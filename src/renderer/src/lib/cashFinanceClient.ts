// Typed client for cash and finance (WP 4.4) — the forecast:*, loan:*, fx:* and budget month /
// revision / CSV channels in src/main/ipcCashFinance.ts. Kept beside client.ts like faApi.
import { call } from './client'
import type { Budget } from '@shared/domain'
import type { LoanSchedule } from '@shared/loanSchedule'
import type {
  BudgetCsvResult, BudgetDrillRow, BudgetMonthlyReport, BudgetRevision, CashFinanceCloseWarnings, EmiReminder, FinanceReminders,
  ForecastBase, ForecastItem, ForecastItemInput, FxRate, FxRateInput, FxRevaluationPreview, FxRevaluationRow, FxSettleInput, FxSettleResult,
  LoanDetail, LoanInput, LoanPrepaymentInput, LoanScheduleRow, LoanSummary, PostEmiInput
} from '@shared/cashFinance'

export const cfApi = {
  forecast: {
    base: (asOn: string, to: string) => call<ForecastBase>('forecast:base', { asOn, to }),
    items: () => call<ForecastItem[]>('forecast:items'),
    itemSave: (data: ForecastItemInput, id?: number) => call<ForecastItem>('forecast:itemSave', { data, id }),
    itemDelete: (id: number) => call<null>('forecast:itemDelete', { id })
  },
  loans: {
    list: () => call<LoanSummary[]>('loan:list', {}),
    get: (id: number) => call<LoanDetail>('loan:get', { id }),
    preview: (data: LoanInput) => call<LoanSchedule>('loan:preview', { data }),
    save: (data: LoanInput, id?: number) => call<LoanDetail>('loan:save', { data, id }),
    remove: (id: number) => call<null>('loan:delete', { id }),
    setStatus: (id: number, status: 'active' | 'closed') => call<LoanSummary>('loan:setStatus', { id, status }),
    prepaymentAdd: (data: LoanPrepaymentInput) => call<LoanDetail>('loan:prepaymentAdd', data),
    prepaymentDelete: (id: number) => call<LoanDetail>('loan:prepaymentDelete', { id }),
    postEmi: (data: PostEmiInput) => call<LoanScheduleRow>('loan:postEmi', data),
    reminders: () => call<EmiReminder[]>('loan:reminders', {})
  },
  fx: {
    rates: () => call<FxRate[]>('fx:rates'),
    rateSave: (data: FxRateInput) => call<FxRate>('fx:rateSave', data),
    rateDelete: (id: number) => call<null>('fx:rateDelete', { id }),
    ledgerCurrencies: () => call<{ ledgerId: number; ledgerName: string; currencyCode: string }[]>('fx:ledgerCurrencies'),
    setLedgerCurrency: (ledgerId: number, currencyCode: string | null) => call<null>('fx:setLedgerCurrency', { ledgerId, currencyCode }),
    preview: (asOf: string) => call<FxRevaluationPreview>('fx:preview', { asOf }),
    revalue: (asOf: string, autoReverse: boolean) => call<FxRevaluationRow>('fx:revalue', { asOf, autoReverse }),
    reverse: (id: number, date?: string) => call<FxRevaluationRow>('fx:reverse', { id, date }),
    revaluations: () => call<FxRevaluationRow[]>('fx:revaluations'),
    settle: (data: FxSettleInput) => call<FxSettleResult>('fx:settle', data)
  },
  budget: {
    monthly: (budgetId: number, upToMonth: string) => call<BudgetMonthlyReport>('budget:monthly', { budgetId, upToMonth }),
    drill: (budgetId: number, lineId: number, month: string | null, upToMonth: string) =>
      call<BudgetDrillRow[]>('budget:drill', { budgetId, lineId, month, upToMonth }),
    revisions: (id: number) => call<BudgetRevision[]>('budget:revisions', { id }),
    revisionDetail: (id: number) => call<{ before: Budget; after: Budget }>('budget:revisionDetail', { id }),
    exportCsv: (id: number) => call<{ path: string; csv: string }>('budget:exportCsv', { id }),
    importCsv: (budgetId: number, csvText: string, reason: string | null) => call<BudgetCsvResult>('budget:importCsv', { budgetId, csvText, reason })
  },
  checks: {
    closeWarnings: (fyStartYear: number) => call<CashFinanceCloseWarnings>('yearEnd:cashFinanceWarnings', { fyStartYear }),
    reminders: () => call<FinanceReminders>('dashboard:financeReminders', {})
  }
}
