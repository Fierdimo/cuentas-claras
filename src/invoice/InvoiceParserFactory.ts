/**
 * InvoiceParserFactory — Registry-based Abstract Factory.
 *
 * Uso:
 *   InvoiceParserFactory.registerAll()
 *   const invoice = await InvoiceParserFactory.parse(attachment, userId)
 *
 * Para agregar un nuevo país:
 *   1. Crear src/invoice/parsers/{pais}/{Pais}InvoiceParser.ts
 *   2. Agregar la firma de namespace en countryDetector.ts
 *   3. Registrar en registerAll() con InvoiceParserFactory.register(new PaisParser())
 */

import { ColombiaInvoiceParser } from './parsers/colombia/ColombiaInvoiceParser'
import { detectCountryFromXml } from './detection/countryDetector'
import { processAttachment, base64UrlToUint8Array } from './pipeline/attachmentPipeline'
import type { IInvoiceParser } from './parsers/IInvoiceParser'
import type { CanonicalInvoice } from './types/canonical'
import type { ParsedAttachment } from './types/email'

const PARSER_VERSION = '1.0.0'

// ── Errores tipados ───────────────────────────────────────────────────────────

export class UnsupportedCountryError extends Error {
  constructor(
    public readonly countryCode: string,
    public readonly format: string,
    public readonly filename: string
  ) {
    super(
      `No hay parser registrado para el país "${countryCode}" ` +
      `(formato: ${format}, archivo: ${filename}). ` +
      `Esta factura no puede procesarse automáticamente.`
    )
    this.name = 'UnsupportedCountryError'
  }
}

export class LockedZipError extends Error {
  constructor(public readonly filename: string) {
    super(`La factura "${filename}" está protegida con contraseña.`)
    this.name = 'LockedZipError'
  }
}

export class NoXmlFoundError extends Error {
  constructor(public readonly filename: string, public readonly detail?: string) {
    super(detail ?? `No se encontró XML de factura en "${filename}".`)
    this.name = 'NoXmlFoundError'
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export class InvoiceParserFactory {
  private static registry = new Map<string, IInvoiceParser>()
  private static initialized = false

  /**
   * Registra un parser en el registro.
   * Llamar antes de usar parse().
   */
  static register(parser: IInvoiceParser): void {
    this.registry.set(parser.countryCode, parser)
  }

  /**
   * Registra todos los parsers disponibles.
   * En Fase 1 solo Colombia.
   */
  static registerAll(): void {
    if (this.initialized) return
    this.register(new ColombiaInvoiceParser())
    // Fase 2+: agregar otros países aquí
    // this.register(new MexicoInvoiceParser())
    // this.register(new PeruInvoiceParser())
    this.initialized = true
  }

  /**
   * Punto de entrada principal.
   * Recibe un adjunto (desde correo o document picker) y retorna
   * un CanonicalInvoice normalizado.
   *
   * Lanza:
   *  - LockedZipError si el ZIP está protegido con contraseña
   *  - NoXmlFoundError si no hay XML en el ZIP
   *  - UnsupportedCountryError si el país no tiene parser registrado
   */
  static async parse(
    attachment: ParsedAttachment,
    userId: string
  ): Promise<CanonicalInvoice> {
    if (!this.initialized) {
      this.registerAll()
    }

    // 1. Descomprimir y extraer XML
    const pipeline = processAttachment(attachment.content, attachment.filename)

    if (pipeline.status === 'locked') {
      throw new LockedZipError(attachment.filename)
    }

    if (pipeline.status !== 'ok' || !pipeline.invoiceXml) {
      throw new NoXmlFoundError(attachment.filename, pipeline.errorMessage)
    }

    // 2. Detectar país
    const detection = detectCountryFromXml(pipeline.invoiceXml)

    // 3. Buscar parser en registro
    const parser = this.registry.get(detection.countryCode)
    if (!parser) {
      throw new UnsupportedCountryError(
        detection.countryCode,
        detection.format,
        attachment.filename
      )
    }

    // 4. Parsear
    const invoice = await parser.parse(pipeline.invoiceXml, {
      sourceFileName: attachment.filename,
      sourceEmailId: attachment.messageId,
      userId,
      parserVersion: PARSER_VERSION,
    })

    // 5. Validar (no bloquea — solo agrega warnings al invoice)
    const validation = parser.validate(invoice)
    if (!validation.isValid || validation.warnings.length > 0) {
      invoice.rawParseErrors = [
        ...validation.errors.map((e) => `[${e.code}] ${e.field}: ${e.message}`),
        ...validation.warnings.map((w) => `[WARN] ${w.field}: ${w.message}`),
      ]
    }

    return invoice
  }

  /**
   * Procesa un adjunto recibido en base64url (formato Gmail API).
   */
  static async parseFromBase64(
    base64Data: string,
    filename: string,
    mimeType: string,
    userId: string,
    messageId?: string
  ): Promise<CanonicalInvoice> {
    const content = base64UrlToUint8Array(base64Data)
    return this.parse({ filename, mimeType, content, messageId }, userId)
  }

  /**
   * Retorna la lista de países con parser registrado.
   */
  static getSupportedCountries(): string[] {
    return Array.from(this.registry.keys())
  }
}
