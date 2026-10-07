import type { DB } from '../db/connection'
import type { LineSource, TradeDocKind } from '@shared/domain'
import { fyOf, todayISO } from '@shared/dates'
import { tradeDocInputSchema, type TradeDocInput, type TradeDocInputParsed } from '@shared/schemas'
import { docStatus, lineFulfilment, type TradeDocStatus } from '@shared/tradeCycle/fulfilment'
import { linkRuleFor } from '@shared/tradeCycle/rules'
import { storedTradeDocTotals, TRADE_DOC_TITLES } from '@shared/tradeCycle/edit'
import type {
  TradeDoc, TradeDocDraft, TradeDocLine, TradeDocLinkedDoc, TradeDocListRow, TradeDocTotals
} from '@shared/tradeCycle/types'
import type { LinkWarnings } from './tradeLinks'
import {
  assertDocReleasable, assertDocRestorable, docSourceLinksOf, docTargetLinksOf, findLinkLine, hasTradeSchema, linkIsLive,
  linkTargetLabel, liveLinkQty, newLineUid, syncTradeDocLinks, type StoredLink
} from './tradeLinks'
import { getTradeDocType, nextTradeDocNumber } from './tradeDocTypes'
import { writeAudit } from './audit'
import { readCompanyInfo } from '../db/seed'

/**
 * Quotations, sales orders and purchase orders (WP 2.5c, design §2.7 / §6.3). Non-posting
 * documents: they never touch voucher_lines, the stock pass or the lock date. Their lines carry
 * stable uids (`trade_doc_lines.line_uid`) that challans, GRNs, invoices, bills and — for a
 * quotation — sales orders link to through line_links (services/tradeLinks.ts).
 *
 * Status. The STORED status is only what the user did by hand (open / closed / cancelled); the
 * SHOWN status is derived on every read from the live links (fulfilment.ts docStatus):
 *   cancelled → closed (short-closed / lost) → fulfilled (every line fully drawn) →
 *   partly fulfilled (something drawn) → expired (a quotation past valid-until, nothing drawn) → open.
 * "Drawn" counts only live targets: not binned, not optional, not a cancelled order.
 *
 * Bin semantics (kept simple, mirroring vouchers):
 *  - delete = move to the bin (deleted_at); refused while a live document draws on the lines —
 *    bin / cancel that first. A binned document's own links (an order's quotation links) go
 *    dormant, so the quotation's quantity is pending again. There is no purge: the documents post
 *    nothing, and a dormant link must keep its source.
 *  - restore re-checks the document's own links (source still there and open enough).
 *  - cancel: only while nothing live draws on it ("cancel instead of delete" is for an untouched
 *    document; once drawn on, short-close it). Cancelling releases its own links like the bin.
 *  - close (short-close / "lost" for a quotation): any open document; no NEW links after it, the
 *    rest of its quantity stops being pending, existing links survive. Reopen undoes either.
 *  - closed, cancelled and binned documents are read-only: reopen / restore first.
 */

// ---------- rows ----------

interface DocRow {
  id: number; doc_type_id: number; number: string; date: string; party_ledger_id: number; valid_until: string | null
  due_date: string | null; reference: string | null; terms: string | null; narration: string | null; pos_override: string | null
  currency_code: string | null; exchange_rate: number | null; status: 'open' | 'closed' | 'cancelled'; closed_at: string | null
  close_reason: string | null; deleted_at: string | null; created_at: string; updated_at: string
  kind: TradeDocKind; type_name: string; party_name: string; party_state: string | null
}

const DOC_SQL = `
  SELECT td.*, tt.kind, tt.name AS type_name, l.name AS party_name, l.state_code AS party_state
  FROM trade_docs td
  JOIN trade_doc_types tt ON tt.id = td.doc_type_id
  JOIN ledgers l ON l.id = td.party_ledger_id`

interface LineRow {
  id: number; doc_id: number; line_uid: string; line_order: number; stock_item_id: number; description: string | null
  godown_id: number | null; qty_milli: number; rate_paise: number; discount_paise: number; amount: number
  gst_rate: number | null; cess_rate: number | null; due_date: string | null
}

const linesOf = (db: DB, docId: number): LineRow[] =>
  db.prepare('SELECT * FROM trade_doc_lines WHERE doc_id = ? ORDER BY line_order, id').all(docId) as LineRow[]

const companyState = (db: DB): string => readCompanyInfo(db).stateCode

function totalsFor(db: DB, d: DocRow, lines: readonly LineRow[]): TradeDocTotals {
  return storedTradeDocTotals(
    lines.map((l) => ({
      stockItemId: l.stock_item_id, qtyMilli: l.qty_milli, ratePaise: l.rate_paise, discountPaise: l.discount_paise,
      gstRate: l.gst_rate, cessRate: l.cess_rate
    })),
    { kind: d.kind, companyStateCode: companyState(db), partyStateCode: d.party_state, posOverride: d.pos_override, date: d.date }
  )
}

/** Pro-rata taxable value of `pendingMilli` of a line. */
const pendingValueOf = (l: { qty_milli: number; amount: number }, pendingMilli: number): number =>
  pendingMilli >= l.qty_milli ? l.amount : Math.round((l.amount * pendingMilli) / l.qty_milli)

/** Live fulfilled quantity per line uid (returns never re-open an order — Q11). */
function doneByUid(db: DB, lines: readonly LineRow[]): Map<string, number> {
  const q = liveLinkQty(db, lines.map((l) => l.line_uid))
  return new Map(lines.map((l) => [l.line_uid, q.get(l.line_uid)?.fulfilMilli ?? 0]))
}

function deriveStatus(d: DocRow, lines: readonly LineRow[], done: ReadonlyMap<string, number>, asOn: string): TradeDocStatus {
  return docStatus(
    { status: d.status, validUntil: d.kind === 'quotation' ? d.valid_until : null },
    lines.map((l) => ({ lineUid: l.line_uid, qtyMilli: l.qty_milli })),
    done,
    asOn
  )
}

/** Group links by the document on the other side. */
function linkedDocs(db: DB, links: readonly StoredLink[], side: 'target' | 'source'): TradeDocLinkedDoc[] {
  const out = new Map<string, TradeDocLinkedDoc>()
  for (const l of links) {
    const voucherId = side === 'target' ? l.toVoucherId : l.fromVoucherId
    const tradeDocId = side === 'target' ? l.toTradeDocId : l.fromTradeDocId
    const key = voucherId != null ? `v${voucherId}` : `d${tradeDocId}`
    const line = findLinkLine(db, side === 'target' ? l.toLineUid : l.fromLineUid)
    const live = side === 'target' ? linkIsLive(db, l) : !!line && !line.binned && !line.cancelled
    const label = line ? line.label.replace(/ line \d+$/, '') : linkTargetLabel(db, l)
    const prev = out.get(key)
    if (prev) prev.qtyMilli += l.qtyMilli
    else out.set(key, { voucherId, tradeDocId, kind: line?.kind ?? 'sales', label, date: line?.date ?? '', qtyMilli: l.qtyMilli, live })
  }
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label))
}

function toDoc(db: DB, d: DocRow, asOn: string): TradeDoc {
  const lines = linesOf(db, d.id)
  const done = doneByUid(db, lines)
  const sources = new Map(docTargetLinksOf(db, d.id).map((l) => [l.toLineUid, { lineUid: l.fromLineUid, linkType: l.linkType } as LineSource]))
  const f = new Map(lineFulfilment(lines.map((l) => ({ lineUid: l.line_uid, qtyMilli: l.qty_milli })), done).map((x) => [x.lineUid, x]))
  const status = deriveStatus(d, lines, done, asOn)
  const open = d.status === 'open' && !d.deleted_at
  const outLines: TradeDocLine[] = lines.map((l) => ({
    id: l.id, lineUid: l.line_uid, stockItemId: l.stock_item_id, description: l.description, godownId: l.godown_id,
    qtyMilli: l.qty_milli, ratePaise: l.rate_paise, discountPaise: l.discount_paise, amount: l.amount, gstRate: l.gst_rate,
    cessRate: l.cess_rate, dueDate: l.due_date, source: sources.get(l.line_uid) ?? null,
    doneMilli: f.get(l.line_uid)!.doneMilli, pendingMilli: f.get(l.line_uid)!.pendingMilli
  }))
  return {
    id: d.id, docTypeId: d.doc_type_id, kind: d.kind, typeName: d.type_name, number: d.number, date: d.date,
    partyLedgerId: d.party_ledger_id, partyName: d.party_name, validUntil: d.valid_until, dueDate: d.due_date,
    reference: d.reference, terms: d.terms, narration: d.narration, posOverride: d.pos_override,
    currencyCode: d.currency_code, exchangeRate: d.exchange_rate, manualStatus: d.status, status,
    closedAt: d.closed_at, closeReason: d.close_reason, deletedAt: d.deleted_at, lines: outLines,
    totals: totalsFor(db, d, lines),
    pendingValue: open ? lines.reduce((s, l) => s + pendingValueOf(l, f.get(l.line_uid)!.pendingMilli), 0) : 0,
    downstream: linkedDocs(db, docSourceLinksOf(db, d.id), 'target'),
    upstream: linkedDocs(db, docTargetLinksOf(db, d.id), 'source'),
    createdAt: d.created_at, updatedAt: d.updated_at
  }
}

function docRow(db: DB, id: number): DocRow | null {
  return (db.prepare(`${DOC_SQL} WHERE td.id = ?`).get(id) as DocRow | undefined) ?? null
}

/** tradeDocs:get — one document (binned ones too), its lines with done / pending, its links. */
export function getTradeDoc(db: DB, id: number, asOn: string = todayISO()): TradeDoc | null {
  const d = docRow(db, id)
  return d ? toDoc(db, d, asOn) : null
}

function requireDoc(db: DB, id: number): DocRow {
  const d = docRow(db, id)
  if (!d) throw new Error('Document not found')
  return d
}

/** tradeDocs:list — a kind's documents dated in the period, with derived status and pending value. */
export function listTradeDocs(
  db: DB,
  q: { kind: TradeDocKind; from: string; to: string; includeBinned?: boolean },
  asOn: string = todayISO()
): TradeDocListRow[] {
  if (!hasTradeSchema(db)) return []
  const rows = db
    .prepare(
      `${DOC_SQL} WHERE tt.kind = ? AND td.date BETWEEN ? AND ? ${q.includeBinned ? '' : 'AND td.deleted_at IS NULL'}
       ORDER BY td.date, td.id`
    )
    .all(q.kind, q.from, q.to) as DocRow[]
  return rows.map((d) => {
    const lines = linesOf(db, d.id)
    const done = doneByUid(db, lines)
    const totals = totalsFor(db, d, lines)
    const open = d.status === 'open' && !d.deleted_at
    const doneValue = lines.reduce((s, l) => s + (l.amount - pendingValueOf(l, l.qty_milli - Math.min(l.qty_milli, done.get(l.line_uid) ?? 0))), 0)
    const pendingValue = open ? totals.taxable - doneValue : 0
    const downstream = linkedDocs(db, docSourceLinksOf(db, d.id), 'target').filter((x) => x.live)
    return {
      id: d.id, kind: d.kind, number: d.number, date: d.date, partyLedgerId: d.party_ledger_id, partyName: d.party_name,
      reference: d.reference, validUntil: d.valid_until, dueDate: d.due_date, lineCount: lines.length,
      taxable: totals.taxable, total: totals.total, pendingValue,
      fulfilledPct: totals.taxable > 0 ? Math.round((doneValue * 100) / totals.taxable) : lines.every((l) => (done.get(l.line_uid) ?? 0) >= l.qty_milli) && lines.length > 0 ? 100 : 0,
      status: deriveStatus(d, lines, done, asOn), binned: d.deleted_at != null, closeReason: d.close_reason,
      downstreamLabels: downstream.map((x) => x.label)
    }
  })
}

// ---------- save ----------

export interface SaveTradeDocResult {
  doc: TradeDoc
  warnings: LinkWarnings
}

/** Is `number` already used by another live document of the series (in its numbering window)? */
function numberTaken(db: DB, docTypeId: number, number: string, date: string, restartFy: boolean, excludeId?: number): boolean {
  const fy = fyOf(date)
  return !!db
    .prepare(
      `SELECT 1 FROM trade_docs WHERE doc_type_id = ? AND number = ? AND deleted_at IS NULL AND id IS NOT ?
       ${restartFy ? 'AND date BETWEEN ? AND ?' : ''} LIMIT 1`
    )
    .get(docTypeId, number, excludeId ?? -1, ...(restartFy ? [fy.from, fy.to] : []))
}

/**
 * tradeDocs:save — create (no id) or alter an open document. Validates party, dates, every
 * line's amount (= round(qty × rate) − discount, the invoice rule) and snapshots each item's GST
 * and cess rate. Lines are updated in place by uid (a uid is kept only if it was this document's),
 * removed lines deleted, new ones inserted — then the document's own links are rewritten and the
 * links other documents hold on its lines re-checked (tradeLinks.syncTradeDocLinks). Any throw
 * rolls the whole save back. Audit entity 'trade_doc'.
 */
export function saveTradeDoc(db: DB, raw: TradeDocInput, id?: number): SaveTradeDocResult {
  const input: TradeDocInputParsed = tradeDocInputSchema.parse(raw)
  const type = getTradeDocType(db, input.docTypeId)
  const before = id != null ? getTradeDoc(db, id) : null
  if (id != null) {
    if (!before) throw new Error('Document not found')
    if (before.deletedAt) throw new Error(`${before.typeName} ${before.number} is in the bin — restore it first`)
    if (before.manualStatus !== 'open') {
      throw new Error(`${before.typeName} ${before.number} is ${before.manualStatus === 'closed' ? 'closed' : 'cancelled'} — reopen it to make changes`)
    }
    if (before.kind !== type.kind) throw new Error(`A ${TRADE_DOC_TITLES[before.kind].toLowerCase()} can't become a ${TRADE_DOC_TITLES[type.kind].toLowerCase()}`)
  }
  const kind = type.kind
  const party = db.prepare('SELECT id FROM ledgers WHERE id = ?').get(input.partyLedgerId)
  if (!party) throw new Error('Party ledger not found')
  const validUntil = kind === 'quotation' ? input.validUntil : null
  const dueDate = kind === 'quotation' ? null : input.dueDate
  if (validUntil && validUntil < input.date) throw new Error('Valid until is before the quotation date')
  if (dueDate && dueDate < input.date) throw new Error('The expected date is before the order date')

  // Lines: item / godown exist, amount = gross − discount, GST snapshot.
  const itemStmt = db.prepare('SELECT gst_rate AS gstRate, cess_rate AS cessRate FROM stock_items WHERE id = ?')
  const godownStmt = db.prepare('SELECT 1 FROM godowns WHERE id = ?')
  const lines = input.lines.map((l, i) => {
    const n = `Line ${i + 1}`
    const it = itemStmt.get(l.stockItemId) as { gstRate: number | null; cessRate: number | null } | undefined
    if (!it) throw new Error(`${n}: stock item not found`)
    if (l.godownId != null && !godownStmt.get(l.godownId)) throw new Error(`${n}: godown not found`)
    const gross = Math.round((l.qtyMilli * l.ratePaise) / 1000)
    if (l.discountPaise > gross) throw new Error(`${n}: the discount is more than qty × rate`)
    if (l.amount !== gross - l.discountPaise) throw new Error(`${n}: the amount must be qty × rate − discount`)
    if (l.dueDate && l.dueDate < input.date) throw new Error(`${n}: the expected date is before the document date`)
    return { ...l, gstRate: it.gstRate ?? 0, cessRate: it.cessRate ?? 0 }
  })

  // Number: typed, else (new / blank) the series' next; manual series need one.
  let number = input.number?.trim() || (before ? before.number : '')
  if (!number) {
    if (type.numbering === 'manual') throw new Error(`${type.name} is numbered by hand — type a number`)
    number = nextTradeDocNumber(db, type.id, input.date, id)
  }
  if (numberTaken(db, type.id, number, input.date, type.restartFy, id)) {
    throw new Error(`${type.name} ${number} already exists — pick another number`)
  }

  let warnings: LinkWarnings = { linkDates: [], frozenRepricing: [] }
  const docId = db.transaction(() => {
    let docId: number
    const head = [
      type.id, number, input.date, input.partyLedgerId, validUntil, dueDate, input.reference, input.terms, input.narration,
      input.posOverride, input.currencyCode, input.exchangeRate
    ]
    if (id == null) {
      docId = Number(
        db
          .prepare(
            `INSERT INTO trade_docs (doc_type_id, number, date, party_ledger_id, valid_until, due_date, reference, terms, narration,
               pos_override, currency_code, exchange_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(...head).lastInsertRowid
      )
    } else {
      docId = id
      db.prepare(
        `UPDATE trade_docs SET doc_type_id = ?, number = ?, date = ?, party_ledger_id = ?, valid_until = ?, due_date = ?, reference = ?,
           terms = ?, narration = ?, pos_override = ?, currency_code = ?, exchange_rate = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(...head, id)
    }
    // Upsert by uid — a uid survives only if it was this document's own line.
    const own = new Set((before?.lines ?? []).map((l) => l.lineUid))
    const used = new Set<string>()
    const resolved = lines.map((l) => {
      const uid = l.lineUid && own.has(l.lineUid) && !used.has(l.lineUid) ? l.lineUid : newLineUid()
      used.add(uid)
      return { ...l, uid }
    })
    for (const gone of [...own].filter((u) => !used.has(u))) db.prepare('DELETE FROM trade_doc_lines WHERE line_uid = ?').run(gone)
    const update = db.prepare(
      `UPDATE trade_doc_lines SET line_order = ?, stock_item_id = ?, description = ?, godown_id = ?, qty_milli = ?, rate_paise = ?,
         discount_paise = ?, amount = ?, gst_rate = ?, cess_rate = ?, due_date = ? WHERE line_uid = ? AND doc_id = ?`
    )
    const insert = db.prepare(
      `INSERT INTO trade_doc_lines (line_order, stock_item_id, description, godown_id, qty_milli, rate_paise, discount_paise, amount,
         gst_rate, cess_rate, due_date, line_uid, doc_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    resolved.forEach((l, i) => {
      const vals = [i, l.stockItemId, l.description, l.godownId, l.qtyMilli, l.ratePaise, l.discountPaise, l.amount, l.gstRate, l.cessRate, l.dueDate, l.uid, docId]
      if (own.has(l.uid)) update.run(...vals)
      else insert.run(...vals)
    })
    warnings = syncTradeDocLinks(db, {
      docId, kind, date: input.date, partyLedgerId: input.partyLedgerId, live: true,
      lines: resolved.map((l) => ({ uid: l.uid, stockItemId: l.stockItemId, qtyMilli: l.qtyMilli, source: l.source })),
      before: new Map((before?.lines ?? []).map((l, i) => [l.lineUid, { stockItemId: l.stockItemId, qtyMilli: l.qtyMilli, lineNo: i + 1 }])),
      beforePartyLedgerId: before?.partyLedgerId ?? null
    })
    return docId
  })()
  const after = getTradeDoc(db, docId)!
  writeAudit(db, 'trade_doc', docId, before ? 'update' : 'create', before ? auditShape(before) : null, auditShape(after))
  return { doc: after, warnings }
}

/** What the audit trail keeps of a document (no derived figures). */
function auditShape(d: TradeDoc): unknown {
  return {
    kind: d.kind, number: d.number, date: d.date, partyLedgerId: d.partyLedgerId, validUntil: d.validUntil, dueDate: d.dueDate,
    reference: d.reference, status: d.manualStatus, closeReason: d.closeReason, deletedAt: d.deletedAt, total: d.totals.total,
    lines: d.lines.map((l) => ({ lineUid: l.lineUid, stockItemId: l.stockItemId, qtyMilli: l.qtyMilli, ratePaise: l.ratePaise, amount: l.amount, source: l.source }))
  }
}

// ---------- bin / cancel / close ----------

function setState(db: DB, id: number, fn: (d: DocRow) => void, label: string, reason?: string | null): TradeDoc {
  const before = getTradeDoc(db, id)
  if (!before) throw new Error('Document not found')
  db.transaction(() => fn(requireDoc(db, id)))()
  const after = getTradeDoc(db, id)!
  writeAudit(db, 'trade_doc', id, label === 'delete' ? 'delete' : 'update', auditShape(before), {
    ...(auditShape(after) as object), action: label, ...(reason !== undefined ? { reason } : {})
  })
  return after
}

const name = (d: DocRow): string => `${d.type_name} ${d.number}`

/** tradeDocs:delete — move to the bin; refused while a live document draws on it. */
export function deleteTradeDoc(db: DB, id: number): void {
  setState(db, id, (d) => {
    if (d.deleted_at) throw new Error(`${name(d)} is already in the bin`)
    assertDocReleasable(db, id, 'bin')
    db.prepare("UPDATE trade_docs SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id)
  }, 'delete')
}

/** tradeDocs:restore — back from the bin; its own links must still fit. */
export function restoreTradeDoc(db: DB, id: number): TradeDoc {
  return setState(db, id, (d) => {
    if (!d.deleted_at) throw new Error(`${name(d)} is not in the bin`)
    db.prepare("UPDATE trade_docs SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ?").run(id)
    if (d.status !== 'cancelled') assertDocRestorable(db, id)
  }, 'restore')
}

/** tradeDocs:cancel — only while nothing live draws on it (short-close it otherwise). */
export function cancelTradeDoc(db: DB, id: number, reason: string | null): TradeDoc {
  return setState(db, id, (d) => {
    if (d.deleted_at) throw new Error(`${name(d)} is in the bin`)
    if (d.status === 'cancelled') throw new Error(`${name(d)} is already cancelled`)
    assertDocReleasable(db, id, 'cancel')
    db.prepare(
      "UPDATE trade_docs SET status = 'cancelled', closed_at = datetime('now'), close_reason = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(reason, id)
  }, 'cancel')
}

/** tradeDocs:close — short-close an order (a quotation: lost); the rest stops being pending. */
export function closeTradeDoc(db: DB, id: number, reason: string | null): TradeDoc {
  return setState(db, id, (d) => {
    if (d.deleted_at) throw new Error(`${name(d)} is in the bin`)
    if (d.status !== 'open') throw new Error(`${name(d)} is ${d.status === 'closed' ? 'already closed' : 'cancelled'}`)
    db.prepare(
      "UPDATE trade_docs SET status = 'closed', closed_at = datetime('now'), close_reason = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(reason, id)
  }, 'close')
}

/** tradeDocs:reopen — undo a close or a cancel (a cancelled order's links must fit again). The
 *  reason (WP 2.5d, optional) is kept on the audit trail; the close reason is cleared. */
export function reopenTradeDoc(db: DB, id: number, reason: string | null = null): TradeDoc {
  return setState(db, id, (d) => {
    if (d.deleted_at) throw new Error(`${name(d)} is in the bin`)
    if (d.status === 'open') throw new Error(`${name(d)} is already open`)
    db.prepare("UPDATE trade_docs SET status = 'open', closed_at = NULL, close_reason = NULL, updated_at = datetime('now') WHERE id = ?").run(id)
    if (d.status === 'cancelled') assertDocRestorable(db, id)
  }, 'reopen', reason)
}

// ---------- convert / duplicate ----------

/**
 * tradeDocs:convert — a draft of `to` drawing every still-pending line of an open document
 * (quotation → sales order; the only doc → doc pair in rules.ts). Never saved: the entry form
 * opens with it, and the save links the lines. Vouchers (challan, invoice, GRN, bill) draw on
 * orders through the "Add from…" drawer instead (links:openSourceLines).
 */
export function convertTradeDoc(db: DB, id: number, to: TradeDocKind): TradeDocDraft {
  const doc = getTradeDoc(db, id)
  if (!doc) throw new Error('Document not found')
  if (!linkRuleFor(doc.kind, to, 'fulfil')) {
    throw new Error(`A ${TRADE_DOC_TITLES[doc.kind].toLowerCase()} can't be converted into a ${TRADE_DOC_TITLES[to].toLowerCase()}`)
  }
  if (doc.deletedAt) throw new Error(`${doc.typeName} ${doc.number} is in the bin`)
  if (doc.manualStatus !== 'open') throw new Error(`${doc.typeName} ${doc.number} is ${doc.manualStatus}`)
  const lines = doc.lines.filter((l) => l.pendingMilli > 0)
  if (lines.length === 0) throw new Error(`Everything on ${doc.typeName} ${doc.number} is already converted`)
  return {
    kind: to, partyLedgerId: doc.partyLedgerId, reference: doc.reference, terms: doc.terms, narration: doc.narration,
    posOverride: doc.posOverride,
    lines: lines.map((l) => ({
      stockItemId: l.stockItemId, description: l.description, godownId: l.godownId, qtyMilli: l.pendingMilli, ratePaise: l.ratePaise,
      discountPaise: l.pendingMilli === l.qtyMilli ? l.discountPaise : Math.round((l.discountPaise * l.pendingMilli) / l.qtyMilli),
      dueDate: l.dueDate, source: { lineUid: l.lineUid, linkType: 'fulfil' }
    }))
  }
}

/** tradeDocs:duplicate — a fresh, unlinked copy of any document (same kind), for the form. */
export function duplicateTradeDoc(db: DB, id: number): TradeDocDraft {
  const doc = getTradeDoc(db, id)
  if (!doc) throw new Error('Document not found')
  return {
    kind: doc.kind, partyLedgerId: doc.partyLedgerId, reference: null, terms: doc.terms, narration: doc.narration,
    posOverride: doc.posOverride,
    lines: doc.lines.map((l) => ({
      stockItemId: l.stockItemId, description: l.description, godownId: l.godownId, qtyMilli: l.qtyMilli, ratePaise: l.ratePaise,
      discountPaise: l.discountPaise, dueDate: null, source: null
    }))
  }
}

// ---------- credit exposure (§9 Q9) ----------

/**
 * A party's open sales-order value: the pending quantity of every open, live sales order, priced
 * at its line rate with GST (the invoice computation, pro rata discount). Warn-only figure for the
 * credit-limit check — outstandings stay invoice-based.
 */
export function openSalesOrderValue(db: DB, partyLedgerId: number): number {
  if (!hasTradeSchema(db)) return 0
  const docs = db
    .prepare(
      `${DOC_SQL} WHERE tt.kind = 'sales_order' AND td.party_ledger_id = ? AND td.status = 'open' AND td.deleted_at IS NULL`
    )
    .all(partyLedgerId) as DocRow[]
  let total = 0
  for (const d of docs) {
    const lines = linesOf(db, d.id)
    const done = doneByUid(db, lines)
    const pending = lines
      .map((l) => ({ l, p: l.qty_milli - Math.min(l.qty_milli, done.get(l.line_uid) ?? 0) }))
      .filter((x) => x.p > 0)
    if (pending.length === 0) continue
    total += storedTradeDocTotals(
      pending.map(({ l, p }) => ({
        stockItemId: l.stock_item_id, qtyMilli: p, ratePaise: l.rate_paise,
        discountPaise: p === l.qty_milli ? l.discount_paise : Math.round((l.discount_paise * p) / l.qty_milli),
        gstRate: l.gst_rate, cessRate: l.cess_rate
      })),
      { kind: d.kind, companyStateCode: companyState(db), partyStateCode: d.party_state, posOverride: d.pos_override, date: d.date }
    ).total
  }
  return total
}
