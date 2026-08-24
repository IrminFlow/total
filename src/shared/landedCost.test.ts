import { describe, it, expect } from 'vitest'
import { allocateLandedCosts, type CostedLine, type LandedCost } from './landedCost'

const lines = (...specs: [id: number, qtyMilli: number, amount: number][]): CostedLine[] =>
  specs.map(([id, qtyMilli, amount]) => ({ id, qtyMilli, amount }))

const freight = (amount: number): LandedCost => ({ label: 'Freight', amount, basis: 'qty' })
const insurance = (amount: number): LandedCost => ({ label: 'Insurance', amount, basis: 'value' })

describe('allocateLandedCosts', () => {
  it('splits a value-based cost in proportion to line value', () => {
    const r = allocateLandedCosts(lines([1, 1000, 30_000], [2, 1000, 10_000]), [insurance(4000)])
    expect(r.lines.map((l) => l.extra)).toEqual([3000, 1000])
    expect(r.unallocated).toBe(0)
  })

  it('splits a quantity-based cost in proportion to quantity, ignoring value', () => {
    // A cheap heavy line takes the bigger share of freight — the whole reason the basis exists.
    const r = allocateLandedCosts(lines([1, 9000, 1000], [2, 1000, 99_000]), [freight(10_000)])
    expect(r.lines.map((l) => l.extra)).toEqual([9000, 1000])
  })

  it('conserves every paisa when the split does not divide, in a defined place', () => {
    const r = allocateLandedCosts(lines([1, 1000, 1], [2, 1000, 1], [3, 1000, 1]), [freight(100)])
    expect(r.lines.map((l) => l.extra).reduce((s, x) => s + x, 0)).toBe(100)
    // Largest remainder, ties by line order: the first line takes the odd paisa.
    expect(r.lines.map((l) => l.extra)).toEqual([34, 33, 33])
  })

  it('keeps each cost on its own basis instead of pooling them into an average of neither', () => {
    const r = allocateLandedCosts(lines([1, 9000, 1000], [2, 1000, 99_000]), [freight(10_000), insurance(10_000)])
    expect(r.lines.map((l) => l.extra)).toEqual([9000 + 100, 1000 + 9900])
    expect(r.total).toBe(20_000)
  })

  it('splits equally across lines of zero value, because there is nothing to weight by', () => {
    const r = allocateLandedCosts(lines([1, 1000, 0], [2, 4000, 0]), [insurance(1000)])
    expect(r.lines.map((l) => l.extra)).toEqual([500, 500])
  })

  it('splits equally across lines of zero quantity too', () => {
    const r = allocateLandedCosts(lines([1, 0, 5000], [2, 0, 5000]), [freight(999)])
    expect(r.lines.map((l) => l.extra)).toEqual([500, 499])
  })

  it('reports money it cannot place rather than dropping it', () => {
    const r = allocateLandedCosts([], [freight(5000)])
    expect(r).toEqual({ lines: [], total: 5000, unallocated: 5000 })
  })

  it('restates the effective rate per whole unit', () => {
    const r = allocateLandedCosts(lines([1, 2000, 20_000]), [freight(1000)])
    expect(r.lines[0]).toMatchObject({ effectiveAmount: 21_000, effectiveRatePaise: 10_500 })
  })

  it('leaves a zero-quantity line with no rate rather than a division by zero', () => {
    const r = allocateLandedCosts(lines([1, 0, 1000]), [insurance(500)])
    expect(r.lines[0]!.effectiveRatePaise).toBe(0)
    expect(r.lines[0]!.effectiveAmount).toBe(1500)
  })

  it('is a no-op when there are no costs', () => {
    const r = allocateLandedCosts(lines([1, 1000, 5000]), [])
    expect(r.lines[0]).toMatchObject({ extra: 0, effectiveAmount: 5000, effectiveRatePaise: 5000 })
    expect(r.total).toBe(0)
  })
})
