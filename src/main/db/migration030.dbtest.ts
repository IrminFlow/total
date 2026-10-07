// Migration 030 (WP 2.6): price lists grow end dates / quantity slabs / slab discounts / currency
// (table rebuild — existing rows keep their ids as open-ended ₹ base slabs), levels grow the
// inclusive and default flags, items grow MRP and standard cost, and the party-rate, scheme and
// counter-sale tables arrive.
import { describe, it, expect } from 'vitest'
import { migrate } from './migrate'
import { MIGRATIONS } from './migrations'
import { freshPartialDb, TEST_INFO } from './testdb'
import { seedCompany } from './seed'

const M030 = MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE price_list_rates_030'))

const cols = (db: ReturnType<typeof freshPartialDb>, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

describe('migration 030 — pricing', () => {
  it('is migration 030', () => {
    expect(M030 + 1).toBe(30)
  })

  it('keeps every price-list row (ids, rates, dates) as an open-ended ₹ base slab', () => {
    const db = freshPartialDb(M030)
    seedCompany(db, TEST_INFO)
    const unit = (db.prepare('SELECT id FROM units LIMIT 1').get() as { id: number }).id
    const item = Number(db.prepare("INSERT INTO stock_items (name, unit_id) VALUES ('Pen', ?)").run(unit).lastInsertRowid)
    const level = Number(db.prepare("INSERT INTO price_levels (name) VALUES ('Retail')").run().lastInsertRowid)
    const r1 = Number(db.prepare("INSERT INTO price_list_rates (price_level_id, stock_item_id, rate, effective_from) VALUES (?, ?, 1000, '2025-04-01')").run(level, item).lastInsertRowid)
    const r2 = Number(db.prepare("INSERT INTO price_list_rates (price_level_id, stock_item_id, rate, effective_from) VALUES (?, ?, 1200, '2025-10-01')").run(level, item).lastInsertRowid)
    db.prepare("INSERT INTO ledgers (name, group_id, price_level_id) VALUES ('Party', 1, ?)").run(level)

    migrate(db)

    expect(db.prepare('SELECT id, rate, effective_from, effective_to, min_qty_milli, discount_bp, currency FROM price_list_rates ORDER BY id').all()).toEqual([
      { id: r1, rate: 1000, effective_from: '2025-04-01', effective_to: null, min_qty_milli: 0, discount_bp: 0, currency: 'INR' },
      { id: r2, rate: 1200, effective_from: '2025-10-01', effective_to: null, min_qty_milli: 0, discount_bp: 0, currency: 'INR' }
    ])
    expect(db.prepare('SELECT inclusive_of_tax, is_default FROM price_levels').get()).toEqual({ inclusive_of_tax: 0, is_default: 0 })
    // A quantity slab on the same date is now a distinct row; the old key still upserts.
    db.prepare("INSERT INTO price_list_rates (price_level_id, stock_item_id, rate, effective_from, min_qty_milli) VALUES (?, ?, 900, '2025-10-01', 10000)").run(level, item)
    expect(() => db.prepare("INSERT INTO price_list_rates (price_level_id, stock_item_id, rate, effective_from) VALUES (?, ?, 1, '2025-10-01')").run(level, item)).toThrow(/UNIQUE/)
    expect(() => db.prepare("INSERT INTO price_list_rates (price_level_id, stock_item_id, rate, effective_from, effective_to) VALUES (?, ?, 1, '2025-11-01', '2025-10-31')").run(level, item)).toThrow(/CHECK/)
    // Cascade from the level still holds after the rebuild.
    db.prepare('UPDATE ledgers SET price_level_id = NULL').run()
    db.prepare('DELETE FROM price_levels WHERE id = ?').run(level)
    expect((db.prepare('SELECT COUNT(*) AS n FROM price_list_rates').get() as { n: number }).n).toBe(0)
  })

  it('adds the item, party-rate, scheme and counter columns / tables with their constraints', () => {
    const db = freshPartialDb(M030)
    seedCompany(db, TEST_INFO)
    migrate(db)
    expect(cols(db, 'stock_items')).toEqual(expect.arrayContaining(['mrp_paise', 'standard_cost_paise']))
    expect(cols(db, 'party_item_rates')).toEqual(expect.arrayContaining(['ledger_id', 'stock_item_id', 'rate_paise', 'discount_bp', 'effective_from', 'effective_to', 'last_sold_at', 'source']))
    expect(cols(db, 'discount_schemes')).toEqual(expect.arrayContaining(['name', 'kind', 'applies_to', 'target_id', 'from_date', 'to_date', 'priority', 'active']))
    expect(cols(db, 'discount_scheme_slabs')).toEqual(expect.arrayContaining(['scheme_id', 'min_qty_milli', 'min_value_paise', 'discount_bp', 'free_qty_milli']))
    expect(cols(db, 'counter_sales')).toEqual(expect.arrayContaining(['invoice_voucher_id', 'receipt_voucher_id', 'tendered_paise', 'change_paise']))
    // One default level.
    db.prepare("INSERT INTO price_levels (name, is_default) VALUES ('A', 1)").run()
    expect(() => db.prepare("INSERT INTO price_levels (name, is_default) VALUES ('B', 1)").run()).toThrow(/UNIQUE/)
    // A scheme for everything has no target; a slab is qty- or value-based, discount or free goods.
    expect(() => db.prepare("INSERT INTO discount_schemes (name, kind, applies_to, target_id) VALUES ('x', 'flat', 'all', 3)").run()).toThrow(/CHECK/)
    const s = Number(db.prepare("INSERT INTO discount_schemes (name, kind, applies_to) VALUES ('Diwali', 'flat', 'all')").run().lastInsertRowid)
    expect(() => db.prepare('INSERT INTO discount_scheme_slabs (scheme_id, min_qty_milli, min_value_paise, discount_bp) VALUES (?, 0, 0, 100)').run(s)).toThrow(/CHECK/)
    expect(() => db.prepare('INSERT INTO discount_scheme_slabs (scheme_id, min_qty_milli, discount_bp, free_qty_milli) VALUES (?, 0, 100, 1000)').run(s)).toThrow(/CHECK/)
    db.prepare('INSERT INTO discount_scheme_slabs (scheme_id, min_qty_milli, discount_bp) VALUES (?, 0, 1000)').run(s)
    db.prepare('DELETE FROM discount_schemes WHERE id = ?').run(s)
    expect((db.prepare('SELECT COUNT(*) AS n FROM discount_scheme_slabs').get() as { n: number }).n).toBe(0)
  })
})
