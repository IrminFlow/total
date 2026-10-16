// to-do §4: an item created over IPC after the Labels tab loaded appears without reopening it —
// main announces the changed masters ('total:masters:changed', main/masterEvents.ts) and
// lib/masterEvents.ts refetches those cached lists.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { StockItem } from '@shared/domain'
import { DEFAULT_FEATURES } from '@shared/features'
import { StockReportsScreen } from '../screens/StockReports'
import { bindMasterEvents } from '../lib/masterEvents'
import { useNav, useSession } from '../state/stores'

const item = (id: number, name: string, barcode: string | null): StockItem => ({
  id, name, groupId: null, unitId: 1, hsn: null, gstRate: null, cessRate: null, openingQtyMilli: 0, openingValue: 0,
  barcode, reorderLevelMilli: null, valuationMethod: 'weighted_avg', trackSerials: false
})

let items: StockItem[] = []
let listener: ((e: { entities: string[] }) => void) | null = null
const invoke = vi.fn()

beforeEach(() => {
  items = [item(1, 'Old Widget', 'W-1')]
  listener = null
  useSession.setState({
    slug: 'test', from: '2026-04-01', to: '2027-03-31', user: null,
    info: { name: 'Acme', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null }
  })
  useNav.setState({ stack: [{ name: 'stock-reports', tab: 'labels' }] as never })
  invoke.mockImplementation(async (channel: string) => {
    switch (channel) {
      case 'master:stockItems:list': return { ok: true, data: items }
      case 'master:priceLevels:list': return { ok: true, data: [] }
      case 'config:features:get': return { ok: true, data: { ...DEFAULT_FEATURES } }
      default: return { ok: true, data: null }
    }
  })
  window.total = {
    platform: 'test',
    invoke,
    onMastersChanged: (l) => {
      listener = l
      return () => { listener = null }
    }
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('master-changed events refresh cached lists', () => {
  it('the Labels tab shows an item created elsewhere without being reopened', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } })
    const unbind = bindMasterEvents(client)
    render(
      <QueryClientProvider client={client}>
        <StockReportsScreen tab="labels" />
      </QueryClientProvider>
    )
    const rows = await screen.findByTestId('rows-labels')
    await within(rows).findByText('Old Widget')
    expect(within(rows).queryByText('New Gadget')).toBeNull()

    // An item created over IPC by something else (no invalidation from this screen) …
    items = [...items, item(2, 'New Gadget', 'G-2')]
    // … unrelated masters changing doesn't refetch the items
    const listsBefore = invoke.mock.calls.filter(([c]) => c === 'master:stockItems:list').length
    act(() => listener!({ entities: ['costCentre'] }))
    expect(invoke.mock.calls.filter(([c]) => c === 'master:stockItems:list').length).toBe(listsBefore)
    // … the stockItem event does.
    act(() => listener!({ entities: ['stockItem'] }))
    await waitFor(() => expect(within(rows).getByText('New Gadget')).toBeTruthy())
    expect(screen.getByTestId('input-labels-copies-2')).toBeTruthy()

    unbind()
    expect(listener).toBeNull()
  })

  it('no bridge (tests, a page without preload) is a no-op', () => {
    const client = new QueryClient()
    expect(() => bindMasterEvents(client, undefined)()).not.toThrow()
  })
})
