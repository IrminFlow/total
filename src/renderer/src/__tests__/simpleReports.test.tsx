// WP 9.9 — the simple Reports: "How is my business doing" (the one column from simple:reports:doing,
// a "Why?" per line, the period picker incl. dates with the error under "to", the T-form P&L as
// the Accountant view), Cash in the next 30 days, Who owes me / Whom I owe (a row opens the
// statement), Sales and purchases by month (12 bars). No banned word on any of them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CompanyInfo } from '@shared/domain'
import type { BusinessDoing, SimpleByMonth, SimpleCash, SimpleOwed } from '@shared/simple/reports'
import { last12Months, monthBars, monthTotals } from '@shared/simple/reports'
import { bannedWordsIn } from '@shared/simple/bannedWords'
import { useNav, useSession } from '../state/stores'
import { useExplain } from '../lib/explain'
import { ReportsScreen } from '../simple/reports/ReportsScreen'

const invoke = vi.fn()
const info: CompanyInfo = { name: 'Mehta Traders', stateCode: '27', gstin: '27AAACT1234A1Z5', gstRegistrationType: 'regular', address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null }
const lines = { sales: 1_05_000_00, openingStock: 20_000_00, purchases: 62_000_00, closingStock: 30_000_00, costOfGoods: 52_000_00, profitOnGoods: 53_000_00, otherIncome: 1_000_00, expenses: 30_000_00, profit: 24_000_00 }
const DOING: BusinessDoing = {
  kind: 'this-month', span: { from: '2026-10-01', to: '2026-10-13' }, previous: { from: '2026-09-01', to: '2026-09-13' },
  lines, previousLines: { ...lines, profit: 20_000_00 }, topExpenses: [{ name: 'Salary', amount: 18_000_00, ledgerId: 42 }, { name: 'Rent', amount: 12_000_00, ledgerId: 41 }], topSales: [],
  asOn: '2026-10-13', cash: { cash: 5_000_00, bank: 45_000_00, total: 50_000_00, ledgerIds: [1, 2], banks: 1 },
  owed: { receivable: 8_000_00, receivableParties: 2, payable: 3_000_00, payableParties: 1, customerAdvances: 0, supplierAdvances: 0 }, empty: false
}
const CASH: SimpleCash = {
  asOn: '2026-10-13', until: '2026-11-11', now: 50_000_00, moneyIn: 8_000_00, moneyOut: 3_000_00, end: 55_000_00, lowest: null,
  inBy: { customers: 8_000_00 }, outBy: { suppliers: 3_000_00 }, topIn: [{ label: 'Asha Stores', date: '2026-10-20', amount: 8_000_00, source: 'customers', ledgerId: 7 }], topOut: [], warnings: 0,
  split: { cash: 5_000_00, bank: 45_000_00, total: 50_000_00, ledgerIds: [1, 2], banks: 1 }, belowZero: null
}
const OWED: SimpleOwed = {
  side: 'receivable', asOn: '2026-10-13', total: 8_000_00, overdue: 5_000_00, advances: 0, advanceParties: 0,
  parties: [{ ledgerId: 7, name: 'Asha Stores', pending: 5_000_00, overdue: 5_000_00, bills: 1, oldestDays: 40 }, { ledgerId: 8, name: 'Bala', pending: 3_000_00, overdue: 0, bills: 1, oldestDays: 3 }]
}
const months = last12Months('2026-10-13')
const BARS = monthBars(months, [{ month: '2026-09', taxable: 70_000_00, vouchers: 3 }], [{ month: '2026-09', taxable: 40_000_00, vouchers: 2 }])
const BY_MONTH: SimpleByMonth = { from: `${months[0]}-01`, to: '2026-10-13', months: BARS, totals: monthTotals(BARS) }

let doingReply: (p: { period: string }) => { ok: boolean; data?: unknown; error?: string; code?: string; field?: string }
const calls = (ch: string): unknown[] => invoke.mock.calls.filter(([c]) => c === ch).map(([, p]) => p)
const lastScreen = (): unknown => useNav.getState().stack.at(-1)

function renderUi(ui: React.ReactNode): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}
const visibleText = (): string => document.body.textContent ?? ''

beforeEach(() => {
  doingReply = () => ({ ok: true, data: DOING })
  invoke.mockImplementation(async (channel: string, payload: unknown) => {
    switch (channel) {
      case 'simple:reports:doing': return doingReply(payload as { period: string })
      case 'simple:reports:cash': return { ok: true, data: CASH }
      case 'simple:reports:owed': return { ok: true, data: { ...OWED, side: (payload as { side: 'receivable' | 'payable' }).side } }
      case 'simple:reports:byMonth': return { ok: true, data: BY_MONTH }
      default: return { ok: true, data: [] }
    }
  })
  window.total = { platform: 'test', invoke }
  act(() => {
    useSession.setState({ info, slug: 'mehta', ui: { mode: 'simple' }, workingDate: '2026-10-13', from: '2026-04-01', to: '2027-03-31' })
    useNav.setState({ stack: [{ name: 'simple-reports' }] })
    useExplain.setState({ ready: false, handler: null })
  })
})
afterEach(() => {
  cleanup()
  invoke.mockReset()
})

describe('How is my business doing (WP 9.9)', () => {
  it('one column from the P&L totals, a "Why?" per line, the change, cash and dues', async () => {
    renderUi(<ReportsScreen />)
    expect((await screen.findByTestId('doing-line-sales')).getAttribute('data-paise')).toBe(String(1_05_000_00))
    expect(screen.getByTestId('doing-line-cost').textContent).toContain('Stock at the start ₹20,000.00 · purchases ₹62,000.00 · stock left at the end ₹30,000.00')
    expect(screen.getByTestId('doing-line-profit').getAttribute('data-paise')).toBe(String(24_000_00))
    expect(screen.getByTestId('doing-line-profit').textContent).toContain('Profit')
    expect(screen.getByTestId('doing-change').textContent).toBe('₹4,000.00 more than the previous period (1 Sep 2026 to 13 Sep 2026).')
    fireEvent.click(screen.getByTestId('why-doing-expenses'))
    expect((await screen.findByTestId('why-doing-expenses-sentence')).textContent).toBe('Running costs such as rent, salaries and electricity: ₹30,000.00. The biggest: Salary ₹18,000.00, Rent ₹12,000.00.')
    fireEvent.click(screen.getByTestId('why-doing-profit'))
    fireEvent.click(await screen.findByTestId('why-doing-profit-link'))
    // WP 10.2: the P&L for exactly the period the line covers
    await waitFor(() => expect(lastScreen()).toEqual({ name: 'profit-loss', from: '2026-10-01', to: '2026-10-13' }))
    expect(screen.getByTestId('doing-cash').getAttribute('data-paise')).toBe(String(50_000_00))
    expect(screen.getByTestId('doing-receivable').textContent).toBe('₹8,000.00')
    expect(bannedWordsIn(visibleText())).toEqual([])
    fireEvent.click(screen.getByTestId('doing-accountant-view'))
    await waitFor(() => expect(lastScreen()).toEqual({ name: 'profit-loss' }))
  })

  it('the period picker: last month, this year; dates you pick — an error sits under "to"', async () => {
    renderUi(<ReportsScreen />)
    await screen.findByTestId('doing-line-sales')
    fireEvent.click(screen.getByTestId('doing-period-last-month'))
    await waitFor(() => expect(calls('simple:reports:doing').some((p) => (p as { period: string }).period === 'last-month')).toBe(true))
    fireEvent.click(screen.getByTestId('doing-period-this-year'))
    await waitFor(() => expect(calls('simple:reports:doing').some((p) => (p as { period: string }).period === 'this-year')).toBe(true))
    doingReply = () => ({ ok: false, error: 'Choose a start date on or before the end date.', code: 'simple_report_period', field: 'to' })
    fireEvent.click(screen.getByTestId('doing-period-custom'))
    const from = screen.getByTestId('doing-from')
    fireEvent.change(from, { target: { value: '10-06-2026' } })
    fireEvent.blur(from)
    const to = screen.getByTestId('doing-to')
    fireEvent.change(to, { target: { value: '01-06-2026' } })
    fireEvent.blur(to)
    fireEvent.click(screen.getByTestId('doing-show'))
    expect((await screen.findByTestId('field-error-to')).textContent).toContain('The end date is before the start date')
    expect(calls('simple:reports:doing').at(-1)).toMatchObject({ period: 'custom', from: '2026-06-10', to: '2026-06-01' })
  })

  it('nothing recorded: one plain card instead of ₹0 lines', async () => {
    doingReply = () => ({ ok: true, data: { ...DOING, empty: true } })
    renderUi(<ReportsScreen />)
    expect((await screen.findByTestId('doing-empty')).textContent).toContain('Nothing recorded yet')
    expect(screen.queryByTestId('doing-line-sales')).toBeNull()
  })
})

describe('Cash, who owes whom, by month (WP 9.9)', () => {
  it('cash in the next 30 days: four figures, the sentence, where it comes from', async () => {
    renderUi(<ReportsScreen report="cash" />)
    expect((await screen.findByTestId('tile-cash-end')).getAttribute('data-paise')).toBe(String(55_000_00))
    expect(screen.getByTestId('cash-sentence').textContent).toContain('You have ₹50,000.00 today. About ₹8,000.00 should come in and ₹3,000.00 go out by 11 Nov')
    expect(screen.getByTestId('cash-incoming-customers').textContent).toContain('From customers')
    expect(screen.getByTestId('cash-incoming').textContent).toContain('Asha Stores · 20 Oct')
    expect(bannedWordsIn(visibleText())).toEqual([])
    fireEvent.click(screen.getByTestId('cash-accountant-view'))
    await waitFor(() => expect(lastScreen()).toEqual({ name: 'cash-forecast' }))
  })

  it('who owes me: total, sentence, rows; a row opens the person; switch to whom I owe; People link', async () => {
    renderUi(<ReportsScreen report="owed" side="receivable" />)
    expect((await screen.findByTestId('owed-sentence')).textContent).toBe('₹8,000.00 is what 2 customers owe you today; ₹5,000.00 of it is past its due date.')
    const row = await screen.findByText('Asha Stores')
    fireEvent.doubleClick(row)
    fireEvent.keyDown(row, { key: 'Enter' })
    await waitFor(() => expect(lastScreen()).toEqual({ name: 'simple-person', id: 7 }))
    fireEvent.click(screen.getByTestId('owed-side-payable'))
    await waitFor(() => expect(calls('simple:reports:owed').at(-1)).toMatchObject({ side: 'payable' }))
    expect(await screen.findByText('Supplier')).toBeTruthy()
    fireEvent.click(screen.getByTestId('owed-people'))
    await waitFor(() => expect(lastScreen()).toEqual({ name: 'simple-people', filter: 'youOwe' }))
    expect(bannedWordsIn(visibleText())).toEqual([])
  })

  it('by month: 12 bars from the registers, the sentence, the register as Accountant view', async () => {
    renderUi(<ReportsScreen report="by-month" />)
    expect((await screen.findByTestId('by-month-bars')).querySelectorAll('li')).toHaveLength(12)
    expect(screen.getByTestId('by-month-bar-2026-09').getAttribute('data-sales')).toBe(String(70_000_00))
    expect(screen.getByTestId('by-month-sentence').textContent).toBe('Sales over the 12 months: ₹70,000.00; purchases: ₹40,000.00. The best month for sales was Sep 2026 (₹70,000.00).')
    expect(bannedWordsIn(visibleText())).toEqual([])
    fireEvent.click(screen.getByTestId('by-month-accountant-view'))
    await waitFor(() => expect(lastScreen()).toEqual({ name: 'registers', tab: 'sales' }))
  })
})
