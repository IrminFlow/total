// WP 2.5c: quotations, sales orders and purchase orders — save / validation, derived status,
// conversions and links (doc → doc and doc → voucher), pending figures, close / cancel / bin
// rules, soft-deleted exclusions, the credit-limit figure, printing and the form round trip.
import { describe, it, expect } from 'vitest'
import type { DB } from '../db/connection'
import type { TradeDocKind } from '@shared/domain'
import type { TradeDocInput } from '@shared/schemas'
import { buildTradeDocPayload, tradeDocStateFromDoc, tradeDocStateFromDraft, tradeDocToPayload } from '@shared/tradeCycle/edit'
import { TEST_INFO } from '../db/testdb'
import { listLedgers, listStockItems } from './masters'
import { deleteVoucher, getVoucher, restoreVoucher } from './vouchers'
import {
  cancelTradeDoc, closeTradeDoc, convertTradeDoc, deleteTradeDoc, duplicateTradeDoc, getTradeDoc, listTradeDocs,
  openSalesOrderValue, reopenTradeDoc, restoreTradeDoc, saveTradeDoc
} from './tradeDocs'
import { openSourceLines } from './tradeLinks'
import { pendingOrders, quotationPipeline } from './tradeReports'
import { tradeDocHtml } from './printTemplates'
import { getFeatures, setFeatures } from './config'
import * as stock from './stockAnalysis'
import { dc, grn, item, trade, tradeBooks, type TradeBooks } from './tradeFixture.testutil'

const D = '2025-06-01'
const TO = '2026-03-31'

interface Books extends TradeBooks {
  w: number
  g: number
}

function books(): Books {
  const b = tradeBooks()
  const w = item(b.db, 'Widget', { opening: [100, 1_000_000] }) // 100 @ ₹100, GST 18%
  const g = item(b.db, 'Gadget', { opening: [50, 500_000], gstRate: 5 })
  b.db.prepare("UPDATE ledgers SET state_code = '27' WHERE id IN (?, ?, ?)").run(b.buyer, b.buyer2, b.supplier)
  return { ...b, w, g }
}

const typeOf = (db: DB, kind: TradeDocKind): number =>
  (db.prepare('SELECT id FROM trade_doc_types WHERE kind = ? ORDER BY id LIMIT 1').get(kind) as { id: number }).id

interface DL {
  item: number
  qty: number
  /** Rate, whole rupees. */
  rate: number
  discount?: number
  from?: string
  uid?: string
}

function input(b: Books, kind: TradeDocKind, date: string, lines: DL[], opts: Partial<TradeDocInput> = {}): TradeDocInput {
  return {
    docTypeId: typeOf(b.db, kind), date,
    partyLedgerId: kind === 'purchase_order' ? b.supplier : b.buyer,
    ...opts,
    lines: lines.map((l) => {
      const ratePaise = l.rate * 100
      const gross = Math.round(l.qty * ratePaise)
      const discountPaise = (l.discount ?? 0) * 100
      return {
        stockItemId: l.item, qtyMilli: l.qty * 1000, ratePaise, discountPaise, amount: gross - discountPaise,
        ...(l.uid ? { lineUid: l.uid } : {}),
        ...(l.from ? { source: { lineUid: l.from, linkType: 'fulfil' as const } } : {})
      }
    })
  }
}

const doc = (b: Books, kind: TradeDocKind, date: string, lines: DL[], opts: Partial<TradeDocInput> = {}, id?: number) =>
  saveTradeDoc(b.db, input(b, kind, date, lines, opts), id).doc

const lineUid = (b: Books, docId: number, i = 0): string => getTradeDoc(b.db, docId)!.lines[i]!.lineUid
const status = (b: Books, id: number, asOn = '2025-06-15'): string => getTradeDoc(b.db, id, asOn)!.status

describe('save and validation', () => {
  it('numbers per series, snapshots GST, prices through the invoice computation', () => {
    const b = books()
    const q1 = doc(b, 'quotation', D, [{ item: b.w, qty: 10, rate: 100, discount: 50 }, { item: b.g, qty: 4, rate: 250 }], { validUntil: '2025-06-10' })
    const q2 = doc(b, 'quotation', D, [{ item: b.w, qty: 1, rate: 100 }])
    const so = doc(b, 'sales_order', D, [{ item: b.w, qty: 1, rate: 100 }])
    const po = doc(b, 'purchase_order', D, [{ item: b.w, qty: 1, rate: 90 }])
    expect([q1.number, q2.number, so.number, po.number]).toEqual(['QT-1', 'QT-2', 'SO-1', 'PO-1'])
    expect(q1.lines.map((l) => [l.gstRate, l.amount])).toEqual([[18, 95_000], [5, 100_000]])
    // 950 @18% intra + 1000 @5%: 171 + 50 tax, total 2171 (rounded to the rupee).
    expect(q1.totals).toMatchObject({ taxable: 195_000, cgst: 8_550 + 2_500, sgst: 8_550 + 2_500, igst: 0, total: 217_100 })
    expect(status(b, q1.id, '2025-06-05')).toBe('open')
    expect(q1.status).toBe('expired') // as on today
    // A later item GST change doesn't move a saved document; a re-save snapshots afresh.
    b.db.prepare('UPDATE stock_items SET gst_rate = 12 WHERE id = ?').run(b.w)
    expect(getTradeDoc(b.db, q1.id)!.lines[0]!.gstRate).toBe(18)
    const audit = b.db.prepare("SELECT action FROM audit_log WHERE entity = 'trade_doc' AND entity_id = ?").all(q1.id)
    expect(audit).toEqual([{ action: 'create' }])
  })

  it('refuses bad amounts, dates, numbers and parties', () => {
    const b = books()
    const bad = input(b, 'sales_order', D, [{ item: b.w, qty: 2, rate: 100 }])
    bad.lines[0]!.amount = 19_999
    expect(() => saveTradeDoc(b.db, bad)).toThrow(/qty × rate − discount/)
    expect(() => doc(b, 'quotation', D, [{ item: b.w, qty: 1, rate: 100 }], { validUntil: '2025-05-01' })).toThrow(/Valid until/)
    expect(() => doc(b, 'sales_order', D, [{ item: b.w, qty: 1, rate: 100 }], { dueDate: '2025-05-01' })).toThrow(/expected date/)
    const over = input(b, 'sales_order', D, [{ item: b.w, qty: 1, rate: 100 }])
    over.lines[0] = { ...over.lines[0]!, discountPaise: 20_000, amount: 0 }
    expect(() => saveTradeDoc(b.db, over)).toThrow(/discount/)
    expect(() => doc(b, 'sales_order', D, [], {})).toThrow()
    expect(() => doc(b, 'sales_order', D, [{ item: b.w, qty: 1, rate: 100 }], { partyLedgerId: 9999 })).toThrow(/Party/)
    doc(b, 'sales_order', D, [{ item: b.w, qty: 1, rate: 100 }], { number: 'SO-77' })
    expect(() => doc(b, 'sales_order', D, [{ item: b.w, qty: 1, rate: 100 }], { number: 'SO-77' })).toThrow(/already exists/)
    // The validity of an order / due date of a quotation are dropped, not stored.
    const so = doc(b, 'sales_order', D, [{ item: b.w, qty: 1, rate: 100 }], { validUntil: '2025-07-01', dueDate: '2025-07-02' })
    expect([so.validUntil, so.dueDate]).toEqual([null, '2025-07-02'])
  })

  it('edits lines in place by uid and keeps the uid', () => {
    const b = books()
    const so = doc(b, 'sales_order', D, [{ item: b.w, qty: 5, rate: 100 }, { item: b.g, qty: 2, rate: 250 }])
    const [u0, u1] = so.lines.map((l) => l.lineUid)
    const ids = so.lines.map((l) => l.id)
    const alt = doc(b, 'sales_order', D, [{ item: b.w, qty: 6, rate: 100, uid: u0 }], {}, so.id)
    expect(alt.lines).toHaveLength(1)
    expect(alt.lines[0]).toMatchObject({ lineUid: u0, id: ids[0], qtyMilli: 6000 })
    expect(b.db.prepare('SELECT 1 FROM trade_doc_lines WHERE line_uid = ?').get(u1)).toBeUndefined()
    // A foreign uid is never adopted.
    const other = doc(b, 'sales_order', D, [{ item: b.w, qty: 1, rate: 100 }])
    const stolen = doc(b, 'sales_order', D, [{ item: b.w, qty: 1, rate: 100, uid: u0 }], {}, other.id)
    expect(stolen.lines[0]!.lineUid).not.toBe(u0)
  })

  it('the entry form round-trips a saved document unchanged', () => {
    const b = books()
    const q = doc(b, 'quotation', D, [{ item: b.w, qty: 3, rate: 120, discount: 10 }], { validUntil: '2025-06-30', terms: '30 days', reference: 'RFQ-9' })
    const so = saveTradeDoc(b.db, { ...tradeDocStateFromDraftPayload(b, convertTradeDoc(b.db, q.id, 'sales_order')), dueDate: '2025-06-20' }).doc
    for (const d of [q, so]) {
      const ctx = {
        kind: d.kind, companyStateCode: TEST_INFO.stateCode,
        items: new Map(listStockItems(b.db).map((i) => [i.id, { gstRate: i.gstRate, cessRate: i.cessRate }])),
        ledgers: new Map(listLedgers(b.db).map((l) => [l.id, { stateCode: l.stateCode }]))
      }
      const built = buildTradeDocPayload(tradeDocStateFromDoc(d), ctx, d.docTypeId)
      expect(built.ok).toBe(true)
      expect(built.ok && built.payload).toEqual(tradeDocToPayload(d))
    }
  })
})

/** The SO form's payload for a converted draft (what the renderer posts after "Convert"). */
function tradeDocStateFromDraftPayload(b: Books, draft: ReturnType<typeof convertTradeDoc>): TradeDocInput {
  const ctx = {
    kind: draft.kind, companyStateCode: TEST_INFO.stateCode,
    items: new Map(listStockItems(b.db).map((i) => [i.id, { gstRate: i.gstRate, cessRate: i.cessRate }])),
    ledgers: new Map(listLedgers(b.db).map((l) => [l.id, { stateCode: l.stateCode }]))
  }
  const r = buildTradeDocPayload(tradeDocStateFromDraft(draft, D), ctx, typeOf(b.db, draft.kind))
  if (!r.ok) throw new Error(r.error)
  return r.payload
}

describe('derived status and conversions', () => {
  it('quotation: open → expired; converted partly then fully into sales orders', () => {
    const b = books()
    const q = doc(b, 'quotation', D, [{ item: b.w, qty: 10, rate: 100 }, { item: b.g, qty: 4, rate: 250 }], { validUntil: '2025-06-10' })
    expect(status(b, q.id, '2025-06-10')).toBe('open')
    expect(status(b, q.id, '2025-06-11')).toBe('expired')
    // Convert: every pending line, linked; partial quantity on the first.
    const draft = convertTradeDoc(b.db, q.id, 'sales_order')
    expect(draft.lines.map((l) => [l.qtyMilli, l.source?.lineUid])).toEqual([[10_000, q.lines[0]!.lineUid], [4000, q.lines[1]!.lineUid]])
    draft.lines = [{ ...draft.lines[0]!, qtyMilli: 6000 }]
    const so1 = saveTradeDoc(b.db, tradeDocStateFromDraftPayload(b, draft)).doc
    expect(so1.lines[0]!.source).toEqual({ lineUid: q.lines[0]!.lineUid, linkType: 'fulfil' })
    expect(so1.upstream.map((u) => u.label)).toEqual(['Quotation QT-1'])
    // Partly converted beats expired.
    expect(status(b, q.id, '2025-07-01')).toBe('partly_fulfilled')
    expect(getTradeDoc(b.db, q.id)!.lines.map((l) => l.pendingMilli)).toEqual([4000, 4000])
    expect(getTradeDoc(b.db, q.id)!.downstream.map((d) => [d.label, d.qtyMilli])).toEqual([['Sales Order SO-1', 6000]])
    const rest = convertTradeDoc(b.db, q.id, 'sales_order')
    expect(rest.lines.map((l) => l.qtyMilli)).toEqual([4000, 4000])
    saveTradeDoc(b.db, tradeDocStateFromDraftPayload(b, rest))
    expect(status(b, q.id)).toBe('fulfilled')
    expect(() => convertTradeDoc(b.db, q.id, 'sales_order')).toThrow(/already converted/)
    expect(() => convertTradeDoc(b.db, so1.id, 'purchase_order')).toThrow(/can't be converted/)
  })

  it('doc → doc links: capacity (I1), party and item (I2), closed source (I5)', () => {
    const b = books()
    const q = doc(b, 'quotation', D, [{ item: b.w, qty: 5, rate: 100 }])
    const qu = lineUid(b, q.id)
    expect(() => doc(b, 'sales_order', D, [{ item: b.w, qty: 6, rate: 100, from: qu }])).toThrow(/only 5/)
    expect(() => doc(b, 'sales_order', D, [{ item: b.g, qty: 1, rate: 100, from: qu }])).toThrow(/different item/)
    expect(() => doc(b, 'sales_order', D, [{ item: b.w, qty: 1, rate: 100, from: qu }], { partyLedgerId: b.buyer2 })).toThrow(/another party/)
    expect(() => doc(b, 'purchase_order', D, [{ item: b.w, qty: 1, rate: 100, from: qu }], { partyLedgerId: b.buyer })).toThrow(/can't fulfil/)
    const so = doc(b, 'sales_order', '2025-05-20', [{ item: b.w, qty: 2, rate: 100, from: qu }])
    expect(so.lines[0]!.source?.lineUid).toBe(qu)
    // Lost quotation: no new conversions; the existing SO keeps its link through an edit.
    closeTradeDoc(b.db, q.id, 'Lost on price')
    expect(status(b, q.id)).toBe('closed')
    expect(() => doc(b, 'sales_order', D, [{ item: b.w, qty: 1, rate: 100, from: qu }])).toThrow(/closed/)
    const kept = doc(b, 'sales_order', '2025-05-20', [{ item: b.w, qty: 2, rate: 105, uid: so.lines[0]!.lineUid, from: qu }], {}, so.id)
    expect(kept.lines[0]!.source?.lineUid).toBe(qu)
    // The open source list never offers a closed quotation.
    expect(openSourceLines(b.db, { partyLedgerId: b.buyer, targetKind: 'sales_order', linkType: 'fulfil' })).toEqual([])
  })

  it('sales order → challan (partial) → invoice; and SO → invoice directly moves stock', () => {
    const b = books()
    const so = doc(b, 'sales_order', D, [{ item: b.w, qty: 10, rate: 120 }])
    const su = lineUid(b, so.id)
    const offered = openSourceLines(b.db, { partyLedgerId: b.buyer, targetKind: 'delivery_note', linkType: 'fulfil' })
    expect(offered.map((o) => [o.tradeDocId, o.pendingMilli, o.ratePaise, o.label])).toEqual([[so.id, 10_000, 12_000, 'Sales Order SO-1 line 1']])
    const ch = dc(b, '2025-06-05', [{ item: b.w, qty: 4, amount: 48_000, from: su }])
    expect(status(b, so.id)).toBe('partly_fulfilled')
    expect(getTradeDoc(b.db, so.id)!.lines[0]).toMatchObject({ doneMilli: 4000, pendingMilli: 6000 })
    // The challan's lines draw on the SO; the invoice draws on the challan (no stock) …
    const chUid = getVoucher(b.db, ch.id)!.inventory[0]!.lineUid!
    const inv1 = trade(b, 'sales', '2025-06-06', [{ item: b.w, qty: 4, amount: 48_000, from: chUid }])
    expect(getVoucher(b.db, inv1.id)!.inventory[0]!.movesStock).toBe(false)
    // … and the rest goes straight from the SO to an invoice, which moves stock itself.
    const inv2 = trade(b, 'sales', '2025-06-07', [{ item: b.w, qty: 6, amount: 72_000, from: su }])
    expect(getVoucher(b.db, inv2.id)!.inventory[0]!.movesStock).toBe(true)
    expect(status(b, so.id)).toBe('fulfilled')
    expect(stock.stockSummary(b.db, TO).find((r) => r.stockItemId === b.w)!.closingQtyMilli).toBe(90_000)
    expect(getTradeDoc(b.db, so.id)!.downstream.map((d) => d.label)).toEqual(['Delivery Note 1', 'Sales 2'])
    // Over-delivery against the SO is refused (I1).
    expect(() => dc(b, '2025-06-08', [{ item: b.w, qty: 1, amount: 12_000, from: su }])).toThrow(/only 10/)
  })

  it('purchase order → GRN → bill, and PO → bill directly', () => {
    const b = books()
    const po = doc(b, 'purchase_order', D, [{ item: b.w, qty: 10, rate: 90 }, { item: b.g, qty: 5, rate: 80 }], { dueDate: '2025-06-10' })
    const [pw, pg] = po.lines.map((l) => l.lineUid)
    const offered = openSourceLines(b.db, { partyLedgerId: b.supplier, targetKind: 'receipt_note', linkType: 'fulfil' })
    expect(offered).toHaveLength(2)
    const g = grn(b, '2025-06-04', [{ item: b.w, qty: 7, amount: 63_000, from: pw }])
    const gu = getVoucher(b.db, g.id)!.inventory[0]!.lineUid!
    trade(b, 'purchase', '2025-06-05', [{ item: b.w, qty: 7, amount: 63_000, from: gu }])
    trade(b, 'purchase', '2025-06-05', [{ item: b.g, qty: 5, amount: 40_000, from: pg }])
    expect(getTradeDoc(b.db, po.id)!.lines.map((l) => l.pendingMilli)).toEqual([3000, 0])
    expect(status(b, po.id)).toBe('partly_fulfilled')
    const pend = pendingOrders(b.db, 'purchase_order', '2025-06-15')
    expect(pend.map((p) => [p.itemName, p.pendingMilli, p.pendingValue, p.overdueDays])).toEqual([['Widget', 3000, 27_000, 5]])
    // A supplier's PO is never offered to a sales document.
    expect(openSourceLines(b.db, { partyLedgerId: b.supplier, targetKind: 'delivery_note', linkType: 'fulfil' })).toEqual([])
  })
})

describe('pending figures and soft-deleted exclusions', () => {
  it('pending orders by as-on date; binned / optional targets and closed orders drop out', () => {
    const b = books()
    const so = doc(b, 'sales_order', D, [{ item: b.w, qty: 10, rate: 100 }, { item: b.g, qty: 2, rate: 250 }])
    const su = lineUid(b, so.id)
    const ch = dc(b, '2025-06-10', [{ item: b.w, qty: 4, amount: 40_000, from: su }])
    const row = (asOn: string) => pendingOrders(b.db, 'sales_order', asOn).find((r) => r.lineUid === su)
    expect(row('2025-06-09')!.pendingMilli).toBe(10_000) // the challan is later
    expect(row('2025-06-10')).toMatchObject({ doneMilli: 4000, pendingMilli: 6000, pendingValue: 60_000, ageDays: 9 })
    expect(listTradeDocs(b.db, { kind: 'sales_order', from: D, to: TO })[0]).toMatchObject({
      pendingValue: 60_000 + 50_000, fulfilledPct: 27, status: 'partly_fulfilled', downstreamLabels: ['Delivery Note 1']
    })
    // Bin the challan: the SO is pending again.
    deleteVoucher(b.db, ch.id)
    expect(row('2025-06-30')!.pendingMilli).toBe(10_000)
    expect(status(b, so.id)).toBe('open')
    restoreVoucher(b.db, ch.id)
    expect(row('2025-06-30')!.pendingMilli).toBe(6000)
    // Short-close: no longer pending, but the challan's link survives.
    closeTradeDoc(b.db, so.id, 'Customer cancelled the rest')
    expect(pendingOrders(b.db, 'sales_order', '2025-06-30')).toEqual([])
    expect(listTradeDocs(b.db, { kind: 'sales_order', from: D, to: TO })[0]).toMatchObject({ status: 'closed', pendingValue: 0 })
    expect(openSourceLines(b.db, { partyLedgerId: b.buyer, targetKind: 'sales', linkType: 'fulfil' }).filter((l) => l.tradeDocId)).toEqual([])
    reopenTradeDoc(b.db, so.id)
    expect(row('2025-06-30')!.pendingMilli).toBe(6000)
  })

  it('a binned order is not listed, not pending, not offered', () => {
    const b = books()
    const so = doc(b, 'sales_order', D, [{ item: b.w, qty: 3, rate: 100 }])
    deleteTradeDoc(b.db, so.id)
    expect(listTradeDocs(b.db, { kind: 'sales_order', from: D, to: TO })).toEqual([])
    expect(listTradeDocs(b.db, { kind: 'sales_order', from: D, to: TO, includeBinned: true })[0]).toMatchObject({ binned: true })
    expect(pendingOrders(b.db, 'sales_order', TO)).toEqual([])
    expect(openSourceLines(b.db, { partyLedgerId: b.buyer, targetKind: 'sales', linkType: 'fulfil' })).toEqual([])
    expect(() => doc(b, 'sales_order', D, [{ item: b.w, qty: 3, rate: 100 }], {}, so.id)).toThrow(/in the bin/)
    restoreTradeDoc(b.db, so.id)
    expect(pendingOrders(b.db, 'sales_order', TO)).toHaveLength(1)
  })
})

describe('close / cancel / bin rules', () => {
  it('cancel only while nothing draws on it; cancelling an SO frees its quotation', () => {
    const b = books()
    const q = doc(b, 'quotation', D, [{ item: b.w, qty: 5, rate: 100 }])
    const so = doc(b, 'sales_order', D, [{ item: b.w, qty: 5, rate: 100, from: lineUid(b, q.id) }])
    expect(() => cancelTradeDoc(b.db, q.id, null)).toThrow(/drawn on by Sales Order SO-1/)
    expect(() => deleteTradeDoc(b.db, q.id)).toThrow(/drawn on by Sales Order SO-1/)
    cancelTradeDoc(b.db, so.id, 'Duplicate entry')
    expect(status(b, so.id)).toBe('cancelled')
    expect(status(b, q.id)).toBe('open')
    // A cancelled / closed document is read-only.
    expect(() => doc(b, 'sales_order', D, [{ item: b.w, qty: 1, rate: 100 }], {}, so.id)).toThrow(/reopen/)
    // Another SO takes the quantity; un-cancelling the first no longer fits.
    doc(b, 'sales_order', D, [{ item: b.w, qty: 5, rate: 100, from: lineUid(b, q.id) }])
    expect(() => reopenTradeDoc(b.db, so.id)).toThrow(/taken that quantity/)
    expect(status(b, so.id)).toBe('cancelled')
    // A drawn-on SO can't be cancelled — short-close it instead.
    const so3 = doc(b, 'sales_order', D, [{ item: b.w, qty: 5, rate: 100 }])
    dc(b, '2025-06-03', [{ item: b.w, qty: 1, amount: 10_000, from: lineUid(b, so3.id) }])
    expect(() => cancelTradeDoc(b.db, so3.id, null)).toThrow(/short-close/)
    expect(closeTradeDoc(b.db, so3.id, null).status).toBe('closed')
  })

  it('binning an SO releases its quotation; restore re-checks capacity', () => {
    const b = books()
    const q = doc(b, 'quotation', D, [{ item: b.w, qty: 5, rate: 100 }])
    const qu = lineUid(b, q.id)
    const so = doc(b, 'sales_order', D, [{ item: b.w, qty: 5, rate: 100, from: qu }])
    deleteTradeDoc(b.db, so.id)
    expect(getTradeDoc(b.db, q.id)!.lines[0]!.pendingMilli).toBe(5000)
    doc(b, 'sales_order', D, [{ item: b.w, qty: 2, rate: 100, from: qu }])
    expect(() => restoreTradeDoc(b.db, so.id)).toThrow(/taken that quantity/)
    expect(getTradeDoc(b.db, so.id)!.deletedAt).not.toBeNull()
  })

  it('a drawn-on line keeps its item and enough quantity; the party stays', () => {
    const b = books()
    const so = doc(b, 'sales_order', D, [{ item: b.w, qty: 5, rate: 100 }, { item: b.g, qty: 1, rate: 100 }])
    const [u0, u1] = so.lines.map((l) => l.lineUid)
    dc(b, '2025-06-03', [{ item: b.w, qty: 3, amount: 30_000, from: u0 }])
    expect(() => doc(b, 'sales_order', D, [{ item: b.g, qty: 1, rate: 100, uid: u1 }], {}, so.id)).toThrow(/can't be removed/)
    expect(() => doc(b, 'sales_order', D, [{ item: b.w, qty: 2, rate: 100, uid: u0 }, { item: b.g, qty: 1, rate: 100, uid: u1 }], {}, so.id)).toThrow(/below the 3/)
    expect(() => doc(b, 'sales_order', D, [{ item: b.w, qty: 5, rate: 100, uid: u0 }], { partyLedgerId: b.buyer2 }, so.id)).toThrow()
    // Rate / quantity above what is drawn are fine; a dropped un-drawn line too.
    const ok = doc(b, 'sales_order', D, [{ item: b.w, qty: 3, rate: 110, uid: u0 }], {}, so.id)
    expect(ok.status).toBe('fulfilled')
  })

  it('duplicate is an unlinked copy', () => {
    const b = books()
    const q = doc(b, 'quotation', D, [{ item: b.w, qty: 5, rate: 100 }], { terms: 'Net 30', reference: 'RFQ-1' })
    const d = duplicateTradeDoc(b.db, q.id)
    expect(d).toMatchObject({ kind: 'quotation', terms: 'Net 30', reference: null })
    expect(d.lines[0]!.source).toBeNull()
  })
})

describe('credit limit (§9 Q9), printing, pipeline', () => {
  it('open SO value is a separate warn-only figure on the sales invoice', () => {
    const b = books()
    setFeatures(b.db, { ...getFeatures(b.db), orders: true })
    b.db.prepare('UPDATE ledgers SET credit_limit = 100000 WHERE id = ?').run(b.buyer) // ₹1,000
    const so = doc(b, 'sales_order', D, [{ item: b.w, qty: 10, rate: 100 }]) // ₹1,000 + 18% = ₹1,180
    expect(openSalesOrderValue(b.db, b.buyer)).toBe(118_000)
    // Invoice ₹500 against the SO: outstanding 500 ≤ limit, + open orders (5 × 118 = 590) > limit → warn only.
    const inv = trade(b, 'sales', '2025-06-03', [{ item: b.w, qty: 5, amount: 50_000, from: lineUid(b, so.id) }])
    expect(inv.warnings.creditLimitExceeded).toMatchObject({ outstanding: 50_000, openSalesOrders: 59_000, ordersOnly: true })
    setFeatures(b.db, { ...getFeatures(b.db), enforceCreditLimit: true })
    expect(() => trade(b, 'sales', '2025-06-04', [{ item: b.w, qty: 1, amount: 10_000 }])).not.toThrow()
    // Flag off: no order figure at all.
    setFeatures(b.db, { ...getFeatures(b.db), orders: false, enforceCreditLimit: false })
    const inv3 = trade(b, 'sales', '2025-06-05', [{ item: b.w, qty: 1, amount: 10_000 }])
    expect(inv3.warnings.creditLimitExceeded).toBeNull()
  })

  it('prints a quotation / order as a commercial document', () => {
    const b = books()
    const company = { ...TEST_INFO, gstin: '27AAACT1234A1Z5' }
    const q = doc(b, 'quotation', D, [{ item: b.w, qty: 2, rate: 100 }], { validUntil: '2025-06-30', terms: 'Prices ex-works', reference: 'RFQ-7' })
    const html = tradeDocHtml(b.db, company, q.id).html
    expect(html).toContain('QUOTATION')
    expect(html).toContain('QT-1')
    expect(html).toContain('Valid until')
    expect(html).toContain('Prices ex-works')
    expect(html).not.toContain('IRN')
    expect(html).not.toContain('Balance outstanding')
    const po = doc(b, 'purchase_order', D, [{ item: b.w, qty: 2, rate: 90 }], { dueDate: '2025-06-09' })
    const poHtml = tradeDocHtml(b.db, company, po.id).html
    expect(poHtml).toContain('PURCHASE ORDER')
    expect(poHtml).toContain('Supplier')
    expect(poHtml).toContain('Deliver by')
    expect(doc(b, 'sales_order', D, [{ item: b.w, qty: 1, rate: 1 }]) && tradeDocHtml(b.db, company, 3).html).toContain('SALES ORDER')
  })

  it('quotation pipeline: outcomes and conversion rate', () => {
    const b = books()
    const won = doc(b, 'quotation', D, [{ item: b.w, qty: 2, rate: 100 }])
    doc(b, 'sales_order', D, [{ item: b.w, qty: 2, rate: 100, from: lineUid(b, won.id) }])
    const half = doc(b, 'quotation', D, [{ item: b.w, qty: 4, rate: 100 }])
    trade(b, 'sales', '2025-06-02', [{ item: b.w, qty: 1, amount: 10_000, from: lineUid(b, half.id) }]) // quotation → invoice directly
    const lost = doc(b, 'quotation', D, [{ item: b.w, qty: 1, rate: 100 }])
    closeTradeDoc(b.db, lost.id, 'Price')
    doc(b, 'quotation', D, [{ item: b.w, qty: 1, rate: 100 }], { validUntil: '2025-06-05' })
    doc(b, 'quotation', D, [{ item: b.w, qty: 1, rate: 100 }])
    const p = quotationPipeline(b.db, D, TO, '2025-06-30')
    expect(p.rows.map((r) => r.outcome)).toEqual(['converted', 'partly_converted', 'lost', 'expired', 'open'])
    expect(p.rows[1]!.convertedValue).toBe(10_000)
    expect(p.conversionRatePct).toBe(50) // 2 converted of 4 decided
    expect(p.valueConversionPct).toBe(33.3) // (200 + 100) / 900
  })
})
