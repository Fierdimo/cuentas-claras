/**
 * Pipeline de desempaquetado de adjuntos de facturas electrónicas.
 *
 * Responsabilidades:
 *  1. Detectar que el adjunto es un ZIP (magic bytes)
 *  2. Descomprimir con fflate
 *  3. Extraer el XML del AttachedDocument UBL 2.1
 *  4. Decodificar el XML interno embebido en base64 dentro de <cbc:Description>
 *
 * Este pipeline es idéntico en el cliente (React Native) y en las
 * Edge Functions de Supabase (Deno). Depende solo de fflate y APIs
 * de plataforma estándar (atob, TextDecoder, crypto).
 */

import { unzipSync, strFromU8 } from 'fflate'

export type PipelineStatus = 'ok' | 'locked' | 'no_xml' | 'invalid_format'

export interface PipelineResult {
  status: PipelineStatus
  /** XML del AttachedDocument (wrapper externo) */
  attachedDocumentXml: string | null
  /** XML interno real de la factura (Invoice/CreditNote/DebitNote) */
  invoiceXml: string | null
  /** Nombre del archivo XML encontrado dentro del ZIP */
  xmlFilename: string | null
  /** Si hay múltiples facturas en el ZIP, todas sus XMLs internos */
  additionalInvoiceXmls: string[]
  /** Mensaje de error si status !== 'ok' */
  errorMessage?: string
}

// Magic bytes del formato ZIP: PK\x03\x04
const ZIP_MAGIC_BYTES = [0x50, 0x4b, 0x03, 0x04]

/**
 * Punto de entrada del pipeline.
 * Recibe los bytes crudos del adjunto del correo (base64url decodificado
 * o Uint8Array desde expo-document-picker).
 */
export function processAttachment(content: Uint8Array, filename: string): PipelineResult {
  const empty: PipelineResult = {
    status: 'no_xml',
    attachedDocumentXml: null,
    invoiceXml: null,
    xmlFilename: null,
    additionalInvoiceXmls: [],
  }

  if (!isZip(content)) {
    return { ...empty, status: 'invalid_format', errorMessage: `El adjunto "${filename}" no es un archivo ZIP válido.` }
  }

  return extractFromZip(content, filename)
}

/**
 * Convierte base64url (formato Gmail API) a Uint8Array.
 */
export function base64UrlToUint8Array(base64url: string): Uint8Array {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
  // Padding seguro
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

// ── Funciones privadas ────────────────────────────────────────────────────────

function isZip(data: Uint8Array): boolean {
  return (
    data.length >= 4 &&
    data[0] === ZIP_MAGIC_BYTES[0] &&
    data[1] === ZIP_MAGIC_BYTES[1] &&
    data[2] === ZIP_MAGIC_BYTES[2] &&
    data[3] === ZIP_MAGIC_BYTES[3]
  )
}

function extractFromZip(content: Uint8Array, filename: string): PipelineResult {
  let unzipped: Record<string, Uint8Array>

  try {
    unzipped = unzipSync(content)
  } catch (e: any) {
    // fflate lanza un error con mensaje específico para ZIPs cifrados
    const msg: string = e?.message ?? ''
    if (msg.includes('encrypted') || msg.includes('password') || msg.includes('AES')) {
      return {
        status: 'locked',
        attachedDocumentXml: null,
        invoiceXml: null,
        xmlFilename: null,
        additionalInvoiceXmls: [],
        errorMessage: `La factura "${filename}" está protegida con contraseña. Será procesada cuando se implemente el desbloqueo.`,
      }
    }
    return {
      status: 'invalid_format',
      attachedDocumentXml: null,
      invoiceXml: null,
      xmlFilename: null,
      additionalInvoiceXmls: [],
      errorMessage: `No se pudo descomprimir "${filename}": ${msg}`,
    }
  }

  // Recopilar todos los archivos XML del ZIP
  const xmlEntries = Object.keys(unzipped).filter((name) =>
    name.toLowerCase().endsWith('.xml') && !name.startsWith('__MACOSX')
  )

  if (xmlEntries.length === 0) {
    return {
      status: 'no_xml',
      attachedDocumentXml: null,
      invoiceXml: null,
      xmlFilename: null,
      additionalInvoiceXmls: [],
      errorMessage: `No se encontró ningún archivo XML dentro del ZIP "${filename}".`,
    }
  }

  // Procesar el primer XML (y los adicionales si hay lote)
  const [primaryEntry, ...otherEntries] = xmlEntries

  const primaryXml = strFromU8(unzipped[primaryEntry])
  const primaryInvoiceXml = extractInnerInvoiceXml(primaryXml)

  const additionalInvoiceXmls = otherEntries
    .map((entry) => {
      const xml = strFromU8(unzipped[entry])
      return extractInnerInvoiceXml(xml) ?? xml
    })
    .filter(Boolean) as string[]

  return {
    status: 'ok',
    attachedDocumentXml: primaryXml,
    invoiceXml: primaryInvoiceXml ?? primaryXml,
    xmlFilename: primaryEntry,
    additionalInvoiceXmls,
  }
}

/**
 * Extrae el XML interno de la factura desde el AttachedDocument DIAN.
 *
 * Estructura del AttachedDocument:
 *   <AttachedDocument>
 *     <cac:Attachment>
 *       <cac:ExternalReference>
 *         <cbc:Description>{BASE64_DEL_XML_INTERNO}</cbc:Description>
 *       </cac:ExternalReference>
 *     </cac:Attachment>
 *   </AttachedDocument>
 *
 * El XML interno es el Invoice/CreditNote/DebitNote real.
 */
function extractInnerInvoiceXml(xml: string): string | null {
  // Si no es un AttachedDocument, el XML ya ES la factura
  if (!xml.includes('AttachedDocument')) {
    return xml
  }

  // Regex para extraer el contenido de <cbc:Description> dentro de <cac:Attachment>
  // Capturamos el base64 que puede incluir saltos de línea y espacios
  const match = xml.match(
    /<cac:Attachment[\s\S]*?<cac:ExternalReference[\s\S]*?<cbc:Description>([\s\S]*?)<\/cbc:Description>/
  )

  if (!match?.[1]) return null

  const base64Content = match[1].trim().replace(/\s+/g, '')

  try {
    const decoded = atob(base64Content)
    // Verificar que es un XML válido
    if (decoded.trim().startsWith('<?xml') || decoded.trim().startsWith('<')) {
      return decoded
    }
    return null
  } catch {
    return null
  }
}
