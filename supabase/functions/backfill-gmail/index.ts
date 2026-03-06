/**
 * Edge Function: backfill-gmail
 *
 * Escanea los últimos 90 días de Gmail del usuario buscando facturas DIAN (ZIPs).
 * Se llama automáticamente desde store-oauth-token al conectar por primera vez.
 *
 * Soporta paginación: el cliente puede llamarla varias veces con pageToken
 * para procesar lotes grandes sin exceder el timeout de Edge Functions.
 *
 * Request: POST { userId, pageToken? }
 * Response: { processed, total, nextPageToken?, done }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'
import { unzipSync } from 'https://esm.sh/fflate@0.8.2'
import { XMLParser } from 'https://esm.sh/fast-xml-parser@4.4.1'

const GMAIL_API  = 'https://gmail.googleapis.com/gmail/v1/users/me'
const DAYS_BACK  = 90
const BATCH_SIZE = 20   // mensajes por llamada (conservador para no exceder timeout)

interface BackfillRequest {
  userId:     string
  pageToken?: string
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // ── 1. Autenticar al usuario ──────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization') ?? ''
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SERVICE_ROLE_KEY')!,
    )

    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', '')
    )
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'No autorizado' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const { userId, pageToken } = await req.json() as BackfillRequest

    if (user.id !== userId) {
      return new Response(JSON.stringify({ error: 'No autorizado' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // ── 2. Obtener refresh token del Vault ────────────────────────────────────
    // vault_decrypted_secret NO existe como RPC — solo como vista vault.decrypted_secrets.
    // get_gmail_refresh_token() accede a private.oauth_tokens + vault en un solo paso.
    const { data: refreshToken, error: tokenRpcError } = await supabase.rpc('get_gmail_refresh_token', {
      p_user_id: userId,
    })
    console.log(`[backfill] get_gmail_refresh_token rpcError=${tokenRpcError?.message ?? 'none'}`)

    if (!refreshToken) {
      return new Response(JSON.stringify({ error: 'Cuenta Gmail no conectada o token no encontrado' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // ── 3. Obtener access token ───────────────────────────────────────────────
    const clientId     = Deno.env.get('GMAIL_CLIENT_ID')
    const clientSecret = Deno.env.get('GMAIL_CLIENT_SECRET')
    console.log(`[backfill] clientId present=${!!clientId} clientSecret present=${!!clientSecret}`)
    console.log(`[backfill] refreshToken present=${!!refreshToken} length=${(refreshToken as string)?.length ?? 0} prefix=${(refreshToken as string)?.substring(0, 10) ?? 'null'}`)

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     clientId!,
        client_secret: clientSecret!,
        refresh_token: refreshToken as string,
        grant_type:    'refresh_token',
      }),
    })
    const tokenJson = await tokenRes.json() as { access_token?: string; error?: string; error_description?: string }
    console.log(`[backfill] token status=${tokenRes.status} error=${tokenJson.error ?? 'none'} desc=${tokenJson.error_description ?? 'none'}`)
    if (!tokenJson.access_token) {
      return new Response(JSON.stringify({ error: `Token error: ${tokenJson.error} - ${tokenJson.error_description}` }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }
    const access_token = tokenJson.access_token

    // ── 4. Buscar todos los correos con adjunto en los últimos 90 días ──────────
    // NO usamos filename:zip — ese filtro busca archivos llamados literalmente "zip".
    // El ZIP de Éxito se llama "UR6819810.zip" y no matchea.
    // Filtramos por extensión en el paso 5 al inspeccionar las partes del mensaje.
    const afterDate = new Date(Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000)
    const afterStr  = `${afterDate.getFullYear()}/${String(afterDate.getMonth() + 1).padStart(2, '0')}/${String(afterDate.getDate()).padStart(2, '0')}`
    const query = `has:attachment after:${afterStr}`
    console.log(`[backfill] query: ${query}`)

    const listUrl = new URL(`${GMAIL_API}/messages`)
    listUrl.searchParams.set('q', query)
    listUrl.searchParams.set('maxResults', String(BATCH_SIZE))
    if (pageToken) listUrl.searchParams.set('pageToken', pageToken)

    const listRes  = await fetch(listUrl.toString(), {
      headers: { Authorization: `Bearer ${access_token}` },
    })
    const listData = await listRes.json() as {
      messages?:     Array<{ id: string }>
      nextPageToken?: string
      resultSizeEstimate?: number
    }

    const messages      = listData.messages ?? []
    const nextPageToken = listData.nextPageToken
    const total         = listData.resultSizeEstimate ?? messages.length
    console.log(`[backfill] mensajes encontrados: ${messages.length} (estimado: ${total})`)

    // ── 5. Procesar cada mensaje ──────────────────────────────────────────────
    // Helper: aplana recursivamente todas las partes del mensaje.
    // Gmail anida adjuntos en multipart/mixed > multipart/alternative > zip,
    // así que hay que buscar en todos los niveles.
    interface GmailPart {
      filename?: string
      mimeType: string
      body: { attachmentId?: string; data?: string; size?: number }
      parts?: GmailPart[]
    }
    function flattenParts(parts: GmailPart[]): GmailPart[] {
      const result: GmailPart[] = []
      for (const p of parts) {
        result.push(p)
        if (p.parts?.length) result.push(...flattenParts(p.parts))
      }
      return result
    }

    const parser = new XMLParser({
      ignoreAttributes: false,
      removeNSPrefix: false,
      isArray: (name: string) =>
        ['cac:TaxTotal', 'cac:InvoiceLine', 'cac:CreditNoteLine'].includes(name),
    })

    let processed = 0

    for (const { id: messageId } of messages) {
      try {
        const msgRes = await fetch(
          `${GMAIL_API}/messages/${messageId}?format=full`,
          { headers: { Authorization: `Bearer ${access_token}` } }
        )
        const msg = await msgRes.json() as { payload: GmailPart }

        console.log(`[backfill] mensaje ${messageId} mimeType=${msg.payload.mimeType} partsCount=${msg.payload.parts?.length ?? 0}`)

        const allParts = flattenParts(msg.payload.parts ?? [])

        // Filtrar únicamente por extensión .zip en el filename.
        // NO usar mimeType=application/octet-stream solo — captura PDFs y otros binarios.
        const zipParts = allParts.filter(p =>
          p.filename?.toLowerCase().endsWith('.zip')
        )

        if (zipParts.length > 0) {
          console.log(`[backfill] mensaje ${messageId} archivos ZIP: ${zipParts.map(p => p.filename).join(', ')}`)
        }

        for (const part of zipParts) {
          let binary: Uint8Array

          // Helper: base64url → base64 estándar con padding correcto
          const toStdB64 = (s: string) => {
            const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
            return b64 + '='.repeat((4 - b64.length % 4) % 4)
          }

          if (part.body.attachmentId) {
            // Adjunto grande — fetch via API
            const attRes = await fetch(
              `${GMAIL_API}/messages/${messageId}/attachments/${part.body.attachmentId}`,
              { headers: { Authorization: `Bearer ${access_token}` } }
            )
            const attData = await attRes.json() as { data?: string; error?: unknown }
            if (!attData.data) {
              console.warn(`[backfill] attachment sin data en ${messageId}:`, attData.error)
              continue
            }
            binary = Uint8Array.from(atob(toStdB64(attData.data)), c => c.charCodeAt(0))
          } else if (part.body.data) {
            // Adjunto pequeño — inline base64url en el payload
            binary = Uint8Array.from(atob(toStdB64(part.body.data)), c => c.charCodeAt(0))
          } else {
            continue
          }

          let xmlContent: string | null = null
          try {
            const files = unzipSync(binary)
            const xmlEntries = Object.keys(files).filter(f => f.toLowerCase().endsWith('.xml'))
            console.log(`[backfill] ZIP entries: ${Object.keys(files).join(', ')}`)
            for (const filename of xmlEntries) {
              const xmlStr = new TextDecoder().decode(files[filename])
              if (xmlStr.includes('AttachedDocument')) {
                // DIAN AttachedDocument: la factura real está en cbc:Description
                // Puede ser: (a) base64, (b) CDATA con XML crudo, (c) XML crudo directo
                // Buscamos la descripción más larga (la que contiene el XML de la factura)
                const allMatches = [...xmlStr.matchAll(/<cbc:Description[^>]*>([\/\s\S]*?)<\/cbc:Description>/g)]
                const bestMatch  = allMatches.sort((a, b) => b[1].length - a[1].length)[0]

                if (bestMatch) {
                  let desc = bestMatch[1].trim()

                  // Caso (b): CDATA — strip wrapper
                  if (desc.startsWith('<![CDATA[')) {
                    desc = desc.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim()
                  }

                  // Caso (c): raw XML dentro de description
                  if (desc.startsWith('<') || desc.startsWith('<?')) {
                    console.log(`[backfill] cbc:Description es XML crudo en ${messageId}`)
                    xmlContent = desc
                  } else {
                    // Caso (a): base64
                    try {
                      const rawB64 = desc.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
                      const padded = rawB64 + '='.repeat((4 - rawB64.length % 4) % 4)
                      xmlContent = atob(padded)
                      console.log(`[backfill] cbc:Description decodificada como base64 en ${messageId}`)
                    } catch {
                      // Fallback: usar el xmlStr del AttachedDocument y navegar via parser
                      console.log(`[backfill] cbc:Description fallback a AttachedDocument en ${messageId}`)
                      xmlContent = xmlStr
                    }
                  }
                } else {
                  xmlContent = xmlStr
                }
              } else {
                xmlContent = xmlStr
              }
              break
            }
          } catch (zipErr) {
            console.warn(`[backfill] Error descomprimiendo ZIP del mensaje ${messageId}:`, zipErr)
            continue
          }

          if (!xmlContent) {
            console.log(`[backfill] mensaje ${messageId}: ZIP sin XML, ignorando`)
            continue
          }

          const parsed  = parser.parse(xmlContent)
          // Si el XML es un AttachedDocument, el inner invoice está anidado dentro
          const attachedDoc = parsed['AttachedDocument'] ?? parsed['fe:AttachedDocument']
          const invoiceRoot = attachedDoc
            ? (attachedDoc['fe:Invoice'] ?? attachedDoc['Invoice'] ??
               attachedDoc['CreditNote'] ?? attachedDoc['DebitNote'] ??
               // Algunos AttachedDocuments tienen el invoice en Attachment/ExternalReference/Description
               null)
            : null
          const invoice = invoiceRoot ??
                          parsed['fe:Invoice'] ?? parsed['Invoice'] ??
                          parsed['CreditNote'] ?? parsed['DebitNote']
          if (!invoice) {
            console.log(`[backfill] ${messageId}: XML sin invoice — keys: ${Object.keys(parsed).join(', ')}`)
            continue
          }

          // Helper: extrae texto de nodos XML que pueden ser string u objeto con atributos
          // e.g. <cbc:UUID schemeID="CUFE-SHA384">abc...</cbc:UUID> → { "#text": "abc...", "@_schemeID": "..." }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const xmlText = (v: any): string => {
            if (v == null) return ''
            if (typeof v === 'object') return String(v['#text'] ?? '')
            return String(v)
          }

          const invoiceNum = xmlText(invoice['cbc:ID']) || 'DESCONOCIDO'
          const issueDate  = xmlText(invoice['cbc:IssueDate']) || new Date().toISOString().slice(0, 10)
          const cufe       = xmlText(invoice['cbc:UUID'])
          const supplier   = invoice['cac:AccountingSupplierParty']?.['cac:Party']
          const customer   = invoice['cac:AccountingCustomerParty']?.['cac:Party']
          const monetary   = invoice['cac:LegalMonetaryTotal'] ?? {}

          const issuerName  = xmlText(supplier?.['cac:PartyName']?.['cbc:Name'] ??
                              supplier?.['cac:PartyLegalEntity']?.['cbc:RegistrationName'])
          const issuerNit   = xmlText(supplier?.['cac:PartyTaxScheme']?.['cbc:CompanyID'])
          const recipNit    = xmlText(customer?.['cac:PartyTaxScheme']?.['cbc:CompanyID'])
          const recipName   = xmlText(customer?.['cac:PartyName']?.['cbc:Name'] ??
                              customer?.['cac:PartyLegalEntity']?.['cbc:RegistrationName'])
          const currency    = xmlText(invoice['cbc:DocumentCurrencyCode']) || 'COP'
          const subtotal    = parseFloat(xmlText(monetary['cbc:LineExtensionAmount']) || '0')
          const totalDiscount = parseFloat(xmlText(monetary['cbc:AllowanceTotalAmount']) || '0')
          const taxInclusive  = parseFloat(xmlText(monetary['cbc:TaxInclusiveAmount']) || '0')
          const totalAmount   = parseFloat(xmlText(monetary['cbc:PayableAmount']) || '0')

          // Generar UUID estable a partir del CUFE (96 hex chars → primeros 32 → formato UUID)
          // Esto garantiza deduplicación en re-runs sin necesitar columna extra.
          const cufeToUUID = (c: string): string => {
            const hex = c.replace(/[^a-f0-9]/gi, '').substring(0, 32).padEnd(32, '0').toLowerCase()
            return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`
          }
          const invoiceId = cufe ? cufeToUUID(cufe) : crypto.randomUUID()

          const { error: upsertError } = await supabase.from('invoices').upsert({
            id:             invoiceId,
            user_id:        userId,
            country_code:   'CO',
            invoice_data: {
              id: invoiceId, countryCode: 'CO', invoiceFormat: 'UBL_2.1',
              invoiceNumber: invoiceNum, invoiceType: 'invoice', status: 'received',
              issueDate,
              issuer:    { taxId: issuerNit, taxIdType: 'NIT', legalName: issuerName },
              recipient: { taxId: recipNit,  taxIdType: 'NIT', legalName: recipName },
              currency,
              subtotal,
              totalDiscount,
              totalTax: taxInclusive - subtotal,
              totalAmount, taxes: [], lineItems: [],
              authorizationCode: cufe, source: 'email',
              sourceEmailId: messageId, userId,
              parsedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              parserVersion: '1.0.0',
            },
            invoice_number: invoiceNum,
            issuer_tax_id:  issuerNit,
            issuer_name:    issuerName,
            total_amount:   totalAmount,
            currency,
            issue_date:     issueDate,
            status:         'received',
            source:         'email',
            version:        1,
          }, { onConflict: 'id' })

          if (upsertError) {
            console.error(`[backfill] upsert error en ${messageId}:`, upsertError.message)
          } else {
            console.log(`[backfill] ✅ factura guardada: ${invoiceNum} | emisor=${issuerName} | total=${totalAmount} | msg=${messageId}`)
            processed++
          }
        }
      } catch (e) {
        console.error('Error procesando mensaje', messageId, e)
      }
    }

    // ── 6. Marcar backfill como completado si es la última página ─────────────
    if (!nextPageToken) {
      await supabase.rpc('mark_backfill_completed', { p_user_id: userId })
    }

    return new Response(
      JSON.stringify({
        processed,
        total,
        nextPageToken: nextPageToken ?? null,
        done: !nextPageToken,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('backfill-gmail error:', err)
    return new Response(
      JSON.stringify({ error: 'Error interno' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
