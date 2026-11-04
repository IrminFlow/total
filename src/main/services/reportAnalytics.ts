/**
 * Comparatives and ratio analysis (WP 6.2). Everything here composes the existing statements —
 * profitAndLoss / balanceSheet (and through them pnlLedgerAmounts, the single profit definition),
 * closingBalances, the inventory valuation pass (stockValuesAt) and the registers' net trade —
 * so a comparative column or a ratio input always equals the statement it came from.
 */
import type { DB } from '../db/connection'
import type { BalanceSheet, ProfitAndLoss } from '@shared/reports'
import { CASH_BANK_GROUPS } from '@shared/seed'
import { computeRatioSet, type RatioPoint, type RatioReport, type RatioSetInput } from '@shared/ratios'
import { addDays, monthEnd, periodKeysBetween, periodLabel, previousPeriod, previousYear, type DateRange } from '@shared/reportPeriod'
import { balanceSheet, closingBalances, descendantIdSet, profitAndLoss } from './reports'
import { listGroups } from './masters'
import { netTradeRows } from './analysis'
import { stockValuesAt } from './stockAnalysis'
import { partySideGroupIds } from '@shared/chartOfAccounts'

// ---------------------------------------------------------------- comparative statements

export interface ComparativeColumn {
  key: 'current' | 'previous' | 'lastYear'
  label: string
  from: string
  to: string
}

export interface ComparativePnl {
  columns: ComparativeColumn[]
  statements: ProfitAndLoss[]
}

export interface ComparativeBs {
  columns: ComparativeColumn[]
  statements: BalanceSheet[]
}

function comparativeColumns(from: string, to: string): ComparativeColumn[] {
  const prev = previousPeriod(from, to)
  const ly = previousYear(from, to)
  return [
    { key: 'current', label: 'This period', from, to },
    { key: 'previous', label: 'Previous period', ...prev },
    { key: 'lastYear', label: 'Same period last year', ...ly }
  ]
}

/** The P&L for the period, the period before it and the same period a year earlier. */
export function comparativePnl(db: DB, from: string, to: string): ComparativePnl {
  const columns = comparativeColumns(from, to)
  return { columns, statements: columns.map((c) => profitAndLoss(db, c.from, c.to)) }
}

/** The balance sheet as on the period end, the previous period's end and a year earlier. */
export function comparativeBs(db: DB, booksFrom: string, from: string, to: string): ComparativeBs {
  const columns = comparativeColumns(from, to)
  return { columns, statements: columns.map((c) => balanceSheet(db, booksFrom, c.to)) }
}

// ---------------------------------------------------------------- ratios

interface Position {
  currentAssets: number
  currentLiabilities: number
  stock: number
  cashBank: number
  receivables: number
  payables: number
  totalAssets: number
  equity: number
  debt: number
}

/** Ratios for the period and for each month in it (capped at the last 36 months). */
export function ratioReport(db: DB, from: string, to: string): RatioReport {
  const groups = listGroups(db)
  const ledgers = db.prepare('SELECT id, group_id AS groupId, opening_balance AS openingBalance FROM ledgers').all() as { id: number; groupId: number; openingBalance: number }[]
  const byId = new Map(groups.map((g) => [g.id, g]))
  const topNature = (groupId: number): string => {
    let g = byId.get(groupId)
    const seen = new Set<number>()
    while (g && g.parentId !== null && byId.has(g.parentId) && !seen.has(g.id)) {
      seen.add(g.id)
      g = byId.get(g.parentId)
    }
    return g?.nature ?? 'asset'
  }
  const set = (names: string[]): Set<number> => descendantIdSet(groups, names)
  const ca = set(['Current Assets'])
  const cl = set(['Current Liabilities'])
  // Cash and bank without overdrafts; an overdraft is a current liability (cash ratio, CL).
  const cash = set(CASH_BANK_GROUPS.filter((n) => n !== 'Bank OD A/c'))
  const od = set(['Bank OD A/c'])
  const debtors = partySideGroupIds(groups, 'debtor')
  const creditors = partySideGroupIds(groups, 'creditor')
  const capital = set(['Capital Account'])
  const loans = set(['Loans (Liability)'])
  const stockGroups = set(['Stock-in-Hand'])

  const monthKeys = periodKeysBetween(from, to, 'month').slice(-36)
  const months: (DateRange & { key: string })[] = monthKeys.map((k) => ({
    key: k,
    from: `${k}-01` < from ? from : `${k}-01`,
    to: monthEnd(`${k}-01`) > to ? to : monthEnd(`${k}-01`)
  }))
  const boundaryDates = [addDays(from, -1), to, ...months.flatMap((m) => [addDays(m.from, -1), m.to])]
  const stockAt = stockValuesAt(db, boundaryDates)

  const positions = new Map<string, Position>()
  const positionAt = (date: string): Position => {
    const cached = positions.get(date)
    if (cached) return cached
    const bal = closingBalances(db, date)
    const sum = (ids: Set<number>, sign: 1 | -1, onlyPositive = false): number =>
      ledgers.reduce((s, l) => {
        if (!ids.has(l.groupId)) return s
        const v = sign * (bal.get(l.id) ?? 0)
        return s + (onlyPositive ? Math.max(0, v) : v)
      }, 0)
    // As on the balance sheet: a Stock-in-Hand ledger that carries the stock replaces the
    // computed closing stock (v0.3 #63); otherwise the valuation engine's figure is added.
    const stockLedgers = ledgers.filter((l) => stockGroups.has(l.groupId) && (l.openingBalance !== 0 || (bal.get(l.id) ?? 0) !== 0))
    const stock = stockLedgers.length ? stockLedgers.reduce((s, l) => s + (bal.get(l.id) ?? 0), 0) : (stockAt.get(date) ?? 0)
    const extraStock = stockLedgers.length ? 0 : stock
    let assets = 0
    let outside = 0
    for (const l of ledgers) {
      const v = bal.get(l.id) ?? 0
      const nature = topNature(l.groupId)
      if (nature === 'asset') assets += v
      else if (nature === 'liability' && !capital.has(l.groupId)) outside -= v
    }
    const totalAssets = assets + extraStock
    const p: Position = {
      currentAssets: sum(ca, 1) + extraStock,
      currentLiabilities: sum(cl, -1) + sum(od, -1, true),
      stock,
      cashBank: sum(cash, 1),
      receivables: sum(debtors, 1, true),
      payables: sum(creditors, -1, true),
      totalAssets,
      equity: totalAssets - outside,
      debt: sum(loans, -1)
    }
    positions.set(date, p)
    return p
  }

  const trade = new Map<string, { sales: number; purchases: number }>()
  let totalSales = 0
  let totalPurchases = 0
  for (const r of netTradeRows(db, from, to)) {
    const t = trade.get(r.month) ?? { sales: 0, purchases: 0 }
    t.sales += r.sales
    t.purchases += r.purchases
    trade.set(r.month, t)
    totalSales += r.sales
    totalPurchases += r.purchases
  }

  const point = (r: DateRange, key: string, label: string, sales: number, purchases: number): RatioPoint & { input: RatioSetInput } => {
    const open = positionAt(addDays(r.from, -1))
    const close = positionAt(r.to)
    const pnl = profitAndLoss(db, r.from, r.to, { openingStock: stockAt.get(addDays(r.from, -1)) ?? 0, closingStock: stockAt.get(r.to) ?? 0 })
    const input: RatioSetInput = {
      ...close,
      openingReceivables: open.receivables,
      openingPayables: open.payables,
      openingTotalAssets: open.totalAssets,
      openingEquity: open.equity,
      sales,
      purchases,
      openingStock: pnl.openingStock,
      closingStock: pnl.closingStock,
      grossProfit: pnl.grossProfit,
      netProfit: pnl.netProfit,
      periodDays: Math.max(1, Math.round((Date.parse(r.to) - Date.parse(r.from)) / 86_400_000) + 1)
    }
    return { key, label, from: r.from, to: r.to, ratios: computeRatioSet(input), input }
  }

  const whole = point({ from, to }, 'period', 'Period', totalSales, totalPurchases)
  const monthPoints = months.map((m) => {
    const t = trade.get(m.key) ?? { sales: 0, purchases: 0 }
    const { input: _input, ...rest } = point(m, m.key, periodLabel(m.key, 'month'), t.sales, t.purchases)
    void _input
    return rest
  })
  const { input, ...period } = whole
  return { period, months: monthPoints, inputs: input }
}
