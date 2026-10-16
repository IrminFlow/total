// WP 9.10: the Accountant-view hand-off — the full → simple table (lib/handoff.ts), the blank full
// counterparts, the remembered-choice rule ("Accountant view" is a one-off; only "Always open the
// full app for this" stores it; "Back to simple" clears it), the unsaved form carried to the
// editor (simple:intentForm → the voucher-entry `handoff` param), and the simple rows of the ⌘K
// palette (simple mode only, from the registry).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DEFAULT_FEATURES } from '@shared/features'
import type { UiSettings } from '@shared/simple/uiMode'
import type { HandoffEntry, IntentFormResult } from '@shared/simple/handoff'
import { sanitiseHandoffEntry } from '@shared/simple/handoff'
import { emptyInvoiceState } from '@shared/voucherEdit'
import { useNav, useSession, type Screen } from '../state/stores'
import { viewOverrideKey } from '../lib/mode'
import {
  backToSimpleClears, dropKeptForms, factsQuery, fullCounterpart, rememberSaved, savedIdFor, simpleTargetFor, useAccountantView, useAlwaysFullRedirect, useBackToSimple, useKeptForm
} from '../lib/handoff'
import { simplePaletteRows, SIMPLE_ENTRIES } from '../lib/screens'
import { ViewToggle } from '../simple/ViewToggle'
import { CommandPalette } from '../components/CommandPalette'
import { HandoffBanner } from '../components/HandoffBanner'
import { DialogHost } from '../components/dialogs'
import { useUnsavedGuard } from '../lib/useUnsavedGuard'

const invoke = vi.fn()
const INFO = { name: 'Hand-off Co', stateCode: '27', gstin: '27AAPFU0939F1ZV', gstRegistrationType: 'regular', address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null }
const top = (): Screen => useNav.getState().stack.at(-1)!
const KEY = (screen: Screen['name']): string => viewOverrideKey('handoff-co', null, screen)

function withClient(ui: React.JSX.Element): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>
}

function setSession(ui: UiSettings): void {
  act(() => {
    useSession.setState({ slug: 'handoff-co', info: INFO as never, from: '2026-04-01', to: '2027-03-31', locked: false, user: null, ui, workingDate: '2026-05-10' })
  })
}

const BILL: HandoffEntry = {
  role: 'bill', kind: 'sales', voucherTypeId: 3, form: 'invoice', amount: 118_000,
  state: { ...emptyInvoiceState('2026-05-10'), number: '', partyId: 7, accountId: 9, rows: [{ itemId: 4, qtyText: '2', rate: 50_000, discount: null, godownId: null, batchId: null }] }
}
let intentForm: IntentFormResult | Error = { kind: 'sale', entries: [BILL], missing: [] }
let facts: unknown = {}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  localStorage.clear()
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'config:features:get') return { ok: true, data: DEFAULT_FEATURES }
    if (channel === 'simple:intentForm') return intentForm instanceof Error ? { ok: false, error: intentForm.message, code: 'validation' } : { ok: true, data: intentForm }
    if (channel === 'simple:handoffTarget') return { ok: true, data: facts }
    if (channel === 'search:query') return { ok: true, data: null }
    return { ok: false, error: `unmocked channel ${channel}` }
  })
  window.total = { platform: 'test', invoke } as unknown as typeof window.total
  intentForm = { kind: 'sale', entries: [BILL], missing: [] }
  facts = {}
  act(() => useNav.setState({ stack: [{ name: 'gateway' }] }))
  dropKeptForms()
})
afterEach(() => cleanup())

describe('the full → simple table', () => {
  it('a saved voucher lands on its simple view; a note on the Returns view of its original bill', () => {
    const ve: Screen = { name: 'voucher-entry', voucherId: 12 }
    const v = (kind: string, originalId: number | null = null) => ({ voucher: { id: 12, kind, originalId } }) as never
    expect(simpleTargetFor(ve, v('sales'))).toEqual({ name: 'simple-sales', billId: 12 })
    expect(simpleTargetFor(ve, v('purchase'))).toEqual({ name: 'simple-purchases', billId: 12 })
    for (const k of ['receipt', 'payment', 'contra']) expect(simpleTargetFor(ve, v(k))).toEqual({ name: 'simple-money', entryId: 12 })
    expect(simpleTargetFor(ve, v('credit_note', 5))).toEqual({ name: 'simple-return-sale', billId: 5 })
    expect(simpleTargetFor(ve, v('debit_note', 6))).toEqual({ name: 'simple-return-purchase', billId: 6 })
    expect(simpleTargetFor(ve, v('debit_note'))).toEqual({ name: 'simple-return-purchase' })
    expect(simpleTargetFor(ve, v('physical_stock'))).toEqual({ name: 'simple-stock' })
  })

  it('an unsaved editor goes back to the simple flow it stands for; a binned voucher too', () => {
    expect(simpleTargetFor({ name: 'voucher-entry', kindHint: 'sales' }, null)).toEqual({ name: 'simple-sell' })
    expect(simpleTargetFor({ name: 'voucher-entry', kindHint: 'receipt', voucherId: 3 }, {})).toEqual({ name: 'simple-money-in' })
    expect(simpleTargetFor({ name: 'voucher-entry', handoff: { from: 'simple-buy', kind: 'purchase', entry: BILL, others: [], missing: [] } }, null)).toEqual({ name: 'simple-buy' })
    expect(simpleTargetFor({ name: 'voucher-entry', kindHint: 'journal' }, null)).toEqual({ name: 'simple-section', section: 'sell' })
  })

  it('a ledger → its People page (customers / suppliers only); an item → its product; Outstandings → People; P&L → Reports', () => {
    expect(simpleTargetFor({ name: 'ledger-statement', ledgerId: 7 }, { ledger: { id: 7, isParty: true } })).toEqual({ name: 'simple-person', id: 7 })
    expect(simpleTargetFor({ name: 'ledger-statement', ledgerId: 8 }, { ledger: { id: 8, isParty: false } }).name).toBe('simple-section')
    expect(simpleTargetFor({ name: 'masters', tab: 'items', itemId: 4 }, null)).toEqual({ name: 'simple-stock', itemId: 4 })
    expect(simpleTargetFor({ name: 'masters', tab: 'ledgers', parties: true }, null)).toEqual({ name: 'simple-people' })
    expect(simpleTargetFor({ name: 'stock-movements', itemId: 4 }, null)).toEqual({ name: 'simple-stock', itemId: 4 })
    expect(simpleTargetFor({ name: 'stock-summary' }, null)).toEqual({ name: 'simple-stock' })
    // WP 9.9 is in: the plain reports whose Accountant view these screens are.
    expect(simpleTargetFor({ name: 'outstandings', side: 'receivable' }, null)).toEqual({ name: 'simple-reports', report: 'owed', side: 'receivable' })
    expect(simpleTargetFor({ name: 'outstandings', side: 'payable' }, null)).toEqual({ name: 'simple-reports', report: 'owed', side: 'payable' })
    expect(simpleTargetFor({ name: 'cash-forecast' }, null)).toEqual({ name: 'simple-reports', report: 'cash' })
    expect(simpleTargetFor({ name: 'gstr3b', month: '2026-05' }, null)).toEqual({ name: 'simple-taxes' })
    const how = SIMPLE_ENTRIES.find((e) => e.id === 'how-am-i-doing')!
    expect(how.screen).toEqual({ name: 'simple-reports', report: 'doing' })
    expect(simpleTargetFor({ name: 'profit-loss' }, null)).toEqual({ name: 'simple-reports', report: 'doing' })
    expect(simpleTargetFor({ name: 'banking', tab: 'import', ledgerId: 2 }, null)).toEqual({ name: 'simple-bank', bankId: 2 })
    expect(simpleTargetFor({ name: 'manufacture', prefill: { itemId: 4, qtyMilli: 1000 } }, null)).toEqual({ name: 'simple-made-goods', itemId: 4 })
    // Everything else: the section list (as before).
    expect(simpleTargetFor({ name: 'daybook' }, null)).toEqual({ name: 'simple-section', section: 'money' })
  })

  it('what is asked of main, and which remembered choices Back to simple clears', () => {
    expect(factsQuery({ name: 'voucher-entry', kindHint: 'sales' }, null)).toBeNull()
    expect(factsQuery({ name: 'voucher-entry', kindHint: 'sales' }, 31)).toEqual({ voucherId: 31 })
    expect(factsQuery({ name: 'voucher-entry', voucherId: 4 }, 31)).toEqual({ voucherId: 4 })
    expect(factsQuery({ name: 'ledger-statement', ledgerId: 7 }, null)).toEqual({ ledgerId: 7 })
    expect(factsQuery({ name: 'daybook' }, null)).toBeNull()
    expect(backToSimpleClears({ name: 'voucher-entry', kindHint: 'sales' }, { name: 'simple-sales', billId: 3 }).sort()).toEqual(['simple-sales', 'simple-sell'])
  })

  it('the blank full counterpart of every simple flow', () => {
    expect(fullCounterpart({ name: 'simple-sell' })).toEqual({ name: 'voucher-entry', kindHint: 'sales' })
    expect(fullCounterpart({ name: 'simple-buy' })).toEqual({ name: 'voucher-entry', kindHint: 'purchase' })
    expect(fullCounterpart({ name: 'simple-sell', party: 7 })).toEqual({ name: 'voucher-entry', kindHint: 'sales', draft: { partyLedgerId: 7 } })
    expect(fullCounterpart({ name: 'simple-money-in' })).toEqual({ name: 'voucher-entry', kindHint: 'receipt' })
    expect(fullCounterpart({ name: 'simple-money-out' })).toEqual({ name: 'voucher-entry', kindHint: 'payment' })
    expect(fullCounterpart({ name: 'simple-move-money' })).toEqual({ name: 'voucher-entry', kindHint: 'contra' })
    expect(fullCounterpart({ name: 'simple-return-sale' })).toEqual({ name: 'voucher-entry', kindHint: 'credit_note' })
    expect(fullCounterpart({ name: 'simple-return-purchase' })).toEqual({ name: 'voucher-entry', kindHint: 'debit_note' })
    expect(fullCounterpart({ name: 'simple-stock-count' })).toEqual({ name: 'voucher-entry', kindHint: 'physical_stock' })
    expect(fullCounterpart({ name: 'simple-made-goods' })).toEqual({ name: 'manufacture' })
    expect(fullCounterpart({ name: 'simple-people' })).toBeNull()
  })

  it('the hand-off never points at a ledger the rehearsal created; the bill name follows the number again', () => {
    const out = sanitiseHandoffEntry({ ...BILL, state: { ...BILL.state, number: '7', billName: '7', partyId: 99 } }, (id) => id !== 99, () => 'Cash sale')
    expect(out.missing).toEqual(['Cash sale'])
    if (out.entry.form !== 'invoice') throw new Error('invoice')
    expect(out.entry.state).toMatchObject({ partyId: null, number: '', billName: '', accountId: 9 })
  })
})

describe('the remembered choice', () => {
  it('Home: "Accountant view" is a one-off; "Always open the full app for this" remembers it; Back to simple clears it', async () => {
    setSession({ mode: 'simple' })
    const { rerender } = render(withClient(<ViewToggle screen={{ name: 'gateway' }} className="" />))
    fireEvent.click(screen.getByTestId('btn-accountant-view'))
    expect(localStorage.getItem(KEY('gateway'))).toBeNull()
    expect(await screen.findByTestId('btn-back-to-simple')).toBeTruthy()
    fireEvent.click(screen.getByTestId('btn-back-to-simple'))
    expect(await screen.findByTestId('btn-accountant-view')).toBeTruthy()
    fireEvent.click(screen.getByTestId('btn-accountant-view-more'))
    fireEvent.click(await screen.findByTestId('btn-accountant-view-always'))
    expect(localStorage.getItem(KEY('gateway'))).toBe('accountant')
    rerender(withClient(<ViewToggle screen={{ name: 'gateway' }} className="" />))
    fireEvent.click(await screen.findByTestId('btn-back-to-simple'))
    await waitFor(() => expect(localStorage.getItem(KEY('gateway'))).toBeNull())
  })

  it('a simple flow: a one-off opens the editor with the answers; "always" also stores it, and the flow then opens the full app on arrival', async () => {
    setSession({ mode: 'simple' })
    act(() => useNav.setState({ stack: [{ name: 'gateway' }, { name: 'simple-sell' }] }))
    const { result } = renderHook(() => useAccountantView('simple-sell'), { wrapper: ({ children }) => withClient(<>{children}</>) })
    await act(async () => result.current({ intent: { kind: 'sale', date: '2026-05-10', customerId: 7, items: [{ itemId: 4, qty: 2000, rate: 50_000 }], payment: { how: 'credit' } } }))
    expect(top()).toMatchObject({ name: 'voucher-entry', handoff: { from: 'simple-sell', kind: 'sale', entry: BILL, others: [], missing: [] } })
    expect(localStorage.getItem(KEY('simple-sell'))).toBeNull()
    expect(invoke).toHaveBeenCalledWith('simple:intentForm', expect.objectContaining({ intent: expect.objectContaining({ kind: 'sale', clientId: 'accountant-view-handoff' }), today: '2026-05-10' }))

    act(() => useNav.setState({ stack: [{ name: 'gateway' }, { name: 'simple-sell' }] }))
    await act(async () => result.current({ intent: null, always: true }))
    expect(top()).toEqual({ name: 'voucher-entry', kindHint: 'sales' })
    expect(localStorage.getItem(KEY('simple-sell'))).toBe('accountant')

    // Arriving at Make a bill again → straight to the full sales editor.
    act(() => useNav.setState({ stack: [{ name: 'gateway' }, { name: 'simple-sell' }] }))
    renderHook(() => useAlwaysFullRedirect(), { wrapper: ({ children }) => withClient(<>{children}</>) })
    await waitFor(() => expect(top()).toEqual({ name: 'voucher-entry', kindHint: 'sales' }))

    // Back to simple from there: Make a bill, the choice cleared.
    const back = renderHook(() => useBackToSimple(), { wrapper: ({ children }) => withClient(<>{children}</>) })
    await act(async () => back.result.current())
    expect(top()).toEqual({ name: 'simple-sell' })
    expect(localStorage.getItem(KEY('simple-sell'))).toBeNull()
  })

  it('review: Back / Esc from the full editor "Always" opened returns to the flow — no second blank editor', async () => {
    setSession({ mode: 'simple' })
    const flow: Screen = { name: 'simple-sell' }
    act(() => useNav.setState({ stack: [{ name: 'gateway' }, flow] }))
    renderHook(() => useAlwaysFullRedirect(), { wrapper: ({ children }) => withClient(<>{children}</>) })
    // Arrived without the choice: the flow stays; the user then picks "Always" there.
    expect(top()).toBe(flow)
    localStorage.setItem(KEY('simple-sell'), 'accountant')
    act(() => useNav.setState({ stack: [{ name: 'gateway' }, flow, { name: 'voucher-entry', kindHint: 'sales' }] }))
    act(() => useNav.setState({ stack: [{ name: 'gateway' }, flow] })) // Back
    await new Promise((r) => setTimeout(r, 20))
    expect(top()).toBe(flow)
    // A NEW arrival still opens the full app — even with the very same Screen object (the
    // registry's section entries push one shared object every time).
    act(() => useNav.setState({ stack: [{ name: 'gateway' }] }))
    act(() => useNav.setState({ stack: [{ name: 'gateway' }, flow] }))
    await waitFor(() => expect(top()).toEqual({ name: 'voucher-entry', kindHint: 'sales' }))
  })

  it('review: "Back to simple" from an unsaved editor asks first; "Stay" keeps the editor AND the remembered choice', async () => {
    setSession({ mode: 'simple' })
    localStorage.setItem(KEY('simple-sell'), 'accountant')
    const editor: Screen = { name: 'voucher-entry', kindHint: 'sales' }
    act(() => useNav.setState({ stack: [{ name: 'gateway' }, editor] }))
    const Dirty = (): null => {
      useUnsavedGuard(true)
      return null
    }
    render(withClient(<><Dirty /><DialogHost /></>))
    const back = renderHook(() => useBackToSimple(), { wrapper: ({ children }) => withClient(<>{children}</>) })
    let done: Promise<void> | undefined
    act(() => {
      done = back.result.current()
    })
    fireEvent.click(await screen.findByTestId('confirm-cancel'))
    await act(async () => done)
    expect(top()).toBe(editor)
    expect(localStorage.getItem(KEY('simple-sell'))).toBe('accountant')
    act(() => {
      done = back.result.current()
    })
    fireEvent.click(await screen.findByTestId('confirm-ok'))
    await act(async () => done)
    expect(top()).toEqual({ name: 'simple-sell' })
    expect(localStorage.getItem(KEY('simple-sell'))).toBeNull()
  })

  it('answers the mapping refuses open the blank editor (no discard question — the answers are kept); a saved form opens the saved voucher', async () => {
    setSession({ mode: 'simple' })
    intentForm = new Error('Pick a product')
    const flow: Screen = { name: 'simple-buy' }
    act(() => useNav.setState({ stack: [{ name: 'gateway' }, flow] }))
    const Dirty = (): null => {
      useUnsavedGuard(true)
      return null
    }
    const dirty = render(withClient(<><Dirty /><DialogHost /></>))
    const { result } = renderHook(() => useAccountantView('simple-buy'), { wrapper: ({ children }) => withClient(<>{children}</>) })
    await act(async () => result.current({ intent: { kind: 'purchase', date: '2026-05-10', supplierId: 3, items: [] } as never, keep: { form: { supplierId: 3 } } }))
    expect(top()).toEqual({ name: 'voucher-entry', kindHint: 'purchase' })
    expect(screen.queryByTestId('confirm-ok')).toBeNull()
    dirty.unmount()
    // Back from the blank editor: the purchase form with the answers.
    act(() => useNav.getState().back())
    await waitFor(() => expect(top()).toBe(flow))
    expect(renderHook(() => useKeptForm({ supplierId: null as number | null })).result.current[0]).toEqual({ supplierId: 3 })
    await act(async () => result.current({ intent: null, savedId: 44 }))
    await waitFor(() => expect(top()).toEqual({ name: 'voucher-entry', voucherId: 44 }))
  })

  it('review: Cancel / Back to simple from a handed-off editor come back to the answers typed; a fresh visit is blank', async () => {
    setSession({ mode: 'simple' })
    const flow: Screen = { name: 'simple-sell' }
    act(() => useNav.setState({ stack: [{ name: 'gateway' }, flow] }))
    const wrapper = ({ children }: { children: React.ReactNode }): React.JSX.Element => withClient(<>{children}</>)
    const { result } = renderHook(() => useAccountantView('simple-sell'), { wrapper })
    const answers = { customer: 7, qty: '2' }
    await act(async () => result.current({ intent: { kind: 'sale', date: '2026-05-10', customerId: 7, items: [{ itemId: 4, qty: 2000, rate: 50_000 }], payment: { how: 'credit' } }, keep: { form: answers } }))
    expect(top()).toMatchObject({ name: 'voucher-entry', handoff: { from: 'simple-sell' } })
    // Back to simple: back to the SAME entry (not a new blank copy), which starts from the answers.
    const back = renderHook(() => useBackToSimple(), { wrapper })
    await act(async () => back.result.current())
    expect(top()).toBe(flow)
    expect(renderHook(() => useKeptForm({ customer: null as number | null, qty: '' })).result.current[0]).toEqual(answers)
    // Taken once: the next visit of the same entry starts blank.
    expect(renderHook(() => useKeptForm({ customer: null as number | null, qty: '' })).result.current[0]).toEqual({ customer: null, qty: '' })

    // Saved in the editor instead: the answers are never offered again.
    await act(async () => result.current({ intent: { kind: 'sale', date: '2026-05-10', customerId: 7, items: [{ itemId: 4, qty: 2000, rate: 50_000 }], payment: { how: 'credit' } }, keep: { form: answers } }))
    rememberSaved(60)
    act(() => useNav.setState({ stack: [{ name: 'gateway' }, flow] }))
    expect(renderHook(() => useKeptForm({ customer: null as number | null, qty: '' })).result.current[0]).toEqual({ customer: null, qty: '' })

    // Left the entry another way (the stack no longer holds it): dropped.
    await act(async () => result.current({ intent: { kind: 'sale', date: '2026-05-10', customerId: 7, items: [{ itemId: 4, qty: 2000, rate: 50_000 }], payment: { how: 'credit' } }, keep: { form: answers } }))
    act(() => useNav.setState({ stack: [{ name: 'gateway' }] }))
    act(() => useNav.setState({ stack: [{ name: 'gateway' }, flow] }))
    expect(renderHook(() => useKeptForm({ customer: null as number | null, qty: '' })).result.current[0]).toEqual({ customer: null, qty: '' })
  })

  it('the voucher a simple-mode editor just saved is what Back to simple means', async () => {
    setSession({ mode: 'simple' })
    const editor: Screen = { name: 'voucher-entry', kindHint: 'sales' }
    act(() => useNav.setState({ stack: [{ name: 'gateway' }, editor] }))
    rememberSaved(51)
    expect(savedIdFor(editor)).toBe(51)
    expect(savedIdFor({ name: 'voucher-entry', kindHint: 'sales' })).toBeNull()
    facts = { voucher: { id: 51, kind: 'sales', originalId: null } }
    const back = renderHook(() => useBackToSimple(), { wrapper: ({ children }) => withClient(<>{children}</>) })
    await act(async () => back.result.current())
    expect(invoke).toHaveBeenCalledWith('simple:handoffTarget', { voucherId: 51 })
    expect(top()).toEqual({ name: 'simple-sales', billId: 51 })
  })

  it('the editor banner says what is filled in, the payment left out and accounts not set up yet', () => {
    render(withClient(<HandoffBanner handoff={{ from: 'simple-sell', kind: 'sale', entry: BILL, others: [{ role: 'payment', kind: 'receipt', amount: 50_000 }], missing: ['Cash sale'] }} />))
    expect(screen.getByTestId('handoff-banner').textContent).toContain('Your answers are filled in')
    expect(screen.getByTestId('handoff-other').textContent).toBe('The ₹500.00 you got now is not part of this form. After you save, add it under Money in.')
    expect(screen.getByTestId('handoff-missing').textContent).toBe('Not set up yet: Cash sale. Pick or create it here.')
  })
})

describe('⌘K: the simple screens, in simple mode only', () => {
  it('rows come from the registry: the simple flows, then the sections; features and GST gate them', () => {
    const rows = simplePaletteRows({ features: { ...DEFAULT_FEATURES }, regular: true, aiReady: false })
    const ids = rows.map((r) => r.id)
    for (const id of ['make-bill', 'record-purchase', 'money-in', 'money-out', 'move-money', 'sale-returns', 'purchase-returns', 'stock-count', 'customers-suppliers', 'bank', 'section-people', 'section-reports', 'section-taxes', 'section-stock'])
      expect(ids).toContain(id)
    expect(ids[0]).toBe('make-bill')
    // Every row is a simple-native screen or a section — never an accountant-only screen.
    for (const r of rows) expect(r.screen.name === 'gateway' || r.screen.name.startsWith('simple-')).toBe(true)
    const noStock = simplePaletteRows({ features: { ...DEFAULT_FEATURES, inventory: false }, regular: true, aiReady: false }).map((r) => r.id)
    expect(noStock).not.toContain('stock-count')
    expect(noStock).not.toContain('section-stock')
  })

  it('the palette lists them first in a simple company, and runs Make a bill; an accountant company sees none', async () => {
    setSession({ mode: 'simple' })
    const onClose = vi.fn()
    render(withClient(<CommandPalette onClose={onClose} />))
    const row = await screen.findByTestId('palette-simple-make-bill')
    expect(row.textContent).toBe('Make a bill')
    expect(screen.getByTestId('palette-section-simple').textContent).toContain('Simple screens')
    fireEvent.change(screen.getByTestId('input-palette'), { target: { value: 'make a' } })
    fireEvent.keyDown(screen.getByTestId('input-palette'), { key: 'Enter' })
    await waitFor(() => expect(top()).toEqual({ name: 'simple-sell' }))
    // Opened with nothing typed, a simple company's palette holds only the simple screens — the
    // full app's commands (New voucher, Ledgers …) come with a search, under "Full app".
    fireEvent.change(screen.getByTestId('input-palette'), { target: { value: '' } })
    await screen.findByTestId('palette-simple-make-bill')
    expect(screen.queryByText('New voucher')).toBeNull()
    expect(screen.queryByTestId('palette-section-commands')).toBeNull()
    fireEvent.change(screen.getByTestId('input-palette'), { target: { value: 'new vouch' } })
    await screen.findByText('New voucher')
    expect(screen.getByTestId('palette-section-commands').textContent).toContain('Full app')
    cleanup()
    setSession({ mode: 'accountant' })
    render(withClient(<CommandPalette onClose={() => {}} />))
    await screen.findByTestId('input-palette')
    expect(screen.queryByTestId('palette-simple-make-bill')).toBeNull()
    expect(screen.queryByTestId('palette-section-simple')).toBeNull()
  })
})
