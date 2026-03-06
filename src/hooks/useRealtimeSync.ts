import { useEffect, useRef } from 'react'
import { DeviceEventEmitter } from 'react-native'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from '../supabase/client'
import { localDb } from '../sync/LocalInvoiceDatabase'
import type { CanonicalInvoice } from '../invoice/types/canonical'

/** Nombre del evento que se emite cuando SQLite es actualizado por Realtime. */
export const INVOICES_UPDATED_EVENT = 'invoices-updated'

/**
 * Hook que mantiene una suscripción Supabase Realtime activa para la
 * tabla `invoices` del usuario autenticado.
 *
 * Cuando el servidor inserta o actualiza una factura (ej: la Edge Function
 * procesó un correo nuevo), este hook actualiza automáticamente el cache SQLite
 * y emite el evento 'invoices-updated' para que useInvoices recargue la UI.
 */
export function useRealtimeSync(userId: string | null): void {
  const channelRef = useRef<RealtimeChannel | null>(null)

  useEffect(() => {
    if (!userId) return

    channelRef.current = supabase
      .channel(`invoices:user:${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'invoices',
          filter: `user_id=eq.${userId}`,
        },
        async (payload) => {
          switch (payload.eventType) {
            case 'INSERT':
            case 'UPDATE': {
              const serverInvoice = payload.new.invoice_data as unknown as CanonicalInvoice
              if (serverInvoice?.id) {
                await localDb.upsertInvoice(
                  { ...serverInvoice, syncedAt: payload.new.updated_at },
                  'synced'
                )
                DeviceEventEmitter.emit(INVOICES_UPDATED_EVENT)
              }
              break
            }
            case 'DELETE': {
              const id = payload.old?.id as string
              if (id) {
                await localDb.softDelete(id)
                DeviceEventEmitter.emit(INVOICES_UPDATED_EVENT)
              }
              break
            }
          }
        }
      )
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR') {
          console.warn('[Realtime] Error en el canal — reconectando...')
          // Supabase client reintenta automáticamente
        }
      })

    return () => {
      channelRef.current?.unsubscribe()
      channelRef.current = null
    }
  }, [userId])
}
