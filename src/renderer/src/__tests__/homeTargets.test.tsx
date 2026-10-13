// WP 8.6: the accountant screens the simple Home's "Why?" links open show THAT figure — the
// Trial balance limited to the cash / bank accounts as on the given date, the Day book on one
// day, Outstandings on the asked side, GSTR-3B on the asked month. Without the params each screen
// is unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { DayBookRow, OutstandingParty, TrialBalance } from '@shared/reports'
import { TrialBalanceScreen } from '../screens/TrialBalance'
import { DayBook } from '../screens/DayBook'
import { OutstandingsScreen } from '../screens/Outstandings'
import { Gstr3bScreen } from '../screens/GstReturns'
import { useNav, useSession } from '../state/stores'

vi.setConfig({ testTimeout: 30_000 })
const SLOW = { timeout: 10_000 }
const invoke = vi.fn()

const tbRow = (ledgerId: number, ledgerName: string, debit: number, credit = 0): TrialBalance['rows'][number] => ({
  ledgerId, ledgerName, groupName: 'X', debit, credit, opening: 0, movementDebit: 0, movementCredit: 0
})
const TB: TrialBalance = {
  rows: [tbRow(5, 'Cash', 150000), tbRow(6, 'HDFC Bank', 250000), tbRow(31, 'Zeta Traders', 0, 400000)],
  totalDebit: 400000, totalCredit: 400000, openingDebitTotal: 0, openingCreditTotal: 0, movementDebitTotal: 0, movementCreditTotal: 0
}
const dbRow = (voucherId: number, date: string): DayBookRow => ({
  voucherId, date, voucherType: 'Receipt', kind: 'receipt', number: String(voucherId), account: 'Cash', accountLedgerId: 5, narration: null, debit: 1000, credit: 0, isOptional: false, postDated: false
})
const DAYBOOK = [dbRow(1, '2026-10-12'), dbRow(2, '2026-10-13'), dbRow(3, '2026-10-13')]
const party = (ledgerId: number, name: string): OutstandingParty => ({ ledgerId, name, pending: 1000, buckets: [1000, 0, 0, 0], bills: [] })

function renderScreen(ui: React.JSX.Element): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}
const rowsOf = (area: string): HTMLElement[] => Array.from(screen.getByTestId(`rows-${area}`).querySelectorAll<HTMLElement>('tr.dt-row'))

beforeEach(() => {
  localStorage.clear()
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string, payload: { side?: string }) => {
    switch (channel) {
      case 'report:trialBalance': return { ok: true, data: TB }
      case 'report:dayBook': return { ok: true, data: DAYBOOK }
      case 'analysis:outstandings': return { ok: true, data: payload?.side === 'payable' ? [party(41, 'Sharma Traders')] : [party(31, 'Zeta Traders')] }
      case 'gst:gstr3b': return { ok: false, error: 'not needed here' }
      case 'master:ledgers:list': return { ok: true, data: [] }
      case 'master:groups:list': return { ok: true, data: [] }
      default: return { ok: false, error: `unmocked channel ${channel}` }
    }
  })
  window.total = { platform: 'test', invoke } as unknown as typeof window.total
  act(() => {
    useSession.setState({ slug: 'alpha-co', from: '2026-04-01', to: '2027-03-31', user: null })
    useNav.setState({ stack: [{ name: 'gateway' }] })
  })
})
afterEach(() => cleanup())

describe('Home link targets (WP 8.6)', () => {
  it('Trial balance: as on the given date, only the given accounts', async () => {
    renderScreen(<TrialBalanceScreen asOn="2026-10-13" ledgerIds={[5, 6]} />)
    await waitFor(() => expect(rowsOf('trial-balance')).toHaveLength(2), SLOW)
    expect(invoke).toHaveBeenCalledWith('report:trialBalance', { asOn: '2026-10-13' })
    expect(screen.getByText('Trial balance · cash and bank')).toBeTruthy()
    cleanup()
    renderScreen(<TrialBalanceScreen />)
    await waitFor(() => expect(rowsOf('trial-balance')).toHaveLength(3), SLOW)
    expect(invoke).toHaveBeenCalledWith('report:trialBalance', { asOn: '2027-03-31' })
  })

  it('Day book: one day', async () => {
    renderScreen(<DayBook date="2026-10-13" />)
    await waitFor(() => expect(rowsOf('daybook')).toHaveLength(2), SLOW)
    expect(screen.getByTestId('daybook-date-chip').textContent).toBe('13-Oct-26')
    cleanup()
    renderScreen(<DayBook />)
    await waitFor(() => expect(rowsOf('daybook')).toHaveLength(3), SLOW)
  })

  it('Outstandings: opens on the asked side', async () => {
    renderScreen(<OutstandingsScreen initialSide="payable" />)
    await waitFor(() => expect(screen.getByText('Sharma Traders')).toBeTruthy(), SLOW)
    expect(invoke.mock.calls.some(([ch, p]) => ch === 'analysis:outstandings' && (p as { side: string }).side === 'payable')).toBe(true)
    cleanup()
    renderScreen(<OutstandingsScreen />)
    await waitFor(() => expect(screen.getByText('Zeta Traders')).toBeTruthy(), SLOW)
  })

  it('GSTR-3B: opens on the asked month', async () => {
    renderScreen(<Gstr3bScreen initialMonth="2026-07" />)
    await waitFor(() => expect(invoke.mock.calls.some(([ch, p]) => ch === 'gst:gstr3b' && (p as { from: string }).from === '2026-07-01')).toBe(true), SLOW)
  })
})
