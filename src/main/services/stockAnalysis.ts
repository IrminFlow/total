import type { DB } from '../db/connection'
import type { StockSummaryRow } from '@shared/reports'
import { valueStock, type StockMovement, type ValuationMethod } from '@shared/valuation'
import { IN_BOOKS, checkStock } from './vouchers'
import type { NegativeStockWarning } from '@shared/domain'

/**
 * Valuation-engine-driven stock reports (lane I). Unlike the legacy reports.stockSummary
 * (periodic weighted average in SQL), everything here walks inventory movements chronologically
 * through src/shared/valuation.ts, honouring each item's `valuation_method` (FIFO vs perpetual
 * moving average) and physical-stock absolute lines.
 *
 * NOTE for the integrator: `stockValue(db, asOn)` here is the drop-in replacement for
 * reports.stockValue (same signature) once Lane R's balance-sheet single-scan lands.
 */

interface ItemRow {
  id: number
  name: string
  unitSymbol: string
  decimals: number
  openingQtyMilli: number
  openingValue: number
  valuationMethod: ValuationMethod
}

interface MovementRow {
  stockItemId: number
  godownId: number | null
  batchId: number | null
  qtyMilli: number
  amount: number
  direction: 'in' | 'out'
  isAbsolute: number
}

function listItems(db: DB): ItemRow[] {
  return db
    .prepare(
      `SELECT si.id, si.name, u.symbol AS unitSymbol, u.decimals,
              si.opening_qty_milli AS openingQtyMilli, si.opening_value AS openingValue,
              si.valuation_method AS valuationMethod
       FROM stock_items si JOIN units u ON u.id = si.unit_id ORDER BY si.name`
    )
    .all() as ItemRow[]
}

/** All in-books inventory movements up to `asOn`, in voucher order, grouped per item. */
function movementsByItem(db: DB, asOn: string, godownId?: number): Map<number, MovementRow[]> {
  const godownFilter = godownId ? 'AND il.godown_id = ?' : ''
  const rows = db
    .prepare(
      `SELECT il.stock_item_id AS stockItemId, il.godown_id AS godownId, il.batch_id AS batchId,
              il.qty_milli AS qtyMilli, il.amount, il.direction, il.is_absolute AS isAbsolute
       FROM inventory_lines il JOIN vouchers v ON v.id = il.voucher_id
       WHERE v.date <= ? AND ${IN_BOOKS} ${godownFilter}
       ORDER BY v.date, v.id, il.line_order, il.id`
    )
    .all(...(godownId ? [asOn, godownId] : [asOn])) as MovementRow[]
  const byItem = new Map<number, MovementRow[]>()
  for (const r of rows) {
    const list = byItem.get(r.stockItemId) ?? []
    list.push(r)
    byItem.set(r.stockItemId, list)
  }
  return byItem
}

const toMovement = (r: MovementRow): StockMovement => ({
  direction: r.direction,
  qtyMilli: r.qtyMilli,
  amount: r.direction === 'in' && !r.isAbsolute ? r.amount : 0,
  isAbsolute: !!r.isAbsolute
})

export interface StockSummaryOptions {
  /** Restrict movements to one godown (opening stock is company-wide and excluded then). */
  godownId?: number
}

/**
 * Per-item stock summary as of `asOn`, valued per each item's valuation method. Same row shape
 * as the legacy reports.stockSummary. When `godownId` is given, only that godown's movements
 * count and opening balances are left out (openings aren't godown-attributed).
 */
export function stockSummary(db: DB, asOn: string, opts: StockSummaryOptions = {}): StockSummaryRow[] {
  const items = listItems(db)
  const byItem = movementsByItem(db, asOn, opts.godownId)
  return items.map((item) => {
    const openingQty = opts.godownId ? 0 : item.openingQtyMilli
    const openingValue = opts.godownId ? 0 : item.openingValue
    const moves = (byItem.get(item.id) ?? []).map(toMovement)
    const r = valueStock(item.valuationMethod, openingQty, openingValue, moves)
    return {
      stockItemId: item.id,
      name: item.name,
      unitSymbol: item.unitSymbol,
      decimals: item.decimals,
      inwardQtyMilli: openingQty + r.inwardQtyMilli,
      outwardQtyMilli: r.outwardQtyMilli,
      closingQtyMilli: r.closingQtyMilli,
      closingValue: r.closingValue
    }
  })
}

/** Total closing stock value as of `asOn` — engine-valued drop-in for reports.stockValue. */
export function stockValue(db: DB, asOn: string): number {
  return stockSummary(db, asOn).reduce((s, r) => s + r.closingValue, 0)
}

/** Items whose closing quantity is negative as of `asOn` — the Exceptions report rows. */
export function negativeStock(db: DB, asOn: string): NegativeStockWarning[] {
  const ids = (db.prepare('SELECT id FROM stock_items').all() as { id: number }[]).map((r) => r.id)
  return checkStock(db, ids, asOn)
}
