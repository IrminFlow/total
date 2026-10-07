import type { DB } from '../db/connection'
import type { TradePurpose, VoucherKind } from '@shared/domain'
import type { NoteClosure } from '@shared/tradeCycle/types'
import { hasTradeSchema, liveLinkQty } from './tradeLinks'
import { closeTradeDoc, getTradeDoc } from './tradeDocs'
import { writeAudit } from './audit'

/**
 * Closure (WP 2.5d, design §2.7 / §8 Q1). Doc-level only:
 *  - A challan / GRN is short-closed in trade_voucher_details.closed_at — not a voucher edit, so
 *    saveVoucher never re-runs. A closed note takes no NEW links (tradeLinks I5), its rest stops
 *    being pending (pending reports, GRNI / GDNI), existing links survive. Reopen clears it. Both
 *    are audited on the voucher with the reason.
 *  - Quotations / orders close and reopen through tradeDocs (closeTradeDoc / reopenTradeDoc);
 *    closeStaleQuotations bulk-closes quotations past their validity.
 * Returns never re-open anything (design Q11): closure is only ever by hand.
 */

interface NoteRow {
  id: number
  kind: VoucherKind
  typeName: string
  number: string
  deletedAt: string | null
  isOptional: number
  purpose: TradePurpose | null
  closedAt: string | null
  closeReason: string | null
}

function noteRow(db: DB, voucherId: number): NoteRow {
  const r = db
    .prepare(
      `SELECT v.id, vt.kind, vt.name AS typeName, v.number, v.deleted_at AS deletedAt, v.is_optional AS isOptional,
              tvd.purpose, tvd.closed_at AS closedAt, tvd.close_reason AS closeReason
       FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN trade_voucher_details tvd ON tvd.voucher_id = v.id WHERE v.id = ?`
    )
    .get(voucherId) as NoteRow | undefined
  if (!r) throw new Error('Voucher not found')
  if (r.kind !== 'delivery_note' && r.kind !== 'receipt_note') throw new Error('Only a delivery challan or goods receipt note can be closed')
  return r
}

/** trade:noteClosure — a challan / GRN's manual close state. */
export function noteClosure(db: DB, voucherId: number): NoteClosure {
  if (!hasTradeSchema(db)) return { closedAt: null, closeReason: null }
  const r = db.prepare('SELECT closed_at AS closedAt, close_reason AS closeReason FROM trade_voucher_details WHERE voucher_id = ?').get(voucherId) as
    | NoteClosure
    | undefined
  return r ?? { closedAt: null, closeReason: null }
}

/** trade:closeVoucher — short-close a challan / GRN: what is not yet invoiced / billed (or
 *  returned) stops being pending. Refused when binned, optional, already closed, or nothing is
 *  pending. */
export function closeStockNote(db: DB, voucherId: number, reason: string | null): NoteClosure {
  const n = noteRow(db, voucherId)
  const name = `${n.typeName} ${n.number}`
  if (n.deletedAt) throw new Error(`${name} is in the bin`)
  if (n.isOptional) throw new Error(`${name} is an optional (memorandum) voucher — nothing on it is pending`)
  if (n.closedAt) throw new Error(`${name} is already closed`)
  const lines = db.prepare('SELECT line_uid AS uid, qty_milli AS q FROM inventory_lines WHERE voucher_id = ? AND is_absolute = 0').all(voucherId) as
    { uid: string; q: number }[]
  const used = liveLinkQty(db, lines.map((l) => l.uid))
  const pending = lines.some((l) => {
    const u = used.get(l.uid)
    return l.q - (u ? u.fulfilMilli + u.returnMilli : 0) > 0
  })
  if (!pending) throw new Error(`Everything on ${name} is already ${n.kind === 'delivery_note' ? 'invoiced or returned' : 'billed or returned'}`)
  const purpose: TradePurpose = n.purpose ?? (n.kind === 'delivery_note' ? 'supply' : 'purchase')
  db.transaction(() => {
    db.prepare(
      `INSERT INTO trade_voucher_details (voucher_id, purpose, closed_at, close_reason) VALUES (?, ?, datetime('now'), ?)
       ON CONFLICT(voucher_id) DO UPDATE SET closed_at = excluded.closed_at, close_reason = excluded.close_reason`
    ).run(voucherId, purpose, reason)
    writeAudit(db, 'voucher', voucherId, 'update', { closedAt: null }, { action: 'close', reason })
  })()
  return noteClosure(db, voucherId)
}

/** trade:reopenVoucher — undo a short-close; the reason (optional) goes on the audit trail. */
export function reopenStockNote(db: DB, voucherId: number, reason: string | null): NoteClosure {
  const n = noteRow(db, voucherId)
  const name = `${n.typeName} ${n.number}`
  if (n.deletedAt) throw new Error(`${name} is in the bin`)
  if (!n.closedAt) throw new Error(`${name} is not closed`)
  db.transaction(() => {
    db.prepare('UPDATE trade_voucher_details SET closed_at = NULL, close_reason = NULL WHERE voucher_id = ?').run(voucherId)
    writeAudit(db, 'voucher', voucherId, 'update', { closedAt: n.closedAt, closeReason: n.closeReason }, { action: 'reopen', reason })
  })()
  return noteClosure(db, voucherId)
}

/** Open quotations past their validity on `asOn` that are not fully converted. */
export function staleQuotationIds(db: DB, asOn: string): number[] {
  if (!hasTradeSchema(db)) return []
  const ids = db
    .prepare(
      `SELECT td.id FROM trade_docs td JOIN trade_doc_types tt ON tt.id = td.doc_type_id
       WHERE tt.kind = 'quotation' AND td.deleted_at IS NULL AND td.status = 'open' AND td.valid_until IS NOT NULL AND td.valid_until < ?
       ORDER BY td.date, td.id`
    )
    .all(asOn) as { id: number }[]
  return ids.map((r) => r.id).filter((id) => getTradeDoc(db, id, asOn)?.status !== 'fulfilled')
}

/**
 * trade:closeStaleQuotations — close ("lost") every quotation past its validity, or only `ids`
 * among them. Each close is the ordinary tradeDocs close (audited per document); one that no longer
 * qualifies is skipped, not refused, so a stale list can be closed in one go.
 */
export function closeStaleQuotations(db: DB, q: { asOn: string; ids?: number[]; reason?: string | null }): { closed: number[] } {
  const stale = new Set(staleQuotationIds(db, q.asOn))
  const wanted = q.ids ? q.ids.filter((id) => stale.has(id)) : [...stale]
  const reason = q.reason?.trim() || 'Validity expired'
  const closed: number[] = []
  db.transaction(() => {
    for (const id of wanted) {
      closeTradeDoc(db, id, reason)
      closed.push(id)
    }
  })()
  return { closed }
}
