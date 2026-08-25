import type { DB } from '../db/connection'
import type { ItemRateInput } from '@shared/schemas'
import {
  checkRateHistory,
  describeRateChange,
  normalizeRateHistory,
  rateOn,
  splitByRatePeriods,
  validateRateHistory,
  type RateChange,
  type RateHistory,
  type RatePeriod
} from '@shared/gst/rateHistory'
import { todayISO } from '@shared/dates'
import { writeAudit } from './audit'

/**
 * The GST rate history of a stock item (roadmap D-92) — the storage half of
 * `src/shared/gst/rateHistory.ts`.
 *
 * The rule the whole feature exists for: a document is priced with the rate in force on ITS OWN
 * date. `stock_items.gst_rate` alone could not express that — editing it rewrote every past
 * invoice and every filed return. So the item keeps its current rate in that column (nothing that
 * reads it had to change) and the dated changes live here, in front of it.
 *
 * An item with NO rows behaves exactly as it did before this table existed: the column answers.
 * That is deliberate — most books never change a rate, and they should never pay for the feature.
 */

export interface ItemRateRow extends RateChange {
  id: number
  stockItemId: number
}

interface Row {
  id: number
  stockItemId: number
  effectiveFrom: string
  ratePercent: number
  cessPercent: number
  note: string | null
}

const SELECT = `SELECT id, stock_item_id AS stockItemId, effective_from AS effectiveFrom,
                       rate_percent AS ratePercent, cess_percent AS cessPercent, note
                FROM item_gst_rates`

const toChange = (r: Row): ItemRateRow => ({
  id: r.id,
  stockItemId: r.stockItemId,
  effectiveFrom: r.effectiveFrom,
  ratePercent: r.ratePercent,
  cessPercent: r.cessPercent,
  note: r.note
})

/** Every recorded change for an item, oldest first. */
export function listItemRates(db: DB, stockItemId: number): ItemRateRow[] {
  return (
    db.prepare(`${SELECT} WHERE stock_item_id = ? ORDER BY effective_from, id`).all(stockItemId) as Row[]
  ).map(toChange)
}

export interface ItemRateHistoryView {
  stockItemId: number
  rows: ItemRateRow[]
  /** The change in force on `asOn`, or null when the history says nothing about that day. */
  inForce: RateChange | null
  /** One sentence about the newest change — what the UI prints under the table. */
  latestSentence: string | null
  /** The item's own undated rate: what still answers when there are no rows at all. */
  itemRate: { gstRate: number | null; cessRate: number | null }
  /** Advisory only. An unusual rate is usually a real rate the slab table has not caught up with. */
  warnings: string[]
}

/** Everything the item editor shows in one call. */
export function itemRateHistory(db: DB, stockItemId: number, asOn: string = todayISO()): ItemRateHistoryView {
  const item = db
    .prepare('SELECT gst_rate AS gstRate, cess_rate AS cessRate FROM stock_items WHERE id = ?')
    .get(stockItemId) as { gstRate: number | null; cessRate: number | null } | undefined
  if (!item) throw new Error('Stock item not found')

  const rows = listItemRates(db, stockItemId)
  const sorted = normalizeRateHistory(rows)
  const latest = sorted[sorted.length - 1] ?? null
  const previous = sorted.length > 1 ? sorted[sorted.length - 2]! : null

  return {
    stockItemId,
    rows,
    inForce: rateOn(rows, asOn),
    latestSentence: latest ? describeRateChange(previous, latest) : null,
    itemRate: { gstRate: item.gstRate, cessRate: item.cessRate },
    // An empty history is not a problem here — it means "use the item's own rate", which is the
    // documented fallback. Only a non-empty history is worth validating.
    warnings: rows.length > 0 ? validateRateHistory(rows) : []
  }
}

export interface SavedItemRate {
  row: ItemRateRow
  /** Warnings never block the save; the caller shows them. */
  warnings: string[]
}

/**
 * Record (or correct) one dated change.
 *
 * The prospective history — the rows as they WOULD be after this save — goes through the engine's
 * validator, and errors refuse the save. Warnings come back to the caller instead: the Council has
 * notified odd rates before, and an app that refuses to record reality is worse than one that
 * queries it.
 */
export function saveItemRate(db: DB, input: ItemRateInput, id?: number): SavedItemRate {
  const item = db.prepare('SELECT id FROM stock_items WHERE id = ?').get(input.stockItemId)
  if (!item) throw new Error('Stock item not found')

  const existing = listItemRates(db, input.stockItemId)
  const before = id != null ? (existing.find((r) => r.id === id) ?? null) : null
  if (id != null && !before) throw new Error('Rate change not found')

  const candidate: RateChange = {
    effectiveFrom: input.effectiveFrom,
    ratePercent: input.ratePercent,
    cessPercent: input.cessPercent,
    note: input.note
  }
  const prospective: RateHistory = [...existing.filter((r) => r.id !== id), candidate]

  const problems = checkRateHistory(prospective)
  const errors = problems.filter((p) => p.severity === 'error')
  if (errors.length > 0) throw new Error(errors.map((p) => p.message).join(' '))

  let savedId: number
  if (id != null) {
    db.prepare(
      `UPDATE item_gst_rates SET effective_from = ?, rate_percent = ?, cess_percent = ?, note = ? WHERE id = ?`
    ).run(input.effectiveFrom, input.ratePercent, input.cessPercent, input.note, id)
    savedId = id
  } else {
    savedId = Number(
      db
        .prepare(
          `INSERT INTO item_gst_rates (stock_item_id, effective_from, rate_percent, cess_percent, note)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(input.stockItemId, input.effectiveFrom, input.ratePercent, input.cessPercent, input.note)
        .lastInsertRowid
    )
  }

  const row = toChange(db.prepare(`${SELECT} WHERE id = ?`).get(savedId) as Row)
  writeAudit(db, 'itemGstRate', row.id, before ? 'update' : 'create', before, row)
  return { row, warnings: problems.filter((p) => p.severity === 'warning').map((p) => p.message) }
}

/**
 * Forget one change.
 *
 * Deleting the last row is allowed: the item then falls back to `stock_items.gst_rate`, which is
 * the same answer it gave before anybody recorded a history. Refusing here would leave a user who
 * mistyped one date unable to undo it.
 */
export function deleteItemRate(db: DB, id: number): void {
  const before = db.prepare(`${SELECT} WHERE id = ?`).get(id) as Row | undefined
  if (!before) throw new Error('Rate change not found')
  db.prepare('DELETE FROM item_gst_rates WHERE id = ?').run(id)
  writeAudit(db, 'itemGstRate', id, 'delete', toChange(before), null)
}

/**
 * The change in force for an item ON `date`, or null when the history does not answer.
 *
 * Null covers both "this item has no history" and "the history starts after this date". Callers
 * fall back to the item's own column in either case — an old voucher dated before anyone recorded
 * a history must keep computing exactly what it computed yesterday.
 */
export function rateForItemOn(db: DB, stockItemId: number, date: string): RateChange | null {
  const row = db
    .prepare(
      `${SELECT} WHERE stock_item_id = ? AND effective_from <= ?
       ORDER BY effective_from DESC, id DESC LIMIT 1`
    )
    .get(stockItemId, date) as Row | undefined
  return row ? toChange(row) : null
}

/** The sub-periods of [from, to] and the rate in force in each — what a report cites. */
export function itemRatePeriods(db: DB, stockItemId: number, from: string, to: string): RatePeriod[] {
  return splitByRatePeriods(listItemRates(db, stockItemId), from, to)
}

/** True when a return period straddles a change for this item — worth saying before filing. */
export function itemRateChangedWithin(db: DB, stockItemId: number, from: string, to: string): boolean {
  return itemRatePeriods(db, stockItemId, from, to).length > 1
}

/**
 * A resolver for hot loops (GSTR-1 extraction walks every line of every voucher in a period).
 *
 * Returns null when no item in the book has any history at all, so the overwhelmingly common case
 * costs one COUNT and then nothing — the per-line path stays byte-for-byte what it was.
 */
export function makeRateResolver(db: DB): ((stockItemId: number, date: string) => RateChange | null) | null {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM item_gst_rates').get() as { n: number }
  if (n === 0) return null
  const stmt = db.prepare(
    `${SELECT} WHERE stock_item_id = ? AND effective_from <= ?
     ORDER BY effective_from DESC, id DESC LIMIT 1`
  )
  return (stockItemId, date) => {
    const row = stmt.get(stockItemId, date) as Row | undefined
    return row ? toChange(row) : null
  }
}
