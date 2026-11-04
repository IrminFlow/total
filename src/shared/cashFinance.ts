/**
 * Cash and finance (WP 4.4) — IPC input schemas and the row shapes main returns, shared by main
 * and renderer. The maths lives in ./cashForecast.ts and ./forex.ts.
 */
import { z } from 'zod'
import { isoDate } from './schemas'
import type { CollectionProfile, ForecastFlow, ItemCadence, ItemKind } from './cashForecast'

const id = z.number().int().positive()
const paise = z.number().int().safe()
const currencyCode = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Expected a 3-letter currency code')
const rateMicro = z.number().int().positive().max(1_000_000_000_000)

// ---------- forecast ----------

export const forecastItemInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    /** Positive for inflow / outflow; signed for an adjustment (+ in, − out). */
    amount: paise.refine((v) => v !== 0, 'Amount cannot be zero'),
    cadence: z.enum(['once', 'weekly', 'monthly', 'quarterly', 'yearly']),
    startDate: isoDate,
    endDate: isoDate.nullable().default(null),
    kind: z.enum(['inflow', 'outflow', 'adjustment']),
    active: z.boolean().default(true),
    note: z.string().trim().max(200).nullable().default(null)
  })
  .refine((v) => v.kind === 'adjustment' || v.amount > 0, { message: 'Inflow and outflow amounts are positive', path: ['amount'] })
  .refine((v) => v.endDate == null || v.endDate >= v.startDate, { message: 'End date is before the start date', path: ['endDate'] })
export type ForecastItemInput = z.input<typeof forecastItemInputSchema>

export interface ForecastItem {
  id: number
  name: string
  amount: number
  cadence: ItemCadence
  startDate: string
  endDate: string | null
  kind: ItemKind
  active: boolean
  note: string | null
}

export const forecastBaseSchema = z.object({
  asOn: isoDate,
  /** Horizon end (inclusive) — flows past it are still returned (the engine marks them beyond). */
  to: isoDate
})

export interface ForecastCashLedger {
  ledgerId: number
  name: string
  kind: 'cash' | 'bank'
  balance: number
}

/** forecast:base — everything the renderer needs to run buildForecast under any scenario. */
export interface ForecastBase {
  asOn: string
  /** Σ cash + bank balances as on asOn (= the trial balance's cash and bank ledgers). */
  openingCash: number
  cashLedgers: ForecastCashLedger[]
  flows: ForecastFlow[]
  receivableProfile: CollectionProfile
  /** Sources that could not be read (one failing never blanks the forecast). */
  warnings: string[]
}

// ---------- forex ----------

export const fxRateInputSchema = z.object({
  date: isoDate,
  currencyCode,
  rateMicro,
  note: z.string().trim().max(120).nullable().default(null)
})
export type FxRateInput = z.input<typeof fxRateInputSchema>

export interface FxRate {
  id: number
  date: string
  currencyCode: string
  rateMicro: number
  note: string | null
}

export const fxLedgerCurrencySchema = z.object({
  ledgerId: id,
  currencyCode: currencyCode.nullable(),
  /** Foreign amount (hundredths, dr-positive) behind the ledger's rupee opening; null = none. */
  openingFc: z.number().int().safe().nullable().default(null)
})

/** A foreign-currency opening entered in its currency: the rupee opening (ledgers.opening_balance)
 *  becomes fc × the rate on the books-begin day (`rateMicro`, else the closing rate stored for
 *  that day or the latest before it). */
export const fxForeignOpeningSchema = z.object({
  ledgerId: id,
  currencyCode,
  /** Foreign amount (hundredths, dr-positive: negative = a credit opening). */
  fc: z.number().int().safe().refine((v) => v !== 0, 'Enter the foreign amount'),
  rateMicro: z.number().int().positive().safe().optional()
})
export type FxForeignOpeningInput = z.input<typeof fxForeignOpeningSchema>

export interface FxForeignOpeningResult { ledgerId: number; currencyCode: string; fc: number; openingInr: number; rateMicro: number; rateDate: string | null; booksBegin: string }

export interface FxOpenBill { name: string; voucherId: number | null; date: string; fcOpen: number; bookOpen: number }

export const fxAsOfSchema = z.object({ asOf: isoDate })

export const fxRevaluePostSchema = z.object({
  asOf: isoDate,
  /** Post the reversal dated the next day (Tally-style adjustment). */
  autoReverse: z.boolean().default(true)
})

export const fxSettleInputSchema = z.object({
  partyLedgerId: id,
  bankLedgerId: id,
  date: isoDate,
  /** Foreign amount settled, hundredths of the currency — spread over the open bills oldest
   *  first when `bills` is empty. */
  fcAmount: z.number().int().positive().safe().optional(),
  /** Bill-wise: the foreign amount taken off each open bill (by its name). */
  bills: z.array(z.object({ name: z.string().min(1).max(80), fc: z.number().int().positive().safe() })).max(100).default([]),
  settleRateMicro: rateMicro,
  narration: z.string().trim().max(200).nullable().default(null)
})
export type FxSettleInput = z.input<typeof fxSettleInputSchema>

export interface FxExposureRow {
  ledgerId: number
  ledgerName: string
  kind: 'receivable' | 'payable' | 'bank'
  currencyCode: string
  /** Signed fc minor, dr-positive. */
  fcBalance: number
  /** Signed paise, dr-positive (book value of the foreign-currency lines). */
  inrBook: number
  carryingRateMicro: number | null
  /** Closing rate on or before the as-of date (null = none entered yet). */
  closingRateMicro: number | null
  closingRateDate: string | null
  /** Restated value at the closing rate, and the unrealised gain (+) / loss (−). */
  target: number | null
  gainLoss: number | null
  /** Rupee lines on the ledger without a foreign amount — not foreign money, never revalued. */
  rupeeLines: number
}

export interface FxRevaluationPreview {
  asOf: string
  rows: FxExposureRow[]
  /** Currencies with an open balance but no closing rate on or before asOf. */
  missingRates: string[]
  gain: number
  loss: number
  /** Why posting is refused, if it is. */
  blocked: string | null
}

export interface FxRevaluationRow {
  id: number
  asOf: string
  voucherId: number | null
  voucherNumber: string | null
  reversalVoucherId: number | null
  reversalVoucherNumber: string | null
  autoReverse: boolean
  gain: number
  loss: number
  createdAt: string
  live: boolean
}

export interface FxSettleResult {
  /** The one settlement voucher (Receipt / Payment, or Journal when the difference sits on the money side). */
  voucherId: number
  bills: { name: string; voucherId: number | null; fc: number; bookInr: number }[]
  bankInr: number
  partyInr: number
  gainLoss: number
}

// ---------- year-end ----------

export interface CashFinanceCloseWarnings {
  unrevalued: { currencyCode: string; ledgers: number; fcBalance: number }[]
  /** No revaluation as on the FY's last day while foreign balances were open. */
  revaluedOnFyEnd: boolean
}
