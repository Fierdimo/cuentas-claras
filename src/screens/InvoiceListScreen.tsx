import React, { useEffect, useRef } from 'react'
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  TouchableHighlight,
} from 'react-native'
import { useInvoices } from '../hooks/useInvoices'
import { useAuth } from '../hooks/useAuth'
import { useConnectedAccounts } from '../hooks/useConnectedAccounts'
import type { CanonicalInvoice } from '../invoice/types/canonical' 

interface Props {
  onSelectInvoice: (invoice: CanonicalInvoice) => void
  onOpenScanner: () => void
  onBack: () => void
}

/**
 * Lista de facturas del usuario.
 * - Lee desde SQLite local (sin latencia de red).
 * - Pull-to-refresh dispara sincronización con Supabase.
 * Fase 6: Añadir filtros, búsqueda, y agrupación por mes.
 */
export default function InvoiceListScreen({ onSelectInvoice, onOpenScanner, onBack }: Props): React.JSX.Element {
  const { user } = useAuth()
  const { invoices, isLoading, isSyncing, refresh } = useInvoices(user?.id ?? null)
  const { runBackfill, isBackfilling, backfillCount } = useConnectedAccounts(user?.id ?? null)

  // Cuando el backfill termina, forzar sync Supabase→SQLite→UI
  const wasBackfillingRef = useRef(false)
  useEffect(() => {
    if (wasBackfillingRef.current && !isBackfilling) {
      void refresh()
    }
    wasBackfillingRef.current = isBackfilling
  }, [isBackfilling, refresh])


  const formatAmount = (amount: number, currency: string) => {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
    }).format(amount)
  }

  const renderItem = ({ item }: { item: CanonicalInvoice }) => (
    <TouchableOpacity style={styles.card} onPress={() => onSelectInvoice(item)}>
      <View style={styles.cardHeader}>
        <Text style={styles.issuerName} numberOfLines={1}>
          {item.issuer.legalName}
        </Text>
      </View>
      <Text style={styles.invoiceNumber}>Factura {item.invoiceNumber}</Text>
      <View style={styles.cardFooter}>
        <Text style={styles.date}>{new Date(item.issueDate).toLocaleDateString('es-CO')}</Text>
        <Text style={styles.amount}>
          {formatAmount(item.totalAmount, item.currency)}
        </Text>
      </View>
    </TouchableOpacity>
  )

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#2563eb" />
      </View>
    )
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableHighlight onPress={onBack} underlayColor="#e5e7eb" style={styles.backButton}>
          <Text style={styles.backText}>← Atrás</Text>
        </TouchableHighlight>

        <TouchableOpacity
          style={[styles.scanButton, isBackfilling && styles.scanButtonActive]}
          onPress={() => void runBackfill()}
          disabled={isBackfilling}
        >
          {isBackfilling ? (
            <View style={styles.scanButtonInner}>
              <ActivityIndicator size="small" color="#2563eb" />
              <Text style={styles.scanButtonText}>
                {backfillCount > 0 ? `${backfillCount} encontradas` : 'Escaneando...'}
              </Text>
            </View>
          ) : (
            <View style={styles.scanButtonInner}>
              <Text style={styles.scanButtonIcon}>📧</Text>
              <Text style={styles.scanButtonText}>Escanear correos</Text>
            </View>
          )}
        </TouchableOpacity>
      </View>
      <FlatList
        data={invoices}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={invoices.length === 0 ? styles.centered : undefined}
        refreshControl={
          <RefreshControl refreshing={isSyncing} onRefresh={refresh} tintColor="#2563eb" />
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyTitle}>Sin facturas</Text>
            <Text style={styles.emptySubtitle}>
              Conecta tu correo o escanea un QR para empezar.
            </Text>
          </View>
        }
      />
      {/* FAB QR Scanner */}
      <TouchableOpacity style={styles.fab} onPress={onOpenScanner}>
        <Text style={styles.fabText}>QR</Text>
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  centered:  { flex: 1, justifyContent: 'center', alignItems: 'center' },

  // ── Header ────────────────────────────────────────────────────────────────
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    backgroundColor: '#fff',
  },
  backButton: { paddingHorizontal: 16, paddingVertical: 12 },
  backText:   { fontSize: 15, color: '#2563eb' },
  scanButton: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginRight: 8,
    borderRadius: 8,
    backgroundColor: '#eff6ff',
  },
  scanButtonActive: { backgroundColor: '#dbeafe' },
  scanButtonInner:  { flexDirection: 'row', alignItems: 'center', gap: 6 },
  scanButtonIcon:   { fontSize: 14 },
  scanButtonText:   { fontSize: 13, color: '#2563eb', fontWeight: '600' },

  // ── Cards ─────────────────────────────────────────────────────────────────
  card: {
    backgroundColor: '#fff',
    margin: 12,
    marginBottom: 0,
    borderRadius: 12,
    padding: 16,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  issuerName:   { fontSize: 15, fontWeight: '600', color: '#111827', flex: 1 },
  invoiceNumber:{ fontSize: 12, color: '#6b7280', marginBottom: 8 },
  cardFooter:   { flexDirection: 'row', justifyContent: 'space-between' },
  date:         { fontSize: 13, color: '#9ca3af' },
  amount:       { fontSize: 15, fontWeight: '700', color: '#111827' },

  // ── Empty state ───────────────────────────────────────────────────────────
  emptyContainer: { alignItems: 'center', padding: 40 },
  emptyTitle:     { fontSize: 20, fontWeight: '600', color: '#374151', marginBottom: 8 },
  emptySubtitle:  { fontSize: 14, color: '#9ca3af', textAlign: 'center' },

  // ── FAB ───────────────────────────────────────────────────────────────────
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    backgroundColor: '#2563eb',
    width: 56,
    height: 56,
    borderRadius: 28,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
  },
  fabText: { color: '#fff', fontWeight: '700', fontSize: 14 },
})
