import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import type { DB } from '../db/connection'
import { createLedger, createStockItem } from './masters'
import { saveVoucher } from './vouchers'
import { costablePurchases, landedCostView, saveLandedCosts } from './inventoryLandedCost'
import { stockSummary } from './stockAnalysis'
import type { DrCr } from '@shared/domain'

/**
 * Landed cost allocation across a purchase (roadmap #117).
 *
 * The point of the feature is one number: closing stock. A charge that stays in an expense ledger
 * makes stock too low and margin too high, so every test here ends up asking what the valuation
 * engine now says the goods are worth.
 */
interface PurchaseItem {
  stockItemId: number
  qtyMilli: number
  ratePaise: number
}

function books() {
  const db: DB = seededDb()
  const groupId = (name: string): number =>
    (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const vtId = (kind: string): number =>
    (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
  const unitId = (db.prepare('SELECT id FROM units LIMIT 1').get() as { id: number }).id

  const purchases = createLedger(db, { name: 'Purchases', groupId: groupId('Purchase Accounts') }).id
  const freight = createLedger(db, { name: 'Freight Inward', groupId: groupId('Indirect Expenses') }).id
  const insurance = createLedger(db, { name: 'Insurance', groupId: groupId('Indirect Expenses') }).id
  const supplier = createLedger(db, { name: 'Acme', groupId: groupId('Sundry Creditors') }).id

  const item = (name: string): number =>
    createStockItem(db, {
      name, groupId: null, unitId, hsn: null, gstRate: null, cessRate: null,
      openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null,
      valuationMethod: 'weighted_avg'
    }).id

  /** A purchase of `items`, plus optional expense debits that are candidates for capitalising. */
  const buy = (date: string, items: PurchaseItem[], expenses: { ledgerId: number; amount: number }[] = []): number => {
    const inventory = items.map((i) => ({
      stockItemId: i.stockItemId, godownId: null, batchId: null, qtyMilli: i.qtyMilli,
      ratePaise: i.ratePaise, discountPaise: 0, amount: Math.round((i.qtyMilli * i.ratePaise) / 1000),
      direction: 'in' as const, isAbsolute: false
    }))
    const goods = inventory.reduce((s, l) => s + l.amount, 0)
    const extra = expenses.reduce((s, e) => s + e.amount, 0)
    const lines: { ledgerId: number; drCr: DrCr; amount: number; costAllocations: [] }[] = [
      // A purchase with no goods on it (services only) has no goods line to post.
      ...(goods > 0 ? [{ ledgerId: purchases, drCr: 'dr' as DrCr, amount: goods, costAllocations: [] as [] }] : []),
      ...expenses.map((e) => ({ ledgerId: e.ledgerId, drCr: 'dr' as DrCr, amount: e.amount, costAllocations: [] as [] })),
      { ledgerId: supplier, drCr: 'cr', amount: goods + extra, costAllocations: [] }
    ]
    return saveVoucher(db, {
      voucherTypeId: vtId('purchase'), date, partyLedgerId: supplier, posOverride: null, lines,
      inventory, billRefs: [], tds: null
    }).id
  }

  return { db, item, buy, freight, insurance, supplier, purchases, vtId }
}

const ASON = '2026-12-31'
const closingValue = (db: DB, stockItemId: number): number =>
  stockSummary(db, ASON).find((r) => r.stockItemId === stockItemId)!.closingValue

describe('landed costs', () => {
  it('carries freight into the value of the goods, to the paisa', () => {
    const b = books()
    const bolts = b.item('Bolts')
    const v = b.buy('2026-04-01', [{ stockItemId: bolts, qtyMilli: 10_000, ratePaise: 10_000 }], [
      { ledgerId: b.freight, amount: 5_000 }
    ])
    expect(closingValue(b.db, bolts)).toBe(100_000)

    saveLandedCosts(b.db, v, [{ ledgerId: b.freight, label: 'Freight', amount: 5_000, basis: 'qty' }])
    expect(closingValue(b.db, bolts)).toBe(105_000)
  })

  it('splits by quantity or by value, and the two give different answers', () => {
    const b = books()
    // A light expensive item and a heavy cheap one: the whole reason there are two bases.
    const gold = b.item('Gold trim')
    const sand = b.item('Sand')
    const v = b.buy(
      '2026-04-01',
      [
        { stockItemId: gold, qtyMilli: 1_000, ratePaise: 900_00 },
        { stockItemId: sand, qtyMilli: 9_000, ratePaise: 100_0 }
      ],
      [{ ledgerId: b.freight, amount: 10_000 }]
    )

    saveLandedCosts(b.db, v, [{ ledgerId: b.freight, label: 'Freight', amount: 10_000, basis: 'qty' }])
    const byQty = landedCostView(b.db, v).lines.map((l) => l.extra)
    expect(byQty).toEqual([1_000, 9_000])

    saveLandedCosts(b.db, v, [{ ledgerId: b.freight, label: 'Freight', amount: 10_000, basis: 'value' }])
    const byValue = landedCostView(b.db, v).lines.map((l) => l.extra)
    expect(byValue).toEqual([9_091, 909])
    expect(byValue.reduce((s, x) => s + x, 0)).toBe(10_000)
  })

  it('conserves a cost that does not divide, and restates the effective rate', () => {
    const b = books()
    const a = b.item('A')
    const c = b.item('C')
    const d = b.item('D')
    const v = b.buy(
      '2026-04-01',
      [
        { stockItemId: a, qtyMilli: 1_000, ratePaise: 100 },
        { stockItemId: c, qtyMilli: 1_000, ratePaise: 100 },
        { stockItemId: d, qtyMilli: 1_000, ratePaise: 100 }
      ],
      [{ ledgerId: b.freight, amount: 100 }]
    )
    saveLandedCosts(b.db, v, [{ ledgerId: b.freight, label: 'Freight', amount: 100, basis: 'value' }])
    const view = landedCostView(b.db, v)
    expect(view.lines.map((l) => l.extra)).toEqual([34, 33, 33])
    expect(view.lines[0]).toMatchObject({ amount: 100, effectiveAmount: 134, effectiveRatePaise: 134 })
    expect(view.total).toBe(100)
  })

  it('refuses money that is not on the voucher', () => {
    const b = books()
    const bolts = b.item('Bolts')
    const v = b.buy('2026-04-01', [{ stockItemId: bolts, qtyMilli: 10_000, ratePaise: 10_000 }])
    expect(() =>
      saveLandedCosts(b.db, v, [{ ledgerId: b.freight, label: 'Freight', amount: 5_000, basis: 'qty' }])
    ).toThrow(/not debited on this purchase/)
  })

  it('refuses to capitalise more than the voucher debited to that ledger', () => {
    const b = books()
    const bolts = b.item('Bolts')
    const v = b.buy('2026-04-01', [{ stockItemId: bolts, qtyMilli: 10_000, ratePaise: 10_000 }], [
      { ledgerId: b.freight, amount: 5_000 }
    ])
    expect(() =>
      saveLandedCosts(b.db, v, [{ ledgerId: b.freight, label: 'Freight', amount: 5_001, basis: 'qty' }])
    ).toThrow(/only what the voucher debits/)
    // Two lines that individually fit but together do not are caught the same way.
    expect(() =>
      saveLandedCosts(b.db, v, [
        { ledgerId: b.freight, label: 'Freight', amount: 3_000, basis: 'qty' },
        { ledgerId: b.freight, label: 'Freight (2)', amount: 3_000, basis: 'value' }
      ])
    ).toThrow(/only what the voucher debits/)
    expect(closingValue(b.db, bolts)).toBe(100_000)
  })

  it('replaces the set on save rather than doubling it', () => {
    const b = books()
    const bolts = b.item('Bolts')
    const v = b.buy('2026-04-01', [{ stockItemId: bolts, qtyMilli: 10_000, ratePaise: 10_000 }], [
      { ledgerId: b.freight, amount: 5_000 }
    ])
    const cost = { ledgerId: b.freight, label: 'Freight', amount: 5_000, basis: 'qty' as const }
    saveLandedCosts(b.db, v, [cost])
    saveLandedCosts(b.db, v, [cost])
    expect(landedCostView(b.db, v).costs).toHaveLength(1)
    expect(closingValue(b.db, bolts)).toBe(105_000)
  })

  it('removes the loading when the costs are cleared', () => {
    const b = books()
    const bolts = b.item('Bolts')
    const v = b.buy('2026-04-01', [{ stockItemId: bolts, qtyMilli: 10_000, ratePaise: 10_000 }], [
      { ledgerId: b.freight, amount: 5_000 }
    ])
    saveLandedCosts(b.db, v, [{ ledgerId: b.freight, label: 'Freight', amount: 5_000, basis: 'qty' }])
    saveLandedCosts(b.db, v, [])
    expect(closingValue(b.db, bolts)).toBe(100_000)
  })

  it('keeps the item line showing what the supplier billed', () => {
    const b = books()
    const bolts = b.item('Bolts')
    const v = b.buy('2026-04-01', [{ stockItemId: bolts, qtyMilli: 10_000, ratePaise: 10_000 }], [
      { ledgerId: b.freight, amount: 5_000 }
    ])
    saveLandedCosts(b.db, v, [{ ledgerId: b.freight, label: 'Freight', amount: 5_000, basis: 'qty' }])
    const line = b.db.prepare('SELECT amount, rate_paise AS ratePaise FROM inventory_lines WHERE voucher_id = ?').get(v) as
      { amount: number; ratePaise: number }
    // The purchase register, the GST return and the party ledger all still have to agree with
    // the supplier's bill; only the valuation sees the loaded cost.
    expect(line).toEqual({ amount: 100_000, ratePaise: 10_000 })
  })

  it('refuses a voucher that is not a purchase, and one with no goods on it', () => {
    const b = books()
    const journal = saveVoucher(b.db, {
      voucherTypeId: b.vtId('journal'), date: '2026-04-01', partyLedgerId: null, posOverride: null,
      lines: [
        { ledgerId: b.freight, drCr: 'dr', amount: 1000, costAllocations: [] },
        { ledgerId: b.supplier, drCr: 'cr', amount: 1000, costAllocations: [] }
      ],
      inventory: [], billRefs: [], tds: null
    }).id
    expect(() => landedCostView(b.db, journal)).toThrow(/only be added to a purchase/)

    const serviceOnly = b.buy('2026-04-01', [], [{ ledgerId: b.freight, amount: 1_000 }])
    expect(() =>
      saveLandedCosts(b.db, serviceOnly, [{ ledgerId: b.freight, label: 'Freight', amount: 1, basis: 'qty' }])
    ).toThrow(/no item lines/)
  })

  it('stops loading the cost once the purchase is in the bin', () => {
    const b = books()
    const bolts = b.item('Bolts')
    const v = b.buy('2026-04-01', [{ stockItemId: bolts, qtyMilli: 10_000, ratePaise: 10_000 }], [
      { ledgerId: b.freight, amount: 5_000 }
    ])
    saveLandedCosts(b.db, v, [{ ledgerId: b.freight, label: 'Freight', amount: 5_000, basis: 'qty' }])
    b.db.prepare("UPDATE vouchers SET deleted_at = datetime('now') WHERE id = ?").run(v)
    expect(closingValue(b.db, bolts)).toBe(0)
  })

  it('offers recent purchases to allocate against, saying what is already loaded', () => {
    const b = books()
    const bolts = b.item('Bolts')
    const v = b.buy('2026-04-01', [{ stockItemId: bolts, qtyMilli: 10_000, ratePaise: 10_000 }], [
      { ledgerId: b.freight, amount: 5_000 }
    ])
    saveLandedCosts(b.db, v, [{ ledgerId: b.freight, label: 'Freight', amount: 4_000, basis: 'qty' }])
    const rows = costablePurchases(b.db, '2026-04-01', ASON)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ voucherId: v, goodsValue: 100_000, landed: 4_000, items: 1, partyName: 'Acme' })
  })

  it('lists the voucher debits a cost may be picked from, with what is already taken', () => {
    const b = books()
    const bolts = b.item('Bolts')
    const v = b.buy('2026-04-01', [{ stockItemId: bolts, qtyMilli: 10_000, ratePaise: 10_000 }], [
      { ledgerId: b.freight, amount: 5_000 },
      { ledgerId: b.insurance, amount: 2_000 }
    ])
    saveLandedCosts(b.db, v, [{ ledgerId: b.freight, label: 'Freight', amount: 5_000, basis: 'qty' }])
    const candidates = landedCostView(b.db, v).candidates
    expect(candidates.map((c) => [c.ledgerName, c.amount, c.allocated])).toEqual([
      ['Freight Inward', 5_000, 5_000],
      ['Insurance', 2_000, 0],
      ['Purchases', 100_000, 0]
    ])
  })
})
