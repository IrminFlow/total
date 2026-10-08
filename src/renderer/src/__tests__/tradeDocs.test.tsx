// WP 2.5c: the quotation / order entry form, the list with its derived statuses and actions, and
// the conversion flows (quotation → SO draft; SO → challan pre-filled from the order), driven
// through the real component tree against a mocked IPC bridge.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Group, Ledger, StockItem, VoucherType } from '@shared/domain'
import type { OpenSourceLine, TradeDoc, TradeDocDraft, TradeDocListRow } from '@shared/tradeCycle/types'
import { DEFAULT_FEATURES } from '@shared/features'
import { TradeDocEntry } from '../screens/TradeDocEntry'
import { TradeDocListScreen } from '../screens/TradeDocList'
import { VoucherEntry } from '../screens/VoucherEntry'
import { creditLimitWarningText } from '@shared/tradeCycle/edit'
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
const LEDGERS: Ledger[] = [ledger(10, 'Buyer', 1), ledger(20, 'Sales', 2)]
const ITEMS: StockItem[] = [
  { id: 100, name: 'Widget', groupId: null, unitId: 1, hsn: '8471', gstRate: 18, cessRate: null, openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null, valuationMethod: 'weighted_avg', trackSerials: false }
]
const TRADE_TYPES = [
  { id: 1, name: 'Quotation', kind: 'quotation', numbering: 'auto', prefix: 'QT-', suffix: '', padWidth: 0, restartFy: true, isSystem: true },
  { id: 2, name: 'Sales Order', kind: 'sales_order', numbering: 'auto', prefix: 'SO-', suffix: '', padWidth: 0, restartFy: true, isSystem: true },
  { id: 3, name: 'Purchase Order', kind: 'purchase_order', numbering: 'auto', prefix: 'PO-', suffix: '', padWidth: 0, restartFy: true, isSystem: true }
]
const vt = (id: number, name: string, kind: VoucherType['kind']): VoucherType => ({
  id, name, kind, numbering: 'auto', prefix: '', suffix: '', padWidth: 0, restartFy: true, isSystem: true
})
const TYPES: VoucherType[] = [vt(1, 'Sales', 'sales'), vt(5, 'Delivery Note', 'delivery_note')]
const UID = (n: number): string => n.toString(16).padStart(32, '0')

const savedSo = (over: Partial<TradeDoc> = {}): TradeDoc => ({
  id: 7, docTypeId: 2, kind: 'sales_order', typeName: 'Sales Order', number: 'SO-4', date: '2025-06-01', partyLedgerId: 10,
  partyName: 'Buyer', validUntil: null, dueDate: '2025-06-20', reference: 'PO-77', terms: 'Net 30', narration: null, posOverride: null,
  currencyCode: null, exchangeRate: null, manualStatus: 'open', status: 'partly_fulfilled', closedAt: null, closeReason: null,
  deletedAt: null,
  lines: [{
    id: 1, lineUid: UID(5), stockItemId: 100, description: null, godownId: null, qtyMilli: 10_000, ratePaise: 12_000, discountPaise: 0,
    amount: 120_000, gstRate: 18, cessRate: 0, dueDate: null, source: null, doneMilli: 4000, pendingMilli: 6000
  }],
  totals: { taxable: 120_000, cgst: 10_800, sgst: 10_800, igst: 0, cess: 0, total: 141_600, roundOff: 0 },
  pendingValue: 72_000,
  downstream: [{ voucherId: 31, tradeDocId: null, kind: 'delivery_note', label: 'Delivery Note DC-1', date: '2025-06-03', qtyMilli: 4000, live: true }],
  upstream: [],
  createdAt: '', updatedAt: 'x',
  ...over
})

const LIST: TradeDocListRow[] = [
  { id: 7, kind: 'sales_order', number: 'SO-4', date: '2025-06-01', partyLedgerId: 10, partyName: 'Buyer', reference: 'PO-77', validUntil: null, dueDate: '2025-06-20', lineCount: 1, taxable: 120_000, total: 141_600, pendingValue: 72_000, fulfilledPct: 40, status: 'partly_fulfilled', binned: false, closeReason: null, downstreamLabels: ['Delivery Note DC-1'] },
  { id: 8, kind: 'sales_order', number: 'SO-5', date: '2025-06-02', partyLedgerId: 10, partyName: 'Buyer', reference: null, validUntil: null, dueDate: null, lineCount: 1, taxable: 50_000, total: 59_000, pendingValue: 0, fulfilledPct: 0, status: 'closed', binned: false, closeReason: 'Customer cancelled', downstreamLabels: [] }
]

const SO_OPEN: OpenSourceLine[] = [{
  lineUid: UID(5), voucherId: null, tradeDocId: 7, kind: 'sales_order', label: 'Sales Order SO-4 line 1', date: '2025-06-01',
  stockItemId: 100, godownId: null, batchId: null, serials: [], qtyMilli: 10_000, doneMilli: 4000, pendingMilli: 6000, ratePaise: 12_000, amount: 120_000
}]
const Q_OPEN: OpenSourceLine[] = [{
  lineUid: UID(9), voucherId: null, tradeDocId: 3, kind: 'quotation', label: 'Quotation QT-2 line 1', date: '2025-05-20',
  stockItemId: 100, godownId: null, batchId: null, serials: [], qtyMilli: 5000, doneMilli: 0, pendingMilli: 5000, ratePaise: 11_000, amount: 55_000
}]

let doc: TradeDoc
let draft: TradeDocDraft | null

beforeEach(() => {
  doc = savedSo()
  draft = null
  useSession.setState({
    slug: 'test',
    workingDate: '2025-06-05',
    from: '2025-04-01',
    to: '2026-03-31',
    info: { name: 'T', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '', booksFrom: 2025, email: null, phone: null, pan: null, tan: null }
  })
  useNav.setState({ stack: [{ name: 'gateway' }] })
  invoke.mockImplementation(async (channel: string, payload: unknown) => {
    switch (channel) {
      case 'config:features:get': return { ok: true, data: { ...DEFAULT_FEATURES, orders: true } }
      case 'tradeDocTypes:list': return { ok: true, data: TRADE_TYPES }
      case 'tradeDocs:nextNumber': return { ok: true, data: 'QT-3' }
      case 'tradeDocs:get': return { ok: true, data: doc }
      case 'tradeDocs:list': return { ok: true, data: LIST }
      case 'tradeDocs:convert': return { ok: true, data: draft }
      case 'tradeDocs:save': return { ok: true, data: { doc: { ...doc, id: 9, number: 'QT-3' }, warnings: { linkDates: [] } } }
      case 'tradeDocs:close': return { ok: true, data: doc }
      case 'master:voucherTypes:list': return { ok: true, data: TYPES }
      case 'master:ledgers:list': return { ok: true, data: LEDGERS }
      case 'master:groups:list': return { ok: true, data: GROUPS }
      case 'master:stockItems:list': return { ok: true, data: ITEMS }
      case 'master:units:list': return { ok: true, data: [{ id: 1, name: 'Numbers', symbol: 'Nos', decimals: 0, uqc: 'NOS' }] }
      case 'master:godowns:list': return { ok: true, data: [] }
      case 'master:batches:list': return { ok: true, data: [] }
      case 'master:currencies:list': return { ok: true, data: [] }
      case 'voucher:nextNumber': return { ok: true, data: { number: '2' } }
      case 'links:openSourceLines': {
        const q = payload as { targetKind: string }
        return { ok: true, data: q.targetKind === 'sales_order' ? Q_OPEN : SO_OPEN }
      }
      case 'report:dashboard': return { ok: true, data: { voucherCount: 3 } }
      default: return { ok: false, error: `unmocked ${channel}` }
    }
  })
  window.total = { platform: 'test', invoke }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function wrap(node: React.ReactNode): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

const lastCall = (channel: string): unknown => [...invoke.mock.calls].reverse().find((c) => c[0] === channel)?.[1]

describe('trade doc entry', () => {
  it('a saved order shows its derived status, linked documents and per-line progress, and saves back unchanged', async () => {
    wrap(<TradeDocEntry kind="sales_order" id={7} />)
    await screen.findByTestId('trade-doc-sales_order')
    expect(screen.getByTestId('trade-doc-status').textContent).toBe('Partly delivered')
    expect(screen.getByTestId('trade-doc-linked').textContent).toContain('Delivery Note DC-1')
    expect(screen.getByTestId('chip-line-done').textContent).toContain('4 of 10 delivered')
    await waitFor(() => expect(screen.getByTestId('trade-doc-totals').textContent).toContain('1,416.00'))
    fireEvent.click(screen.getByTestId('btn-trade-doc-save'))
    await waitFor(() => expect(lastCall('tradeDocs:save')).toBeTruthy())
    const saved = lastCall('tradeDocs:save') as { id: number; data: Record<string, unknown> }
    expect(saved.id).toBe(7)
    expect(saved.data).toMatchObject({ docTypeId: 2, number: 'SO-4', partyLedgerId: 10, dueDate: '2025-06-20', reference: 'PO-77', terms: 'Net 30', validUntil: null })
    expect((saved.data.lines as unknown[])[0]).toMatchObject({ lineUid: UID(5), qtyMilli: 10_000, ratePaise: 12_000, amount: 120_000, source: null })
  })

  it('a short-closed / cancelled document is read-only until reopened', async () => {
    doc = savedSo({ manualStatus: 'closed', status: 'closed', closeReason: 'Customer cancelled' })
    wrap(<TradeDocEntry kind="sales_order" id={7} />)
    await screen.findByTestId('trade-doc-readonly')
    expect(screen.getByTestId('trade-doc-readonly').textContent).toContain('Customer cancelled')
    expect(screen.queryByTestId('btn-trade-doc-save')).toBeNull()
  })

  it('a converted draft (quotation → SO) arrives with its lines linked, and posts the source', async () => {
    draft = {
      kind: 'sales_order', partyLedgerId: 10, reference: 'RFQ-1', terms: 'Net 15', narration: null, posOverride: null,
      lines: [{ stockItemId: 100, description: null, godownId: null, qtyMilli: 3000, ratePaise: 11_000, discountPaise: 0, dueDate: null, source: { lineUid: UID(9), linkType: 'fulfil' } }]
    }
    wrap(<TradeDocEntry kind="sales_order" draft={draft} />)
    await screen.findByTestId('trade-doc-sales_order')
    await screen.findByTestId('chip-line-source')
    expect(screen.getByTestId('line-item-locked').textContent).toBe('Widget')
    // The quantity is capped at what is pending on the quotation (5).
    fireEvent.change(screen.getAllByTestId('input-line-qty')[0]!, { target: { value: '9' } })
    expect((screen.getAllByTestId('input-line-qty')[0] as HTMLInputElement).value).toBe('5')
    fireEvent.click(screen.getByTestId('btn-trade-doc-save'))
    await waitFor(() => expect(lastCall('tradeDocs:save')).toBeTruthy())
    const saved = lastCall('tradeDocs:save') as { id?: number; data: { lines: { source: unknown; qtyMilli: number }[]; terms: string } }
    expect(saved.id).toBeUndefined()
    expect(saved.data.terms).toBe('Net 15')
    expect(saved.data.lines[0]).toMatchObject({ qtyMilli: 5000, source: { lineUid: UID(9), linkType: 'fulfil' } })
  })

  it('a sales order can draw lines from quotations (Add from quotations…)', async () => {
    doc = savedSo({ lines: [], downstream: [], status: 'open', totals: { taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, total: 0, roundOff: 0 } })
    wrap(<TradeDocEntry kind="sales_order" id={7} />)
    fireEvent.click(await screen.findByTestId('btn-add-from'))
    const drawer = await screen.findByTestId('drawer-add-from')
    expect(drawer.textContent).toContain('Quotation QT-2')
    fireEvent.click(within(drawer).getByTestId('input-add-from-pick'))
    fireEvent.click(within(drawer).getByTestId('btn-add-from-insert'))
    await screen.findByTestId('chip-line-source')
    expect((lastCall('links:openSourceLines') as { excludeTradeDocId: number }).excludeTradeDocId).toBe(7)
  })
})

describe('trade doc list', () => {
  it('shows derived statuses and the row actions by state', async () => {
    wrap(<TradeDocListScreen kind="sales_order" />)
    await screen.findByText('SO-4')
    const badges = screen.getAllByTestId('trade-doc-status').map((b) => b.textContent)
    expect(badges).toEqual(['Partly delivered', 'Short-closed'])
    fireEvent.click(screen.getByTestId('trade-doc-actions-7'))
    expect(await screen.findByTestId('trade-doc-action-convert-delivery_note')).toBeTruthy()
    expect(screen.getByTestId('trade-doc-action-close')).toBeTruthy()
    // Something is drawn on it: it can only be short-closed, not cancelled.
    expect(screen.queryByTestId('trade-doc-action-cancel')).toBeNull()
    fireEvent.click(screen.getByTestId('trade-doc-action-convert-delivery_note'))
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toMatchObject({ name: 'voucher-entry', kindHint: 'delivery_note', draft: { partyLedgerId: 10, fromTradeDocId: 7 } }))
  })

  it('a closed order offers reopen, not convert', async () => {
    wrap(<TradeDocListScreen kind="sales_order" />)
    await screen.findByText('SO-5')
    fireEvent.click(screen.getByTestId('trade-doc-actions-8'))
    expect(await screen.findByTestId('trade-doc-action-reopen')).toBeTruthy()
    expect(screen.queryByTestId('trade-doc-action-convert-delivery_note')).toBeNull()
  })
})

describe('conversion into a voucher', () => {
  it('"Convert to delivery challan" opens the challan with every pending order line drawn', async () => {
    wrap(<VoucherEntry kindHint="delivery_note" draft={{ partyLedgerId: 10, fromTradeDocId: 7 }} />)
    await screen.findByTestId('stock-note-delivery_note')
    await screen.findByTestId('chip-line-source')
    expect((screen.getAllByTestId('input-line-qty')[0] as HTMLInputElement).value).toBe('6')
    expect(screen.getByTestId('chip-line-source').textContent).toContain('Sales Order SO-4')
    expect(screen.getByTestId('btn-add-from').textContent).toContain('Add from sales orders')
  })
})

describe('credit-limit warning text (§9 Q9)', () => {
  it('names the open sales-order value as a separate figure', () => {
    const base = { ledgerId: 10, ledgerName: 'Buyer', creditLimit: 100_000, outstanding: 120_000 }
    expect(creditLimitWarningText(base)).toBe('Buyer: credit limit ₹1,000.00 exceeded — outstanding ₹1,200.00 (with this invoice) is ₹200.00 over the limit')
    expect(creditLimitWarningText({ ...base, outstanding: 50_000, openSalesOrders: 59_000, ordersOnly: true })).toContain(
      'outstanding ₹500.00 + open sales orders ₹590.00 = ₹1,090.00, ₹90.00 over the limit (orders not yet invoiced)'
    )
  })
})
