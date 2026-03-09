/**
 * useFinancialTimeline
 *
 * Hook unificado que combina movimientos bancarios (pending_movements) con
 * facturas electrónicas (invoices) en una única vista cronológica.
 *
 * Responsabilidades:
 *  1. Cargar movimientos (vía usePendingMovements) y facturas (vía useInvoices).
 *  2. Detectar posibles duplicados: un movimiento bancario + una factura que
 *     representan la misma transacción.
 *  3. Exponer acciones para confirmar o descartar el vínculo.
 *
 * Algoritmo de detección de duplicados:
 *  - Monto idéntico (diferencia < 1 COP)
 *  - Proximidad temporal ≤ 15 días (email_date vs issueDate)
 *  - Coincidencia parcial de nombre (counterpart vs issuer.legalName):
 *      · nombre + diff ≤ 5 días → 'probable'
 *      · nombre + diff 6-15 días → 'possible'  (cruce de mes habitual)
 *      · sin nombre pero diff ≤ 3 días → 'possible'
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import * as SecureStore from 'expo-secure-store'
import { usePendingMovements, type PendingMovement, type ManualMovementInput } from './usePendingMovements'
import { useInvoices } from './useInvoices'
import { supabase } from '../supabase/client'
import type { CanonicalInvoice } from '../invoice/types/canonical'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type MatchConfidence = 'probable' | 'possible'

export interface InvoiceMatch {
  invoice:    CanonicalInvoice
  confidence: MatchConfidence
}

export interface MovementMatch {
  movement:   PendingMovement
  confidence: MatchConfidence
}

export interface UseFinancialTimelineReturn {
  // ── Movimientos (de usePendingMovements) ─────────────────────────────────
  movements:       PendingMovement[]
  isLoading:       boolean
  count:           number
  refresh:         () => Promise<void>
  markAsTransfer:  (ids: string[]) => Promise<void>
  dismissTransfer: (id: string) => Promise<void>
  ownCounterparts: string[]

  // ── Facturas (de useInvoices) ─────────────────────────────────────────────
  invoices:          CanonicalInvoice[]
  isLoadingInvoices: boolean

  // ── Detección de duplicados ───────────────────────────────────────────────
  /** movementId → mejor(es) coincidencia(s) ordenadas por confianza desc */
  possibleMatches: Map<string, InvoiceMatch[]>
  /** invoiceId → movimiento(s) posiblemente relacionados (vista inversa) */
  invoiceToMovementMatches: Map<string, MovementMatch[]>
  /**
   * Facturas que NO tienen un movimiento confirmado vinculado.
   * Representan gastos que no se detectaron como notificación bancaria
   * (p. ej. pago con tarjeta crédito sin alerta, o efectivo).
   */
  orphanInvoices: CanonicalInvoice[]

  // ── Acciones de vinculación ───────────────────────────────────────────────
  /** Confirma que movimiento y factura son la misma transacción. */
  confirmInvoiceLink:  (movementId: string, invoiceId: string) => Promise<void>
  /** Descarta la sugerencia de vínculo (se guarda en AsyncStorage). */
  dismissInvoiceMatch: (movementId: string, invoiceId: string) => Promise<void>
  /** Crea un movimiento manual (efectivo u otro medio no detectado). */
  createManual:    (input: ManualMovementInput) => Promise<void>
  /** Elimina un movimiento manual creado por el usuario. */
  deleteManual:    (id: string) => Promise<void>
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Tokeniza un string para comparar palabras parciales. */
function tokenize(str: string): Set<string> {
  return new Set(
    str
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')   // quitar tildes
      .replace(/[^a-z0-9\s]/g, ' ')      // solo alfanumérico
      .split(/\s+/)
      .filter(w => w.length >= 3),        // mínimo 3 chars
  )
}

/** Número de tokens en común entre dos strings. */
function nameOverlap(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0
  const tokA = tokenize(a)
  const tokB = tokenize(b)
  let count = 0
  for (const t of tokA) { if (tokB.has(t)) count++ }
  return count
}

/** Diferencia en días entre dos fechas ISO (valor absoluto). */
function daysDiff(isoA: string | null | undefined, isoB: string | null | undefined): number {
  if (!isoA || !isoB) return Infinity
  return Math.abs(new Date(isoA).getTime() - new Date(isoB).getTime()) / 86_400_000
}

// SecureStore helpers para pares descartados
function dismissedKey(userId: string) { return `invoice_dismissed_${userId}` }

async function loadDismissedPairs(userId: string): Promise<Set<string>> {
  try {
    const raw = await SecureStore.getItemAsync(dismissedKey(userId))
    if (!raw) return new Set()
    return new Set(JSON.parse(raw) as string[])
  } catch { return new Set() }
}

async function saveDismissedPairs(userId: string, pairs: Set<string>): Promise<void> {
  try {
    // SecureStore has 2048 byte limit; keep only last 200 dismissed pairs
    const arr = [...pairs].slice(-200)
    await SecureStore.setItemAsync(dismissedKey(userId), JSON.stringify(arr))
  } catch { /* best-effort */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

export function useFinancialTimeline(userId: string | null): UseFinancialTimelineReturn {
  const movHook = usePendingMovements(userId)
  const invHook = useInvoices(userId)
  const { movements } = movHook
  const { invoices }  = invHook

  // Pares "movimientoId:facturaId" que el usuario descartó explícitamente
  const [dismissedPairs, setDismissedPairs] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!userId) return
    void loadDismissedPairs(userId).then(setDismissedPairs)
  }, [userId])

  // IDs de facturas que ya tienen un movimiento confirmado (linked_invoice_id en DB)
  const confirmedInvoiceIds = useMemo<Set<string>>(() => {
    const s = new Set<string>()
    for (const m of movements) {
      if (m.linked_invoice_id) s.add(m.linked_invoice_id)
    }
    return s
  }, [movements])

  // ── Detección de posibles duplicados ─────────────────────────────────────
  const possibleMatches = useMemo<Map<string, InvoiceMatch[]>>(() => {
    const result = new Map<string, InvoiceMatch[]>()

    for (const m of movements) {
      // Solo débitos (gastos) sin transferencia confirmada y sin factura vinculada
      if (m.direction !== 'debit') continue
      if (m.is_internal_transfer === true) continue
      if (m.linked_invoice_id) continue

      const matches: InvoiceMatch[] = []

      for (const inv of invoices) {
        if (!inv.totalAmount) continue
        if (inv.deletedAt) continue
        // Esta factura ya está vinculada a otro movimiento
        if (confirmedInvoiceIds.has(inv.id)) continue
        // El usuario ya descartó esta combinación
        if (dismissedPairs.has(`${m.id}:${inv.id}`)) continue

        // 1) Monto idéntico (< 1 COP de diferencia)
        if (Math.abs(m.amount - inv.totalAmount) >= 1) continue

        // 2) Proximidad temporal ≤ 15 días  (cubre cruces de mes)
        const diff = daysDiff(m.email_date, inv.issueDate)
        if (diff > 15) continue

        // 3) Coincidencia de nombre + graduar confianza por proximidad
        const overlap = nameOverlap(m.counterpart, inv.issuer?.legalName)
        let confidence: MatchConfidence
        if (overlap >= 1 && diff <= 5) {
          confidence = 'probable'             // nombre + fecha muy cercana
        } else if ((overlap >= 1 && diff <= 15) || diff <= 3) {
          confidence = 'possible'             // nombre lejano O fecha exacta sin nombre
        } else {
          continue  // No hay suficiente señal
        }

        matches.push({ invoice: inv, confidence })
      }

      if (matches.length > 0) {
        // Probables primero, luego posibles
        matches.sort((a, b) => (a.confidence === 'probable' ? -1 : 1))
        result.set(m.id, matches)
      }
    }

    return result
  }, [movements, invoices, confirmedInvoiceIds, dismissedPairs])

  // ── Vista inversa: factura → posibles movimientos ─────────────────────────────
  // Misma lógica, proyectada al revés. Reutiliza los mismos criterios.
  const invoiceToMovementMatches = useMemo<Map<string, MovementMatch[]>>(() => {
    const result = new Map<string, MovementMatch[]>()

    for (const inv of invoices) {
      if (!inv.totalAmount) continue
      if (inv.deletedAt) continue
      if (confirmedInvoiceIds.has(inv.id)) continue

      const matches: MovementMatch[] = []

      for (const m of movements) {
        if (m.direction !== 'debit') continue
        if (m.is_internal_transfer === true) continue
        if (m.linked_invoice_id) continue
        if (dismissedPairs.has(`${m.id}:${inv.id}`)) continue

        if (Math.abs(m.amount - inv.totalAmount) >= 1) continue

        const diff = daysDiff(m.email_date, inv.issueDate)
        if (diff > 15) continue

        const overlap = nameOverlap(m.counterpart, inv.issuer?.legalName)
        let confidence: MatchConfidence
        if (overlap >= 1 && diff <= 5) {
          confidence = 'probable'
        } else if ((overlap >= 1 && diff <= 15) || diff <= 3) {
          confidence = 'possible'
        } else {
          continue
        }

        matches.push({ movement: m, confidence })
      }

      if (matches.length > 0) {
        matches.sort((a, b) => (a.confidence === 'probable' ? -1 : 1))
        result.set(inv.id, matches)
      }
    }

    return result
  }, [movements, invoices, confirmedInvoiceIds, dismissedPairs])

  // ── Facturas huérfanas (sin movimiento confirmado) ────────────────────────
  const orphanInvoices = useMemo<CanonicalInvoice[]>(() => {
    return invoices.filter(inv => !inv.deletedAt && !confirmedInvoiceIds.has(inv.id))
  }, [invoices, confirmedInvoiceIds])

  // ── Acciones ──────────────────────────────────────────────────────────────

  const confirmInvoiceLink = useCallback(async (movementId: string, invoiceId: string) => {
    if (!userId) return
    // Actualiza pending_movements.linked_invoice_id en Supabase
    await db
      .from('pending_movements')
      .update({ linked_invoice_id: invoiceId })
      .eq('id', movementId)
      .eq('user_id', userId)
    // Actualiza invoices.linked_movement_id en Supabase
    await db
      .from('invoices')
      .update({ linked_movement_id: movementId })
      .eq('id', invoiceId)
      .eq('user_id', userId)
    // Recarga movimientos para que confirmedInvoiceIds se actualice
    await movHook.refresh()
  }, [userId, movHook])

  const dismissInvoiceMatch = useCallback(async (movementId: string, invoiceId: string) => {
    const pairKey = `${movementId}:${invoiceId}`
    // Actualiza estado local inmediatamente
    setDismissedPairs(prev => new Set([...prev, pairKey]))
    // Persiste en AsyncStorage
    if (userId) {
      const existing = await loadDismissedPairs(userId)
      existing.add(pairKey)
      await saveDismissedPairs(userId, existing)
    }
  }, [userId])

  return {
    // movimientos
    movements:       movHook.movements,
    isLoading:       movHook.isLoading,
    count:           movHook.count,
    refresh:         movHook.refresh,
    markAsTransfer:  movHook.markAsTransfer,
    dismissTransfer: movHook.dismissTransfer,
    ownCounterparts: movHook.ownCounterparts,
    // facturas
    invoices:          invHook.invoices,
    isLoadingInvoices: invHook.isLoading,
    // dedup
    possibleMatches,
    invoiceToMovementMatches,
    orphanInvoices,
    confirmInvoiceLink,
    dismissInvoiceMatch,
    createManual:    movHook.createManual,
    deleteManual:    movHook.deleteManual,
  }
}
