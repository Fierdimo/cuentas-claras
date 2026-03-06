/**
 * Edge Function: store-oauth-token
 *
 * Recibe el authorization code del flujo OAuth PKCE y:
 *  1. Intercambia el code por access_token + refresh_token con Google
 *  2. Guarda el refresh_token en Supabase Vault (cifrado AEAD)
 *  3. Guarda metadata en private.oauth_tokens
 *  4. Registra Gmail Watch para push notifications
 *
 * El refresh_token NUNCA regresa al cliente móvil.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GMAIL_WATCH_URL  = 'https://gmail.googleapis.com/gmail/v1/users/me/watch'

interface RequestBody {
  code: string
  redirectUri: string
  codeVerifier: string
  userId: string
  expoPushToken?: string
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // ── 1. Parsear body ───────────────────────────────────────────────────────
    const { code, redirectUri, codeVerifier, userId, expoPushToken } =
      await req.json() as RequestBody

    if (!code || !redirectUri || !codeVerifier || !userId) {
      return new Response(
        JSON.stringify({ error: 'Faltan parámetros requeridos' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── 2. Verificar que el userId del JWT coincide con el parámetro ──────────
    const authHeader = req.headers.get('Authorization') ?? ''
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SERVICE_ROLE_KEY')!,
    )
    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', '')
    )
    if (authError || user?.id !== userId) {
      return new Response(
        JSON.stringify({ error: 'No autorizado' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── 3. Intercambiar code por tokens con Google ────────────────────────────
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     Deno.env.get('GMAIL_CLIENT_ID')!,
        client_secret: Deno.env.get('GMAIL_CLIENT_SECRET')!,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code',
        code_verifier: codeVerifier,
      }),
    })

    if (!tokenRes.ok) {
      const err = await tokenRes.text()
      console.error('Google token error:', err)
      return new Response(
        JSON.stringify({ error: 'Error al obtener tokens de Google' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const tokens = await tokenRes.json() as {
      access_token: string
      refresh_token?: string
      expires_in: number
      scope: string
    }

    if (!tokens.refresh_token) {
      return new Response(
        JSON.stringify({ error: 'Google no devolvió refresh_token. El usuario debe revocar y reconectar.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── 4. Obtener email del usuario desde Google ─────────────────────────────
    const profileRes = await fetch('https://www.googleapis.com/gmail/v1/users/me/profile', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    const profile = await profileRes.json() as { emailAddress: string }

    // ── 5. Guardar refresh_token en Vault ─────────────────────────────────────
    const { data: vaultData, error: vaultError } = await supabase.rpc('vault_create_secret', {
      secret:      tokens.refresh_token,
      name:        `gmail_refresh_${userId}`,
      description: `Gmail refresh token para usuario ${userId}`,
    })

    if (vaultError) {
      console.error('Vault error:', vaultError)
      return new Response(
        JSON.stringify({ error: 'Error al guardar token de forma segura' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const secretId = vaultData as string

    // ── 6. Guardar metadata en private.oauth_tokens ───────────────────────────
    await supabase.from('oauth_tokens_view').upsert({
      user_id:                userId,
      provider:               'gmail',
      email_address:          profile.emailAddress,
      refresh_token_secret_id: secretId,
      token_scope:            tokens.scope.split(' '),
      is_active:              true,
      last_refreshed:         new Date().toISOString(),
      expo_push_token:        expoPushToken ?? null,
    })

    // ── 7. Registrar Gmail Watch ──────────────────────────────────────────────
    const pubsubTopic = Deno.env.get('GMAIL_PUBSUB_TOPIC')
    if (pubsubTopic) {
      const watchRes = await fetch(GMAIL_WATCH_URL, {
        method: 'POST',
        headers: {
          Authorization:  `Bearer ${tokens.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          topicName: pubsubTopic,
          labelIds:  ['INBOX'],
        }),
      })
      if (!watchRes.ok) {
        // No es fatal — el usuario puede reconectar. Loguear y continuar.
        console.warn('Gmail Watch error:', await watchRes.text())
      }
    }

    return new Response(
      JSON.stringify({ success: true, emailAddress: profile.emailAddress }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('store-oauth-token error:', err)
    return new Response(
      JSON.stringify({ error: 'Error interno del servidor' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
