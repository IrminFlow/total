// Search results screen — per-kind tab counts, "See all" → kind tab with paged "Load more",
// removable filter chips, and row open → navigation.
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

function v(id: number): VoucherResult {
  return {
    kind: 'voucher', id, typeName: 'Receipt', voucherKind: 'receipt', number: `RC-${id}`, date: '2026-04-12',
    party: 'Umbrella Retail', amount: 100000 + id, narration: null, isOptional: false, postDated: false,
    matchField: 'amount', matchText: '₹1,000'
  }
}

const TOTAL = 75

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  localStorage.clear()
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

describe('SearchResultsScreen', () => {
  it('shows counts per kind, chips, and pages a kind with Load more', async () => {
    renderScreen()
    await screen.findByTestId('rows-search-vouchers')
    expect(screen.getByTestId('tab-search-voucher').textContent).toBe('Vouchers · 75')
    expect(screen.getByTestId('tab-search-all').textContent).toBe('All · 75')
    expect(screen.getByTestId('search-chips').textContent).toContain('Amount > ₹1,000')
    expect(screen.getByTestId('rows-search-vouchers').querySelectorAll('tr')).toHaveLength(20)

    fireEvent.click(screen.getByTestId('btn-search-show-all-voucher'))
    await waitFor(() => expect(screen.getByTestId('rows-search-vouchers').querySelectorAll('tr')).toHaveLength(50))
    expect(screen.getByText('Showing 50 of 75')).toBeTruthy()
    fireEvent.click(screen.getByTestId('btn-search-load-more'))
    await waitFor(() => expect(screen.getByTestId('rows-search-vouchers').querySelectorAll('tr')).toHaveLength(75))
    expect(screen.queryByTestId('btn-search-load-more')).toBeNull()
    const pagedCalls = invoke.mock.calls.filter(([, p]) => (p as { kind?: string }).kind === 'voucher').map(([, p]) => (p as { offset: number }).offset)
    expect(pagedCalls).toEqual([0, 50])
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
    fireEvent.click(tbody.querySelector('tr[data-row-id="3"]')!)
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'voucher-entry', voucherId: 3 }))
    const stored = JSON.parse(localStorage.getItem('total-search-recents-acme-co')!) as { vouchers: { id: number }[]; queries: string[] }
    expect(stored.vouchers[0]!.id).toBe(3)
    expect(stored.queries).toEqual(['amt:>1000'])
  })
})
