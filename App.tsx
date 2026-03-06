import React, { useState } from 'react'
import { StyleSheet, StatusBar, View, Platform } from 'react-native'
import { useAuth } from './src/hooks/useAuth'
import { useRealtimeSync } from './src/hooks/useRealtimeSync'
import LoginScreen from './src/screens/LoginScreen'
import DashboardScreen from './src/screens/DashboardScreen'
import InvoiceListScreen from './src/screens/InvoiceListScreen'
import InvoiceDetailScreen from './src/screens/InvoiceDetailScreen'
import QRScannerScreen from './src/screens/QRScannerScreen'
import ConnectEmailScreen from './src/screens/ConnectEmailScreen'
import type { CanonicalInvoice } from './src/invoice/types/canonical'

/** Altura del status bar en cada plataforma */
const TOP_INSET = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 24) : 44

type Screen =
  | { name: 'dashboard' }
  | { name: 'invoiceList' }
  | { name: 'invoiceDetail'; invoice: CanonicalInvoice }
  | { name: 'qrScanner' }
  | { name: 'connectEmail' }

/**
 * Navegación manual mínima sin react-navigation.
 * Fase 6: Migrar a react-navigation (Stack + Tabs).
 */
export default function App(): React.JSX.Element {
  const { user, isLoading } = useAuth()
  const [screen, setScreen] = useState<Screen>({ name: 'dashboard' })

  // Mantener Realtime activo para el usuario autenticado
  useRealtimeSync(user?.id ?? null)

  if (isLoading) {
    return <View style={styles.splash} />
  }

  if (!user) {
    return (
      <View style={styles.container}>
        <StatusBar barStyle="dark-content" />
        <LoginScreen />
      </View>
    )
  }

  const navigate = (s: Screen) => setScreen(s)

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" />

      {screen.name === 'dashboard' && (
        <DashboardScreen
          onConnectEmail={() => navigate({ name: 'connectEmail' })}
          onOpenInvoiceList={() => navigate({ name: 'invoiceList' })}
        />
      )}

      {screen.name === 'invoiceList' && (
        <InvoiceListScreen
          onSelectInvoice={(invoice) => navigate({ name: 'invoiceDetail', invoice })}
          onOpenScanner={() => navigate({ name: 'qrScanner' })}
          onBack={() => navigate({ name: 'dashboard' })}
        />
      )}

      {screen.name === 'invoiceDetail' && (
        <InvoiceDetailScreen
          invoice={(screen as { name: 'invoiceDetail'; invoice: CanonicalInvoice }).invoice}
          onBack={() => navigate({ name: 'invoiceList' })}
        />
      )}

      {screen.name === 'qrScanner' && (
        <QRScannerScreen onClose={() => navigate({ name: 'invoiceList' })} />
      )}

      {screen.name === 'connectEmail' && (
        <ConnectEmailScreen onBack={() => navigate({ name: 'dashboard' })} />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb', paddingTop: TOP_INSET },
  splash: { flex: 1, backgroundColor: '#2563eb', paddingTop: TOP_INSET },
})
