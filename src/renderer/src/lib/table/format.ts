// Kind-aware formatting and input parsing for table cells. Money goes through @shared/money and
// dates through @shared/dates ONLY; quantities use integer string math (never a float divide).
import { formatPaise, parseRupees } from '@shared/money'
import { isValidISODate, parseSmartDate, toDisplayDate } from '@shared/dates'
import type { Align, CellValue, ColumnDef, ColumnKind } from './types'

/** Integer thousandths → "1,234.500" style (Indian grouping off — quantities read plainly).
 *  Rounds half away from zero to `decimals` (0–3) with integer arithmetic only. */
export function formatMilli(milli: number, decimals = 3): string {
  const d = Math.max(0, Math.min(3, Math.trunc(decimals)))
  const negative = milli < 0
  let abs = Math.abs(Math.trunc(milli))
  const drop = 10 ** (3 - d) // 1, 10, 100 or 1000
  if (drop > 1) abs = Math.floor((abs + drop / 2) / drop) // round half away from zero
  const scale = 10 ** d
  const whole = Math.floor(abs / scale)
  const frac = d > 0 ? '.' + (abs % scale).toString().padStart(d, '0') : ''
  return `${negative && abs !== 0 ? '-' : ''}${whole}${frac}`
}

/** "12.5" → 12500 milli. Integer string math; up to 3 decimals; commas/spaces ignored. */
export function parseMilli(input: string): number | null {
  const cleaned = input.replace(/[,\s]/g, '')
  if (!/^-?\d*(\.\d{0,3})?$/.test(cleaned) || cleaned === '' || cleaned === '-' || cleaned === '.' || cleaned === '-.')
    return null
  const negative = cleaned.startsWith('-')
  const [wholeRaw = '', fracRaw = ''] = cleaned.replace('-', '').split('.')
  const whole = wholeRaw === '' ? 0 : parseInt(wholeRaw, 10)
  const frac = fracRaw === '' ? 0 : parseInt(fracRaw.padEnd(3, '0'), 10)
  const milli = whole * 1000 + frac
  if (!Number.isSafeInteger(milli)) return null
  return negative ? -milli : milli
}

/** Plain number input ("1,200" / "-3.5") for `number` columns. */
export function parseNumber(input: string): number | null {
  const cleaned = input.replace(/[,\s]/g, '')
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null
  return Number(cleaned)
}

/** Parses a filter operand typed by the user into the column kind's raw value. */
export function parseFilterValue(kind: ColumnKind, input: string, dateContext: string): number | string | null {
  switch (kind) {
    case 'money':
      return parseRupees(input)
    case 'quantity':
      return parseMilli(input)
    case 'number':
      return parseNumber(input)
    case 'date': {
      const t = input.trim()
      if (isValidISODate(t)) return t
      return parseSmartDate(t, dateContext)
    }
    default:
      return input
  }
}

/** Raw value → display text for a filter chip / input prefill. */
export function formatRaw(kind: ColumnKind, v: CellValue, opts: { signed?: boolean; decimals?: number; plainZero?: boolean } = {}): string {
  if (v === null || v === undefined || v === '') return ''
  switch (kind) {
    case 'money': {
      const n = Number(v)
      if (opts.signed) return n === 0 ? '–' : `${formatPaise(Math.abs(n))} ${n > 0 ? 'Dr' : 'Cr'}`
      return formatPaise(n, { zeroDash: !opts.plainZero })
    }
    case 'quantity':
      return formatMilli(Number(v), opts.decimals ?? 3)
    case 'date':
      return typeof v === 'string' && isValidISODate(v) ? toDisplayDate(v) : String(v)
    case 'number':
      return String(v)
    default:
      return String(v)
  }
}

export function defaultAlign(kind: ColumnKind): Align {
  return kind === 'money' || kind === 'quantity' || kind === 'number' ? 'right' : 'left'
}

export function columnAlign<Row>(col: ColumnDef<Row>): Align {
  return col.align ?? defaultAlign(col.kind)
}

/** The display/export text of one cell. */
export function cellText<Row>(col: ColumnDef<Row>, row: Row): string {
  if (col.text) return col.text(row)
  const v = col.value(row)
  if (col.kind === 'enum' && col.options && v != null) {
    const opt = col.options.find((o) => o.value === String(v))
    if (opt) return opt.label
  }
  return formatRaw(col.kind, v, { signed: col.signed, decimals: col.decimals })
}

/** Formats an aggregate (sum/subtotal) value for a column. */
export function aggregateText<Row>(col: ColumnDef<Row>, v: CellValue): string {
  return formatRaw(col.kind, v, { signed: col.signed, decimals: col.decimals })
}
