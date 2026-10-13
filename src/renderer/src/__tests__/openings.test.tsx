// WP 8.7: "What you had on day one" — each step refuses to go on with the problem under its field
// (negative amounts, a bill number twice for one customer, a new customer without a name), the
// confirm step says the difference in one sentence (more / less / even) from the server's
// rehearsal and saves with that very figure; Home's step shows progress, "I started fresh"
// skips it, and once saved Home says what customers owe. No banned word on any of it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Openings } from '../simple/Openings'
import { OpeningsHomeCard } from '../simple/OpeningsHomeCard'
import { bannedWordsIn } from '@shared/simple/bannedWords'
import type { OpeningsResult, OpeningsState, SimpleOpeningsInput } from '@shared/simple/openings'
import type { DashboardSeries } from '@shared/dashboard'

const invoke = vi.fn()

function withClient(ui: React.JSX.Element): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>
}

const STATE: OpeningsState = {
  booksBegin: '2026-04-01',
  startedFresh: false,
  stockOn: true,
  appliedAt: null,
  cash: { ledgerId: 1, name: 'Cash', amount: 0 },
  banks: [],
  overdrafts: [],
  customers: [],
  suppliers: [],
  items: [],
  others: [],
  pick: { customers: [{ id: 10, name: 'Sharma Stores' }], suppliers: [], items: [], units: [{ id: 2, name: 'Pieces', symbol: 'Pcs' }] },
  capitals: [{ ledgerId: 5, name: "Owner's money", amount: 0 }],
  progress: { done: 0, total: 4 }
}

const result = (difference: number): OpeningsResult => ({
  booksBegin: '2026-04-01',
  have: Math.max(difference, 0) + 1_000_00,
  owe: Math.max(-difference, 0) + 1_000_00,
  difference,
  capital: { ledgerId: 5, name: "Owner's money", before: 0, after: -difference },
  warnings: [],
  changed: 3,
  balanced: true
})

let previewDifference = 12_345_00
let applied: SimpleOpeningsInput | null = null
let skipped = false

beforeEach(() => {
  previewDifference = 12_345_00
  applied = null
  skipped = false
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    if (channel === 'simple:openings:get') return { ok: true, data: STATE }
    if (channel === 'simple:openings:preview') return { ok: true, data: result(previewDifference) }
    if (channel === 'simple:openings') {
      applied = payload as SimpleOpeningsInput
      return { ok: true, data: result(previewDifference) }
    }
    if (channel === 'simple:openings:skip') {
      skipped = true
      return { ok: true, data: { startedFresh: true } }
    }
    return { ok: false, error: `unmocked ${channel}` }
  })
  window.total = { platform: 'test', invoke } as unknown as typeof window.total
})
afterEach(() => cleanup())

const click = (id: string): void => {
  fireEvent.click(screen.getByTestId(id))
}
const type = (id: string, value: string): void => {
  fireEvent.change(screen.getByTestId(id), { target: { value } })
}
const step = (): string | null => screen.getByTestId('openings').getAttribute('data-step')

describe('opening setup screen', () => {
  it('checks each step under its field, then confirms the difference the server worked out', async () => {
    render(withClient(<Openings />))
    await waitFor(() => expect(step()).toBe('money'))
    expect(screen.getByTestId('openings-step-label').textContent).toBe('Step 1 of 5')
    expect(screen.getByText(/the first day you record/).textContent).toContain('1 Apr 2026')

    // A negative amount is refused under the field.
    type('openings-cash', '-500')
    click('openings-next')
    expect(step()).toBe('money')
    expect(screen.getByText('Amounts can’t be below zero. Type the amount without a minus sign.')).toBeTruthy()
    type('openings-cash', '5000')
    expect(screen.queryByText('Amounts can’t be below zero. Type the amount without a minus sign.')).toBeNull()
    click('openings-add-bank')
    type('openings-bank-0-amount', '20000')
    click('openings-next')
    expect(screen.getByText('Type a name.')).toBeTruthy()
    type('openings-bank-0-name', 'HDFC current')
    expect(screen.getByTestId('openings-money-total').textContent).toBe('Money in all: ₹25,000.00')
    click('openings-next')
    expect(step()).toBe('customers')

    // Two bills with one number for the same customer.
    click('openings-add-customer')
    type('openings-customer-0-name', 'Sharma Stores')
    type('openings-customer-0-bill-0-ref', 'B-12')
    type('openings-customer-0-bill-0-amount', '3000')
    click('openings-customer-0-add-bill')
    type('openings-customer-0-bill-1-ref', 'b-12')
    type('openings-customer-0-bill-1-amount', '1500')
    click('openings-next')
    expect(step()).toBe('customers')
    expect(screen.getByText('Another bill here has the same number. Give each bill its own number, or leave it blank.')).toBeTruthy()
    type('openings-customer-0-bill-1-ref', '')
    expect(screen.getByTestId('openings-customers-total').textContent).toBe('Customers owe you ₹4,500.00 in all')
    click('openings-next')
    expect(step()).toBe('suppliers')
    click('openings-next')
    expect(step()).toBe('stock')
    click('openings-add-item')
    type('openings-item-0-name', 'Rice 25 kg bag')
    type('openings-item-0-qty', '10')
    type('openings-item-0-rate', '1200')
    expect(screen.getByTestId('openings-item-0-value').textContent).toBe('₹12,000.00')
    click('openings-next')
    expect(step()).toBe('confirm')

    await waitFor(() => expect(screen.getByTestId('openings-difference-sentence').getAttribute('data-kind')).toBe('more'))
    expect(screen.getByTestId('openings-difference-sentence').textContent).toBe(
      'What you have is ₹12,345.00 more than what you owe. We’ll record that as your own money in the business.'
    )
    expect(screen.getByTestId('openings-sum-money').textContent).toBe('₹25,000.00')
    expect(screen.getByTestId('openings-sum-customers').textContent).toBe('₹4,500.00')
    expect(screen.getByTestId('openings-sum-stock').textContent).toBe('₹12,000.00')
    expect(bannedWordsIn(screen.getByTestId('openings').textContent ?? '')).toEqual([])

    // "More…" opens loans and things used for years.
    click('openings-more')
    expect(screen.getByTestId('openings-other')).toBeTruthy()

    click('openings-confirm')
    await waitFor(() => expect(screen.getByTestId('openings-done')).toBeTruthy())
    expect(applied).toMatchObject({
      cash: { amount: 5_000_00, base: 0 },
      banks: [{ ledgerId: null, name: 'HDFC current', amount: 20_000_00 }],
      customers: [{ name: 'Sharma Stores', bills: [{ ref: 'B-12', date: null, amount: 3_000_00 }, { ref: '', date: null, amount: 1_500_00 }] }],
      items: [{ name: 'Rice 25 kg bag', unitId: 2, qtyMilli: 10_000, ratePaise: 1_200_00 }],
      confirmCapital: -12_345_00
    })
    expect(bannedWordsIn(screen.getByTestId('openings-done').textContent ?? '')).toEqual([])
  })

  it('says it plainly when you owe more than you have, or when the two are equal', async () => {
    previewDifference = -2_000_00
    render(withClient(<Openings />))
    await waitFor(() => expect(step()).toBe('money'))
    type('openings-cash', '100')
    for (let i = 0; i < 4; i++) click('openings-next')
    await waitFor(() => expect(screen.getByTestId('openings-difference-sentence').getAttribute('data-kind')).toBe('less'))
    expect(screen.getByTestId('openings-difference-sentence').textContent).toBe(
      'You owe ₹2,000.00 more than what you have. We’ll record that as a shortfall in your own money in the business.'
    )
    cleanup()
    previewDifference = 0
    render(withClient(<Openings />))
    await waitFor(() => expect(step()).toBe('money'))
    type('openings-cash', '100')
    for (let i = 0; i < 4; i++) click('openings-next')
    await waitFor(() => expect(screen.getByTestId('openings-difference-sentence').getAttribute('data-kind')).toBe('even'))
  })

  it('an overdrawn bank shows under what you owe (not blocking money); blank bill numbers show the names they will get; two capital accounts → pick one', async () => {
    const state: OpeningsState = {
      ...STATE,
      overdrafts: [{ ledgerId: 7, name: 'SBI OD', amount: 3_000_00 }],
      capitals: [{ ledgerId: 5, name: "Owner's money", amount: 0 }, { ledgerId: 6, name: 'Partner B', amount: 0 }]
    }
    invoke.mockImplementation(async (channel: string, payload?: unknown) => {
      if (channel === 'simple:openings:get') return { ok: true, data: state }
      if (channel === 'simple:openings:preview') return { ok: true, data: result(-3_000_00) }
      if (channel === 'simple:openings') {
        applied = payload as SimpleOpeningsInput
        return { ok: true, data: result(-3_000_00) }
      }
      return { ok: false, error: `unmocked ${channel}` }
    })
    render(withClient(<Openings />))
    await waitFor(() => expect(step()).toBe('money'))
    expect(screen.getByTestId('openings-overdraft-note')).toBeTruthy()
    click('openings-next')
    click('openings-add-customer')
    type('openings-customer-0-name', 'Sharma')
    type('openings-customer-0-bill-0-amount', '100')
    type('openings-customer-0-bill-0-date', '1/3/26')
    fireEvent.blur(screen.getByTestId('openings-customer-0-bill-0-date'))
    click('openings-customer-0-add-bill')
    type('openings-customer-0-bill-1-amount', '50')
    // Bill 1 has no date (= 1 Apr 2026), bill 0 is dated 1 Mar: the dated one is "Opening".
    expect((screen.getByTestId('openings-customer-0-bill-0-ref') as HTMLInputElement).placeholder).toBe('Opening')
    expect((screen.getByTestId('openings-customer-0-bill-1-ref') as HTMLInputElement).placeholder).toBe('Opening 2')
    expect((screen.getByTestId('openings-customer-0-bill-0-date') as HTMLInputElement).value).toBe('1 Mar 2026')
    click('openings-next')
    expect(step()).toBe('suppliers')
    expect(screen.getByTestId('openings-overdraft-0').textContent).toContain('SBI OD')
    expect(screen.getByTestId('openings-suppliers-total').textContent).toBe('You owe ₹3,000.00 in all')
    click('openings-next')
    click('openings-next')
    await waitFor(() => expect(screen.getByTestId('openings-capital')).toBeTruthy())
    expect(screen.getByTestId('openings-sum-overdrafts').textContent).toBe('₹3,000.00')
    fireEvent.change(screen.getByTestId('openings-capital'), { target: { value: '6' } })
    await waitFor(() => expect((screen.getByTestId('openings-confirm') as HTMLButtonElement).disabled).toBe(false))
    click('openings-confirm')
    await waitFor(() => expect(applied).not.toBeNull())
    expect(applied).toMatchObject({ capitalLedgerId: 6, overdrafts: [{ ledgerId: 7, amount: 3_000_00, base: -3_000_00 }] })
  })

  it('nothing entered: the confirm button stays off and says so', async () => {
    render(withClient(<Openings />))
    await waitFor(() => expect(step()).toBe('money'))
    for (let i = 0; i < 4; i++) click('openings-next')
    expect(screen.getByTestId('openings-nothing')).toBeTruthy()
    expect((screen.getByTestId('openings-confirm') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('Home: enter what you had on day one', () => {
  const series = { receivables: { ok: true, data: { total: 4_500_00 } }, payables: { ok: true, data: { total: 8_000_00 } } } as unknown as DashboardSeries

  it('shows progress for a continuing business; "I started fresh" skips it', async () => {
    render(withClient(<OpeningsHomeCard series={series} />))
    await waitFor(() => expect(screen.getByTestId('simple-home-openings').getAttribute('data-done')).toBe('false'))
    expect(screen.getByTestId('simple-home-openings-progress').textContent).toBe('0 of 4 parts entered')
    expect(screen.getByTestId('simple-home-openings').textContent).toContain('Enter what you had on day one')
    expect(bannedWordsIn(screen.getByTestId('simple-home-openings').textContent ?? '')).toEqual([])
    click('simple-home-openings-fresh')
    await waitFor(() => expect(skipped).toBe(true))
  })

  it('hidden for a fresh start; once saved it says what customers owe', async () => {
    invoke.mockImplementation(async (channel: string) =>
      channel === 'simple:openings:get' ? { ok: true, data: { ...STATE, startedFresh: true } } : { ok: false, error: 'unmocked' }
    )
    const { container } = render(withClient(<OpeningsHomeCard series={series} />))
    await waitFor(() => expect(invoke).toHaveBeenCalled())
    expect(container.querySelector('[data-testid="simple-home-openings"]')).toBeNull()
    cleanup()
    invoke.mockImplementation(async (channel: string) =>
      channel === 'simple:openings:get' ? { ok: true, data: { ...STATE, appliedAt: '2026-10-13T10:00:00Z' } } : { ok: false, error: 'unmocked' }
    )
    render(withClient(<OpeningsHomeCard series={series} />))
    await waitFor(() => expect(screen.getByTestId('simple-home-openings').getAttribute('data-done')).toBe('true'))
    expect(screen.getByTestId('simple-home-customers-owe').textContent).toBe('Customers owe you ₹4,500.00')
    expect(screen.getByTestId('simple-home-you-owe').textContent).toBe('You owe suppliers ₹8,000.00')
  })
})
