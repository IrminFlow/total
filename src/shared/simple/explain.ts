// "Why?" sentences (WP 8.6, plan 2026-10-13 §1 principle 5: every number explains itself in one
// sentence). Pure: each function turns figures main computed (`simple:home`, shared/simple/home.ts)
// into sentences through t() — plurals by the catalogue's rules, amounts by money.ts, dates by
// dates.ts. Nothing here computes a figure the service did not return; the sentence is never
// written by a model. Where a figure needs a caveat (a loan inside money in, customer advances,
// reverse charge, who files), the caveat is its own sentence after the first. WP 10.2 extends
// this to Reports and Taxes.

import type { MessageKey, Translate } from '../i18n'
import { formatPaise } from '../money'
import { toMonthLabel, toPlainDate } from '../dates'
import type { HomeAttentionItem, HomeCash, HomeGst, HomeMoneyDay, HomeOwed, HomeProfit } from './home'
import type { Deadline } from '../compliance'
import type { CloseCheckKey } from '../closeChecklist'
import type { AnomalyKind } from '../anomalies'
import type { BusinessDoing, SimpleByMonth, SimpleCash, SimpleOwed } from './reports'
import type { GstFigures, GstPeriod, SimpleTaxes, TaxesWithholding } from './taxes'

export const money = (paise: number): string => formatPaise(paise, { symbol: true })

type RegularGst = Extract<HomeGst, { kind: 'regular' }>

/** '2026-11-20' → '20 Nov' (the year only when it is not `today`'s). */
export function shortDate(date: string, today?: string): string {
  const plain = toPlainDate(date)
  return today && date.slice(0, 4) === today.slice(0, 4) ? plain.slice(0, plain.lastIndexOf(' ')) : plain
}

const join = (parts: (string | null)[]): string => parts.filter((p): p is string => !!p).join(' ')

export function moneyInWhy(day: HomeMoneyDay, t: Translate): string {
  if (day.entries === 0) return t('simple.explain.moneyInNone')
  return join([
    t('simple.explain.moneyIn', { amount: money(day.amount), count: day.entries }),
    day.loans > 0 ? t('simple.explain.moneyInLoan', { amount: money(day.loans) }) : null
  ])
}

export function moneyOutWhy(day: HomeMoneyDay, t: Translate): string {
  if (day.entries === 0) return t('simple.explain.moneyOutNone')
  return join([
    t('simple.explain.moneyOut', { amount: money(day.amount), count: day.entries }),
    day.loans > 0 ? t('simple.explain.moneyOutLoan', { amount: money(day.loans) }) : null
  ])
}

/** "₹4,200.00 is what 3 customers still owe you; the oldest bill is for Ramesh, 12 days old." —
 *  plus the customer advances the same allocation holds, when there are any. */
export function receivablesWhy(owed: HomeOwed, t: Translate): string {
  const advance = owed.advances > 0 ? t('simple.explain.receivablesAdvances', { amount: money(owed.advances), count: owed.advanceParties }) : null
  if (owed.total <= 0 || !owed.oldest) return join([t('simple.explain.receivablesNone'), advance])
  const vars = { amount: money(owed.total), count: owed.parties, name: owed.oldest.name, days: owed.oldest.days }
  return join([
    owed.overdue > 0 ? t('simple.explain.receivablesOverdue', { ...vars, overdue: money(owed.overdue) }) : t('simple.explain.receivables', vars),
    advance
  ])
}

/** "You owe ₹9,000.00 to 2 suppliers; the next payment, to Sharma Traders, is due 20 Oct." */
export function payablesWhy(owed: HomeOwed, today: string, t: Translate): string {
  const advance = owed.advances > 0 ? t('simple.explain.payablesAdvances', { amount: money(owed.advances), count: owed.advanceParties }) : null
  if (owed.total <= 0) return join([t('simple.explain.payablesNone'), advance])
  const vars = { amount: money(owed.total), count: owed.parties }
  const first =
    owed.overdue > 0
      ? t('simple.explain.payablesOverdue', { ...vars, overdue: money(owed.overdue) })
      : owed.nextDue
        ? t('simple.explain.payables', { ...vars, name: owed.nextDue.name, date: shortDate(owed.nextDue.date, today) })
        : t('simple.explain.payablesNoDate', vars)
  return join([first, advance])
}

export function cashWhy(cash: HomeCash, t: Translate): string {
  if (cash.cash < 0) return t('simple.explain.cashBelowZero', { cash: money(-cash.cash) })
  const banks = cash.accounts.filter((a) => a.kind === 'bank').length
  if (banks === 0) return t('simple.explain.cashOnly', { total: money(cash.total) })
  return t('simple.explain.cash', { total: money(cash.total), cash: money(cash.cash), bank: money(cash.bank), count: banks })
}

const result = (netProfit: number): 'profit' | 'loss' | 'none' => (netProfit > 0 ? 'profit' : netProfit < 0 ? 'loss' : 'none')

/** "How is my business doing": this month and the FY to date, signed — one sentence. */
export function profitSentence(profit: HomeProfit, t: Translate): string {
  if (profit.month.netProfit === 0 && profit.year.netProfit === 0) return t('simple.explain.profitNone', { from: toPlainDate(profit.year.from) })
  return t('simple.explain.profit', {
    month: result(profit.month.netProfit),
    monthAmount: money(Math.abs(profit.month.netProfit)),
    year: result(profit.year.netProfit),
    yearAmount: money(Math.abs(profit.year.netProfit)),
    from: toPlainDate(profit.year.from)
  })
}

/** Why profit is not just sales minus purchases: the goods still on the shelf (closing stock). */
export function profitWhy(profit: HomeProfit, t: Translate): string {
  return profit.year.closingStock > 0
    ? t('simple.explain.profitStock', { stock: money(profit.year.closingStock) })
    : t('simple.explain.profitPlain', { from: toPlainDate(profit.year.from) })
}

/** The dates the GST figures cover, in words: "September 2026", "Jul – Sep 2026", or
 *  "Oct 2026 so far" for a quarter still running. */
export function gstPeriodLabel(gst: RegularGst, t: Translate): string {
  const r = gst.row
  if (!r.quarterly || !r.from) return toMonthLabel(r.period, 'long')
  const first = r.from.slice(0, 7)
  const vars = { from: toMonthLabel(first), to: toMonthLabel(r.period, 'long') }
  if (r.soFar) return first === r.period ? t('simple.home.gstMonthSoFar', { month: toMonthLabel(r.period, 'long') }) : t('simple.home.gstQuarterSoFar', vars)
  return t('simple.home.gstQuarter', vars)
}

/** The GST tile's figure line: "₹Z by 20 Nov" (regular registrations only); a quarter still
 *  running (its return more than 45 days off) shows "So far this quarter: ₹X". */
export function gstLine(gst: RegularGst, today: string, t: Translate): string {
  const r = gst.row
  if (r.soFar) return t('simple.home.gstSoFar', { amount: money(Math.max(0, r.payable)) })
  if (!r.gstr3bDue) return t('simple.home.gstNoDate', { amount: money(Math.max(0, r.payable)), month: gstPeriodLabel(gst, t) })
  return r.payable > 0
    ? t('simple.home.gstAmountBy', { amount: money(r.payable), date: shortDate(r.gstr3bDue, today) })
    : t('simple.home.gstNothingDue', { date: shortDate(r.gstr3bDue, today) })
}

/**
 * The three figures (plan §2.2 / principle 10): GST collected on sales (reverse charge NOT
 * included), GST you paid on purchases (booked; how much GSTR-2B has not confirmed), and the cash
 * to pay by the date — then reverse charge (only when there is some) and who files.
 */
export function gstWhy(gst: RegularGst, today: string, t: Translate): string {
  const r = gst.row
  const sales = r.outwardTax ?? r.liability
  const rcm = r.rcmTax ?? 0
  const credit =
    gst.credit.checked === 'none'
      ? t('simple.explain.gstCreditNotChecked')
      : gst.credit.awaiting > 0
        ? t('simple.explain.gstCreditAwaiting', { amount: money(gst.credit.awaiting) })
        : gst.credit.checked === 'all'
          ? t('simple.explain.gstCreditConfirmed')
          : t('simple.explain.gstCreditSome')
  const vars = { period: gstPeriodLabel(gst, t), collected: money(sales), paid: money(r.itc), credit }
  const first =
    r.payable <= 0
      ? t('simple.explain.gstNothing', vars)
      : r.gstr3bDue && !r.soFar
        ? t('simple.explain.gst', { ...vars, payable: money(r.payable), date: shortDate(r.gstr3bDue, today) })
        : t('simple.explain.gstNoDate', { ...vars, payable: money(r.payable) })
  return join([first, rcm > 0 ? t('simple.explain.gstRcm', { amount: money(rcm) }) : null, t('simple.explain.gstYouFile')])
}

const CLOSE_TEXT: Partial<Record<CloseCheckKey, MessageKey>> = {
  overdue_bills: 'simple.attention.close.overdueBills',
  unallocated: 'simple.attention.close.unallocated',
  gst_returns: 'simple.attention.close.gstReturns',
  withholding: 'simple.attention.close.withholding',
  negative_stock: 'simple.attention.close.negativeStock',
  unbilled_goods: 'simple.attention.close.unbilledGoods',
  suspense: 'simple.attention.close.suspense',
  pdc_due: 'simple.attention.close.pdcDue',
  depreciation: 'simple.attention.close.depreciation',
  drafts: 'simple.attention.close.drafts',
  bank_reconciliation: 'simple.attention.close.bankReconciliation',
  rounding: 'simple.attention.close.rounding'
}

const ANOMALY_TEXT: Record<AnomalyKind, MessageKey> = {
  duplicate_party_amount: 'simple.attention.anomaly.duplicatePartyAmount',
  duplicate_bill_number: 'simple.attention.anomaly.duplicateBillNumber',
  duplicate_narration: 'simple.attention.anomaly.duplicateNarration',
  round_amount: 'simple.attention.anomaly.roundAmount',
  unusual_pairing: 'simple.attention.anomaly.unusualPairing',
  amount_outlier: 'simple.attention.anomaly.amountOutlier',
  weekend_posting: 'simple.attention.anomaly.weekendPosting',
  holiday_posting: 'simple.attention.anomaly.holidayPosting',
  backdated: 'simple.attention.anomaly.backdated',
  gst_rate_deviation: 'simple.attention.anomaly.gstRateDeviation',
  hsn_rate_mismatch: 'simple.attention.anomaly.hsnRateMismatch'
}

/** A "Needs attention" row in plain words, keyed by its source and kind. `period` is the month
 *  the close checklist ran for (YYYY-MM). */
export function attentionText(item: HomeAttentionItem, period: string, t: Translate): string {
  if (item.source === 'owed') {
    return t(item.key === 'receivable' ? 'simple.attention.owed.receivable' : 'simple.attention.owed.payable', {
      count: item.count,
      amount: money(item.amount ?? 0)
    })
  }
  if (item.source === 'stock') return t('simple.attention.stock.low', { count: item.count })
  const key =
    item.source === 'close'
      ? CLOSE_TEXT[item.key as CloseCheckKey] ?? 'simple.attention.close.other'
      : ANOMALY_TEXT[item.key as AnomalyKind] ?? 'simple.attention.anomaly.other'
  return t(key, { count: item.count, month: toMonthLabel(period, 'long') })
}

const DEADLINE_KEY: Partial<Record<Deadline['kind'], MessageKey>> = {
  tds: 'simple.home.deadline.tds',
  pf: 'simple.home.deadline.pf',
  esi: 'simple.home.deadline.esi',
  'advance-tax': 'simple.home.deadline.advanceTax'
}

export function deadlineText(d: Pick<Deadline, 'kind' | 'form' | 'date'>, today: string, t: Translate): string {
  const key = DEADLINE_KEY[d.kind] ?? 'simple.home.deadline.other'
  return t(key, { date: shortDate(d.date, today), form: d.form })
}

/** The GST link says what opens: the month's return, or (quarterly) the return month by month. */
export function gstLinkLabel(gst: RegularGst, t: Translate): string {
  const r = gst.row
  return r.quarterly && r.from
    ? t('simple.home.link.gstQuarter', { month: toMonthLabel(r.from.slice(0, 7), 'long') })
    : t('simple.home.link.gst', { month: toMonthLabel(r.period, 'long') })
}

// ---------------------------------------------------------------- WP 9.9: Reports and Taxes
// The same rule: each sentence is a pure function of figures main returned (simple:reports:* /
// simple:taxes) — nothing here computes a figure.

const span = (s: { from: string; to: string }): { from: string; to: string } => ({ from: toPlainDate(s.from), to: toPlainDate(s.to) })
const resultOf = (paise: number): 'profit' | 'loss' | 'none' => (paise > 0 ? 'profit' : paise < 0 ? 'loss' : 'none')

/** "₹1,200.00 more than the previous period (1 Sep 2026 to 13 Sep 2026)." */
export function changeSentence(current: number, previous: number, prev: { from: string; to: string }, t: Translate): string {
  const diff = current - previous
  return t('simple.reports.change', { dir: diff > 0 ? 'up' : diff < 0 ? 'down' : 'same', amount: money(Math.abs(diff)), ...span(prev) })
}

export function salesWhy(d: Pick<BusinessDoing, 'lines' | 'span'>, t: Translate): string {
  return d.lines.sales === 0 ? t('simple.reports.why.salesNone', span(d.span)) : t('simple.reports.why.sales', { ...span(d.span), amount: money(d.lines.sales) })
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

export function expensesWhy(d: Pick<BusinessDoing, 'lines' | 'span' | 'topExpenses'>, t: Translate): string {
  if (d.lines.expenses === 0) return t('simple.reports.why.expensesNone', span(d.span))
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
    t('simple.reports.why.profit', { result: resultOf(l.profit), amount: money(Math.abs(l.profit)), ...span(d.span) }),
    stock > 0 ? t('simple.reports.why.stockUp', { amount: money(stock) }) : stock < 0 ? t('simple.reports.why.stockDown', { amount: money(-stock) }) : null,
    changeSentence(l.profit, d.previousLines.profit, d.previous, t)
  ])
}

export function doingCashWhy(d: Pick<BusinessDoing, 'cash' | 'asOn'>, t: Translate): string {
  const c = d.cash
  const date = toPlainDate(d.asOn)
  return c.banks === 0
    ? t('simple.reports.why.cashOnly', { total: money(c.total), date })
    : t('simple.reports.why.cash', { total: money(c.total), cash: money(c.cash), bank: money(c.bank), count: c.banks, date })
}

export function doingOwedWhy(d: Pick<BusinessDoing, 'owed' | 'asOn'>, t: Translate): string {
  return join([
    t('simple.reports.why.owed', { date: toPlainDate(d.asOn), receivable: money(d.owed.receivable), payable: money(d.owed.payable) }),
    d.owed.customerAdvances > 0 ? t('simple.reports.why.advances', { amount: money(d.owed.customerAdvances) }) : null
  ])
}

export function cashNext30Why(c: SimpleCash, t: Translate): string {
  const low = Math.min(c.end, c.lowest?.amount ?? c.end)
  return join([
    t('simple.reports.cash.why', { now: money(c.now), in: money(c.moneyIn), out: money(c.moneyOut), date: shortDate(c.until, c.asOn), end: money(c.end) }),
    c.lowest && c.lowest.amount < c.end ? t('simple.reports.cash.lowest', { amount: money(c.lowest.amount), date: shortDate(c.lowest.date, c.asOn) }) : null,
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
  const sales = b.months.reduce((s, m) => s + m.sales, 0)
  const purchases = b.months.reduce((s, m) => s + m.purchases, 0)
  if (sales === 0 && purchases === 0) return t('simple.reports.byMonth.whyNone')
  const best = b.months.reduce((a, m) => (m.sales > a.sales ? m : a), b.months[0]!)
  return t('simple.reports.byMonth.why', { sales: money(sales), purchases: money(purchases), month: toMonthLabel(best.month, 'long'), amount: money(best.sales) })
}

type RegularTaxes = Extract<SimpleTaxes, { kind: 'regular' }>

/** "Sep 2026", "Jul – Sep 2026", "Oct 2026 so far" — the Home tile's words. */
export function taxesPeriodLabel(p: GstPeriod, t: Translate): string {
  if (!p.quarterly) return p.soFar ? t('simple.home.gstMonthSoFar', { month: toMonthLabel(p.period, 'long') }) : toMonthLabel(p.period, 'long')
  const vars = { from: toMonthLabel(p.from.slice(0, 7)), to: toMonthLabel(p.period, 'long') }
  return p.soFar ? t('simple.home.gstQuarterSoFar', vars) : t('simple.home.gstQuarter', vars)
}

/** The credit's status in words (the purchases figure's tail). */
export function creditStatus(f: GstFigures, t: Translate): string {
  if (f.checked === 'none') return t('simple.taxes.gst.notCheckedYet')
  if (f.awaiting > 0) return t('simple.taxes.gst.awaitingLine', { amount: money(f.awaiting) })
  return f.checked === 'all' ? t('simple.taxes.gst.allConfirmed') : t('simple.taxes.gst.someChecked')
}

export function collectedWhy(x: Pick<RegularTaxes, 'figures' | 'period'>, t: Translate): string {
  return join([
    t('simple.taxes.why.collected', { ...span(x.period), amount: money(x.figures.collected) }),
    x.figures.reverseCharge > 0 ? t('simple.explain.gstRcm', { amount: money(x.figures.reverseCharge) }) : null
  ])
}

export function onPurchasesWhy(x: Pick<RegularTaxes, 'figures' | 'period'>, t: Translate): string {
  return t('simple.taxes.why.onPurchases', { ...span(x.period), amount: money(x.figures.onPurchases), credit: creditStatus(x.figures, t) })
}

export function toPayWhy(x: Pick<RegularTaxes, 'figures' | 'due' | 'today'>, t: Translate): string {
  const f = x.figures
  return join([
    f.toPay > 0 ? t('simple.taxes.why.toPay', { amount: money(f.toPay), date: shortDate(x.due.gstr3b, x.today) }) : t('simple.taxes.why.toPayNone'),
    f.toPay > 0 && f.reverseCharge > 0 ? t('simple.taxes.why.rcmCash', { amount: money(f.reverseCharge) }) : null,
    t('simple.taxes.why.source'),
    t('simple.explain.gstYouFile')
  ])
}

export function withholdingUnpaidText(u: TaxesWithholding['unpaid'][number], today: string, t: Translate): string {
  if (!u.month || !u.dueDate) return t('simple.taxes.withholding.unpaidOpening', { amount: money(u.amount) })
  return t('simple.taxes.withholding.unpaid', { month: toMonthLabel(u.month, 'long'), amount: money(u.amount), date: shortDate(u.dueDate, today), late: u.late ? 'yes' : 'no' })
}
