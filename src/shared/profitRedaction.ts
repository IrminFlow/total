// WP 7.2 — a user whose `canSeeProfit` flag is off still gets the dashboards and simple Home; the
// profit figures in them are left out (never shown as ₹0). Pure.
import type { DashboardData, TrialBalance } from './reports'
import type { DashboardSeries } from './dashboard'
import type { SimpleHomeData } from './simple/home'

export const PROFIT_HIDDEN_MESSAGE = 'Profit figures are not shown to your account'

export function redactDashboard(d: DashboardData): DashboardData {
  return { ...d, ratios: { ...d.ratios, grossMarginPct: null, netMarginPct: null } }
}

export function redactDashboardSeries(d: DashboardSeries): DashboardSeries {
  return { ...d, trade: { ok: false, error: PROFIT_HIDDEN_MESSAGE } }
}

const zeroPeriod = <T extends { netProfit: number; lines: unknown; topExpense: unknown }>(p: T): T => ({
  ...p,
  netProfit: 0,
  openingStock: 0,
  closingStock: 0,
  lines: { ...(p.lines as object), ...Object.fromEntries(Object.keys(p.lines as object).map((k) => [k, 0])) },
  topExpense: null
})

export function redactHome(h: SimpleHomeData): SimpleHomeData {
  return {
    ...h,
    profitHidden: true,
    profit: {
      month: zeroPeriod(h.profit.month),
      year: zeroPeriod(h.profit.year),
      previousMonth: { ...h.profit.previousMonth, lines: zeroPeriod({ netProfit: 0, lines: h.profit.previousMonth.lines, topExpense: null }).lines }
    }
  }
}

/** The ledgerId the trial balance gives its computed "Profit & Loss A/c (opening)" row. */
export const TB_PRIOR_PNL_ROW_ID = -5

/** The trial balance without what adds up to the profit: the income / expense ledgers
 *  (`pnlLedgerIds`) and the computed prior-years P&L row are left out, and the totals are 0 with
 *  `profitHidden` set — a Dr / Cr total over the remaining rows would show the profit as their
 *  difference, so no total is given (never a wrong number: the screen shows the note instead). */
export function redactTrialBalance(tb: TrialBalance, pnlLedgerIds: ReadonlySet<number>): TrialBalance {
  return {
    rows: tb.rows.filter((r) => r.ledgerId !== TB_PRIOR_PNL_ROW_ID && !pnlLedgerIds.has(r.ledgerId)),
    totalDebit: 0,
    totalCredit: 0,
    openingDebitTotal: 0,
    openingCreditTotal: 0,
    movementDebitTotal: 0,
    movementCreditTotal: 0,
    profitHidden: true
  }
}

/** What the AI tools / Ask Total / report packs say when a profit figure is withheld. */
export const PROFIT_HIDDEN_TOOL_MESSAGE =
  'Profit figures are not shown to this user’s account (the owner turned “can see profit” off). Tell the user plainly that profit, the balance sheet and P&L figures are not available to them and that the owner can change it in People & roles.'
