import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import * as stockAnalysis from './stockAnalysis'
import { itemProfitability } from './reports'
import { seedStockFixture } from './stockFixture.testutil'

// ---------- legacy parity (WP 2.1) ----------
// The file snapshot below was generated on origin/main BEFORE the global valuation pass landed
// (commit "test: pin legacy stock valuation outputs"). Every existing voucher uses the 'stored'
// costing rule, so every stock figure the app reports must stay byte-identical: a company's
// stock value must not move on upgrade. Do not regenerate this snapshot to make a change pass.

function legacyOutputs(): unknown {
  const db = seededDb()
  const fx = seedStockFixture(db, { vouchers: 2500, items: 30, seed: 7 })
  const ends = ['2025-04-30', '2025-06-30', '2025-09-30', '2025-12-31', '2026-03-31']
  return {
    lines: fx.inventoryLines,
    summary: ends.map((d) => stockAnalysis.stockSummary(db, d)),
    summaryByGodown: fx.godownIds.map((g) => stockAnalysis.stockSummary(db, '2026-03-31', { godownId: g })),
    stockValue: ends.map((d) => stockAnalysis.stockValue(db, d)),
    valuesAt: [...stockAnalysis.stockValuesAt(db, ends).entries()],
    consumption: [
      ['2025-04-01', '2025-06-30'],
      ['2025-07-15', '2025-07-15'],
      ['2025-10-01', '2026-03-31']
    ].map(([f, t]) => [...stockAnalysis.periodConsumption(db, f!, t!).entries()].sort((a, b) => a[0] - b[0])),
    byGodown: stockAnalysis.stockByGodown(db, '2026-03-31'),
    profitability: itemProfitability(db, '2025-04-01', '2026-03-31')
  }
}

describe('stock valuation — legacy parity', () => {
  it('reproduces origin/main outputs byte-for-byte on a randomised fixture', async () => {
    await expect(JSON.stringify(legacyOutputs(), null, 1)).toMatchFileSnapshot('./__snapshots__/stockValuation.legacy.json')
  })
})
