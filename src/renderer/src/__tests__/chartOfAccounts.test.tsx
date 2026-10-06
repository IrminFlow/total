// Masters → Groups chart of accounts (components/ChartOfAccounts.tsx): ledgers show as leaves
// under their group, the filter keeps matches' ancestors open, and a leaf opens its statement.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { buildChartOfAccounts } from '@shared/chartOfAccounts'
import { ChartOfAccounts } from '../components/ChartOfAccounts'
import { useDrill } from '../lib/drill'

const TREE = buildChartOfAccounts(
  [
    { id: 1, name: 'Sales Accounts', parentId: null, nature: 'income', isSystem: true },
    { id: 2, name: 'Purchase Accounts', parentId: null, nature: 'expense', isSystem: true },
    { id: 3, name: 'Current Assets', parentId: null, nature: 'asset', isSystem: true },
    { id: 4, name: 'Sundry Debtors', parentId: 3, nature: 'asset', isSystem: true }
  ],
  [
    { id: 10, name: 'Local Sale', groupId: 1, gstin: null, pan: null },
    { id: 20, name: 'Local Purchase', groupId: 2, gstin: null, pan: null },
    { id: 30, name: 'Acme Traders', groupId: 4, gstin: null, pan: null }
  ],
  (id) => ({ 10: -100000, 20: 40000, 30: 60000 })[id] ?? 0
)

const ledgerNames = (): string[] => screen.queryAllByTestId('coa-ledger').map((el) => el.textContent ?? '')

afterEach(cleanup)

describe('ChartOfAccounts', () => {
  it('shows ledgers under top-level groups by default, with counts and Dr/Cr balances', () => {
    render(<ChartOfAccounts tree={TREE} onOpenLedger={() => {}} />)
    const names = ledgerNames()
    expect(names.some((n) => n.includes('Local Sale'))).toBe(true)
    expect(names.some((n) => n.includes('Local Purchase'))).toBe(true)
    // Acme sits two levels down (Current Assets → Sundry Debtors): collapsed by default.
    expect(names.some((n) => n.includes('Acme Traders'))).toBe(false)
    const salesRow = screen.getAllByTestId('coa-group').find((el) => el.textContent?.includes('Sales Accounts'))!
    expect(salesRow.textContent).toContain('1 ledger')
    expect(salesRow.textContent).toContain('Cr')
  })

  it('filter "Sales" keeps Local Sale visible under Sales Accounts', () => {
    render(<ChartOfAccounts tree={TREE} onOpenLedger={() => {}} />)
    fireEvent.click(screen.getByTestId('coa-collapse-all'))
    expect(ledgerNames()).toEqual([])
    fireEvent.change(screen.getByTestId('coa-filter'), { target: { value: 'Sales' } })
    const names = ledgerNames()
    expect(names.some((n) => n.includes('Local Sale'))).toBe(true)
    expect(names.some((n) => n.includes('Local Purchase'))).toBe(false)
  })

  it('a deep ledger match auto-expands its ancestors; expand all reveals everything', () => {
    render(<ChartOfAccounts tree={TREE} onOpenLedger={() => {}} />)
    fireEvent.change(screen.getByTestId('coa-filter'), { target: { value: 'acme' } })
    const hits = ledgerNames()
    expect(hits).toHaveLength(1)
    expect(hits[0]).toContain('Acme Traders')
    fireEvent.change(screen.getByTestId('coa-filter'), { target: { value: '' } })
    fireEvent.click(screen.getByTestId('coa-expand-all'))
    expect(ledgerNames()).toHaveLength(3)
  })

  it('clicking a ledger leaf opens its statement', () => {
    const onOpen = vi.fn()
    render(<ChartOfAccounts tree={TREE} onOpenLedger={onOpen} />)
    const leaf = screen.getAllByTestId('coa-ledger').find((el) => el.textContent?.includes('Local Sale'))!
    fireEvent.click(leaf)
    expect(onOpen).toHaveBeenCalledWith(10)
  })

  it('a leaf\'s NAME opens the ledger edit window instead (WP 1.8); Enter on the leaf opens the statement', () => {
    useDrill.setState({ ledgerEditId: null })
    const onOpen = vi.fn()
    render(<ChartOfAccounts tree={TREE} onOpenLedger={onOpen} />)
    const leaf = screen.getAllByTestId('coa-ledger').find((el) => el.textContent?.includes('Local Sale'))!
    fireEvent.click(within(leaf).getByTestId('ledger-link'))
    expect(useDrill.getState().ledgerEditId).toBe(10)
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.keyDown(leaf, { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith(10)
  })
})
