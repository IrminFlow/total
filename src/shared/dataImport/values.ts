/**
 * Cell-text parsers for the import wizard (WP 6.3). Every parser takes the cell's TEXT (an XLSX
 * cell goes through @shared/xlsx cellText first: dates arrive as ISO, numbers without float
 * noise) and returns `{ ok: value } | { error }` — never throws. Money is integer paise and
 * quantities integer thousandths, parsed from the decimal string (no float arithmetic).
 */
import { parseRupees } from '../money'
import { GST_STATES } from '../gst/states'
import { validateGstin, validateHsn } from '../gst/validate'
import { isValidISODate } from '../dates'

export type Parsed<T> = { ok: T } | { error: string }
export type DateOrder = 'dmy' | 'mdy' | 'ymd'

const ok = <T>(v: T): Parsed<T> => ({ ok: v })
const err = <T>(e: string): Parsed<T> => ({ error: e })

/** Strip ₹/Rs/INR, spaces, Indian or western grouping; "(1,234.50)" → negative. */
function cleanAmount(raw: string): string {
  let s = raw.trim().replace(/^(rs\.?|inr|₹)\s*/i, '').replace(/\s*(rs\.?|inr|₹)$/i, '')
  let neg = false
  const paren = /^\((.*)\)$/.exec(s)
  if (paren) {
    neg = true
    s = paren[1]!
  }
  s = s.replace(/[,\s₹]/g, '')
  if (s.endsWith('-')) {
    neg = !neg
    s = s.slice(0, -1)
  }
  return (neg ? '-' : '') + s.replace(/^\+/, '')
}

/** Decimal string → integer of `scale` decimals, exactly (rounding half away from zero beyond). */
export function decimalToScaled(raw: string, scale: number): number | null {
  const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(raw)
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) return null
  const whole = m[2] === '' ? 0 : Number(m[2])
  const frac = (m[3] ?? '').padEnd(scale + 1, '0')
  let units = whole * 10 ** scale + Number(frac.slice(0, scale) || '0')
  if (Number(frac[scale] ?? '0') >= 5) units += 1
  if (!Number.isSafeInteger(units)) return null
  return m[1] ? -units : units
}

/**
 * A European-style number ("1.234,56", "12,5", "2,50"): a comma followed by only 1–2 digits at the
 * end, or a dot used before a final comma. Indian and western grouping never end like that, so the
 * value is refused rather than misread (12,5 would otherwise become 125). The wizard's "decimal
 * comma" option converts such cells first (normalizeDecimalComma).
 */
export function decimalCommaLike(t: string): boolean {
  const s = t.trim().replace(/^[(+-]|[)-]$/g, '').replace(/^(rs\.?|inr|₹)\s*/i, '')
  if (/^\d{1,3}(\.\d{3})+,\d+$/.test(s)) return true
  return /^\d+,\d{1,2}$/.test(s) || /^[\d.]*\d,\d{1,2}$/.test(s) && s.includes('.')
}
const DECIMAL_COMMA_ERROR = (raw: string): string => `"${raw}" looks like a decimal comma — choose "Numbers use a decimal comma" in the options`

/** "1.234,56" → "1234.56" for a numeric cell written with a decimal comma (dates and text untouched). */
export function normalizeDecimalComma(cell: string): string {
  const t = cell.trim()
  if (!/^[(+-]?(rs\.?\s*|inr\s*|₹\s*)?[\d.\s]*\d(,\d+)?[)-]?$/i.test(t) || !t.includes(',')) return cell
  return t.replace(/[.\s](?=\d{3}\b)/g, '').replace(',', '.')
}

/** "1,23,456.78" / "₹ 500" / "(500)" / "500-" → paise. Empty → null (no value). */
export function parseMoney(raw: string): Parsed<number | null> {
  const t = raw.trim()
  if (t === '' || t === '-' || t === '–') return ok(null)
  if (decimalCommaLike(t)) return err(DECIMAL_COMMA_ERROR(raw))
  const s = cleanAmount(t)
  // Excel can hand back "1234.5000000001" from a formula; parseRupees wants ≤ 2 decimals, so
  // round through the exact decimal path instead.
  const exact = parseRupees(s)
  if (exact !== null) return ok(exact)
  const scaled = decimalToScaled(s, 2)
  return scaled === null ? err(`"${raw}" is not an amount`) : ok(scaled)
}

/** Amount with an optional Dr/Cr suffix or prefix ("15,000.00 Dr", "Cr 500"); signed result,
 *  Dr positive. A bare negative number is Cr (Total's dr-positive convention). */
export function parseSignedMoney(raw: string, drCrCell?: string): Parsed<number | null> {
  let t = raw.trim()
  let side: 'dr' | 'cr' | null = null
  const m = /^(?:(dr|cr)\.?\s+)?(.*?)(?:\s*(dr|cr)\.?)?$/i.exec(t)
  if (m) {
    side = ((m[1] ?? m[3])?.toLowerCase() as 'dr' | 'cr' | undefined) ?? null
    t = m[2]!
  }
  const amt = parseMoney(t)
  if ('error' in amt || amt.ok === null) return amt
  const sideCell = drCrCell !== undefined ? parseDrCr(drCrCell) : ok(null)
  if ('error' in sideCell) return sideCell
  const s = side ?? sideCell.ok
  if (s === 'dr') return ok(Math.abs(amt.ok))
  if (s === 'cr') return ok(-Math.abs(amt.ok))
  return amt
}

/** "Dr", "Debit", "D", "By" → dr; "Cr", "Credit", "C", "To" → cr; "" → null. */
export function parseDrCr(raw: string): Parsed<'dr' | 'cr' | null> {
  const t = raw.trim().toLowerCase().replace(/\.$/, '')
  if (t === '') return ok(null)
  if (['dr', 'd', 'debit', 'by', 'debit (dr)'].includes(t)) return ok('dr')
  if (['cr', 'c', 'credit', 'to', 'credit (cr)'].includes(t)) return ok('cr')
  return err(`"${raw}" is not Dr or Cr`)
}

/** Decimal quantity (optionally followed by a unit, "2.500 Kg") → thousandths. */
export function parseQty(raw: string): Parsed<number | null> {
  const t = raw.trim()
  if (t === '') return ok(null)
  if (decimalCommaLike(t.replace(/\s*[A-Za-z.]*$/, ''))) return err(DECIMAL_COMMA_ERROR(raw))
  const m = /^(-?[\d,]*\.?\d+)\s*[A-Za-z.]*$/.exec(t)
  if (!m) return err(`"${raw}" is not a quantity`)
  const v = decimalToScaled(m[1]!.replace(/,/g, ''), 3)
  return v === null ? err(`"${raw}" is not a quantity`) : ok(v)
}

export function parsePercent(raw: string, max = 100): Parsed<number | null> {
  const t = raw.trim().replace(/%$/, '').trim()
  if (t === '') return ok(null)
  const n = Number(t)
  if (!Number.isFinite(n) || n < 0 || n > max) return err(`"${raw}" is not a rate between 0 and ${max}`)
  return ok(Math.round(n * 1000) / 1000)
}

export function parseInt0(raw: string, max = 1e9): Parsed<number | null> {
  const t = raw.trim().replace(/,/g, '')
  if (t === '') return ok(null)
  if (!/^\d+(\.0+)?$/.test(t) || Number(t) > max) return err(`"${raw}" is not a whole number`)
  return ok(Math.round(Number(t)))
}

export function parseBool(raw: string): Parsed<boolean | null> {
  const t = raw.trim().toLowerCase()
  if (t === '') return ok(null)
  if (['yes', 'y', 'true', '1', 'on'].includes(t)) return ok(true)
  if (['no', 'n', 'false', '0', 'off'].includes(t)) return ok(false)
  return err(`"${raw}" is not Yes or No`)
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12
}

function iso(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000
  const s = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  return isValidISODate(s) ? s : null
}

/**
 * Dates as they come out of Excel, Busy, Zoho and bank statements: ISO (with or without a time),
 * dd-mm-yyyy / dd/mm/yy / dd.mm.yyyy (or mm/dd with `order: 'mdy'`), 15-Apr-2025, 15 April 2025,
 * Apr 15, 2025, yyyymmdd (Tally), and a bare Excel serial number (a date column read as text).
 */
export function parseDate(raw: string, order: DateOrder = 'dmy'): Parsed<string | null> {
  // Drop a time: "10:30", "10:30:00 pm", or an ISO "T10:30:00(.000)(Z|+05:30)" — never a bare "T"
  // (upper-case month names like "15-OCT-2025" contain one).
  const t = raw.trim().replace(/\s+\d{1,2}:\d{2}(:\d{2})?(\s*[ap]m)?$/i, '').replace(/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i, '')
  if (t === '') return ok(null)
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t)
  if (m) return wrap(iso(+m[1]!, +m[2]!, +m[3]!), raw)
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(t)
  if (m) return wrap(iso(+m[1]!, +m[2]!, +m[3]!), raw)
  m = /^(\d{1,2})[-/. ]([A-Za-z]{3,9})[-/., ]+(\d{2}|\d{4})$/.exec(t)
  if (m) {
    const mon = MONTHS[m[2]!.slice(0, 4).toLowerCase()] ?? MONTHS[m[2]!.slice(0, 3).toLowerCase()]
    return mon ? wrap(iso(+m[3]!, mon, +m[1]!), raw) : err(`"${raw}" is not a date`)
  }
  m = /^([A-Za-z]{3,9})[ -](\d{1,2}),?[ -](\d{4})$/.exec(t)
  if (m) {
    const mon = MONTHS[m[1]!.slice(0, 3).toLowerCase()]
    return mon ? wrap(iso(+m[3]!, mon, +m[2]!), raw) : err(`"${raw}" is not a date`)
  }
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(t)
  if (m) {
    const [a, b, y] = [+m[1]!, +m[2]!, +m[3]!]
    if (order === 'mdy') return wrap(iso(y, a, b), raw)
    return wrap(iso(y, b, a), raw)
  }
  // A serial that lost its date style (5 digits, 1982–2173).
  if (/^\d{5}(\.\d+)?$/.test(t)) {
    const days = Math.floor(Number(t))
    const d = new Date(Date.UTC(1899, 11, 30) + days * 86400000).toISOString().slice(0, 10)
    return ok(d)
  }
  return err(`"${raw}" is not a date`)
}

function wrap(v: string | null, raw: string): Parsed<string | null> {
  return v ? ok(v) : err(`"${raw}" is not a real date`)
}

export function parseGstin(raw: string): Parsed<string | null> {
  const t = raw.trim().toUpperCase().replace(/\s+/g, '')
  if (t === '' || t === 'NA' || t === 'N/A' || t === 'URP' || t === 'UNREGISTERED') return ok(null)
  const v = validateGstin(t)
  return v.valid ? ok(t) : err(`GSTIN "${raw}": ${v.error ?? 'invalid'}`)
}

export function parsePan(raw: string): Parsed<string | null> {
  const t = raw.trim().toUpperCase()
  if (t === '' || t === 'NA' || t === 'N/A') return ok(null)
  return /^[A-Z]{5}\d{4}[A-Z]$/.test(t) ? ok(t) : err(`PAN "${raw}" is not in the AAAAA9999A format`)
}

export function parseHsn(raw: string): Parsed<string | null> {
  const t = raw.trim().replace(/\.0+$/, '')
  if (t === '') return ok(null)
  const v = validateHsn(t)
  return v.valid ? ok(t) : err(`HSN/SAC "${raw}": ${v.error ?? 'invalid'}`)
}

/** ISO 3166-2:IN / vehicle-style abbreviations → GST state codes (Zoho "Place of Supply" uses
 *  these, e.g. "TN"). Both old and new spellings are accepted (OR/OD, UK/UT, TS/TG, CG/CT). */
export const STATE_ABBREVIATIONS: Record<string, string> = {
  JK: '01', HP: '02', PB: '03', CH: '04', UK: '05', UT: '05', HR: '06', DL: '07', RJ: '08', UP: '09', BR: '10',
  SK: '11', AR: '12', NL: '13', MN: '14', MZ: '15', TR: '16', ML: '17', AS: '18', WB: '19', JH: '20', OR: '21',
  OD: '21', CG: '22', CT: '22', MP: '23', GJ: '24', DD: '26', DN: '26', MH: '27', KA: '29', GA: '30', LD: '31',
  KL: '32', TN: '33', PY: '34', AN: '35', TS: '36', TG: '36', AP: '37', LA: '38'
}

/** "27", "Maharashtra", "MH", "27-Maharashtra", "Maharashtra (27)" → "27". */
export function parseState(raw: string): Parsed<string | null> {
  const t = raw.trim()
  if (t === '') return ok(null)
  const code = /^(\d{1,2})\b/.exec(t)?.[1] ?? /\((\d{2})\)$/.exec(t)?.[1]
  if (code && code.padStart(2, '0') in GST_STATES) return ok(code.padStart(2, '0'))
  const abbr = STATE_ABBREVIATIONS[t.toUpperCase()]
  if (abbr) return ok(abbr)
  const name = t.replace(/^\d{1,2}\s*[-–]\s*/, '').replace(/\s*\(\d{2}\)$/, '').toLowerCase().replace(/&/g, 'and').replace(/\s+/g, ' ')
  const hit = Object.entries(GST_STATES).find(([, n]) => n.toLowerCase().replace(/&/g, 'and').replace(/\s+/g, ' ') === name)
  return hit ? ok(hit[0]) : err(`Unknown state "${raw}"`)
}

export function parseText(raw: string, max = 500): Parsed<string | null> {
  const t = raw.trim()
  if (t === '') return ok(null)
  return t.length > max ? err(`Longer than ${max} characters`) : ok(t)
}
