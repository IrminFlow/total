/**
 * WP 4.2 — collection measures. Pure; services/receivables.ts feeds the monthly figures.
 *
 * Definitions (documented in the Collections tab's Options → About):
 *  - DSO (days sales outstanding), period method: closing receivables ÷ credit sales in the month
 *    × days in the month. No sales in a month → null (undefined, not infinite).
 *  - Collection efficiency ("received ÷ due", the collection effectiveness index):
 *        (opening + sales − closing) ÷ (opening + sales − closing not yet due)
 *    The numerator is what was collected (or otherwise settled) in the month; the denominator is
 *    what could have been collected — everything that was due. 1 = every due rupee came in.
 *    Nothing due → null.
 */

export interface CollectionMonthInput {
  /** 'YYYY-MM' */
  month: string
  /** Receivables at the start of the month (paise, debtors' net debit balances). */
  opening: number
  /** Credit sales in the month (invoice totals with tax, + debit notes − credit notes). */
  sales: number
  /** Receivables at month end. */
  closing: number
  /** Part of `closing` not yet due at month end. */
  closingNotDue: number
}

export interface CollectionMonth extends CollectionMonthInput {
  collected: number
  due: number
  /** Days, one decimal; null when there were no sales. */
  dso: number | null
  /** 0..1+ (four decimals); null when nothing was due. */
  efficiency: number | null
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

export function dso(closing: number, sales: number, days: number): number | null {
  if (sales <= 0) return null
  return Math.round((Math.max(0, closing) / sales) * days * 10) / 10
}

export function collectionMonth(i: CollectionMonthInput): CollectionMonth {
  const collected = i.opening + i.sales - i.closing
  const due = i.opening + i.sales - i.closingNotDue
  return {
    ...i,
    collected,
    due,
    dso: dso(i.closing, i.sales, daysInMonth(i.month)),
    efficiency: due > 0 ? Math.round((collected / due) * 10_000) / 10_000 : null
  }
}

/** Months from `from` to `to` inclusive ('YYYY-MM'). */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = []
  let [y, m] = from.slice(0, 7).split('-').map(Number) as [number, number]
  const end = to.slice(0, 7)
  for (let guard = 0; guard < 240; guard++) {
    const ym = `${y}-${String(m).padStart(2, '0')}`
    if (ym > end) break
    out.push(ym)
    m += 1
    if (m === 13) {
      m = 1
      y += 1
    }
  }
  return out
}

export function monthStartIso(month: string): string {
  return `${month}-01`
}

export function monthEndIso(month: string): string {
  return `${month}-${String(daysInMonth(month)).padStart(2, '0')}`
}

/** Party-level DSO over a trailing window: outstanding ÷ sales in the window × window days. */
export function partyDso(outstanding: number, salesInWindow: number, windowDays: number): number | null {
  return dso(outstanding, salesInWindow, windowDays)
}
