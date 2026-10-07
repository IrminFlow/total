// WP 2.5b: the delivery challan / GRN screens and the invoice's "Add from…" drawer, driven
// through the real component tree against a mocked IPC bridge.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Group, Ledger, StockItem, Voucher, VoucherType } from '@shared/domain'
import type { OpenSourceLine } from '@shared/tradeCycle/types'
import { DEFAULT_FEATURES } from '@shared/features'
import { VoucherEntry } from '../screens/VoucherEntry'
import { AddFromDrawer } from '../screens/voucher/AddFromDrawer'
import { useSession } from '../state/stores'

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
const vt = (id: number, name: string, kind: VoucherType['kind']): VoucherType => ({
  id, name, kind, numbering: 'auto', prefix: '', suffix: '', padWidth: 0, restartFy: true, isSystem: true
})
const TYPES: VoucherType[] = [vt(1, 'Sales', 'sales'), vt(2, 'Journal', 'journal'), vt(5, 'Delivery Note', 'delivery_note'), vt(6, 'Receipt Note', 'receipt_note')]
const UID = (n: number): string => n.toString(16).padStart(32, '0')

const challan = (over: Partial<Voucher> = {}): Voucher => ({
  id: 31, voucherTypeId: 5, date: '2025-05-01', number: 'DC-1', partyLedgerId: 10, narration: null, reference: 'PO-7',
  instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: 'MH12AB1234', transportDistanceKm: 18, posOverride: null,
  currencyCode: null, exchangeRate: null, irn: null, irnAckNo: null, irnAckDate: null, ewbNo: null, ewbValidUpto: null,
  postDated: false, isOptional: false, isYearEndClose: false, deletedAt: null, createdAt: '', updatedAt: '',
  lines: [],
  inventory: [{ id: 1, stockItemId: 100, godownId: null, batchId: null, qtyMilli: 5000, ratePaise: 12000, discountPaise: 0, amount: 60000, direction: 'out', isAbsolute: false, serials: [], lineUid: UID(1), movesStock: true, source: null }],
  billRefs: [], tds: null, trade: { purpose: 'job_work' }, ...over
})

const OPEN: OpenSourceLine[] = [{
  lineUid: UID(1), voucherId: 31, tradeDocId: null, kind: 'delivery_note', label: 'Delivery Note DC-1 line 1', date: '2025-05-01',
  stockItemId: 100, godownId: null, batchId: null, serials: [], qtyMilli: 5000, doneMilli: 0, pendingMilli: 5000, ratePaise: 12000, amount: 60000
}]

let voucher: Voucher
let orders = true

beforeEach(() => {
  orders = true
  useSession.setState({
    slug: 'test',
    info: { name: 'T', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '', booksFrom: 2025, email: null, phone: null, pan: null, tan: null }
  })
  invoke.mockImplementation(async (channel: string, payload: unknown) => {
    switch (channel) {
      case 'config:features:get': return { ok: true, data: { ...DEFAULT_FEATURES, orders } }
      case 'master:voucherTypes:list': return { ok: true, data: TYPES }
      case 'voucher:get': return { ok: true, data: voucher }
      case 'master:ledgers:list': return { ok: true, data: LEDGERS }
      case 'master:groups:list': return { ok: true, data: GROUPS }
      case 'master:stockItems:list': return { ok: true, data: ITEMS }
      case 'master:units:list': return { ok: true, data: [{ id: 1, name: 'Numbers', symbol: 'Nos', decimals: 0, uqc: 'NOS' }] }
      case 'master:godowns:list': return { ok: true, data: [] }
      case 'master:batches:list': return { ok: true, data: [] }
      case 'master:currencies:list': return { ok: true, data: [] }
      case 'voucher:nextNumber': return { ok: true, data: { number: '7' } }
      case 'voucher:numberExists': return { ok: true, data: false }
      case 'voucher:save': return { ok: true, data: { ...voucher, ...(payload as { data: object }).data, warnings: { negativeStock: [], creditLimitExceeded: null } } }
      case 'links:forVoucher': return { ok: true, data: { upstream: [], downstream: [] } }
      case 'links:openSourceLines': return { ok: true, data: OPEN }
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

function renderEntry(props: Parameters<typeof VoucherEntry>[0]): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <VoucherEntry {...props} />
    </QueryClientProvider>
  )
}

const mode = async (): Promise<string | null> =>
  (await screen.findByTestId('voucher-entry-mode', undefined, { timeout: 3000 })).getAttribute('data-mode')

describe('delivery challan / GRN entry', () => {
  it('opens a saved challan in the challan form with its purpose, and saves it back as a stock note', async () => {
    voucher = challan()
    renderEntry({ voucherId: 31 })
    expect(await mode()).toBe('stockNote')
    await screen.findByTestId('stock-note-delivery_note')
    const jobWork = screen.getByRole('radio', { name: 'Job work' })
    expect(jobWork.getAttribute('aria-checked')).toBe('true')
    expect((screen.getAllByTestId('input-line-qty')[0] as HTMLInputElement).value).toBe('5')
    expect(screen.getByTestId('stock-note-totals').textContent).toContain('600.00')
    // Job work isn't a supply: value only, no tax shown.
    expect(screen.getByTestId('stock-note-totals').textContent).not.toContain('CGST')

    fireEvent.click(screen.getByRole('radio', { name: 'Supply' }))
    await waitFor(() => expect(screen.getByTestId('stock-note-totals').textContent).toContain('CGST'))
    fireEvent.click(screen.getByTestId('btn-save-voucher'))
    await waitFor(() => expect(invoke.mock.calls.some((c) => c[0] === 'voucher:save')).toBe(true))
    const saved = invoke.mock.calls.find((c) => c[0] === 'voucher:save')![1] as { data: Record<string, unknown>; id: number }
    expect(saved.id).toBe(31)
    expect(saved.data.lines).toEqual([])
    expect(saved.data.trade).toEqual({ purpose: 'supply' })
    expect((saved.data.inventory as { direction: string; lineUid: string }[])[0]).toMatchObject({ direction: 'out', lineUid: UID(1), amount: 60000 })
  })

  it('warns when a challan number exceeds 16 characters (rule 55)', async () => {
    voucher = challan({ number: 'DC/2025-26/000000001' })
    renderEntry({ voucherId: 31 })
    await screen.findByTestId('stock-note-delivery_note')
    expect(screen.getByText(/at most 16/)).toBeTruthy()
  })

  it('a new GRN offers the receipt purposes; the note tabs show only with Orders & challans on', async () => {
    renderEntry({ kindHint: 'receipt_note' })
    expect(await mode()).toBe('stockNote')
    await screen.findByTestId('stock-note-receipt_note')
    expect(screen.getByRole('radio', { name: 'Purchase' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio', { name: 'Return / rejection' })).toBeTruthy()
    expect(screen.getByTestId('tab-voucher-entry-delivery_note')).toBeTruthy()
    cleanup()
    orders = false
    renderEntry({ kindHint: 'sales' })
    await screen.findByTestId('tab-voucher-entry-sales')
    expect(screen.queryByTestId('tab-voucher-entry-delivery_note')).toBeNull()
  })
})

describe('"Add from…" drawer', () => {
  it('caps the quantity at pending and returns the picks', async () => {
    const onInsert = vi.fn()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <AddFromDrawer title="Add from challans" lines={OPEN} onClose={() => {}} onInsert={onInsert} />
      </QueryClientProvider>
    )
    const insert = await screen.findByTestId('btn-add-from-insert')
    expect((insert as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('input-add-from-pick'))
    const qty = screen.getByTestId('input-add-from-qty') as HTMLInputElement
    expect(qty.value).toBe('5')
    fireEvent.change(qty, { target: { value: '9' } })
    expect(qty.value).toBe('5')
    fireEvent.change(qty, { target: { value: '3' } })
    fireEvent.click(insert)
    expect(onInsert).toHaveBeenCalledWith([{ line: OPEN[0], qtyMilli: 3000 }])
  })

  it('in a sales invoice, inserts locked rows that carry the challan link and a "from" chip', async () => {
    renderEntry({ kindHint: 'sales', draft: { partyLedgerId: 10 } })
    expect(await mode()).toBe('invoice')
    fireEvent.click(await screen.findByTestId('btn-add-from'))
    const drawer = await screen.findByTestId('drawer-add-from')
    fireEvent.click(await within(drawer).findByTestId('input-add-from-pick'))
    fireEvent.change(within(drawer).getByTestId('input-add-from-qty'), { target: { value: '2' } })
    fireEvent.click(within(drawer).getByTestId('btn-add-from-insert'))
    await waitFor(() => expect(screen.queryByTestId('drawer-add-from')).toBeNull())
    expect(screen.getByTestId('line-item-locked').textContent).toBe('Widget')
    expect(screen.getByTestId('chip-line-source').textContent).toContain('Delivery Note DC-1 · line 1')
    const qty = screen.getAllByTestId('input-line-qty')[0] as HTMLInputElement
    expect(qty.value).toBe('2')
    expect((screen.getAllByTestId('input-line-rate')[0] as HTMLInputElement).value).toBe('120.00')
    // Capped at what the challan still has pending.
    fireEvent.change(qty, { target: { value: '8' } })
    expect(qty.value).toBe('5')
    expect(screen.getByTestId('invoice-goods-on-challan')).toBeTruthy()
  })
})
