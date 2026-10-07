// WP 2.5d: the linked-documents chain, returns (limits, register, rate, orders never re-opened),
// closure (challans / GRNs, stale quotations, reopen with audit), three-way match with tolerances,
// GRNI / GDNI against the pending reports and the year-end preview, order book, lead time and
// demand vs stock.
import { describe, it, expect } from 'vitest'
import type { DB } from '../db/connection'
import type { TradeDocKind } from '@shared/domain'
import type { TradeDocInput } from '@shared/schemas'
import { DEFAULT_MATCH_TOLERANCES } from '@shared/tradeCycle/match'
import { deleteVoucher, getVoucher } from './vouchers'
import { closeTradeDoc, getTradeDoc, reopenTradeDoc, saveTradeDoc } from './tradeDocs'
import { openSourceLines } from './tradeLinks'
import { pendingOrders, pendingStockNotes } from './tradeReports'
import { tradeChain } from './tradeChain'
import {
  itemDemand, leadTime, orderBook, returnsRate, returnsRegister, staleDocuments, threeWayMatchReport, unbilledGoods
} from './tradeAnalysis'
import { closeStaleQuotations, closeStockNote, noteClosure, reopenStockNote } from './tradeClosure'
import { closePreview } from './yearEnd'
import * as stock from './stockAnalysis'
import { dc, grn, item, trade, tradeBooks, uid, type TradeBooks } from './tradeFixture.testutil'

const FAR = '2099-12-31'

interface Books extends TradeBooks {
  w: number
  g: number
}

function books(): Books {
  const b = tradeBooks()
  const w = item(b.db, 'Widget', { opening: [100, 1_000_000] }) // 100 @ ₹100
  const g = item(b.db, 'Gadget', { opening: [50, 500_000], gstRate: 5 })
  return { ...b, w, g }
}

const typeOf = (db: DB, kind: TradeDocKind): number =>
  (db.prepare('SELECT id FROM trade_doc_types WHERE kind = ? ORDER BY id LIMIT 1').get(kind) as { id: number }).id

interface DL {
  item: number
  qty: number
  /** Whole rupees. */
  rate: number
  from?: string
}

function doc(b: Books, kind: TradeDocKind, date: string, lines: DL[], opts: Partial<TradeDocInput> = {}) {
  return saveTradeDoc(b.db, {
    docTypeId: typeOf(b.db, kind), date, partyLedgerId: kind === 'purchase_order' ? b.supplier : b.buyer, ...opts,
    lines: lines.map((l) => ({
      stockItemId: l.item, qtyMilli: l.qty * 1000, ratePaise: l.rate * 100, discountPaise: 0, amount: l.qty * l.rate * 100,
      ...(l.from ? { source: { lineUid: l.from, linkType: 'fulfil' as const } } : {})
    }))
  }).doc
}

const docUid = (b: Books, id: number, i = 0): string => getTradeDoc(b.db, id)!.lines[i]!.lineUid

describe('trade:chain — linked documents', () => {
  it('walks quotation → SO → challans → invoice → credit note, with partial quantities and levels', () => {
    const b = books()
    const qt = doc(b, 'quotation', '2025-05-01', [{ item: b.w, qty: 10, rate: 150 }])
    const so = doc(b, 'sales_order', '2025-05-02', [{ item: b.w, qty: 10, rate: 150, from: docUid(b, qt.id) }])
    const d1 = dc(b, '2025-05-03', [{ item: b.w, qty: 4, amount: 60000, from: docUid(b, so.id) }])
    const d2 = dc(b, '2025-05-04', [{ item: b.w, qty: 3, amount: 45000, from: docUid(b, so.id) }])
    const inv = trade(b, 'sales', '2025-05-05', [
      { item: b.w, qty: 4, amount: 60000, from: uid(b.db, d1.id) },
      { item: b.w, qty: 2, amount: 30000, from: uid(b.db, d2.id) }
    ])
    const cn = trade(b, 'credit_note', '2025-05-10', [{ item: b.w, qty: 1, amount: 15000, from: uid(b.db, inv.id, 0), link: 'return' }])

    // The same graph from any member: from the credit note (the far end) and from the quotation.
    for (const root of [{ voucherId: cn.id }, { tradeDocId: qt.id }]) {
      const c = tradeChain(b.db, root)
      expect(c.nodes.map((n) => [n.label.split(' ')[0], n.level])).toEqual([
        ['Quotation', 0], ['Sales', 1], ['Delivery', 2], ['Delivery', 2], ['Sales', 3], ['Credit', 4]
      ])
      expect(c.edges).toHaveLength(6)
      expect(c.truncated).toBe(false)
    }
    const c = tradeChain(b.db, { voucherId: inv.id })
    expect(c.rootKey).toBe(`v${inv.id}`)
    expect(c.nodes.find((n) => n.isRoot)!.voucherId).toBe(inv.id)
    const byKey = new Map(c.nodes.map((n) => [n.key, n]))
    expect(byKey.get(`d${qt.id}`)!.status).toBe('fulfilled')
    expect(byKey.get(`d${so.id}`)!.status).toBe('partly_fulfilled')
    expect(byKey.get(`d${so.id}`)!.lines[0]!.fulfilledMilli).toBe(7000)
    expect(byKey.get(`v${d1.id}`)!.status).toBe('fulfilled')
    expect(byKey.get(`v${d2.id}`)!.status).toBe('partly_fulfilled')
    expect(byKey.get(`v${inv.id}`)!.status).toBe('partly_returned')
    expect(byKey.get(`v${inv.id}`)!.lines[0]!.returnedMilli).toBe(1000)
    const soToDc = c.edges.filter((e) => e.from === `d${so.id}`)
    expect(soToDc.map((e) => e.qtyMilli).sort()).toEqual([3000, 4000])
    expect(c.edges.find((e) => e.to === `v${cn.id}`)!.linkType).toBe('return')
  })

  it('a binned target stays in the chain, not live; a document with no links is a chain of one', () => {
    const b = books()
    const d = dc(b, '2025-05-03', [{ item: b.w, qty: 4, amount: 60000 }])
    const inv = trade(b, 'sales', '2025-05-05', [{ item: b.w, qty: 4, amount: 60000, from: uid(b.db, d.id) }])
    deleteVoucher(b.db, inv.id)
    const c = tradeChain(b.db, { voucherId: d.id })
    const n = c.nodes.find((x) => x.voucherId === inv.id)!
    expect(n.status).toBe('binned')
    expect(n.live).toBe(false)
    expect(c.edges[0]!.live).toBe(false)
    expect(c.nodes.find((x) => x.voucherId === d.id)!.status).toBe('open')
    const lone = trade(b, 'sales', '2025-05-06', [{ item: b.w, qty: 1, amount: 15000 }])
    expect(tradeChain(b.db, { voucherId: lone.id }).nodes).toHaveLength(1)
    expect(() => tradeChain(b.db, { voucherId: 99999 })).toThrow(/not found/)
  })

  it('purchase side: PO → GRN → bill → debit note', () => {
    const b = books()
    const po = doc(b, 'purchase_order', '2025-05-01', [{ item: b.w, qty: 10, rate: 100 }])
    const g = grn(b, '2025-05-02', [{ item: b.w, qty: 10, amount: 100000, from: docUid(b, po.id) }])
    const bill = trade(b, 'purchase', '2025-05-03', [{ item: b.w, qty: 10, amount: 110000, from: uid(b.db, g.id) }])
    trade(b, 'debit_note', '2025-05-09', [{ item: b.w, qty: 2, amount: 22000, from: uid(b.db, bill.id), link: 'return' }])
    const c = tradeChain(b.db, { tradeDocId: po.id })
    expect(c.nodes.map((n) => n.kind)).toEqual(['purchase_order', 'receipt_note', 'purchase', 'debit_note'])
    expect(c.nodes.map((n) => n.level)).toEqual([0, 1, 2, 3])
  })
})

describe('returns', () => {
  it('returnable = invoiced − already returned; a return can never exceed the source', () => {
    const b = books()
    const inv = trade(b, 'sales', '2025-05-01', [{ item: b.w, qty: 5, amount: 75000 }])
    const src = uid(b.db, inv.id)
    trade(b, 'credit_note', '2025-05-05', [{ item: b.w, qty: 2, amount: 30000, from: src, link: 'return' }])
    const open = openSourceLines(b.db, { partyLedgerId: b.buyer, targetKind: 'credit_note', linkType: 'return' })
    expect(open.map((l) => [l.lineUid, l.doneMilli, l.pendingMilli])).toEqual([[src, 2000, 3000]])
    expect(() => trade(b, 'credit_note', '2025-05-06', [{ item: b.w, qty: 4, amount: 60000, from: src, link: 'return' }])).toThrow(/returned/)
    trade(b, 'credit_note', '2025-05-06', [{ item: b.w, qty: 3, amount: 45000, from: src, link: 'return' }])
    expect(openSourceLines(b.db, { partyLedgerId: b.buyer, targetKind: 'credit_note', linkType: 'return' })).toHaveLength(0)
    // Another party's invoice is not offered and can't be returned against.
    expect(openSourceLines(b.db, { partyLedgerId: b.buyer2, targetKind: 'credit_note', linkType: 'return' })).toHaveLength(0)
  })

  it('a debit note against a bill and the rejection notes respect the same limits', () => {
    const b = books()
    const bill = trade(b, 'purchase', '2025-05-01', [{ item: b.w, qty: 5, amount: 50000 }])
    expect(() => trade(b, 'debit_note', '2025-05-02', [{ item: b.w, qty: 6, amount: 60000, from: uid(b.db, bill.id), link: 'return' }])).toThrow()
    // GRN not yet billed: rejection out on a challan, capped by what is not billed.
    const g = grn(b, '2025-05-03', [{ item: b.w, qty: 10, amount: 100000 }])
    trade(b, 'purchase', '2025-05-04', [{ item: b.w, qty: 7, amount: 70000, from: uid(b.db, g.id) }])
    expect(() => dc(b, '2025-05-05', [{ item: b.w, qty: 4, amount: 0, from: uid(b.db, g.id), link: 'return' }], { party: b.supplier, purpose: 'non_supply' })).toThrow()
    dc(b, '2025-05-05', [{ item: b.w, qty: 3, amount: 30000, from: uid(b.db, g.id), link: 'return' }], { party: b.supplier, purpose: 'non_supply' })
    expect(pendingStockNotes(b.db, 'receipt_note', FAR)).toHaveLength(0)
  })

  it('returns never re-open an order (Q11); serials and batches flow back', () => {
    const b = books()
    const so = doc(b, 'sales_order', '2025-05-01', [{ item: b.w, qty: 5, rate: 150 }])
    const inv = trade(b, 'sales', '2025-05-02', [{ item: b.w, qty: 5, amount: 75000, from: docUid(b, so.id) }])
    expect(pendingOrders(b.db, 'sales_order', FAR)).toHaveLength(0)
    trade(b, 'credit_note', '2025-05-05', [{ item: b.w, qty: 2, amount: 30000, from: uid(b.db, inv.id), link: 'return' }])
    expect(pendingOrders(b.db, 'sales_order', FAR)).toHaveLength(0)
    expect(getTradeDoc(b.db, so.id)!.status).toBe('fulfilled')

    const s = item(b.db, 'Laptop', { serials: true, opening: [0, 0] })
    trade(b, 'purchase', '2025-05-01', [{ item: s, qty: 3, amount: 300000, serials: ['A1', 'A2', 'A3'] }])
    const sale = trade(b, 'sales', '2025-05-02', [{ item: s, qty: 2, amount: 300000, serials: ['A1', 'A2'] }])
    const offered = openSourceLines(b.db, { partyLedgerId: b.buyer, targetKind: 'credit_note', linkType: 'return' }).find((l) => l.stockItemId === s)!
    expect(offered.serials).toEqual(['A1', 'A2'])
    trade(b, 'credit_note', '2025-05-06', [{ item: s, qty: 1, amount: 150000, serials: ['A2'], from: uid(b.db, sale.id), link: 'return' }])
    const status = b.db.prepare("SELECT serial, status FROM serial_numbers ORDER BY serial").all() as { serial: string; status: string }[]
    expect(status.find((x) => x.serial === 'A2')!.status).toBe('in_stock')
    expect(status.find((x) => x.serial === 'A1')!.status).toBe('sold')
    const after = openSourceLines(b.db, { partyLedgerId: b.buyer, targetKind: 'credit_note', linkType: 'return' }).find((l) => l.stockItemId === s)!
    expect(after.serials).toEqual(['A1'])
  })

  it('register: linked and unlinked returns with the reason from the narration; rate by item and party', () => {
    const b = books()
    const d = dc(b, '2025-05-01', [{ item: b.w, qty: 4, amount: 60000 }])
    const inv = trade(b, 'sales', '2025-05-03', [{ item: b.w, qty: 4, amount: 60000, from: uid(b.db, d.id) }])
    const cn = trade(b, 'credit_note', '2025-05-13', [{ item: b.w, qty: 1, amount: 15000, from: uid(b.db, inv.id), link: 'return' }])
    b.db.prepare("UPDATE vouchers SET narration = 'Damaged in transit' WHERE id = ?").run(cn.id)
    trade(b, 'credit_note', '2025-05-14', [{ item: b.g, qty: 1, amount: 9000 }], { party: b.buyer2 })
    trade(b, 'sales', '2025-05-02', [{ item: b.g, qty: 10, amount: 90000 }], { party: b.buyer2 })
    // A rejection GRN against a challan is a sales-side return too.
    const d2 = dc(b, '2025-05-20', [{ item: b.w, qty: 2, amount: 30000 }])
    grn(b, '2025-05-22', [{ item: b.w, qty: 1, amount: 15000, from: uid(b.db, d2.id), link: 'return' }], { party: b.buyer, purpose: 'return' })

    const reg = returnsRegister(b.db, { side: 'sales', from: '2025-04-01', to: '2026-03-31' })
    expect(reg.map((r) => [r.kind, r.qtyMilli, r.againstKind, r.daysAfter])).toEqual([
      ['credit_note', 1000, 'sales', 10], ['credit_note', 1000, null, null], ['receipt_note', 1000, 'delivery_note', 2]
    ])
    expect(reg[0]!.reason).toBe('Damaged in transit')
    expect(reg[0]!.againstVoucherId).toBe(inv.id)
    expect(returnsRegister(b.db, { side: 'purchase', from: '2025-04-01', to: '2026-03-31' })).toHaveLength(0)

    const byItem = returnsRate(b.db, { side: 'sales', from: '2025-04-01', to: '2026-03-31', by: 'item' })
    const widget = byItem.find((r) => r.stockItemId === b.w)!
    expect([widget.soldQtyMilli, widget.returnedQtyMilli, widget.qtyRatePct]).toEqual([4000, 2000, 50])
    const gadget = byItem.find((r) => r.stockItemId === b.g)!
    expect([gadget.soldQtyMilli, gadget.returnedQtyMilli, gadget.qtyRatePct, gadget.valueRatePct]).toEqual([10000, 1000, 10, 10])
    const byParty = returnsRate(b.db, { side: 'sales', from: '2025-04-01', to: '2026-03-31', by: 'party' })
    expect(byParty.find((r) => r.partyLedgerId === b.buyer2)!.returnedValue).toBe(9000)
  })

  it('a credit note against a challan-backed invoice brings stock back at the engine cost', () => {
    const b = books()
    const d = dc(b, '2025-05-01', [{ item: b.w, qty: 4, amount: 60000 }]) // leaves at ₹100 avg
    const inv = trade(b, 'sales', '2025-05-03', [{ item: b.w, qty: 4, amount: 60000, from: uid(b.db, d.id) }])
    trade(b, 'credit_note', '2025-05-10', [{ item: b.w, qty: 1, amount: 15000, from: uid(b.db, inv.id), link: 'return' }])
    const s = stock.stockSummary(b.db, FAR).find((r) => r.stockItemId === b.w)!
    expect(s.closingQtyMilli).toBe(97_000)
    expect(s.closingValue).toBe(970_000) // back at ₹100, not the ₹150 sale value
  })
})

describe('closure', () => {
  it('a challan short-close stops it being pending and takes no new links; reopen undoes it; both audited', () => {
    const b = books()
    const d = dc(b, '2025-05-01', [{ item: b.w, qty: 4, amount: 60000 }])
    trade(b, 'sales', '2025-05-03', [{ item: b.w, qty: 1, amount: 15000, from: uid(b.db, d.id) }])
    expect(pendingStockNotes(b.db, 'delivery_note', FAR)).toHaveLength(1)
    closeStockNote(b.db, d.id, 'Customer kept the rest as samples')
    expect(noteClosure(b.db, d.id).closeReason).toBe('Customer kept the rest as samples')
    expect(pendingStockNotes(b.db, 'delivery_note', FAR)).toHaveLength(0)
    expect(unbilledGoods(b.db, FAR).gdni.value).toBe(0)
    expect(() => trade(b, 'sales', '2025-05-04', [{ item: b.w, qty: 1, amount: 15000, from: uid(b.db, d.id) }])).toThrow(/closed/)
    expect(() => closeStockNote(b.db, d.id, null)).toThrow(/already closed/)
    // A re-save of the challan keeps the closure (it is not a voucher field).
    expect(getVoucher(b.db, d.id)!.trade?.purpose).toBe('supply')
    reopenStockNote(b.db, d.id, 'Invoicing after all')
    expect(noteClosure(b.db, d.id).closedAt).toBeNull()
    expect(pendingStockNotes(b.db, 'delivery_note', FAR)[0]!.pendingMilli).toBe(3000)
    const audit = b.db.prepare("SELECT after_json AS a FROM audit_log WHERE entity = 'voucher' AND entity_id = ? ORDER BY id").all(d.id) as { a: string }[]
    const actions = audit.map((r) => JSON.parse(r.a)).filter((x) => x.action)
    expect(actions.map((x) => [x.action, x.reason])).toEqual([['close', 'Customer kept the rest as samples'], ['reopen', 'Invoicing after all']])
    // Fully invoiced: nothing to close.
    trade(b, 'sales', '2025-05-05', [{ item: b.w, qty: 3, amount: 45000, from: uid(b.db, d.id) }])
    expect(() => closeStockNote(b.db, d.id, null)).toThrow(/already invoiced/)
  })

  it('reopen of a trade doc keeps its reason on the audit trail', () => {
    const b = books()
    const so = doc(b, 'sales_order', '2025-05-01', [{ item: b.w, qty: 5, rate: 150 }])
    closeTradeDoc(b.db, so.id, 'Customer cancelled')
    reopenTradeDoc(b.db, so.id, 'Customer came back')
    const last = b.db.prepare("SELECT after_json AS a FROM audit_log WHERE entity = 'trade_doc' AND entity_id = ? ORDER BY id DESC LIMIT 1").get(so.id) as { a: string }
    expect(JSON.parse(last.a)).toMatchObject({ action: 'reopen', reason: 'Customer came back', status: 'open' })
  })

  it('stale documents; bulk close of quotations past validity (all, or a subset)', () => {
    const b = books()
    const q1 = doc(b, 'quotation', '2025-05-01', [{ item: b.w, qty: 5, rate: 150 }], { validUntil: '2025-05-15' })
    const q2 = doc(b, 'quotation', '2025-05-02', [{ item: b.w, qty: 5, rate: 150 }], { validUntil: '2025-05-20' })
    const q3 = doc(b, 'quotation', '2025-05-03', [{ item: b.w, qty: 5, rate: 150 }], { validUntil: '2025-12-31' })
    // Fully converted: never stale.
    const q4 = doc(b, 'quotation', '2025-05-04', [{ item: b.w, qty: 1, rate: 150 }], { validUntil: '2025-05-10' })
    doc(b, 'sales_order', '2025-05-05', [{ item: b.w, qty: 1, rate: 150, from: docUid(b, q4.id) }], { dueDate: '2025-05-20' })
    dc(b, '2025-05-01', [{ item: b.w, qty: 1, amount: 15000 }])
    const asOn = '2025-06-30'
    const stale = staleDocuments(b.db, asOn, { orderAgeDays: 30, noteAgeDays: 30 })
    expect(stale.map((r) => [r.kind, r.why]).sort()).toEqual([
      ['delivery_note', 'aged'], ['quotation', 'expired'], ['quotation', 'expired'], ['sales_order', 'overdue']
    ])
    expect(stale.find((r) => r.tradeDocId === q1.id)!.daysStale).toBe(46)
    expect(closeStaleQuotations(b.db, { asOn, ids: [q2.id, q3.id] }).closed).toEqual([q2.id])
    expect(getTradeDoc(b.db, q2.id)!.closeReason).toBe('Validity expired')
    expect(getTradeDoc(b.db, q3.id, asOn)!.status).toBe('open')
    expect(closeStaleQuotations(b.db, { asOn, reason: 'Lost to competitor' }).closed).toEqual([q1.id])
    expect(getTradeDoc(b.db, q4.id)!.status).toBe('fulfilled')
    expect(staleDocuments(b.db, asOn).filter((r) => r.kind === 'quotation')).toHaveLength(0)
  })
})

describe('three-way match', () => {
  function cycle(b: Books, billRate: number, opts: { grnQty?: number; billQty?: number } = {}) {
    const po = doc(b, 'purchase_order', '2025-05-01', [{ item: b.w, qty: 10, rate: 100 }])
    const g = grn(b, '2025-05-02', [{ item: b.w, qty: opts.grnQty ?? 10, amount: (opts.grnQty ?? 10) * 10000, from: docUid(b, po.id) }])
    const billQty = opts.billQty ?? opts.grnQty ?? 10
    const bill = trade(b, 'purchase', '2025-05-03', [{ item: b.w, qty: billQty, amount: billQty * billRate * 100, from: uid(b.db, g.id) }])
    return { po, g, bill }
  }
  const run = (b: Books, tol: Partial<typeof DEFAULT_MATCH_TOLERANCES> = {}) =>
    threeWayMatchReport(b.db, { from: '2025-04-01', to: '2026-03-31', tolerances: { ...DEFAULT_MATCH_TOLERANCES, ...tol } })

  it('a clean PO → GRN → bill matches; a rate variance is flagged against the PO rate', () => {
    const b = books()
    cycle(b, 100)
    expect(run(b)).toEqual([])
    const c = cycle(b, 110)
    const rows = run(b)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ exception: 'rate_variance', expectedPaise: 100000, actualPaise: 110000, diffPaise: 10000, diffBp: 1000 })
    expect(rows[0]!.po!.tradeDocId).toBe(c.po.id)
    expect(rows[0]!.grn!.voucherId).toBe(c.g.id)
    expect(rows[0]!.bill!.voucherId).toBe(c.bill.id)
  })

  it('tolerances: within 10 % or within ₹ is not an exception (both must be exceeded)', () => {
    const b = books()
    cycle(b, 110)
    expect(run(b, { rateTolBp: 1000 })).toHaveLength(0)
    expect(run(b, { rateTolBp: 999 })).toHaveLength(1)
    expect(run(b, { amountTolPaise: 10000 })).toHaveLength(0)
    expect(run(b, { amountTolPaise: 9999 })).toHaveLength(1)
  })

  it('partly billed GRN, bill without GRN, GRN without PO, unmatched bill lines (optional)', () => {
    const b = books()
    cycle(b, 100, { grnQty: 10, billQty: 6 })
    const po2 = doc(b, 'purchase_order', '2025-05-05', [{ item: b.g, qty: 4, rate: 100 }])
    trade(b, 'purchase', '2025-05-06', [{ item: b.g, qty: 4, amount: 40000, from: docUid(b, po2.id) }])
    grn(b, '2025-05-07', [{ item: b.g, qty: 2, amount: 20000 }])
    trade(b, 'purchase', '2025-05-08', [{ item: b.g, qty: 1, amount: 10000 }])
    const rows = run(b)
    expect(rows.map((r) => [r.exception, r.diffQtyMilli])).toEqual([
      ['qty_unbilled', 4000], ['bill_without_grn', 4000], ['grn_without_po', 2000]
    ])
    expect(rows[0]!.diffPaise).toBe(40000)
    expect(run(b, { qtyTolBp: 4000 }).map((r) => r.exception)).not.toContain('qty_unbilled')
    expect(run(b, { flagGrnWithoutPo: false }).map((r) => r.exception)).not.toContain('grn_without_po')
    expect(run(b, { flagUnmatchedBills: true }).map((r) => r.exception)).toContain('unmatched_bill_line')
  })

  it('a binned bill drops out and leaves its GRN unbilled again (not an exception)', () => {
    const b = books()
    const c = cycle(b, 120)
    expect(run(b)).toHaveLength(1)
    deleteVoucher(b.db, c.bill.id)
    expect(run(b)).toEqual([])
  })
})

describe('GRNI / GDNI', () => {
  it('equal the pending reports\' values for supply challans and purchase GRNs, and reach the close preview', () => {
    const b = books()
    const d = dc(b, '2025-05-01', [{ item: b.w, qty: 4, amount: 60000 }, { item: b.g, qty: 2, amount: 20000 }])
    trade(b, 'sales', '2025-05-03', [{ item: b.w, qty: 1, amount: 15000, from: uid(b.db, d.id, 0) }])
    dc(b, '2025-05-02', [{ item: b.w, qty: 1, amount: 15000 }], { purpose: 'non_supply' })
    const g = grn(b, '2025-05-04', [{ item: b.w, qty: 10, amount: 100000 }])
    trade(b, 'purchase', '2025-05-05', [{ item: b.w, qty: 6, amount: 60000, from: uid(b.db, g.id) }])
    grn(b, '2025-05-06', [{ item: b.g, qty: 1, amount: 9000 }], { purpose: 'job_work' })
    const asOn = '2026-03-31'
    const u = unbilledGoods(b.db, asOn)
    const pDc = pendingStockNotes(b.db, 'delivery_note', asOn).filter((r) => r.purpose === 'supply' || r.purpose === 'approval')
    const pGrn = pendingStockNotes(b.db, 'receipt_note', asOn).filter((r) => r.purpose === 'purchase')
    expect(u.gdni.value).toBe(pDc.reduce((s, r) => s + r.pendingValue, 0))
    expect(u.grni.value).toBe(pGrn.reduce((s, r) => s + r.pendingValue, 0))
    expect([u.gdni.value, u.gdni.notes, u.gdni.lines]).toEqual([45000 + 20000, 1, 2])
    expect([u.grni.value, u.grni.notes, u.grni.lines]).toEqual([40000, 1, 1])
    expect(u.byParty.map((p) => [p.side, p.partyLedgerId, p.value])).toEqual([['gdni', b.buyer, 65000], ['grni', b.supplier, 40000]])
    const preview = closePreview(b.db, 2025)
    expect(preview.unbilled.gdni.value).toBe(65000)
    expect(preview.unbilled.grni.value).toBe(40000)
    // As on an earlier date, later billing doesn't count.
    expect(unbilledGoods(b.db, '2025-05-04').grni.value).toBe(100000)
  })
})

describe('order book, lead time, demand', () => {
  it('order book: ordered / fulfilled / pending / short-closed; cancelled orders left out', () => {
    const b = books()
    const so1 = doc(b, 'sales_order', '2025-05-01', [{ item: b.w, qty: 10, rate: 100 }])
    dc(b, '2025-05-03', [{ item: b.w, qty: 4, amount: 40000, from: docUid(b, so1.id) }])
    const so2 = doc(b, 'sales_order', '2025-06-01', [{ item: b.w, qty: 5, rate: 100 }])
    dc(b, '2025-06-03', [{ item: b.w, qty: 1, amount: 10000, from: docUid(b, so2.id) }])
    closeTradeDoc(b.db, so2.id, null)
    const so3 = doc(b, 'sales_order', '2025-06-02', [{ item: b.w, qty: 5, rate: 100 }])
    b.db.prepare("UPDATE trade_docs SET status = 'cancelled' WHERE id = ?").run(so3.id)
    const rows = orderBook(b.db, { kind: 'sales_order', from: '2025-04-01', to: '2026-03-31' })
    expect(rows.map((r) => [r.month, r.orderedValue, r.fulfilledValue, r.pendingValue, r.shortClosedValue])).toEqual([
      ['2025-05', 100000, 40000, 60000, 0], ['2025-06', 50000, 10000, 0, 40000]
    ])
  })

  it('lead time: order → challan → invoice days, full delivery once every line is done', () => {
    const b = books()
    const so = doc(b, 'sales_order', '2025-05-01', [{ item: b.w, qty: 10, rate: 100 }, { item: b.g, qty: 2, rate: 100 }])
    const d1 = dc(b, '2025-05-04', [{ item: b.w, qty: 6, amount: 60000, from: docUid(b, so.id, 0) }])
    dc(b, '2025-05-09', [{ item: b.w, qty: 4, amount: 40000, from: docUid(b, so.id, 0) }])
    trade(b, 'sales', '2025-05-11', [{ item: b.w, qty: 6, amount: 60000, from: uid(b.db, d1.id) }])
    const asOn = '2026-03-31'
    let [r] = leadTime(b.db, { kind: 'sales_order', from: '2025-04-01', to: asOn, asOn })
    expect([r!.daysToFirstDelivery, r!.daysToFullDelivery, r!.daysDeliveryToInvoice, r!.daysOrderToInvoice]).toEqual([3, null, 7, 10])
    trade(b, 'sales', '2025-05-15', [{ item: b.g, qty: 2, amount: 20000, from: docUid(b, so.id, 1) }])
    ;[r] = leadTime(b.db, { kind: 'sales_order', from: '2025-04-01', to: asOn, asOn })
    expect([r!.fullDeliveryDate, r!.daysToFullDelivery]).toEqual(['2025-05-15', 14])
    // As on before anything happened.
    ;[r] = leadTime(b.db, { kind: 'sales_order', from: '2025-04-01', to: asOn, asOn: '2025-05-02' })
    expect(r!.firstDeliveryDate).toBeNull()
  })

  it('demand vs stock vs on-order: net = closing − open SO + open PO', () => {
    const b = books()
    doc(b, 'sales_order', '2025-05-01', [{ item: b.w, qty: 130, rate: 100 }])
    doc(b, 'purchase_order', '2025-05-01', [{ item: b.w, qty: 20, rate: 90 }])
    const rows = itemDemand(b.db, FAR)
    expect(rows.map((r) => [r.stockItemId, r.closingQtyMilli, r.openSoMilli, r.openPoMilli, r.netMilli, r.shortMilli])).toEqual([
      [b.w, 100_000, 130_000, 20_000, -10_000, 10_000]
    ])
    expect(itemDemand(b.db, FAR, { onlyOpen: false }).length).toBe(2)
  })
})
