// to-do §4 (PR #111 leftover): a NEW opening product is offered the GST slabs in force on the
// WORKING date — what its next bill charges — not the books-begin date's (books begun before
// 22 Sep 2025 offered 12 % / 28 %). Those older slabs, or any other rate, only behind
// "Custom rate (check with your CA)", as in the product dialog.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { StockStep } from '../simple/OpeningsSteps'
import { useSession } from '../state/stores'
import type { ItemDraft, OpeningsDraft, OpeningsState } from '@shared/simple/openings'

const STATE = {
  booksBegin: '2025-04-01',
  chargesGst: true,
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
  pick: { customers: [], suppliers: [], items: [], units: [{ id: 2, name: 'Pieces', symbol: 'Pcs' }] },
  capitals: [],
  progress: { done: 0, total: 4 }
} as unknown as OpeningsState

const item = (): ItemDraft => ({ key: 'k1', itemId: null, name: 'Atta 10 kg', unitId: 2, qty: '20', rate: 380_00, base: null, gstRate: null, sell: null, sellBase: null })

let latest: OpeningsDraft
function Harness(): React.JSX.Element {
  const [draft, setDraft] = useState<OpeningsDraft>({ cash: { amount: null, base: null }, banks: [], overdrafts: [], customers: [], suppliers: [], items: [item()], others: [] })
  latest = draft
  return <StockStep draft={draft} update={(fn) => setDraft((d) => fn(d))} state={STATE} />
}

const options = (): string[] => within(screen.getByTestId('openings-item-0-gst')).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)

beforeEach(() => act(() => useSession.setState({ workingDate: '2026-10-16' })))
afterEach(() => cleanup())

describe('opening products: GST slabs of the working date', () => {
  it('books begun 1 Apr 2025, working today: 0 / 5 / 18 (+ special), no 12 or 28; custom last', () => {
    render(<Harness />)
    const values = options()
    expect(values).toContain('5')
    expect(values).toContain('18')
    expect(values).not.toContain('12')
    expect(values).not.toContain('28')
    expect(values.at(-1)).toBe('custom')
    expect(screen.queryByTestId('openings-item-0-gst-custom')).toBeNull()
    fireEvent.change(screen.getByTestId('openings-item-0-gst'), { target: { value: '18' } })
    expect(latest.items[0]!.gstRate).toBe(18)
  })

  it('the books-begin slabs (12 %) only behind Custom rate, with the CA warning; a typed rate too', () => {
    render(<Harness />)
    fireEvent.change(screen.getByTestId('openings-item-0-gst'), { target: { value: '18' } })
    fireEvent.change(screen.getByTestId('openings-item-0-gst'), { target: { value: 'custom' } })
    const box = screen.getByTestId('openings-item-0-gst-custom')
    expect(box.textContent).toContain('Use it only if your CA says so')
    expect(latest.items[0]!.gstRate).toBeNull() // nothing picked until the custom rate is given
    fireEvent.click(screen.getByTestId('openings-item-0-gst-earlier-12'))
    expect(latest.items[0]!.gstRate).toBe(12)
    expect(screen.getByTestId('openings-item-0-gst-earlier-12').getAttribute('aria-pressed')).toBe('true')
    expect((screen.getByTestId('openings-item-0-gst') as HTMLSelectElement).value).toBe('custom')
    fireEvent.change(screen.getByTestId('openings-item-0-gst-custom-input'), { target: { value: '7.5' } })
    expect(latest.items[0]!.gstRate).toBe(7.5)
    fireEvent.change(screen.getByTestId('openings-item-0-gst-custom-input'), { target: { value: 'abc' } })
    expect(latest.items[0]!.gstRate).toBeNull()
    // Back to a listed slab: the box closes.
    fireEvent.change(screen.getByTestId('openings-item-0-gst'), { target: { value: '5' } })
    expect(latest.items[0]!.gstRate).toBe(5)
    expect(screen.queryByTestId('openings-item-0-gst-custom')).toBeNull()
  })

  it('books and working date in the same period: no earlier slabs to offer, custom still there', () => {
    act(() => useSession.setState({ workingDate: '2026-10-16' }))
    render(<StockStep draft={{ cash: { amount: null, base: null }, banks: [], overdrafts: [], customers: [], suppliers: [], items: [item()], others: [] }} update={() => {}} state={{ ...STATE, booksBegin: '2026-04-01' }} />)
    expect(options().at(-1)).toBe('custom')
    fireEvent.change(screen.getByTestId('openings-item-0-gst'), { target: { value: 'custom' } })
    expect(screen.queryByTestId(/openings-item-0-gst-earlier-/)).toBeNull()
  })
})
