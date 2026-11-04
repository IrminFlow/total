// PR #188 review (owner, 4 Nov): the accountant Physical Stock editor SHOWS a count line's cost per
// unit (typed for a product with nothing on hand) and lets it be changed or cleared — never a
// hidden rate re-applied when the quantity changes. A row without one shows no box.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CompanyInfo } from '@shared/domain'
import { emptyPhysicalState, type PhysicalFormState } from '@shared/voucherEdit'
import { useNav, useSession } from '../state/stores'
import { PhysicalStockEntry } from '../screens/voucher/PhysicalStockEntry'

const invoke = vi.fn()
const info: CompanyInfo = { name: 'Mehta Bakery', stateCode: '27', gstin: null, gstRegistrationType: 'unregistered', address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null }
const ITEMS = [
  { id: 1, name: 'Jam', groupId: null, unitId: 4, hsn: null, gstRate: null, cessRate: null, openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null, valuationMethod: 'weighted_avg', trackSerials: false },
  { id: 2, name: 'Flour', groupId: null, unitId: 4, hsn: null, gstRate: null, cessRate: null, openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null, valuationMethod: 'weighted_avg', trackSerials: false }
]
const initial: PhysicalFormState = {
  ...emptyPhysicalState('2026-10-13'),
  rows: [
    { itemId: 1, qtyText: '10', godownId: null, batchId: null, ratePaise: 2500 },
    { itemId: 2, qtyText: '98', godownId: null, batchId: null }
  ]
}

beforeEach(() => {
  invoke.mockImplementation(async (channel: string) => {
    switch (channel) {
      case 'master:stockItems:list': return { ok: true, data: ITEMS }
      case 'voucher:save': return { ok: true, data: { id: 9, number: 'PS-1', inventory: [], lines: [] } }
      default: return { ok: true, data: [] }
    }
  })
  window.total = { platform: 'test', invoke }
  act(() => {
    useSession.setState({ info, slug: 'mehta', user: null, ui: { mode: 'accountant' }, workingDate: '2026-10-13', from: '2026-04-01', to: '2027-03-31' })
    useNav.setState({ stack: [{ name: 'voucher-entry' }] })
  })
})
afterEach(() => {
  cleanup()
  invoke.mockReset()
})

const saved = (): { inventory: { stockItemId: number; qtyMilli: number; ratePaise: number; amount: number; countCost?: boolean }[] } =>
  (invoke.mock.calls.filter(([c]) => c === 'voucher:save').at(-1)![1] as { data: never }).data

describe('Physical Stock editor: a count line’s cost per unit', () => {
  it('is shown on the row that has one, editable; the value follows qty × the cost shown', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><PhysicalStockEntry typeId={5} initial={initial} /></QueryClientProvider>)
    const boxes = await waitFor(() => screen.getAllByTestId('input-count-cost'))
    expect(boxes).toHaveLength(1) // only the Jam row
    expect((boxes[0] as HTMLInputElement).value).toBe('25.00')
    fireEvent.change(screen.getAllByTestId('input-counted-qty')[0]!, { target: { value: '12' } })
    fireEvent.change(boxes[0]!, { target: { value: '30' } })
    fireEvent.click(screen.getByTestId('btn-save-physical'))
    await waitFor(() => expect(invoke.mock.calls.some(([c]) => c === 'voucher:save')).toBe(true))
    const [jam, flour] = saved().inventory
    expect(jam).toMatchObject({ stockItemId: 1, qtyMilli: 12_000, ratePaise: 3000, amount: 36_000, countCost: true })
    expect(flour).toMatchObject({ stockItemId: 2, qtyMilli: 98_000, ratePaise: 0, amount: 0 })
    expect(flour!.countCost).toBeUndefined()
  })

  it('cleared, the line goes back to the engine’s cost (no rate, no mark)', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><PhysicalStockEntry typeId={5} initial={initial} /></QueryClientProvider>)
    const box = (await waitFor(() => screen.getAllByTestId('input-count-cost')))[0]!
    fireEvent.change(box, { target: { value: '' } })
    expect(screen.getAllByTestId('input-count-cost')).toHaveLength(1) // the box stays until the item changes
    fireEvent.click(screen.getByTestId('btn-save-physical'))
    await waitFor(() => expect(invoke.mock.calls.some(([c]) => c === 'voucher:save')).toBe(true))
    expect(saved().inventory[0]).toMatchObject({ stockItemId: 1, ratePaise: 0, amount: 0 })
    expect(saved().inventory[0]!.countCost).toBeUndefined()
  })
})
