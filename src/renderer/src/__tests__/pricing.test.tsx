// WP 2.6 — the invoice grid's automatic pricing (source hint, explanation popover, a typed rate
// is never overridden, reset to the price list) and the Counter billing keyboard flow (scan →
// increment → ↑ / + / − → edit a cell → F5 cash → F9 → the exact checkout payload), against a
// mocked IPC bridge.
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Group, Ledger, StockItem } from '@shared/domain'
import type { PriceResult } from '@shared/pricing'
import { DEFAULT_FEATURES } from '@shared/features'
import { ItemLineGrid, blankItemRow, type ItemRow } from '../screens/voucher/ItemLineGrid'
import { CounterBillingScreen, parseDiscount, parseScan } from '../screens/CounterBilling'
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
const LEDGERS: Ledger[] = [ledger(10, 'Cash sale', 1), ledger(11, 'Umbrella Retail', 1), ledger(20, 'Sales', 2)]
const item = (id: number, name: string, gstRate: number, barcode: string | null): StockItem => ({
  id, name, groupId: null, unitId: 1, hsn: '4820', gstRate, cessRate: null, openingQtyMilli: 0, openingValue: 0, barcode,
  reorderLevelMilli: null, valuationMethod: 'weighted_avg', trackSerials: false
})
const ITEMS: StockItem[] = [item(100, 'Gel Pen', 18, '8901'), item(101, 'Notebook', 5, '8902')]

/** The mocked resolver: pens ₹10 at the default level; notebooks ₹50, 10% off from qty 2. */
function priced(itemId: number, qtyMilli: number): PriceResult {
  if (itemId === 100) {
    return { ratePaise: 1000, discountBp: 0, discountPaise: 0, freeQtyMilli: 0, source: 'default_level', label: 'Level: Retail', inclusive: null, explanation: ['Default level Retail: ₹10.00'] }
  }
  const bp = qtyMilli >= 2000 ? 1000 : 0
  return {
    ratePaise: 5000, discountBp: bp, discountPaise: Math.round((qtyMilli * 5000 * bp) / 1000 / 10000), freeQtyMilli: 0,
    source: bp ? 'scheme' : 'default_level', label: bp ? 'Scheme: Notebooks 2+' : 'Level: Retail', inclusive: null,
    explanation: bp ? ['Base: Default level Retail: ₹50.00', 'Scheme Notebooks 2+: qty ≥ 2: 10% off'] : ['Default level Retail: ₹50.00']
  }
}

const resolveCalls: { lines: { key: number; itemId: number; qtyMilli: number }[]; partyLedgerId: number | null }[] = []
const checkouts: unknown[] = []

beforeEach(() => {
  resolveCalls.length = 0
  checkouts.length = 0
  useSession.setState({
    slug: 'test',
    workingDate: '2025-10-07',
    info: { name: 'T', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '', booksFrom: 2025, email: null, phone: null, pan: null, tan: null }
  })
  invoke.mockImplementation(async (channel: string, payload: unknown) => {
    switch (channel) {
      case 'config:features:get': return { ok: true, data: DEFAULT_FEATURES }
      case 'master:ledgers:list': return { ok: true, data: LEDGERS }
      case 'master:groups:list': return { ok: true, data: GROUPS }
      case 'master:stockItems:list': return { ok: true, data: ITEMS }
      case 'master:units:list': return { ok: true, data: [{ id: 1, name: 'Numbers', symbol: 'Nos', decimals: 0, uqc: 'NOS' }] }
      case 'master:godowns:list': return { ok: true, data: [] }
      case 'master:batches:list': return { ok: true, data: [] }
      case 'pricing:config': return { ok: true, data: { autoApply: true, rememberLastPrice: false } }
      case 'pricing:resolve': {
        const q = payload as { lines: { key: number; itemId: number; qtyMilli: number }[]; partyLedgerId: number | null }
        resolveCalls.push(q)
        return { ok: true, data: q.lines.map((l) => ({ ...l, result: priced(l.itemId, l.qtyMilli) })) }
      }
      case 'counter:config':
        return {
          ok: true,
          data: {
            config: { walkInLedgerId: null, salesLedgerId: null, voucherTypeId: null, receiptTypeId: null, cashLedgerId: null, upiLedgerId: null, cardLedgerId: null, godownId: null, templateId: 'receipt-80mm', autoPrint: false },
            accounts: { walkInLedgerId: 10, salesLedgerId: 20, voucherTypeId: 1, receiptTypeId: 2, cashLedgerId: 30, upiLedgerId: 31, cardLedgerId: 31 }
          }
        }
      case 'voucher:nextNumber': return { ok: true, data: { number: 'CS-7' } }
      case 'counter:checkout':
        checkouts.push(payload)
        return { ok: true, data: { invoiceId: 50, invoiceNumber: 'CS-7', totalPaise: 12000, receiptId: 51, receiptNumber: 'R-3', paidPaise: 12000, balancePaise: 0, changePaise: 0, negativeStock: [] } }
      default: return { ok: false, error: `unmocked ${channel}` }
    }
  })
  window.total = { platform: 'test', invoke }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const client = (): QueryClient => new QueryClient({ defaultOptions: { queries: { retry: false } } })

function GridHarness(): React.JSX.Element {
  const [rows, setRows] = useState<ItemRow[]>([blankItemRow()])
  const setRow = (i: number, patch: Partial<ItemRow>): void =>
    setRows((rs) => {
      const next = rs.map((r, j) => (j === i ? { ...r, ...patch } : r))
      return next[next.length - 1]!.itemId != null ? [...next, blankItemRow()] : next
    })
  return (
    <ItemLineGrid
      rows={rows}
      setRow={setRow}
      setRows={setRows}
      direction="out"
      priceLevelId={null}
      fxActive={false}
      date="2025-10-07"
      onCreateItem={() => {}}
      stockDetail={false}
      pricing={{ enabled: true, autoApply: true, partyId: 11, date: '2025-10-07', supply: 'intra', currency: '' }}
    />
  )
}

async function pickItem(name: string): Promise<void> {
  const input = (await screen.findAllByTestId('picker-item'))[0] as HTMLInputElement
  await waitFor(() => {
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: name } })
    expect(screen.getAllByRole('option').some((o) => o.textContent?.startsWith(name))).toBe(true)
  })
  fireEvent.keyDown(input, { key: 'Enter' })
}

describe('invoice grid pricing (WP 2.6)', () => {
  it('fills the rate from the resolver, shows its source, and re-prices when the qty crosses a slab', async () => {
    render(<QueryClientProvider client={client()}><GridHarness /></QueryClientProvider>)
    await pickItem('Notebook')
    await waitFor(() => expect((screen.getAllByTestId('input-line-rate')[0] as HTMLInputElement).value).toBe('50.00'))
    expect(screen.getByTestId('line-price-hint').textContent).toBe('Level: Retail')
    expect(resolveCalls[0]).toMatchObject({ partyLedgerId: 11, lines: [{ itemId: 101, qtyMilli: 0 }] })
    fireEvent.change(screen.getAllByTestId('input-line-qty')[0]!, { target: { value: '3' } })
    await waitFor(() => expect(screen.getByTestId('line-price-hint').textContent).toBe('Scheme: Notebooks 2+'))
    expect((screen.getAllByTestId('input-line-discount')[0] as HTMLInputElement).value).toBe('15.00')
    // The explanation popover.
    fireEvent.click(screen.getByTestId('line-price-hint'))
    expect((await screen.findByTestId('line-price-explanation')).textContent).toContain('qty ≥ 2: 10% off')
  })

  it('never overrides a typed rate; "Use the price list again" hands the line back', async () => {
    render(<QueryClientProvider client={client()}><GridHarness /></QueryClientProvider>)
    await pickItem('Gel Pen')
    await waitFor(() => expect((screen.getAllByTestId('input-line-rate')[0] as HTMLInputElement).value).toBe('10.00'))
    fireEvent.change(screen.getAllByTestId('input-line-rate')[0]!, { target: { value: '12' } })
    await waitFor(() => expect(screen.getByTestId('line-price-hint').textContent).toBe('Manual'))
    const calls = resolveCalls.length
    fireEvent.change(screen.getAllByTestId('input-line-qty')[0]!, { target: { value: '5' } })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(resolveCalls.length).toBe(calls) // a manual line is never re-priced
    expect((screen.getAllByTestId('input-line-rate')[0] as HTMLInputElement).value).toBe('12')
    fireEvent.click(screen.getByTestId('line-price-hint'))
    fireEvent.click(await screen.findByTestId('btn-line-price-reset'))
    await waitFor(() => expect((screen.getAllByTestId('input-line-rate')[0] as HTMLInputElement).value).toBe('10.00'))
    expect(screen.getByTestId('line-price-hint').textContent).toBe('Level: Retail')
  })
})

describe('counter billing (WP 2.6)', () => {
  it('parses "3*code" multipliers and "10%" discounts', () => {
    expect(parseScan('3*8901')).toEqual({ qtyMilli: 3000, code: '8901' })
    expect(parseScan('2.5 * ')).toEqual({ qtyMilli: 2500, code: '' })
    expect(parseScan('8901')).toEqual({ qtyMilli: null, code: '8901' })
    expect(parseDiscount('10%', 20000)).toBe(2000)
    expect(parseDiscount('15', 20000)).toBe(1500)
    expect(parseDiscount('500', 20000)).toBe(20000) // capped at the gross
    expect(parseDiscount('x', 20000)).toBeNull()
  })

  it('keyboard only: scan, scan again, ↑ + −, edit the rate, F5 cash, F9 — and the focus stays in the search box', async () => {
    render(<QueryClientProvider client={client()}><CounterBillingScreen /></QueryClientProvider>)
    const search = (await screen.findByTestId('input-counter-search')) as HTMLInputElement
    await waitFor(() => expect(screen.getByTestId('counter-next-number').textContent).toBe('CS-7'))
    const scan = async (code: string): Promise<void> => {
      await waitFor(() => {
        fireEvent.change(search, { target: { value: code } })
        expect(screen.queryAllByRole('option').length).toBeGreaterThan(0) // items loaded
      })
      fireEvent.keyDown(search, { key: 'Enter' })
    }
    const lines = (): HTMLElement[] => screen.queryAllByTestId('counter-line')
    const cellText = (row: number, f: string): string => lines()[row]!.querySelector(`[data-testid="counter-cell-${f}"]`)!.textContent ?? ''

    await scan('8901')
    await waitFor(() => expect(cellText(0, 'rate')).toBe('10.00'))
    await scan('8902')
    await waitFor(() => expect(lines()).toHaveLength(2))
    await scan('8902') // the same item: one more on its line, re-priced past the slab
    await waitFor(() => expect(cellText(1, 'qty')).toMatch(/^2/))
    await waitFor(() => expect(cellText(1, 'disc')).toBe('10.00'))
    expect(lines()[1]!.textContent).toContain('Scheme: Notebooks 2+')

    // ↑ to the pen, + twice, − once → 2.
    fireEvent.keyDown(search, { key: 'ArrowUp' })
    expect(lines()[0]!.getAttribute('data-active')).toBe('true')
    fireEvent.keyDown(search, { key: '+' })
    fireEvent.keyDown(search, { key: '+' })
    fireEvent.keyDown(search, { key: '-' })
    await waitFor(() => expect(cellText(0, 'qty')).toMatch(/^2/))

    // → to Rate, Enter edits it, type 12, Enter: a manual rate.
    fireEvent.keyDown(search, { key: 'ArrowRight' })
    fireEvent.keyDown(search, { key: 'Enter' })
    const edit = (await screen.findByTestId('input-counter-edit-rate')) as HTMLInputElement
    fireEvent.change(edit, { target: { value: '12' } })
    fireEvent.keyDown(edit, { key: 'Enter' })
    await waitFor(() => expect(cellText(0, 'rate')).toBe('12.00'))
    expect(lines()[0]!.textContent).toContain('Manual')
    await waitFor(() => expect(document.activeElement).toBe(search))

    // Pens 2 × 12 = 24 + 18% = 28.32; notebooks 2 × 50 − 10 = 90 + 5% = 94.50 → 122.82 → ₹123.
    await waitFor(() => expect(screen.getByTestId('counter-total').textContent).toBe('₹123.00'))
    fireEvent.keyDown(window, { key: 'F5' })
    const cash = (await screen.findByTestId('input-counter-pay-cash')) as HTMLInputElement
    await waitFor(() => expect(cash.value).toBe('123.00'))
    fireEvent.keyDown(window, { key: 'F9' })
    await waitFor(() => expect(checkouts).toHaveLength(1))
    expect(checkouts[0]).toEqual({
      date: '2025-10-07',
      partyLedgerId: null,
      lines: [
        { itemId: 100, qtyMilli: 2000, ratePaise: 1200, discountPaise: 0 },
        { itemId: 101, qtyMilli: 2000, ratePaise: 5000, discountPaise: 1000 }
      ],
      payments: [{ mode: 'cash', amountPaise: 12300 }],
      tenderedPaise: 12300
    })
    await screen.findByTestId('counter-last-sale')
    expect(lines()).toHaveLength(0)
    await waitFor(() => expect(document.activeElement).toBe(search))
  })

  it('a walk-in bill must be paid in full before F9 completes it', async () => {
    render(<QueryClientProvider client={client()}><CounterBillingScreen /></QueryClientProvider>)
    const search = (await screen.findByTestId('input-counter-search')) as HTMLInputElement
    await waitFor(() => {
      fireEvent.change(search, { target: { value: '8901' } })
      expect(screen.queryAllByRole('option').length).toBeGreaterThan(0)
    })
    fireEvent.keyDown(search, { key: 'Enter' })
    await waitFor(() => expect(screen.getByTestId('counter-total').textContent).toBe('₹12.00'))
    fireEvent.keyDown(window, { key: 'F5' })
    const cash = (await screen.findByTestId('input-counter-pay-cash')) as HTMLInputElement
    fireEvent.change(cash, { target: { value: '5' } })
    expect((await screen.findByTestId('counter-pay-issue')).textContent).toContain('still to pay')
    expect((screen.getByTestId('btn-counter-complete') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(window, { key: 'F9' })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(checkouts).toHaveLength(0)
  })
})
