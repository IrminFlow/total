/**
 * Laying post-dated cheques out on a month grid (#137).
 *
 * The PDC register is a list sorted by date, and a list answers "what is next". It does not
 * answer the question the register is actually consulted for, which is "how much clears in the
 * week of the 15th, and is there enough in the account by then" — that one needs the cheques
 * arranged the way a month is arranged, with the empty days visible, because an empty week is
 * information too.
 *
 * Pure date arithmetic on ISO strings, UTC throughout (see src/shared/dates.ts for why): a grid
 * built in local time puts the 1st in the wrong cell on either side of a DST change.
 */

import { addDays } from './dates'

/** Sunday-first, which is how a wall calendar in India is printed. */
export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/** 'YYYY-MM' → the first of that month, ISO. */
export function monthStart(monthKey: string): string {
  if (!/^\d{4}-\d{2}$/.test(monthKey)) throw new Error(`Not a month: ${monthKey}`)
  return `${monthKey}-01`
}

/** The month a date falls in, as 'YYYY-MM'. */
export function monthOf(dateISO: string): string {
  return dateISO.slice(0, 7)
}

/** Step a month key by `delta` months, wrapping the year. */
export function shiftMonth(monthKey: string, delta: number): string {
  const year = Number(monthKey.slice(0, 4))
  const month = Number(monthKey.slice(5, 7))
  const zero = year * 12 + (month - 1) + delta
  return `${String(Math.floor(zero / 12)).padStart(4, '0')}-${String((zero % 12) + 1).padStart(2, '0')}`
}

/** 'August 2026'. */
export function monthLabel(monthKey: string): string {
  const names = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December']
  return `${names[Number(monthKey.slice(5, 7)) - 1]} ${monthKey.slice(0, 4)}`
}

export interface CalendarCell {
  date: string
  /** False for the leading/trailing days borrowed from the neighbouring months. */
  inMonth: boolean
}

/**
 * The month as weeks of seven days, padded out to whole weeks.
 *
 * The padding days are returned rather than blanked because a cheque dated the 31st of the
 * previous month sitting in the first row is worth seeing — it is late, and a blank cell would
 * hide it.
 */
export function monthGrid(monthKey: string): CalendarCell[][] {
  const first = monthStart(monthKey)
  const firstWeekday = new Date(`${first}T00:00:00Z`).getUTCDay()
  const start = addDays(first, -firstWeekday)

  const weeks: CalendarCell[][] = []
  let cursor = start
  // Six rows always: a five-row month and a six-row month rendering at different heights makes
  // the panel jump as the user pages through, and the sixth row is cheap.
  for (let w = 0; w < 6; w++) {
    const week: CalendarCell[] = []
    for (let d = 0; d < 7; d++) {
      week.push({ date: cursor, inMonth: cursor.startsWith(monthKey) })
      cursor = addDays(cursor, 1)
    }
    weeks.push(week)
  }
  return weeks
}

/** The date a post-dated cheque actually falls due: the instrument date when it has one. */
export function pdcDueDate(row: { date: string; instrumentDate?: string | null }): string {
  return row.instrumentDate ?? row.date
}

export interface DayBucket<T> {
  date: string
  rows: T[]
  /** Paise. Signed by the caller's convention — this only sums what it is given. */
  total: number
}

/** Group rows onto their due dates, with a per-day total. Days with nothing are absent. */
export function bucketByDueDate<T extends { date: string; instrumentDate?: string | null; amount: number }>(
  rows: T[]
): Map<string, DayBucket<T>> {
  const map = new Map<string, DayBucket<T>>()
  for (const row of rows) {
    const key = pdcDueDate(row)
    const bucket = map.get(key) ?? { date: key, rows: [], total: 0 }
    bucket.rows.push(row)
    bucket.total += row.amount
    map.set(key, bucket)
  }
  return map
}

/** Sum of everything falling due inside a month — the figure the account has to cover. */
export function monthTotal<T extends { date: string; instrumentDate?: string | null; amount: number }>(
  rows: T[],
  monthKey: string
): number {
  return rows.filter((r) => pdcDueDate(r).startsWith(monthKey)).reduce((s, r) => s + r.amount, 0)
}
