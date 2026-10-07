// WP 1.7a screens on the DataTable platform — Day Book, Trial Balance, Ledger Statement and
// Outstandings: columns render, the default order is the old one, a header sort works, row
// activation goes where it did before, and the totals are right (in-books only on the Day Book,
// never a summed running balance on the statement).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { DayBookRow, LedgerStatement, OutstandingParty, TrialBalance } from '@shared/reports'
import { DayBook } from '../screens/DayBook'
import { TrialBalanceScreen } from '../screens/TrialBalance'
import { LedgerStatementScreen } from '../screens/LedgerStatement'
import { OutstandingsScreen } from '../screens/Outstandings'
import { useNav, useSession } from '../state/stores'

const invoke = vi.fn()
const go = vi.fn()
/** The first render of a screen also pays for its module graph — generous under a loaded CI box. */
const SLOW = { timeout: 10_000 }
vi.setConfig({ testTimeout: 30_000 })

const DAYBOOK: DayBookRow[] = [
  { voucherId: 11, date: '2026-04-02', voucherType: 'Sales', kind: 'sales', number: '9', account: 'Zeta Traders', accountLedgerId: 31, narration: null, debit: 118000, credit: 0, isOptional: false, postDated: false },
  { voucherId: 12, date: '2026-04-03', voucherType: 'Payment', kind: 'payment', number: '10', account: 'Alpha Rent', accountLedgerId: 33, narration: 'April rent', debit: 0, credit: 50000, isOptional: false, postDated: false },
  { voucherId: 13, date: '2026-04-05', voucherType: 'Journal', kind: 'journal', number: '2', account: 'Memo Co', accountLedgerId: 34, narration: null, debit: 99900, credit: 0, isOptional: true, postDated: false }
]

const TB: TrialBalance = {
  rows: [
    { ledgerId: 5, ledgerName: 'Cash', groupName: 'Cash-in-hand', debit: 150000, credit: 0, opening: 100000, movementDebit: 80000, movementCredit: 30000 },
    { ledgerId: -1, ledgerName: 'Profit & Loss A/c (opening)', groupName: 'Primary', debit: 0, credit: 20000, opening: -20000, movementDebit: 0, movementCredit: 0 },
    { ledgerId: 7, ledgerName: 'Capital', groupName: 'Capital Account', debit: 0, credit: 130000, opening: -80000, movementDebit: 0, movementCredit: 50000 }
  ],
  totalDebit: 150000,
  totalCredit: 150000,
  openingDebitTotal: 100000,
  openingCreditTotal: 100000,
  movementDebitTotal: 80000,
  movementCreditTotal: 80000
}

const STATEMENT: LedgerStatement = {
  ledgerId: 5,
  ledgerName: 'Cash',
  opening: 100000,
  rows: [
    { voucherId: 21, date: '2026-04-01', voucherType: 'Receipt', number: '1', particulars: 'Zeta Traders', particularsLedgerId: 31, narration: null, debit: 50000, credit: 0, running: 150000 },
    { voucherId: 22, date: '2026-04-04', voucherType: 'Payment', number: '3', particulars: 'Alpha Rent', particularsLedgerId: 33, narration: null, debit: 0, credit: 20000, running: 130000 }
  ],
  closing: 130000,
  totalDebit: 50000,
  totalCredit: 20000
}

const PARTIES: OutstandingParty[] = [
  {
    ledgerId: 31,
    name: 'Zeta Traders',
    pending: 300000,
    buckets: [100000, 0, 0, 200000],
    bills: [
      { voucherId: 41, number: 'INV-1', date: '2026-01-01', amount: 200000, pending: 200000, ageDays: 120, dueDate: null, overdueDays: 120 },
      { voucherId: 42, number: 'INV-7', date: '2026-04-01', amount: 100000, pending: 100000, ageDays: 5, dueDate: '2026-04-30', overdueDays: 0 }
    ]
  },
  { ledgerId: 32, name: 'Alpha Stores', pending: 50000, buckets: [50000, 0, 0, 0], bills: [{ voucherId: 43, number: 'INV-3', date: '2026-04-02', amount: 50000, pending: 50000, ageDays: 4, dueDate: null, overdueDays: 0 }] }
]

function renderScreen(ui: React.JSX.Element): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

const rowsOf = (area: string): HTMLElement[] =>
  Array.from(screen.getByTestId(`rows-${area}`).querySelectorAll<HTMLElement>('tr.dt-row'))
const col = (area: string, i: number): string[] => rowsOf(area).map((tr) => tr.querySelectorAll('td')[i]!.textContent ?? '')

beforeEach(() => {
  localStorage.clear()
  go.mockReset()
  invoke.mockImplementation(async (channel: string, payload?: { groupBy?: string }) => {
    switch (channel) {
      case 'report:dayBook':
        return { ok: true, data: DAYBOOK }
      case 'report:trialBalance':
        return { ok: true, data: TB }
      case 'report:ledger':
        return {
          ok: true,
          data:
            payload?.groupBy === 'month'
              ? { ...STATEMENT, months: [{ month: '2026-04', debit: 50000, credit: 20000, closing: 130000 }] }
              : STATEMENT
        }
      case 'analysis:outstandings':
        return { ok: true, data: PARTIES }
      default:
        return { ok: false, error: `unmocked channel ${channel}` }
    }
  })
  window.total = { platform: 'test', invoke }
  act(() => {
    useSession.setState({ slug: 'alpha-co', from: '2026-04-01', to: '2027-03-31' })
    useNav.setState({ go })
  })
})
afterEach(() => cleanup())

describe('Day Book', () => {
  it('shows in-books vouchers in service order, totals and activation', async () => {
    renderScreen(<DayBook />)
    await waitFor(() => expect(rowsOf('daybook')).toHaveLength(2), SLOW) // the optional voucher is out of the books
    expect(col('daybook', 3)).toEqual(['Zeta Traders', 'Alpha Rent'])
    const totals = screen.getByTestId('daybook-table-totals')
    expect(totals.textContent).toContain('Total · 2 vouchers')
    expect(totals.textContent).toContain('1,180.00')
    expect(totals.textContent).toContain('500.00')

    fireEvent.click(screen.getByTestId('sort-daybook-account'))
    expect(col('daybook', 3)).toEqual(['Alpha Rent', 'Zeta Traders'])

    fireEvent.click(rowsOf('daybook')[1]!)
    expect(go).toHaveBeenCalledWith({ name: 'voucher-entry', voucherId: 11 })
    // Every printable voucher (here the sales invoice and the payment) has the PDF action in its own
    // cell (never activating the row); WP 1.10c prints non-invoice kinds with their template too.
    expect(screen.getAllByTestId('btn-daybook-invoice-pdf')).toHaveLength(2)
  })

  it('"All vouchers" shows optional rows but keeps them out of the totals', async () => {
    renderScreen(<DayBook />)
    await waitFor(() => expect(rowsOf('daybook')).toHaveLength(2), SLOW)
    fireEvent.change(screen.getByTestId('input-daybook-scope'), { target: { value: 'all' } })
    expect(rowsOf('daybook')).toHaveLength(3)
    expect(col('daybook', 3)[2]).toBe('Memo CoOptional')
    const totals = screen.getByTestId('daybook-table-totals').textContent ?? ''
    expect(totals).toContain('Total (in books) · 2 vouchers')
    expect(totals).toContain('1,180.00')
    expect(totals).not.toContain('2,179.00')
  })

  it('tags the year-end closing journal with its chip; it still counts in the books', async () => {
    const closing: DayBookRow = {
      voucherId: 14, date: '2027-03-31', voucherType: 'Journal', kind: 'journal', number: '3', account: 'Profit & Loss A/c', accountLedgerId: 35,
      narration: 'Year-end close', debit: 25000, credit: 0, isOptional: false, postDated: false, yearEndClose: true
    }
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, payload?: unknown) =>
      channel === 'report:dayBook' ? { ok: true, data: [...DAYBOOK, closing] } : base(channel, payload)
    )
    renderScreen(<DayBook />)
    await waitFor(() => expect(rowsOf('daybook')).toHaveLength(3), SLOW)
    const chips = screen.getAllByTestId('daybook-year-end-chip')
    expect(chips).toHaveLength(1)
    expect(chips[0]!.textContent).toBe('Year-end closing entry')
    expect(chips[0]!.closest('tr')!.getAttribute('data-row-id')).toBe('14')
    expect(screen.getByTestId('daybook-table-totals').textContent).toContain('Total · 3 vouchers')
  })
})

describe('Trial Balance', () => {
  it('renders ledgers in service order with totals; synthetic rows never drill down', async () => {
    renderScreen(<TrialBalanceScreen />)
    await waitFor(() => expect(rowsOf('trial-balance')).toHaveLength(3), SLOW)
    expect(col('trial-balance', 0)).toEqual(['Cash', 'Profit & Loss A/c (opening)', 'Capital'])
    // Opening / movement columns are hidden by default, as before.
    expect(screen.queryByTestId('sort-trial-balance-opening')).toBeNull()
    const totals = screen.getByTestId('trial-balance-table-totals').textContent ?? ''
    expect(totals.match(/1,500\.00/g)).toHaveLength(2)

    fireEvent.click(screen.getByTestId('sort-trial-balance-ledger'))
    expect(col('trial-balance', 0)).toEqual(['Capital', 'Cash', 'Profit & Loss A/c (opening)'])

    fireEvent.click(rowsOf('trial-balance')[2]!) // the computed P&L opening row
    expect(go).not.toHaveBeenCalled()
    fireEvent.click(rowsOf('trial-balance')[1]!)
    expect(go).toHaveBeenCalledWith({ name: 'ledger-statement', ledgerId: 5 })
  })

  it('seeds hidden columns from the old report config (movement → both movement columns)', async () => {
    localStorage.setItem('total-reportcfg-alpha-co-trial-balance', JSON.stringify({ movement: true, opening: true }))
    renderScreen(<TrialBalanceScreen />)
    await waitFor(() => expect(rowsOf('trial-balance')).toHaveLength(3), SLOW)
    for (const id of ['opening', 'movementDr', 'movementCr']) expect(screen.getByTestId(`sort-trial-balance-${id}`)).toBeTruthy()
    // Net opening, signed like the rows: 1,000 Dr − 200 Cr − 800 Cr = 0 → a dash.
    const totals = screen.getByTestId('trial-balance-table-totals')
    expect(within(totals).getAllByText('800.00').length).toBe(2) // movement Dr / Cr
  })
})

describe('Ledger Statement', () => {
  it('voucher rows open the voucher; the footer shows the closing balance, never a summed balance', async () => {
    renderScreen(<LedgerStatementScreen ledgerId={5} />)
    await waitFor(() => expect(rowsOf('ledger-statement')).toHaveLength(2), SLOW)
    const totals = screen.getByTestId('ledger-statement-table-totals').textContent ?? ''
    expect(totals).toContain('Closing balance')
    expect(totals).toContain('1,300.00 Dr')
    expect(totals).not.toContain('2,800.00') // Σ running balances
    fireEvent.click(rowsOf('ledger-statement')[1]!)
    expect(go).toHaveBeenCalledWith({ name: 'voucher-entry', voucherId: 22 })

    fireEvent.click(screen.getByTestId('sort-ledger-statement-debit'))
    expect(col('ledger-statement', 1)).toEqual(['Alpha Rent', 'Zeta Traders'])

    // A filtered view has no honest closing figure: the balance total goes blank, debits re-sum.
    fireEvent.change(screen.getByTestId('ledger-statement-table-quick'), { target: { value: 'zeta' } })
    await waitFor(() => expect(rowsOf('ledger-statement')).toHaveLength(1), SLOW)
    const filtered = screen.getByTestId('ledger-statement-table-totals').textContent ?? ''
    expect(filtered).toContain('500.00')
    expect(filtered).not.toContain('Dr')
  })

  it('switches to the Monthly view through the shared tab bar', async () => {
    renderScreen(<LedgerStatementScreen ledgerId={5} />)
    await waitFor(() => expect(rowsOf('ledger-statement')).toHaveLength(2), SLOW)
    fireEvent.click(screen.getByTestId('tab-ledger-statement-monthly'))
    await waitFor(() => expect(rowsOf('ledger-statement-monthly')).toHaveLength(1), SLOW)
    expect(col('ledger-statement-monthly', 0)).toEqual(['Apr 2026'])
    expect(screen.getByTestId('ledger-statement-monthly-table-totals').textContent).toContain('1,300.00 Dr')
  })
})

describe('Outstandings', () => {
  it('parties expand to their bills; totals sum every bucket', async () => {
    renderScreen(<OutstandingsScreen />)
    await waitFor(() => expect(rowsOf('outstandings')).toHaveLength(2), SLOW)
    expect(col('outstandings', 1)).toEqual(['Zeta Traders', 'Alpha Stores']) // after the chevron cell
    const totals = screen.getByTestId('outstandings-table-totals').textContent ?? ''
    expect(totals).toContain('1,500.00') // 0–30 d
    expect(totals).toContain('3,500.00') // pending

    fireEvent.click(rowsOf('outstandings')[0]!)
    const bills = await screen.findByTestId('outstandings-bills-31', {}, SLOW)
    expect(bills.textContent).toContain('INV-1')
    expect(bills.textContent).toContain('120d overdue')
    fireEvent.click(within(bills).getByText('INV-7'))
    expect(go).toHaveBeenCalledWith({ name: 'voucher-entry', voucherId: 42 })
    fireEvent.click(rowsOf('outstandings')[0]!)
    expect(screen.queryByTestId('outstandings-bills-31')).toBeNull()

    fireEvent.click(screen.getByTestId('sort-outstandings-pending'))
    expect(col('outstandings', 1)).toEqual(['Alpha Stores', 'Zeta Traders'])
  })
})
