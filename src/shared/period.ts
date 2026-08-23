/**
 * Report period granularity — the bucket size for columnar reports (ledger statement,
 * sales/purchase registers).
 *
 * Every bucket is anchored to the Indian financial year (1 April - 31 March), so a "quarter"
 * here is a *statutory* quarter (Q1 = Apr-Jun), not a calendar one. That is what QRMP filers,
 * TDS returns and every Indian accountant mean by Q1, and it is the same convention
 * `tdsQuarterOf` in ./tds.ts uses — that function now derives from these helpers so the two
 * can never drift apart.
 *
 * Bucket keys are opaque strings chosen so that plain lexicographic sort is chronological:
 *   month    '2026-04'    Apr 2026
 *   quarter  '2026-Q1'    Apr-Jun 2026        (Q4 '2026-Q4' is Jan-Mar 2027)
 *   half     '2026-H1'    Apr-Sep 2026
 *   year     '2026-FY'    Apr 2026 - Mar 2027
 * The number before the marker is always the calendar year the financial year *started* in.
 */

import { fyOf, fyFromStartYear } from './dates'

export const PERIODS = ['month', 'quarter', 'half', 'year'] as const
export type Period = (typeof PERIODS)[number]

/** Guard for values arriving from IPC/localStorage. */
export function isPeriod(v: unknown): v is Period {
  return typeof v === 'string' && (PERIODS as readonly string[]).includes(v)
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Enumerating a range is bounded so a corrupt or hostile date pair can never spin the main
 * process. 1200 months is a century of books — the same cap the monthly-only predecessor used.
 */
const MAX_BUCKETS = 1200

/** Which bucket does this date fall in, at the given granularity? */
export function periodKey(dateISO: string, period: Period): string {
  if (period === 'month') return dateISO.slice(0, 7)

  const startYear = fyOf(dateISO).startYear
  if (period === 'year') return `${startYear}-FY`

  // Months since the start of the financial year: April = 0 ... March = 11.
  const month = Number(dateISO.slice(5, 7))
  const sinceApril = (month - 4 + 12) % 12
  if (period === 'half') return `${startYear}-H${Math.floor(sinceApril / 6) + 1}`
  return `${startYear}-Q${Math.floor(sinceApril / 3) + 1}`
}

/**
 * Every bucket key from `from` to `to` inclusive, in chronological order — including buckets
 * with no activity, which is what lets a columnar report carry a closing balance across a
 * quiet quarter. A `to` before `from` yields just the `from` bucket rather than throwing;
 * callers are UI date pickers where a transiently inverted range is normal.
 */
export function periodRange(from: string, to: string, period: Period): string[] {
  const endKey = periodKey(to, period)
  const keys: string[] = []
  let cursor = from

  for (;;) {
    const key = periodKey(cursor, period)
    keys.push(key)
    if (key === endKey || key > endKey || keys.length >= MAX_BUCKETS) break
    cursor = advance(cursor, period)
  }
  return keys
}

/** First day of the bucket after the one containing `dateISO`. */
function advance(dateISO: string, period: Period): string {
  const y = Number(dateISO.slice(0, 4))
  const m = Number(dateISO.slice(5, 7))
  const step = period === 'month' ? 1 : period === 'quarter' ? 3 : period === 'half' ? 6 : 12

  // Snap to the start of the current bucket first, so stepping is stable regardless of which
  // day within the bucket we started on.
  const sinceApril = period === 'month' ? 0 : (m - 4 + 12) % 12
  const bucketStartMonth = m - (sinceApril % step)

  const total = y * 12 + (bucketStartMonth - 1) + step
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-01`
}

/** Human-facing column header for a bucket key. */
export function periodLabel(key: string, period: Period): string {
  if (period === 'month') {
    const [y, m] = key.split('-')
    return `${MONTH_NAMES[Number(m) - 1]} ${y}`
  }
  const [startYear, marker] = key.split('-')
  const fy = fyFromStartYear(Number(startYear))
  return period === 'year' ? `FY${fy.label}` : `${marker} FY${fy.label}`
}

/** Inclusive ISO date bounds of a bucket key — used for drill-down and export headers. */
export function periodBounds(key: string, period: Period): { from: string; to: string } {
  if (period === 'month') {
    const [y, m] = key.split('-').map(Number) as [number, number]
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
    return { from: `${key}-01`, to: `${key}-${String(last).padStart(2, '0')}` }
  }
  const startYear = Number(key.slice(0, 4))
  const fy = fyFromStartYear(startYear)
  if (period === 'year') return { from: fy.from, to: fy.to }

  const n = Number(key.slice(-1))
  const span = period === 'half' ? 6 : 3
  const firstMonth = 4 + (n - 1) * span
  const from = monthStart(startYear, firstMonth)
  const to = monthStart(startYear, firstMonth + span)
  return { from, to: prevDay(to) }
}

function monthStart(fyStartYear: number, monthFromApril: number): string {
  const total = fyStartYear * 12 + (monthFromApril - 1)
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-01`
}

function prevDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}
