import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import type { DB } from '../db/connection'
import {
  saveVoucher, checkStock, getVoucher, maturePostDated, maturePdcNow, pdcRegister, setLockDate,
  type SaveVoucherResult
} from './vouchers'
import {
  createStockItem, createUnit, createGodown, updateGodown, deleteGodown, createBatch, listBatches, createLedger
} from './masters'
import { setBom } from './extras'
import { savePriceLevel, saveRate, rateFor, deletePriceLevel } from './priceLevels'
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
    reorderLevelMilli: null,
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

  it.each(['weighted_avg', 'fifo'] as const)(
    'keeps the godown breakdown reconciled after a company-wide count (%s)',
    (valuationMethod) => {
      const db = seededDb()
      const a = createGodown(db, { name: 'Count A', address: null })
      const b = createGodown(db, { name: 'Count B', address: null })
      const id = makeItem(db, `Count split ${valuationMethod}`, valuationMethod)

      // Deliberately use quantities and values that do not divide evenly so this also exercises
      // paisa rounding in the by-godown value allocation.
      postStock(db, '2025-05-01', [
        { stockItemId: id, qtyMilli: 10001, amount: 100003, direction: 'in', godownId: a.id }
      ])
      postStock(db, '2025-05-05', [
        { stockItemId: id, qtyMilli: 3334, direction: 'out', godownId: a.id },
        { stockItemId: id, qtyMilli: 3334, amount: 33341, direction: 'in', godownId: b.id }
      ])

      // PhysicalStockEntry records an item-wide count without a godown. Its adjustment must
      // reconcile the location rows, not pin a second independent "no godown" balance.
      postStock(db, '2025-05-10', [
        { stockItemId: id, qtyMilli: 7777, direction: 'in', isAbsolute: true }
      ], 'physical_stock')

      const afterCount = rowFor(db, id, '2025-05-10')
      const splitAfterCount = stockAnalysis.stockByGodown(db, '2025-05-10').filter((r) => r.stockItemId === id)
      expect(splitAfterCount.reduce((sum, r) => sum + r.closingQtyMilli, 0)).toBe(afterCount.closingQtyMilli)
      expect(splitAfterCount.reduce((sum, r) => sum + r.closingValue, 0)).toBe(afterCount.closingValue)

      // Later movements retain the same invariant, including a negative unallocated count
      // adjustment and another non-even value allocation.
      postStock(db, '2025-05-11', [
        { stockItemId: id, qtyMilli: 1000, direction: 'out', godownId: a.id },
        { stockItemId: id, qtyMilli: 500, amount: 15001, direction: 'in', godownId: b.id }
      ])
      const final = rowFor(db, id, '2025-05-31')
      const finalSplit = stockAnalysis.stockByGodown(db, '2025-05-31').filter((r) => r.stockItemId === id)
      expect(final.closingQtyMilli).toBe(7277)
      expect(finalSplit.reduce((sum, r) => sum + r.closingQtyMilli, 0)).toBe(final.closingQtyMilli)
      expect(finalSplit.reduce((sum, r) => sum + r.closingValue, 0)).toBe(final.closingValue)
    }
  )

  it('keeps a negative post-count position reconciled by godown and removes zero-count rows', () => {
    const db = seededDb()
    const godown = createGodown(db, { name: 'Counted store', address: null })
    const id = makeItem(db, 'Counted below zero', 'weighted_avg')
    postStock(db, '2025-05-01', [
      { stockItemId: id, qtyMilli: 3000, amount: 30001, direction: 'in', godownId: godown.id }
    ])
    postStock(db, '2025-05-02', [
      { stockItemId: id, qtyMilli: 0, direction: 'in', isAbsolute: true }
    ], 'physical_stock')
    expect(stockAnalysis.stockByGodown(db, '2025-05-02').filter((r) => r.stockItemId === id)).toEqual([])

    postStock(db, '2025-05-03', [
      { stockItemId: id, qtyMilli: 1000, direction: 'out', godownId: godown.id }
    ])
    const summary = rowFor(db, id, '2025-05-31')
    const split = stockAnalysis.stockByGodown(db, '2025-05-31').filter((r) => r.stockItemId === id)
    expect(summary.closingQtyMilli).toBe(-1000)
    expect(split.reduce((sum, r) => sum + r.closingQtyMilli, 0)).toBe(summary.closingQtyMilli)
    expect(split.reduce((sum, r) => sum + r.closingValue, 0)).toBe(summary.closingValue)
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

// ---------- I3 helpers ----------

function makeLedgerIn(db: DB, name: string, groupName: string, extra: { creditLimit?: number | null; priceLevelId?: number | null } = {}): number {
  const group = db.prepare('SELECT id FROM groups WHERE name = ?').get(groupName) as { id: number } | undefined
  if (!group) throw new Error(`Seeded group '${groupName}' not found`)
  return createLedger(db, {
    name, groupId: group.id, openingBalance: 0, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null,
    exportType: null, priceLevelId: extra.priceLevelId ?? null, creditLimit: extra.creditLimit ?? null
  }).id
}

interface LedgerLine {
  ledgerId: number
  drCr: 'dr' | 'cr'
  amount: number
}

function postLedgerVoucher(
  db: DB,
  kind: 'sales' | 'journal' | 'stock_journal',
  date: string,
  partyLedgerId: number | null,
  lines: LedgerLine[],
  opts: { postDated?: boolean; isOptional?: boolean; inventory?: StockLine[]; existingId?: number } = {}
): SaveVoucherResult {
  const vt = db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }
  return saveVoucher(
    db,
    {
      voucherTypeId: vt.id,
      date,
      partyLedgerId,
      narration: null,
      reference: null,
      instrumentNo: null,
      instrumentDate: null,
      transporterId: null,
      vehicleNo: null,
      transportDistanceKm: null,
      currencyCode: null,
      exchangeRate: null,
      postDated: opts.postDated,
      isOptional: opts.isOptional,
      lines: lines.map((l) => ({ ...l, costAllocations: [] })),
      inventory: (opts.inventory ?? []).map((l) => ({
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
    },
    opts.existingId
  )
}

const postSales = (db: DB, date: string, partyId: number, salesId: number, amount: number, opts: { postDated?: boolean; isOptional?: boolean } = {}) =>
  postLedgerVoucher(db, 'sales', date, partyId, [
    { ledgerId: partyId, drCr: 'dr', amount },
    { ledgerId: salesId, drCr: 'cr', amount }
  ], opts)

// ---------- I3: price levels ----------

describe('price levels — date-effective rates', () => {
  it('rateFor returns the latest rate with effective_from ≤ date, null before any', () => {
    const db = seededDb()
    const item = makeItem(db, 'Priced', 'weighted_avg')
    const level = savePriceLevel(db, { name: 'Wholesale' })
    saveRate(db, { priceLevelId: level.id, stockItemId: item, rate: 10000, effectiveFrom: '2025-04-01' })
    saveRate(db, { priceLevelId: level.id, stockItemId: item, rate: 12000, effectiveFrom: '2025-06-01' })
    expect(rateFor(db, level.id, item, '2025-03-31')).toBeNull()
    expect(rateFor(db, level.id, item, '2025-04-01')).toBe(10000)
    expect(rateFor(db, level.id, item, '2025-05-15')).toBe(10000)
    expect(rateFor(db, level.id, item, '2025-06-01')).toBe(12000)
    expect(rateFor(db, level.id, item, '2026-01-01')).toBe(12000)
  })

  it('upserts on the same (level, item, effective_from) and blocks deleting an assigned level', () => {
    const db = seededDb()
    const item = makeItem(db, 'Priced2', 'weighted_avg')
    const level = savePriceLevel(db, { name: 'Retail' })
    saveRate(db, { priceLevelId: level.id, stockItemId: item, rate: 5000, effectiveFrom: '2025-04-01' })
    saveRate(db, { priceLevelId: level.id, stockItemId: item, rate: 5500, effectiveFrom: '2025-04-01' })
    expect(rateFor(db, level.id, item, '2025-04-02')).toBe(5500)

    makeLedgerIn(db, 'Priced Party', 'Sundry Debtors', { priceLevelId: level.id })
    expect(() => deletePriceLevel(db, level.id)).toThrow(/assigned/)
  })
})

// ---------- I3: credit limits ----------

describe('credit limit on saveVoucher', () => {
  it('warns when the party outstanding incl. this voucher exceeds the limit; blocks under F11', () => {
    const db = seededDb()
    const party = makeLedgerIn(db, 'Limited Party', 'Sundry Debtors', { creditLimit: 100000 })
    const sales = makeLedgerIn(db, 'Sales A/c', 'Sales Accounts')

    const ok = postSales(db, '2025-05-01', party, sales, 60000)
    expect(ok.warnings.creditLimitExceeded).toBeNull()

    const over = postSales(db, '2025-05-02', party, sales, 50000)
    expect(over.warnings.creditLimitExceeded).toEqual({
      ledgerId: party, ledgerName: 'Limited Party', creditLimit: 100000, outstanding: 110000
    })

    setFeatures(db, { ...DEFAULT_FEATURES, enforceCreditLimit: true })
    const countBefore = (db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n
    expect(() => postSales(db, '2025-05-03', party, sales, 10000)).toThrow(/Credit limit exceeded/)
    const countAfter = (db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n
    expect(countAfter).toBe(countBefore) // rolled back
  })

  it('post-dated and optional vouchers never trip the limit', () => {
    const db = seededDb()
    const party = makeLedgerIn(db, 'PDC Party', 'Sundry Debtors', { creditLimit: 1000 })
    const sales = makeLedgerIn(db, 'Sales B', 'Sales Accounts')
    expect(postSales(db, '2025-05-01', party, sales, 50000, { postDated: true }).warnings.creditLimitExceeded).toBeNull()
    expect(postSales(db, '2025-05-01', party, sales, 50000, { isOptional: true }).warnings.creditLimitExceeded).toBeNull()
  })
})

// ---------- I3: post-dated + optional vouchers ----------

describe('post-dated and optional vouchers', () => {
  it('keeps PDC/optional inventory out of the books until maturity', () => {
    const db = seededDb()
    const item = makeItem(db, 'PDC Item', 'weighted_avg', 10000, 100000)
    postLedgerVoucher(db, 'stock_journal', '2025-05-01', null, [], {
      postDated: true, inventory: [{ stockItemId: item, qtyMilli: 4000, direction: 'out' }]
    })
    postLedgerVoucher(db, 'stock_journal', '2025-05-01', null, [], {
      isOptional: true, inventory: [{ stockItemId: item, qtyMilli: 3000, direction: 'out' }]
    })
    expect(rowFor(db, item, '2025-05-31').closingQtyMilli).toBe(10000)

    const { matured } = maturePostDated(db, '2025-05-31')
    expect(matured).toHaveLength(1)
    // The PDC now counts; the optional voucher still doesn't.
    expect(rowFor(db, item, '2025-05-31').closingQtyMilli).toBe(6000)
  })

  it('pdcRegister lists live PDCs; maturePostDated flips only due ones and audits each', () => {
    const db = seededDb()
    const party = makeLedgerIn(db, 'Register Party', 'Sundry Debtors')
    const sales = makeLedgerIn(db, 'Sales C', 'Sales Accounts')
    const due = postSales(db, '2025-05-10', party, sales, 12345, { postDated: true })
    const future = postSales(db, '2025-07-10', party, sales, 500, { postDated: true })

    const reg = pdcRegister(db)
    expect(reg.map((r) => [r.id, r.amount, r.partyName])).toEqual([
      [due.id, 12345, 'Register Party'],
      [future.id, 500, 'Register Party']
    ])

    const { matured } = maturePostDated(db, '2025-06-01')
    expect(matured).toEqual([due.id])
    expect(getVoucher(db, due.id)!.postDated).toBe(false)
    expect(getVoucher(db, future.id)!.postDated).toBe(true)
    expect(pdcRegister(db).map((r) => r.id)).toEqual([future.id])
    const audits = db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'voucher' AND entity_id = ? AND action = 'update'")
      .get(due.id) as { n: number }
    expect(audits.n).toBeGreaterThanOrEqual(1)
  })

  it('maturation respects the books lock: due PDCs dated inside a locked period are refused, not posted (v0.3 review F3)', () => {
    const db = seededDb()
    const party = makeLedgerIn(db, 'Lock Party', 'Sundry Debtors')
    const sales = makeLedgerIn(db, 'Sales Lock', 'Sales Accounts')
    const inLocked = postSales(db, '2025-05-10', party, sales, 7000, { postDated: true })
    const afterLock = postSales(db, '2025-07-10', party, sales, 9000, { postDated: true })
    // Year-end-close style lock: everything up to 30 Jun is closed.
    setLockDate(db, '2025-06-30')

    const res = maturePostDated(db, '2025-08-01')
    expect(res.matured).toEqual([afterLock.id])
    expect(res.blockedByLock).toEqual([inLocked.id])
    // The blocked PDC stays out of the books (still post-dated, still in the register)...
    expect(getVoucher(db, inLocked.id)!.postDated).toBe(true)
    expect(pdcRegister(db).map((r) => r.id)).toEqual([inLocked.id])
    // ...and "Mature now" refuses it too, same as saveVoucher/deleteVoucher on locked dates.
    expect(() => maturePdcNow(db, inLocked.id)).toThrow(/locked/i)

    // Lifting the lock lets it mature normally.
    setLockDate(db, null)
    expect(maturePostDated(db, '2025-08-01')).toEqual({ matured: [inLocked.id], blockedByLock: [] })
    expect(getVoucher(db, inLocked.id)!.postDated).toBe(false)
  })

  it('editing a voucher without mentioning the flags preserves them', () => {
    const db = seededDb()
    const party = makeLedgerIn(db, 'Edit Party', 'Sundry Debtors')
    const sales = makeLedgerIn(db, 'Sales D', 'Sales Accounts')
    const v = postSales(db, '2025-06-15', party, sales, 700, { postDated: true })
    const edited = postLedgerVoucher(db, 'sales', '2025-06-16', party, [
      { ledgerId: party, drCr: 'dr', amount: 800 },
      { ledgerId: sales, drCr: 'cr', amount: 800 }
    ], { existingId: v.id })
    expect(edited.postDated).toBe(true)
    expect(edited.isOptional).toBe(false)
  })
})

// ---------- I3: BOM cycles + manufacture additional cost ----------

describe('BOM multi-level cycle detection', () => {
  it('rejects a BOM that would close a loop through existing BOMs', () => {
    const db = seededDb()
    const a = makeItem(db, 'Assembly A', 'weighted_avg')
    const b = makeItem(db, 'Part B', 'weighted_avg')
    const c = makeItem(db, 'Part C', 'weighted_avg')
    setBom(db, { itemId: a, lines: [{ componentId: b, qtyMilliPerUnit: 1000 }] })
    setBom(db, { itemId: b, lines: [{ componentId: c, qtyMilliPerUnit: 1000 }] })
    expect(() => setBom(db, { itemId: c, lines: [{ componentId: a, qtyMilliPerUnit: 1000 }] })).toThrow(/cycle/)
    expect(() => setBom(db, { itemId: c, lines: [{ componentId: c, qtyMilliPerUnit: 1000 }] })).toThrow(/own component/)
    // Replacing A's BOM is allowed even though A currently points at B.
    setBom(db, { itemId: a, lines: [{ componentId: c, qtyMilliPerUnit: 2000 }] })
  })
})

describe('manufacture additional-cost lines', () => {
  it("loads the stock journal's ledger cost into the produced item's value", () => {
    const db = seededDb()
    const component = makeItem(db, 'Raw', 'weighted_avg', 5000, 50000)
    const produced = makeItem(db, 'Finished', 'weighted_avg')
    const freight = makeLedgerIn(db, 'Freight Inward', 'Indirect Expenses')
    const cash = db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }

    postLedgerVoucher(db, 'stock_journal', '2025-05-05', null, [
      { ledgerId: freight, drCr: 'dr', amount: 500 },
      { ledgerId: cash.id, drCr: 'cr', amount: 500 }
    ], {
      inventory: [
        { stockItemId: component, qtyMilli: 2000, direction: 'out' },
        { stockItemId: produced, qtyMilli: 1000, amount: 20000, direction: 'in' }
      ]
    })

    // Produced: base 20000 + 500 additional cost. Component: 2 of 5 consumed at avg ₹10.
    expect(rowFor(db, produced, '2025-05-31').closingValue).toBe(20500)
    expect(rowFor(db, component, '2025-05-31').closingValue).toBe(30000)
  })

  it('splits the extra pro-rata across inward lines, conserving every paisa', () => {
    const db = seededDb()
    const p1 = makeItem(db, 'Out One', 'weighted_avg')
    const p2 = makeItem(db, 'Out Two', 'weighted_avg')
    const freight = makeLedgerIn(db, 'Labour', 'Indirect Expenses')
    const cash = db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }
    postLedgerVoucher(db, 'stock_journal', '2025-05-05', null, [
      { ledgerId: freight, drCr: 'dr', amount: 101 },
      { ledgerId: cash.id, drCr: 'cr', amount: 101 }
    ], {
      inventory: [
        { stockItemId: p1, qtyMilli: 1000, amount: 1000, direction: 'in' },
        { stockItemId: p2, qtyMilli: 1000, amount: 2000, direction: 'in' }
      ]
    })
    const v1 = rowFor(db, p1, '2025-05-31').closingValue
    const v2 = rowFor(db, p2, '2025-05-31').closingValue
    expect(v1 + v2).toBe(3101)
    expect(v1).toBe(1034) // floor(101/3)=33 +1 largest-remainder
    expect(v2).toBe(2067)
  })
})
