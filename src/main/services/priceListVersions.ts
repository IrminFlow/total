import type { DB } from '../db/connection'
import { addDays } from '@shared/dates'
import {
  listOn,
  planRevision,
  versionsOf,
  type DatedRate,
  type PriceVersion,
  type RevisionPlan,
  type Rounding
} from '@shared/priceList'
import { writeAudit } from './audit'

/**
 * Price list versioning (roadmap E #128).
 *
 * `price_list_rates` has carried an `effective_from` since price levels were built, and
 * `priceLevels.rateFor` has always resolved it, so the storage and the invoice side were never
 * missing. What was missing is the idea a user actually has: not "a rate with a date on it" but a
 * VERSION — on 1 October the wholesale list changed, all forty items at once — and any way at all
 * to ask what the list said on a day that has passed.
 *
 * A version is DERIVED: the set of rates sharing an effective date. Never stored. A stored version
 * header and the rates under it are two things that can disagree, and the rates are the ones that
 * price the invoice.
 *
 * Kept in its own file rather than bolted onto `priceLevels.ts` because it is a different job:
 * that file is CRUD over one rate at a time, and this one is about a list moving as a whole.
 * The rules are in `@shared/priceList`, tested exhaustively there.
 */

/** Every rate of a level, for the pure resolver. */
function datedRates(db: DB, priceLevelId: number): DatedRate[] {
  return db
    .prepare(
      `SELECT stock_item_id AS stockItemId, rate, effective_from AS effectiveFrom
       FROM price_list_rates WHERE price_level_id = ?`
    )
    .all(priceLevelId) as DatedRate[]
}

/** The versions of a level, newest first, each with how many items it changed. */
export function listVersions(db: DB, priceLevelId: number, asOn: string): PriceVersion[] {
  return versionsOf(datedRates(db, priceLevelId), asOn)
}

export interface PriceListRow {
  stockItemId: number
  itemName: string
  unitSymbol: string
  rate: number
  /** The date the rate in force came from — which version this row belongs to. */
  effectiveFrom: string
}

/**
 * The whole list as it stood on a date: one rate per item, the one in force.
 *
 * This is the answer to the question the feature exists for — the credit note raised in November
 * against a September invoice, the price-protection claim, the argument about a rate. Resolved
 * through `listOn` rather than a second SQL query, so this screen and the `rateFor` that prices an
 * invoice can never come to differ about what "in force" means.
 */
export function listAsOn(db: DB, priceLevelId: number, asOn: string): PriceListRow[] {
  const rates = datedRates(db, priceLevelId)
  const inForce = listOn(rates, asOn)
  if (inForce.size === 0) return []
  const ids = [...inForce.keys()]
  const rows = db
    .prepare(
      `SELECT si.id AS stockItemId, si.name AS itemName, u.symbol AS unitSymbol
         FROM stock_items si JOIN units u ON u.id = si.unit_id
        WHERE si.id IN (${ids.map(() => '?').join(',')})
        ORDER BY si.name`
    )
    .all(...ids) as { stockItemId: number; itemName: string; unitSymbol: string }[]

  const dateOf = new Map<number, string>()
  for (const r of rates) {
    if (r.effectiveFrom > asOn) continue
    const seen = dateOf.get(r.stockItemId)
    if (seen === undefined || r.effectiveFrom > seen) dateOf.set(r.stockItemId, r.effectiveFrom)
  }
  return rows.map((r) => ({
    ...r,
    rate: inForce.get(r.stockItemId)!,
    effectiveFrom: dateOf.get(r.stockItemId)!
  }))
}

export interface RevisionRequest {
  priceLevelId: number
  effectiveFrom: string
  /** Basis points: +500 is +5%. Integer, because a percentage stored as a float reintroduces one
   *  layer up exactly the imprecision paise exist to avoid. */
  changeBp: number
  rounding?: Rounding
  /** Items to leave out — the ones whose price was negotiated separately this quarter. */
  skip?: number[]
}

export interface RevisionPreview extends RevisionPlan {
  /** Item names for the preview table, so the screen does not need a second query to label rows. */
  names: Record<number, string>
}

/** What a revision would do, old and new rate side by side. Nothing is written. */
export function previewRevision(db: DB, input: RevisionRequest): RevisionPreview {
  // The base is what is in force on the day BEFORE the new version starts. Reading it as on the
  // effective date itself would pick the new version up as its own base the second time the
  // preview ran, and compound the percentage against a rate it had just set.
  const base = listAsOn(db, input.priceLevelId, addDays(input.effectiveFrom, -1))
  const plan = planRevision({
    base: base.map((b) => ({ stockItemId: b.stockItemId, rate: b.rate })),
    effectiveFrom: input.effectiveFrom,
    changeBp: input.changeBp,
    rounding: input.rounding,
    skip: input.skip
  })
  return { ...plan, names: Object.fromEntries(base.map((b) => [b.stockItemId, b.itemName])) }
}

/** Write the revision. All or nothing: a half-applied price list is one nobody can quote from. */
export function applyRevision(db: DB, input: RevisionRequest): { rows: number; effectiveFrom: string } {
  const plan = previewRevision(db, input)
  if (plan.errors.length) throw new Error(plan.errors.join('; '))
  const insert = db.prepare(
    `INSERT INTO price_list_rates (price_level_id, stock_item_id, rate, effective_from)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (price_level_id, stock_item_id, effective_from) DO UPDATE SET rate = excluded.rate`
  )
  const run = db.transaction(() => {
    for (const row of plan.rows) insert.run(input.priceLevelId, row.stockItemId, row.rate, row.effectiveFrom)
  })
  run()
  writeAudit(db, 'priceRate', input.priceLevelId, 'update', null, {
    revision: input.effectiveFrom,
    changeBp: input.changeBp,
    items: plan.rows.length
  })
  return { rows: plan.rows.length, effectiveFrom: input.effectiveFrom }
}

/**
 * Delete a whole version — every rate that came into force on one date.
 *
 * The one destructive operation here, and the clearest reason a version is worth being a
 * first-class idea: a revision applied with the wrong percentage leaves forty rows to undo by
 * hand otherwise, and forty by hand is thirty-nine right and one wrong.
 */
export function deleteVersion(db: DB, priceLevelId: number, effectiveFrom: string): number {
  const res = db
    .prepare('DELETE FROM price_list_rates WHERE price_level_id = ? AND effective_from = ?')
    .run(priceLevelId, effectiveFrom)
  writeAudit(db, 'priceRate', priceLevelId, 'delete', { version: effectiveFrom, rows: res.changes }, null)
  return res.changes
}
