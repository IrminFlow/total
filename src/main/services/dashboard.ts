// Gateway dashboard series (WP 1.10b). Every figure is computed at query time from voucher_lines
// through the function the matching report uses — never a second definition:
//   trade (sales / purchases)   analysis.registerVoucherRows + noteVoucherRows (Registers screen)
//   monthly / period net profit reports.profitAndLoss (P&L screen), month by month
//   cash & bank                 opening + in-books movements per ledger (= trial balance rows)
//   receivables / payables      analysis.outstandings (Outstandings screen totals + ageing buckets)
//   top customers / suppliers   the same register rows, grouped by party
//   GST                         gst.gstr3b (GSTR-3B screen) + compliance.upcomingDeadlines
//   TDS                         tds.tdsSummary (TDS screen) + the "TDS Payable …" ledger balances
//   stock alerts                stockAnalysis.negativeStock (Exceptions) + reports.stockAgeing
//   activity                    the Day Book's scope (bin excluded, optional / PDC included)
// Each section runs in its own try/catch so one failing query can't blank the Gateway.
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import {
  dashboardWindow, monthOf, monthSpan, addDays, addMonths, weekStart, monthEnd,
  type DashAgeing, type DashCash, type DashCashLedger, type DashGst, type DashMonth, type DashParty,
  type DashSection, type DashSetup, type DashStatus, type DashStock, type DashStockAlert, type DashTds,
  type DashTrade, type DashTrendPoint, type DashboardSeries, type DashboardWindow, type DashActivity
} from '@shared/dashboard'
import { upcomingDeadlines } from '@shared/compliance'
import { tdsQuarterOf } from '@shared/tds'
import { gstPeriodOf } from '@shared/dates'
import { closingBalances, descendantIdSet, profitAndLoss, stockAgeing } from './reports'
import { netTradeRows, outstandings } from './analysis'
import { negativeStock, stockValuesAt } from './stockAnalysis'
import { gstr3b, turnover } from './gst'
import { itc04Periodicity } from '@shared/gst/itc04'
import { fyOf } from '@shared/dates'
import { tdsSummary } from './tds'
import { getFeatures } from './config'
import { listGroups } from './masters'
import { IN_BOOKS, NOT_DELETED, getLockDate } from './vouchers'
import { promisedThisWeek } from './receivables'

/** Mirrors db/backup.ts BackupInfo — passed in by the IPC handler (the service never touches
 *  the filesystem, so dbtests can hand it a list). */
export interface DashBackupInput {
  mtime: number
  tag: string
}

/** On-open snapshots are automatic on every company open — they don't count as "you backed up". */
const AUTOMATIC_TAGS = new Set(['open'])

/**
 * WP 3.4 — the annual GST deadlines in the next 45 days: GSTR-9 (31 December, rule 80) and, when
 * the company keeps job-worker godowns, ITC-04 (25 October / 25 April, rule 45(3) + Notification
 * 35/2021-CT) at the periodicity the preceding FY's turnover gives. Sources: shared/gst/sources.ts.
 */
function annualGstDeadlines(db: DB, today: string): { form: string; title: string; date: string }[] {
  const jobWork = db.prepare("SELECT 1 FROM godowns WHERE kind = 'job_worker' LIMIT 1").get() != null
  const fy = fyOf(today)
  const prev = fyOf(`${fy.startYear - 1}-06-01`)
  const itc04 = jobWork ? itc04Periodicity(turnover(db, prev.from, prev.to)) : undefined
  return upcomingDeadlines(today, 'regular', false, 45, { jobWork, itc04 })
    .filter((d) => d.form === 'GSTR-9' || d.form === 'ITC-04')
    .map((d) => ({ form: d.form, title: d.title, date: d.date }))
}

function section<T>(fn: () => T): DashSection<T> {
  try {
    return { ok: true, data: fn() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

const sum4 = (a: { igst: number; cgst: number; sgst: number; cess: number }): number => a.igst + a.cgst + a.sgst + a.cess

interface LedgerRow { id: number; name: string; groupId: number; openingBalance: number }

export function dashboardSeries(
  db: DB,
  company: CompanyInfo,
  opts: { today: string; from: string; to: string; backups: DashBackupInput[] }
): DashboardSeries {
  // One read transaction: every card sees the same snapshot of the books.
  return db.transaction(() => computeSeries(db, company, opts))()
}

function computeSeries(
  db: DB,
  company: CompanyInfo,
  opts: { today: string; from: string; to: string; backups: DashBackupInput[] }
): DashboardSeries {
  const w = dashboardWindow(opts.today, opts.from, opts.to)
  const features = getFeatures(db)
  const groups = listGroups(db)
  const ledgers = db
    .prepare('SELECT id, name, group_id AS groupId, opening_balance AS openingBalance FROM ledgers')
    .all() as LedgerRow[]
  const ledgerName = new Map(ledgers.map((l) => [l.id, l.name]))

  const cashIds = descendantIdSet(groups, ['Cash-in-Hand'])
  const bankIds = descendantIdSet(groups, ['Bank Accounts', 'Bank OD A/c'])
  const debtorIds = descendantIdSet(groups, ['Sundry Debtors'])
  const creditorIds = descendantIdSet(groups, ['Sundry Creditors'])
  const dutiesIds = descendantIdSet(groups, ['Duties & Taxes'])

  // Month-end and as-on balances of every cash/bank/party/duties ledger from ONE grouped
  // (ledger, month) pass — the same opening + in-books-movements ≤ date sum closingBalances
  // computes (the dbtest pins every cash/bank figure to the trial balance), without a second
  // scan of all voucher lines.
  let monthEndCache: ReturnType<typeof monthEndBalances> | null = null
  const monthData = (): ReturnType<typeof monthEndBalances> =>
    (monthEndCache ??= monthEndBalances(db, ledgers, new Set([...cashIds, ...bankIds, ...debtorIds, ...creditorIds, ...dutiesIds]), w))
  const balances = (): Map<number, number> => monthData().closing
  const monthEnds = (): Map<number, Map<string, number>> => monthData().ends

  const trendOf = (ids: Set<number>, valueOf: (bal: number) => number): DashTrendPoint[] => {
    const ends = monthEnds()
    return w.sparkMonths.map((month) => {
      let amount = 0
      for (const l of ledgers) {
        if (!ids.has(l.groupId)) continue
        amount += valueOf(ends.get(l.id)?.get(month) ?? l.openingBalance)
      }
      return { month, amount }
    })
  }

  const tradeRows = (() => {
    let cache: ReturnType<typeof netTradeRows> | null = null
    return () => (cache ??= netTradeRows(db, seriesStart(w), w.asOn))
  })()

  const trade = section((): DashTrade => trade_(db, w, tradeRows()))

  const cash = section((): DashCash => {
    const bal = balances()
    const rows: DashCashLedger[] = ledgers
      .filter((l) => cashIds.has(l.groupId) || bankIds.has(l.groupId))
      .map((l) => ({ ledgerId: l.id, name: l.name, kind: cashIds.has(l.groupId) ? ('cash' as const) : ('bank' as const), balance: bal.get(l.id) ?? 0 }))
      .sort((a, b) => (a.kind === b.kind ? b.balance - a.balance : a.kind === 'cash' ? -1 : 1))
    const cashTotal = rows.filter((r) => r.kind === 'cash').reduce((s, r) => s + r.balance, 0)
    const bankTotal = rows.filter((r) => r.kind === 'bank').reduce((s, r) => s + r.balance, 0)
    return {
      ledgers: rows,
      cash: cashTotal,
      bank: bankTotal,
      total: cashTotal + bankTotal,
      trend: trendOf(new Set([...cashIds, ...bankIds]), (b) => b)
    }
  })

  const ageing = (side: 'receivable' | 'payable'): DashAgeing => {
    const parties = outstandings(db, side, w.asOn)
    const buckets: [number, number, number, number] = [0, 0, 0, 0]
    for (const p of parties) for (let i = 0; i < 4; i++) buckets[i]! += p.buckets[i]!
    return {
      total: parties.reduce((s, p) => s + p.pending, 0),
      buckets,
      parties: parties.filter((p) => p.pending !== 0).length,
      trend: side === 'receivable' ? trendOf(debtorIds, (b) => Math.max(0, b)) : trendOf(creditorIds, (b) => Math.max(0, -b))
    }
  }
  const receivables = section(() => ageing('receivable'))
  const payables = section(() => ageing('payable'))

  const topBy = (key: 'sales' | 'purchases'): DashParty[] => {
    const byParty = new Map<number, number>()
    for (const r of tradeRows()) {
      if (r.partyLedgerId == null || r.date < w.from || r[key] === 0) continue
      byParty.set(r.partyLedgerId, (byParty.get(r.partyLedgerId) ?? 0) + r[key])
    }
    return [...byParty]
      .filter(([, amount]) => amount > 0)
      .map(([ledgerId, amount]) => ({ ledgerId, name: ledgerName.get(ledgerId) ?? '', amount }))
      .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name))
      .slice(0, 5)
  }
  const topCustomers = section(() => topBy('sales'))
  const topSuppliers = section(() => topBy('purchases'))

  const gst = section((): DashGst | null => {
    if (company.gstRegistrationType !== 'regular') return null
    const due = upcomingDeadlines(w.today, 'regular', false, 45).filter((d) => d.kind === 'gst')
    const next3b = due.find((d) => d.form === 'GSTR-3B')
    const next1 = due.find((d) => d.form === 'GSTR-1')
    // The return the next GSTR-3B files covers the month before its due month.
    const period = addMonths(monthOf(next3b?.date ?? w.today), -1)
    const from = `${period}-01`
    const to = monthEnd(period)
    const r = gstr3b(db, company, from, to, gstPeriodOf(from))
    return {
      period,
      gstr1Due: next1?.date ?? null,
      gstr3bDue: next3b?.date ?? null,
      liability: sum4(r.outward) + r.zeroRated.igst + r.zeroRated.cess + sum4(r.rcm),
      itc: sum4(r.itc),
      payable: sum4(r.netPayable) + sum4(r.rcmPayable),
      annual: annualGstDeadlines(db, w.today)
    }
  })

  const tds = section((): DashTds | null => {
    if (!features.tds) return null
    const q = tdsQuarterOf(w.today)
    const deducted = tdsSummary(db, q.fyStartYear)
      .filter((r) => r.quarter === q.label)
      .reduce((s, r) => s + r.tds, 0)
    const bal = w.asOn === w.today ? balances() : closingBalances(db, w.today)
    const payableLedgers = ledgers
      .filter((l) => dutiesIds.has(l.groupId) && l.name.startsWith('TDS Payable'))
      .map((l) => ({ ledgerId: l.id, name: l.name, balance: -(bal.get(l.id) ?? 0) }))
      .filter((l) => l.balance !== 0)
    const nextDue = upcomingDeadlines(w.today, company.gstRegistrationType, false, 45).find((d) => d.kind === 'tds')?.date ?? null
    return { quarter: q.label, deducted, payable: payableLedgers.reduce((s, l) => s + l.balance, 0), payableLedgers, nextDue }
  })

  const stock = section((): DashStock | null => {
    if (!features.inventory) return null
    const meta = new Map(
      (db
        .prepare(
          `SELECT si.id, u.symbol AS unitSymbol, u.decimals, si.reorder_level_milli AS reorderLevelMilli
           FROM stock_items si JOIN units u ON u.id = si.unit_id`
        )
        .all() as { id: number; unitSymbol: string; decimals: number; reorderLevelMilli: number | null }[]).map((r) => [r.id, r])
    )
    const negative: DashStockAlert[] = negativeStock(db, w.asOn).map((n) => ({
      stockItemId: n.stockItemId,
      name: n.name,
      unitSymbol: n.unitSymbol,
      decimals: meta.get(n.stockItemId)?.decimals ?? 0,
      closingQtyMilli: n.closingQtyMilli,
      reorderLevelMilli: meta.get(n.stockItemId)?.reorderLevelMilli ?? null
    }))
    const hasReorder = [...meta.values()].some((m) => m.reorderLevelMilli != null)
    const belowReorder: DashStockAlert[] = hasReorder
      ? stockAgeing(db, w.asOn)
          .filter((r) => r.belowReorder)
          .map((r) => ({
            stockItemId: r.stockItemId, name: r.name, unitSymbol: r.unitSymbol, decimals: r.decimals,
            closingQtyMilli: r.closingQtyMilli, reorderLevelMilli: r.reorderLevelMilli
          }))
      : []
    return { negative, belowReorder }
  })

  const activity = section((): DashActivity => {
    const weekFrom = weekStart(w.today)
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN v.date = ? THEN 1 ELSE 0 END), 0) AS today, COUNT(*) AS week
         FROM vouchers v WHERE v.date BETWEEN ? AND ? AND ${NOT_DELETED}`
      )
      .get(w.today, weekFrom, w.today) as { today: number; week: number }
    return { today: row.today, week: row.week, weekFrom }
  })

  const userBackups = opts.backups.filter((b) => !AUTOMATIC_TAGS.has(b.tag)).length
  const status = section((): DashStatus => {
    const newest = opts.backups.reduce<DashBackupInput | null>((a, b) => (a == null || b.mtime > a.mtime ? b : a), null)
    return { lockDate: getLockDate(db), lastBackup: newest ? { at: newest.mtime, tag: newest.tag } : null, userBackups }
  })

  const setup = section((): DashSetup => {
    const counts = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM ledgers WHERE is_system = 0) AS userLedgers,
                (SELECT COUNT(*) FROM vouchers v WHERE ${NOT_DELETED}) AS voucherCount`
      )
      .get() as { userLedgers: number; voucherCount: number }
    return {
      companyInfoComplete: !!company.address.trim() && !!(company.email || company.phone) && !!company.pan,
      gstRegistered: company.gstRegistrationType !== 'unregistered',
      gstinSet: !!company.gstin,
      userLedgers: counts.userLedgers,
      bankLedgers: ledgers.filter((l) => bankIds.has(l.groupId)).length,
      voucherCount: counts.voucherCount,
      userBackups
    }
  })

  return { window: w, trade, cash, receivables, payables, topCustomers, topSuppliers, gst, tds, stock, activity, status, setup }
}

/** Earliest date any series needs: the period start or the first spark month, whichever is first. */
function seriesStart(w: DashboardWindow): string {
  const sparkFrom = `${w.sparkMonths[0]!}-01`
  return sparkFrom < w.from ? sparkFrom : w.from
}

/** Months with figures — the spark months and the period months up to asOn — with their sales,
 *  purchases (register rows, net of notes) and P&L net profit. */
function trade_(db: DB, w: DashboardWindow, rows: ReturnType<typeof netTradeRows>): DashTrade {
  const all = [...new Set([...w.sparkMonths, ...w.periodMonths])].sort()
  const spans = all
    .map((month) => ({ month, span: monthSpan(month, w) }))
    .filter((m): m is { month: string; span: { from: string; to: string } } => m.span != null)

  // Every stock figure the month P&Ls (and the period P&L) need, from one inventory walk.
  const periodTo = w.asOn
  const stockDates = [addDays(w.from, -1), periodTo, ...spans.flatMap((m) => [addDays(m.span.from, -1), m.span.to])]
  const stock = stockValuesAt(db, stockDates)
  const pnl = (from: string, to: string): number =>
    profitAndLoss(db, from, to, { openingStock: stock.get(addDays(from, -1))!, closingStock: stock.get(to)! }).netProfit

  // Each month's trade covers exactly its span (a first period month starting mid-month is
  // clipped to `from`, same as its P&L).
  const spanOf = new Map(spans.map((m) => [m.month, m.span]))
  const byMonth = new Map<string, { sales: number; purchases: number }>()
  for (const r of rows) {
    const span = spanOf.get(r.month)
    if (!span || r.date < span.from || r.date > span.to) continue
    const m = byMonth.get(r.month) ?? { sales: 0, purchases: 0 }
    m.sales += r.sales
    m.purchases += r.purchases
    byMonth.set(r.month, m)
  }

  const months: DashMonth[] = spans.map(({ month, span }) => ({
    month,
    from: span.from,
    to: span.to,
    sales: byMonth.get(month)?.sales ?? 0,
    purchases: byMonth.get(month)?.purchases ?? 0,
    netProfit: pnl(span.from, span.to)
  }))
  const inPeriod = months.filter((m) => m.from >= w.from && m.to <= w.to)
  return {
    months,
    periodNetProfit: w.asOn >= w.from ? pnl(w.from, periodTo) : 0,
    periodSales: inPeriod.reduce((s, m) => s + m.sales, 0),
    periodPurchases: inPeriod.reduce((s, m) => s + m.purchases, 0)
  }
}

/** Per ledger (in `groupIds`), the balance at each spark month's end (clipped to asOn) and as on
 *  asOn: opening + in-books movements ≤ that date. One grouped (ledger, month) query. */
function monthEndBalances(
  db: DB,
  ledgers: LedgerRow[],
  groupIds: Set<number>,
  w: DashboardWindow
): { ends: Map<number, Map<string, number>>; closing: Map<number, number> } {
  const result = new Map<number, Map<string, number>>()
  const closing = new Map<number, number>()
  if (groupIds.size === 0) return { ends: result, closing }
  const placeholders = [...groupIds].map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT vl.ledger_id AS ledgerId, substr(v.date, 1, 7) AS month,
              SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END) AS net
       FROM voucher_lines vl
       JOIN vouchers v ON v.id = vl.voucher_id
       JOIN ledgers l ON l.id = vl.ledger_id
       WHERE l.group_id IN (${placeholders}) AND v.date <= ? AND ${IN_BOOKS}
       GROUP BY vl.ledger_id, month
       ORDER BY vl.ledger_id, month`
    )
    .all(...groupIds, w.asOn) as { ledgerId: number; month: string; net: number }[]
  const moves = new Map<number, { month: string; net: number }[]>()
  for (const r of rows) {
    const list = moves.get(r.ledgerId) ?? []
    list.push(r)
    moves.set(r.ledgerId, list)
  }
  for (const l of ledgers) {
    if (!groupIds.has(l.groupId)) continue
    const list = moves.get(l.id) ?? []
    const ends = new Map<string, number>()
    let bal = l.openingBalance
    let i = 0
    for (const month of w.sparkMonths) {
      while (i < list.length && list[i]!.month <= month) bal += list[i++]!.net
      ends.set(month, bal)
    }
    while (i < list.length) bal += list[i++]!.net
    result.set(l.id, ends)
    closing.set(l.id, bal)
  }
  return { ends: result, closing }
}

/**
 * WP 4.2 — the Gateway's "promised this week" chip (Compliance card): promises to pay on bills
 * still open, from the follow-ups (services/receivables.ts). Kept a separate function and a
 * separate channel (report:dashboardPromised) so the dashboard series stays untouched.
 */
export function dashPromisedPayments(db: DB, today: string): { count: number; amount: number; overdueCount: number; weekFrom: string; weekTo: string } {
  const s = promisedThisWeek(db, today)
  return { count: s.count, amount: s.amount, overdueCount: s.overdueCount, weekFrom: s.weekFrom, weekTo: s.weekTo }
}
