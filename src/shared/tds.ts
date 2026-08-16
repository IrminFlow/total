/**
 * TDS (Tax Deducted at Source) — pure rate/threshold/quarter math shared by main (persistence,
 * suggestions) and renderer (voucher-entry banner, Tds screen). No I/O, no DB.
 */
import { roundToRupee } from './money'
import { fyOf } from './dates'

/**
 * Amount to deduct at source. Without a PAN on file, section 206AA forces the higher of the
 * section rate or 20% (never lower). Result is rounded to the nearest whole rupee, as filed.
 */
export function computeTds(ratePercent: number, basePaise: number, panAvailable: boolean): number {
  const effectiveRate = panAvailable ? ratePercent : Math.max(ratePercent, 20)
  return roundToRupee(Math.round((basePaise * effectiveRate) / 100))
}

export interface TdsThresholds {
  /** Single-transaction threshold, paise. 0 = no single-transaction threshold. */
  thresholdSingle: number
  /** Financial-year cumulative threshold, paise. 0 = no annual threshold. */
  thresholdAnnual: number
}

/**
 * Whether this deduction becomes applicable under either threshold. A section with both
 * thresholds at 0 (e.g. none configured) is always applicable. `fyBaseSoFarPaise` is the sum of
 * prior deductee base amounts in the same FY, *excluding* the current transaction.
 */
export function thresholdCrossed(thresholds: TdsThresholds, basePaise: number, fyBaseSoFarPaise: number): boolean {
  const { thresholdSingle, thresholdAnnual } = thresholds
  if (thresholdSingle <= 0 && thresholdAnnual <= 0) return true
  const singleCrossed = thresholdSingle > 0 && basePaise >= thresholdSingle
  const annualCrossed = thresholdAnnual > 0 && fyBaseSoFarPaise + basePaise >= thresholdAnnual
  return singleCrossed || annualCrossed
}

export interface TdsQuarter {
  q: 1 | 2 | 3 | 4
  /** e.g. "Q1 FY2025-26" */
  label: string
  /** Calendar year the containing FY starts in. */
  fyStartYear: number
  from: string
  to: string
}

/** Indian TDS quarters: Q1 Apr-Jun, Q2 Jul-Sep, Q3 Oct-Dec, Q4 Jan-Mar (of fyStartYear + 1). */
export function tdsQuarterOf(dateISO: string): TdsQuarter {
  const fy = fyOf(dateISO)
  const month = Number(dateISO.split('-')[1])
  if (month >= 4 && month <= 6) {
    return { q: 1, label: `Q1 FY${fy.label}`, fyStartYear: fy.startYear, from: `${fy.startYear}-04-01`, to: `${fy.startYear}-06-30` }
  }
  if (month >= 7 && month <= 9) {
    return { q: 2, label: `Q2 FY${fy.label}`, fyStartYear: fy.startYear, from: `${fy.startYear}-07-01`, to: `${fy.startYear}-09-30` }
  }
  if (month >= 10 && month <= 12) {
    return { q: 3, label: `Q3 FY${fy.label}`, fyStartYear: fy.startYear, from: `${fy.startYear}-10-01`, to: `${fy.startYear}-12-31` }
  }
  return { q: 4, label: `Q4 FY${fy.label}`, fyStartYear: fy.startYear, from: `${fy.startYear + 1}-01-01`, to: `${fy.startYear + 1}-03-31` }
}
