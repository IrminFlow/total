// WP 9.8 — the simple People screens (simple/people/…): the list shows who owes you / whom you
// owe from simple:people:list with late / paid-ahead / hold chips and filters; a row opens the
// person's page; the page's buttons open Money in / Make a bill (customer) and Money out / Record
// a purchase (supplier) for that person; a bad phone or day count sits under its field and
// nothing is sent; a good one goes through simple:people:update; the reminder is the letter's
// facts as plain text (copied → logged as 'copied'); hold is the owner's; a viewer sees no
// buttons that write; Bills to pay lists the bills with Pay → Money out for that bill. No banned
// word on any of it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CompanyInfo, Group, Ledger } from '@shared/domain'
import type { BillsToPay as BillsData, PeopleList as PeopleData, PersonView as PersonData } from '@shared/simple/people'
import { bannedWordsIn } from '@shared/simple/bannedWords'
import { useNav, useSession } from '../state/stores'
import { PeopleList } from '../simple/people/PeopleList'
import { PersonView } from '../simple/people/PersonView'

const invoke = vi.fn()
const GROUPS: Group[] = [
  { id: 1, name: 'Current Assets', parentId: null, nature: 'asset', affectsGrossProfit: false, isSystem: true },
  { id: 2, name: 'Sundry Debtors', parentId: 1, nature: 'asset', affectsGrossProfit: false, isSystem: true },
  { id: 3, name: 'Sundry Creditors', parentId: null, nature: 'liability', affectsGrossProfit: false, isSystem: true }
]
const ledger = (id: number, name: string, groupId: number): Ledger =>
  ({ id, name, groupId, openingBalance: 0, gstin: null, stateCode: '27', address: null, taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null, isSystem: false }) as Ledger
const TODAY = '2026-10-14'
const LIST: PeopleData = {
  today: TODAY,
  people: [
    { ledgerId: 10, name: 'Ramesh', side: 'customer', phone: '98765 43210', whatsapp: null, creditDays: 15, onHold: false, open: 150_000, ahead: 0, late: 100_000, lateBills: 1, maxLateDays: 25, walkIn: false },
    { ledgerId: 11, name: 'Sita', side: 'customer', phone: null, whatsapp: null, creditDays: null, onHold: true, open: 0, ahead: 20_000, late: 0, lateBills: 0, maxLateDays: 0, walkIn: false },
    { ledgerId: 20, name: 'Bharat Steel', side: 'supplier', phone: null, whatsapp: null, creditDays: 30, onHold: false, open: 80_000, ahead: 0, late: 0, lateBills: 0, maxLateDays: 0, walkIn: false }
  ],
  totals: { owesYou: 150_000, youOwe: 80_000, customersAhead: 20_000, suppliersAhead: 0 }
}
const RAMESH: PersonData = {
  ...LIST.people[0]!,
  email: null,
  bills: [
    { name: '1', voucherId: 101, date: '2026-09-04', dueDate: '2026-09-19', amount: 100_000, pending: 100_000, overdueDays: 25 },
    { name: '2', voucherId: 102, date: '2026-10-10', dueDate: '2026-10-25', amount: 50_000, pending: 50_000, overdueDays: 0 }
  ],
  reminder: {
    bucket: 'gentle',
    bills: [{ name: '1', voucherId: 101, date: '2026-09-04', dueDate: '2026-09-19', amount: 100_000, pending: 100_000, overdueDays: 25 }],
    amount: 100_000,
    lastSent: null,
    allowed: true,
    nextAllowed: null
  },
  holdReason: null,
  company: 'Sharma Traders',
  today: TODAY
}
const BHARAT: PersonData = { ...LIST.people[2]!, email: null, bills: [{ name: 'BS-9', voucherId: 201, date: '2026-10-01', dueDate: '2026-10-31', amount: 80_000, pending: 80_000, overdueDays: 0 }], reminder: null, holdReason: null, company: 'Sharma Traders', today: TODAY }
const BILLS: BillsData = {
  today: TODAY,
  bills: [{ ...BHARAT.bills[0]!, ledgerId: 20, party: 'Bharat Steel' }],
  weekEnd: '2026-10-18',
  monthEnd: '2026-10-31',
  dueThisWeek: 0,
  dueThisMonth: 80_000,
  late: 0
}
const info: CompanyInfo = { name: 'Sharma Traders', stateCode: '27', gstin: null, gstRegistrationType: 'unregistered', address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null }
const calls = (ch: string): unknown[] => invoke.mock.calls.filter(([c]) => c === ch).map(([, p]) => p)
let rameshNow: PersonData = RAMESH
let updateReply: () => { ok: boolean; data?: unknown; error?: string; code?: string; field?: string }

function renderUi(ui: React.ReactElement): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}
const visibleText = (): string => document.body.textContent ?? ''

beforeEach(() => {
  rameshNow = RAMESH
  updateReply = () => ({ ok: true, data: { ledgerId: 10, phone: '9876543210', whatsapp: null, creditDays: 20 } })
  invoke.mockImplementation(async (channel: string, payload: { id?: number }) => {
    switch (channel) {
      case 'master:groups:list': return { ok: true, data: GROUPS }
      case 'master:ledgers:list': return { ok: true, data: [ledger(10, 'Ramesh', 2), ledger(20, 'Bharat Steel', 3)] }
      case 'simple:people:list': return { ok: true, data: LIST }
      case 'simple:people:person': return { ok: true, data: payload.id === 20 ? BHARAT : rameshNow }
      case 'receivables:statementPdf': return { ok: true, data: { path: '/tmp/exports/statement.pdf' } }
      case 'simple:people:billsToPay': return { ok: true, data: BILLS }
      case 'simple:people:update': return updateReply()
      case 'simple:people:reminded': return { ok: true, data: { logId: 1 } }
      case 'receivables:setHold': return { ok: true, data: { hold: true, reason: 'x', at: null } }
      default: return { ok: true, data: [] }
    }
  })
  window.total = { platform: 'test', invoke }
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } })
  act(() => {
    useSession.setState({ info, slug: 'sharma', ui: { mode: 'simple' }, workingDate: TODAY, from: '2026-04-01', to: '2027-03-31', user: null })
    useNav.setState({ stack: [{ name: 'simple-people' }] })
  })
})
afterEach(() => {
  cleanup()
  invoke.mockReset()
})

describe('the People list', () => {
  it('shows who owes you / whom you owe with late, paid-ahead and hold chips, and the totals', async () => {
    renderUi(<PeopleList />)
    await waitFor(() => expect(screen.getByTestId('people-totals').textContent).toBe('Customers owe you ₹1,500.00 · You owe suppliers ₹800.00'))
    const rows = screen.getByTestId('rows-simple-people')
    await waitFor(() => expect(rows.querySelectorAll('tr[data-row-id]').length).toBe(3))
    const ramesh = rows.querySelector('tr[data-row-id="10"]') as HTMLElement
    expect(ramesh.textContent).toContain('1,500.00')
    expect(ramesh.textContent).toContain('98765 43210')
    expect(within(ramesh).getByTestId('person-chip-late').textContent).toBe('₹1,000.00 late · 25 days')
    expect(ramesh.textContent).toContain('15 days')
    const sita = rows.querySelector('tr[data-row-id="11"]') as HTMLElement
    expect(within(sita).getByTestId('person-chip-ahead').textContent).toBe('₹200.00 credit')
    expect(within(sita).getByTestId('person-chip-hold')).toBeTruthy()
    expect(bannedWordsIn(visibleText())).toEqual([])
  })

  it('filters: suppliers, owe you, late to pay', async () => {
    renderUi(<PeopleList />)
    const rows = await screen.findByTestId('rows-simple-people')
    await waitFor(() => expect(rows.querySelectorAll('tr[data-row-id]').length).toBe(3))
    fireEvent.click(screen.getByTestId('people-filter-suppliers'))
    expect([...rows.querySelectorAll('tr[data-row-id]')].map((r) => r.getAttribute('data-row-id'))).toEqual(['20'])
    fireEvent.click(screen.getByTestId('people-filter-owesYou'))
    expect([...rows.querySelectorAll('tr[data-row-id]')].map((r) => r.getAttribute('data-row-id'))).toEqual(['10'])
    fireEvent.click(screen.getByTestId('people-filter-late'))
    expect([...rows.querySelectorAll('tr[data-row-id]')].map((r) => r.getAttribute('data-row-id'))).toEqual(['10'])
  })

  it('a row opens the person; + New person opens the plain dialog on Customer', async () => {
    renderUi(<PeopleList />)
    const rows = await screen.findByTestId('rows-simple-people')
    await waitFor(() => expect(rows.querySelector('tr[data-row-id="20"]')).toBeTruthy())
    fireEvent.click(rows.querySelector('tr[data-row-id="20"] td')!)
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'simple-person', id: 20 }))
    fireEvent.click(screen.getByTestId('btn-people-new'))
    expect(await screen.findByTestId('dialog-new-account')).toBeTruthy()
    expect(screen.getByTestId('account-kind-customer').getAttribute('aria-checked')).toBe('true')
  })

  it('Bills to pay: the week / month header and Pay → Money out for that bill', async () => {
    renderUi(<PeopleList tab="bills" />)
    await waitFor(() => expect(screen.getByTestId('bills-due-month').getAttribute('data-paise')).toBe('80000'))
    expect(screen.getByTestId('bills-due-week').textContent).toContain('Due this week (by 18 Oct 2026)')
    const row = (await screen.findByTestId('rows-simple-bills-to-pay')).querySelector('tr[data-bill="BS-9"]') as HTMLElement
    await waitFor(() => expect(row.textContent).toContain('due in 17 days'))
    fireEvent.click(within(row).getByTestId('btn-bill-pay'))
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'simple-money-out', party: 20, amount: 80_000, bill: 'BS-9', billId: 201 }))
    expect(bannedWordsIn(visibleText())).toEqual([])
  })
})

describe('a person’s page', () => {
  it('a customer: balance, late part, open bills oldest first with their timing; Money in and Make a bill for them', async () => {
    renderUi(<PersonView id={10} />)
    await waitFor(() => expect(screen.getByTestId('person-balance').textContent).toBe('Owes you ₹1,500.00'))
    expect(screen.getByTestId('person-late').textContent).toBe('₹1,000.00 of it is late.')
    const bills = screen.getByTestId('rows-person-bills')
    expect([...bills.querySelectorAll('tr[data-bill]')].map((r) => r.getAttribute('data-bill'))).toEqual(['1', '2'])
    expect(bills.textContent).toContain('25 days overdue')
    expect(bills.textContent).toContain('due in 11 days')
    fireEvent.click(screen.getByTestId('btn-person-money-in'))
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'simple-money-in', party: 10 }))
    fireEvent.click(screen.getByTestId('btn-person-make-bill'))
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'simple-sell', party: 10 }))
    fireEvent.click(screen.getByTestId('btn-person-history'))
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'ledger-statement', ledgerId: 10 }))
    expect(screen.queryByTestId('btn-person-money-out')).toBeNull()
    expect(bannedWordsIn(visibleText())).toEqual([])
  })

  it('WP 10.8: a customer who owes but has nothing late is told why there is no reminder', async () => {
    const notLate: PersonData = { ...RAMESH, bills: [RAMESH.bills[1]!], reminder: null }
    invoke.mockImplementation(async (channel: string) => (channel === 'simple:people:person' ? { ok: true, data: notLate } : { ok: true, data: [] }))
    renderUi(<PersonView id={10} />)
    expect((await screen.findByTestId('person-nothing-late')).textContent).toBe('Nothing is late yet, so there is no reminder to send. To show them what they owe, use Statement.')
    expect(screen.queryByTestId('btn-person-remind')).toBeNull()
  })

  it('a supplier: Money out and Record a purchase; no reminder or hold', async () => {
    renderUi(<PersonView id={20} />)
    await waitFor(() => expect(screen.getByTestId('person-balance').textContent).toBe('You owe ₹800.00'))
    fireEvent.click(screen.getByTestId('btn-person-purchase'))
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'simple-buy', party: 20 }))
    fireEvent.click(screen.getByTestId('btn-person-money-out'))
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'simple-money-out', party: 20 }))
    expect(screen.queryByTestId('btn-person-remind')).toBeNull()
    expect(screen.queryByTestId('btn-person-hold')).toBeNull()
  })

  it('a bad phone / day count sits under its field and nothing is sent; a good one is saved', async () => {
    renderUi(<PersonView id={10} />)
    const phone = await screen.findByTestId('input-person-phone')
    fireEvent.change(phone, { target: { value: 'call me' } })
    fireEvent.change(screen.getByTestId('input-person-days'), { target: { value: '1.5' } })
    fireEvent.click(screen.getByTestId('btn-person-save'))
    await waitFor(() => expect(screen.getByTestId('field-error-phone').textContent).toContain('doesn’t look like a phone number'))
    expect(screen.getByTestId('field-error-creditDays').textContent).toContain('from 0 to 365')
    expect(calls('simple:people:update')).toEqual([])
    fireEvent.change(phone, { target: { value: '9876543210' } })
    fireEvent.change(screen.getByTestId('input-person-days'), { target: { value: '20' } })
    fireEvent.click(screen.getByTestId('btn-person-save'))
    await waitFor(() => expect(calls('simple:people:update')).toEqual([{ id: 10, phone: '9876543210', whatsapp: '', creditDays: 20 }]))
  })

  it('a refusal from main lands under its field', async () => {
    updateReply = () => ({ ok: false, error: 'Not a phone number', code: 'simple_people_bad_phone', field: 'whatsapp' })
    renderUi(<PersonView id={10} />)
    fireEvent.change(await screen.findByTestId('input-person-whatsapp'), { target: { value: '98765 43210' } })
    fireEvent.click(screen.getByTestId('btn-person-save'))
    await waitFor(() => expect(screen.getByTestId('field-error-whatsapp').textContent).toContain('doesn’t look like a phone number'))
  })

  it('Send a reminder: the late bills as a plain message; Copy writes it and logs it as copied', async () => {
    renderUi(<PersonView id={10} />)
    fireEvent.click(await screen.findByTestId('btn-person-remind'))
    const text = (screen.getByTestId('reminder-text') as HTMLTextAreaElement).value
    expect(text).toContain('Hello Ramesh,')
    expect(text).toContain('This is a friendly reminder from Sharma Traders: ₹1,000.00 is now past its due date.')
    expect(text).toContain('• Bill 1 of 4 Sep 2026: ₹1,000.00')
    expect(text).not.toContain('Bill 2')
    expect(bannedWordsIn(text)).toEqual([])
    fireEvent.click(screen.getByTestId('btn-reminder-copy'))
    await waitFor(() => expect(calls('simple:people:reminded')).toEqual([{ id: 10, via: 'copied', today: TODAY }]))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(text)
    expect(screen.getByTestId('reminder-note').textContent).toContain('noted as a reminder sent today')
    fireEvent.click(screen.getByTestId('reminder-lang-hinglish'))
    expect((screen.getByTestId('reminder-text') as HTMLTextAreaElement).value).toContain('Namaste Ramesh ji,')
    // WhatsApp: a wa.me link for the saved number, opened by the OS browser.
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    fireEvent.click(screen.getByTestId('btn-reminder-whatsapp'))
    await waitFor(() => expect(open).toHaveBeenCalled())
    expect(open.mock.calls[0]![0]).toMatch(/^https:\/\/wa\.me\/919876543210\?text=Namaste/)
    // The same message copied and then opened in WhatsApp is ONE reminder in the log.
    expect(screen.getByTestId('reminder-note').textContent).toContain('WhatsApp')
    expect(calls('simple:people:reminded')).toHaveLength(1)
    open.mockRestore()
  })

  it('inside the "don\'t remind again" window the first send asks first; Not now sends nothing, Send again goes ahead', async () => {
    rameshNow = { ...RAMESH, reminder: { ...RAMESH.reminder!, lastSent: '2026-10-11', allowed: false, nextAllowed: '2026-10-18' } }
    renderUi(<PersonView id={10} />)
    fireEvent.click(await screen.findByTestId('btn-person-remind'))
    expect(screen.getByTestId('reminder-last').textContent).toContain('You can still send it.')
    fireEvent.click(screen.getByTestId('btn-reminder-copy'))
    expect(screen.getByTestId('reminder-again').textContent).toContain('You reminded them 3 days ago. Send again?')
    expect(bannedWordsIn(screen.getByTestId('reminder-again').textContent ?? '')).toEqual([])
    fireEvent.click(screen.getByTestId('btn-reminder-again-no'))
    expect(screen.queryByTestId('reminder-again')).toBeNull()
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
    expect(calls('simple:people:reminded')).toEqual([])
    fireEvent.click(screen.getByTestId('btn-reminder-sms'))
    fireEvent.click(screen.getByTestId('btn-reminder-again-yes'))
    await waitFor(() => expect(calls('simple:people:reminded')).toEqual([{ id: 10, via: 'sms', today: TODAY }]))
    expect(navigator.clipboard.writeText).toHaveBeenCalled()
    // Asked once per panel: the next way (the same message) goes straight through.
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    fireEvent.click(screen.getByTestId('btn-reminder-whatsapp'))
    expect(screen.queryByTestId('reminder-again')).toBeNull()
    await waitFor(() => expect(open).toHaveBeenCalled())
    open.mockRestore()
  })

  it('outside the window (or never reminded) nothing is asked', async () => {
    renderUi(<PersonView id={10} />)
    fireEvent.click(await screen.findByTestId('btn-person-remind'))
    fireEvent.click(screen.getByTestId('btn-reminder-copy'))
    expect(screen.queryByTestId('reminder-again')).toBeNull()
    await waitFor(() => expect(calls('simple:people:reminded')).toHaveLength(1))
  })

  it('hold: the owner is asked why; the reason is required', async () => {
    renderUi(<PersonView id={10} />)
    fireEvent.click(await screen.findByTestId('btn-person-hold'))
    fireEvent.click(screen.getByTestId('btn-hold-confirm'))
    expect(screen.getByTestId('field-error-reason').textContent).toBe('Say why, so you remember later.')
    expect(calls('receivables:setHold')).toEqual([])
    fireEvent.change(screen.getByTestId('input-hold-reason'), { target: { value: 'Cheque bounced' } })
    fireEvent.click(screen.getByTestId('btn-hold-confirm'))
    await waitFor(() => expect(calls('receivables:setHold')).toEqual([{ ledgerId: 10, hold: true, reason: 'Cheque bounced' }]))
  })

  it('a viewer sees the figures but no button that writes; an accountant has no hold', async () => {
    act(() => useSession.setState({ user: { id: 2, name: 'Vik', role: 'viewer' } as never }))
    renderUi(<PersonView id={10} />)
    await screen.findByTestId('person-balance')
    for (const id of ['btn-person-money-in', 'btn-person-make-bill', 'btn-person-remind', 'btn-person-hold', 'btn-person-save', 'btn-person-edit']) {
      expect(screen.queryByTestId(id), id).toBeNull()
    }
    expect(screen.getByTestId('btn-person-history')).toBeTruthy()
    // PR #92 follow-up: a viewer gets the same Statement (receivables:statementPdf is a viewer read).
    fireEvent.click(screen.getByTestId('btn-person-statement'))
    await waitFor(() => expect(calls('receivables:statementPdf')).toEqual([{ ledgerId: 10, from: '2026-04-01', to: TODAY }]))
    expect(await screen.findByTestId('person-statement-saved')).toBeTruthy()
    cleanup()
    act(() => useSession.setState({ user: { id: 3, name: 'Asha', role: 'accountant' } as never }))
    renderUi(<PersonView id={10} />)
    await screen.findByTestId('btn-person-remind')
    expect(screen.queryByTestId('btn-person-hold')).toBeNull()
  })
})
