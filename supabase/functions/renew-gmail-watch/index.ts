/**
 * Edge Function: renew-gmail-watch
 *
 * Llamada automáticamente por pg_cron cada 6 días (cron job en 004_audit_and_cron.sql).
 * También puede llamarse manualmente en cualquier momento (idempotente).
 *
 * Renueva el Gmail Watch de todas las cuentas cuyo Watch expira dentro de 48 horas,
 * o que nunca han tenido Watch registrado (watch_expiry IS NULL).
 *
 * Flujo por cuenta:
 *   1. get_gmail_accounts_for_renewal() — lista cuentas a renovar + refresh_token del Vault
 *   2. Obtener nuevo access_token con el refresh_token
 *   3. POST /gmail/v1/users/me/watch   — registrar/renovar Watch
 *   4. update_gmail_watch_expiry()     — guardar nueva fecha de expiración
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GMAIL_WATCH_URL  = 'https://gmail.googleapis.com/gmail/v1/users/me/watch'

interface GmailAccount {
  user_id:       string
  email_address: string
  refresh_token: string
}

interface WatchResponse {
  historyId:  string
  expiration: string  // Unix ms como string
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SERVICE_ROLE_KEY')!,
  )

  const pubsubTopic = Deno.env.get('GMAIL_PUBSUB_TOPIC')
  if (!pubsubTopic) {
    console.error('GMAIL_PUBSUB_TOPIC no configurado')
    return new Response(
      JSON.stringify({ error: 'GMAIL_PUBSUB_TOPIC no configurado' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // ── 1. Listar cuentas que necesitan renovación (expiran en < 48h o nunca registradas) ──
  const { data: accounts, error: listError } = await supabase.rpc(
    'get_gmail_accounts_for_renewal',
    { p_window_hours: 48 }
  )

  if (listError) {
    console.error('get_gmail_accounts_for_renewal error:', listError)
    return new Response(
      JSON.stringify({ error: listError.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  if (!accounts || accounts.length === 0) {
    return new Response(
      JSON.stringify({ renewed: 0, message: 'Ninguna cuenta necesita renovación' }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  console.log(`Renovando Watch para ${accounts.length} cuenta(s)...`)

  const results: Array<{ email: string; success: boolean; expiration?: string; error?: string }> = []

  for (const account of accounts as GmailAccount[]) {
    try {
      // ── 2. Obtener access_token fresco con el refresh_token ─────────────────
      const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          refresh_token: account.refresh_token,
          client_id:     Deno.env.get('GMAIL_CLIENT_ID')!,
          client_secret: Deno.env.get('GMAIL_CLIENT_SECRET')!,
          grant_type:    'refresh_token',
        }),
      })

      if (!tokenRes.ok) {
        const err = await tokenRes.text()
        console.error(`Token refresh fallido para ${account.email_address}:`, err)
        results.push({ email: account.email_address, success: false, error: 'token_refresh_failed' })
        continue
      }

      const { access_token } = await tokenRes.json() as { access_token: string }

      // ── 3. Registrar / renovar Gmail Watch ─────────────────────────────────
      const watchRes = await fetch(GMAIL_WATCH_URL, {
        method: 'POST',
        headers: {
          Authorization:  `Bearer ${access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          topicName: pubsubTopic,
          labelIds:  ['INBOX'],
        }),
      })

      if (!watchRes.ok) {
        const err = await watchRes.text()
        console.error(`Gmail Watch fallido para ${account.email_address}:`, err)
        results.push({ email: account.email_address, success: false, error: 'watch_registration_failed' })
        continue
      }

      const watchData = await watchRes.json() as WatchResponse
      const expiryMs  = parseInt(watchData.expiration, 10)

      // ── 4. Guardar nueva fecha de expiración ────────────────────────────────
      const { error: updateError } = await supabase.rpc('update_gmail_watch_expiry', {
        p_user_id:   account.user_id,
        p_email:     account.email_address,
        p_expiry_ms: expiryMs,
      })

      if (updateError) {
        // No es fatal — el Watch ya está activo, solo falla el registro local
        console.warn(`update_gmail_watch_expiry error para ${account.email_address}:`, updateError)
      }

      const expiresAt = new Date(expiryMs).toISOString()
      console.log(`✓ Watch renovado: ${account.email_address} → expira ${expiresAt}`)
      results.push({ email: account.email_address, success: true, expiration: expiresAt })

    } catch (err) {
      console.error(`Error inesperado procesando ${account.email_address}:`, err)
      results.push({ email: account.email_address, success: false, error: String(err) })
    }
  }

  const renewed = results.filter(r => r.success).length
  const failed  = results.filter(r => !r.success).length

  return new Response(
    JSON.stringify({ renewed, failed, total: accounts.length, results }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
})
