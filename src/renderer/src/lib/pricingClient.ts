// Typed client for pricing and counter billing (WP 2.6) — the channels in src/main/ipcPricing.ts.
// Kept beside client.ts so the pricing surface stays in one place.
import { call } from './client'
import type { PriceLevel, PriceListRate } from '@shared/domain'
import type {
  CheckoutResult, CounterAccounts, CounterQuote, DayEndSummary, DiscountSchemeRow, HeldBill, PartyRate, RateGrid,
  RatesImportResult, ResolvedLine
} from '@shared/pricingTypes'
import type {
  BulkRateUpdate, CounterCheckoutInput, CounterConfig, DiscountSchemeInput, HeldBillInput, PartyRateInput, PricingConfig
} from '@shared/pricingSchemas'
import type { PriceRateInput } from '@shared/schemas'

export type {
  CheckoutResult, CounterAccounts, CounterQuote, DayEndSummary, DiscountSchemeRow, HeldBill, PartyRate, RateGrid, RatesImportResult, ResolvedLine
} from '@shared/pricingTypes'

export interface ResolveQuery {
  date: string
  partyLedgerId: number | null
  currency?: string
  supply?: 'intra' | 'inter'
  lines: { key: number; itemId: number; qtyMilli: number }[]
}

export const pricingApi = {
  grid: (date: string) => call<RateGrid>('pricing:grid', { date }),
  setGridRate: (priceLevelId: number, stockItemId: number, date: string, rate: number | null) =>
    call<PriceListRate | null>('pricing:setGridRate', { priceLevelId, stockItemId, date, rate }),
  updateRate: (id: number, data: PriceRateInput) => call<PriceListRate>('pricing:updateRate', { id, data }),
  bulkUpdate: (req: Partial<BulkRateUpdate> & Pick<BulkRateUpdate, 'priceLevelId' | 'changeBp'>) => call<{ updated: number }>('pricing:bulkUpdate', req),
  copyLevel: (req: { fromLevelId: number; name: string; changeBp?: number; inclusiveOfTax?: boolean }) => call<PriceLevel>('pricing:copyLevel', req),
  exportCsv: (priceLevelId?: number) => call<{ csv: string }>('pricing:exportCsv', priceLevelId ? { priceLevelId } : {}),
  importCsv: (csvText: string, dryRun = false) => call<RatesImportResult>('pricing:importCsv', { csvText, dryRun }),

  partyRates: (ledgerId?: number) => call<PartyRate[]>('pricing:partyRates', ledgerId ? { ledgerId } : {}),
  savePartyRate: (data: PartyRateInput, id?: number) => call<PartyRate>('pricing:savePartyRate', { data, id }),
  deletePartyRate: (id: number) => call<null>('pricing:deletePartyRate', { id }),

  schemes: () => call<DiscountSchemeRow[]>('pricing:schemes'),
  saveScheme: (data: DiscountSchemeInput, id?: number) => call<DiscountSchemeRow>('pricing:saveScheme', { data, id }),
  deleteScheme: (id: number) => call<null>('pricing:deleteScheme', { id }),

  config: () => call<PricingConfig>('pricing:config'),
  setConfig: (cfg: PricingConfig) => call<PricingConfig>('pricing:setConfig', cfg),
  resolve: (q: ResolveQuery) => call<ResolvedLine[]>('pricing:resolve', q)
}

export const counterApi = {
  config: () => call<{ config: CounterConfig; accounts: CounterAccounts }>('counter:config'),
  setConfig: (cfg: CounterConfig) => call<CounterConfig>('counter:setConfig', cfg),
  quote: (input: CounterCheckoutInput) => call<CounterQuote>('counter:quote', input),
  checkout: (input: CounterCheckoutInput) => call<CheckoutResult>('counter:checkout', input),
  held: () => call<HeldBill[]>('counter:held'),
  hold: (input: HeldBillInput) => call<HeldBill>('counter:hold', input),
  recall: (id: string) => call<HeldBill>('counter:recall', { id }),
  discardHeld: (id: string) => call<null>('counter:discardHeld', { id }),
  dayEnd: (date: string) => call<DayEndSummary>('counter:dayEnd', { date }),
  printHtml: (voucherId: number, templateId: string) => call<{ html: string }>('counter:printHtml', { voucherId, templateId }),
  print: (voucherId: number, templateId: string) => call<{ path: string }>('counter:print', { voucherId, templateId })
}
