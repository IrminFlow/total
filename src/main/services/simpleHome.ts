// Simple Home (WP 8.6) — everything the simple Home shows, in ONE call (`simple:home`), as on
// TODAY (never the financial year's end). Every figure comes from the service the matching
// accountant screen uses, so the two never disagree (simpleHome.dbtest.ts pins each one):
//   customers / suppliers  analysis.outstandings (Outstandings screen; Gateway tiles)
//   cash and bank          reports.closingBalances (trial balance rows; Gateway Cash & bank)
//   profit                 reports.profitAndLoss → pnlLedgerAmounts (P&L; Gateway month / FY)
//   GST                    dashboard.dashGst (Gateway Compliance row) — regular only
//   needs attention        assistants.closeChecklist (previous month) + assistants.anomalies
//   deadlines              compliance.upcomingDeadlines + the WP 8.0 applicability rules
//   setup                  dashboard.dashSetup (Gateway setup card → onboarding.ts)
// Read-only: one read transaction, nothing stored. The sentences are shared/simple/explain.ts.
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { addDays, addMonths, monthOf, monthSpan } from '@shared/dashboard'
import { fyOf } from '@shared/dates'
import { upcomingDeadlines } from '@shared/compliance'
import {
  attentionItems, BACKUP_NUDGE_DAYS, daysSince, owedSummary,
  type HomeAttention, type HomeCash, type HomeGst, type HomeMoneyDay, type HomeProfitPeriod, type SimpleHomeData
} from '@shared/simple/home'
import { closingBalances, descendantIdSet, profitAndLoss } from './reports'
import { outstandings } from './analysis'
import { stockValuesAt } from './stockAnalysis'
import { listGroups } from './masters'
import { IN_BOOKS } from './vouchers'
import { getFeatures, getGstProfile, getUi } from './config'
import { dashGst, dashSetup, tdsApplies, tdsPayableLedgers, userBackupsOf, type DashBackupInput } from './dashboard'
import { anomalies, closeChecklist } from './assistants'

export function simpleHome(db: DB, company: CompanyInfo, opts: { today: string; backups: DashBackupInput[] }): SimpleHomeData {
  // One read transaction: every tile sees the same snapshot of the books.
  return db.transaction(() => compute(db, company, opts))()
}

interface LedgerRow { id: number; name: string; groupId: number }

function compute(db: DB, company: CompanyInfo, opts: { today: string; backups: DashBackupInput[] }): SimpleHomeData {
  const today = opts.today
  const fy = fyOf(today)
  const features = getFeatures(db)
  const groups = listGroups(db)
  const ledgers = db.prepare('SELECT id, name, group_id AS groupId FROM ledgers').all() as LedgerRow[]
  const cashIds = descendantIdSet(groups, ['Cash-in-Hand'])
  const bankIds = descendantIdSet(groups, ['Bank Accounts', 'Bank OD A/c'])
  const dutiesIds = descendantIdSet(groups, ['Duties & Taxes'])
  const bal = closingBalances(db, today)

  // ---- cash and bank: each account's balance as on today ----
  const accounts = ledgers
    .filter((l) => cashIds.has(l.groupId) || bankIds.has(l.groupId))
    .map((l) => ({ ledgerId: l.id, name: l.name, kind: cashIds.has(l.groupId) ? ('cash' as const) : ('bank' as const), balance: bal.get(l.id) ?? 0 }))
    .sort((a, b) => (a.kind === b.kind ? b.balance - a.balance : a.kind === 'cash' ? -1 : 1))
  const cashTotal = accounts.filter((a) => a.kind === 'cash').reduce((s, a) => s + a.balance, 0)
  const bankTotal = accounts.filter((a) => a.kind === 'bank').reduce((s, a) => s + a.balance, 0)
  const cash: HomeCash = { accounts, cash: cashTotal, bank: bankTotal, total: cashTotal + bankTotal }

  // ---- money in / out today: per entry, its net on cash + bank (a move between them nets 0) ----
  const moneyIds = [...cashIds, ...bankIds]
  const moneyIn: HomeMoneyDay = { amount: 0, entries: 0 }
  const moneyOut: HomeMoneyDay = { amount: 0, entries: 0 }
  if (moneyIds.length) {
    const rows = db
      .prepare(
        `SELECT v.id, SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END) AS net
         FROM voucher_lines vl
         JOIN vouchers v ON v.id = vl.voucher_id
         JOIN ledgers l ON l.id = vl.ledger_id
         WHERE v.date = ? AND ${IN_BOOKS} AND l.group_id IN (${moneyIds.map(() => '?').join(',')})
         GROUP BY v.id`
      )
      .all(today, ...moneyIds) as { id: number; net: number }[]
    for (const r of rows) {
      if (r.net > 0) {
        moneyIn.amount += r.net
        moneyIn.entries++
      } else if (r.net < 0) {
        moneyOut.amount -= r.net
        moneyOut.entries++
      }
    }
  }

  // ---- who owes whom: the Outstandings allocation as on today ----
  const receivables = owedSummary(outstandings(db, 'receivable', today), today)
  const payables = owedSummary(outstandings(db, 'payable', today), today)

  // ---- profit: this month and the FY, to today (the Gateway's month and period P&L) ----
  const month = monthOf(today)
  const span = monthSpan(month, { from: fy.from, asOn: today }) ?? { from: today, to: today }
  const stock = stockValuesAt(db, [addDays(fy.from, -1), addDays(span.from, -1), today])
  const pnl = (from: string, to: string): HomeProfitPeriod => {
    const openingStock = stock.get(addDays(from, -1))!
    const closingStock = stock.get(to)!
    return { from, to, netProfit: profitAndLoss(db, from, to, { openingStock, closingStock }).netProfit, openingStock, closingStock }
  }
  const profit = { month: { month, ...pnl(span.from, span.to) }, year: pnl(fy.from, today) }

  // ---- GST: the Gateway's row for a regular registration; composition gets the CMP-08 note ----
  const filing = company.gstRegistrationType === 'regular' ? getGstProfile(db).filing : 'monthly'
  const gstRow = dashGst(db, company, today)
  const gst: HomeGst | null = gstRow ? { kind: 'regular', filing, row: gstRow } : company.gstRegistrationType === 'composition' ? { kind: 'composition' } : null

  // ---- deadlines (WP 8.0: applicable ones only), other than GST ----
  const hasPayroll = features.payroll && !!db.prepare('SELECT 1 FROM employees WHERE active = 1 LIMIT 1').get()
  const tds = tdsApplies(db, company, features.tds, tdsPayableLedgers(ledgers, dutiesIds, bal).length > 0)
  const deadlines = upcomingDeadlines(today, company.gstRegistrationType, hasPayroll, 30, { tds, gstFiling: filing }).filter((d) => d.kind !== 'gst')

  // ---- needs attention: the close checklist (previous month, the Assistants default) + anomalies ----
  let attention: HomeAttention | null = null
  const period = addMonths(month, -1)
  try {
    const checks = closeChecklist(db, company, period, today).checks
    const found = anomalies(db, fy.from, today).rows
    attention = { period, items: attentionItems(checks, found) }
  } catch {
    attention = null // never blanks Home; the Assistants screen shows the error
  }

  // ---- backup nudge ----
  const mine = userBackupsOf(opts.backups)
  const lastAt = mine.reduce<number | null>((a, b) => (a == null || b.mtime > a ? b.mtime : a), null)
  const days = lastAt == null ? null : daysSince(lastAt, today)
  const backup = { lastAt, days, nudge: days != null && days > BACKUP_NUDGE_DAYS }

  const setup = dashSetup(db, company, ledgers.filter((l) => bankIds.has(l.groupId)).length, mine.length)
  const ui = getUi(db)

  return {
    today,
    fy: { from: fy.from, to: fy.to },
    moneyIn,
    moneyOut,
    receivables,
    payables,
    cash,
    profit,
    gst,
    deadlines,
    attention,
    backup,
    setup,
    gstAnswer: ui.setup?.gst ?? null
  }
}
