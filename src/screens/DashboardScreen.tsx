import React from 'react'
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator } from 'react-native'
import { useInvoices } from '../hooks/useInvoices'
import { useAuth } from '../hooks/useAuth'
import type { CanonicalInvoice } from '../invoice/types/canonical'

interface Props {
  onConnectEmail: () => void
  onOpenInvoiceList: () => void
}

/**
 * Pantalla principal del dashboard.
 * - Resumen de gastos del mes.
 * - Acceso rápido a conectar correo y lista de facturas.
 * Fase 6: Añadir gráficos (react-native-gifted-charts), alertas de facturas próximas a vencer.
 */
export default function DashboardScreen({ onConnectEmail, onOpenInvoiceList }: Props): React.JSX.Element {
  const { user, signOut } = useAuth()
  const { invoices, isLoading, isSyncing, lastSyncAt } = useInvoices(user?.id ?? null)

  const thisMonth = React.useMemo(() => {
    const now = new Date()
    return invoices.filter((inv: CanonicalInvoice) => {
      const d = new Date(inv.issueDate)
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
    })
  }, [invoices])

  const totalThisMonth = thisMonth.reduce(
    (sum: number, inv: CanonicalInvoice) => sum + inv.totalAmount,
    0
  )

  const formatCOP = (amount: number) =>
    new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(amount)

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Encabezado */}
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>Hola 👋</Text>
          <Text style={styles.email}>{user?.email}</Text>
        </View>
        <TouchableOpacity onPress={signOut}>
          <Text style={styles.signOutText}>Salir</Text>
        </TouchableOpacity>
      </View>

      {/* Tarjeta resumen del mes */}
      <View style={styles.summaryCard}>
        <Text style={styles.summaryTitle}>Gastos este mes</Text>
        <Text style={styles.summaryAmount}>{formatCOP(totalThisMonth)}</Text>
        <Text style={styles.summaryCount}>{thisMonth.length} factura(s)</Text>
        {(isLoading || isSyncing)
          ? <ActivityIndicator style={{ marginTop: 8 }} color="#93c5fd" size="small" />
          : lastSyncAt
            ? <Text style={styles.syncLabel}>Última sync: {new Date(lastSyncAt).toLocaleTimeString('es-CO')}</Text>
            : <Text style={styles.syncLabel}> </Text>
        }
      </View>

      {/* Acciones rápidas */}
      <Text style={styles.sectionTitle}>Acciones</Text>
      <View style={styles.actionsRow}>
        <TouchableOpacity style={styles.actionCard} onPress={onConnectEmail}>
          <Text style={styles.actionIcon}>✉️</Text>
          <Text style={styles.actionLabel}>Conectar correo</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.actionCard} onPress={onOpenInvoiceList}>
          <Text style={styles.actionIcon}>📋</Text>
          <Text style={styles.actionLabel}>Ver facturas</Text>
        </TouchableOpacity>
      </View>

      {/* TODO Fase 6: Gráfico de barras por mes (react-native-gifted-charts) */}
      {/* TODO Fase 6: Lista de facturas recientes */}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  content: { padding: 20 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 },
  greeting: { fontSize: 22, fontWeight: '700', color: '#111827' },
  email: { fontSize: 13, color: '#6b7280', marginTop: 2 },
  signOutText: { color: '#ef4444', fontSize: 14, fontWeight: '600' },
  summaryCard: {
    backgroundColor: '#2563eb',
    borderRadius: 16,
    padding: 24,
    marginBottom: 24,
  },
  summaryTitle: { color: '#bfdbfe', fontSize: 14, marginBottom: 8 },
  summaryAmount: { color: '#fff', fontSize: 32, fontWeight: '700', marginBottom: 4 },
  summaryCount: { color: '#bfdbfe', fontSize: 14 },
  syncLabel: { color: '#93c5fd', fontSize: 11, marginTop: 8, minHeight: 18 },
  sectionTitle: { fontSize: 17, fontWeight: '600', color: '#374151', marginBottom: 12 },
  actionsRow: { flexDirection: 'row', gap: 12 },
  actionCard: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  actionIcon: { fontSize: 28, marginBottom: 8 },
  actionLabel: { fontSize: 13, fontWeight: '600', color: '#374151', textAlign: 'center' },
})
