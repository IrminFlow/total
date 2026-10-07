/**
 * TDS (Tax Deducted at Source) — pure rate/threshold/quarter math and voucher validation shared
 * by main (persistence, suggestions, save-time validation) and renderer (voucher-entry banner,
 * Tds screen). No I/O, no DB.
 *
 * Rates live in an effective-dated table (`tds_section_rates`, migration 020): one row per
 * section × deductee type × period, in basis points (1% = 100 bp) so 0.1% (194Q) stays an
 * integer. The statutory sources for every seeded value are cited next to the seed in
 * src/main/db/migrations.ts (migration 020).
 *
 * WP 3.3: the machinery TDS shares with TCS (rate rows, no-PAN / certificate rate choice,
 * thresholds, rounding, quarters, Act references, entry validation) moved to
 * src/shared/withholding.ts. The TDS names below are re-exports / thin wrappers with the exact
 * pre-3.3 behaviour and messages, so callers and tests are unchanged.
 */
import { roundToRupee } from './money'
import type { PostingError } from './posting'
import {
  computeWithholdingPaise, expectedWithholdingPaise, quarterBounds, quarterOf, validateWithholdingEntries,
  type ApplicableRate, type RateDeducteeType, type WithholdingCertificate, type WithholdingLabels,
  type WithholdingQuarter, type WithholdingRateRow, type WithholdingThresholds
} from './withholding'

export {
  DEDUCTEE_TYPES, deducteeTypeFromPan, resolveDeducteeType, rateRowOn, applicableRate, taxableBase,
  thresholdCrossed, thresholdPeriod, thresholdStatus, IT_ACT_2025_FROM, sectionReferenceOn
} from './withholding'
export type { DeducteeType, RateDeducteeType, CertificateUse, ApplicableRate, ThresholdStatus } from './withholding'

export const DEDUCTEE_TYPE_LABELS: Record<RateDeducteeType, string> = {
  individual_huf: 'Individual / HUF',
  company: 'Company',
  firm: 'Firm / LLP',
  other: 'Other (AOP, BOI, trust, …)',
  any: 'Any deductee'
}

/** A TDS rate row (tds_section_rates). */
export type TdsRateRow = WithholdingRateRow
/** Lower/nil deduction certificate (s.197 of the 1961 Act) issued to a deductee. */
export type TdsCertificate = WithholdingCertificate
export type TdsThresholds = WithholdingThresholds
export type TdsQuarter = WithholdingQuarter

/**
 * The deduction, rounded to the nearest whole rupee (half up). Source: s.288B of the 1961 Act
 * rounds tax "payable" to the nearest ten rupees, but TDS is deducted/reported to the rupee —
 * see the rounding citation in migration 020. Surcharge and cess are never added: for resident
 * payees other than salary the TDS rates in force are not increased by surcharge or cess (same
 * citation block). Only the part of the base still covered by a capped certificate gets the
 * certificate rate; the excess goes at the table rate.
 */
export const computeTdsPaise = computeWithholdingPaise

/**
 * Legacy single-rate helper (percent), kept for callers that predate the rate table. Without a
 * PAN the higher of the section rate and 20% applies.
 */
export function computeTds(ratePercent: number, basePaise: number, panAvailable: boolean): number {
  const effectiveRate = panAvailable ? ratePercent : Math.max(ratePercent, 20)
  return roundToRupee(Math.round((basePaise * effectiveRate) / 100))
}

/** The deduction the rate table yields: rate (or certificate) on the taxable part of the base. */
export function expectedTdsPaise(rate: ApplicableRate, basePaise: number, priorPeriodBasePaise: number): number {
  return expectedWithholdingPaise(rate, basePaise, priorPeriodBasePaise)
}

/** Indian TDS quarters: Q1 Apr-Jun, Q2 Jul-Sep, Q3 Oct-Dec, Q4 Jan-Mar (of fyStartYear + 1). */
export const tdsQuarterOf = quarterOf
/** Bounds of quarter `q` of the FY starting `fyStartYear`. */
export const tdsQuarterBounds = quarterBounds

// ---------------------------------------------------------------------------------------------
// Validation (saveVoucher)
// ---------------------------------------------------------------------------------------------

export interface TdsEntryToValidate {
  sectionId: number
  baseAmount: number
  tdsAmount: number
  isManual: boolean
}

export interface TdsSectionFacts {
  code: string
  /** Deduction the rate table yields for this entry (computed by the caller with
   *  applicableRate + computeTdsPaise); null = no rate in force on the voucher date. */
  expectedTdsPaise: number | null
}

export const TDS_LABELS: WithholdingLabels = {
  prefix: 'tds', name: 'TDS', noun: 'deduction', party: 'the deductee', sectionsScreen: 'TDS › Sections'
}

/**
 * Checks a voucher's TDS entries against its own lines. Per entry: the section exists, there is
 * a party, 0 < tds ≤ base, and (unless the entry is marked manual) tds equals the rate table's
 * figure. Per section: the voucher credits ledgers tagged as that section's TDS payable
 * (`payableLedgerTagMap`: ledger id → section id) by exactly the entries' total — or, when
 * every entry for that section is manual, by something.
 */
export function validateTdsEntries(
  voucher: { partyLedgerId: number | null; lines: readonly { ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[] },
  entries: readonly TdsEntryToValidate[],
  payableLedgerTagMap: ReadonlyMap<number, number>,
  sectionFacts: (entry: TdsEntryToValidate) => TdsSectionFacts | null
): PostingError[] {
  const byGeneric = new Map<object, TdsEntryToValidate>()
  const generic = entries.map((e) => {
    const g = { sectionId: e.sectionId, baseAmount: e.baseAmount, amount: e.tdsAmount, isManual: e.isManual }
    byGeneric.set(g, e)
    return g
  })
  return validateWithholdingEntries(voucher, generic, payableLedgerTagMap, (g) => {
    const f = sectionFacts(byGeneric.get(g)!)
    return f ? { code: f.code, expectedPaise: f.expectedTdsPaise } : null
  }, TDS_LABELS)
}
