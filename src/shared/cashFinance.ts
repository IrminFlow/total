/**
 * Cash and finance (WP 4.4) — IPC input schemas and the row shapes main returns, shared by main
 * and renderer. The maths lives in ./cashForecast.ts, ./loanSchedule.ts, ./forex.ts and
 * ./budgetPhasing.ts.
 */
import { z } from 'zod'
import { isoDate } from './schemas'
import type { CollectionProfile, ForecastFlow, ItemCadence, ItemKind } from './cashForecast'
import type { EmiMethod, MoratoriumMode, PrepaymentEffect, ScheduleKind } from './loanSchedule'
import type { MonthlyVarianceRow } from './budgetPhasing'

const id = z.number().int().positive()
const paise = z.number().int().safe()
const positivePaise = paise.positive()
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

// ---------- loans ----------

export const loanInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    /** The loan liability ledger (lender), e.g. under Secured Loans. */
    loanLedgerId: id,
    /** Default bank for Post EMI. */
    bankLedgerId: id.nullable().default(null),
    /** Interest expense ledger; null = "Interest on Loans" under Indirect Expenses (created on first post). */
    interestLedgerId: id.nullable().default(null),
    principal: positivePaise,
    annualRateMilli: z.number().int().min(0).max(60_000),
    tenureMonths: z.number().int().min(1).max(600),
    disbursedOn: isoDate,
    firstDueDate: isoDate,
    method: z.enum(['reducing', 'flat']).default('reducing'),
    moratoriumMonths: z.number().int().min(0).max(60).default(0),
    moratoriumMode: z.enum(['capitalise', 'interest_only']).default('capitalise'),
    emiOverride: positivePaise.nullable().default(null),
    notes: z.string().trim().max(400).nullable().default(null)
  })
  .refine((v) => v.firstDueDate > v.disbursedOn, { message: 'The first instalment must fall after the disbursement date', path: ['firstDueDate'] })
export type LoanInput = z.input<typeof loanInputSchema>

export const loanPrepaymentInputSchema = z.object({
  loanId: id,
  date: isoDate,
  amount: positivePaise,
  effect: z.enum(['reduce_tenure', 'reduce_emi'])
})
export type LoanPrepaymentInput = z.input<typeof loanPrepaymentInputSchema>

export const postEmiSchema = z.object({
  scheduleId: id,
  /** Defaults to the instalment's due date. */
  date: isoDate.optional(),
  /** Defaults to the loan's bank ledger. */
  bankLedgerId: id.optional()
})
export type PostEmiInput = z.input<typeof postEmiSchema>

export interface LoanSummary {
  id: number
  name: string
  loanLedgerId: number
  loanLedgerName: string
  bankLedgerId: number | null
  bankLedgerName: string | null
  interestLedgerId: number | null
  interestLedgerName: string | null
  principal: number
  annualRateMilli: number
  tenureMonths: number
  disbursedOn: string
  firstDueDate: string
  method: EmiMethod
  moratoriumMonths: number
  moratoriumMode: MoratoriumMode
  emiOverride: number | null
  status: 'active' | 'closed'
  notes: string | null
  /** The schedule's EMI. */
  emi: number
  /** Principal still owed per the schedule after the last posted row (paise). */
  outstanding: number
  /** The loan ledger's book balance today (credit balance shown positive). */
  ledgerBalance: number
  postedCount: number
  pendingCount: number
  nextDue: { scheduleId: number; dueDate: string; payment: number } | null
  /** Unposted rows due on or before today. */
  overdueCount: number
  /** Interest falling due in the current financial year (posted or not). */
  interestThisFy: number
  totalInterest: number
}

export interface LoanScheduleRow {
  id: number
  loanId: number
  seq: number
  dueDate: string
  kind: ScheduleKind
  opening: number
  payment: number
  interest: number
  principal: number
  closing: number
  /** Live posted voucher (null when not posted, or its voucher is in the bin). */
  voucherId: number | null
  voucherNumber: string | null
  posted: boolean
}

export interface LoanDetail {
  loan: LoanSummary
  schedule: LoanScheduleRow[]
  prepayments: { id: number; date: string; amount: number; effect: PrepaymentEffect }[]
}

export interface EmiReminder {
  loanId: number
  loanName: string
  scheduleId: number
  dueDate: string
  payment: number
  overdue: boolean
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

// ---------- budgets ----------

export const budgetMonthlySchema = z.object({ budgetId: id, upToMonth: z.string().regex(/^\d{4}-\d{2}$/, 'Expected YYYY-MM') })

export const budgetDrillSchema = z.object({
  budgetId: id,
  lineId: id,
  /** 'YYYY-MM' for one month; null = April through upToMonth. */
  month: z.string().regex(/^\d{4}-\d{2}$/).nullable(),
  upToMonth: z.string().regex(/^\d{4}-\d{2}$/)
})

export const budgetCsvImportSchema = z.object({
  budgetId: id,
  csvText: z.string().max(2 * 1024 * 1024),
  reason: z.string().trim().max(200).nullable().default(null)
})

export interface BudgetMonthlyReport {
  budgetId: number
  fyStartYear: number
  months: string[]
  upToMonth: string
  rows: MonthlyVarianceRow[]
}

export interface BudgetDrillRow {
  voucherId: number
  date: string
  number: string
  voucherType: string
  ledgerId: number
  ledgerName: string
  /** Signed in the target's natural direction (as counted in the actual). */
  amount: number
}

export interface BudgetRevision {
  id: number
  budgetId: number
  revisionNo: number
  revisedAt: string
  userName: string | null
  reason: string | null
  totalBefore: number
  totalAfter: number
  linesBefore: number
  linesAfter: number
}

export interface BudgetCsvResult {
  lines: number
  errors: string[]
}

export interface OverBudgetRow {
  budgetId: number
  budgetName: string
  lineId: number
  targetName: string
  costCentreName: string | null
  budget: number
  actual: number
}

export interface OverBudgetChip {
  month: string
  rows: OverBudgetRow[]
}

// ---------- year-end / dashboard ----------

export interface CashFinanceCloseWarnings {
  unpostedEmis: { loanId: number; loanName: string; count: number; amount: number }[]
  unrevalued: { currencyCode: string; ledgers: number; fcBalance: number }[]
  /** No revaluation as on the FY's last day while foreign balances were open. */
  revaluedOnFyEnd: boolean
  /** Lines (department / cost-centre lines first) whose full-year actual exceeds the budget. */
  overBudget: OverBudgetRow[]
}

/** dashboard:financeReminders — the compliance card's EMI reminders and over-budget chip. */
export interface FinanceReminders {
  emis: EmiReminder[]
  overBudget: OverBudgetChip
}
