import type { DB } from '../db/connection'
import type { LinkType, TradeDocKind, VoucherKind } from '@shared/domain'
import type { ChainEdge, ChainLine, ChainNode, ChainNodeStatus, TradeChain } from '@shared/tradeCycle/types'
import { SHARED_CAPACITY_SOURCES } from '@shared/tradeCycle/rules'
import { lineFulfilment } from '@shared/tradeCycle/fulfilment'
import { chainLevels } from '@shared/tradeCycle/analysis'
import { hasTradeSchema, liveLinkQty } from './tradeLinks'
import { getTradeDoc } from './tradeDocs'

/**
 * Linked documents (WP 2.5d, trade:chain): the whole connected set of documents around one
 * voucher or trade doc, through line_links in both directions and over any number of hops —
 * quotation → sales order → challan → invoice → credit note, purchase order → GRN → bill →
 * debit note, and rejection notes. Binned and cancelled documents stay in the chain (marked, not
 * live) so the history reads whole; every link, live or dormant, is an edge.
 *
 * Each node carries its lines with the live quantity drawn from them (fulfilled / returned) and a
 * shown status. Levels lay the chain out left to right (analysis.chainLevels). The walk stops at
 * NODE_CAP documents (`truncated`).
 */

const NODE_CAP = 120

interface Head {
  key: string
  voucherId: number | null
  tradeDocId: number | null
  kind: VoucherKind | TradeDocKind
  typeName: string
  number: string
  date: string
  partyLedgerId: number | null
  partyName: string | null
  binned: boolean
  optional: boolean
  cancelled: boolean
  closed: boolean
  closeReason: string | null
}

interface LinkRow {
  linkType: LinkType
  fromVoucherId: number | null
  fromTradeDocId: number | null
  toVoucherId: number | null
  toTradeDocId: number | null
  qtyMilli: number
  id: number
}

const keyOf = (voucherId: number | null, tradeDocId: number | null): string => (voucherId != null ? `v${voucherId}` : `d${tradeDocId}`)

function voucherHead(db: DB, id: number): Head | null {
  const r = db
    .prepare(
      `SELECT v.id, vt.kind, vt.name AS typeName, v.number, v.date, v.party_ledger_id AS partyLedgerId, l.name AS partyName,
              v.deleted_at AS deletedAt, v.is_optional AS isOptional, tvd.closed_at AS closedAt, tvd.close_reason AS closeReason
       FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers l ON l.id = v.party_ledger_id
       LEFT JOIN trade_voucher_details tvd ON tvd.voucher_id = v.id
       WHERE v.id = ?`
    )
    .get(id) as
    | { id: number; kind: VoucherKind; typeName: string; number: string; date: string; partyLedgerId: number | null; partyName: string | null
        deletedAt: string | null; isOptional: number; closedAt: string | null; closeReason: string | null }
    | undefined
  if (!r) return null
  return {
    key: keyOf(r.id, null), voucherId: r.id, tradeDocId: null, kind: r.kind, typeName: r.typeName, number: r.number, date: r.date,
    partyLedgerId: r.partyLedgerId, partyName: r.partyName, binned: r.deletedAt != null, optional: r.isOptional === 1, cancelled: false,
    closed: r.closedAt != null, closeReason: r.closeReason
  }
}

function docHead(db: DB, id: number): Head | null {
  const r = db
    .prepare(
      `SELECT td.id, tt.kind, tt.name AS typeName, td.number, td.date, td.party_ledger_id AS partyLedgerId, l.name AS partyName,
              td.deleted_at AS deletedAt, td.status, td.close_reason AS closeReason
       FROM trade_docs td JOIN trade_doc_types tt ON tt.id = td.doc_type_id JOIN ledgers l ON l.id = td.party_ledger_id
       WHERE td.id = ?`
    )
    .get(id) as
    | { id: number; kind: TradeDocKind; typeName: string; number: string; date: string; partyLedgerId: number; partyName: string
        deletedAt: string | null; status: 'open' | 'closed' | 'cancelled'; closeReason: string | null }
    | undefined
  if (!r) return null
  return {
    key: keyOf(null, r.id), voucherId: null, tradeDocId: r.id, kind: r.kind, typeName: r.typeName, number: r.number, date: r.date,
    partyLedgerId: r.partyLedgerId, partyName: r.partyName, binned: r.deletedAt != null, optional: false, cancelled: r.status === 'cancelled',
    closed: r.status === 'closed', closeReason: r.closeReason
  }
}

const LINK_SQL = `SELECT id, link_type AS linkType, from_voucher_id AS fromVoucherId, from_trade_doc_id AS fromTradeDocId,
  to_voucher_id AS toVoucherId, to_trade_doc_id AS toTradeDocId, qty_milli AS qtyMilli FROM line_links`

function linksTouching(db: DB, h: Head): LinkRow[] {
  return h.voucherId != null
    ? (db.prepare(`${LINK_SQL} WHERE from_voucher_id = ? OR to_voucher_id = ?`).all(h.voucherId, h.voucherId) as LinkRow[])
    : (db.prepare(`${LINK_SQL} WHERE from_trade_doc_id = ? OR to_trade_doc_id = ?`).all(h.tradeDocId, h.tradeDocId) as LinkRow[])
}

interface RawLine {
  lineUid: string
  lineOrder: number
  stockItemId: number
  itemName: string
  decimals: number
  qtyMilli: number
  amount: number
}

function linesOf(db: DB, h: Head): RawLine[] {
  const cols = `si.name AS itemName, COALESCE(u.decimals, 3) AS decimals`
  return h.voucherId != null
    ? (db
        .prepare(
          `SELECT il.line_uid AS lineUid, il.line_order AS lineOrder, il.stock_item_id AS stockItemId, ${cols}, il.qty_milli AS qtyMilli, il.amount
           FROM inventory_lines il JOIN stock_items si ON si.id = il.stock_item_id LEFT JOIN units u ON u.id = si.unit_id
           WHERE il.voucher_id = ? ORDER BY il.line_order, il.id`
        )
        .all(h.voucherId) as RawLine[])
    : (db
        .prepare(
          `SELECT tl.line_uid AS lineUid, tl.line_order AS lineOrder, tl.stock_item_id AS stockItemId, ${cols}, tl.qty_milli AS qtyMilli, tl.amount
           FROM trade_doc_lines tl JOIN stock_items si ON si.id = tl.stock_item_id LEFT JOIN units u ON u.id = si.unit_id
           WHERE tl.doc_id = ? ORDER BY tl.line_order, tl.id`
        )
        .all(h.tradeDocId) as RawLine[])
}

function statusOf(db: DB, h: Head, lines: readonly ChainLine[]): ChainNodeStatus {
  if (h.binned) return 'binned'
  if (h.optional) return 'optional'
  if (h.tradeDocId != null) return getTradeDoc(db, h.tradeDocId)?.status ?? 'open'
  if (SHARED_CAPACITY_SOURCES.includes(h.kind)) {
    if (h.closed) return 'closed'
    const f = lineFulfilment(
      lines.map((l) => ({ lineUid: l.lineUid, qtyMilli: l.qtyMilli })),
      new Map(lines.map((l) => [l.lineUid, l.fulfilledMilli + l.returnedMilli]))
    )
    if (f.length > 0 && f.every((x) => x.pendingMilli === 0)) return 'fulfilled'
    return f.some((x) => x.doneMilli > 0) ? 'partly_fulfilled' : 'open'
  }
  if (h.kind === 'sales' || h.kind === 'purchase') {
    const returned = lines.reduce((s, l) => s + Math.min(l.qtyMilli, l.returnedMilli), 0)
    const qty = lines.reduce((s, l) => s + l.qtyMilli, 0)
    if (returned > 0 && returned >= qty) return 'returned'
    if (returned > 0) return 'partly_returned'
  }
  return 'posted'
}

export function tradeChain(db: DB, q: { voucherId?: number; tradeDocId?: number }): TradeChain {
  const root = q.voucherId != null ? voucherHead(db, q.voucherId) : q.tradeDocId != null ? docHead(db, q.tradeDocId) : null
  if (!root) throw new Error(q.voucherId != null ? 'Voucher not found' : 'Document not found')
  if (!hasTradeSchema(db)) return { rootKey: root.key, nodes: [], edges: [], truncated: false }

  const heads = new Map<string, Head>([[root.key, root]])
  const links = new Map<number, LinkRow>()
  const queue: Head[] = [root]
  let truncated = false
  while (queue.length > 0) {
    const h = queue.shift()!
    for (const l of linksTouching(db, h)) {
      links.set(l.id, l)
      for (const [vid, did] of [[l.fromVoucherId, l.fromTradeDocId], [l.toVoucherId, l.toTradeDocId]] as const) {
        const key = keyOf(vid, did)
        if (heads.has(key)) continue
        if (heads.size >= NODE_CAP) {
          truncated = true
          continue
        }
        const other = vid != null ? voucherHead(db, vid) : did != null ? docHead(db, did) : null
        if (!other) continue
        heads.set(key, other)
        queue.push(other)
      }
    }
  }

  const isLive = (h: Head): boolean => !h.binned && !h.optional && !h.cancelled
  // Edges: links summed per (source doc, target doc, link type), between nodes in the chain.
  const edgeMap = new Map<string, ChainEdge>()
  for (const l of links.values()) {
    const from = keyOf(l.fromVoucherId, l.fromTradeDocId)
    const to = keyOf(l.toVoucherId, l.toTradeDocId)
    if (!heads.has(from) || !heads.has(to)) continue
    const k = `${from}>${to}:${l.linkType}`
    const e = edgeMap.get(k)
    if (e) {
      e.qtyMilli += l.qtyMilli
      e.lines += 1
    } else {
      edgeMap.set(k, { from, to, linkType: l.linkType, qtyMilli: l.qtyMilli, lines: 1, live: isLive(heads.get(to)!) })
    }
  }
  const edges = [...edgeMap.values()]
  const levels = chainLevels([...heads.keys()], edges)

  const nodes: ChainNode[] = []
  for (const h of heads.values()) {
    const raw = linesOf(db, h)
    const qty = liveLinkQty(db, raw.map((r) => r.lineUid))
    const lines: ChainLine[] = raw.map((r) => ({
      lineUid: r.lineUid, lineNo: r.lineOrder + 1, stockItemId: r.stockItemId, itemName: r.itemName, decimals: r.decimals,
      qtyMilli: r.qtyMilli, amount: r.amount, fulfilledMilli: qty.get(r.lineUid)?.fulfilMilli ?? 0, returnedMilli: qty.get(r.lineUid)?.returnMilli ?? 0
    }))
    nodes.push({
      key: h.key, voucherId: h.voucherId, tradeDocId: h.tradeDocId, kind: h.kind, typeName: h.typeName, number: h.number,
      label: `${h.typeName} ${h.number}`, date: h.date, partyLedgerId: h.partyLedgerId, partyName: h.partyName,
      qtyMilli: lines.reduce((s, l) => s + l.qtyMilli, 0), value: lines.reduce((s, l) => s + l.amount, 0),
      status: statusOf(db, h, lines), live: isLive(h), closeReason: h.closeReason, level: levels.get(h.key) ?? 0,
      isRoot: h.key === root.key, lines
    })
  }
  nodes.sort((a, b) => a.level - b.level || a.date.localeCompare(b.date) || a.label.localeCompare(b.label))
  return { rootKey: root.key, nodes, edges, truncated }
}
