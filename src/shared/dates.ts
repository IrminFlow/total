/**
 * Date helpers. All dates in the engine and database are ISO strings 'YYYY-MM-DD'.
 * Indian financial year runs 1 April – 31 March.
 */

export interface FinancialYear {
  /** Calendar year the FY starts in, e.g. 2025 for FY 2025-26. */
  startYear: number
  from: string
  to: string
  /** Display label, e.g. "2025-26". */
  label: string
}

export function isValidISODate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const [y, m, d] = s.split('-').map(Number) as [number, number, number]
  if (m < 1 || m > 12) return false
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return d >= 1 && d <= daysInMonth
}

export function fyOf(date: string): FinancialYear {
  const [y, m] = date.split('-').map(Number) as [number, number]
  const startYear = m >= 4 ? y : y - 1
  return fyFromStartYear(startYear)
}

export function fyFromStartYear(startYear: number): FinancialYear {
  const endShort = ((startYear + 1) % 100).toString().padStart(2, '0')
  return {
    startYear,
    from: `${startYear}-04-01`,
    to: `${startYear + 1}-03-31`,
    label: `${startYear}-${endShort}`
  }
}

/** GST return period "MMYYYY" (portal format) for a date. */
export function gstPeriodOf(date: string): string {
  const [y, m] = date.split('-') as [string, string]
  return `${m}${y}`
}

/** 'DD-MM-YYYY' — the format the GST portal JSON uses for document dates. */
export function toPortalDate(date: string): string {
  const [y, m, d] = date.split('-') as [string, string, string]
  return `${d}-${m}-${y}`
}

/** 'DD-MMM-YY' for on-screen display (Tally style). */
export function toDisplayDate(date: string): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return `${d.toString().padStart(2, '0')}-${months[m - 1]}-${(y % 100).toString().padStart(2, '0')}`
}

/** 'DD-MMM-YY HH:MM' (24h, local time) for on-screen timestamps — audit trail, backup list.
 *  Takes a Date so both ISO strings (`new Date(iso)`) and epoch ms (`new Date(mtime)`) share it. */
export function toDisplayDateTime(d: Date): string {
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return `${toDisplayDate(iso)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * Tally-style smart date entry, resolved against a context date (usually the last voucher date
 * or today). Accepts:
 *   "7"        -> 7th of the context month
 *   "7/4" or "7-4"      -> 7 April of the context FY
 *   "7/4/25", "07-04-2025" -> exact date (DD/MM/YY[YY])
 *   "y"        -> day before context date
 *   "t"        -> context date itself (today)
 * Returns ISO date or null if unparseable.
 */
export function parseSmartDate(input: string, context: string): string | null {
  const trimmed = input.trim().toLowerCase()
  if (trimmed === '') return null
  if (trimmed === 't' || trimmed === '.') return context
  if (trimmed === 'y') {
    const dt = new Date(context + 'T00:00:00Z')
    dt.setUTCDate(dt.getUTCDate() - 1)
    return dt.toISOString().slice(0, 10)
  }
  const parts = trimmed.split(/[/\-.]/).map((p) => p.trim())
  if (parts.some((p) => !/^\d+$/.test(p))) return null
  const [ctxY, ctxM] = context.split('-').map(Number) as [number, number]
  const nums = parts.map(Number)
  let candidate: string | null = null
  if (nums.length === 1) {
    const d = nums[0]!
    candidate = `${ctxY}-${ctxM.toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}`
  } else if (nums.length === 2) {
    const [d, m] = nums as [number, number]
    // Resolve year within the context financial year: Apr-Dec -> FY start year, Jan-Mar -> FY end year
    const fy = fyOf(context)
    const y = m >= 4 ? fy.startYear : fy.startYear + 1
    candidate = `${y}-${m.toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}`
  } else if (nums.length === 3) {
    const [d, m, yRaw] = nums as [number, number, number]
    const y = yRaw < 100 ? 2000 + yRaw : yRaw
    candidate = `${y}-${m.toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}`
  }
  return candidate && isValidISODate(candidate) ? candidate : null
}

/**
 * `date` shifted by whole days, still as 'YYYY-MM-DD'.
 *
 * Done in UTC rather than local time on purpose: an ISO date in this app is a calendar day with
 * no clock attached, and doing the arithmetic locally makes 30 days land on a different date
 * either side of a DST change.
 */
export function addDays(date: string, days: number): string {
  const dt = new Date(`${date}T00:00:00Z`)
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

/** Whole days from `fromDate` to `toDate`; negative when `toDate` is earlier. */
export function daysBetween(fromDate: string, toDate: string): number {
  return Math.round((Date.parse(toDate) - Date.parse(fromDate)) / 86_400_000)
}

export function todayISO(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = (now.getMonth() + 1).toString().padStart(2, '0')
  const d = now.getDate().toString().padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * `date` shifted by whole calendar months, clamped to the end of the target month.
 *
 * 31 January + 1 month is 28 February (29 in a leap year), not 3 March. JavaScript's own
 * `setUTCMonth` overflows into the next month, which is how "one year from 31 March" quietly
 * becomes 1 April — a day that matters when the number is a statutory deadline.
 */
export function addMonths(date: string, months: number): string {
  const dt = new Date(`${date}T00:00:00Z`)
  const day = dt.getUTCDate()
  dt.setUTCDate(1)
  dt.setUTCMonth(dt.getUTCMonth() + months)
  const lastOfMonth = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate()
  dt.setUTCDate(Math.min(day, lastOfMonth))
  return dt.toISOString().slice(0, 10)
}
