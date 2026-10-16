import type { DB } from '../db/connection'
import type { LinkType, TradePurpose, VoucherKind } from '@shared/domain'
import type { NoteListFilter, NoteListStatus, NoteListTarget, StockNoteListRow } from '@shared/tradeCycle/types'
import { convertiblePurpose, type NoteStage } from '@shared/tradeCycle/convert'
import { hasTradeSchema } from './tradeLinks'
import { NOT_DELETED } from './vouchers'

/**
 * The challan / GRN list screens (WP 2.5b lists, trade:noteList): one row per delivery challan /
 * GRN with its items, quantities, what is still pending, its status and the documents drawing on
 * it — all computed from the notes and their LIVE links at query time; the only stored state is
 * the short-close (`trade_voucher_details.closed_at`).
 *
 * The pending figures follow the pending reports (tradeReports.pendingStockNotes, and so GRNI /
 * GDNI) exactly: a line's done quantity is every live link drawing on it (fulfil + return — a
 * stock note's shared capacity) from a voucher dated on or before `asOn`, capped at the line; a
 * short-closed note has nothing pending; the pending value is the line's value pro rata. Optional
 * (memorandum) and binned notes are not listed.
 *
 * `filter` 'pending' lists every note dated on or before `asOn` with something pending (like the
 * pending report — an old challan still to invoice is shown whatever the period); 'closed' (fully
 * invoiced / billed, or short-closed) and 'all' list the notes dated `from`..`to`.
 */
export function listStockNotes(
  db: DB,
  q: { stage: NoteStage; from: string; to: string; asOn?: string; filter: NoteListFilter }
): StockNoteListRow[] {
  if (!hasTradeSchema(db)) return []
  const asOn = q.asOn ?? q.to
  const fromDate = q.filter === 'pending' ? '0000-01-01' : q.from
  const toDate = q.filter === 'pending' ? asOn : q.to
  const notes = db
    .prepare(
      `SELECT v.id AS voucherId, v.number, v.date, COALESCE(tvd.purpose, ?) AS purpose, v.party_ledger_id AS partyLedgerId,
              p.name AS partyName, tvd.closed_at AS closedAt, tvd.close_reason AS closeReason
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN trade_voucher_details tvd ON tvd.voucher_id = v.id
       LEFT JOIN ledgers p ON p.id = v.party_ledger_id
       WHERE vt.kind = ? AND v.date BETWEEN ? AND ? AND ${NOT_DELETED} AND v.is_optional = 0
       ORDER BY v.date, v.id`
    )
    .all(q.stage === 'delivery_note' ? 'supply' : 'purchase', q.stage, fromDate, toDate) as {
    voucherId: number; number: string; date: string; purpose: TradePurpose; partyLedgerId: number | null
    partyName: string | null; closedAt: string | null; closeReason: string | null
  }[]
  if (notes.length === 0) return []

  interface Line { voucherId: number; lineUid: string; itemName: string; unit: string | null; unitId: number | null; decimals: number; qtyMilli: number; amount: number }
  const linesByNote = new Map<number, Line[]>()
  const doneByUid = new Map<string, number>()
  const targetsByNote = new Map<number, NoteListTarget[]>()
  // Batched in chunks of 500 notes (WP 7.1: never one query per row).
  for (let i = 0; i < notes.length; i += 500) {
    const ids = notes.slice(i, i + 500).map((n) => n.voucherId)
    const marks = ids.map(() => '?').join(',')
    const lines = db
      .prepare(
        `SELECT il.voucher_id AS voucherId, il.line_uid AS lineUid, si.name AS itemName, u.symbol AS unit, si.unit_id AS unitId,
                COALESCE(u.decimals, 3) AS decimals, il.qty_milli AS qtyMilli, il.amount
         FROM inventory_lines il
         JOIN stock_items si ON si.id = il.stock_item_id
         LEFT JOIN units u ON u.id = si.unit_id
         WHERE il.voucher_id IN (${marks}) AND il.is_absolute = 0
         ORDER BY il.voucher_id, il.line_order`
      )
      .all(...ids) as Line[]
    for (const l of lines) {
      const list = linesByNote.get(l.voucherId)
      if (list) list.push(l)
      else linesByNote.set(l.voucherId, [l])
    }
    const done = db
      .prepare(
        `SELECT ll.from_line_uid AS uid, SUM(ll.qty_milli) AS q
         FROM line_links ll JOIN vouchers tv ON tv.id = ll.to_voucher_id
         WHERE ll.from_voucher_id IN (${marks}) AND tv.deleted_at IS NULL AND tv.is_optional = 0 AND tv.date <= ?
         GROUP BY ll.from_line_uid`
      )
      .all(...ids, asOn) as { uid: string; q: number }[]
    for (const d of done) doneByUid.set(d.uid, d.q)
    const targets = db
      .prepare(
        `SELECT DISTINCT ll.from_voucher_id AS noteId, tv.id AS voucherId, tv.number, tvt.kind, tv.date, ll.link_type AS linkType
         FROM line_links ll
         JOIN vouchers tv ON tv.id = ll.to_voucher_id
         JOIN voucher_types tvt ON tvt.id = tv.voucher_type_id
         WHERE ll.from_voucher_id IN (${marks}) AND tv.deleted_at IS NULL AND tv.is_optional = 0 AND tv.date <= ?
         ORDER BY tv.date, tv.id, ll.link_type`
      )
      .all(...ids, asOn) as (NoteListTarget & { noteId: number })[]
    for (const { noteId, ...t } of targets) {
      const list = targetsByNote.get(noteId)
      if (list) list.push(t)
      else targetsByNote.set(noteId, [t])
    }
  }

  const out: StockNoteListRow[] = []
  for (const n of notes) {
    const lines = linesByNote.get(n.voucherId) ?? []
    const closed = n.closedAt != null
    let total = 0
    let pendingQty = 0
    let doneQty = 0
    let value = 0
    let pendingValue = 0
    let pendingLines = 0
    for (const l of lines) {
      const done = Math.min(l.qtyMilli, doneByUid.get(l.lineUid) ?? 0)
      const pending = closed ? 0 : l.qtyMilli - done
      total += l.qtyMilli
      doneQty += done
      value += l.amount
      if (pending > 0) {
        pendingQty += pending
        pendingLines += 1
        pendingValue += done === 0 ? l.amount : Math.round((l.amount * pending) / l.qtyMilli)
      }
    }
    const status: NoteListStatus = closed ? 'closed' : pendingQty === 0 ? 'done' : doneQty === 0 ? 'pending' : 'partly'
    if (q.filter === 'pending' && status !== 'pending' && status !== 'partly') continue
    if (q.filter === 'closed' && status !== 'done' && status !== 'closed') continue
    const oneUnit = lines.length > 0 && lines.every((l) => l.unitId === lines[0]!.unitId)
    out.push({
      voucherId: n.voucherId, number: n.number, date: n.date, purpose: n.purpose, partyLedgerId: n.partyLedgerId, partyName: n.partyName,
      lineCount: lines.length,
      items: [...new Set(lines.map((l) => l.itemName))].join(', '),
      qtyMilli: oneUnit ? total : null,
      pendingMilli: oneUnit ? pendingQty : null,
      unit: oneUnit ? lines[0]!.unit : null,
      decimals: oneUnit ? lines[0]!.decimals : 3,
      pendingLines, value, pendingValue, status,
      closedAt: n.closedAt, closeReason: n.closeReason,
      targets: (targetsByNote.get(n.voucherId) ?? []) as { voucherId: number; number: string; kind: VoucherKind; date: string; linkType: LinkType }[],
      convertible: pendingLines > 0 && convertiblePurpose(q.stage, n.purpose)
    })
  }
  return out
}
