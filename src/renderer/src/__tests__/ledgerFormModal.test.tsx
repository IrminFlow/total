// LedgerFormModal — an edit-and-save must round-trip every LedgerInput field the server would
// otherwise default (rcm / itcEligibility used to be dropped, silently resetting to false /
// 'eligible'), it can be opened by id alone, and a save refreshes all queries, not just ledgers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Group, Ledger } from '@shared/domain'
import { LedgerFormModal } from '../components/LedgerFormModal'
import { useSession } from '../state/stores'

const invoke = vi.fn()

const GROUPS: Group[] = [
  { id: 1, name: 'Current Liabilities', parentId: null, nature: 'liability', affectsGrossProfit: false, isSystem: true },
  { id: 2, name: 'Sundry Creditors', parentId: 1, nature: 'liability', affectsGrossProfit: false, isSystem: true },
  { id: 3, name: 'Current Assets', parentId: null, nature: 'asset', affectsGrossProfit: false, isSystem: true },
  { id: 4, name: 'Sundry Debtors', parentId: 3, nature: 'asset', affectsGrossProfit: false, isSystem: true }
]

const PARTY: Ledger = {
  id: 42,
  name: 'Rcm Supplier',
  groupId: 2,
  openingBalance: 0,
  gstin: null,
  stateCode: null,
  address: null,
  taxType: null,
  gstRate: null,
  hsn: null,
  tdsSectionId: null,
  pan: null,
  creditDays: null,
  exportType: null,
  rcm: true,
  itcEligibility: 'blocked',
  priceLevelId: null,
  creditLimit: null,
  deducteeType: null,
  tdsPayableSectionId: null,
  tdsDefaultSectionId: null,
  isSystem: false
}

function renderWithClient(ui: React.JSX.Element): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
  return client
}

beforeEach(() => {
  invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    switch (channel) {
      case 'master:groups:list': return { ok: true, data: GROUPS }
      case 'master:ledgers:list': return { ok: true, data: [PARTY] }
      case 'tds:sections': return { ok: true, data: [] }
      case 'receivables:setHold': return { ok: true, data: { hold: true, reason: 'x', at: null } }
      case 'master:ledgers:update': {
        const p = payload as { id: number; data: Partial<Ledger> }
        return { ok: true, data: { ...PARTY, ...p.data, id: p.id } }
      }
      default: return { ok: false, error: `unmocked channel ${channel}` }
    }
  })
  window.total = { platform: 'test', invoke }
})

afterEach(() => {
  act(() => useSession.setState({ user: null }))
  cleanup()
  vi.restoreAllMocks()
})

function updateCall(): { id: number; data: Record<string, unknown> } {
  const call = invoke.mock.calls.find(([ch]) => ch === 'master:ledgers:update')
  expect(call).toBeTruthy()
  return call![1] as { id: number; data: Record<string, unknown> }
}

describe('LedgerFormModal', () => {
  it('edit-and-save keeps rcm and itcEligibility', async () => {
    const onClose = vi.fn()
    renderWithClient(<LedgerFormModal ledger={PARTY} onClose={onClose} />)
    // Party fields only render once groups resolve the ancestry to Sundry Creditors.
    await screen.findByTestId('ledger-rcm')
    fireEvent.change(screen.getByDisplayValue('Rcm Supplier'), { target: { value: 'Rcm Supplier Renamed' } })
    fireEvent.click(screen.getByTestId('btn-ledger-save'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    const { id, data } = updateCall()
    expect(id).toBe(42)
    expect(data.name).toBe('Rcm Supplier Renamed')
    expect(data.rcm).toBe(true)
    expect(data.itcEligibility).toBe('blocked')
  })

  it('exposes rcm / itcEligibility as editable party fields', async () => {
    const onClose = vi.fn()
    renderWithClient(<LedgerFormModal ledger={PARTY} onClose={onClose} />)
    const box = (await screen.findByTestId('ledger-rcm')) as HTMLInputElement
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    fireEvent.change(screen.getByTestId('ledger-itc-eligibility'), { target: { value: 'capital_goods' } })
    fireEvent.click(screen.getByTestId('btn-ledger-save'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    const { data } = updateCall()
    expect(data.rcm).toBe(false)
    expect(data.itcEligibility).toBe('capital_goods')
  })

  it('opens by ledgerId alone and invalidates every query on save', async () => {
    const onClose = vi.fn()
    const client = renderWithClient(<LedgerFormModal ledgerId={42} onClose={onClose} />)
    const spy = vi.spyOn(client, 'invalidateQueries')
    await screen.findByDisplayValue('Rcm Supplier')
    await screen.findByTestId('ledger-rcm')
    fireEvent.click(screen.getByTestId('btn-ledger-save'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(updateCall().data.itcEligibility).toBe('blocked')
    // No filter → every family (reports included), not just ['ledgers'].
    expect(spy).toHaveBeenCalledWith()
  })

  it('ledgerId for a missing ledger shows not-found instead of a blank create form', async () => {
    renderWithClient(<LedgerFormModal ledgerId={999} onClose={() => {}} />)
    await screen.findByText(/Ledger not found/)
    expect(screen.queryByTestId('btn-ledger-save')).toBeNull()
  })

  describe('credit hold (WP 4.2)', () => {
    const CUSTOMER: Ledger = { ...PARTY, id: 43, name: 'Mehta Traders', groupId: 4, rcm: false, itcEligibility: 'eligible', creditHold: false, creditHoldReason: null }
    const order = (): string[] => invoke.mock.calls.map(([ch]) => ch as string).filter((ch) => ch === 'master:ledgers:update' || ch === 'receivables:setHold')

    it('an owner puts a customer on hold with a reason, saved after the form', async () => {
      const onClose = vi.fn()
      renderWithClient(<LedgerFormModal ledger={CUSTOMER} onClose={onClose} />)
      fireEvent.click(await screen.findByTestId('ledger-credit-hold-toggle'))
      // No reason → refused, nothing saved.
      fireEvent.click(screen.getByTestId('btn-ledger-save'))
      await waitFor(() => expect(screen.getByTestId('ledger-credit-hold-reason')).toBeTruthy())
      expect(order()).toEqual([])
      fireEvent.change(screen.getByTestId('ledger-credit-hold-reason'), { target: { value: ' 90+ days overdue ' } })
      fireEvent.click(screen.getByTestId('btn-ledger-save'))
      await waitFor(() => expect(onClose).toHaveBeenCalled())
      expect(order()).toEqual(['master:ledgers:update', 'receivables:setHold'])
      expect(invoke.mock.calls.find(([ch]) => ch === 'receivables:setHold')![1]).toEqual({ ledgerId: 43, hold: true, reason: '90+ days overdue' })
    })

    it('an owner releases a hold; an unchanged hold sends nothing', async () => {
      const held = { ...CUSTOMER, creditHold: true, creditHoldReason: 'Cheque bounced' }
      const onClose = vi.fn()
      renderWithClient(<LedgerFormModal ledger={held} onClose={onClose} />)
      const box = (await screen.findByTestId('ledger-credit-hold-toggle')) as HTMLInputElement
      expect(box.checked).toBe(true)
      expect((screen.getByTestId('ledger-credit-hold-reason') as HTMLInputElement).value).toBe('Cheque bounced')
      fireEvent.click(screen.getByTestId('btn-ledger-save'))
      await waitFor(() => expect(onClose).toHaveBeenCalled())
      expect(order()).toEqual(['master:ledgers:update'])
      cleanup()
      invoke.mockClear()
      const onClose2 = vi.fn()
      renderWithClient(<LedgerFormModal ledger={held} onClose={onClose2} />)
      fireEvent.click(await screen.findByTestId('ledger-credit-hold-toggle'))
      fireEvent.click(screen.getByTestId('btn-ledger-save'))
      await waitFor(() => expect(onClose2).toHaveBeenCalled())
      expect(invoke.mock.calls.find(([ch]) => ch === 'receivables:setHold')![1]).toEqual({ ledgerId: 43, hold: false, reason: '' })
    })

    it('an accountant sees the hold read-only and never calls setHold', async () => {
      act(() => useSession.setState({ user: { id: 2, name: 'Asha', role: 'accountant' } as never }))
      const onClose = vi.fn()
      renderWithClient(<LedgerFormModal ledger={{ ...CUSTOMER, creditHold: true, creditHoldReason: 'Over limit' }} onClose={onClose} />)
      expect((await screen.findByTestId('ledger-credit-hold')).textContent).toContain('On credit hold — Over limit. Only an owner can release it.')
      expect(screen.queryByTestId('ledger-credit-hold-toggle')).toBeNull()
      fireEvent.click(screen.getByTestId('btn-ledger-save'))
      await waitFor(() => expect(onClose).toHaveBeenCalled())
      expect(order()).toEqual(['master:ledgers:update'])
    })
  })
})
