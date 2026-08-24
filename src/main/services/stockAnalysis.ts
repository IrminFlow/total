import type { DB } from '../db/connection'
import type { StockSummaryRow } from '@shared/reports'
import {
  valueStock, expiryBucketOf, allocateAdditionalCost, daysToExpiry, summariseExpiry, AT_RISK_BUCKETS,
  type ExpiryBucket, type ExpirySummaryRow, type StockMovement, type ValuationMethod
} from '@shared/valuation'
import { allocateLandedCosts, type LandedCostBasis } from '@shared/landedCost'
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
  date: string
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

/**
 * Landed costs (roadmap #117): freight, insurance, duty and clearing charges recorded against a
 * purchase in `landed_costs`, carried into the value of that purchase's item lines on their own
 * basis (by value or by quantity). Returns extra paise per inventory_lines.id, exactly conserving
 * each charge.
 *
 * Read here rather than written into `inventory_lines.amount` at save time for the same reason
 * the manufacture costs above are: the item lines are what the supplier billed, and that is what
 * the purchase register, GST return and party ledger have to keep showing. Only the valuation
 * sees the loaded cost.
 */
function landedCostByLine(db: DB, asOn: string): Map<number, number> {
  const extraByLine = new Map<number, number>()
  const costs = db
    .prepare(
      `SELECT lc.voucher_id AS voucherId, lc.amount, lc.basis
       FROM landed_costs lc JOIN vouchers v ON v.id = lc.voucher_id
       WHERE v.date <= ? AND ${IN_BOOKS}
       ORDER BY lc.voucher_id, lc.line_order, lc.id`
    )
    .all(asOn) as { voucherId: number; amount: number; basis: LandedCostBasis }[]
  if (costs.length === 0) return extraByLine

  const byVoucher = new Map<number, { label: string; amount: number; basis: LandedCostBasis }[]>()
  for (const c of costs) {
    const list = byVoucher.get(c.voucherId) ?? []
    list.push({ label: '', amount: c.amount, basis: c.basis })
    byVoucher.set(c.voucherId, list)
  }

  const inLinesStmt = db.prepare(
    `SELECT id, qty_milli AS qtyMilli, amount FROM inventory_lines
     WHERE voucher_id = ? AND direction = 'in' AND is_absolute = 0 ORDER BY line_order, id`
  )
  for (const [voucherId, list] of byVoucher) {
    const inLines = inLinesStmt.all(voucherId) as { id: number; qtyMilli: number; amount: number }[]
    if (inLines.length === 0) continue
    for (const line of allocateLandedCosts(inLines, list).lines) {
      extraByLine.set(line.id, (extraByLine.get(line.id) ?? 0) + line.extra)
    }
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
              v.date AS date, il.qty_milli AS qtyMilli, il.amount, il.direction, il.is_absolute AS isAbsolute
       FROM inventory_lines il JOIN vouchers v ON v.id = il.voucher_id
       WHERE v.date <= ? AND ${IN_BOOKS} ${godownFilter}
       ORDER BY v.date, v.id, il.line_order, il.id`
    )
    .all(...(godownId ? [asOn, godownId] : [asOn])) as MovementRow[]
  const extraByLine = additionalCostByLine(db, asOn)
  for (const [lineId, extra] of landedCostByLine(db, asOn)) {
    extraByLine.set(lineId, (extraByLine.get(lineId) ?? 0) + extra)
  }
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
      // v0.3 #64 row shape (lane R): opening split out of inwards.
      openingQtyMilli: openingQty,
      openingValue,
      inwardQtyMilli: r.inwardQtyMilli,
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

export interface PeriodConsumption {
  /** Engine-valued cost of ALL outward movements dated within the period, paise. */
  consumedValue: number
  /** Total outward quantity within the period (all voucher kinds), integer thousandths. */
  outwardQtyMilli: number
}

/**
 * Engine-valued consumption per item within [from, to] (v0.3 integration, reconciliation (c):
 * item profitability's COGS basis). Computed as the difference of two chronological valuations —
 * movements before `from` versus movements through `to` — so each item's valuation_method
 * (FIFO / weighted average) prices the period's outward cost.
 */
export function periodConsumption(db: DB, from: string, to: string): Map<number, PeriodConsumption> {
  const items = listItems(db)
  const byItem = movementsByItem(db, to)
  const result = new Map<number, PeriodConsumption>()
  for (const item of items) {
    const moves = byItem.get(item.id) ?? []
    const before = moves.filter((m) => m.date < from)
    const all = valueStock(item.valuationMethod, item.openingQtyMilli, item.openingValue, moves.map(toMovement))
    const prior = valueStock(item.valuationMethod, item.openingQtyMilli, item.openingValue, before.map(toMovement))
    result.set(item.id, {
      consumedValue: all.consumedValue - prior.consumedValue,
      outwardQtyMilli: all.outwardQtyMilli - prior.outwardQtyMilli
    })
  }
  return result
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
    // KNOWN LIMITATION (deferred, v0.3 review): PhysicalStockEntry saves counts with
    // godownId = null, so a company-wide count pins only the no-godown bucket while
    // godown-attributed rows keep their pre-count quantities — per-godown rows can then sum to
    // more than the item's engine-valued closing, and the value pro-ration (below, which divides
    // by the engine closing) skews per-row values. Fixing this properly needs per-godown counts
    // (or distributing a null-godown count across godown buckets), tracked for a later wave.
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


// ---------- near-expiry, with what it is worth (roadmap #114, #116) ----------

export interface NearExpiryRow extends ExpiryAgeingRow {
  daysToExpiry: number
  /** What this batch's remaining stock is worth, at the item's own valuation. Paise. */
  value: number
  /** Days since the batch was made, when a manufacturing date was recorded. */
  ageDays: number | null
}

export interface NearExpiryReport {
  asOn: string
  rows: NearExpiryRow[]
  summary: ExpirySummaryRow[]
  /** Expired plus everything inside ninety days — the number worth putting in front of somebody. */
  atRisk: number
  expired: number
  /** Batches holding stock with no expiry recorded. Not a clean bill of health: a gap in the data. */
  undatedBatches: number
  undatedQtyMilli: number
}

/**
 * What is about to become worthless, and what it costs.
 *
 * `expiryAgeing` already knew which batches expire when; what it could not say is what they are
 * worth, which is the only form of the question anybody acts on. Value is the batch's remaining
 * quantity at the item's own rate from the valuation engine, so it agrees with the closing stock
 * on the balance sheet rather than being a second opinion about it.
 *
 * Batches with stock but no expiry date are counted separately and loudly. Reporting "nothing
 * expires soon" when the truth is "nobody recorded a date" is the one failure this report cannot
 * afford.
 */
export function nearExpiry(db: DB, asOn: string): NearExpiryReport {
  const batches = batchStock(db, asOn).filter((r) => r.closingQtyMilli > 0)
  // One valuation pass for every item that has a live batch, rather than one per batch.
  const rates = new Map<number, number>()
  for (const row of stockSummary(db, asOn)) {
    rates.set(row.stockItemId, row.closingQtyMilli > 0 ? Math.round((row.closingValue * 1000) / row.closingQtyMilli) : 0)
  }

  const rows: NearExpiryRow[] = batches
    .filter((r) => r.expiryDate !== null)
    .map((r) => {
      const rate = rates.get(r.stockItemId) ?? 0
      return {
        ...r,
        bucket: expiryBucketOf(r.expiryDate, asOn),
        daysToExpiry: daysToExpiry(r.expiryDate, asOn) as number,
        value: Math.round((r.closingQtyMilli * rate) / 1000),
        ageDays: r.mfgDate ? Math.max(0, -(daysToExpiry(r.mfgDate, asOn) as number)) : null
      }
    })
    .sort((a, b) => a.daysToExpiry - b.daysToExpiry || b.value - a.value)

  const undated = batches.filter((r) => r.expiryDate === null)
  return {
    asOn,
    rows,
    summary: summariseExpiry(rows.map((r) => ({ bucket: r.bucket, value: r.value }))),
    atRisk: rows.filter((r) => AT_RISK_BUCKETS.has(r.bucket)).reduce((s, r) => s + r.value, 0),
    expired: rows.filter((r) => r.bucket === 'expired').reduce((s, r) => s + r.value, 0),
    undatedBatches: undated.length,
    undatedQtyMilli: undated.reduce((s, r) => s + r.closingQtyMilli, 0)
  }
}

// ---------- what it costs to take stock out (roadmap #112) ----------

/**
 * The book cost of moving `qtyMilli` of an item out on `asOn` — what the valuation engine would
 * charge for that outward line if it were the next one entered.
 *
 * Asked as a difference of two walks rather than read off a rate, because under FIFO the cost of
 * the next unit out is the oldest layer's cost, which is not the average and can be a long way
 * from it. A godown transfer values both of its lines at this number so the pair cancels exactly
 * and company-wide stock value does not move.
 *
 * A transfer dated before later movements is priced as if it were the last one on its date, which
 * is what a person entering it today means; re-pricing history around a back-dated move would
 * silently rewrite the cost of sales already reported.
 */
export function outwardCostOf(db: DB, asOn: string, stockItemId: number, qtyMilli: number): number {
  if (qtyMilli <= 0) return 0
  const item = db
    .prepare(
      `SELECT opening_qty_milli AS openingQtyMilli, opening_value AS openingValue,
              valuation_method AS valuationMethod
       FROM stock_items WHERE id = ?`
    )
    .get(stockItemId) as
    | { openingQtyMilli: number; openingValue: number; valuationMethod: ValuationMethod }
    | undefined
  if (!item) return 0

  const moves = (movementsByItem(db, asOn).get(stockItemId) ?? []).map(toMovement)
  const walk = (ms: StockMovement[]): number =>
    valueStock(item.valuationMethod, item.openingQtyMilli, item.openingValue, ms).consumedValue
  return walk([...moves, { direction: 'out', qtyMilli, amount: 0 }]) - walk(moves)
}
