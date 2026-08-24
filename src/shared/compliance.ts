/**
 * Compliance calendar — pure date math over the recurring Indian statutory deadlines a small
 * business tracks: GST returns, TDS deposit, PF/ESI contributions, advance tax instalments.
 * No DB, no Electron — `upcomingDeadlines` takes everything it needs as arguments so it can be
 * driven identically from the main-process notifier (services/reports-adjacent) and the renderer
 * (Gateway's GST-countdown tile), both of which already have `today` + `CompanyInfo` in hand.
 */

export type DeadlineKind = 'gst' | 'tds' | 'pf' | 'esi' | 'advance-tax'

/**
 * GSTR-3B under QRMP is staggered by state. Registrations in this group file by the 22nd; every
 * other state files by the 24th. Codes are the two-digit GST state codes.
 *
 * This is the one piece of the schedule that varies by where the business is registered, and it
 * is exactly the sort of thing worth checking against the current notification before a filing
 * season -- the grouping has been revised before.
 */
const QRMP_22ND_STATE_CODES = new Set([
  '29', // Karnataka
  '32', // Kerala
  '33', // Tamil Nadu
  '34', // Puducherry
  '35', // Andaman & Nicobar
  '36', // Telangana
  '37', // Andhra Pradesh
  '24', // Gujarat
  '26', // Dadra & Nagar Haveli and Daman & Diu
  '27', // Maharashtra
  '30', // Goa
  '31', // Lakshadweep
  '22', // Chhattisgarh
  '23' // Madhya Pradesh
])

/** Which FY quarter a 1-indexed calendar month falls in. Q1 is Apr-Jun. */
function fyQuarterOfMonth(month: number): 1 | 2 | 3 | 4 {
  return (Math.floor(((month - 4 + 12) % 12) / 3) + 1) as 1 | 2 | 3 | 4
}

/** Position of a month within its FY quarter: 1, 2 or 3. */
function monthInQuarter(month: number): 1 | 2 | 3 {
  return (((month - 4 + 12) % 12) % 3 + 1) as 1 | 2 | 3
}

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
  horizonDays = 30,
  /** Monthly unless the registration is on QRMP. */
  gstFilingFrequency: 'monthly' | 'quarterly' = 'monthly',
  /** Two-digit GST state code, which decides the QRMP GSTR-3B date. */
  stateCode = ''
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

    if (gstRegistrationType === 'regular' && gstFilingFrequency === 'monthly') {
      const gstr1Date = ymd(filingY, filingM, 11)
      if (inRange(gstr1Date)) {
        out.push({ id: `gstr1-${period.y}-${pad2(period.m)}`, form: 'GSTR-1', title: `GSTR-1 — outward supplies (${periodLabel})`, date: gstr1Date, kind: 'gst' })
      }
      const gstr3bDate = ymd(filingY, filingM, 20)
      if (inRange(gstr3bDate)) {
        out.push({ id: `gstr3b-${period.y}-${pad2(period.m)}`, form: 'GSTR-3B', title: `GSTR-3B — summary return (${periodLabel})`, date: gstr3bDate, kind: 'gst' })
      }
    }

    if (gstRegistrationType === 'composition') {
      // Composition dealers had no GST deadlines at all, which read as "nothing to file" rather
      // than "we do not support your scheme". CMP-08 is quarterly; GSTR-4 is annual and handled
      // outside this month loop because it is a fixed calendar date.
      if (monthInQuarter(period.m) === 3) {
        const cmp08Date = ymd(filingY, filingM, 18)
        if (inRange(cmp08Date)) {
          out.push({
            id: `cmp08-${period.y}-${fyQuarterOfMonth(period.m)}`,
            form: 'CMP-08',
            title: `CMP-08 — self-assessed tax (Q${fyQuarterOfMonth(period.m)}, quarter ending ${periodLabel})`,
            date: cmp08Date,
            kind: 'gst'
          })
        }
      }
    }

    if (gstRegistrationType === 'regular' && gstFilingFrequency === 'quarterly') {
      // QRMP. The returns are quarterly but the money is still monthly, which is the part
      // filers most often miss -- a PMT-06 challan is due in each of the first two months.
      const position = monthInQuarter(period.m)
      const quarter = fyQuarterOfMonth(period.m)

      if (position === 3) {
        // Quarter just ended: both returns fall due in the following month.
        const gstr1Date = ymd(filingY, filingM, 13)
        if (inRange(gstr1Date)) {
          out.push({
            id: `gstr1-q-${period.y}-${quarter}`,
            form: 'GSTR-1',
            title: `GSTR-1 — outward supplies (Q${quarter}, quarter ending ${periodLabel})`,
            date: gstr1Date,
            kind: 'gst'
          })
        }
        const day3b = QRMP_22ND_STATE_CODES.has(stateCode) ? 22 : 24
        const gstr3bDate = ymd(filingY, filingM, day3b)
        if (inRange(gstr3bDate)) {
          out.push({
            id: `gstr3b-q-${period.y}-${quarter}`,
            form: 'GSTR-3B',
            title: `GSTR-3B — summary return (Q${quarter}, quarter ending ${periodLabel})`,
            date: gstr3bDate,
            kind: 'gst'
          })
        }
      } else {
        // Months 1 and 2: tax by challan, and the optional IFF so buyers see their credit
        // without waiting for the quarter to close.
        const pmt06Date = ymd(filingY, filingM, 25)
        if (inRange(pmt06Date)) {
          out.push({
            id: `pmt06-${period.y}-${pad2(period.m)}`,
            form: 'PMT-06',
            title: `PMT-06 — monthly tax payment (${periodLabel})`,
            date: pmt06Date,
            kind: 'gst'
          })
        }
        const iffDate = ymd(filingY, filingM, 13)
        if (inRange(iffDate)) {
          out.push({
            id: `iff-${period.y}-${pad2(period.m)}`,
            form: 'IFF',
            title: `IFF — optional B2B upload (${periodLabel})`,
            date: iffDate,
            kind: 'gst'
          })
        }
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

  // GSTR-4 is annual, due on a fixed date after the financial year closes, so it is scanned over
  // calendar years rather than derived from a filing month.
  if (gstRegistrationType === 'composition') {
    for (let year = ty - 1; year <= hy + 1; year++) {
      const date = ymd(year, 6, 30)
      if (inRange(date)) {
        const fyLabel = `${year - 1}-${pad2((year % 100))}`
        out.push({
          id: `gstr4-${year}`,
          form: 'GSTR-4',
          title: `GSTR-4 — annual return (FY ${fyLabel})`,
          date,
          kind: 'gst'
        })
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
