/**
 * WP 7.3 review — the byte-level half of reading a text file whose encoding nobody declared
 * (pure, renderer-safe). Shared by `textFiles.decodeTextFile` (Tally XML, CSV masters, GSTR-2B /
 * template JSON) and `bankFormats/quirks.decodeBytes` (bank statements).
 *
 * Windows writes "ANSI" text in the machine's code page — Windows-1252 on an English / Indian-
 * English install, and Tally's non-Unicode export follows it. Decoded as UTF-8, every byte from
 * 0x80 up became U+FFFD, silently, so "Café Corner" arrived as "Caf� Corner" in a ledger name.
 */

/** Windows-1252's 0x80–0x9F block (the rest of 0x00–0xFF is Latin-1 = the code point). */
const CP1252_HIGH: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6,
  0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c,
  0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a,
  0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178
}

export function decodeWindows1252(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(CP1252_HIGH[b] ?? b)
  return s
}

/** Text files never hold NUL bytes, UTF-16 text is full of them (every ASCII character has one):
 *  a NUL in the first 64 bytes means UTF-16, the side the NULs fall on gives the byte order. */
export function looksUtf16(b: Uint8Array, order: 'le' | 'be'): boolean {
  const n = Math.min(64, b.length - (b.length % 2))
  if (n < 2) return false
  let even = 0
  let odd = 0
  for (let i = 0; i < n; i++) if (b[i] === 0) i % 2 === 0 ? even++ : odd++
  if (even + odd === 0) return false
  return order === 'le' ? odd > even : even > odd
}

export function decodeUtf16be(bytes: Uint8Array): string {
  const swapped = new Uint8Array(bytes.length - (bytes.length % 2))
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    swapped[i] = bytes[i + 1]!
    swapped[i + 1] = bytes[i]!
  }
  return new TextDecoder('utf-16le').decode(swapped)
}

/**
 * How the bytes read as UTF-8: `valid` (strict), `legacy` (invalid, and not one well-formed
 * multi-byte sequence in it — a single-byte code page such as Windows-1252), or `mixed` (well-
 * formed multi-byte UTF-8 next to invalid bytes — a damaged or concatenated file; no single
 * decoding is right).
 */
export function utf8Shape(b: Uint8Array): 'valid' | 'legacy' | 'mixed' {
  let multi = 0
  let bad = 0
  for (let i = 0; i < b.length; ) {
    const c = b[i]!
    if (c < 0x80) {
      i++
      continue
    }
    const len = c >= 0xc2 && c <= 0xdf ? 2 : c >= 0xe0 && c <= 0xef ? 3 : c >= 0xf0 && c <= 0xf4 ? 4 : 0
    let ok = len > 0 && i + len <= b.length
    for (let k = 1; ok && k < len; k++) ok = (b[i + k]! & 0xc0) === 0x80
    if (ok && len === 3) {
      const c1 = b[i + 1]!
      ok = !(c === 0xe0 && c1 < 0xa0) && !(c === 0xed && c1 >= 0xa0) // overlong / surrogate
    } else if (ok && len === 4) {
      const c1 = b[i + 1]!
      ok = !(c === 0xf0 && c1 < 0x90) && !(c === 0xf4 && c1 >= 0x90)
    }
    if (ok) {
      multi++
      i += len
    } else {
      bad++
      i++
    }
  }
  if (bad === 0) return 'valid'
  return multi === 0 ? 'legacy' : 'mixed'
}

/** The encoding an XML declaration names (`<?xml version="1.0" encoding="windows-1252"?>`), read
 *  from the first bytes as ASCII; lower-cased, or null. */
export function xmlDeclaredEncoding(b: Uint8Array): string | null {
  let head = ''
  for (let i = 0; i < Math.min(b.length, 200); i++) head += String.fromCharCode(b[i]!)
  const m = head.match(/^(?:\xef\xbb\xbf)?\s*<\?xml[^>]*?\bencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/)
  return m ? m[1]!.toLowerCase() : null
}

/** Declared encodings that mean "a single-byte Western code page" (Latin-1 is read as its
 *  Windows-1252 superset, as browsers do — WHATWG Encoding). */
export const SINGLE_BYTE_WESTERN = new Set(['windows-1252', 'cp1252', 'iso-8859-1', 'iso8859-1', 'latin1', 'latin-1', 'l1', 'us-ascii', 'ascii', 'ansi'])
