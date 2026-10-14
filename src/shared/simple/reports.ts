// Plain reports (WP 9.9, plan 2026-10-13 §2.2 Reports, §3 "How is my business doing"): the shapes
// the simple Reports screens get and the pure rules behind them. Every figure is computed by main
// through the service the accountant screen uses (services/simpleReports.ts):
//   how is my business doing  reports.profitAndLoss (→ pnlLedgerAmounts; closing stock from the one
//                             valuation pass, stockValuesAt) — the lines below are its own totals
//   cash + bank               reports.closingBalances (trial balance basis)
//   who owes whom             analysis.outstandingsWithAdvances (the Outstandings allocation)
//   cash in the next 30 days  cashForecast.forecastBase + buildForecast (expected scenario)
//   sales and purchases       analysis.registerByMonth (the Registers screen, by month)
// Nothing here is stored and nothing here computes a figure a service did not return: the
// one-column lines are re-arrangements of the P&L's own totals (sales = trading incomes, cost of
// goods = opening stock + trading expenses − closing stock, …), so profit IS its net profit.

import { z } from 'zod'
import type { ProfitAndLoss, StatementNode } from '../reports'
import type { OutstandingParty } from '../reports'

// ---------------------------------------------------------------- periods

export const REPORT_PERIODS = ['this-month', 'last-month', 'this-year', 'custom'] as const
export type ReportPeriodKind = (typeof REPORT_PERIODS)[number]

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const doingQuerySchema = z
  .object({
    period: z.enum(REPORT_PERIODS),
    from: iso.optional(),
    to: iso.optional(),
    today: iso.optional()
  })
  .strict()
export type DoingQuery = z.infer<typeof doingQuerySchema>

const pad2 = (n: number): string => String(n).padStart(2, '0')
function addDays(date: string, delta: number): string {
  const dt = new Date(`${date}T00:00:00Z`)
  dt.setUTCDate(dt.getUTCDate() + delta)
  return dt.toISOString().slice(0, 10)
}
function addMonths(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number) as [number, number]
  const idx = y * 12 + (m - 1) + delta
  return `${Math.floor(idx / 12)}-${pad2((idx % 12) + 1)}`
}
const daysIn = (ym: string): number => {
  const [y, m] = ym.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}
const monthEnd = (ym: string): string => `${ym}-${pad2(daysIn(ym))}`
/** The same day `months` months away, clamped to that month's last day (31 Mar → 28/29 Feb). */
function sameDay(date: string, months: number): string {
  const ym = addMonths(date.slice(0, 7), months)
  const d = Math.min(Number(date.slice(8, 10)), daysIn(ym))
  return `${ym}-${pad2(d)}`
}
const fyStart = (date: string): string => {
  const [y, m] = date.split('-').map(Number) as [number, number]
  return `${m >= 4 ? y : y - 1}-04-01`
}
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

export interface ReportSpan {
  from: string
  to: string
}

/**
 * The dates a period covers, as on `today` (never after it for the running periods): this month =
 * the 1st to today; last month = the whole of it; this year = the financial year's 1 April to
 * today; custom = as given. Null for a custom period without both dates, or one that ends before
 * it starts (the screen puts the error on "to").
 */
export function reportSpan(kind: ReportPeriodKind, today: string, custom?: { from?: string; to?: string }): ReportSpan | null {
  switch (kind) {
    case 'this-month':
      return { from: `${today.slice(0, 7)}-01`, to: today }
    case 'last-month': {
      const ym = addMonths(today.slice(0, 7), -1)
      return { from: `${ym}-01`, to: monthEnd(ym) }
    }
    case 'this-year':
      return { from: fyStart(today), to: today }
    case 'custom':
      if (!custom?.from || !custom.to || custom.from > custom.to) return null
      return { from: custom.from, to: custom.to }
  }
}

/**
 * The period a report is compared with: the same days one step back — this month to date vs last
 * month to the same day; a whole month vs the month before; the FY to date vs last FY to the same
 * day; a custom span vs the same number of days just before it.
 */
export function previousSpan(kind: ReportPeriodKind, span: ReportSpan): ReportSpan {
  switch (kind) {
    case 'this-month':
      return { from: sameDay(span.from, -1), to: sameDay(span.to, -1) }
    case 'last-month': {
      const ym = addMonths(span.from.slice(0, 7), -1)
      return { from: `${ym}-01`, to: monthEnd(ym) }
    }
    case 'this-year':
      return { from: sameDay(span.from, -12), to: sameDay(span.to, -12) }
    case 'custom': {
      const len = daysBetween(span.from, span.to)
      const to = addDays(span.from, -1)
      return { from: addDays(to, -len), to }
    }
  }
}

// ---------------------------------------------------------------- how is my business doing

/** The one column, in paise. Signs as they read: sales, purchases, expenses positive; profit
 *  positive / negative (loss). Identity (asserted by doingLines' callers' tests):
 *  sales − costOfGoods + otherIncome − expenses = profit, costOfGoods = openingStock + purchases −
 *  closingStock, profitOnGoods = sales − costOfGoods. */
export interface DoingLines {
  sales: number
  openingStock: number
  purchases: number
  closingStock: number
  costOfGoods: number
  profitOnGoods: number
  otherIncome: number
  expenses: number
  profit: number
}

export interface DoingPart {
  name: string
  amount: number
  /** The ledger (or group) the amount sits on — names link to its statement. */
  ledgerId: number | null
}

const sum = (nodes: readonly StatementNode[]): number => nodes.reduce((s, n) => s + n.amount, 0)

/** The P&L's own totals, re-arranged into the column. Profit is the P&L's net profit — taken, not
 *  recomputed. */
export function doingLines(pnl: Pick<ProfitAndLoss, 'openingStock' | 'closingStock' | 'tradingIncomes' | 'tradingExpenses' | 'indirectIncomes' | 'indirectExpenses' | 'grossProfit' | 'netProfit'>): DoingLines {
  const sales = sum(pnl.tradingIncomes)
  const purchases = sum(pnl.tradingExpenses)
  const costOfGoods = pnl.openingStock + purchases - pnl.closingStock
  return {
    sales,
    openingStock: pnl.openingStock,
    purchases,
    closingStock: pnl.closingStock,
    costOfGoods,
    profitOnGoods: pnl.grossProfit,
    otherIncome: sum(pnl.indirectIncomes),
    expenses: sum(pnl.indirectExpenses),
    profit: pnl.netProfit
  }
}

/** The biggest leaves (ledgers) of a statement side, largest first — "where the money went". */
export function topParts(nodes: readonly StatementNode[], limit = 5): DoingPart[] {
  const out: DoingPart[] = []
  const walk = (n: StatementNode): void => {
    if (n.children.length === 0) {
      if (n.amount !== 0) out.push({ name: n.name, amount: n.amount, ledgerId: n.kind === 'ledger' ? n.id : null })
      return
    }
    n.children.forEach(walk)
  }
  nodes.forEach(walk)
  return out.sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name)).slice(0, limit)
}

export interface DoingCash {
  cash: number
  bank: number
  total: number
  /** Cash-in-hand / bank ledgers, for the accountant link (trial balance limited to them). */
  ledgerIds: number[]
  banks: number
}

export interface DoingOwed {
  receivable: number
  receivableParties: number
  payable: number
  payableParties: number
  /** Customer / supplier advances (the same allocation's unapplied credit). */
  customerAdvances: number
  supplierAdvances: number
}

export interface BusinessDoing {
  kind: ReportPeriodKind
  span: ReportSpan
  previous: ReportSpan
  lines: DoingLines
  previousLines: DoingLines
  topExpenses: DoingPart[]
  topSales: DoingPart[]
  /** Cash and bank at the period's end (as on today when it runs past today). */
  asOn: string
  cash: DoingCash
  owed: DoingOwed
  /** Nothing at all in the period and before it — the screen says so instead of ₹0 lines. */
  empty: boolean
}

/** Signed change from the previous period, paise (current − previous). */
export const changeOf = (current: number, previous: number): number => current - previous

/** The lines that make up profit, each with the sign it has in it. */
export const PROFIT_PARTS = ['sales', 'costOfGoods', 'otherIncome', 'expenses'] as const
export type ProfitPart = (typeof PROFIT_PARTS)[number]
const PART_SIGN: Record<ProfitPart, 1 | -1> = { sales: 1, costOfGoods: -1, otherIncome: 1, expenses: -1 }

/**
 * WP 10.2 — "mostly from …": of the lines that make up profit, the one whose change moved profit
 * the most in the same direction as profit moved (sales up, running costs down …). `change` is the
 * line's own change (current − previous, signed as the line reads); null when profit did not move
 * or no line moved it that way. Pure — the lines are the service's (doingLines of each P&L).
 */
export function biggestChange(current: Pick<DoingLines, ProfitPart | 'profit'>, previous: Pick<DoingLines, ProfitPart | 'profit'>): { part: ProfitPart; change: number } | null {
  const diff = current.profit - previous.profit
  if (diff === 0) return null
  let best: { part: ProfitPart; change: number; effect: number } | null = null
  for (const part of PROFIT_PARTS) {
    const change = current[part] - previous[part]
    const effect = PART_SIGN[part] * change
    if (Math.sign(effect) !== Math.sign(diff)) continue
    if (!best || Math.abs(effect) > Math.abs(best.effect)) best = { part, change, effect }
  }
  return best && { part: best.part, change: best.change }
}

// ---------------------------------------------------------------- cash in the next 30 days

export const CASH_HORIZON_DAYS = 30

export type CashFlowSource = 'customers' | 'suppliers' | 'taxes' | 'loans' | 'orders' | 'other'

export interface CashItem {
  label: string
  date: string
  /** Weighted paise (the forecast's expected amount). */
  amount: number
  source: CashFlowSource
  ledgerId: number | null
}

export interface SimpleCash {
  asOn: string
  until: string
  /** Cash + bank today (= the trial balance's cash / bank, the forecast's opening). */
  now: number
  moneyIn: number
  moneyOut: number
  /** now + in − out. */
  end: number
  /** The lowest the balance gets in the 30 days, and the day — when it dips below today's. */
  lowest: { amount: number; date: string } | null
  inBy: Partial<Record<CashFlowSource, number>>
  outBy: Partial<Record<CashFlowSource, number>>
  /** The biggest expected receipts / payments, largest first. */
  topIn: CashItem[]
  topOut: CashItem[]
  /** Parts of the forecast that could not be read (shown as a note). */
  warnings: number
  /** WP 10.2 — today's `now` in parts: the trial balance's cash / bank rows (= the forecast's
   *  opening) and the accounts, for the "Why?" and its link. */
  split: DoingCash
  /** The first day the running balance goes below zero, and how far — null when it never does. */
  belowZero: { amount: number; date: string } | null
}

// ---------------------------------------------------------------- who owes whom

export const owedQuerySchema = z.object({ side: z.enum(['receivable', 'payable']), today: iso.optional() }).strict()

export interface OwedParty {
  ledgerId: number
  name: string
  pending: number
  overdue: number
  bills: number
  oldestDays: number
}

export interface SimpleOwed {
  side: 'receivable' | 'payable'
  asOn: string
  total: number
  overdue: number
  parties: OwedParty[]
  advances: number
  advanceParties: number
}

/** The Outstandings parties, in plain rows (largest first). Pure. */
export function owedRows(parties: readonly OutstandingParty[]): OwedParty[] {
  return parties
    .filter((p) => p.pending !== 0)
    .map((p) => ({
      ledgerId: p.ledgerId,
      name: p.name,
      pending: p.pending,
      overdue: p.bills.filter((b) => b.overdueDays > 0 && b.pending > 0).reduce((s, b) => s + b.pending, 0),
      bills: p.bills.filter((b) => b.pending > 0).length,
      oldestDays: p.bills.reduce((m, b) => (b.pending > 0 && b.ageDays > m ? b.ageDays : m), 0)
    }))
    .sort((a, b) => b.pending - a.pending || a.name.localeCompare(b.name))
}

// ---------------------------------------------------------------- sales and purchases by month

export interface MonthBar {
  /** 'YYYY-MM'. */
  month: string
  /** The Sales register's taxable value for the month (before GST), paise. */
  sales: number
  /** The Purchase register's taxable value. */
  purchases: number
  salesBills: number
  purchaseBills: number
}

export interface SimpleByMonth {
  months: MonthBar[]
  from: string
  to: string
  /** WP 10.2 — the 12 months together (the registers' taxable values, summed per side). */
  totals: { sales: number; purchases: number }
}

/** The 12 bars' totals. Pure. */
export function monthTotals(bars: readonly MonthBar[]): SimpleByMonth['totals'] {
  return { sales: bars.reduce((s, m) => s + m.sales, 0), purchases: bars.reduce((s, m) => s + m.purchases, 0) }
}

/** The 12 months ending with `today`'s month, oldest first. */
export function last12Months(today: string): string[] {
  const end = today.slice(0, 7)
  return Array.from({ length: 12 }, (_, i) => addMonths(end, i - 11))
}

/** The register rows laid on the 12 months (a month without bills is zero). Pure. */
export function monthBars(
  months: readonly string[],
  sales: readonly { month: string; taxable: number; vouchers: number }[],
  purchases: readonly { month: string; taxable: number; vouchers: number }[]
): MonthBar[] {
  const s = new Map(sales.map((r) => [r.month, r]))
  const p = new Map(purchases.map((r) => [r.month, r]))
  return months.map((month) => ({
    month,
    sales: s.get(month)?.taxable ?? 0,
    purchases: p.get(month)?.taxable ?? 0,
    salesBills: s.get(month)?.vouchers ?? 0,
    purchaseBills: p.get(month)?.vouchers ?? 0
  }))
}
