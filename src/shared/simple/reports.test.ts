// WP 9.9: the plain reports' pure rules — the periods and what they are compared with, the
// one-column lines as the P&L's own totals (profit IS its net profit), the 12 bars, the owed rows
// and the "Why?" sentences (hand-worked figures, banned-word clean).
import { describe, expect, it } from 'vitest'
import { translator } from '../i18n'
import { bannedWordsIn } from './bannedWords'
import { doingLines, last12Months, monthBars, monthTotals, owedRows, previousSpan, reportSpan, topParts, type BusinessDoing, type SimpleCash } from './reports'
import { byMonthWhy, cashNext30Why, costWhy, doingCashWhy, doingOwedWhy, doingProfitWhy, expensesWhy, owedListWhy, profitOnGoodsWhy, salesWhy } from './explain'
import type { ProfitAndLoss, StatementNode } from '../reports'

const t = translator('en')
const node = (id: number, name: string, amount: number, children: StatementNode[] = [], kind: StatementNode['kind'] = children.length ? 'group' : 'ledger'): StatementNode => ({ id, kind, name, amount, children })

describe('report periods', () => {
  it('this month / last month / this FY / custom, as on today', () => {
    expect(reportSpan('this-month', '2026-10-14')).toEqual({ from: '2026-10-01', to: '2026-10-14' })
    expect(reportSpan('last-month', '2026-10-14')).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(reportSpan('last-month', '2026-01-05')).toEqual({ from: '2025-12-01', to: '2025-12-31' })
    expect(reportSpan('this-year', '2026-10-14')).toEqual({ from: '2026-04-01', to: '2026-10-14' })
    expect(reportSpan('this-year', '2027-02-10')).toEqual({ from: '2026-04-01', to: '2027-02-10' })
    expect(reportSpan('custom', '2026-10-14', { from: '2026-05-01', to: '2026-05-31' })).toEqual({ from: '2026-05-01', to: '2026-05-31' })
    expect(reportSpan('custom', '2026-10-14', { from: '2026-06-01', to: '2026-05-31' })).toBeNull()
    expect(reportSpan('custom', '2026-10-14', { from: '2026-06-01' })).toBeNull()
  })

  it('the previous period: the same days one step back', () => {
    expect(previousSpan('this-month', { from: '2026-10-01', to: '2026-10-14' })).toEqual({ from: '2026-09-01', to: '2026-09-14' })
    // 31 March → 28 / 29 February.
    expect(previousSpan('this-month', { from: '2026-03-01', to: '2026-03-31' })).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(previousSpan('last-month', { from: '2026-09-01', to: '2026-09-30' })).toEqual({ from: '2026-08-01', to: '2026-08-31' })
    expect(previousSpan('this-year', { from: '2026-04-01', to: '2026-10-14' })).toEqual({ from: '2025-04-01', to: '2025-10-14' })
    expect(previousSpan('this-year', { from: '2027-04-01', to: '2028-02-29' })).toEqual({ from: '2026-04-01', to: '2027-02-28' })
    // 10 days → the 10 days before.
    expect(previousSpan('custom', { from: '2026-05-11', to: '2026-05-20' })).toEqual({ from: '2026-05-01', to: '2026-05-10' })
  })
})

describe('the one column', () => {
  // Hand-worked: sales 1,00,000 + direct income 5,000 = 1,05,000; purchases 60,000 + freight 2,000
  // = 62,000; opening stock 20,000, closing 30,000 → cost of goods 20,000 + 62,000 − 30,000 =
  // 52,000; gross 1,05,000 − 52,000 = 53,000; + interest 1,000 − rent 12,000 − salary 18,000 =
  // 24,000 profit.
  const pnl: Pick<ProfitAndLoss, 'openingStock' | 'closingStock' | 'tradingIncomes' | 'tradingExpenses' | 'indirectIncomes' | 'indirectExpenses' | 'grossProfit' | 'netProfit'> = {
    openingStock: 20_000_00,
    closingStock: 30_000_00,
    tradingIncomes: [node(1, 'Sales Accounts', 1_05_000_00, [node(11, 'Sales', 1_00_000_00), node(12, 'Job charges', 5_000_00)])],
    tradingExpenses: [node(2, 'Purchase Accounts', 62_000_00, [node(21, 'Purchases', 60_000_00), node(22, 'Freight inward', 2_000_00)])],
    indirectIncomes: [node(31, 'Interest received', 1_000_00)],
    indirectExpenses: [node(4, 'Indirect Expenses', 30_000_00, [node(41, 'Rent', 12_000_00), node(42, 'Salary', 18_000_00)])],
    grossProfit: 53_000_00,
    netProfit: 24_000_00
  }

  it('re-arranges the P&L totals; profit is its net profit', () => {
    const l = doingLines(pnl)
    expect(l).toEqual({
      sales: 1_05_000_00, openingStock: 20_000_00, purchases: 62_000_00, closingStock: 30_000_00, costOfGoods: 52_000_00,
      profitOnGoods: 53_000_00, otherIncome: 1_000_00, expenses: 30_000_00, profit: 24_000_00
    })
    expect(l.sales - l.costOfGoods).toBe(l.profitOnGoods)
    expect(l.profitOnGoods + l.otherIncome - l.expenses).toBe(l.profit)
  })

  it('top parts are the biggest leaves', () => {
    expect(topParts(pnl.indirectExpenses)).toEqual([
      { name: 'Salary', amount: 18_000_00, ledgerId: 42 },
      { name: 'Rent', amount: 12_000_00, ledgerId: 41 }
    ])
  })

  it('the sentences', () => {
    const d: BusinessDoing = {
      kind: 'this-month', span: { from: '2026-10-01', to: '2026-10-14' }, previous: { from: '2026-09-01', to: '2026-09-14' },
      lines: doingLines(pnl), previousLines: { ...doingLines(pnl), profit: 20_000_00 }, topExpenses: topParts(pnl.indirectExpenses), topSales: [],
      asOn: '2026-10-14', cash: { cash: 5_000_00, bank: 45_000_00, total: 50_000_00, ledgerIds: [1, 2], banks: 1 },
      owed: { receivable: 8_000_00, receivableParties: 2, payable: 3_000_00, payableParties: 1, customerAdvances: 0, supplierAdvances: 0 }, empty: false
    }
    expect(salesWhy(d, t)).toBe('Sales are what you billed from 1 Oct 2026 to 14 Oct 2026, with returns taken off and before GST: ₹1,05,000.00.')
    expect(costWhy(d, t)).toBe('The goods you sold cost you ₹52,000.00: stock at the start ₹20,000.00, plus purchases ₹62,000.00, minus the stock left at the end ₹30,000.00.')
    expect(profitOnGoodsWhy(d, t)).toBe('Sales ₹1,05,000.00 minus what the goods cost ₹52,000.00 leaves ₹53,000.00 on the goods sold.')
    expect(expensesWhy(d, t)).toBe('Running costs such as rent, salaries and electricity: ₹30,000.00. The biggest: Salary ₹18,000.00, Rent ₹12,000.00.')
    expect(doingProfitWhy(d, t)).toBe(
      'You made a profit of ₹24,000.00 from 1 Oct 2026 to 14 Oct 2026 — the same figure the full profit and loss report shows. ' +
        'Profit is higher than sales minus purchases because ₹10,000.00 more stock is on the shelf than at the start — it is yours, not a cost. ' +
        '₹4,000.00 more than the previous period (1 Sep 2026 to 14 Sep 2026).'
    )
    expect(doingCashWhy(d, t)).toBe('₹50,000.00 in cash and bank on 14 Oct 2026: ₹5,000.00 in cash and ₹45,000.00 in 1 bank account.')
    expect(doingOwedWhy(d, t)).toBe('On 14 Oct 2026 customers owe you ₹8,000.00 and you owe suppliers ₹3,000.00, bill by bill.')
    const loss = { ...d, lines: { ...d.lines, profit: -5_000_00, openingStock: 0, closingStock: 0 }, previousLines: { ...d.lines, profit: -5_000_00 } }
    expect(doingProfitWhy(loss, t)).toBe('You made a loss of ₹5,000.00 from 1 Oct 2026 to 14 Oct 2026 — the same figure the full profit and loss report shows. The same as the previous period (1 Sep 2026 to 14 Sep 2026).')
    expect(costWhy(loss, t)).toContain('What you bought to sell')
    for (const s of [salesWhy(d, t), costWhy(d, t), expensesWhy(d, t), doingProfitWhy(d, t), doingCashWhy(d, t), doingOwedWhy(d, t)]) expect(bannedWordsIn(s)).toEqual([])
  })
})

describe('cash, owed, by month', () => {
  it('cash in the next 30 days: the sentence names the lowest point and a shortfall', () => {
    const c: SimpleCash = {
      asOn: '2026-10-14', until: '2026-11-12', now: 10_000_00, moneyIn: 4_000_00, moneyOut: 16_000_00, end: -2_000_00,
      lowest: { amount: -3_000_00, date: '2026-10-20' }, inBy: { customers: 4_000_00 }, outBy: { suppliers: 16_000_00 }, topIn: [], topOut: [], warnings: 0,
      split: { cash: 10_000_00, bank: 0, total: 10_000_00, ledgerIds: [1], banks: 0 }, belowZero: { amount: -1_000_00, date: '2026-10-18' }
    }
    expect(cashNext30Why(c, t)).toBe(
      'You have ₹10,000.00 today. About ₹4,000.00 should come in and ₹16,000.00 go out by 12 Nov, which leaves about -₹2,000.00. ' +
        'The lowest point is about -₹3,000.00 on 20 Oct. That is below zero — plan for the shortfall before then. Money from customers is an estimate, based on how quickly they have paid before.'
    )
  })

  it('owed rows: largest first, overdue part, oldest bill', () => {
    const rows = owedRows([
      { ledgerId: 1, name: 'Asha', pending: 500_00, bills: [{ voucherId: 1, number: 'S1', date: '2026-09-01', amount: 500_00, pending: 500_00, dueDate: '2026-09-30', ageDays: 43, overdueDays: 14 }] },
      { ledgerId: 2, name: 'Bala', pending: 900_00, bills: [{ voucherId: 2, number: 'S2', date: '2026-10-10', amount: 900_00, pending: 900_00, dueDate: '2026-10-25', ageDays: 4, overdueDays: 0 }] },
      { ledgerId: 3, name: 'Zero', pending: 0, bills: [] }
    ] as never)
    expect(rows).toEqual([
      { ledgerId: 2, name: 'Bala', pending: 900_00, overdue: 0, bills: 1, oldestDays: 4 },
      { ledgerId: 1, name: 'Asha', pending: 500_00, overdue: 500_00, bills: 1, oldestDays: 43 }
    ])
    expect(owedListWhy({ side: 'receivable', asOn: '2026-10-14', total: 1_400_00, overdue: 500_00, parties: rows, advances: 200_00, advanceParties: 1 }, t)).toBe(
      '₹1,400.00 is what 2 customers owe you today; ₹500.00 of it is past its due date. You also hold ₹200.00 that customers paid in advance.'
    )
    expect(owedListWhy({ side: 'payable', asOn: '2026-10-14', total: 0, overdue: 0, parties: [], advances: 0, advanceParties: 0 }, t)).toBe('You don’t owe any supplier today.')
  })

  it('12 bars ending this month; a month without bills is zero', () => {
    const months = last12Months('2026-10-14')
    expect(months[0]).toBe('2025-11')
    expect(months.at(-1)).toBe('2026-10')
    expect(months).toHaveLength(12)
    const bars = monthBars(months, [{ month: '2026-09', taxable: 70_000_00, vouchers: 3 }, { month: '2026-10', taxable: 10_000_00, vouchers: 1 }], [{ month: '2026-09', taxable: 40_000_00, vouchers: 2 }])
    expect(bars.find((b) => b.month === '2026-09')).toEqual({ month: '2026-09', sales: 70_000_00, purchases: 40_000_00, salesBills: 3, purchaseBills: 2 })
    expect(bars.find((b) => b.month === '2026-01')).toEqual({ month: '2026-01', sales: 0, purchases: 0, salesBills: 0, purchaseBills: 0 })
    expect(byMonthWhy({ months: bars, from: '2025-11-01', to: '2026-10-14', totals: monthTotals(bars) }, t)).toBe(
      'Sales over the 12 months: ₹80,000.00; purchases: ₹40,000.00. The best month for sales was Sep 2026 (₹70,000.00).'
    )
    expect(byMonthWhy({ months: monthBars(months, [], []), from: '', to: '', totals: { sales: 0, purchases: 0 } }, t)).toBe('No sales or purchase bills in the last 12 months.')
  })
})
