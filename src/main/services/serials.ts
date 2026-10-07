import type { DB } from '../db/connection'
import { toDisplayDate } from '@shared/dates'
import { voucherSerialErrors, walkSerials, type SerialEvent, type SerialLine, type SerialStatus } from '@shared/serials'
import type { VoucherKind } from '@shared/domain'
import type { SerialListRow } from '@shared/stockPlanning'
import { MOVES_STOCK, NOT_DELETED, NOT_OPTIONAL } from './vouchers'
import { hasTradeSchema } from './tradeLinks'

/**
 * Serial numbers (WP 2.3). The rules are pure (src/shared/serials.ts); this module persists a
 * line's serials (inventory_lines.serials, JSON) and keeps the `serial_numbers` projection in
 * step: per item, re-walk every live line's serials in voucher order and replace the item's rows.
 * Live = not binned and not optional (NOT_DELETED / NOT_OPTIONAL); post-dated vouchers count —
 * they reserve their serials. Every caller runs inside the voucher's own transaction, so a
 * conflict thrown here rolls the save / bin / restore back.
 */

const serialSchemaSeen = new WeakSet<DB>()

/** Migration 021 applied? Only data-migration tests ever save vouchers on an older schema (a
 *  partially migrated fixture); there the serial step is skipped. Positive answers are cached. */
function hasSerialSchema(db: DB): boolean {
  if (serialSchemaSeen.has(db)) return true
  const ok = (db.prepare('PRAGMA table_info(stock_items)').all() as { name: string }[]).some((c) => c.name === 'track_serials')
  if (ok) serialSchemaSeen.add(db)
  return ok
}

/** inventory_lines.serials → string[] (NULL / junk = none). */
export function parseLineSerials(json: string | null | undefined): string[] {
  if (!json) return []
  try {
    const v = JSON.parse(json) as unknown
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
  } catch {
    return []
  }
}

/** Serial-tracked items among `ids`, with their names. */
export function trackedItems(db: DB, ids: readonly number[]): Map<number, string> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const rows = db
    .prepare(`SELECT id, name FROM stock_items WHERE track_serials = 1 AND id IN (${unique.map(() => '?').join(',')})`)
    .all(...unique) as { id: number; name: string }[]
  return new Map(rows.map((r) => [r.id, r.name]))
}

interface WalkRow {
  lineId: number
  voucherId: number
  stockItemId: number
  direction: 'in' | 'out'
  serials: string | null
  godownId: number | null
  batchId: number | null
  kind: VoucherKind
  typeName: string
  number: string
  date: string
}

/**
 * Re-project `serial_numbers` for the given items: tracked items are re-walked from their live
 * line serials (throws on the first conflict); untracked items lose their rows.
 */
export function rebuildItemSerials(db: DB, itemIds: readonly number[]): void {
  const unique = [...new Set(itemIds)]
  if (unique.length === 0 || !hasSerialSchema(db)) return
  const tracked = trackedItems(db, unique)
  const del = db.prepare('DELETE FROM serial_numbers WHERE stock_item_id = ?')
  for (const id of unique) del.run(id)
  if (tracked.size === 0) return
  const ids = [...tracked.keys()]
  // WP 2.5: an invoice line whose goods moved on its challan names the serials (they print) but
  // moves none — only stock-moving lines walk.
  const trade = hasTradeSchema(db)
  const rows = db
    .prepare(
      `SELECT il.id AS lineId, il.voucher_id AS voucherId, il.stock_item_id AS stockItemId, il.direction, il.serials,
              il.godown_id AS godownId, il.batch_id AS batchId, vt.kind, vt.name AS typeName, v.number, v.date
       FROM inventory_lines il
       JOIN vouchers v ON v.id = il.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE il.stock_item_id IN (${ids.map(() => '?').join(',')}) AND il.serials IS NOT NULL AND il.is_absolute = 0
         AND ${NOT_DELETED} AND ${NOT_OPTIONAL} ${trade ? `AND ${MOVES_STOCK}` : ''}
       ORDER BY v.date, v.id, il.direction = 'in', il.line_order, il.id`
    )
    .all(...ids) as WalkRow[]
  const events: SerialEvent[] = []
  for (const r of rows) {
    const label = `${r.typeName} ${r.number} (${toDisplayDate(r.date)})`
    for (const serial of parseLineSerials(r.serials)) {
      events.push({
        stockItemId: r.stockItemId, serial, direction: r.direction, lineId: r.lineId, voucherId: r.voucherId,
        voucherLabel: label, kind: r.kind, godownId: r.godownId, batchId: r.batchId
      })
    }
  }
  const walk = walkSerials(events, (id) => tracked.get(id) ?? 'Item')
  if (!walk.ok) throw new Error(walk.error)
  // §9 Q7: out on a challan = 'delivered'; 'sold' once a live invoice line linked to the
  // challan line names the serial.
  // A challan that sends rejected goods back to the supplier (a return of a GRN line) → 'returned'.
  const invoiced = trade ? invoicedSerialKeys(db, ids) : new Set<string>()
  const rejectedOut = trade ? returnLineIds(db, ids) : new Set<number>()
  for (const r of walk.records) {
    if (r.status !== 'delivered') continue
    if (r.outwardLineId != null && rejectedOut.has(r.outwardLineId)) r.status = 'returned'
    else if (invoiced.has(`${r.stockItemId}|${r.serial}`)) r.status = 'sold'
  }
  const ins = db.prepare(
    `INSERT INTO serial_numbers (stock_item_id, serial, batch_id, godown_id, status, inward_line_id, outward_line_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  for (const r of walk.records) {
    ins.run(r.stockItemId, r.serial, r.batchId, r.godownId, r.status, r.inwardLineId, r.outwardLineId)
  }
}

/** Inventory line ids (of these items) that are the target of a return link. */
function returnLineIds(db: DB, itemIds: readonly number[]): Set<number> {
  const rows = db
    .prepare(
      `SELECT il.id FROM inventory_lines il JOIN line_links ll ON ll.to_line_uid = il.line_uid AND ll.link_type = 'return'
       WHERE il.stock_item_id IN (${itemIds.map(() => '?').join(',')}) AND ${MOVES_STOCK}`
    )
    .all(...itemIds) as { id: number }[]
  return new Set(rows.map((r) => r.id))
}

/** item|serial keys named by live, non-moving sales lines that fulfil a challan line. */
function invoicedSerialKeys(db: DB, itemIds: readonly number[]): Set<string> {
  const rows = db
    .prepare(
      `SELECT il.stock_item_id AS stockItemId, il.serials
       FROM inventory_lines il
       JOIN vouchers v ON v.id = il.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN line_links ll ON ll.to_line_uid = il.line_uid AND ll.link_type = 'fulfil'
       WHERE il.moves_stock = 0 AND il.serials IS NOT NULL AND vt.kind = 'sales'
         AND il.stock_item_id IN (${itemIds.map(() => '?').join(',')}) AND ${NOT_DELETED} AND ${NOT_OPTIONAL}`
    )
    .all(...itemIds) as { stockItemId: number; serials: string }[]
  const out = new Set<string>()
  for (const r of rows) for (const s of parseLineSerials(r.serials)) out.add(`${r.stockItemId}|${s}`)
  return out
}

/**
 * The saveVoucher step (called right after the voucher's inventory lines are inserted, inside its
 * transaction): validate the line serials of tracked items (count = whole units, no duplicates),
 * store them on the lines (dropping serials of untracked items), then re-project every item the
 * voucher touched — now or before this edit.
 */
export function syncVoucherSerials(
  db: DB,
  voucherId: number,
  inventory: readonly SerialLine[],
  previous: readonly { stockItemId: number }[] = []
): void {
  if (!hasSerialSchema(db)) return
  const tracked = trackedItems(db, inventory.map((l) => l.stockItemId))
  const errors = voucherSerialErrors(inventory, tracked)
  if (errors.length > 0) throw new Error(errors.join('; '))
  const update = db.prepare('UPDATE inventory_lines SET serials = ? WHERE voucher_id = ? AND line_order = ?')
  inventory.forEach((l, i) => {
    const keep = tracked.has(l.stockItemId) && !l.isAbsolute && (l.serials?.length ?? 0) > 0
    if (keep) update.run(JSON.stringify(l.serials), voucherId, i)
  })
  rebuildItemSerials(db, [...inventory.map((l) => l.stockItemId), ...previous.map((l) => l.stockItemId)])
}

export type SerialRow = SerialListRow

/** Serial register rows — every serial of an item (or all items), optionally one status. */
export function listSerials(db: DB, q: { stockItemId?: number; status?: SerialStatus } = {}): SerialRow[] {
  const where: string[] = []
  const args: (number | string)[] = []
  if (q.stockItemId) {
    where.push('sn.stock_item_id = ?')
    args.push(q.stockItemId)
  }
  if (q.status) {
    where.push('sn.status = ?')
    args.push(q.status)
  }
  const rows = db
    .prepare(
      `SELECT sn.stock_item_id AS stockItemId, si.name AS itemName, sn.serial, sn.status,
              sn.godown_id AS godownId, g.name AS godownName, sn.batch_id AS batchId, b.name AS batchName,
              il_in.voucher_id AS inwardVoucherId, vt_in.name || ' ' || v_in.number AS inwardName, v_in.date AS inwardDate,
              il_out.voucher_id AS outwardVoucherId, vt_out.name || ' ' || v_out.number AS outwardName, v_out.date AS outwardDate
       FROM serial_numbers sn
       JOIN stock_items si ON si.id = sn.stock_item_id
       JOIN inventory_lines il_in ON il_in.id = sn.inward_line_id
       JOIN vouchers v_in ON v_in.id = il_in.voucher_id
       JOIN voucher_types vt_in ON vt_in.id = v_in.voucher_type_id
       LEFT JOIN inventory_lines il_out ON il_out.id = sn.outward_line_id
       LEFT JOIN vouchers v_out ON v_out.id = il_out.voucher_id
       LEFT JOIN voucher_types vt_out ON vt_out.id = v_out.voucher_type_id
       LEFT JOIN godowns g ON g.id = sn.godown_id
       LEFT JOIN batches b ON b.id = sn.batch_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY si.name, sn.serial`
    )
    .all(...args) as (Omit<SerialRow, 'inwardLabel' | 'outwardLabel'> & {
      inwardName: string; inwardDate: string; outwardName: string | null; outwardDate: string | null
    })[]
  return rows.map(({ inwardName, inwardDate, outwardName, outwardDate, ...r }) => ({
      ...r,
      inwardLabel: `${inwardName} · ${toDisplayDate(inwardDate)}`,
      outwardLabel: outwardName && outwardDate ? `${outwardName} · ${toDisplayDate(outwardDate)}` : null
    }))
}

/**
 * Serials an outward line of `stockItemId` may pick: those in stock, plus — when altering
 * `voucherId` — the ones that voucher itself took out (they return to stock if deselected).
 */
export function availableSerials(db: DB, stockItemId: number, voucherId?: number): string[] {
  const rows = db
    .prepare(
      `SELECT sn.serial FROM serial_numbers sn
       LEFT JOIN inventory_lines il ON il.id = sn.outward_line_id
       WHERE sn.stock_item_id = ? AND (sn.status = 'in_stock' OR (? IS NOT NULL AND il.voucher_id = ?))
       ORDER BY sn.serial`
    )
    .all(stockItemId, voucherId ?? null, voucherId ?? null) as { serial: string }[]
  return rows.map((r) => r.serial)
}
