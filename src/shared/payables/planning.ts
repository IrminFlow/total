/**
 * Payment planning (WP 4.3) — pure helpers shared by the main-process planner and the screen:
 * due-date buckets, the "pay by" date (credit terms vs the MSME s.15 deadline), early-payment
 * discount terms, and the plan → payment-voucher grouping.
 */
import { addDays, daysBetween } from './msme'

export const PLAN_BUCKETS = ['overdue', 'this_week', 'next_week', 'later'] as const
export type PlanBucket = (typeof PLAN_BUCKETS)[number]

export const PLAN_BUCKET_LABELS: Record<PlanBucket, string> = {
  overdue: 'Overdue',
  this_week: 'Due this week',
  next_week: 'Due next week',
  later: 'Later'
}

/** The Sunday that ends `date`'s Monday–Sunday week (the date itself when it is a Sunday). */
export function weekEnd(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay() // 0 = Sunday
  return addDays(date, dow === 0 ? 0 : 7 - dow)
}

/**
 * Bucket a "pay by" date against `today`: before today = overdue; today … this Sunday = this week;
 * the following Monday … Sunday = next week; anything after = later.
 */
export function planBucket(payBy: string, today: string): PlanBucket {
  if (payBy < today) return 'overdue'
  const thisSunday = weekEnd(today)
  if (payBy <= thisSunday) return 'this_week'
  if (payBy <= addDays(thisSunday, 7)) return 'next_week'
  return 'later'
}

/**
 * The date a bill should be paid by: the earlier of its credit-terms due date (bill-wise due date,
 * else the bill date + the ledger's credit days — the Outstandings basis; the bill date itself
 * when neither is known) and, for a micro / small supplier, the MSMED Act s.15 deadline.
 */
export function payByDate(billDate: string, dueDate: string | null, s15PayBy: string | null): string {
  const terms = dueDate ?? billDate
  return s15PayBy != null && s15PayBy < terms ? s15PayBy : terms
}

/** A supplier's early-payment discount terms (per party, migration 034). */
export interface EarlyPaymentTerms {
  /** Discount, basis points of the bill (200 = 2 %). */
  bp: number
  /** Paid within this many days of the bill date. */
  days: number
}

export interface EarlyDiscount {
  /** Last day the discount can be taken. */
  by: string
  bp: number
  /** Discount on the pending amount, paise (rounded). */
  paise: number
  /** True when paying on `payDate` still earns it. */
  available: boolean
}

/** Discount offered for paying the pending amount by bill date + days (e.g. "2/10 net 30"). */
export function earlyDiscount(pendingPaise: number, billDate: string, terms: EarlyPaymentTerms | null, payDate: string): EarlyDiscount | null {
  if (!terms || terms.bp <= 0 || pendingPaise <= 0) return null
  const by = addDays(billDate, terms.days)
  return { by, bp: terms.bp, paise: Math.round((pendingPaise * terms.bp) / 10000), available: payDate <= by }
}

/** Days from `today` to `payBy` (negative = overdue by that many days). */
export function daysToPay(payBy: string, today: string): number {
  return daysBetween(today, payBy)
}

// ---------------------------------------------------------------------------------------------
// Selection → payment vouchers
// ---------------------------------------------------------------------------------------------

export interface PlanPick {
  ledgerId: number
  /** Bill name to settle (the bill-wise reference, or the voucher number for a bill without one). */
  number: string
  /** Amount to settle, paise (≤ the bill's pending). */
  amount: number
}

export interface SupplierPayment {
  partyLedgerId: number
  amount: number
  bills: { name: string; amount: number }[]
}

/** Ticked bills → one payment per supplier (bills in the order picked; zero amounts dropped). */
export function groupPicksBySupplier(picks: readonly PlanPick[]): SupplierPayment[] {
  const by = new Map<number, SupplierPayment>()
  for (const p of picks) {
    if (p.amount <= 0) continue
    const s = by.get(p.ledgerId) ?? { partyLedgerId: p.ledgerId, amount: 0, bills: [] }
    s.amount += p.amount
    const same = s.bills.find((b) => b.name === p.number)
    if (same) same.amount += p.amount
    else s.bills.push({ name: p.number, amount: p.amount })
    by.set(p.ledgerId, s)
  }
  return [...by.values()]
}
