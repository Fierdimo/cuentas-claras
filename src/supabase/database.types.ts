/**
 * Tipos generados para la base de datos Supabase.
 * Actualizar con: npx supabase gen types typescript --local > src/supabase/database.types.ts
 *
 * Por ahora se define manualmente hasta tener la DB configurada.
 */

interface InvoiceRow {
  id: string
  user_id: string
  country_code: string
  invoice_data: Record<string, unknown>
  invoice_number: string
  issuer_tax_id: string | null
  issuer_name: string | null
  total_amount: number | null
  currency: string | null
  issue_date: string | null
  status: string
  source: string
  created_at: string
  updated_at: string
  deleted_at: string | null
  version: number
}

type InvoiceInsert = Omit<InvoiceRow, 'created_at'> & { created_at?: string }
type InvoiceUpdate = Partial<InvoiceInsert>

export interface Database {
  public: {
    Tables: {
      invoices: {
        Row: InvoiceRow
        Insert: InvoiceInsert
        Update: InvoiceUpdate
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
