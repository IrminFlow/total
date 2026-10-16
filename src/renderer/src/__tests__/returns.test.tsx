// WP 9.5 — Return a sale / Return a purchase (simple/returns): the bill list (what is still
// returnable), a bill's products with what is left, the live total from the editor's calculation,
// "Give the money back, or keep it" only for the part that is a credit, the plain preview from
// simple:preview, Save → simple:post (the intent's shape) → the save card; refusals sit under
// their question; an amount-only bill for an unregistered shop has no GST anywhere; the Sales
// bill view starts a return from that bill. No banned word on any of it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CompanyInfo, Ledger } from '@shared/domain'
import { DEFAULT_FEATURES } from '@shared/features'
import type { IntentFacts, SimplePostResult, SimplePreview } from '@shared/simple/intents'
import type { ReturnBill, ReturnBillRow } from '@shared/simple/returns'
import type { SaleView, SellSetup } from '@shared/simple/sell'
import { bannedWordsIn } from '@shared/simple/bannedWords'
import { useNav, useSession } from '../state/stores'
import { ReturnSale } from '../simple/returns/ReturnSale'
import { ReturnPurchase } from '../simple/returns/ReturnPurchase'
import { SalesList } from '../simple/sell/SalesList'
import { PurchaseList } from '../simple/buy/PurchaseList'
import type { PurchaseView } from '@shared/simple/buy'

const invoke = vi.fn()
const ledger = (id: number, name: string, groupId: number, extra: Partial<Ledger> = {}): Ledger =>
  ({ id, name, groupId, openingBalance: 0, gstin: null, stateCode: '27', address: null, taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null, isSystem: false, ...extra }) as Ledger
const LEDGERS = [ledger(10, 'Ramesh', 2), ledger(12, 'Cash sale', 2), ledger(20, 'Sales', 5), ledger(30, 'Cash', 1), ledger(31, 'HDFC Bank', 1), ledger(40, 'Bharat Steel', 3)]
const ITEMS = [
  { id: 1, name: 'Sugar 1kg', unitId: 4, gstRate: 18, cessRate: null, barcode: null },
  { id: 2, name: 'Tea 250g', unitId: 4, gstRate: 5, cessRate: null, barcode: null }
]
let setup: SellSetup
const ROWS: ReturnBillRow[] = [
  { voucherId: 7, number: '3', billNo: null, date: '2026-10-12', partyId: 10, partyName: 'Ramesh', walkIn: false, total: 118_000, mode: 'items', returns: 1, returned: 11_800, left: 'part' },
  { voucherId: 8, number: '4', billNo: null, date: '2026-10-13', partyId: 12, partyName: 'Cash sale', walkIn: true, total: 50_000, mode: 'amount', returns: 0, returned: 0, left: 'all' }
]
const itemsBill = (over: Partial<ReturnBill> = {}): ReturnBill => ({
  voucherId: 7, side: 'sale', number: '3', billNo: null, date: '2026-10-12', partyId: 10, partyName: 'Ramesh', partyStateCode: '27', walkIn: false,
  total: 118_000, tax: 18_000, billName: '3', pending: 0, carriesGst: true, rates: [18], accountId: 20, mode: 'items',
  lines: [
    { lineUid: 'u-1', itemId: 1, qtyMilli: 2000, ratePaise: 50_000, discountPaise: 0, godownId: null, batchId: null, leftMilli: 1000, name: 'Sugar 1kg', unit: 'Pcs', amount: 100_000 }
  ],
  amountTaxable: 0, amountLeft: null, earlier: [{ voucherId: 9, number: '1', date: '2026-10-12', total: 59_000 }], ...over
})
const amountBill = (over: Partial<ReturnBill> = {}): ReturnBill => ({
  ...itemsBill(), voucherId: 8, number: '4', partyId: 12, partyName: 'Cash sale', walkIn: true, total: 50_000, tax: 0, billName: '4', pending: 0, carriesGst: false, rates: [0],
  mode: 'amount', lines: [], amountTaxable: 50_000, amountLeft: 50_000, earlier: [], ...over
})
let bill: ReturnBill
const FACTS: IntentFacts = {
  kind: 'return_sale', partyName: 'Ramesh', total: 59_000, tax: 9_000, paid: 59_000, how: 'upi', moneyAccount: 'HDFC Bank', due: 0, settled: [], advance: 0,
  fromName: null, toName: null, againstBill: null, offBill: 0, credit: 59_000, walkIn: false, balance: 0, noGst: null, side: 'customer'
}
let postReply: () => { ok: boolean; data?: unknown; error?: string; code?: string; field?: string; params?: Record<string, unknown> }
const calls = (ch: string): unknown[] => invoke.mock.calls.filter(([c]) => c === ch).map(([, p]) => p)
const info = (gstRegistrationType: CompanyInfo['gstRegistrationType']): CompanyInfo => ({
  name: 'Sharma Kirana', stateCode: '27', gstin: gstRegistrationType === 'unregistered' ? null : '27AAACT1234A1Z5', gstRegistrationType,
  address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null
})

function renderUi(ui: React.JSX.Element): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  bill = itemsBill()
  setup = {
    walkInId: 12, customers: [{ id: 10, name: 'Ramesh', stateCode: '27', phone: null, creditHold: false }],
    moneyAccounts: [{ id: 30, name: 'Cash', kind: 'cash' }, { id: 31, name: 'HDFC Bank', kind: 'bank' }],
    defaults: { cash: 30, upi: 31, card: 31, bank: 31 }, memoryId: null, salesAccountId: 20
  }
  postReply = () => ({ ok: true, data: { voucherIds: [21, 22], entries: [], replayed: false, summary: { entries: [], parties: [], undo: { undoable: true, reason: null } }, sentences: [], facts: FACTS, warnings: { negativeStock: [], creditLimitExceeded: null } } satisfies SimplePostResult })
  invoke.mockImplementation(async (channel: string) => {
    switch (channel) {
      case 'master:ledgers:list': return { ok: true, data: LEDGERS }
      case 'master:stockItems:list': return { ok: true, data: ITEMS }
      case 'master:groups:list': return { ok: true, data: [] }
      case 'config:features:get': return { ok: true, data: DEFAULT_FEATURES }
      case 'simple:sell:setup': return { ok: true, data: setup }
      case 'simple:returns:bills': return { ok: true, data: ROWS }
      case 'simple:returns:bill': return { ok: true, data: bill }
      case 'simple:preview': return { ok: true, data: { kind: 'return_sale', sentences: [], facts: FACTS, entries: [], warnings: { negativeStock: [], creditLimitExceeded: null } } satisfies SimplePreview }
      case 'simple:post': return postReply()
      case 'voucher:saveSummary': return { ok: true, data: { entries: [{ voucherId: 21, kind: 'credit_note', number: '2', date: '2026-10-13', amount: 59_000, money: null }], parties: [], undo: { undoable: true, reason: null } } }
      default: return { ok: true, data: [] }
    }
  })
  window.total = { platform: 'test', invoke }
  act(() => {
    useSession.setState({ info: info('regular'), slug: 'sharma', ui: { mode: 'simple' }, workingDate: '2026-10-13', from: '2026-04-01', to: '2027-03-31' })
    useNav.setState({ stack: [{ name: 'simple-return-sale' }] })
  })
})
afterEach(() => {
  cleanup()
  invoke.mockReset()
  localStorage.clear()
})

const click = (id: string): void => void fireEvent.click(screen.getByTestId(id))
const text = (id: string): string => screen.getByTestId(id).textContent ?? ''
const typeIn = (id: string, value: string): void => void fireEvent.change(screen.getByTestId(id), { target: { value } })
const visibleText = (): string => document.body.textContent ?? ''
const lastScreen = (): unknown => useNav.getState().stack.at(-1)
async function openBill(id: number): Promise<void> {
  const row = await waitFor(() => {
    const r = document.querySelector(`[data-row-id="${id}"]`)
    expect(r).toBeTruthy()
    return r as HTMLElement
  })
  fireEvent.click(row)
  await screen.findByTestId('return-bill')
}

describe('Return a sale (WP 9.5)', () => {
  it('the bill list: what came back and what is left; a row opens that bill', async () => {
    renderUi(<ReturnSale />)
    await openBill(7)
    expect(calls('simple:returns:bills')[0]).toMatchObject({ side: 'sale', today: '2026-10-13' })
    expect(text('return-bill-head')).toBe('Bill 3 · Ramesh · 12 Oct 2026')
    expect(text('return-bill-earlier')).toBe('Returned once before: ₹590.00.')
    expect(bannedWordsIn(visibleText())).toEqual([])
  })

  it('an empty Save puts the problem under the products; nothing posted', async () => {
    renderUi(<ReturnSale billId={7} />)
    await screen.findByTestId('return-bill')
    await waitFor(() => expect((screen.getByTestId('btn-return-save') as HTMLButtonElement).disabled).toBe(false))
    click('btn-return-save')
    expect((await screen.findByTestId('field-error-items')).textContent).toContain('Type how many came back')
    typeIn('input-return-qty-0', '2')
    click('btn-return-save')
    expect((await screen.findByTestId('field-error-items')).textContent).toContain('more than is left')
    expect(calls('simple:post')).toHaveLength(0)
  })

  it('products: the editor’s total; a paid bill asks refund or credit; Save posts the intent and shows the save card', async () => {
    renderUi(<ReturnSale billId={7} />)
    await screen.findByTestId('return-bill')
    // Only one left of the two sold.
    expect(text('return-line-0')).toContain('1 Pcs came back before')
    click('btn-return-all-0')
    await waitFor(() => expect(screen.getByTestId('return-total').getAttribute('data-paise')).toBe('59000'))
    expect(screen.getByTestId('return-tax').getAttribute('data-paise')).toBe('9000')
    expect(screen.getByTestId('return-line-amount-0').getAttribute('data-paise')).toBe('50000')
    // A paid bill: all of it is a credit → refund or keep.
    expect(screen.getByTestId('return-settle')).toBeTruthy()
    expect(screen.queryByTestId('return-off-bill')).toBeNull()
    click('return-settle-refund')
    click('return-how-upi')
    expect((screen.getByTestId('select-return-account') as HTMLSelectElement).value).toBe('31')
    await waitFor(() => expect(text('return-preview')).toContain('₹590.00 paid back by UPI.'))
    expect(bannedWordsIn(visibleText())).toEqual([])
    typeIn('input-return-reason', 'Damaged')
    click('btn-return-save')
    await screen.findByTestId('save-card')
    const sent = calls('simple:post')[0] as { intent: Record<string, unknown> }
    expect(sent.intent).toMatchObject({ kind: 'return_sale', billId: 7, date: '2026-10-13', narration: 'Damaged', items: [{ lineUid: 'u-1', qty: 1000 }], refund: { how: 'upi', accountId: 31 } })
  })

  it('an unpaid bill: the return simply comes off it — no refund question, none sent', async () => {
    bill = itemsBill({ pending: 118_000 })
    renderUi(<ReturnSale billId={7} />)
    await screen.findByTestId('return-bill')
    expect(text('return-bill-facts')).toContain('₹1,180.00 still due on it')
    typeIn('input-return-qty-0', '1')
    await waitFor(() => expect(text('return-off-bill')).toContain('Bill 3 was not paid yet'))
    expect(screen.queryByTestId('return-settle')).toBeNull()
    click('btn-return-save')
    await screen.findByTestId('save-card')
    expect((calls('simple:post')[0] as { intent: Record<string, unknown> }).intent.refund).toBeUndefined()
  })

  it('part due: says what comes off the bill and how much the question is about (review fix)', async () => {
    bill = itemsBill({ pending: 30_000 })
    renderUi(<ReturnSale billId={7} />)
    await screen.findByTestId('return-bill')
    typeIn('input-return-qty-0', '1')
    await waitFor(() => expect(text('return-off-bill')).toBe('₹300.00 comes off bill 3 (it was still due). For the other ₹290.00:'))
    expect(screen.getByTestId('return-settle')).toBeTruthy()
  })

  it('a refusal from main sits under its question', async () => {
    postReply = () => ({ ok: false, error: 'Only 0.5 left to return on this line', code: 'simple_return_qty', field: 'items.0.qty', params: { qty: '0.5' } })
    renderUi(<ReturnSale billId={7} />)
    await screen.findByTestId('return-bill')
    typeIn('input-return-qty-0', '1')
    await waitFor(() => expect(screen.getByTestId('return-total').getAttribute('data-paise')).toBe('59000'))
    click('btn-return-save')
    expect((await screen.findByTestId('field-error-items')).textContent).toContain('Only 0.5 is left to return on this line.')
  })

  it('a bill whose GST rates changed since: no products to tick, the accountant view instead', async () => {
    bill = itemsBill({ rates: null })
    renderUi(<ReturnSale billId={7} />)
    await screen.findByTestId('return-rates-changed')
    expect(screen.queryByTestId('input-return-qty-0')).toBeNull()
    expect((screen.getByTestId('btn-return-save') as HTMLButtonElement).disabled).toBe(true)
    click('btn-return-accountant-view')
    await waitFor(() => expect(lastScreen()).toEqual({ name: 'voucher-entry', kindHint: 'credit_note' }))
  })

  it('everything already came back: says so, nothing to fill', async () => {
    bill = itemsBill({ lines: [{ ...itemsBill().lines[0]!, leftMilli: 0 }] })
    renderUi(<ReturnSale billId={7} />)
    expect((await screen.findByTestId('return-nothing-left')).textContent).toContain('Everything on this bill has come back already')
    expect(screen.queryByTestId('btn-return-save')).toBeNull()
  })

  it('an unregistered shop, a cash customer, just an amount: no GST anywhere, money back now', async () => {
    act(() => useSession.setState({ info: info('unregistered') }))
    bill = amountBill()
    renderUi(<ReturnSale billId={8} />)
    await screen.findByTestId('return-bill')
    expect(text('return-bill-head')).toContain('Cash customer')
    expect(screen.getByTestId('input-return-amount')).toBeTruthy()
    expect(screen.queryByTestId('return-gst')).toBeNull()
    typeIn('input-return-amount', '600')
    fireEvent.blur(screen.getByTestId('input-return-amount'))
    click('btn-return-save')
    expect((await screen.findByTestId('field-error-amount')).textContent).toContain('more than is left to return')
    typeIn('input-return-amount', '120')
    fireEvent.blur(screen.getByTestId('input-return-amount'))
    await waitFor(() => expect(screen.getByTestId('return-total').getAttribute('data-paise')).toBe('12000'))
    expect(screen.queryByTestId('return-tax')).toBeNull()
    expect((screen.getByTestId('return-settle-credit') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('return-walk-in-hint')).toBeTruthy()
    expect(visibleText()).not.toMatch(/GST/)
    click('btn-return-save')
    await screen.findByTestId('save-card')
    expect((calls('simple:post')[0] as { intent: Record<string, unknown> }).intent).toMatchObject({ amount: { amount: 12_000 }, refund: { how: 'cash', accountId: 30 } })
  })

  it('a wizard business with no bank: "Add a bank account" right in the refund question', async () => {
    setup = { ...setup, moneyAccounts: [{ id: 30, name: 'Cash', kind: 'cash' }], defaults: { cash: 30, upi: null, card: null, bank: null } }
    renderUi(<ReturnSale billId={7} />)
    await screen.findByTestId('return-bill')
    click('btn-return-all-0')
    click('return-settle-refund')
    click('return-how-upi')
    expect(screen.getByTestId('btn-return-add-bank')).toBeTruthy()
    click('btn-return-save')
    expect((await screen.findByTestId('field-error-refund')).textContent).toContain('Add the bank account')
  })
})

describe('Return a purchase (WP 9.5)', () => {
  it('lists the supplier’s bill number; money back comes into an account', async () => {
    bill = { ...itemsBill(), side: 'purchase', billNo: 'BS/9', partyId: 40, partyName: 'Bharat Steel' }
    renderUi(<ReturnPurchase billId={7} />)
    await screen.findByTestId('return-bill')
    expect(text('return-bill-head')).toBe('Bill BS/9 · Bharat Steel · 12 Oct 2026')
    expect(calls('simple:returns:bill')[0]).toMatchObject({ side: 'purchase', id: 7 })
    click('btn-return-all-0')
    click('return-settle-refund')
    expect(screen.getByText('Money comes into')).toBeTruthy()
    expect(bannedWordsIn(visibleText())).toEqual([])
  })
})

describe('the Sales bill view starts a return (WP 9.5)', () => {
  it('"Return items" opens Return a sale on that bill; a returned bill carries its chip', async () => {
    const view: SaleView = {
      voucherId: 7, number: '3', date: '2026-10-12', partyId: 10, partyName: 'Ramesh', walkIn: false, items: [], amounts: [], note: null,
      total: 118_000, tax: 18_000, rounding: 0, paid: 118_000, due: 0, dueDate: null, overdueDays: 0, returned: 59_000
    }
    invoke.mockImplementation(async (channel: string) =>
      channel === 'simple:sale' ? { ok: true, data: view } : channel === 'simple:returns:bill' ? { ok: true, data: bill } : channel === 'simple:sell:setup' ? { ok: true, data: setup } : { ok: true, data: [] }
    )
    renderUi(<SalesList billId={7} />)
    expect((await screen.findByTestId('sale-returned')).textContent).toBe('Returned ₹590.00')
    await waitFor(() => expect(calls('simple:returns:bill')[0]).toMatchObject({ side: 'sale', id: 7 }))
    click('btn-bill-return')
    await waitFor(() => expect(lastScreen()).toEqual({ name: 'simple-return-sale', billId: 7 }))
  })

  it('a bill with nothing left to return has no "Return items"', async () => {
    const view: SaleView = {
      voucherId: 7, number: '3', date: '2026-10-12', partyId: 10, partyName: 'Ramesh', walkIn: false, items: [], amounts: [], note: null,
      total: 118_000, tax: 18_000, rounding: 0, paid: 0, due: 0, dueDate: null, overdueDays: 0, returned: 118_000
    }
    bill = itemsBill({ lines: [{ ...itemsBill().lines[0]!, leftMilli: 0 }] })
    invoke.mockImplementation(async (channel: string) => (channel === 'simple:sale' ? { ok: true, data: view } : channel === 'simple:returns:bill' ? { ok: true, data: bill } : { ok: true, data: [] }))
    renderUi(<SalesList billId={7} />)
    await screen.findByTestId('sale-returned')
    await waitFor(() => expect(screen.queryByTestId('btn-bill-return')).toBeNull())
    // Review fix: cleared by the return with nothing paid — neither "Paid" nor "Paid in full".
    expect(screen.getByTestId('sale-status').dataset.status).toBe('returned')
    expect(screen.getByTestId('sale-status').textContent).toBe('Nothing due')
    expect(screen.getByTestId('simple-sale-due').textContent).toBe('₹1,180.00 came off it with returns. Nothing more is due.')
  })

  it('part paid, the rest taken off by a return: says both, never "Paid in full" (review fix)', async () => {
    const view: SaleView = {
      voucherId: 7, number: '1', date: '2026-10-12', partyId: 10, partyName: 'Ramesh', walkIn: false, items: [], amounts: [], note: null,
      total: 261_000, tax: 31_000, rounding: 0, paid: 100_000, due: 0, dueDate: null, overdueDays: 0, returned: 177_000
    }
    invoke.mockImplementation(async (channel: string) => (channel === 'simple:sale' ? { ok: true, data: view } : channel === 'simple:returns:bill' ? { ok: true, data: bill } : { ok: true, data: [] }))
    renderUi(<SalesList billId={7} />)
    expect((await screen.findByTestId('simple-sale-due')).textContent).toBe('₹1,000.00 paid so far. ₹1,610.00 came off it with returns. Nothing more is due.')
    expect(screen.getByTestId('sale-status').dataset.status).toBe('paid')
  })
})

describe('the purchase bill view starts a return; the purchase list carries the chip (WP 9.5 on 9.3)', () => {
  const pview: PurchaseView = {
    voucherId: 7, number: '1', billNo: 'BS/9', date: '2026-10-12', partyId: 40, partyName: 'Bharat Steel', total: 118_000, tax: 18_000,
    paid: 0, due: 94_400, dueDate: null, overdueDays: 0, returned: 23_600, items: [], amounts: [], rounding: 0, note: null
  }
  it('"Return items" opens Return a purchase on that bill; the view shows the returned chip', async () => {
    bill = { ...itemsBill(), side: 'purchase', billNo: 'BS/9', partyId: 40, partyName: 'Bharat Steel' }
    invoke.mockImplementation(async (channel: string) =>
      channel === 'simple:purchase' ? { ok: true, data: pview } : channel === 'simple:returns:bill' ? { ok: true, data: bill } : { ok: true, data: [] }
    )
    renderUi(<PurchaseList billId={7} />)
    expect((await screen.findByTestId('purchase-returned')).textContent).toBe('Returned ₹236.00')
    // A return off an unpaid bill is not a payment: still "Due", never "Part paid".
    expect(screen.getByTestId('purchase-status').dataset.status).toBe('due')
    expect(screen.getByTestId('simple-purchase-due').textContent).toBe('₹944.00 still to pay. ₹236.00 came off it with returns.')
    await waitFor(() => expect(calls('simple:returns:bill')[0]).toMatchObject({ side: 'purchase', id: 7 }))
    click('btn-purchase-return')
    await waitFor(() => expect(lastScreen()).toEqual({ name: 'simple-return-purchase', billId: 7 }))
    expect(bannedWordsIn(visibleText())).toEqual([])
  })

  it('the purchase list row carries the chip', async () => {
    const { items: _i, amounts: _a, rounding: _r, note: _n, ...row } = pview
    invoke.mockImplementation(async (channel: string) => (channel === 'simple:purchases' ? { ok: true, data: [row] } : { ok: true, data: [] }))
    renderUi(<PurchaseList />)
    expect((await screen.findByTestId('purchase-returned')).textContent).toBe('Returned ₹236.00')
  })
})

describe('to-do §4: a viewer is told up front (Returns)', () => {
  it('Return a sale: the note at the top before a bill is picked', async () => {
    act(() => useSession.setState({ user: { id: 2, name: 'Vee', role: 'viewer' } as never }))
    try {
      renderUi(<ReturnSale />)
      expect((await screen.findByTestId('viewer-note-top')).textContent).toContain('can’t save entries')
    } finally {
      act(() => useSession.setState({ user: null }))
    }
  })
})
