/**
 * WP 4.2 — interest on overdue bills. Pure: the main-side service (services/receivables.ts) feeds
 * it the open bills and what has already been charged, and posts what it returns.
 *
 * Day-count convention (see sources.ts 'day-count'): simple interest, actual days / 365, no
 * leap-year adjustment, rounded half up to the paisa PER BILL:
 *
 *     interest = pending × rateBp / 10 000 × days / 365
 *
 * The chargeable period of a bill starts the day after (due date + grace days) — the grace days
 * are interest-free — or the day after the last period already charged, whichever is later, and
 * ends on the as-on date; both ends inclusive. A bill with no due date runs from its bill date.
 * The principal is the bill's pending amount as on the as-on date (part-payments during the
 * period lower the base for the whole period — the customer is never over-charged).
 *
 * GST (sources.ts 'cgst-15-2-d'): the interest is apportioned over the original supply's GST
 * rates by taxable value and taxed at each rate.
 */
import { computeGst, type SupplyType } from '../gst/calc'

const DAY_MS = 86_400_000

export function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Whole days from `from` to `to` (to − from); negative when `to` is earlier. */
export function daysBetweenIso(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)
}

/** pending × rateBp × days / (10 000 × 365), rounded half up to the paisa. BigInt so a crore-sized
 *  bill at any rate over years never loses precision. */
export function simpleInterest(principalPaise: number, rateBp: number, days: number): number {
  if (principalPaise <= 0 || rateBp <= 0 || days <= 0) return 0
  const num = BigInt(principalPaise) * BigInt(rateBp) * BigInt(days)
  const den = 10_000n * 365n
  return Number((num * 2n + den) / (2n * den))
}

export interface InterestPeriod {
  /** First chargeable day (inclusive). */
  from: string
  /** Last chargeable day (inclusive) — the as-on date. */
  to: string
  days: number
}

/**
 * The chargeable period of one bill as on `asOn`, or null when nothing is chargeable yet.
 * `dueDate` null = the bill date is the due basis. `chargedTo` = the last day already charged on
 * a live debit note (null = never charged).
 */
export function interestPeriod(billDate: string, dueDate: string | null, graceDays: number, asOn: string, chargedTo: string | null): InterestPeriod | null {
  const basis = dueDate ?? billDate
  let from = addDaysIso(basis, Math.max(0, graceDays) + 1)
  if (chargedTo && chargedTo >= from) from = addDaysIso(chargedTo, 1)
  if (from > asOn) return null
  return { from, to: asOn, days: daysBetweenIso(from, asOn) + 1 }
}

export interface RateShare {
  /** GST rate in percent (0 = nil / exempt / non-GST). */
  rate: number
  /** Compensation-cess rate in percent (0 = none). */
  cessRate?: number
  taxablePaise: number
}

export interface InterestGstLine {
  rate: number
  cessRate: number
  /** Interest apportioned to this rate (the taxable value of the debit-note line). */
  interestPaise: number
  cgst: number
  sgst: number
  igst: number
  cess: number
}

/**
 * Split `interest` over the supply's (rate, cess) classes in proportion to their taxable values
 * (largest remainder, so the parts add up to the whole exactly), then tax each part at its rate
 * — exactly as the GST returns compute a ledger line (computeGst per line). With no shares (an
 * opening balance, a journal) or `charge` off, the whole interest is one untaxed rate-0 line.
 * `zeroTax` (SEZ / export without payment of tax): the rates stay, the tax is nil.
 */
export function splitInterestGst(interest: number, shares: RateShare[], supply: SupplyType, charge: boolean, zeroTax = false): InterestGstLine[] {
  const live = shares.filter((s) => s.taxablePaise > 0)
  const total = live.reduce((s, x) => s + x.taxablePaise, 0)
  if (interest <= 0) return []
  if (!charge || total <= 0) return [{ rate: 0, cessRate: 0, interestPaise: interest, cgst: 0, sgst: 0, igst: 0, cess: 0 }]
  // Merge equal classes first.
  const byClass = new Map<string, { rate: number; cessRate: number; taxable: number }>()
  for (const s of live) {
    const k = `${s.rate}|${s.cessRate ?? 0}`
    const c = byClass.get(k) ?? { rate: s.rate, cessRate: s.cessRate ?? 0, taxable: 0 }
    c.taxable += s.taxablePaise
    byClass.set(k, c)
  }
  const classes = [...byClass.values()].sort((a, b) => b.rate - a.rate || b.cessRate - a.cessRate)
  const parts = classes.map((c) => {
    const exact = (BigInt(interest) * BigInt(c.taxable) * 1000n) / BigInt(total)
    return { ...c, floor: Number(exact / 1000n), rem: Number(exact % 1000n) }
  })
  let left = interest - parts.reduce((s, p) => s + p.floor, 0)
  for (const p of [...parts].sort((a, b) => b.rem - a.rem)) {
    if (left <= 0) break
    p.floor += 1
    left -= 1
  }
  return parts
    .filter((p) => p.floor > 0)
    .map((p) => {
      const g = zeroTax ? { cgst: 0, sgst: 0, igst: 0, cess: 0 } : computeGst(p.floor, p.rate, supply, p.cessRate)
      return { rate: p.rate, cessRate: p.cessRate, interestPaise: p.floor, cgst: g.cgst, sgst: g.sgst, igst: g.igst, cess: g.cess }
    })
}

/** The tax a split carries (CGST + SGST + IGST + cess). */
export const gstOfLines = (lines: InterestGstLine[]): number => lines.reduce((s, g) => s + g.cgst + g.sgst + g.igst + g.cess, 0)

export interface InterestBillInput {
  billDate: string
  dueDate: string | null
  pendingPaise: number
  rateBp: number
  graceDays: number
  chargedTo: string | null
}

export interface InterestBillResult {
  period: InterestPeriod | null
  interestPaise: number
}

export function billInterest(b: InterestBillInput, asOn: string): InterestBillResult {
  const period = interestPeriod(b.billDate, b.dueDate, b.graceDays, asOn, b.chargedTo)
  return { period, interestPaise: period ? simpleInterest(b.pendingPaise, b.rateBp, period.days) : 0 }
}

/** "18" → 1800 bp; '' → null. Percent with up to two decimals. */
export function percentToBp(s: string): number | null {
  const t = s.trim()
  if (!t) return null
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return NaN
  const [w, f = ''] = t.split('.')
  return Number(w) * 100 + Number(f.padEnd(2, '0'))
}

export function bpToPercent(bp: number | null | undefined): string {
  if (bp == null) return ''
  const w = Math.floor(bp / 100)
  const f = bp % 100
  return f === 0 ? String(w) : `${w}.${String(f).padStart(2, '0').replace(/0$/, '')}`
}
