import type { DB } from '../db/connection'
import {
  standardCostOn,
  summariseVariance,
  varianceOf,
  type StandardCostRow,
  type VarianceLine,
  type VarianceSummary
} from '@shared/standardCost'
import { writeAudit } from './audit'
import { IN_BOOKS } from './vouchers'

/**
 * Standard costing and variance against actual (roadmap E #118) — the database half.
 *
 * The arithmetic and the decomposition live in `@shared/standardCost`. This file answers two
 * questions the engine cannot: what the standard was on a date, and what actually happened.
 *
 * "What actually happened" is read from `inventory_lines`, which is the only place it exists.
 * There is deliberately no stored variance anywhere: a variance is a difference between two things
 * that can both change (a standard can be corrected, a voucher can be altered), so storing it
 * would produce a report that disagrees with the books it was computed from and gives no clue
 * which is right.
 */

export interface StandardCost {
  id: number
  stockItemId: number
  itemName: string
  effectiveFrom: string
  standardCost: number
  note: string | null
}

const SELECT = `
  SELECT sc.id, sc.stock_item_id AS stockItemId, si.name AS itemName,
         sc.effective_from AS effectiveFrom, sc.standard_cost AS standardCost, sc.note
    FROM standard_costs sc JOIN stock_items si ON si.id = sc.stock_item_id`

export function listStandardCosts(db: DB, stockItemId?: number | null): StandardCost[] {
  return stockItemId == null
    ? (db.prepare(`${SELECT} ORDER BY si.name, sc.effective_from DESC`).all() as StandardCost[])
    : (db
        .prepare(`${SELECT} WHERE sc.stock_item_id = ? ORDER BY sc.effective_from DESC`)
        .all(stockItemId) as StandardCost[])
}

export interface StandardCostInput {
  stockItemId: number
  effectiveFrom: string
  standardCost: number
  note?: string | null
}

/**
 * Set (or correct) the standard for one item from one date.
 *
 * An upsert on (item, date) rather than an insert: setting the same day's standard twice is a
 * correction, and stacking two rows on one date would leave the resolution rule picking whichever
 * the query planner returned first — a number that changes between runs.
 */
export function saveStandardCost(db: DB, input: StandardCostInput): StandardCost {
  const item = db.prepare('SELECT id FROM stock_items WHERE id = ?').get(input.stockItemId)
  if (!item) throw new Error('Stock item not found')
  if (input.standardCost < 0) throw new Error('A standard cost cannot be negative')
  const before = db
    .prepare(`${SELECT} WHERE sc.stock_item_id = ? AND sc.effective_from = ?`)
    .get(input.stockItemId, input.effectiveFrom) as StandardCost | undefined
  db.prepare(
    `INSERT INTO standard_costs (stock_item_id, effective_from, standard_cost, note)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (stock_item_id, effective_from)
     DO UPDATE SET standard_cost = excluded.standard_cost, note = excluded.note`
  ).run(input.stockItemId, input.effectiveFrom, input.standardCost, input.note ?? null)
  const saved = db
    .prepare(`${SELECT} WHERE sc.stock_item_id = ? AND sc.effective_from = ?`)
    .get(input.stockItemId, input.effectiveFrom) as StandardCost
  writeAudit(db, 'standardCost', saved.id, before ? 'update' : 'create', before ?? null, saved)
  return saved
}

export function deleteStandardCost(db: DB, id: number): void {
  const before = db.prepare(`${SELECT} WHERE sc.id = ?`).get(id) as StandardCost | undefined
  if (!before) throw new Error('Standard cost not found')
  db.prepare('DELETE FROM standard_costs WHERE id = ?').run(id)
  writeAudit(db, 'standardCost', id, 'delete', before, null)
}

/** Every standard for an item, for the dated lookup. */
function historyFor(db: DB, stockItemId: number): StandardCostRow[] {
  return db
    .prepare(
      'SELECT effective_from AS effectiveFrom, standard_cost AS standardCost FROM standard_costs WHERE stock_item_id = ? ORDER BY effective_from'
    )
    .all(stockItemId) as StandardCostRow[]
}

export type VarianceBasis = 'purchase' | 'consumption'

export interface VarianceQuery {
  from: string
  to: string
  /**
   * Which movements to score.
   *
   * `purchase` scores what came IN — the buyer's variance, and the one a trading business wants.
   * `consumption` scores what went OUT of the factory on stock journals and manufactures, which is
   * the floor's variance. They are not summed: an item bought at ₹210 and consumed at ₹210 is one
   * ₹10 variance, and counting it on both sides would report ₹20.
   */
  basis: VarianceBasis
  stockItemId?: number | null
}

interface MovementRow {
  stockItemId: number
  name: string
  qtyMilli: number
  amount: number
  date: string
}

/**
 * The movements in the period, per item, with the date of each — because the standard is dated and
 * an item bought in September and again in November is scored against two different standards.
 *
 * `IN_BOOKS`, not merely not-deleted: a post-dated or unapproved voucher has not happened yet, and
 * a variance report that includes one reports a purchase nobody has made.
 */
function movements(db: DB, query: VarianceQuery): MovementRow[] {
  const direction = query.basis === 'purchase' ? 'in' : 'out'
  const kinds =
    query.basis === 'purchase'
      ? ['purchase', 'debit_note']
      : ['stock_journal', 'sales', 'credit_note']
  const params: unknown[] = [direction, query.from, query.to, ...kinds]
  const itemClause = query.stockItemId == null ? '' : ' AND il.stock_item_id = ?'
  if (query.stockItemId != null) params.push(query.stockItemId)
  return db
    .prepare(
      `SELECT il.stock_item_id AS stockItemId, si.name, il.qty_milli AS qtyMilli, il.amount, v.date
         FROM inventory_lines il
         JOIN vouchers v ON v.id = il.voucher_id
         JOIN voucher_types vt ON vt.id = v.voucher_type_id
         JOIN stock_items si ON si.id = il.stock_item_id
        WHERE il.direction = ? AND il.is_absolute = 0
          AND v.date BETWEEN ? AND ?
          AND vt.kind IN (${kinds.map(() => '?').join(',')})
          AND ${IN_BOOKS}${itemClause}
        ORDER BY si.name, v.date`
    )
    .all(...params) as MovementRow[]
}

/**
 * Variance for a period.
 *
 * Each movement is scored against the standard in force on ITS OWN date and then the scored lines
 * are added up per item — not the other way round. Aggregating first and applying one standard at
 * the end would price October's purchases at September's standard the moment a revision landed
 * mid-period, which is precisely the period anybody looks at this report for.
 */
export function varianceReport(db: DB, query: VarianceQuery): VarianceSummary {
  const rows = movements(db, query)
  const histories = new Map<number, StandardCostRow[]>()
  const byItem = new Map<number, VarianceLine>()
  const noStandard = new Map<number, { stockItemId: number; name: string; actualCostPaise: number }>()

  for (const row of rows) {
    let history = histories.get(row.stockItemId)
    if (!history) {
      history = historyFor(db, row.stockItemId)
      histories.set(row.stockItemId, history)
    }
    const standard = standardCostOn(history, row.date)
    if (standard === null) {
      // Listed, never scored. A blank in a variance report is a question; a zero is an answer, and
      // it would be the wrong one.
      const entry = noStandard.get(row.stockItemId) ?? {
        stockItemId: row.stockItemId,
        name: row.name,
        actualCostPaise: 0
      }
      entry.actualCostPaise += row.amount
      noStandard.set(row.stockItemId, entry)
      continue
    }
    const v = varianceOf({
      actualQtyMilli: row.qtyMilli,
      actualCostPaise: row.amount,
      standardRatePaise: standard
    })
    const existing = byItem.get(row.stockItemId)
    if (!existing) {
      byItem.set(row.stockItemId, {
        stockItemId: row.stockItemId,
        name: row.name,
        actualQtyMilli: row.qtyMilli,
        standardQtyMilli: row.qtyMilli,
        standardRatePaise: standard,
        ...v
      })
      continue
    }
    existing.actualQtyMilli += row.qtyMilli
    existing.standardQtyMilli += row.qtyMilli
    existing.actualCostPaise += v.actualCostPaise
    existing.standardCostPaise += v.standardCostPaise
    existing.priceVariancePaise += v.priceVariancePaise
    existing.usageVariancePaise += v.usageVariancePaise
    existing.totalVariancePaise += v.totalVariancePaise
    // The item's own rate on the summary row is the LAST standard that applied in the period —
    // stating an average of two standards would be a rate that was never anybody's standard.
    existing.standardRatePaise = standard
    existing.verdict =
      existing.totalVariancePaise === 0 ? 'on standard' : existing.totalVariancePaise > 0 ? 'adverse' : 'favourable'
  }

  const lines = [...byItem.values()].sort((a, b) => Math.abs(b.totalVariancePaise) - Math.abs(a.totalVariancePaise))
  return summariseVariance(lines, [...noStandard.values()].sort((a, b) => a.name.localeCompare(b.name)))
}
