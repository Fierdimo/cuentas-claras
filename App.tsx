import React, { useState, useEffect, useRef } from 'react'
import { StyleSheet, StatusBar, View, Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import { useAuth } from './src/hooks/useAuth'
import { useRealtimeSync } from './src/hooks/useRealtimeSync'
import LoginScreen from './src/screens/LoginScreen'
import DashboardScreen from './src/screens/DashboardScreen'
import InvoiceListScreen from './src/screens/InvoiceListScreen'
import InvoiceDetailScreen from './src/screens/InvoiceDetailScreen'
import QRScannerScreen from './src/screens/QRScannerScreen'
import ConnectEmailScreen from './src/screens/ConnectEmailScreen'
import BankMovementsScreen from './src/screens/BankMovementsScreen'
import SetupNameModal from './src/screens/SetupNameModal'
import type { CanonicalInvoice } from './src/invoice/types/canonical'

/** Altura del status bar en cada plataforma */
const TOP_INSET = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 24) : 44

type Screen =
  | { name: 'dashboard' }
  | { name: 'invoiceList' }
  | { name: 'invoiceDetail'; invoice: CanonicalInvoice }
  | { name: 'qrScanner' }
  | { name: 'connectEmail' }
  | { name: 'bankMovements' }

/**
 * Navegación manual mínima sin react-navigation.
 * Fase 6: Migrar a react-navigation (Stack + Tabs).
 */
export default function App(): React.JSX.Element {
  const { user, isLoading, saveProfileName } = useAuth()
  const [screen, setScreen]           = useState<Screen>({ name: 'dashboard' })
  const [showNameSetup, setShowNameSetup] = useState(false)
  const nameSetupCheckedRef = useRef(false)

  // Mantener Realtime activo para el usuario autenticado
  useRealtimeSync(user?.id ?? null)

  // ── Detectar y guardar nombre del usuario tras login ─────────────────────
  // 1. Google OAuth: full_name está en user_metadata — se guarda automáticamente.
  // 2. Email/password: no hay nombre — se muestra SetupNameModal una sola vez
  //    (el flag 'name_setup_done:<uid>' en SecureStore evita repetirlo).
  useEffect(() => {
    if (!user || isLoading || nameSetupCheckedRef.current) return
    nameSetupCheckedRef.current = true

    const run = async () => {
      const flagKey    = `name_setup_done_${user.id}`
      const alreadySet = await SecureStore.getItemAsync(flagKey)
      if (alreadySet) return

      const oauthName = (user.user_metadata?.full_name as string | undefined)
        ?? (user.user_metadata?.name as string | undefined)
        ?? null

      if (oauthName) {
        // OAuth login — guardar silenciosamente sin molestar al usuario
        await saveProfileName(oauthName)
        await SecureStore.setItemAsync(flagKey, '1')
      } else {
        // Email/password — pedir el nombre una sola vez
        setShowNameSetup(true)
      }
    }
    void run()
  }, [user, isLoading, saveProfileName])

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

  const handleNameSave = async (name: string) => {
    await saveProfileName(name)
    await SecureStore.setItemAsync(`name_setup_done_${user!.id}`, '1')
    setShowNameSetup(false)
  }

  const handleNameSkip = async () => {
    // Mark as done even if skipped \u2014 won't ask again
    await SecureStore.setItemAsync(`name_setup_done_${user!.id}`, '1')
    setShowNameSetup(false)
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" />

      {/* One-time name setup modal (email/password users only) */}
      <SetupNameModal
        visible={showNameSetup}
        onSave={name => { void handleNameSave(name) }}
        onSkip={() => { void handleNameSkip() }}
      />

      {screen.name === 'dashboard' && (
        <DashboardScreen
          onConnectEmail={() => navigate({ name: 'connectEmail' })}
          onOpenInvoiceList={() => navigate({ name: 'invoiceList' })}
          onOpenBankMovements={() => navigate({ name: 'bankMovements' })}
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

      {screen.name === 'bankMovements' && (
        <BankMovementsScreen onBack={() => navigate({ name: 'dashboard' })} />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb', paddingTop: TOP_INSET },
  splash: { flex: 1, backgroundColor: '#2563eb', paddingTop: TOP_INSET },
})
