/**
 * Tipos canónicos universales para facturas electrónicas.
 * Este modelo es la salida normalizada de InvoiceParserFactory
 * independientemente del país o formato de origen.
 */

export type InvoiceType = 'invoice' | 'credit_note' | 'debit_note' | 'receipt'
export type InvoiceStatus = 'pending' | 'received' | 'approved' | 'rejected' | 'cancelled' | 'locked'
export type InvoiceSource = 'email' | 'qr' | 'manual'
export type TaxType = 'IVA_CO' | 'INC' | 'ICA' | 'RETE_IVA' | 'RETE_FUENTE' | 'VAT' | 'IGV' | 'OTHER'
export type TaxIdType = 'NIT' | 'RFC' | 'RUC' | 'NIF' | 'CC' | 'OTHER'
export type SyncStatus = 'synced' | 'pending_upload' | 'conflict'

export interface CanonicalAddress {
  street?: string
  city?: string
  state?: string
  postalCode?: string
  countryCode: string
}

export interface CanonicalParty {
  /** NIT (CO), RFC (MX), RUC (PE/EC), NIF (ES) */
  taxId: string
  taxIdType: TaxIdType
  legalName: string
  tradeName?: string
  address?: CanonicalAddress
  email?: string
  phone?: string
}

export interface CanonicalTaxLine {
  taxType: TaxType
  taxableAmount: number
  /** Ej: 0.19 para 19% de IVA */
  taxRate: number
  taxAmount: number
  taxCategory?: string
}

export interface CanonicalLineItem {
  lineNumber: number
  productCode?: string
  description: string
  quantity: number
  unitOfMeasure?: string
  unitPrice: number
  discountAmount?: number
  /** Total de la línea antes de impuestos */
  lineTotal: number
  taxes: CanonicalTaxLine[]
}

export interface CanonicalInvoice {
  // ── Identidad ──────────────────────────────────────────────────
  /** UUID generado por la app */
  id: string
  /** ISO 3166-1 alpha-2: 'CO', 'MX', 'ES' */
  countryCode: string
  invoiceFormat: 'UBL_2.1' | 'CFDI_4.0' | 'FACTURAE_3.2' | 'UBL_2.1_PE' | 'OTHER'
  /** SHA-256 del XML original — prueba de inmutabilidad */
  originalXmlHash: string

  // ── Datos del documento ────────────────────────────────────────
  /** Ej: "SETT-1234" (CO), "A-0001" (MX) */
  invoiceNumber: string
  series?: string
  invoiceType: InvoiceType
  status: InvoiceStatus

  // ── Fechas ─────────────────────────────────────────────────────
  /** ISO 8601: "2026-03-06" */
  issueDate: string
  /** ISO 8601: "14:30:00" */
  issueTime?: string
  dueDate?: string

  // ── Partes ─────────────────────────────────────────────────────
  /** Vendedor / Proveedor */
  issuer: CanonicalParty
  /** Comprador / Receptor */
  recipient: CanonicalParty

  // ── Totales financieros ────────────────────────────────────────
  /** ISO 4217: "COP", "MXN", "EUR" */
  currency: string
  /** Monto neto antes de impuestos */
  subtotal: number
  totalDiscount?: number
  totalTax: number
  /** Gran total incluyendo impuestos */
  totalAmount: number

  // ── Desglose de impuestos ──────────────────────────────────────
  taxes: CanonicalTaxLine[]

  // ── Líneas de detalle ──────────────────────────────────────────
  lineItems: CanonicalLineItem[]

  // ── Autorización electrónica ───────────────────────────────────
  /** CUFE (CO), UUID (MX), CAE (AR) */
  authorizationCode?: string
  authorizationDate?: string
  qrCodeData?: string

  // ── Proveniencia ───────────────────────────────────────────────
  source: InvoiceSource
  sourceEmailId?: string
  sourceEmailSubject?: string
  sourceFileName?: string
  /** Path en Supabase Storage */
  attachmentStoragePath?: string

  // ── Metadata de la app ─────────────────────────────────────────
  userId: string
  parsedAt: string
  parserVersion: string
  rawParseErrors?: string[]

  // ── Sync ───────────────────────────────────────────────────────
  syncStatus?: SyncStatus
  syncedAt?: string
  updatedAt: string
  deletedAt?: string
  /** Para concurrencia optimista */
  version: number
}
