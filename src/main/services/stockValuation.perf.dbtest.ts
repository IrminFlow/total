// Stock valuation performance guard (WP 2.1): ~100,000 inventory lines (≈50k vouchers across
// 500 items: purchases, sales, notes, mixed stock journals with additional cost, physical counts)
// seeded by raw INSERTs in one transaction, then the engine-valued stock reports are timed
// best-of-3. Same flake-proofing as search.perf.dbtest.ts / dashboard.perf.dbtest.ts: best-of-3,
// a looser bound when CI is set, TOTAL_SKIP_PERF=1 skips the suite.
//
// This is a REGRESSION GUARD, not a benchmark: the bounds only trip on an order-of-magnitude
// regression (an O(n²) walk, a per-line query). The measured times are printed — watch those.
import { describe, it, expect, beforeAll } from 'vitest'
import { seededDb } from '../db/testdb'
import type { DB } from '../db/connection'
import * as stockAnalysis from './stockAnalysis'
import { seedStockFixture } from './stockFixture.testutil'

const BOUND_MS = process.env.CI ? 8000 : 3000
const skip = process.env.TOTAL_SKIP_PERF === '1'

function bestOf3(fn: () => unknown): number {
  let best = Infinity
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now()
    fn()
    best = Math.min(best, performance.now() - t0)
  }
  return best
}

describe.skipIf(skip)('stock valuation performance (100k inventory lines)', () => {
  let db: DB
  let godown = 0
  beforeAll(() => {
    db = seededDb()
    const fx = seedStockFixture(db, { vouchers: 50_000, items: 500, seed: 99, days: 730 })
    expect(fx.inventoryLines).toBeGreaterThanOrEqual(100_000)
    godown = fx.godownIds[0]!
  }, 120_000)

  const cases: [string, () => unknown][] = [
    ['stockSummary', () => stockAnalysis.stockSummary(db, '2027-03-31')],
    ['stockSummary(godown)', () => stockAnalysis.stockSummary(db, '2027-03-31', { godownId: godown })],
    ['stockValuesAt(13 dates)', () =>
      stockAnalysis.stockValuesAt(db, Array.from({ length: 13 }, (_, i) => new Date(Date.UTC(2025, 3 + i * 2, 0)).toISOString().slice(0, 10)))],
    ['periodConsumption', () => stockAnalysis.periodConsumption(db, '2026-04-01', '2027-03-31')],
    ['stockByGodown', () => stockAnalysis.stockByGodown(db, '2027-03-31')]
  ]
  for (const [name, fn] of cases) {
    it(`${name} returns within ${BOUND_MS} ms`, () => {
      const best = bestOf3(fn)
      console.log(`[valuation perf] ${name} best of 3: ${best.toFixed(1)} ms`)
      expect(best, `${name} best of 3 took ${best.toFixed(1)} ms (bound ${BOUND_MS} ms)`).toBeLessThan(BOUND_MS)
    })
  }
})
