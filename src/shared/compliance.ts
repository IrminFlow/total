/**
 * Compliance calendar — pure date math over the recurring Indian statutory deadlines a small
 * business tracks: GST returns, TDS deposit, PF/ESI contributions, advance tax instalments.
 * No DB, no Electron — `upcomingDeadlines` takes everything it needs as arguments so it can be
 * driven identically from the main-process notifier (services/reports-adjacent) and the renderer
 * (Gateway's GST-countdown tile), both of which already have `today` + `CompanyInfo` in hand.
 */

export type DeadlineKind = 'gst' | 'tds' | 'pf' | 'esi' | 'advance-tax'

export interface Deadline {
  id: string
  form: string
  title: string
  /** ISO 'YYYY-MM-DD'. */
  date: string
  kind: DeadlineKind
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
]

function pad2(n: number): string {
  return n.toString().padStart(2, '0')
}

function ymd(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`
}

function parseISO(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return { y, m, d }
}

function addDays(iso: string, days: number): string {
  const dt = new Date(iso + 'T00:00:00Z')
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

/** Add `delta` calendar months to (y, m), rolling the year over as needed. `m` is 1-indexed. */
function monthAdd(y: number, m: number, delta: number): { y: number; m: number } {
  const idx = y * 12 + (m - 1) + delta
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 }
}

function monthLabel(y: number, m: number): string {
  return `${MONTH_NAMES[m - 1]} ${y}`
}

/**
 * All statutory deadlines falling within `[today, today + horizonDays]` inclusive, sorted by
 * date. GST return deadlines (GSTR-1/GSTR-3B) only apply to `regular` registrations — composition
 * dealers and unregistered businesses don't file them. PF/ESI only appear when `hasPayroll`.
 */
export function upcomingDeadlines(
  today: string,
  gstRegistrationType: 'regular' | 'composition' | 'unregistered',
  hasPayroll: boolean,
  horizonDays = 30
): Deadline[] {
  const horizonEnd = addDays(today, horizonDays)
  const { y: ty, m: tm } = parseISO(today)
  const { y: hy, m: hm } = parseISO(horizonEnd)

  const inRange = (date: string): boolean => date >= today && date <= horizonEnd

  const out: Deadline[] = []

  // Monthly filing-month rules (GSTR-1/3B, TDS, PF, ESI) are all expressed in terms of a "filing
  // month" — the month the return/deposit is due in, one month after the period it covers.
  // Scan a comfortable window of filing months around [today, horizonEnd]: one month back covers
  // deadlines that fall early in `today`'s month but were computed relative to a filing month that
  // started before it; one month forward past horizonEnd is a safety margin for long horizons.
  const start = monthAdd(ty, tm, -1)
  const endM = monthAdd(hy, hm, 1)
  for (let idx = start.y * 12 + (start.m - 1); idx <= endM.y * 12 + (endM.m - 1); idx++) {
    const filingY = Math.floor(idx / 12)
    const filingM = (idx % 12) + 1
    const period = monthAdd(filingY, filingM, -1)
    const periodLabel = monthLabel(period.y, period.m)

    if (gstRegistrationType === 'regular') {
      const gstr1Date = ymd(filingY, filingM, 11)
      if (inRange(gstr1Date)) {
        out.push({ id: `gstr1-${period.y}-${pad2(period.m)}`, form: 'GSTR-1', title: `GSTR-1 — outward supplies (${periodLabel})`, date: gstr1Date, kind: 'gst' })
      }
      const gstr3bDate = ymd(filingY, filingM, 20)
      if (inRange(gstr3bDate)) {
        out.push({ id: `gstr3b-${period.y}-${pad2(period.m)}`, form: 'GSTR-3B', title: `GSTR-3B — summary return (${periodLabel})`, date: gstr3bDate, kind: 'gst' })
      }
    }

    const tdsDate = ymd(filingY, filingM, 7)
    if (inRange(tdsDate)) {
      out.push({ id: `tds-${period.y}-${pad2(period.m)}`, form: 'TDS Challan', title: `TDS deposit — challan for ${periodLabel}`, date: tdsDate, kind: 'tds' })
    }

    if (hasPayroll) {
      const pfDate = ymd(filingY, filingM, 15)
      if (inRange(pfDate)) {
        out.push({ id: `pf-${period.y}-${pad2(period.m)}`, form: 'PF ECR', title: `PF contribution — ${periodLabel}`, date: pfDate, kind: 'pf' })
      }
      const esiDate = ymd(filingY, filingM, 15)
      if (inRange(esiDate)) {
        out.push({ id: `esi-${period.y}-${pad2(period.m)}`, form: 'ESI', title: `ESI contribution — ${periodLabel}`, date: esiDate, kind: 'esi' })
      }
    }
  }

  // Advance tax instalments are fixed calendar dates, not filing-month derived — scan the calendar
  // years touching the window directly (one year of margin on each side for FY-boundary safety).
  for (let year = ty - 1; year <= hy + 1; year++) {
    const instalments: { m: number; d: number; label: string }[] = [
      { m: 6, d: 15, label: 'Q1' },
      { m: 9, d: 15, label: 'Q2' },
      { m: 12, d: 15, label: 'Q3' },
      { m: 3, d: 15, label: 'Q4' }
    ]
    for (const inst of instalments) {
      const date = ymd(year, inst.m, inst.d)
      if (inRange(date)) {
        out.push({
          id: `advtax-${date}`,
          form: 'Advance Tax',
          title: `Advance tax instalment (${inst.label}) due`,
          date,
          kind: 'advance-tax'
        })
      }
    }
  }

  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1))
  return out
}
