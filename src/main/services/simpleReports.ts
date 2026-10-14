// The simple Reports screens (WP 9.9, plan 2026-10-13 §2.2 Reports, §3 "How is my business
// doing"). Read-only: every figure comes from the service the accountant screen uses, inside one
// read transaction, and nothing is stored (simpleReports.dbtest.ts pins each):
//   doing     reports.profitAndLoss (→ pnlLedgerAmounts, closing journals out) with the stock
//             figures from the one valuation pass (stockValuesAt) — the P&L screen's own numbers;
//             cash + bank = reports.closingBalances (trial balance basis); dues =
//             analysis.outstandingsWithAdvances as on the period's end (never after today)
//   cash      cashForecast.forecastBase + buildForecast, expected scenario (the Cash forecast
//             screen's defaults), the next 30 days
//   owed      analysis.outstandingsWithAdvances as on today
//   by month  analysis.registerByMonth (the Registers screen's monthly rows), 12 months
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { AppError } from '@shared/errors'
import { addDaysISO, buildForecast, SCENARIO_PRESETS, type ForecastSource } from '@shared/cashForecast'
import {
  CASH_HORIZON_DAYS, doingLines, last12Months, monthBars, monthTotals, owedRows, previousSpan, reportSpan, topParts,
  type BusinessDoing, type CashFlowSource, type CashItem, type DoingCash, type DoingOwed, type DoingQuery, type SimpleByMonth, type SimpleCash, type SimpleOwed
} from '@shared/simple/reports'
import { closingBalances, descendantIdSet, profitAndLoss } from './reports'
import { outstandingsWithAdvances, registerByMonth } from './analysis'
import { stockValuesAt } from './stockAnalysis'
import { listGroups } from './masters'
import { forecastBase } from './cashForecast'
import { NOT_DELETED } from './vouchers'

const dayBefore = (date: string): string => addDaysISO(date, -1)

/** Cash-in-hand and bank ledgers (Bank OD under banks), as Home and the Gateway count them. */
function moneyLedgers(db: DB): { cash: Set<number>; bank: Set<number> } {
  const groups = listGroups(db)
  const cashGroups = descendantIdSet(groups, ['Cash-in-Hand'])
  const bankGroups = descendantIdSet(groups, ['Bank Accounts', 'Bank OD A/c'])
  const rows = db.prepare('SELECT id, group_id AS groupId FROM ledgers').all() as { id: number; groupId: number }[]
  return {
    cash: new Set(rows.filter((r) => cashGroups.has(r.groupId)).map((r) => r.id)),
    bank: new Set(rows.filter((r) => bankGroups.has(r.groupId)).map((r) => r.id))
  }
}

/** Cash and bank as on `asOn` — the trial balance's closing balances for those ledgers. */
export function cashAt(db: DB, asOn: string): DoingCash {
  const { cash, bank } = moneyLedgers(db)
  const bal = closingBalances(db, asOn)
  const total = (ids: Set<number>): number => [...ids].reduce((s, id) => s + (bal.get(id) ?? 0), 0)
  const c = total(cash)
  const b = total(bank)
  return { cash: c, bank: b, total: c + b, ledgerIds: [...cash, ...bank], banks: bank.size }
}

function owedAt(db: DB, asOn: string): DoingOwed {
  const r = outstandingsWithAdvances(db, 'receivable', asOn)
  const p = outstandingsWithAdvances(db, 'payable', asOn)
  return {
    receivable: r.parties.reduce((s, x) => s + x.pending, 0),
    receivableParties: r.parties.filter((x) => x.pending !== 0).length,
    payable: p.parties.reduce((s, x) => s + x.pending, 0),
    payableParties: p.parties.filter((x) => x.pending !== 0).length,
    customerAdvances: r.advances,
    supplierAdvances: p.advances
  }
}

/** "How is my business doing" for a period (as on `today`). */
export function businessDoing(db: DB, q: DoingQuery, today: string): BusinessDoing {
  const span = reportSpan(q.period, today, { from: q.from, to: q.to })
  if (!span) {
    throw new AppError('simple_report_period', 'Choose a start date on or before the end date.', { field: q.from ? 'to' : 'from' })
  }
  const previous = previousSpan(q.period, span)
  return db.transaction((): BusinessDoing => {
    // One valuation pass for the four stock figures (the P&L's opening / closing stock).
    const stock = stockValuesAt(db, [dayBefore(span.from), span.to, dayBefore(previous.from), previous.to])
    const pnl = profitAndLoss(db, span.from, span.to, { openingStock: stock.get(dayBefore(span.from))!, closingStock: stock.get(span.to)! })
    const prev = profitAndLoss(db, previous.from, previous.to, { openingStock: stock.get(dayBefore(previous.from))!, closingStock: stock.get(previous.to)! })
    const asOn = span.to < today ? span.to : today
    const lines = doingLines(pnl)
    const previousLines = doingLines(prev)
    const cash = cashAt(db, asOn)
    const owed = owedAt(db, asOn)
    const zero = (l: typeof lines): boolean => Object.values(l).every((v) => v === 0)
    const empty =
      zero(lines) && zero(previousLines) && cash.total === 0 && owed.receivable === 0 && owed.payable === 0 &&
      !db.prepare(`SELECT 1 FROM vouchers v WHERE ${NOT_DELETED} LIMIT 1`).get()
    return {
      kind: q.period,
      span,
      previous,
      lines,
      previousLines,
      topExpenses: topParts(pnl.indirectExpenses),
      topSales: topParts(pnl.tradingIncomes, 3),
      asOn,
      cash,
      owed,
      empty
    }
  })()
}

const SOURCE_OF: Record<ForecastSource, CashFlowSource> = {
  receivable: 'customers',
  payable: 'suppliers',
  sales_order: 'orders',
  purchase_order: 'orders',
  item: 'other',
  adjustment: 'other',
  statutory: 'taxes',
  emi: 'loans'
}

/** Cash in the next 30 days: the Cash forecast's expected scenario, from today. */
export function cashNext30(db: DB, company: CompanyInfo, today: string): SimpleCash {
  return db.transaction((): SimpleCash => {
    const until = addDaysISO(today, CASH_HORIZON_DAYS - 1)
    const base = forecastBase(db, company, today, until)
    // Five weeks cover the 30 days; only what falls by `until` is counted.
    const f = buildForecast({ asOn: today, unit: 'week', count: 5, openingCash: base.openingCash, flows: base.flows, scenario: SCENARIO_PRESETS.expected })
    const names = new Map((db.prepare('SELECT id, name FROM ledgers').all() as { id: number; name: string }[]).map((r) => [r.id, r.name]))
    const inside = f.contributions.filter((c) => c.periodKey != null && c.effectiveDate <= until && c.weighted > 0)
    const inBy: SimpleCash['inBy'] = {}
    const outBy: SimpleCash['outBy'] = {}
    let moneyIn = 0
    let moneyOut = 0
    const byDay = new Map<string, number>()
    const items: (CashItem & { direction: 'in' | 'out' })[] = []
    for (const c of inside) {
      const source = SOURCE_OF[c.source]
      const signed = c.direction === 'in' ? c.weighted : -c.weighted
      byDay.set(c.effectiveDate, (byDay.get(c.effectiveDate) ?? 0) + signed)
      if (c.direction === 'in') {
        moneyIn += c.weighted
        inBy[source] = (inBy[source] ?? 0) + c.weighted
      } else {
        moneyOut += c.weighted
        outBy[source] = (outBy[source] ?? 0) + c.weighted
      }
      const label = c.ledgerId != null ? names.get(c.ledgerId) ?? null : c.source === 'emi' ? c.label.replace(/ · EMI$/, '') : null
      items.push({ direction: c.direction, label: label ?? '', date: c.effectiveDate, amount: c.weighted, source, ledgerId: c.ledgerId ?? null })
    }
    // The running balance day by day; the lowest point when it dips below today's balance.
    let running = base.openingCash
    let lowest: SimpleCash['lowest'] = null
    let belowZero: SimpleCash['belowZero'] = base.openingCash < 0 ? { amount: base.openingCash, date: today } : null
    for (const day of [...byDay.keys()].sort()) {
      running += byDay.get(day)!
      if (running < base.openingCash && (!lowest || running < lowest.amount)) lowest = { amount: running, date: day }
      if (running < 0 && !belowZero) belowZero = { amount: running, date: day }
    }
    const top = (dir: 'in' | 'out'): CashItem[] =>
      items
        .filter((i) => i.direction === dir)
        .sort((a, b) => b.amount - a.amount || a.date.localeCompare(b.date))
        .slice(0, 5)
        .map(({ direction: _d, ...rest }) => rest)
    return {
      asOn: today,
      until,
      now: base.openingCash,
      moneyIn,
      moneyOut,
      end: base.openingCash + moneyIn - moneyOut,
      lowest,
      inBy,
      outBy,
      topIn: top('in'),
      topOut: top('out'),
      warnings: base.warnings.length,
      // The trial balance's cash / bank rows as on today — the forecast's opening (the dbtest
      // pins split.total = now).
      split: cashAt(db, today),
      belowZero
    }
  })()
}

/** Who owes me / whom I owe, as on today. */
export function owedList(db: DB, side: 'receivable' | 'payable', today: string): SimpleOwed {
  const o = outstandingsWithAdvances(db, side, today)
  const parties = owedRows(o.parties)
  return {
    side,
    asOn: today,
    total: o.parties.reduce((s, p) => s + p.pending, 0),
    overdue: parties.reduce((s, p) => s + p.overdue, 0),
    parties,
    advances: o.advances,
    advanceParties: o.advanceParties
  }
}

/** Sales and purchases by month: the registers' monthly rows for the 12 months to today. */
export function byMonth(db: DB, today: string): SimpleByMonth {
  const months = last12Months(today)
  const from = `${months[0]}-01`
  return db.transaction((): SimpleByMonth => {
    const bars = monthBars(months, registerByMonth(db, 'sales', from, today), registerByMonth(db, 'purchase', from, today))
    return { months: bars, from, to: today, totals: monthTotals(bars) }
  })()
}
