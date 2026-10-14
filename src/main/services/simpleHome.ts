// Simple Home (WP 8.6) — what the simple Home shows, as on TODAY (never the financial year's end;
// a later date asked for is clamped to the server's today). Every figure comes from the service
// the matching accountant screen uses, so the two never disagree (simpleHome.dbtest.ts pins each):
//   customers / suppliers  analysis.outstandingsWithAdvances (Outstandings screen; Gateway tiles)
//   cash and bank          reports.closingBalances (trial balance rows; Gateway Cash & bank)
//   profit                 reports.profitAndLoss → pnlLedgerAmounts (P&L; Gateway month / FY)
//   GST                    dashboard.dashGst (Gateway Compliance row) — regular only — and the
//                          stored GSTR-2B statements for "booked, not yet confirmed"
//   deadlines              compliance.upcomingDeadlines + the WP 8.0 applicability rules
//   setup                  dashboard.dashSetup (Gateway setup card → onboarding.ts)
// `simple:home` is the fast half (one round trip, every tile); `simple:homeAttention` is the slow
// half — the close checklist and the anomaly scan — fetched after Home shows (capped: no anomaly
// scan over ANOMALY_HOME_CAP entries). Read-only: read transactions, nothing stored.
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { addDays, addMonths, monthOf, monthRange, monthSpan } from '@shared/dashboard'
import { fyOf, gstPeriodOf } from '@shared/dates'
import { upcomingDeadlines } from '@shared/compliance'
import { parseGstr2b, reconcile2b, recon2bOptionsFrom } from '@shared/gst/recon2b'
import {
  ANOMALY_HOME_CAP, attentionItems, BACKUP_NUDGE_DAYS, daysSince, owedSummary,
  type HomeAttention, type HomeCash, type HomeGst, type HomeGstCredit, type HomeMoneyDay, type HomeProfitPeriod, type SimpleHomeData
} from '@shared/simple/home'
import { GST_FILED_META_KEY, gstPeriodEnd, gstStartsOn, normalizeGstFiled, type GstFiledMeta } from '@shared/simple/taxes'
import { doingLines, previousSpan, topParts, withoutRoundOff } from '@shared/simple/reports'
import type { ProfitAndLoss } from '@shared/reports'
import { descendantIdSet, profitAndLoss } from './reports'
import { outstandingsWithAdvances } from './analysis'
import { stockValuesAt } from './stockAnalysis'
import { listGroups } from './masters'
import { IN_BOOKS } from './vouchers'
import { getFeatures, getGstProfile, getUi } from './config'
import { dashGst, dashSetup, tdsApplies, tdsPayableLedgers, userBackupsOf, type DashBackupInput } from './dashboard'
import { anomalies, closeChecklist, getStatement } from './assistants'
import { extractPurchaseDocs } from './gst'
import { getRecon2bTolerances } from './gstIms'
import { stockAttentionCounts } from './simpleStock'

/** The as-on date: what was asked for, never after the server's today. */
export function homeAsOn(asked: string | undefined, serverToday: string): string {
  return asked && asked < serverToday ? asked : serverToday
}

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
  const loanIds = new Set([...descendantIdSet(groups, ['Loans (Liability)'])].filter((id) => !bankIds.has(id)))
  const dutiesIds = descendantIdSet(groups, ['Duties & Taxes'])
  const bal = balancesOf(db, ledgers.filter((l) => cashIds.has(l.groupId) || bankIds.has(l.groupId) || dutiesIds.has(l.groupId)).map((l) => l.id), today)

  // ---- cash and bank: each account's balance as on today ----
  const accounts = ledgers
    .filter((l) => cashIds.has(l.groupId) || bankIds.has(l.groupId))
    .map((l) => ({ ledgerId: l.id, name: l.name, kind: cashIds.has(l.groupId) ? ('cash' as const) : ('bank' as const), balance: bal.get(l.id) ?? 0 }))
    .sort((a, b) => (a.kind === b.kind ? b.balance - a.balance : a.kind === 'cash' ? -1 : 1))
  const cashTotal = accounts.filter((a) => a.kind === 'cash').reduce((s, a) => s + a.balance, 0)
  const bankTotal = accounts.filter((a) => a.kind === 'bank').reduce((s, a) => s + a.balance, 0)
  const cash: HomeCash = { accounts, cash: cashTotal, bank: bankTotal, total: cashTotal + bankTotal }

  // ---- money in / out today: per entry, its net on cash + bank (a move between them nets 0);
  //      the part whose other side is a loan account is borrowed / repaid money ----
  const moneyIds = [...cashIds, ...bankIds]
  const moneyIn: HomeMoneyDay = { amount: 0, entries: 0, loans: 0 }
  const moneyOut: HomeMoneyDay = { amount: 0, entries: 0, loans: 0 }
  if (moneyIds.length) {
    const inList = (ids: Iterable<number>): string => [...ids].join(',') || 'NULL'
    const rows = db
      .prepare(
        `SELECT v.id,
                SUM(CASE WHEN l.group_id IN (${inList(moneyIds)}) THEN (CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END) ELSE 0 END) AS net,
                SUM(CASE WHEN l.group_id IN (${inList(loanIds)}) THEN (CASE WHEN vl.dr_cr = 'cr' THEN vl.amount ELSE -vl.amount END) ELSE 0 END) AS loanCr
         FROM voucher_lines vl
         JOIN vouchers v ON v.id = vl.voucher_id
         JOIN ledgers l ON l.id = vl.ledger_id
         WHERE v.date = ? AND ${IN_BOOKS}
         GROUP BY v.id`
      )
      .all(today) as { id: number; net: number; loanCr: number }[]
    for (const r of rows) {
      if (r.net > 0) {
        moneyIn.amount += r.net
        moneyIn.entries++
        if (r.loanCr > 0) moneyIn.loans += Math.min(r.net, r.loanCr)
      } else if (r.net < 0) {
        moneyOut.amount -= r.net
        moneyOut.entries++
        if (r.loanCr < 0) moneyOut.loans += Math.min(-r.net, -r.loanCr)
      }
    }
  }

  // ---- who owes whom: the Outstandings allocation as on today (+ its unapplied credit) ----
  const owed = (side: 'receivable' | 'payable'): ReturnType<typeof owedSummary> => {
    const o = outstandingsWithAdvances(db, side, today)
    return owedSummary(o.parties, today, { amount: o.advances, parties: o.advanceParties })
  }
  const receivables = owed('receivable')
  const payables = owed('payable')

  // ---- profit: this month and the FY, to today (the Gateway's month and period P&L) ----
  const month = monthOf(today)
  const span = monthSpan(month, { from: fy.from, asOn: today }) ?? { from: today, to: today }
  // WP 10.2: the month is compared with the same days of the month before (Reports' rule).
  const prevSpan = previousSpan('this-month', span)
  const stock = stockValuesAt(db, [addDays(fy.from, -1), addDays(span.from, -1), today, addDays(prevSpan.from, -1), prevSpan.to])
  const pnlOf = (from: string, to: string): { pnl: ProfitAndLoss; openingStock: number; closingStock: number } => {
    const openingStock = stock.get(addDays(from, -1))!
    const closingStock = stock.get(to)!
    return { pnl: profitAndLoss(db, from, to, { openingStock, closingStock }), openingStock, closingStock }
  }
  const pnl = (from: string, to: string): HomeProfitPeriod => {
    const p = pnlOf(from, to)
    const top = topParts(withoutRoundOff(p.pnl.indirectExpenses), 1)[0] ?? null
    return { from, to, netProfit: p.pnl.netProfit, openingStock: p.openingStock, closingStock: p.closingStock, lines: doingLines(p.pnl), topExpense: top }
  }
  const profit = {
    month: { month, ...pnl(span.from, span.to) },
    year: pnl(fy.from, today),
    previousMonth: { ...prevSpan, lines: doingLines(pnlOf(prevSpan.from, prevSpan.to).pnl) }
  }

  // ---- GST: the Gateway's row for a regular registration; composition gets its note ----
  const filing = company.gstRegistrationType === 'regular' ? getGstProfile(db).filing : 'monthly'
  // WP 10.8: never a return period that ended before the books (or the registration) began.
  const gstRow = dashGst(db, company, today, gstStartsOn(company.booksBeginDate, company.gstRegistrationSince))
  const gst: HomeGst | null = gstRow
    ? { kind: 'regular', filing, row: gstRow, credit: gstCredit(db, gstRow.from ?? `${gstRow.period}-01`, gstRow.to ?? gstRow.from ?? `${gstRow.period}-01`) }
    : company.gstRegistrationType === 'composition'
      ? { kind: 'composition' }
      : null

  // ---- deadlines (WP 8.0: applicable ones only), other than GST ----
  const hasPayroll = features.payroll && !!db.prepare('SELECT 1 FROM employees WHERE active = 1 LIMIT 1').get()
  const tds = tdsApplies(db, company, features.tds, tdsPayableLedgers(ledgers, dutiesIds, bal).length > 0)
  const deadlines = upcomingDeadlines(today, company.gstRegistrationType, hasPayroll, 30, { tds, gstFiling: filing, stateCode: company.stateCode }).filter((d) => d.kind !== 'gst')

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
    backup,
    setup,
    gstAnswer: ui.setup?.gst ?? null
  }
}

/** reports.closingBalances' definition (opening + in-books movements up to `asOn`) for just the
 *  ledgers Home needs — cash, bank and the duties ledgers — instead of every ledger. The dbtest
 *  pins the result to the trial balance's / Gateway's figures. */
function balancesOf(db: DB, ids: number[], asOn: string): Map<number, number> {
  const out = new Map<number, number>()
  if (ids.length === 0) return out
  const rows = db
    .prepare(
      `SELECT l.id, l.opening_balance + COALESCE((
         SELECT SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END)
         FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
         WHERE vl.ledger_id = l.id AND v.date <= ? AND ${IN_BOOKS}
       ), 0) AS bal
       FROM ledgers l WHERE l.id IN (${ids.map(() => '?').join(',')})`
    )
    .all(asOn, ...ids) as { id: number; bal: number }[]
  for (const r of rows) out.set(r.id, r.bal)
  return out
}

/**
 * GST paid on purchases vs the imported GSTR-2B statements (one per return month, the WP 5.5
 * store): a month without a statement is unchecked; in a checked month, the tax on purchase bills
 * 2B does not list (the WP 3.4 matcher's `missingInPortal`) is booked but not yet confirmed.
 */
export function gstCredit(db: DB, from: string, to: string): HomeGstCredit {
  const months = monthRange(monthOf(from), monthOf(to))
  let checkedMonths = 0
  let awaiting = 0
  const tol = recon2bOptionsFrom(getRecon2bTolerances(db))
  for (const m of months) {
    const st = getStatement(db, gstPeriodOf(`${m}-01`))
    if (!st) continue
    checkedMonths++
    const mFrom = `${m}-01`
    const mTo = m === monthOf(to) ? to : addDays(`${addMonths(m, 1)}-01`, -1)
    const result = reconcile2b(parseGstr2b(st.jsonText).invoices, extractPurchaseDocs(db, mFrom, mTo), tol)
    const b = result.buckets.missingInPortal
    awaiting += b.igst + b.cgst + b.sgst + b.cess
  }
  return { checked: checkedMonths === 0 ? 'none' : checkedMonths === months.length ? 'all' : 'some', awaiting }
}

/** meta `gstFiled` (the Taxes screen's "I've filed" marks, shared/simple/taxes.ts); missing or
 *  malformed = none. simpleTaxes.ts writes it. */
export function readGstFiled(db: DB): GstFiledMeta {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(GST_FILED_META_KEY) as { value: string } | undefined
  if (!row) return {}
  try {
    return normalizeGstFiled(JSON.parse(row.value))
  } catch {
    return {}
  }
}

/** `simple:homeAttention` — the close checklist for the previous month (the Assistants default)
 *  and, unless the year has more than ANOMALY_HOME_CAP entries, the anomaly scan for the FY to
 *  today. Overdue bills are not taken from here (Home has them from the tiles, as on today). */
export function simpleHomeAttention(db: DB, company: CompanyInfo, today: string): HomeAttention {
  return db.transaction((): HomeAttention => {
    const fy = fyOf(today)
    const period = addMonths(monthOf(today), -1)
    // WP 10.8: a business whose books began after that month has nothing to close for it (a
    // company started today is not told "GST files for last month are not prepared").
    const startsOn = gstStartsOn(company.booksBeginDate, null)
    const checks = startsOn && gstPeriodEnd({ period }) < startsOn ? [] : closeChecklist(db, company, period, today).checks
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM vouchers v WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS}`).get(fy.from, today) as { n: number }).n
    const anomaliesSkipped = count > ANOMALY_HOME_CAP
    const found = anomaliesSkipped ? [] : anomalies(db, fy.from, today).rows
    // WP 9.9: once the user has noted BOTH returns of that period as filed (Taxes → "I've filed",
    // meta gstFiled), "GST files not prepared" is no longer something to look at — they may have
    // filed on the portal without Total's files. The Assistants checklist itself is unchanged.
    const filed = readGstFiled(db)[period]
    // WP 10.8 review: nor for a month that ended before the regular registration began (the
    // Taxes screen and Home's GST tile never offer it — the same gstStartsOn rule).
    const gstFrom = gstStartsOn(company.booksBeginDate, company.gstRegistrationSince)
    const noReturn = (filed?.gstr1 && filed.gstr3b) || (gstFrom != null && gstPeriodEnd({ period }) < gstFrom)
    const items = attentionItems(noReturn ? checks.filter((c) => c.key !== 'gst_returns') : checks, found)
    // WP 9.7: products running low or out (the Stock list's own rule, as on today) — one row
    // that opens the list filtered to them.
    const stock = getFeatures(db).inventory ? stockAttentionCounts(db, today) : { low: 0, negative: 0 }
    if (stock.low > 0) items.push({ source: 'stock', key: 'low_stock', count: stock.low, amount: null, level: 'medium' })
    // WP 10.8: stock sold before its purchase was recorded is costed at nothing by the valuation
    // pass — said on Home as on today (the month-end check only sees last month).
    // Only when last month's checks don't already say it (one row per finding).
    const negative = items.some((i) => i.key === 'negative_stock') ? 0 : stock.negative
    if (negative > 0) items.push({ source: 'stock', key: 'negative_stock', count: negative, amount: null, level: 'high' })
    return { period, items, anomaliesSkipped }
  })()
}
