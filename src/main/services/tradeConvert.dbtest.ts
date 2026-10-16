// WP 2.5b lists: "Convert to invoice / bill" from the challan / GRN lists. The editor is opened
// with convertPicks(openSourceLines, { voucherIds }) — the "Add from…" drawer's own picks of every
// pending line — and saves through the invoice form's buildInvoicePayload + saveVoucher like any
// invoice. Proven here: the converted invoice equals the same invoice entered by hand (rows typed
// with their source lines) in a twin company — voucher, lines, links; stock is unchanged (lines
// against a challan / GRN do not move stock); several challans of one party make ONE invoice; the
// save's I1–I7 refusals surface.
import { describe, it, expect } from 'vitest'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { TEST_INFO } from '../db/testdb'
import {
  buildInvoicePayload, buildStockNotePayload, emptyInvoiceState, emptyStockNoteState, rowsFromSourcePicks, taxLedgerIdsFrom,
  type InvoiceRowState, type StockNoteKind
} from '@shared/voucherEdit'
import { convertPicks, convertTogetherProblem } from '@shared/tradeCycle/convert'
import { createLedger, listLedgers, listStockItems } from './masters'
import { getVoucher, saveVoucher } from './vouchers'
import { openSourceLines } from './tradeLinks'
import { listStockNotes } from './tradeLists'
import { closeStockNote } from './tradeClosure'
import * as stock from './stockAnalysis'
import { item, tradeBooks, typeId, type TradeBooks } from './tradeFixture.testutil'

const COMPANY: CompanyInfo = { ...TEST_INFO, gstin: '27AAACT1234A1Z5' }
const TO = '2026-03-31'

interface Books extends TradeBooks {
  w: number
  g: number
}

function books(): Books {
  const b = tradeBooks()
  const grp = (name: string): number => (b.db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  for (const [name, taxType] of [['CGST', 'cgst'], ['SGST', 'sgst'], ['IGST', 'igst']] as const) {
    createLedger(b.db, {
      name, groupId: grp('Duties & Taxes'), openingBalance: 0, gstin: null, stateCode: null, address: null, taxType, gstRate: null,
      hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
    })
  }
  b.db.prepare("UPDATE ledgers SET gstin = '27AAACB1234C1Z5', state_code = '27' WHERE id IN (?, ?)").run(b.buyer, b.buyer2)
  b.db.prepare("UPDATE ledgers SET gstin = '27AAACS1234C1Z5', state_code = '27' WHERE id = ?").run(b.supplier)
  const w = item(b.db, 'Widget', { opening: [100, 1_000_000] }) // 100 @ ₹100
  const g = item(b.db, 'Gadget', { opening: [50, 500_000], gstRate: 5 }) // 50 @ ₹100
  return { ...b, w, g }
}

function ctxOf(db: DB) {
  const items = listStockItems(db)
  const ledgers = listLedgers(db)
  return {
    companyStateCode: COMPANY.stateCode, gstRegistrationType: COMPANY.gstRegistrationType,
    items: new Map(items.map((i) => [i.id, { gstRate: i.gstRate, cessRate: i.cessRate }])),
    ledgers: new Map(ledgers.map((l) => [l.id, { stateCode: l.stateCode, gstRate: l.gstRate, tdsPayableSectionId: l.tdsPayableSectionId }])),
    taxLedgers: taxLedgerIdsFrom(ledgers)
  }
}

const row = (itemId: number, q: number, rate: number, extra: Partial<InvoiceRowState> = {}): InvoiceRowState => ({
  itemId, qtyText: String(q), rate, discount: null, godownId: null, batchId: null, ...extra
})

/** What the challan / GRN screen posts. */
function saveNote(b: Books, kind: StockNoteKind, date: string, rows: InvoiceRowState[], party?: number): number {
  const c = ctxOf(b.db)
  const state = { ...emptyStockNoteState(kind, date), partyId: party ?? (kind === 'delivery_note' ? b.buyer : b.supplier), rows }
  const r = buildStockNotePayload(state, { ...c, kind }, typeId(b.db, kind))
  if (!r.ok) throw new Error(r.error)
  return saveVoucher(b.db, r.payload).id
}

/** What the invoice / bill form posts. */
function invoicePayload(b: Books, kind: 'sales' | 'purchase', date: string, rows: InvoiceRowState[], party: number, opts: { optional?: boolean } = {}) {
  const c = ctxOf(b.db)
  const state = {
    ...emptyInvoiceState(date), partyId: party, accountId: kind === 'sales' ? b.sales : b.purchases, rows, billName: 'INV-1',
    ...(opts.optional ? { optional: true } : {})
  }
  const r = buildInvoicePayload(state, { ...c, kind }, typeId(b.db, kind), c.taxLedgers)
  if (!r.ok) throw new Error(r.error)
  return r.payload
}

/** The converted editor's rows: every pending line of these notes, as the list's button opens it. */
function convertedRows(b: Books, target: 'sales' | 'purchase', party: number, voucherIds: number[]): InvoiceRowState[] {
  const lines = openSourceLines(b.db, { partyLedgerId: party, targetKind: target, linkType: 'fulfil' })
  return rowsFromSourcePicks(convertPicks(lines, { voucherIds }), { linkType: 'fulfil' })
}

/** A voucher with its line uids replaced by "<source voucher number>:<line>" — comparable across companies. */
function canon(db: DB, voucherId: number) {
  const v = getVoucher(db, voucherId)!
  const srcOf = (u: string): string => {
    const r = db.prepare('SELECT v.number, il.line_order AS o FROM inventory_lines il JOIN vouchers v ON v.id = il.voucher_id WHERE il.line_uid = ?').get(u) as {
      number: string; o: number
    }
    return `${r.number}:${r.o}`
  }
  const links = db
    .prepare('SELECT ll.link_type AS t, ll.from_line_uid AS f, ll.qty_milli AS q, ll.reprices AS r, il.line_order AS o FROM line_links ll JOIN inventory_lines il ON il.line_uid = ll.to_line_uid WHERE ll.to_voucher_id = ? ORDER BY il.line_order')
    .all(voucherId) as { t: string; f: string; q: number; r: number; o: number }[]
  return {
    date: v.date, number: v.number, party: v.partyLedgerId, lines: v.lines.map((l) => [l.ledgerId, l.drCr, l.amount]),
    inventory: v.inventory.map((l) => ({
      item: l.stockItemId, godown: l.godownId, qty: l.qtyMilli, rate: l.ratePaise, discount: l.discountPaise, amount: l.amount,
      direction: l.direction, source: l.source ? `${l.source.linkType}:${srcOf(l.source.lineUid)}` : null
    })),
    movesStock: (db.prepare('SELECT moves_stock AS m FROM inventory_lines WHERE voucher_id = ? ORDER BY line_order').all(voucherId) as { m: number }[]).map((x) => x.m),
    billRefs: v.billRefs,
    links: links.map((l) => [l.t, srcOf(l.f), l.q, l.r, l.o])
  }
}

const stockOf = (db: DB) => stock.stockSummary(db, TO).map((r) => [r.stockItemId, r.closingQtyMilli, r.closingValue])

/** Two challans for Buyer (DC-1 partly invoiced already), one for Second Buyer. */
function challans(b: Books) {
  const dc1 = saveNote(b, 'delivery_note', '2025-05-01', [row(b.w, 10, 120_000, { godownId: b.godown }), row(b.g, 5, 50_000, { godownId: b.godown, discount: 10_000 })])
  const dc2 = saveNote(b, 'delivery_note', '2025-05-03', [row(b.w, 2, 125_000, { godownId: b.godown2 })])
  const dc3 = saveNote(b, 'delivery_note', '2025-05-04', [row(b.w, 1, 120_000, { godownId: b.godown })], b.buyer2)
  // 4 widgets of DC-1 invoiced by hand through the drawer.
  const dc1w = getVoucher(b.db, dc1)!.inventory[0]!.lineUid!
  saveVoucher(b.db, invoicePayload(b, 'sales', '2025-05-05', [row(b.w, 4, 120_000, { godownId: b.godown, source: { lineUid: dc1w, linkType: 'fulfil' } })], b.buyer))
  return { dc1, dc2, dc3 }
}

describe('Convert challans to one invoice', () => {
  it('= the same invoice entered by hand with its source lines (twin company): voucher, links, no stock moved', () => {
    const a = books()
    const ca = challans(a)
    const twin = books()
    const ct = challans(twin)

    // The list offers DC-1 and DC-2 together (same party, both pending) but not with DC-3.
    const rows = listStockNotes(a.db, { stage: 'delivery_note', from: '2025-04-01', to: TO, filter: 'pending' })
    const pick = (ids: number[]) => rows.filter((r) => ids.includes(r.voucherId))
    expect(convertTogetherProblem(pick([ca.dc1, ca.dc2]))).toBeNull()
    expect(convertTogetherProblem(pick([ca.dc1, ca.dc3]))).toMatch(/one party/)

    const stockBefore = stockOf(a.db)
    const converted = convertedRows(a, 'sales', a.buyer, [ca.dc1, ca.dc2])
    // Every pending line: DC-1's 6 widgets and 5 gadgets, DC-2's 2 widgets, at the challans' rates.
    expect(converted.map((r) => [r.itemId, r.qtyText, r.rate, r.discount, r.godownId])).toEqual([
      [a.w, '6', 120_000, null, a.godown], [a.g, '5', 50_000, 10_000, a.godown], [a.w, '2', 125_000, null, a.godown2]
    ])
    const inv = saveVoucher(a.db, invoicePayload(a, 'sales', '2025-05-10', converted, a.buyer)).id

    // By hand in the twin: the same rows typed, each with its challan line as the source.
    const uidOf = (id: number, i: number): string => getVoucher(twin.db, id)!.inventory[i]!.lineUid!
    const hand = saveVoucher(twin.db, invoicePayload(twin, 'sales', '2025-05-10', [
      row(twin.w, 6, 120_000, { godownId: twin.godown, source: { lineUid: uidOf(ct.dc1, 0), linkType: 'fulfil' } }),
      row(twin.g, 5, 50_000, { godownId: twin.godown, discount: 10_000, source: { lineUid: uidOf(ct.dc1, 1), linkType: 'fulfil' } }),
      row(twin.w, 2, 125_000, { godownId: twin.godown2, source: { lineUid: uidOf(ct.dc2, 0), linkType: 'fulfil' } })
    ], twin.buyer)).id

    const got = canon(a.db, inv)
    expect(got).toEqual(canon(twin.db, hand))
    expect(got.links).toEqual([['fulfil', '1:0', 6000, 0, 0], ['fulfil', '1:1', 5000, 0, 1], ['fulfil', '2:0', 2000, 0, 2]])
    expect(got.movesStock).toEqual([0, 0, 0])
    // GST on the invoice (intra-state: CGST + SGST) is the editor's own computation.
    expect(got.lines.length).toBeGreaterThan(2)
    // Invoice lines against a challan do not move stock.
    expect(stockOf(a.db)).toEqual(stockBefore)
    expect(stockOf(a.db)).toEqual(stockOf(twin.db))
    // Both challans are now invoiced; DC-3 is untouched.
    const after = listStockNotes(a.db, { stage: 'delivery_note', from: '2025-04-01', to: TO, filter: 'all' })
    expect(after.map((r) => [r.voucherId, r.status])).toEqual([[ca.dc1, 'done'], [ca.dc2, 'done'], [ca.dc3, 'pending']])
    expect(after.find((r) => r.voucherId === ca.dc2)!.targets.map((t) => t.voucherId)).toEqual([inv])
  })

  it('the save refuses what I1–I7 refuse: another party, over-drawing, a closed challan, an optional invoice', () => {
    const b = books()
    const c = challans(b)
    // I2 — DC-3 belongs to Second Buyer.
    const other = convertedRows(b, 'sales', b.buyer2, [c.dc3])
    expect(() => saveVoucher(b.db, invoicePayload(b, 'sales', '2025-05-10', other, b.buyer))).toThrow(/another party/)
    // I6 — an optional (memorandum) invoice can't be linked.
    const rows = convertedRows(b, 'sales', b.buyer, [c.dc2])
    expect(() => saveVoucher(b.db, invoicePayload(b, 'sales', '2025-05-10', rows, b.buyer, { optional: true }))).toThrow(/optional/i)
    // I1 — converting the same pending lines twice (a stale editor): the second save is refused.
    saveVoucher(b.db, invoicePayload(b, 'sales', '2025-05-10', rows, b.buyer))
    expect(() => saveVoucher(b.db, invoicePayload(b, 'sales', '2025-05-11', rows, b.buyer))).toThrow(/already linked/)
    // Nothing pending on DC-2 any more: the list offers no conversion.
    expect(convertPicks(openSourceLines(b.db, { partyLedgerId: b.buyer, targetKind: 'sales', linkType: 'fulfil' }), { voucherIds: [c.dc2] })).toEqual([])
    // I5 — a short-closed challan takes no new links (an editor opened before the close).
    const dc1Rows = convertedRows(b, 'sales', b.buyer, [c.dc1])
    closeStockNote(b.db, c.dc1, 'Rest written off')
    expect(() => saveVoucher(b.db, invoicePayload(b, 'sales', '2025-05-12', dc1Rows, b.buyer))).toThrow(/closed/)
    expect(listStockNotes(b.db, { stage: 'delivery_note', from: '2025-04-01', to: TO, filter: 'pending' }).map((r) => r.voucherId)).toEqual([c.dc3])
  })
})

describe('Convert GRNs to one bill', () => {
  it('draws every pending GRN line at its rate; quantity and value in stock unchanged; the links re-price (rule)', () => {
    const b = books()
    const g1 = saveNote(b, 'receipt_note', '2025-06-01', [row(b.w, 8, 100_000, { godownId: b.godown })])
    const g2 = saveNote(b, 'receipt_note', '2025-06-02', [row(b.g, 3, 100_000, { godownId: b.godown })])
    const before = stockOf(b.db)
    const rows = convertedRows(b, 'purchase', b.supplier, [g1, g2])
    expect(rows.map((r) => [r.itemId, r.qtyText, r.rate])).toEqual([[b.w, '8', 100_000], [b.g, '3', 100_000]])
    const bill = saveVoucher(b.db, { ...invoicePayload(b, 'purchase', '2025-06-05', rows, b.supplier), reference: 'SUP-77' }).id
    const got = canon(b.db, bill)
    expect(got.links).toEqual([['fulfil', '1:0', 8000, 1, 0], ['fulfil', '2:0', 3000, 1, 1]])
    expect(got.movesStock).toEqual([0, 0])
    expect(stockOf(b.db)).toEqual(before)
    expect(listStockNotes(b.db, { stage: 'receipt_note', from: '2025-04-01', to: TO, filter: 'all' }).map((r) => r.status)).toEqual(['done', 'done'])
  })
})
