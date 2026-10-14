// "Why?" sentences (WP 8.6, plan 2026-10-13 §1 principle 5: every number explains itself in one
// sentence). Pure: each function turns figures main computed (`simple:home`, shared/simple/home.ts)
// into sentences through t() — plurals by the catalogue's rules, amounts by money.ts, dates by
// dates.ts. Nothing here computes a figure the service did not return; the sentence is never
// written by a model. Where a figure needs a caveat (a loan inside money in, customer advances,
// reverse charge, who files), the caveat is its own sentence after the first. WP 9.9 / 10.2 extend
// this to Reports (./explainReports.ts) and Taxes (./explainTaxes.ts); this module keeps Home's and
// re-exports theirs, so `./explain` stays the one import.

import type { MessageKey, Translate } from '../i18n'
import { toMonthLabel, toPlainDate } from '../dates'
import { join, money, resultOf, shortDate } from './explainCommon'
import { compareSentence } from './explainReports'
import type { HomeAttentionItem, HomeCash, HomeGst, HomeMoneyDay, HomeOwed, HomeProfit } from './home'
import type { Deadline } from '../compliance'
import type { CloseCheckKey } from '../closeChecklist'
import type { AnomalyKind } from '../anomalies'

export { dirOf, join, money, resultOf, shortDate, span } from './explainCommon'
export * from './explainReports'
export * from './explainTaxes'

type RegularGst = Extract<HomeGst, { kind: 'regular' }>


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

/**
 * WP 10.2 — the Home profit tile's "Why?": what the year's profit is made of (the P&L's own lines:
 * sales, what the goods cost, other income, running costs → its net profit), then why it differs
 * from sales minus purchases (the stock on the shelf), or else the biggest running cost.
 */
export function homeProfitWhy(profit: HomeProfit, t: Translate): string {
  const y = profit.year
  const l = y.lines
  if (l.sales === 0 && l.costOfGoods === 0 && l.otherIncome === 0 && l.expenses === 0 && y.netProfit === 0) {
    return t('simple.explain.profitPlain', { from: toPlainDate(y.from) })
  }
  const stock = y.closingStock - y.openingStock
  return join([
    t('simple.why.home.profit', {
      from: toPlainDate(y.from),
      sales: money(l.sales),
      cost: money(l.costOfGoods),
      hasOther: l.otherIncome !== 0 ? 'yes' : 'no',
      other: money(l.otherIncome),
      expenses: money(l.expenses),
      result: resultOf(y.netProfit),
      amount: money(Math.abs(y.netProfit))
    }),
    stock > 0
      ? t('simple.why.home.stockUp', { amount: money(stock) })
      : stock < 0
        ? t('simple.why.home.stockDown', { amount: money(-stock) })
        : y.topExpense
          ? t('simple.why.home.topExpense', { name: y.topExpense.name, amount: money(y.topExpense.amount) })
          : null
  ])
}

/** Home's month against the same days of the month before (compareSentence, ./explainReports). */
export function monthCompareWhy(profit: HomeProfit, t: Translate): string {
  return compareSentence(profit.month.lines, profit.previousMonth.lines, profit.previousMonth, 'month', t)
}

const DEADLINE_WHY: Partial<Record<Deadline['kind'], MessageKey>> = {
  tds: 'simple.why.deadline.tds',
  pf: 'simple.why.deadline.pf',
  esi: 'simple.why.deadline.esi',
  'advance-tax': 'simple.why.deadline.advanceTax'
}

/** WP 10.2 — a "Coming up" row's "Why?": what the date is for and the rule's day in words. */
export function deadlineWhy(d: Pick<Deadline, 'kind' | 'form' | 'date'>, today: string, t: Translate): string {
  return t(DEADLINE_WHY[d.kind] ?? 'simple.why.deadline.other', { date: shortDate(d.date, today), form: d.form })
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
