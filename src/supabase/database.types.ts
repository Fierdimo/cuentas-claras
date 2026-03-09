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
  linked_movement_id: string | null
  version: number
}

type InvoiceInsert = Omit<InvoiceRow, 'created_at'> & { created_at?: string }
type InvoiceUpdate = Partial<InvoiceInsert>

// ── pending_movements ─────────────────────────────────────────────────────────
interface PendingMovementRow {
  id:            string
  user_id:       string
  gmail_msg_id:  string | null
  source:        string
  bank_name:     string | null
  sender_email:  string | null
  amount:        number
  direction:     'credit' | 'debit'
  currency:      string
  counterpart:   string | null
  account_last4: string | null
  email_date:    string | null
  body_snippet:  string | null
  parser_used:   'known' | 'learned' | 'perplexity'
  status:                'pending_confirmation' | 'confirmed' | 'rejected' | 'ignored'
  confirmed_at:          string | null
  rejected_at:           string | null
  is_internal_transfer:  boolean | null
  transfer_pair_id:      string | null
  linked_invoice_id:     string | null
  created_at:            string
  updated_at:            string
}

interface PendingMovementUpdate {
  status?:               'pending_confirmation' | 'confirmed' | 'rejected' | 'ignored'
  confirmed_at?:         string | null
  rejected_at?:          string | null
  is_internal_transfer?: boolean | null
  transfer_pair_id?:     string | null
  linked_invoice_id?:    string | null
  updated_at?:           string
}

// ── user_own_counterparts ─────────────────────────────────────────────────────
interface UserOwnCounterpartRow {
  id:          string
  user_id:     string
  name:        string
  name_lower:  string
  source_bank: string | null
  created_at:  string
}
type UserOwnCounterpartInsert = Pick<UserOwnCounterpartRow, 'user_id' | 'name' | 'name_lower'>
  & { source_bank?: string | null; id?: string; created_at?: string }

export interface Database {
  public: {
    Tables: {
      invoices: {
        Row:           InvoiceRow
        Insert:        InvoiceInsert
        Update:        InvoiceUpdate
        Relationships: []
      }
      pending_movements: {
        Row:           PendingMovementRow
        Insert:        Omit<PendingMovementRow, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string }
        Update:        PendingMovementUpdate
        Relationships: []
      }
      user_own_counterparts: {
        Row:           UserOwnCounterpartRow
        Insert:        UserOwnCounterpartInsert
        Update:        Partial<UserOwnCounterpartInsert>
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
