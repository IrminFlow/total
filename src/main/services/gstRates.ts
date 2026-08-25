/**
 * Dated GST rates for stock items (roadmap #358).
 *
 * The engine is split in two, and both halves matter here: the slab history — which rates existed
 * on a date — is in src/shared/gst/slabs.ts, and the caveats about the September 2025
 * rationalisation live there. Read them before trusting anything this file reports. What an
 * ITEM's rate was on a date comes from src/shared/gst/rateHistory.ts, which is also what
 * ./itemRates.ts writes; both read the one table, `stock_item_gst_rates`.
 *
 * What this adds is the books: a per-item change list, a lookup that prefers it over the master
 * column, and an advisory pass over a period's invoices. The advisory is the point of the whole
 * feature — the question a user will actually be asked is "why is there 12% on an invoice dated
 * October 2025", and nothing in the app could answer it.
 *
 * NOTHING HERE CHANGES A POSTED VOUCHER. A voucher carries the tax it was posted with, and
 * recomputing history to match a rate table is how a filed return stops agreeing with the books.
 * The advisory says which entries look wrong; a human decides what to do about each one.
 */

import type { DB } from '../db/connection'
import { slabAdvice, slabsOn, structureChangedWithin, type GstSlabSet } from '@shared/gst/slabs'
import { rateOn } from '@shared/gst/rateHistory'
import type { ItemGstRateInput } from '@shared/schemas'
import type { RateChange } from '@shared/gst/rateHistory'
import { effectiveItemTax } from './masters'
import { IN_BOOKS } from './vouchers'
import { writeAudit } from './audit'

/**
 * The row shape this service and the advisory UI speak.
 *
 * Deliberately not the engine's `RateChange`: the engine names the fields `ratePercent` /
 * `cessPercent`, this screen has always said `rate` / `cessRate`, and renaming a wire shape to win
 * a naming argument is churn. `toChange` converts at the one place the engine is called.
 */
export interface ItemRate {
  effectiveFrom: string
  rate: number
  cessRate: number
  note: string | null
}

interface RateRow {
  id: number
  stock_item_id: number
  effective_from: string
  gst_rate: number
  cess_rate: number
  note: string | null
}

const toChange = (r: ItemRate): RateChange => ({
  effectiveFrom: r.effectiveFrom,
  ratePercent: r.rate,
  cessPercent: r.cessRate,
  note: r.note
})

/** The item's rate in force on `date`, in this file's shape. */
const itemRateOn = (history: ItemRate[], date: string): ItemRate | null => {
  const inForce = rateOn(history.map(toChange), date)
  return inForce ? (history.find((h) => h.effectiveFrom === inForce.effectiveFrom) ?? null) : null
}

/** Rate changes for an item that fall strictly inside a period — the ones that split a report. */
const changesWithin = (history: ItemRate[], from: string, to: string): ItemRate[] =>
  history
    .filter((r) => r.effectiveFrom > from && r.effectiveFrom <= to)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))

const mapRate = (r: RateRow): ItemRate & { id: number } => ({
  id: r.id,
  effectiveFrom: r.effective_from,
  rate: r.gst_rate,
  cessRate: r.cess_rate,
  note: r.note
})

/** Every recorded change for an item, oldest first. */
export function itemRateHistory(db: DB, stockItemId: number): (ItemRate & { id: number })[] {
  const rows = db
    .prepare('SELECT * FROM stock_item_gst_rates WHERE stock_item_id = ? ORDER BY effective_from')
    .all(stockItemId) as RateRow[]
  return rows.map(mapRate)
}

export interface DatedItemTax {
  gstRate: number | null
  cessRate: number | null
  /** 'history' when a dated entry answered, 'master' when it fell back to the item/group. */
  source: 'history' | 'master'
  /** The dated entry that answered, when one did. */
  entry: ItemRate | null
  /** The slab structure in force on the date asked about. */
  slabs: GstSlabSet
  /** Set when the rate is not a notified slab on that date. Advice, never a refusal. */
  advice: string | null
}

/**
 * The rate an item carried on a date.
 *
 * Falls back to the master column (and its group inheritance) when the history says nothing about
 * a date that early. That fallback is not a compromise, it is correct: an item nobody has dated
 * has had one rate for its whole life, and that rate is the one in the master. The history only
 * becomes the answer once somebody records a change.
 */
export function itemTaxOn(db: DB, stockItemId: number, date: string): DatedItemTax {
  const dated = itemRateOn(itemRateHistory(db, stockItemId), date)
  const slabs = slabsOn(date)
  if (dated) {
    return {
      gstRate: dated.rate,
      cessRate: dated.cessRate,
      source: 'history',
      entry: dated,
      slabs,
      advice: slabAdvice(dated.rate, date).message
    }
  }
  const master = effectiveItemTax(db, stockItemId)
  return {
    gstRate: master.gstRate,
    cessRate: master.cessRate,
    source: 'master',
    entry: null,
    slabs,
    advice: master.gstRate === null ? null : slabAdvice(master.gstRate, date).message
  }
}

/**
 * Record a rate change.
 *
 * Upsert on (item, date) so correcting the rate you just typed replaces it rather than leaving
 * two entries for one day, which `itemRateOn` would have to break a tie on.
 */
export function saveItemRate(db: DB, input: ItemGstRateInput): (ItemRate & { id: number })[] {
  const before = db
    .prepare('SELECT * FROM stock_item_gst_rates WHERE stock_item_id = ? AND effective_from = ?')
    .get(input.stockItemId, input.effectiveFrom) as RateRow | undefined
  db.prepare(
    `INSERT INTO stock_item_gst_rates (stock_item_id, effective_from, gst_rate, cess_rate, note)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (stock_item_id, effective_from) DO UPDATE SET
       gst_rate = excluded.gst_rate, cess_rate = excluded.cess_rate, note = excluded.note`
  ).run(input.stockItemId, input.effectiveFrom, input.gstRate, input.cessRate, input.note)
  const after = db
    .prepare('SELECT * FROM stock_item_gst_rates WHERE stock_item_id = ? AND effective_from = ?')
    .get(input.stockItemId, input.effectiveFrom) as RateRow
  writeAudit(db, 'stockItemGstRate', after.id, before ? 'update' : 'create', before ? mapRate(before) : null, mapRate(after))
  return itemRateHistory(db, input.stockItemId)
}

export function deleteItemRate(db: DB, id: number): (ItemRate & { id: number })[] {
  const before = db.prepare('SELECT * FROM stock_item_gst_rates WHERE id = ?').get(id) as RateRow | undefined
  if (!before) throw new Error('Rate entry not found')
  db.prepare('DELETE FROM stock_item_gst_rates WHERE id = ?').run(id)
  writeAudit(db, 'stockItemGstRate', id, 'delete', mapRate(before), null)
  return itemRateHistory(db, before.stock_item_id)
}

export interface RateFinding {
  voucherId: number
  date: string
  voucherNumber: string
  kind: string
  itemId: number
  itemName: string
  /** The rate the item master carries today. */
  usedRate: number
  /** What the item's dated history says for that date, or null when it says nothing. */
  datedRate: number | null
  message: string
}

export interface RateAdvisory {
  from: string
  to: string
  /** Set when the period straddles a change in the slab structure. */
  structureChange: GstSlabSet | null
  /** Items whose own history changes inside the period — the reports that will legitimately split. */
  itemsChangingWithin: { itemId: number; itemName: string; changes: ItemRate[] }[]
  /** Lines whose rate is not a notified slab on the invoice date, or contradicts the history. */
  findings: RateFinding[]
  /** Items whose CURRENT master rate is a slab that no longer exists. The fix list. */
  staleMasters: { itemId: number; itemName: string; gstRate: number; message: string }[]
}

/**
 * What is worth looking at about rates in a period.
 *
 * Three separate questions, deliberately not merged into one number:
 *
 *   - Did the STRUCTURE change inside this period? September 2025's GSTR-1 shows one HSN at two
 *     rates and that is correct. Without this line it looks like a data-entry error, and somebody
 *     will "fix" it.
 *   - Does any LINE carry a rate that was not a slab on its own date? That is the finding.
 *   - Does any MASTER still hold a withdrawn rate? That is the cause, and fixing it is what stops
 *     the findings recurring next month.
 */
export function rateAdvisory(db: DB, from: string, to: string): RateAdvisory {
  const lines = db
    .prepare(
      `SELECT v.id AS voucherId, v.date AS date, v.number AS voucherNumber, vt.kind AS kind,
              si.id AS itemId, si.name AS itemName, si.gst_rate AS masterRate
       FROM inventory_lines il
       JOIN vouchers v ON v.id = il.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN stock_items si ON si.id = il.stock_item_id
       WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       GROUP BY v.id, si.id
       ORDER BY v.date, v.id`
    )
    .all(from, to) as {
      voucherId: number; date: string; voucherNumber: string; kind: string
      itemId: number; itemName: string; masterRate: number | null
    }[]

  const historyCache = new Map<number, ItemRate[]>()
  const historyOf = (itemId: number): ItemRate[] => {
    const cached = historyCache.get(itemId)
    if (cached) return cached
    const h = itemRateHistory(db, itemId)
    historyCache.set(itemId, h)
    return h
  }

  const findings: RateFinding[] = []
  for (const l of lines) {
    // The rate a line was posted with is not stored on the line — inventory lines carry value,
    // and the tax came from the master at entry time. So the honest thing to check is the pair
    // (what the master says now, what the history says for that date), which is exactly the
    // disagreement a user is being asked about.
    const dated = itemRateOn(historyOf(l.itemId), l.date)
    const used = l.masterRate
    if (used === null) continue

    if (dated && dated.rate !== used) {
      findings.push({
        voucherId: l.voucherId, date: l.date, voucherNumber: l.voucherNumber, kind: l.kind,
        itemId: l.itemId, itemName: l.itemName, usedRate: used, datedRate: dated.rate,
        message:
          `The item master now says ${used}%, but its rate history says ${dated.rate}% applied on ${l.date}. ` +
          'Check the tax on this voucher against the rate in force when it was raised.'
      })
      continue
    }
    const advice = slabAdvice(used, l.date)
    if (advice.message) {
      findings.push({
        voucherId: l.voucherId, date: l.date, voucherNumber: l.voucherNumber, kind: l.kind,
        itemId: l.itemId, itemName: l.itemName, usedRate: used, datedRate: dated?.rate ?? null,
        message: advice.message
      })
    }
  }

  const itemsChangingWithin: RateAdvisory['itemsChangingWithin'] = []
  for (const [itemId, history] of historyCache) {
    const changes = changesWithin(history, from, to)
    if (changes.length === 0) continue
    const name = lines.find((l) => l.itemId === itemId)?.itemName ?? String(itemId)
    itemsChangingWithin.push({ itemId, itemName: name, changes })
  }

  const masters = db.prepare('SELECT id, name, gst_rate AS gstRate FROM stock_items WHERE gst_rate IS NOT NULL').all() as
    { id: number; name: string; gstRate: number }[]
  const staleMasters = masters
    .map((m) => ({ m, advice: slabAdvice(m.gstRate, to) }))
    .filter((x) => x.advice.message !== null)
    .map((x) => ({ itemId: x.m.id, itemName: x.m.name, gstRate: x.m.gstRate, message: x.advice.message as string }))

  return {
    from,
    to,
    structureChange: structureChangedWithin(from, to),
    itemsChangingWithin,
    findings,
    staleMasters
  }
}
