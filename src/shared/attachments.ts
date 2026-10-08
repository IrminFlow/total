// WP 6.4 — attachments on vouchers, ledgers, stock items and trade documents. Pure TypeScript:
// the entity vocabulary, the allowed file types, the size cap, and the content-addressed layout of
// the store (<company folder>/attachments/<sha256[0:2]>/<sha256>). The main process
// (services/attachments.ts) does every file read and write; the renderer never touches a path.
import { z } from 'zod'

export const ATTACHMENT_ENTITIES = ['voucher', 'ledger', 'stockItem', 'trade_doc'] as const
export type AttachmentEntity = (typeof ATTACHMENT_ENTITIES)[number]

export interface Attachment {
  id: number
  entity: AttachmentEntity
  entityId: number
  fileName: string
  mime: string
  size: number
  sha256: string
  addedBy: string | null
  addedAt: string
}

/** Default size cap per file (25 MB). */
export const DEFAULT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024
/** The cap can be set between 1 MB and 200 MB. */
export const ATTACHMENT_MAX_BYTES_RANGE = { min: 1024 * 1024, max: 200 * 1024 * 1024 } as const

/** Allowed file types: extension → MIME. Documents and images a bill or a KYC file comes as —
 *  nothing executable, no archives (they could hide anything), no HTML / SVG (they would run script
 *  when opened), no .eml (mail bodies are HTML). Text types are also content-sniffed
 *  (contentRefusal) so a web page renamed .xml / .txt is refused too. */
export const ATTACHMENT_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  txt: 'text/plain',
  csv: 'text/csv',
  xml: 'application/xml',
  json: 'application/json',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet'
}
export const DEFAULT_ALLOWED_EXTENSIONS: readonly string[] = Object.keys(ATTACHMENT_TYPES)

export const attachmentConfigSchema = z.object({
  maxBytes: z.number().int().min(ATTACHMENT_MAX_BYTES_RANGE.min).max(ATTACHMENT_MAX_BYTES_RANGE.max),
  /** Lower-case extensions, each one of ATTACHMENT_TYPES (a subset can be turned off). */
  allowedExtensions: z
    .array(z.string().regex(/^[a-z0-9]{1,8}$/))
    .min(1)
    .refine((xs) => xs.every((x) => x in ATTACHMENT_TYPES), 'Only the listed file types can be allowed')
})
export type AttachmentConfig = z.infer<typeof attachmentConfigSchema>
export const DEFAULT_ATTACHMENT_CONFIG: AttachmentConfig = {
  maxBytes: DEFAULT_ATTACHMENT_MAX_BYTES,
  allowedExtensions: [...DEFAULT_ALLOWED_EXTENSIONS]
}

export const attachmentTargetSchema = z.object({
  entity: z.enum(ATTACHMENT_ENTITIES),
  entityId: z.number().int().positive()
})
export type AttachmentTarget = z.infer<typeof attachmentTargetSchema>

/** Lower-case extension of a file name ('' when there is none). */
export function extensionOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/** The display name stored for a file: the base name only (never a path), control characters
 *  dropped, at most 255 characters. */
export function cleanFileName(raw: string): string {
  const base = (raw.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (base.length <= 255) return base
  const ext = extensionOf(base)
  return ext ? `${base.slice(0, 254 - ext.length)}.${ext}` : base.slice(0, 255)
}

/** Why a file can't be attached under `cfg`, or null when it can. */
export function attachmentRefusal(fileName: string, size: number, cfg: AttachmentConfig): string | null {
  const name = cleanFileName(fileName)
  if (!name) return 'The file has no name'
  const ext = extensionOf(name)
  if (!ext || !(ext in ATTACHMENT_TYPES) || !cfg.allowedExtensions.includes(ext)) {
    return `${ext ? `.${ext}` : 'Files without an extension'} can't be attached — allowed: ${cfg.allowedExtensions.join(', ')}`
  }
  if (size > cfg.maxBytes) return `${name} is ${formatBytes(size)} — the limit is ${formatBytes(cfg.maxBytes)}`
  return null
}

/** Why a stored file may not be OPENED (or restored) under `cfg`: the same type policy as adding,
 *  without the size cap (a cap lowered later doesn't lock existing files away). */
export function openRefusal(fileName: string, cfg: AttachmentConfig): string | null {
  return attachmentRefusal(fileName, 0, cfg)
}

/** Text types whose content is sniffed: a web page, SVG or script inside them is refused. */
export const SNIFFED_EXTENSIONS: readonly string[] = ['txt', 'csv', 'xml', 'json']
const ACTIVE_CONTENT = /<\s*(html|svg|script|iframe|object|embed|body)\b|<!doctype\s+html|xml-stylesheet|javascript:/i

/** Why the bytes (the first few KB are enough) don't match a safe file of that extension. */
export function contentRefusal(fileName: string, head: Uint8Array): string | null {
  const ext = extensionOf(fileName)
  if (!SNIFFED_EXTENSIONS.includes(ext)) return null
  let text = ''
  const n = Math.min(head.length, 16384)
  for (let i = 0; i < n; i++) text += String.fromCharCode(head[i]!)
  return ACTIVE_CONTENT.test(text) ? `${cleanFileName(fileName)} looks like a web page or script, not a .${ext} file — refused` : null
}

export const SHA256_RE = /^[0-9a-f]{64}$/

/** Where a file with this hash lives, relative to the attachments folder. */
export function storedPathFor(sha256: string): string {
  if (!SHA256_RE.test(sha256)) throw new Error('Not a SHA-256 hash')
  return `${sha256.slice(0, 2)}/${sha256}`
}

/** True only for the exact relative path storedPathFor would give that hash — anything else
 *  (an absolute path, '..', a different hash) is never resolved against the store. */
export function isSafeStoredPath(storedPath: string, sha256: string): boolean {
  return SHA256_RE.test(sha256) && storedPath === storedPathFor(sha256)
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
}
