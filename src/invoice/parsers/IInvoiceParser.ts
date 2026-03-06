/**
 * Contrato que deben implementar todos los parsers de facturas.
 * Cada país registra su propia implementación en InvoiceParserFactory.
 */

import type { CanonicalInvoice } from '../types/canonical'
import type { ParseMetadata, ValidationResult } from '../types/email'

export interface IInvoiceParser {
  /** Código ISO 3166-1 alpha-2 del país */
  readonly countryCode: string
  /** Formato soportado, ej: 'UBL_2.1', 'CFDI_4.0' */
  readonly supportedFormat: string

  /**
   * Parsea el XML interno de la factura (ya desenvuelto del AttachedDocument)
   * y retorna un CanonicalInvoice normalizado.
   */
  parse(xmlContent: string, meta: ParseMetadata): Promise<CanonicalInvoice>

  /**
   * Valida el CanonicalInvoice contra reglas de negocio específicas del país.
   * No lanza excepción — retorna errores y warnings para decisión del caller.
   */
  validate(invoice: CanonicalInvoice): ValidationResult
}
