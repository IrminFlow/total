import type { DB } from '../db/connection'
import type { TradeDocKind, VoucherKind } from '@shared/domain'
import type {
  ItemDemandRow, LeadTimeRow, OrderBookRow, ReturnRateRow, ReturnRow, ReturnSide, StaleDocRow, StaleOptions, UnbilledGoods,
  UnbilledPartyRow, UnbilledTotals
} from '@shared/tradeCycle/types'
import { threeWayMatch, type MatchInputLine, type MatchRow, type MatchTolerances } from '@shared/tradeCycle/match'
import { daysBetween, fullDeliveryDate, pct, type DeliveryEvent } from '@shared/tradeCycle/analysis'
import { hasTradeSchema } from './tradeLinks'
import { getTradeDoc } from './tradeDocs'
import { pendingOrders, pendingStockNotes } from './tradeReports'
import { stockSummary } from './stockAnalysis'

/**
 * Trade-cycle reports (WP 2.5d): three-way match, demand vs stock vs on-order, the order book,
 * fulfilment lead time, the returns register and returns rate, goods received / delivered not
 * invoiced (GRNI / GDNI), and stale documents. Every figure comes from the documents and their
 * line links at query time — nothing is stored.
 *
 * "Live" throughout: a voucher that is not binned and not optional (memorandum); a trade doc that
 * is not binned and not cancelled — the same rule as link capacity (tradeLinks I1).
 */

// ---------- three-way match ----------

interface FactRow {
  lineUid: string; voucherId: number | null; tradeDocId: number | null; number: string; date: string; qtyMilli: number
  ratePaise: number; amount: number; partyLedgerId: number | null; partyName: string | null; stockItemId: number; itemName: string
  decimals: number; sourceUid: string | null
}

const VOUCHER_FACTS = `
  SELECT il.line_uid AS lineUid, il.voucher_id AS voucherId, NULL AS tradeDocId, v.number, v.date, il.qty_milli AS qtyMilli,
         il.rate_paise AS ratePaise, il.amount, v.party_ledger_id AS partyLedgerId, p.name AS partyName, il.stock_item_id AS stockItemId,
         si.name AS itemName, COALESCE(u.decimals, 3) AS decimals,
         (SELECT ll.from_line_uid FROM line_links ll WHERE ll.to_line_uid = il.line_uid AND ll.link_type = 'fulfil') AS sourceUid
  FROM inventory_lines il
  JOIN vouchers v ON v.id = il.voucher_id
  JOIN voucher_types vt ON vt.id = v.voucher_type_id
  LEFT JOIN trade_voucher_details tvd ON tvd.voucher_id = v.id
  LEFT JOIN ledgers p ON p.id = v.party_ledger_id
  JOIN stock_items si ON si.id = il.stock_item_id
  LEFT JOIN units u ON u.id = si.unit_id`

const DOC_FACTS = `
  SELECT tl.line_uid AS lineUid, NULL AS voucherId, td.id AS tradeDocId, td.number, td.date, tl.qty_milli AS qtyMilli,
         tl.rate_paise AS ratePaise, tl.amount, td.party_ledger_id AS partyLedgerId, p.name AS partyName, tl.stock_item_id AS stockItemId,
         si.name AS itemName, COALESCE(u.decimals, 3) AS decimals, NULL AS sourceUid
  FROM trade_doc_lines tl
  JOIN trade_docs td ON td.id = tl.doc_id
  JOIN trade_doc_types tt ON tt.id = td.doc_type_id
  LEFT JOIN ledgers p ON p.id = td.party_ledger_id
  JOIN stock_items si ON si.id = tl.stock_item_id
  LEFT JOIN units u ON u.id = si.unit_id`

/** Live purchase-side voucher lines (bills, GRNs) — the predicate both loaders share. */
const LIVE_VOUCHER = 'v.deleted_at IS NULL AND v.is_optional = 0'

/**
 * trade:threeWayMatch — exceptions for bills and purchase GRNs dated in the period (match.ts has
 * the rules). Reference lines (the POs and GRNs they draw on, and bills of any date up to `to`
 * that bill those GRNs) are loaded too, but raise nothing themselves.
 */
export function threeWayMatchReport(db: DB, q: { from: string; to: string; tolerances: MatchTolerances }): MatchRow[] {
  if (!hasTradeSchema(db)) return []
  const lines = new Map<string, MatchInputLine>()
  const add = (rows: FactRow[], stage: MatchInputLine['stage'], anchor: boolean): void => {
    for (const r of rows) {
      const had = lines.get(r.lineUid)
      if (had) {
        if (anchor) had.anchor = true
        continue
      }
      lines.set(r.lineUid, { ...r, stage, anchor })
    }
  }
  add(
    db.prepare(`${VOUCHER_FACTS} WHERE vt.kind = 'purchase' AND ${LIVE_VOUCHER} AND v.date BETWEEN ? AND ? AND il.is_absolute = 0`).all(q.from, q.to) as FactRow[],
    'bill', true
  )
  add(
    db
      .prepare(
        `${VOUCHER_FACTS} WHERE vt.kind = 'receipt_note' AND ${LIVE_VOUCHER} AND v.date BETWEEN ? AND ? AND il.is_absolute = 0
           AND COALESCE(tvd.purpose, 'purchase') = 'purchase'`
      )
      .all(q.from, q.to) as FactRow[],
    'grn', true
  )
  // Bills (any date up to `to`) that bill the period's GRN lines — for the unbilled share.
  const grnUids = [...lines.values()].filter((l) => l.stage === 'grn').map((l) => l.lineUid)
  const billsOf = db.prepare(
    `${VOUCHER_FACTS} WHERE vt.kind = 'purchase' AND ${LIVE_VOUCHER} AND v.date <= ?
       AND il.line_uid IN (SELECT ll.to_line_uid FROM line_links ll WHERE ll.from_line_uid = ? AND ll.link_type = 'fulfil')`
  )
  for (const uid of grnUids) add(billsOf.all(q.to, uid) as FactRow[], 'bill', false)
  // Sources: GRN lines and PO lines the loaded lines draw on (two hops: bill → GRN → PO).
  const grnByUid = db.prepare(`${VOUCHER_FACTS} WHERE il.line_uid = ? AND vt.kind = 'receipt_note'`)
  const poByUid = db.prepare(`${DOC_FACTS} WHERE tl.line_uid = ? AND tt.kind = 'purchase_order'`)
  for (let hop = 0; hop < 2; hop++) {
    for (const l of [...lines.values()]) {
      if (!l.sourceUid || lines.has(l.sourceUid)) continue
      const g = grnByUid.get(l.sourceUid) as FactRow | undefined
      if (g) add([g], 'grn', false)
      else {
        const p = poByUid.get(l.sourceUid) as FactRow | undefined
        if (p) add([p], 'po', false)
      }
    }
  }
  return threeWayMatch([...lines.values()], q.tolerances)
}

// ---------- demand vs stock vs on-order ----------

/** trade:itemDemand — per item, closing stock against what open orders still want. */
export function itemDemand(db: DB, asOn: string, opts: { onlyOpen?: boolean } = {}): ItemDemandRow[] {
  const onlyOpen = opts.onlyOpen ?? true
  const so = new Map<number, { q: number; v: number }>()
  const po = new Map<number, { q: number; v: number }>()
  for (const [kind, into] of [['sales_order', so], ['purchase_order', po]] as const) {
    for (const r of pendingOrders(db, kind, asOn)) {
      const t = into.get(r.stockItemId) ?? { q: 0, v: 0 }
      t.q += r.pendingMilli
      t.v += r.pendingValue
      into.set(r.stockItemId, t)
    }
  }
  const reorder = new Map(
    (db.prepare('SELECT id, reorder_level_milli AS r FROM stock_items').all() as { id: number; r: number | null }[]).map((x) => [x.id, x.r])
  )
  const out: ItemDemandRow[] = []
  for (const s of stockSummary(db, asOn)) {
    const o = so.get(s.stockItemId) ?? { q: 0, v: 0 }
    const p = po.get(s.stockItemId) ?? { q: 0, v: 0 }
    if (onlyOpen && o.q === 0 && p.q === 0) continue
    const net = s.closingQtyMilli - o.q + p.q
    out.push({
      stockItemId: s.stockItemId, itemName: s.name, unit: s.unitSymbol || null, decimals: s.decimals, closingQtyMilli: s.closingQtyMilli,
      openSoMilli: o.q, openSoValue: o.v, openPoMilli: p.q, openPoValue: p.v, netMilli: net, shortMilli: Math.max(0, -net),
      reorderLevelMilli: reorder.get(s.stockItemId) ?? null
    })
  }
  return out.sort((a, b) => b.shortMilli - a.shortMilli || a.itemName.localeCompare(b.itemName))
}

// ---------- order book and lead time ----------

type OrderKind = 'sales_order' | 'purchase_order'

function ordersIn(db: DB, kind: OrderKind, from: string, to: string): number[] {
  return (
    db
      .prepare(
        `SELECT td.id FROM trade_docs td JOIN trade_doc_types tt ON tt.id = td.doc_type_id
         WHERE tt.kind = ? AND td.date BETWEEN ? AND ? AND td.deleted_at IS NULL AND td.status <> 'cancelled' ORDER BY td.date, td.id`
      )
      .all(kind, from, to) as { id: number }[]
  ).map((r) => r.id)
}

/** trade:orderBook — every live sales / purchase order dated in the period with ordered,
 *  fulfilled, pending and short-closed taxable value (fulfilment: live links of any date). */
export function orderBook(db: DB, q: { kind: OrderKind; from: string; to: string }): OrderBookRow[] {
  if (!hasTradeSchema(db)) return []
  return ordersIn(db, q.kind, q.from, q.to).map((id) => {
    const d = getTradeDoc(db, id, q.to)!
    const fulfilled = d.lines.reduce(
      (s, l) => s + (l.doneMilli >= l.qtyMilli ? l.amount : Math.round((l.amount * l.doneMilli) / l.qtyMilli)),
      0
    )
    const taxable = d.totals.taxable
    return {
      docId: d.id, kind: q.kind, number: d.number, date: d.date, month: d.date.slice(0, 7), partyLedgerId: d.partyLedgerId,
      partyName: d.partyName, status: d.status, lineCount: d.lines.length, orderedValue: taxable, fulfilledValue: fulfilled,
      pendingValue: d.pendingValue, shortClosedValue: d.manualStatus === 'closed' ? Math.max(0, taxable - fulfilled) : 0
    }
  })
}

const NOTE_OF: Record<OrderKind, VoucherKind> = { sales_order: 'delivery_note', purchase_order: 'receipt_note' }
const INVOICE_OF: Record<OrderKind, VoucherKind> = { sales_order: 'sales', purchase_order: 'purchase' }

/**
 * trade:leadTime — order → delivery → invoice days for each live order dated in the period.
 * Delivery = a challan / GRN drawing on the order, or an invoice / bill drawing on it directly
 * (then it is delivery and invoice at once); invoice = an invoice / bill drawing on the order or on
 * its challans / GRNs. Only live documents dated on or before `asOn` count.
 */
export function leadTime(db: DB, q: { kind: OrderKind; from: string; to: string; asOn: string }): LeadTimeRow[] {
  if (!hasTradeSchema(db)) return []
  const fulfilFrom = db.prepare(
    `SELECT ll.to_line_uid AS toUid, ll.qty_milli AS qtyMilli, v.date, vt.kind FROM line_links ll
     JOIN vouchers v ON v.id = ll.to_voucher_id JOIN voucher_types vt ON vt.id = v.voucher_type_id
     WHERE ll.from_line_uid = ? AND ll.link_type = 'fulfil' AND ${LIVE_VOUCHER} AND v.date <= ?`
  )
  type Hit = { toUid: string; qtyMilli: number; date: string; kind: VoucherKind }
  return ordersIn(db, q.kind, q.from, q.to).map((id) => {
    const d = getTradeDoc(db, id, q.asOn)!
    const deliveries: DeliveryEvent[] = []
    const invoiceDates: string[] = []
    for (const l of d.lines) {
      for (const h of fulfilFrom.all(l.lineUid, q.asOn) as Hit[]) {
        if (h.kind === NOTE_OF[q.kind]) {
          deliveries.push({ lineUid: l.lineUid, date: h.date, qtyMilli: h.qtyMilli })
          for (const inv of fulfilFrom.all(h.toUid, q.asOn) as Hit[]) if (inv.kind === INVOICE_OF[q.kind]) invoiceDates.push(inv.date)
        } else if (h.kind === INVOICE_OF[q.kind]) {
          deliveries.push({ lineUid: l.lineUid, date: h.date, qtyMilli: h.qtyMilli })
          invoiceDates.push(h.date)
        }
      }
    }
    const first = deliveries.map((e) => e.date).sort()[0] ?? null
    const full = fullDeliveryDate(d.lines.map((l) => ({ lineUid: l.lineUid, qtyMilli: l.qtyMilli })), deliveries)
    const firstInvoice = invoiceDates.sort()[0] ?? null
    return {
      docId: d.id, kind: q.kind, number: d.number, date: d.date, partyLedgerId: d.partyLedgerId, partyName: d.partyName, status: d.status,
      firstDeliveryDate: first, fullDeliveryDate: full, firstInvoiceDate: firstInvoice,
      daysToFirstDelivery: first ? daysBetween(d.date, first) : null,
      daysToFullDelivery: full ? daysBetween(d.date, full) : null,
      daysDeliveryToInvoice: first && firstInvoice ? Math.max(0, daysBetween(first, firstInvoice)) : null,
      daysOrderToInvoice: firstInvoice ? daysBetween(d.date, firstInvoice) : null
    }
  })
}

// ---------- returns ----------

interface ReturnLineRow {
  voucherId: number; kind: VoucherKind; typeName: string; number: string; date: string; partyLedgerId: number | null
  partyName: string | null; lineUid: string; lineOrder: number; stockItemId: number; itemName: string; unit: string | null
  decimals: number; qtyMilli: number; amount: number; narration: string | null
  srcVoucherId: number | null; srcKind: VoucherKind | null; srcTypeName: string | null; srcNumber: string | null; srcDate: string | null
}

/** Return lines of a side dated in the period: credit / debit note lines (linked or not), and
 *  rejection notes — a GRN line returning a challan line (or any GRN marked "return"), a challan
 *  line returning a GRN line. */
function returnLines(db: DB, side: ReturnSide, from: string, to: string): ReturnLineRow[] {
  const note = side === 'sales' ? 'credit_note' : 'debit_note'
  const rejection = side === 'sales' ? 'receipt_note' : 'delivery_note'
  return db
    .prepare(
      `SELECT v.id AS voucherId, vt.kind, vt.name AS typeName, v.number, v.date, v.party_ledger_id AS partyLedgerId, p.name AS partyName,
              il.line_uid AS lineUid, il.line_order AS lineOrder, il.stock_item_id AS stockItemId, si.name AS itemName, u.symbol AS unit,
              COALESCE(u.decimals, 3) AS decimals, il.qty_milli AS qtyMilli, il.amount, v.narration,
              sv.id AS srcVoucherId, svt.kind AS srcKind, svt.name AS srcTypeName, sv.number AS srcNumber, sv.date AS srcDate
       FROM inventory_lines il
       JOIN vouchers v ON v.id = il.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN trade_voucher_details tvd ON tvd.voucher_id = v.id
       LEFT JOIN ledgers p ON p.id = v.party_ledger_id
       JOIN stock_items si ON si.id = il.stock_item_id
       LEFT JOIN units u ON u.id = si.unit_id
       LEFT JOIN line_links ll ON ll.to_line_uid = il.line_uid AND ll.link_type = 'return'
       LEFT JOIN vouchers sv ON sv.id = ll.from_voucher_id
       LEFT JOIN voucher_types svt ON svt.id = sv.voucher_type_id
       WHERE ${LIVE_VOUCHER} AND v.date BETWEEN ? AND ? AND il.is_absolute = 0
         AND (vt.kind = ? OR (vt.kind = ? AND (ll.id IS NOT NULL OR tvd.purpose = 'return')))
       ORDER BY v.date, v.id, il.line_order`
    )
    .all(from, to, note, rejection) as ReturnLineRow[]
}

/** trade:returnsRegister — every return line of a side in the period, with what it returns. */
export function returnsRegister(db: DB, q: { side: ReturnSide; from: string; to: string }): ReturnRow[] {
  if (!hasTradeSchema(db)) return []
  return returnLines(db, q.side, q.from, q.to).map((r) => ({
    voucherId: r.voucherId, kind: r.kind, typeName: r.typeName, number: r.number, date: r.date, partyLedgerId: r.partyLedgerId,
    partyName: r.partyName, lineUid: r.lineUid, lineNo: r.lineOrder + 1, stockItemId: r.stockItemId, itemName: r.itemName, unit: r.unit,
    decimals: r.decimals, qtyMilli: r.qtyMilli, amount: r.amount, againstVoucherId: r.srcVoucherId, againstKind: r.srcKind,
    againstLabel: r.srcTypeName && r.srcNumber ? `${r.srcTypeName} ${r.srcNumber}` : null, againstDate: r.srcDate,
    daysAfter: r.srcDate ? daysBetween(r.srcDate, r.date) : null, reason: r.narration?.trim() || null
  }))
}

/** trade:returnsRate — returned ÷ sold (or bought) in the period, per item or per party. */
export function returnsRate(db: DB, q: { side: ReturnSide; from: string; to: string; by: 'item' | 'party' }): ReturnRateRow[] {
  if (!hasTradeSchema(db)) return []
  const sold = db
    .prepare(
      `SELECT v.party_ledger_id AS partyLedgerId, p.name AS partyName, il.stock_item_id AS stockItemId, si.name AS itemName,
              COALESCE(u.decimals, 3) AS decimals, il.qty_milli AS qtyMilli, il.amount
       FROM inventory_lines il
       JOIN vouchers v ON v.id = il.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers p ON p.id = v.party_ledger_id
       JOIN stock_items si ON si.id = il.stock_item_id
       LEFT JOIN units u ON u.id = si.unit_id
       WHERE vt.kind = ? AND ${LIVE_VOUCHER} AND v.date BETWEEN ? AND ? AND il.is_absolute = 0`
    )
    .all(q.side === 'sales' ? 'sales' : 'purchase', q.from, q.to) as {
      partyLedgerId: number | null; partyName: string | null; stockItemId: number; itemName: string; decimals: number; qtyMilli: number; amount: number
    }[]
  const groups = new Map<string, ReturnRateRow>()
  const at = (r: { partyLedgerId: number | null; partyName: string | null; stockItemId: number; itemName: string; decimals: number }): ReturnRateRow => {
    const key = q.by === 'item' ? `i${r.stockItemId}` : `p${r.partyLedgerId ?? 0}`
    let g = groups.get(key)
    if (!g) {
      g = {
        key, stockItemId: q.by === 'item' ? r.stockItemId : null, itemName: q.by === 'item' ? r.itemName : null,
        partyLedgerId: q.by === 'party' ? r.partyLedgerId : null, partyName: q.by === 'party' ? r.partyName : null,
        decimals: q.by === 'item' ? r.decimals : 3, soldQtyMilli: 0, soldValue: 0, returnedQtyMilli: 0, returnedValue: 0,
        qtyRatePct: null, valueRatePct: null
      }
      groups.set(key, g)
    }
    return g
  }
  for (const r of sold) {
    const g = at(r)
    g.soldQtyMilli += r.qtyMilli
    g.soldValue += r.amount
  }
  for (const r of returnLines(db, q.side, q.from, q.to)) {
    const g = at(r)
    g.returnedQtyMilli += r.qtyMilli
    g.returnedValue += r.amount
  }
  return [...groups.values()]
    .map((g) => ({ ...g, qtyRatePct: pct(g.returnedQtyMilli, g.soldQtyMilli), valueRatePct: pct(g.returnedValue, g.soldValue) }))
    .sort((a, b) => b.returnedValue - a.returnedValue || (a.itemName ?? a.partyName ?? '').localeCompare(b.itemName ?? b.partyName ?? ''))
}

// ---------- GRNI / GDNI ----------

/** Challan purposes that are supplies awaiting an invoice (GDNI). */
export const GDNI_PURPOSES = ['supply', 'approval'] as const
/** GRN purposes awaiting a bill (GRNI). */
export const GRNI_PURPOSES = ['purchase'] as const

/**
 * trade:unbilledGoods — goods delivered not invoiced (pending supply / on-approval challans) and
 * goods received not invoiced (pending purchase GRNs) as on a date, in total and per party. The
 * values are exactly the pending reports' pending value for those purposes (taxable, GST
 * excluded). Year-end close preview shows them as a warning (design §9 Q5: no automatic journal).
 */
export function unbilledGoods(db: DB, asOn: string): UnbilledGoods {
  const empty = (): UnbilledTotals => ({ value: 0, notes: 0, lines: 0 })
  const out: UnbilledGoods = { asOn, gdni: empty(), grni: empty(), byParty: [] }
  if (!hasTradeSchema(db)) return out
  const parties = new Map<string, UnbilledPartyRow & { noteIds: Set<number> }>()
  for (const side of ['gdni', 'grni'] as const) {
    const purposes: readonly string[] = side === 'gdni' ? GDNI_PURPOSES : GRNI_PURPOSES
    const rows = pendingStockNotes(db, side === 'gdni' ? 'delivery_note' : 'receipt_note', asOn).filter((r) => purposes.includes(r.purpose))
    const notes = new Set<number>()
    for (const r of rows) {
      notes.add(r.voucherId)
      out[side].value += r.pendingValue
      out[side].lines += 1
      const k = `${side}:${r.partyLedgerId ?? 0}`
      let p = parties.get(k)
      if (!p) {
        p = { side, partyLedgerId: r.partyLedgerId, partyName: r.partyName, notes: 0, lines: 0, value: 0, oldestDays: 0, noteIds: new Set() }
        parties.set(k, p)
      }
      p.noteIds.add(r.voucherId)
      p.lines += 1
      p.value += r.pendingValue
      p.oldestDays = Math.max(p.oldestDays, r.ageDays)
    }
    out[side].notes = notes.size
  }
  out.byParty = [...parties.values()]
    .map(({ noteIds, ...p }) => ({ ...p, notes: noteIds.size }))
    .sort((a, b) => a.side.localeCompare(b.side) || b.value - a.value)
  return out
}

// ---------- stale documents ----------

export const DEFAULT_STALE_OPTIONS: StaleOptions = { orderAgeDays: 30, noteAgeDays: 30 }

/**
 * trade:staleDocuments — what is left open too long, as on a date:
 *  - quotations past their validity (still open, not fully converted) — `expired`; quotations with
 *    no validity older than `orderAgeDays` — `aged`;
 *  - sales / purchase orders with something pending: past their expected date (`overdue`), or
 *    with no expected date and older than `orderAgeDays` (`aged`);
 *  - challans / GRNs with something pending older than `noteAgeDays` (`aged`).
 * Closed, cancelled and binned documents are never stale.
 */
export function staleDocuments(db: DB, asOn: string, opts: StaleOptions = DEFAULT_STALE_OPTIONS): StaleDocRow[] {
  if (!hasTradeSchema(db)) return []
  const out: StaleDocRow[] = []
  const docs = db
    .prepare(
      `SELECT td.id FROM trade_docs td WHERE td.deleted_at IS NULL AND td.status = 'open' AND td.date <= ? ORDER BY td.date, td.id`
    )
    .all(asOn) as { id: number }[]
  for (const { id } of docs) {
    const d = getTradeDoc(db, id, asOn)!
    if (d.status === 'fulfilled') continue
    const kind: TradeDocKind = d.kind
    let why: StaleDocRow['why'] | null = null
    let due: string | null = null
    let days = 0
    if (kind === 'quotation') {
      if (d.validUntil && d.validUntil < asOn) {
        why = 'expired'
        due = d.validUntil
        days = daysBetween(d.validUntil, asOn)
      } else if (!d.validUntil && daysBetween(d.date, asOn) > opts.orderAgeDays) {
        why = 'aged'
        days = daysBetween(d.date, asOn)
      }
    } else {
      const lineDue = d.lines.filter((l) => l.pendingMilli > 0).map((l) => l.dueDate ?? d.dueDate).filter((x): x is string => !!x).sort()[0] ?? null
      if (lineDue && lineDue < asOn) {
        why = 'overdue'
        due = lineDue
        days = daysBetween(lineDue, asOn)
      } else if (!lineDue && daysBetween(d.date, asOn) > opts.orderAgeDays) {
        why = 'aged'
        days = daysBetween(d.date, asOn)
      }
    }
    if (!why) continue
    out.push({
      key: `d${d.id}`, kind, voucherId: null, tradeDocId: d.id, number: d.number, date: d.date, partyLedgerId: d.partyLedgerId,
      partyName: d.partyName, why, dueDate: due, daysStale: days, pendingValue: d.pendingValue, status: d.status
    })
  }
  // A note line count, to tell "partly invoiced" (some lines fully done) from untouched.
  const noteLines = db.prepare('SELECT COUNT(*) AS n FROM inventory_lines il WHERE il.voucher_id = ? AND il.is_absolute = 0')
  for (const stage of ['delivery_note', 'receipt_note'] as const) {
    const byNote = new Map<number, StaleDocRow & { partly: boolean; pendingLines: number }>()
    for (const r of pendingStockNotes(db, stage, asOn)) {
      if (r.ageDays <= opts.noteAgeDays) continue
      const n = byNote.get(r.voucherId)
      if (n) {
        n.pendingValue += r.pendingValue
        n.pendingLines += 1
        if (r.doneMilli > 0) n.partly = true
        continue
      }
      byNote.set(r.voucherId, {
        key: `v${r.voucherId}`, kind: stage, voucherId: r.voucherId, tradeDocId: null, number: r.number, date: r.date,
        partyLedgerId: r.partyLedgerId, partyName: r.partyName, why: 'aged', dueDate: null, daysStale: r.ageDays,
        pendingValue: r.pendingValue, status: 'open', partly: r.doneMilli > 0, pendingLines: 1
      })
    }
    for (const { partly, pendingLines, ...n } of byNote.values()) {
      const total = (noteLines.get(n.voucherId) as { n: number }).n
      out.push({ ...n, status: partly || pendingLines < total ? 'partly_fulfilled' : 'open' })
    }
  }
  return out.sort((a, b) => b.daysStale - a.daysStale || a.date.localeCompare(b.date))
}
