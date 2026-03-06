import type { CanonicalInvoice } from '../invoice/types/canonical'

export type ConflictStrategy = 'server_wins' | 'local_wins' | 'latest_timestamp' | 'merge'

/**
 * Resuelve conflictos cuando una misma factura fue modificada
 * tanto en el cliente como en el servidor.
 *
 * Estrategia por escenario:
 *  - Datos parseados automáticamente → server_wins (el servidor es autoritativo)
 *  - Status / anotaciones del usuario → merge (no sobreescribir edits del usuario)
 */
export function resolveConflict(
  local: CanonicalInvoice,
  server: CanonicalInvoice,
  strategy: ConflictStrategy = 'merge'
): CanonicalInvoice {
  switch (strategy) {
    case 'server_wins':
      return { ...server, syncedAt: new Date().toISOString() }

    case 'local_wins':
      return {
        ...local,
        version: Math.max(local.version, server.version) + 1,
        updatedAt: new Date().toISOString(),
        syncedAt: new Date().toISOString(),
      }

    case 'latest_timestamp': {
      const localTs = new Date(local.updatedAt).getTime()
      const serverTs = new Date(server.updatedAt).getTime()
      return localTs > serverTs
        ? { ...local, version: Math.max(local.version, server.version) + 1 }
        : { ...server }
    }

    case 'merge':
    default:
      // Servidor gana para todos los campos parseados automáticamente.
      // Local gana para campos que el usuario puede editar manualmente.
      return {
        ...server,                             // Base: datos del servidor
        // Campos editables por el usuario:
        status: local.status,                  // Estado (pending/approved/rejected)
        // Metadata de sync:
        version: Math.max(local.version, server.version) + 1,
        updatedAt: new Date().toISOString(),
        syncedAt: new Date().toISOString(),
      }
  }
}
