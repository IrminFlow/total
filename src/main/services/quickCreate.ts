// WP 8.4 — product quick-create from a bill line (the plain "New product" dialog). ONE transaction:
// the stock item (createStockItem, audited `stockItem`), and when a selling price is given, its row
// on the company's DEFAULT price level (savePriceLevel / saveRate, audited `priceLevel` /
// `priceRate`). A company without a default level gets one ("Selling price", tax-exclusive) —
// the pricing resolver's tier 4 then finds the price exactly as it finds any default-level rate;
// `resolvePrice`'s order is untouched. The optional purchase price is the item's standard cost
// (stock_items.standard_cost_paise, an existing master field) — never a stock value.
import type { DB } from '../db/connection'
import type { StockItem } from '@shared/domain'
import { quickItemSchema, type QuickItemInput } from '@shared/schemas'
import { readCompanyInfo } from '../db/seed'
import { createStockItem } from './masters'
import { defaultPriceLevel, savePriceLevel, saveRate } from './priceLevels'

/** Name of the default level created for a company that has none. */
export const DEFAULT_SELLING_LEVEL = 'Selling price'

export interface QuickItemResult {
  item: StockItem
  /** The default level the selling price went on (created when the company had none). */
  priceLevelId: number | null
}

export function quickCreateItem(db: DB, raw: QuickItemInput): QuickItemResult {
  const input = quickItemSchema.parse(raw)
  return db.transaction(() => {
    const item = createStockItem(db, {
      ...input.item,
      ...(input.purchasePricePaise != null && input.purchasePricePaise > 0 ? { standardCostPaise: input.purchasePricePaise } : {})
    })
    if (input.sellingPricePaise == null || input.sellingPricePaise <= 0) return { item, priceLevelId: null }
    const level = defaultPriceLevel(db) ?? savePriceLevel(db, { name: DEFAULT_SELLING_LEVEL, inclusiveOfTax: false, isDefault: true })
    const info = readCompanyInfo(db)
    const from = info.booksBeginDate ?? `${info.booksFrom}-04-01`
    saveRate(db, { priceLevelId: level.id, stockItemId: item.id, rate: input.sellingPricePaise, effectiveFrom: from })
    return { item, priceLevelId: level.id }
  })()
}
