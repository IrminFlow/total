// WP 1.8 on the main report screens: clicking a ledger NAME opens the ledger edit window (one
// global DrillHost), clicking the rest of the row opens that ledger's statement — or, where the
// row already means something else (a Day Book voucher, an Outstandings party's bills), keeps
// that meaning while the name still opens the ledger.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Group, Ledger } from '@shared/domain'
import type { DayBookRow, LedgerStatement, OutstandingParty, StatementNode, TrialBalance } from '@shared/reports'
import { DrillHost } from '../components/DrillHost'
import { StatementTree } from '../components/StatementTree'
import { TrialBalanceScreen } from '../screens/TrialBalance'
import { DayBook } from '../screens/DayBook'
import { OutstandingsScreen } from '../screens/Outstandings'
import { Masters } from '../screens/Masters'
import { LedgerStatementScreen } from '../screens/LedgerStatement'
import { useDrill } from '../lib/drill'
import { useNav, useSession } from '../state/stores'

vi.setConfig({ testTimeout: 30_000 })
const SLOW = { timeout: 10_000 }

const invoke = vi.fn()
const go = vi.fn()

const GROUPS: Group[] = [
  { id: 1, name: 'Current Assets', parentId: null, nature: 'asset', affectsGrossProfit: false, isSystem: true },
  { id: 2, name: 'Sundry Debtors', parentId: 1, nature: 'asset', affectsGrossProfit: false, isSystem: true },
  { id: 3, name: 'Cash-in-Hand', parentId: 1, nature: 'asset', affectsGrossProfit: false, isSystem: true }
]
const ledger = (id: number, name: string, groupId: number): Ledger => ({
  id, name, groupId, openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null,
  hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null, rcm: false, itcEligibility: 'eligible',
  priceLevelId: null, creditLimit: null, isSystem: false
})
const LEDGERS = [ledger(5, 'Cash', 3), ledger(31, 'Zeta Traders', 2), ledger(32, 'Alpha Stores', 2)]

const TB: TrialBalance = {
  rows: [
    { ledgerId: 5, ledgerName: 'Cash', groupName: 'Cash-in-Hand', debit: 150000, credit: 0, opening: 0, movementDebit: 0, movementCredit: 0 },
    { ledgerId: -1, ledgerName: 'Profit & Loss A/c (opening)', groupName: 'Primary', debit: 0, credit: 150000, opening: 0, movementDebit: 0, movementCredit: 0 }
  ],
  totalDebit: 150000, totalCredit: 150000, openingDebitTotal: 0, openingCreditTotal: 0, movementDebitTotal: 0, movementCreditTotal: 0
}
const DAYBOOK: DayBookRow[] = [
  { voucherId: 11, date: '2026-04-02', voucherType: 'Sales', kind: 'sales', number: '9', account: 'Zeta Traders', accountLedgerId: 31, narration: null, debit: 118000, credit: 0, isOptional: false, postDated: false }
]
const PARTIES: OutstandingParty[] = [
  {
    ledgerId: 31, name: 'Zeta Traders', pending: 200000, buckets: [0, 0, 0, 200000],
    bills: [{ voucherId: 41, number: 'INV-1', date: '2026-01-01', amount: 200000, pending: 200000, ageDays: 120, dueDate: null, overdueDays: 120 }]
  }
]
const STATEMENT: LedgerStatement = {
  ledgerId: 31, ledgerName: 'Zeta Traders', opening: 0, closing: 118000, totalDebit: 118000, totalCredit: 0,
  rows: [{ voucherId: 11, date: '2026-04-02', voucherType: 'Sales', number: '9', particulars: 'Sales Local', particularsLedgerId: 60, narration: null, debit: 118000, credit: 0, running: 118000 }]
}

function renderScreen(ui: React.JSX.Element): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      {ui}
      <DrillHost />
    </QueryClientProvider>
  )
}

const rowsOf = (area: string): HTMLElement[] =>
  Array.from(screen.getByTestId(`rows-${area}`).querySelectorAll<HTMLElement>('tr.dt-row'))

/** Name click → the global edit window for that ledger. */
async function expectEditWindow(name: string): Promise<void> {
  expect(await screen.findByText(`Edit ${name}`, undefined, SLOW)).toBeTruthy()
  expect(go).not.toHaveBeenCalled()
}

beforeEach(() => {
  localStorage.clear()
  go.mockReset()
  invoke.mockImplementation(async (channel: string) => {
    switch (channel) {
      case 'report:trialBalance': return { ok: true, data: TB }
      case 'report:dayBook': return { ok: true, data: DAYBOOK }
      case 'analysis:outstandings': return { ok: true, data: PARTIES }
      case 'report:ledger': return { ok: true, data: STATEMENT }
      case 'master:ledgers:list': return { ok: true, data: LEDGERS }
      case 'master:groups:list': return { ok: true, data: GROUPS }
      case 'tds:sections': return { ok: true, data: [] }
      default: return { ok: false, error: `unmocked channel ${channel}` }
    }
  })
  window.total = { platform: 'test', invoke }
  act(() => {
    useSession.setState({ slug: 'alpha-co', from: '2026-04-01', to: '2027-03-31', user: null })
    useNav.setState({ go, stack: [{ name: 'gateway' }] })
    useDrill.setState({ ledgerEditId: null, itemEditId: null })
  })
})
afterEach(() => cleanup())

describe('Trial balance', () => {
  it('ledger name → edit window; the rest of the row → statement; synthetic rows stay plain', async () => {
    renderScreen(<TrialBalanceScreen />)
    await waitFor(() => expect(rowsOf('trial-balance')).toHaveLength(2), SLOW)
    const [cash, pl] = rowsOf('trial-balance')
    expect(within(pl!).queryByTestId('ledger-link')).toBeNull()

    fireEvent.click(within(cash!).getByTestId('ledger-link'))
    await expectEditWindow('Cash')

    act(() => useDrill.setState({ ledgerEditId: null }))
    fireEvent.click(cash!.querySelectorAll('td')[1]!) // the group cell — "white" row space
    expect(go).toHaveBeenCalledWith({ name: 'ledger-statement', ledgerId: 5 })
    expect(useDrill.getState().ledgerEditId).toBeNull()
  })

  it('⌘E on the active row edits its ledger; a viewer gets the statement from the name', async () => {
    renderScreen(<TrialBalanceScreen />)
    await waitFor(() => expect(rowsOf('trial-balance')).toHaveLength(2), SLOW)
    fireEvent.keyDown(window, { key: 'e', metaKey: true })
    await expectEditWindow('Cash')

    act(() => {
      useDrill.setState({ ledgerEditId: null })
      useSession.setState({ user: { id: 1, name: 'Vee', role: 'viewer' } })
    })
    await waitFor(() => expect(screen.queryByText('Edit Cash')).toBeNull())
    fireEvent.click(within(rowsOf('trial-balance')[0]!).getByTestId('ledger-link'))
    expect(go).toHaveBeenCalledWith({ name: 'ledger-statement', ledgerId: 5 })
    expect(useDrill.getState().ledgerEditId).toBeNull()
  })
})

describe('Day book', () => {
  it('account name → edit window; the row still opens the voucher', async () => {
    renderScreen(<DayBook />)
    await waitFor(() => expect(rowsOf('daybook')).toHaveLength(1), SLOW)
    const row = rowsOf('daybook')[0]!
    fireEvent.click(within(row).getByTestId('ledger-link'))
    await expectEditWindow('Zeta Traders')

    fireEvent.click(row.querySelectorAll('td')[0]!)
    expect(go).toHaveBeenCalledWith({ name: 'voucher-entry', voucherId: 11 })
  })

  it('the edit window offers the statement', async () => {
    renderScreen(<DayBook />)
    await waitFor(() => expect(rowsOf('daybook')).toHaveLength(1), SLOW)
    fireEvent.click(within(rowsOf('daybook')[0]!).getByTestId('ledger-link'))
    await expectEditWindow('Zeta Traders')
    fireEvent.click(screen.getByTestId('btn-ledger-statement'))
    expect(go).toHaveBeenCalledWith({ name: 'ledger-statement', ledgerId: 31 })
  })
})

describe('Outstandings', () => {
  it('party name → edit window; row click expands the bills; Statement → statement', async () => {
    renderScreen(<OutstandingsScreen />)
    await waitFor(() => expect(rowsOf('outstandings')).toHaveLength(1), SLOW)
    const row = rowsOf('outstandings')[0]!
    fireEvent.click(within(row).getByTestId('ledger-link'))
    await expectEditWindow('Zeta Traders')
    expect(screen.queryByTestId('outstandings-bills-31')).toBeNull() // the name click didn't expand

    act(() => useDrill.setState({ ledgerEditId: null }))
    fireEvent.click(row.querySelectorAll('td')[2]!)
    expect(await screen.findByTestId('outstandings-bills-31')).toBeTruthy()
    expect(go).not.toHaveBeenCalled()

    // Bill numbers are voucher links.
    fireEvent.click(within(screen.getByTestId('outstandings-bills-31')).getByTestId('voucher-link'))
    expect(go).toHaveBeenCalledWith({ name: 'voucher-entry', voucherId: 41 })

    fireEvent.click(screen.getByTestId('btn-outstandings-statement'))
    expect(go).toHaveBeenCalledWith({ name: 'ledger-statement', ledgerId: 31 })
  })
})

describe('Masters', () => {
  it('Ledgers tab: name → edit window, row → statement', async () => {
    renderScreen(<Masters tab="ledgers" />)
    await waitFor(() => expect(rowsOf('masters-ledgers')).toHaveLength(3), SLOW)
    const alpha = rowsOf('masters-ledgers').find((tr) => tr.textContent?.includes('Alpha Stores'))!
    fireEvent.click(within(alpha).getByTestId('ledger-link'))
    await expectEditWindow('Alpha Stores')

    act(() => useDrill.setState({ ledgerEditId: null }))
    fireEvent.click(alpha.querySelectorAll('td')[1]!)
    expect(go).toHaveBeenCalledWith({ name: 'ledger-statement', ledgerId: 32 })
  })
})

describe('P&L / Balance Sheet tree', () => {
  const NODES: StatementNode[] = [
    {
      id: 2, kind: 'group', name: 'Sundry Debtors', amount: 118000,
      children: [{ id: 31, kind: 'ledger', name: 'Zeta Traders', amount: 118000, children: [] }]
    }
  ]

  it('a ledger leaf: name → edit window, row → statement', async () => {
    renderScreen(<StatementTree nodes={NODES} />)
    const leaf = screen.getByTestId('statement-ledger')
    fireEvent.click(within(leaf).getByTestId('ledger-link'))
    await expectEditWindow('Zeta Traders')
    fireEvent.click(leaf)
    expect(go).toHaveBeenCalledWith({ name: 'ledger-statement', ledgerId: 31 })
  })
})

describe('Ledger statement', () => {
  it('shows the group breadcrumb and an Edit button; counter-ledgers and vouchers link', async () => {
    renderScreen(<LedgerStatementScreen ledgerId={31} />)
    expect((await screen.findByTestId('ledger-statement-breadcrumb', undefined, SLOW)).textContent).toBe('Current Assets › Sundry Debtors')
    fireEvent.click(screen.getByTestId('btn-statement-edit-ledger'))
    await expectEditWindow('Zeta Traders')
    act(() => useDrill.setState({ ledgerEditId: null }))

    const row = rowsOf('ledger-statement')[0]!
    fireEvent.click(within(row).getByTestId('voucher-link'))
    expect(go).toHaveBeenCalledWith({ name: 'voucher-entry', voucherId: 11 })
    fireEvent.click(within(row).getByTestId('ledger-link'))
    expect(useDrill.getState().ledgerEditId).toBe(60)
    expect(go).toHaveBeenCalledTimes(1)
  })
})
