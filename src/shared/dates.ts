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

/** 'YYYY-MM' → 'Apr' (short) or 'Apr 2026' (long) — chart axes and tooltips. */
export function toMonthLabel(ym: string, style: 'short' | 'long' = 'short'): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const [y, m] = ym.split('-').map(Number) as [number, number]
  return style === 'short' ? months[m - 1]! : `${months[m - 1]} ${y}`
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

export function todayISO(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = (now.getMonth() + 1).toString().padStart(2, '0')
  const d = now.getDate().toString().padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Printed-document date formats (print templates). 'dd-mmm-yy' is toDisplayDate's Tally style. */
export const DOC_DATE_FORMATS = ['dd-mmm-yy', 'dd-mmm-yyyy', 'dd/mm/yyyy', 'dd-mm-yyyy', 'd mmmm yyyy', 'yyyy-mm-dd'] as const
export type DocDateFormat = (typeof DOC_DATE_FORMATS)[number]

/** Format an ISO date (YYYY-MM-DD) in one of the DocDateFormat shapes. */
export function formatDateAs(date: string, format: DocDateFormat): string {
  if (format === 'dd-mmm-yy') return toDisplayDate(date)
  if (format === 'yyyy-mm-dd') return date
  const [y, m, d] = date.split('-') as [string, string, string]
  const short = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const long = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const mi = Number(m) - 1
  switch (format) {
    case 'dd-mmm-yyyy':
      return `${d}-${short[mi]}-${y}`
    case 'dd/mm/yyyy':
      return `${d}/${m}/${y}`
    case 'dd-mm-yyyy':
      return `${d}-${m}-${y}`
    default:
      return `${Number(d)} ${long[mi]} ${y}`
  }
}

// ---------- plain-language dates (WP 5.3 drafting) ----------

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

/** ISO date `days` days after `date` (negative = before). */
export function addDaysISO(date: string, days: number): string {
  const dt = new Date(date + 'T00:00:00Z')
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

function lastDayOfMonthISO(y: number, m: number): string {
  const d = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function monthIndexOf(word: string): number | null {
  const w = word.toLowerCase().replace(/\.$/, '')
  if (w.length < 3) return null
  const i = MONTH_NAMES.findIndex((m) => m.startsWith(w) || (w === 'sept' && m === 'september'))
  return i >= 0 ? i + 1 : null
}

/**
 * Resolve a date the way a person says it, against the working date `context` — never the AI
 * model's idea of today (WP 5.3). Returns the ISO date and how it was read, or null. Reads:
 *   ISO "2025-07-31", and everything the date field reads (parseSmartDate: "7", "7/4", "07-04-2025");
 *   "today", "yesterday", "tomorrow", "day before yesterday", "3 days ago", "2 weeks ago";
 *   "friday" — the most recent Friday on or before the working date; "last friday" — the most
 *   recent one strictly before it; "this friday" — the coming one (the working date if it is a
 *   Friday); "next friday" — the coming one strictly after;
 *   "15 aug", "15th of August", "Aug 15" (no year: within the working date's financial year, the
 *   date field's "7/4" rule), "15 aug 2025";
 *   "start of the month", "end of last month", "start of last month", "end of this month".
 */
export function resolveDateText(input: string, context: string): { date: string; how: string } | null {
  const t = input.trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ').replace(/^on /, '').trim()
  if (t === '') return null
  if (isValidISODate(t)) return { date: t, how: 'as given' }
  if (t === 'today' || t === 'now') return { date: context, how: 'today (the working date)' }
  if (t === 'yesterday') return { date: addDaysISO(context, -1), how: 'the day before the working date' }
  if (t === 'tomorrow') return { date: addDaysISO(context, 1), how: 'the day after the working date' }
  if (t === 'day before yesterday') return { date: addDaysISO(context, -2), how: 'two days before the working date' }
  let m = /^(\d{1,3}) (day|days|week|weeks) ago$/.exec(t)
  if (m) {
    const n = Number(m[1]) * (m[2]!.startsWith('week') ? 7 : 1)
    return { date: addDaysISO(context, -n), how: `${n} day${n === 1 ? '' : 's'} before the working date` }
  }
  m = /^(last |this |previous |next )?(sun|mon|tue|wed|thu|fri|sat)[a-z]*$/.exec(t)
  if (m && WEEKDAYS.some((d) => d.toLowerCase().startsWith(t.replace(/^(last |this |previous |next )/, '')))) {
    const target = WEEKDAYS.findIndex((d) => d.toLowerCase().startsWith(m![2]!))
    const today = new Date(context + 'T00:00:00Z').getUTCDay()
    // "this friday" / "next friday": the coming one (today when it is that day for "this").
    if (m[1] === 'this ' || m[1] === 'next ') {
      let ahead = (target - today + 7) % 7
      if (ahead === 0 && m[1] === 'next ') ahead = 7
      return { date: addDaysISO(context, ahead), how: ahead === 0 ? 'the working date' : `the coming ${WEEKDAYS[target]} after the working date` }
    }
    let back = (today - target + 7) % 7
    if (back === 0 && (m[1] === 'last ' || m[1] === 'previous ')) back = 7
    return { date: addDaysISO(context, -back), how: back === 0 ? 'the working date' : `the ${WEEKDAYS[target]} before the working date` }
  }
  const [cy, cm] = context.split('-').map(Number) as [number, number]
  m = /^(start|beginning|first day|first|end|last day) of (the |this |last |previous )?month$/.exec(t)
  if (m) {
    const prev = m[2] === 'last ' || m[2] === 'previous '
    const y = prev && cm === 1 ? cy - 1 : cy
    const mo = prev ? (cm === 1 ? 12 : cm - 1) : cm
    const start = /^(start|beginning|first day|first)$/.test(m[1]!)
    const date = start ? `${y}-${String(mo).padStart(2, '0')}-01` : lastDayOfMonthISO(y, mo)
    return { date, how: `the ${start ? 'first' : 'last'} day of ${prev ? 'the month before the working date' : 'the working month'}` }
  }
  let day: number | null = null
  let month: number | null = null
  let year: number | null = null
  m = /^(\d{1,2})(?:st|nd|rd|th)? (?:of )?([a-z]+\.?)(?: (\d{2}|\d{4}))?$/.exec(t)
  if (m) {
    day = Number(m[1])
    month = monthIndexOf(m[2]!)
    year = m[3] ? Number(m[3]) : null
  } else {
    const n = /^([a-z]+\.?) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{2}|\d{4}))?$/.exec(t)
    if (n) {
      month = monthIndexOf(n[1]!)
      day = Number(n[2])
      year = n[3] ? Number(n[3]) : null
    }
  }
  if (day != null && month != null) {
    const fy = fyOf(context)
    const y = year != null ? (year < 100 ? 2000 + year : year) : month >= 4 ? fy.startYear : fy.startYear + 1
    const date = `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    if (!isValidISODate(date)) return null
    return { date, how: year != null ? 'as given' : `in FY ${fy.label}, the working date's financial year` }
  }
  const smart = parseSmartDate(t, context)
  if (smart) return { date: smart, how: 'read as the date field reads it' }
  return null
}
