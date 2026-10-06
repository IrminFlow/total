// LedgerFormModal — an edit-and-save must round-trip every LedgerInput field the server would
// otherwise default (rcm / itcEligibility used to be dropped, silently resetting to false /
// 'eligible'), it can be opened by id alone, and a save refreshes all queries, not just ledgers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Group, Ledger } from '@shared/domain'
import { LedgerFormModal } from '../components/LedgerFormModal'

const invoke = vi.fn()

const GROUPS: Group[] = [
  { id: 1, name: 'Current Liabilities', parentId: null, nature: 'liability', affectsGrossProfit: false, isSystem: true },
  { id: 2, name: 'Sundry Creditors', parentId: 1, nature: 'liability', affectsGrossProfit: false, isSystem: true }
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
})
