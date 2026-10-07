/**
 * The small, boring rules Indian bank exports need (WP 4.1): dates in every order and separator
 * (15/08/2026, 15-Aug-26, 15.08.2026, 2026-08-15, 15 August 2026), money with ₹ / Rs. / INR,
 * Indian digit grouping (1,23,456.78), Dr/Cr suffixes or prefixes, accounting parentheses,
 * trailing minus, and the duplicate-detection hash. Pure — no I/O.
 */
import type { DateFormat, TextEncodingName } from './types'

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12
}

function iso(y: number, m: number, d: number): string | null {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2200)) return null
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

const year4 = (y: string): number => (y.length === 2 ? 2000 + Number(y) : Number(y))

/**
 * Parse a statement date cell to ISO. 'auto' prefers day-first for ambiguous numeric dates (the
 * Indian convention) — pass 'MM/DD/YYYY' for US-style exports. Time-of-day suffixes are ignored.
 */
export function parseBankDate(cell: string, format: DateFormat = 'auto'): string | null {
  const t = cell.trim().replace(/^"|"$/g, '').replace(/\s+\d{1,2}:\d{2}(:\d{2})?(\s*[AP]M)?$/i, '').replace(/T\d{2}:\d{2}.*$/, '').trim()
  if (!t) return null
  let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/)
  if (m) return format === 'auto' || format === 'YYYY-MM-DD' ? iso(Number(m[1]), Number(m[2]), Number(m[3])) : null
  m = t.match(/^(\d{1,2})[-/. ]+([A-Za-z]{3,9})[-/., ]+(\d{2}|\d{4})$/)
  if (m) {
    const mon = MONTHS[m[2]!.toLowerCase()] ?? MONTHS[m[2]!.slice(0, 3).toLowerCase()]
    return mon ? iso(year4(m[3]!), mon, Number(m[1])) : null
  }
  // Aug 15, 2026
  m = t.match(/^([A-Za-z]{3,9})[ .-]+(\d{1,2}),?[ .-]+(\d{4})$/)
  if (m) {
    const mon = MONTHS[m[1]!.toLowerCase()] ?? MONTHS[m[1]!.slice(0, 3).toLowerCase()]
    return mon ? iso(Number(m[3]), mon, Number(m[2])) : null
  }
  m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/)
  if (m) {
    const a = Number(m[1])
    const b = Number(m[2])
    const y = year4(m[3]!)
    if (format === 'MM/DD/YYYY') return iso(y, a, b)
    return iso(y, b, a)
  }
  // Compact DDMMYYYY / YYYYMMDD (8 digits) — only when a format says which.
  m = t.match(/^(\d{8})$/)
  if (m) {
    const s = m[1]!
    if (format === 'YYYY-MM-DD') return iso(Number(s.slice(0, 4)), Number(s.slice(4, 6)), Number(s.slice(6)))
    if (format === 'DD/MM/YYYY') return iso(Number(s.slice(4)), Number(s.slice(2, 4)), Number(s.slice(0, 2)))
  }
  return null
}

export interface ParsedAmount {
  /** Signed paise as written (a Dr/Cr marker does NOT flip the sign — see `flag`). */
  paise: number
  flag: 'dr' | 'cr' | null
}

/**
 * Parse a money cell: '₹1,23,456.78', 'Rs. 500', 'INR 1,000.00', '1,000.00 Cr', 'Dr 250',
 * '(1,234.50)', '1234.50-', '-0.75'. Returns null for blanks, '-', '--', 'nil'.
 * `decimalComma` handles European '1.234,56' (MT940 uses ',' as the decimal mark).
 */
export function parseBankAmount(cell: string, decimalComma = false): ParsedAmount | null {
  let t = cell.trim().replace(/^"|"$/g, '')
  if (!t || /^(-+|nil|n\/a|na)$/i.test(t)) return null
  let flag: 'dr' | 'cr' | null = null
  const fm = t.match(/(^|\s|\d|\))(dr|cr|db|d|c)\.?$/i) ?? null
  if (fm && /\d/.test(t)) {
    const f = fm[2]!.toLowerCase()
    flag = f === 'cr' || f === 'c' ? 'cr' : 'dr'
    t = t.slice(0, t.length - fm[0].length + fm[1]!.length)
  }
  const pm = t.match(/^(dr|cr)\.?\s+/i)
  if (pm) {
    flag = pm[1]!.toLowerCase() === 'cr' ? 'cr' : 'dr'
    t = t.slice(pm[0].length)
  }
  let negative = false
  t = t.replace(/₹|rs\.?|inr/gi, '').replace(/\s+/g, '')
  if (/^\(.*\)$/.test(t)) {
    negative = true
    t = t.slice(1, -1)
  }
  if (t.endsWith('-')) {
    negative = !negative
    t = t.slice(0, -1)
  }
  if (t.startsWith('-')) {
    negative = !negative
    t = t.slice(1)
  } else if (t.startsWith('+')) t = t.slice(1)
  if (decimalComma) t = t.replace(/\./g, '').replace(',', '.')
  else t = t.replace(/,/g, '')
  t = t.replace(/\.$/, '') // MT940 allows '1234,' (no decimals after the mark)
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(t)) return null
  // Integer paise without float error: split on the decimal point.
  const [whole, frac = ''] = t.split('.')
  const paise = Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2)) + (Number(frac[2] ?? '0') >= 5 ? 1 : 0)
  return { paise: negative ? -paise : paise, flag }
}

/** Collapse whitespace and upper-case — the narration form duplicate detection hashes. */
export function normaliseNarration(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toUpperCase()
}

/** FNV-1a over UTF-16 code units, two independent 32-bit lanes → 16 hex chars. Pure, stable. */
export function stableHash(s: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193 ^ 0x9e3779b9
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0
    h2 ^= h2 >>> 15
  }
  return h1.toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')
}

/**
 * Duplicate-detection keys for a statement (WP 4.1): hash of (date, signed amount, normalised
 * narration, occurrence). The occurrence counter (1st, 2nd … identical line on the same day)
 * keeps two genuine identical charges apart while making a re-import — or an overlapping
 * statement that covers the same day in full — produce the same keys, which the
 * `bank_statement_lines (bank_ledger_id, import_hash)` unique index then rejects.
 */
export function importHashes(lines: { date: string; deposit: number; withdrawal: number; description: string }[]): string[] {
  const seen = new Map<string, number>()
  return lines.map((l) => {
    const base = `${l.date}|${l.deposit - l.withdrawal}|${normaliseNarration(l.description)}`
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return stableHash(`${base}|${n}`)
  })
}

const CP1252_HIGH: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6,
  0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c,
  0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a,
  0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178
}

/** Decode file bytes. A BOM wins over the requested encoding (UTF-8 / UTF-16LE / UTF-16BE). */
export function decodeBytes(bytes: Uint8Array, encoding: TextEncodingName = 'utf-8'): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3))
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = new Uint8Array(bytes.length - 2)
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      swapped[i - 2] = bytes[i + 1]!
      swapped[i - 1] = bytes[i]!
    }
    return new TextDecoder('utf-16le').decode(swapped)
  }
  if (encoding === 'utf-16le') return new TextDecoder('utf-16le').decode(bytes)
  if (encoding === 'windows-1252') {
    let s = ''
    for (const b of bytes) s += String.fromCharCode(CP1252_HIGH[b] ?? b)
    return s
  }
  return new TextDecoder('utf-8').decode(bytes)
}

/** Base64 → bytes without Buffer (renderer-safe). */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
