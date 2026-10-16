// WP 2.5b lists: the Challans / GRNs list screens (DataTable, status, convert buttons, several
// challans of one party onto one invoice) and the sales editor opened by "Convert to invoice" with
// every pending line of those challans drawn, against a mocked IPC bridge.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Group, Ledger, StockItem, VoucherType } from '@shared/domain'
import type { OpenSourceLine, StockNoteListRow } from '@shared/tradeCycle/types'
import { DEFAULT_FEATURES } from '@shared/features'
import { VoucherEntry } from '../screens/VoucherEntry'
import { TradeNoteListScreen } from '../screens/TradeNoteList'
import { useNav, useSession } from '../state/stores'

const invoke = vi.fn()

const GROUPS: Group[] = [
  { id: 1, name: 'Sundry Debtors', parentId: null, nature: 'asset', affectsGrossProfit: false, isSystem: true },
  { id: 2, name: 'Sales Accounts', parentId: null, nature: 'income', affectsGrossProfit: true, isSystem: true }
]
const ledger = (id: number, name: string, groupId: number): Ledger => ({
  id, name, groupId, openingBalance: 0, gstin: null, stateCode: '27', address: null, taxType: null, gstRate: null,
  hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null, rcm: false, itcEligibility: 'eligible',
  priceLevelId: null, creditLimit: null, deducteeType: null, tdsPayableSectionId: null, tdsDefaultSectionId: null, isSystem: false
})
const LEDGERS: Ledger[] = [ledger(10, 'Buyer', 1), ledger(11, 'Other Buyer', 1), ledger(20, 'Sales', 2)]
const ITEMS: StockItem[] = [
  { id: 100, name: 'Widget', groupId: null, unitId: 1, hsn: '8471', gstRate: 18, cessRate: null, openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null, valuationMethod: 'weighted_avg', trackSerials: false },
  { id: 101, name: 'Gadget', groupId: null, unitId: 1, hsn: '8471', gstRate: 18, cessRate: null, openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null, valuationMethod: 'weighted_avg', trackSerials: false }
]
const vt = (id: number, name: string, kind: VoucherType['kind']): VoucherType => ({
  id, name, kind, numbering: 'auto', prefix: '', suffix: '', padWidth: 0, restartFy: true, isSystem: true
})
const TYPES: VoucherType[] = [vt(1, 'Sales', 'sales'), vt(2, 'Journal', 'journal'), vt(5, 'Delivery Note', 'delivery_note'), vt(6, 'Receipt Note', 'receipt_note')]
const UID = (n: number): string => n.toString(16).padStart(32, '0')

const note = (over: Partial<StockNoteListRow>): StockNoteListRow => ({
  voucherId: 31, number: 'DC-1', date: '2025-05-01', purpose: 'supply', partyLedgerId: 10, partyName: 'Buyer', lineCount: 1, items: 'Widget',
  qtyMilli: 5000, pendingMilli: 5000, unit: 'Nos', decimals: 0, pendingLines: 1, value: 60000, pendingValue: 60000, status: 'pending',
  closedAt: null, closeReason: null, targets: [], convertible: true, ...over
})
const NOTES: StockNoteListRow[] = [
  note({}),
  note({ voucherId: 32, number: 'DC-2', items: 'Gadget', qtyMilli: 4000, pendingMilli: 1000, pendingValue: 10000, status: 'partly', targets: [{ voucherId: 40, number: 'INV-9', kind: 'sales', date: '2025-05-05', linkType: 'fulfil' }] }),
  note({ voucherId: 33, number: 'DC-3', partyLedgerId: 11, partyName: 'Other Buyer' }),
  note({ voucherId: 34, number: 'DC-4', purpose: 'job_work', convertible: false }),
  note({ voucherId: 35, number: 'DC-5', status: 'done', pendingMilli: 0, pendingValue: 0, pendingLines: 0, convertible: false })
]

const line = (n: number, voucherId: number, label: string, stockItemId: number, pendingMilli: number): OpenSourceLine => ({
  lineUid: UID(n), voucherId, tradeDocId: null, kind: 'delivery_note', label, date: '2025-05-01', stockItemId, godownId: null, batchId: null,
  serials: [], qtyMilli: pendingMilli, doneMilli: 0, pendingMilli, ratePaise: 12000, amount: (pendingMilli / 1000) * 12000
})
const OPEN: OpenSourceLine[] = [
  line(1, 31, 'Delivery Note DC-1 line 1', 100, 5000),
  line(2, 32, 'Delivery Note DC-2 line 1', 101, 1000),
  line(3, 36, 'Delivery Note DC-6 line 1', 100, 2000)
]

beforeEach(() => {
  useSession.setState({
    slug: 'test',
    info: { name: 'T', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '', booksFrom: 2025, email: null, phone: null, pan: null, tan: null } as never,
    from: '2025-04-01',
    to: '2026-03-31',
    user: null
  })
  useNav.setState({ stack: [{ name: 'challans' }] })
  invoke.mockImplementation(async (channel: string) => {
    switch (channel) {
      case 'config:features:get': return { ok: true, data: { ...DEFAULT_FEATURES, orders: true } }
      case 'trade:noteList': return { ok: true, data: NOTES }
      case 'master:voucherTypes:list': return { ok: true, data: TYPES }
      case 'master:ledgers:list': return { ok: true, data: LEDGERS }
      case 'master:groups:list': return { ok: true, data: GROUPS }
      case 'master:stockItems:list': return { ok: true, data: ITEMS }
      case 'master:units:list': return { ok: true, data: [{ id: 1, name: 'Numbers', symbol: 'Nos', decimals: 0, uqc: 'NOS' }] }
      case 'master:godowns:list': return { ok: true, data: [] }
      case 'master:batches:list': return { ok: true, data: [] }
      case 'master:currencies:list': return { ok: true, data: [] }
      case 'voucher:nextNumber': return { ok: true, data: { number: '7' } }
      case 'voucher:numberExists': return { ok: true, data: false }
      case 'links:forVoucher': return { ok: true, data: { upstream: [], downstream: [] } }
      case 'links:openSourceLines': return { ok: true, data: OPEN }
      case 'report:dashboard': return { ok: true, data: { voucherCount: 3 } }
      default: return { ok: false, error: `unmocked ${channel}` }
    }
  })
  window.total = { platform: 'test', invoke } as unknown as typeof window.total
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function wrap(ui: React.ReactElement): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('Delivery challans list', () => {
  it('asks for the period, pending as on its end; status words; linked invoices; convert only where something is pending to invoice', async () => {
    wrap(<TradeNoteListScreen stage="delivery_note" />)
    await screen.findByText('DC-1')
    expect(invoke.mock.calls.find((c) => c[0] === 'trade:noteList')![1]).toEqual({
      stage: 'delivery_note', from: '2025-04-01', to: '2026-03-31', asOn: '2026-03-31', filter: 'pending'
    })
    expect(screen.getAllByTestId('note-status').map((b) => b.textContent)).toEqual(['Not invoiced', 'Partly invoiced', 'Not invoiced', 'Not invoiced', 'Invoiced'])
    expect(screen.getByTestId('note-target').textContent).toContain('INV-9')
    expect(screen.getByTestId('btn-note-convert-31')).toBeTruthy()
    expect(screen.queryByTestId('btn-note-convert-34')).toBeNull() // job work
    expect(screen.queryByTestId('btn-note-convert-35')).toBeNull() // invoiced
    fireEvent.click(screen.getByTestId('btn-note-convert-31'))
    await waitFor(() =>
      expect(useNav.getState().stack.at(-1)).toMatchObject({ name: 'voucher-entry', kindHint: 'sales', draft: { partyLedgerId: 10, fromVoucherIds: [31] } })
    )
  })

  it('ticks several challans of one party onto one invoice; another party is refused', async () => {
    wrap(<TradeNoteListScreen stage="delivery_note" />)
    await screen.findByText('DC-1')
    const box = (key: number): HTMLInputElement => screen.getByTestId(`trade-notes-delivery_note-select-${key}`) as HTMLInputElement
    expect(box(34).disabled).toBe(true)
    fireEvent.click(box(31))
    fireEvent.click(box(32))
    const btn = screen.getByTestId('btn-notes-convert-selected') as HTMLButtonElement
    expect(btn.textContent).toBe('Convert 2 challans to one invoice')
    fireEvent.click(box(33))
    expect((screen.getByTestId('btn-notes-convert-selected') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(box(33))
    fireEvent.click(screen.getByTestId('btn-notes-convert-selected'))
    await waitFor(() =>
      expect(useNav.getState().stack.at(-1)).toMatchObject({ name: 'voucher-entry', kindHint: 'sales', draft: { partyLedgerId: 10, fromVoucherIds: [31, 32] } })
    )
  })

  it('the filter asks main again; a viewer gets no convert', async () => {
    useSession.setState({ user: { id: 2, name: 'V', role: 'viewer' } as never })
    wrap(<TradeNoteListScreen stage="delivery_note" />)
    await screen.findByText('DC-1')
    expect(screen.queryByTestId('btn-note-convert-31')).toBeNull()
    fireEvent.click(screen.getByTestId('trade-notes-filter-all'))
    await waitFor(() => expect(invoke.mock.calls.some((c) => c[0] === 'trade:noteList' && (c[1] as { filter: string }).filter === 'all')).toBe(true))
  })
})

describe('"Convert to invoice" in the sales editor', () => {
  it('draws every pending line of the converted challans — only those — with their source links', async () => {
    wrap(<VoucherEntry kindHint="sales" draft={{ partyLedgerId: 10, fromVoucherIds: [31, 32] }} />)
    await waitFor(() => expect(screen.getAllByTestId('chip-line-source')).toHaveLength(2))
    const chips = screen.getAllByTestId('chip-line-source').map((c) => c.textContent)
    expect(chips[0]).toContain('DC-1 · line 1')
    expect(chips[1]).toContain('DC-2 · line 1')
    const qtys = screen.getAllByTestId('input-line-qty').map((q) => (q as HTMLInputElement).value)
    expect(qtys.slice(0, 2)).toEqual(['5', '1'])
    expect(screen.queryByText(/DC-6/)).toBeNull()
    expect(within(document.body).getAllByTestId('line-item-locked').map((x) => x.textContent)).toEqual(['Widget', 'Gadget'])
  })
})
