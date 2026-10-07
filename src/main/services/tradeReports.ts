import type { DB } from '../db/connection'
import type { TradePurpose } from '@shared/domain'
import type {
  PendingNoteRow, PendingOrderRow, QuotationOutcome, QuotationPipeline, QuotationPipelineRow
} from '@shared/tradeCycle/types'
import { SHARED_CAPACITY_SOURCES } from '@shared/tradeCycle/rules'
import { hasTradeSchema } from './tradeLinks'
import { NOT_DELETED } from './vouchers'
import { getTradeDoc } from './tradeDocs'

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
              u.symbol AS unit, COALESCE(u.decimals, 3) AS decimals, il.godown_id AS godownId, g.name AS godownName, il.qty_milli AS qtyMilli,
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

/**
 * Pending sales / purchase orders (WP 2.5c): one row per open order line with what is still to
 * deliver / receive, as on a date. Done = live fulfilment (challan, invoice, GRN, bill — never a
 * return: returns don't re-open an order, design Q11) by documents dated on or before `asOn`.
 * Closed (short-closed), cancelled and binned orders are not pending. Value = the line's taxable
 * value pro rata; age runs from the order date, overdue from the line's (else the order's)
 * expected date.
 */
export function pendingOrders(db: DB, kind: 'sales_order' | 'purchase_order', asOn: string): PendingOrderRow[] {
  if (!hasTradeSchema(db)) return []
  const lines = db
    .prepare(
      `SELECT td.id AS docId, td.number, td.date, COALESCE(tl.due_date, td.due_date) AS dueDate, td.party_ledger_id AS partyLedgerId,
              p.name AS partyName, tl.line_uid AS lineUid, tl.line_order AS lineOrder, tl.stock_item_id AS stockItemId, si.name AS itemName,
              u.symbol AS unit, COALESCE(u.decimals, 3) AS decimals, tl.qty_milli AS qtyMilli, tl.rate_paise AS ratePaise, tl.amount
       FROM trade_doc_lines tl
       JOIN trade_docs td ON td.id = tl.doc_id
       JOIN trade_doc_types tt ON tt.id = td.doc_type_id
       JOIN ledgers p ON p.id = td.party_ledger_id
       JOIN stock_items si ON si.id = tl.stock_item_id
       LEFT JOIN units u ON u.id = si.unit_id
       WHERE tt.kind = ? AND td.date <= ? AND td.deleted_at IS NULL AND td.status = 'open'
       ORDER BY td.date, td.id, tl.line_order`
    )
    .all(kind, asOn) as (Omit<PendingOrderRow, 'doneMilli' | 'pendingMilli' | 'pendingValue' | 'ageDays' | 'overdueDays' | 'lineNo'> & {
      lineOrder: number; amount: number
    })[]
  if (lines.length === 0) return []
  const doneStmt = db.prepare(
    `SELECT COALESCE(SUM(ll.qty_milli), 0) AS q FROM line_links ll
     LEFT JOIN vouchers tv ON tv.id = ll.to_voucher_id
     LEFT JOIN trade_docs ttd ON ttd.id = ll.to_trade_doc_id
     WHERE ll.from_line_uid = ? AND ll.link_type = 'fulfil' AND (
       (tv.id IS NOT NULL AND tv.deleted_at IS NULL AND tv.is_optional = 0 AND tv.date <= ?)
       OR (ttd.id IS NOT NULL AND ttd.deleted_at IS NULL AND ttd.status <> 'cancelled' AND ttd.date <= ?))`
  )
  const out: PendingOrderRow[] = []
  for (const l of lines) {
    const done = Math.min(l.qtyMilli, (doneStmt.get(l.lineUid, asOn, asOn) as { q: number }).q)
    const pending = l.qtyMilli - done
    if (pending <= 0) continue
    const { lineOrder, amount, ...rest } = l
    out.push({
      ...rest,
      lineNo: lineOrder + 1,
      doneMilli: done,
      pendingMilli: pending,
      pendingValue: done === 0 ? amount : Math.round((amount * pending) / l.qtyMilli),
      ageDays: Math.max(0, daysBetween(l.date, asOn)),
      overdueDays: l.dueDate ? Math.max(0, daysBetween(l.dueDate, asOn)) : 0
    })
  }
  return out
}

/**
 * Quotation pipeline (WP 2.5c): every quotation dated in the period (binned ones aside) with its
 * outcome as on `asOn` and the value converted into sales orders / invoices. Conversion rate =
 * quotations converted (fully or partly) ÷ quotations decided (converted, lost — closed with
 * nothing converted — or expired); open and cancelled ones are not decided.
 */
export function quotationPipeline(db: DB, from: string, to: string, asOn: string): QuotationPipeline {
  if (!hasTradeSchema(db)) return { rows: [], conversionRatePct: null, valueConversionPct: null }
  const ids = db
    .prepare(
      `SELECT td.id FROM trade_docs td JOIN trade_doc_types tt ON tt.id = td.doc_type_id
       WHERE tt.kind = 'quotation' AND td.date BETWEEN ? AND ? AND td.deleted_at IS NULL ORDER BY td.date, td.id`
    )
    .all(from, to) as { id: number }[]
  const rows: QuotationPipelineRow[] = []
  for (const { id } of ids) {
    const d = getTradeDoc(db, id, asOn)!
    const convertedValue = d.lines.reduce(
      (s, l) => s + (l.doneMilli >= l.qtyMilli ? l.amount : Math.round((l.amount * l.doneMilli) / l.qtyMilli)),
      0
    )
    const anyDone = d.lines.some((l) => l.doneMilli > 0)
    const outcome: QuotationOutcome =
      d.status === 'cancelled' ? 'cancelled'
        : d.status === 'fulfilled' ? 'converted'
          : d.status === 'partly_fulfilled' ? 'partly_converted'
            : d.status === 'closed' ? (anyDone ? 'partly_converted' : 'lost')
              : d.status === 'expired' ? 'expired'
                : 'open'
    rows.push({
      docId: d.id, number: d.number, date: d.date, validUntil: d.validUntil, partyLedgerId: d.partyLedgerId, partyName: d.partyName,
      taxable: d.totals.taxable, total: d.totals.total, convertedValue, outcome,
      convertedTo: d.downstream.filter((x) => x.live).map((x) => x.label), closeReason: d.closeReason
    })
  }
  const converted = rows.filter((r) => r.outcome === 'converted' || r.outcome === 'partly_converted').length
  const decided = converted + rows.filter((r) => r.outcome === 'lost' || r.outcome === 'expired').length
  const quoted = rows.filter((r) => r.outcome !== 'cancelled').reduce((s, r) => s + r.taxable, 0)
  const convertedValue = rows.reduce((s, r) => s + r.convertedValue, 0)
  return {
    rows,
    conversionRatePct: decided > 0 ? Math.round((converted * 1000) / decided) / 10 : null,
    valueConversionPct: quoted > 0 ? Math.round((convertedValue * 1000) / quoted) / 10 : null
  }
}
