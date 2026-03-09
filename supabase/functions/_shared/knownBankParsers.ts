/**
 * Módulo compartido: parsers conocidos para bancos colombianos.
 *
 * Cada parser es un conjunto de reglas regex ajustadas al formato real
 * de los emails de ese banco. Son el "fast path" antes de consultar la DB
 * (reglas aprendidas) o llamar a Perplexity.
 *
 * IMPORTANTE: Los formatos de email bancario cambian con el tiempo.
 * Si un parser empieza a fallar, el sistema cae automáticamente en
 * las reglas aprendidas (DB) o en Perplexity — no hay que hacer nada manual.
 *
 * Estructura de ParsedMovement:
 *   amount:       número positivo
 *   direction:    'credit' (recibiste / abono) | 'debit' (enviaste / compra)
 *   counterpart:  nombre de quien envió/recibió (puede ser null)
 *   account_last4: últimos 4 dígitos (puede ser null)
 *   currency:     siempre 'COP' por ahora
 *   description:  texto descriptivo corto
 */

export interface ParsedMovement {
  amount:        number
  direction:     'credit' | 'debit'
  currency:      string
  counterpart:   string | null
  account_last4: string | null
  description:   string
}

export interface LearnedRules {
  amount_regex:              string
  direction_credit_keywords: string[]
  direction_debit_keywords:  string[]
  counterpart_regex:         string | null
  account_regex:             string | null
  currency:                  string
}

// ─── Helpers comunes ──────────────────────────────────────────────────────────

/**
 * Extrae un monto en COP del texto.
 * Soporta formatos: $1.500.000 (punto miles) · $1,500,000 (coma miles) · $45000 · 1.500.000
 *
 * Heurística para distinguir separador de miles vs. decimal:
 *   Si el último separador tiene exactamente 3 dígitos después → es separador de miles.
 *   Si tiene menos de 3 → es separador decimal.
 */
function parseColombianAmount(raw: string): number | null {
  const dotIdx   = raw.lastIndexOf('.')
  const commaIdx = raw.lastIndexOf(',')
  let normalized: string
  if (dotIdx === -1 && commaIdx === -1) {
    normalized = raw  // "150000" sin separadores
  } else if (dotIdx > commaIdx) {
    // punto es el último separador
    const afterDot = raw.slice(dotIdx + 1)
    if (afterDot.length === 3) {
      normalized = raw.replace(/\./g, '')           // "1.500.000" → miles con punto
    } else {
      normalized = raw.replace(/,/g, '').replace('.', '.')  // "150.50" → decimal
    }
  } else {
    // coma es el último separador
    const afterComma = raw.slice(commaIdx + 1)
    if (afterComma.length === 3) {
      normalized = raw.replace(/,/g, '')            // "150,000" / "1,500,000" → miles con coma (Davivienda)
    } else {
      normalized = raw.replace(/\./g, '').replace(',', '.')  // "150,50" → decimal
    }
  }
  const val = parseFloat(normalized)
  return isNaN(val) ? null : val
}

function extractAmount(text: string, pattern?: RegExp): number | null {
  const re = pattern ?? /\$\s*([\d.,]+)/
  const m  = text.match(re)
  if (!m) return null
  return parseColombianAmount(m[1])
}

function detectDirection(
  text:           string,
  creditKeywords: string[],
  debitKeywords:  string[]
): 'credit' | 'debit' | null {
  const lower = text.toLowerCase()
  if (creditKeywords.some(k => lower.includes(k))) return 'credit'
  if (debitKeywords.some(k => lower.includes(k)))  return 'debit'
  return null
}

function extractGroup(text: string, pattern: RegExp, group = 1): string | null {
  const m = text.match(pattern)
  return m?.[group]?.trim() ?? null
}

// ─── Parser: Nequi ────────────────────────────────────────────────────────────
// Formato real confirmado (Bre-B / transferencias interbancarias):
//   "Enviaste de manera exitosa 100.000 a la llave @davi3028308008 de GREGORIO MORALES PAJARO el 7 de marzo de 2026"
//   "Realizaste un envío por Bre-B y todo salió bien!"
// Otros formatos:
//   "Recibiste 50.000 de JUAN PEREZ el 5 de marzo"
//   "Tu pago de $25.000 fue exitoso en Rappi"

function parseNequi(body: string): ParsedMovement | null {
  // Monto: Nequi usa "100.000" sin signo ni COP — capturar número tras palabra clave financiera
  const amount =
    extractAmount(body, /exitosa\s+([\d.,]+)/)      ||   // "exitosa 100.000 a"
    extractAmount(body, /recibiste\s+([\d.,]+)/i)    ||   // "Recibiste 100.000 de"
    extractAmount(body, /pago de\s+\$?([\d.,]+)/i)   ||   // "pago de $25.000" o "pago de 25.000"
    extractAmount(body, /\$\s*([\d.,]+)/)            ||   // "$25.000"
    extractAmount(body, /([\d.,]+)\s*COP/)               // "25.000 COP"

  if (!amount) return null

  const direction = detectDirection(
    body,
    ['recibiste', 'te consignaron', 'abono', 'te enviaron', 'te transfirieron', 'ingresaron'],
    ['enviaste', 'pagaste', 'retiraste', 'compraste', 'realizaste un envío', 'realizaste un pago', 'pago fue exitoso']
  )
  if (!direction) return null

  // Contraparte: "de NOMBRE APELLIDO el 7" (tras la llave en Bre-B)
  // o "de Nombre" / "a Nombre" en otros formatos
  const counterpart =
    extractGroup(body, /de\s+([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑa-záéíóúñ\s]+?)\s+el\s+\d/, 1)  ||
    extractGroup(body, /(?:a|para|de)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñA-ZÁÉÍÓÚÑ\s]+?)(?:\s+el\s+\d|\s+la\s+llave|\.|,|$)/, 1)

  return {
    amount,
    direction,
    currency:      'COP',
    counterpart:   counterpart ? counterpart.trim() : null,
    account_last4: null,
    description:   `${direction === 'credit' ? 'Recibiste' : 'Enviaste'} $${amount.toLocaleString('es-CO')}${counterpart ? ` ${direction === 'credit' ? 'de' : 'a'} ${counterpart.trim()}` : ' con Nequi'}`,
  }
}

// ─── Parser: Bancolombia ──────────────────────────────────────────────────────
// Ejemplos conocidos:
//   "Realizaste una transacción por $1.500.000 en ÉXITO"
//   "Recibiste una consignación de $500.000 de Empresa XYZ"
//   "Cuenta **** 1234 — Débito $200.000"

function parseBancolombia(body: string): ParsedMovement | null {
  const amount = extractAmount(body, /\$\s*([\d.,]+)/)
  if (!amount) return null

  const direction = detectDirection(
    body,
    ['recibiste', 'consignación', 'abono', 'crédito'],
    ['realizaste', 'débito', 'compra', 'retiro', 'pago', 'transferiste']
  )
  if (!direction) return null

  const account_last4 = extractGroup(body, /\*{2,4}\s*(\d{4})/, 1)

  const counterpart = extractGroup(
    body,
    /(?:en|de|a|para)\s+([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑa-záéíóúñ\s&.,]+?)(?:\s+por|\s+con|\s+cuenta|\.|,|$)/,
    1
  )

  return {
    amount,
    direction,
    currency:     'COP',
    counterpart:  counterpart ? counterpart.trim() : null,
    account_last4: account_last4 ?? null,
    description:  `${direction === 'credit' ? 'Crédito' : 'Débito'} $${amount.toLocaleString('es-CO')} Bancolombia`,
  }
}

// ─── Parser: Davivienda ───────────────────────────────────────────────────────
// Formato real confirmado (correos transaccionales):
//   "Clase de Movimiento:.Retiro"  /  "Clase de Movimiento:.Compra"  /  "Clase de Movimiento:.Consignacion"
//   "Valor Transacción:.$150,000"  — coma como separador de miles (Davivienda style)
//   "Lugar de Transacción:.CAJERO BANCOLOMBIA 9706"
//   "****1234"  — últimos 4 dígitos de la cuenta

function parseDavivienda(body: string): ParsedMovement | null {
  // Saltar rápido correos que claramente no son transaccionales
  // (OTP, alertas de seguridad, marketing sin monto)
  const lowerBody = body.toLowerCase()
  const nonTransactional = [
    'código de verificación', 'codigo de verificacion', 'token', 'otp',
    'clave dinámica', 'clave dinamica', 'iniciar sesión', 'iniciar sesion',
    'actualización de datos', 'actualizacion de datos',
    'cambio de clave', 'cambio de contraseña', 'cambio de pin',
    'bloqueo de tarjeta', 'desbloqueo de tarjeta',
    'activación de tarjeta', 'activacion de tarjeta',
  ]
  if (nonTransactional.some(k => lowerBody.includes(k)) &&
      !lowerBody.includes('valor transacci')) {
    return null
  }

  // Monto: campo estructurado → genérico $X → "por X" sin signo
  const amount =
    extractAmount(body, /Valor Transacci[oó]n:\s*\.?\s*\$?([\d.,]+)/i) ||
    extractAmount(body, /valor[:\s]+\$?([\d.,]+)/i)                     ||
    extractAmount(body, /por\s+\$?([\d.,]+)/i)                          ||
    extractAmount(body, /\$\s*([\d.,]+)/)

  if (!amount) return null

  // Dirección: leer el campo "Clase de Movimiento" y mapear al tipo
  const claseMatch = body.match(/Clase de Movimiento:\s*\.?\s*([^.\n\r]+)/i)
  const clase      = claseMatch?.[1]?.trim().toLowerCase() ?? ''

  let direction: 'credit' | 'debit' | null = null
  if (['retiro', 'compra', 'débito', 'debito', 'pago', 'transferencia', 'avance', 'cargo'].some(k => clase.includes(k))) {
    direction = 'debit'
  } else if (['consignación', 'consignacion', 'abono', 'crédito', 'credito', 'nómina', 'nomina', 'depósito', 'deposito'].some(k => clase.includes(k))) {
    direction = 'credit'
  } else {
    // Fallback: buscar palabras clave en el cuerpo completo
    direction = detectDirection(
      body,
      ['recibiste', 'consignación', 'consignacion', 'abono', 'crédito', 'nómina', 'nomina', 'depósito', 'deposito'],
      ['débito', 'compra', 'retiro', 'pago', 'transferencia débito', 'avance', 'cargo', 'realizaste']
    )
  }
  if (!direction) return null

  // Contraparte: campo "Lugar de Transacción" o patrón genérico
  const counterpart =
    extractGroup(body, /Lugar de Transacci[oó]n:\s*\.?\s*(.+)/i, 1) ||
    extractGroup(body, /(?:en|de|a|para)\s+([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑa-záéíóúñ\s]+?)(?:\s+por|\.|,|$)/, 1)

  // Últimos 4 dígitos: "****1234"
  const account_last4 = extractGroup(body, /\*{4}(\d{4})/, 1)

  const label = clase
    ? clase.charAt(0).toUpperCase() + clase.slice(1)
    : direction === 'credit' ? 'Crédito' : 'Débito'

  return {
    amount,
    direction,
    currency:      'COP',
    counterpart:   counterpart ? counterpart.trim() : null,
    account_last4: account_last4 ?? null,
    description:   `${label} $${amount.toLocaleString('es-CO')} Davivienda`,
  }
}

// ─── Parser: Daviplata ────────────────────────────────────────────────────────
function parseDaviplata(body: string): ParsedMovement | null {
  const amount = extractAmount(body, /\$\s*([\d.,]+)/)
  if (!amount) return null

  const direction = detectDirection(
    body,
    ['recibiste', 'te enviaron', 'abono'],
    ['enviaste', 'pagaste', 'retiraste']
  )
  if (!direction) return null

  const counterpart = extractGroup(
    body,
    /(?:de|para|a)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñA-ZÁÉÍÓÚÑ\s]+?)(?:\s+por|\.|$)/,
    1
  )

  return {
    amount,
    direction,
    currency:      'COP',
    counterpart:   counterpart ? counterpart.trim() : null,
    account_last4: null,
    description:   `${direction === 'credit' ? 'Recibiste' : 'Enviaste'} $${amount.toLocaleString('es-CO')} Daviplata`,
  }
}

// ─── Registry de parsers conocidos ───────────────────────────────────────────

const KNOWN_PARSERS = new Map<string, (body: string) => ParsedMovement | null>([
  ['notificaciones@nequi.com.co',                  parseNequi],
  ['alertas@notificaciones.bancolombia.com.co',     parseBancolombia],
  ['alertas@davivienda.com',                        parseDavivienda],
  ['banco_davivienda@davivienda.com',               parseDavivienda],  // remitente real confirmado
  ['daviplata@daviplata.com',                       parseDaviplata],
])

/**
 * Intenta parsear un email con el parser conocido para ese remitente.
 * @returns ParsedMovement si tiene éxito, null si no hay parser o falla.
 */
export function parseWithKnownParser(
  senderEmail: string,
  body:        string
): ParsedMovement | null {
  const parser = KNOWN_PARSERS.get(senderEmail.toLowerCase())
  if (!parser) return null
  try {
    return parser(body)
  } catch {
    return null
  }
}

/**
 * Intenta parsear usando reglas aprendidas guardadas en la DB (formato LearnedRules).
 * Estas reglas fueron generadas por Perplexity en llamadas anteriores.
 *
 * @returns ParsedMovement si tiene éxito, null si las reglas no matchean.
 */
export function parseWithLearnedRules(
  body:        string,
  rules:       LearnedRules,
  bankName:    string,
  senderEmail: string
): ParsedMovement | null {
  try {
    const amount = extractAmount(body, new RegExp(rules.amount_regex))
    if (!amount) return null

    const direction = detectDirection(
      body,
      rules.direction_credit_keywords,
      rules.direction_debit_keywords
    )
    if (!direction) return null

    const counterpart = rules.counterpart_regex
      ? extractGroup(body, new RegExp(rules.counterpart_regex), 1)
      : null

    const account_last4 = rules.account_regex
      ? extractGroup(body, new RegExp(rules.account_regex), 1)
      : null

    return {
      amount,
      direction,
      currency:     rules.currency ?? 'COP',
      counterpart:  counterpart ?? null,
      account_last4: account_last4 ?? null,
      description:  `${direction === 'credit' ? 'Crédito' : 'Débito'} $${amount.toLocaleString('es-CO')} ${bankName}`,
    }
  } catch {
    return null
  }
}
