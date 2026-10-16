// Cash flow drill-down (e2e 68–71 notes): a line opens the Day book on the vouchers it was
// computed from (same period); ▸ shows the ledgers behind it, whose names open their statements;
// the stock line (the valuation engine's) has no drill. The Day book then lists only those
// vouchers, with a chip that clears the filter.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CashFlowStatement } from '@shared/reportMath'
import { DEFAULT_FEATURES } from '@shared/features'
import { CashFlowScreen } from '../screens/CashFlow'
import { DayBook } from '../screens/DayBook'
import { useNav, useSession } from '../state/stores'

const invoke = vi.fn()
const CF: CashFlowStatement = {
  period: { from: '2025-04-01', to: '2026-03-31' },
  netProfit: 8000,
  operating: [
    { name: 'Current Assets', amount: -7000, parts: [{ ledgerId: 11, name: 'Debtor A', amount: -5000 }, { ledgerId: 12, name: 'Debtor B', amount: -2000 }], voucherIds: [101, 102, 103] },
    { name: 'Increase in stock', amount: -1000 }
  ],
  operatingTotal: 0,
  investing: [{ name: 'Fixed Assets', amount: -10000, parts: [{ ledgerId: 13, name: 'Fixtures', amount: -10000 }], voucherIds: [104] }],
  investingTotal: -10000,
  financing: [],
  financingTotal: 0,
  netChange: -10000,
  openingCash: 20000,
  closingCash: 10000
}
const dayRow = (voucherId: number, number: string) => ({
  voucherId, date: '2025-04-15', voucherType: 'Sales', kind: 'sales', number, narration: null, isOptional: false, postDated: false,
  yearEndClose: false, account: 'Debtor A', accountLedgerId: 11, accountNet: 5000, debit: 5000, credit: 0, amount: 5000
})

function renderUi(ui: React.ReactElement): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  useSession.setState({
    slug: 'test', from: '2025-04-01', to: '2026-03-31', user: null,
    info: { name: 'T', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '', booksFrom: 2025, email: null, phone: null, pan: null, tan: null }
  })
  useNav.setState({ stack: [{ name: 'cash-flow' }] })
  invoke.mockImplementation(async (channel: string) => {
    switch (channel) {
      case 'report:cashFlow': return { ok: true, data: CF }
      case 'report:dayBook': return { ok: true, data: [dayRow(101, 'S-1'), dayRow(102, 'S-2'), dayRow(200, 'S-9')] }
      case 'config:features:get': return { ok: true, data: DEFAULT_FEATURES }
      default: return { ok: true, data: [] }
    }
  })
  window.total = { platform: 'test', invoke }
})
afterEach(() => {
  cleanup()
  invoke.mockReset()
})

const top = (): unknown => useNav.getState().stack[useNav.getState().stack.length - 1]

describe('cash flow drill-down', () => {
  it('a line opens the Day book on its vouchers; ▸ lists its ledgers, a name opens the statement', async () => {
    renderUi(<CashFlowScreen />)
    const lines = await screen.findAllByTestId('cash-flow-line')
    const ca = lines.find((l) => l.dataset.line === 'Current Assets')!
    expect(ca.dataset.vouchers).toBe('3')
    fireEvent.click(ca)
    await waitFor(() => expect(top()).toEqual({ name: 'daybook', voucherIds: [101, 102, 103], source: 'Cash flow: Current Assets' }))

    useNav.setState({ stack: [{ name: 'cash-flow' }] })
    fireEvent.click(ca.querySelector('[data-testid="cash-flow-toggle"]')!)
    await new Promise((r) => setTimeout(r, 20))
    expect(top()).toEqual({ name: 'cash-flow' }) // the toggle doesn't drill
    const parts = screen.getAllByTestId('cash-flow-part')
    expect(parts.map((p) => p.dataset.ledgerId)).toEqual(['11', '12'])
    expect(parts[0]!.textContent).toContain('Debtor A')
    fireEvent.click(screen.getAllByTestId('cash-flow-ledger')[1]!)
    await waitFor(() => expect(top()).toEqual({ name: 'ledger-statement', ledgerId: 12 }))

    // Keyboard: Enter on a focused line drills too.
    useNav.setState({ stack: [{ name: 'cash-flow' }] })
    const fa = lines.find((l) => l.dataset.line === 'Fixed Assets')!
    fireEvent.keyDown(fa, { key: 'Enter' })
    await waitFor(() => expect(top()).toEqual({ name: 'daybook', voucherIds: [104], source: 'Cash flow: Fixed Assets' }))
  })

  it('the stock line has no drill', async () => {
    renderUi(<CashFlowScreen />)
    const stock = (await screen.findAllByTestId('cash-flow-line')).find((l) => l.dataset.line === 'Increase in stock')!
    expect(stock.dataset.vouchers).toBe('0')
    expect(stock.querySelector('[data-testid="cash-flow-toggle"]')).toBeNull()
    fireEvent.click(stock)
    await new Promise((r) => setTimeout(r, 20))
    expect(top()).toEqual({ name: 'cash-flow' })
  })

  it('the Day book lists only the drilled vouchers; the chip clears it', async () => {
    renderUi(<DayBook voucherIds={[101, 102, 103]} source="Cash flow: Current Assets" />)
    const chip = await screen.findByTestId('daybook-only-chip')
    expect(chip.textContent).toContain('Cash flow: Current Assets · 3 vouchers')
    await waitFor(() => expect(document.body.textContent).toContain('S-2'))
    expect(document.body.textContent).not.toContain('S-9')
    fireEvent.click(chip.querySelector('button')!)
    await waitFor(() => expect(document.body.textContent).toContain('S-9'))
  })
})
