/**
 * Tipos relacionados con adjuntos de correo electrónico.
 */

export interface ParsedAttachment {
  filename: string
  mimeType: string
  /** Contenido binario del adjunto */
  content: Uint8Array
  /** ID del mensaje de Gmail/Outlook */
  messageId?: string
  /** ID del adjunto en la API de Gmail */
  attachmentId?: string
}

export interface EmailMessage {
  messageId: string
  subject: string
  senderEmail: string
  senderName?: string
  receivedAt: string
  attachments: ParsedAttachment[]
  bodySnippet?: string
}

export interface ParseMetadata {
  sourceEmailId?: string
  sourceEmailSubject?: string
  sourceFileName?: string
  userId: string
  parserVersion: string
}

export interface ValidationResult {
  isValid: boolean
  errors: Array<{ field: string; message: string; code: string }>
  warnings: Array<{ field: string; message: string }>
}
