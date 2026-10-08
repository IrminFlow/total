// IPC channels for cash and finance (WP 4.4): the cash-flow forecast and its known items, loans
// and EMI schedules, forex rates / revaluation / settlement, the budget month-by-month variance,
// revisions and CSV, and the additive year-end / dashboard checks. Registered from ipc.ts with its
// `handle` (role gate + { ok, data | error } envelope); every payload is Zod-parsed here.
import { writeFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import type { DB } from './db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { Role } from './services/roles'
import { isoDate } from '@shared/schemas'
import { todayISO } from '@shared/dates'
import {
  budgetCsvImportSchema, budgetDrillSchema, budgetMonthlySchema, forecastBaseSchema, forecastItemInputSchema, fxAsOfSchema,
  fxLedgerCurrencySchema, fxRateInputSchema, fxRevaluePostSchema, fxSettleInputSchema, loanInputSchema, loanPrepaymentInputSchema, postEmiSchema
} from '@shared/cashFinance'
import * as forecast from './services/cashForecast'
import * as loans from './services/loans'
import * as forex from './services/forex'
import * as budgetVar from './services/budgetVariance'
import * as checks from './services/cashFinanceChecks'
import { getBudget } from './services/budgets'
import { writeAudit } from './services/audit'
import { companyExportsDir } from './paths'

type Handle = (channel: string, fn: (payload: unknown) => unknown, minRole?: Role) => void
interface Company { db: DB; info: CompanyInfo; slug: string }

const idSchema = z.object({ id: z.number().int().positive() })
const withId = <T extends z.ZodTypeAny>(schema: T) => z.object({ id: z.number().int().positive().optional(), data: schema })
const todaySchema = z.object({ today: isoDate.optional() }).default({})

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

  // ---------- loans ----------
  handle('loan:list', (p) => loans.listLoans(db(), todaySchema.parse(p ?? {}).today ?? todayISO()), 'viewer')
  handle('loan:get', (p) => loans.getLoan(db(), idSchema.parse(p).id), 'viewer')
  handle('loan:preview', (p) => loans.previewSchedule(z.object({ data: loanInputSchema }).parse(p).data), 'viewer')
  handle('loan:save', (p) => {
    const { id, data } = withId(loanInputSchema).parse(p)
    return loans.saveLoan(db(), data, id)
  })
  handle('loan:delete', (p) => loans.deleteLoan(db(), idSchema.parse(p).id))
  handle('loan:setStatus', (p) => {
    const { id, status } = z.object({ id: z.number().int().positive(), status: z.enum(['active', 'closed']) }).parse(p)
    return loans.setLoanStatus(db(), id, status)
  })
  handle('loan:prepaymentAdd', (p) => loans.addPrepayment(db(), loanPrepaymentInputSchema.parse(p)))
  handle('loan:prepaymentDelete', (p) => loans.deletePrepayment(db(), idSchema.parse(p).id))
  handle('loan:postEmi', (p) => loans.postEmi(db(), postEmiSchema.parse(p)))
  handle('loan:reminders', (p) => loans.emiReminders(db(), todaySchema.parse(p ?? {}).today ?? todayISO()), 'viewer')

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

  // ---------- budgets (month-by-month, cost centres, revisions, CSV) ----------
  handle('budget:monthly', (p) => {
    const { budgetId, upToMonth } = budgetMonthlySchema.parse(p)
    return budgetVar.budgetMonthlyReport(db(), budgetId, upToMonth)
  }, 'viewer')
  handle('budget:drill', (p) => {
    const { budgetId, lineId, month, upToMonth } = budgetDrillSchema.parse(p)
    return budgetVar.budgetDrill(db(), budgetId, lineId, month, upToMonth)
  }, 'viewer')
  handle('budget:revisions', (p) => budgetVar.budgetRevisions(db(), idSchema.parse(p).id), 'viewer')
  handle('budget:revisionDetail', (p) => budgetVar.budgetRevisionDetail(db(), idSchema.parse(p).id), 'viewer')
  handle('budget:exportCsv', (p) => {
    const { id } = idSchema.parse(p)
    const c = company()
    const budget = getBudget(c.db, id)
    if (!budget) throw new Error('Budget not found')
    const csv = budgetVar.budgetCsv(c.db, id)
    const safe = budget.name.replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-') || 'budget'
    const path = join(companyExportsDir(c.slug), `budget-${safe}-FY${budget.fyStartYear}.csv`)
    writeFileSync(path, csv, 'utf8')
    writeAudit(c.db, 'export', 0, 'export', null, { kind: 'budget-csv', budgetId: id, path })
    return { path, csv }
  }, 'viewer')
  handle('budget:importCsv', (p) => {
    const { budgetId, csvText, reason } = budgetCsvImportSchema.parse(p)
    return budgetVar.importBudgetCsv(db(), budgetId, csvText, reason)
  })

  // ---------- additive checks (year-end close, dashboard) ----------
  handle('yearEnd:cashFinanceWarnings', (p) => checks.closeWarnings(db(), z.object({ fyStartYear: z.number().int() }).parse(p).fyStartYear), 'viewer')
  handle('dashboard:financeReminders', (p) => checks.financeReminders(db(), todaySchema.parse(p ?? {}).today ?? todayISO()), 'viewer')
}
