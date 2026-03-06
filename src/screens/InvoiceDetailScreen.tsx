import React from 'react'
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert } from 'react-native'
import type { CanonicalInvoice } from '../invoice/types/canonical'
import { useInvoices } from '../hooks/useInvoices'
import { useAuth } from '../hooks/useAuth'

interface Props {
  invoice: CanonicalInvoice
  onBack: () => void
}

/**
 * Detalle de una factura individual.
 * Muestra todos los campos del modelo CanonicalInvoice.
 * Fase 6: Añadir gráfico de desglose de impuestos, PDF viewer, acción de exportar.
 */
export default function InvoiceDetailScreen({ invoice, onBack }: Props): React.JSX.Element {
  const { user } = useAuth()
  const { updateStatus, deleteInvoice } = useInvoices(user?.id ?? null)

  const formatAmount = (amount: number) =>
    new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: invoice.currency,
      minimumFractionDigits: 0,
    }).format(amount)

  const handleDelete = () => {
    Alert.alert(
      'Eliminar factura',
      '¿Seguro que quieres eliminar esta factura? Esta acción es irreversible.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Eliminar',
          style: 'destructive',
          onPress: async () => {
            await deleteInvoice(invoice.id)
            onBack()
          },
        },
      ]
    )
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Header */}
      <TouchableOpacity onPress={onBack} style={styles.backButton}>
        <Text style={styles.backText}>← Volver</Text>
      </TouchableOpacity>

      <Text style={styles.issuerName}>{invoice.issuer.legalName}</Text>
      <Text style={styles.issuerNit}>NIT {invoice.issuer.taxId}</Text>

      {/* Resumen */}
      <View style={styles.section}>
        <Row label="N° Factura" value={invoice.invoiceNumber} />
        <Row label="Fecha" value={new Date(invoice.issueDate).toLocaleDateString('es-CO')} />
        <Row label="Moneda" value={invoice.currency} />
        <Row label="Estado" value={invoice.status} />
        <Row label="Fuente" value={invoice.source} />
        {invoice.authorizationCode && <Row label="CUFE" value={`${invoice.authorizationCode.slice(0, 20)}…`} />}
      </View>

      {/* Receptor */}
      <Text style={styles.sectionTitle}>Receptor</Text>
      <View style={styles.section}>
        <Row label="Nombre" value={invoice.recipient.legalName} />
        <Row label="NIT" value={invoice.recipient.taxId} />
      </View>

      {/* Totales */}
      <Text style={styles.sectionTitle}>Totales</Text>
      <View style={styles.section}>
        <Row label="Subtotal" value={formatAmount(invoice.subtotal)} />
        <Row label="Descuentos" value={formatAmount(invoice.totalDiscount ?? 0)} />
        <Row label="Impuestos" value={formatAmount(invoice.totalTax)} />
        <Row label="Total" value={formatAmount(invoice.totalAmount)} bold />
      </View>

      {/* Impuestos detallados */}
      {invoice.taxes.length > 0 && (
        <>
          <Text style={styles.sectionTitle}>Desglose de impuestos</Text>
          <View style={styles.section}>
            {invoice.taxes.map((tax, i) => (
              <Row
                key={i}
                label={`${tax.taxType} ${(tax.taxRate * 100).toFixed(0)}%`}
                value={formatAmount(tax.taxAmount)}
              />
            ))}
          </View>
        </>
      )}

      {/* Líneas */}
      {invoice.lineItems.length > 0 && (
        <>
          <Text style={styles.sectionTitle}>Ítems ({invoice.lineItems.length})</Text>
          {invoice.lineItems.map((line) => (
            <View key={line.lineNumber} style={styles.lineCard}>
              <Text style={styles.lineDescription}>{line.description}</Text>
              <Text style={styles.lineDetail}>
                {line.quantity} × {formatAmount(line.unitPrice)} = {formatAmount(line.lineTotal)}
              </Text>
            </View>
          ))}
        </>
      )}

      {/* Acción eliminar */}
      <TouchableOpacity style={styles.deleteButton} onPress={handleDelete}>
        <Text style={styles.deleteButtonText}>Eliminar factura</Text>
      </TouchableOpacity>

      {/* TODO Fase 6: PDF viewer, exportar CSV, cambiar estado */}
    </ScrollView>
  )
}

function Row({
  label,
  value,
  bold = false,
}: {
  label: string
  value: string
  bold?: boolean
}): React.JSX.Element {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, bold && styles.rowValueBold]}>{value}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  content: { padding: 20, paddingBottom: 60 },
  backButton: { marginBottom: 20 },
  backText: { color: '#2563eb', fontSize: 16 },
  issuerName: { fontSize: 22, fontWeight: '700', color: '#111827', marginBottom: 4 },
  issuerNit: { fontSize: 14, color: '#6b7280', marginBottom: 20 },
  sectionTitle: { fontSize: 16, fontWeight: '600', color: '#374151', marginTop: 20, marginBottom: 8 },
  section: {
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingHorizontal: 16,
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e7eb',
  },
  rowLabel: { fontSize: 14, color: '#6b7280' },
  rowValue: { fontSize: 14, color: '#111827' },
  rowValueBold: { fontWeight: '700', fontSize: 15 },
  lineCard: {
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    elevation: 1,
  },
  lineDescription: { fontSize: 14, color: '#111827', marginBottom: 4 },
  lineDetail: { fontSize: 13, color: '#6b7280' },
  deleteButton: {
    marginTop: 32,
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#ef4444',
  },
  deleteButtonText: { color: '#ef4444', fontSize: 16, fontWeight: '600' },
})
