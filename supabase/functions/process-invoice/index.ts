/**
 * Edge Function: process-invoice
 *
 * Receptor del webhook de Gmail API (Google Cloud Pub/Sub).
 * Cuando Gmail detecta un nuevo correo, Pub/Sub notifica a esta función.
 *
 * Seguridad en capas:
 *  1. Verificar token de autenticación del Pub/Sub push subscription
 *  2. Verificar HMAC secreto del webhook
 *  3. Solo opera con service_role — nunca expuesto al cliente
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'
import { verifyGoogleJwt } from '../_shared/verifyWebhook.ts'
// Pipeline compartido con la app (misma lógica, Deno-compatible)
import { unzipSync } from 'https://esm.sh/fflate@0.8.2'
import { XMLParser } from 'https://esm.sh/fast-xml-parser@4.4.1'

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'
const EXPO_PUSH = 'https://exp.host/--/api/v2/push/send'

interface PubSubMessage {
  message: {
    data: string   // base64-encoded JSON { emailAddress, historyId }
    messageId: string
    publishTime: string
  }
  subscription: string
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // ── 1. Verificar JWT de Google Pub/Sub ────────────────────────────────────
    const authHeader = req.headers.get('Authorization') ?? ''
    const isValid = await verifyGoogleJwt(authHeader.replace('Bearer ', ''))
    if (!isValid) {
      return new Response('Unauthorized', { status: 401 })
    }

    // ── 2. Parsear mensaje Pub/Sub ────────────────────────────────────────────
    const pubsub = await req.json() as PubSubMessage
    const decoded = JSON.parse(atob(pubsub.message.data)) as {
      emailAddress: string
      historyId: string
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SERVICE_ROLE_KEY')!,
    )

    // ── 3. Buscar usuario por email y obtener refresh token del Vault ─────────
    const { data: tokenRow } = await supabase
      .schema('private')
      .from('oauth_tokens')
      .select('user_id, refresh_token_secret_id, expo_push_token, last_history_id')
      .eq('email_address', decoded.emailAddress)
      .eq('provider', 'gmail')
      .eq('is_active', true)
      .single()

    if (!tokenRow) {
      console.warn('No se encontró token para:', decoded.emailAddress)
      // Devolver 200 para que Pub/Sub no reintente
      return new Response('ok', { status: 200 })
    }

    // Obtener el refresh token del Vault
    const { data: secretData } = await supabase.rpc('vault_decrypted_secret', {
      secret_id: tokenRow.refresh_token_secret_id,
    })
    const refreshToken = secretData as string

    // ── 4. Obtener nuevo access token ─────────────────────────────────────────
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
    const { access_token } = await tokenRes.json() as { access_token: string }

    // ── 5. Listar mensajes nuevos desde el último historyId ───────────────────
    const sinceHistoryId = tokenRow.last_history_id ?? decoded.historyId
    const historyRes = await fetch(
      `${GMAIL_API}/history?startHistoryId=${sinceHistoryId}&historyTypes=messageAdded&labelId=INBOX`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    )
    const historyData = await historyRes.json() as {
      history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>
      historyId: string
    }

    const messageIds = (historyData.history ?? [])
      .flatMap(h => h.messagesAdded ?? [])
      .map(m => m.message.id)

    // Actualizar historyId para la próxima notificación
    await supabase
      .schema('private')
      .from('oauth_tokens')
      .update({ last_history_id: historyData.historyId, last_refreshed: new Date().toISOString() })
      .eq('user_id', tokenRow.user_id)
      .eq('provider', 'gmail')

    // ── 6. Procesar cada mensaje ──────────────────────────────────────────────
    const parsedInvoices: string[] = []

    for (const messageId of messageIds) {
      try {
        const msgRes = await fetch(`${GMAIL_API}/messages/${messageId}`, {
          headers: { Authorization: `Bearer ${access_token}` },
        })
        const msg = await msgRes.json() as {
          id: string
          payload: {
            parts?: Array<{
              filename?: string
              mimeType: string
              body: { attachmentId?: string; data?: string; size: number }
            }>
          }
        }

        // Buscar adjuntos ZIP
        const zipParts = (msg.payload.parts ?? []).filter(
          p => p.filename?.endsWith('.zip') ||
               p.mimeType === 'application/zip' ||
               p.mimeType === 'application/x-zip-compressed'
        )

        for (const part of zipParts) {
          if (!part.body.attachmentId) continue

          // Descargar adjunto
          const attRes = await fetch(
            `${GMAIL_API}/messages/${messageId}/attachments/${part.body.attachmentId}`,
            { headers: { Authorization: `Bearer ${access_token}` } }
          )
          const attData = await attRes.json() as { data: string }

          // Gmail usa base64url → convertir a Uint8Array
          const b64 = attData.data.replace(/-/g, '+').replace(/_/g, '/')
          const binary = Uint8Array.from(atob(b64), c => c.charCodeAt(0))

          // Descomprimir ZIP
          let xmlContent: string | null = null
          try {
            const files = unzipSync(binary)
            for (const [filename, content] of Object.entries(files)) {
              if (!filename.endsWith('.xml')) continue
              const xmlStr = new TextDecoder().decode(content)

              // Extraer XML interno si es AttachedDocument
              if (xmlStr.includes('AttachedDocument')) {
                const match = xmlStr.match(/<cbc:Description[^>]*>([\s\S]+?)<\/cbc:Description>/)
                if (match) {
                  xmlContent = atob(match[1].trim())
                } else {
                  xmlContent = xmlStr
                }
              } else {
                xmlContent = xmlStr
              }
              break
            }
          } catch {
            console.warn('ZIP inaccesible (posiblemente cifrado):', part.filename)
            continue
          }

          if (!xmlContent) continue

          // Parsear XML con fast-xml-parser
          const parser = new XMLParser({
            ignoreAttributes: false,
            removeNSPrefix: false,
            isArray: (name) => ['cac:TaxTotal','cac:InvoiceLine','cac:CreditNoteLine'].includes(name),
          })
          const parsed = parser.parse(xmlContent)

          const invoice = parsed['fe:Invoice'] ??
                          parsed['Invoice']    ??
                          parsed['CreditNote'] ??
                          parsed['DebitNote']

          if (!invoice) continue

          const invoiceId   = crypto.randomUUID()
          const invoiceNum  = invoice['cbc:ID'] ?? 'DESCONOCIDO'
          const issueDate   = invoice['cbc:IssueDate'] ?? new Date().toISOString().slice(0, 10)
          const cufe        = invoice['cbc:UUID'] ?? ''
          const supplier    = invoice['cac:AccountingSupplierParty']?.['cac:Party']
          const customer    = invoice['cac:AccountingCustomerParty']?.['cac:Party']
          const monetary    = invoice['cac:LegalMonetaryTotal'] ?? {}

          const issuerName   = supplier?.['cac:PartyName']?.['cbc:Name'] ??
                               supplier?.['cac:PartyLegalEntity']?.['cbc:RegistrationName'] ?? ''
          const issuerNit    = supplier?.['cac:PartyTaxScheme']?.['cbc:CompanyID'] ?? ''
          const recipientNit = customer?.['cac:PartyTaxScheme']?.['cbc:CompanyID'] ?? ''
          const recipientName = customer?.['cac:PartyName']?.['cbc:Name'] ??
                                customer?.['cac:PartyLegalEntity']?.['cbc:RegistrationName'] ?? ''
          const totalAmount  = parseFloat(monetary['cbc:PayableAmount'] ?? '0')

          const canonicalInvoice = {
            id: invoiceId,
            countryCode: 'CO',
            invoiceFormat: 'UBL_2.1',
            originalXmlHash: '',
            invoiceNumber: invoiceNum,
            invoiceType: 'invoice' as const,
            status: 'pending' as const,
            issueDate,
            issuer:    { taxId: issuerNit, taxIdType: 'NIT' as const, legalName: issuerName },
            recipient: { taxId: recipientNit, taxIdType: 'NIT' as const, legalName: recipientName },
            currency: invoice['cbc:DocumentCurrencyCode'] ?? 'COP',
            subtotal: parseFloat(monetary['cbc:LineExtensionAmount'] ?? '0'),
            totalDiscount: parseFloat(monetary['cbc:AllowanceTotalAmount'] ?? '0'),
            totalTax: parseFloat(monetary['cbc:TaxInclusiveAmount'] ?? totalAmount.toString()) - parseFloat(monetary['cbc:LineExtensionAmount'] ?? '0'),
            totalAmount,
            taxes: [],
            lineItems: [],
            authorizationCode: cufe,
            source: 'email' as const,
            sourceEmailId: messageId,
            userId: tokenRow.user_id,
            parsedAt: new Date().toISOString(),
            parserVersion: '1.0.0',
          }

          // Guardar en Supabase
          const { error: insertError } = await supabase.from('invoices').upsert({
            id:             invoiceId,
            user_id:        tokenRow.user_id,
            country_code:   'CO',
            invoice_data:   canonicalInvoice,
            invoice_number: invoiceNum,
            issuer_tax_id:  issuerNit,
            issuer_name:    issuerName,
            total_amount:   totalAmount,
            currency:       canonicalInvoice.currency,
            issue_date:     issueDate,
            status:         'pending',
            source:         'email',
            version:        1,
          }, { onConflict: 'id' })

          if (!insertError) {
            parsedInvoices.push(invoiceId)
          }
        }
      } catch (msgErr) {
        console.error('Error procesando mensaje', messageId, msgErr)
      }
    }

    // ── 7. Enviar push notification si hay facturas nuevas ────────────────────
    if (parsedInvoices.length > 0 && tokenRow.expo_push_token) {
      const label = parsedInvoices.length === 1
        ? '1 factura nueva recibida'
        : `${parsedInvoices.length} facturas nuevas recibidas`

      await fetch(EXPO_PUSH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to:    tokenRow.expo_push_token,
          title: '📄 Cuentas',
          body:  label,
          data:  { invoiceIds: parsedInvoices },
        }),
      })
    }

    return new Response(
      JSON.stringify({ processed: parsedInvoices.length }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('process-invoice error:', err)
    // Devolver 200 para que Pub/Sub no reintente en errores no recuperables
    return new Response('ok', { status: 200 })
  }
})
