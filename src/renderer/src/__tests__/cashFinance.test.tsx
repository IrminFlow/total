// WP 4.4 — cash and finance screens against a mocked IPC bridge: the forecast (periods, scenario
// switch, shortfall highlighting), Loans (schedule, Post EMI payload), Forex (exposures, the
// revaluation post), Budgets (editor → lines, favourable colouring, drill), the year-end
// warnings and the Gateway reminder rows, plus the registry entries.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ForecastBase, FxRevaluationPreview, LoanDetail, LoanSummary, BudgetMonthlyReport, CashFinanceCloseWarnings as CloseWarningsData, FinanceReminders } from '@shared/cashFinance'
import { DEFAULT_BUCKET_BP, buildForecast, SCENARIO_PRESETS } from '@shared/cashForecast'
import { figure } from '@shared/budgetPhasing'
import { CashForecastScreen, periodViews } from '../screens/CashForecast'
import { LoansScreen } from '../screens/Loans'
import { ForexScreen } from '../screens/Forex'
import { BudgetsScreen, linesFromRows, type EditRow } from '../screens/Budgets'
import { CashFinanceCloseWarnings } from '../screens/cashFinance/CloseWarnings'
import { FinanceReminderRows } from '../screens/gateway/FinanceReminders'
import { SCREENS } from '../lib/screens'
import { useSession } from '../state/stores'
import { todayISO } from '@shared/dates'

const invoke = vi.fn()
const calls: { channel: string; payload: unknown }[] = []
const TODAY = todayISO()
const addDays = (d: string, n: number): string => {
  const x = new Date(d + 'T00:00:00Z')
  x.setUTCDate(x.getUTCDate() + n)
  return x.toISOString().slice(0, 10)
}

const BASE: ForecastBase = {
  asOn: TODAY,
  openingCash: 1_00_000_00,
  cashLedgers: [{ ledgerId: 1, name: 'Cash', kind: 'cash', balance: 1_00_000_00 }],
  flows: [
    { source: 'receivable', direction: 'in', date: addDays(TODAY, 3), amount: 50_000_00, probabilityBp: 8_000, label: 'Acme · S1', ledgerId: 5, voucherId: 70, bucket: 0 },
    { source: 'payable', direction: 'out', date: addDays(TODAY, 10), amount: 1_60_000_00, probabilityBp: 10_000, label: 'Steel · P1', ledgerId: 6, voucherId: 71 },
    { source: 'emi', direction: 'out', date: addDays(TODAY, 20), amount: 8_884_88, probabilityBp: 10_000, label: 'Term loan · EMI', loanId: 1 }
  ],
  receivableProfile: { sampleSize: 0, paidWithinBp: [0, 0, 0, 0], bucketProbabilityBp: DEFAULT_BUCKET_BP, medianDelayDays: 0, fromHistory: false },
  warnings: []
}

const LOAN: LoanSummary = {
  id: 1, name: 'HDFC term loan', loanLedgerId: 20, loanLedgerName: 'HDFC Term Loan', bankLedgerId: 2, bankLedgerName: 'HDFC Current',
  interestLedgerId: null, interestLedgerName: null, principal: 1_00_000_00, annualRateMilli: 12_000, tenureMonths: 12, disbursedOn: '2026-04-01',
  firstDueDate: '2026-05-05', method: 'reducing', moratoriumMonths: 0, moratoriumMode: 'capitalise', emiOverride: null, status: 'active', notes: null,
  emi: 8_884_88, outstanding: 1_00_000_00, ledgerBalance: 1_00_000_00, postedCount: 0, pendingCount: 12,
  nextDue: { scheduleId: 101, dueDate: '2026-05-05', payment: 8_884_88 }, overdueCount: 1, interestThisFy: 6_618_55, totalInterest: 6_618_55
}
const DETAIL: LoanDetail = {
  loan: LOAN,
  schedule: [
    { id: 101, loanId: 1, seq: 1, dueDate: '2026-05-05', kind: 'emi', opening: 1_00_000_00, payment: 8_884_88, interest: 1_000_00, principal: 7_884_88, closing: 92_115_12, voucherId: null, voucherNumber: null, posted: false },
    { id: 102, loanId: 1, seq: 2, dueDate: '2026-06-05', kind: 'emi', opening: 92_115_12, payment: 8_884_88, interest: 921_15, principal: 7_963_73, closing: 84_151_39, voucherId: null, voucherNumber: null, posted: false }
  ],
  prepayments: []
}

const FX: FxRevaluationPreview = {
  asOf: TODAY,
  rows: [{
    ledgerId: 30, ledgerName: 'Globex Inc', kind: 'receivable', currencyCode: 'USD', fcBalance: 1000_00, inrBook: 82_000_00, carryingRateMicro: 82_000_000,
    closingRateMicro: 83_250_000, closingRateDate: TODAY, target: 83_250_00, gainLoss: 1_250_00, inferredLines: 0
  }],
  missingRates: [], gain: 1_250_00, loss: 0, blocked: null
}

const BUDGET = {
  id: 3, name: 'Opex', fyStartYear: 2026, seasonal: null,
  lines: [{ id: 9, ledgerId: 40, groupId: null, month: null, amount: 1_20_000_00, costCentreId: 4, phasing: 'even' as const, monthly: null }]
}
const months = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03']
const REPORT: BudgetMonthlyReport = {
  budgetId: 3, fyStartYear: 2026, months, upToMonth: '2026-05',
  rows: [{
    lineId: 9, targetName: 'Rent', ledgerId: 40, groupId: null, costCentreId: 4, costCentreName: 'Mumbai', nature: 'expense', month: null, phasing: 'even',
    annualBudget: 1_20_000_00,
    months: months.map((m) => figure(10_000_00, m === '2026-05' ? 12_000_00 : m === '2026-04' ? 9_000_00 : 0, 'expense')),
    current: figure(10_000_00, 12_000_00, 'expense'),
    ytd: figure(20_000_00, 21_000_00, 'expense')
  }]
}

beforeEach(() => {
  calls.length = 0
  localStorage.clear()
  useSession.setState({
    slug: 'test', from: '2026-04-01', to: '2027-03-31', workingDate: TODAY,
    info: { name: 'T', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '', booksFrom: 2025, email: null, phone: null, pan: null, tan: null }
  })
  invoke.mockImplementation(async (channel: string, payload: unknown) => {
    calls.push({ channel, payload })
    switch (channel) {
      case 'forecast:base': return { ok: true, data: BASE }
      case 'forecast:items': return { ok: true, data: [] }
      case 'loan:list': return { ok: true, data: [LOAN] }
      case 'loan:get': return { ok: true, data: DETAIL }
      case 'loan:postEmi': return { ok: true, data: { ...DETAIL.schedule[0], posted: true, voucherId: 500, voucherNumber: '12' } }
      case 'fx:preview': return { ok: true, data: FX }
      case 'fx:rates': return { ok: true, data: [{ id: 1, date: TODAY, currencyCode: 'USD', rateMicro: 83_250_000, note: null }] }
      case 'fx:revaluations': return { ok: true, data: [] }
      case 'fx:revalue': return { ok: true, data: { id: 1, asOf: TODAY, voucherId: 600, voucherNumber: '7', reversalVoucherId: 601, reversalVoucherNumber: '8', autoReverse: true, gain: 1_250_00, loss: 0, createdAt: '', live: true } }
      case 'currency:list': return { ok: true, data: [{ id: 1, code: 'USD', symbol: '$', name: 'US Dollar', decimals: 2 }] }
      case 'budget:list': return { ok: true, data: [BUDGET] }
      case 'budget:monthly': return { ok: true, data: REPORT }
      case 'budget:drill': return { ok: true, data: [{ voucherId: 80, date: '2026-05-06', number: '4', voucherType: 'Payment', ledgerId: 40, ledgerName: 'Rent', amount: 12_000_00 }] }
      case 'cc:list': return { ok: true, data: [{ id: 4, name: 'Mumbai', parentId: null, active: true }] }
      case 'master:ledgers:list': return { ok: true, data: [{ id: 40, name: 'Rent', groupId: 8 }, { id: 2, name: 'HDFC Current', groupId: 9 }, { id: 20, name: 'HDFC Term Loan', groupId: 10 }] }
      case 'master:groups:list': return { ok: true, data: [{ id: 8, name: 'Indirect Expenses', parentId: null, nature: 'expense' }, { id: 9, name: 'Bank Accounts', parentId: null, nature: 'asset' }, { id: 10, name: 'Secured Loans', parentId: null, nature: 'liability' }] }
      default: return { ok: false, error: `unmocked ${channel}` }
    }
  })
  window.total = { platform: 'test', invoke }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderUi(ui: React.ReactNode): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('registry', () => {
  it('lists the forecast, loans and forex under Analysis', () => {
    for (const name of ['cash-forecast', 'loans', 'forex'] as const) {
      expect(SCREENS.find((s) => s.name === name)).toMatchObject({ navSection: 'analysis' })
    }
  })
})

describe('cash-flow forecast', () => {
  it('splits known items by direction for the table', () => {
    const r = buildForecast({
      asOn: TODAY, unit: 'week', count: 1, openingCash: 0, scenario: SCENARIO_PRESETS.expected,
      flows: [
        { source: 'item', direction: 'out', date: TODAY, amount: 5_00, probabilityBp: 10_000, label: 'Rent' },
        { source: 'adjustment', direction: 'in', date: TODAY, amount: 2_00, probabilityBp: 10_000, label: 'Refund' }
      ]
    })
    expect(periodViews(r.periods, r.contributions)[0]).toMatchObject({ otherIn: 2_00, otherOut: 5_00 })
  })

  it('shows 13 weekly periods, flags the shortfall, and re-weights on the worst case', async () => {
    renderUi(<CashForecastScreen />)
    const tbody = await screen.findByTestId('rows-cash-forecast')
    await waitFor(() => expect(within(tbody).getAllByRole('row').length).toBe(13))
    // 1,00,000 + 40,000 (80 % of 50,000) − 1,60,000 → shortfall in week 2
    const short = tbody.querySelector('[data-shortfall="true"]')!
    expect(short.getAttribute('data-period')).toBe('w2')
    expect(await screen.findByTestId('forecast-shortfall')).toBeTruthy()
    expect(document.getElementById('tile-forecast-in-value')!.textContent).toContain('40,000.00')
    fireEvent.click(screen.getByTestId('seg-forecast-scenario-worst'))
    await waitFor(() => expect(screen.getByTestId('forecast-scenario-summary').textContent).toContain('70%'))
    // worst: 70 % of the 80 % bucket probability = 56 % of 50,000
    expect(document.getElementById('tile-forecast-in-value')!.textContent).toContain('28,000.00')
  }, 20_000)
})

describe('loans', () => {
  it('lists the loan, shows its schedule and posts the next EMI', async () => {
    renderUi(<LoansScreen />)
    expect(await screen.findByText('HDFC term loan', { selector: 'td *, td' })).toBeTruthy()
    const sched = await screen.findByTestId('rows-loan-schedule')
    await waitFor(() => expect(within(sched).getAllByRole('row').length).toBe(2))
    expect(sched.textContent).toContain('7,884.88')
    fireEvent.click(screen.getByTestId('btn-loan-post-next'))
    const modal = await screen.findByTestId('loan-post-modal')
    expect(modal.textContent).toContain('1,000.00')
    fireEvent.click(screen.getByTestId('btn-loan-post-confirm'))
    await waitFor(() => expect(calls.find((c) => c.channel === 'loan:postEmi')?.payload).toEqual({ scheduleId: 101, date: '2026-05-05', bankLedgerId: 2 }))
  }, 20_000)
})

describe('forex', () => {
  it('lists the USD exposure with its unrealised gain and posts the revaluation with auto-reversal', async () => {
    renderUi(<ForexScreen />)
    const rows = await screen.findByTestId('rows-forex-exposures')
    await waitFor(() => expect(rows.textContent).toContain('1,000.00 USD'))
    expect(rows.textContent).toContain('+1,250.00')
    fireEvent.click(screen.getByTestId('btn-forex-revalue'))
    const modal = await screen.findByTestId('forex-revalue-modal')
    expect(modal.textContent).toContain('Unrealised Forex Gain')
    fireEvent.click(screen.getByTestId('btn-forex-revalue-post'))
    await waitFor(() => expect(calls.find((c) => c.channel === 'fx:revalue')?.payload).toEqual({ asOf: TODAY, autoReverse: true }))
  }, 20_000)
})

describe('budgets', () => {
  it('turns editor rows into lines: manual months sum, a single month, a cost centre', () => {
    const base: Omit<EditRow, 'key'> = { targetType: 'ledger', ledgerId: 40, groupId: null, costCentreId: 4, spread: 'manual', month: null, amount: null, monthly: [1_00, 2_00, ...Array(10).fill(null)] }
    const { lines, errors } = linesFromRows([
      { key: 1, ...base },
      { key: 2, ...base, spread: 'month', month: '2026-06', amount: 5_00, costCentreId: null },
      { key: 3, ...base, ledgerId: null, spread: 'even', amount: null }
    ], months)
    expect(lines[0]).toMatchObject({ amount: 3_00, phasing: 'manual', costCentreId: 4, monthly: [1_00, 2_00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] })
    expect(lines[1]).toMatchObject({ month: '2026-06', phasing: 'annual', amount: 5_00 })
    expect(errors).toEqual([])
    expect(linesFromRows([{ key: 4, ...base, spread: 'even', amount: 0 }], months).errors[0]).toMatch(/amount/)
  })

  it('shows month and YTD variance with unfavourable colouring and drills to the vouchers', async () => {
    renderUi(<BudgetsScreen />)
    const rows = await screen.findByTestId('rows-budget-variance')
    await waitFor(() => expect(rows.querySelector('[data-line-id="9"]')).toBeTruthy())
    const tr = rows.querySelector('[data-line-id="9"]')!
    expect(tr.getAttribute('data-ytd-favourable')).toBe('false')
    expect(tr.textContent).toContain('Mumbai')
    expect(tr.querySelector('[data-favourable="false"]')!.className).toContain('text-cr')
    fireEvent.click(within(tr as HTMLElement).getByText('Mumbai'))
    const drill = await screen.findByTestId('rows-budget-drill')
    await waitFor(() => expect(drill.textContent).toContain('12,000.00'))
  }, 20_000)
})

describe('year-end and dashboard additions', () => {
  it('warns about unposted EMIs, unrevalued balances and over-budget lines', async () => {
    const w: CloseWarningsData = {
      unpostedEmis: [{ loanId: 1, loanName: 'HDFC term loan', count: 2, amount: 17_769_76 }],
      unrevalued: [{ currencyCode: 'USD', ledgers: 1, fcBalance: 1000_00 }],
      revaluedOnFyEnd: false,
      overBudget: [{ budgetId: 3, budgetName: 'Opex', lineId: 9, targetName: 'Rent', costCentreName: 'Mumbai', budget: 10_00, actual: 12_00 }]
    }
    invoke.mockImplementation(async (channel: string) => (channel === 'yearEnd:cashFinanceWarnings' ? { ok: true, data: w } : { ok: false, error: channel }))
    renderUi(<CashFinanceCloseWarnings fyStartYear={2025} closed={false} />)
    expect((await screen.findByTestId('year-end-unposted-emis')).textContent).toContain('2 instalments')
    expect(screen.getByTestId('year-end-unrevalued').textContent).toContain('1,000.00 USD')
    expect(screen.getByTestId('year-end-over-budget').textContent).toContain('Mumbai · Rent')
  })

  it('the compliance card shows EMIs due and the over-budget chip', async () => {
    const r: FinanceReminders = {
      emis: [{ loanId: 1, loanName: 'HDFC term loan', scheduleId: 101, dueDate: addDays(TODAY, -2), payment: 8_884_88, overdue: true }],
      overBudget: { month: TODAY.slice(0, 7), rows: [{ budgetId: 3, budgetName: 'Opex', lineId: 9, targetName: 'Rent', costCentreName: null, budget: 10_00, actual: 12_00 }] }
    }
    invoke.mockImplementation(async (channel: string) => (channel === 'dashboard:financeReminders' ? { ok: true, data: r } : { ok: false, error: channel }))
    renderUi(<FinanceReminderRows />)
    expect((await screen.findByTestId('chip-emi')).textContent).toBe('2 days overdue')
    expect(screen.getByTestId('chip-over-budget').textContent).toContain('Over budget this month · 1')
  })
})
