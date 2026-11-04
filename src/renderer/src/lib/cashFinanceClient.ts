// Typed client for cash and finance (WP 4.4) — the forecast:* and fx:* channels in
// src/main/ipcCashFinance.ts. Kept beside client.ts like faApi.
import { call } from './client'
import type {
  CashFinanceCloseWarnings,
  ForecastBase, ForecastItem, FxForeignOpeningInput, FxForeignOpeningResult, FxOpenBill, ForecastItemInput, FxRate, FxRateInput, FxRevaluationPreview, FxRevaluationRow, FxSettleInput, FxSettleResult
} from '@shared/cashFinance'

export const cfApi = {
  forecast: {
    base: (asOn: string, to: string) => call<ForecastBase>('forecast:base', { asOn, to }),
    items: () => call<ForecastItem[]>('forecast:items'),
    itemSave: (data: ForecastItemInput, id?: number) => call<ForecastItem>('forecast:itemSave', { data, id }),
    itemDelete: (id: number) => call<null>('forecast:itemDelete', { id })
  },
  fx: {
    rates: () => call<FxRate[]>('fx:rates'),
    rateSave: (data: FxRateInput) => call<FxRate>('fx:rateSave', data),
    rateDelete: (id: number) => call<null>('fx:rateDelete', { id }),
    ledgerCurrencies: () => call<{ ledgerId: number; ledgerName: string; currencyCode: string; openingFc: number | null; openingInr: number }[]>('fx:ledgerCurrencies'),
    setLedgerCurrency: (ledgerId: number, currencyCode: string | null, openingFc: number | null = null) => call<null>('fx:setLedgerCurrency', { ledgerId, currencyCode, openingFc }),
    setForeignOpening: (data: FxForeignOpeningInput) => call<FxForeignOpeningResult>('fx:setForeignOpening', data),
    openBills: (ledgerId: number, asOf: string) => call<{ currencyCode: string; kind: 'receivable' | 'payable' | 'bank'; bills: FxOpenBill[] }>('fx:openBills', { ledgerId, asOf }),
    preview: (asOf: string) => call<FxRevaluationPreview>('fx:preview', { asOf }),
    revalue: (asOf: string, autoReverse: boolean) => call<FxRevaluationRow>('fx:revalue', { asOf, autoReverse }),
    reverse: (id: number, date?: string) => call<FxRevaluationRow>('fx:reverse', { id, date }),
    revaluations: () => call<FxRevaluationRow[]>('fx:revaluations'),
    settle: (data: FxSettleInput) => call<FxSettleResult>('fx:settle', data)
  },
  checks: {
    closeWarnings: (fyStartYear: number) => call<CashFinanceCloseWarnings>('yearEnd:cashFinanceWarnings', { fyStartYear })
  }
}
