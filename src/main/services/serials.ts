import type { DB } from '../db/connection'
import {
  normaliseSerial,
  planSerialMovement,
  statusAfter,
  type SerialMovementFact,
  type SerialStatus
} from '@shared/serials'

/**
 * Serial-number tracking (roadmap E #115) — the half that needs a database.
 *
 * The rules (what a serial may be, whether a set of them matches a quantity, which movements are
 * legal) are all in `@shared/serials` and tested there. This file gathers the facts those rules
 * need, writes the movements, and derives status from them.
 *
 * **Status is derived, never stored.** `serialStatus` reads the latest movement. A `status` column
 * would be a second copy of a fact the movements already carry, and the two would part company the
 * first time a voucher was altered — which is exactly when the answer matters, because altering
 * the invoice that sold a unit is how the unit comes back into stock.
 */

export interface SerialLineInput {
  stockItemId: number
  direction: 'in' | 'out'
  qtyMilli: number
  /** Already normalised by the caller or not — this module normalises again, cheaply. */
  serials: string[]
}

interface SerialRow {
  id: number
  stockItemId: number
  serial: string
}

/** The serials in `serials`, whatever item they belong to, with their current status. */
export function serialFacts(db: DB, serials: string[]): Map<string, SerialMovementFact> {
  const out = new Map<string, SerialMovementFact>()
  if (serials.length === 0) return out
  const placeholders = serials.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT sn.id, sn.stock_item_id AS stockItemId, sn.serial,
              (SELECT sm.direction FROM serial_movements sm
                 JOIN vouchers v ON v.id = sm.voucher_id
                WHERE sm.serial_id = sn.id AND v.deleted_at IS NULL
                ORDER BY sm.moved_on DESC, sm.id DESC LIMIT 1) AS lastDirection
         FROM serial_numbers sn
        WHERE sn.serial IN (${placeholders})`
    )
    .all(...serials) as (SerialRow & { lastDirection: 'in' | 'out' | null })[]
  for (const r of rows) {
    out.set(normaliseSerial(r.serial), {
      serial: normaliseSerial(r.serial),
      // No live movement at all — the voucher that received it is in the bin — is the same
      // situation as never having been received: there is nothing on the shelf to sell.
      status: r.lastDirection === null ? null : statusAfter(r.lastDirection),
      stockItemId: r.stockItemId
    })
  }
  return out
}

/**
 * Check every serial-tracked line of a voucher at once, and say everything that is wrong.
 *
 * One pass over all the lines rather than a check per line, because the facts come from one query
 * and because a nine-line invoice with three bad serials must not be refused three times.
 */
export function checkSerialLines(db: DB, lines: SerialLineInput[], names?: Map<number, string>): string[] {
  const all = [...new Set(lines.flatMap((l) => l.serials.map(normaliseSerial)))]
  const facts = serialFacts(db, all)
  const errors: string[] = []
  // A serial named twice on the SAME voucher is not caught by the facts map — nothing is written
  // yet, so the second occurrence still looks free. Caught here instead.
  const seen = new Set<string>()
  for (const line of lines) {
    for (const s of line.serials.map(normaliseSerial)) {
      if (seen.has(s)) errors.push(`${s} appears twice on this voucher`)
      seen.add(s)
    }
    errors.push(
      ...planSerialMovement({
        direction: line.direction,
        stockItemId: line.stockItemId,
        qtyMilli: line.qtyMilli,
        serials: line.serials.map(normaliseSerial),
        facts,
        itemName: names?.get(line.stockItemId)
      }).errors
    )
  }
  return errors
}

/** Which of these items are serial-tracked. One query, so a fifty-line invoice asks once. */
export function serialTrackedItems(db: DB, stockItemIds: number[]): Set<number> {
  if (stockItemIds.length === 0) return new Set()
  const placeholders = stockItemIds.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT id FROM stock_items WHERE track_serials = 1 AND id IN (${placeholders})`)
    .all(...stockItemIds) as { id: number }[]
  return new Set(rows.map((r) => r.id))
}

/** Names for the error messages, so a refusal says "Compressor 2 HP" rather than "item 14". */
export function itemNames(db: DB, stockItemIds: number[]): Map<number, string> {
  if (stockItemIds.length === 0) return new Map()
  const placeholders = stockItemIds.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT id, name FROM stock_items WHERE id IN (${placeholders})`)
    .all(...stockItemIds) as { id: number; name: string }[]
  return new Map(rows.map((r) => [r.id, r.name]))
}

/**
 * Record the movements for one voucher, replacing whatever it recorded before.
 *
 * Replace-not-append, matching how `saveVoucher` treats lines: an alteration that drops a serial
 * from an invoice has to un-issue it, and appending would leave the old movement in place saying
 * it went out. Called INSIDE the save transaction, so a later failure takes the movements with it.
 */
export function writeSerialMovements(
  db: DB,
  voucherId: number,
  date: string,
  lines: SerialLineInput[],
  context: { partyLedgerId?: number | null; godownId?: number | null; ratePaise?: number } = {}
): void {
  db.prepare('DELETE FROM serial_movements WHERE voucher_id = ?').run(voucherId)
  const findSerial = db.prepare('SELECT id FROM serial_numbers WHERE stock_item_id = ? AND serial = ?')
  const insertSerial = db.prepare(
    'INSERT INTO serial_numbers (stock_item_id, serial, original_text) VALUES (?, ?, ?)'
  )
  const insertMovement = db.prepare(
    `INSERT INTO serial_movements (serial_id, voucher_id, direction, moved_on, rate_paise, party_ledger_id, godown_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  for (const line of lines) {
    for (const raw of line.serials) {
      const key = normaliseSerial(raw)
      const existing = findSerial.get(line.stockItemId, key) as { id: number } | undefined
      const serialId =
        existing?.id ?? Number(insertSerial.run(line.stockItemId, key, raw.trim()).lastInsertRowid)
      insertMovement.run(
        serialId,
        voucherId,
        line.direction,
        date,
        context.ratePaise ?? 0,
        context.partyLedgerId ?? null,
        context.godownId ?? null
      )
    }
  }
}

export interface SerialRecord {
  id: number
  serial: string
  originalText: string
  stockItemId: number
  itemName: string
  status: SerialStatus
  /** The last movement — where it went, when, and to whom. */
  lastMovedOn: string
  lastVoucherId: number
  lastVoucherNumber: string
  lastVoucherType: string
  partyName: string | null
  ratePaise: number
}

const SERIAL_SELECT = `
  SELECT sn.id, sn.serial, sn.original_text AS originalText, sn.stock_item_id AS stockItemId,
         si.name AS itemName, sm.direction, sm.moved_on AS lastMovedOn, sm.rate_paise AS ratePaise,
         v.id AS lastVoucherId, v.number AS lastVoucherNumber, vt.name AS lastVoucherType,
         l.name AS partyName
    FROM serial_numbers sn
    JOIN stock_items si ON si.id = sn.stock_item_id
    JOIN serial_movements sm ON sm.id = (
      SELECT m.id FROM serial_movements m
        JOIN vouchers mv ON mv.id = m.voucher_id
       WHERE m.serial_id = sn.id AND mv.deleted_at IS NULL
       ORDER BY m.moved_on DESC, m.id DESC LIMIT 1
    )
    JOIN vouchers v ON v.id = sm.voucher_id
    JOIN voucher_types vt ON vt.id = v.voucher_type_id
    LEFT JOIN ledgers l ON l.id = COALESCE(sm.party_ledger_id, v.party_ledger_id)
   WHERE v.deleted_at IS NULL`

function mapSerial(r: Record<string, unknown>): SerialRecord {
  return {
    id: r.id as number,
    serial: r.serial as string,
    originalText: r.originalText as string,
    stockItemId: r.stockItemId as number,
    itemName: r.itemName as string,
    status: statusAfter(r.direction as 'in' | 'out'),
    lastMovedOn: r.lastMovedOn as string,
    lastVoucherId: r.lastVoucherId as number,
    lastVoucherNumber: r.lastVoucherNumber as string,
    lastVoucherType: r.lastVoucherType as string,
    partyName: (r.partyName as string | null) ?? null,
    ratePaise: r.ratePaise as number
  }
}

export interface SerialQuery {
  stockItemId?: number | null
  status?: SerialStatus | 'all'
  /** Substring of the serial, for the "customer read me a number over the phone" case. */
  search?: string | null
  limit?: number
}

/** The serial register: what exists, where each one is, and what it last did. */
export function listSerials(db: DB, query: SerialQuery = {}): SerialRecord[] {
  const clauses: string[] = []
  const params: unknown[] = []
  if (query.stockItemId != null) {
    clauses.push('sn.stock_item_id = ?')
    params.push(query.stockItemId)
  }
  if (query.search) {
    clauses.push('sn.serial LIKE ?')
    params.push(`%${normaliseSerial(query.search)}%`)
  }
  if (query.status && query.status !== 'all') {
    clauses.push('sm.direction = ?')
    params.push(query.status === 'in_stock' ? 'in' : 'out')
  }
  const where = clauses.length ? ` AND ${clauses.join(' AND ')}` : ''
  const rows = db
    .prepare(`${SERIAL_SELECT}${where} ORDER BY si.name, sn.serial LIMIT ?`)
    .all(...params, query.limit ?? 500) as Record<string, unknown>[]
  return rows.map(mapSerial)
}

export interface SerialHistoryEntry {
  voucherId: number
  voucherNumber: string
  voucherType: string
  direction: 'in' | 'out'
  movedOn: string
  partyName: string | null
  ratePaise: number
  godownName: string | null
}

/**
 * Everything that ever happened to one serial, oldest first.
 *
 * This is the screen a warranty claim is answered from: bought on this bill at this cost, sold on
 * that invoice to that customer on that date. Binned vouchers are excluded — a movement recorded
 * by an entry that no longer exists is not history, it is a deleted mistake.
 */
export function serialHistory(db: DB, serialId: number): SerialHistoryEntry[] {
  return db
    .prepare(
      `SELECT v.id AS voucherId, v.number AS voucherNumber, vt.name AS voucherType,
              sm.direction, sm.moved_on AS movedOn, sm.rate_paise AS ratePaise,
              l.name AS partyName, g.name AS godownName
         FROM serial_movements sm
         JOIN vouchers v ON v.id = sm.voucher_id
         JOIN voucher_types vt ON vt.id = v.voucher_type_id
         LEFT JOIN ledgers l ON l.id = COALESCE(sm.party_ledger_id, v.party_ledger_id)
         LEFT JOIN godowns g ON g.id = sm.godown_id
        WHERE sm.serial_id = ? AND v.deleted_at IS NULL
        ORDER BY sm.moved_on, sm.id`
    )
    .all(serialId) as SerialHistoryEntry[]
}

/** How many of each item's serials are on the shelf — the number the stock summary can be
 *  checked against, and the one that disagrees when somebody keys a quantity without serials. */
export function serialCounts(db: DB): { stockItemId: number; itemName: string; inStock: number; issued: number }[] {
  return db
    .prepare(
      `SELECT sn.stock_item_id AS stockItemId, si.name AS itemName,
              SUM(CASE WHEN sm.direction = 'in' THEN 1 ELSE 0 END) AS inStock,
              SUM(CASE WHEN sm.direction = 'out' THEN 1 ELSE 0 END) AS issued
         FROM serial_numbers sn
         JOIN stock_items si ON si.id = sn.stock_item_id
         JOIN serial_movements sm ON sm.id = (
           SELECT m.id FROM serial_movements m
             JOIN vouchers mv ON mv.id = m.voucher_id
            WHERE m.serial_id = sn.id AND mv.deleted_at IS NULL
            ORDER BY m.moved_on DESC, m.id DESC LIMIT 1
         )
        GROUP BY sn.stock_item_id, si.name
        ORDER BY si.name`
    )
    .all() as { stockItemId: number; itemName: string; inStock: number; issued: number }[]
}
