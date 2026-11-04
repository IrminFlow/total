// Typed client for cash and finance (WP 4.4) — the forecast:* and fx:* channels in
// src/main/ipcCashFinance.ts. Kept beside client.ts like faApi.
import { call } from './client'
import type { ForecastBase, ForecastItem, ForecastItemInput, FxRate, FxRevaluationRow } from '@shared/cashFinance'

export const cfApi = {
  forecast: {
    base: (asOn: string, to: string) => call<ForecastBase>('forecast:base', { asOn, to }),
    items: () => call<ForecastItem[]>('forecast:items'),
    itemSave: (data: ForecastItemInput, id?: number) => call<ForecastItem>('forecast:itemSave', { data, id }),
    itemDelete: (id: number) => call<null>('forecast:itemDelete', { id })
  },
  fx: {
    rates: () => call<FxRate[]>('fx:rates'),
    foreignOpening: (ledgerId: number) => call<{ currencyCode: string; openingFc: number } | null>('fx:foreignOpening', { ledgerId }),
    revaluationOf: (voucherId: number) => call<{ id: number; asOf: string; reversed: boolean } | null>('fx:revaluationOf', { voucherId }),
    reverse: (id: number, date?: string) => call<FxRevaluationRow>('fx:reverse', { id, date })
  }
}
