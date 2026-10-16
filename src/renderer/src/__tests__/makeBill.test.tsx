// WP 9.2 — Make a bill (simple/sell/MakeBill): an empty Save puts each problem under its question;
// "Paid how?" offers the six ways and keeps credit / part payment for a named customer; the plain
// preview line comes from simple:preview; with stock off the form asks for "just an amount" and
// never shows a product picker; an unregistered company never sees GST; a customer on credit hold
// and a locked date are refused in plain words under their field; Save posts the sale intent and
// shows the save card. No banned word on any of it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CompanyInfo, Group, Ledger } from '@shared/domain'
import { DEFAULT_FEATURES } from '@shared/features'
import type { IntentFacts, SimplePostResult, SimplePreview } from '@shared/simple/intents'
import type { SellSetup } from '@shared/simple/sell'
import { bannedWordsIn } from '@shared/simple/bannedWords'
import { useSession } from '../state/stores'
import { MakeBill } from '../simple/sell/MakeBill'
import { recordPaymentScreen } from '../simple/sell/recordPayment'
import { NewProductDialog } from '../simple/NewProductDialog'

const invoke = vi.fn()
const GROUPS: Group[] = [
  { id: 1, name: 'Current Assets', parentId: null, nature: 'asset', affectsGrossProfit: false, isSystem: true },
  { id: 2, name: 'Sundry Debtors', parentId: 1, nature: 'asset', affectsGrossProfit: false, isSystem: true },
  { id: 5, name: 'Sales Accounts', parentId: null, nature: 'income', affectsGrossProfit: true, isSystem: true }
]
const ledger = (id: number, name: string, groupId: number, extra: Partial<Ledger> = {}): Ledger =>
  ({ id, name, groupId, openingBalance: 0, gstin: null, stateCode: '27', address: null, taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null, isSystem: false, ...extra }) as Ledger
const LEDGERS = [ledger(10, 'Ramesh', 2), ledger(11, 'Hold Traders', 2, { creditHold: true }), ledger(20, 'Sales', 5), ledger(30, 'Cash', 1), ledger(31, 'HDFC Bank', 1)]
const ITEMS = [
  { id: 1, name: 'Sugar 1kg', unitId: 4, gstRate: 5, cessRate: null, barcode: null },
  { id: 2, name: 'Tea 250g', unitId: 4, gstRate: 5, cessRate: null, barcode: null }
]
const SETUP: SellSetup = {
  walkInId: null,
  customers: [
    { id: 10, name: 'Ramesh', stateCode: '27', phone: '9876543210', creditHold: false },
    { id: 11, name: 'Hold Traders', stateCode: '27', phone: null, creditHold: true }
  ],
  moneyAccounts: [{ id: 30, name: 'Cash', kind: 'cash' }, { id: 31, name: 'HDFC Bank', kind: 'bank' }],
  defaults: { cash: 30, upi: 31, card: 31, bank: 31 },
  memoryId: null,
  salesAccountId: 20
}
const info = (gstRegistrationType: CompanyInfo['gstRegistrationType']): CompanyInfo => ({
  name: 'Sharma Kirana', stateCode: '27', gstin: gstRegistrationType === 'unregistered' ? null : '27AAACT1234A1Z5', gstRegistrationType,
  address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null
})
const FACTS: IntentFacts = {
  kind: 'sale', partyName: 'Ramesh', total: 118_000, tax: 0, paid: 50_000, how: 'upi', moneyAccount: 'HDFC Bank', due: 68_000, settled: [], advance: 0, fromName: null, toName: null, againstBill: null, offBill: 0, credit: 0, balance: 68_000, noGst: null, side: 'customer', walkIn: false, dueDate: '2026-11-20'
}

let features = { ...DEFAULT_FEATURES }
let postReply: () => { ok: boolean; data?: unknown; error?: string; code?: string; field?: string; params?: Record<string, unknown> }
const calls = (ch: string): unknown[] => invoke.mock.calls.filter(([c]) => c === ch).map(([, p]) => p)

function renderUi(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MakeBill />
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
      case 'simple:sell:setup': return { ok: true, data: SETUP }
      case 'pricing:resolve': return { ok: true, data: [] }
      case 'simple:preview':
        return { ok: true, data: { kind: 'sale', sentences: [], facts: FACTS, entries: [], warnings: { negativeStock: [{ stockItemId: 1, name: 'Sugar 1kg', unitSymbol: 'Pcs', closingQtyMilli: -2000 }], creditLimitExceeded: null } } satisfies SimplePreview }
      case 'simple:post': return postReply()
      case 'voucher:saveSummary': return { ok: true, data: { entries: [{ voucherId: 7, kind: 'sales', number: 'S-1', amount: 118_000 }], parties: [], undo: { undoable: true, reason: null } } }
      default: return { ok: true, data: [] }
    }
  })
  window.total = { platform: 'test', invoke }
  act(() => useSession.setState({ info: info('regular'), slug: 'sharma', ui: { mode: 'simple' }, workingDate: '2026-10-13', from: '2026-04-01', to: '2027-03-31' }))
})
afterEach(() => {
  cleanup()
  invoke.mockReset()
  localStorage.clear()
})

const click = (id: string): void => void fireEvent.click(screen.getByTestId(id))
const text = (id: string): string => screen.getByTestId(id).textContent ?? ''
const disabled = (id: string): boolean => (screen.getByTestId(id) as HTMLButtonElement).disabled
/** The form is ready once its choices (simple:sell:setup) are in. */
const ready = (): Promise<void> => waitFor(() => expect(disabled('btn-sell-save')).toBe(false))
async function option(label: string): Promise<HTMLElement> {
  let hit: HTMLElement | undefined
  await waitFor(() => {
    hit = screen.getAllByRole('option').find((o) => !o.dataset.create && (o.textContent ?? '').includes(label))
    expect(hit).toBeTruthy()
  })
  return hit!
}
async function pickItem(i: number, text: string): Promise<void> {
  fireEvent.change(screen.getByTestId(`picker-sell-item-${i}`), { target: { value: text } })
  fireEvent.mouseDown(await option(text))
}
async function pickCustomer(text: string): Promise<void> {
  fireEvent.change(screen.getByTestId('picker-sell-customer'), { target: { value: text } })
  fireEvent.mouseDown(await option(text))
}
const typeIn = (id: string, value: string): void => void fireEvent.change(screen.getByTestId(id), { target: { value } })
const visibleText = (): string => document.body.textContent ?? ''

describe('Make a bill (WP 9.2)', () => {
  it('an empty Save: the problem under its question, nothing posted', async () => {
    renderUi()
    await ready()
    click('btn-sell-save')
    expect((await screen.findByTestId('field-error-items')).textContent).toContain('Pick the product on every line')
    expect(calls('simple:post')).toHaveLength(0)
    expect(bannedWordsIn(visibleText())).toEqual([])
  })

  it('Paid how? — six ways; a cash customer pays now, credit and part need a named customer', async () => {
    renderUi()
    await ready()
    for (const v of ['cash', 'upi', 'card', 'bank', 'credit', 'part']) expect(screen.getByTestId(`sell-paid-${v}`)).toBeTruthy()
    expect(disabled('sell-paid-credit')).toBe(true)
    expect(disabled('sell-paid-part')).toBe(true)
    expect(text('sell-walk-in-hint')).toContain('A cash customer pays in full now')
    await pickCustomer('Ramesh')
    expect(disabled('sell-paid-credit')).toBe(false)
    click('sell-paid-part')
    expect(screen.getByTestId('input-sell-part-amount')).toBeTruthy()
    for (const v of ['cash', 'upi', 'card', 'bank']) expect(screen.getByTestId(`sell-part-how-${v}`)).toBeTruthy()
    // The account the money goes into, defaulted per way.
    click('sell-part-how-upi')
    expect((screen.getByTestId('select-sell-account') as HTMLSelectElement).value).toBe('31')
  })

  it('the preview line from simple:preview, the live total, a short-stock warning in words; Save → the save card', async () => {
    renderUi()
    await ready()
    await pickCustomer('Ramesh')
    await pickItem(0, 'Sugar')
    typeIn('input-sell-qty-0', '2')
    typeIn('input-sell-rate-0', '500')
    await waitFor(() => expect(screen.getByTestId('sell-total').getAttribute('data-paise')).toBe('105000'))
    expect(text('sell-line-gst-0')).toContain('5% GST')
    await waitFor(() => expect(text('sell-preview')).toContain('Bill ₹1,180.00 to Ramesh. ₹500.00 by UPI now, ₹680.00 due by 20 Nov 2026.'), { timeout: 3000 })
    expect(text('sell-short-stock')).toContain('Sugar 1kg: you are selling more than you have')
    expect(text('sell-short-stock')).toContain('Record the purchase first, or the profit will be wrong.')
    expect(text('sell-print-title')).toContain('Prints as: Tax invoice')
    expect(bannedWordsIn(visibleText())).toEqual([])
    // A named customer starts on credit (plan §3); paid in cash is one click.
    expect(screen.getByTestId('sell-paid-credit').getAttribute('aria-checked')).toBe('true')
    click('sell-paid-cash')
    click('btn-sell-save')
    await screen.findByTestId('save-card')
    expect(calls('simple:post')[0]).toMatchObject({ intent: { kind: 'sale', customerId: 10, items: [{ itemId: 1, qty: 2000, rate: 50_000 }], payment: { how: 'cash', accountId: 30 } } })
  })

  it('to-do §4: "Prices include GST" with a price typed converts it — the bill stays ₹1,050', async () => {
    renderUi()
    await ready()
    await pickCustomer('Ramesh')
    await pickItem(0, 'Sugar')
    typeIn('input-sell-qty-0', '2')
    typeIn('input-sell-rate-0', '500')
    await waitFor(() => expect(screen.getByTestId('sell-total').getAttribute('data-paise')).toBe('105000'))
    click('sell-prices-incl')
    await waitFor(() => expect((screen.getByTestId('input-sell-rate-0') as HTMLInputElement).value).toMatch(/^525(\.00)?$/))
    expect(screen.getByTestId('sell-total').getAttribute('data-paise')).toBe('105000')
    expect(localStorage.getItem('total-sell-incl:sharma')).toBe('1')
    click('sell-prices-excl')
    await waitFor(() => expect((screen.getByTestId('input-sell-rate-0') as HTMLInputElement).value).toMatch(/^500(\.00)?$/))
    expect(screen.getByTestId('sell-total').getAttribute('data-paise')).toBe('105000')
  })

  it('WP 10.8 review: a viewer sees the note, and ⌘↵ posts nothing (an accountant\'s ⌘↵ does)', async () => {
    const fill = async (): Promise<void> => {
      await pickCustomer('Ramesh')
      await pickItem(0, 'Sugar')
      typeIn('input-sell-qty-0', '2')
      typeIn('input-sell-rate-0', '500')
      click('sell-paid-cash')
      await waitFor(() => expect(screen.getByTestId('sell-total').getAttribute('data-paise')).toBe('105000'))
    }
    act(() => useSession.setState({ user: { id: 2, name: 'Vee', role: 'viewer' } as never }))
    renderUi()
    await screen.findByTestId('viewer-note')
    expect(screen.queryByTestId('btn-sell-save')).toBeNull()
    await fill()
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true })
    await new Promise((r) => setTimeout(r, 50))
    expect(calls('simple:post')).toHaveLength(0)
    cleanup()
    act(() => useSession.setState({ user: { id: 1, name: 'Asha', role: 'accountant' } as never }))
    renderUi()
    await ready()
    await fill()
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(calls('simple:post')).toHaveLength(1))
    act(() => useSession.setState({ user: null }))
  })

  it('review: Paid how follows the customer until the user picks — walk-in cash, named customer on credit', async () => {
    renderUi()
    await ready()
    expect(screen.getByTestId('sell-paid-cash').getAttribute('aria-checked')).toBe('true')
    await pickCustomer('Ramesh')
    expect(screen.getByTestId('sell-paid-credit').getAttribute('aria-checked')).toBe('true')
    click('btn-sell-cash-customer')
    expect(screen.getByTestId('sell-paid-cash').getAttribute('aria-checked')).toBe('true')
    // Once the user says UPI, picking a customer keeps it.
    click('sell-paid-upi')
    await pickCustomer('Ramesh')
    expect(screen.getByTestId('sell-paid-upi').getAttribute('aria-checked')).toBe('true')
  })

  it('review: no bank account yet — UPI offers "Add a bank account" right there (no dead end)', async () => {
    const noBank: SellSetup = { ...SETUP, moneyAccounts: [{ id: 30, name: 'Cash', kind: 'cash' }], defaults: { cash: 30, upi: null, card: null, bank: null } }
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, payload: unknown) => (channel === 'simple:sell:setup' ? { ok: true, data: noBank } : base(channel, payload)))
    renderUi()
    await ready()
    click('sell-paid-upi')
    expect(text('sell-no-account')).toContain('Add the account this money goes into')
    expect(text('sell-no-account')).not.toMatch(/Settings/)
    click('btn-sell-add-bank')
    // The plain new-account dialog, already on "Bank".
    expect(await screen.findByTestId('dialog-new-account')).toBeTruthy()
    expect(screen.getByTestId('account-kind-bank').getAttribute('aria-checked')).toBe('true')
  })

  it('review: a preview the books refuse says why — never "Checking…" for ever', async () => {
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, payload: unknown) =>
      channel === 'simple:preview' ? { ok: false, error: 'No money account', code: 'simple_no_money_account', field: 'payment', params: {} } : base(channel, payload)
    )
    renderUi()
    await ready()
    await pickItem(0, 'Tea')
    typeIn('input-sell-rate-0', '100')
    await waitFor(() => expect(screen.getByTestId('sell-preview-problem').textContent).toContain('can’t be saved yet'), { timeout: 3000 })
    expect(text('sell-preview')).not.toContain('Checking')
  })

  it('stock off: just an amount — the product picker never shows', async () => {
    features = { ...DEFAULT_FEATURES, inventory: false }
    act(() => useSession.setState({ info: info('unregistered') }))
    renderUi()
    await screen.findByTestId('input-sell-amount')
    await waitFor(() => expect(screen.queryByTestId('picker-sell-item-0')).toBeNull())
    expect(screen.queryByTestId('btn-sell-toggle-mode')).toBeNull()
    typeIn('input-sell-amount', '1500')
    typeIn('input-sell-note', 'Repair work')
    click('btn-sell-save')
    await screen.findByTestId('save-card')
    expect(calls('simple:post')[0]).toMatchObject({ intent: { kind: 'sale', amount: { amount: 150_000 }, narration: 'Repair work', payment: { how: 'cash' } } })
    expect((calls('simple:post')[0] as { intent: { amount: object } }).intent.amount).not.toHaveProperty('gstRate')
  })

  it('an unregistered company never sees GST; it prints as an Invoice', async () => {
    act(() => useSession.setState({ info: info('unregistered') }))
    renderUi()
    await ready()
    await pickItem(0, 'Sugar')
    expect(screen.queryByTestId('sell-line-gst-0')).toBeNull()
    expect(screen.queryByTestId('sell-prices-incl')).toBeNull()
    expect(screen.queryByTestId('sell-tax')).toBeNull()
    expect(text('sell-print-title')).toContain('Prints as: Invoice')
    click('btn-sell-toggle-mode')
    expect(screen.queryByTestId('sell-gst')).toBeNull()
    expect(visibleText()).not.toMatch(/GST/)
  })

  it('a regular company asks the GST rate of just an amount from the dated slabs', async () => {
    renderUi()
    await ready()
    click('btn-sell-toggle-mode')
    expect(screen.getByTestId('sell-gst')).toBeTruthy()
    expect(screen.queryByTestId('sell-gst-rate-12')).toBeNull()
    typeIn('input-sell-amount', '1000')
    click('btn-sell-save')
    expect((await screen.findByTestId('field-error-gstRate')).textContent).toContain('Pick the GST rate')
    click('sell-gst-rate-18')
    await waitFor(() => expect(screen.getByTestId('sell-total').getAttribute('data-paise')).toBe('118000'))
  })

  it('a customer on credit hold: refused under the customer, ask the owner', async () => {
    renderUi()
    await ready()
    await pickCustomer('Hold Traders')
    await pickItem(0, 'Tea')
    typeIn('input-sell-rate-0', '100')
    click('btn-sell-save')
    expect((await screen.findByTestId('field-error-party')).textContent).toContain('on credit hold, so a bill can’t be made for them here. Ask the owner.')
    expect(calls('simple:post')).toHaveLength(0)
    // And if main refuses it (the hold set meanwhile), the same plain words.
    postReply = () => ({ ok: false, error: 'Ramesh is on credit hold', code: 'credit_hold', field: 'party', params: { name: 'Ramesh', part: 'bill' } })
    await pickCustomer('Ramesh')
    click('btn-sell-save')
    await waitFor(() => expect(calls('simple:post')).toHaveLength(1))
    expect((await screen.findByTestId('field-error-party')).textContent).toContain('Ask the owner.')
  })

  it('a locked date: the plain message under the date', async () => {
    postReply = () => ({ ok: false, error: 'Books are locked up to 2026-09-30', code: 'books_locked', field: 'date', params: { date: '30-Sep-26', part: 'bill' } })
    renderUi()
    await ready()
    await pickItem(0, 'Tea')
    typeIn('input-sell-rate-0', '100')
    click('btn-sell-save')
    expect((await screen.findByTestId('field-error-date')).textContent).toContain('locked')
    expect(text('field-error-date')).toContain('ask the owner to unlock')
  })

  it('Record a payment opens Money in (WP 9.4) for the customer, what is still due and that bill', () => {
    expect(recordPaymentScreen({ partyId: 10, due: 68_000, number: 'S-7' }, 30)).toEqual({ name: 'simple-money-in', party: 10, amount: 68_000, bill: 'S-7' })
    expect(recordPaymentScreen({ partyId: 10, due: 0 }, 30)).toEqual({ name: 'simple-money-in', party: 10 })
    // Review: the bill's entry goes along, so the tick follows it even if its open name differs.
    expect(recordPaymentScreen({ partyId: 10, due: 68_000, number: 'S-7', voucherId: 44 }, 30)).toEqual({ name: 'simple-money-in', party: 10, amount: 68_000, bill: 'S-7', billId: 44 })
  })

  it('the product dialog (WP 8.4, gate follow-ups): a rate outside the dated slabs only as a marked custom rate; no unit with stock off', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { unmount } = render(
      <QueryClientProvider client={client}>
        <NewProductDialog name="Bolt" onClose={() => undefined} onCreated={() => undefined} />
      </QueryClientProvider>
    )
    await screen.findByTestId('select-product-unit')
    click('gst-rate-other')
    expect(screen.queryByTestId('input-product-gst-other')).toBeNull()
    click('gst-rate-custom')
    expect(text('product-gst-custom')).toContain('Use it only if your CA says so')
    typeIn('input-product-gst-other', '12')
    expect(screen.getByTestId('product-gst-custom')).toBeTruthy()
    unmount()
    features = { ...DEFAULT_FEATURES, inventory: false }
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <NewProductDialog name="Repair" onClose={() => undefined} onCreated={() => undefined} />
      </QueryClientProvider>
    )
    await screen.findByTestId('dialog-new-product')
    await waitFor(() => expect(screen.queryByTestId('select-product-unit')).toBeNull())
  })
})
