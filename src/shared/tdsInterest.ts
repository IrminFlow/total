/**
 * Interest on late deduction / late deposit of TDS — INDICATIVE. Pure; rates are parameters so
 * the Challans tab can let the user change them.
 *
 * SOURCES (accessed 2026-10-07):
 *  - Income-tax Act 1961 s.201(1A): simple interest "(i) at one per cent for every month or part
 *    of a month on the amount of such tax from the date on which such tax was deductible to the
 *    date on which such tax is deducted; and (ii) at one and one-half per cent for every month or
 *    part of a month on the amount of such tax from the date on which such tax was deducted to
 *    the date on which such tax is actually paid" —
 *    (dates up to 31 Mar 2026). The department's page (https://www.incometaxindia.gov.in/w/section-201)
 *    refused automated access (HTTP 403) on 2026-10-07, so this wording is UNVERIFIED here —
 *    it matches the 2025-Act text below.
 *  - Income-tax Act 2025 s.398(3)(a): the same 1% / 1.5% "for every month or part of a month"
 *    two-tier rule (text read via https://eztax.in/income-tax-act-2025/section-398 — a secondary
 *    reproduction; NOT yet checked against the Gazette copy, see the WP 3.2 UNVERIFIED list).
 *  - Due date of deposit (non-government deductor): Income-tax Rules 1962 rule 30(2) — within
 *    seven days from the end of the month of deduction; for March, 30 April. The Income-tax
 *    Rules 2026 equivalent is UNVERIFIED (same dates per the department's tax calendar).
 *
 * "Month or part of a month" is counted the way TRACES computes it — calendar months, both the
 * starting and ending month counted (deducted 25 Jan, paid 8 Feb = 2 months). Courts have read
 * it as periods of a month from the date instead; TRACES's reading is the conservative one.
 */
import { monthlyInterestPaise, monthsOrPart } from './withholding'

export { monthsOrPart }

/** Rates in basis points (100 = 1%). */
export const LATE_DEDUCTION_RATE_BP = 100
export const LATE_DEPOSIT_RATE_BP = 150

/** Last date to deposit TDS deducted on `deductedOn` (rule 30(2), non-government deductor). */
export function depositDueDate(deductedOn: string): string {
  const [y, m] = deductedOn.split('-').map(Number) as [number, number]
  if (m === 3) return `${y}-04-30`
  const ny = m === 12 ? y + 1 : y
  const nm = m === 12 ? 1 : m + 1
  return `${ny}-${String(nm).padStart(2, '0')}-07`
}

export interface InterestResult {
  months: number
  rateBp: number
  interestPaise: number
  /** For deposit interest: the due date it was measured against. */
  dueDate?: string
}

/** s.201(1A)(ii) / 2025 s.398(3)(a) second limb: deposited after the due date → rate per month
 *  or part from the date of deduction to the date of payment. */
export function lateDepositInterest(
  tdsPaise: number, deductedOn: string, paidOn: string, rateBp = LATE_DEPOSIT_RATE_BP,
  /** TCS (WP 3.3) passes its own due date (rule 37CA / Rules 2026 rule 218(2)) — the two-tier
   *  interest itself is the same under s.206C(7) / 2025 s.398(3)(a). */
  dueDateOf: (withheldOn: string) => string = depositDueDate
): InterestResult {
  const dueDate = dueDateOf(deductedOn)
  if (paidOn <= dueDate || tdsPaise <= 0) return { months: 0, rateBp, interestPaise: 0, dueDate }
  const months = monthsOrPart(deductedOn, paidOn)
  return { months, rateBp, interestPaise: monthlyInterestPaise(tdsPaise, rateBp, months), dueDate }
}

/** s.201(1A)(i) / first limb: deducted after it was deductible (e.g. on payment of a bill that
 *  should have been deducted at credit) → rate per month or part between the two dates. */
export function lateDeductionInterest(tdsPaise: number, deductibleOn: string, deductedOn: string, rateBp = LATE_DEDUCTION_RATE_BP): InterestResult {
  if (deductedOn <= deductibleOn || tdsPaise <= 0) return { months: 0, rateBp, interestPaise: 0 }
  const months = monthsOrPart(deductibleOn, deductedOn)
  return { months, rateBp, interestPaise: monthlyInterestPaise(tdsPaise, rateBp, months) }
}

/** Shown next to the late-deduction figure (Deducted tab, its export). */
export const LATE_DEDUCTION_CITATION =
  'Income-tax Act 1961 s.201(1A)(i) (2025 Act s.398(3)(a)): 1% for every month or part of a month from the date the tax was deductible to the date it was deducted — indicative, not posted'

/** What the late-deduction figure rests on that no official text read here confirms. */
export const TDS_INTEREST_UNVERIFIED: readonly string[] = [
  's.201(1A) wording: the department page refused automated access (see the sources above); the 2025-Act text was read from a secondary reproduction.',
  '"Month or part of a month" counted as calendar months with both the first and the last month counted (TRACES\'s reading; no official text quoted here says so — courts have also read it as periods of a month from the date).',
  'A bill that became liable only when a LATER bill crossed the annual threshold is taken as deductible on that later bill\'s date.',
  'Bills of an earlier financial year are not followed: a deduction on payment is compared only with the bills of its own year.',
  'Each bill\'s share of the deducted tax is the entry\'s TDS × that bill\'s share of the entry\'s base (half-up), its interest rounded to the rupee per bill.'
]

export interface LateDeduction {
  /** The earliest date the covered tax became deductible. */
  deductibleOn: string
  /** Months (or part) for the earliest bill — the longest delay. */
  months: number
  rateBp: number
  interestPaise: number
  parts: { voucherId: number; deductibleOn: string; tdsPaise: number; months: number; interestPaise: number }[]
}

/** s.201(1A)(i) for a deduction made on payment that covered bills already liable at credit
 *  (`cover` = the walk's `lateCover`). Null when it covered none. */
export function lateDeductionOnPayment(
  entryTdsPaise: number, entryBasePaise: number, deductedOn: string,
  cover: readonly { voucherId: number; deductibleOn: string; basePaise: number }[] | undefined,
  rateBp = LATE_DEDUCTION_RATE_BP
): LateDeduction | null {
  if (!cover?.length || entryBasePaise <= 0 || entryTdsPaise <= 0) return null
  const parts = cover.map((c) => {
    const num = BigInt(entryTdsPaise) * BigInt(c.basePaise) * 2n + BigInt(entryBasePaise)
    const tdsPaise = Number(num / (2n * BigInt(entryBasePaise)))
    const i = lateDeductionInterest(tdsPaise, c.deductibleOn, deductedOn, rateBp)
    return { voucherId: c.voucherId, deductibleOn: c.deductibleOn, tdsPaise, months: i.months, interestPaise: i.interestPaise }
  })
  const first = parts.reduce((a, b) => (b.deductibleOn < a.deductibleOn ? b : a))
  return { deductibleOn: first.deductibleOn, months: first.months, rateBp, interestPaise: parts.reduce((s, p) => s + p.interestPaise, 0), parts }
}
