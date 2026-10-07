import type { DB } from '../db/connection'
import type { PriceLevel, PriceListRate } from '@shared/domain'
import { priceRateInputSchema, type PriceLevelInput, type PriceRateInput } from '@shared/schemas'
import type { BulkRateUpdate } from '@shared/pricingSchemas'
import { parseCsv, rowsToCsv } from '@shared/csv'
import { formatQtyMilli, plainRupees, parseRupees } from '@shared/money'
import type { RateGridCell, RateGridRow, RatesImportResult } from '@shared/pricingTypes'
import { writeAudit } from './audit'

export type { RateGridCell, RateGridRow, RatesImportResult }

/**
 * Price levels (task 75, extended by WP 2.6 / migration 030): named price lists (Retail /
 * Wholesale / ...) with date-effective per-item rates. A row also carries an end date, a
 * quantity slab (min_qty_milli: the row applies from that quantity up), the slab's discount and
 * a currency. A level may be GST-inclusive and one level may be the company default. A party
 * ledger points at a level via ledgers.price_level_id. The resolver (src/shared/pricing.ts,
 * loaded by services/pricing.ts) decides which row a line gets; rateFor() below is the simple
 * "base ₹ rate on a date" lookup labels and the manufacture prefill use.
 */

interface LevelRow { id: number; name: string; inclusive_of_tax: number; is_default: number; n?: number }
const mapLevel = (r: LevelRow): PriceLevel => ({
  id: r.id, name: r.name, inclusiveOfTax: !!r.inclusive_of_tax, isDefault: !!r.is_default, ...(r.n != null ? { rateCount: r.n } : {})
})

export function listPriceLevels(db: DB): PriceLevel[] {
  return (
    db.prepare(
      `SELECT l.id, l.name, l.inclusive_of_tax, l.is_default, (SELECT COUNT(*) FROM price_list_rates r WHERE r.price_level_id = l.id) AS n
       FROM price_levels l ORDER BY l.name`
    ).all() as LevelRow[]
  ).map(mapLevel)
}

function getLevel(db: DB, id: number): PriceLevel | undefined {
  const r = db.prepare('SELECT id, name, inclusive_of_tax, is_default FROM price_levels WHERE id = ?').get(id) as LevelRow | undefined
  return r ? mapLevel(r) : undefined
}

export function defaultPriceLevel(db: DB): PriceLevel | null {
  const r = db.prepare('SELECT id, name, inclusive_of_tax, is_default FROM price_levels WHERE is_default = 1').get() as LevelRow | undefined
  return r ? mapLevel(r) : null
}

export function savePriceLevel(db: DB, input: PriceLevelInput, id?: number): PriceLevel {
  return db.transaction(() => {
    const existing = id ? getLevel(db, id) : undefined
    if (id && !existing) throw new Error('Price level not found')
    const inclusive = input.inclusiveOfTax ?? existing?.inclusiveOfTax ?? false
    const isDefault = input.isDefault ?? existing?.isDefault ?? false
    if (isDefault) db.prepare('UPDATE price_levels SET is_default = 0 WHERE is_default = 1 AND id IS NOT ?').run(id ?? null)
    let levelId = id
    if (id) {
      db.prepare('UPDATE price_levels SET name = ?, inclusive_of_tax = ?, is_default = ? WHERE id = ?').run(input.name, inclusive ? 1 : 0, isDefault ? 1 : 0, id)
    } else {
      levelId = Number(db.prepare('INSERT INTO price_levels (name, inclusive_of_tax, is_default) VALUES (?, ?, ?)').run(input.name, inclusive ? 1 : 0, isDefault ? 1 : 0).lastInsertRowid)
    }
    const saved = getLevel(db, levelId!)!
    writeAudit(db, 'priceLevel', saved.id, id ? 'update' : 'create', existing ?? null, saved)
    return saved
  })()
}

export function deletePriceLevel(db: DB, id: number): void {
  const existing = getLevel(db, id)
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

const RATE_COLS = `r.id, r.price_level_id AS priceLevelId, r.stock_item_id AS stockItemId, r.rate,
  r.effective_from AS effectiveFrom, r.effective_to AS effectiveTo, r.min_qty_milli AS minQtyMilli,
  r.discount_bp AS discountBp, r.currency`

export function listRates(db: DB, priceLevelId: number): PriceRateRow[] {
  return db
    .prepare(
      `SELECT ${RATE_COLS}, si.name AS itemName, u.symbol AS unitSymbol
       FROM price_list_rates r
       JOIN stock_items si ON si.id = r.stock_item_id
       JOIN units u ON u.id = si.unit_id
       WHERE r.price_level_id = ?
       ORDER BY si.name, r.currency, r.min_qty_milli, r.effective_from DESC`
    )
    .all(priceLevelId) as PriceRateRow[]
}

function getRate(db: DB, id: number): PriceListRate | undefined {
  return db.prepare(`SELECT ${RATE_COLS} FROM price_list_rates r WHERE r.id = ?`).get(id) as PriceListRate | undefined
}

/** Upsert one (level, item, currency, slab, effective_from) rate; with `id`, edit that row. */
export function saveRate(db: DB, raw: PriceRateInput, id?: number): PriceListRate {
  const input = priceRateInputSchema.parse(raw)
  if (!getLevel(db, input.priceLevelId)) throw new Error('Price level not found')
  return db.transaction(() => {
    const before = id ? getRate(db, id) : undefined
    if (id && !before) throw new Error('Rate not found')
    let rowId: number
    if (id) {
      db.prepare(
        `UPDATE price_list_rates SET price_level_id = ?, stock_item_id = ?, rate = ?, effective_from = ?, effective_to = ?,
           min_qty_milli = ?, discount_bp = ?, currency = ? WHERE id = ?`
      ).run(input.priceLevelId, input.stockItemId, input.rate, input.effectiveFrom, input.effectiveTo, input.minQtyMilli, input.discountBp, input.currency, id)
      rowId = id
    } else {
      db.prepare(
        `INSERT INTO price_list_rates (price_level_id, stock_item_id, rate, effective_from, effective_to, min_qty_milli, discount_bp, currency)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (price_level_id, stock_item_id, currency, min_qty_milli, effective_from)
         DO UPDATE SET rate = excluded.rate, effective_to = excluded.effective_to, discount_bp = excluded.discount_bp`
      ).run(input.priceLevelId, input.stockItemId, input.rate, input.effectiveFrom, input.effectiveTo, input.minQtyMilli, input.discountBp, input.currency)
      rowId = (
        db.prepare(
          `SELECT id FROM price_list_rates WHERE price_level_id = ? AND stock_item_id = ? AND currency = ? AND min_qty_milli = ? AND effective_from = ?`
        ).get(input.priceLevelId, input.stockItemId, input.currency, input.minQtyMilli, input.effectiveFrom) as { id: number }
      ).id
    }
    const row = getRate(db, rowId)!
    writeAudit(db, 'priceRate', row.id, before ? 'update' : 'create', before ?? null, row)
    return row
  })()
}

export function deleteRate(db: DB, id: number): void {
  const existing = getRate(db, id)
  if (!existing) throw new Error('Rate not found')
  db.prepare('DELETE FROM price_list_rates WHERE id = ?').run(id)
  writeAudit(db, 'priceRate', id, 'delete', existing, null)
}

/** The base ₹ rate (paise per unit) in force for an item under a level on `date`: the open
 *  (min-quantity 0) row with the latest effective_from ≤ date whose end date hasn't passed, or
 *  null when none applies. Labels and the manufacture prefill use this; invoices use the full
 *  resolver (services/pricing.ts). */
export function rateFor(db: DB, priceLevelId: number, stockItemId: number, date: string): number | null {
  const row = db
    .prepare(
      `SELECT rate FROM price_list_rates
       WHERE price_level_id = ? AND stock_item_id = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
         AND min_qty_milli = 0 AND currency = 'INR'
       ORDER BY effective_from DESC LIMIT 1`
    )
    .get(priceLevelId, stockItemId, date, date) as { rate: number } | undefined
  return row ? row.rate : null
}

// ---------------------------------------------------------------- the items × levels grid



export function rateGrid(db: DB, date: string): { levels: PriceLevel[]; rows: RateGridRow[] } {
  const levels = listPriceLevels(db)
  const items = db
    .prepare(
      `SELECT si.id, si.name, si.barcode, si.gst_rate, si.mrp_paise, si.standard_cost_paise, si.group_id, u.symbol
       FROM stock_items si JOIN units u ON u.id = si.unit_id ORDER BY si.name`
    )
    .all() as { id: number; name: string; barcode: string | null; gst_rate: number | null; mrp_paise: number | null; standard_cost_paise: number | null; group_id: number | null; symbol: string }[]
  const base = db.prepare(
    `SELECT id, rate, effective_from, effective_to FROM price_list_rates
     WHERE price_level_id = ? AND stock_item_id = ? AND currency = 'INR' AND min_qty_milli = 0
       AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
     ORDER BY effective_from DESC LIMIT 1`
  )
  const slabCount = db.prepare(
    `SELECT COUNT(*) AS n FROM price_list_rates WHERE price_level_id = ? AND stock_item_id = ? AND min_qty_milli > 0
       AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)`
  )
  const rows = items.map((it) => {
    const rates: Record<number, RateGridCell | null> = {}
    for (const l of levels) {
      const r = base.get(l.id, it.id, date, date) as { id: number; rate: number; effective_from: string; effective_to: string | null } | undefined
      const n = (slabCount.get(l.id, it.id, date, date) as { n: number }).n
      rates[l.id] = r ? { rateId: r.id, rate: r.rate, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, slabs: n } : null
    }
    return {
      itemId: it.id, itemName: it.name, barcode: it.barcode, unitSymbol: it.symbol, gstRate: it.gst_rate, mrpPaise: it.mrp_paise,
      standardCostPaise: it.standard_cost_paise, groupId: it.group_id, rates
    }
  })
  return { levels, rows }
}

/** Inline grid edit: re-price the base row in force on `date` (in place), or add one from `date`.
 *  null clears the cell — deletes the base row in force. */
export function setGridRate(db: DB, priceLevelId: number, stockItemId: number, date: string, rate: number | null): PriceListRate | null {
  const current = db
    .prepare(
      `SELECT id FROM price_list_rates WHERE price_level_id = ? AND stock_item_id = ? AND currency = 'INR' AND min_qty_milli = 0
         AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?) ORDER BY effective_from DESC LIMIT 1`
    )
    .get(priceLevelId, stockItemId, date, date) as { id: number } | undefined
  if (rate == null) {
    if (current) deleteRate(db, current.id)
    return null
  }
  if (current) {
    const row = getRate(db, current.id)!
    return saveRate(db, { ...row, effectiveTo: row.effectiveTo ?? null, rate }, current.id)
  }
  return saveRate(db, { priceLevelId, stockItemId, rate, effectiveFrom: date })
}

const roundTo = (paise: number, step: number): number => Math.max(0, Math.round(paise / step) * step)
const dayBefore = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/** Bulk % change on a level's rows (all, or the listed items). With effectiveFrom, the rows in
 *  force on that date get a new row from the date (the old closes the day before) — the price
 *  history stays; without it, every row of the level is re-priced in place. */
export function bulkUpdateRates(db: DB, req: BulkRateUpdate): { updated: number } {
  if (!getLevel(db, req.priceLevelId)) throw new Error('Price level not found')
  const only = req.stockItemIds ? new Set(req.stockItemIds) : null
  const apply = (rate: number): number => roundTo(Math.round((rate * (10000 + req.changeBp)) / 10000), req.roundToPaise)
  return db.transaction(() => {
    let rows = listRates(db, req.priceLevelId).filter((r) => !only || only.has(r.stockItemId))
    let updated = 0
    if (req.effectiveFrom) {
      const on = req.effectiveFrom
      rows = rows.filter((r) => r.effectiveFrom <= on && (r.effectiveTo == null || r.effectiveTo >= on))
      for (const r of rows) {
        if (r.effectiveFrom === on) {
          saveRate(db, { ...r, effectiveTo: r.effectiveTo ?? null, rate: apply(r.rate) }, r.id)
        } else {
          saveRate(db, { ...r, effectiveTo: dayBefore(on) }, r.id)
          saveRate(db, { ...r, id: undefined, rate: apply(r.rate), effectiveFrom: on, effectiveTo: r.effectiveTo ?? null } as PriceRateInput)
        }
        updated++
      }
    } else {
      for (const r of rows) {
        saveRate(db, { ...r, effectiveTo: r.effectiveTo ?? null, rate: apply(r.rate) }, r.id)
        updated++
      }
    }
    return { updated }
  })()
}

/** Copy a level's rows into a new level (optionally ± a percentage). */
export function copyLevel(db: DB, req: { fromLevelId: number; name: string; changeBp?: number; inclusiveOfTax?: boolean }): PriceLevel {
  const from = getLevel(db, req.fromLevelId)
  if (!from) throw new Error('Price level not found')
  return db.transaction(() => {
    const level = savePriceLevel(db, { name: req.name, inclusiveOfTax: req.inclusiveOfTax ?? from.inclusiveOfTax })
    const change = req.changeBp ?? 0
    for (const r of listRates(db, from.id)) {
      saveRate(db, {
        priceLevelId: level.id, stockItemId: r.stockItemId, rate: Math.max(0, Math.round((r.rate * (10000 + change)) / 10000)),
        effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo ?? null, minQtyMilli: r.minQtyMilli ?? 0, discountBp: r.discountBp ?? 0, currency: r.currency ?? 'INR'
      })
    }
    return listPriceLevels(db).find((l) => l.id === level.id)!
  })()
}

// ---------------------------------------------------------------- CSV (export:csv / import:pickCsv)

export const RATES_CSV_HEADER = ['Level', 'Item', 'Barcode', 'Rate', 'Effective from', 'Effective to', 'Min qty', 'Discount %', 'Currency']

/** Every price-list row as CSV (all levels, or one). Rates in rupees, quantities in units. */
export function exportRatesCsv(db: DB, priceLevelId?: number): string {
  const levels = listPriceLevels(db).filter((l) => priceLevelId == null || l.id === priceLevelId)
  const barcodes = new Map((db.prepare('SELECT id, barcode FROM stock_items').all() as { id: number; barcode: string | null }[]).map((r) => [r.id, r.barcode]))
  const out: string[][] = []
  for (const l of levels) {
    for (const r of listRates(db, l.id)) {
      out.push([
        l.name, r.itemName, barcodes.get(r.stockItemId) ?? '', plainRupees(r.rate), r.effectiveFrom, r.effectiveTo ?? '',
        formatQtyMilli(r.minQtyMilli ?? 0), String((r.discountBp ?? 0) / 100), r.currency ?? 'INR'
      ])
    }
  }
  return rowsToCsv(RATES_CSV_HEADER, out)
}


/** Import price-list rows from CSV (the export's columns; header names matched loosely). All or
 *  nothing: any bad row and nothing is written. Unknown levels are created; items are matched by
 *  barcode, then by name. Each row upserts its (level, item, currency, slab, from) key. */
export function importRatesCsv(db: DB, csvText: string, dryRun = false): RatesImportResult {
  const [head, ...body] = parseCsv(csvText.replace(/^\uFEFF/, ''))
  const header = (head?.cells ?? []).map((h) => h.trim().toLowerCase())
  // Cells our own export neutralised against spreadsheet formulas carry a leading quote.
  const clean = (v: string): string => v.trim().replace(/^'(?=[=+\-@])/, '')
  const records = body.map((r) => ({ line: r.line, rec: r.cells }))
  const key = (rec: string[], ...names: string[]): string => {
    for (const n of names) {
      const at = header.indexOf(n)
      if (at >= 0) return clean(rec[at] ?? '')
    }
    return ''
  }
  const levelsByName = new Map(listPriceLevels(db).map((l) => [l.name.toLowerCase(), l]))
  const items = db.prepare('SELECT id, name, barcode FROM stock_items').all() as { id: number; name: string; barcode: string | null }[]
  const byName = new Map(items.map((i) => [i.name.toLowerCase(), i.id]))
  const byBarcode = new Map(items.filter((i) => i.barcode).map((i) => [i.barcode!, i.id]))
  const errors: RatesImportResult['errors'] = []
  const newLevels = new Set<string>()
  const parsed: { level: string; input: PriceRateInput }[] = []
  records.forEach(({ line, rec }) => {
    const level = key(rec, 'level', 'price level')
    const itemName = key(rec, 'item', 'stock item')
    const barcode = key(rec, 'barcode')
    const itemId = (barcode && byBarcode.get(barcode)) || byName.get(itemName.toLowerCase())
    const rate = parseRupees(key(rec, 'rate'))
    const from = key(rec, 'effective from', 'from') || '2000-01-01'
    const to = key(rec, 'effective to', 'to') || null
    const minQtyText = key(rec, 'min qty', 'min quantity')
    const minQty = minQtyText ? Math.round(Number(minQtyText.replace(/,/g, '')) * 1000) : 0
    const discText = key(rec, 'discount %', 'discount')
    const disc = discText ? Math.round(Number(discText) * 100) : 0
    const currency = (key(rec, 'currency') || 'INR').toUpperCase()
    if (!level) return void errors.push({ line, message: 'Level is empty' })
    if (!itemId) return void errors.push({ line, message: `No stock item "${barcode || itemName}"` })
    if (rate == null || rate < 0) return void errors.push({ line, message: `Rate "${key(rec, 'rate')}" is not an amount` })
    if (!Number.isFinite(minQty) || minQty < 0) return void errors.push({ line, message: 'Min qty must be a number' })
    if (!Number.isFinite(disc) || disc < 0 || disc > 10000) return void errors.push({ line, message: 'Discount % must be 0–100' })
    const r = priceRateInputSchema.safeParse({ priceLevelId: 1, stockItemId: itemId, rate, effectiveFrom: from, effectiveTo: to, minQtyMilli: minQty, discountBp: disc, currency })
    if (!r.success) return void errors.push({ line, message: r.error.issues.map((x) => x.message).join('; ') })
    if (!levelsByName.has(level.toLowerCase())) newLevels.add(level)
    parsed.push({ level, input: r.data })
  })
  const result = { rows: parsed.length, newLevels: [...newLevels], errors, applied: false }
  if (dryRun || errors.length > 0) return result
  db.transaction(() => {
    for (const p of parsed) {
      let level = levelsByName.get(p.level.toLowerCase())
      if (!level) {
        level = savePriceLevel(db, { name: p.level })
        levelsByName.set(p.level.toLowerCase(), level)
      }
      saveRate(db, { ...p.input, priceLevelId: level.id })
    }
  })()
  return { ...result, applied: true }
}
