// CommandPalette — books search: parsed-filter chips, per-kind groups with counts and "See all"
// rows, highlighted matches, recent searches / recently opened records (per company, in
// localStorage), and the unchanged ↑/↓/↵/Esc keyboard behaviour for commands.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CompanyInfo } from '@shared/domain'
import type { SearchResponse } from '@shared/search'
import { DEFAULT_FEATURES } from '@shared/features'
import { CommandPalette } from '../components/CommandPalette'
import { useNav, useSession } from '../state/stores'
import { loadRecents, recentsKey, withQuery, withRecord, EMPTY_RECENTS, RECENT_LIMIT } from '../lib/searchRecents'
import { useDrill } from '../lib/drill'

const INFO: CompanyInfo = {
  name: 'A', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '',
  booksFrom: 2026, email: null, phone: null, pan: null, tan: null
}

const invoke = vi.fn()

function response(over: Partial<SearchResponse> = {}): SearchResponse {
  return {
    chips: [], unknown: [], terms: ['umbrella'], kinds: ['ledger', 'item', 'voucher'],
    ledgers: {
      total: 1, offset: 0,
      rows: [{ kind: 'ledger', id: 7, name: 'Umbrella Retail', groupName: 'Sundry Debtors', gstin: '27AABCD1234E1Z8', pan: null, matchField: 'name', matchText: 'Umbrella Retail' }]
    },
    items: { total: 0, offset: 0, rows: [] },
    vouchers: {
      total: 312, offset: 0,
      rows: [{
        kind: 'voucher', id: 42, typeName: 'Sales', voucherKind: 'sales', number: 'INV-12', date: '2026-04-12',
        party: 'Umbrella Retail', partyLedgerId: 7, amount: 1180000, narration: 'Office chairs', isOptional: false, postDated: true,
        matchField: 'party', matchText: 'Umbrella Retail'
      }]
    },
    ...over
  }
}

let lastSearch: unknown = null

beforeEach(() => {
  // jsdom has no layout — useKeyNav keeps the active row in view via scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn()
  localStorage.clear()
  useSession.getState().setCompany('acme-co', INFO)
  useSession.getState().setPeriod('2026-04-01', '2027-03-31')
  useNav.setState({ stack: [{ name: 'gateway' }] })
  lastSearch = null
  invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    switch (channel) {
      case 'config:features:get': return { ok: true, data: DEFAULT_FEATURES }
      case 'search:query':
        lastSearch = payload
        return { ok: true, data: response() }
      default: return { ok: false, error: `unmocked channel ${channel}` }
    }
  })
  window.total = { platform: 'test', invoke }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderPalette(onClose = vi.fn()): { onClose: ReturnType<typeof vi.fn> } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <CommandPalette onClose={onClose} />
    </QueryClientProvider>
  )
  return { onClose }
}

const input = (): HTMLInputElement => screen.getByTestId('input-palette') as HTMLInputElement
const type = (v: string): void => {
  fireEvent.change(input(), { target: { value: v } })
}
const top = (): Promise<void> => act(async () => { await Promise.resolve() })

describe('searchRecents (pure)', () => {
  it('keeps the last 10, most recent first, de-duplicated', () => {
    let r = EMPTY_RECENTS
    for (let i = 0; i < 12; i++) r = withQuery(r, `query ${i}`)
    r = withQuery(r, 'QUERY 5')
    expect(r.queries).toHaveLength(RECENT_LIMIT)
    expect(r.queries[0]).toBe('QUERY 5')
    expect(r.queries.filter((q) => q.toLowerCase() === 'query 5')).toHaveLength(1)
    expect(withQuery(r, ' x ').queries).toEqual(r.queries) // < 2 chars ignored
    let rec = EMPTY_RECENTS
    for (let i = 0; i < 12; i++) rec = withRecord(rec, 'ledger', { id: i, label: `L${i}` })
    rec = withRecord(rec, 'ledger', { id: 5, label: 'L5' })
    expect(rec.ledgers.map((l) => l.id)).toEqual([5, 11, 10, 9, 8, 7, 6, 4, 3, 2])
  })

  it('is per company and tolerates corrupt storage', () => {
    expect(recentsKey('acme-co')).toBe('total-search-recents-acme-co')
    localStorage.setItem(recentsKey('x'), '{not json')
    expect(loadRecents('x')).toEqual(EMPTY_RECENTS)
    localStorage.setItem(recentsKey('y'), JSON.stringify({ queries: ['a b', 3], ledgers: [{ id: 'bad' }, { id: 1, label: 'ok' }] }))
    expect(loadRecents('y')).toEqual({ queries: ['a b'], ledgers: [{ id: 1, label: 'ok' }], items: [], vouchers: [] })
  })
})

describe('CommandPalette', () => {
  it('shows parsed-filter chips immediately (local parse) and unknown tokens', () => {
    renderPalette()
    type('amt:>=50000 date:2026-04 colour:red')
    const chips = screen.getByTestId('palette-chips')
    expect(chips.textContent).toContain('Amount ≥ ₹50,000')
    expect(chips.textContent).toContain('April 2026')
    expect(chips.textContent).toContain('Not a filter: colour:red')
  })

  it('groups books results by kind with counts, highlights matches and offers See all', async () => {
    renderPalette()
    type('umbrella')
    await screen.findByTestId('palette-hit-voucher-42')
    expect(lastSearch).toMatchObject({ q: 'umbrella', limitPerKind: 6, fyStartYear: 2026 })
    const vouchers = screen.getByTestId('palette-section-kind-voucher')
    expect(vouchers.textContent).toContain('Vouchers')
    expect(vouchers.textContent).toContain('312')
    expect(vouchers.textContent).toContain('11,800.00') // amount
    expect(vouchers.textContent).toContain('12-Apr-26') // date
    expect(vouchers.textContent).toContain('PDC')
    // Highlighted party name.
    const marks = [...vouchers.querySelectorAll('mark')].map((m) => m.textContent)
    expect(marks).toContain('Umbrella')
    // 1 of 1 ledgers → no See all; 1 of 312 vouchers → See all.
    expect(screen.queryByTestId('palette-see-all-ledger')).toBeNull()
    expect(screen.getByTestId('palette-see-all-voucher').textContent).toContain('See all 312 vouchers')
    // Items section with zero hits is omitted.
    expect(screen.queryByTestId('palette-section-kind-item')).toBeNull()
  })

  it('See all opens the Search results screen for that kind and records the query', async () => {
    const { onClose } = renderPalette()
    type('umbrella')
    fireEvent.click(await screen.findByTestId('palette-see-all-voucher'))
    expect(onClose).toHaveBeenCalled()
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'search', q: 'umbrella', kind: 'voucher' }))
    expect(loadRecents('acme-co').queries).toEqual(['umbrella'])
  })

  it('⌘↵ opens all results for the current query', async () => {
    renderPalette()
    type('umbrella')
    fireEvent.keyDown(input(), { key: 'Enter', metaKey: true })
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'search', q: 'umbrella' }))
  })

  it('opening a hit navigates and remembers it as a recently opened record', async () => {
    renderPalette()
    type('umbrella')
    fireEvent.click(await screen.findByTestId('palette-hit-voucher-42'))
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'voucher-entry', voucherId: 42 }))
    const r = loadRecents('acme-co')
    expect(r.vouchers[0]).toMatchObject({ id: 42, label: 'Sales INV-12' })
    expect(r.queries).toEqual(['umbrella'])
  })

  it('empty query shows recent searches, recently opened records and the syntax help row', async () => {
    let r = withQuery(EMPTY_RECENTS, 'amt:>50000')
    r = withRecord(r, 'ledger', { id: 7, label: 'Umbrella Retail', sub: 'Sundry Debtors' })
    r = withRecord(r, 'item', { id: 3, label: 'Office Chair' })
    localStorage.setItem(recentsKey('acme-co'), JSON.stringify(r))
    // Another company's recents never leak in.
    localStorage.setItem(recentsKey('other-co'), JSON.stringify(withQuery(EMPTY_RECENTS, 'secret')))
    renderPalette()
    await top()
    expect(screen.getByTestId('palette-section-recent-q').textContent).toContain('amt:>50000')
    expect(screen.queryByText('secret')).toBeNull()
    expect(screen.getByTestId('palette-recent-ledger').textContent).toContain('Umbrella Retail')
    expect(screen.getByTestId('palette-recent-item').textContent).toContain('Office Chair')
    expect(screen.getByTestId('palette-help').textContent).toContain('amt:>50000')
    // Recents sit BELOW the commands: the default selection is still the first command.
    const sections = [...document.querySelectorAll('[data-testid^="palette-section-"]')].map((s) => s.getAttribute('data-testid'))
    expect(sections).toEqual(['palette-section-commands', 'palette-section-recent-q', 'palette-section-recent-r'])
    const active = document.querySelector('.kbar-row[data-active="true"]')
    expect(active?.textContent).toContain('New voucher')
  })

  it('⌘K then ↵ on an empty query still runs New voucher, even with recents stored', async () => {
    localStorage.setItem(recentsKey('acme-co'), JSON.stringify(withQuery(EMPTY_RECENTS, 'amt:>50000')))
    const { onClose } = renderPalette()
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(onClose).toHaveBeenCalled()
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'voucher-entry' }))
  })

  it('a row appearing under a stationary cursor does not steal the default selection', async () => {
    renderPalette()
    const rows = (): Element[] => [...document.querySelectorAll('.kbar-row')]
    fireEvent.mouseEnter(rows()[3]!)
    expect(rows()[0]!.getAttribute('data-active')).toBe('true')
    fireEvent.mouseMove(screen.getByTestId('palette'))
    fireEvent.mouseEnter(rows()[3]!)
    expect(rows()[3]!.getAttribute('data-active')).toBe('true')
  })

  it('a recent search, once selected, refills the box', async () => {
    localStorage.setItem(recentsKey('acme-co'), JSON.stringify(withQuery(EMPTY_RECENTS, 'amt:>50000')))
    renderPalette()
    fireEvent.click(screen.getByTestId('palette-recent-query'))
    expect(input().value).toBe('amt:>50000')
  })

  it('a recently opened ledger opens its statement', async () => {
    localStorage.setItem(recentsKey('acme-co'), JSON.stringify(withRecord(EMPTY_RECENTS, 'ledger', { id: 7, label: 'Umbrella Retail' })))
    renderPalette()
    fireEvent.click(screen.getByTestId('palette-recent-ledger'))
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'ledger-statement', ledgerId: 7 }))
  })

  it('keyboard: ↓/↑ move over commands, ↵ runs, Esc closes', async () => {
    const { onClose } = renderPalette()
    type('trial balance')
    const rows = (): Element[] => [...document.querySelectorAll('.kbar-row')]
    expect(rows()[0]!.getAttribute('data-active')).toBe('true')
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'ArrowUp' })
    expect(rows()[0]!.getAttribute('data-active')).toBe('true')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(onClose).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'trial-balance' }))
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('ledger hits: ↵ opens the statement, ⌘E (or the row\'s Edit action) the ledger edit window', async () => {
    useDrill.setState({ ledgerEditId: null })
    const { onClose } = renderPalette()
    type('umbrella')
    const hit = await screen.findByTestId('palette-hit-ledger-7')
    // Move the selection onto the ledger hit (commands come first; 'umbrella' matches none).
    const rows = [...document.querySelectorAll('.kbar-row')]
    const at = rows.indexOf(hit)
    for (let i = 0; i < at; i++) fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(hit.getAttribute('data-active')).toBe('true')
    expect(hit.querySelector('[data-testid="palette-edit-ledger"]')).not.toBeNull()
    expect(screen.getByTestId('palette-help').textContent).toContain('⌘E')
    fireEvent.keyDown(input(), { key: 'e', metaKey: true })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(useDrill.getState().ledgerEditId).toBe(7)
    expect(useNav.getState().stack.at(-1)).toEqual({ name: 'gateway' })

    useDrill.setState({ ledgerEditId: null })
    fireEvent.click(hit.querySelector('[data-testid="palette-edit-ledger"]')!)
    expect(useDrill.getState().ledgerEditId).toBe(7)
    expect(useNav.getState().stack.at(-1)).toEqual({ name: 'gateway' }) // the click didn't also open the statement
  })

  it('does not call the books search for one-character or filter-less queries', async () => {
    renderPalette()
    type('a')
    await new Promise((r) => setTimeout(r, 250))
    type('in:ledgers')
    await new Promise((r) => setTimeout(r, 250))
    expect(invoke.mock.calls.filter(([ch]) => ch === 'search:query')).toHaveLength(0)
  })
})
