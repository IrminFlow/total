// WP 2.2 — the Manufacture form against a mocked IPC bridge: live profit on every keystroke,
// BOM prefill scaled by quantity, the both-sides-match footer, Save disabled until the rules
// pass, the loss confirmation, and the exact manufacture:save payload.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { StockItem, VoucherType } from '@shared/domain'
import { ManufactureScreen } from '../screens/Manufacture'
import { DialogHost } from '../components/dialogs'
import { useSession } from '../state/stores'
import { hasUnsavedChanges } from '../lib/useUnsavedGuard'

const invoke = vi.fn()

const item = (id: number, name: string): StockItem => ({
  id, name, groupId: null, unitId: 1, hsn: null, gstRate: null, cessRate: null, openingQtyMilli: 0, openingValue: 0,
  barcode: null, reorderLevelMilli: null, valuationMethod: 'weighted_avg', trackSerials: false
})
const CHAIR = 1
const STEEL = 2
const PAINT = 3
const TABLE = 4
const ITEMS = [item(CHAIR, 'Chair'), item(STEEL, 'Steel'), item(PAINT, 'Paint'), item(TABLE, 'Table')]
/** Engine unit cost (paise per unit) the mocked costPreview charges. */
const UNIT_COST: Record<number, number> = { [STEEL]: 15000, [PAINT]: 40000, [TABLE]: 0 }
const TYPES: VoucherType[] = [
  { id: 9, name: 'Stock Journal', kind: 'stock_journal', numbering: 'auto', prefix: '', suffix: '', padWidth: 0, restartFy: true, isSystem: true }
]
let bom: { id: number; componentId: number; componentName: string; unitSymbol: string; qtyMilliPerUnit: number }[] = []
let saleRate: number | null = 100000
/** WP 2.4 tests set every item's versions directly. */
let versions: unknown[] | null = null
const saves: unknown[] = []

beforeEach(() => {
  saves.length = 0
  bom = []
  versions = null
  saleRate = 100000
  useSession.setState({
    slug: 'test',
    workingDate: '2025-06-10',
    info: { name: 'T', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '', booksFrom: 2025, email: null, phone: null, pan: null, tan: null }
  })
  invoke.mockImplementation(async (channel: string, payload: unknown) => {
    switch (channel) {
      case 'master:voucherTypes:list': return { ok: true, data: TYPES }
      case 'master:stockItems:list': return { ok: true, data: ITEMS }
      case 'master:units:list': return { ok: true, data: [{ id: 1, name: 'Numbers', symbol: 'nos', decimals: 0, uqc: 'NOS' }] }
      case 'master:godowns:list': return { ok: true, data: [] }
      case 'master:ledgers:list': return { ok: true, data: [] }
      case 'master:groups:list': return { ok: true, data: [] }
      case 'voucher:nextNumber': return { ok: true, data: { number: '12' } }
      case 'voucher:numberExists': return { ok: true, data: false }
      case 'bom:get': return { ok: true, data: bom }
      // WP 2.4: the screen explodes the versions itself — `bom` is the Chair's default version.
      case 'bom:versions': return { ok: true, data: versions ?? (bom.length ? [{ id: 50, itemId: CHAIR, name: 'v1', effectiveFrom: null, effectiveTo: null, isDefault: true, lines: bom.map((b) => ({ componentId: b.componentId, qtyMilliPerUnit: b.qtyMilliPerUnit, scrapPctBp: null })) }] : []) }
      case 'jobWork:sendChallans': return { ok: true, data: [] }
      case 'manufacture:costPreview': {
        const q = payload as { lines: { itemId: number; qtyMilli: number }[]; finishedItemId?: number | null }
        const lines = q.lines.map((l) => ({
          itemId: l.itemId, qtyMilli: l.qtyMilli, costPaise: Math.round((l.qtyMilli * (UNIT_COST[l.itemId] ?? 0)) / 1000),
          unitCostPaise: UNIT_COST[l.itemId] ?? 0, onHandQtyMilli: 10000
        }))
        return {
          ok: true,
          data: {
            lines, totalPaise: lines.reduce((s, l) => s + l.costPaise, 0),
            saleRate: q.finishedItemId ? { ratePaise: saleRate, source: saleRate == null ? null : 'sales' } : { ratePaise: null, source: null }
          }
        }
      }
      case 'manufacture:save': {
        saves.push(payload)
        return { ok: true, data: { id: 77, number: '12', warnings: { negativeStock: [] }, manufacture: { saleAmount: 200000, profitPaise: 90000 } } }
      }
      default: return { ok: false, error: `unmocked ${channel}` }
    }
  })
  window.total = { platform: 'test', invoke }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderScreen(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ManufactureScreen />
      <DialogHost />
    </QueryClientProvider>
  )
}

async function pick(testId: string, name: string): Promise<void> {
  const input = (await screen.findByTestId(testId)) as HTMLInputElement
  // The item list loads asynchronously — wait for the option before picking it.
  await waitFor(() => {
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: name } })
    expect(screen.getAllByRole('option').some((o) => o.textContent === name)).toBe(true)
  })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(input.value).toBe(name))
}
const type = (testId: string, value: string): void => {
  fireEvent.change(screen.getByTestId(testId), { target: { value } })
}
const text = (testId: string): string => screen.getByTestId(testId).textContent ?? ''
const saveBtn = (): HTMLButtonElement => screen.getByTestId('btn-save-manufacture') as HTMLButtonElement

describe('Manufacture screen', () => {
  it('shows one sale row and ten raw-material rows from the start; Save disabled while empty', async () => {
    renderScreen()
    await screen.findByTestId('manufacture-form')
    expect(screen.getAllByTestId('manufacture-raw-row')).toHaveLength(10)
    expect(screen.getByTestId('manufacture-sale').querySelectorAll('tbody tr')).toHaveLength(1)
    expect(text('manufacture-raw-cost-0')).toBe('–')
    expect(saveBtn().disabled).toBe(true)
    expect(text('manufacture-issue')).toMatch(/Pick the item being manufactured/)
    // A pristine form (suggested number, working date) holds no unsaved changes.
    await waitFor(() => expect((screen.getByTestId('input-manufacture-number') as HTMLInputElement).value).toBe('12'))
    expect(hasUnsavedChanges()).toBe(false)
    type('input-manufacture-qty', '1')
    expect(hasUnsavedChanges()).toBe(true)
  })

  it('recalculates profit on every keystroke, prefills the average price, and matches both sides', async () => {
    renderScreen()
    await pick('picker-manufacture-item', 'Chair')
    type('input-manufacture-qty', '2')
    // Average price prefilled from the server's suggested selling rate (₹1,000).
    await waitFor(() => expect((screen.getByTestId('input-manufacture-sale-rate') as HTMLInputElement).value).toBe('1,000.00'))
    await waitFor(() => expect(text('manufacture-left-total')).toContain('2,000.00'))

    await pick('picker-manufacture-raw-0', 'Steel')
    type('input-manufacture-raw-qty-0', '4')
    await waitFor(() => expect(text('manufacture-raw-amount-0')).toContain('600.00'))
    expect(text('manufacture-raw-cost-0')).toBe('150.00')
    await waitFor(() => expect(text('manufacture-profit')).toContain('1,400.00'))

    await pick('picker-manufacture-raw-1', 'Paint')
    type('input-manufacture-raw-qty-1', '0.5')
    type('input-manufacture-labour', '300')
    await waitFor(() => expect(text('manufacture-production-cost')).toContain('1,100.00'))
    expect(text('manufacture-profit')).toContain('900.00')
    expect(text('manufacture-right-total')).toContain('2,000.00')
    expect(screen.getByTestId('manufacture-match').getAttribute('data-match')).toBe('true')
    expect(saveBtn().disabled).toBe(false)

    // Editing the price moves profit immediately.
    type('input-manufacture-sale-rate', '400')
    await waitFor(() => expect(text('manufacture-profit')).toContain('-300.00'))
    expect(screen.getByTestId('manufacture-profit').getAttribute('data-negative')).toBe('true')
    expect(screen.getByTestId('manufacture-profit').className).toContain('text-danger')
  })

  it('saves the exact payload; a loss asks for confirmation first', async () => {
    renderScreen()
    await pick('picker-manufacture-item', 'Chair')
    type('input-manufacture-qty', '2')
    await pick('picker-manufacture-raw-0', 'Steel')
    type('input-manufacture-raw-qty-0', '4')
    type('input-manufacture-labour', '300')
    await waitFor(() => expect(text('manufacture-profit')).toContain('1,100.00'))
    await act(async () => fireEvent.click(saveBtn()))
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]).toEqual({
      data: {
        voucherTypeId: 9, date: '2025-06-10', number: '12', narration: null, godownId: null, finishedItemId: CHAIR, qtyMilli: 2000,
        saleRatePaise: 100000, raw: [{ stockItemId: STEEL, qtyMilli: 4000 }], labourPaise: 30000, labourPosted: true,
        labourCreditLedgerId: null, profitPaise: 110000
      },
      id: undefined
    })
    // The form resets for the next voucher — amounts cleared, nothing left "unsaved".
    await waitFor(() => expect((screen.getByTestId('input-manufacture-qty') as HTMLInputElement).value).toBe(''))
    expect((screen.getByTestId('input-manufacture-labour') as HTMLInputElement).value).toBe('')
    expect(hasUnsavedChanges()).toBe(false)

    saleRate = 10000 // ₹100 — a loss
    await pick('picker-manufacture-item', 'Chair')
    type('input-manufacture-qty', '1')
    await pick('picker-manufacture-raw-0', 'Steel')
    type('input-manufacture-raw-qty-0', '2')
    await waitFor(() => expect(text('manufacture-profit')).toContain('-200.00'))
    await act(async () => fireEvent.click(saveBtn()))
    expect(await screen.findByText(/Save anyway\?/)).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByTestId('confirm-ok')))
    await waitFor(() => expect(saves).toHaveLength(2))
    expect((saves[1] as { data: { confirmLoss?: boolean; profitPaise: number } }).data).toMatchObject({ confirmLoss: true, profitPaise: -20000 })
  })

  it('prefills raw rows from the BOM scaled by quantity, and they stay editable', async () => {
    bom = [
      { id: 1, componentId: STEEL, componentName: 'Steel', unitSymbol: 'nos', qtyMilliPerUnit: 2000 },
      { id: 2, componentId: PAINT, componentName: 'Paint', unitSymbol: 'nos', qtyMilliPerUnit: 250 }
    ]
    renderScreen()
    await pick('picker-manufacture-item', 'Chair')
    await waitFor(() => expect((screen.getByTestId('input-manufacture-raw-qty-0') as HTMLInputElement).value).toBe('2'))
    expect((screen.getByTestId('picker-manufacture-raw-0') as HTMLInputElement).value).toBe('Steel')
    expect((screen.getByTestId('input-manufacture-raw-qty-1') as HTMLInputElement).value).toBe('0.25')
    type('input-manufacture-qty', '3')
    await waitFor(() => expect((screen.getByTestId('input-manufacture-raw-qty-0') as HTMLInputElement).value).toBe('6'))
    expect((screen.getByTestId('input-manufacture-raw-qty-1') as HTMLInputElement).value).toBe('0.75')
    expect(screen.getAllByTestId('manufacture-raw-row')).toHaveLength(10)
    // An edit wins: a later quantity change no longer rescales.
    type('input-manufacture-raw-qty-1', '1')
    type('input-manufacture-qty', '4')
    await waitFor(() => expect(text('manufacture-left-total')).toContain('4,000.00'))
    expect((screen.getByTestId('input-manufacture-raw-qty-0') as HTMLInputElement).value).toBe('6')
    expect((screen.getByTestId('input-manufacture-raw-qty-1') as HTMLInputElement).value).toBe('1')
  })

  it('blocks a raw material equal to the finished item and duplicates, with the reason shown', async () => {
    renderScreen()
    await pick('picker-manufacture-item', 'Chair')
    type('input-manufacture-qty', '1')
    await pick('picker-manufacture-raw-0', 'Chair')
    type('input-manufacture-raw-qty-0', '1')
    await waitFor(() => expect(text('manufacture-issue')).toMatch(/can't be a raw material of itself/))
    expect(saveBtn().disabled).toBe(true)
    await pick('picker-manufacture-raw-0', 'Steel')
    await pick('picker-manufacture-raw-1', 'Steel')
    type('input-manufacture-raw-qty-1', '1')
    await waitFor(() => expect(text('manufacture-issue')).toMatch(/combine them into one row/))
    expect(saveBtn().disabled).toBe(true)
  })

  it('rows can be added past ten; "already booked" hides the credit account', async () => {
    renderScreen()
    await screen.findByTestId('manufacture-form')
    fireEvent.click(screen.getByTestId('btn-manufacture-add-row'))
    expect(screen.getAllByTestId('manufacture-raw-row')).toHaveLength(11)
    expect(screen.getByTestId('picker-manufacture-labour-credit')).toBeTruthy()
    fireEvent.click(screen.getByTestId('input-manufacture-labour-booked'))
    expect(screen.queryByTestId('picker-manufacture-labour-credit')).toBeNull()
  })
})

describe('Alt+F7 — the Manufacture key', () => {
  it('is Manufacture, not Journal; plain F7 stays Journal', async () => {
    const { isManufactureKey, kindForVoucherKey } = await import('../lib/voucherKeys')
    expect(isManufactureKey({ key: 'F7', altKey: true, ctrlKey: false })).toBe(true)
    expect(isManufactureKey({ key: 'F7', altKey: false, ctrlKey: true })).toBe(true)
    expect(kindForVoucherKey({ key: 'F7', altKey: true, ctrlKey: false })).toBeNull()
    expect(kindForVoucherKey({ key: 'F7', altKey: false, ctrlKey: false })).toBe('journal')
    expect(isManufactureKey({ key: 'F8', altKey: true, ctrlKey: false })).toBe(false)
  })
})

describe('Ctrl / Alt + F8 / F9 — split (WP 2.5d, design §9 Q10)', () => {
  it('Ctrl is the credit / debit note; Alt the delivery / receipt note, only with stock notes on', async () => {
    const { kindForVoucherKey } = await import('../lib/voucherKeys')
    const k = (key: string, mods: { ctrlKey?: boolean; altKey?: boolean }, stockNotes: boolean) =>
      kindForVoucherKey({ key, ctrlKey: !!mods.ctrlKey, altKey: !!mods.altKey }, { stockNotes })
    for (const on of [true, false]) {
      expect(k('F8', { ctrlKey: true }, on)).toBe('credit_note')
      expect(k('F9', { ctrlKey: true }, on)).toBe('debit_note')
      expect(k('F8', { ctrlKey: true, altKey: true }, on)).toBe('credit_note')
      expect(k('F8', {}, on)).toBe('sales')
      expect(k('F9', {}, on)).toBe('purchase')
      expect(k('F5', { altKey: true }, on)).toBe('payment')
    }
    expect(k('F8', { altKey: true }, true)).toBe('delivery_note')
    expect(k('F9', { altKey: true }, true)).toBe('receipt_note')
    expect(k('F8', { altKey: true }, false)).toBeNull()
    expect(k('F9', { altKey: true }, false)).toBeNull()
  })
})
