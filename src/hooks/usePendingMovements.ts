import { useState, useEffect, useCallback } from 'react'
import { DeviceEventEmitter } from 'react-native'
import { supabase } from '../supabase/client'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any

export interface PendingMovement {
  id:            string
  bank_name:     string | null
  sender_email:  string | null
  amount:        number
  direction:     'credit' | 'debit'
  currency:      string
  counterpart:   string | null
  account_last4: string | null
  email_date:    string | null
  body_snippet:  string | null
  source:               string | null   // 'email' | 'manual' | null (pre-migration)
  parser_used:          'known' | 'learned' | 'perplexity'
  status:               'pending_confirmation' | 'confirmed' | 'rejected' | 'ignored'
  confirmed_at:         string | null
  is_internal_transfer: boolean | null
  transfer_pair_id:     string | null  // enlazado automáticamente por el trigger de la DB
  linked_invoice_id:    string | null  // factura electrónica confirmada para este movimiento
  created_at:           string
}

export interface ManualMovementInput {
  direction:    'credit' | 'debit'
  amount:       number
  counterpart?: string | null
  bankName?:    string | null
  date:         string   // ISO
}

interface UseBankMovementsReturn {
  movements:         PendingMovement[]
  isLoading:         boolean
  count:             number
  refresh:           () => Promise<void>
  markAsTransfer:    (ids: string[]) => Promise<void>
  dismissTransfer:   (id: string)    => Promise<void>
  ownCounterparts:   string[]  // lowercase names the user confirmed as their own
  createManual:      (input: ManualMovementInput) => Promise<void>
  deleteManual:      (id: string) => Promise<void>
}

export function usePendingMovements(userId: string | null): UseBankMovementsReturn {
  const [movements, setMovements]               = useState<PendingMovement[]>([])
  const [isLoading, setIsLoading]               = useState(true)
  const [count, setCount]                       = useState(0)
  const [ownCounterparts, setOwnCounterparts]   = useState<string[]>([])

  const load = useCallback(async () => {
    if (!userId) {
      setMovements([])
      setIsLoading(false)
      return
    }
    try {
      const [movRes, ownRes] = await Promise.all([
        supabase
          .from('pending_movements')
          .select('*')
          .eq('user_id', userId)
          .eq('status', 'confirmed')
          .order('email_date', { ascending: false })
          .limit(500),
        supabase
          .from('user_own_counterparts')
          .select('name_lower')
          .eq('user_id', userId),
      ])

      if (movRes.error)  throw movRes.error

      const rows = (movRes.data ?? []) as PendingMovement[]
      setMovements(rows)
      setCount(rows.length)
      setOwnCounterparts((ownRes.data ?? []).map((r: { name_lower: string }) => r.name_lower))
    } catch (e) {
      console.error('[useBankMovements] load:', e)
    } finally {
      setIsLoading(false)
    }
  }, [userId])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('BANK_MOVEMENTS_UPDATED', () => {
      void load()
    })
    return () => sub.remove()
  }, [load])

  // Auto-confirm movements whose counterpart matches a known own name.
  // No need to ask — we already know it's the user themselves.
  useEffect(() => {
    if (ownCounterparts.length === 0) return
    const toMark = movements
      .filter(m => {
        if (m.is_internal_transfer !== null) return false
        const cp = (m.counterpart ?? '').toLowerCase()
        if (!cp) return false
        return ownCounterparts.some(n => cp === n || cp.includes(n))
      })
      .map(m => m.id)
    if (toMark.length === 0) return
    void markAsTransfer(toMark)
  // markAsTransfer is intentionally omitted from deps: it's stable within a load
  // cycle and including it would cause an infinite re-render loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movements, ownCounterparts])

  const markAsTransfer = useCallback(async (ids: string[]) => {
    if (!userId) return
    // Include any DB-linked pair automatically so the caller only needs to pass one side
    const allIds = [...new Set([
      ...ids,
      ...ids.flatMap(id => {
        const m = movements.find(mv => mv.id === id)
        return m?.transfer_pair_id ? [m.transfer_pair_id] : []
      }),
    ])]
    await db
      .from('pending_movements')
      .update({ is_internal_transfer: true })
      .in('id', allIds)
      .eq('user_id', userId)

    // Learn: persist counterpart names so future movements auto-flag
    const newEntries = allIds
      .flatMap(id => {
        const m = movements.find(mv => mv.id === id)
        if (!m?.counterpart?.trim()) return []
        return [{
          user_id:     userId,
          name:        m.counterpart.trim(),
          name_lower:  m.counterpart.trim().toLowerCase(),
          source_bank: m.bank_name ?? null,
        }]
      })
      .filter((e, i, arr) => arr.findIndex(x => x.name_lower === e.name_lower) === i) // dedupe

    if (newEntries.length > 0) {
      await db
        .from('user_own_counterparts')
        .upsert(newEntries, { onConflict: 'user_id,name_lower', ignoreDuplicates: true })
      setOwnCounterparts(prev =>
        [...new Set([...prev, ...newEntries.map(e => e.name_lower)])]
      )
    }

    await load()
  }, [userId, load, movements])

  const dismissTransfer = useCallback(async (id: string) => {
    if (!userId) return
    const m      = movements.find(mv => mv.id === id)
    const pairId = m?.transfer_pair_id ?? null
    // Mark this movement as dismissed and remove its link
    await db
      .from('pending_movements')
      .update({ is_internal_transfer: false, transfer_pair_id: null })
      .eq('id', id)
      .eq('user_id', userId)
    // Unlink the other side too (but don't change its transfer status —
    // it may still be matched with another movement later)
    if (pairId) {
      await db
        .from('pending_movements')
        .update({ transfer_pair_id: null })
        .eq('id', pairId)
        .eq('user_id', userId)
    }
    await load()
  }, [userId, load, movements])

  const createManual = useCallback(async (input: ManualMovementInput): Promise<void> => {
    if (!userId) return
    const { error } = await db
      .from('pending_movements')
      .insert({
        user_id:              userId,
        bank_name:            input.bankName ?? null,
        amount:               input.amount,
        direction:            input.direction,
        currency:             'COP',
        counterpart:          input.counterpart ?? null,
        email_date:           input.date,
        gmail_msg_id:         null,          // null identifies a manual entry
        sender_email:         null,
        body_snippet:         null,
        parser_used:          'known',
        status:               'confirmed',
        confirmed_at:         new Date().toISOString(),
        is_internal_transfer: false,
        transfer_pair_id:     null,
        linked_invoice_id:    null,
      })
    if (error) {
      console.error('[createManual] insert error:', error)
      throw new Error(error.message)
    }
    await load()
  }, [userId, load])

  const deleteManual = useCallback(async (id: string): Promise<void> => {
    if (!userId) return
    // Safety: only allow deleting entries that have no gmail_msg_id (manual entries)
    await db
      .from('pending_movements')
      .update({ status: 'rejected' })
      .eq('id', id)
      .eq('user_id', userId)
      .is('gmail_msg_id', null)
    await load()
  }, [userId, load])

  return { movements, isLoading, count, refresh: load, markAsTransfer, dismissTransfer, ownCounterparts, createManual, deleteManual }
}
