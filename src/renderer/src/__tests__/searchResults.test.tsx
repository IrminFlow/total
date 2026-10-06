// Search results screen (on the shared DataTable) — per-kind tab counts, relevance order kept
// as the default (no default sort), "See all" → kind tab that loads pages of 200 in the
// background up to 1,000 rows then offers "Load more", removable chips, row open → navigation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CompanyInfo } from '@shared/domain'
import type { SearchResponse, VoucherResult } from '@shared/search'
import { SearchResultsScreen } from '../screens/SearchResults'
import { useNav, useSession } from '../state/stores'

const INFO: CompanyInfo = {
  name: 'A', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '',
  booksFrom: 2026, email: null, phone: null, pan: null, tan: null
}

const invoke = vi.fn()
let TOTAL = 75

/** Relevance order deliberately NOT date/amount/number order, so any default sort would show. */
function v(id: number): VoucherResult {
  return {
    kind: 'voucher', id, typeName: 'Receipt', voucherKind: 'receipt', number: `RC-${(id * 37) % 101}`,
    date: `2026-0${(id % 9) + 1}-1${id % 10}`, party: 'Umbrella Retail', partyLedgerId: 7, amount: 100000 + ((id * 7919) % 5000),
    narration: null, isOptional: false, postDated: false, matchField: 'amount', matchText: '₹1,000'
  }
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  localStorage.clear()
  TOTAL = 75
  useSession.getState().setCompany('acme-co', INFO)
  useNav.setState({ stack: [{ name: 'gateway' }, { name: 'search', q: 'amt:>1000' }] })
  invoke.mockImplementation(async (channel: string, payload?: { kind?: string; offset?: number; limitPerKind?: number; q: string }) => {
    if (channel !== 'search:query') return { ok: false, error: `unmocked ${channel}` }
    const off = payload?.offset ?? 0
    const lim = payload?.limitPerKind ?? 20
    const rows = Array.from({ length: Math.max(0, Math.min(lim, TOTAL - off)) }, (_, i) => v(off + i + 1))
    const res: SearchResponse = {
      chips: [{ key: 'amount', label: 'Amount > ₹1,000', raw: 'amt:>1000' }], unknown: [], terms: [], kinds: ['voucher'],
      ledgers: payload?.kind ? null : { rows: [], total: 0, offset: 0 },
      items: payload?.kind ? null : { rows: [], total: 0, offset: 0 },
      vouchers: { rows, total: TOTAL, offset: off }
    }
    return { ok: true, data: res }
  })
  window.total = { platform: 'test', invoke }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderScreen(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <SearchResultsScreen q="amt:>1000" />
    </QueryClientProvider>
  )
}

const rowIds = (): string[] =>
  [...screen.getByTestId('rows-search-vouchers').querySelectorAll('tr[data-row-id]')].map((tr) => tr.getAttribute('data-row-id')!)

const pagedOffsets = (): number[] =>
  invoke.mock.calls.filter(([, p]) => (p as { kind?: string }).kind === 'voucher').map(([, p]) => (p as { offset: number }).offset)

describe('SearchResultsScreen', () => {
  it('shows counts per kind and chips; rows stay in relevance (service) order', async () => {
    renderScreen()
    await screen.findByTestId('rows-search-vouchers')
    expect(screen.getByTestId('tab-search-voucher').textContent).toBe('Vouchers · 75')
    expect(screen.getByTestId('tab-search-all').textContent).toBe('All · 75')
    expect(screen.getByTestId('search-chips').textContent).toContain('Amount > ₹1,000')
    expect(rowIds()).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 1)))
  })

  it('See all → kind tab loads every page in the background (≤ 1,000) with exports, in rank order', async () => {
    TOTAL = 450
    renderScreen()
    await screen.findByTestId('rows-search-vouchers')
    fireEvent.click(screen.getByTestId('btn-search-show-all-voucher'))
    await waitFor(() => expect(screen.getByTestId('search-loaded').textContent).toBe('Loaded 450 of 450'), { timeout: 8000 })
    expect(pagedOffsets()).toEqual([0, 200, 400])
    expect(screen.queryByTestId('btn-search-load-more')).toBeNull()
    expect(screen.getByTestId('search-vouchers-table')).toBeTruthy()
    // Toolbar export is enabled on the kind tab.
    expect(screen.getByTestId('search-vouchers-table').textContent).toMatch(/CSV/)
    // First rendered rows are ranks 1, 2, 3… (no default sort reorders them).
    expect(rowIds().slice(0, 3)).toEqual(['1', '2', '3'])
  })

  it('stops at 1,000 rows and offers Load more for the rest', async () => {
    TOTAL = 1200
    renderScreen()
    await screen.findByTestId('rows-search-vouchers')
    fireEvent.click(screen.getByTestId('btn-search-show-all-voucher'))
    await waitFor(() => expect(screen.getByTestId('search-loaded').textContent).toContain('Loaded 1000 of 1200'), { timeout: 8000 })
    expect(pagedOffsets()).toEqual([0, 200, 400, 600, 800])
    fireEvent.click(screen.getByTestId('btn-search-load-more'))
    await waitFor(() => expect(screen.getByTestId('search-loaded').textContent).toBe('Loaded 1200 of 1200'), { timeout: 8000 })
  })

  it('removing a chip edits the query (here back to an empty query → syntax help)', async () => {
    renderScreen()
    await screen.findByTestId('rows-search-vouchers')
    fireEvent.click(screen.getByLabelText('Remove Amount > ₹1,000'))
    expect((screen.getByTestId('input-search') as HTMLInputElement).value).toBe('')
    expect(await screen.findByTestId('search-help')).toBeTruthy()
  })

  it('row click opens the voucher and records it as recent', async () => {
    renderScreen()
    const tbody = await screen.findByTestId('rows-search-vouchers')
    fireEvent.click(tbody.querySelector('tr[data-row-id="3"] td')!)
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'voucher-entry', voucherId: 3 }))
    const stored = JSON.parse(localStorage.getItem('total-search-recents-acme-co')!) as { vouchers: { id: number }[]; queries: string[] }
    expect(stored.vouchers[0]!.id).toBe(3)
    expect(stored.queries).toEqual(['amt:>1000'])
  })
})
