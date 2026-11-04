// WP 4.4 — cash and finance screens against a mocked IPC bridge: the forecast (periods, scenario
// switch, shortfall highlighting), Forex (exposures, the revaluation post), the year-end warning,
// plus the registry entries.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ForecastBase, FxRevaluationPreview, CashFinanceCloseWarnings as CloseWarningsData } from '@shared/cashFinance'
import { DEFAULT_BUCKET_BP, buildForecast, SCENARIO_PRESETS } from '@shared/cashForecast'
import { CashForecastScreen, periodViews } from '../screens/CashForecast'
import { ForexScreen } from '../screens/Forex'
import { CashFinanceCloseWarnings } from '../screens/cashFinance/CloseWarnings'
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

const FX: FxRevaluationPreview = {
  asOf: TODAY,
  rows: [{
    ledgerId: 30, ledgerName: 'Globex Inc', kind: 'receivable', currencyCode: 'USD', fcBalance: 1000_00, inrBook: 82_000_00, carryingRateMicro: 82_000_000,
    closingRateMicro: 83_250_000, closingRateDate: TODAY, target: 83_250_00, gainLoss: 1_250_00, rupeeLines: 0
  }],
  missingRates: [], gain: 1_250_00, loss: 0, blocked: null
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
      case 'fx:ledgerCurrencies': return { ok: true, data: [] }
      case 'fx:setForeignOpening': return { ok: true, data: { ledgerId: 40, currencyCode: 'USD', fc: 1000_00, openingInr: 82_000_00, rateMicro: 82_000_000, rateDate: null, booksBegin: '2025-04-01' } }
      case 'fx:preview': return { ok: true, data: FX }
      case 'fx:rates': return { ok: true, data: [{ id: 1, date: TODAY, currencyCode: 'USD', rateMicro: 83_250_000, note: null }] }
      case 'fx:revaluations': return { ok: true, data: [] }
      case 'fx:revalue': return { ok: true, data: { id: 1, asOf: TODAY, voucherId: 600, voucherNumber: '7', reversalVoucherId: 601, reversalVoucherNumber: '8', autoReverse: true, gain: 1_250_00, loss: 0, createdAt: '', live: true } }
      case 'currency:list': return { ok: true, data: [{ id: 1, code: 'USD', symbol: '$', name: 'US Dollar', decimals: 2 }] }
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
  it('lists the forecast and forex under Analysis', () => {
    for (const name of ['cash-forecast', 'forex'] as const) {
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

describe('forex', () => {
  it('sets a foreign opening from the foreign amount and the books-begin rate', async () => {
    renderUi(<ForexScreen />)
    await screen.findByTestId('btn-forex-revalue')
    fireEvent.click(document.querySelector('button[aria-haspopup="dialog"][data-testid$="-options"]')!)
    fireEvent.click(await screen.findByTestId('btn-forex-designate'))
    const picker = await screen.findByTestId('picker-forex-designate')
    fireEvent.focus(picker)
    fireEvent.change(picker, { target: { value: 'HDFC Cur' } })
    await waitFor(() => expect(screen.getAllByRole('option').some((o) => o.textContent?.includes('HDFC Current'))).toBe(true))
    fireEvent.keyDown(picker, { key: 'Enter' })
    await waitFor(() => expect((picker as HTMLInputElement).value).toBe('HDFC Current'))
    fireEvent.change(screen.getByTestId('input-forex-opening-fc'), { target: { value: '1000.00' } })
    fireEvent.change(screen.getByTestId('input-forex-opening-rate'), { target: { value: '82' } })
    fireEvent.click(screen.getByTestId('btn-forex-opening-set'))
    await waitFor(() => expect(calls.find((c) => c.channel === 'fx:setForeignOpening')?.payload).toEqual({ ledgerId: 2, currencyCode: 'USD', fc: 1000_00, rateMicro: 82_000_000 }))
  }, 20_000)

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

describe('year-end addition', () => {
  it('warns about unrevalued balances', async () => {
    const w: CloseWarningsData = {
      unrevalued: [{ currencyCode: 'USD', ledgers: 1, fcBalance: 1000_00 }],
      revaluedOnFyEnd: false
    }
    invoke.mockImplementation(async (channel: string) => (channel === 'yearEnd:cashFinanceWarnings' ? { ok: true, data: w } : { ok: false, error: channel }))
    renderUi(<CashFinanceCloseWarnings fyStartYear={2025} closed={false} />)
    expect((await screen.findByTestId('year-end-unrevalued')).textContent).toContain('1,000.00 USD')
  })
})

