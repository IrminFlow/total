// WP 9.3 — Record a purchase (simple/buy/RecordPurchase): an empty Save puts each problem under its
// question; a regular company is asked "Does the bill show GST?" and sees the GST it can claim
// back; products on a bill without GST are refused under that question with a one-click way out;
// a business that can't claim GST is never asked (the GST is part of the cost); stock off = no
// products; the plain preview line comes from simple:preview; Save posts the purchase intent and
// shows the save card; the same supplier bill again shows its refusal under the bill number with a
// link to the bill already recorded; "Snap a bill" only while AI is ready. No banned word.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CompanyInfo, Group, Ledger } from '@shared/domain'
import { DEFAULT_FEATURES } from '@shared/features'
import type { IntentFacts, SimplePostResult, SimplePreview } from '@shared/simple/intents'
import type { BuySetup } from '@shared/simple/buy'
import { bannedWordsIn } from '@shared/simple/bannedWords'
import { useNav, useSession } from '../state/stores'
import { useExplain } from '../lib/explain'
import { useDialogs } from '../lib/dialogs'
import { RecordPurchase } from '../simple/buy/RecordPurchase'
import { recordSupplierPaymentScreen } from '../simple/buy/recordSupplierPayment'

const invoke = vi.fn()
const GROUPS: Group[] = [
  { id: 1, name: 'Current Assets', parentId: null, nature: 'asset', affectsGrossProfit: false, isSystem: true },
  { id: 3, name: 'Sundry Creditors', parentId: null, nature: 'liability', affectsGrossProfit: false, isSystem: true },
  { id: 6, name: 'Purchase Accounts', parentId: null, nature: 'expense', affectsGrossProfit: true, isSystem: true },
  { id: 7, name: 'Indirect Expenses', parentId: null, nature: 'expense', affectsGrossProfit: false, isSystem: true }
]
const ledger = (id: number, name: string, groupId: number, extra: Partial<Ledger> = {}): Ledger =>
  ({ id, name, groupId, openingBalance: 0, gstin: null, stateCode: '27', address: null, taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null, isSystem: false, ...extra }) as Ledger
const LEDGERS = [ledger(10, 'Bharat Steel', 3), ledger(20, 'Purchases', 6, { simpleCategory: 'purchases' }), ledger(21, 'Rent', 7, { gstRate: 18, simpleCategory: 'rent' }), ledger(30, 'Cash', 1), ledger(31, 'HDFC Bank', 1)]
const ITEMS = [
  { id: 1, name: 'Steel bolt', unitId: 4, gstRate: 18, cessRate: null, barcode: null },
  { id: 2, name: 'Rice 5kg', unitId: 4, gstRate: 5, cessRate: null, barcode: null },
  { id: 3, name: 'Loose salt', unitId: 4, gstRate: 0, cessRate: null, barcode: null }
]
const SETUP: BuySetup = {
  suppliers: [{ id: 10, name: 'Bharat Steel', stateCode: '27', gstin: '27AABCG3456H1ZN', phone: null }],
  moneyAccounts: [{ id: 30, name: 'Cash', kind: 'cash' }, { id: 31, name: 'HDFC Bank', kind: 'bank' }],
  defaults: { cash: 30, upi: 31, card: 31, bank: 31 },
  memoryId: null,
  purchaseAccountId: 20
}
const info = (gstRegistrationType: CompanyInfo['gstRegistrationType']): CompanyInfo => ({
  name: 'Mehta Traders', stateCode: '27', gstin: gstRegistrationType === 'unregistered' ? null : '27AAACT1234A1Z5', gstRegistrationType,
  address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null
})
const FACTS: IntentFacts = {
  kind: 'purchase', partyName: 'Bharat Steel', total: 118_000, tax: 18_000, paid: 50_000, how: 'upi', moneyAccount: 'HDFC Bank', due: 68_000, settled: [], advance: 0, fromName: null, toName: null, againstBill: null, offBill: 0, credit: 0, balance: 68_000, noGst: null, side: 'supplier', walkIn: false, dueDate: '2026-11-12'
}

let features = { ...DEFAULT_FEATURES }
let postReply: () => { ok: boolean; data?: unknown; error?: string; code?: string; field?: string; params?: Record<string, unknown> }
const calls = (ch: string): unknown[] => invoke.mock.calls.filter(([c]) => c === ch).map(([, p]) => p)

function renderUi(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <RecordPurchase />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  features = { ...DEFAULT_FEATURES }
  postReply = () => ({ ok: true, data: { voucherIds: [7, 8], entries: [], replayed: false, summary: { entries: [], parties: [], undo: { undoable: true, reason: null } }, sentences: [], facts: FACTS, warnings: { negativeStock: [], creditLimitExceeded: null } } satisfies SimplePostResult })
  invoke.mockImplementation(async (channel: string) => {
    switch (channel) {
      case 'master:groups:list': return { ok: true, data: GROUPS }
      case 'master:ledgers:list': return { ok: true, data: LEDGERS }
      case 'master:units:list': return { ok: true, data: [{ id: 4, name: 'Pieces', symbol: 'Pcs', decimals: 0, uqc: 'PCS' }] }
      case 'master:stockItems:list': return { ok: true, data: ITEMS }
      case 'config:features:get': return { ok: true, data: features }
      case 'simple:buy:setup': return { ok: true, data: SETUP }
      case 'simple:preview':
        return { ok: true, data: { kind: 'purchase', sentences: [], facts: FACTS, entries: [], warnings: { negativeStock: [], creditLimitExceeded: null } } satisfies SimplePreview }
      case 'simple:post': return postReply()
      case 'voucher:saveSummary': return { ok: true, data: { entries: [{ voucherId: 7, kind: 'purchase', number: 'P-1', amount: 118_000 }], parties: [], undo: { undoable: true, reason: null } } }
      default: return { ok: true, data: [] }
    }
  })
  window.total = { platform: 'test', invoke }
  act(() => {
    useSession.setState({ info: info('regular'), slug: 'mehta', ui: { mode: 'simple' }, workingDate: '2026-10-13', from: '2026-04-01', to: '2027-03-31' })
    useNav.setState({ stack: [{ name: 'simple-buy' }] })
    useExplain.setState({ ready: false, handler: null })
    useDialogs.setState({ queue: [] })
  })
})
afterEach(() => {
  cleanup()
  invoke.mockReset()
  localStorage.clear()
})

const click = (id: string): void => void fireEvent.click(screen.getByTestId(id))
const text = (id: string): string => screen.getByTestId(id).textContent ?? ''
const disabled = (id: string): boolean => (screen.getByTestId(id) as HTMLButtonElement).disabled
/** The form is ready once its choices (simple:buy:setup) are in. */
const ready = (): Promise<void> => waitFor(() => expect(disabled('btn-buy-save')).toBe(false))
async function option(label: string): Promise<HTMLElement> {
  let hit: HTMLElement | undefined
  await waitFor(() => {
    hit = screen.getAllByRole('option').find((o) => !o.dataset.create && (o.textContent ?? '').includes(label))
    expect(hit).toBeTruthy()
  })
  return hit!
}
async function pick(testId: string, value: string): Promise<void> {
  fireEvent.change(screen.getByTestId(testId), { target: { value } })
  fireEvent.mouseDown(await option(value))
}
const typeIn = (id: string, value: string): void => void fireEvent.change(screen.getByTestId(id), { target: { value } })
const visibleText = (): string => document.body.textContent ?? ''
const lastScreen = (): unknown => useNav.getState().stack.at(-1)

describe('Record a purchase (WP 9.3)', () => {
  it('an empty Save: the problems under their questions, nothing posted', async () => {
    renderUi()
    await ready()
    click('btn-buy-save')
    expect((await screen.findByTestId('field-error-party')).textContent).toContain('Pick the supplier')
    expect(text('field-error-items')).toContain('Pick the product on every line')
    expect(calls('simple:post')).toHaveLength(0)
    expect(bannedWordsIn(visibleText())).toEqual([])
  })

  it('a regular company: "Does the bill show GST?", the GST it can claim back, the preview line; Save → the save card', async () => {
    renderUi()
    await ready()
    expect(screen.getByTestId('buy-gst-question')).toBeTruthy()
    expect(screen.queryByTestId('buy-cant-claim')).toBeNull()
    await pick('picker-buy-supplier', 'Bharat')
    typeIn('input-buy-bill-no', 'BS/101')
    await pick('picker-buy-item-0', 'Steel bolt')
    typeIn('input-buy-qty-0', '10')
    typeIn('input-buy-rate-0', '100')
    await waitFor(() => expect(screen.getByTestId('buy-total').getAttribute('data-paise')).toBe('118000'))
    expect(screen.getByTestId('buy-tax').getAttribute('data-paise')).toBe('18000')
    expect(text('buy-line-gst-0')).toBe('18% GST')
    click('buy-paid-part')
    typeIn('input-buy-part-amount', '500')
    click('buy-part-how-upi')
    expect((screen.getByTestId('select-buy-account') as HTMLSelectElement).value).toBe('31')
    await waitFor(() => expect(text('buy-preview')).toBe('Bill ₹1,180.00 from Bharat Steel. ₹500.00 paid by UPI now, ₹680.00 still to pay by 12 Nov 2026.'), { timeout: 3000 })
    expect(bannedWordsIn(visibleText())).toEqual([])
    click('btn-buy-save')
    await screen.findByTestId('save-card')
    expect(calls('simple:post')[0]).toMatchObject({
      intent: { kind: 'purchase', supplierId: 10, billNo: 'BS/101', date: '2026-10-13', gstOnBill: true, items: [{ itemId: 1, qty: 10_000, rate: 10_000 }], payment: { how: 'upi', amount: 50_000, accountId: 31 } }
    })
  })

  it('products on a bill without GST: refused under the GST question, with "Record it as just an amount"', async () => {
    renderUi()
    await ready()
    await pick('picker-buy-supplier', 'Bharat')
    await pick('picker-buy-item-0', 'Rice')
    typeIn('input-buy-rate-0', '100')
    click('buy-gst-no')
    click('btn-buy-save')
    expect((await screen.findByTestId('field-error-gstOnBill')).textContent).toContain('A bill without GST can’t list products here')
    expect(calls('simple:post')).toHaveLength(0)
    click('btn-buy-as-amount')
    expect(screen.getByTestId('input-buy-amount')).toBeTruthy()
    expect(screen.queryByTestId('buy-gst')).toBeNull()
    typeIn('input-buy-amount', '400')
    click('btn-buy-save')
    await screen.findByTestId('save-card')
    expect(calls('simple:post')[0]).toMatchObject({ intent: { kind: 'purchase', gstOnBill: false, amount: { amount: 40_000, accountId: 20 } } })
    expect((calls('simple:post')[0] as { intent: { amount: object } }).intent.amount).not.toHaveProperty('gstRate')
  })

  it('an expense: what it was for is asked under its question; no out-of-table GST rate is offered', async () => {
    renderUi()
    await ready()
    await pick('picker-buy-supplier', 'Bharat')
    click('buy-mode-expense')
    expect(screen.queryByTestId('buy-gst-rate-12')).toBeNull()
    click('btn-buy-save')
    expect((await screen.findByTestId('field-error-account')).textContent).toContain('Pick what the money was spent on')
  })

  it('a business that can’t claim GST is never asked; prices are what was paid; GST nowhere as a claim', async () => {
    act(() => useSession.setState({ info: info('unregistered') }))
    renderUi()
    await ready()
    expect(screen.queryByTestId('buy-gst-question')).toBeNull()
    expect(text('buy-cant-claim')).toContain('can’t claim GST back')
    expect(screen.getByTestId('buy-prices-incl').getAttribute('aria-checked')).toBe('true')
    await pick('picker-buy-supplier', 'Bharat')
    await pick('picker-buy-item-0', 'Rice')
    typeIn('input-buy-qty-0', '2')
    typeIn('input-buy-rate-0', '262.50')
    await waitFor(() => expect(screen.getByTestId('buy-total').getAttribute('data-paise')).toBe('52500'))
    expect(screen.queryByTestId('buy-tax')).toBeNull()
    expect(screen.queryByTestId('buy-line-gst-0')).toBeNull()
    click('buy-paid-cash')
    click('btn-buy-save')
    await screen.findByTestId('save-card')
    expect(calls('simple:post')[0]).toMatchObject({ intent: { kind: 'purchase', gstOnBill: false, items: [{ itemId: 2, qty: 2_000, rate: 26_250 }], payment: { how: 'cash', accountId: 30 } } })
    // Prices before GST: the product's 5 % goes into the cost (shown, never claimed).
    click('btn-save-card-new')
    await ready()
    click('buy-prices-excl')
    await pick('picker-buy-supplier', 'Bharat')
    await pick('picker-buy-item-0', 'Rice')
    typeIn('input-buy-qty-0', '2')
    typeIn('input-buy-rate-0', '250')
    await waitFor(() => expect(screen.getByTestId('buy-total').getAttribute('data-paise')).toBe('52500'))
    expect(screen.getByTestId('buy-folded').getAttribute('data-paise')).toBe('2500')
    expect(text('buy-line-gst-0')).toContain('5% GST into the cost')
  })

  it('stock off: no products — an expense or just an amount', async () => {
    features = { ...DEFAULT_FEATURES, inventory: false }
    renderUi()
    await screen.findByTestId('input-buy-amount')
    await waitFor(() => expect(screen.queryByTestId('buy-mode-items')).toBeNull())
    expect(screen.queryByTestId('picker-buy-item-0')).toBeNull()
    expect(screen.getByTestId('buy-mode-expense')).toBeTruthy()
  })

  it('the same supplier bill again: the refusal under the bill number, with a link to the bill already recorded', async () => {
    postReply = () => ({ ok: false, error: 'Bill BS/101 from this supplier is already in the books (purchase P-3)', code: 'simple_duplicate_bill', field: 'billNo', params: { number: 'P-3', voucherId: 42, part: 'bill' } })
    renderUi()
    await ready()
    await pick('picker-buy-supplier', 'Bharat')
    typeIn('input-buy-bill-no', 'BS/101')
    await pick('picker-buy-item-0', 'Steel bolt')
    typeIn('input-buy-rate-0', '100')
    click('btn-buy-save')
    expect((await screen.findByTestId('field-error-billNo')).textContent).toBe('This bill from this supplier is already recorded. Check the bill number, or open the one already recorded.')
    click('btn-buy-open-duplicate')
    // What was typed here would be lost: the app asks first (the unsaved-changes guard).
    await waitFor(() => expect(useDialogs.getState().queue).toHaveLength(1))
    act(() => useDialogs.getState().settle(useDialogs.getState().queue[0]!.id, true))
    await waitFor(() => expect(lastScreen()).toEqual({ name: 'simple-purchases', billId: 42 }))
  })

  it('"Snap a bill" only while AI is ready; "Accountant view" opens the purchase editor', async () => {
    renderUi()
    await ready()
    expect(screen.queryByTestId('btn-buy-snap')).toBeNull()
    act(() => useExplain.setState({ ready: true, handler: () => undefined }))
    click('btn-buy-snap')
    await waitFor(() => expect(lastScreen()).toEqual({ name: 'capture' }))
    click('btn-buy-accountant-view')
    await waitFor(() => expect(lastScreen()).toEqual({ name: 'voucher-entry', kindHint: 'purchase' }))
  })

  it('review: no bank account yet — UPI offers "Add a bank account" right there (no dead end)', async () => {
    const noBank: BuySetup = { ...SETUP, moneyAccounts: [{ id: 30, name: 'Cash', kind: 'cash' }], defaults: { cash: 30, upi: null, card: null, bank: null } }
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, payload: unknown) => (channel === 'simple:buy:setup' ? { ok: true, data: noBank } : base(channel, payload)))
    renderUi()
    await ready()
    click('buy-paid-upi')
    expect(text('buy-no-account')).toContain('Add the account this money came from')
    expect(text('buy-no-account')).not.toMatch(/Settings/)
    click('btn-buy-add-bank')
    expect(await screen.findByTestId('dialog-new-account')).toBeTruthy()
    expect(screen.getByTestId('account-kind-bank').getAttribute('aria-checked')).toBe('true')
  })

  it('review: a preview the books refuse says why — never "Checking…" for ever; a duplicate goes under the bill number at once', async () => {
    let reply: unknown = { ok: false, error: 'No money account', code: 'simple_no_money_account', field: 'payment', params: {} }
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, payload: unknown) => (channel === 'simple:preview' ? reply : base(channel, payload)))
    renderUi()
    await ready()
    await pick('picker-buy-supplier', 'Bharat')
    await pick('picker-buy-item-0', 'Steel bolt')
    typeIn('input-buy-rate-0', '100')
    await waitFor(() => expect(text('buy-preview-problem')).toContain('can’t be saved yet'), { timeout: 3000 })
    expect(text('buy-preview')).not.toContain('Checking')
    reply = { ok: false, error: 'Bill BS/101 from this supplier is already in the books', code: 'simple_duplicate_bill', field: 'billNo', params: { number: 'P-3', voucherId: 42, part: 'bill' } }
    typeIn('input-buy-bill-no', 'BS/101')
    await waitFor(() => expect(text('field-error-billNo')).toContain('already recorded'), { timeout: 3000 })
    expect(screen.getByTestId('btn-buy-open-duplicate')).toBeTruthy()
    expect(text('buy-preview')).not.toContain('Checking')
  })

  it('review: nil-rated products on a bill without GST are fine; the rupee round-off is its own line', async () => {
    renderUi()
    await ready()
    await pick('picker-buy-supplier', 'Bharat')
    await pick('picker-buy-item-0', 'Loose salt')
    typeIn('input-buy-qty-0', '3')
    typeIn('input-buy-rate-0', '10.30')
    click('buy-gst-no')
    await waitFor(() => expect(screen.getByTestId('buy-total').getAttribute('data-paise')).toBe('3100'))
    expect(screen.queryByTestId('btn-buy-as-amount')).toBeNull()
    expect(screen.getByTestId('buy-rounding').getAttribute('data-paise')).toBe('10')
    click('btn-buy-save')
    await screen.findByTestId('save-card')
    expect(calls('simple:post')[0]).toMatchObject({ intent: { kind: 'purchase', gstOnBill: false, items: [{ itemId: 3, qty: 3_000, rate: 1_030 }] } })
  })

  it('Record a payment opens Money out — the payment editor pre-filled while Money out is still the full app', () => {
    const s = recordSupplierPaymentScreen({ partyId: 10, due: 68_000 }, 30)
    expect(s).toMatchObject({ name: 'voucher-entry', kindHint: 'payment', draft: { partyLedgerId: 10, lines: [{ ledgerId: 10, drCr: 'dr', amount: 68_000 }, { ledgerId: 30, drCr: 'cr', amount: 68_000 }] } })
  })
})
