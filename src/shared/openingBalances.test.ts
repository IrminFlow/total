import { describe, it, expect } from 'vitest'
import { OPENING_CATEGORIES, openingAdvice, openingTotals, signedOpening, type OpeningRow } from './openingBalances'
import { DEFAULT_GROUPS } from './seed'
import { formatPaise } from './money'

const category = (id: string) => OPENING_CATEGORIES.find((c) => c.id === id)!

describe('the opening categories', () => {
  it('every category names a group the app actually seeds', () => {
    // A category pointing at a group that does not exist fails at the moment somebody has just
    // typed their whole opening set in, which is the worst moment available.
    const seeded = new Set(DEFAULT_GROUPS.map((g) => g.name))
    for (const c of OPENING_CATEGORIES) {
      expect(seeded.has(c.group), `${c.id} → ${c.group}`).toBe(true)
    }
  })

  it('asks for money in before money out', () => {
    expect(OPENING_CATEGORIES.map((c) => c.id).slice(0, 3)).toEqual(['cash', 'debtors', 'creditors'])
  })
})

describe('signedOpening', () => {
  it('turns a positive amount into the right side of the books', () => {
    expect(signedOpening(category('cash'), 500000)).toBe(500000)
    expect(signedOpening(category('creditors'), 500000)).toBe(-500000)
    expect(signedOpening(category('capital'), 500000)).toBe(-500000)
  })
})

describe('openingTotals', () => {
  const rows: OpeningRow[] = [
    { name: 'HDFC Current', categoryId: 'cash', amount: 1000000 },
    { name: 'Kumar Traders', categoryId: 'debtors', amount: 250000 },
    { name: 'Metal Supplies', categoryId: 'creditors', amount: 400000 }
  ]

  it('adds each side up', () => {
    const totals = openingTotals(rows)
    expect(totals.debit).toBe(1250000)
    expect(totals.credit).toBe(400000)
    expect(totals.difference).toBe(850000)
    expect(totals.balanced).toBe(false)
  })

  it('balances once the capital is entered', () => {
    const totals = openingTotals([...rows, { name: 'Owner Capital', categoryId: 'capital', amount: 850000 }])
    expect(totals.balanced).toBe(true)
    expect(totals.difference).toBe(0)
  })

  it('ignores blank and negative rows rather than inventing entries', () => {
    const totals = openingTotals([
      { name: '', categoryId: 'cash', amount: 0 },
      { name: 'X', categoryId: 'cash', amount: -100 }
    ])
    expect(totals).toEqual({ debit: 0, credit: 0, difference: 0, balanced: true })
  })
})

describe('openingAdvice', () => {
  it('names the usual reason for each direction rather than saying "invalid"', () => {
    expect(openingAdvice(openingTotals([{ name: 'A', categoryId: 'cash', amount: 100 }]), formatPaise)).toMatch(/capital/)
    expect(openingAdvice(openingTotals([{ name: 'A', categoryId: 'creditors', amount: 100 }]), formatPaise)).toMatch(/stock/)
  })

  it('says so when it ties', () => {
    const totals = openingTotals([
      { name: 'A', categoryId: 'cash', amount: 100 },
      { name: 'B', categoryId: 'capital', amount: 100 }
    ])
    expect(openingAdvice(totals, formatPaise)).toMatch(/balances/)
  })

  it('says nothing alarming about an empty screen', () => {
    expect(openingAdvice(openingTotals([]), formatPaise)).toBe('Nothing entered yet.')
  })
})
