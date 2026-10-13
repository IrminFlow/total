// WP 5.4 — the zlib inflate handed to the PDF reader, capped per stream (a zip bomb stops at
// 32 MB instead of exhausting memory; the reader also caps the total decoded bytes).
import { inflateSync } from 'zlib'

export const PDF_STREAM_MAX_BYTES = 32 * 1024 * 1024

export const pdfInflate = (b: Uint8Array): Uint8Array => new Uint8Array(inflateSync(b, { maxOutputLength: PDF_STREAM_MAX_BYTES }))
