import type { DB } from '../db/connection'
import type { PriceLevel, PriceListRate } from '@shared/domain'
import type { PriceLevelInput, PriceRateInput } from '@shared/schemas'
import { writeAudit } from './audit'

/**
 * Price levels (task 75): named price lists (Retail / Wholesale / ...) with date-effective
 * per-item rates. A party ledger points at a level via ledgers.price_level_id; voucher entry
 * asks rateFor(party's level, item, voucher date) first and falls back to the item's usual
 * rate when there's no applicable row.
 */

export function listPriceLevels(db: DB): PriceLevel[] {
  return db.prepare('SELECT id, name FROM price_levels ORDER BY name').all() as PriceLevel[]
}

export function savePriceLevel(db: DB, input: PriceLevelInput, id?: number): PriceLevel {
  if (id) {
    const existing = db.prepare('SELECT id, name FROM price_levels WHERE id = ?').get(id) as PriceLevel | undefined
    if (!existing) throw new Error('Price level not found')
    db.prepare('UPDATE price_levels SET name = ? WHERE id = ?').run(input.name, id)
    const updated = db.prepare('SELECT id, name FROM price_levels WHERE id = ?').get(id) as PriceLevel
    writeAudit(db, 'priceLevel', id, 'update', existing, updated)
    return updated
  }
  const res = db.prepare('INSERT INTO price_levels (name) VALUES (?)').run(input.name)
  const created = db.prepare('SELECT id, name FROM price_levels WHERE id = ?').get(res.lastInsertRowid) as PriceLevel
  writeAudit(db, 'priceLevel', created.id, 'create', null, created)
  return created
}

export function deletePriceLevel(db: DB, id: number): void {
  const existing = db.prepare('SELECT id, name FROM price_levels WHERE id = ?').get(id) as PriceLevel | undefined
  if (!existing) throw new Error('Price level not found')
  const used = db.prepare('SELECT COUNT(*) AS n FROM ledgers WHERE price_level_id = ?').get(id) as { n: number }
  if (used.n > 0) throw new Error('Price level is assigned to ledgers; unassign it first')
  // price_list_rates cascade via FK.
  db.prepare('DELETE FROM price_levels WHERE id = ?').run(id)
  writeAudit(db, 'priceLevel', id, 'delete', existing, null)
}

export interface PriceRateRow extends PriceListRate {
  itemName: string
  unitSymbol: string
}

export function listRates(db: DB, priceLevelId: number): PriceRateRow[] {
  return db
    .prepare(
      `SELECT r.id, r.price_level_id AS priceLevelId, r.stock_item_id AS stockItemId, r.rate,
              r.effective_from AS effectiveFrom, si.name AS itemName, u.symbol AS unitSymbol
       FROM price_list_rates r
       JOIN stock_items si ON si.id = r.stock_item_id
       JOIN units u ON u.id = si.unit_id
       WHERE r.price_level_id = ?
       ORDER BY si.name, r.effective_from DESC`
    )
    .all(priceLevelId) as PriceRateRow[]
}

/** Upsert one (level, item, effective_from) rate. */
export function saveRate(db: DB, input: PriceRateInput): PriceListRate {
  db.prepare(
    `INSERT INTO price_list_rates (price_level_id, stock_item_id, rate, effective_from)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (price_level_id, stock_item_id, effective_from) DO UPDATE SET rate = excluded.rate`
  ).run(input.priceLevelId, input.stockItemId, input.rate, input.effectiveFrom)
  const row = db
    .prepare(
      `SELECT id, price_level_id AS priceLevelId, stock_item_id AS stockItemId, rate, effective_from AS effectiveFrom
       FROM price_list_rates WHERE price_level_id = ? AND stock_item_id = ? AND effective_from = ?`
    )
    .get(input.priceLevelId, input.stockItemId, input.effectiveFrom) as PriceListRate
  writeAudit(db, 'priceRate', row.id, 'update', null, row)
  return row
}

export function deleteRate(db: DB, id: number): void {
  const existing = db
    .prepare(
      `SELECT id, price_level_id AS priceLevelId, stock_item_id AS stockItemId, rate, effective_from AS effectiveFrom
       FROM price_list_rates WHERE id = ?`
    )
    .get(id) as PriceListRate | undefined
  if (!existing) throw new Error('Rate not found')
  db.prepare('DELETE FROM price_list_rates WHERE id = ?').run(id)
  writeAudit(db, 'priceRate', id, 'delete', existing, null)
}

/** The rate (paise per unit) in force for an item under a level on `date`: the row with the
 *  latest effective_from ≤ date, or null when none applies. */
export function rateFor(db: DB, priceLevelId: number, stockItemId: number, date: string): number | null {
  const row = db
    .prepare(
      `SELECT rate FROM price_list_rates
       WHERE price_level_id = ? AND stock_item_id = ? AND effective_from <= ?
       ORDER BY effective_from DESC LIMIT 1`
    )
    .get(priceLevelId, stockItemId, date) as { rate: number } | undefined
  return row ? row.rate : null
}
