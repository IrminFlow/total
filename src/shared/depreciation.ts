/**
 * Depreciation, computed twice, because the law asks for two different numbers.
 *
 * The Companies Act wants depreciation **per asset**, over the useful life in Schedule II, by
 * straight line or written-down value, pro-rated from the day the asset was put to use. The
 * Income-tax Act wants it **per block of assets** — every asset attracting the same rate pooled
 * into one written-down value — with a half-rate year for anything put to use for less than 180
 * days, and no pro-rating at all otherwise.
 *
 * They give different answers on purpose. Doing one and calling it depreciation is the mistake
 * this file exists to prevent: the first goes in the books, the second goes in the return, and
 * the difference between them is a deferred tax the accountant has to see.
 *
 * **Rates and useful lives below must be checked against the current notification before use.**
 * All amounts are integer paise; nothing here posts anything.
 */

export type DepreciationMethod = 'slm' | 'wdv'

// ---------- Companies Act, Schedule II ----------

/**
 * Residual value is capped at 5% of original cost under Schedule II — a company may assume less,
 * never more, without justifying it in the accounts.
 */
export const MAX_RESIDUAL_PERCENT = 5

/** Useful lives in years, from Schedule II. A starting point for the master, not a constraint. */
export const SCHEDULE_II_LIVES: { category: string; years: number }[] = [
  { category: 'Buildings — RCC frame', years: 60 },
  { category: 'Buildings — other than RCC', years: 30 },
  { category: 'Plant and machinery — general', years: 15 },
  { category: 'Furniture and fittings', years: 10 },
  { category: 'Office equipment', years: 5 },
  { category: 'Computers and laptops', years: 3 },
  { category: 'Servers and networks', years: 6 },
  { category: 'Motor vehicles — commercial', years: 8 },
  { category: 'Motor vehicles — other', years: 10 },
  { category: 'Electrical installations', years: 10 }
]

export interface CompaniesActAsset {
  cost: number
  /** Paise expected at the end of the useful life. Capped at 5% of cost by Schedule II. */
  residualValue: number
  usefulLifeMonths: number
  method: DepreciationMethod
  /** The day depreciation starts — when the asset was put to use, not when it was bought. */
  putToUseDate: string
  /** Written-down value at the start of the year being computed. */
  openingWdv: number
  /** Accumulated depreciation to date, so a fully depreciated asset stops. */
  accumulated: number
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/**
 * The WDV rate implied by a useful life and a residual value.
 *
 * Schedule II gives lives, not rates: the rate is whatever reduces cost to the residual value
 * over that life, which is `1 − (residual/cost)^(1/years)`. A zero residual has no such rate —
 * no percentage ever reaches zero — so a nominal ₹1 is assumed, which is the convention.
 */
export function wdvRateFor(cost: number, residualValue: number, usefulLifeMonths: number): number {
  if (cost <= 0 || usefulLifeMonths <= 0) return 0
  const residual = Math.max(1, residualValue)
  if (residual >= cost) return 0
  const years = usefulLifeMonths / 12
  return 1 - Math.pow(residual / cost, 1 / years)
}

export interface CompaniesActResult {
  /** Depreciation for the year, integer paise. */
  depreciation: number
  /** Fraction of the year the asset was held, 0-1. */
  heldFraction: number
  closingWdv: number
  /** True when the charge was trimmed so the asset does not fall below its residual value. */
  cappedAtResidual: boolean
  /** The WDV rate used, as a fraction. Zero for straight line. */
  wdvRate: number
}

/**
 * One asset's depreciation for one financial year under the Companies Act.
 *
 * Pro-rated by days, which is what "from the date it is put to use" means in practice. An asset
 * bought in March earns eighteen days of depreciation, not a month's and not a year's.
 *
 * `heldUntil` is the day the asset stopped being held — a disposal date. It shortens the *held*
 * period without shortening the year: passing a disposal date as `fyTo` instead would make the
 * denominator shrink with the numerator and hand a mid-year sale a full year's charge.
 *
 * The charge is trimmed rather than allowed to run past the residual value: a schedule that
 * depreciates an asset to less than its scrap value has stopped describing anything real.
 */
export function depreciateCompaniesAct(
  asset: CompaniesActAsset,
  fyFrom: string,
  fyTo: string,
  heldUntil?: string
): CompaniesActResult {
  const daysInYear = daysBetween(fyFrom, fyTo) + 1
  const lastDay = heldUntil && heldUntil < fyTo ? heldUntil : fyTo
  const start = asset.putToUseDate > fyFrom ? asset.putToUseDate : fyFrom
  const heldDays = asset.putToUseDate > lastDay ? 0 : daysBetween(start, lastDay) + 1
  const heldFraction = daysInYear > 0 ? Math.max(0, Math.min(1, heldDays / daysInYear)) : 0

  const depreciableFloor = Math.max(asset.residualValue, 0)
  const remaining = Math.max(0, asset.openingWdv - depreciableFloor)
  if (remaining === 0 || heldFraction === 0) {
    return {
      depreciation: 0,
      heldFraction,
      closingWdv: asset.openingWdv,
      cappedAtResidual: remaining === 0,
      wdvRate: 0
    }
  }

  let full: number
  let wdvRate = 0
  if (asset.method === 'slm') {
    const years = asset.usefulLifeMonths / 12
    full = years > 0 ? (asset.cost - depreciableFloor) / years : 0
  } else {
    wdvRate = wdvRateFor(asset.cost, asset.residualValue, asset.usefulLifeMonths)
    full = asset.openingWdv * wdvRate
  }

  const charge = Math.floor(full * heldFraction)
  const capped = charge > remaining
  const depreciation = Math.max(0, capped ? remaining : charge)

  return {
    depreciation,
    heldFraction,
    closingWdv: asset.openingWdv - depreciation,
    cappedAtResidual: capped,
    wdvRate
  }
}

// ---------- Income-tax Act: blocks of assets ----------

/** The half-rate threshold: put to use for fewer than this many days in the year of acquisition. */
export const HALF_RATE_DAYS = 180

/**
 * The common blocks and their written-down-value rates.
 *
 * A starting point for a new company's master, not a substitute for checking the notification.
 * Rates are whole percent.
 */
export const IT_BLOCKS: { name: string; rate: number }[] = [
  { name: 'Buildings — residential', rate: 5 },
  { name: 'Buildings — other', rate: 10 },
  { name: 'Furniture and fittings', rate: 10 },
  { name: 'Plant and machinery — general', rate: 15 },
  { name: 'Motor vehicles', rate: 15 },
  { name: 'Computers and software', rate: 40 },
  { name: 'Intangible assets', rate: 25 }
]

export interface BlockAddition {
  cost: number
  putToUseDate: string
  /** Days the asset was put to use in this year — computed by the caller from the FY end. */
  daysInUse: number
}

export interface BlockInput {
  blockName: string
  rate: number
  openingWdv: number
  additions: BlockAddition[]
  /** Sale consideration for assets taken out of the block this year, paise. */
  deletions: number
}

export interface BlockResult {
  blockName: string
  rate: number
  openingWdv: number
  /** Additions used for at least 180 days — the full rate applies. */
  additionsFullRate: number
  /** Additions used for less than 180 days — half the rate applies. */
  additionsHalfRate: number
  deletions: number
  /** Opening + additions − deletions, before depreciation. */
  writtenDownBeforeDepreciation: number
  depreciation: number
  closingWdv: number
  /**
   * Set when the block's value went to zero or negative — no depreciation is allowed, and the
   * excess is a short-term capital gain the accountant has to deal with separately.
   */
  blockExhausted: boolean
  /** Positive when deletions exceeded the block: a short-term capital gain under section 50. */
  shortTermGain: number
}

/**
 * One block's depreciation for one year under section 32.
 *
 * The block, not the asset, is the unit: assets attracting the same rate are pooled, sales reduce
 * the pool rather than producing a gain or loss, and depreciation is charged on what is left. No
 * pro-rating by days — an asset either earns the full rate or, if it was put to use for fewer
 * than 180 days in the year it was acquired, exactly half of it.
 *
 * If deletions exhaust the block, no depreciation is allowed at all and the excess becomes a
 * short-term capital gain. That is stated rather than silently floored at zero, because it is a
 * number that has to go somewhere else in the return.
 */
export function depreciateBlock(block: BlockInput): BlockResult {
  const full = block.additions.filter((a) => a.daysInUse >= HALF_RATE_DAYS).reduce((s, a) => s + a.cost, 0)
  const half = block.additions.filter((a) => a.daysInUse < HALF_RATE_DAYS).reduce((s, a) => s + a.cost, 0)
  const before = block.openingWdv + full + half - block.deletions

  if (before <= 0) {
    return {
      blockName: block.blockName,
      rate: block.rate,
      openingWdv: block.openingWdv,
      additionsFullRate: full,
      additionsHalfRate: half,
      deletions: block.deletions,
      writtenDownBeforeDepreciation: before,
      depreciation: 0,
      closingWdv: 0,
      blockExhausted: true,
      shortTermGain: Math.max(0, -before)
    }
  }

  // Deletions come off the full-rate pool first — the half-rate concession applies to what was
  // actually added and kept, and reducing the half-rate pool first would overstate the charge.
  const fullPool = Math.max(0, block.openingWdv + full - block.deletions)
  const halfPool = Math.max(0, before - fullPool)

  const depreciation =
    Math.floor((fullPool * block.rate) / 100) + Math.floor((halfPool * block.rate) / 200)

  return {
    blockName: block.blockName,
    rate: block.rate,
    openingWdv: block.openingWdv,
    additionsFullRate: full,
    additionsHalfRate: half,
    deletions: block.deletions,
    writtenDownBeforeDepreciation: before,
    depreciation,
    closingWdv: before - depreciation,
    blockExhausted: false,
    shortTermGain: 0
  }
}

/** Days an asset was in use during a financial year, for the 180-day test. */
export function daysInUseDuring(putToUseDate: string, fyFrom: string, fyTo: string): number {
  if (putToUseDate > fyTo) return 0
  const start = putToUseDate > fyFrom ? putToUseDate : fyFrom
  return Math.max(0, daysBetween(start, fyTo) + 1)
}

// ---------- disposal (roadmap #368) ----------

export interface DisposalResult {
  /** Book value on the day it left, under the Companies Act. */
  bookValue: number
  proceeds: number
  /** Positive is a profit on sale, negative a loss. Companies Act only. */
  profitOrLoss: number
  /**
   * Under the Income-tax Act there is no profit or loss on an individual asset: the proceeds
   * simply reduce the block. Stated so the two treatments are visibly different rather than
   * quietly conflated.
   */
  incomeTaxTreatment: string
}

export function disposeAsset(bookValue: number, proceeds: number, blockName: string): DisposalResult {
  return {
    bookValue,
    proceeds,
    profitOrLoss: proceeds - bookValue,
    incomeTaxTreatment: `Reduces the "${blockName}" block by ${proceeds} paise; no gain or loss on the asset itself`
  }
}
