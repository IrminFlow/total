/**
 * Income tax on salary, and the TDS that comes off it every month.
 *
 * Two regimes, both with slabs that move every Budget, so the slabs are dated data rather than
 * constants — the same shape as statutory.ts, and for the same reason: an employee's February
 * payslip and their Form 16 have to agree with each other a year later.
 *
 * **The slabs below are what was in force when this was written. Check them against the Finance
 * Act for the year before relying on them.** A payroll that deducts confidently wrong TDS is
 * worse than one that deducts none, because the employee finds out in July from a demand notice.
 *
 * Everything is integer paise. Tax is computed on the year and spread across the months, which is
 * how TDS on salary actually works: section 192 asks the employer to estimate the year's salary,
 * compute the tax on it, and deduct it in roughly equal parts.
 */

export type Regime = 'new' | 'old'

export interface TaxSlab {
  /** Upper bound of this slab, inclusive, in paise. null = no upper bound. */
  upTo: number | null
  /** Whole percent. */
  rate: number
}

export interface RegimeRates {
  /** Financial year start, e.g. 2025 for FY 2025-26. */
  fyStartYear: number
  regime: Regime
  slabs: TaxSlab[]
  /** Flat deduction from salary income before the slabs are applied. */
  standardDeduction: number
  /**
   * Section 87A: taxable income at or below this gets a rebate wiping the tax out entirely.
   * Above it, marginal relief caps the tax at the excess over the threshold.
   */
  rebateLimit: number
  /** Maximum rebate, which is what caps it when income is just under the limit. */
  rebateMax: number
  /** Health and education cess, whole percent, applied after surcharge. */
  cessRate: number
  /** Surcharge rate caps out here under the new regime. */
  maxSurchargeRate: number
  note: string
}

/** Surcharge thresholds are the same under both regimes; only the top rate differs. */
export const SURCHARGE_BANDS: { above: number; rate: number }[] = [
  { above: 50_00_000_00, rate: 10 },
  { above: 1_00_00_000_00, rate: 15 },
  { above: 2_00_00_000_00, rate: 25 },
  { above: 5_00_00_000_00, rate: 37 }
]

/**
 * Slabs by financial year, ascending. A year later than the last entry is served by the last
 * entry, with `assumedFromEarlierYear` set on the result so the UI can say so out loud rather
 * than presenting a guess as fact.
 */
export const TAX_HISTORY: RegimeRates[] = [
  {
    fyStartYear: 2024,
    regime: 'new',
    slabs: [
      { upTo: 3_00_000_00, rate: 0 },
      { upTo: 7_00_000_00, rate: 5 },
      { upTo: 10_00_000_00, rate: 10 },
      { upTo: 12_00_000_00, rate: 15 },
      { upTo: 15_00_000_00, rate: 20 },
      { upTo: null, rate: 30 }
    ],
    standardDeduction: 75_000_00,
    rebateLimit: 7_00_000_00,
    rebateMax: 25_000_00,
    cessRate: 4,
    maxSurchargeRate: 25,
    note: 'FY 2024-25 new regime (Finance (No. 2) Act 2024).'
  },
  {
    fyStartYear: 2024,
    regime: 'old',
    slabs: [
      { upTo: 2_50_000_00, rate: 0 },
      { upTo: 5_00_000_00, rate: 5 },
      { upTo: 10_00_000_00, rate: 20 },
      { upTo: null, rate: 30 }
    ],
    standardDeduction: 50_000_00,
    rebateLimit: 5_00_000_00,
    rebateMax: 12_500_00,
    cessRate: 4,
    maxSurchargeRate: 37,
    note: 'FY 2024-25 old regime — slabs unchanged since FY 2014-15.'
  },
  {
    fyStartYear: 2025,
    regime: 'new',
    slabs: [
      { upTo: 4_00_000_00, rate: 0 },
      { upTo: 8_00_000_00, rate: 5 },
      { upTo: 12_00_000_00, rate: 10 },
      { upTo: 16_00_000_00, rate: 15 },
      { upTo: 20_00_000_00, rate: 20 },
      { upTo: 24_00_000_00, rate: 25 },
      { upTo: null, rate: 30 }
    ],
    standardDeduction: 75_000_00,
    rebateLimit: 12_00_000_00,
    rebateMax: 60_000_00,
    cessRate: 4,
    maxSurchargeRate: 25,
    note: 'FY 2025-26 new regime (Finance Act 2025) — rebate up to ₹12,00,000 taxable income.'
  },
  {
    fyStartYear: 2025,
    regime: 'old',
    slabs: [
      { upTo: 2_50_000_00, rate: 0 },
      { upTo: 5_00_000_00, rate: 5 },
      { upTo: 10_00_000_00, rate: 20 },
      { upTo: null, rate: 30 }
    ],
    standardDeduction: 50_000_00,
    rebateLimit: 5_00_000_00,
    rebateMax: 12_500_00,
    cessRate: 4,
    maxSurchargeRate: 37,
    note: 'FY 2025-26 old regime.'
  }
]

export interface ResolvedRates extends RegimeRates {
  /** True when no entry exists for the year asked for and an earlier year's was used. */
  assumedFromEarlierYear: boolean
}

export function ratesForFy(fyStartYear: number, regime: Regime): ResolvedRates {
  const forRegime = TAX_HISTORY.filter((r) => r.regime === regime).sort((a, b) => a.fyStartYear - b.fyStartYear)
  let chosen = forRegime[0] as RegimeRates
  for (const r of forRegime) if (r.fyStartYear <= fyStartYear) chosen = r
  return { ...chosen, assumedFromEarlierYear: chosen.fyStartYear !== fyStartYear }
}

/** Tax on an amount by slab, before rebate, surcharge and cess. Integer paise, floored. */
export function taxOnSlabs(taxableIncome: number, slabs: TaxSlab[]): number {
  if (taxableIncome <= 0) return 0
  let tax = 0
  let lower = 0
  for (const slab of slabs) {
    const upper = slab.upTo ?? Infinity
    if (taxableIncome <= lower) break
    const inThisSlab = Math.min(taxableIncome, upper) - lower
    if (inThisSlab > 0) tax += (inThisSlab * slab.rate) / 100
    lower = upper
  }
  return Math.floor(tax)
}

/**
 * Surcharge, with the marginal relief that stops a rupee of extra income costing lakhs of tax.
 *
 * Without relief, crossing ₹50,00,000 by ₹1 adds 10% surcharge on the whole tax — an increase far
 * larger than the extra income. The Act caps the total (tax + surcharge) increase at the increase
 * in income, and that cap is what marginal relief computes.
 */
export function surcharge(taxableIncome: number, baseTax: number, maxRate: number, slabs: TaxSlab[]): number {
  let rate = 0
  let threshold = 0
  for (const band of SURCHARGE_BANDS) {
    if (taxableIncome > band.above) {
      rate = Math.min(band.rate, maxRate)
      threshold = band.above
    }
  }
  if (rate === 0) return 0

  const raw = Math.floor((baseTax * rate) / 100)

  // At the threshold: what tax plus surcharge would have been on exactly the threshold income.
  const taxAtThreshold = taxOnSlabs(threshold, slabs)
  const bandBelow = SURCHARGE_BANDS.filter((b) => threshold > b.above).pop()
  const rateBelow = bandBelow ? Math.min(bandBelow.rate, maxRate) : 0
  const totalAtThreshold = taxAtThreshold + Math.floor((taxAtThreshold * rateBelow) / 100)

  const excessIncome = taxableIncome - threshold
  const capped = totalAtThreshold + excessIncome
  return baseTax + raw > capped ? Math.max(0, capped - baseTax) : raw
}

export interface TaxInput {
  /** Gross salary for the year, paise. */
  grossSalary: number
  /** Deductions the employee has declared and the employer accepts (80C, 80D, ...), paise.
   *  Ignored under the new regime, where almost none of them survive. */
  declaredDeductions?: number
  /** Professional tax paid — deductible under section 16(iii), old regime only. */
  professionalTax?: number
  regime: Regime
  fyStartYear: number
}

export interface TaxComputation {
  grossSalary: number
  standardDeduction: number
  /** 80C-style deductions actually allowed under the chosen regime. */
  chapterVIA: number
  professionalTaxAllowed: number
  taxableIncome: number
  taxBeforeRebate: number
  rebate: number
  surcharge: number
  cess: number
  /** What is payable for the whole year. */
  totalTax: number
  rates: ResolvedRates
}

/**
 * The year's tax on a salary.
 *
 * The new regime is the default and disallows almost every deduction, which is why
 * `declaredDeductions` and professional tax are silently dropped there rather than quietly
 * reducing the tax — the returned computation says what was allowed, so the payslip can too.
 */
export function computeAnnualTax(input: TaxInput): TaxComputation {
  const rates = ratesForFy(input.fyStartYear, input.regime)
  const chapterVIA = input.regime === 'old' ? (input.declaredDeductions ?? 0) : 0
  const ptAllowed = input.regime === 'old' ? (input.professionalTax ?? 0) : 0

  const taxableIncome = Math.max(0, input.grossSalary - rates.standardDeduction - ptAllowed - chapterVIA)
  const taxBeforeRebate = taxOnSlabs(taxableIncome, rates.slabs)

  let rebate = 0
  if (taxableIncome <= rates.rebateLimit) {
    rebate = Math.min(taxBeforeRebate, rates.rebateMax)
  } else {
    // Marginal relief on the rebate: just past the limit, the tax cannot exceed the income that
    // took you past it. Without this, ₹12,00,001 of income costs far more tax than ₹12,00,000.
    const excess = taxableIncome - rates.rebateLimit
    if (taxBeforeRebate > excess) rebate = taxBeforeRebate - excess
  }

  const afterRebate = Math.max(0, taxBeforeRebate - rebate)
  const sur = surcharge(taxableIncome, afterRebate, rates.maxSurchargeRate, rates.slabs)
  const cess = Math.floor(((afterRebate + sur) * rates.cessRate) / 100)

  return {
    grossSalary: input.grossSalary,
    standardDeduction: rates.standardDeduction,
    chapterVIA,
    professionalTaxAllowed: ptAllowed,
    taxableIncome,
    taxBeforeRebate,
    rebate,
    surcharge: sur,
    cess,
    totalTax: afterRebate + sur + cess,
    rates
  }
}

/**
 * TDS for one month under section 192: the year's tax, less what has already been deducted,
 * spread over the months that are left.
 *
 * Spreading over the remaining months rather than a flat twelfth is what makes a mid-year salary
 * revision or a late declaration correct itself instead of leaving a shortfall in March.
 */
export function monthlyTds(annualTax: number, alreadyDeducted: number, monthsRemaining: number): number {
  if (monthsRemaining <= 0) return Math.max(0, annualTax - alreadyDeducted)
  return Math.max(0, Math.ceil((annualTax - alreadyDeducted) / monthsRemaining))
}

/** Months left in the financial year, counting the given month itself. April = 12, March = 1. */
export function monthsLeftInFy(month: string): number {
  const m = Number(month.slice(5, 7))
  return m >= 4 ? 12 - (m - 4) : 4 - m
}

/** FY start year for a 'YYYY-MM' pay month: April to March. */
export function fyStartYearOf(month: string): number {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return m >= 4 ? y : y - 1
}
