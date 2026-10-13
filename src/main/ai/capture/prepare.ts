// WP 5.4 — turning a captured file into what is sent: a PDF's TEXT LAYER when it has a usable
// one (maskable, small), else the PDF file itself (the provider renders it); an image as an image
// (HEIC converted to JPEG, large photos scaled down — by Electron's nativeImage in the app; tests
// inject a converter). The PDF is read off the main thread (pdfHost.ts). What goes out carries a
// NEUTRAL file name ("bill.pdf") — a real file name often holds the supplier, GSTIN or invoice no.
import { textLooksUsable } from '@shared/capture/pdfText'
import { CAPTURE_MAX_PAGES } from '@shared/capture/types'
import type { ChatAttachment } from '../types'
import { readPdf } from './pdfHost'

/** Converts an image for sending (JPEG / PNG / WEBP out), or null when it cannot be read. */
export type ImageConverter = (bytes: Buffer, mime: string) => { mime: 'image/jpeg' | 'image/png' | 'image/webp'; bytes: Buffer } | null

/** The converter used outside the app (dbtests): sends PNG / JPEG / WEBP as they are; HEIC needs Electron. */
export const passthroughImages: ImageConverter = (bytes, mime) =>
  mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/webp' ? { mime, bytes } : null

export type PreparedDoc =
  | { mode: 'text'; text: string; pages: number }
  | { mode: 'image'; attachment: ChatAttachment; pages: 1 }
  | { mode: 'pdf'; attachment: ChatAttachment; pages: number }

export const ENCRYPTED_PDF = 'This PDF is password-protected — remove the password and capture it again'
export const UNKNOWN_PAGES = 'The page count of this PDF could not be read — print it to a new PDF (or photograph the pages) and capture that'
export const tooManyPages = (n: number): string => `${n} pages — capture takes bills of up to ${CAPTURE_MAX_PAGES} pages`

/** Page count and whether a text layer is usable — read at intake (for the cost estimate). A
 *  file whose pages cannot be counted, or with too many, is refused there (never guessed). */
export async function inspectDocument(bytes: Buffer, mime: string): Promise<{ pages: number; textLayer: boolean }> {
  if (mime !== 'application/pdf') return { pages: 1, textLayer: false }
  const r = await readPdf(bytes)
  if (r.encrypted) throw new Error(ENCRYPTED_PDF)
  if (r.pageCount == null) throw new Error(UNKNOWN_PAGES)
  if (r.pageCount > CAPTURE_MAX_PAGES) throw new Error(tooManyPages(r.pageCount))
  return { pages: r.pageCount, textLayer: textLooksUsable(r.pages.join('\n')) }
}

export async function prepareDocument(bytes: Buffer, mime: string, images: ImageConverter): Promise<PreparedDoc> {
  if (mime === 'application/pdf') {
    const r = await readPdf(bytes)
    if (r.encrypted) throw new Error(ENCRYPTED_PDF)
    if (r.pageCount == null) throw new Error(UNKNOWN_PAGES)
    if (r.pageCount > CAPTURE_MAX_PAGES) throw new Error(tooManyPages(r.pageCount))
    const text = r.pages.map((p, i) => (r.pages.length > 1 ? `--- page ${i + 1} ---\n${p}` : p)).join('\n')
    if (textLooksUsable(text)) return { mode: 'text', text, pages: r.pageCount }
    return { mode: 'pdf', pages: r.pageCount, attachment: { kind: 'file', mime: 'application/pdf', base64: bytes.toString('base64'), filename: 'bill.pdf' } }
  }
  const img = images(bytes, mime)
  if (!img) throw new Error(mime === 'image/heic' || mime === 'image/heif' ? 'This HEIC photo could not be converted — export it as JPEG and capture that' : 'The image could not be read')
  return { mode: 'image', pages: 1, attachment: { kind: 'image', mime: img.mime, base64: img.bytes.toString('base64') } }
}
