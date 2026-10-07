import type { DB } from '../db/connection'
import type { StockSummaryRow } from '@shared/reports'
import {
  expiryBucketOf, runInventoryPass, stockCostPositionsAsOf, costConsumption, bookedInwardValues,
  type ExpiryBucket, type ValuationMethod, type ValuationResult, type InventoryItem, type InventoryMovement,
  type InventoryPassInput, type VoucherCosting, type StockCostPosition, type ConsumptionCosting,
  type ProposedOutward, type LinkedLineCosting
} from '@shared/valuation'
import { IN_BOOKS, MOVES_STOCK, checkStock } from './vouchers'
import { hasTradeSchema } from './tradeLinks'
import type { NegativeStockWarning } from '@shared/domain'
import {
  averageMonthlyConsumption, daysToExpiry, expiresWithin, isBelowReorder, labelSheetHtml, monthsOfCover, suggestedOrderQty,
  type ExpiryReportRow, type LabelItem, type ReorderRow, type StockMovementRegister, type StockMovementRow
} from '@shared/stockPlanning'
import { formatPaise } from '@shared/money'
import { parseLineSerials } from './serials'
import { rateFor } from './priceLevels'

/**
 * Valuation-engine-driven stock reports (lane I; global pass WP 2.1). Unlike the legacy
 * reports.stockSummary (periodic weighted average in SQL), everything here walks inventory
 * movements chronologically through src/shared/valuation.ts — ONE pass over every item —
 * honouring each item's `valuation_method` (FIFO vs perpetual moving average), physical-stock
 * absolute lines, and each voucher's costing rule (see voucherCosting).
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
  voucherId: number
  stockItemId: number
  godownId: number | null
  date: string
  qtyMilli: number
  amount: number
  direction: 'in' | 'out'
  isAbsolute: number
}

// ---------- costing rule per voucher (WP 2.1) ----------

/** A voucher marked for `'derived'` (value-conserving) costing. */
export interface DerivedCostingMark {
  voucherId: number
  /** Explicit additional cost (WP 2.2: labour from manufacture_details), paise. `null` = none
   *  given — fall back to the legacy Dr-ledger-line total. */
  additionalCostPaise: number | null
}

/** Supplies the derived marks for in-books vouchers dated ≤ asOn. */
export type DerivedCostingSource = (db: DB, asOn: string) => DerivedCostingMark[]

/**
 * The default source (WP 2.2): every in-books voucher with a `manufacture_details` row (saved
 * by the Manufacture screen) is costed `'derived'`, with that row's labour as the explicit
 * additional cost — which beats the voucher's own Dr labour ledger lines (precedence 1 below),
 * so labour is never counted twice. Legacy stock journals have no row and stay `'stored'`
 * exactly as before, so no existing company's stock value moves on upgrade.
 */
export const manufactureDetailsCostingSource: DerivedCostingSource = (db, asOn) =>
  db
    .prepare(
      `SELECT md.voucher_id AS voucherId, md.labour_paise AS additionalCostPaise
       FROM manufacture_details md JOIN vouchers v ON v.id = md.voucher_id
       WHERE v.date <= ? AND ${IN_BOOKS}`
    )
    .all(asOn) as DerivedCostingMark[]
let derivedCostingSource: DerivedCostingSource = manufactureDetailsCostingSource

/** Install a derived-mark predicate (tests); `null` restores the default
 *  (manufactureDetailsCostingSource). */
export function setDerivedCostingSource(source: DerivedCostingSource | null): void {
  derivedCostingSource = source ?? manufactureDetailsCostingSource
}

/**
 * Per-voucher costing for every in-books voucher dated ≤ asOn that needs more than the default
 * (`'stored'`, no additional cost).
 *
 * Rule: `'derived'` only when the voucher is marked by the derived-costing source AND it is a
 * stock_journal with at least one outward and one inward non-absolute in-books line. Everything
 * else — including a marked voucher that isn't such a journal — is `'stored'`.
 *
 * Additional cost precedence (never summed):
 *   1. an explicit `additionalCostPaise` on the voucher's mark (WP 2.2 labour) — wins, because
 *      WP 2.2 also posts that labour as Dr ledger lines on the same voucher;
 *   2. else, for a stock_journal, the total of its Dr ledger lines (legacy task 79:
 *      freight/labour journalled on the manufacture);
 *   3. else 0.
 * Under `'stored'` the additional cost is split over inward lines by stored amount exactly as
 * before (positive totals only); under `'derived'` it joins the consumed cost in the conserved
 * total.
 */
export function voucherCosting(db: DB, asOn: string): Map<number, VoucherCosting> {
  const costing = linkedCosting(db)
  const ledgerExtra = db
    .prepare(
      `SELECT v.id AS voucherId, SUM(vl.amount) AS extra
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN voucher_lines vl ON vl.voucher_id = v.id AND vl.dr_cr = 'dr'
       WHERE vt.kind = 'stock_journal' AND v.date <= ? AND ${IN_BOOKS}
       GROUP BY v.id`
    )
    .all(asOn) as { voucherId: number; extra: number }[]
  for (const { voucherId, extra } of ledgerExtra) {
    if (extra > 0) costing.set(voucherId, { rule: 'stored', additionalCostPaise: extra })
  }

  const marks = derivedCostingSource(db, asOn)
  if (marks.length === 0) return costing
  const eligible = new Set(
    (
      db
        .prepare(
          `SELECT v.id AS id
           FROM vouchers v
           JOIN voucher_types vt ON vt.id = v.voucher_type_id
           JOIN inventory_lines il ON il.voucher_id = v.id AND il.is_absolute = 0
           WHERE vt.kind = 'stock_journal' AND v.date <= ? AND ${IN_BOOKS} AND ${MOVES_STOCK}
           GROUP BY v.id
           HAVING SUM(il.direction = 'out') > 0 AND SUM(il.direction = 'in') > 0`
        )
        .all(asOn) as { id: number }[]
    ).map((r) => r.id)
  )
  for (const mark of marks) {
    if (!eligible.has(mark.voucherId)) continue
    const legacy = costing.get(mark.voucherId)?.additionalCostPaise ?? 0
    costing.set(mark.voucherId, {
      rule: 'derived',
      additionalCostPaise: mark.additionalCostPaise ?? legacy
    })
  }
  return costing
}

/**
 * WP 2.5 (design §3.3): the `'linked'` costing of every voucher that needs it — independent of
 * any as-of date (a bill re-prices its GRN retroactively at the GRN's position, so a checkpoint
 * snapshot still equals a pass over the movements up to it).
 * - GRN re-pricing: each live receipt-note line with live `reprices = 1` bill links → `billed`.
 * - Return costing: each in-books inward line with a `return` link → `returnOf` its cost source,
 *   found by walking `fulfil` links up from its source line to the first stock-moving line
 *   (credit note → invoice line (non-moving) → challan line).
 * Without any link (every company before WP 2.5) this returns an empty map: legacy books are
 * valued exactly as before.
 */
function linkedCosting(db: DB): Map<number, VoucherCosting> {
  const costing = new Map<number, VoucherCosting>()
  if (!hasTradeSchema(db)) return costing
  if (!db.prepare('SELECT 1 FROM line_links LIMIT 1').get()) return costing
  const lines = new Map<number, Map<number, LinkedLineCosting>>()
  const entry = (voucherId: number, lineId: number, c: LinkedLineCosting): void => {
    let m = lines.get(voucherId)
    if (!m) lines.set(voucherId, (m = new Map()))
    if (!m.has(lineId)) m.set(lineId, c)
  }

  const billed = db
    .prepare(
      `SELECT g.id AS grnLineId, g.voucher_id AS grnVoucherId, b.qty_milli AS qtyMilli, b.amount
       FROM line_links ll
       JOIN inventory_lines g ON g.line_uid = ll.from_line_uid AND g.moves_stock = 1
       JOIN vouchers gv ON gv.id = g.voucher_id
       JOIN inventory_lines b ON b.line_uid = ll.to_line_uid
       JOIN vouchers v ON v.id = b.voucher_id
       WHERE ll.link_type = 'fulfil' AND ll.reprices = 1 AND gv.deleted_at IS NULL
         AND v.deleted_at IS NULL AND v.is_optional = 0
       ORDER BY g.id, b.id`
    )
    .all() as { grnLineId: number; grnVoucherId: number; qtyMilli: number; amount: number }[]
  const byGrnLine = new Map<number, { voucherId: number; bills: { qtyMilli: number; amount: number }[] }>()
  for (const r of billed) {
    const cur = byGrnLine.get(r.grnLineId) ?? { voucherId: r.grnVoucherId, bills: [] }
    cur.bills.push({ qtyMilli: r.qtyMilli, amount: r.amount })
    byGrnLine.set(r.grnLineId, cur)
  }
  for (const [lineId, { voucherId, bills }] of byGrnLine) entry(voucherId, lineId, { billed: bills })

  const returns = db
    .prepare(
      `SELECT t.id AS lineId, t.voucher_id AS voucherId, ll.from_line_uid AS fromUid
       FROM line_links ll
       JOIN inventory_lines t ON t.line_uid = ll.to_line_uid
       JOIN vouchers v ON v.id = t.voucher_id
       WHERE ll.link_type = 'return' AND t.direction = 'in' AND t.is_absolute = 0 AND t.moves_stock = 1 AND ${IN_BOOKS}`
    )
    .all() as { lineId: number; voucherId: number; fromUid: string }[]
  if (returns.length > 0) {
    const lineByUid = db.prepare('SELECT id, qty_milli AS qtyMilli, moves_stock AS movesStock, direction FROM inventory_lines WHERE line_uid = ?')
    const upstream = db.prepare("SELECT from_line_uid AS uid FROM line_links WHERE to_line_uid = ? AND link_type = 'fulfil'")
    for (const r of returns) {
      let uid: string | undefined = r.fromUid
      for (let depth = 0; uid && depth < 8; depth++) {
        const src = lineByUid.get(uid) as { id: number; qtyMilli: number; movesStock: number; direction: 'in' | 'out' } | undefined
        if (!src) break
        if (src.movesStock === 1) {
          if (src.direction === 'out') entry(r.voucherId, r.lineId, { returnOf: { sourceLineId: src.id, sourceQtyMilli: src.qtyMilli } })
          break
        }
        uid = (upstream.get(uid) as { uid: string } | undefined)?.uid
      }
    }
  }
  for (const [voucherId, linked] of lines) costing.set(voucherId, { rule: 'linked', linked })
  return costing
}

// ---------- loading ----------

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

/** In-books inventory lines dated ≤ asOn, in voucher order (date, voucher, line order) —
 *  all of them, or one godown's, or (`stockJournalInward`) only stock journals' plain inward
 *  lines (all that stored-rule additional-cost loading reads). */
function loadMovements(
  db: DB,
  asOn: string,
  filter: { godownId?: number; stockJournalInward?: boolean } = {}
): MovementRow[] {
  const where = [
    filter.godownId ? 'AND il.godown_id = ?' : '',
    filter.stockJournalInward
      ? `AND il.direction = 'in' AND il.is_absolute = 0
         AND v.voucher_type_id IN (SELECT id FROM voucher_types WHERE kind = 'stock_journal')`
      : ''
  ].join(' ')
  return db
    .prepare(
      `SELECT il.id AS lineId, il.voucher_id AS voucherId, il.stock_item_id AS stockItemId, il.godown_id AS godownId,
              v.date AS date, il.qty_milli AS qtyMilli, il.amount, il.direction, il.is_absolute AS isAbsolute
       FROM inventory_lines il JOIN vouchers v ON v.id = il.voucher_id
       WHERE v.date <= ? AND ${IN_BOOKS} AND ${MOVES_STOCK} ${where}
       ORDER BY v.date, v.id, il.line_order, il.id`
    )
    .all(...(filter.godownId ? [asOn, filter.godownId] : [asOn])) as MovementRow[]
}

const toMovement = (r: MovementRow, amount = r.amount): InventoryMovement => ({
  itemId: r.stockItemId,
  voucherId: r.voucherId,
  date: r.date,
  lineId: r.lineId,
  direction: r.direction,
  qtyMilli: r.qtyMilli,
  amount: r.direction === 'in' && !r.isAbsolute ? amount : 0,
  isAbsolute: !!r.isAbsolute
})

const toItems = (items: ItemRow[], withOpening = true): InventoryItem[] =>
  items.map((i) => ({
    itemId: i.id,
    method: i.valuationMethod,
    openingQtyMilli: withOpening ? i.openingQtyMilli : 0,
    openingValue: withOpening ? i.openingValue : 0
  }))

/** The company-wide pass input as of `asOn` (every item, every in-books line, every rule). */
function companyPassInput(db: DB, asOn: string): { items: ItemRow[]; rows: MovementRow[]; input: InventoryPassInput } {
  const items = listItems(db)
  const rows = loadMovements(db, asOn)
  return {
    items,
    rows,
    input: { items: toItems(items), movements: rows.map((r) => toMovement(r)), costing: voucherCosting(db, asOn) }
  }
}

/**
 * The pass input of ONE godown's view as of `asOn` (stock summary's godown mode, and the movement
 * register filtered to a godown): only that godown's movements, no openings (they aren't
 * godown-attributed), and every costed inward line (additional cost, derived manufacture) at the
 * value the company-wide pass booked for it — valuation is company-wide, the godown is walked alone.
 */
function godownPassInput(
  db: DB,
  asOn: string,
  godownId: number,
  items: ItemRow[],
  costing: Map<number, VoucherCosting>
): InventoryPassInput {
  let godownRows: MovementRow[]
  let booked: Map<number, number>
  if ([...costing.values()].some((c) => c.rule !== 'stored')) {
    // Derived values (and WP 2.5 linked ones) need the company-wide movements.
    const rows = loadMovements(db, asOn)
    booked = bookedInwardValues({ items: toItems(items), movements: rows.map((r) => toMovement(r)), costing })
    godownRows = rows.filter((r) => r.godownId === godownId)
  } else {
    // Stored-rule values depend only on each voucher's own lines: no pass needed.
    const journalInward = costing.size > 0 ? loadMovements(db, asOn, { stockJournalInward: true }) : []
    booked = bookedInwardValues({ items: [], movements: journalInward.map((r) => toMovement(r)), costing })
    godownRows = loadMovements(db, asOn, { godownId })
  }
  return { items: toItems(items, false), movements: godownRows.map((r) => toMovement(r, booked.get(r.lineId) ?? r.amount)) }
}

const ZERO: ValuationResult = { closingQtyMilli: 0, closingValue: 0, inwardQtyMilli: 0, outwardQtyMilli: 0, consumedValue: 0 }

export interface StockSummaryOptions {
  /** Restrict movements to one godown (opening stock is company-wide and excluded then). */
  godownId?: number
}

/**
 * Per-item stock summary as of `asOn`, valued per each item's valuation method. Same row shape
 * as the legacy reports.stockSummary. When `godownId` is given, only that godown's movements
 * count and opening balances are left out (openings aren't godown-attributed). Valuation is
 * company-wide, so a godown view takes each costed inward line (additional cost, derived
 * manufacture) at the value the company-wide pass booked for it, then walks the godown alone.
 */
export function stockSummary(db: DB, asOn: string, opts: StockSummaryOptions = {}): StockSummaryRow[] {
  const items = listItems(db)
  const costing = voucherCosting(db, asOn)
  const input = opts.godownId
    ? godownPassInput(db, asOn, opts.godownId, items, costing)
    : { items: toItems(items), movements: loadMovements(db, asOn).map((r) => toMovement(r)), costing }
  const results = runInventoryPass(input).closing
  return items.map((item) => {
    const r = results.get(item.id) ?? ZERO
    const openingQty = opts.godownId ? 0 : item.openingQtyMilli
    const openingValue = opts.godownId ? 0 : item.openingValue
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

/** stockValue at several dates from ONE movement load and ONE pass — each entry equals
 *  stockValue(db, d). For the dashboard's month-by-month P&L. The pass is chronological, so a
 *  checkpoint's snapshot equals a pass over only the movements up to it (later vouchers, and
 *  their additional cost, never leak into an earlier date). */
export function stockValuesAt(db: DB, dates: string[]): Map<string, number> {
  const result = new Map<string, number>()
  if (dates.length === 0) return result
  const latest = dates.reduce((a, b) => (a > b ? a : b))
  const { items, input } = companyPassInput(db, latest)
  const unique = [...new Set(dates)]
  const { at } = runInventoryPass(input, unique.map((date) => ({ date })))
  unique.forEach((d, i) => {
    const snap = at[i]!
    result.set(d, items.reduce((s, item) => s + (snap.get(item.id)?.closingValue ?? 0), 0))
  })
  return result
}

export interface PeriodConsumption {
  /** Engine-valued cost of ALL outward movements dated within the period, paise. */
  consumedValue: number
  /** Total outward quantity within the period (all voucher kinds), integer thousandths. */
  outwardQtyMilli: number
}

/**
 * Engine-valued consumption per item within [from, to] (v0.3 integration, reconciliation (c):
 * item profitability's COGS basis): the pass through `to` minus its snapshot just before
 * `from`, so each item's valuation_method (FIFO / weighted average) prices the period.
 */
export function periodConsumption(db: DB, from: string, to: string): Map<number, PeriodConsumption> {
  const { items, input } = companyPassInput(db, to)
  const { closing, at } = runInventoryPass(input, [{ date: from, voucherId: 0 }])
  const before = at[0]!
  const result = new Map<number, PeriodConsumption>()
  for (const item of items) {
    const all = closing.get(item.id) ?? ZERO
    const prior = before.get(item.id) ?? ZERO
    result.set(item.id, {
      consumedValue: all.consumedValue - prior.consumedValue,
      outwardQtyMilli: all.outwardQtyMilli - prior.outwardQtyMilli
    })
  }
  return result
}

// ---------- cost as of a date (WP 2.1 → WP 2.2's manufacture screen) ----------

export interface CostAsOfQuery {
  /** The voucher date being priced. */
  date: string
  /** The voucher being edited: its own saved lines are left out and only vouchers ordered
   *  before it count. Omit for a new voucher (priced after everything on `date`). */
  voucherId?: number
  /** Items whose running position to return (default: every item in `lines`, or all items). */
  itemIds?: number[]
  /** Proposed outward lines to price without saving. */
  lines?: ProposedOutward[]
}

export interface CostAsOfResult {
  positions: StockCostPosition[]
  consumption: ConsumptionCosting | null
}

/** Exact engine cost figures at a voucher's position: each item's running average / FIFO next
 *  layer, and (optionally) the cost a proposed set of outward lines would be charged. */
export function costAsOf(db: DB, q: CostAsOfQuery): CostAsOfResult {
  const { items, input } = companyPassInput(db, q.date)
  const at = { date: q.date, voucherId: q.voucherId }
  const ids = q.itemIds ?? (q.lines ? [...new Set(q.lines.map((l) => l.itemId))] : items.map((i) => i.id))
  return {
    positions: stockCostPositionsAsOf(input, at, ids),
    consumption: q.lines ? costConsumption(input, q.lines, at) : null
  }
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
  const { items, rows, input } = companyPassInput(db, asOn)
  const { closing } = runInventoryPass(input)
  const godowns = new Map(
    (db.prepare('SELECT id, name FROM godowns').all() as { id: number; name: string }[]).map((g) => [g.id, g.name])
  )
  const movesByItem = new Map<number, MovementRow[]>()
  for (const r of rows) {
    const list = movesByItem.get(r.stockItemId)
    if (list) list.push(r)
    else movesByItem.set(r.stockItemId, [r])
  }

  const out: GodownStockRow[] = []
  for (const item of items) {
    const moves = movesByItem.get(item.id) ?? []
    const summary = closing.get(item.id) ?? ZERO

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
      out.push({
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
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.godownName.localeCompare(b.godownName))
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
                WHERE il.batch_id = b.id AND il.is_absolute = 0 AND v.date <= ? AND ${IN_BOOKS} AND ${MOVES_STOCK}
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

// ---------- item movements (WP 2.2 minimal register; WP 2.3 builds the full one) ----------

export interface ItemMovementRow {
  voucherId: number
  date: string
  number: string
  voucherType: string
  kind: string
  /** Thousandths; for a physical-count line, the counted closing quantity. */
  inQtyMilli: number
  outQtyMilli: number
  isAbsolute: boolean
  /** Stored line amount, paise (a derived manufacture's inward value is re-derived by the
   *  engine at valuation time — this is the save-time figure). */
  amount: number
}

/** One item's in-books inventory lines dated within [from, to], in voucher order — the
 *  read-only movement list under a Stock summary row. */
export function itemMovements(db: DB, stockItemId: number, from: string, to: string): ItemMovementRow[] {
  const rows = db
    .prepare(
      `SELECT v.id AS voucherId, v.date, v.number, vt.name AS voucherType, vt.kind,
              il.direction, il.qty_milli AS qtyMilli, il.is_absolute AS isAbsolute, il.amount
       FROM inventory_lines il
       JOIN vouchers v ON v.id = il.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE il.stock_item_id = ? AND v.date BETWEEN ? AND ? AND ${IN_BOOKS} AND ${MOVES_STOCK}
       ORDER BY v.date, v.id, il.line_order, il.id`
    )
    .all(stockItemId, from, to) as {
      voucherId: number; date: string; number: string; voucherType: string; kind: string
      direction: 'in' | 'out'; qtyMilli: number; isAbsolute: number; amount: number
    }[]
  return rows.map((r) => ({
    voucherId: r.voucherId,
    date: r.date,
    number: r.number,
    voucherType: r.voucherType,
    kind: r.kind,
    inQtyMilli: r.direction === 'in' ? r.qtyMilli : 0,
    outQtyMilli: r.direction === 'out' ? r.qtyMilli : 0,
    isAbsolute: !!r.isAbsolute,
    amount: r.amount
  }))
}

// ---------- item movement register (WP 2.3) ----------

interface RegisterLineRow {
  lineId: number
  voucherId: number
  date: string
  number: string
  voucherType: string
  kind: string
  partyLedgerId: number | null
  partyName: string | null
  narration: string | null
  godownId: number | null
  godownName: string | null
  batchId: number | null
  batchName: string | null
  expiryDate: string | null
  ratePaise: number
  serials: string | null
}

/**
 * One item's movements in [from, to] with running quantity and value — read off the SAME pass
 * the stock summary runs (company-wide, or one godown's view exactly as stockSummary's godown
 * mode builds it), observed line by line: nothing is re-costed here. In-books semantics are the
 * pass's own (binned / post-dated / optional vouchers never appear). Opening = the pass position
 * just before `from`; closing = the position after `to` — equal to stockSummary(db, to) for the
 * item by construction (dbtest-pinned).
 */
export function stockMovements(db: DB, itemId: number, from: string, to: string, godownId?: number): StockMovementRegister {
  const items = listItems(db)
  const item = items.find((i) => i.id === itemId)
  if (!item) throw new Error('Stock item not found')
  const costing = voucherCosting(db, to)
  const input = godownId
    ? godownPassInput(db, to, godownId, items, costing)
    : { items: toItems(items), movements: loadMovements(db, to).map((r) => toMovement(r)), costing }

  const effects: { lineId: number; date: string; qtyDelta: number; valueDelta: number; qtyAfter: number; valueAfter: number; isAbsolute: boolean; direction: 'in' | 'out' }[] = []
  const { closing, at } = runInventoryPass(input, [{ date: from, voucherId: 0 }], {
    itemId,
    onLine: (e) => {
      if (e.movement.date < from) return
      effects.push({
        lineId: e.movement.lineId!, date: e.movement.date, qtyDelta: e.qtyDelta, valueDelta: e.valueDelta,
        qtyAfter: e.qtyAfter, valueAfter: e.valueAfter, isAbsolute: !!e.movement.isAbsolute, direction: e.movement.direction
      })
    }
  })
  const opening = at[0]!.get(itemId) ?? ZERO
  const end = closing.get(itemId) ?? ZERO

  const meta = new Map(
    (
      db
        .prepare(
          `SELECT il.id AS lineId, v.id AS voucherId, v.date, v.number, vt.name AS voucherType, vt.kind,
                  v.party_ledger_id AS partyLedgerId, pl.name AS partyName, v.narration,
                  il.godown_id AS godownId, g.name AS godownName, il.batch_id AS batchId, b.name AS batchName,
                  b.expiry_date AS expiryDate, il.rate_paise AS ratePaise, il.serials
           FROM inventory_lines il
           JOIN vouchers v ON v.id = il.voucher_id
           JOIN voucher_types vt ON vt.id = v.voucher_type_id
           LEFT JOIN ledgers pl ON pl.id = v.party_ledger_id
           LEFT JOIN godowns g ON g.id = il.godown_id
           LEFT JOIN batches b ON b.id = il.batch_id
           WHERE il.stock_item_id = ? AND v.date BETWEEN ? AND ? AND ${IN_BOOKS} AND ${MOVES_STOCK}`
        )
        .all(itemId, from, to) as RegisterLineRow[]
    ).map((r) => [r.lineId, r])
  )

  const rows: StockMovementRow[] = []
  const totals = { inwardQtyMilli: 0, inwardValue: 0, outwardQtyMilli: 0, outwardValue: 0 }
  for (const e of effects) {
    const m = meta.get(e.lineId)
    if (!m) continue
    const inward = e.isAbsolute ? e.qtyDelta > 0 || (e.qtyDelta === 0 && e.valueDelta > 0) : e.direction === 'in'
    const inwardQtyMilli = inward ? Math.max(0, e.qtyDelta) : 0
    const outwardQtyMilli = inward ? 0 : Math.max(0, -e.qtyDelta)
    const value = inward ? e.valueDelta : -e.valueDelta
    if (inward) {
      totals.inwardQtyMilli += inwardQtyMilli
      totals.inwardValue += value
    } else {
      totals.outwardQtyMilli += outwardQtyMilli
      totals.outwardValue += value
    }
    rows.push({
      lineId: e.lineId, voucherId: m.voucherId, date: m.date, number: m.number, voucherType: m.voucherType, kind: m.kind,
      particulars: m.partyName ?? m.narration ?? '', partyLedgerId: m.partyLedgerId, narration: m.narration,
      godownId: m.godownId, godownName: m.godownName, batchId: m.batchId, batchName: m.batchName, expiryDate: m.expiryDate,
      isAbsolute: e.isAbsolute, inwardQtyMilli, outwardQtyMilli, ratePaise: m.ratePaise, value,
      runningQtyMilli: e.qtyAfter, runningValue: e.valueAfter, serials: parseLineSerials(m.serials)
    })
  }
  return {
    item: { id: item.id, name: item.name, unitSymbol: item.unitSymbol, decimals: item.decimals, valuationMethod: item.valuationMethod },
    from,
    to,
    godownId: godownId ?? null,
    opening: { qtyMilli: opening.closingQtyMilli, value: opening.closingValue },
    rows,
    totals,
    closing: { qtyMilli: end.closingQtyMilli, value: end.closingValue }
  }
}

// ---------- reorder planning (WP 2.3) ----------

/**
 * Items with a reorder level, as of `to`: closing (stock summary), outward quantity over
 * [from, to] from the valuation pass (periodConsumption), average monthly consumption
 * (30-day month, src/shared/stockPlanning.ts) and the suggested order for items below their level:
 * max(0, reorder level × 2 − closing). `onlyBelow` (default) keeps just the items to reorder.
 */
export function reorderPlan(db: DB, from: string, to: string, opts: { onlyBelow?: boolean } = {}): ReorderRow[] {
  const levels = new Map(
    (db.prepare('SELECT id, reorder_level_milli AS r FROM stock_items WHERE reorder_level_milli IS NOT NULL').all() as { id: number; r: number }[])
      .map((x) => [x.id, x.r])
  )
  if (levels.size === 0) return []
  const consumption = periodConsumption(db, from, to)
  const rows: ReorderRow[] = []
  for (const s of stockSummary(db, to)) {
    const level = levels.get(s.stockItemId)
    if (level == null) continue
    const below = isBelowReorder(s.closingQtyMilli, level)
    if ((opts.onlyBelow ?? true) && !below) continue
    const consumedMilli = consumption.get(s.stockItemId)?.outwardQtyMilli ?? 0
    const avgMonthlyMilli = averageMonthlyConsumption(consumedMilli, from, to)
    rows.push({
      stockItemId: s.stockItemId, name: s.name, unitSymbol: s.unitSymbol, decimals: s.decimals, reorderLevelMilli: level,
      closingQtyMilli: s.closingQtyMilli, consumedMilli, avgMonthlyMilli, monthsOfCover: monthsOfCover(s.closingQtyMilli, avgMonthlyMilli),
      below, suggestedMilli: below ? suggestedOrderQty(level, s.closingQtyMilli) : 0
    })
  }
  return rows
}

// ---------- expiry report (WP 2.3) ----------

/** Batches holding stock as of `asOn` that are expired or expire within `withinDays`. */
export function expiryReport(db: DB, asOn: string, withinDays: number): ExpiryReportRow[] {
  return batchStock(db, asOn)
    .filter((r) => r.closingQtyMilli > 0 && r.expiryDate !== null && expiresWithin(r.expiryDate, asOn, withinDays))
    .map((r) => ({
      batchId: r.batchId, batchName: r.batchName, stockItemId: r.stockItemId, itemName: r.itemName, unitSymbol: r.unitSymbol,
      decimals: r.decimals, mfgDate: r.mfgDate, expiryDate: r.expiryDate!, closingQtyMilli: r.closingQtyMilli,
      daysToExpiry: daysToExpiry(r.expiryDate!, asOn)
    }))
    .sort((a, b) => a.daysToExpiry - b.daysToExpiry || a.itemName.localeCompare(b.itemName))
}

// ---------- barcode labels (WP 2.3) ----------

export interface LabelRequest {
  items: { itemId: number; copies: number }[]
  /** Price list to print the rate from (default: the first price list); null = no price. */
  priceLevelId?: number | null
  /** Rate effective on this date. */
  date: string
  caption?: string
}

/** The label sheet HTML (shared/stockPlanning.labelSheetHtml) for the requested items. */
export function labelsHtml(db: DB, req: LabelRequest): string {
  const level =
    req.priceLevelId === undefined
      ? ((db.prepare('SELECT id FROM price_levels ORDER BY id LIMIT 1').get() as { id: number } | undefined)?.id ?? null)
      : req.priceLevelId
  const stmt = db.prepare('SELECT id, name, barcode FROM stock_items WHERE id = ?')
  const labels: LabelItem[] = []
  for (const it of req.items) {
    const row = stmt.get(it.itemId) as { id: number; name: string; barcode: string | null } | undefined
    if (!row) continue
    const rate = level != null ? rateFor(db, level, row.id, req.date) : null
    labels.push({ name: row.name, barcode: row.barcode, priceText: rate != null ? formatPaise(rate, { symbol: true }) : null, copies: it.copies })
  }
  return labelSheetHtml(labels, { caption: req.caption })
}
