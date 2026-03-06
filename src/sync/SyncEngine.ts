import NetInfo from '@react-native-community/netinfo'
import { supabase } from '../supabase/client'
import { localDb } from './LocalInvoiceDatabase'
import { resolveConflict } from './conflictResolver'
import type { CanonicalInvoice } from '../invoice/types/canonical'

// Typed helper that bypasses the bootstrap period before `supabase gen types`.
// Once the real DB is set up and `supabase gen types` runs, this cast becomes unnecessary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const invoicesTable = () => (supabase as any).from('invoices') as ReturnType<typeof supabase.from>

export interface SyncResult {
  status: 'ok' | 'offline' | 'partial_error'
  uploaded: number
  downloaded: number
  conflicts: number
  errors: string[]
}

/**
 * Motor de sincronización offline-first.
 *
 * Estrategia:
 *  - Lecturas: siempre desde SQLite local (instantáneo, sin red)
 *  - Escrituras: SQLite primero → Supabase después (si hay red)
 *  - Realtime: Supabase Realtime actualiza SQLite en background (ver useRealtimeSync)
 *  - Al reconectar: subir pending_upload → descargar cambios del servidor
 */
export class SyncEngine {
  constructor(private readonly userId: string) {}

  /**
   * Sincronización completa: subir pendientes + descargar cambios.
   * Llamar al foreground de la app y al reconectar.
   */
  async sync(): Promise<SyncResult> {
    const net = await NetInfo.fetch()

    if (!net.isConnected) {
      return { status: 'offline', uploaded: 0, downloaded: 0, conflicts: 0, errors: [] }
    }

    const errors: string[] = []
    let uploaded = 0
    let downloaded = 0
    let conflicts = 0

    try {
      const upResult = await this.uploadPending()
      uploaded = upResult.count
      conflicts += upResult.conflicts
      errors.push(...upResult.errors)
    } catch (e) {
      errors.push(`Upload error: ${e}`)
    }

    try {
      const downResult = await this.downloadChanges()
      downloaded = downResult.count
      conflicts += downResult.conflicts
      errors.push(...downResult.errors)
    } catch (e) {
      errors.push(`Download error: ${e}`)
    }

    return {
      status: errors.length > 0 ? 'partial_error' : 'ok',
      uploaded,
      downloaded,
      conflicts,
      errors,
    }
  }

  // ── Upload ────────────────────────────────────────────────────────────────

  private async uploadPending(): Promise<{ count: number; conflicts: number; errors: string[] }> {
    const pending = await localDb.getPendingUploads()
    let count = 0
    let conflicts = 0
    const errors: string[] = []

    for (const invoice of pending) {
      try {
        const { error } = await invoicesTable().upsert(
          {
            id:             invoice.id,
            user_id:        invoice.userId,
            country_code:   invoice.countryCode,
            invoice_data:   invoice as unknown as Record<string, unknown>,
            invoice_number: invoice.invoiceNumber,
            issuer_tax_id:  invoice.issuer?.taxId ?? null,
            issuer_name:    invoice.issuer?.legalName ?? null,
            total_amount:   invoice.totalAmount,
            currency:       invoice.currency,
            issue_date:     invoice.issueDate,
            status:         invoice.status,
            source:         invoice.source,
            updated_at:     invoice.updatedAt,
            deleted_at:     invoice.deletedAt ?? null,
            version:        invoice.version,
          },
          { onConflict: 'id' }
        )

        if (error) {
          errors.push(`Error subiendo ${invoice.id}: ${error.message}`)
        } else {
          await localDb.updateSyncStatus(invoice.id, 'synced')
          count++
        }
      } catch (e) {
        // Error de red — mantener como pending_upload para reintentar
        errors.push(`Error de red subiendo ${invoice.id}: ${e}`)
      }
    }

    return { count, conflicts, errors }
  }

  // ── Download ──────────────────────────────────────────────────────────────

  private async downloadChanges(): Promise<{ count: number; conflicts: number; errors: string[] }> {
    const since = await localDb.getLastServerSync()
    const errors: string[] = []
    let count = 0
    let conflicts = 0

    const query = invoicesTable()
      .select('*')
      .eq('user_id', this.userId)
      .order('updated_at', { ascending: true })

    if (since) {
      query.gt('updated_at', since)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: serverRows, error } = await query as any as {
      data: Array<{ id: string; invoice_data: Record<string, unknown>; updated_at: string }> | null
      error: { message: string } | null
    }

    if (error) {
      return { count: 0, conflicts: 0, errors: [error.message] }
    }

    for (const row of serverRows ?? []) {
      const serverInvoice = row.invoice_data as unknown as CanonicalInvoice
      const local = await localDb.getById(row.id)

      if (local?.syncStatus === 'pending_upload') {
        // Conflicto: hay cambios locales no subidos y el servidor también cambió
        const resolved = resolveConflict(local, serverInvoice, 'merge')
        await localDb.upsertInvoice({ ...resolved, syncedAt: row.updated_at }, 'pending_upload')
        conflicts++
      } else {
        // Sin conflicto: aplicar versión del servidor
        await localDb.upsertInvoice(
          { ...serverInvoice, syncedAt: row.updated_at },
          'synced'
        )
        count++
      }
    }

    return { count, conflicts, errors }
  }
}
