// "Why?" sentences (WP 8.6, plan 2026-10-13 §1 principle 5: every number explains itself in one
// sentence). Pure: each function turns figures main computed (`simple:home`, shared/simple/home.ts)
// into a sentence through t() — plurals by the catalogue's rules, amounts by money.ts, dates by
// dates.ts. Nothing here computes a figure the service did not return; the sentence is never
// written by a model. WP 10.2 extends this to Reports and Taxes.

import type { MessageKey, Translate } from '../i18n'
import { formatPaise } from '../money'
import { toMonthLabel, toPlainDate } from '../dates'
import type { HomeAttentionItem, HomeCash, HomeGst, HomeMoneyDay, HomeOwed, HomeProfit } from './home'
import type { Deadline } from '../compliance'
import type { CloseCheckKey } from '../closeChecklist'
import type { AnomalyKind } from '../anomalies'

export const money = (paise: number): string => formatPaise(paise, { symbol: true })

/** '2026-11-20' → '20 Nov' (the year only when it is not `today`'s). */
export function shortDate(date: string, today?: string): string {
  const plain = toPlainDate(date)
  return today && date.slice(0, 4) === today.slice(0, 4) ? plain.slice(0, plain.lastIndexOf(' ')) : plain
}

export function moneyInWhy(day: HomeMoneyDay, t: Translate): string {
  return day.entries === 0
    ? t('simple.explain.moneyInNone')
    : t('simple.explain.moneyIn', { amount: money(day.amount), count: day.entries })
}

export function moneyOutWhy(day: HomeMoneyDay, t: Translate): string {
  return day.entries === 0
    ? t('simple.explain.moneyOutNone')
    : t('simple.explain.moneyOut', { amount: money(day.amount), count: day.entries })
}

/** "₹4,200.00 is what 3 customers still owe you; the oldest bill is for Ramesh, 12 days old." */
export function receivablesWhy(owed: HomeOwed, t: Translate): string {
  if (owed.total <= 0 || !owed.oldest) return t('simple.explain.receivablesNone')
  const vars = { amount: money(owed.total), count: owed.parties, name: owed.oldest.name, days: owed.oldest.days }
  return owed.overdue > 0
    ? t('simple.explain.receivablesOverdue', { ...vars, overdue: money(owed.overdue) })
    : t('simple.explain.receivables', vars)
}

/** "You owe ₹9,000.00 to 2 suppliers; the next payment, to Sharma Traders, is due 20 Oct." */
export function payablesWhy(owed: HomeOwed, today: string, t: Translate): string {
  if (owed.total <= 0) return t('simple.explain.payablesNone')
  const vars = { amount: money(owed.total), count: owed.parties }
  if (owed.overdue > 0) return t('simple.explain.payablesOverdue', { ...vars, overdue: money(owed.overdue) })
  if (owed.nextDue) return t('simple.explain.payables', { ...vars, name: owed.nextDue.name, date: shortDate(owed.nextDue.date, today) })
  return t('simple.explain.payablesNoDate', vars)
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

/** The GST tile's figure line: "₹Z by 20 Nov" (regular registrations only). */
export function gstLine(gst: Extract<HomeGst, { kind: 'regular' }>, today: string, t: Translate): string {
  const r = gst.row
  if (!r.gstr3bDue) return t('simple.home.gstNoDate', { amount: money(Math.max(0, r.payable)), month: toMonthLabel(r.period, 'long') })
  return r.payable > 0
    ? t('simple.home.gstAmountBy', { amount: money(r.payable), date: shortDate(r.gstr3bDue, today) })
    : t('simple.home.gstNothingDue', { date: shortDate(r.gstr3bDue, today) })
}

export function gstWhy(gst: Extract<HomeGst, { kind: 'regular' }>, t: Translate): string {
  const r = gst.row
  const vars = { month: toMonthLabel(r.period, 'long'), collected: money(r.liability), paid: money(r.itc) }
  return r.payable > 0 ? t('simple.explain.gst', { ...vars, payable: money(r.payable) }) : t('simple.explain.gstNothing', vars)
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

/** A "Needs attention" row in plain words, keyed by its check / anomaly kind. `period` is the
 *  month the close checklist ran for (YYYY-MM). */
export function attentionText(item: HomeAttentionItem, period: string, t: Translate): string {
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
