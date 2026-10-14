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

/**
 * Decode a text file's bytes: a BOM decides (UTF-8 / UTF-16LE / UTF-16BE); without one, a file
 * with NUL bytes among its first 64 is UTF-16 (LE when the NUL comes second — a
 * BOM-less "Unicode" export); anything else is UTF-8. A leading U+FEFF left by a
 * double-encoded BOM is dropped too.
 */
export function decodeTextFile(bytes: Uint8Array): string {
  let text: string
  if (hasBom(bytes)) text = decodeBytes(bytes)
  else if (looksUtf16(bytes, 'le')) text = new TextDecoder('utf-16le').decode(bytes)
  else if (looksUtf16(bytes, 'be')) {
    const swapped = new Uint8Array(bytes.length - (bytes.length % 2))
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      swapped[i] = bytes[i + 1]!
      swapped[i + 1] = bytes[i]!
    }
    text = new TextDecoder('utf-16le').decode(swapped)
  } else text = new TextDecoder('utf-8').decode(bytes)
  return text.replace(/^\uFEFF/, '')
}

/** CRLF and lone CR → LF. */
export function normaliseNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

function hasBom(b: Uint8Array): boolean {
  return (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) || (b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)
}

/** Text files never hold NUL bytes, UTF-16 text is full of them (every ASCII character has one):
 *  a NUL in the first 64 bytes means UTF-16, the side the NULs fall on gives the byte order. */
function looksUtf16(b: Uint8Array, order: 'le' | 'be'): boolean {
  const n = Math.min(64, b.length - (b.length % 2))
  if (n < 2) return false
  let even = 0
  let odd = 0
  for (let i = 0; i < n; i++) if (b[i] === 0) i % 2 === 0 ? even++ : odd++
  if (even + odd === 0) return false
  return order === 'le' ? odd > even : even > odd
}
