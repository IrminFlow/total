/**
 * Period arithmetic for the report builder, comparatives and scheduled packs — pure date maths
 * on ISO 'YYYY-MM-DD' strings (Indian financial year, 1 April – 31 March).
 */
import { fyFromStartYear, fyOf, toMonthLabel } from '../dates'
import type { DimensionKey, PeriodRule, RelativePeriod } from './model'

export interface DateRange {
  from: string
  to: string
}

const pad = (n: number): string => String(n).padStart(2, '0')
const ymd = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`
const parts = (iso: string): [number, number, number] => iso.split('-').map(Number) as [number, number, number]
const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate()

export function monthStart(iso: string): string {
  const [y, m] = parts(iso)
  return ymd(y, m, 1)
}

export function monthEnd(iso: string): string {
  const [y, m] = parts(iso)
  return ymd(y, m, daysInMonth(y, m))
}

export function addDays(iso: string, delta: number): string {
  const dt = new Date(iso + 'T00:00:00Z')
  dt.setUTCDate(dt.getUTCDate() + delta)
  return dt.toISOString().slice(0, 10)
}

/** Same day `n` months later (negative = earlier), clamped to the target month's last day. */
export function addMonths(iso: string, n: number): string {
  const [y, m, d] = parts(iso)
  const idx = y * 12 + (m - 1) + n
  const ty = Math.floor(idx / 12)
  const tm = (idx % 12) + 1
  return ymd(ty, tm, Math.min(d, daysInMonth(ty, tm)))
}

const isMonthStart = (iso: string): boolean => iso.endsWith('-01')
const isMonthEnd = (iso: string): boolean => iso === monthEnd(iso)

/** Whole calendar months covered by [from, to] when it starts on a 1st and ends on a month end. */
function wholeMonths(from: string, to: string): number | null {
  if (!isMonthStart(from) || !isMonthEnd(to)) return null
  const [fy, fm] = parts(from)
  const [ty, tm] = parts(to)
  return (ty * 12 + tm) - (fy * 12 + fm) + 1
}

/** FY quarter containing `iso`: Q1 = Apr–Jun … Q4 = Jan–Mar. */
export function fyQuarterOf(iso: string): { fyStartYear: number; q: 1 | 2 | 3 | 4; from: string; to: string } {
  const [y, m] = parts(iso)
  const fyStartYear = m >= 4 ? y : y - 1
  const q = (Math.floor(((m + 8) % 12) / 3) + 1) as 1 | 2 | 3 | 4
  const startMonthIdx = fyStartYear * 12 + 3 + (q - 1) * 3 // months since year 0, April = index 3
  const sy = Math.floor(startMonthIdx / 12)
  const sm = (startMonthIdx % 12) + 1
  const from = ymd(sy, sm, 1)
  return { fyStartYear, q, from, to: monthEnd(addMonths(from, 2)) }
}

/** A relative period as of `today`. */
export function relativePeriod(rule: RelativePeriod, today: string): DateRange {
  switch (rule) {
    case 'thisMonth':
      return { from: monthStart(today), to: monthEnd(today) }
    case 'lastMonth': {
      const prev = addMonths(monthStart(today), -1)
      return { from: prev, to: monthEnd(prev) }
    }
    case 'thisQuarter': {
      const q = fyQuarterOf(today)
      return { from: q.from, to: q.to }
    }
    case 'lastQuarter': {
      const q = fyQuarterOf(addMonths(fyQuarterOf(today).from, -1))
      return { from: q.from, to: q.to }
    }
    case 'fyToDate':
      return { from: fyOf(today).from, to: today }
    case 'lastFy': {
      const fy = fyFromStartYear(fyOf(today).startYear - 1)
      return { from: fy.from, to: fy.to }
    }
  }
}

export const RELATIVE_LABELS: Record<RelativePeriod, string> = {
  thisMonth: 'This month',
  lastMonth: 'Last month',
  thisQuarter: 'This quarter',
  lastQuarter: 'Last quarter',
  fyToDate: 'Financial year to date',
  lastFy: 'Last financial year'
}

/** The concrete range a model's period rule means right now. */
export function resolvePeriod(rule: PeriodRule, working: DateRange, today: string): DateRange {
  if (rule.kind === 'working') return working
  if (rule.kind === 'range') return { from: rule.from, to: rule.to }
  return relativePeriod(rule.rule, today)
}

/**
 * The period of the same length immediately before [from, to]: whole months shift by that many
 * months (Apr–Jun → Jan–Mar; a calendar month → the month before, whatever its length); any other
 * range shifts by its length in days.
 */
export function previousPeriod(from: string, to: string): DateRange {
  const months = wholeMonths(from, to)
  if (months !== null) {
    const pf = addMonths(from, -months)
    return { from: pf, to: monthEnd(addMonths(pf, months - 1)) }
  }
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1
  return { from: addDays(from, -days), to: addDays(from, -1) }
}

/** The same dates one year earlier (month-ends stay month-ends, so 29 Feb ↔ 28 Feb). */
export function previousYear(from: string, to: string): DateRange {
  const shift = (iso: string): string => (isMonthEnd(iso) ? monthEnd(addMonths(iso, -12)) : addMonths(iso, -12))
  return { from: addMonths(from, -12), to: shift(to) }
}

/** How a comparative period maps onto the current one, in months (for re-keying date buckets). */
export function comparativeShiftMonths(kind: 'previousPeriod' | 'previousYear', from: string, to: string): number | null {
  if (kind === 'previousYear') return 12
  return wholeMonths(from, to)
}

// ---------------------------------------------------------------- date-bucket keys

/** Bucket key of a date for a period dimension: 'YYYY-MM', 'YYYY-Qn' (FY start year), FY start
 *  year as a string, or the date itself. Mirrors the SQL the compiler emits. */
export function periodKey(iso: string, dim: DimensionKey): string {
  if (dim === 'month') return iso.slice(0, 7)
  if (dim === 'quarter') {
    const q = fyQuarterOf(iso)
    return `${q.fyStartYear}-Q${q.q}`
  }
  if (dim === 'fy') return String(fyOf(iso).startYear)
  return iso
}

/** Display label of a bucket key. */
export function periodLabel(key: string, dim: DimensionKey): string {
  if (dim === 'month') return /^\d{4}-\d{2}$/.test(key) ? toMonthLabel(key, 'long') : key
  if (dim === 'quarter') {
    const m = /^(\d{4})-Q([1-4])$/.exec(key)
    return m ? `Q${m[2]} ${fyFromStartYear(Number(m[1])).label}` : key
  }
  if (dim === 'fy') return /^\d{4}$/.test(key) ? `FY ${fyFromStartYear(Number(key)).label}` : key
  return key
}

/** First date of a bucket. */
function bucketStart(key: string, dim: DimensionKey): string {
  if (dim === 'month') return `${key}-01`
  if (dim === 'quarter') {
    const m = /^(\d{4})-Q([1-4])$/.exec(key)!
    return addMonths(`${m[1]}-04-01`, (Number(m[2]) - 1) * 3)
  }
  if (dim === 'fy') return `${key}-04-01`
  return key
}

/** Every bucket key from `from` to `to`, in order (capped at 2,000 buckets). */
export function periodKeysBetween(from: string, to: string, dim: DimensionKey): string[] {
  const keys: string[] = []
  let d = from
  while (d <= to && keys.length < 2000) {
    const k = periodKey(d, dim)
    if (keys[keys.length - 1] !== k) keys.push(k)
    if (dim === 'day') d = addDays(d, 1)
    else if (dim === 'month') d = addMonths(monthStart(d), 1)
    else if (dim === 'quarter') d = addMonths(bucketStart(k, dim), 3)
    else d = `${Number(k) + 1}-04-01`
  }
  return keys
}

/** Re-key a bucket `months` months later (comparative alignment: last year's May lines up with
 *  this year's May). Day buckets shift by calendar months too. */
export function shiftPeriodKey(key: string, dim: DimensionKey, months: number): string {
  if (dim === 'day') return addMonths(key, months)
  if (dim === 'fy') return months % 12 === 0 ? String(Number(key) + months / 12) : key
  const shifted = addMonths(bucketStart(key, dim), months)
  return periodKey(shifted, dim)
}

/** Financial-year starts strictly inside (from, to] — where income/expense ledgers restart. */
export function fyStartsWithin(from: string, to: string): string[] {
  const out: string[] = []
  for (let y = fyOf(from).startYear + 1; y <= fyOf(to).startYear && out.length < 50; y++) out.push(`${y}-04-01`)
  return out.filter((d) => d > from && d <= to)
}

export function rangeLabel(r: DateRange): string {
  return `${r.from} → ${r.to}`
}
