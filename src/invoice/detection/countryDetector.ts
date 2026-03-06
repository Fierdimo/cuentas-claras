/**
 * Detecta el país y formato de una factura electrónica
 * escaneando los primeros 2KB del XML por firmas de namespace.
 *
 * Diseñado para ser rápido: no hace DOM parse completo.
 */

import type { CanonicalInvoice } from '../types/canonical'

export interface DetectionResult {
  countryCode: string
  format: CanonicalInvoice['invoiceFormat']
  confidence: 'high' | 'medium' | 'low'
}

// Firmas ordenadas de más a menos específicas
const NAMESPACE_SIGNATURES: Array<{
  fragment: string
  countryCode: string
  format: CanonicalInvoice['invoiceFormat']
}> = [
  // Colombia DIAN — UBL 2.1 con extensiones DIAN
  { fragment: 'dian.gov.co',           countryCode: 'CO', format: 'UBL_2.1' },
  { fragment: 'xmlns:dian',            countryCode: 'CO', format: 'UBL_2.1' },
  { fragment: 'xmlns:sts',             countryCode: 'CO', format: 'UBL_2.1' },
  // México SAT — CFDI 4.0
  { fragment: 'sat.gob.mx/cfd',        countryCode: 'MX', format: 'CFDI_4.0' },
  { fragment: 'xmlns:cfdi',            countryCode: 'MX', format: 'CFDI_4.0' },
  // España AEAT — FacturaE
  { fragment: 'www.facturae.es',        countryCode: 'ES', format: 'FACTURAE_3.2' },
  // Perú SUNAT — UBL 2.1
  { fragment: 'sunat.gob.pe',          countryCode: 'PE', format: 'UBL_2.1_PE' },
  // Ecuador SRI
  { fragment: 'www.sri.gob.ec',        countryCode: 'EC', format: 'OTHER' },
  // Chile SII
  { fragment: 'www.sii.cl',            countryCode: 'CL', format: 'OTHER' },
  // UBL 2.1 genérico (fallback — puede ser CO, PE, EC no detectados arriba)
  {
    fragment: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
    countryCode: 'UNKNOWN_UBL',
    format: 'UBL_2.1',
  },
  {
    fragment: 'urn:oasis:names:specification:ubl:schema:xsd:AttachedDocument-2',
    countryCode: 'UNKNOWN_UBL',
    format: 'UBL_2.1',
  },
]

const ROOT_ELEMENT_HINTS: Record<string, string> = {
  'cfdi:Comprobante': 'MX',
  'fe:Invoice':       'ES',
  DTE:                'CL',
  comprobante:        'EC',
}

/**
 * Detecta el país/formato de una factura electrónica a partir de su XML.
 *
 * @param xmlString - Contenido XML como string (puede ser AttachedDocument o Invoice)
 * @returns DetectionResult con countryCode, format y nivel de confianza
 */
export function detectCountryFromXml(xmlString: string): DetectionResult {
  // Escanear solo los primeros 2KB — suficiente para encontrar namespaces
  const header = xmlString.substring(0, 2048)

  for (const sig of NAMESPACE_SIGNATURES) {
    if (header.includes(sig.fragment)) {
      return {
        countryCode: sig.countryCode,
        format: sig.format,
        confidence: 'high',
      }
    }
  }

  // Fallback: elemento raíz
  const rootMatch = header.match(/<([a-zA-Z:]+)[\s>]/)
  if (rootMatch) {
    const rootEl = rootMatch[1]
    const country = ROOT_ELEMENT_HINTS[rootEl]
    if (country) {
      return { countryCode: country, format: 'OTHER', confidence: 'medium' }
    }
  }

  return { countryCode: 'UNKNOWN', format: 'OTHER', confidence: 'low' }
}
