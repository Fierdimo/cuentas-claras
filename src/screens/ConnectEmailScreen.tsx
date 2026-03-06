import React from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  ScrollView,
} from 'react-native'
import { useConnectedAccounts, type ConnectedAccount } from '../hooks/useConnectedAccounts'
import { useAuth } from '../hooks/useAuth'

interface Props {
  onBack: () => void
}

/**
 * Pantalla para conectar y gestionar cuentas de correo.
 *
 * Cuando el usuario inició sesión con Google, detectamos su email y:
 *  - Mostramos un banner "Tu cuenta Google" con su dirección
 *  - Pre-seleccionamos esa cuenta en el flujo OAuth de Gmail (login_hint)
 *  - Si ya está conectada, mostramos estado activo directamente
 *
 * El flujo OAuth de Gmail es independiente del login con Google:
 *  - Login Google → saber quién eres (Supabase Auth)
 *  - Gmail OAuth → permiso para leer tus correos (gmail.readonly)
 */
export default function ConnectEmailScreen({ onBack }: Props): React.JSX.Element {
  const { user } = useAuth()

  const isGoogleUser = user?.app_metadata?.provider === 'google'
  const googleEmail  = isGoogleUser ? (user?.email ?? undefined) : undefined

  const { accounts, isLoading, isConnecting, isBackfilling, backfillCount, backfillTotal, error, connectGmail, disconnect } =
    useConnectedAccounts(user?.id ?? null, { emailHint: googleEmail })

  React.useEffect(() => {
    if (error) {
      Alert.alert('Error', error)
    }
  }, [error])

  const handleDisconnect = (account: ConnectedAccount) => {
    Alert.alert(
      'Desconectar cuenta',
      `¿Desconectar ${account.emailAddress}? Dejarás de recibir facturas automáticamente.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Desconectar',
          style: 'destructive',
          onPress: () => void disconnect(account.id),
        },
      ]
    )
  }

  // ¿La cuenta Google del usuario ya está conectada para Gmail?
  const googleAccountConnected = isGoogleUser && accounts.some(
    a => a.provider === 'gmail' &&
         a.emailAddress.toLowerCase() === (googleEmail ?? '').toLowerCase()
  )

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <TouchableOpacity onPress={onBack} style={styles.backButton}>
        <Text style={styles.backText}>← Volver</Text>
      </TouchableOpacity>

      <Text style={styles.title}>Correo electrónico</Text>
      <Text style={styles.subtitle}>
        Conecta tu correo para detectar facturas electrónicas DIAN automáticamente.
        Solo leemos adjuntos ZIP — nunca el contenido de tus mensajes.
      </Text>

      {/* Banner cuenta Google detectada */}
      {isGoogleUser && (
        <View style={[
          styles.googleBanner,
          googleAccountConnected ? styles.googleBannerConnected : styles.googleBannerPending,
        ]}>
          <View style={styles.googleBannerRow}>
            <View style={styles.googleDot}>
              <Text style={styles.googleDotText}>G</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.googleBannerTitle}>
                {googleAccountConnected ? '✅ Gmail conectado' : 'Cuenta Google detectada'}
              </Text>
              <Text style={styles.googleBannerEmail}>{googleEmail}</Text>
            </View>
          </View>

          {/* Backfill progress */}
          {isBackfilling && (
            <View style={styles.backfillRow}>
              <ActivityIndicator size="small" color="#2563eb" />
              <Text style={styles.backfillText}>
                Escaneando correos...{' '}
                {backfillCount > 0
                  ? `${backfillCount} factura${backfillCount !== 1 ? 's' : ''} encontrada${backfillCount !== 1 ? 's' : ''}`
                  : 'buscando facturas DIAN'}
                {backfillTotal > 0 && ` (${backfillTotal} correos)`}
              </Text>
            </View>
          )}
          {!isBackfilling && googleAccountConnected && backfillCount > 0 && (
            <Text style={styles.backfillDone}>
              ✅ Escaneo completado · {backfillCount} factura{backfillCount !== 1 ? 's' : ''} importada{backfillCount !== 1 ? 's' : ''}
            </Text>
          )}
          {!googleAccountConnected && (
            <>
              <Text style={styles.googleBannerNote}>
                Iniciaste sesión con esta cuenta. Autoriza el acceso a Gmail para detectar
                facturas automáticamente — es un permiso separado a tu inicio de sesión.
              </Text>
              <TouchableOpacity
                style={[styles.connectGooglePrimary, isConnecting && { opacity: 0.6 }]}
                onPress={() => void connectGmail()}
                disabled={isConnecting}
              >
                {isConnecting ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.connectGooglePrimaryText}>
                    Autorizar acceso a Gmail →
                  </Text>
                )}
              </TouchableOpacity>
            </>
          )}
        </View>
      )}

      {isLoading ? (
        <ActivityIndicator style={{ marginTop: 32 }} color="#2563eb" />
      ) : (
        <>
          {/* Cuentas conectadas */}
          {accounts.length > 0 && (
            <>
              <Text style={styles.sectionTitle}>Cuentas conectadas</Text>
              {accounts.map(account => (
                <View key={account.id} style={styles.accountCard}>
                  <View style={styles.accountInfo}>
                    <Text style={styles.accountIcon}>
                      {account.provider === 'gmail' ? '📧' : '📨'}
                    </Text>
                    <View>
                      <Text style={styles.accountEmail}>{account.emailAddress}</Text>
                      <Text style={styles.accountMeta}>
                        {account.isActive ? '✅ Activa' : '⚠️ Inactiva'} ·{' '}
                        {account.provider === 'gmail' ? 'Gmail' : 'Outlook'}
                      </Text>
                    </View>
                  </View>
                  <TouchableOpacity
                    onPress={() => handleDisconnect(account)}
                    style={styles.disconnectButton}
                  >
                    <Text style={styles.disconnectText}>Desconectar</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </>
          )}

          {/* Botones agregar cuenta — solo mostrar Gmail si no tiene la cuenta Google ya conectada */}
          {!googleAccountConnected && (
            <>
              <Text style={styles.sectionTitle}>
                {accounts.length > 0 ? 'Agregar otra cuenta' : 'Agregar cuenta'}
              </Text>

              {/* Si no es usuario Google, mostrar botón Gmail genérico */}
              {!isGoogleUser && (
                <TouchableOpacity
                  style={[styles.connectButton, isConnecting && styles.connectButtonDisabled]}
                  onPress={() => void connectGmail()}
                  disabled={isConnecting}
                >
                  {isConnecting ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <>
                      <Text style={styles.connectButtonIcon}>G</Text>
                      <Text style={styles.connectButtonText}>Conectar Gmail</Text>
                    </>
                  )}
                </TouchableOpacity>
              )}

              {/* Outlook — Fase 3b */}
              <TouchableOpacity style={[styles.connectButton, styles.connectButtonOutlook]} disabled>
                <Text style={styles.connectButtonIcon}>⊞</Text>
                <Text style={styles.connectButtonText}>Conectar Outlook</Text>
                <Text style={styles.comingSoon}>Próximamente</Text>
              </TouchableOpacity>
            </>
          )}
        </>
      )}

      {/* Nota de privacidad */}
      <View style={styles.privacyNote}>
        <Text style={styles.privacyText}>
          🔒 Tus credenciales se guardan cifradas y nunca se comparten con terceros.
          Puedes revocar el acceso en cualquier momento.
        </Text>
      </View>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  content:   { padding: 20, paddingBottom: 60 },
  backButton: { marginBottom: 20 },
  backText:   { color: '#2563eb', fontSize: 16 },
  title:      { fontSize: 24, fontWeight: '700', color: '#111827', marginBottom: 8 },
  subtitle:   { fontSize: 14, color: '#6b7280', lineHeight: 20, marginBottom: 28 },
  sectionTitle: {
    fontSize: 14, fontWeight: '600', color: '#374151',
    marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.5,
    marginTop: 8,
  },

  // Banner Google
  googleBanner: {
    borderRadius: 12,
    padding: 16,
    marginBottom: 24,
    borderWidth: 1,
  },
  googleBannerConnected: {
    backgroundColor: '#f0fdf4',
    borderColor: '#86efac',
  },
  googleBannerPending: {
    backgroundColor: '#eff6ff',
    borderColor: '#bfdbfe',
  },
  googleBannerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 8,
  },
  googleDot: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#4285F4',
    alignItems: 'center',
    justifyContent: 'center',
  },
  googleDotText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  googleBannerTitle: { fontSize: 14, fontWeight: '700', color: '#111827' },
  googleBannerEmail: { fontSize: 13, color: '#6b7280', marginTop: 2 },
  googleBannerNote: {
    fontSize: 13,
    color: '#3b82f6',
    lineHeight: 18,
    marginBottom: 12,
    marginTop: 4,
  },
  connectGooglePrimary: {
    backgroundColor: '#2563eb',
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
  },
  connectGooglePrimaryText: { color: '#fff', fontWeight: '700', fontSize: 14 },

  // Tarjetas de cuentas
  accountCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  accountInfo:  { flexDirection: 'row', alignItems: 'center', flex: 1 },
  accountIcon:  { fontSize: 24, marginRight: 12 },
  accountEmail: { fontSize: 14, fontWeight: '600', color: '#111827' },
  accountMeta:  { fontSize: 12, color: '#6b7280', marginTop: 2 },
  disconnectButton: { paddingHorizontal: 10, paddingVertical: 6 },
  disconnectText:   { color: '#ef4444', fontSize: 13, fontWeight: '600' },

  // Botones conectar
  connectButton: {
    backgroundColor: '#2563eb',
    borderRadius: 10,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
    gap: 10,
  },
  connectButtonDisabled: { opacity: 0.6 },
  connectButtonOutlook:  { backgroundColor: '#0078d4', opacity: 0.5 },
  connectButtonIcon: { color: '#fff', fontSize: 18, fontWeight: '700' },
  connectButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  comingSoon: { color: '#bfdbfe', fontSize: 11, marginLeft: 4 },

  privacyNote: {
    marginTop: 32,
    backgroundColor: '#eff6ff',
    borderRadius: 10,
    padding: 14,
  },
  privacyText: { fontSize: 13, color: '#3b82f6', lineHeight: 18 },

  // Backfill progress
  backfillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
    marginBottom: 4,
    backgroundColor: '#dbeafe',
    borderRadius: 8,
    padding: 10,
  },
  backfillText: { fontSize: 13, color: '#1d4ed8', flex: 1 },
  backfillDone: { fontSize: 13, color: '#16a34a', marginTop: 6, fontWeight: '600' },
})
