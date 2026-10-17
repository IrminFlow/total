// Stock and Made goods (WP 9.7, plan 2026-10-13 §2.2): the READ side of the simple Stock screens,
// plus "Change price". Writing the books goes through simple:post only (the `stock_count` and
// `make_goods` intents, services/simplePost.ts). Every figure comes from the service the
// accountant screen uses:
//
// - stockList: quantity and value = stockAnalysis.stockSummary as on the date (the accountant
//   Stock summary's own rows — the ONE valuation pass, never a second computation); the selling
//   price = resolvePrice for a walk-in bill on that date (pricing.pricingLoader — the only rate
//   resolver; a last-purchase fallback is not a selling price); "running low" = shared/simple/
//   stock.ts stockLevel (the reorder level, else out of stock);
// - stockProduct: one product — the same row, its recipe (the BOM version in force), and its
//   movements this year (stockAnalysis.stockMovements — the Stock movements screen's register)
//   in plain words;
// - madeGoodsSetup: the products that have a recipe in force on the date, with the Manufacture
//   screen's "average price" prefill (manufacture.suggestedSaleRate);
// - setSellingPrice: the product's row on the DEFAULT price level (the WP 8.4 quick-create path:
//   that level, else "Selling price"), from the date — the earlier price stays for earlier bills
//   (its row ends the day before); saved through priceLevels.saveRate (audited `priceRate`);
// - saveRecipe: "To make 1 X you use …" — a NEW BOM version through the accountant BOM service
//   (bom.saveBomVersion, audited `bom` exactly as the full editor's save), planned by the pure
//   shared/simple/stock.ts planRecipe (first recipe = always, a change = from the working date);
//   the optional labour per unit is kept per version in meta `simpleRecipeLabour` (the BOM tables
//   have no labour column — nothing posts from it; Made goods only prefills its labour answer).
import type { DB } from '../db/connection'
import { addDaysISO, fyOf } from '@shared/dates'
import { pickBomVersion } from '@shared/bom'
import { unitRate } from '@shared/manufacture'
import {
  historyWhat, needsReorder, planRecipe, stockLevel, type RecipeInput,
  type MadeGoodsSetup, type SavedCountView, type StockList, type StockProductView, type StockRecipe, type StockRow
} from '@shared/simple/stock'
import { countLineEffects, stockMovements, stockSummary, withStockPass } from './stockAnalysis'
import { IN_BOOKS, MOVES_STOCK } from './vouchers'
import { pricingLoader } from './pricing'
import { listBomVersions, saveBomVersion } from './bom'
import { writeAudit } from './audit'
import { suggestedSaleRate } from './manufacture'
import { defaultPriceLevel, saveRate } from './priceLevels'
import { sellingLevel } from './quickCreate'

interface ItemFacts { id: number; reorderLevelMilli: number | null; hsn: string | null; gstRate: number | null }

function itemFacts(db: DB): Map<number, ItemFacts> {
  const rows = db.prepare('SELECT id, reorder_level_milli AS reorderLevelMilli, hsn, gst_rate AS gstRate FROM stock_items').all() as ItemFacts[]
  return new Map(rows.map((r) => [r.id, r]))
}

/** The walk-in selling price per unit on `date` (resolvePrice), null when none is set. */
export function sellingPrices(db: DB, date: string): (itemId: number) => number | null {
  const price = pricingLoader(db)
  return (itemId) => {
    const p = price({ date, partyLedgerId: null, currency: 'INR', supply: 'intra' }, itemId, 1000)
    return p.ratePaise != null && p.ratePaise > 0 && p.source !== 'last_purchase' && p.source !== 'none' ? p.ratePaise : null
  }
}

export function stockList(db: DB, asOn: string): StockList {
  return db.transaction((): StockList => {
    const facts = itemFacts(db)
    const price = sellingPrices(db, asOn)
    const versions = listBomVersions(db)
    const rows: StockRow[] = stockSummary(db, asOn).map((s) => {
      const f = facts.get(s.stockItemId)
      const level = stockLevel(s, f?.reorderLevelMilli ?? null)
      const v = pickBomVersion(versions, s.stockItemId, asOn)
      return {
        itemId: s.stockItemId,
        name: s.name,
        unit: s.unitSymbol,
        qtyMilli: s.closingQtyMilli,
        value: s.closingValue,
        sellingPrice: price(s.stockItemId),
        reorderLevelMilli: f?.reorderLevelMilli ?? null,
        level,
        hasRecipe: !!v && v.lines.length > 0
      }
    })
    rows.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))
    return { asOn, rows, lowCount: rows.filter((r) => needsReorder(r.level)).length, negativeCount: rows.filter((r) => r.qtyMilli < 0).length }
  })()
}

/** Products running low or out as on `asOn` (Home's "Needs attention"). */
export const lowStockCount = (db: DB, asOn: string): number =>
  // WP 7.1: stockList's own count (same summary, same levels) without pricing every product.
  db.transaction((): number => {
    const facts = itemFacts(db)
    return stockSummary(db, asOn).filter((s) => needsReorder(stockLevel(s, facts.get(s.stockItemId)?.reorderLevelMilli ?? null))).length
  })()
/** WP 10.8: Home's two stock rows from ONE summary (one valuation pass): running low or out
 *  (= lowStockCount) and below zero — sold before their purchase was recorded (less than nothing
 *  in stock as on `asOn`, the same quantity the list shows). */
export const stockAttentionCounts = (db: DB, asOn: string): { low: number; negative: number } =>
  db.transaction(() => {
    const facts = itemFacts(db)
    const summary = stockSummary(db, asOn)
    return {
      low: summary.filter((s) => needsReorder(stockLevel(s, facts.get(s.stockItemId)?.reorderLevelMilli ?? null))).length,
      negative: summary.filter((s) => s.closingQtyMilli < 0).length
    }
  })()

const LABOUR_KEY = 'simpleRecipeLabour' // meta: { [bomVersionId]: paise per unit }

/** The simple recipe editor's labour per unit, by BOM version id. */
function recipeLabours(db: DB): Record<string, number> {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(LABOUR_KEY) as { value: string } | undefined
  if (!row) return {}
  try {
    const v = JSON.parse(row.value) as unknown
    return v && typeof v === 'object' ? (v as Record<string, number>) : {}
  } catch {
    return {}
  }
}

function recipeOf(db: DB, itemId: number, date: string, versions = listBomVersions(db), labours = recipeLabours(db)): StockRecipe | null {
  const v = pickBomVersion(versions, itemId, date)
  if (!v || v.lines.length === 0) return null
  const name = db.prepare('SELECT si.name, u.symbol FROM stock_items si JOIN units u ON u.id = si.unit_id WHERE si.id = ?')
  const labour = labours[String(v.id)]
  return {
    versionId: v.id,
    effectiveFrom: v.effectiveFrom,
    ...(typeof labour === 'number' && labour > 0 ? { labourPerUnit: labour } : {}),
    lines: v.lines.map((l) => {
      const c = name.get(l.componentId) as { name: string; symbol: string } | undefined
      return { itemId: l.componentId, name: c?.name ?? '', unit: c?.symbol ?? '', qtyMilliPerUnit: l.qtyMilliPerUnit, scrapPctBp: l.scrapPctBp }
    })
  }
}

export function stockProduct(db: DB, itemId: number, asOn: string): StockProductView | null {
  // PR #104: ONE valuation pass — the register's pass to `asOn` also answers the summary row.
  return db.transaction((): StockProductView | null => withStockPass(db, () => {
    const f = itemFacts(db).get(itemId)
    if (!f) return null
    const fy = fyOf(asOn)
    const reg = stockMovements(db, itemId, fy.from, asOn)
    const s = stockSummary(db, asOn).find((r) => r.stockItemId === itemId)
    if (!s) return null
    // Which stock journals are manufactures (made / used) and which move this product both ways
    // (a transfer between places) — any other stock journal is an adjustment, not "made".
    const ids = [...new Set(reg.rows.filter((r) => r.kind === 'stock_journal').map((r) => r.voucherId))]
    const made = new Set(
      ids.length
        ? (db.prepare(`SELECT voucher_id AS id FROM manufacture_details WHERE voucher_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { id: number }[]).map((r) => r.id)
        : []
    )
    const ways = new Map<number, Set<'in' | 'out'>>()
    for (const r of reg.rows) {
      if (r.kind !== 'stock_journal') continue
      const w = ways.get(r.voucherId) ?? new Set<'in' | 'out'>()
      w.add(r.inwardQtyMilli > 0 ? 'in' : 'out')
      ways.set(r.voucherId, w)
    }
    return {
      itemId,
      name: s.name,
      unit: s.unitSymbol,
      hsn: f.hsn,
      gstRate: f.gstRate,
      asOn,
      qtyMilli: s.closingQtyMilli,
      value: s.closingValue,
      unitCost: s.closingQtyMilli > 0 ? unitRate(s.closingValue, s.closingQtyMilli) : null,
      sellingPrice: sellingPrices(db, asOn)(itemId),
      reorderLevelMilli: f.reorderLevelMilli,
      level: stockLevel(s, f.reorderLevelMilli),
      recipe: recipeOf(db, itemId, asOn),
      history: {
        from: fy.from,
        openingMilli: reg.opening.qtyMilli,
        rows: reg.rows.map((r) => ({
          voucherId: r.voucherId,
          date: r.date,
          what: historyWhat(r.kind, r.inwardQtyMilli > 0 ? 'in' : 'out', r.isAbsolute, { manufacture: made.has(r.voucherId), bothWays: (ways.get(r.voucherId)?.size ?? 0) === 2 }),
          party: r.partyLedgerId != null ? r.particulars : null,
          inMilli: r.inwardQtyMilli,
          outMilli: r.outwardQtyMilli,
          balanceMilli: r.runningQtyMilli
        }))
      }
    }
  }))()
}

/** A saved stock count reopened: its lines with the difference the ENGINE recorded (the pass
 *  position just before each line → counted), so a reopened count never shows 0 because the
 *  total already includes it. null = not a stock count. */
export function savedCount(db: DB, voucherId: number): SavedCountView | null {
  return db.transaction((): SavedCountView | null => {
    const v = db
      .prepare(
        `SELECT v.id, v.number, v.date, v.narration, (${IN_BOOKS}) AS inBooks FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
         WHERE v.id = ? AND vt.kind = 'physical_stock'`
      )
      .get(voucherId) as { id: number; number: string; date: string; narration: string | null; inBooks: number } | undefined
    if (!v) return null
    const lines = db
      .prepare(
        `SELECT il.id AS lineId, il.stock_item_id AS itemId, si.name, u.symbol AS unit, il.qty_milli AS countedMilli
         FROM inventory_lines il JOIN stock_items si ON si.id = il.stock_item_id JOIN units u ON u.id = si.unit_id
         WHERE il.voucher_id = ? AND il.is_absolute = 1 AND ${MOVES_STOCK} ORDER BY il.line_order, il.id`
      )
      .all(voucherId) as { lineId: number; itemId: number; name: string; unit: string; countedMilli: number }[]
    const effects = v.inBooks ? countLineEffects(db, voucherId, v.date) : new Map()
    return {
      voucherId: v.id,
      number: v.number,
      date: v.date,
      narration: v.narration,
      inBooks: !!v.inBooks,
      lines: lines.map((l) => {
        const e = effects.get(l.lineId)
        return { ...l, beforeMilli: e ? e.beforeMilli : null, valueChange: e ? e.valueChange : null }
      })
    }
  })()
}

export function madeGoodsSetup(db: DB, date: string): MadeGoodsSetup {
  return db.transaction((): MadeGoodsSetup => {
    const versions = listBomVersions(db)
    const labours = recipeLabours(db)
    const items = db.prepare('SELECT si.id, si.name, u.symbol FROM stock_items si JOIN units u ON u.id = si.unit_id ORDER BY si.name COLLATE NOCASE').all() as { id: number; name: string; symbol: string }[]
    const products: MadeGoodsSetup['products'] = []
    for (const it of items) {
      const recipe = recipeOf(db, it.id, date, versions, labours)
      if (!recipe) continue
      products.push({ itemId: it.id, name: it.name, unit: it.symbol, recipe, suggestedPrice: suggestedSaleRate(db, it.id, date).ratePaise })
    }
    return { date, products }
  })()
}

/** "Change price": the selling price from `date` on the default price level (WP 8.4's level).
 *  Returns the walk-in price now in force. */
export function setSellingPrice(db: DB, itemId: number, ratePaise: number, date: string): { sellingPrice: number | null } {
  return db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM stock_items WHERE id = ?').get(itemId)) throw new Error('Stock item not found')
    const level = defaultPriceLevel(db) ?? sellingLevel(db)
    const current = db
      .prepare(
        `SELECT id, rate, effective_from AS effectiveFrom, effective_to AS effectiveTo, discount_bp AS discountBp FROM price_list_rates
         WHERE price_level_id = ? AND stock_item_id = ? AND currency = 'INR' AND min_qty_milli = 0
           AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
         ORDER BY effective_from DESC LIMIT 1`
      )
      .get(level.id, itemId, date, date) as { id: number; rate: number; effectiveFrom: string; effectiveTo: string | null; discountBp: number } | undefined
    const base = { priceLevelId: level.id, stockItemId: itemId, minQtyMilli: 0, currency: 'INR' }
    if (current?.rate === ratePaise) return { sellingPrice: sellingPrices(db, date)(itemId) }
    if (current && current.effectiveFrom === date) {
      // The price already changed on this day: the new one replaces it.
      saveRate(db, { ...base, rate: ratePaise, effectiveFrom: date, effectiveTo: current.effectiveTo, discountBp: current.discountBp }, current.id)
    } else {
      // The old price stays for what was billed before: it ends the day before.
      if (current) saveRate(db, { ...base, rate: current.rate, effectiveFrom: current.effectiveFrom, effectiveTo: addDaysISO(date, -1), discountBp: current.discountBp }, current.id)
      saveRate(db, { ...base, rate: ratePaise, effectiveFrom: date, effectiveTo: current?.effectiveTo ?? null })
    }
    return { sellingPrice: sellingPrices(db, date)(itemId) }
  })()
}

/**
 * The simple recipe editor's Save: the answers checked and planned by planRecipe, then ONE new
 * BOM version through bom.saveBomVersion (the full editor's own save — its validation, cycle
 * check and `bom` audit row), the labour per unit beside it (meta, audited as a `bom` update
 * with the before / after labour). Answers equal to the recipe in force write nothing. One
 * transaction: a refusal leaves no version, no meta and no audit row.
 */
export function saveRecipe(db: DB, input: RecipeInput, date: string): { changed: boolean; recipe: StockRecipe | null } {
  return db.transaction(() => {
    const versions = listBomVersions(db)
    const items = new Map((db.prepare('SELECT id, name FROM stock_items').all() as { id: number; name: string }[]).map((r) => [r.id, r.name]))
    const labours = recipeLabours(db)
    const plan = planRecipe(
      input,
      versions,
      date,
      (id) => items.get(id) ?? '',
      (id) => items.has(id),
      (vid) => (typeof labours[String(vid)] === 'number' && labours[String(vid)]! > 0 ? labours[String(vid)]! : null)
    )
    if (!plan.changed) return { changed: false, recipe: recipeOf(db, input.itemId, date) }
    const saved = saveBomVersion(db, plan.version)
    if (plan.labourPerUnit != null) {
      const next = { ...labours, [String(saved.id)]: plan.labourPerUnit }
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(LABOUR_KEY, JSON.stringify(next))
      writeAudit(db, 'bom', input.itemId, 'update', { versionId: saved.id, labourPerUnitPaise: null }, { versionId: saved.id, labourPerUnitPaise: plan.labourPerUnit })
    }
    return { changed: true, recipe: recipeOf(db, input.itemId, date) }
  })()
}
