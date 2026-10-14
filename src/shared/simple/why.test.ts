// WP 10.2 — "Why?" for every Home / Reports / Taxes figure (plan 2026-10-13 §1 principle 5, §5).
// Every sentence's ₹ figures are read back out of the sentence and must be figures the service
// returned (or the stated difference of two of them) — never anything else; each one renders in
// en / hi / hinglish without an unknown key, a missing variable or a syntax error (the new
// simple.why.* keys are translated in both); no banned word in any language.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configureI18n, translator, type I18nProblem, type Language, type Translate } from '../i18n'
import { bannedWordsIn } from './bannedWords'
import {
  byMonthTotalsWhy, cashEndWhy, cashInWhy, cashNowWhy, cashOutWhy, compareSentence, compositionDueWhy, creditLeftWhy, deadlineWhy, doingCompareWhy, doingResultWhy,
  dueWhy, homeProfitWhy, monthCompareWhy, owedTotalWhy, salesCompareWhy, toPayPartsWhy, withholdingWhy
} from './explain'
import { biggestChange, last12Months, monthBars, monthTotals, type BusinessDoing, type DoingLines, type SimpleCash, type SimpleOwed } from './reports'
import type { HomeProfit } from './home'
import type { SimpleTaxes, TaxesWithholding } from './taxes'

const TODAY = '2026-10-13'
const LANGS: Language[] = ['en', 'hi', 'hinglish']

/** Every "₹1,23,456.78" / "-₹50.00" in a sentence, as paise. */
function amountsIn(text: string): number[] {
  return [...text.matchAll(/(-?)₹([\d,]+)\.(\d{2})/g)].map((m) => (m[1] ? -1 : 1) * (Number(m[2]!.replace(/,/g, '')) * 100 + Number(m[3])))
}

/** The sentence's figures are exactly drawn from `allowed` (each of `required` present). */
function figuresFrom(text: string, allowed: number[], required: number[] = allowed): void {
  const found = amountsIn(text)
  for (const a of found) expect(allowed, `${a} in "${text}"`).toContain(a)
  for (const r of required) expect(found, `${r} missing from "${text}"`).toContain(r)
}

const lines = (o: Partial<DoingLines>): DoingLines => {
  const l = { sales: 0, openingStock: 0, purchases: 0, closingStock: 0, otherIncome: 0, expenses: 0, ...o }
  const costOfGoods = l.openingStock + l.purchases - l.closingStock
  const profitOnGoods = l.sales - costOfGoods
  return { ...l, costOfGoods, profitOnGoods, profit: profitOnGoods + l.otherIncome - l.expenses }
}

// Home: the year sold ₹2,00,000, bought ₹1,60,000 with ₹30,000 still on the shelf (cost ₹1,30,000),
// rent ₹20,000 of ₹25,000 running costs, ₹1,000 interest → profit ₹46,000.
const YEAR = lines({ sales: 2_00_000_00, purchases: 1_60_000_00, closingStock: 30_000_00, otherIncome: 1_000_00, expenses: 25_000_00 })
const MONTH = lines({ sales: 40_000_00, purchases: 20_000_00, closingStock: 30_000_00, openingStock: 25_000_00, expenses: 5_000_00 })
const PREV = lines({ sales: 30_000_00, purchases: 18_000_00, closingStock: 25_000_00, openingStock: 20_000_00, expenses: 6_000_00 })
const PROFIT: HomeProfit = {
  month: { month: '2026-10', from: '2026-10-01', to: TODAY, netProfit: MONTH.profit, openingStock: 25_000_00, closingStock: 30_000_00, lines: MONTH, topExpense: { name: 'Rent', amount: 5_000_00, ledgerId: 9 } },
  year: { from: '2026-04-01', to: TODAY, netProfit: YEAR.profit, openingStock: 0, closingStock: 30_000_00, lines: YEAR, topExpense: { name: 'Rent', amount: 20_000_00, ledgerId: 9 } },
  previousMonth: { from: '2026-09-01', to: '2026-09-13', lines: PREV }
}

const DOING: BusinessDoing = {
  kind: 'this-month', span: { from: '2026-10-01', to: TODAY }, previous: { from: '2026-09-01', to: '2026-09-13' },
  lines: MONTH, previousLines: PREV, topExpenses: [{ name: 'Rent', amount: 5_000_00, ledgerId: 9 }], topSales: [],
  asOn: TODAY, cash: { cash: 5_000_00, bank: 45_000_00, total: 50_000_00, ledgerIds: [1, 2], banks: 1 },
  owed: { receivable: 8_000_00, receivableParties: 2, payable: 3_000_00, payableParties: 1, customerAdvances: 0, supplierAdvances: 0 }, empty: false
}

const CASH: SimpleCash = {
  asOn: TODAY, until: '2026-11-11', now: 10_000_00, moneyIn: 6_000_00, moneyOut: 19_000_00, end: -3_000_00,
  lowest: { amount: -4_000_00, date: '2026-10-25' }, inBy: { customers: 5_000_00, other: 1_000_00 }, outBy: { suppliers: 15_000_00, taxes: 4_000_00 },
  topIn: [{ label: 'Asha Stores', date: '2026-10-20', amount: 5_000_00, source: 'customers', ledgerId: 7 }],
  topOut: [{ label: 'Sharma Traders', date: '2026-10-22', amount: 15_000_00, source: 'suppliers', ledgerId: 8 }],
  warnings: 0, split: { cash: 2_000_00, bank: 8_000_00, total: 10_000_00, ledgerIds: [1, 2], banks: 1 }, belowZero: { amount: -1_500_00, date: '2026-10-22' }
}

const OWED: SimpleOwed = {
  side: 'receivable', asOn: TODAY, total: 8_000_00, overdue: 5_000_00, advances: 0, advanceParties: 0,
  parties: [{ ledgerId: 7, name: 'Asha Stores', pending: 5_000_00, overdue: 5_000_00, bills: 1, oldestDays: 40 }, { ledgerId: 8, name: 'Bala', pending: 3_000_00, overdue: 0, bills: 1, oldestDays: 3 }]
}

const MONTHS = last12Months(TODAY)
const BARS = monthBars(MONTHS, [{ month: '2026-08', taxable: 50_000_00, vouchers: 2 }, { month: '2026-09', taxable: 70_000_00, vouchers: 3 }, { month: '2026-10', taxable: 10_000_00, vouchers: 1 }], [{ month: '2026-09', taxable: 40_000_00, vouchers: 2 }])
const BY_MONTH = { months: BARS, from: `${MONTHS[0]}-01`, to: TODAY, totals: monthTotals(BARS) }

type Regular = Extract<SimpleTaxes, { kind: 'regular' }>
// gstr3b(): collected ₹18,000, credit ₹10,800 all used → ₹7,200 cash, plus ₹500 reverse charge.
const TAXES: Regular = {
  kind: 'regular', today: TODAY, filing: 'monthly',
  period: { period: '2026-09', from: '2026-09-01', to: '2026-09-30', quarterly: false, soFar: false }, periods: [],
  figures: { collected: 18_000_00, reverseCharge: 500_00, onPurchases: 10_800_00, awaiting: 0, checked: 'none', toPay: 7_700_00, cashOnSales: 7_200_00, rcmCash: 500_00, creditUsed: 10_800_00, creditLeft: 0 },
  due: { gstr1: '2026-10-11', gstr3b: '2026-10-20', gstr3bUnverified: false, pmt06: [] },
  missing: [], supplierBills: [], prepared: { gstr1: null, gstr3b: null }, filesMonthly: false, filed: {}, withholding: []
}
const TDS: TaxesWithholding = {
  kind: 'tds', thisMonth: 1_000_00, thisMonthDue: '2026-11-07', totalUnpaid: 3_000_00, lateUnpaid: 2_000_00,
  unpaid: [{ month: '2026-08', amount: 2_000_00, dueDate: '2026-09-07', late: true }, { month: '2026-10', amount: 1_000_00, dueDate: '2026-11-07', late: false }]
}

/** Every sentence, by language (the renderer shows exactly these). */
function all(t: Translate): string[] {
  return [
    homeProfitWhy(PROFIT, t), monthCompareWhy(PROFIT, t),
    deadlineWhy({ kind: 'tds', form: 'TDS', date: '2026-11-07' }, TODAY, t), deadlineWhy({ kind: 'pf', form: 'PF ECR', date: '2026-11-15' }, TODAY, t),
    deadlineWhy({ kind: 'esi', form: 'ESI', date: '2026-11-15' }, TODAY, t), deadlineWhy({ kind: 'advance-tax', form: 'Advance tax', date: '2026-12-15' }, TODAY, t),
    salesCompareWhy(DOING, t), doingResultWhy(DOING, t), doingCompareWhy(DOING, t),
    cashNowWhy(CASH, t), cashInWhy(CASH, t), cashOutWhy(CASH, t), cashEndWhy(CASH, t), owedTotalWhy(OWED, t), owedTotalWhy({ ...OWED, side: 'payable' }, t), byMonthTotalsWhy(BY_MONTH, t),
    toPayPartsWhy(TAXES, t), creditLeftWhy({ creditLeft: 1_200_00 }, t)!, dueWhy('gstr1', TAXES, t), dueWhy('gstr3b', TAXES, t),
    dueWhy('pmt06', { ...TAXES, due: { ...TAXES.due, pmt06: ['2026-08-25', '2026-09-25'] } }, t),
    compositionDueWhy('cmp08', { today: TODAY, composition: { cmp08: { from: '2026-07-01', to: '2026-09-30', due: '2026-10-18' }, gstr4: { fyLabel: '2026-27', due: '2027-06-30' } } }, t),
    compositionDueWhy('gstr4', { today: TODAY, composition: { cmp08: { from: '2026-07-01', to: '2026-09-30', due: '2026-10-18' }, gstr4: { fyLabel: '2026-27', due: '2027-06-30' } } }, t),
    withholdingWhy(TDS, TODAY, t), withholdingWhy({ ...TDS, kind: 'tcs', totalUnpaid: 0, lateUnpaid: 0, unpaid: [] }, TODAY, t)
  ]
}

const t = translator('en')

describe('each sentence says the figures it was given (WP 10.2)', () => {
  it('Home profit: the P&L lines add up to the profit; stock on the shelf; the biggest cost', () => {
    const s = homeProfitWhy(PROFIT, t)
    expect(s).toBe(
      'From 1 Apr 2026 to today you sold ₹2,00,000.00; the goods cost ₹1,30,000.00, other income added ₹1,000.00 and running costs came to ₹25,000.00, so the profit is ₹46,000.00. ' +
        'Profit is higher than sales minus purchases because ₹30,000.00 more of the stock you bought is still on the shelf than at the start.'
    )
    // sales − cost + other − expenses = profit, and the stock = closing − opening
    expect(YEAR.sales - YEAR.costOfGoods + YEAR.otherIncome - YEAR.expenses).toBe(YEAR.profit)
    figuresFrom(s, [YEAR.sales, YEAR.costOfGoods, YEAR.otherIncome, YEAR.expenses, YEAR.profit, PROFIT.year.closingStock - PROFIT.year.openingStock])
    // no stock change → the biggest running cost instead; a loss reads as a loss
    const flat = { ...PROFIT, year: { ...PROFIT.year, closingStock: 0, lines: lines({ sales: 10_000_00, purchases: 12_000_00, expenses: 1_000_00 }), netProfit: -3_000_00 } }
    expect(homeProfitWhy(flat, t)).toBe(
      'From 1 Apr 2026 to today you sold ₹10,000.00; the goods cost ₹12,000.00 and running costs came to ₹1,000.00, so the loss is ₹3,000.00. The biggest running cost was Rent: ₹20,000.00.'
    )
    // stock sold down: profit lower than sales − purchases
    const down = { ...PROFIT, year: { ...PROFIT.year, openingStock: 40_000_00, closingStock: 30_000_00 } }
    expect(homeProfitWhy(down, t)).toContain('Profit is lower than sales minus purchases because you also sold ₹10,000.00 of the stock you had at the start.')
  })

  it('the comparison: better / worse by the difference, mostly from the line that moved it most', () => {
    // this month ₹20,000 vs ₹11,000: sales +₹10,000 moved it most (cost of goods +₹2,000 the other way, running costs −₹1,000)
    expect(MONTH.profit - PREV.profit).toBe(9_000_00)
    expect(biggestChange(MONTH, PREV)).toEqual({ part: 'sales', change: 10_000_00 })
    const s = monthCompareWhy(PROFIT, t)
    expect(s).toBe('This month’s result is ₹9,000.00 better than the same days last month (1 Sep 2026 to 13 Sep 2026), mostly because sales went up by ₹10,000.00.')
    figuresFrom(s, [MONTH.profit - PREV.profit, MONTH.sales - PREV.sales])
    // worse, mostly because running costs went up
    const worse = compareSentence(lines({ sales: 10_000_00, expenses: 9_000_00 }), lines({ sales: 11_000_00, expenses: 2_000_00 }), DOING.previous, 'period', t)
    expect(worse).toBe('The result is ₹8,000.00 worse than the period before (1 Sep 2026 to 13 Sep 2026), mostly because running costs went up by ₹7,000.00.')
    expect(compareSentence(MONTH, MONTH, DOING.previous, 'period', t)).toBe('The result is the same as the period before (1 Sep 2026 to 13 Sep 2026).')
  })

  it('Reports: sales with their change; the result with its stock reason; cash in its parts', () => {
    figuresFrom(salesCompareWhy(DOING, t), [MONTH.sales, MONTH.sales - PREV.sales])
    expect(doingResultWhy(DOING, t)).toBe(
      'You made a profit of ₹20,000.00 from 1 Oct 2026 to 13 Oct 2026 — the same figure the full profit and loss report shows. Profit is higher than sales minus purchases because ₹5,000.00 more stock is on the shelf than at the start — it is yours, not a cost.'
    )
    figuresFrom(doingCompareWhy(DOING, t), [MONTH.profit - PREV.profit, MONTH.sales - PREV.sales])
    expect(cashNowWhy(CASH, t)).toBe('₹10,000.00 is what you have today: ₹2,000.00 in cash and ₹8,000.00 in 1 bank account.')
    expect(CASH.split.total).toBe(CASH.now)
    expect(cashInWhy(CASH, t)).toBe('About ₹6,000.00 should come in by 11 Nov: From customers ₹5,000.00, Other ₹1,000.00. The biggest: Asha Stores, about ₹5,000.00 on 20 Oct.')
    figuresFrom(cashOutWhy(CASH, t), [CASH.moneyOut, 15_000_00, 4_000_00])
    expect(cashEndWhy(CASH, t)).toBe(
      '₹10,000.00 today, plus about ₹6,000.00 coming in, minus about ₹19,000.00 going out, leaves about -₹3,000.00 on 11 Nov. On 22 Oct it would go ₹1,500.00 below zero — plan for that before then.'
    )
    expect(CASH.now + CASH.moneyIn - CASH.moneyOut).toBe(CASH.end)
    // never below zero → the lowest point; nothing expected
    expect(cashEndWhy({ ...CASH, belowZero: null, end: 2_000_00, lowest: { amount: 1_000_00, date: '2026-10-25' } }, t)).toContain('The lowest point is about ₹1,000.00 on 25 Oct.')
    expect(cashInWhy({ ...CASH, moneyIn: 0, inBy: {}, topIn: [] }, t)).toBe('Nothing is expected to come in by 11 Nov.')
  })

  it('who owes: the total, the past-due part and who has the most; by month: totals, best month, last whole month vs the one before', () => {
    expect(owedTotalWhy(OWED, t)).toBe('₹8,000.00 is what 2 customers owe you today; ₹5,000.00 of it is past its due date. Asha Stores owes you the most: ₹5,000.00.')
    expect(owedTotalWhy({ ...OWED, side: 'payable' }, t)).toContain('You owe Asha Stores the most: ₹5,000.00.')
    const s = byMonthTotalsWhy(BY_MONTH, t)
    expect(s).toBe('Sales over the 12 months: ₹1,30,000.00; purchases: ₹40,000.00. The best month for sales was Sep 2026 (₹70,000.00). In Sep 2026 sales were ₹20,000.00 more than in Aug 2026.')
    expect(BY_MONTH.totals).toEqual({ sales: 1_30_000_00, purchases: 40_000_00 })
    figuresFrom(s, [BY_MONTH.totals.sales, BY_MONTH.totals.purchases, 70_000_00, 70_000_00 - 50_000_00])
  })

  it('Taxes: the cash to pay = collected − credit used, + reverse charge; credit left; each date; TDS', () => {
    const f = TAXES.figures
    expect(f.collected - f.creditUsed).toBe(f.cashOnSales)
    expect(f.cashOnSales + f.rcmCash).toBe(f.toPay)
    expect(toPayPartsWhy(TAXES, t)).toBe(
      'Of the ₹18,000.00 you collected, ₹10,800.00 is covered by the GST on your purchases, so ₹7,200.00 is left; with ₹500.00 under reverse charge, always paid in cash, that makes ₹7,700.00 — to pay by 20 Oct. ' +
        'Total prepares these figures; you file the return and pay on gst.gov.in.'
    )
    expect(toPayPartsWhy({ ...TAXES, figures: { ...f, cashOnSales: 0, toPay: 500_00, creditUsed: 18_000_00 } }, t)).toContain('the ₹500.00 under reverse charge is always paid in cash — by 20 Oct.')
    expect(toPayPartsWhy({ ...TAXES, figures: { ...f, cashOnSales: 0, rcmCash: 0, toPay: 0 } }, t)).toContain('nothing to pay in cash')
    expect(creditLeftWhy({ creditLeft: 0 }, t)).toBeNull()
    expect(dueWhy('gstr1', TAXES, t)).toBe('GSTR-1 lists every sales bill of Sep 2026; it is due 11 Oct, the 11th of the next month.')
    expect(dueWhy('gstr3b', TAXES, t)).toBe('GSTR-3B sums up Sep 2026 and goes with the payment of ₹7,700.00; it is due 20 Oct, the 20th of the next month.')
    const q = { ...TAXES, period: { period: '2026-09', from: '2026-07-01', to: '2026-09-30', quarterly: true, soFar: false }, due: { ...TAXES.due, gstr1: '2026-10-13', gstr3b: '2026-10-22' } }
    expect(dueWhy('gstr1', q, t)).toContain('the 13th after the quarter because you file every three months')
    expect(dueWhy('gstr3b', q, t)).toContain('the 22nd or 24th after the quarter depending on your state')
    expect(withholdingWhy(TDS, TODAY, t)).toBe(
      'TDS you deduct is the government’s money that you hold until you pay it: ₹3,000.00 is still to pay, and ₹2,000.00 of it is past its date. The oldest is from Aug 2026, due 7 Sep.'
    )
    figuresFrom(withholdingWhy(TDS, TODAY, t), [TDS.totalUnpaid, TDS.lateUnpaid])
  })
})

describe('every language renders every sentence (WP 10.2)', () => {
  let problems: I18nProblem[] = []
  beforeEach(() => {
    problems = []
    configureI18n({ dev: true, report: (p) => problems.push(p) })
  })
  afterEach(() => configureI18n({ dev: false }))

  it.each(LANGS)('%s: no unknown key, missing variable or broken message; the new keys translated; the same ₹ figures; no banned word', (lang) => {
    const tl = translator(lang)
    const sentences = all(tl)
    const english = all(t)
    for (const [i, s] of sentences.entries()) {
      expect(s, `${lang} #${i}`).not.toMatch(/[{}]|simple\.why/)
      expect(bannedWordsIn(s), `${lang}: ${s}`).toEqual([])
      // the same figures as English (sorted — word order differs)
      expect(amountsIn(s).sort((a, b) => a - b), `${lang} #${i}: ${s}`).toEqual(amountsIn(english[i]!).sort((a, b) => a - b))
    }
    expect(problems.filter((p) => p.kind !== 'untranslated')).toEqual([])
    expect(problems.filter((p) => p.key.startsWith('simple.why.'))).toEqual([])
  })
})
