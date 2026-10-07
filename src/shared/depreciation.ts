/**
 * Fixed-asset depreciation (WP 3.6) — pure maths shared by main (runs, schedule, disposals, IT
 * statement) and renderer (previews). No I/O, no DB.
 *
 * Two independent computations:
 *
 * 1. **Companies Act, 2013 — Schedule II (book depreciation, posted).** Asset by asset: the
 *    depreciable amount (cost − residual value) is allocated over the useful life, straight-line
 *    (SLM) or written-down value (WDV), pro rata to the days the asset is available for use.
 *    Sources (accessed 2026-10-07) are cited next to the seeded life table in
 *    src/main/db/migrations.ts (migration 026, "WP 3.6") and summarised in FIXED_ASSET_SOURCES
 *    below.
 *
 * 2. **Income-tax (block of assets, NOT posted).** Block by block: opening WDV + actual cost of
 *    additions − moneys payable on transfers, depreciation at the block rate, half the rate on
 *    additions put to use for less than 180 days in the year, and the s.50 / 2025-Act capital-gain
 *    figure when the block's WDV goes negative or the block ceases. No asset-level IT depreciation.
 *
 * ## Day count (documented convention)
 * A day counts when the asset is available for use on it: from the put-to-use date (inclusive)
 * up to the day BEFORE disposal (the disposal date itself is not charged). A full financial year
 * is its actual length (365 or 366 days) so a whole year always charges exactly the annual amount.
 *
 * ## Rounding (documented convention)
 * Money is integer paise. Every computed charge is ONE exact rational (amount × numerator ÷
 * denominator, in BigInt) rounded half away from zero to the paisa — per tranche (cost layer) per
 * period. Rates that are irrational (the WDV rate) are fixed first as integer parts-per-million
 * (`wdvRatePpb`, parts per billion), so the float only ever touches the rate, never an amount. A charge is capped so
 * the carrying amount never falls below the residual value, and the period that contains the end
 * of the useful life writes the carrying amount down to the residual exactly (so rounding never
 * leaves a stray paisa).
 */
import { fyOf, type FinancialYear } from './dates'

export type DepMethod = 'slm' | 'wdv'
export const DEP_METHODS: readonly DepMethod[] = ['slm', 'wdv'] as const
export const DEP_METHOD_LABELS: Record<DepMethod, string> = {
  slm: 'Straight line (SLM)',
  wdv: 'Written down value (WDV)'
}

// ---------------------------------------------------------------------------------------------
// Date + integer helpers
// ---------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000

function toUtc(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return Date.UTC(y, m - 1, d)
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function addDays(iso: string, n: number): string {
  return fromUtc(toUtc(iso) + n * DAY_MS)
}

/** Days from `from` to `to`, both inclusive; 0 when `to` is before `from`. */
export function daysInclusive(from: string, to: string): number {
  if (to < from) return 0
  return Math.round((toUtc(to) - toUtc(from)) / DAY_MS) + 1
}

/** Calendar months after `iso`, the day clamped to the target month's length (31 Jan + 1 = 28/29 Feb). */
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  const total = y * 12 + (m - 1) + months
  const ty = Math.floor(total / 12)
  const tm = total % 12
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate()
  return `${ty}-${String(tm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`
}

/** Last day of the useful life: put-to-use + life months − 1 day (10 years from 1 Apr 2025 ends 31 Mar 2035). */
export function lifeEndDate(putToUseDate: string, lifeMonths: number): string {
  return addDays(addMonths(putToUseDate, lifeMonths), -1)
}

const min = (a: string, b: string): string => (a < b ? a : b)
const max = (a: string, b: string): string => (a > b ? a : b)

/** Days of [a1, a2] ∩ [b1, b2], inclusive. */
export function overlapDays(a1: string, a2: string, b1: string, b2: string): number {
  return daysInclusive(max(a1, b1), min(a2, b2))
}

/** round(a × b ÷ c), half away from zero, exact (BigInt) — the single rounding step of every charge.
 *  Each argument must itself be a safe integer; the product is formed in BigInt. */
export function mulDivRound(a: number, b: number, c: number): number {
  if (c === 0) throw new Error('mulDivRound: division by zero')
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(c)) throw new Error('mulDivRound: arguments must be safe integers')
  const A = BigInt(Math.trunc(a))
  const B = BigInt(Math.trunc(b))
  const C = BigInt(Math.trunc(c))
  const num = A * B
  const neg = num < 0n !== C < 0n
  const n = num < 0n ? -num : num
  const d = C < 0n ? -C : C
  const q = (n * 2n + d) / (d * 2n)
  return Number(neg ? -q : q)
}

/** Residual value of `gross` at `residualBp` basis points (500 = 5%), rounded to the paisa. */
export function residualOf(gross: number, residualBp: number): number {
  return mulDivRound(gross, residualBp, 10_000)
}

/** Remaining life from `from` to `endExclusive` in thousandths of a month: whole calendar months
 *  plus the leftover days as a fraction of the month they fall in. From the put-to-use date it is
 *  exactly lifeMonths × 1000. */
export function remainingMilliMonths(from: string, endExclusive: string): number {
  if (endExclusive <= from) return 0
  let months = 0
  let cursor = from
  // Whole months first (bounded: a useful life is at most a few hundred months).
  for (;;) {
    const next = addMonths(from, months + 1)
    if (next > endExclusive) break
    months++
    cursor = next
  }
  const leftover = daysInclusive(cursor, addDays(endExclusive, -1))
  if (leftover === 0) return months * 1000
  const monthLen = daysInclusive(cursor, addDays(addMonths(cursor, 1), -1))
  return months * 1000 + Math.round((leftover * 1000) / monthLen)
}

/**
 * WDV rate (parts per billion) that writes `startAmount` down to `residual` over
 * `remainingMilliMonths`: rate = 1 − (residual / start)^(1 / years). This is the standard
 * derivation of a WDV rate from a Schedule II useful life (e.g. 5% residual, 10 years ⇒ 25.89%).
 * The float is used for the rate only and frozen to an integer here.
 */
export function wdvRatePpb(startAmount: number, residual: number, remainingMilliMonthsValue: number): number {
  if (startAmount <= 0 || remainingMilliMonthsValue <= 0) return 0
  if (residual <= 0) throw new Error('WDV needs a residual value above zero — use SLM, or set a residual value')
  if (residual >= startAmount) return 0
  const years = remainingMilliMonthsValue / 12_000
  return Math.round((1 - Math.pow(residual / startAmount, 1 / years)) * 1_000_000_000)
}

/** WDV rate for a fresh asset: depends only on the residual percentage and the life. */
export function wdvRatePpbForLife(residualBp: number, lifeMonths: number): number {
  return wdvRatePpb(10_000, residualBp, lifeMonths * 1000)
}

// ---------------------------------------------------------------------------------------------
// Companies Act, 2013 — Schedule II (per asset)
// ---------------------------------------------------------------------------------------------

export interface CostLayer {
  /** Available-for-use date of this cost (original cost: the put-to-use date) — depreciation
   *  runs from here. */
  date: string
  amount: number
  /** Date the cost entered the gross block (the purchase date); defaults to `date`. Only the
   *  gross / carrying figures read it — an asset bought but not yet in use is carried at cost. */
  bookedOn?: string
}

export interface CaAssetInput {
  method: DepMethod
  /** Residual value, basis points of cost (Schedule II Part A: normally not more than 5%). */
  residualBp: number
  /** Total useful life in months, counted from the put-to-use date. */
  lifeMonths: number
  putToUseDate: string
  /** Null while the asset is in service. Days from this date on are not charged. */
  disposalDate: string | null
  /** Original cost plus additions / improvements, each depreciated from its own date. An
   *  addition is depreciated over the REMAINING useful life of the asset (SLM) or at the asset's
   *  WDV rate (WDV). */
  layers: CostLayer[]
  /**
   * Date the current method / life / residual took effect. Equal to putToUseDate unless they were
   * changed later — a change of estimate is prospective (AS 10 / Ind AS 16 with AS 5 / Ind AS 8):
   * the carrying amount on this date is depreciated over the remaining life; nothing is restated.
   */
  basisDate: string
  /** Book accumulated depreciation before basisDate. Only read when basisDate > putToUseDate. */
  accBeforeBasis: number
  /** Book accumulated depreciation before the start of the period's financial year (opening
   *  accumulated depreciation + every live run, disposal catch-ups included). */
  accBeforeFy: number
  /** Depreciation already booked in the same financial year before the period starts. */
  accInFyBeforePeriod: number
  /** Last day already depreciated (a posted run's period end, the opening position's date, …);
   *  days on or before it are never charged twice. Null = nothing posted yet. */
  depreciatedThrough: string | null
}

export interface CaPeriodResult {
  /** Gross block at period start (cost layers dated before it). */
  openingGross: number
  /** Cost layers dated inside the period. */
  additions: number
  /** Carrying amount at period start (gross − accumulated depreciation). */
  openingWdv: number
  depreciation: number
  /** openingWdv + additions − depreciation. */
  closingWdv: number
  /** Days of the period the asset was available for use and not already depreciated. */
  daysUsed: number
  residual: number
  lifeEnd: string
  /** Closing carrying amount equals the residual value — nothing left to depreciate. */
  fullyDepreciated: boolean
  /** WDV only: the rate applied, parts per billion. */
  ratePpb: number | null
}

interface Tranche {
  /** Depreciable amount of the tranche (SLM) or its base (WDV). */
  amount: number
  start: string
}

/**
 * Schedule II depreciation of one asset for `period` (inside one financial year).
 *
 * SLM: each tranche's annual charge = depreciable amount × 12 ÷ remaining life in months at the
 * tranche's start; the period charge = annual × days used ÷ days in the FY. The original cost's
 * tranche starts on the put-to-use date with the full life, so a full year charges exactly
 * (cost − residual) ÷ life-in-years.
 *
 * WDV: the rate (wdvRatePpb) is applied to the carrying amount at the start of the FY, plus each
 * cost layer of the FY from its own date; the period charge = base × rate × days ÷ days in the FY.
 */
export function companiesActPeriod(a: CaAssetInput, period: { from: string; to: string }): CaPeriodResult {
  const fy: FinancialYear = fyOf(period.from)
  if (period.to < period.from || period.to > fy.to) throw new Error('A depreciation period must lie inside one financial year')
  if (a.lifeMonths <= 0) throw new Error('Useful life must be at least one month')
  const fyDays = daysInclusive(fy.from, fy.to)
  const lifeEnd = lifeEndDate(a.putToUseDate, a.lifeMonths)
  const lifeEndExcl = addDays(lifeEnd, 1)
  const lastChargeable = min(min(period.to, lifeEnd), a.disposalDate ? addDays(a.disposalDate, -1) : period.to)
  const firstChargeable = max(max(period.from, a.putToUseDate), a.depreciatedThrough ? addDays(a.depreciatedThrough, 1) : period.from)

  const live = a.layers.filter((l) => !a.disposalDate || l.date < a.disposalDate)
  const sum = (ls: CostLayer[]): number => ls.reduce((s, l) => s + l.amount, 0)
  const booked = (l: CostLayer): string => min(l.bookedOn ?? l.date, l.date)
  const openingGross = sum(live.filter((l) => booked(l) < period.from))
  const additions = sum(live.filter((l) => booked(l) >= period.from && booked(l) <= period.to))
  const grossEnd = openingGross + additions
  const residual = residualOf(grossEnd, a.residualBp)
  const openingWdv = openingGross - a.accBeforeFy - a.accInFyBeforePeriod
  const maxCharge = Math.max(0, openingWdv + additions - residual)

  const days = (start: string): number => daysInclusive(max(firstChargeable, start), lastChargeable)
  const daysUsed = days(a.putToUseDate)

  let raw = 0
  let ratePpb: number | null = null
  const changed = a.basisDate > a.putToUseDate
  if (a.method === 'slm') {
    const tranches: Tranche[] = []
    if (changed) {
      const before = live.filter((l) => l.date < a.basisDate)
      const carrying = sum(before) - a.accBeforeBasis
      tranches.push({ amount: Math.max(0, carrying - residualOf(sum(before), a.residualBp)), start: a.basisDate })
    }
    for (const l of live) {
      if (changed && l.date < a.basisDate) continue
      tranches.push({ amount: l.amount - residualOf(l.amount, a.residualBp), start: l.date })
    }
    for (const t of tranches) {
      const d = days(t.start)
      if (d === 0 || t.amount <= 0) continue
      const mm = t.start === a.putToUseDate ? a.lifeMonths * 1000 : remainingMilliMonths(t.start, lifeEndExcl)
      if (mm <= 0) continue
      raw += mulDivRound(t.amount, 12_000 * d, mm * fyDays)
    }
  } else {
    if (changed) {
      const before = live.filter((l) => l.date < a.basisDate)
      const carrying = sum(before) - a.accBeforeBasis
      ratePpb = wdvRatePpb(carrying, residualOf(sum(before), a.residualBp), remainingMilliMonths(a.basisDate, lifeEndExcl))
    } else {
      if (a.residualBp <= 0) throw new Error('WDV needs a residual value above zero — use SLM, or set a residual value')
      ratePpb = wdvRatePpbForLife(a.residualBp, a.lifeMonths)
    }
    // Base at the start of the FY, then each layer of this FY from its own date.
    const fyBase = sum(live.filter((l) => l.date < fy.from)) - a.accBeforeFy
    // (a layer booked before the FY but put to use inside it depreciates from its own date below)
    const tranches: Tranche[] = []
    if (fyBase > 0) tranches.push({ amount: fyBase, start: max(fy.from, a.putToUseDate) })
    for (const l of live) if (l.date >= fy.from) tranches.push({ amount: l.amount, start: l.date })
    for (const t of tranches) {
      const d = days(t.start)
      if (d === 0) continue
      raw += mulDivRound(t.amount, ratePpb * d, 1_000_000_000 * fyDays)
    }
  }

  // The period holding the last day of the useful life writes down to the residual exactly.
  const lifeEndsHere = lifeEnd >= firstChargeable && lifeEnd <= period.to && (!a.disposalDate || a.disposalDate > lifeEnd)
  const depreciation = lifeEndsHere ? maxCharge : Math.min(Math.max(0, raw), maxCharge)
  const closingWdv = openingWdv + additions - depreciation
  return {
    openingGross,
    additions,
    openingWdv,
    depreciation,
    closingWdv,
    daysUsed,
    residual,
    lifeEnd,
    fullyDepreciated: grossEnd > 0 && closingWdv <= residual,
    ratePpb
  }
}

// ---------------------------------------------------------------------------------------------
// Disposal
// ---------------------------------------------------------------------------------------------

export interface DisposalFigures {
  gross: number
  accumulated: number
  carrying: number
  proceeds: number
  /** Positive = profit on sale, negative = loss. */
  profit: number
}

export function disposalFigures(gross: number, accumulated: number, proceeds: number): DisposalFigures {
  const carrying = gross - accumulated
  return { gross, accumulated, carrying, proceeds, profit: proceeds - carrying }
}

export interface DisposalLine {
  ledgerId: number
  drCr: 'dr' | 'cr'
  amount: number
}

/**
 * Journal lines of a sale / scrap: Dr consideration (cash, bank or the buyer) with the proceeds,
 * Dr accumulated depreciation (booked + `catchUp`), Cr the asset with its gross cost, Dr
 * depreciation expense with the catch-up up to the disposal date, and the balancing Dr loss /
 * Cr profit on sale. Zero lines are dropped. The lines always balance.
 */
export function disposalLines(input: {
  gross: number
  accumulatedBooked: number
  catchUp: number
  proceeds: number
  assetLedgerId: number
  accDepLedgerId: number
  depExpenseLedgerId: number
  considerationLedgerId: number | null
  profitLedgerId: number
  lossLedgerId: number
}): { lines: DisposalLine[]; figures: DisposalFigures } {
  const figures = disposalFigures(input.gross, input.accumulatedBooked + input.catchUp, input.proceeds)
  const lines: DisposalLine[] = []
  const push = (ledgerId: number, drCr: 'dr' | 'cr', amount: number): void => {
    if (amount > 0) lines.push({ ledgerId, drCr, amount })
  }
  if (input.proceeds > 0 && input.considerationLedgerId == null) throw new Error('Pick the cash, bank or party account the sale proceeds go to')
  if (input.considerationLedgerId != null) push(input.considerationLedgerId, 'dr', input.proceeds)
  push(input.depExpenseLedgerId, 'dr', input.catchUp)
  // Accumulated depreciation: the catch-up is credited and the whole balance written back in one
  // net debit of what was booked before (the catch-up legs cancel on the same ledger).
  push(input.accDepLedgerId, 'dr', input.accumulatedBooked)
  push(input.assetLedgerId, 'cr', input.gross)
  if (figures.profit > 0) push(input.profitLedgerId, 'cr', figures.profit)
  if (figures.profit < 0) push(input.lossLedgerId, 'dr', -figures.profit)
  return { lines, figures }
}

// ---------------------------------------------------------------------------------------------
// Asset schedule (Schedule III note: gross block, depreciation, net block)
// ---------------------------------------------------------------------------------------------

export interface ScheduleAssetMovement {
  groupId: number
  grossOpening: number
  grossAdditions: number
  grossDisposals: number
  accOpening: number
  /** Depreciation charged in the period (runs + disposal catch-ups). */
  accCharge: number
  /** Accumulated depreciation written back on disposals in the period. */
  accDisposals: number
}

export interface ScheduleTotals {
  grossOpening: number
  grossAdditions: number
  grossDisposals: number
  grossClosing: number
  accOpening: number
  accCharge: number
  accDisposals: number
  accClosing: number
  netOpening: number
  netClosing: number
}

export function scheduleTotals(rows: Omit<ScheduleAssetMovement, 'groupId'>[]): ScheduleTotals {
  const t = rows.reduce(
    (s, r) => ({
      grossOpening: s.grossOpening + r.grossOpening,
      grossAdditions: s.grossAdditions + r.grossAdditions,
      grossDisposals: s.grossDisposals + r.grossDisposals,
      accOpening: s.accOpening + r.accOpening,
      accCharge: s.accCharge + r.accCharge,
      accDisposals: s.accDisposals + r.accDisposals
    }),
    { grossOpening: 0, grossAdditions: 0, grossDisposals: 0, accOpening: 0, accCharge: 0, accDisposals: 0 }
  )
  const grossClosing = t.grossOpening + t.grossAdditions - t.grossDisposals
  const accClosing = t.accOpening + t.accCharge - t.accDisposals
  return { ...t, grossClosing, accClosing, netOpening: t.grossOpening - t.accOpening, netClosing: grossClosing - accClosing }
}

// ---------------------------------------------------------------------------------------------
// Income-tax — block of assets (computation only, never posted)
// ---------------------------------------------------------------------------------------------

/** Assets put to use for less than this many days in the year of acquisition get half the rate
 *  (1961 Act s.32(1) second proviso; Income-tax Act 2025 — see migration 026 citations). */
export const IT_HALF_RATE_DAYS = 180

export interface ItAddition {
  /** Date the asset was first put to use (the 180-day test runs from here to 31 March). */
  putToUseDate: string
  amount: number
  /** Eligible for additional depreciation (new plant & machinery of a manufacturer, …). */
  additionalEligible?: boolean
}

export interface ItBlockInput {
  fy: FinancialYear
  rateBp: number
  openingWdv: number
  additions: ItAddition[]
  /** Moneys payable (sale price / scrap value) on assets of the block transferred in the year. */
  saleProceeds: number
  /** No asset of the block remains at the end of the year (every asset transferred). */
  blockCeases: boolean
  /** Additional-depreciation rate in bp (0 / undefined = none). */
  additionalRateBp?: number
  /** Unclaimed half of additional depreciation brought from the previous year. */
  additionalBroughtForward?: number
}

export interface ItBlockResult {
  openingWdv: number
  /** Additions put to use for 180 days or more in the year. */
  additionsFullRate: number
  /** Additions put to use for less than 180 days in the year. */
  additionsHalfRate: number
  saleProceeds: number
  /** opening + additions − sale proceeds (may be negative). */
  wdvBeforeDepreciation: number
  depreciationFullRate: number
  depreciationHalfRate: number
  additionalDepreciation: number
  additionalCarriedForward: number
  totalDepreciation: number
  closingWdv: number
  /** Positive: short-term capital gain (sale proceeds exceed opening WDV + additions). */
  shortTermCapitalGain: number
  /** Positive: short-term capital loss (block ceased with WDV left). */
  shortTermCapitalLoss: number
}

export function putToUseDaysInYear(putToUseDate: string, fy: FinancialYear): number {
  return daysInclusive(max(putToUseDate, fy.from), fy.to)
}

/**
 * Block computation for one financial year. Sale proceeds reduce the full-rate base first; only
 * what exceeds it eats into the half-rate additions (the usual reading of the second proviso —
 * listed as UNVERIFIED in migration 026). Rounding: each depreciation figure is rounded half away
 * from zero to the paisa (the return itself rounds total income to ₹10, not done here).
 */
export function itBlockYear(input: ItBlockInput): ItBlockResult {
  let full = 0
  let half = 0
  for (const a of input.additions) {
    if (putToUseDaysInYear(a.putToUseDate, input.fy) < IT_HALF_RATE_DAYS) half += a.amount
    else full += a.amount
  }
  const total = input.openingWdv + full + half - input.saleProceeds
  const base: ItBlockResult = {
    openingWdv: input.openingWdv,
    additionsFullRate: full,
    additionsHalfRate: half,
    saleProceeds: input.saleProceeds,
    wdvBeforeDepreciation: total,
    depreciationFullRate: 0,
    depreciationHalfRate: 0,
    additionalDepreciation: 0,
    additionalCarriedForward: 0,
    totalDepreciation: 0,
    closingWdv: 0,
    shortTermCapitalGain: 0,
    shortTermCapitalLoss: 0
  }
  if (total < 0) return { ...base, shortTermCapitalGain: -total }
  if (input.blockCeases) return { ...base, shortTermCapitalLoss: total }
  if (total === 0) return base

  let fullBase = input.openingWdv + full - input.saleProceeds
  let halfBase = half
  if (fullBase < 0) {
    halfBase += fullBase
    fullBase = 0
  }
  const depFull = mulDivRound(fullBase, input.rateBp, 10_000)
  const depHalf = mulDivRound(halfBase, input.rateBp, 20_000)

  let additional = input.additionalBroughtForward ?? 0
  let carried = 0
  const addl = input.additionalRateBp ?? 0
  if (addl > 0) {
    for (const a of input.additions) {
      if (!a.additionalEligible) continue
      if (putToUseDaysInYear(a.putToUseDate, input.fy) < IT_HALF_RATE_DAYS) {
        const now = mulDivRound(a.amount, addl, 20_000)
        additional += now
        carried += mulDivRound(a.amount, addl, 10_000) - now
      } else {
        additional += mulDivRound(a.amount, addl, 10_000)
      }
    }
  }
  // Depreciation can never take the block below zero.
  const normal = Math.min(depFull + depHalf, total)
  additional = Math.min(additional, total - normal)
  const totalDep = normal + additional
  return {
    ...base,
    depreciationFullRate: Math.min(depFull, normal),
    depreciationHalfRate: normal - Math.min(depFull, normal),
    additionalDepreciation: additional,
    additionalCarriedForward: carried,
    totalDepreciation: totalDep,
    closingWdv: total - totalDep
  }
}
