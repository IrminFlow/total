// WP 1.8 drill-down links: a ledger NAME opens the ledger edit window (the statement for a
// read-only viewer), an item name the item editor, a voucher label voucher entry — and none of
// them lets the click / Enter reach the row underneath. DrillHost hosts the windows once and
// wires ⌘E to the ledger of the row the user is on.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Group, Ledger, StockItem } from '@shared/domain'
import { FirstLedgerLink, ItemLink, LedgerLink, VoucherLink, drillRowProps } from '../components/links'
import { DrillHost } from '../components/DrillHost'
import { ledgerForShortcut, openLedgerStatement, useDrill } from '../lib/drill'
import { useNav, useSession } from '../state/stores'

vi.setConfig({ testTimeout: 30_000 })

const invoke = vi.fn()
const go = vi.fn()

const GROUPS: Group[] = [{ id: 1, name: 'Sundry Debtors', parentId: null, nature: 'asset', affectsGrossProfit: false, isSystem: true }]
const ACME: Ledger = {
  id: 31, name: 'Acme Traders', groupId: 1, openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null,
  gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null, rcm: false,
  itcEligibility: 'eligible', priceLevelId: null, creditLimit: null, deducteeType: null, tdsPayableSectionId: null, tdsDefaultSectionId: null, isSystem: false
}
const WIDGET = { id: 7, name: 'Widget', unitId: 1, groupId: null, hsn: null, gstRate: null, cessRate: null, openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null } as unknown as StockItem

function renderWithClient(ui: React.JSX.Element): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  go.mockReset()
  invoke.mockImplementation(async (channel: string) => {
    switch (channel) {
      case 'master:groups:list': return { ok: true, data: GROUPS }
      case 'master:ledgers:list': return { ok: true, data: [ACME] }
      case 'master:stockItems:list': return { ok: true, data: [WIDGET] }
      case 'units:list': return { ok: true, data: [{ id: 1, name: 'Numbers', symbol: 'Nos', decimals: 0, uqc: 'NOS' }] }
      case 'tds:sections': return { ok: true, data: [] }
      case 'bom:get': return { ok: true, data: [] }
      default: return { ok: false, error: `unmocked channel ${channel}` }
    }
  })
  window.total = { platform: 'test', invoke }
  act(() => {
    useSession.setState({ slug: 'alpha-co', user: null })
    useNav.setState({ go, stack: [{ name: 'gateway' }] })
    useDrill.setState({ ledgerEditId: null, itemEditId: null })
  })
})
afterEach(() => cleanup())

describe('LedgerLink', () => {
  it('click opens the edit window and never reaches the row', () => {
    const rowClick = vi.fn()
    render(
      <div onClick={rowClick}>
        <LedgerLink ledgerId={31} name="Acme Traders" />
      </div>
    )
    const link = screen.getByRole('button', { name: 'Edit ledger Acme Traders' })
    expect(link.getAttribute('title')).toBe('Edit ledger Acme Traders')
    fireEvent.click(link)
    expect(useDrill.getState().ledgerEditId).toBe(31)
    expect(rowClick).not.toHaveBeenCalled()
    expect(go).not.toHaveBeenCalled()
  })

  it('Enter and Space open the edit window; the key never reaches window listeners (row Enter)', () => {
    const windowKey = vi.fn()
    window.addEventListener('keydown', windowKey)
    try {
      render(<LedgerLink ledgerId={31} name="Acme Traders" />)
      const link = screen.getByTestId('ledger-link')
      link.focus()
      expect(document.activeElement).toBe(link)
      fireEvent.keyDown(link, { key: 'Enter' })
      expect(useDrill.getState().ledgerEditId).toBe(31)
      act(() => useDrill.setState({ ledgerEditId: null }))
      fireEvent.keyDown(link, { key: ' ' })
      expect(useDrill.getState().ledgerEditId).toBe(31)
      expect(windowKey).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', windowKey)
    }
  })

  it('a viewer gets the statement instead of an edit form they cannot save', () => {
    act(() => useSession.setState({ user: { id: 1, name: 'Vee', role: 'viewer' } }))
    const rowClick = vi.fn()
    render(
      <div onClick={rowClick}>
        <LedgerLink ledgerId={31} name="Acme Traders" />
      </div>
    )
    const link = screen.getByRole('button', { name: 'Open Acme Traders statement' })
    fireEvent.click(link)
    expect(go).toHaveBeenCalledWith({ name: 'ledger-statement', ledgerId: 31 })
    expect(useDrill.getState().ledgerEditId).toBeNull()
    expect(rowClick).not.toHaveBeenCalled()
  })

  it('accountants and owners edit', () => {
    act(() => useSession.setState({ user: { id: 2, name: 'Acc', role: 'accountant' } }))
    render(<LedgerLink ledgerId={31} name="Acme Traders" />)
    fireEvent.click(screen.getByTestId('ledger-link'))
    expect(useDrill.getState().ledgerEditId).toBe(31)
  })

  it('synthetic ledgers (id <= 0 / null) render as plain text', () => {
    const { container } = render(
      <>
        <LedgerLink ledgerId={-1} name="Profit & Loss A/c (opening)" />
        <LedgerLink ledgerId={null} name="Cash sale" />
      </>
    )
    expect(screen.queryByTestId('ledger-link')).toBeNull()
    expect(container.textContent).toBe('Profit & Loss A/c (opening)Cash sale')
  })
})

describe('FirstLedgerLink', () => {
  it('links only the first name of a "A,B,C" summary', async () => {
    renderWithClient(<FirstLedgerLink ledgerId={31} text="Acme Traders,CGST Input,SGST Input" />)
    await waitFor(() => expect(screen.getByTestId('ledger-link').textContent).toBe('Acme Traders'))
    expect(document.body.textContent).toContain('Acme Traders,CGST Input,SGST Input')
    fireEvent.click(screen.getByTestId('ledger-link'))
    expect(useDrill.getState().ledgerEditId).toBe(31)
  })
})

describe('ItemLink and VoucherLink', () => {
  it('ItemLink opens the item editor; viewers see plain text', () => {
    const rowClick = vi.fn()
    const { unmount } = render(
      <div onClick={rowClick}>
        <ItemLink itemId={7} name="Widget" />
      </div>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Edit item Widget' }))
    expect(useDrill.getState().itemEditId).toBe(7)
    expect(rowClick).not.toHaveBeenCalled()
    unmount()
    act(() => useSession.setState({ user: { id: 1, name: 'Vee', role: 'viewer' } }))
    render(<ItemLink itemId={7} name="Widget" />)
    expect(screen.queryByTestId('item-link')).toBeNull()
    expect(screen.getByText('Widget')).toBeTruthy()
  })

  it('VoucherLink opens voucher entry, by click or Enter, without activating the row', () => {
    const rowClick = vi.fn()
    render(
      <div onClick={rowClick}>
        <VoucherLink voucherId={41} label="INV-1" />
      </div>
    )
    fireEvent.click(screen.getByText('INV-1'))
    expect(go).toHaveBeenCalledWith({ name: 'voucher-entry', voucherId: 41 })
    fireEvent.keyDown(screen.getByTestId('voucher-link'), { key: 'Enter' })
    expect(go).toHaveBeenCalledTimes(2)
    expect(rowClick).not.toHaveBeenCalled()
  })
})

describe('drill rows and statement navigation', () => {
  it('drillRowProps: row click / Enter → statement; a name click inside → edit only', () => {
    render(
      <div data-testid="row" {...drillRowProps(() => openLedgerStatement(31), 31)}>
        <LedgerLink ledgerId={31} name="Acme Traders" /> <span>₹ 1,000</span>
      </div>
    )
    fireEvent.click(screen.getByText('₹ 1,000'))
    expect(go).toHaveBeenCalledWith({ name: 'ledger-statement', ledgerId: 31 })
    fireEvent.keyDown(screen.getByTestId('row'), { key: 'Enter' })
    expect(go).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByTestId('ledger-link'))
    expect(go).toHaveBeenCalledTimes(2)
    expect(useDrill.getState().ledgerEditId).toBe(31)
  })

  it('openLedgerStatement does not push the statement already on screen', () => {
    act(() => useNav.setState({ stack: [{ name: 'gateway' }, { name: 'ledger-statement', ledgerId: 31 }] }))
    openLedgerStatement(31)
    expect(go).not.toHaveBeenCalled()
    openLedgerStatement(32)
    expect(go).toHaveBeenCalledWith({ name: 'ledger-statement', ledgerId: 32 })
  })
})

describe('DrillHost', () => {
  it('renders the one ledger edit window for the requested id; Statement moves on to the statement', async () => {
    renderWithClient(<DrillHost />)
    act(() => useDrill.getState().setLedgerEdit(31))
    expect(await screen.findByText('Edit Acme Traders')).toBeTruthy()
    fireEvent.click(screen.getByTestId('btn-ledger-statement'))
    expect(go).toHaveBeenCalledWith({ name: 'ledger-statement', ledgerId: 31 })
    await waitFor(() => expect(screen.queryByText('Edit Acme Traders')).toBeNull())
  })

  it('renders the item editor for an item id', async () => {
    renderWithClient(<DrillHost />)
    act(() => useDrill.getState().setItemEdit(7))
    expect(await screen.findByText('Edit Widget')).toBeTruthy()
  })

  it('⌘E / Ctrl+E edits the ledger of the active table row', async () => {
    renderWithClient(
      <>
        <table>
          <tbody>
            <tr className="kbar-row dt-row" data-active="false">
              <td>
                <LedgerLink ledgerId={99} name="Other" />
              </td>
            </tr>
            <tr className="kbar-row dt-row" data-active="true">
              <td>
                <LedgerLink ledgerId={31} name="Acme Traders" />
              </td>
            </tr>
          </tbody>
        </table>
        <DrillHost />
      </>
    )
    fireEvent.keyDown(window, { key: 'e', metaKey: true })
    expect(useDrill.getState().ledgerEditId).toBe(31)
    expect(await screen.findByText('Edit Acme Traders')).toBeTruthy()
    // While the window is open, ⌘E does nothing more (the modal owns the keyboard).
    act(() => useDrill.setState({ ledgerEditId: null }))
    await waitFor(() => expect(screen.queryByText('Edit Acme Traders')).toBeNull())
    fireEvent.keyDown(window, { key: 'E', ctrlKey: true })
    expect(useDrill.getState().ledgerEditId).toBe(31)
  })

  it('⌘E prefers the focused row; ignores inputs and rows without a ledger', () => {
    render(
      <>
        <div data-testid="r1" {...drillRowProps(() => {}, 31)}>
          Acme
        </div>
        <input data-testid="box" />
      </>
    )
    screen.getByTestId('r1').focus()
    expect(ledgerForShortcut(document, null)).toBe(31)
    screen.getByTestId('box').focus()
    expect(ledgerForShortcut(document, null)).toBeNull()
  })
})
