import { describe, it, expect } from 'vitest'
import {
  valueStock,
  allocateAdditionalCost,
  expiryBucketOf,
  wouldCreateBomCycle,
  type StockMovement
} from './valuation'

const mv = (
  direction: 'in' | 'out',
  qtyMilli: number,
  amount = 0,
  isAbsolute = false
): StockMovement => ({ direction, qtyMilli, amount, isAbsolute })

describe('valueStock — perpetual moving average', () => {
  it('values a simple in/out sequence at moving average cost', () => {
    // Opening 10 @ ₹10 (100000p total), buy 10 @ ₹20 (200000p), sell 10.
    // Avg after purchase = 300000/20000milli = 15p/milli-unit → sell 10 removes 150000p.
    const r = valueStock('weighted_avg', 10000, 100000, [mv('in', 10000, 200000), mv('out', 10000)])
    expect(r.closingQtyMilli).toBe(10000)
    expect(r.closingValue).toBe(150000)
    expect(r.inwardQtyMilli).toBe(10000)
    expect(r.outwardQtyMilli).toBe(10000)
  })

  it('is perpetual, not periodic: a sale before a purchase uses only the cost known so far', () => {
    // Opening 10 @ ₹10; sell 5 (at avg ₹10 → removes 50000), then buy 10 @ ₹40 (400000).
    // Closing = 5@avg10 + 10@40 = 50000 + 400000 = 450000, qty 15.
    const r = valueStock('weighted_avg', 10000, 100000, [mv('out', 5000), mv('in', 10000, 400000)])
    expect(r.closingQtyMilli).toBe(15000)
    expect(r.closingValue).toBe(450000)
  })

  it('handles overdraw (negative stock) at the last known average cost', () => {
    // Opening 10 @ ₹10; sell 15 → qty -5, value 100000 - 150000 = -50000.
    const r = valueStock('weighted_avg', 10000, 100000, [mv('out', 15000)])
    expect(r.closingQtyMilli).toBe(-5000)
    expect(r.closingValue).toBe(-50000)
  })

  it('an outward with zero stock on hand removes zero value', () => {
    const r = valueStock('weighted_avg', 0, 0, [mv('out', 5000)])
    expect(r.closingQtyMilli).toBe(-5000)
    expect(r.closingValue).toBe(0)
  })
})

describe('valueStock — FIFO', () => {
  it('consumes the oldest layer first', () => {
    // Opening 10 @ ₹10 (100000); buy 10 @ ₹20 (200000); sell 15.
    // FIFO removes 10@10 + 5@20 = 100000 + 100000 → closing 5@20 = 100000.
    const r = valueStock('fifo', 10000, 100000, [mv('in', 10000, 200000), mv('out', 15000)])
    expect(r.closingQtyMilli).toBe(5000)
    expect(r.closingValue).toBe(100000)
  })

  it('differs from weighted average on the same movements', () => {
    const moves = [mv('in', 10000, 200000), mv('out', 15000)]
    const fifo = valueStock('fifo', 10000, 100000, moves)
    const avg = valueStock('weighted_avg', 10000, 100000, moves)
    expect(fifo.closingValue).toBe(100000)
    expect(avg.closingValue).toBe(75000) // 5 left at avg ₹15
  })

  it('consumes partial layers proportionally with integer rounding', () => {
    // One layer 3 @ 100p total; take 1 → removes round(100/3)=33, leaves 67.
    const r = valueStock('fifo', 3000, 100, [mv('out', 1000)])
    expect(r.closingQtyMilli).toBe(2000)
    expect(r.closingValue).toBe(67)
  })

  it('backfills an overdraw from the next inward layer', () => {
    // Sell 5 with nothing on hand, then buy 10 @ ₹20 (200000).
    // The deficit of 5 consumes half the new layer → closing 5 @ ₹20 = 100000.
    const r = valueStock('fifo', 0, 0, [mv('out', 5000), mv('in', 10000, 200000)])
    expect(r.closingQtyMilli).toBe(5000)
    expect(r.closingValue).toBe(100000)
  })

  it('conserves value: opening + inward = consumed + closing', () => {
    const moves = [mv('in', 7000, 91300), mv('out', 4500), mv('in', 2000, 45700), mv('out', 3000)]
    for (const method of ['fifo', 'weighted_avg'] as const) {
      const r = valueStock(method, 5000, 61200, moves)
      expect(r.closingQtyMilli).toBe(5000 + 7000 + 2000 - 4500 - 3000)
      const totalIn = 61200 + 91300 + 45700
      expect(r.consumedValue + r.closingValue).toBe(totalIn)
    }
  })
})

describe('valueStock — physical stock (absolute) lines', () => {
  it('an absolute line above current stock books an inward delta at current average cost', () => {
    // Opening 10 @ ₹10; count says 12 → +2 at avg ₹10 = 20000p.
    const r = valueStock('weighted_avg', 10000, 100000, [mv('in', 12000, 0, true)])
    expect(r.closingQtyMilli).toBe(12000)
    expect(r.closingValue).toBe(120000)
    expect(r.inwardQtyMilli).toBe(2000)
  })

  it('an absolute line below current stock books an outward delta', () => {
    // FIFO: opening 10 @ ₹10 + 10 @ ₹20; count says 5 → remove 15 FIFO → closing 5@20.
    const r = valueStock('fifo', 10000, 100000, [mv('in', 10000, 200000), mv('in', 5000, 0, true)])
    expect(r.closingQtyMilli).toBe(5000)
    expect(r.closingValue).toBe(100000)
    expect(r.outwardQtyMilli).toBe(15000)
  })

  it('an absolute line equal to current stock is a no-op', () => {
    const r = valueStock('weighted_avg', 10000, 100000, [mv('in', 10000, 0, true)])
    expect(r.closingQtyMilli).toBe(10000)
    expect(r.closingValue).toBe(100000)
    expect(r.inwardQtyMilli).toBe(0)
    expect(r.outwardQtyMilli).toBe(0)
  })

  it('an absolute count of zero empties the stock and its value', () => {
    const r = valueStock('fifo', 10000, 100000, [mv('in', 0, 0, true)])
    expect(r.closingQtyMilli).toBe(0)
    expect(r.closingValue).toBe(0)
  })
})

describe('allocateAdditionalCost', () => {
  it('splits an extra cost pro-rata over the base amounts, conserving every paisa', () => {
    const shares = allocateAdditionalCost([100, 200, 700], 55)
    expect(shares.reduce((s, x) => s + x, 0)).toBe(55)
    expect(shares).toEqual([6, 11, 38])
  })

  it('gives everything to a single line', () => {
    expect(allocateAdditionalCost([500], 33)).toEqual([33])
  })

  it('splits equally when all bases are zero', () => {
    const shares = allocateAdditionalCost([0, 0, 0], 10)
    expect(shares.reduce((s, x) => s + x, 0)).toBe(10)
  })

  it('returns an empty array for no lines', () => {
    expect(allocateAdditionalCost([], 10)).toEqual([])
  })
})

describe('expiryBucketOf', () => {
  it('buckets by days until expiry relative to asOn', () => {
    expect(expiryBucketOf(null, '2026-01-01')).toBe('none')
    expect(expiryBucketOf('2025-12-31', '2026-01-01')).toBe('expired')
    expect(expiryBucketOf('2026-01-01', '2026-01-01')).toBe('within30') // expires today = still usable today
    expect(expiryBucketOf('2026-01-31', '2026-01-01')).toBe('within30')
    expect(expiryBucketOf('2026-02-01', '2026-01-01')).toBe('within90')
    expect(expiryBucketOf('2026-04-01', '2026-01-01')).toBe('within90')
    expect(expiryBucketOf('2026-04-02', '2026-01-01')).toBe('later')
  })
})

describe('wouldCreateBomCycle', () => {
  // Edges are (parent item) -> (component).
  it('detects a direct two-node cycle', () => {
    // B already contains A; making A contain B is a cycle.
    expect(wouldCreateBomCycle(1, [2], [{ itemId: 2, componentId: 1 }])).toBe(true)
  })

  it('detects a multi-level cycle', () => {
    // C contains B, B contains A; making A contain C closes the loop.
    const edges = [
      { itemId: 3, componentId: 2 },
      { itemId: 2, componentId: 1 }
    ]
    expect(wouldCreateBomCycle(1, [3], edges)).toBe(true)
  })

  it('allows a shared component used by two parents (a DAG, not a cycle)', () => {
    const edges = [
      { itemId: 2, componentId: 4 },
      { itemId: 3, componentId: 4 }
    ]
    expect(wouldCreateBomCycle(1, [2, 3], edges)).toBe(false)
  })

  it('ignores the item’s own previous BOM lines (they are being replaced)', () => {
    // Item 1 currently contains 2 — replacing with [3] must not read the old edge.
    const edges = [{ itemId: 1, componentId: 2 }]
    expect(wouldCreateBomCycle(1, [3], edges)).toBe(false)
  })
})
