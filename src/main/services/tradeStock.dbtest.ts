// WP 2.5a (design §2.5–2.6): a challan plus the invoice drawn from it moves stock ONCE — every
// stock reader (summary, godown, batch, register, ageing, reorder, negative stock, checkpoints,
// period consumption) reports exactly the challan-only figures.
import { describe, it, expect } from 'vitest'
import type { DB } from '../db/connection'
import * as stock from './stockAnalysis'
import { stockAgeing, itemProfitability } from './reports'
import { createBatch } from './masters'
import { getFeatures, setFeatures } from './config'
import { deleteVoucher, checkStock } from './vouchers'
import { dc, grn, item, trade, tradeBooks, uid } from './tradeFixture.testutil'

const AS_ON = '2025-06-30'

function stockFigures(db: DB, items: number[], godowns: number[]): unknown {
  return {
    summary: stock.stockSummary(db, AS_ON),
    byGodownView: godowns.map((g) => stock.stockSummary(db, AS_ON, { godownId: g })),
    byGodown: stock.stockByGodown(db, AS_ON),
    batches: stock.batchStock(db, AS_ON),
    expiry: stock.expiryAgeing(db, AS_ON),
    register: items.map((i) => stock.stockMovements(db, i, '2025-04-01', AS_ON)),
    registerGodown: items.map((i) => stock.stockMovements(db, i, '2025-04-01', AS_ON, godowns[0])),
    itemMovements: items.map((i) => stock.itemMovements(db, i, '2025-04-01', AS_ON)),
    ageing: stockAgeing(db, AS_ON),
    reorder: stock.reorderPlan(db, '2025-04-01', AS_ON, { onlyBelow: false }),
    negative: stock.negativeStock(db, AS_ON),
    checkpoints: [...stock.stockValuesAt(db, ['2025-05-01', '2025-05-31', AS_ON]).entries()],
    consumption: [...stock.periodConsumption(db, '2025-04-01', AS_ON).entries()],
    checkStock: checkStock(db, items, AS_ON),
    serials: db.prepare('SELECT stock_item_id, serial, status, godown_id, batch_id FROM serial_numbers ORDER BY serial').all()
  }
}

describe('a challan and its invoice move stock once', () => {
  it('every stock reader equals the challan-only figures', () => {
    const b = tradeBooks()
    const a = item(b.db, 'Widget', { method: 'fifo', opening: [10, 10000] })
    const p = item(b.db, 'Phone', { serials: true })
    b.db.prepare('UPDATE stock_items SET reorder_level_milli = 50000 WHERE id IN (?, ?)').run(a, p)
    const lot = createBatch(b.db, { stockItemId: a, name: 'L1', mfgDate: null, expiryDate: '2025-07-15' }).id
    trade(b, 'purchase', '2025-04-05', [{ item: a, qty: 20, amount: 24000, godown: b.godown, batch: lot }])
    trade(b, 'purchase', '2025-04-06', [{ item: p, qty: 3, amount: 30000, godown: b.godown2, serials: ['S1', 'S2', 'S3'] }])
    const d = dc(b, '2025-05-10', [
      { item: a, qty: 8, amount: 9600, godown: b.godown, batch: lot },
      { item: p, qty: 2, amount: 26000, godown: b.godown2, serials: ['S1', 'S2'] }
    ])
    trade(b, 'sales', '2025-05-20', [{ item: a, qty: 2, amount: 2600, godown: b.godown, batch: lot }])
    const items = [a, p]
    const godowns = [b.godown, b.godown2]
    const challanOnly = JSON.stringify(stockFigures(b.db, items, godowns))
      .replaceAll('"delivered"', '"<out>"')

    const inv = trade(b, 'sales', '2025-06-02', [
      { item: a, qty: 8, amount: 10400, godown: b.godown, batch: lot, from: uid(b.db, d.id, 0) },
      { item: p, qty: 2, amount: 28000, godown: b.godown2, serials: ['S1', 'S2'], from: uid(b.db, d.id, 1) }
    ])
    expect(inv.inventory.every((l) => l.movesStock === false)).toBe(true)
    const withInvoice = JSON.stringify(stockFigures(b.db, items, godowns))
    // Only the serial status moves on: delivered → sold.
    expect(withInvoice.replaceAll('"sold"', '"<out>"')).toBe(challanOnly)
    expect(withInvoice).toContain('"sold"')

    // Binning the invoice leaves stock unchanged (and the challan pending again).
    deleteVoucher(b.db, inv.id)
    expect(JSON.stringify(stockFigures(b.db, items, godowns)).replaceAll('"delivered"', '"<out>"')).toBe(challanOnly)
  })

  it('the invoice still counts its items where invoice items matter (item profitability sales value)', () => {
    const b = tradeBooks()
    const a = item(b.db, 'Widget', { opening: [10, 10000] })
    const d = dc(b, '2025-05-10', [{ item: a, qty: 4, amount: 4000 }])
    trade(b, 'sales', '2025-05-20', [{ item: a, qty: 4, amount: 6000, from: uid(b.db, d.id) }])
    const row = itemProfitability(b.db, '2025-04-01', AS_ON).find((r) => r.stockItemId === a)!
    expect(row.salesValue).toBe(6000)
    expect(stock.stockSummary(b.db, AS_ON).find((r) => r.stockItemId === a)!.closingQtyMilli).toBe(6000)
  })

  it('a non-moving invoice line never trips the negative-stock block', () => {
    const b = tradeBooks()
    const a = item(b.db, 'Widget', { opening: [5, 5000] })
    setFeatures(b.db, { ...getFeatures(b.db), preventNegativeStock: true })
    const d = dc(b, '2025-05-10', [{ item: a, qty: 5, amount: 5000 }])
    expect(() => trade(b, 'sales', '2025-05-11', [{ item: a, qty: 1, amount: 1000 }])).toThrow(/Insufficient stock/)
    const inv = trade(b, 'sales', '2025-05-12', [{ item: a, qty: 5, amount: 6000, from: uid(b.db, d.id) }])
    expect(inv.warnings.negativeStock).toEqual([])
  })

  it('a GRN and its bill move stock once (quantity)', () => {
    const b = tradeBooks()
    const a = item(b.db, 'Widget')
    const g = grn(b, '2025-05-01', [{ item: a, qty: 10, amount: 10000, godown: b.godown }])
    const before = stock.stockSummary(b.db, AS_ON).find((r) => r.stockItemId === a)!
    trade(b, 'purchase', '2025-05-03', [{ item: a, qty: 10, amount: 10000, godown: b.godown, from: uid(b.db, g.id) }])
    const after = stock.stockSummary(b.db, AS_ON).find((r) => r.stockItemId === a)!
    expect(after).toEqual(before)
    expect(stock.stockByGodown(b.db, AS_ON).filter((r) => r.stockItemId === a).map((r) => r.closingQtyMilli)).toEqual([10000])
  })
})
