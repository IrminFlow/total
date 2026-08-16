import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import type { DB } from '../db/connection'
import { saveVoucher, checkStock, type SaveVoucherResult } from './vouchers'
import { createStockItem, createUnit } from './masters'
import { setFeatures } from './config'
import { DEFAULT_FEATURES } from '@shared/features'
import * as stockAnalysis from './stockAnalysis'

// ---------- helpers ----------

function makeItem(
  db: DB,
  name: string,
  valuationMethod: 'weighted_avg' | 'fifo',
  openingQtyMilli = 0,
  openingValue = 0
): number {
  const unit = db.prepare('SELECT id FROM units ORDER BY id LIMIT 1').get() as { id: number } | undefined
  const unitId = unit?.id ?? createUnit(db, { name: 'Numbers', symbol: 'nos', decimals: 0, uqc: 'NOS' }).id
  return createStockItem(db, {
    name,
    groupId: null,
    unitId,
    hsn: null,
    gstRate: null,
    cessRate: null,
    openingQtyMilli,
    openingValue,
    barcode: null,
    valuationMethod
  }).id
}

interface StockLine {
  stockItemId: number
  qtyMilli: number
  amount?: number
  direction: 'in' | 'out'
  isAbsolute?: boolean
  godownId?: number | null
  batchId?: number | null
}

/** Post a stock-journal (or physical-stock) voucher carrying only inventory lines. */
function postStock(db: DB, date: string, items: StockLine[], kind: 'stock_journal' | 'physical_stock' = 'stock_journal'): SaveVoucherResult {
  const vt = db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }
  return saveVoucher(db, {
    voucherTypeId: vt.id,
    date,
    partyLedgerId: null,
    narration: null,
    reference: null,
    instrumentNo: null,
    instrumentDate: null,
    transporterId: null,
    vehicleNo: null,
    transportDistanceKm: null,
    currencyCode: null,
    exchangeRate: null,
    lines: [],
    inventory: items.map((l) => ({
      stockItemId: l.stockItemId,
      godownId: l.godownId ?? null,
      batchId: l.batchId ?? null,
      qtyMilli: l.qtyMilli,
      ratePaise: 0,
      amount: l.amount ?? 0,
      direction: l.direction,
      isAbsolute: l.isAbsolute ?? false
    })),
    billRefs: [],
    tds: null
  })
}

const rowFor = (db: DB, itemId: number, asOn: string, godownId?: number) =>
  stockAnalysis.stockSummary(db, asOn, { godownId }).find((r) => r.stockItemId === itemId)!

// ---------- I1: valuation engine wired to the DB ----------

describe('stockAnalysis.stockSummary — valuation methods', () => {
  it('values FIFO and weighted-average items differently on the same movements', () => {
    const db = seededDb()
    const fifoId = makeItem(db, 'Widget FIFO', 'fifo', 10000, 100000)
    const avgId = makeItem(db, 'Widget AVG', 'weighted_avg', 10000, 100000)
    for (const id of [fifoId, avgId]) {
      postStock(db, '2025-05-01', [{ stockItemId: id, qtyMilli: 10000, amount: 200000, direction: 'in' }])
      postStock(db, '2025-05-02', [{ stockItemId: id, qtyMilli: 15000, direction: 'out' }])
    }
    const fifo = rowFor(db, fifoId, '2025-05-31')
    const avg = rowFor(db, avgId, '2025-05-31')
    expect(fifo.closingQtyMilli).toBe(5000)
    expect(avg.closingQtyMilli).toBe(5000)
    expect(fifo.closingValue).toBe(100000) // 5 left @ ₹20 layer
    expect(avg.closingValue).toBe(75000) // 5 left @ moving avg ₹15
    expect(stockAnalysis.stockValue(db, '2025-05-31')).toBe(175000)
  })

  it('walks movements chronologically by voucher date, not insertion order', () => {
    const db = seededDb()
    const id = makeItem(db, 'Chrono', 'weighted_avg', 10000, 100000)
    // Inserted out-of-order: the sale on May 2 must be valued before the May 10 purchase.
    postStock(db, '2025-05-10', [{ stockItemId: id, qtyMilli: 10000, amount: 400000, direction: 'in' }])
    postStock(db, '2025-05-02', [{ stockItemId: id, qtyMilli: 5000, direction: 'out' }])
    const row = rowFor(db, id, '2025-05-31')
    expect(row.closingQtyMilli).toBe(15000)
    expect(row.closingValue).toBe(450000) // 5 @ avg ₹10 + 10 @ ₹40
  })
})

describe('physical stock (absolute) lines', () => {
  it('pins the closing quantity, valuing the delta at the current average cost', () => {
    const db = seededDb()
    const id = makeItem(db, 'Counted', 'weighted_avg', 10000, 100000)
    postStock(db, '2025-06-01', [{ stockItemId: id, qtyMilli: 12000, direction: 'in', isAbsolute: true }], 'physical_stock')
    const row = rowFor(db, id, '2025-06-30')
    expect(row.closingQtyMilli).toBe(12000)
    expect(row.closingValue).toBe(120000)
  })

  it('accepts a zero-quantity count and empties the stock', () => {
    const db = seededDb()
    const id = makeItem(db, 'Zeroed', 'fifo', 10000, 100000)
    postStock(db, '2025-06-01', [{ stockItemId: id, qtyMilli: 0, direction: 'in', isAbsolute: true }], 'physical_stock')
    const row = rowFor(db, id, '2025-06-30')
    expect(row.closingQtyMilli).toBe(0)
    expect(row.closingValue).toBe(0)
  })
})

describe('negative-stock detection', () => {
  it('saveVoucher warns (but saves) when an outward line overdraws stock', () => {
    const db = seededDb()
    const id = makeItem(db, 'Scarce', 'weighted_avg', 5000, 50000)
    const result = postStock(db, '2025-05-01', [{ stockItemId: id, qtyMilli: 8000, direction: 'out' }])
    expect(result.warnings.negativeStock).toHaveLength(1)
    expect(result.warnings.negativeStock[0]).toMatchObject({ stockItemId: id, closingQtyMilli: -3000 })
    // Saved anyway.
    expect(rowFor(db, id, '2025-05-31').closingQtyMilli).toBe(-3000)
  })

  it('does not warn when stock stays non-negative, and checkStock agrees', () => {
    const db = seededDb()
    const id = makeItem(db, 'Plenty', 'fifo', 5000, 50000)
    const result = postStock(db, '2025-05-01', [{ stockItemId: id, qtyMilli: 5000, direction: 'out' }])
    expect(result.warnings.negativeStock).toEqual([])
    expect(checkStock(db, [id], '2025-05-31')).toEqual([])
  })

  it('blocks the save when the preventNegativeStock feature is on, rolling everything back', () => {
    const db = seededDb()
    const id = makeItem(db, 'Guarded', 'weighted_avg', 5000, 50000)
    setFeatures(db, { ...DEFAULT_FEATURES, preventNegativeStock: true })
    expect(() => postStock(db, '2025-05-01', [{ stockItemId: id, qtyMilli: 8000, direction: 'out' }]))
      .toThrow(/Insufficient stock/)
    // Nothing was written.
    expect(rowFor(db, id, '2025-05-31').closingQtyMilli).toBe(5000)
    const count = db.prepare('SELECT COUNT(*) AS n FROM inventory_lines').get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('negativeStock lists overdrawn items for the exceptions report', () => {
    const db = seededDb()
    const id = makeItem(db, 'Exceptional', 'weighted_avg', 1000, 1000)
    postStock(db, '2025-05-01', [{ stockItemId: id, qtyMilli: 2000, direction: 'out' }])
    const rows = stockAnalysis.negativeStock(db, '2025-05-31')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ stockItemId: id, closingQtyMilli: -1000 })
  })
})
