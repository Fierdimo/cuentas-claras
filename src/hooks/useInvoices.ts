import { useState, useEffect, useCallback, useRef } from 'react'
import { AppState, DeviceEventEmitter, type AppStateStatus } from 'react-native'
import NetInfo from '@react-native-community/netinfo'
import { localDb } from '../sync/LocalInvoiceDatabase'
import { SyncEngine } from '../sync/SyncEngine'
import { INVOICES_UPDATED_EVENT } from './useRealtimeSync'
import type { CanonicalInvoice, InvoiceStatus } from '../invoice/types/canonical'

let syncEngineInstance: SyncEngine | null = null

function getSyncEngine(userId: string): SyncEngine {
  if (!syncEngineInstance) {
    syncEngineInstance = new SyncEngine(userId)
  }
  return syncEngineInstance
}

interface UseInvoicesState {
  invoices: CanonicalInvoice[]
  isLoading: boolean
  isSyncing: boolean
  error: string | null
  lastSyncAt: string | null
}

interface UseInvoicesActions {
  refresh: () => Promise<void>
  syncNow: () => Promise<void>
  updateStatus: (invoiceId: string, status: InvoiceStatus) => Promise<void>
  deleteInvoice: (invoiceId: string) => Promise<void>
  addLocalInvoice: (invoice: CanonicalInvoice) => Promise<void>
}

type UseInvoicesReturn = UseInvoicesState & UseInvoicesActions

/**
 * Hook principal para gestión de facturas.
 *
 * - Lee desde SQLite local (sin latencia de red).
 * - Dispara una sincronización con Supabase al montar y cuando la app
 *   vuelve al primer plano.
 * - Expone acciones para modificar estado y eliminar facturas.
 */
export function useInvoices(userId: string | null): UseInvoicesReturn {
  const [invoices, setInvoices] = useState<CanonicalInvoice[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSyncing, setIsSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null)

  // Ref para el guard de sync — no provoca re-renders ni re-crea callbacks
  const syncingRef = useRef(false)
  const userIdRef  = useRef(userId)
  useEffect(() => { userIdRef.current = userId }, [userId])

  // Carga desde SQLite local
  const loadLocal = useCallback(async () => {
    if (!userId) {
      setInvoices([])
      setIsLoading(false)
      return
    }
    try {
      await localDb.init()
      const rows = await localDb.getAll(userId)
      setInvoices(rows)
    } catch (e) {
      setError('Error al cargar facturas locales')
      console.error('[useInvoices] loadLocal:', e)
    } finally {
      setIsLoading(false)
    }
  }, [userId])

  // Sincronización con Supabase.
  // IMPORTANTE: sin dependencias que cambien frecuentemente (isSyncing fue
  // eliminado de deps) — usamos syncingRef para el guard y userIdRef para
  // leer el userId actual sin recrear la función.
  const syncNow = useCallback(async () => {
    const uid = userIdRef.current
    if (!uid || syncingRef.current) return
    syncingRef.current = true
    setIsSyncing(true)
    setError(null)
    try {
      await localDb.init()
      const engine = getSyncEngine(uid)
      await engine.sync()
      const rows = await localDb.getAll(uid)
      setInvoices(rows)
      const last = await localDb.getLastServerSync()
      setLastSyncAt(last)
    } catch (e) {
      console.error('[useInvoices] syncNow:', e)
    } finally {
      syncingRef.current = false
      setIsSyncing(false)
    }
  }, []) // sin deps — estable durante toda la vida del hook

  // Carga inicial + sync
  useEffect(() => {
    if (!userId) {
      setInvoices([])
      setIsLoading(false)
      return
    }
    void (async () => {
      await localDb.init()
      await loadLocal()
      await syncNow()
    })()
  }, [userId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Sync al volver al primer plano — se monta una sola vez
  useEffect(() => {
    const handler = (nextState: AppStateStatus) => {
      if (nextState === 'active') void syncNow()
    }
    const sub = AppState.addEventListener('change', handler)
    return () => sub.remove()
  }, [syncNow]) // syncNow es estable (deps vacías), se monta una vez

  // Sync al recuperar conectividad.
  // Usamos fetchInitially:false para que NO dispare en la suscripción inicial.
  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) => {
      if (state.isConnected && !state.isInternetReachable === false) {
        void syncNow()
      }
    })
    return unsub
  }, [syncNow])

  // Recargar SQLite cuando Realtime escribe nuevas facturas (backfill o push)
  // Si Realtime sincronizó: loadLocal() es suficiente.
  // Si el evento viene del fin de backfill: syncNow() baja todo de Supabase primero.
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(INVOICES_UPDATED_EVENT, () => {
      void syncNow().then(() => loadLocal())
    })
    return () => sub.remove()
  }, [loadLocal, syncNow])

  const refresh = useCallback(async () => {
    await loadLocal()
    await syncNow()
  }, [loadLocal, syncNow])

  const updateStatus = useCallback(
    async (invoiceId: string, status: InvoiceStatus) => {
      await localDb.updateStatus(invoiceId, status)
      await loadLocal()
      // Marcará como pending_upload; el sync subirá el cambio
      await syncNow()
    },
    [loadLocal, syncNow]
  )

  const deleteInvoice = useCallback(
    async (invoiceId: string) => {
      await localDb.softDelete(invoiceId)
      await loadLocal()
      await syncNow()
    },
    [loadLocal, syncNow]
  )

  const addLocalInvoice = useCallback(
    async (invoice: CanonicalInvoice) => {
      await localDb.upsertInvoice(invoice, 'pending_upload')
      await loadLocal()
      await syncNow()
    },
    [loadLocal, syncNow]
  )

  return {
    invoices,
    isLoading,
    isSyncing,
    error,
    lastSyncAt,
    refresh,
    syncNow,
    updateStatus,
    deleteInvoice,
    addLocalInvoice,
  }
}
