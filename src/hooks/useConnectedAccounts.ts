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
  error: string | null
  connectGmail: () => Promise<void>
  runBackfill: () => Promise<void>
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
  const [error, setError]                 = useState<string | null>(null)
  // Ref para evitar backfills concurrentes (no usar state para evitar stale closures)
  const backfillRunningRef    = useRef(false)
  // Auto-disparar backfill solo una vez por montaje del hook
  const hasAutoBackfilledRef  = useRef(false)

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
    } catch (e) {
      setError('Error al cargar cuentas conectadas')
      console.error('[useConnectedAccounts] loadAccounts:', e)
    } finally {
      setIsLoading(false)
    }
  }, [userId])

  useEffect(() => { void loadAccounts() }, [loadAccounts])

  // ── runBackfill: lógica de escaneo extraída para reutilizarla ───────────────
  // Se llama tanto desde connectGmail (primera conexión) como desde el
  // auto-trigger de montaje (cuenta ya conectada sin escaneo previo).
  const runBackfill = useCallback(async () => {
    if (!userId || backfillRunningRef.current) return
    backfillRunningRef.current = true
    setIsBackfilling(true)
    setBackfillCount(0)
    setBackfillTotal(0)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return
      let pageToken: string | undefined
      let accProcessed = 0
      do {
        const backfillRes = await fetch(
          `${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/backfill-gmail`,
          {
            method:  'POST',
            headers: {
              'Content-Type':  'application/json',
              'Authorization': `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({ userId, ...(pageToken ? { pageToken } : {}) }),
          }
        )
        const bf = await backfillRes.json() as {
          processed: number
          total: number
          nextPageToken?: string | null
          done: boolean
        }
        accProcessed += bf.processed
        pageToken = bf.nextPageToken ?? undefined
        setBackfillCount(accProcessed)
        setBackfillTotal(bf.total)
        if (bf.done) break
      } while (pageToken)
      // Recargar cuentas y forzar recarga de facturas en useInvoices
      await loadAccounts()
      DeviceEventEmitter.emit(INVOICES_UPDATED_EVENT)
      // Forzar recarga de facturas en useInvoices (Realtime puede llegar tarde)
      DeviceEventEmitter.emit(INVOICES_UPDATED_EVENT)
    } catch (bfErr) {
      console.warn('[useConnectedAccounts] backfill error:', bfErr)
    } finally {
      backfillRunningRef.current = false
      setIsBackfilling(false)
    }
  }, [userId, loadAccounts])

  // Auto-disparar backfill si la cuenta ya está conectada pero nunca se escaneó.
  // hasAutoBackfilledRef garantiza que solo corra una vez por montaje del hook,
  // evitando loops ante re-renders.
  useEffect(() => {
    if (isLoading) return
    if (hasAutoBackfilledRef.current) return
    const needsBackfill = accounts.some(
      a => a.provider === 'gmail' && a.isActive && a.backfillCompletedAt === null
    )
    if (needsBackfill) {
      hasAutoBackfilledRef.current = true
      void runBackfill()
    }
  }, [isLoading, accounts, runBackfill])

  const connectGmail = useCallback(async () => {
    if (!userId) return
    setError(null)
    setIsConnecting(true)
    try {
      // 1. Generar PKCE
      const codeVerifier  = generateCodeVerifier()
      const codeChallenge = await generateCodeChallenge(codeVerifier)

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
        ...(emailHint ? { login_hint: emailHint } : {}),
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

      const json = await res.json() as { success?: boolean; error?: string }
      if (!res.ok || !json.success) throw new Error(json.error ?? 'Error al conectar cuenta')

      await loadAccounts()

      // Iniciar backfill (reutiliza runBackfill para no duplicar lógica)
      await runBackfill()
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

  return { accounts, isLoading, isConnecting, isBackfilling, backfillCount, backfillTotal, error, connectGmail, runBackfill, disconnect }
}
