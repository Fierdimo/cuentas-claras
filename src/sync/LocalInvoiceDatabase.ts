import * as SQLite from 'expo-sqlite'
import type { CanonicalInvoice, SyncStatus } from '../invoice/types/canonical'

const DB_NAME = 'cuentas.db'
const SCHEMA_VERSION = 1

/**
 * Base de datos local SQLite para cache offline-first.
 * Espeja la tabla `invoices` de Supabase con una columna adicional
 * `sync_status` para gestionar la sincronización pendiente.
 */
export class LocalInvoiceDatabase {
  private db!: SQLite.SQLiteDatabase
  private ready = false
  private initPromise: Promise<void> | null = null

  async init(): Promise<void> {
    if (this.ready) return
    // Evitar que múltiples llamadas concurrentes abran la BD dos veces
    if (this.initPromise) return this.initPromise
    this.initPromise = this._init()
    await this.initPromise
  }

  private async _init(): Promise<void> {
    this.db = await SQLite.openDatabaseAsync(DB_NAME)

    await this.db.execAsync(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS invoices (
        id                TEXT PRIMARY KEY,
        user_id           TEXT NOT NULL,
        country_code      TEXT NOT NULL DEFAULT 'CO',
        invoice_data      TEXT NOT NULL,
        invoice_number    TEXT,
        issuer_tax_id     TEXT,
        issuer_name       TEXT,
        total_amount      REAL,
        currency          TEXT DEFAULT 'COP',
        issue_date        TEXT,
        status            TEXT DEFAULT 'pending',
        source            TEXT DEFAULT 'email',
        sync_status       TEXT NOT NULL DEFAULT 'synced',
        local_updated_at  TEXT NOT NULL,
        server_updated_at TEXT,
        version           INTEGER DEFAULT 1,
        deleted_at        TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_local_user_date
        ON invoices (user_id, issue_date DESC)
        WHERE deleted_at IS NULL;

      CREATE INDEX IF NOT EXISTS idx_local_sync_pending
        ON invoices (sync_status)
        WHERE sync_status != 'synced';

      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      );
    `)

    // Insertar versión si no existe
    await this.db.runAsync(
      `INSERT OR IGNORE INTO schema_version (version) VALUES (?)`,
      [SCHEMA_VERSION]
    )

    this.ready = true
  }
  // fin _init

  private ensureReady(): void {
    if (!this.ready) {
      throw new Error('LocalInvoiceDatabase no está inicializada. Llama a init() primero.')
    }
  }

  /**
   * Inserta o actualiza una factura en el cache local.
   */
  async upsertInvoice(
    invoice: CanonicalInvoice,
    syncStatus: SyncStatus = 'synced'
  ): Promise<void> {
    this.ensureReady()
    const now = new Date().toISOString()

    await this.db.runAsync(
      `INSERT INTO invoices (
        id, user_id, country_code, invoice_data, invoice_number,
        issuer_tax_id, issuer_name, total_amount, currency, issue_date,
        status, source, sync_status, local_updated_at, server_updated_at,
        version, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        invoice_data      = excluded.invoice_data,
        invoice_number    = excluded.invoice_number,
        issuer_tax_id     = excluded.issuer_tax_id,
        issuer_name       = excluded.issuer_name,
        total_amount      = excluded.total_amount,
        currency          = excluded.currency,
        issue_date        = excluded.issue_date,
        status            = excluded.status,
        source            = excluded.source,
        sync_status       = excluded.sync_status,
        local_updated_at  = excluded.local_updated_at,
        server_updated_at = excluded.server_updated_at,
        version           = excluded.version,
        deleted_at        = excluded.deleted_at`,
      [
        invoice.id,
        invoice.userId,
        invoice.countryCode,
        JSON.stringify(invoice),
        invoice.invoiceNumber,
        invoice.issuer?.taxId ?? null,
        invoice.issuer?.legalName ?? null,
        invoice.totalAmount,
        invoice.currency,
        invoice.issueDate,
        invoice.status,
        invoice.source,
        syncStatus,
        invoice.updatedAt ?? now,
        invoice.syncedAt ?? null,
        invoice.version,
        invoice.deletedAt ?? null,
      ]
    )
  }

  /**
   * Retorna todas las facturas del usuario, ordenadas por fecha descendente.
   */
  async getAll(userId: string): Promise<CanonicalInvoice[]> {
    this.ensureReady()

    const rows = await this.db.getAllAsync<{ invoice_data: string }>(
      `SELECT invoice_data FROM invoices
       WHERE user_id = ? AND deleted_at IS NULL
       ORDER BY issue_date DESC`,
      [userId]
    )

    return rows.map((r) => JSON.parse(r.invoice_data) as CanonicalInvoice)
  }

  /**
   * Busca una factura por ID.
   */
  async getById(id: string): Promise<(CanonicalInvoice & { syncStatus: SyncStatus }) | null> {
    this.ensureReady()

    const row = await this.db.getFirstAsync<{ invoice_data: string; sync_status: string }>(
      `SELECT invoice_data, sync_status FROM invoices WHERE id = ?`,
      [id]
    )

    if (!row) return null

    return {
      ...(JSON.parse(row.invoice_data) as CanonicalInvoice),
      syncStatus: row.sync_status as SyncStatus,
    }
  }

  /**
   * Retorna facturas pendientes de subir a Supabase.
   */
  async getPendingUploads(): Promise<CanonicalInvoice[]> {
    this.ensureReady()

    const rows = await this.db.getAllAsync<{ invoice_data: string }>(
      `SELECT invoice_data FROM invoices WHERE sync_status = 'pending_upload'`
    )

    return rows.map((r) => JSON.parse(r.invoice_data) as CanonicalInvoice)
  }

  /**
   * Actualiza el sync_status de una factura.
   */
  async updateSyncStatus(id: string, syncStatus: SyncStatus): Promise<void> {
    this.ensureReady()
    await this.db.runAsync(
      `UPDATE invoices SET sync_status = ? WHERE id = ?`,
      [syncStatus, id]
    )
  }

  /**
   * Soft-delete local de una factura.
   */
  async softDelete(id: string): Promise<void> {
    this.ensureReady()
    const now = new Date().toISOString()
    await this.db.runAsync(
      `UPDATE invoices SET deleted_at = ?, sync_status = 'pending_upload', local_updated_at = ? WHERE id = ?`,
      [now, now, id]
    )
  }

  /**
   * Actualiza el status de una factura (ej: pending → approved).
   */
  async updateStatus(id: string, status: CanonicalInvoice['status']): Promise<void> {
    this.ensureReady()
    const now = new Date().toISOString()
    await this.db.runAsync(
      `UPDATE invoices SET status = ?, sync_status = 'pending_upload', local_updated_at = ? WHERE id = ?`,
      [status, now, id]
    )
  }

  /**
   * Retorna el timestamp de la última factura sincronizada con el servidor.
   * Usado por SyncEngine para descargar solo cambios incrementales.
   */
  async getLastServerSync(): Promise<string | null> {
    this.ensureReady()

    const row = await this.db.getFirstAsync<{ server_updated_at: string }>(
      `SELECT server_updated_at FROM invoices
       WHERE server_updated_at IS NOT NULL
       ORDER BY server_updated_at DESC
       LIMIT 1`
    )

    return row?.server_updated_at ?? null
  }
}

// Singleton para uso en toda la app
export const localDb = new LocalInvoiceDatabase()
