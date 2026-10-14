// WP 7.2 — a user whose `canSeeProfit` flag is off still gets the dashboards and simple Home; the
// profit figures in them are left out (never shown as ₹0). Pure.
import type { DashboardData } from './reports'
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
