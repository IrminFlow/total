// WP 10.2 — every figure on simple Home, Reports and Taxes has a "Why?": the popover shows the
// sentence explain*.ts computes from what the service returned, and its link says what it opens and
// opens THAT figure (the P&L for the line's dates, the trial balance as on today limited to cash /
// bank, Outstandings on the side, GSTR-1 / GSTR-3B for the period, TDS / payroll …). No banned word.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CompanyInfo } from '@shared/domain'
import { translator } from '@shared/i18n'
import { bannedWordsIn } from '@shared/simple/bannedWords'
import type { SimpleHomeData } from '@shared/simple/home'
import { last12Months, monthBars, monthTotals, type BusinessDoing, type DoingLines, type SimpleCash, type SimpleOwed } from '@shared/simple/reports'
import type { SimpleTaxes } from '@shared/simple/taxes'
import {
  byMonthTotalsWhy, cashEndWhy, doingCashWhy, cashInWhy, cashNowWhy, cashOutWhy, collectedWhy, deadlineWhy, doingResultWhy, dueWhy, homeProfitWhy, monthCompareWhy, onPurchasesWhy, owedTotalWhy,
  salesCompareWhy, toPayPartsWhy, withholdingWhy
} from '@shared/simple/explain'
import { useNav, useSession } from '../state/stores'
import { useExplain } from '../lib/explain'
import { SimpleHome } from '../simple/SimpleHome'
import { ReportsScreen } from '../simple/reports/ReportsScreen'
import { TaxesScreen } from '../simple/taxes/TaxesScreen'
import { ProfitLossScreen } from '../screens/ProfitLoss'

const t = translator('en')
const TODAY = '2026-10-13'
const invoke = vi.fn()
const info: CompanyInfo = { name: 'Mehta Traders', stateCode: '27', gstin: '27AAACT1234A1Z5', gstRegistrationType: 'regular', address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null }
const replies = new Map<string, unknown>()

const lines = (o: Partial<DoingLines>): DoingLines => {
  const l = { sales: 0, openingStock: 0, purchases: 0, closingStock: 0, otherIncome: 0, expenses: 0, ...o }
  const costOfGoods = l.openingStock + l.purchases - l.closingStock
  return { ...l, costOfGoods, profitOnGoods: l.sales - costOfGoods, profit: l.sales - costOfGoods + l.otherIncome - l.expenses }
}
const YEAR = lines({ sales: 2_00_000_00, purchases: 1_60_000_00, closingStock: 30_000_00, expenses: 25_000_00 })
const MONTH = lines({ sales: 40_000_00, purchases: 20_000_00, openingStock: 25_000_00, closingStock: 30_000_00, expenses: 5_000_00 })
const PREV = lines({ sales: 30_000_00, purchases: 18_000_00, openingStock: 20_000_00, closingStock: 25_000_00, expenses: 6_000_00 })

const HOME: SimpleHomeData = {
  today: TODAY,
  fy: { from: '2026-04-01', to: '2027-03-31' },
  moneyIn: { amount: 4_200_00, entries: 3, loans: 0 },
  moneyOut: { amount: 1_200_00, entries: 1, loans: 0 },
  receivables: { total: 8_000_00, parties: 2, overdue: 5_000_00, overdueBills: 1, oldest: { ledgerId: 7, name: 'Asha Stores', days: 40 }, nextDue: null, advances: 0, advanceParties: 0 },
  payables: { total: 3_000_00, parties: 1, overdue: 0, overdueBills: 0, oldest: null, nextDue: { ledgerId: 8, name: 'Sharma Traders', date: '2026-10-20', amount: 3_000_00 }, advances: 0, advanceParties: 0 },
  cash: { accounts: [{ ledgerId: 1, name: 'Cash', kind: 'cash', balance: 5_000_00 }, { ledgerId: 2, name: 'HDFC Bank', kind: 'bank', balance: 45_000_00 }], cash: 5_000_00, bank: 45_000_00, total: 50_000_00 },
  profit: {
    month: { month: '2026-10', from: '2026-10-01', to: TODAY, netProfit: MONTH.profit, openingStock: 25_000_00, closingStock: 30_000_00, lines: MONTH, topExpense: null },
    year: { from: '2026-04-01', to: TODAY, netProfit: YEAR.profit, openingStock: 0, closingStock: 30_000_00, lines: YEAR, topExpense: { name: 'Rent', amount: 20_000_00, ledgerId: 9 } },
    previousMonth: { from: '2026-09-01', to: '2026-09-13', lines: PREV }
  },
  gst: {
    kind: 'regular', filing: 'monthly', credit: { checked: 'none', awaiting: 0 },
    row: { period: '2026-09', from: '2026-09-01', to: '2026-09-30', gstr1Due: '2026-10-11', gstr3bDue: '2026-10-20', liability: 18_000_00, outwardTax: 18_000_00, rcmTax: 0, itc: 10_800_00, payable: 7_200_00, annual: [] }
  },
  deadlines: [
    { id: 'tds-2026-10', form: 'TDS', title: 'TDS deposit', date: '2026-11-07', kind: 'tds' },
    { id: 'pf-2026-10', form: 'PF ECR', title: 'PF', date: '2026-11-15', kind: 'pf' },
    { id: 'adv-q3', form: 'Advance tax', title: 'Advance tax Q3', date: '2026-12-15', kind: 'advance-tax' }
  ],
  backup: { lastAt: null, days: null, nudge: false },
  setup: { companyInfoComplete: true, gstRegistered: true, gstinSet: true, userLedgers: 3, bankLedgers: 1, voucherCount: 10, userBackups: 1 },
  gstAnswer: 'regular'
}

const DOING: BusinessDoing = {
  kind: 'this-month', span: { from: '2026-10-01', to: TODAY }, previous: { from: '2026-09-01', to: '2026-09-13' },
  lines: { ...MONTH, otherIncome: 0 }, previousLines: PREV, topExpenses: [{ name: 'Rent', amount: 5_000_00, ledgerId: 9 }], topSales: [],
  asOn: TODAY, cash: { cash: 5_000_00, bank: 45_000_00, total: 50_000_00, ledgerIds: [1, 2], banks: 1 },
  owed: { receivable: 8_000_00, receivableParties: 2, payable: 3_000_00, payableParties: 1, customerAdvances: 0, supplierAdvances: 0 }, empty: false
}
const CASH: SimpleCash = {
  asOn: TODAY, until: '2026-11-11', now: 50_000_00, moneyIn: 8_000_00, moneyOut: 60_000_00, end: -2_000_00, lowest: { amount: -3_000_00, date: '2026-10-25' },
  inBy: { customers: 8_000_00 }, outBy: { suppliers: 60_000_00 },
  topIn: [{ label: 'Asha Stores', date: '2026-10-20', amount: 8_000_00, source: 'customers', ledgerId: 7 }], topOut: [{ label: 'Sharma Traders', date: '2026-10-22', amount: 60_000_00, source: 'suppliers', ledgerId: 8 }],
  warnings: 0, split: { cash: 5_000_00, bank: 45_000_00, total: 50_000_00, ledgerIds: [1, 2], banks: 1 }, belowZero: { amount: -2_000_00, date: '2026-10-22' }
}
const OWED: SimpleOwed = {
  side: 'receivable', asOn: TODAY, total: 8_000_00, overdue: 5_000_00, advances: 0, advanceParties: 0,
  parties: [{ ledgerId: 7, name: 'Asha Stores', pending: 5_000_00, overdue: 5_000_00, bills: 1, oldestDays: 40 }, { ledgerId: 8, name: 'Bala', pending: 3_000_00, overdue: 0, bills: 1, oldestDays: 3 }]
}
const MONTHS = last12Months(TODAY)
const BARS = monthBars(MONTHS, [{ month: '2026-08', taxable: 50_000_00, vouchers: 2 }, { month: '2026-09', taxable: 70_000_00, vouchers: 3 }], [{ month: '2026-09', taxable: 40_000_00, vouchers: 2 }])
const BY_MONTH = { from: `${MONTHS[0]}-01`, to: TODAY, months: BARS, totals: monthTotals(BARS) }

type Regular = Extract<SimpleTaxes, { kind: 'regular' }>
const TDS = { kind: 'tds' as const, thisMonth: 300_00, thisMonthDue: '2026-11-07', totalUnpaid: 900_00, lateUnpaid: 600_00, unpaid: [{ month: '2026-09', amount: 600_00, dueDate: '2026-10-07', late: true }, { month: '2026-10', amount: 300_00, dueDate: '2026-11-07', late: false }] }
const TAXES: Regular = {
  kind: 'regular', today: TODAY, filing: 'quarterly',
  period: { period: '2026-09', from: '2026-07-01', to: '2026-09-30', quarterly: true, soFar: false }, periods: [{ period: '2026-09', from: '2026-07-01', to: '2026-09-30', quarterly: true, soFar: false }],
  figures: { collected: 18_000_00, reverseCharge: 500_00, onPurchases: 12_000_00, awaiting: 0, checked: 'none', toPay: 6_500_00, cashOnSales: 6_000_00, rcmCash: 500_00, creditUsed: 12_000_00, creditLeft: 0 },
  due: { gstr1: '2026-10-13', gstr3b: '2026-10-22', gstr3bUnverified: false, pmt06: ['2026-08-25', '2026-09-25'] },
  missing: [], supplierBills: [], prepared: { gstr1: null, gstr3b: null }, filesMonthly: true, filed: {}, withholding: [TDS]
}

const lastScreen = (): unknown => useNav.getState().stack.at(-1)
function renderUi(ui: React.ReactNode): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

/** Opens a "Why?", checks its sentence, and (when there is a link) that it opens `target`. */
async function why(testId: string, sentence: string, link?: { label: string; target: unknown }): Promise<void> {
  if (!screen.queryByTestId(`${testId}-sentence`)) fireEvent.click(await screen.findByTestId(testId))
  expect((await screen.findByTestId(`${testId}-sentence`)).textContent).toBe(sentence)
  expect(bannedWordsIn(sentence)).toEqual([])
  if (!link) {
    expect(screen.queryByTestId(`${testId}-link`)).toBeNull()
    fireEvent.click(screen.getByTestId(testId))
    return
  }
  const a = screen.getByTestId(`${testId}-link`)
  expect(a.textContent).toBe(`${link.label} →`)
  const before = useNav.getState().stack
  fireEvent.click(a)
  await waitFor(() => expect(lastScreen()).toEqual(link.target))
  act(() => useNav.setState({ stack: before }))
}

beforeEach(() => {
  replies.clear()
  replies.set('simple:home', HOME)
  replies.set('simple:homeAttention', { period: '2026-09', items: [], anomaliesSkipped: false })
  replies.set('simple:reports:doing', DOING)
  replies.set('simple:reports:cash', CASH)
  replies.set('simple:reports:owed', OWED)
  replies.set('simple:reports:byMonth', BY_MONTH)
  replies.set('simple:taxes', TAXES)
  invoke.mockImplementation(async (channel: string) => ({ ok: true, data: replies.has(channel) ? replies.get(channel) : null }))
  window.total = { platform: 'test', invoke } as unknown as typeof window.total
  localStorage.clear()
  act(() => {
    useSession.setState({ info, slug: 'mehta', ui: { mode: 'simple' }, workingDate: TODAY, from: '2026-04-01', to: '2027-03-31', user: null })
    useNav.setState({ stack: [{ name: 'gateway' }] })
    useExplain.setState({ ready: false, handler: null })
  })
})
afterEach(() => {
  cleanup()
  invoke.mockReset()
})

describe('Home: every tile and date has a "Why?" (WP 10.2)', () => {
  it('profit: what it is made of, the stock on the shelf, the month against last month; opens the P&L for the FY to today', async () => {
    renderUi(<SimpleHome />)
    for (const id of ['money-in', 'money-out', 'cash', 'receivables', 'payables', 'gst', 'profit']) expect(await screen.findByTestId(`simple-why-${id}`)).toBeTruthy()
    fireEvent.click(screen.getByTestId('simple-why-profit'))
    expect((await screen.findByTestId('simple-why-profit-compare')).textContent).toBe(monthCompareWhy(HOME.profit, t))
    expect(screen.getByTestId('simple-why-profit-compare').textContent).toContain('mostly because sales went up by ₹10,000.00')
    await why('simple-why-profit', homeProfitWhy(HOME.profit, t), { label: 'Open the profit and loss report', target: { name: 'profit-loss', from: '2026-04-01', to: TODAY } })
  })

  it('each "Coming up" date: what it is for; TDS opens TDS, PF opens payroll, advance tax has no screen', async () => {
    renderUi(<SimpleHome />)
    await why('simple-why-deadline-tds', deadlineWhy(HOME.deadlines[0]!, TODAY, t), { label: 'Open TDS in the full app', target: { name: 'tds' } })
    await why('simple-why-deadline-pf', deadlineWhy(HOME.deadlines[1]!, TODAY, t), { label: 'Open payroll in the full app', target: { name: 'payroll' } })
    await why('simple-why-deadline-advance-tax', deadlineWhy(HOME.deadlines[2]!, TODAY, t))
  })
})

describe('Reports: every line and figure has a "Why?" (WP 10.2)', () => {
  it('How is my business doing: each line opens the P&L for its period; profit says the comparison', async () => {
    renderUi(<ReportsScreen />)
    const pnl = { label: 'Open the profit and loss report for 1 Oct 2026 to 13 Oct 2026', target: { name: 'profit-loss', from: '2026-10-01', to: TODAY } }
    await why('why-doing-sales', salesCompareWhy(DOING, t), pnl)
    for (const id of ['cost', 'goods', 'expenses']) {
      fireEvent.click(await screen.findByTestId(`why-doing-${id}`))
      expect(screen.getByTestId(`why-doing-${id}-link`).textContent).toBe(`${pnl.label} →`)
      fireEvent.click(screen.getByTestId(`why-doing-${id}`))
    }
    fireEvent.click(screen.getByTestId('why-doing-profit'))
    expect((await screen.findByTestId('why-doing-profit-extra')).textContent).toContain('The result is ₹9,000.00 better than the period before')
    await why('why-doing-profit', doingResultWhy(DOING, t), pnl)
    await why('why-doing-cash', doingCashWhy(DOING, t), {
      label: 'See each account’s balance', target: { name: 'trial-balance', asOn: TODAY, ledgerIds: [1, 2] }
    })
  })

  it('Cash in the next 30 days: each tile its own sentence; today opens the trial balance, the rest the forecast', async () => {
    renderUi(<ReportsScreen report="cash" />)
    const forecast = { label: 'Open the full cash forecast', target: { name: 'cash-forecast' } }
    await why('why-cash-now', cashNowWhy(CASH, t), { label: 'See each account’s balance today', target: { name: 'trial-balance', asOn: TODAY, ledgerIds: [1, 2] } })
    await why('why-cash-in', cashInWhy(CASH, t), forecast)
    await why('why-cash-out', cashOutWhy(CASH, t), forecast)
    await why('why-cash-end', cashEndWhy(CASH, t), forecast)
    expect(cashEndWhy(CASH, t)).toContain('On 22 Oct it would go ₹2,000.00 below zero')
  })

  it('who owes me: the total, past due and who owes most → Outstandings; by month → the lists', async () => {
    renderUi(<ReportsScreen report="owed" />)
    await why('why-owed', owedTotalWhy(OWED, t), { label: 'See every open bill, party by party', target: { name: 'outstandings', side: 'receivable' } })
    cleanup()
    renderUi(<ReportsScreen report="by-month" />)
    await why('why-by-month', byMonthTotalsWhy(BY_MONTH, t), { label: 'Open the sales and purchase lists', target: { name: 'registers', tab: 'sales' } })
  })
})

describe('Taxes: the three figures, each date and TDS have a "Why?" (WP 10.2)', () => {
  it('figures open GSTR-3B for the period; the dates open their return; TDS opens TDS', async () => {
    renderUi(<TaxesScreen />)
    const g3b = { label: 'Open GSTR-3B in the full app', target: { name: 'gstr3b', month: '2026-07' } }
    // the three figures keep WP 9.9's link (the screen's Accountant view: GSTR-3B for the period)
    const fig = { label: t('simple.taxes.accountant3b'), target: g3b.target }
    await why('why-gst-collected', collectedWhy(TAXES, t), fig)
    await why('why-gst-purchases', onPurchasesWhy(TAXES, t), fig)
    await why('why-gst-to-pay', toPayPartsWhy(TAXES, t), fig)
    expect(toPayPartsWhy(TAXES, t)).toContain('₹6,000.00 is left; with ₹500.00 under reverse charge, always paid in cash, that makes ₹6,500.00')
    await why('why-due-gstr1', dueWhy('gstr1', TAXES, t), { label: 'Open GSTR-1 in the full app', target: { name: 'gstr1' } })
    await why('why-due-gstr3b', dueWhy('gstr3b', TAXES, t), g3b)
    await why('why-due-pmt06', dueWhy('pmt06', TAXES, t))
    await why('why-tds', withholdingWhy(TDS, TODAY, t), { label: 'Open TDS in the full app', target: { name: 'tds' } })
  })

  it('composition: each date explained', async () => {
    replies.set('simple:taxes', { kind: 'composition', today: TODAY, composition: { cmp08: { from: '2026-07-01', to: '2026-09-30', due: '2026-10-18' }, gstr4: { fyLabel: '2026-27', due: '2027-06-30' } }, withholding: [] })
    renderUi(<TaxesScreen />)
    fireEvent.click(await screen.findByTestId('why-due-cmp08'))
    expect((await screen.findByTestId('why-due-cmp08-sentence')).textContent).toBe('Under composition you pay a fixed share of your sales; CMP-08 states it for 1 Jul 2026 to 30 Sep 2026 and is due 18 Oct, the 18th after the quarter.')
    fireEvent.click(screen.getByTestId('why-due-gstr4'))
    expect((await screen.findByTestId('why-due-gstr4-sentence')).textContent).toBe('GSTR-4 is the yearly return for 2026-27; it is due 30 Jun 2027.')
  })
})

describe('the P&L opens on the dates a "Why?" asks for (WP 10.2)', () => {
  const asked = (): unknown[] => invoke.mock.calls.filter(([c]) => c === 'report:profitLoss').map(([, p]) => p)
  it('with from / to it shows that period (the session period is left alone); without them, the session period as before', async () => {
    renderUi(<ProfitLossScreen from="2026-10-01" to="2026-10-13" />)
    await waitFor(() => expect(asked()).toContainEqual({ from: '2026-10-01', to: '2026-10-13' }))
    expect(asked()).not.toContainEqual(expect.objectContaining({ from: '2026-04-01' }))
    expect(useSession.getState().from).toBe('2026-04-01')
    cleanup()
    invoke.mockClear()
    renderUi(<ProfitLossScreen />)
    await waitFor(() => expect(asked()).toContainEqual(expect.objectContaining({ from: '2026-04-01', to: '2027-03-31' })))
  })
})
