/**
 * Pure recurring-voucher scheduling math (task 2.3). No Electron, no DB — `src/main/services/
 * recurring.ts` stores/re-validates templates and calls this to advance `next_due`.
 */

export type RecurringCadence = 'monthly' | 'weekly'

export interface RecurringCadenceOpts {
  /** 1-31, clamped to the target month's last day (31 in April -> 30 Apr, Feb -> 28/29). */
  dayOfMonth?: number
  /** 0 = Sunday .. 6 = Saturday. */
  weekday?: number
}

/** Minimal shape dueTemplates needs — works directly against RecurringTemplate (domain.ts). */
export interface DueLike {
  nextDue: string
  active: boolean
}

function daysInMonth(year: number, month: number): number {
  // Date.UTC's day-0 of `month` (1-based, used directly as the 0-based index of the *next*
  // month) rolls back to the last day of `month` itself — the same trick dates.ts's
  // isValidISODate uses.
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function clampedMonthDate(year: number, month: number, day: number): string {
  const clamped = Math.min(day, daysInMonth(year, month))
  return `${year}-${String(month).padStart(2, '0')}-${String(clamped).padStart(2, '0')}`
}

/**
 * Next occurrence of the given cadence strictly after `afterISO`.
 * - monthly: the next month-anniversary of `dayOfMonth`, clamped to short months (31 -> 30 Apr,
 *   28 Feb / 29 Feb in a leap year).
 * - weekly: the next date whose weekday matches `weekday` (0=Sun..6=Sat).
 */
export function nextDueAfter(cadence: RecurringCadence, opts: RecurringCadenceOpts, afterISO: string): string {
  if (cadence === 'monthly') {
    const dayOfMonth = opts.dayOfMonth
    if (!dayOfMonth) throw new Error('dayOfMonth is required for a monthly cadence')
    const [y, m] = afterISO.split('-').map(Number) as [number, number]
    let year = y
    let month = m
    let candidate = clampedMonthDate(year, month, dayOfMonth)
    if (candidate <= afterISO) {
      month += 1
      if (month > 12) {
        month = 1
        year += 1
      }
      candidate = clampedMonthDate(year, month, dayOfMonth)
    }
    return candidate
  }

  const weekday = opts.weekday
  if (weekday == null) throw new Error('weekday is required for a weekly cadence')
  const dt = new Date(afterISO + 'T00:00:00Z')
  do {
    dt.setUTCDate(dt.getUTCDate() + 1)
  } while (dt.getUTCDay() !== weekday)
  return dt.toISOString().slice(0, 10)
}

/** Active templates whose next_due has arrived (<=  today), earliest due first. */
export function dueTemplates<T extends DueLike>(templates: T[], todayISO: string): T[] {
  return templates
    .filter((t) => t.active && t.nextDue <= todayISO)
    .sort((a, b) => a.nextDue.localeCompare(b.nextDue))
}
