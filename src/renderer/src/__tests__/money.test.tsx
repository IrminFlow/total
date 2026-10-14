// WP 9.4 — the simple Money screens (simple/money/…): an empty Save puts each problem under its
// question; a customer's bills show oldest first with the ones the amount pays ticked (and what
// each gets); untouched = no bills named (simple:post settles oldest first), a changed tick names
// them; the preview is simple:preview's sentences; Save posts the intent and shows the save card;
// Money out asks about a GST bill only for a regular registration and then posts ONE purchase
// intent; a refusal from main sits under its field; Move money refuses the same account under
// To; the list shows who / in or out / how and chips. No banned word on any of it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CompanyInfo, Group, Ledger } from '@shared/domain'
import { DEFAULT_FEATURES } from '@shared/features'
import type { IntentFacts, SimplePostResult, SimplePreview } from '@shared/simple/intents'
import type { MoneyOpenBill, MoneyRow, MoneySetup } from '@shared/simple/money'
import { bannedWordsIn } from '@shared/simple/bannedWords'
import { useSession } from '../state/stores'
import { MoneyIn } from '../simple/money/MoneyIn'
import { MoneyOut } from '../simple/money/MoneyOut'
import { MoveMoney } from '../simple/money/MoveMoney'
import { MoneyList } from '../simple/money/MoneyList'

const invoke = vi.fn()
const GROUPS: Group[] = [
  { id: 1, name: 'Current Assets', parentId: null, nature: 'asset', affectsGrossProfit: false, isSystem: true },
  { id: 2, name: 'Sundry Debtors', parentId: 1, nature: 'asset', affectsGrossProfit: false, isSystem: true },
  { id: 3, name: 'Sundry Creditors', parentId: null, nature: 'liability', affectsGrossProfit: false, isSystem: true },
  { id: 6, name: 'Indirect Expenses', parentId: null, nature: 'expense', affectsGrossProfit: false, isSystem: true }
]
const ledger = (id: number, name: string, groupId: number, extra: Partial<Ledger> = {}): Ledger =>
  ({ id, name, groupId, openingBalance: 0, gstin: null, stateCode: '27', address: null, taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null, isSystem: false, ...extra }) as Ledger
const LEDGERS = [ledger(10, 'Ramesh', 2), ledger(20, 'Bharat Steel', 3), ledger(30, 'Cash', 1), ledger(31, 'HDFC Bank', 1), ledger(32, 'SBI', 1), ledger(40, 'Rent', 6, { simpleCategory: 'rent' })]
const SETUP: MoneySetup = {
  customers: [{ id: 10, name: 'Ramesh', stateCode: '27', phone: '9876543210' }],
  suppliers: [{ id: 20, name: 'Bharat Steel', stateCode: '27', phone: null }],
  moneyAccounts: [{ id: 30, name: 'Cash', kind: 'cash' }, { id: 31, name: 'HDFC Bank', kind: 'bank' }, { id: 32, name: 'SBI', kind: 'bank' }],
  defaultsIn: { cash: 30, upi: 31, card: 31, bank: 31 },
  defaultsOut: { cash: 30, upi: 31, card: 31, bank: 31 },
  memoryIn: null,
  memoryOut: null,
  ownerId: 50,
  drawingsId: 51,
  loans: [],
  tds: true,
  payroll: false
}
const BILLS: MoneyOpenBill[] = [
  { name: 'S-1', date: '2026-09-01', pending: 100_000, voucherId: 1, dueDate: '2026-09-16', overdueDays: 27 },
  { name: 'S-2', date: '2026-10-01', pending: 60_000, voucherId: 2, dueDate: '2026-10-16', overdueDays: 0 }
]
const info = (gstRegistrationType: CompanyInfo['gstRegistrationType']): CompanyInfo => ({
  name: 'Sharma Kirana', stateCode: '27', gstin: gstRegistrationType === 'unregistered' ? null : '27AAACT1234A1Z5', gstRegistrationType,
  address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null
})
const FACTS: IntentFacts = {
  kind: 'money_in', partyName: 'Ramesh', total: 130_000, tax: 0, paid: 130_000, how: 'upi', moneyAccount: 'HDFC Bank', due: 30_000,
  settled: [{ name: 'S-1', amount: 100_000 }, { name: 'S-2', amount: 30_000 }], advance: 0, fromName: 'Ramesh', toName: 'HDFC Bank', againstBill: null, offBill: 0, credit: 0,
  balance: 30_000, noGst: null, side: 'customer', walkIn: false
}
const PREVIEW: SimplePreview = {
  kind: 'money_in', sentences: ['₹1,300.00 from Ramesh into HDFC Bank.', 'Pays bill S-1: ₹1,000.00.', 'Pays bill S-2: ₹300.00.', 'Ramesh still owes ₹300.00.'],
  facts: FACTS, entries: [], warnings: { negativeStock: [], creditLimitExceeded: null }
}
const ROWS: MoneyRow[] = [
  { voucherId: 9, number: '3', date: '2026-10-13', direction: 'move', who: 'HDFC Bank', partyId: null, account: 'Cash', amount: 200_000, chips: [], billCount: 0 },
  { voucherId: 8, number: '2', date: '2026-10-12', direction: 'out', who: 'Rent', partyId: null, account: 'Cash', amount: 25_000, chips: ['expense'], billCount: 0 },
  { voucherId: 7, number: '1', date: '2026-10-11', direction: 'in', who: 'Ramesh', partyId: 10, account: 'HDFC Bank', amount: 130_000, chips: ['bills'], billCount: 2 }
]

let postReply: () => { ok: boolean; data?: unknown; error?: string; code?: string; field?: string; params?: Record<string, unknown> }
let previewReply: () => { ok: boolean; data?: unknown }
const calls = (ch: string): unknown[] => invoke.mock.calls.filter(([c]) => c === ch).map(([, p]) => p)

function renderUi(ui: React.ReactElement): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  postReply = () => ({ ok: true, data: { voucherIds: [7], entries: [], replayed: false, summary: { entries: [], parties: [], undo: { undoable: true, reason: null } }, sentences: [], facts: FACTS, warnings: { negativeStock: [], creditLimitExceeded: null } } satisfies SimplePostResult })
  previewReply = () => ({ ok: true, data: PREVIEW })
  invoke.mockImplementation(async (channel: string) => {
    switch (channel) {
      case 'master:groups:list': return { ok: true, data: GROUPS }
      case 'master:ledgers:list': return { ok: true, data: LEDGERS }
      case 'config:features:get': return { ok: true, data: DEFAULT_FEATURES }
      case 'simple:money:setup': return { ok: true, data: SETUP }
      case 'simple:money:bills': return { ok: true, data: BILLS }
      case 'simple:money:list': return { ok: true, data: ROWS }
      case 'simple:preview': return previewReply()
      case 'simple:post': return postReply()
      case 'voucher:saveSummary': return { ok: true, data: { entries: [{ voucherId: 7, kind: 'receipt', number: '1', amount: 130_000 }], parties: [], undo: { undoable: true, reason: null } } }
      default: return { ok: true, data: [] }
    }
  })
  window.total = { platform: 'test', invoke }
  act(() => useSession.setState({ info: info('regular'), slug: 'sharma', ui: { mode: 'simple' }, workingDate: '2026-10-13', from: '2026-04-01', to: '2027-03-31' }))
})
afterEach(() => {
  cleanup()
  invoke.mockReset()
})

const click = (id: string): void => void fireEvent.click(screen.getByTestId(id))
const disabled = (id: string): boolean => (screen.getByTestId(id) as HTMLButtonElement).disabled
const ready = (): Promise<void> => waitFor(() => expect(disabled('btn-money-save')).toBe(false))
const typeAmount = (rupees: string): void => {
  const input = screen.getByTestId('input-money-amount')
  fireEvent.change(input, { target: { value: rupees } })
  fireEvent.blur(input)
}
async function option(label: string): Promise<HTMLElement> {
  let hit: HTMLElement | undefined
  await waitFor(() => {
    hit = screen.getAllByRole('option').find((o) => !o.dataset.create && (o.textContent ?? '').includes(label))
    expect(hit).toBeTruthy()
  })
  return hit!
}
async function pick(testId: string, text: string): Promise<void> {
  fireEvent.change(screen.getByTestId(testId), { target: { value: text } })
  fireEvent.mouseDown(await option(text))
}
const visible = (): string => document.body.textContent ?? ''

describe('Money in (WP 9.4)', () => {
  it('an empty Save: each problem under its question, nothing posted', async () => {
    renderUi(<MoneyIn />)
    await ready()
    click('btn-money-save')
    await waitFor(() => expect(screen.getByTestId('field-error-party').textContent).toBe('Pick the customer who paid.'))
    expect(screen.getByTestId('field-error-amount').textContent).toBe('Type the amount.')
    expect(calls('simple:post')).toEqual([])
    expect(bannedWordsIn(visible())).toEqual([])
  })

  it('a customer: bills oldest first, ticked up to the amount; the preview sentences; Save posts without naming bills, into the UPI account', async () => {
    renderUi(<MoneyIn />)
    await ready()
    await pick('picker-money-customer', 'Ramesh')
    await waitFor(() => expect(screen.getByTestId('money-bill-list')).toBeTruthy())
    typeAmount('1300')
    click('money-how-upi')
    await waitFor(() => expect((screen.getByTestId('money-bill-0') as HTMLInputElement).checked).toBe(true))
    expect((screen.getByTestId('money-bill-1') as HTMLInputElement).checked).toBe(true)
    expect(screen.getByTestId('money-bill-gets-1').getAttribute('data-paise')).toBe('30000')
    expect(screen.getByTestId('money-bill-0').getAttribute('data-bill')).toBe('S-1')
    await waitFor(() => expect(screen.getByTestId('money-preview').textContent).toContain('Ramesh still owes ₹300.00.'))
    expect((screen.getByTestId('select-money-account') as HTMLSelectElement).value).toBe('31')
    expect(bannedWordsIn(visible())).toEqual([])
    click('btn-money-save')
    await waitFor(() => expect(screen.getByTestId('save-card')).toBeTruthy())
    const sent = calls('simple:post')[0] as { intent: Record<string, unknown> }
    expect(sent.intent).toMatchObject({ kind: 'money_in', customerId: 10, amount: 130_000, into: { how: 'upi', accountId: 31 } })
    expect(sent.intent).not.toHaveProperty('bills')
  })

  it('unticking the older bill names the bills; short of the amount it asks the advance question and refuses under the bills until answered', async () => {
    renderUi(<MoneyIn />)
    await ready()
    await pick('picker-money-customer', 'Ramesh')
    await waitFor(() => expect(screen.getByTestId('money-bill-list')).toBeTruthy())
    typeAmount('1300')
    await waitFor(() => expect((screen.getByTestId('money-bill-0') as HTMLInputElement).checked).toBe(true))
    fireEvent.click(screen.getByTestId('money-bill-0'))
    await waitFor(() => expect(screen.getByTestId('money-advance')).toBeTruthy())
    click('btn-money-save')
    await waitFor(() => expect(screen.getByTestId('field-error-bills').textContent).toContain('Tick more bills'))
    expect(calls('simple:post')).toEqual([])
    // Review: "No" would be refused here, so the hint says to tick more (not "it stays with them").
    expect(screen.getByTestId('money-advance-hint').textContent).toContain('tick more bills')
    click('money-advance-yes')
    click('btn-money-save')
    await waitFor(() => expect(calls('simple:post')).toHaveLength(1))
    expect((calls('simple:post')[0] as { intent: Record<string, unknown> }).intent).toMatchObject({ bills: [{ name: 'S-2', amount: 60_000 }], advance: true })
  })

  it('the owner put money in: no customer asked, the owner’s account named; a locked date from main sits under the date', async () => {
    postReply = () => ({ ok: false, error: 'Books are locked up to 31-Oct-26', code: 'books_locked', field: 'date', params: { date: '31 Oct 2026' } })
    renderUi(<MoneyIn />)
    await ready()
    click('money-in-who-owner')
    expect(screen.queryByTestId('picker-money-customer')).toBeNull()
    typeAmount('5000')
    click('btn-money-save')
    await waitFor(() => expect(screen.getByTestId('field-error-date')).toBeTruthy())
    expect((calls('simple:post')[0] as { intent: Record<string, unknown> }).intent).toMatchObject({ kind: 'money_in', sourceId: 50, amount: 500_000 })
  })
})

describe('review fixes', () => {
  const NO_BANK: MoneySetup = { ...SETUP, moneyAccounts: [{ id: 30, name: 'Cash', kind: 'cash' }], defaultsIn: { cash: 30, upi: null, card: null, bank: null }, defaultsOut: { cash: 30, upi: null, card: null, bank: null } }
  const noBank = (): void => {
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, payload: unknown) => (channel === 'simple:money:setup' ? { ok: true, data: NO_BANK } : base(channel, payload)))
  }

  it('UPI with no bank account yet: "Add a bank account" right there (never "go to Settings")', async () => {
    noBank()
    renderUi(<MoneyIn />)
    await ready()
    click('money-how-upi')
    expect(screen.getByTestId('money-no-account').textContent).not.toContain('Settings')
    click('btn-money-add-bank')
    await waitFor(() => expect(screen.getByTestId('dialog-new-account')).toBeTruthy())
    expect(bannedWordsIn(visible())).toEqual([])
  })

  it('Move money with only Cash: "Add a bank account" on the form', async () => {
    noBank()
    renderUi(<MoveMoney />)
    await waitFor(() => expect(screen.getByTestId('money-move-no-bank')).toBeTruthy())
    click('btn-money-add-bank')
    await waitFor(() => expect(screen.getByTestId('dialog-new-account')).toBeTruthy())
  })

  it('"Record a payment" ticks the bill by its entry even when its open name differs from its number', async () => {
    renderUi(<MoneyIn party={10} amount={60_000} bill="2" billId={2} />)
    await ready()
    await waitFor(() => expect((screen.getByTestId('money-bill-1') as HTMLInputElement).checked).toBe(true))
    expect((screen.getByTestId('money-bill-0') as HTMLInputElement).checked).toBe(false)
    click('btn-money-save')
    await waitFor(() => expect(calls('simple:post')).toHaveLength(1))
    expect((calls('simple:post')[0] as { intent: Record<string, unknown> }).intent).toMatchObject({ customerId: 10, amount: 60_000, bills: [{ name: 'S-2', amount: 60_000 }] })
  })
})

describe('Money out (WP 9.4)', () => {
  it('an expense, regular registration: the GST bill question, its fields under their questions, then ONE purchase intent paid now', async () => {
    renderUi(<MoneyOut />)
    await ready()
    click('money-out-who-expense')
    click('picker-money-expense')
    fireEvent.click(await screen.findByTestId('category-rent'))
    typeAmount('1180')
    click('btn-money-save')
    await waitFor(() => expect(screen.getByTestId('field-error-gstBill')).toBeTruthy())
    click('money-gst-bill-yes')
    click('btn-money-save')
    await waitFor(() => expect(screen.getByTestId('field-error-billSupplier')).toBeTruthy())
    expect(screen.getByTestId('field-error-billNo')).toBeTruthy()
    expect(screen.getByTestId('field-error-gstRate')).toBeTruthy()
    await pick('picker-money-bill-supplier', 'Bharat')
    fireEvent.change(screen.getByTestId('input-money-bill-no'), { target: { value: 'R-77' } })
    click('money-gst-rate-18')
    click('money-how-bank')
    expect(bannedWordsIn(visible())).toEqual([])
    click('btn-money-save')
    await waitFor(() => expect(calls('simple:post')).toHaveLength(1))
    expect((calls('simple:post')[0] as { intent: Record<string, unknown> }).intent).toEqual(expect.objectContaining({
      kind: 'purchase', supplierId: 20, billNo: 'R-77', amount: { amount: 100_000, accountId: 40, gstRate: 18, billTotal: 118_000 }, payment: { how: 'bank', accountId: 31 }
    }))
  })

  it('unregistered: no GST bill question; a payment to the expense', async () => {
    act(() => useSession.setState({ info: info('unregistered') }))
    renderUi(<MoneyOut />)
    await ready()
    click('money-out-who-expense')
    expect(screen.queryByTestId('money-gst-bill')).toBeNull()
    click('picker-money-expense')
    fireEvent.click(await screen.findByTestId('category-rent'))
    typeAmount('250')
    click('btn-money-save')
    await waitFor(() => expect(calls('simple:post')).toHaveLength(1))
    expect((calls('simple:post')[0] as { intent: Record<string, unknown> }).intent).toMatchObject({ kind: 'money_out', payeeId: 40, amount: 25_000, from: { how: 'cash', accountId: 30 } })
  })

  it('WP 10.1: opened from Ask Total — pre-filled from the prefill; Save posts that intent with the draft id, once', async () => {
    act(() => useSession.setState({ info: info('unregistered') }))
    renderUi(<MoneyOut ask={{ draftId: 41, prefill: { screen: 'simple-money-out', who: 'expense', payee: 40, amount: 50_000, how: 'cash', note: 'tea' } }} />)
    await ready()
    click('btn-money-save')
    await waitFor(() => expect(calls('simple:post')).toHaveLength(1))
    const sent = calls('simple:post')[0] as { intent: Record<string, unknown>; aiDraftId?: number }
    expect(sent.intent).toMatchObject({ kind: 'money_out', payeeId: 40, amount: 50_000, from: { how: 'cash', accountId: 30 }, narration: 'tea' })
    expect(sent.aiDraftId).toBe(41)
  })

  it('Salary only with Payroll on; the owner took money = drawings; the TDS hint says it plainly', async () => {
    previewReply = () => ({ ok: true, data: { ...PREVIEW, kind: 'money_out', sentences: ['₹35,000.00 to Bharat Steel from Cash.'], tds: [{ partyName: 'Bharat Steel', sectionCode: '194C', tdsPaise: 70_000 }] } })
    renderUi(<MoneyOut />)
    await ready()
    expect(screen.queryByTestId('money-out-who-salary')).toBeNull()
    await pick('picker-money-supplier', 'Bharat')
    typeAmount('35000')
    await waitFor(() => expect(screen.getByTestId('money-tds-hint').textContent).toContain('TDS (tax deducted at source) may apply'))
    expect(screen.getByTestId('money-tds-hint').textContent).toContain('₹700.00')
    click('money-out-who-owner')
    expect(screen.getByTestId('money-owner').textContent).toContain('not a business expense')
    click('btn-money-save')
    await waitFor(() => expect(calls('simple:post')).toHaveLength(1))
    expect((calls('simple:post')[0] as { intent: Record<string, unknown> }).intent).toMatchObject({ kind: 'money_out', drawings: true })
  })
})

describe('Move money and the list (WP 9.4)', () => {
  it('the same account twice is refused under To; a move posts move_money', async () => {
    renderUi(<MoveMoney />)
    await ready()
    fireEvent.change(screen.getByTestId('select-move-from'), { target: { value: '30' } })
    typeAmount('2000')
    click('btn-money-save')
    await waitFor(() => expect(screen.getByTestId('field-error-to').textContent).toBe('Pick where the money goes.'))
    fireEvent.change(screen.getByTestId('select-move-to'), { target: { value: '31' } })
    click('btn-money-save')
    await waitFor(() => expect(calls('simple:post')).toHaveLength(1))
    expect((calls('simple:post')[0] as { intent: Record<string, unknown> }).intent).toMatchObject({ kind: 'move_money', fromId: 30, toId: 31, amount: 200_000 })
    expect(bannedWordsIn(visible())).toEqual([])
  })

  it('the list: who, in / out / moved, cash or bank, amount, chips', async () => {
    renderUi(<MoneyList />)
    await waitFor(() => expect(screen.getAllByTestId('money-row-direction')).toHaveLength(3))
    expect(screen.getAllByTestId('money-row-direction').map((e) => e.getAttribute('data-value'))).toEqual(['move', 'out', 'in'])
    expect(screen.getAllByTestId('money-row-chip').map((e) => e.textContent)).toEqual(['Expense', 'Paid bills'])
    expect(bannedWordsIn(visible())).toEqual([])
  })
})
