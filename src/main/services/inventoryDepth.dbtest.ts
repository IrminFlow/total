import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import type { DB } from '../db/connection'
import { saveVoucher, checkStock, type SaveVoucherResult } from './vouchers'
import { createStockItem, createUnit, createGodown, updateGodown, deleteGodown, createBatch, listBatches } from './masters'
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

// ---------- I2: godowns, batches, transfers ----------

describe('godown CRUD + godown transfer', () => {
  it('creates, updates and deletes godowns with an address', () => {
    const db = seededDb()
    const g = createGodown(db, { name: 'Main Warehouse', address: '12 MG Road' })
    expect(g.address).toBe('12 MG Road')
    const updated = updateGodown(db, g.id, { name: 'Main WH', address: null })
    expect(updated).toMatchObject({ name: 'Main WH', address: null })
    deleteGodown(db, g.id)
    expect(db.prepare('SELECT COUNT(*) AS n FROM godowns WHERE id = ?').get(g.id)).toMatchObject({ n: 0 })
  })

  it('refuses to delete a godown holding stock movements', () => {
    const db = seededDb()
    const g = createGodown(db, { name: 'Held', address: null })
    const item = makeItem(db, 'Boxed', 'weighted_avg')
    postStock(db, '2025-05-01', [{ stockItemId: item, qtyMilli: 1000, amount: 1000, direction: 'in', godownId: g.id }])
    expect(() => deleteGodown(db, g.id)).toThrow(/stock movements/)
  })

  it('a godown transfer conserves total quantity and value while moving godown balances', () => {
    const db = seededDb()
    const a = createGodown(db, { name: 'Godown A', address: null })
    const b = createGodown(db, { name: 'Godown B', address: null })
    const item = makeItem(db, 'Moved', 'weighted_avg')
    postStock(db, '2025-05-01', [{ stockItemId: item, qtyMilli: 10000, amount: 100000, direction: 'in', godownId: a.id }])
    // Transfer 4 from A to B via a stock journal (out of A, into B).
    postStock(db, '2025-05-05', [
      { stockItemId: item, qtyMilli: 4000, direction: 'out', godownId: a.id },
      { stockItemId: item, qtyMilli: 4000, amount: 40000, direction: 'in', godownId: b.id }
    ])
    const total = rowFor(db, item, '2025-05-31')
    expect(total.closingQtyMilli).toBe(10000)
    expect(total.closingValue).toBe(100000)
    const byGodown = stockAnalysis.stockByGodown(db, '2025-05-31').filter((r) => r.stockItemId === item)
    const inA = byGodown.find((r) => r.godownId === a.id)!
    const inB = byGodown.find((r) => r.godownId === b.id)!
    expect(inA.closingQtyMilli).toBe(6000)
    expect(inB.closingQtyMilli).toBe(4000)
    expect(inA.closingValue + inB.closingValue).toBe(100000)
  })
})

describe('batches', () => {
  it('createBatch is create-or-return per (item, name) and listBatches scopes by item', () => {
    const db = seededDb()
    const item = makeItem(db, 'Batched', 'weighted_avg')
    const other = makeItem(db, 'Other', 'weighted_avg')
    const b1 = createBatch(db, { stockItemId: item, name: 'LOT-1', mfgDate: '2025-04-01', expiryDate: '2026-04-01' })
    const again = createBatch(db, { stockItemId: item, name: 'LOT-1', mfgDate: null, expiryDate: null })
    expect(again.id).toBe(b1.id)
    createBatch(db, { stockItemId: other, name: 'LOT-1', mfgDate: null, expiryDate: null })
    expect(listBatches(db, item)).toHaveLength(1)
    expect(listBatches(db)).toHaveLength(2)
  })

  it('tracks per-batch balances and validates outward availability', () => {
    const db = seededDb()
    const item = makeItem(db, 'Lots', 'fifo')
    const lot1 = createBatch(db, { stockItemId: item, name: 'L1', mfgDate: null, expiryDate: null })
    const lot2 = createBatch(db, { stockItemId: item, name: 'L2', mfgDate: null, expiryDate: null })
    postStock(db, '2025-05-01', [
      { stockItemId: item, qtyMilli: 5000, amount: 50000, direction: 'in', batchId: lot1.id },
      { stockItemId: item, qtyMilli: 3000, amount: 45000, direction: 'in', batchId: lot2.id }
    ])
    postStock(db, '2025-05-02', [{ stockItemId: item, qtyMilli: 2000, direction: 'out', batchId: lot1.id }])
    const rows = stockAnalysis.batchStock(db, '2025-05-31', item)
    expect(rows.find((r) => r.batchId === lot1.id)!.closingQtyMilli).toBe(3000)
    expect(rows.find((r) => r.batchId === lot2.id)!.closingQtyMilli).toBe(3000)

    // Taking more than the batch holds is a hard error and rolls back.
    expect(() => postStock(db, '2025-05-03', [{ stockItemId: item, qtyMilli: 4000, direction: 'out', batchId: lot1.id }]))
      .toThrow(/Not enough stock in batch L1/)
    expect(stockAnalysis.batchStock(db, '2025-05-31', item).find((r) => r.batchId === lot1.id)!.closingQtyMilli).toBe(3000)
  })

  it('rejects a line whose batch belongs to a different item', () => {
    const db = seededDb()
    const item = makeItem(db, 'Right', 'weighted_avg')
    const wrongItem = makeItem(db, 'Wrong', 'weighted_avg')
    const lot = createBatch(db, { stockItemId: wrongItem, name: 'W1', mfgDate: null, expiryDate: null })
    expect(() => postStock(db, '2025-05-01', [{ stockItemId: item, qtyMilli: 1000, amount: 0, direction: 'in', batchId: lot.id }]))
      .toThrow(/different stock item/)
  })

  it('expiry ageing buckets batches with stock by expiry date', () => {
    const db = seededDb()
    const item = makeItem(db, 'Perishable', 'weighted_avg')
    const asOn = '2025-06-01'
    const expired = createBatch(db, { stockItemId: item, name: 'EXP', mfgDate: null, expiryDate: '2025-05-20' })
    const soon = createBatch(db, { stockItemId: item, name: 'SOON', mfgDate: null, expiryDate: '2025-06-20' })
    const later = createBatch(db, { stockItemId: item, name: 'LATER', mfgDate: null, expiryDate: '2026-06-01' })
    const empty = createBatch(db, { stockItemId: item, name: 'EMPTY', mfgDate: null, expiryDate: '2025-05-01' })
    postStock(db, '2025-05-01', [
      { stockItemId: item, qtyMilli: 1000, amount: 100, direction: 'in', batchId: expired.id },
      { stockItemId: item, qtyMilli: 1000, amount: 100, direction: 'in', batchId: soon.id },
      { stockItemId: item, qtyMilli: 1000, amount: 100, direction: 'in', batchId: later.id }
    ])
    const rows = stockAnalysis.expiryAgeing(db, asOn)
    expect(rows.map((r) => [r.batchId, r.bucket])).toEqual([
      [expired.id, 'expired'],
      [soon.id, 'within30'],
      [later.id, 'later']
    ])
    expect(rows.find((r) => r.batchId === empty.id)).toBeUndefined()
  })
})
