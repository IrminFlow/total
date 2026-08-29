import { describe, it, expect } from 'vitest'
import { purchaseSuggestions, stockAgeing } from './reports'
import { seededDb } from '../db/testdb'
import { createLedger, createStockItem } from './masters'
import { saveVoucher } from './vouchers'
import type { DrCr } from '@shared/domain'

/**
 * What to buy, from whom, and roughly for how much.
 *
 * The stock summary already flags an item below its reorder level. What is tested here is the
 * part that turns a flag into an action: the shortfall, the last supplier, and a price that came
 * from a real purchase rather than a guess.
 */
function books() {
  const db = seededDb()
  const groupId = (name: string): number =>
    (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const vtId = (kind: string): number =>
    (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
  const unitId = (db.prepare('SELECT id FROM units LIMIT 1').get() as { id: number }).id
  const purchases = createLedger(db, { name: 'Purchases', groupId: groupId('Purchase Accounts') }).id

  const item = (name: string, reorderLevelMilli: number | null, openingQtyMilli = 0): number =>
    createStockItem(db, {
      name, unitId, openingQtyMilli, openingValue: 0, reorderLevelMilli
    } as Parameters<typeof createStockItem>[1]).id

  const supplier = (name: string): number => createLedger(db, { name, groupId: groupId('Sundry Creditors') }).id

  const buy = (
    party: number, date: string, stockItemId: number, qtyMilli: number, ratePaise: number
  ): void => {
    const amount = Math.round((qtyMilli * ratePaise) / 1000)
    const lines: { ledgerId: number; drCr: DrCr; amount: number }[] = [
      { ledgerId: purchases, drCr: 'dr', amount },
      { ledgerId: party, drCr: 'cr', amount }
    ]
    saveVoucher(db, {
      voucherTypeId: vtId('purchase'), date, partyLedgerId: party, posOverride: null,
      lines: lines.map((l) => ({ ...l, costAllocations: [] })),
      inventory: [{ stockItemId, godownId: null, batchId: null, qtyMilli, ratePaise, discountPaise: 0, amount, direction: 'in', isAbsolute: false }],
      billRefs: [], tds: null
    })
  }

  return { db, item, supplier, buy }
}

const ASON = '2026-12-31'

describe('purchaseSuggestions', () => {
  it('suggests nothing when nothing is below its level', () => {
    const b = books()
    b.item('Comfortable', 5000, 20000)
    expect(purchaseSuggestions(b.db, ASON)).toEqual([])
  })

  it('says how much to buy to reach the level', () => {
    const b = books()
    b.item('Short', 10000, 3000) // level 10, stock 3
    const [row] = purchaseSuggestions(b.db, ASON)
    expect(row!.name).toBe('Short')
    expect(row!.closingQtyMilli).toBe(3000)
    expect(row!.reorderLevelMilli).toBe(10000)
    expect(row!.shortfallQtyMilli).toBe(7000)
  })

  it('ignores an item with no reorder level, which nobody has an opinion about', () => {
    // Inventing a level would be inventing the opinion too.
    const b = books()
    b.item('Unopinionated', null, 0)
    expect(purchaseSuggestions(b.db, ASON)).toEqual([])
  })

  it('names the most recent supplier and the price they charged', () => {
    const b = books()
    const id = b.item('Widget', 10000, 1000)
    const old = b.supplier('Old Supplier')
    const recent = b.supplier('Recent Supplier')
    // Small quantities on purpose: the item has to stay below its reorder level, or there would
    // be no suggestion to inspect.
    b.buy(old, '2026-01-10', id, 1000, 20000) // Rs 200 per unit
    b.buy(recent, '2026-06-10', id, 1000, 25000) // Rs 250 per unit, more recently

    const [row] = purchaseSuggestions(b.db, ASON)
    expect(row!.lastSupplier).toBe('Recent Supplier')
    expect(row!.lastPurchaseDate).toBe('2026-06-10')
    expect(row!.lastRatePaise).toBe(25000)
  })

  it('estimates the cost at the last price, per whole unit', () => {
    const b = books()
    const id = b.item('Widget', 10000, 1000) // level 10 units, opening 1
    b.buy(b.supplier('S'), '2026-06-10', id, 1000, 25000) // +1 unit at Rs 250, so stock is 2
    const [row] = purchaseSuggestions(b.db, ASON)
    // Eight more at Rs 250 comes to Rs 2,000. The rate is per whole unit and the shortfall is in
    // thousandths, so the /1000 is unit conversion rather than a rounding choice.
    expect(row!.shortfallQtyMilli).toBe(8000)
    expect(row!.estimatedCost).toBe(200000)
  })

  it('shows no estimate at all for something never bought, rather than a guess', () => {
    const b = books()
    b.item('Never Bought', 10000, 0)
    const [row] = purchaseSuggestions(b.db, ASON)
    expect(row!.lastSupplier).toBeNull()
    expect(row!.lastRatePaise).toBeNull()
    expect(row!.estimatedCost).toBeNull()
  })

  it('agrees with the stock summary about what is below reorder', () => {
    // Built on stockAgeing rather than a parallel query, so the two can never differ about it.
    const b = books()
    b.item('Below', 10000, 1000)
    b.item('Above', 10000, 90000)
    b.item('No level', null, 0)

    const flagged = stockAgeing(b.db, ASON).filter((r) => r.belowReorder).map((r) => r.name)
    const suggested = purchaseSuggestions(b.db, ASON).map((r) => r.name)
    expect(suggested).toEqual(flagged)
  })

  it('reads stock as at the date asked for, not as of today', () => {
    const b = books()
    const id = b.item('Widget', 10000, 0)
    b.buy(b.supplier('S'), '2026-06-10', id, 20000, 10000)
    // Before that purchase the item was short; after it, it is not.
    expect(purchaseSuggestions(b.db, '2026-05-31').map((r) => r.name)).toEqual(['Widget'])
    expect(purchaseSuggestions(b.db, '2026-12-31')).toEqual([])
  })
})
