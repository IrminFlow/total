/**
 * Cash and finance (WP 4.4) — IPC input schemas and the row shapes main returns, shared by main
 * and renderer. The maths lives in ./cashForecast.ts and ./forex.ts.
 */
import { z } from 'zod'
import { isoDate } from './schemas'
import type { CollectionProfile, ForecastFlow, ItemCadence, ItemKind } from './cashForecast'

const id = z.number().int().positive()
const paise = z.number().int().safe()

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

// ---------- forex (read-only since the 1.0 cleanup; the old write schemas live in main's forexLegacy.testutil.ts) ----------

export interface FxRate {
  id: number
  date: string
  currencyCode: string
  rateMicro: number
  note: string | null
}

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
