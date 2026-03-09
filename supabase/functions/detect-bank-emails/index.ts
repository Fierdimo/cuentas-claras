/**
 * Edge Function: detect-bank-emails
 *
 * Escanea Gmail buscando correos transaccionales de bancos colombianos.
 * Soporta múltiples cuentas, paginación y sync incremental — mismo patrón que backfill-gmail.
 *
 * Pipeline de detección por email:
 *   1. Verificar que el remitente esté en TRUSTED_BANK_SENDERS (allowlist)
 *   2. Intentar parser conocido (hardcoded, rápido)
 *   3. Si falla → buscar reglas aprendidas en bank_email_parsers (DB)
 *   4. Si no hay → llamar Perplexity API → guardar reglas → reusar en el futuro
 *   5. Guardar MovimientoPendiente (siempre status='pending_confirmation')
 *
 * Request:  POST { userId, emailAddress?, pageToken?, sinceDate? }
 * Response: { detected, created, skipped, nextPageToken?, done, sinceDate }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'
import {
  detectBankSender,
  extractEmailBody,
  getHeader,
  type GmailPayload,
} from '../_shared/bankDomains.ts'
import {
  parseWithKnownParser,
  parseWithLearnedRules,
  type ParsedMovement,
  type LearnedRules,
} from '../_shared/knownBankParsers.ts'

const GMAIL_API  = 'https://gmail.googleapis.com/gmail/v1/users/me'
const DAYS_BACK  = 90
const BATCH_SIZE = 20

interface DetectRequest {
  userId:        string
  emailAddress?: string
  pageToken?:    string
  sinceDate?:    string
}

interface PerplexityResult {
  movement: {
    amount:        number
    direction:     'credit' | 'debit'
    counterpart:   string | null
    account_last4: string | null
    currency:      string
    description:   string
  } | null
  rules:           LearnedRules
  is_bank_movement: boolean
}

// ── Perplexity: parsear email desconocido y extraer reglas reutilizables ──────

async function parseWithPerplexity(
  senderEmail: string,
  bankName:    string,
  subject:     string,
  bodyText:    string
): Promise<{ parsed: ParsedMovement | null; rules: LearnedRules | null; disable: boolean }> {
  const apiKey = Deno.env.get('PERPLEXITY_API_KEY')
  if (!apiKey) {
    console.warn('[detect-bank-emails] PERPLEXITY_API_KEY no configurado — Perplexity deshabilitado')
    return { parsed: null, rules: null, disable: true }
  }

  // Truncar el body para no exceder tokens (3000 chars es suficiente para emails bancarios)
  const truncatedBody = bodyText.slice(0, 3000)

  const prompt = `Analiza este correo de notificación bancaria colombiana y extrae la información de la transacción.

Remitente: ${senderEmail}
Banco: ${bankName}
Asunto: ${subject}
Cuerpo del correo:
${truncatedBody}

Responde ÚNICAMENTE con JSON válido (sin texto adicional, sin markdown, sin bloques de código):
{
  "movement": {
    "amount": <número decimal, ejemplo: 50000>,
    "direction": "credit" o "debit",
    "counterpart": "<nombre de quien envió o recibió>" o null,
    "account_last4": "<últimos 4 dígitos>" o null,
    "currency": "COP",
    "description": "<resumen en una frase>"
  },
  "rules": {
    "amount_regex": "<regex JavaScript para extraer el monto en futuros correos de este remitente>",
    "direction_credit_keywords": ["<palabras en español que indican crédito/recibido>"],
    "direction_debit_keywords": ["<palabras en español que indican débito/enviado/compra>"],
    "counterpart_regex": "<regex JavaScript para extraer el nombre de la contraparte>" o null,
    "account_regex": "<regex JavaScript para extraer los últimos 4 dígitos>" o null,
    "currency": "COP"
  },
  "is_bank_movement": true o false
}

Si el correo NO es una notificación de movimiento real (marketing, bienvenida, aviso de seguridad, etc.), pon "is_bank_movement": false y "movement": null.`

  try {
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        model:       'sonar',
        messages: [
          {
            role:    'system',
            content: 'Eres un experto en correos de notificación bancaria de Colombia. Responde ÚNICAMENTE con JSON válido, sin explicaciones ni texto adicional.',
          },
          { role: 'user', content: prompt },
        ],
        max_tokens:  1024,
        temperature: 0.1,
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      const fatal = res.status === 401 || res.status === 403
      console.error(`[detect-bank-emails] Perplexity error ${res.status}${fatal ? ' (deshabilitando para esta invocación)' : ''}:`, body)
      return { parsed: null, rules: null, disable: fatal }
    }

    const data = await res.json() as {
      choices: Array<{ message: { content: string } }>
    }

    const content = data.choices?.[0]?.message?.content ?? ''

    // Extraer JSON de la respuesta (a veces Perplexity añade texto antes/después)
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      console.warn('[detect-bank-emails] Perplexity no devolvió JSON válido:', content.slice(0, 200))
      return { parsed: null, rules: null }
    }

    const result = JSON.parse(jsonMatch[0]) as PerplexityResult

    if (!result.is_bank_movement || !result.movement) {
      return { parsed: null, rules: result.rules ?? null }
    }

    const parsed: ParsedMovement = {
      amount:        result.movement.amount,
      direction:     result.movement.direction,
      currency:      result.movement.currency ?? 'COP',
      counterpart:   result.movement.counterpart ?? null,
      account_last4: result.movement.account_last4 ?? null,
      description:   result.movement.description ?? '',
    }

    return { parsed, rules: result.rules ?? null, disable: false }

  } catch (err) {
    console.error('[detect-bank-emails] Perplexity parse error:', err)
    return { parsed: null, rules: null, disable: false }
  }
}

// ── Handler principal ─────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization') ?? ''
    const supabase   = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SERVICE_ROLE_KEY')!,
    )

    // ── 1. Autenticar ─────────────────────────────────────────────────────────
    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', '')
    )
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'No autorizado' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const { userId, emailAddress, pageToken, sinceDate: sinceDateFromClient } =
      await req.json() as DetectRequest

    if (user.id !== userId) {
      return new Response(JSON.stringify({ error: 'No autorizado' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // ── 2. Obtener refresh token + fecha del último bank sync ─────────────────
    const { data: syncRows, error: syncError } = await supabase.rpc('get_bank_sync_info', {
      p_user_id: userId,
      p_email:   emailAddress ?? null,
    })
    if (syncError) {
      return new Response(JSON.stringify({ error: syncError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const syncInfo     = Array.isArray(syncRows) ? syncRows[0] : null
    const refreshToken = syncInfo?.refresh_token as string | null
    const lastSyncedAt = syncInfo?.last_bank_synced_at as string | null
    const accountEmail = syncInfo?.email_address as string | null

    if (!refreshToken) {
      return new Response(JSON.stringify({ error: 'Cuenta Gmail no conectada' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // ── 3. Obtener access token ───────────────────────────────────────────────
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     Deno.env.get('GMAIL_CLIENT_ID')!,
        client_secret: Deno.env.get('GMAIL_CLIENT_SECRET')!,
        refresh_token: refreshToken,
        grant_type:    'refresh_token',
      }),
    })
    const tokenJson = await tokenRes.json() as { access_token?: string; error?: string }
    if (!tokenJson.access_token) {
      return new Response(JSON.stringify({ error: `Token error: ${tokenJson.error}` }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }
    const access_token = tokenJson.access_token

    // ── 4. Determinar rango de fechas (mismo patrón que backfill-gmail) ───────
    let afterDate: Date

    if (sinceDateFromClient) {
      afterDate = new Date(sinceDateFromClient)
    } else if (lastSyncedAt) {
      afterDate = new Date(new Date(lastSyncedAt).getTime() - 10 * 60 * 1000)
    } else {
      afterDate = new Date(Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000)
    }

    const afterEpoch   = Math.floor(afterDate.getTime() / 1000)
    const sinceDateISO = afterDate.toISOString()

    // Query: solo correos de remitentes bancarios conocidos, sin adjuntos ZIP
    // Construir la parte from: con todos los senders del TRUSTED_BANK_SENDERS map
    const bankSenders = [
      'notificaciones@nequi.com.co',
      'alertas@notificaciones.bancolombia.com.co',
      'alertas@davivienda.com',
      'banco_davivienda@davivienda.com',
      'daviplata@daviplata.com',
      'alertas@bbva.com.co',
      'notificaciones@itau.com.co',
      'info@bancodeoccidente.com.co',
      'notificaciones@bancocajasocial.com.co',
      'alertas@colpatria.com.co',
    ]
    const fromQuery = bankSenders.map(s => `from:${s}`).join(' OR ')
    const query     = `(${fromQuery}) after:${afterEpoch} -filename:zip`

    const listUrl = new URL(`${GMAIL_API}/messages`)
    listUrl.searchParams.set('q', query)
    listUrl.searchParams.set('maxResults', String(BATCH_SIZE))
    if (pageToken) listUrl.searchParams.set('pageToken', pageToken)

    const listRes  = await fetch(listUrl.toString(), {
      headers: { Authorization: `Bearer ${access_token}` },
    })
    const listData = await listRes.json() as {
      messages?:            Array<{ id: string }>
      nextPageToken?:        string
      resultSizeEstimate?:   number
    }

    const messages      = listData.messages ?? []
    const nextPageToken = listData.nextPageToken
    console.log(`[detect-bank] encontrados: ${messages.length} correos bancarios`)

    // ── 5. Cargar reglas aprendidas de la DB (un viaje, antes del loop) ───────
    const { data: learnedRows } = await supabase
      .from('bank_email_parsers')
      .select('sender_email, bank_name, rules')

    const learnedRulesMap = new Map<string, { bankName: string; rules: LearnedRules }>(
      (learnedRows ?? []).map((r: { sender_email: string; bank_name: string; rules: LearnedRules }) => [
        r.sender_email,
        { bankName: r.bank_name, rules: r.rules },
      ])
    )

    // ── 6. Procesar cada mensaje ──────────────────────────────────────────────
    // Circuit-breaker: si Perplexity devuelve 401/403 (o no hay clave) se
    // deshabilita para toda la invocación — no tiene sentido volver a llamarlo.
    let perplexityEnabled = !!Deno.env.get('PERPLEXITY_API_KEY')

    let detected = 0
    let created  = 0
    let skipped  = 0

    for (const msg of messages) {
      try {
        // Obtener mensaje completo (headers + body)
        const msgRes  = await fetch(`${GMAIL_API}/messages/${msg.id}?format=full`, {
          headers: { Authorization: `Bearer ${access_token}` },
        })
        const msgData = await msgRes.json() as {
          id:           string
          internalDate: string
          payload:      GmailPayload
        }

        const payload  = msgData.payload
        const from     = getHeader(payload, 'from')
        const subject  = getHeader(payload, 'subject')
        const dateMs   = parseInt(msgData.internalDate, 10)
        const emailDate = new Date(dateMs).toISOString()

        // ── 6a. Verificar remitente confiable ─────────────────────────────────
        const bankInfo = detectBankSender(from)
        if (!bankInfo) {
          skipped++
          continue  // No es banco conocido — IGNORAR siempre
        }

        detected++
        const { bankName, senderEmail } = bankInfo

        // ── 6b. Extraer cuerpo del email ──────────────────────────────────────
        const bodyText = extractEmailBody(payload)
        if (!bodyText) {
          console.warn(`[detect-bank] sin body: msgId=${msg.id}`)
          skipped++
          continue
        }

        // ── 6c. Pipeline de parseo: conocido → aprendido → Perplexity ─────────
        let parsed:     ParsedMovement | null = null
        let parserUsed: 'known' | 'learned' | 'perplexity' = 'known'

        // Intento 1: parser conocido (hardcoded)
        parsed = parseWithKnownParser(senderEmail, bodyText)

        // Intento 2: reglas aprendidas en DB
        if (!parsed) {
          const learned = learnedRulesMap.get(senderEmail)
          if (learned) {
            parsed     = parseWithLearnedRules(bodyText, learned.rules, learned.bankName, senderEmail)
            parserUsed = 'learned'
          }
        }

        // Intento 3: Perplexity — parsea Y extrae reglas para el futuro
        if (!parsed && perplexityEnabled) {
          parserUsed = 'perplexity'
          const { parsed: pParsed, rules: pRules, disable } = await parseWithPerplexity(
            senderEmail, bankName, subject, bodyText
          )

          // 401/403 → desactivar para el resto del batch
          if (disable) {
            perplexityEnabled = false
            console.warn('[detect-bank] Perplexity deshabilitado para esta invocación (error de autenticación/cuota)')
          }

          parsed = pParsed

          // Guardar reglas para que próximos emails de este remitente no necesiten Perplexity
          if (pRules) {
            await supabase.rpc('upsert_bank_parser', {
              p_sender_email: senderEmail,
              p_bank_name:    bankName,
              p_rules:        pRules,
            })
            // Actualizar el mapa local para el resto del batch
            learnedRulesMap.set(senderEmail, { bankName, rules: pRules })
            console.log(`[detect-bank] reglas aprendidas guardadas para ${senderEmail}`)
          }
        }

        if (!parsed) {
          console.log(`[detect-bank] skip (no transaccional o formato desconocido): ${senderEmail} — ${subject}`)
          skipped++
          continue
        }

        // ── 6d. Guardar como movimiento confirmado ──────────────────────────
        // Los correos bancarios colombianos son notificaciones post-transacción:
        // la operación ya ocurrió. Se insertan directo como 'confirmed'.
        const { error: insertError } = await supabase
          .from('pending_movements')
          .upsert(
            {
              user_id:       userId,
              gmail_msg_id:  msg.id,
              source:        'email',
              bank_name:     bankName,
              sender_email:  senderEmail,
              amount:        parsed.amount,
              direction:     parsed.direction,
              currency:      parsed.currency,
              counterpart:   parsed.counterpart,
              account_last4: parsed.account_last4,
              email_date:    emailDate,
              body_snippet:  bodyText.slice(0, 500),
              parser_used:   parserUsed,
              status:        'confirmed',
              confirmed_at:  emailDate,
            },
            { onConflict: 'user_id,gmail_msg_id', ignoreDuplicates: true }
          )

        if (insertError) {
          console.error(`[detect-bank] insert error msgId=${msg.id}:`, insertError)
        } else {
          created++
          console.log(`[detect-bank] ✓ ${bankName} ${parsed.direction} $${parsed.amount} (${parserUsed})`)
        }

      } catch (msgErr) {
        console.error(`[detect-bank] error procesando msgId=${msg.id}:`, msgErr)
        skipped++
      }
    }

    // ── 7. Si es la última página, marcar sync completado ─────────────────────
    // Guardia anti-regresión: si es el PRIMER scan (lastSyncedAt === null) y no
    // se guardó ningún movimiento, NO avanzar el cursor. Así, si los parsers
    // fallaron para todos los correos, el próximo intento vuelve a escanear los
    // 90 días completos en vez de saltar por encima de los correos históricos.
    const done            = !nextPageToken
    const isFirstScan     = !lastSyncedAt
    const shouldMarkDone  = done && (!isFirstScan || created > 0)

    if (shouldMarkDone) {
      await supabase.rpc('mark_bank_sync_completed', {
        p_user_id: userId,
        p_email:   accountEmail ?? null,
      })
    } else if (done && isFirstScan && created === 0) {
      console.warn('[detect-bank] primer scan sin movimientos guardados — cursor NO avanzado para reintentar en la próxima llamada')
    }

    return new Response(
      JSON.stringify({
        detected,
        created,
        skipped,
        total:     messages.length,
        done,
        sinceDate: sinceDateISO,
        ...(nextPageToken ? { nextPageToken } : {}),
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    console.error('[detect-bank-emails] error:', err)
    return new Response(JSON.stringify({ error: 'Error interno' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
