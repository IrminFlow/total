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

export interface FinancialQuarter {
  /** Stable key, e.g. "2025-26-Q1". */
  key: string
  quarter: 1 | 2 | 3 | 4
  from: string
  to: string
  /** Display label, e.g. "Q1 2025-26". */
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

/** Indian financial-year quarter containing `date`: Apr-Jun Q1 through Jan-Mar Q4. */
export function financialQuarterOf(date: string): FinancialQuarter {
  const [, month] = date.split('-').map(Number) as [number, number]
  const fy = fyOf(date)
  const quarter = (month >= 4 ? Math.floor((month - 4) / 3) + 1 : 4) as 1 | 2 | 3 | 4
  const starts: Record<FinancialQuarter['quarter'], [number, number]> = {
    1: [fy.startYear, 4],
    2: [fy.startYear, 7],
    3: [fy.startYear, 10],
    4: [fy.startYear + 1, 1]
  }
  const [year, startMonth] = starts[quarter]
  const end = new Date(Date.UTC(year, startMonth + 2, 0))
  const to = `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, '0')}-${String(end.getUTCDate()).padStart(2, '0')}`
  return {
    key: `${fy.label}-Q${quarter}`,
    quarter,
    from: `${year}-${String(startMonth).padStart(2, '0')}-01`,
    to,
    label: `Q${quarter} ${fy.label}`
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
  if (trimmed === 't' || trimmed === '.' || trimmed === 'today') return context
  if (trimmed === 'y' || trimmed === 'yesterday') {
    const dt = new Date(context + 'T00:00:00Z')
    dt.setUTCDate(dt.getUTCDate() - 1)
    return dt.toISOString().slice(0, 10)
  }
  const weekday = trimmed.match(/^last\s+(sun|mon|tue|wed|thu|fri|sat)(?:day)?$/)
  if (weekday) {
    const names = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
    const target = names.indexOf(weekday[1]!)
    const dt = new Date(context + 'T00:00:00Z')
    const delta = ((dt.getUTCDay() - target + 7) % 7) || 7
    dt.setUTCDate(dt.getUTCDate() - delta)
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

export interface ParsedPeriod { from: string; to: string; label: string }

/** Human period language used by the global period picker and commands. */
export function parsePeriodExpression(input: string, context: string): ParsedPeriod | null {
  const value = input.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!value) return null
  const single = parseSmartDate(value, context)
  if (single) return { from: single, to: single, label: toDisplayDate(single) }
  const month = (date: Date): ParsedPeriod => {
    const prefix = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
    return { from: `${prefix}-01`, to: `${prefix}-${String(last).padStart(2, '0')}`, label: date.toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }) }
  }
  const contextDate = new Date(`${context}T00:00:00Z`)
  if (value === 'this month' || value === 'current month') return month(contextDate)
  if (value === 'last month' || value === 'previous month') {
    const previous = new Date(contextDate)
    previous.setUTCDate(1)
    previous.setUTCMonth(previous.getUTCMonth() - 1)
    return month(previous)
  }
  if (value === 'this fy' || value === 'current fy' || value === 'this financial year') {
    const fy = fyOf(context)
    return { from: fy.from, to: fy.to, label: `FY ${fy.label}` }
  }
  if (value === 'last fy' || value === 'previous fy' || value === 'last financial year') {
    const fy = fyFromStartYear(fyOf(context).startYear - 1)
    return { from: fy.from, to: fy.to, label: `FY ${fy.label}` }
  }
  const quarter = value.match(/^(?:this\s+)?q([1-4])$/)
  if (quarter) {
    const number = Number(quarter[1]) as 1 | 2 | 3 | 4
    const fy = fyOf(context)
    const starts: Record<1 | 2 | 3 | 4, [number, number]> = { 1: [fy.startYear, 4], 2: [fy.startYear, 7], 3: [fy.startYear, 10], 4: [fy.startYear + 1, 1] }
    const [year, startMonth] = starts[number]
    const end = new Date(Date.UTC(year, startMonth + 2, 0))
    return {
      from: `${year}-${String(startMonth).padStart(2, '0')}-01`,
      to: end.toISOString().slice(0, 10),
      label: `Q${number} ${fy.label}`
    }
  }
  return null
}

export function todayISO(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = (now.getMonth() + 1).toString().padStart(2, '0')
  const d = now.getDate().toString().padStart(2, '0')
  return `${y}-${m}-${d}`
}
