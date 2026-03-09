/**
 * Módulo compartido: dominios bancarios de confianza y detección de remitentes.
 *
 * IMPORTANTE — Allowlist estricta:
 *   Solo se procesan correos de remitentes en TRUSTED_BANK_SENDERS.
 *   Cualquier dominio desconocido es ignorado, aunque parezca bancario.
 *   Esto evita que correos fraudulentos (phishing) generen movimientos falsos.
 *
 * Agregar un nuevo banco: añadir entrada al Map con la dirección exacta del from.
 */

export interface BankSenderInfo {
  bankName:    string
  senderEmail: string
}

/**
 * Mapa de remitentes confiables → nombre del banco.
 * Clave: dirección de email en minúsculas, tal como aparece en el header From.
 */
export const TRUSTED_BANK_SENDERS = new Map<string, string>([
  ['notificaciones@nequi.com.co',                         'Nequi'],
  ['alertas@notificaciones.bancolombia.com.co',            'Bancolombia'],
  ['alertas@davivienda.com',                               'Davivienda'],
  ['banco_davivienda@davivienda.com',                      'Davivienda'],  // remitente real confirmado
  ['daviplata@daviplata.com',                              'Daviplata'],
  ['alertas@bbva.com.co',                                  'BBVA Colombia'],
  ['notificaciones@itau.com.co',                           'Itaú Colombia'],
  ['info@bancodeoccidente.com.co',                         'Banco de Occidente'],
  ['notificaciones@bancocajasocial.com.co',                'Banco Caja Social'],
  ['alertas@colpatria.com.co',                             'Scotiabank Colpatria'],
  ['correo@corresponsalescaixa.com.co',                    'CaixaBank Colombia'],
])

/**
 * Extrae el email del campo From y verifica si pertenece a un banco conocido.
 *
 * El campo From puede venir como:
 *   "Nequi <notificaciones@nequi.com.co>"   (con nombre)
 *   "notificaciones@nequi.com.co"            (sin nombre)
 *
 * @returns BankSenderInfo si es banco conocido, null si no.
 */
export function detectBankSender(from: string): BankSenderInfo | null {
  // Extraer el email del campo From — primero intenta "<email>", luego email suelto
  const bracketMatch = from.match(/<([^>]+)>/)
  const plainMatch   = from.match(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/)
  const email = (bracketMatch?.[1] ?? plainMatch?.[1] ?? '').toLowerCase().trim()

  if (!email) return null

  const bankName = TRUSTED_BANK_SENDERS.get(email)
  if (!bankName) return null

  return { bankName, senderEmail: email }
}

/**
 * Decodifica base64url a string UTF-8.
 * Gmail devuelve los cuerpos de los mensajes en base64url.
 */
export function decodeBase64Url(data: string): string {
  const base64  = data.replace(/-/g, '+').replace(/_/g, '/')
  const padded  = base64 + '=='.slice(0, (4 - base64.length % 4) % 4)
  const binary  = atob(padded)
  const bytes   = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder('utf-8').decode(bytes)
}

/**
 * Elimina etiquetas HTML y normaliza espacios para obtener texto plano.
 * Suficiente para extraer montos y palabras clave de emails bancarios.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Extrae recursivamente el cuerpo de texto de un mensaje Gmail.
 * Prefiere text/plain; si no existe, usa text/html y lo limpia.
 *
 * @param payload  payload del mensaje Gmail (puede tener parts anidadas)
 * @returns texto plano del cuerpo, o string vacío si no se encuentra
 */
export function extractEmailBody(payload: GmailPayload): string {
  // Intentar extraer text/plain primero (más confiable para regex)
  const plain = findPartByMime(payload, 'text/plain')
  if (plain) return plain

  // Fallback: text/html → limpiar etiquetas
  const html = findPartByMime(payload, 'text/html')
  if (html) return stripHtml(html)

  return ''
}

function findPartByMime(payload: GmailPayload, mimeType: string): string | null {
  if (payload.mimeType === mimeType && payload.body?.data) {
    return decodeBase64Url(payload.body.data)
  }
  for (const part of payload.parts ?? []) {
    const result = findPartByMime(part, mimeType)
    if (result) return result
  }
  return null
}

// Tipos de Gmail payload (usados en bankDomains y detect-bank-emails)
export interface GmailPayload {
  mimeType: string
  headers?: Array<{ name: string; value: string }>
  body?:    { data?: string; size?: number }
  parts?:   GmailPayload[]
}

export function getHeader(payload: GmailPayload, name: string): string {
  return payload.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}
