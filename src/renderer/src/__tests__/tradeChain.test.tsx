// WP 2.5d: the Linked documents drawer (trade:chain laid out in columns, links table, navigation
// closes it) and the "Against…" picker of a return (a whole document fills in at its returnable
// quantity; the reason comes back with the picks).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { OpenSourceLine, TradeChain } from '@shared/tradeCycle/types'
import { DEFAULT_FEATURES } from '@shared/features'
import { LinkedDocsDrawer, LinkedDocsHost, chainStatusLabel, openLinkedDocs, useLinkedDocs } from '../components/LinkedDocs'
import { AddFromDrawer } from '../screens/voucher/AddFromDrawer'
import { useNav, useSession } from '../state/stores'

const invoke = vi.fn()
const UID = (n: number): string => n.toString(16).padStart(32, '0')

const line = (n: number, qty: number, fulfilled = 0, returned = 0) => ({
  lineUid: UID(n), lineNo: 1, stockItemId: 100, itemName: 'Widget', decimals: 0, qtyMilli: qty, amount: qty * 150,
  fulfilledMilli: fulfilled, returnedMilli: returned
})

const CHAIN: TradeChain = {
  rootKey: 'v40',
  truncated: false,
  nodes: [
    { key: 'd4', voucherId: null, tradeDocId: 4, kind: 'sales_order', typeName: 'Sales Order', number: 'SO-4', label: 'Sales Order SO-4', date: '2025-05-02', partyLedgerId: 10, partyName: 'Buyer', qtyMilli: 10_000, value: 1_500_000, status: 'partly_fulfilled', live: true, closeReason: null, level: 0, isRoot: false, lines: [line(1, 10_000, 7000)] },
    { key: 'v31', voucherId: 31, tradeDocId: null, kind: 'delivery_note', typeName: 'Delivery Note', number: 'DC-1', label: 'Delivery Note DC-1', date: '2025-05-03', partyLedgerId: 10, partyName: 'Buyer', qtyMilli: 4000, value: 600_000, status: 'fulfilled', live: true, closeReason: null, level: 1, isRoot: false, lines: [line(2, 4000, 4000)] },
    { key: 'v32', voucherId: 32, tradeDocId: null, kind: 'delivery_note', typeName: 'Delivery Note', number: 'DC-2', label: 'Delivery Note DC-2', date: '2025-05-04', partyLedgerId: 10, partyName: 'Buyer', qtyMilli: 3000, value: 450_000, status: 'closed', live: true, closeReason: 'Kept as samples', level: 1, isRoot: false, lines: [line(3, 3000)] },
    { key: 'v40', voucherId: 40, tradeDocId: null, kind: 'sales', typeName: 'Sales', number: '12', label: 'Sales 12', date: '2025-05-05', partyLedgerId: 10, partyName: 'Buyer', qtyMilli: 4000, value: 600_000, status: 'partly_returned', live: true, closeReason: null, level: 2, isRoot: true, lines: [line(4, 4000, 0, 1000)] },
    { key: 'v50', voucherId: 50, tradeDocId: null, kind: 'credit_note', typeName: 'Credit Note', number: 'CN-1', label: 'Credit Note CN-1', date: '2025-05-10', partyLedgerId: 10, partyName: 'Buyer', qtyMilli: 1000, value: 150_000, status: 'posted', live: true, closeReason: null, level: 3, isRoot: false, lines: [line(5, 1000)] }
  ],
  edges: [
    { from: 'd4', to: 'v31', linkType: 'fulfil', qtyMilli: 4000, lines: 1, live: true },
    { from: 'd4', to: 'v32', linkType: 'fulfil', qtyMilli: 3000, lines: 1, live: true },
    { from: 'v31', to: 'v40', linkType: 'fulfil', qtyMilli: 4000, lines: 1, live: true },
    { from: 'v40', to: 'v50', linkType: 'return', qtyMilli: 1000, lines: 1, live: true }
  ]
}

beforeEach(() => {
  useSession.setState({
    slug: 'test',
    info: { name: 'T', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '', booksFrom: 2025, email: null, phone: null, pan: null, tan: null }
  })
  invoke.mockImplementation(async (channel: string, payload: unknown) => {
    switch (channel) {
      case 'config:features:get': return { ok: true, data: { ...DEFAULT_FEATURES, orders: true } }
      case 'trade:chain': {
        const p = payload as { voucherId?: number }
        return p.voucherId === 99
          ? { ok: true, data: { rootKey: 'v99', truncated: false, edges: [], nodes: [{ ...CHAIN.nodes[3]!, key: 'v99', voucherId: 99, label: 'Sales 99', isRoot: true, status: 'posted' }] } }
          : { ok: true, data: CHAIN }
      }
      case 'master:stockItems:list': return { ok: true, data: [{ id: 100, name: 'Widget', groupId: null, unitId: 1, hsn: '8471', gstRate: 18, cessRate: null, openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null, valuationMethod: 'weighted_avg', trackSerials: false }] }
      case 'master:units:list': return { ok: true, data: [{ id: 1, name: 'Numbers', symbol: 'Nos', decimals: 0, uqc: 'NOS' }] }
      default: return { ok: false, error: `unmocked ${channel}` }
    }
  })
  window.total = { platform: 'test', invoke }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useLinkedDocs.setState({ target: null })
})

function wrap(ui: React.ReactElement): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('Linked documents drawer', () => {
  it('lays the chain out by level with statuses, quantities and every link', async () => {
    wrap(<LinkedDocsDrawer target={{ voucherId: 40 }} onClose={() => {}} />)
    const drawer = await screen.findByTestId('drawer-linked-docs')
    await waitFor(() => expect(within(drawer).getAllByTestId('chain-node')).toHaveLength(5))
    expect(invoke).toHaveBeenCalledWith('trade:chain', { voucherId: 40 })
    const levels = within(drawer).getAllByTestId('chain-level')
    expect(levels.map((l) => within(l).getAllByTestId('chain-node').map((n) => n.getAttribute('data-key')))).toEqual([
      ['d4'], ['v31', 'v32'], ['v40'], ['v50']
    ])
    expect(levels[1]!.getAttribute('aria-label')).toBe('Delivery challans')
    const root = within(drawer).getAllByTestId('chain-node').find((n) => n.getAttribute('data-root') === 'true')!
    expect(root.getAttribute('data-key')).toBe('v40')
    expect(within(root).getByTestId('chain-node-status').textContent).toBe('Partly returned')
    expect(within(root).getByTestId('chain-line').textContent).toContain('1 back')
    const dc2 = within(drawer).getAllByTestId('chain-node').find((n) => n.getAttribute('data-key') === 'v32')!
    expect(within(dc2).getByTestId('chain-node-status').textContent).toBe('Short-closed')
    expect(dc2.textContent).toContain('Kept as samples')
    const edges = within(drawer).getByTestId('rows-chain-edges').querySelectorAll('tr.dt-row')
    expect(edges).toHaveLength(4)
    expect([...edges].map((e) => e.getAttribute('data-link-type'))).toEqual(['fulfil', 'fulfil', 'fulfil', 'return'])
    expect(edges[3]!.textContent).toContain('returned')
    expect(edges[0]!.textContent).toContain('delivered')
  })

  it('a document with nothing linked says so', async () => {
    wrap(<LinkedDocsDrawer target={{ voucherId: 99 }} onClose={() => {}} />)
    expect((await screen.findByTestId('linked-docs-none')).textContent).toContain('Sales 99')
  })

  it('opens from the store, and following a document link closes it', async () => {
    wrap(<LinkedDocsHost />)
    expect(screen.queryByTestId('drawer-linked-docs')).toBeNull()
    openLinkedDocs({ tradeDocId: 4 })
    const drawer = await screen.findByTestId('drawer-linked-docs')
    await waitFor(() => expect(within(drawer).getAllByTestId('chain-node')).toHaveLength(5))
    expect(invoke).toHaveBeenCalledWith('trade:chain', { tradeDocId: 4 })
    const cn = within(drawer).getAllByTestId('chain-node').find((n) => n.getAttribute('data-key') === 'v50')!
    fireEvent.click(within(cn).getByTestId('voucher-link'))
    await waitFor(() => expect(screen.queryByTestId('drawer-linked-docs')).toBeNull())
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toMatchObject({ name: 'voucher-entry', voucherId: 50 }))
  })

  it('status words per kind', () => {
    expect(chainStatusLabel('delivery_note', 'open')).toBe('Not invoiced')
    expect(chainStatusLabel('receipt_note', 'partly_fulfilled')).toBe('Partly billed')
    expect(chainStatusLabel('sales_order', 'fulfilled')).toBe('Delivered')
    expect(chainStatusLabel('sales', 'binned')).toBe('In the bin')
  })
})

const RETURNABLE: OpenSourceLine[] = [
  { lineUid: UID(1), voucherId: 40, tradeDocId: null, kind: 'sales', label: 'Sales 12 line 1', date: '2025-05-05', stockItemId: 100, godownId: null, batchId: null, serials: [], qtyMilli: 4000, doneMilli: 1000, pendingMilli: 3000, ratePaise: 15000, amount: 60000 },
  { lineUid: UID(2), voucherId: 40, tradeDocId: null, kind: 'sales', label: 'Sales 12 line 2', date: '2025-05-05', stockItemId: 100, godownId: null, batchId: null, serials: [], qtyMilli: 2000, doneMilli: 0, pendingMilli: 2000, ratePaise: 15000, amount: 30000 },
  { lineUid: UID(3), voucherId: 41, tradeDocId: null, kind: 'sales', label: 'Sales 13 line 1', date: '2025-05-07', stockItemId: 100, godownId: null, batchId: null, serials: [], qtyMilli: 5000, doneMilli: 0, pendingMilli: 5000, ratePaise: 15000, amount: 75000 }
]

describe('"Against…" picker (returns)', () => {
  it('picking a document fills its returnable lines; quantities stay capped; the reason comes back', async () => {
    const onInsert = vi.fn()
    wrap(<AddFromDrawer title="Against invoice" lines={RETURNABLE} linkType="return" onClose={() => {}} onInsert={onInsert} />)
    const drawer = await screen.findByTestId('drawer-add-from')
    // Return wording: sold / returned / returnable.
    const heads = [...drawer.querySelectorAll('th')].map((th) => th.textContent)
    expect(heads.some((h) => h?.includes('Sold'))).toBe(true)
    expect(heads.some((h) => h?.includes('Returned'))).toBe(true)
    expect(heads.some((h) => h?.includes('Returnable'))).toBe(true)
    const against = screen.getByTestId('input-add-from-against') as HTMLSelectElement
    expect([...against.options].map((o) => o.textContent)).toEqual(['Pick a document…', 'Sales 12 · 05/05/2025 · 2 lines', 'Sales 13 · 07/05/2025 · 1 line'])
    fireEvent.change(against, { target: { value: 'v40' } })
    const qtys = screen.getAllByTestId('input-add-from-qty') as HTMLInputElement[]
    expect(qtys.map((q) => q.value)).toEqual(['3', '2'])
    fireEvent.change(qtys[0]!, { target: { value: '7' } })
    expect((screen.getAllByTestId('input-add-from-qty')[0] as HTMLInputElement).value).toBe('3')
    fireEvent.change(qtys[1]!, { target: { value: '1' } })
    fireEvent.change(screen.getByTestId('input-add-from-reason'), { target: { value: 'Damaged in transit' } })
    fireEvent.click(screen.getByTestId('btn-add-from-insert'))
    expect(onInsert).toHaveBeenCalledWith(
      [{ line: RETURNABLE[0], qtyMilli: 3000 }, { line: RETURNABLE[1], qtyMilli: 1000 }],
      'Damaged in transit'
    )
  })

  it('the fulfil drawer has no Against / reason fields', async () => {
    wrap(<AddFromDrawer title="Add from challans" lines={RETURNABLE} onClose={() => {}} onInsert={() => {}} />)
    await screen.findByTestId('drawer-add-from')
    expect(screen.queryByTestId('input-add-from-against')).toBeNull()
    expect(screen.queryByTestId('input-add-from-reason')).toBeNull()
  })
})
