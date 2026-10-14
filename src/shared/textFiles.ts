/**
 * WP 7.3 — reading text files written on Windows. Pure (no fs) so the importers' unit tests cover it.
 *
 * Windows tools write text files three ways the macOS defaults never do: with a UTF-8 byte-order
 * mark (Excel "CSV UTF-8", Notepad), as UTF-16LE with a BOM (Tally's "Unicode" XML export, Excel
 * "Unicode Text"), and with CRLF line endings. `decodeTextFile` turns any of them into a plain JS
 * string without the BOM; the line endings are left to each parser (every importer splits on
 * \r?\n, and `normaliseNewlines` is there for those that want LF only, e.g. XML per XML 1.0 §2.11).
 */
import { decodeBytes } from './bankFormats/quirks'
import { SINGLE_BYTE_WESTERN, decodeUtf16be, decodeWindows1252, looksUtf16, utf8Shape, xmlDeclaredEncoding } from './textEncoding'

/** A file whose bytes have no one right reading — refused with this message, never guessed. */
export class TextEncodingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TextEncodingError'
  }
}

/**
 * Decode a text file's bytes: a BOM decides (UTF-8 / UTF-16LE / UTF-16BE); without one, a file
 * with NUL bytes among its first 64 is UTF-16 (LE when the NUL comes second — a
 * BOM-less "Unicode" export); anything else is UTF-8. A leading U+FEFF left by a
 * double-encoded BOM is dropped too.
 *
 * WP 7.3 review — a file that is NOT UTF-8 (Tally's non-Unicode export and other "ANSI" files are
 * written in the Windows code page, 1252 on English / Indian-English Windows): an XML declaration
 * naming Windows-1252 / ISO-8859-1 / ASCII is honoured for bytes that are not valid UTF-8, and bytes
 * with not one well-formed UTF-8 multi-byte sequence are read as Windows-1252 — instead of every accented letter becoming U+FFFD
 * in a ledger name. Well-formed UTF-8 next to invalid bytes (a damaged file) and any other declared
 * encoding are refused with a `TextEncodingError` that says how to re-export.
 */
export function decodeTextFile(bytes: Uint8Array): string {
  let text: string
  if (hasBom(bytes)) text = decodeBytes(bytes)
  else if (looksUtf16(bytes, 'le')) text = new TextDecoder('utf-16le').decode(bytes)
  else if (looksUtf16(bytes, 'be')) text = decodeUtf16be(bytes)
  else {
    const declared = xmlDeclaredEncoding(bytes)
    const shape = utf8Shape(bytes)
    if (shape === 'valid') text = new TextDecoder('utf-8').decode(bytes)
    else if (declared && SINGLE_BYTE_WESTERN.has(declared)) text = decodeWindows1252(bytes)
    else if (declared && declared !== 'utf-8' && declared !== 'utf8') {
      throw new TextEncodingError(`This file is in the ${declared} encoding, which Total can't read — export it again as UTF-8 or Unicode (UTF-16)`)
    } else if (shape === 'legacy') text = decodeWindows1252(bytes)
    else {
      throw new TextEncodingError('This file mixes text encodings (part UTF-8, part not), so some names would come out wrong — export it again as UTF-8 or Unicode (UTF-16)')
    }
  }
  return text.replace(/^\uFEFF/, '')
}

/** CRLF and lone CR → LF. */
export function normaliseNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

function hasBom(b: Uint8Array): boolean {
  return (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) || (b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)
}
