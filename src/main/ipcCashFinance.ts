// IPC channels for cash and finance (WP 4.4): the cash-flow forecast and its known items, and what
// is left of forex after the 1.0 cleanup (the stored rates, reversing a revaluation already in the books). Registered from ipc.ts with its
// `handle` (role gate + { ok, data | error } envelope); every payload is Zod-parsed here.
import { z } from 'zod'
import type { DB } from './db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { Role } from './services/roles'
import { isoDate } from '@shared/schemas'
import { forecastBaseSchema, forecastItemInputSchema } from '@shared/cashFinance'
import * as forecast from './services/cashForecast'
import * as forex from './services/forex'

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

  // ---------- forex (1.0 cleanup: read only, plus reversing a revaluation already in the books) ----------
  handle('fx:rates', () => forex.listRates(db()), 'viewer')
  handle('fx:foreignOpening', (p) => forex.foreignOpeningOf(db(), z.object({ ledgerId: z.number().int().positive() }).parse(p).ledgerId), 'viewer')
  handle('fx:revaluationOf', (p) => forex.revaluationOf(db(), z.object({ voucherId: z.number().int().positive() }).parse(p).voucherId), 'viewer')
  handle('fx:reverse', (p) => {
    const { id, date } = z.object({ id: z.number().int().positive(), date: isoDate.optional() }).parse(p)
    return forex.reverseRevaluation(db(), id, date)
  })
}
