import type { DB } from '../db/connection'
import type { StockSummaryRow } from '@shared/reports'
import {
  valueStock, expiryBucketOf, allocateAdditionalCost,
  type ExpiryBucket, type StockMovement, type ValuationMethod
} from '@shared/valuation'
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
  lineId: number
  stockItemId: number
  godownId: number | null
  batchId: number | null
  qtyMilli: number
  amount: number
  direction: 'in' | 'out'
  isAbsolute: number
}

/**
 * Manufacture additional costs (task 79): a stock journal's balanced ledger lines
 * (e.g. Dr Freight Inward / Cr Cash) represent cost loaded into what it produces. The debit
 * total (== credit total — the voucher balances) is split across the voucher's inward
 * inventory lines pro-rata by base amount (largest-remainder, every paisa conserved), so the
 * produced item's cost includes freight/labour. Returns extra paise per inventory_lines.id.
 */
function additionalCostByLine(db: DB, asOn: string): Map<number, number> {
  const extraByLine = new Map<number, number>()
  const costRows = db
    .prepare(
      `SELECT v.id AS voucherId,
              (SELECT COALESCE(SUM(amount), 0) FROM voucher_lines WHERE voucher_id = v.id AND dr_cr = 'dr') AS extra
       FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE vt.kind = 'stock_journal' AND v.date <= ? AND ${IN_BOOKS}
         AND EXISTS (SELECT 1 FROM voucher_lines WHERE voucher_id = v.id)`
    )
    .all(asOn) as { voucherId: number; extra: number }[]
  const inLinesStmt = db.prepare(
    `SELECT id, amount FROM inventory_lines
     WHERE voucher_id = ? AND direction = 'in' AND is_absolute = 0 ORDER BY line_order, id`
  )
  for (const { voucherId, extra } of costRows) {
    if (extra <= 0) continue
    const inLines = inLinesStmt.all(voucherId) as { id: number; amount: number }[]
    if (inLines.length === 0) continue
    const shares = allocateAdditionalCost(inLines.map((l) => l.amount), extra)
    inLines.forEach((l, i) => extraByLine.set(l.id, shares[i]!))
  }
  return extraByLine
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
      `SELECT il.id AS lineId, il.stock_item_id AS stockItemId, il.godown_id AS godownId, il.batch_id AS batchId,
              il.qty_milli AS qtyMilli, il.amount, il.direction, il.is_absolute AS isAbsolute
       FROM inventory_lines il JOIN vouchers v ON v.id = il.voucher_id
       WHERE v.date <= ? AND ${IN_BOOKS} ${godownFilter}
       ORDER BY v.date, v.id, il.line_order, il.id`
    )
    .all(...(godownId ? [asOn, godownId] : [asOn])) as MovementRow[]
  const extraByLine = additionalCostByLine(db, asOn)
  if (extraByLine.size > 0) {
    for (const r of rows) {
      const extra = extraByLine.get(r.lineId)
      if (extra) r.amount += extra
    }
  }
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

// ---------- godown-wise stock (task 73) ----------

export interface GodownStockRow {
  godownId: number | null
  /** '' for lines with no godown. */
  godownName: string
  stockItemId: number
  name: string
  unitSymbol: string
  decimals: number
  closingQtyMilli: number
  /** Paise — the godown's share of the item's engine-valued closing stock, pro-rated by
   *  quantity (valuation itself is per item, not per godown). */
  closingValue: number
}

/** Per-(item, godown) closing stock as of `asOn`. Only rows with a non-zero quantity. Opening
 *  balances aren't godown-attributed and land on the "no godown" row. */
export function stockByGodown(db: DB, asOn: string): GodownStockRow[] {
  const items = listItems(db)
  const byItem = movementsByItem(db, asOn)
  const godowns = new Map(
    (db.prepare('SELECT id, name FROM godowns').all() as { id: number; name: string }[]).map((g) => [g.id, g.name])
  )

  const rows: GodownStockRow[] = []
  for (const item of items) {
    const moves = byItem.get(item.id) ?? []
    const summary = valueStock(item.valuationMethod, item.openingQtyMilli, item.openingValue, moves.map(toMovement))

    // Quantity per godown: absolute (physical-count) lines pin the quantity of the godown they
    // sit on (null = the company-wide bucket).
    const qtyByGodown = new Map<number | null, number>()
    qtyByGodown.set(null, item.openingQtyMilli)
    for (const m of moves) {
      const key = m.godownId
      const cur = qtyByGodown.get(key) ?? 0
      if (m.isAbsolute) qtyByGodown.set(key, m.qtyMilli)
      else qtyByGodown.set(key, cur + (m.direction === 'in' ? m.qtyMilli : -m.qtyMilli))
    }

    // Pro-rate the item's closing value over godown quantities (the last row soaks up the
    // rounding remainder so the sum always equals the item's closing value).
    const entries = [...qtyByGodown.entries()].filter(([, qty]) => qty !== 0)
    const totalQty = summary.closingQtyMilli
    let allocated = 0
    entries.forEach(([godownId, qty], i) => {
      const isLast = i === entries.length - 1
      const value =
        totalQty !== 0
          ? isLast
            ? summary.closingValue - allocated
            : Math.round((summary.closingValue * qty) / totalQty)
          : 0
      allocated += value
      rows.push({
        godownId,
        godownName: godownId === null ? '' : godowns.get(godownId) ?? '',
        stockItemId: item.id,
        name: item.name,
        unitSymbol: item.unitSymbol,
        decimals: item.decimals,
        closingQtyMilli: qty,
        closingValue: value
      })
    })
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.godownName.localeCompare(b.godownName))
}

// ---------- batch-wise stock + expiry ageing (task 74) ----------

export interface BatchStockRow {
  batchId: number
  batchName: string
  stockItemId: number
  itemName: string
  unitSymbol: string
  decimals: number
  mfgDate: string | null
  expiryDate: string | null
  closingQtyMilli: number
}

/** Per-batch closing quantity as of `asOn` (in − out; physical-count absolute lines don't
 *  carry batch semantics and are excluded). Every known batch is returned, zero rows included,
 *  optionally scoped to one item. */
export function batchStock(db: DB, asOn: string, stockItemId?: number): BatchStockRow[] {
  const itemFilter = stockItemId ? 'AND b.stock_item_id = ?' : ''
  return db
    .prepare(
      `SELECT b.id AS batchId, b.name AS batchName, b.stock_item_id AS stockItemId,
              si.name AS itemName, u.symbol AS unitSymbol, u.decimals,
              b.mfg_date AS mfgDate, b.expiry_date AS expiryDate,
              COALESCE((
                SELECT SUM(CASE WHEN il.direction = 'in' THEN il.qty_milli ELSE -il.qty_milli END)
                FROM inventory_lines il JOIN vouchers v ON v.id = il.voucher_id
                WHERE il.batch_id = b.id AND il.is_absolute = 0 AND v.date <= ? AND ${IN_BOOKS}
              ), 0) AS closingQtyMilli
       FROM batches b
       JOIN stock_items si ON si.id = b.stock_item_id
       JOIN units u ON u.id = si.unit_id
       WHERE 1 = 1 ${itemFilter}
       ORDER BY si.name, b.name`
    )
    .all(...(stockItemId ? [asOn, stockItemId] : [asOn])) as BatchStockRow[]
}

export interface ExpiryAgeingRow extends BatchStockRow {
  bucket: ExpiryBucket
}

/** Batches still holding stock as of `asOn`, bucketed by expiry: expired / ≤30 days / ≤90 days /
 *  later. Batches without an expiry date are omitted. */
export function expiryAgeing(db: DB, asOn: string): ExpiryAgeingRow[] {
  return batchStock(db, asOn)
    .filter((r) => r.closingQtyMilli > 0 && r.expiryDate !== null)
    .map((r) => ({ ...r, bucket: expiryBucketOf(r.expiryDate, asOn) }))
    .sort((a, b) => (a.expiryDate! < b.expiryDate! ? -1 : a.expiryDate! > b.expiryDate! ? 1 : 0))
}
