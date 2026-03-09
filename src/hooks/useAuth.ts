import { useState, useEffect, useCallback } from 'react'
import type { Session, User, AuthError } from '@supabase/supabase-js'
import * as WebBrowser from 'expo-web-browser'
import { makeRedirectUri } from 'expo-auth-session'
import { supabase } from '../supabase/client'

// Necesario para cerrar el browser en Android después del redirect
WebBrowser.maybeCompleteAuthSession()

interface UseAuthState {
  session: Session | null
  user: User | null
  isLoading: boolean
  error: AuthError | null
}

interface UseAuthActions {
  signInWithEmail:   (email: string, password: string) => Promise<void>
  signUpWithEmail:   (email: string, password: string) => Promise<void>
  signInWithGoogle:  () => Promise<void>
  signOut:           () => Promise<void>
  clearError:        () => void
  saveProfileName:   (name: string) => Promise<void>
}

type UseAuthReturn = UseAuthState & UseAuthActions

/**
 * Hook de autenticación Supabase.
 *
 * Gestiona el ciclo de vida de la sesión:
 * - Recupera la sesión existente del SecureStore al montar.
 * - Suscribe a `onAuthStateChange` para actualizaciones en tiempo real
 *   (login, logout, token refresh).
 * - Expone helpers para email/password y sign-out.
 *
 * Fase 3 agregará `signInWithGmail()` y `signInWithOutlook()` aquí.
 */
export function useAuth(): UseAuthReturn {
  const [session, setSession] = useState<Session | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<AuthError | null>(null)

  useEffect(() => {
    // Recuperar sesión existente
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s)
      setUser(s?.user ?? null)
      setIsLoading(false)
    })

    // Suscribirse a cambios de sesión
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s)
      setUser(s?.user ?? null)
      setIsLoading(false)
    })

    return () => subscription.unsubscribe()
  }, [])

  const signInWithEmail = useCallback(async (email: string, password: string) => {
    setError(null)
    setIsLoading(true)
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password })
    if (authError) setError(authError)
    setIsLoading(false)
  }, [])

  const signUpWithEmail = useCallback(async (email: string, password: string) => {
    setError(null)
    setIsLoading(true)
    const { error: authError } = await supabase.auth.signUp({ email, password })
    if (authError) setError(authError)
    setIsLoading(false)
  }, [])

  const signInWithGoogle = useCallback(async () => {
    setError(null)
    setIsLoading(true)
    try {
      const redirectTo = makeRedirectUri({
        scheme: 'com.cuentas.app',
        path: 'auth/callback',
      })

      const { data, error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          skipBrowserRedirect: true,
          redirectTo,
        },
      })

      if (oauthError) {
        setError(oauthError)
        return
      }

      if (!data.url) return

      const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo)

      if (result.type === 'success' && result.url) {
        // Supabase devuelve los tokens en el fragmento (#) de la URL
        const fragment = result.url.includes('#')
          ? result.url.split('#')[1]
          : result.url.split('?')[1] ?? ''
        const params = new URLSearchParams(fragment)
        const accessToken = params.get('access_token')
        const refreshToken = params.get('refresh_token')

        if (accessToken && refreshToken) {
          const { error: sessionError } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          })
          if (sessionError) setError(sessionError)
        }
      }
    } catch (_e) {
      // Usuario canceló el browser — no es un error real
    } finally {
      setIsLoading(false)
    }
  }, [])

  const signOut = useCallback(async () => {
    setError(null)
    await supabase.auth.signOut()
  }, [])

  const clearError = useCallback(() => setError(null), [])

  /**
   * Guarda el nombre del usuario en user_own_counterparts (source_bank=null).
   * Se usa tanto para auto-guardar desde el perfil OAuth como para el nombre
   * ingresado manualmente. UPSERT por (user_id, name_lower) — idempotente.
   */
  const saveProfileName = useCallback(async (name: string) => {
    if (!user) return
    const trimmed = name.trim()
    if (!trimmed) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any)
      .from('user_own_counterparts')
      .upsert(
        {
          user_id:    user.id,
          name:       trimmed,
          name_lower: trimmed.toLowerCase(),
          source_bank: null,   // null = proviene del perfil, no de un movimiento
        },
        { onConflict: 'user_id,name_lower', ignoreDuplicates: true }
      )
  }, [user])

  return {
    session,
    user,
    isLoading,
    error,
    signInWithEmail,
    signUpWithEmail,
    signInWithGoogle,
    signOut,
    clearError,
    saveProfileName,
  }
}
