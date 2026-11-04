// Typed client for comparatives and ratios (WP 6.2) — the channels in src/main/ipcReports.ts.
// Kept beside client.ts like pricingClient.ts.
import { call } from './client'
import type { RatioReport } from '@shared/ratios'
import type { BalanceSheet, ProfitAndLoss } from '@shared/reports'

export interface ComparativeColumn {
  key: 'current' | 'previous' | 'lastYear'
  label: string
  from: string
  to: string
}

export const reportsApi = {
  comparativePnl: (from: string, to: string) => call<{ columns: ComparativeColumn[]; statements: ProfitAndLoss[] }>('report:comparative', { kind: 'pnl', from, to }),
  comparativeBs: (from: string, to: string) => call<{ columns: ComparativeColumn[]; statements: BalanceSheet[] }>('report:comparative', { kind: 'bs', from, to }),
  ratios: (from: string, to: string) => call<RatioReport>('report:ratios', { from, to })
}
