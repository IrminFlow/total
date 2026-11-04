// IPC channels for cash and finance (WP 4.4): the cash-flow forecast and its known items, forex
// rates / revaluation / settlement, and the additive year-end check. Registered from ipc.ts with its
// `handle` (role gate + { ok, data | error } envelope); every payload is Zod-parsed here.
import { z } from 'zod'
import type { DB } from './db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { Role } from './services/roles'
import { isoDate } from '@shared/schemas'
import {
  forecastBaseSchema, forecastItemInputSchema, fxAsOfSchema,
  fxForeignOpeningSchema, fxLedgerCurrencySchema, fxRateInputSchema, fxRevaluePostSchema, fxSettleInputSchema
} from '@shared/cashFinance'
import * as forecast from './services/cashForecast'
import * as forex from './services/forex'
import * as checks from './services/cashFinanceChecks'

type Handle = (channel: string, fn: (payload: unknown) => unknown, minRole?: Role) => void
interface Company { db: DB; info: CompanyInfo; slug: string }

const idSchema = z.object({ id: z.number().int().positive() })
const withId = <T extends z.ZodTypeAny>(schema: T) => z.object({ id: z.number().int().positive().optional(), data: schema })

export function registerCashFinanceIpc(handle: Handle, company: () => Company): void {
  const db = (): DB => company().db

  // ---------- forecast ----------
  handle('forecast:base', (p) => {
    const { asOn, to } = forecastBaseSchema.parse(p)
    const c = company()
    return forecast.forecastBase(c.db, c.info, asOn, to)
  }, 'viewer')
  handle('forecast:items', () => forecast.listForecastItems(db()), 'viewer')
  handle('forecast:itemSave', (p) => {
    const { id, data } = withId(forecastItemInputSchema).parse(p)
    return forecast.saveForecastItem(db(), data, id)
  })
  handle('forecast:itemDelete', (p) => forecast.deleteForecastItem(db(), idSchema.parse(p).id))

  // ---------- forex ----------
  handle('fx:rates', () => forex.listRates(db()), 'viewer')
  handle('fx:rateSave', (p) => forex.saveRate(db(), fxRateInputSchema.parse(p)))
  handle('fx:rateDelete', (p) => forex.deleteRate(db(), idSchema.parse(p).id))
  handle('fx:ledgerCurrencies', () => forex.listLedgerCurrencies(db()), 'viewer')
  handle('fx:setLedgerCurrency', (p) => {
    const { ledgerId, currencyCode, openingFc } = fxLedgerCurrencySchema.parse(p)
    forex.setLedgerCurrency(db(), ledgerId, currencyCode, openingFc)
    return null
  })
  handle('fx:setForeignOpening', (p) => forex.setForeignOpening(db(), fxForeignOpeningSchema.parse(p)))
  handle('fx:preview', (p) => forex.revaluationPreview(db(), fxAsOfSchema.parse(p).asOf), 'viewer')
  handle('fx:revalue', (p) => forex.postRevaluation(db(), fxRevaluePostSchema.parse(p)))
  handle('fx:reverse', (p) => {
    const { id, date } = z.object({ id: z.number().int().positive(), date: isoDate.optional() }).parse(p)
    return forex.reverseRevaluation(db(), id, date)
  })
  handle('fx:revaluations', () => forex.listRevaluations(db()), 'viewer')
  handle('fx:revaluationLines', (p) => forex.revaluationLines(db(), idSchema.parse(p).id), 'viewer')
  handle('fx:openBills', (p) => {
    const { ledgerId, asOf } = z.object({ ledgerId: z.number().int().positive(), asOf: isoDate }).parse(p)
    return forex.openBills(db(), ledgerId, asOf)
  }, 'viewer')
  handle('fx:settle', (p) => forex.settle(db(), fxSettleInputSchema.parse(p)))

  // ---------- additive checks (year-end close, dashboard) ----------
  handle('yearEnd:cashFinanceWarnings', (p) => checks.closeWarnings(db(), z.object({ fyStartYear: z.number().int() }).parse(p).fyStartYear), 'viewer')
}
