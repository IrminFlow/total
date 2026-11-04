// WP 4.4 — cash and finance screens against a mocked IPC bridge: the forecast (periods, scenario
// switch, shortfall highlighting), the registry entries, and the one forex action left after the
// 1.0 cleanup: reversing a revaluation posted without its reversal, from the journal's view.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ForecastBase } from '@shared/cashFinance'
import { DEFAULT_BUCKET_BP, buildForecast, SCENARIO_PRESETS } from '@shared/cashForecast'
import { CashForecastScreen, periodViews } from '../screens/CashForecast'
import { RevaluationReverseBanner, defaultReversalDate } from '../screens/voucher/RevaluationReverseBanner'
import { SavedCurrencyPicker } from '../screens/voucher/SavedCurrencyPicker'
import { DialogHost } from '../components/dialogs'
import { ForeignOpeningNote } from '../components/ForeignOpeningNote'
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
  it('lists the forecast under Analysis; the forex screen is gone (1.0 cleanup)', () => {
    expect(SCREENS.some((s) => (s.name as string) === 'forex')).toBe(false)
    for (const name of ['cash-forecast'] as const) {
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

describe('a revaluation posted without its reversal (the one forex write left)', () => {
  it('its journal offers Reverse…, which reverses it the next day; a reversed one or any other voucher offers nothing', async () => {
    let reversed = false
    invoke.mockImplementation(async (channel: string, payload: unknown) => {
      calls.push({ channel, payload })
      if (channel === 'fx:revaluationOf') return { ok: true, data: (payload as { voucherId: number }).voucherId === 600 ? { id: 7, asOf: '2026-03-31', reversed } : null }
      if (channel === 'fx:reverse') {
        reversed = true
        return { ok: true, data: { id: 7, asOf: '2026-03-31', voucherId: 600, reversalVoucherId: 601, live: true } }
      }
      return { ok: false, error: `unmocked ${channel}` }
    })
    renderUi(<><RevaluationReverseBanner voucherId={600} /><DialogHost /></>)
    const banner = await screen.findByTestId('fx-revaluation-banner')
    expect(banner.textContent).toContain('31-Mar-26')
    fireEvent.click(screen.getByTestId('btn-fx-reverse'))
    fireEvent.click(await screen.findByTestId('confirm-ok'))
    await waitFor(() => expect(calls.find((c) => c.channel === 'fx:reverse')?.payload).toEqual({ id: 7, date: '2026-04-01' }))
    await waitFor(() => expect(screen.queryByTestId('fx-revaluation-banner')).toBeNull())
    cleanup()
    renderUi(<RevaluationReverseBanner voucherId={601} />)
    await waitFor(() => expect(calls.some((c) => c.channel === 'fx:revaluationOf' && (c.payload as { voucherId: number }).voucherId === 601)).toBe(true))
    expect(screen.queryByTestId('fx-revaluation-banner')).toBeNull()
    cleanup()
    // a viewer is not offered it (main would refuse the reversal), even on an un-reversed journal
    reversed = false
    for (const user of [{ id: 2, name: 'Vee', role: 'viewer' }, { id: 3, name: 'Acc', role: 'accountant', capabilities: { canPost: false } }]) {
      calls.length = 0
      useSession.setState({ user: user as never })
      renderUi(<RevaluationReverseBanner voucherId={600} />)
      await waitFor(() => expect(calls.some((c) => c.channel === 'fx:revaluationOf')).toBe(true))
      await new Promise((r) => setTimeout(r, 20))
      expect(screen.queryByTestId('fx-revaluation-banner'), user.role).toBeNull()
      cleanup()
    }
    // the same un-reversed journal for an accountant who may post: offered
    useSession.setState({ user: { id: 4, name: 'Ok', role: 'accountant' } as never })
    renderUi(<RevaluationReverseBanner voucherId={600} />)
    expect(await screen.findByTestId('fx-revaluation-banner')).toBeTruthy()
    useSession.setState({ user: null })
  })
})

describe('a foreign opening entered on the old Forex screen', () => {
  it('the ledger form says it stays as it was once the rupee opening changes; nothing for other ledgers', async () => {
    invoke.mockImplementation(async (channel: string, payload: unknown) =>
      channel === 'fx:foreignOpening' ? { ok: true, data: (payload as { ledgerId: number }).ledgerId === 40 ? { currencyCode: 'USD', openingFc: 1000_00 } : null } : { ok: false, error: channel })
    renderUi(<ForeignOpeningNote ledgerId={40} openingBalance={82_000_00} newOpening={82_000_00} />)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('fx:foreignOpening', { ledgerId: 40 }))
    expect(screen.queryByTestId('ledger-foreign-opening-note')).toBeNull()
    cleanup()
    renderUi(<ForeignOpeningNote ledgerId={40} openingBalance={82_000_00} newOpening={83_000_00} />)
    const note = await screen.findByTestId('ledger-foreign-opening-note')
    expect(note.textContent).toContain('1,000.00 USD')
    expect(note.dataset.cleared).toBe('false')
    cleanup()
    // flipped to Cr, or zero: the note says it will be cleared on save (as masters.updateLedger does)
    for (const newOpening of [-5_000_00, 0]) {
      renderUi(<ForeignOpeningNote ledgerId={40} openingBalance={82_000_00} newOpening={newOpening} />)
      const n = await screen.findByTestId('ledger-foreign-opening-note')
      expect(n.dataset.cleared).toBe('true')
      expect(n.textContent).toContain('will be cleared')
      cleanup()
    }
    cleanup()
    renderUi(<ForeignOpeningNote ledgerId={41} openingBalance={0} newOpening={5_00} />)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('fx:foreignOpening', { ledgerId: 41 }))
    expect(screen.queryByTestId('ledger-foreign-opening-note')).toBeNull()
  })
})

describe('the reversal date (CodeRabbit on #195)', () => {
  it('defaults to the day after, or the first day after the lock when that day is locked', () => {
    expect(defaultReversalDate('2026-03-31', null)).toBe('2026-04-01')
    expect(defaultReversalDate('2026-03-31', '2026-03-31')).toBe('2026-04-01')
    expect(defaultReversalDate('2026-03-31', '2026-04-01')).toBe('2026-04-02')
    expect(defaultReversalDate('2026-03-31', '2026-04-30')).toBe('2026-05-01')
  })

  it('with the books locked past the day after, the banner posts on the first unlocked day; a typed date is sent as typed', async () => {
    invoke.mockImplementation(async (channel: string, payload: unknown) => {
      calls.push({ channel, payload })
      if (channel === 'fx:revaluationOf') return { ok: true, data: { id: 7, asOf: '2026-03-31', reversed: false } }
      if (channel === 'company:lock:get') return { ok: true, data: { date: '2026-04-15' } }
      if (channel === 'fx:reverse') return { ok: true, data: { id: 7 } }
      return { ok: false, error: `unmocked ${channel}` }
    })
    renderUi(<><RevaluationReverseBanner voucherId={600} /><DialogHost /></>)
    const input = await screen.findByTestId('input-fx-reverse-date')
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('16-Apr-26'))
    fireEvent.click(screen.getByTestId('btn-fx-reverse'))
    fireEvent.click(await screen.findByTestId('confirm-ok'))
    await waitFor(() => expect(calls.find((c) => c.channel === 'fx:reverse')?.payload).toEqual({ id: 7, date: '2026-04-16' }))
    calls.length = 0
    fireEvent.change(input, { target: { value: '20/04/2026' } })
    fireEvent.blur(input)
    fireEvent.click(screen.getByTestId('btn-fx-reverse'))
    fireEvent.click(await screen.findByTestId('confirm-ok'))
    await waitFor(() => expect(calls.find((c) => c.channel === 'fx:reverse')?.payload).toEqual({ id: 7, date: '2026-04-20' }))
  })
})

describe('a saved foreign-currency invoice (CodeRabbit on #195)', () => {
  it('shows its currency and rate even with no currency master left, so it round-trips', () => {
    const setCode = vi.fn()
    renderUi(
      <SavedCurrencyPicker currencies={[]} savedCode="USD" currencyCode="USD" setCurrencyCode={setCode} fxRateText="83.25" setFxRateText={() => {}} fxActive />
    )
    const select = screen.getByTestId('select-invoice-currency') as HTMLSelectElement
    expect(select.value).toBe('USD')
    expect([...select.options].map((o) => o.value)).toEqual(['', 'USD'])
    expect((screen.getByTestId('input-invoice-fx-rate') as HTMLInputElement).value).toBe('83.25')
    cleanup()
    // with other currencies in the master: only the invoice's own currency and ₹ (no switching to
    // another foreign currency — #195 follow-up), the saved one once, with its symbol
    renderUi(
      <SavedCurrencyPicker
        currencies={[{ id: 1, code: 'USD', symbol: '$', name: 'US Dollar', decimals: 2 }, { id: 2, code: 'EUR', symbol: '€', name: 'Euro', decimals: 2 }]}
        savedCode="USD" currencyCode="USD" setCurrencyCode={setCode} fxRateText="83.25" setFxRateText={() => {}} fxActive
      />
    )
    const options = [...(screen.getByTestId('select-invoice-currency') as HTMLSelectElement).options]
    expect(options.map((o) => o.value)).toEqual(['', 'USD'])
    expect(options[1]!.textContent).toBe('$ USD')
  })
})
