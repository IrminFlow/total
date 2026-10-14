// "Why?" sentences for the simple Taxes screen (WP 9.9, extended by WP 10.2). Pure functions of
// what `simple:taxes` returned (gstr3b()'s own figures, the stored GSTR-2B, the cited due dates),
// through t(). Total prepares; the user files (plan §1 principle 10).

import type { Translate } from '../i18n'
import { toMonthLabel } from '../dates'
import type { GstFigures, GstPeriod, SimpleTaxes, TaxesWithholding } from './taxes'
import { join, money, shortDate, span } from './explainCommon'

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

// ---------------------------------------------------------------- WP 10.2

/**
 * The cash to pay, in its parts as gstr3b() returns them: what you collected, how much of it the
 * credit covers (the set-off), what is left in cash, plus reverse charge (always cash) — then who
 * files. The credit left over for the next return is `creditLeftWhy`, shown under it.
 */
export function toPayPartsWhy(x: Pick<RegularTaxes, 'figures' | 'due' | 'today'>, t: Translate): string {
  const f = x.figures
  const date = shortDate(x.due.gstr3b, x.today)
  const first =
    f.toPay <= 0
      ? t('simple.taxes.why.toPayNone')
      : f.cashOnSales <= 0
        ? t('simple.why.taxes.toPayRcmOnly', { amount: money(f.rcmCash), date })
        : t('simple.why.taxes.toPay', {
            collected: money(f.collected),
            used: money(f.creditUsed),
            cash: money(f.cashOnSales),
            rcm: f.rcmCash > 0 ? 'yes' : 'no',
            rcmAmount: money(f.rcmCash),
            total: money(f.toPay),
            date
          })
  return join([first, t('simple.explain.gstYouFile')])
}

/** The credit not used this time (carried to the next return), or null when none is left. */
export function creditLeftWhy(f: Pick<GstFigures, 'creditLeft'>, t: Translate): string | null {
  return f.creditLeft > 0 ? t('simple.why.taxes.creditLeft', { amount: money(f.creditLeft) }) : null
}

/** A due date's "Why?": which return it is, what it covers, and the rule's day in words. */
export function dueWhy(form: 'gstr1' | 'gstr3b' | 'pmt06', x: Pick<RegularTaxes, 'due' | 'period' | 'figures' | 'today'>, t: Translate): string {
  const period = taxesPeriodLabel(x.period, t)
  const quarterly = x.period.quarterly ? 'yes' : 'no'
  if (form === 'gstr1') return t('simple.why.due.gstr1', { period, date: shortDate(x.due.gstr1, x.today), quarterly })
  if (form === 'gstr3b') return t('simple.why.due.gstr3b', { period, date: shortDate(x.due.gstr3b, x.today), amount: money(x.figures.toPay), quarterly })
  return t('simple.why.due.pmt06', { dates: x.due.pmt06.map((d) => shortDate(d, x.today)).join(', ') })
}

/** Composition dates: CMP-08 (the quarter) and GSTR-4 (the year). */
export function compositionDueWhy(form: 'cmp08' | 'gstr4', x: Pick<Extract<SimpleTaxes, { kind: 'composition' }>, 'composition' | 'today'>, t: Translate): string {
  const c = x.composition
  return form === 'cmp08'
    ? t('simple.why.due.cmp08', { ...span(c.cmp08), date: shortDate(c.cmp08.due, x.today) })
    : t('simple.why.due.gstr4', { fy: c.gstr4.fyLabel, date: shortDate(c.gstr4.due, x.today) })
}

/** TDS / TCS: what is still to pay (and how much is late), then the oldest part — or, all paid,
 *  this month's amount and its date. */
export function withholdingWhy(w: TaxesWithholding, today: string, t: Translate): string {
  if (w.totalUnpaid <= 0) return t('simple.why.withholdingAllPaid', { kind: w.kind, amount: money(w.thisMonth), date: shortDate(w.thisMonthDue, today) })
  const oldest = w.unpaid[0]
  return join([
    t('simple.why.withholding', { kind: w.kind, total: money(w.totalUnpaid), late: w.lateUnpaid > 0 ? 'yes' : 'no', lateAmount: money(w.lateUnpaid) }),
    oldest?.month && oldest.dueDate ? t('simple.why.withholdingOldest', { month: toMonthLabel(oldest.month, 'long'), date: shortDate(oldest.dueDate, today) }) : null
  ])
}
