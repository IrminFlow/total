import type { DB } from '../db/connection'
import type { TradePurpose } from '@shared/domain'
import type { PendingNoteRow } from '@shared/tradeCycle/types'
import { SHARED_CAPACITY_SOURCES } from '@shared/tradeCycle/rules'
import { hasTradeSchema } from './tradeLinks'
import { NOT_DELETED } from './vouchers'

/** Whole days from `from` to `to` (ISO dates). */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/**
 * Pending stock notes (WP 2.5b, design §5.3): delivery challans not yet invoiced ("goods
 * delivered, not invoiced") or GRNs not yet billed ("received, not billed"), one row per open
 * line, as on a date.
 *
 * A line's done quantity is the live linked quantity — fulfil (invoiced / billed) plus return
 * (rejected), the shared capacity of a stock note — counting only targets dated on or before
 * `asOn`, so the report can be read as of a past date. Short-closed notes, binned and optional
 * (memorandum) notes are not pending. The pending value is the line's own value pro rata
 * (taxable, GST excluded); ageing runs from the note's date.
 */
export function pendingStockNotes(db: DB, stage: 'delivery_note' | 'receipt_note', asOn: string): PendingNoteRow[] {
  if (!hasTradeSchema(db)) return []
  const lines = db
    .prepare(
      `SELECT v.id AS voucherId, v.number, v.date, vt.kind, COALESCE(tvd.purpose, ?) AS purpose,
              v.party_ledger_id AS partyLedgerId, p.name AS partyName,
              il.line_uid AS lineUid, il.line_order AS lineOrder, il.stock_item_id AS stockItemId, si.name AS itemName,
              u.symbol AS unit, il.godown_id AS godownId, g.name AS godownName, il.qty_milli AS qtyMilli,
              il.rate_paise AS ratePaise, il.amount
       FROM inventory_lines il
       JOIN vouchers v ON v.id = il.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN trade_voucher_details tvd ON tvd.voucher_id = v.id
       LEFT JOIN ledgers p ON p.id = v.party_ledger_id
       JOIN stock_items si ON si.id = il.stock_item_id
       LEFT JOIN units u ON u.id = si.unit_id
       LEFT JOIN godowns g ON g.id = il.godown_id
       WHERE vt.kind = ? AND v.date <= ? AND ${NOT_DELETED} AND v.is_optional = 0 AND tvd.closed_at IS NULL
         AND il.is_absolute = 0
       ORDER BY v.date, v.id, il.line_order`
    )
    .all(stage === 'delivery_note' ? 'supply' : 'purchase', stage, asOn) as (Omit<PendingNoteRow, 'doneMilli' | 'pendingMilli' | 'pendingValue' | 'ageDays' | 'lineNo'> & {
      lineOrder: number; amount: number; kind: string; purpose: TradePurpose
    })[]
  if (lines.length === 0) return []
  // Stock notes share capacity between fulfil and return (rules.ts) — both count as done.
  const shared = SHARED_CAPACITY_SOURCES.includes(stage)
  const doneStmt = db.prepare(
    `SELECT COALESCE(SUM(ll.qty_milli), 0) AS q FROM line_links ll
     JOIN vouchers tv ON tv.id = ll.to_voucher_id
     WHERE ll.from_line_uid = ? AND tv.deleted_at IS NULL AND tv.is_optional = 0 AND tv.date <= ?
       ${shared ? '' : "AND ll.link_type = 'fulfil'"}`
  )
  const out: PendingNoteRow[] = []
  for (const l of lines) {
    const done = Math.min(l.qtyMilli, (doneStmt.get(l.lineUid, asOn) as { q: number }).q)
    const pending = l.qtyMilli - done
    if (pending <= 0) continue
    const { lineOrder, amount, kind: _kind, ...rest } = l
    out.push({
      ...rest,
      lineNo: lineOrder + 1,
      doneMilli: done,
      pendingMilli: pending,
      pendingValue: done === 0 ? amount : Math.round((amount * pending) / l.qtyMilli),
      ageDays: Math.max(0, daysBetween(l.date, asOn))
    })
  }
  return out
}
