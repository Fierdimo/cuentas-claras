import { useState, useEffect, useCallback, useRef } from 'react'
import { DeviceEventEmitter } from 'react-native'
import * as WebBrowser from 'expo-web-browser'
import * as Notifications from 'expo-notifications'
import * as Crypto from 'expo-crypto'
import { supabase } from '../supabase/client'
import { INVOICES_UPDATED_EVENT } from './useRealtimeSync'

// Necesario para cerrar el browser de OAuth en Android
WebBrowser.maybeCompleteAuthSession()

// ─── PKCE helpers (expo-crypto — compatible con Hermes) ──────────────────────

function generateCodeVerifier(): string {
  const bytes = Crypto.getRandomBytes(32)
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    verifier,
    { encoding: Crypto.CryptoEncoding.BASE64 }
  )
  // Base64 → Base64url
  return digest.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

// ─── Constantes ───────────────────────────────────────────────────────────────

// El flujo completo:
//  App → Google (redirect_uri = HTTPS Edge Function oauth-callback)
//       → oauth-callback redirige a com.cuentas.app://oauth2redirect?code=...
//       → App captura el custom scheme y envía code + codeVerifier a store-oauth-token
const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
// Debe coincidir con el redirect_uri que envía store-oauth-token a Google
const OAUTH_CALLBACK_URI   = `${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/oauth-callback`
// URI que WebBrowser.openAuthSessionAsync usará para detectar que la auth terminó
const APP_REDIRECT_URI     = 'com.cuentas.app://oauth2redirect'

// Tiempo mínimo entre sincronizaciones automáticas al abrir la app
const SYNC_COOLDOWN_MS = 5 * 60 * 1000

export interface ConnectedAccount {
  id: string
  provider: 'gmail' | 'outlook'
  emailAddress: string
  isActive: boolean
  lastRefreshed: string
  backfillCompletedAt: string | null
}

interface UseConnectedAccountsReturn {
  accounts: ConnectedAccount[]
  isLoading: boolean
  isConnecting: boolean
  isBackfilling: boolean
  backfillCount: number
  backfillTotal: number
  isBankDetecting: boolean
  bankDetectedCount: number
  error: string | null
  connectGmail: (hintOverride?: string | null) => Promise<void>
  runBackfill: (emailAddress?: string) => Promise<void>
  runBankDetection: (emailAddress?: string) => Promise<void>
  disconnect: (accountId: string) => Promise<void>
}

interface UseConnectedAccountsOptions {
  emailHint?: string
}

/**
 * Hook para gestionar cuentas de correo conectadas.
 *
 * Flujo OAuth PKCE:
 *  1. expo-auth-session abre el browser con el URL de Google
 *  2. El usuario aprueba el acceso
 *  3. Google redirige con el `code` al redirect URI de la app
 *  4. El `code` + `codeVerifier` se envían a la Edge Function `store-oauth-token`
 *  5. La Edge Function hace el exchange y guarda el refresh_token en Vault
 *  6. El refresh_token NUNCA toca el dispositivo
 */
export function useConnectedAccounts(
  userId: string | null,
  { emailHint }: UseConnectedAccountsOptions = {}
): UseConnectedAccountsReturn {
  const [accounts, setAccounts]           = useState<ConnectedAccount[]>([])
  const [isLoading, setIsLoading]         = useState(true)
  const [isConnecting, setIsConnecting]   = useState(false)
  const [isBackfilling, setIsBackfilling] = useState(false)
  const [backfillCount, setBackfillCount] = useState(0)
  const [backfillTotal, setBackfillTotal] = useState(0)
  const [error, setError]                         = useState<string | null>(null)
  const [isBankDetecting, setIsBankDetecting]     = useState(false)
  const [bankDetectedCount, setBankDetectedCount] = useState(0)
  // Ref para evitar backfills concurrentes (no usar state para evitar stale closures)
  const backfillRunningRef      = useRef(false)
  const bankDetectionRunningRef = useRef(false)
  // Auto-disparar backfill solo una vez por montaje del hook
  const hasAutoBackfilledRef    = useRef(false)
  const hasAutoBankDetectedRef  = useRef(false)
  // Ref para acceder a accounts sin stale closures dentro de runBackfill
  const accountsRef             = useRef<ConnectedAccount[]>([])

  // Cargar cuentas conectadas desde la vista pública de Supabase
  const loadAccounts = useCallback(async () => {
    if (!userId) { setAccounts([]); setIsLoading(false); return }
    setIsLoading(true)
    try {
      const { data, error: dbError } = await supabase
        .from('connected_accounts')
        .select('id, provider, emailAddress, isActive, lastRefreshed, backfillCompletedAt')
      if (dbError) throw dbError
      const mapped: ConnectedAccount[] = (data ?? []).map((row: {
        id: string
        provider: string
        emailAddress: string
        isActive: boolean
        lastRefreshed: string
        backfillCompletedAt: string | null
      }) => ({
        id:                  row.id,
        provider:            row.provider as ConnectedAccount['provider'],
        emailAddress:        row.emailAddress,
        isActive:            row.isActive,
        lastRefreshed:       row.lastRefreshed,
        backfillCompletedAt: row.backfillCompletedAt ?? null,
      }))
      setAccounts(mapped)
      accountsRef.current = mapped
    } catch (e) {
      setError('Error al cargar cuentas conectadas')
      console.error('[useConnectedAccounts] loadAccounts:', e)
    } finally {
      setIsLoading(false)
    }
  }, [userId])

  useEffect(() => { void loadAccounts() }, [loadAccounts])

  // ── runBackfill: escanea una cuenta específica o todas las que necesitan sync ──
  // emailAddress?: si se especifica, sincroniza solo esa cuenta.
  //               si no, sincroniza todas las cuentas Gmail activas que lo necesiten,
  //               respetando SYNC_COOLDOWN_MS entre sincronizaciones automáticas.
  const runBackfill = useCallback(async (emailAddress?: string) => {
    if (!userId || backfillRunningRef.current) return

    // Determinar qué cuentas sincronizar ANTES de adquirir el lock (sin flicker de UI)
    const toSync: string[] = emailAddress
      ? [emailAddress]
      : accountsRef.current
          .filter(a => {
            if (a.provider !== 'gmail' || !a.isActive) return false
            if (!a.backfillCompletedAt) return true  // primer sync → 90 días
            return (Date.now() - new Date(a.backfillCompletedAt).getTime()) > SYNC_COOLDOWN_MS
          })
          .map(a => a.emailAddress)

    if (toSync.length === 0) return  // nada que sincronizar

    backfillRunningRef.current = true
    setIsBackfilling(true)
    setBackfillCount(0)
    setBackfillTotal(0)

    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return

      let totalProcessed = 0

      // Sincronizar cada cuenta secuencialmente
      for (const email of toSync) {
        let pageToken: string | undefined
        let sinceDateToken: string | undefined
        do {
          const backfillRes = await fetch(
            `${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/backfill-gmail`,
            {
              method:  'POST',
              headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${session.access_token}`,
              },
              body: JSON.stringify({
                userId,
                emailAddress: email,
                ...(pageToken      ? { pageToken }                : {}),
                ...(sinceDateToken ? { sinceDate: sinceDateToken } : {}),
              }),
            }
          )
          const bf = await backfillRes.json() as {
            processed: number
            total: number
            nextPageToken?: string | null
            done: boolean
            sinceDate?: string
            isIncremental?: boolean
          }
          sinceDateToken  = bf.sinceDate ?? sinceDateToken
          totalProcessed += bf.processed
          pageToken       = bf.nextPageToken ?? undefined
          setBackfillCount(totalProcessed)
          setBackfillTotal(bf.total)
          if (bf.done) break
        } while (pageToken)
      }

      await loadAccounts()
      DeviceEventEmitter.emit(INVOICES_UPDATED_EVENT)
    } catch (bfErr) {
      console.warn('[useConnectedAccounts] backfill error:', bfErr)
    } finally {
      backfillRunningRef.current = false
      setIsBackfilling(false)
    }
  }, [userId, loadAccounts])

  // ── runBankDetection: escanea correos bancarios para detectar movimientos ────
  // Mismo patrón paginado que runBackfill — llama detect-bank-emails con pageToken.
  const runBankDetection = useCallback(async (emailAddress?: string) => {
    if (!userId || bankDetectionRunningRef.current) return

    const toScan: string[] = emailAddress
      ? [emailAddress]
      : accountsRef.current
          .filter(a => a.provider === 'gmail' && a.isActive)
          .map(a => a.emailAddress)

    if (toScan.length === 0) return

    bankDetectionRunningRef.current = true
    setIsBankDetecting(true)
    setBankDetectedCount(0)

    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return

      let totalDetected = 0

      for (const email of toScan) {
        let pageToken:    string | undefined
        let sinceDateToken: string | undefined
        do {
          const res = await fetch(
            `${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/detect-bank-emails`,
            {
              method:  'POST',
              headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${session.access_token}`,
              },
              body: JSON.stringify({
                userId,
                emailAddress: email,
                ...(pageToken      ? { pageToken }                : {}),
                ...(sinceDateToken ? { sinceDate: sinceDateToken } : {}),
              }),
            }
          )
          const data = await res.json() as {
            detected:      number
            created:       number
            done:          boolean
            sinceDate?:    string
            nextPageToken?: string
          }
          sinceDateToken  = data.sinceDate ?? sinceDateToken
          totalDetected  += data.created
          pageToken       = data.nextPageToken ?? undefined
          setBankDetectedCount(totalDetected)
          if (data.done) break
        } while (pageToken)
      }

      if (totalDetected > 0) {
        DeviceEventEmitter.emit('BANK_MOVEMENTS_UPDATED')
      }
    } catch (err) {
      console.warn('[useConnectedAccounts] bankDetection error:', err)
    } finally {
      bankDetectionRunningRef.current = false
      setIsBankDetecting(false)
    }
  }, [userId])

  // Auto-disparar sync al montar si hay alguna cuenta Gmail activa.
  // runBackfill() sin args determina internamente qué cuentas necesitan sync
  // (primer sync vs. incremental, respetando SYNC_COOLDOWN_MS).
  // hasAutoBackfilledRef evita múltiples disparos por re-renders en el mismo montaje.
  useEffect(() => {
    if (isLoading) return
    if (!hasAutoBackfilledRef.current) {
      const hasGmailAccount = accounts.some(a => a.provider === 'gmail' && a.isActive)
      if (hasGmailAccount) {
        hasAutoBackfilledRef.current = true
        void runBackfill()
      }
    }
    if (!hasAutoBankDetectedRef.current) {
      const hasGmailAccount = accounts.some(a => a.provider === 'gmail' && a.isActive)
      if (hasGmailAccount) {
        hasAutoBankDetectedRef.current = true
        void runBankDetection()
      }
    }
  }, [isLoading, accounts, runBackfill, runBankDetection])

  const connectGmail = useCallback(async (hintOverride?: string | null) => {
    if (!userId) return
    setError(null)
    setIsConnecting(true)
    try {
      // 1. Generar PKCE
      const codeVerifier  = generateCodeVerifier()
      const codeChallenge = await generateCodeChallenge(codeVerifier)

      // hintOverride === undefined  → usar emailHint del hook (cuenta principal Google)
      // hintOverride === null       → sin hint, el usuario elige la cuenta en el browser
      // hintOverride === 'email...' → hint explícito
      const hint = hintOverride === undefined ? emailHint : (hintOverride ?? undefined)

      // 2. Construir URL de autorización de Google
      const params = new URLSearchParams({
        client_id:             process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID!,
        redirect_uri:          OAUTH_CALLBACK_URI,
        response_type:         'code',
        scope:                 'https://www.googleapis.com/auth/gmail.readonly email profile',
        access_type:           'offline',
        prompt:                'consent',
        code_challenge:        codeChallenge,
        code_challenge_method: 'S256',
        ...(hint ? { login_hint: hint } : {}),
      })
      const authUrl = `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`

      // 3. Abrir browser — se cerrará cuando detecte APP_REDIRECT_URI
      const result = await WebBrowser.openAuthSessionAsync(authUrl, APP_REDIRECT_URI)

      if (result.type !== 'success' || !result.url) return

      // 4. Extraer code de la URL de retorno
      const returnUrl  = new URL(result.url)
      const code       = returnUrl.searchParams.get('code')
      const oauthError = returnUrl.searchParams.get('error')

      if (oauthError) throw new Error(`Google OAuth: ${oauthError}`)
      if (!code) throw new Error('No se recibió el código de autorización')

      // 5. Enviar code + codeVerifier a la Edge Function para exchange seguro
      // El push token es opcional — falla si Firebase no está configurado (dev builds)
      let expoPushToken: string | undefined
      try {
        const pt = await Notifications.getExpoPushTokenAsync()
        expoPushToken = pt.data
      } catch {
        console.warn('[useConnectedAccounts] Push token no disponible (requiere FCM en prod)')
      }

      const { data: { session } } = await supabase.auth.getSession()

      const res = await fetch(
        `${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/store-oauth-token`,
        {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${session?.access_token}`,
          },
          body: JSON.stringify({
            code,
            redirectUri:  OAUTH_CALLBACK_URI,
            codeVerifier,
            userId,
            ...(expoPushToken ? { expoPushToken } : {}),
          }),
        }
      )

      const json = await res.json() as { success?: boolean; error?: string; emailAddress?: string }
      if (!res.ok || !json.success) throw new Error(json.error ?? 'Error al conectar cuenta')

      await loadAccounts()
      // Iniciar backfill e detección bancaria para la cuenta recién conectada
      await runBackfill(json.emailAddress)
      void runBankDetection(json.emailAddress)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al conectar Gmail')
    } finally {
      setIsConnecting(false)
    }
  }, [userId, emailHint, loadAccounts, runBackfill])

  const disconnect = useCallback(async (accountId: string) => {
    setError(null)
    try {
      // Marcar como inactivo — la Edge Function deja de procesar correos
      const { data: { session } } = await supabase.auth.getSession()
      await fetch(
        `${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/revoke-oauth-token`,
        {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${session?.access_token}`,
          },
          body: JSON.stringify({ accountId }),
        }
      )
      await loadAccounts()
    } catch (e) {
      setError('Error al desconectar cuenta')
    }
  }, [loadAccounts])

  return { accounts, isLoading, isConnecting, isBackfilling, backfillCount, backfillTotal, isBankDetecting, bankDetectedCount, error, connectGmail, runBackfill, runBankDetection, disconnect }
}
