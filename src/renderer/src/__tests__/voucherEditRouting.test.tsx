// VoucherEntry alteration routing (WP 1.4): a saved voucher opens in the mode that creates its
// kind when that mode can show it faithfully, and in the lossless fallback (with a banner)
// otherwise. Drives the real component tree against a mocked IPC bridge.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, within, cleanup, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_FEATURES } from '@shared/features'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Group, Ledger, StockItem, Voucher, VoucherType } from '@shared/domain'
import { buildInvoicePayload, emptyInvoiceState, taxLedgerIdsFrom } from '@shared/voucherEdit'
import { VoucherEntry } from '../screens/VoucherEntry'
import { useSession } from '../state/stores'
import { DialogHost } from '../components/dialogs'

const invoke = vi.fn()

const GROUPS: Group[] = [
  { id: 1, name: 'Sundry Debtors', parentId: null, nature: 'asset', affectsGrossProfit: false, isSystem: true },
  { id: 2, name: 'Sales Accounts', parentId: null, nature: 'income', affectsGrossProfit: true, isSystem: true },
  { id: 3, name: 'Duties & Taxes', parentId: null, nature: 'liability', affectsGrossProfit: false, isSystem: true }
]

const ledger = (id: number, name: string, groupId: number, over: Partial<Ledger> = {}): Ledger => ({
  id, name, groupId, openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null,
  hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null, rcm: false, itcEligibility: 'eligible',
  priceLevelId: null, creditLimit: null, deducteeType: null, tdsPayableSectionId: null, tdsDefaultSectionId: null, isSystem: false, ...over
})
const LEDGERS: Ledger[] = [
  ledger(10, 'Buyer', 1, { stateCode: '27' }),
  ledger(20, 'Sales', 2),
  ledger(40, 'CGST', 3, { taxType: 'cgst' }),
  ledger(41, 'SGST', 3, { taxType: 'sgst' })
]
const ITEMS: StockItem[] = [
  { id: 100, name: 'Widget', groupId: null, unitId: 1, hsn: null, gstRate: 18, cessRate: null, openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null, valuationMethod: 'weighted_avg', trackSerials: false },
  { id: 101, name: 'Steel', groupId: null, unitId: 1, hsn: null, gstRate: 18, cessRate: null, openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null, valuationMethod: 'weighted_avg', trackSerials: false }
]
const vt = (id: number, name: string, kind: VoucherType['kind']): VoucherType => ({
  id, name, kind, numbering: 'auto', prefix: '', suffix: '', padWidth: 0, restartFy: true, isSystem: true
})
const TYPES: VoucherType[] = [vt(1, 'Sales', 'sales'), vt(2, 'Journal', 'journal'), vt(3, 'Stock Journal', 'stock_journal'), vt(4, 'Physical Stock', 'physical_stock')]

function asVoucher(id: number, p: ReturnType<typeof salesPayload>): Voucher {
  return {
    id, voucherTypeId: p.voucherTypeId, date: p.date, number: p.number ?? 'X', partyLedgerId: p.partyLedgerId, narration: p.narration,
    reference: p.reference, instrumentNo: p.instrumentNo, instrumentDate: p.instrumentDate, transporterId: p.transporterId,
    vehicleNo: p.vehicleNo, transportDistanceKm: p.transportDistanceKm, posOverride: p.posOverride, currencyCode: p.currencyCode,
    exchangeRate: p.exchangeRate, irn: null, irnAckNo: null, irnAckDate: null, ewbNo: null, ewbValidUpto: null,
    postDated: false, isOptional: p.isOptional ?? false, isYearEndClose: false, deletedAt: null, createdAt: '', updatedAt: '',
    lines: p.lines.map((l, i) => ({ id: i + 1, ledgerId: l.ledgerId, drCr: l.drCr, amount: l.amount, bankDate: null, costAllocations: [] })),
    inventory: p.inventory.map((l, i) => ({
      id: i + 1, stockItemId: l.stockItemId, godownId: l.godownId ?? null, batchId: l.batchId ?? null, qtyMilli: l.qtyMilli,
      ratePaise: l.ratePaise, discountPaise: l.discountPaise ?? 0, amount: l.amount, direction: l.direction, isAbsolute: l.isAbsolute ?? false
    })),
    billRefs: p.billRefs.map((r) => ({ ...r, dueDate: r.dueDate ?? null })),
    tds: null
  }
}

function salesPayload() {
  const r = buildInvoicePayload(
    {
      ...emptyInvoiceState('2025-05-01'), number: 'INV-9', partyId: 10, accountId: 20, billName: 'INV-9', billDueDate: '2025-05-31',
      rows: [{ itemId: 100, qtyText: '2', rate: 50000, discount: 10000, godownId: null, batchId: 7 }]
    },
    {
      kind: 'sales', companyStateCode: '27', gstRegistrationType: 'regular',
      items: new Map(ITEMS.map((i) => [i.id, { gstRate: i.gstRate, cessRate: i.cessRate }])),
      ledgers: new Map(LEDGERS.map((l) => [l.id, { stateCode: l.stateCode, gstRate: l.gstRate }]))
    },
    1,
    taxLedgerIdsFrom(LEDGERS)
  )
  if (!r.ok) throw new Error(r.error)
  return r.payload
}

let voucher: Voucher

beforeEach(() => {
  useSession.setState({
    slug: 'test',
    info: { name: 'T', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '', booksFrom: 2025, email: null, phone: null, pan: null, tan: null }
  })
  invoke.mockImplementation(async (channel: string) => {
    switch (channel) {
      case 'master:voucherTypes:list': return { ok: true, data: TYPES }
      case 'voucher:get': return { ok: true, data: voucher }
      case 'master:ledgers:list': return { ok: true, data: LEDGERS }
      case 'master:groups:list': return { ok: true, data: GROUPS }
      case 'master:stockItems:list': return { ok: true, data: ITEMS }
      case 'master:units:list': return { ok: true, data: [{ id: 1, name: 'Numbers', symbol: 'Nos', decimals: 0, uqc: 'NOS' }] }
      case 'bom:get': return { ok: true, data: [] }
      case 'bom:versions': return { ok: true, data: [] }
      case 'jobWork:get': return { ok: true, data: null }
      case 'manufacture:get': return { ok: true, data: { voucher, details: null } }
      case 'master:godowns:list': return { ok: true, data: [{ id: 1, name: 'Main', address: null }, { id: 2, name: 'Annex', address: null }] }
      case 'master:batches:list': return { ok: true, data: [] }
      case 'stock:byGodown': return { ok: true, data: [] }
      case 'voucher:nextNumber': return { ok: true, data: { number: '99' } }
      case 'voucher:delete': return { ok: true, data: null }
      default: return { ok: false, error: `unmocked ${channel}` }
    }
  })
  window.total = { platform: 'test', invoke }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderEntry(id: number): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <VoucherEntry voucherId={id} />
    </QueryClientProvider>
  )
}

const mode = async (): Promise<string | null> =>
  (await screen.findByTestId('voucher-entry-mode', undefined, { timeout: 3000 })).getAttribute('data-mode')

describe('VoucherEntry alteration routing', () => {
  it('opens an invoice-built sales voucher in the invoice form with its lines', async () => {
    voucher = asVoucher(5, salesPayload())
    renderEntry(5)
    expect(await mode()).toBe('invoice')
    expect((screen.getAllByTestId('input-line-qty')[0] as HTMLInputElement).value).toBe('2')
    expect((screen.getAllByTestId('input-line-discount')[0] as HTMLInputElement).value).toBe('100.00')
    expect(screen.queryByTestId('banner-accounting-fallback')).toBeNull()
  })

  it('opens a sales voucher with no bill reference (empty due date) in the invoice form', async () => {
    voucher = { ...asVoucher(9, salesPayload()), billRefs: [] }
    renderEntry(9)
    expect(await mode()).toBe('invoice')
    expect((screen.getAllByTestId('input-line-qty')[0] as HTMLInputElement).value).toBe('2')
  })

  it('opens a sales voucher the invoice form cannot reproduce in accounting mode with a banner', async () => {
    const v = asVoucher(6, salesPayload())
    v.inventory[0]!.amount += 1 // e.g. an imported line whose amount ≠ qty × rate − discount
    voucher = v
    renderEntry(6)
    expect(await mode()).toBe('accounting')
    expect(await screen.findByTestId('banner-accounting-fallback')).toBeTruthy()
    // WP 2.3: the carried stock lines are listed, their godown / batch / serials editable.
    expect(await screen.findByText(/quantities and amounts are kept as saved/)).toBeTruthy()
    expect(within(screen.getByTestId('rows-carried-stock')).getAllByRole('row')).toHaveLength(1)
  })

  it('opens a godown transfer in the transfer form (WP 2.3), an arbitrary stock journal in the stock-lines editor, a count in physical mode', async () => {
    const base = asVoucher(7, salesPayload())
    const transfer: Voucher = {
      ...base, voucherTypeId: 3, partyLedgerId: null, lines: [], billRefs: [],
      inventory: [
        { id: 1, stockItemId: 101, godownId: 1, batchId: null, qtyMilli: 1000, ratePaise: 100, discountPaise: 0, amount: 100, direction: 'out', isAbsolute: false },
        { id: 2, stockItemId: 101, godownId: 2, batchId: null, qtyMilli: 1000, ratePaise: 100, discountPaise: 0, amount: 100, direction: 'in', isAbsolute: false }
      ]
    }
    voucher = transfer
    renderEntry(7)
    expect(await mode()).toBe('transfer')
    expect(await screen.findByTestId('rows-stock-transfer')).toBeTruthy()
    expect((screen.getAllByTestId('input-transfer-qty')[0] as HTMLInputElement).value).toBe('1')
    cleanup()

    voucher = { ...transfer, id: 17, inventory: [transfer.inventory[0]!, { ...transfer.inventory[1]!, amount: 90, ratePaise: 90 }] }
    renderEntry(17)
    expect(await mode()).toBe('stockLines')
    expect((await screen.findByTestId('banner-stock-lines-legacy')).textContent).toContain('Created before 0.6.0 — costed at the saved amounts')
    cleanup()

    voucher = {
      ...base, id: 8, voucherTypeId: 4, partyLedgerId: null, lines: [], billRefs: [],
      inventory: [{ id: 1, stockItemId: 101, godownId: null, batchId: null, qtyMilli: 4500, ratePaise: 0, discountPaise: 0, amount: 0, direction: 'in', isAbsolute: true }]
    }
    renderEntry(8)
    expect(await mode()).toBe('physical')
    await waitFor(() => expect((screen.getAllByTestId('input-counted-qty')[0] as HTMLInputElement).value).toBe('4.5'))
  })

  it('shows a year-end closing entry read-only: banner and a disabled form (WP 1.3)', async () => {
    voucher = { ...asVoucher(11, salesPayload()), isYearEndClose: true }
    renderEntry(11)
    const modeEl = await screen.findByTestId('voucher-entry-mode', undefined, { timeout: 3000 })
    expect(screen.getByTestId('year-end-close-banner').textContent).toMatch(/read-only/)
    expect((modeEl.closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true)
  })

  it('offers the closing entry\'s "Move to Bin" outside the disabled form (owner / no users)', async () => {
    voucher = { ...asVoucher(13, salesPayload()), isYearEndClose: true }
    act(() => useSession.setState({ user: null }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <VoucherEntry voucherId={13} />
        <DialogHost />
      </QueryClientProvider>
    )
    const modeEl = await screen.findByTestId('voucher-entry-mode', undefined, { timeout: 3000 })
    const bin = screen.getByTestId('btn-year-end-close-bin') as HTMLButtonElement
    expect(bin.closest('fieldset')).toBeNull()
    expect(bin.disabled).toBe(false)
    // The form itself stays read-only.
    expect((modeEl.closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true)
    fireEvent.click(bin)
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move to Bin' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('voucher:delete', { id: 13 }))
  })

  it.each([
    ['owner', 'owner', true],
    ['accountant', 'accountant', false],
    ['viewer', 'viewer', false]
  ] as const)('the closing entry\'s bin button for a signed-in %s: %s', async (_l, role, shown) => {
    voucher = { ...asVoucher(14, salesPayload()), isYearEndClose: true }
    act(() => useSession.setState({ user: { id: 1, name: 'U', role } }))
    renderEntry(14)
    await screen.findByTestId('voucher-entry-mode', undefined, { timeout: 3000 })
    expect(screen.queryByTestId('btn-year-end-close-bin') != null).toBe(shown)
    act(() => useSession.setState({ user: null }))
  })

  it('leaves ordinary vouchers editable', async () => {
    voucher = asVoucher(12, salesPayload())
    renderEntry(12)
    const modeEl = await screen.findByTestId('voucher-entry-mode', undefined, { timeout: 3000 })
    expect(screen.queryByTestId('year-end-close-banner')).toBeNull()
    expect((modeEl.closest('fieldset') as HTMLFieldSetElement).disabled).toBe(false)
  })
})

describe('Alt+F7 in voucher entry (WP 8.3)', () => {
  const withFeatures = (manufacturing: boolean | undefined): void => {
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, payload?: unknown) =>
      channel === 'config:features:get'
        ? { ok: true, data: { ...DEFAULT_FEATURES, ...(manufacturing === undefined ? {} : { manufacturing }) } }
        : base(channel, payload)
    )
  }
  const settle = (): Promise<void> =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })
  const renderNew = async (): Promise<void> => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <VoucherEntry />
      </QueryClientProvider>
    )
    await screen.findByTestId('voucher-entry-mode', undefined, { timeout: 3000 })
    await waitFor(() => expect(invoke.mock.calls.some((c) => c[0] === 'config:features:get')).toBe(true))
    await settle()
  }

  it('opens the manufacture form only while manufacturing is on', async () => {
    withFeatures(false)
    await renderNew()
    fireEvent.keyDown(window, { key: 'F7', altKey: true })
    await settle()
    expect(screen.queryByText('Manufacture (BOM)')).toBeNull()
    cleanup()
    withFeatures(undefined)
    await renderNew()
    fireEvent.keyDown(window, { key: 'F7', altKey: true })
    await waitFor(() => expect(screen.getByText('Manufacture (BOM)')).toBeTruthy())
  })
})
