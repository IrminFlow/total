/**
 * When input credit stops being claimable.
 *
 * Section 16(4): credit on an invoice cannot be taken after 30 November of the financial year
 * following the one the invoice belongs to, or the date the annual return for that year is
 * filed, whichever is earlier. Miss it and the credit is gone — not deferred, gone — and it is
 * one of the few GST mistakes with no remedy at all.
 *
 * The app had nothing to say about it. A purchase from two years ago sat in the books looking
 * exactly like one from last month.
 *
 * The deadline computed here is the 30 November limb only. The annual-return limb depends on when
 * the business actually filed GSTR-9, which the filing register knows and this module deliberately
 * does not: a pure function that silently used one limb while the other had already closed would
 * report a comfortable margin on credit that was already lost. Callers that know the GSTR-9 date
 * pass it in.
 */

/** 30 November of the year after the FY closes. */
export function itcDeadline(fyStartYear: number): string {
  return `${fyStartYear + 1}-11-30`
}

/** FY start year a date belongs to. April starts the year. */
export function fyStartYearOf(dateISO: string): number {
  const [y, m] = dateISO.split('-').map(Number) as [number, number]
  return m >= 4 ? y : y - 1
}

export interface ItcRiskInput {
  /** Invoice date, ISO. */
  invoiceDate: string
  today: string
  /**
   * Date the annual return (GSTR-9) for the invoice's FY was filed, if it was. The earlier of
   * this and 30 November is the real cut-off.
   */
  annualReturnFiledAt?: string | null
}

export type ItcRiskLevel =
  /** Comfortably inside the window. */
  | 'ok'
  /** Inside the window, but the deadline is close enough to act on. */
  | 'closing'
  /** Past the cut-off. The credit is gone; the row exists so it can be written off knowingly. */
  | 'lapsed'

/** Days before the cut-off at which a row starts reading as urgent. */
export const ITC_WARNING_DAYS = 60

export interface ItcRisk {
  fyStartYear: number
  /** The operative cut-off: the earlier of 30 November and the annual return's filing date. */
  deadline: string
  /** Negative once the deadline has passed. */
  daysRemaining: number
  level: ItcRiskLevel
  /** Which limb of section 16(4) set the deadline, so the UI can say why. */
  limb: 'november' | 'annual-return'
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000)
}

export function itcRisk(input: ItcRiskInput): ItcRisk {
  const fyStartYear = fyStartYearOf(input.invoiceDate)
  const november = itcDeadline(fyStartYear)
  const filed = input.annualReturnFiledAt ?? null

  // "Whichever is earlier" — an annual return filed in August closes the window in August.
  const useAnnual = filed !== null && filed < november
  const deadline = useAnnual ? filed! : november
  const daysRemaining = daysBetween(input.today, deadline)

  return {
    fyStartYear,
    deadline,
    daysRemaining,
    level: daysRemaining < 0 ? 'lapsed' : daysRemaining <= ITC_WARNING_DAYS ? 'closing' : 'ok',
    limb: useAnnual ? 'annual-return' : 'november'
  }
}

/** Ageing buckets by days since the invoice date. Upper bound exclusive; the last is open. */
export const ITC_AGEING_BUCKETS = [
  { id: '0-30', label: '0–30 days', fromDays: 0, toDays: 31 },
  { id: '31-90', label: '31–90 days', fromDays: 31, toDays: 91 },
  { id: '91-180', label: '91–180 days', fromDays: 91, toDays: 181 },
  { id: '181-365', label: '181–365 days', fromDays: 181, toDays: 366 },
  { id: '365+', label: 'Over a year', fromDays: 366, toDays: null }
] as const

export type ItcAgeingBucket = (typeof ITC_AGEING_BUCKETS)[number]['id']

export function itcAgeingBucket(invoiceDate: string, today: string): ItcAgeingBucket {
  // A future-dated invoice ages zero days rather than falling off the front of the list.
  const age = Math.max(0, daysBetween(invoiceDate, today))
  for (const b of ITC_AGEING_BUCKETS) {
    if (age >= b.fromDays && (b.toDays === null || age < b.toDays)) return b.id
  }
  return '365+'
}
