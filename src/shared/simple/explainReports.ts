// "Why?" sentences for the simple Reports (WP 9.9, extended by WP 10.2). The same rule as Home's
// (./explain.ts): each sentence is a pure function of figures main returned (simple:reports:*),
// through t() — nothing here computes a figure a service did not return (a change between two
// returned figures is said, never re-derived from the books).

import type { Translate } from '../i18n'
import { toMonthLabel, toPlainDate } from '../dates'
import { biggestChange, type BusinessDoing, type CashFlowSource, type DoingLines, type ProfitPart, type SimpleByMonth, type SimpleCash, type SimpleOwed } from './reports'
import { dirOf, join, money, resultOf, shortDate, span } from './explainCommon'

/** "₹1,200.00 more than the previous period (1 Sep 2026 to 13 Sep 2026)." */
export function changeSentence(current: number, previous: number, prev: { from: string; to: string }, t: Translate): string {
  const diff = current - previous
  return t('simple.reports.change', { dir: diff > 0 ? 'up' : diff < 0 ? 'down' : 'same', amount: money(Math.abs(diff)), ...span(prev, t.lang) })
}

export function salesWhy(d: Pick<BusinessDoing, 'lines' | 'span'>, t: Translate): string {
  return d.lines.sales === 0 ? t('simple.reports.why.salesNone', span(d.span, t.lang)) : t('simple.reports.why.sales', { ...span(d.span, t.lang), amount: money(d.lines.sales) })
}

export function costWhy(d: Pick<BusinessDoing, 'lines'>, t: Translate): string {
  const l = d.lines
  if (l.openingStock === 0 && l.closingStock === 0) return t('simple.reports.why.costNoStock', { cost: money(l.costOfGoods) })
  return t('simple.reports.why.cost', { cost: money(l.costOfGoods), opening: money(l.openingStock), purchases: money(l.purchases), closing: money(l.closingStock) })
}

export function profitOnGoodsWhy(d: Pick<BusinessDoing, 'lines'>, t: Translate): string {
  return t('simple.reports.why.profitOnGoods', { sales: money(d.lines.sales), cost: money(d.lines.costOfGoods), amount: money(d.lines.profitOnGoods) })
}

export function otherIncomeWhy(d: Pick<BusinessDoing, 'lines'>, t: Translate): string {
  return t('simple.reports.why.otherIncome', { amount: money(d.lines.otherIncome) })
}

/** Gate polish: the bills' round-off line. */
export function roundingWhy(d: Pick<BusinessDoing, 'lines'>, t: Translate): string {
  return t('simple.reports.why.rounding', { amount: money(d.lines.rounding) })
}

export function expensesWhy(d: Pick<BusinessDoing, 'lines' | 'span' | 'topExpenses'>, t: Translate): string {
  if (d.lines.expenses === 0) return t('simple.reports.why.expensesNone', span(d.span, t.lang))
  const list = d.topExpenses
    .slice(0, 3)
    .map((p) => `${p.name} ${money(p.amount)}`)
    .join(', ')
  return t('simple.reports.why.expenses', { amount: money(d.lines.expenses), list })
}

/** The profit line: the result, why stock makes it differ from sales − purchases, the change. */
export function doingProfitWhy(d: Pick<BusinessDoing, 'lines' | 'previousLines' | 'span' | 'previous'>, t: Translate): string {
  const l = d.lines
  const stock = l.closingStock - l.openingStock
  return join([
    t('simple.reports.why.profit', { result: resultOf(l.profit), amount: money(Math.abs(l.profit)), ...span(d.span, t.lang) }),
    stock > 0 ? t('simple.reports.why.stockUp', { amount: money(stock) }) : stock < 0 ? t('simple.reports.why.stockDown', { amount: money(-stock) }) : null,
    changeSentence(l.profit, d.previousLines.profit, d.previous, t)
  ])
}

export function doingCashWhy(d: Pick<BusinessDoing, 'cash' | 'asOn'>, t: Translate): string {
  const c = d.cash
  const date = toPlainDate(d.asOn, t.lang)
  return c.banks === 0
    ? t('simple.reports.why.cashOnly', { total: money(c.total), date })
    : t('simple.reports.why.cash', { total: money(c.total), cash: money(c.cash), bank: money(c.bank), count: c.banks, date })
}

export function doingOwedWhy(d: Pick<BusinessDoing, 'owed' | 'asOn'>, t: Translate): string {
  return join([
    t('simple.reports.why.owed', { date: toPlainDate(d.asOn, t.lang), receivable: money(d.owed.receivable), payable: money(d.owed.payable) }),
    d.owed.customerAdvances > 0 ? t('simple.reports.why.advances', { amount: money(d.owed.customerAdvances) }) : null
  ])
}

export function cashNext30Why(c: SimpleCash, t: Translate): string {
  const low = Math.min(c.end, c.lowest?.amount ?? c.end)
  return join([
    t('simple.reports.cash.why', { now: money(c.now), in: money(c.moneyIn), out: money(c.moneyOut), date: shortDate(c.until, c.asOn, t.lang), end: money(c.end) }),
    c.lowest && c.lowest.amount < c.end ? t('simple.reports.cash.lowest', { amount: money(c.lowest.amount), date: shortDate(c.lowest.date, c.asOn, t.lang) }) : null,
    low < 0 ? t('simple.reports.cash.belowZero') : null,
    (c.inBy.customers ?? 0) > 0 ? t('simple.reports.cash.estimate') : null
  ])
}

export function owedListWhy(o: SimpleOwed, t: Translate): string {
  const receivable = o.side === 'receivable'
  const advance =
    o.advances > 0 ? t(receivable ? 'simple.reports.owed.advancesReceivable' : 'simple.reports.owed.advancesPayable', { amount: money(o.advances) }) : null
  if (o.total <= 0) return join([t(receivable ? 'simple.reports.owed.noneReceivable' : 'simple.reports.owed.nonePayable'), advance])
  const vars = { amount: money(o.total), count: o.parties.length, overdue: money(o.overdue) }
  return join([t(receivable ? 'simple.reports.owed.whyReceivable' : 'simple.reports.owed.whyPayable', vars), advance])
}

export function byMonthWhy(b: SimpleByMonth, t: Translate): string {
  const { sales, purchases } = b.totals // WP 10.2: the service's totals (monthTotals)
  if (sales === 0 && purchases === 0) return t('simple.reports.byMonth.whyNone')
  const best = b.months.reduce((a, m) => (m.sales > a.sales ? m : a), b.months[0]!)
  return t('simple.reports.byMonth.why', { sales: money(sales), purchases: money(purchases), month: toMonthLabel(best.month, 'long', t.lang), amount: money(best.sales) })
}

// ---------------------------------------------------------------- WP 10.2

type CompareLines = Pick<DoingLines, ProfitPart | 'profit'>

/**
 * "₹X better than …, mostly because sales went up by ₹Y": a result against the one before it (the
 * service's two P&Ls, as `lines`), and the line that moved it most (biggestChange). `when` names
 * the comparison: Home's month (the same days last month) or a Reports period.
 */
export function compareSentence(current: CompareLines, previous: CompareLines, prev: { from: string; to: string }, when: 'month' | 'period', t: Translate): string {
  const diff = current.profit - previous.profit
  const part = biggestChange(current, previous)
  return t('simple.why.compare', {
    when,
    dir: dirOf(diff),
    amount: money(Math.abs(diff)),
    ...span(prev, t.lang),
    part: part ? part.part : 'none',
    partDir: part && part.change > 0 ? 'up' : 'down',
    partAmount: money(Math.abs(part?.change ?? 0))
  })
}

/** Sales, then how they compare with the period before. */
export function salesCompareWhy(d: Pick<BusinessDoing, 'lines' | 'previousLines' | 'span' | 'previous'>, t: Translate): string {
  return join([salesWhy(d, t), changeSentence(d.lines.sales, d.previousLines.sales, d.previous, t)])
}

/** The profit line: the result and why stock makes it differ from sales − purchases (the
 *  comparison is `doingCompareWhy`, shown under it). */
export function doingResultWhy(d: Pick<BusinessDoing, 'lines' | 'span'>, t: Translate): string {
  const l = d.lines
  const stock = l.closingStock - l.openingStock
  return join([
    t('simple.reports.why.profit', { result: resultOf(l.profit), amount: money(Math.abs(l.profit)), ...span(d.span, t.lang) }),
    stock > 0 ? t('simple.reports.why.stockUp', { amount: money(stock) }) : stock < 0 ? t('simple.reports.why.stockDown', { amount: money(-stock) }) : null
  ])
}

export function doingCompareWhy(d: Pick<BusinessDoing, 'lines' | 'previousLines' | 'previous'>, t: Translate): string {
  return compareSentence(d.lines, d.previousLines, d.previous, 'period', t)
}

const CASH_SOURCES: readonly CashFlowSource[] = ['customers', 'suppliers', 'taxes', 'loans', 'orders', 'other']

const cashList = (by: SimpleCash['inBy'], t: Translate): string =>
  CASH_SOURCES.filter((s) => (by[s] ?? 0) > 0)
    .map((s) => `${t('simple.reports.cash.source', { source: s })} ${money(by[s] ?? 0)}`)
    .join(', ')

/** Cash now: today's cash and bank, the trial balance's rows (= the forecast's opening). */
export function cashNowWhy(c: Pick<SimpleCash, 'split'>, t: Translate): string {
  const s = c.split
  return s.banks === 0
    ? t('simple.explain.cashOnly', { total: money(s.total) })
    : t('simple.explain.cash', { total: money(s.total), cash: money(s.cash), bank: money(s.bank), count: s.banks })
}

const cashItemName = (i: SimpleCash['topIn'][number], t: Translate): string => i.label || t('simple.reports.cash.source', { source: i.source })

/** Expected in: by source, then the biggest single receipt. */
export function cashInWhy(c: SimpleCash, t: Translate): string {
  const date = shortDate(c.until, c.asOn, t.lang)
  if (c.moneyIn <= 0) return t('simple.why.cash.inNone', { date })
  const top = c.topIn[0]
  return join([
    t('simple.why.cash.in', { amount: money(c.moneyIn), date, list: cashList(c.inBy, t) }),
    top ? t('simple.why.cash.biggestIn', { name: cashItemName(top, t), amount: money(top.amount), date: shortDate(top.date, c.asOn, t.lang) }) : null
  ])
}

/** Expected out: by source, then the biggest single payment. */
export function cashOutWhy(c: SimpleCash, t: Translate): string {
  const date = shortDate(c.until, c.asOn, t.lang)
  if (c.moneyOut <= 0) return t('simple.why.cash.outNone', { date })
  const top = c.topOut[0]
  return join([
    t('simple.why.cash.out', { amount: money(c.moneyOut), date, list: cashList(c.outBy, t) }),
    top ? t('simple.why.cash.biggestOut', { name: cashItemName(top, t), amount: money(top.amount), date: shortDate(top.date, c.asOn, t.lang) }) : null
  ])
}

/** The end balance: now + in − out, then the first day below zero (or else the lowest point). */
export function cashEndWhy(c: SimpleCash, t: Translate): string {
  return join([
    t('simple.why.cash.end', { now: money(c.now), in: money(c.moneyIn), out: money(c.moneyOut), end: money(c.end), date: shortDate(c.until, c.asOn, t.lang) }),
    c.belowZero
      ? t('simple.why.cash.belowZero', { date: shortDate(c.belowZero.date, c.asOn, t.lang), amount: money(-c.belowZero.amount) })
      : c.lowest && c.lowest.amount < c.end
        ? t('simple.reports.cash.lowest', { amount: money(c.lowest.amount), date: shortDate(c.lowest.date, c.asOn, t.lang) })
        : null
  ])
}

/** Who owes me / whom I owe: the total with its past-due part, then who has the most (or the
 *  advances held, when there are any). */
export function owedTotalWhy(o: SimpleOwed, t: Translate): string {
  const top = o.parties[0]
  if (o.total <= 0 || o.advances > 0 || !top) return owedListWhy(o, t)
  return join([
    owedListWhy(o, t),
    t(o.side === 'receivable' ? 'simple.why.owed.biggestReceivable' : 'simple.why.owed.biggestPayable', { name: top.name, amount: money(top.pending) })
  ])
}

/** Sales and purchases by month: the 12 months' totals (the service's), the best month, then the
 *  last whole month against the one before it. */
export function byMonthTotalsWhy(b: SimpleByMonth, t: Translate): string {
  const { sales, purchases } = b.totals
  if (sales === 0 && purchases === 0) return t('simple.reports.byMonth.whyNone')
  const best = b.months.reduce((a, m) => (m.sales > a.sales ? m : a), b.months[0]!)
  const last = b.months[b.months.length - 2]
  const before = b.months[b.months.length - 3]
  return join([
    t('simple.reports.byMonth.why', { sales: money(sales), purchases: money(purchases), month: toMonthLabel(best.month, 'long', t.lang), amount: money(best.sales) }),
    last && before
      ? t('simple.why.byMonth.change', { month: toMonthLabel(last.month, 'long', t.lang), previous: toMonthLabel(before.month, 'long', t.lang), dir: dirOf(last.sales - before.sales), amount: money(Math.abs(last.sales - before.sales)) })
      : null
  ])
}
