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
//   (its row ends the day before); saved through priceLevels.saveRate (audited `priceRate`).
import type { DB } from '../db/connection'
import { addDaysISO, fyOf } from '@shared/dates'
import { pickBomVersion } from '@shared/bom'
import { unitRate } from '@shared/manufacture'
import {
  historyWhat, needsReorder, stockLevel,
  type MadeGoodsSetup, type StockList, type StockProductView, type StockRecipe, type StockRow
} from '@shared/simple/stock'
import { stockMovements, stockSummary } from './stockAnalysis'
import { pricingLoader } from './pricing'
import { listBomVersions } from './bom'
import { suggestedSaleRate } from './manufacture'
import { defaultPriceLevel, saveRate } from './priceLevels'
import { sellingLevel } from './quickCreate'

interface ItemFacts { id: number; reorderLevelMilli: number | null; hsn: string | null; gstRate: number | null }

function itemFacts(db: DB): Map<number, ItemFacts> {
  const rows = db.prepare('SELECT id, reorder_level_milli AS reorderLevelMilli, hsn, gst_rate AS gstRate FROM stock_items').all() as ItemFacts[]
  return new Map(rows.map((r) => [r.id, r]))
}

/** The walk-in selling price per unit on `date` (resolvePrice), null when none is set. */
function sellingPrices(db: DB, date: string): (itemId: number) => number | null {
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
    return { asOn, rows, lowCount: rows.filter((r) => needsReorder(r.level)).length }
  })()
}

/** Products running low or out as on `asOn` (Home's "Needs attention"). */
export const lowStockCount = (db: DB, asOn: string): number => stockList(db, asOn).lowCount

function recipeOf(db: DB, itemId: number, date: string, versions = listBomVersions(db)): StockRecipe | null {
  const v = pickBomVersion(versions, itemId, date)
  if (!v || v.lines.length === 0) return null
  const name = db.prepare('SELECT si.name, u.symbol FROM stock_items si JOIN units u ON u.id = si.unit_id WHERE si.id = ?')
  return {
    versionId: v.id,
    lines: v.lines.map((l) => {
      const c = name.get(l.componentId) as { name: string; symbol: string } | undefined
      return { itemId: l.componentId, name: c?.name ?? '', unit: c?.symbol ?? '', qtyMilliPerUnit: l.qtyMilliPerUnit, scrapPctBp: l.scrapPctBp }
    })
  }
}

export function stockProduct(db: DB, itemId: number, asOn: string): StockProductView | null {
  return db.transaction((): StockProductView | null => {
    const s = stockSummary(db, asOn).find((r) => r.stockItemId === itemId)
    const f = itemFacts(db).get(itemId)
    if (!s || !f) return null
    const fy = fyOf(asOn)
    const reg = stockMovements(db, itemId, fy.from, asOn)
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
          what: historyWhat(r.kind, r.inwardQtyMilli > 0 ? 'in' : 'out', r.isAbsolute),
          party: r.partyLedgerId != null ? r.particulars : null,
          inMilli: r.inwardQtyMilli,
          outMilli: r.outwardQtyMilli,
          balanceMilli: r.runningQtyMilli
        }))
      }
    }
  })()
}

export function madeGoodsSetup(db: DB, date: string): MadeGoodsSetup {
  return db.transaction((): MadeGoodsSetup => {
    const versions = listBomVersions(db)
    const items = db.prepare('SELECT si.id, si.name, u.symbol FROM stock_items si JOIN units u ON u.id = si.unit_id ORDER BY si.name COLLATE NOCASE').all() as { id: number; name: string; symbol: string }[]
    const products: MadeGoodsSetup['products'] = []
    for (const it of items) {
      const recipe = recipeOf(db, it.id, date, versions)
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
