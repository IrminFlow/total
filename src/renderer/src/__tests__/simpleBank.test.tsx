// WP 9.6 — the simple Bank screen (simple/bank/BankScreen): suggestions pre-selected with their
// "because …", accept one / accept all through simple:bank:accept (a failed line keeps its problem
// on its row, the picker's under the picker), the BRS sentence and its "see them" hand-off to the
// full Banking → BRS on this account, a dropped statement's bytes go to the existing preview /
// commit channels (never a path), a company without a bank gets "Add a bank account", and no
// banned word anywhere.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CompanyInfo, Group, Ledger } from '@shared/domain'
import type { BankAcceptResult, BankSetup, BankView } from '@shared/simple/bank'
import { bannedWordsIn } from '@shared/simple/bannedWords'
import { useNav, useSession } from '../state/stores'
import { BankScreen } from '../simple/bank/BankScreen'

const invoke = vi.fn()
const GROUPS: Group[] = [
  { id: 1, name: 'Current Assets', parentId: null, nature: 'asset', affectsGrossProfit: false, isSystem: true },
  { id: 2, name: 'Sundry Debtors', parentId: 1, nature: 'asset', affectsGrossProfit: false, isSystem: true },
  { id: 3, name: 'Bank Accounts', parentId: 1, nature: 'asset', affectsGrossProfit: false, isSystem: true },
  { id: 4, name: 'Indirect Expenses', parentId: null, nature: 'expense', affectsGrossProfit: false, isSystem: true }
]
const ledger = (id: number, name: string, groupId: number, extra: Partial<Ledger> = {}): Ledger =>
  ({ id, name, groupId, openingBalance: 0, gstin: null, stateCode: '27', address: null, taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null, isSystem: false, ...extra }) as Ledger
const LEDGERS = [ledger(10, 'Ramesh Traders', 2), ledger(31, 'HDFC Bank', 3), ledger(40, 'Bank charges', 4, { simpleCategory: 'bank_charges' } as Partial<Ledger>), ledger(41, 'Rent', 4)]
const SETUP: BankSetup = {
  banks: [{ id: 31, name: 'HDFC Bank' }],
  accounts: [
    { id: 10, name: 'Ramesh Traders', cls: 'debtor', category: null, owner: false },
    { id: 30, name: 'Cash', cls: 'cash', category: null, owner: false },
    { id: 31, name: 'HDFC Bank', cls: 'bank', category: null, owner: false },
    { id: 40, name: 'Bank charges', cls: 'expense', category: 'bank_charges', owner: false },
    { id: 41, name: 'Rent', cls: 'expense', category: 'rent', owner: false }
  ],
  ids: { bankCharges: 40, interest: null, ownerMoney: null, drawings: null }
}
const VIEW: BankView = {
  bankLedgerId: 31,
  bankName: 'HDFC Bank',
  lines: [
    {
      id: 1, date: '2026-10-02', description: 'NEFT-RAMESH TRADERS-UTR9', reference: 'N1', side: 'deposit', amount: 400_000, status: 'open', done: [], match: null,
      suggestion: { choice: { kind: 'customer', partyId: 10 }, source: 'party', because: { key: 'simple.bank.because.party', vars: { name: 'Ramesh Traders' } } }
    },
    {
      id: 2, date: '2026-10-05', description: 'SMS CHARGES JUL-SEP', reference: '', side: 'withdrawal', amount: 5_900, status: 'open', done: [], match: null,
      suggestion: { choice: { kind: 'charges', accountId: 40 }, source: 'history', because: { key: 'simple.bank.because.history', vars: { name: 'Bank charges', words: 'SMS CHARGES' } } }
    },
    { id: 3, date: '2026-10-06', description: 'UPI-STATIONERY MART', reference: '', side: 'withdrawal', amount: 45_000, status: 'open', done: [], match: null, suggestion: null },
    { id: 4, date: '2026-10-01', description: 'CASH DEP KUMAR', reference: '', side: 'deposit', amount: 100_000, status: 'done', done: [{ voucherId: 77, name: 'Kumar Stores' }], match: null, suggestion: null }
  ],
  sentence: { asOn: '2026-10-06', differ: 2, difference: 50_000, open: 3 },
  lastImport: { id: 1, fileName: 'hdfc.csv', lineCount: 4 }
}

let setup: BankSetup = SETUP
let view: BankView = VIEW
let acceptReply: (items: { lineId: number }[]) => BankAcceptResult
const calls = (ch: string): Record<string, unknown>[] => invoke.mock.calls.filter(([c]) => c === ch).map(([, p]) => p as Record<string, unknown>)

function renderUi(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <BankScreen />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  setup = SETUP
  view = VIEW
  acceptReply = (items) => ({ done: items.map((i) => ({ lineId: i.lineId, voucherIds: [100 + i.lineId] })), failed: [] })
  invoke.mockImplementation(async (channel: string, payload: Record<string, unknown>) => {
    switch (channel) {
      case 'master:groups:list': return { ok: true, data: GROUPS }
      case 'master:ledgers:list': return { ok: true, data: LEDGERS }
      case 'simple:bank:setup': return { ok: true, data: setup }
      case 'simple:bank:lines': return { ok: true, data: view }
      case 'master:ledgers:create': return { ok: true, data: { ...LEDGERS[0], ...(payload as object), id: 90 } }
      case 'simple:bank:accept': return { ok: true, data: acceptReply(payload.items as { lineId: number }[]) }
      case 'simple:preview': return { ok: true, data: { kind: 'money_in', sentences: ['₹4,000.00 received in the bank.', 'Ramesh Traders owes nothing now.'], facts: {}, entries: [], warnings: { negativeStock: [], creditLimitExceeded: null } } }
      case 'bankImport:preview':
        return { ok: true, data: { fileName: 'oct.csv', format: 'csv', profile: null, profileSource: 'detected', grid: null, lines: [{ lineNo: 1, hash: 'h', duplicate: false, date: '2026-10-07', valueDate: null, description: 'X', reference: '', deposit: 100, withdrawal: 0, balance: null }], newCount: 1, duplicateCount: 0, warnings: [], account: null, openingBalance: null, closingBalance: null } }
      case 'bankImport:commit': return { ok: true, data: { importId: 2, inserted: 1, duplicates: 0 } }
      default: return { ok: true, data: [] }
    }
  })
  window.total = { platform: 'test', invoke }
  act(() => {
    useSession.setState({ info: { name: 'Sharma Kirana', stateCode: '27', gstin: null, gstRegistrationType: 'unregistered', address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null } as CompanyInfo, slug: 'sharma', ui: { mode: 'simple' }, workingDate: '2026-10-13', from: '2026-04-01', to: '2027-03-31' })
    useNav.setState({ stack: [{ name: 'simple-bank' }] })
  })
})
afterEach(() => {
  cleanup()
  invoke.mockReset()
})

const lineCard = (id: number): HTMLElement => screen.getAllByTestId('bank-line').find((e) => e.dataset.lineId === String(id))!
const visibleText = (): string => document.body.textContent ?? ''

describe('simple Bank (WP 9.6)', () => {
  it('pre-selects each suggestion with its plain "because …"; a line without one waits for an answer', async () => {
    renderUi()
    await waitFor(() => expect(screen.getAllByTestId('bank-line')).toHaveLength(3))
    expect(lineCard(1).dataset.choice).toBe('customer')
    expect(within(lineCard(1)).getByTestId('bank-line-because').textContent).toBe('Suggested because the bank’s description names Ramesh Traders')
    expect(within(lineCard(2)).getByTestId('bank-line-because').textContent).toContain('earlier lines starting “SMS CHARGES” went to Bank charges')
    expect(lineCard(3).dataset.choice).toBe('')
    // A customer's money: what it settles comes from simple:preview, never worked out here.
    await waitFor(() => expect(within(lineCard(1)).getByTestId('bank-line-preview').textContent).toContain('owes nothing now'))
    expect(calls('simple:preview')[0]).toMatchObject({ intent: { kind: 'money_in', customerId: 10, amount: 400_000, into: { how: 'bank', accountId: 31 } } })
    // Done lines stay listed; the sentence says what differs.
    expect(screen.getByTestId('bank-done').textContent).toContain('Done · Kumar Stores')
    expect(screen.getByTestId('btn-bank-see-them').textContent).toBe('2 entries differ: see them')
    expect(screen.queryByTestId('bank-ask')).toBeNull() // AI not ready: never offered
    expect(bannedWordsIn(visibleText())).toEqual([])
  })

  it('accept all sends every suggested line; a failed one keeps its problem on its row', async () => {
    acceptReply = (items) => ({
      done: items.filter((i) => i.lineId !== 2).map((i) => ({ lineId: i.lineId, voucherIds: [100 + i.lineId] })),
      failed: [{ lineId: 2, error: { message: 'Books are locked up to 2026-10-05', code: 'books_locked', field: 'date', params: { date: '5 Oct 2026' } } }]
    })
    renderUi()
    await waitFor(() => expect(screen.getByTestId('btn-bank-accept-all').textContent).toBe('Save all 2 answered lines'))
    fireEvent.click(screen.getByTestId('btn-bank-accept-all'))
    await waitFor(() => expect(calls('simple:bank:accept')).toHaveLength(1))
    const sent = calls('simple:bank:accept')[0]!
    expect(sent).toMatchObject({ bankLedgerId: 31, items: [{ lineId: 1, choice: { kind: 'customer', partyId: 10 } }, { lineId: 2, choice: { kind: 'charges', accountId: 40 } }] })
    expect((sent.items as { clientId: string }[]).every((i) => i.clientId.length >= 8)).toBe(true)
    await waitFor(() => expect(within(lineCard(2)).getByTestId('bank-line-error').textContent).toMatch(/locked/i))
    expect(screen.getByTestId('bank-note').textContent).toContain('1 line saved')
    expect(screen.getByTestId('bank-note').textContent).toContain('1 line could not be saved')
    // A retry of the same answer re-sends the same clientId (never saved twice).
    const first = (sent.items as { lineId: number; clientId: string }[]).find((i) => i.lineId === 2)!.clientId
    fireEvent.click(within(lineCard(2)).getByTestId('btn-bank-line-save'))
    await waitFor(() => expect(calls('simple:bank:accept')).toHaveLength(2))
    expect((calls('simple:bank:accept')[1]!.items as { clientId: string }[])[0]!.clientId).toBe(first)
  })

  it('an answer that needs a pick can’t be saved until it has one; the picker’s problem sits under it', async () => {
    acceptReply = () => ({ done: [], failed: [{ lineId: 3, error: { message: 'Pick two different accounts', code: 'simple_same_account', field: 'to' } }] })
    renderUi()
    await waitFor(() => expect(screen.getAllByTestId('bank-line')).toHaveLength(3))
    fireEvent.click(within(lineCard(3)).getByTestId('bank-choice-expense'))
    expect((within(lineCard(3)).getByTestId('btn-bank-line-save') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(lineCard(3)).getByTestId('bank-choice-supplier'))
    expect(within(lineCard(3)).getByTestId('picker-bank-party-3')).toBeTruthy()
    // "Skip for now" saves nothing and offers no Save.
    fireEvent.click(within(lineCard(3)).getByTestId('bank-choice-skip'))
    expect(within(lineCard(3)).queryByTestId('btn-bank-line-save')).toBeNull()
    expect(screen.getByTestId('btn-bank-accept-all').textContent).toBe('Save all 2 answered lines')
    // Moved to another account: the account is picked, and a refusal sits under that picker.
    fireEvent.click(within(lineCard(3)).getByTestId('bank-choice-transfer'))
    fireEvent.change(within(lineCard(3)).getByTestId('select-bank-transfer-3'), { target: { value: '30' } })
    fireEvent.click(within(lineCard(3)).getByTestId('btn-bank-line-save'))
    await waitFor(() => expect(calls('simple:bank:accept')).toHaveLength(1))
    expect(calls('simple:bank:accept')[0]).toMatchObject({ items: [{ lineId: 3, choice: { kind: 'transfer', accountId: 30 } }] })
    const field = await within(lineCard(3)).findByText(/different/i)
    expect(field.closest('[role="alert"]')?.getAttribute('data-testid')).not.toBe('bank-line-error')
    expect(within(lineCard(3)).queryByTestId('bank-line-error')).toBeNull()
  })

  it('"see them" opens the full Banking → BRS on this account as on the statement date', async () => {
    renderUi()
    fireEvent.click(await screen.findByTestId('btn-bank-see-them'))
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'banking', tab: 'brs', ledgerId: 31, asOn: '2026-10-06' }))
  })

  it('a dropped statement goes to the existing preview / commit as bytes, never a path', async () => {
    renderUi()
    const input = await screen.findByTestId('input-bank-file')
    const file = new File(['Date,Narration,Withdrawal,Deposit\n07/10/2026,X,,1.00\n'], 'oct.csv', { type: 'text/csv' })
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => expect(screen.getByTestId('bank-preview-found').textContent).toContain('oct.csv: 1 new line'))
    const src = calls('bankImport:preview')[0]!.source as Record<string, unknown>
    expect(src.fileName).toBe('oct.csv')
    expect(typeof src.base64).toBe('string')
    expect(src).not.toHaveProperty('path')
    fireEvent.click(screen.getByTestId('btn-bank-add-lines'))
    await waitFor(() => expect(screen.getByTestId('bank-note').textContent).toBe('Added 1 line from oct.csv.'))
    expect(calls('bankImport:commit')).toHaveLength(1)
  })

  it('a business with no bank account is offered "Add a bank account", not a dead end', async () => {
    setup = { ...SETUP, banks: [] }
    renderUi()
    expect((await screen.findByTestId('bank-no-bank')).textContent).toContain('You have no bank account in Total yet')
    expect(screen.getByTestId('btn-bank-add-bank')).toBeTruthy()
    expect(bannedWordsIn(visibleText())).toEqual([])
  })
  it('"Pick the bills yourself" opens Money in for this customer, filled in from the line (date, bank, amount, reference, description)', async () => {
    renderUi()
    await waitFor(() => expect(screen.getAllByTestId('bank-line')).toHaveLength(3))
    fireEvent.click(within(lineCard(1)).getByTestId('btn-bank-pick-bills-1'))
    await waitFor(() =>
      expect(useNav.getState().stack.at(-1)).toEqual({
        name: 'simple-money-in', party: 10, amount: 400_000, date: '2026-10-02', bankId: 31, reference: 'N1', note: 'NEFT-RAMESH TRADERS-UTR9'
      })
    )
    // Lines that are not a customer's / supplier's money offer no such link.
    expect(within(lineCard(2)).queryByTestId('btn-bank-pick-bills-2')).toBeNull()
  })
  it('two lines of one "Save all" that need the same new account share it — added once, not twice', async () => {
    setup = { ...SETUP, accounts: SETUP.accounts.filter((a) => a.id !== 40), ids: { ...SETUP.ids, bankCharges: null } }
    const charge = (id: number, date: string) => ({ id, date, description: `SMS CHARGES ${id}`, reference: '', side: 'withdrawal' as const, amount: 5_900, status: 'open' as const, done: [], match: null, suggestion: null })
    view = { ...VIEW, lines: [charge(5, '2026-10-03'), charge(6, '2026-10-04')] }
    renderUi()
    await waitFor(() => expect(screen.getAllByTestId('bank-line')).toHaveLength(2))
    fireEvent.click(within(lineCard(5)).getByTestId('bank-choice-charges'))
    fireEvent.click(within(lineCard(6)).getByTestId('bank-choice-charges'))
    fireEvent.click(screen.getByTestId('btn-bank-accept-all'))
    await waitFor(() => expect(calls('simple:bank:accept')).toHaveLength(1))
    expect(calls('master:ledgers:create')).toHaveLength(1)
    expect(calls('master:ledgers:create')[0]).toMatchObject({ name: 'Bank charges', simpleCategory: 'bank_charges' })
    const items = calls('simple:bank:accept')[0]!.items as { lineId: number; choice: { kind: string; accountId: number } }[]
    expect(items.map((i) => [i.lineId, i.choice])).toEqual([[5, { kind: 'charges', accountId: 90 }], [6, { kind: 'charges', accountId: 90 }]])
  })
})
