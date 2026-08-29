/**
 * Bonus and gratuity — the two payments a business owes by law and forgets to compute.
 *
 * Both are statutory formulas with famously fiddly edges: bonus is calculated on a *capped* wage
 * that is not the wage anybody is paid, and gratuity rounds a part-year up or down at six months
 * and one day. Getting either slightly wrong is a labour-court matter, so both are computed here
 * in integer paise with every intermediate figure returned, and neither posts anything by itself.
 *
 * These are the Central Acts. A state with a higher minimum wage changes the bonus base, and a
 * company that pays better than the Act simply pays more — so the caller can override the base
 * and the percentage, and the result says which was used.
 */

// ---------- Payment of Bonus Act, 1965 ----------

/** Monthly salary at or below which an employee is eligible for statutory bonus. */
export const BONUS_ELIGIBILITY_LIMIT = 21_000_00
/** Salary the bonus is calculated on, when actual salary exceeds it. */
export const BONUS_CALCULATION_CEILING = 7_000_00
export const BONUS_MIN_PERCENT = 8.33
export const BONUS_MAX_PERCENT = 20
/** Days worked in the year below which there is no entitlement. */
export const BONUS_MIN_DAYS = 30

export interface BonusInput {
  /** Monthly basic + DA, paise. Eligibility is tested on this. */
  monthlySalary: number
  /** Days actually worked in the accounting year. */
  daysWorked: number
  /** Months to pay for — normally 12, fewer for a mid-year joiner. */
  monthsPayable: number
  /** Percent to pay; defaults to the statutory minimum. Clamped to 8.33-20. */
  percent?: number
  /**
   * The state minimum wage, where it exceeds ₹7,000 — the Act calculates on whichever is higher.
   * Paise per month; omit when it does not apply.
   */
  minimumWage?: number
}

export interface BonusResult {
  eligible: boolean
  /** Why not, when not — shown rather than leaving a zero to be explained. */
  reason: string | null
  /** The monthly figure the bonus is actually computed on. */
  calculationBase: number
  percent: number
  monthsPayable: number
  amount: number
}

export function statutoryBonus(input: BonusInput): BonusResult {
  const percent = Math.min(BONUS_MAX_PERCENT, Math.max(BONUS_MIN_PERCENT, input.percent ?? BONUS_MIN_PERCENT))
  const ceiling = Math.max(BONUS_CALCULATION_CEILING, input.minimumWage ?? 0)
  const calculationBase = Math.min(input.monthlySalary, ceiling)

  if (input.monthlySalary > BONUS_ELIGIBILITY_LIMIT) {
    return {
      eligible: false,
      reason: `Salary above the ₹21,000 eligibility limit`,
      calculationBase,
      percent,
      monthsPayable: 0,
      amount: 0
    }
  }
  if (input.daysWorked < BONUS_MIN_DAYS) {
    return {
      eligible: false,
      reason: `Worked ${input.daysWorked} days — the Act requires 30`,
      calculationBase,
      percent,
      monthsPayable: 0,
      amount: 0
    }
  }

  const months = Math.max(0, Math.min(12, input.monthsPayable))
  return {
    eligible: true,
    reason: null,
    calculationBase,
    percent,
    monthsPayable: months,
    // Floored: a bonus is a statutory minimum, and paying a paisa more than computed is the
    // employer's choice to make rather than a rounding artefact.
    amount: Math.floor((calculationBase * months * percent) / 100)
  }
}

// ---------- Payment of Gratuity Act, 1972 ----------

/** Completed years of service below which there is no gratuity (death/disablement aside). */
export const GRATUITY_MIN_YEARS = 5
/** Lifetime tax-free ceiling. */
export const GRATUITY_CEILING = 20_00_000_00
/** The Act's formula: 15 days' wages for each completed year, on a 26-day month. */
export const GRATUITY_DAYS = 15
export const GRATUITY_MONTH_DAYS = 26

export interface GratuityInput {
  /** Last drawn basic + DA per month, paise. */
  lastDrawnMonthly: number
  joined: string
  /** Last working day. */
  left: string
  /**
   * Death or permanent disablement waives the five-year qualifying period. A resignation does not,
   * and quietly paying gratuity to a four-year leaver would be a gift the books cannot explain.
   */
  waiveMinimum?: boolean
}

export interface GratuityResult {
  eligible: boolean
  reason: string | null
  /** Whole years counted, after the six-month rounding rule. */
  countedYears: number
  /** Actual service, for the statement. */
  serviceYears: number
  serviceMonths: number
  serviceDays: number
  /** Before the lifetime ceiling is applied. */
  computed: number
  /** Paid amount — computed, capped at the ceiling. */
  amount: number
  cappedByCeiling: boolean
}

/**
 * Years, months and days of service, counted the way a calendar counts.
 *
 * Done by advancing from the joining date rather than subtracting the two dates field by field:
 * someone who joined on the 31st has no anniversary in February, and a naive subtraction produces
 * a negative day count that has to be patched with a guess about how long "a month" is. Advancing
 * and clamping to the month end gives the answer a person would give — 31 Jan to 1 Mar is one
 * month and a day.
 */
export function serviceLength(joined: string, left: string): { years: number; months: number; days: number } {
  const [jy, jm, jd] = joined.split('-').map(Number) as [number, number, number]
  const [ly, lm, ld] = left.split('-').map(Number) as [number, number, number]
  if (left < joined) return { years: 0, months: 0, days: 0 }

  let totalMonths = (ly - jy) * 12 + (lm - jm)
  if (ld < jd) totalMonths -= 1
  if (totalMonths < 0) totalMonths = 0

  const anchorIndex = jm - 1 + totalMonths
  const ay = jy + Math.floor(anchorIndex / 12)
  const am = (anchorIndex % 12) + 1
  const monthEnd = new Date(Date.UTC(ay, am, 0)).getUTCDate()
  const ad = Math.min(jd, monthEnd)
  const days = Math.round((Date.parse(left) - Date.UTC(ay, am - 1, ad)) / 86_400_000)

  return { years: Math.floor(totalMonths / 12), months: totalMonths % 12, days: Math.max(0, days) }
}

export function gratuity(input: GratuityInput): GratuityResult {
  const { years, months, days } = serviceLength(input.joined, input.left)
  // The Act's rounding: a part-year of more than six months counts as a full year, less does not.
  const countedYears = months > 6 || (months === 6 && days > 0) ? years + 1 : years

  if (years < GRATUITY_MIN_YEARS && !input.waiveMinimum) {
    return {
      eligible: false,
      reason: `${years} year${years === 1 ? '' : 's'} of service — the Act requires 5`,
      countedYears,
      serviceYears: years,
      serviceMonths: months,
      serviceDays: days,
      computed: 0,
      amount: 0,
      cappedByCeiling: false
    }
  }

  const computed = Math.floor((input.lastDrawnMonthly * GRATUITY_DAYS * countedYears) / GRATUITY_MONTH_DAYS)
  const amount = Math.min(computed, GRATUITY_CEILING)
  return {
    eligible: true,
    reason: null,
    countedYears,
    serviceYears: years,
    serviceMonths: months,
    serviceDays: days,
    computed,
    amount,
    cappedByCeiling: computed > GRATUITY_CEILING
  }
}

/** "15/26 × ₹30,000 × 7 years" — the working, for the settlement statement. */
export function describeGratuity(input: GratuityInput, result: GratuityResult): string {
  const rupees = (p: number): string => (p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })
  return `${GRATUITY_DAYS}/${GRATUITY_MONTH_DAYS} × ₹${rupees(input.lastDrawnMonthly)} × ${result.countedYears} year${
    result.countedYears === 1 ? '' : 's'
  }`
}
