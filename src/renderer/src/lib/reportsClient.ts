// Typed client for comparatives and ratios (WP 6.2) — the channels in src/main/ipcReports.ts.
// Kept beside client.ts like pricingClient.ts.
import { call } from './client'
import type { RatioReport } from '@shared/ratios'
import type { BalanceSheet, ProfitAndLoss, StatementNode } from '@shared/reports'

export interface ComparativeColumn {
  key: 'current' | 'previous' | 'lastYear'
  label: string
  from: string
  to: string
}

export interface BudgetAmounts {
  budgetId: number
  name: string
  ledgers: Record<number, number>
  groups: Record<number, number>
  pnl: { tradingIncomes: StatementNode[]; tradingExpenses: StatementNode[]; indirectIncomes: StatementNode[]; indirectExpenses: StatementNode[] }
}

export const reportsApi = {
  comparativePnl: (from: string, to: string) => call<{ columns: ComparativeColumn[]; statements: ProfitAndLoss[] }>('report:comparative', { kind: 'pnl', from, to }),
  comparativeBs: (from: string, to: string) => call<{ columns: ComparativeColumn[]; statements: BalanceSheet[] }>('report:comparative', { kind: 'bs', from, to }),
  budgetAmounts: (budgetId: number, from: string, to: string) => call<BudgetAmounts>('report:budgetAmounts', { budgetId, from, to }),
  ratios: (from: string, to: string) => call<RatioReport>('report:ratios', { from, to })
}
