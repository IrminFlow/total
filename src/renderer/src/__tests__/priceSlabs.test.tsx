// Follow-up to #195: the price-list slab table shows its Currency column only when a slab is in
// another currency (one saved before the forex cut); new slabs are always in ₹.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SlabsModal } from '../screens/masters/PriceListsTab'
import { useSession } from '../state/stores'

const invoke = vi.fn()
const row = (id: number, currency?: string) => ({
  id, priceLevelId: 1, stockItemId: 9, rate: 100_00, effectiveFrom: '2026-04-01', effectiveTo: null, minQtyMilli: 0, discountBp: 0,
  ...(currency ? { currency } : {}), itemName: 'Widget', unitSymbol: 'Nos'
})
let rates: unknown[] = []

beforeEach(() => {
  useSession.setState({ slug: 'p', workingDate: '2026-04-10' } as never)
  invoke.mockImplementation(async (channel: string) => (channel === 'priceLevels:rates' ? { ok: true, data: rates } : { ok: false, error: channel }))
  window.total = { platform: 'test', invoke } as unknown as typeof window.total
})
afterEach(() => cleanup())

function renderModal(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <SlabsModal level={{ id: 1, name: 'Retail' }} itemId={9} itemName="Widget" onClose={() => {}} onChanged={async () => {}} />
    </QueryClientProvider>
  )
}
const headers = (): string[] => [...screen.getByTestId('table-price-slabs').querySelectorAll('th')].map((th) => th.textContent ?? '')

describe('price slabs: the Currency column', () => {
  it('is hidden when every slab is in ₹ (absent currency = INR)', async () => {
    rates = [row(1), row(2, 'INR')]
    renderModal()
    await waitFor(() => expect(screen.getByTestId('table-price-slabs').querySelectorAll('tbody tr').length).toBe(2))
    expect(headers()).not.toContain('Currency')
  })

  it('shows when a slab saved before the forex cut is in another currency', async () => {
    rates = [row(1), row(2, 'USD')]
    renderModal()
    await waitFor(() => expect(headers()).toContain('Currency'))
    expect(screen.getByTestId('table-price-slabs').textContent).toContain('USD')
  })

  it('the empty state spans exactly the header columns (6 without Currency — CodeRabbit on #196)', async () => {
    rates = []
    renderModal()
    const cell = await screen.findByTestId('price-slabs-empty')
    expect(Number(cell.getAttribute('colspan'))).toBe(headers().length)
    expect(headers()).toHaveLength(6)
  })
})
