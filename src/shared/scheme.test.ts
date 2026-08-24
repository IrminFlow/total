import { describe, it, expect } from 'vitest'
import { applyScheme, schemeApplies, type Scheme } from './scheme'

const base: Scheme = {
  id: 1,
  stockItemId: 7,
  stockGroupId: null,
  kind: 'percent',
  minQtyMilli: 10_000,
  percentBp: 500,
  ratePaise: null,
  freeQtyMilli: null,
  fromDate: '2026-04-01',
  toDate: null,
  active: true
}
const ctx = { on: '2026-06-01', stockItemId: 7, stockGroupId: 3 }

describe('when a scheme reaches an item', () => {
  it('an item scheme reaches only its item', () => {
    expect(schemeApplies(base, ctx.on, 7, 3)).toBe(true)
    expect(schemeApplies(base, ctx.on, 8, 3)).toBe(false)
  })

  it('a group scheme reaches every item in the group', () => {
    const g = { ...base, stockItemId: null, stockGroupId: 3 }
    expect(schemeApplies(g, ctx.on, 8, 3)).toBe(true)
    expect(schemeApplies(g, ctx.on, 8, 4)).toBe(false)
  })

  it('is not live before it starts, after it ends, or once switched off', () => {
    expect(schemeApplies(base, '2026-01-01', 7, 3)).toBe(false)
    expect(schemeApplies({ ...base, toDate: '2026-05-01' }, ctx.on, 7, 3)).toBe(false)
    expect(schemeApplies({ ...base, active: false }, ctx.on, 7, 3)).toBe(false)
  })
})

describe('quantity breaks', () => {
  it('does nothing below the slab', () => {
    expect(applyScheme(9_000, 10000, [base], ctx)).toBeNull()
  })

  it('takes a percentage off at the slab', () => {
    const a = applyScheme(10_000, 10000, [base], ctx)!
    expect(a.discountPaise).toBe(5000) // 5% of 1000.00
    expect(a.billedQtyMilli).toBe(10_000)
  })

  it('drops to a slab rate when that is the scheme', () => {
    const rate: Scheme = { ...base, id: 2, kind: 'rate', percentBp: null, ratePaise: 9000 }
    const a = applyScheme(10_000, 10000, [rate], ctx)!
    expect(a.ratePaise).toBe(9000)
    expect(a.savedPaise).toBe(10000)
  })

  it('ignores a slab rate that is worse than the base rate', () => {
    const rate: Scheme = { ...base, id: 2, kind: 'rate', percentBp: null, ratePaise: 11000 }
    expect(applyScheme(10_000, 10000, [rate], ctx)).toBeNull()
  })

  it('picks the scheme that gives the customer more money off, not the higher slab', () => {
    const better: Scheme = { ...base, id: 2, minQtyMilli: 5_000, percentBp: 1000 }
    const a = applyScheme(12_000, 10000, [base, better], ctx)!
    expect(a.schemeId).toBe(2)
  })
})

describe('buy ten get one free', () => {
  const free: Scheme = { ...base, id: 3, kind: 'free', percentBp: null, freeQtyMilli: 1_000 }

  it('raises the billed quantity so the free unit still leaves stock', () => {
    const a = applyScheme(10_000, 10000, [free], ctx)!
    expect(a.billedQtyMilli).toBe(11_000)
    expect(a.freeQtyMilli).toBe(1_000)
    // Charged for ten, eleven move: the discount is exactly one unit's value.
    expect(a.discountPaise).toBe(10000)
  })

  it('gives whole sets only — fifteen earns one, not one and a half', () => {
    const a = applyScheme(15_000, 10000, [free], ctx)!
    expect(a.freeQtyMilli).toBe(1_000)
  })

  it('gives two on twenty', () => {
    const a = applyScheme(20_000, 10000, [free], ctx)!
    expect(a.freeQtyMilli).toBe(2_000)
    expect(a.billedQtyMilli).toBe(22_000)
  })

  it('does nothing at all below one whole set', () => {
    expect(applyScheme(9_000, 10000, [free], ctx)).toBeNull()
  })
})
