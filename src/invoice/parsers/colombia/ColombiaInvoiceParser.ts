import { XMLParser } from 'fast-xml-parser'
import type { IInvoiceParser } from '../IInvoiceParser'
import type { CanonicalInvoice, CanonicalParty, CanonicalTaxLine, CanonicalLineItem, TaxType } from '../../types/canonical'
import type { ParseMetadata, ValidationResult } from '../../types/email'

const PARSER_VERSION = '1.0.0'

/**
 * Parser para facturas electrónicas colombianas DIAN.
 * Formato: UBL 2.1 con extensiones DIAN (sts:, fe:).
 *
 * Entrada esperada: XML interno del Invoice/CreditNote/DebitNote
 * (ya extraído del AttachedDocument por attachmentPipeline).
 */
export class ColombiaInvoiceParser implements IInvoiceParser {
  readonly countryCode = 'CO'
  readonly supportedFormat = 'UBL_2.1'

  private readonly xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    // Mantener prefijos de namespace para no colapsar nodos con mismo nombre local
    removeNSPrefix: false,
    parseAttributeValue: true,
    // Convertir siempre a array los nodos que pueden repetirse
    isArray: (tagName) =>
      ['cac:InvoiceLine', 'cac:TaxTotal', 'cac:TaxSubtotal',
       'cac:CreditNoteLine', 'cac:DebitNoteLine'].includes(tagName),
  })

  async parse(xmlContent: string, meta: ParseMetadata): Promise<CanonicalInvoice> {
    const doc = this.xmlParser.parse(xmlContent)

    // El root puede ser fe:Invoice, Invoice, CreditNote, DebitNote
    const inv =
      doc['fe:Invoice'] ??
      doc['Invoice'] ??
      doc['CreditNote'] ??
      doc['DebitNote'] ??
      doc['fe:CreditNote'] ??
      doc['fe:DebitNote']

    if (!inv) {
      throw new Error('CO: No se encontró el elemento raíz Invoice/CreditNote/DebitNote')
    }

    const cbc = (key: string) => inv[`cbc:${key}`] ?? inv[key]
    const cac = (key: string) => inv[`cac:${key}`] ?? inv[key]

    const invoiceType = this.mapInvoiceType(String(cbc('InvoiceTypeCode') ?? ''))
    const lineItems = this.mapLineItems(
      cac('InvoiceLine') ?? cac('CreditNoteLine') ?? cac('DebitNoteLine') ?? []
    )
    const taxes = this.mapTaxTotals(cac('TaxTotal') ?? [])
    const monetary = cac('LegalMonetaryTotal') ?? {}

    return {
      id: crypto.randomUUID(),
      countryCode: 'CO',
      invoiceFormat: 'UBL_2.1',
      originalXmlHash: await this.sha256(xmlContent),

      invoiceNumber: String(cbc('ID') ?? ''),
      series: this.extractSeries(String(cbc('ID') ?? '')),
      invoiceType,
      status: 'pending',

      issueDate: String(cbc('IssueDate') ?? ''),
      issueTime: cbc('IssueTime') != null ? String(cbc('IssueTime')) : undefined,
      dueDate: cbc('DueDate') != null ? String(cbc('DueDate')) : undefined,

      issuer: this.mapParty(cac('AccountingSupplierParty')),
      recipient: this.mapParty(cac('AccountingCustomerParty')),

      currency: String(cbc('DocumentCurrencyCode') ?? 'COP'),
      subtotal: this.parseAmount(monetary['cbc:LineExtensionAmount']),
      totalDiscount: this.parseAmount(monetary['cbc:AllowanceTotalAmount']),
      totalTax: taxes.reduce((sum, t) => sum + t.taxAmount, 0),
      totalAmount: this.parseAmount(monetary['cbc:PayableAmount']),

      taxes,
      lineItems,

      authorizationCode: cbc('UUID') != null ? String(cbc('UUID')) : undefined,
      qrCodeData: undefined, // Se extrae del PDF, no del XML

      source: meta.sourceEmailId ? 'email' : 'manual',
      sourceEmailId: meta.sourceEmailId,
      sourceEmailSubject: meta.sourceEmailSubject,
      sourceFileName: meta.sourceFileName,

      userId: meta.userId,
      parsedAt: new Date().toISOString(),
      parserVersion: meta.parserVersion ?? PARSER_VERSION,
      updatedAt: new Date().toISOString(),
      version: 1,
    }
  }

  validate(invoice: CanonicalInvoice): ValidationResult {
    const errors: ValidationResult['errors'] = []
    const warnings: ValidationResult['warnings'] = []

    // CUFE debe existir y tener exactamente 96 caracteres (SHA-384 en hex)
    if (!invoice.authorizationCode) {
      errors.push({
        field: 'authorizationCode',
        message: 'El CUFE es obligatorio en facturas DIAN',
        code: 'CO_001',
      })
    } else if (invoice.authorizationCode.length !== 96) {
      errors.push({
        field: 'authorizationCode',
        message: `El CUFE debe tener 96 caracteres, se encontraron ${invoice.authorizationCode.length}`,
        code: 'CO_002',
      })
    }

    // Fecha de emisión requerida
    if (!invoice.issueDate) {
      errors.push({ field: 'issueDate', message: 'La fecha de emisión es obligatoria', code: 'CO_003' })
    }

    // NIT emisor: formato colombiano básico (7–10 dígitos, opcionalmente con dígito de verificación)
    if (!invoice.issuer.taxId.match(/^\d{7,10}(-\d)?$/)) {
      warnings.push({
        field: 'issuer.taxId',
        message: `NIT del emisor con formato inusual: ${invoice.issuer.taxId}`,
      })
    }

    // Total no puede ser negativo
    if (invoice.totalAmount < 0) {
      errors.push({
        field: 'totalAmount',
        message: 'El total de la factura no puede ser negativo',
        code: 'CO_004',
      })
    }

    return { isValid: errors.length === 0, errors, warnings }
  }

  // ── Mapeo de partes (emisor / receptor) ────────────────────────────────────

  private mapParty(partyContainer: any): CanonicalParty {
    const party = partyContainer?.['cac:Party'] ?? partyContainer ?? {}
    const taxScheme = party['cac:PartyTaxScheme'] ?? {}
    const legalEntity = party['cac:PartyLegalEntity'] ?? {}
    const partyName = party['cac:PartyName'] ?? {}
    const postalAddr = party['cac:PostalAddress'] ?? {}
    const contact = party['cac:Contact'] ?? {}

    const taxId = String(
      taxScheme['cbc:CompanyID'] ??
      legalEntity['cbc:CompanyID'] ??
      ''
    )

    const legalName = String(
      legalEntity['cbc:RegistrationName'] ??
      partyName['cbc:Name'] ??
      taxScheme['cbc:RegistrationName'] ??
      ''
    )

    return {
      taxId,
      taxIdType: 'NIT',
      legalName,
      address: {
        street: String(postalAddr['cac:AddressLine']?.['cbc:Line'] ?? ''),
        city: String(postalAddr['cbc:CityName'] ?? ''),
        state: String(postalAddr['cbc:CountrySubentity'] ?? ''),
        postalCode: String(postalAddr['cbc:PostalZone'] ?? ''),
        countryCode: String(postalAddr['cac:Country']?.['cbc:IdentificationCode'] ?? 'CO'),
      },
      email: contact['cbc:ElectronicMail']
        ? String(contact['cbc:ElectronicMail'])
        : undefined,
      phone: contact['cbc:Telephone']
        ? String(contact['cbc:Telephone'])
        : undefined,
    }
  }

  // ── Mapeo de impuestos ──────────────────────────────────────────────────────

  private mapTaxTotals(taxTotalNodes: any[]): CanonicalTaxLine[] {
    const nodes = Array.isArray(taxTotalNodes) ? taxTotalNodes : [taxTotalNodes]
    return nodes
      .filter(Boolean)
      .flatMap((tt: any) => {
        const subtotals = tt['cac:TaxSubtotal']
        const subtotalArr = Array.isArray(subtotals) ? subtotals : [subtotals]
        return subtotalArr.filter(Boolean).map((sub: any) => {
          const category = sub['cac:TaxCategory'] ?? {}
          const scheme = category['cac:TaxScheme'] ?? {}
          return {
            taxType: this.mapTaxSchemeId(String(scheme['cbc:ID'] ?? '')),
            taxableAmount: this.parseAmount(sub['cbc:TaxableAmount']),
            taxRate: parseFloat(String(category['cbc:Percent'] ?? '0')) / 100,
            taxAmount: this.parseAmount(sub['cbc:TaxAmount']),
            taxCategory: String(category['cbc:ID'] ?? ''),
          } satisfies CanonicalTaxLine
        })
      })
  }

  // ── Mapeo de líneas de detalle ──────────────────────────────────────────────

  private mapLineItems(lineNodes: any[]): CanonicalLineItem[] {
    const lines = Array.isArray(lineNodes) ? lineNodes : lineNodes ? [lineNodes] : []
    return lines.map((line: any, idx: number) => {
      const item = line['cac:Item'] ?? {}
      const price = line['cac:Price'] ?? {}
      const qty = line['cbc:InvoicedQuantity'] ?? line['cbc:CreditedQuantity'] ?? line['cbc:DebitedQuantity'] ?? '1'
      const qtyValue = typeof qty === 'object' ? (qty['#text'] ?? qty) : qty

      return {
        lineNumber: parseInt(String(line['cbc:ID'] ?? idx + 1), 10),
        productCode: String(
          item['cac:SellersItemIdentification']?.['cbc:ID'] ??
          item['cac:StandardItemIdentification']?.['cbc:ID'] ??
          ''
        ) || undefined,
        description: String(item['cbc:Description'] ?? item['cbc:Name'] ?? ''),
        quantity: parseFloat(String(qtyValue)),
        unitOfMeasure: typeof qty === 'object' ? String(qty['@_unitCode'] ?? '') : undefined,
        unitPrice: this.parseAmount(price['cbc:PriceAmount']),
        discountAmount: this.parseAmount(line['cac:AllowanceCharge']?.['cbc:Amount']),
        lineTotal: this.parseAmount(line['cbc:LineExtensionAmount']),
        taxes: this.mapTaxTotals(
          Array.isArray(line['cac:TaxTotal'])
            ? line['cac:TaxTotal']
            : line['cac:TaxTotal']
            ? [line['cac:TaxTotal']]
            : []
        ),
      } satisfies CanonicalLineItem
    })
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private mapInvoiceType(code: string): CanonicalInvoice['invoiceType'] {
    const map: Record<string, CanonicalInvoice['invoiceType']> = {
      '01': 'invoice',
      '02': 'invoice',   // Factura de exportación
      '03': 'invoice',   // Factura por contingencia
      '91': 'credit_note',
      '92': 'debit_note',
    }
    return map[code] ?? 'invoice'
  }

  private mapTaxSchemeId(id: string): TaxType {
    const map: Record<string, TaxType> = {
      '01': 'IVA_CO',
      '04': 'INC',
      '03': 'ICA',
      '06': 'RETE_IVA',
      '07': 'RETE_FUENTE',
      ZA:   'IVA_CO',
    }
    return map[id] ?? 'OTHER'
  }

  private parseAmount(node: any): number {
    if (node == null) return 0
    const val = typeof node === 'object' ? (node['#text'] ?? node['@_currencyID'] ? node['#text'] : node) : node
    return parseFloat(String(val)) || 0
  }

  private extractSeries(invoiceId: string): string | undefined {
    const match = invoiceId.match(/^([A-Za-z]+)/)
    return match?.[1] ?? undefined
  }

  private async sha256(text: string): Promise<string> {
    const buffer = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(text)
    )
    return Array.from(new Uint8Array(buffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }
}
