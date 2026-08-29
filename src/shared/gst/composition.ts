/**
 * The composition scheme: CMP-08 and GSTR-4.
 *
 * Composition dealers were served an error. `validateGstr1` blocked their export with a message
 * telling them they file CMP-08/GSTR-4 instead, and the app then offered neither. That is a
 * large, price-sensitive segment -- traders up to Rs 1.5 crore, restaurants, and service
 * providers up to Rs 50 lakh -- turned away at the door.
 *
 * What the scheme is, in the shape this module needs:
 *  - No input tax credit, and no tax charged to the customer. Tax is a percentage of turnover
 *    paid out of the dealer's own margin, which is why the arithmetic here is turnover-based
 *    rather than invoice-tax-based.
 *  - CMP-08 is a quarterly statement of self-assessed tax.
 *  - GSTR-4 is an annual return summarising the four quarters.
 *  - Purchases attracting reverse charge are taxed at the normal rate, separately from the
 *    turnover computation, because the dealer owes that as a recipient rather than a supplier.
 *
 * Rates are configurable rather than hardcoded into the computation: they have moved before, and
 * a wrong rate compiled into a build is a wrong statutory filing.
 */

import { percentOf } from '../money'

/** Composition categories and their CGST+SGST combined rate, as a percentage of turnover. */
export const COMPOSITION_CATEGORIES = [
  { id: 'trader', label: 'Trader or manufacturer', ratePercent: 1 },
  { id: 'restaurant', label: 'Restaurant (no alcohol)', ratePercent: 5 },
  { id: 'service', label: 'Service provider', ratePercent: 6 }
] as const

export type CompositionCategory = (typeof COMPOSITION_CATEGORIES)[number]['id']

export function compositionRate(category: CompositionCategory): number {
  return COMPOSITION_CATEGORIES.find((c) => c.id === category)?.ratePercent ?? 1
}

export interface CompositionInput {
  category: CompositionCategory
  /** Outward supplies in the quarter, in paise, excluding anything exempt. */
  outwardTurnover: number
  /** Inward supplies attracting reverse charge, in paise. */
  inwardReverseCharge: number
  /** Tax already paid on those reverse-charge inwards, if any, in paise. */
  reverseChargeTax: number
  /** Interest and late fee the dealer is declaring, in paise. */
  interest?: number
  lateFee?: number
}

export interface Cmp08 {
  /** Table 6 of CMP-08, which is the whole form. */
  outwardTurnover: number
  ratePercent: number
  /** Tax on turnover, split equally between CGST and SGST. */
  cgst: number
  sgst: number
  /** Reverse-charge liability, which is not part of the turnover computation. */
  reverseChargeTax: number
  interest: number
  lateFee: number
  /** What the dealer actually pays. */
  totalPayable: number
}

/**
 * Compute CMP-08 for a quarter.
 *
 * The tax on turnover splits equally between CGST and SGST, and the halves are derived so they
 * always re-add to the total -- taking half of each independently can leave a stray paisa when
 * the total is odd, and a statement that does not foot is a statement that gets rejected.
 */
export function computeCmp08(input: CompositionInput): Cmp08 {
  const ratePercent = compositionRate(input.category)
  const taxOnTurnover = percentOf(input.outwardTurnover, ratePercent)
  const cgst = Math.floor(taxOnTurnover / 2)
  const sgst = taxOnTurnover - cgst
  const interest = input.interest ?? 0
  const lateFee = input.lateFee ?? 0

  return {
    outwardTurnover: input.outwardTurnover,
    ratePercent,
    cgst,
    sgst,
    reverseChargeTax: input.reverseChargeTax,
    interest,
    lateFee,
    totalPayable: cgst + sgst + input.reverseChargeTax + interest + lateFee
  }
}

export interface Gstr4Quarter {
  /** 'Q1'..'Q4' of the financial year. */
  quarter: string
  cmp08: Cmp08
}

export interface Gstr4 {
  /** Financial year label, e.g. '2026-27'. */
  financialYear: string
  quarters: Gstr4Quarter[]
  totalTurnover: number
  totalCgst: number
  totalSgst: number
  totalReverseChargeTax: number
  totalPayable: number
  /** Quarters with no CMP-08 computed, so the UI can say what is missing rather than imply zero. */
  missingQuarters: string[]
}

/**
 * Roll four quarters into the annual return.
 *
 * A missing quarter is reported rather than treated as zero. An annual return that silently
 * totals three quarters and presents itself as complete is the worst possible failure here.
 */
export function buildGstr4(financialYear: string, quarters: Gstr4Quarter[]): Gstr4 {
  const byQuarter = new Map(quarters.map((q) => [q.quarter, q]))
  const missingQuarters = ['Q1', 'Q2', 'Q3', 'Q4'].filter((q) => !byQuarter.has(q))
  const present = ['Q1', 'Q2', 'Q3', 'Q4'].map((q) => byQuarter.get(q)).filter((q): q is Gstr4Quarter => !!q)

  const sum = (pick: (c: Cmp08) => number): number => present.reduce((total, q) => total + pick(q.cmp08), 0)

  return {
    financialYear,
    quarters: present,
    totalTurnover: sum((c) => c.outwardTurnover),
    totalCgst: sum((c) => c.cgst),
    totalSgst: sum((c) => c.sgst),
    totalReverseChargeTax: sum((c) => c.reverseChargeTax),
    totalPayable: sum((c) => c.totalPayable),
    missingQuarters
  }
}
