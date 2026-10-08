// WP 5.4 — turning a captured file into what is sent: a PDF's TEXT LAYER when it has a usable
// one (maskable, small), else the PDF file itself (the provider renders it); an image as an image
// (HEIC converted to JPEG, large photos scaled down — by Electron's nativeImage in the app; tests
// inject a converter). Pure apart from the injected pieces — no Electron import here.
import { inflateSync } from 'zlib'
import { extractPdfText, textLooksUsable } from '@shared/capture/pdfText'
import { CAPTURE_MAX_PAGES } from '@shared/capture/types'
import type { ChatAttachment } from '../types'

/** Converts an image for sending (JPEG / PNG / WEBP out), or null when it cannot be read. */
export type ImageConverter = (bytes: Buffer, mime: string) => { mime: 'image/jpeg' | 'image/png' | 'image/webp'; bytes: Buffer } | null

/** The converter used outside the app (dbtests): sends PNG / JPEG / WEBP as they are; HEIC needs Electron. */
export const passthroughImages: ImageConverter = (bytes, mime) =>
  mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/webp' ? { mime, bytes } : null

export type PreparedDoc =
  | { mode: 'text'; text: string; pages: number }
  | { mode: 'image'; attachment: ChatAttachment; pages: 1 }
  | { mode: 'pdf'; attachment: ChatAttachment; pages: number }

const inflate = (b: Uint8Array): Uint8Array => new Uint8Array(inflateSync(b))

/** Page count and whether a text layer is usable — read at intake (for the cost estimate). */
export function inspectDocument(bytes: Buffer, mime: string): { pages: number; textLayer: boolean } {
  if (mime !== 'application/pdf') return { pages: 1, textLayer: false }
  try {
    const r = extractPdfText(bytes, inflate)
    if (r.encrypted) throw new Error('This PDF is password-protected — remove the password and capture it again')
    return { pages: r.pageCount, textLayer: textLooksUsable(r.pages.join('\n')) }
  } catch (err) {
    if ((err as Error).message.startsWith('This PDF')) throw err
    return { pages: 1, textLayer: false }
  }
}

export function prepareDocument(bytes: Buffer, mime: string, fileName: string, images: ImageConverter): PreparedDoc {
  if (mime === 'application/pdf') {
    const r = extractPdfText(bytes, inflate)
    if (r.encrypted) throw new Error('This PDF is password-protected — remove the password and capture it again')
    if (r.pageCount > CAPTURE_MAX_PAGES) throw new Error(`${r.pageCount} pages — capture takes bills of up to ${CAPTURE_MAX_PAGES} pages`)
    const text = r.pages.map((p, i) => (r.pages.length > 1 ? `--- page ${i + 1} ---\n${p}` : p)).join('\n')
    if (textLooksUsable(text)) return { mode: 'text', text, pages: r.pageCount }
    return { mode: 'pdf', pages: r.pageCount, attachment: { kind: 'file', mime: 'application/pdf', base64: bytes.toString('base64'), filename: fileName.replace(/[^\w.() -]/g, '_') } }
  }
  const img = images(bytes, mime)
  if (!img) throw new Error(mime === 'image/heic' || mime === 'image/heif' ? 'This HEIC photo could not be converted — export it as JPEG and capture that' : 'The image could not be read')
  return { mode: 'image', pages: 1, attachment: { kind: 'image', mime: img.mime, base64: img.bytes.toString('base64') } }
}
