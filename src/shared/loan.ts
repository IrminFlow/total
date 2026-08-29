/**
 * Loans the business borrowed, and the EMI split (roadmap #370).
 *
 * The whole point of this module is the split. An EMI is not an expense: part of it repays what
 * was borrowed and part of it is interest, and the proportion changes every month. Booking the
 * whole instalment to the loan account — which is what almost every small business does — leaves
 * the loan balance wrong, understates interest, and overstates profit by the interest for as long
 * as the loan runs.
 *
 * Everything is reducing-balance and monthly, because that is what a vehicle or machinery loan in
 * this market is. Interest is charged on the opening balance of the month at one twelfth of the
 * annual rate; the schedule below is the one a bank's own amortisation sheet produces.
 */
import { roundPaise } from './money'

export interface LoanTerms {
  /** What was actually borrowed, in paise. */
  principalPaise: number
  /** Annual rate in basis points. 9.25% p.a. = 925. */
  annualRateBp: number
  /** Number of monthly instalments. */
  months: number
  /**
   * The instalment the bank stated, in paise. Almost always present on a real sanction letter,
   * and preferred over the computed one when it is: the bank's rounding is the one the account
   * will actually be debited by, and recomputing it drifts by a rupee or two over five years.
   */
  emiPaise?: number | null
  /** First instalment date, ISO. */
  firstInstalmentDate: string
}

export interface LoanInstalment {
  /** 1-based. */
  n: number
  dueDate: string
  openingPaise: number
  emiPaise: number
  interestPaise: number
  principalPaise: number
  closingPaise: number
}

export interface LoanSchedule {
  emiPaise: number
  /** True when the EMI came from the terms rather than the formula. */
  emiStated: boolean
  rows: LoanInstalment[]
  totalInterestPaise: number
  totalPaidPaise: number
  /**
   * The last instalment differs from the rest whenever the EMI does not divide the loan evenly,
   * which is nearly always. Surfaced rather than hidden: a borrower who sees a final instalment
   * of ₹9,842 against an EMI of ₹9,847 should be told why, not left to think it is a bug.
   */
  finalInstalmentPaise: number
}

/**
 * The standard EMI formula: P·i·(1+i)^n / ((1+i)^n − 1).
 *
 * A float is unavoidable here — the formula has a power in it — but it touches nothing but this
 * one number, which is rounded to paise on the way out. Every figure derived from it afterwards
 * is integer arithmetic on that rounded EMI, so the rounding happens once and never compounds.
 */
export function computeEmi(principalPaise: number, annualRateBp: number, months: number): number {
  if (months <= 0) throw new Error('A loan needs at least one instalment')
  if (annualRateBp === 0) return Math.ceil(principalPaise / months)
  const i = annualRateBp / 10000 / 12
  const factor = Math.pow(1 + i, months)
  return roundPaise((principalPaise * i * factor) / (factor - 1))
}

/** Add whole months to an ISO date, clamping to the end of a short month. */
export function addMonthsISO(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const target = new Date(Date.UTC(y, m - 1 + months, 1))
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  // The 31st of a 30-day month becomes the 30th, not the 1st of the next — a loan due on the
  // 31st is due at the end of February, not in March.
  const day = Math.min(d, lastDay)
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * The full amortisation schedule, to the last rupee.
 *
 * Two edges decide whether this is right or merely plausible:
 *
 * 1. The EMI almost never divides the loan evenly. The last instalment therefore repays whatever
 *    principal is left rather than the standard amount, so the closing balance is exactly zero
 *    and not "about zero". A schedule that ends at −₹3.17 is a schedule nobody can reconcile.
 * 2. An EMI smaller than the first month's interest never repays anything. That is a real (and
 *    ruinous) product, but it is far more often a typo, so it is refused rather than run into a
 *    growing balance for 240 rows.
 */
export function amortise(terms: LoanTerms): LoanSchedule {
  if (terms.principalPaise <= 0) throw new Error('A loan needs a principal')
  if (terms.months <= 0) throw new Error('A loan needs at least one instalment')
  const emiStated = terms.emiPaise != null && terms.emiPaise > 0
  const emi = emiStated ? terms.emiPaise! : computeEmi(terms.principalPaise, terms.annualRateBp, terms.months)
  const monthlyRateBp = terms.annualRateBp / 12

  const firstInterest = roundPaise((terms.principalPaise * monthlyRateBp) / 10000)
  if (emi <= firstInterest && terms.months > 1) {
    throw new Error(
      `An instalment of ₹${(emi / 100).toFixed(2)} never repays this loan — the first month's interest alone is ₹${(firstInterest / 100).toFixed(2)}`
    )
  }

  const rows: LoanInstalment[] = []
  let balance = terms.principalPaise
  for (let n = 1; n <= terms.months && balance > 0; n++) {
    const interest = roundPaise((balance * monthlyRateBp) / 10000)
    const isLast = n === terms.months
    // The last row clears the balance whatever the EMI says; so does any earlier row that would
    // otherwise overshoot, which happens when the stated EMI is a little generous.
    let principal = isLast ? balance : Math.min(emi - interest, balance)
    if (principal < 0) principal = 0
    const paid = principal + interest
    rows.push({
      n,
      dueDate: addMonthsISO(terms.firstInstalmentDate, n - 1),
      openingPaise: balance,
      emiPaise: paid,
      interestPaise: interest,
      principalPaise: principal,
      closingPaise: balance - principal
    })
    balance -= principal
  }

  return {
    emiPaise: emi,
    emiStated,
    rows,
    totalInterestPaise: rows.reduce((s, r) => s + r.interestPaise, 0),
    totalPaidPaise: rows.reduce((s, r) => s + r.emiPaise, 0),
    finalInstalmentPaise: rows.length ? rows[rows.length - 1]!.emiPaise : 0
  }
}

/** Instalments falling inside a period — what the month's or year's journal covers. */
export function instalmentsBetween(schedule: LoanSchedule, from: string, to: string): LoanInstalment[] {
  return schedule.rows.filter((r) => r.dueDate >= from && r.dueDate <= to)
}

/** What is still owed the day before `on` — the balance-sheet figure. */
export function outstandingOn(schedule: LoanSchedule, principalPaise: number, on: string): number {
  const paid = schedule.rows.filter((r) => r.dueDate <= on).reduce((s, r) => s + r.principalPaise, 0)
  return Math.max(0, principalPaise - paid)
}
