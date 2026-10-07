// WP 2.5b: challans and GRNs through the entry screens' own pure paths (stockNote mode, the
// "Add from…" drawer's rowsFromSourcePicks, the invoice form's buildInvoicePayload), and their
// GST / e-way / print / pending-report effects.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { DB } from '../db/connection'
import type { CompanyInfo, TradePurpose } from '@shared/domain'
import { TEST_INFO } from '../db/testdb'
import {
  buildInvoicePayload, buildStockNotePayload, emptyInvoiceState, emptyStockNoteState, planVoucherEdit, rowsFromSourcePicks,
  taxLedgerIdsFrom, type InvoiceRowState, type StockNoteKind
} from '@shared/voucherEdit'
import { buildEwbJson } from '@shared/gst/edocs'
import { createLedger, listLedgers, listStockItems } from './masters'
import { deleteVoucher, getVoucher, saveVoucher } from './vouchers'
import { openSourceLines } from './tradeLinks'
import * as stock from './stockAnalysis'
import { extractDocSeries, extractOutwardDocs, gstr1 } from './gst'
import { ewbJsonForVoucher, extractEdocInvoices, listSalesInvoices } from './edocs'
import { documentHtml } from './printTemplates'
import { pendingStockNotes } from './tradeReports'
import { ensureCompanyTree } from '../paths'
import { item, tradeBooks, typeId, type TradeBooks } from './tradeFixture.testutil'

const COMPANY: CompanyInfo = { ...TEST_INFO, gstin: '27AAACT1234A1Z5', address: 'Plot 4, MIDC Bhosari, Pune 411026' }
const FROM = '2025-04-01'
const TO = '2026-03-31'

interface Books extends TradeBooks {
  w: number
  phone: number
}

function books(): Books {
  const b = tradeBooks()
  const g = (name: string): number => (b.db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  for (const [name, taxType] of [['CGST', 'cgst'], ['SGST', 'sgst'], ['IGST', 'igst']] as const) {
    createLedger(b.db, {
      name, groupId: g('Duties & Taxes'), openingBalance: 0, gstin: null, stateCode: null, address: null, taxType, gstRate: null,
      hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
    })
  }
  b.db.prepare("UPDATE ledgers SET gstin = '27AAACB1234C1Z5', state_code = '27', address = 'Shop 2, MG Road, Pune 411001' WHERE id = ?").run(b.buyer)
  b.db.prepare("UPDATE ledgers SET gstin = '27AAACS1234C1Z5', state_code = '27', address = 'Unit 9, Chakan, Pune 410501' WHERE id = ?").run(b.supplier)
  const w = item(b.db, 'Widget', { opening: [100, 1_000_000] }) // 100 @ ₹100
  const phone = item(b.db, 'Phone', { serials: true })
  // Serial-tracked phones come in on a plain purchase first.
  saveViaInvoice(b, 'purchase', '2025-04-02', [{ itemId: phone, qtyText: '3', rate: 1_000_000, discount: null, godownId: b.godown, batchId: null, serials: ['P1', 'P2', 'P3'] }], b.supplier)
  return { ...b, w, phone }
}

function ctxOf(db: DB) {
  const items = listStockItems(db)
  const ledgers = listLedgers(db)
  return {
    companyStateCode: COMPANY.stateCode,
    items: new Map(items.map((i) => [i.id, { gstRate: i.gstRate, cessRate: i.cessRate }])),
    ledgers: new Map(ledgers.map((l) => [l.id, { stateCode: l.stateCode, gstRate: l.gstRate, tdsPayableSectionId: l.tdsPayableSectionId }])),
    taxLedgers: taxLedgerIdsFrom(ledgers)
  }
}

/** What the challan / GRN screen posts. */
function saveNote(b: TradeBooks, kind: StockNoteKind, date: string, rows: InvoiceRowState[], opts: { purpose?: TradePurpose; number?: string } = {}): number {
  const c = ctxOf(b.db)
  const state = {
    ...emptyStockNoteState(kind, date), partyId: kind === 'delivery_note' ? b.buyer : b.supplier, rows,
    number: opts.number ?? '', vehicleNo: 'mh12ab1234', distanceKm: '18', ...(opts.purpose ? { purpose: opts.purpose } : {})
  }
  const r = buildStockNotePayload(state, { ...c, kind }, typeId(b.db, kind))
  if (!r.ok) throw new Error(r.error)
  return saveVoucher(b.db, r.payload).id
}

/** What the invoice form posts (rows may carry a source from the drawer). */
function saveViaInvoice(b: TradeBooks, kind: 'sales' | 'purchase', date: string, rows: InvoiceRowState[], party: number, number?: string): number {
  const c = ctxOf(b.db)
  const state = {
    ...emptyInvoiceState(date), partyId: party, accountId: kind === 'sales' ? b.sales : b.purchases, rows,
    billName: number ?? `B-${date}-${rows.length}`, number: number ?? ''
  }
  const r = buildInvoicePayload(state, { ...c, kind }, typeId(b.db, kind), c.taxLedgers)
  if (!r.ok) throw new Error(r.error)
  return saveVoucher(b.db, r.payload).id
}

/** The drawer: the party's open lines for the target kind, picked with these quantities. */
function drawerRows(b: TradeBooks, target: 'sales' | 'purchase', party: number, take: (uidIndex: number) => number | null): InvoiceRowState[] {
  const lines = openSourceLines(b.db, { partyLedgerId: party, targetKind: target, linkType: 'fulfil' })
  const picks = lines.map((line, i) => ({ line, qtyMilli: take(i) ?? 0 })).filter((p) => p.qtyMilli > 0)
  return rowsFromSourcePicks(picks, { linkType: 'fulfil' })
}

const qty = (db: DB, itemId: number, asOn = TO): number => stock.stockSummary(db, asOn).find((r) => r.stockItemId === itemId)!.closingQtyMilli
const value = (db: DB, itemId: number, asOn = TO): number => stock.stockSummary(db, asOn).find((r) => r.stockItemId === itemId)!.closingValue

const row = (itemId: number, q: number, rate: number, extra: Partial<InvoiceRowState> = {}): InvoiceRowState => ({
  itemId, qtyText: String(q), rate, discount: null, godownId: null, batchId: null, ...extra
})

describe('invoice raised from a delivery challan (through the editor paths)', () => {
  it('stock moves once, the links are made, serials are sold, partial invoicing leaves the rest pending', () => {
    const b = books()
    const dcId = saveNote(b, 'delivery_note', '2025-05-01', [
      row(b.w, 10, 120000, { godownId: b.godown }),
      row(b.phone, 2, 1_500_000, { godownId: b.godown, serials: ['P1', 'P2'] })
    ], { number: 'DC-1' })
    expect(getVoucher(b.db, dcId)!.trade).toEqual({ purpose: 'supply' })
    expect(getVoucher(b.db, dcId)!.lines).toEqual([])
    const afterChallan = { w: qty(b.db, b.w), phone: qty(b.db, b.phone), wv: value(b.db, b.w) }
    expect(afterChallan.w).toBe(90_000)
    expect(afterChallan.phone).toBe(1_000)
    const serial = (s: string): string => (b.db.prepare('SELECT status FROM serial_numbers WHERE serial = ?').get(s) as { status: string }).status
    expect(serial('P1')).toBe('delivered')

    // Partial: 6 widgets and 1 phone (its first serial) at an invoice rate above the challan's.
    const rows = drawerRows(b, 'sales', b.buyer, (i) => (i === 0 ? 6000 : 1000)).map((r, i) => (i === 0 ? { ...r, rate: 125000 } : r))
    expect(rows[1]!.serials).toEqual(['P1'])
    const invId = saveViaInvoice(b, 'sales', '2025-05-10', rows, b.buyer, 'INV-1')
    const inv = getVoucher(b.db, invId)!
    expect(inv.inventory.map((l) => l.movesStock)).toEqual([false, false])
    expect(inv.inventory.map((l) => l.source?.linkType)).toEqual(['fulfil', 'fulfil'])
    expect(b.db.prepare('SELECT COUNT(*) AS n FROM line_links WHERE to_voucher_id = ?').get(invId)).toEqual({ n: 2 })
    // Stock moved on the challan only.
    expect({ w: qty(b.db, b.w), phone: qty(b.db, b.phone), wv: value(b.db, b.w) }).toEqual(afterChallan)
    expect(serial('P1')).toBe('sold')
    expect(serial('P2')).toBe('delivered')

    // What is left is pending (drawer and report agree).
    const open = openSourceLines(b.db, { partyLedgerId: b.buyer, targetKind: 'sales', linkType: 'fulfil' })
    expect(open.map((l) => l.pendingMilli)).toEqual([4000, 1000])
    const pending = pendingStockNotes(b.db, 'delivery_note', TO)
    expect(pending.map((p) => [p.number, p.pendingMilli, p.pendingValue])).toEqual([['DC-1', 4000, 480000], ['DC-1', 1000, 1_500_000]])
    // As on a date before the invoice, the whole challan was pending.
    expect(pendingStockNotes(b.db, 'delivery_note', '2025-05-05').map((p) => p.pendingMilli)).toEqual([10000, 2000])

    // The rest on a second invoice: nothing pending; still one movement.
    saveViaInvoice(b, 'sales', '2025-05-20', drawerRows(b, 'sales', b.buyer, (i) => open[i]!.pendingMilli), b.buyer, 'INV-2')
    expect(pendingStockNotes(b.db, 'delivery_note', TO)).toEqual([])
    expect(qty(b.db, b.w)).toBe(90_000)
    expect(serial('P2')).toBe('sold')

    // Binning an invoice reopens its share of the challan; stock is unchanged.
    deleteVoucher(b.db, invId)
    expect(pendingStockNotes(b.db, 'delivery_note', TO).map((p) => p.pendingMilli)).toEqual([6000, 1000])
    expect(qty(b.db, b.w)).toBe(90_000)
  })

  it('a challan with a linked invoice can\'t be binned', () => {
    const b = books()
    const dcId = saveNote(b, 'delivery_note', '2025-05-01', [row(b.w, 5, 100000)])
    saveViaInvoice(b, 'sales', '2025-05-02', drawerRows(b, 'sales', b.buyer, () => 5000), b.buyer)
    expect(() => deleteVoucher(b.db, dcId)).toThrow(/bin that first/)
  })
})

describe('purchase bill raised from a GRN', () => {
  it('the bill re-prices the GRN; partial billing keeps the rest at the GRN rate', () => {
    const b = books()
    const grnId = saveNote(b, 'receipt_note', '2025-06-01', [row(b.w, 10, 100000, { godownId: b.godown2 })], { number: 'GRN-1' })
    expect(getVoucher(b.db, grnId)!.trade).toEqual({ purpose: 'purchase' })
    const before = value(b.db, b.w)
    expect(pendingStockNotes(b.db, 'receipt_note', TO).map((p) => [p.number, p.pendingMilli])).toEqual([['GRN-1', 10000]])
    // Bill 6 of 10 at ₹110: value = 660 + (1000 − 600) over the GRN's ₹1,000.
    const rows = drawerRows(b, 'purchase', b.supplier, () => 6000).map((r) => ({ ...r, rate: 110000 }))
    const billId = saveViaInvoice(b, 'purchase', '2025-06-05', rows, b.supplier, 'SUP-1')
    expect(getVoucher(b.db, billId)!.inventory[0]!.movesStock).toBe(false)
    expect(value(b.db, b.w) - before).toBe(60_000)
    expect(qty(b.db, b.w)).toBe(110_000)
    expect(pendingStockNotes(b.db, 'receipt_note', TO).map((p) => [p.pendingMilli, p.pendingValue])).toEqual([[4000, 400000]])
  })
})

describe('GST: a challan is never an invoice (GSTR-1) but is a Table 13 document', () => {
  it('B2B / B2C / HSN count the invoice only; Table 13 reports challans by purpose; GRNs are not reported', () => {
    const b = books()
    saveNote(b, 'delivery_note', '2025-05-01', [row(b.w, 10, 120000)], { number: 'DC-1' })
    saveNote(b, 'delivery_note', '2025-05-02', [row(b.w, 4, 100000)], { number: 'DC-2', purpose: 'job_work' })
    const dc3 = saveNote(b, 'delivery_note', '2025-05-03', [row(b.w, 1, 100000)], { number: 'DC-3', purpose: 'approval' })
    saveNote(b, 'delivery_note', '2025-05-04', [row(b.w, 1, 100000)], { number: 'DC-4', purpose: 'non_supply' })
    saveNote(b, 'receipt_note', '2025-05-05', [row(b.w, 3, 100000)], { number: 'GRN-1' })
    saveViaInvoice(b, 'sales', '2025-05-10', drawerRows(b, 'sales', b.buyer, (i) => (i === 0 ? 10000 : null)), b.buyer, 'INV-1')
    deleteVoucher(b.db, dc3)

    const docs = extractOutwardDocs(b.db, COMPANY, FROM, TO)
    expect(docs.map((d) => d.number)).toEqual(['INV-1'])
    const r = gstr1(b.db, COMPANY, FROM, TO, '052025')
    const json = JSON.stringify(r.json)
    for (const n of ['DC-1', 'DC-2', 'DC-4', 'GRN-1']) expect(json.includes(`"${n}"`) && !json.includes(`"from":"${n}"`) && !json.includes(`"to":"${n}"`)).toBe(false)
    const b2b = (r.json as { b2b: { inv: { inum: string }[] }[] }).b2b
    expect(b2b.flatMap((x) => x.inv.map((i) => i.inum))).toEqual(['INV-1'])
    // HSN qty = the invoice's 10, not challan + invoice.
    const hsn = (r.json as { hsn: { hsn_b2b: { qty: number; txval: number }[] } }).hsn.hsn_b2b
    expect(hsn).toHaveLength(1)
    expect(hsn[0]!.qty).toBe(10)

    expect(extractDocSeries(b.db, FROM, TO)).toEqual([
      { category: 1, from: 'INV-1', to: 'INV-1', totnum: 1, cancel: 0 },
      { category: 9, from: 'DC-2', to: 'DC-2', totnum: 1, cancel: 0 },
      { category: 10, from: 'DC-3', to: 'DC-3', totnum: 1, cancel: 1 },
      { category: 12, from: 'DC-1', to: 'DC-4', totnum: 2, cancel: 0 }
    ])
    const docIssue = (r.json as { doc_issue: { doc_det: { doc_num: number }[] } }).doc_issue
    expect(docIssue.doc_det.map((d) => d.doc_num)).toEqual([1, 9, 10, 12])
  })
})

describe('e-way bill from a challan; none for the invoice whose goods moved on it', () => {
  it('builds CHL JSON by purpose with tax for a supply, value-only for job work; the invoice reads "goods moved on challan"', () => {
    const b = books()
    const dcId = saveNote(b, 'delivery_note', '2025-05-01', [row(b.w, 10, 600000)], { number: 'DC-1' }) // ₹60,000 + GST
    const jwId = saveNote(b, 'delivery_note', '2025-05-02', [row(b.w, 2, 3_000_000)], { number: 'JW-1', purpose: 'job_work' })
    b.db.prepare("UPDATE vouchers SET ewb_no = '331001234567' WHERE id = ?").run(dcId)
    const invId = saveViaInvoice(b, 'sales', '2025-05-03', drawerRows(b, 'sales', b.buyer, (i) => (i === 0 ? 10000 : null)), b.buyer, 'INV-1')

    const [dc] = extractEdocInvoices(b.db, COMPANY, FROM, TO, dcId, ['delivery_note'])
    expect(dc!.docType).toBe('CHL')
    expect(dc!.taxable).toBe(6_000_000)
    expect(dc!.cgst + dc!.sgst).toBe(1_080_000)
    expect(dc!.total).toBe(7_080_000)
    const bill = (buildEwbJson([dc!], { name: COMPANY.name, gstin: COMPANY.gstin!, stateCode: '27', address: COMPANY.address }).billLists as Record<string, unknown>[])[0]!
    expect(bill).toMatchObject({ supplyType: 'O', subSupplyType: '8', subSupplyDesc: 'Supply on challan', docType: 'CHL', docNo: 'DC-1', totInvValue: 70800, vehicleNo: 'MH12AB1234', transDistance: '18' })

    const [jw] = extractEdocInvoices(b.db, COMPANY, FROM, TO, jwId, ['delivery_note'])
    const jwBill = (buildEwbJson([jw!], { name: COMPANY.name, gstin: COMPANY.gstin!, stateCode: '27', address: COMPANY.address }).billLists as Record<string, unknown>[])[0]!
    expect(jwBill).toMatchObject({ subSupplyType: '4', docType: 'CHL', totalValue: 60000, cgstValue: 0, totInvValue: 60000 })

    const list = listSalesInvoices(b.db, FROM, TO, COMPANY)
    const byNo = new Map(list.map((r) => [r.number, r]))
    expect(byNo.get('DC-1')).toMatchObject({ docType: 'CHL', ewbReason: null, total: 7_080_000, irn: null })
    expect(byNo.get('JW-1')).toMatchObject({ docType: 'CHL', ewbReason: null })
    expect(byNo.get('INV-1')!.ewbReason).toBe('Goods moved on challan DC-1 (EWB 331001234567)')

    process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-ewb-chl-'))
    ensureCompanyTree('ewb-chl')
    expect(() => ewbJsonForVoucher(b.db, COMPANY, 'ewb-chl', invId)).toThrow(/Goods moved on challan DC-1/)
    const { path } = ewbJsonForVoucher(b.db, COMPANY, 'ewb-chl', dcId)
    expect(JSON.parse(readFileSync(path, 'utf8')).billLists[0].docType).toBe('CHL')
  })
})

describe('printing', () => {
  it('a delivery challan prints in triplicate, without tax-invoice wording or an outstanding; a GRN prints as a receipt note', () => {
    const b = books()
    const dcId = saveNote(b, 'delivery_note', '2025-05-01', [row(b.w, 10, 120000)], { number: 'DC-1' })
    const { html, kind } = documentHtml(b.db, COMPANY, dcId)
    expect(kind).toBe('delivery_challan')
    expect(html).toContain('DELIVERY CHALLAN')
    for (const l of ['Original for Consignee', 'Duplicate for Transporter', 'Triplicate for Consigner']) expect(html).toContain(l)
    expect(html).toContain('rule 55 of the CGST Rules, 2017')
    expect(html).toContain('Taxable value')
    expect(html).toContain('Purpose: Supply')
    expect(html).not.toMatch(/invoice/i)
    expect(html).not.toContain('Balance outstanding')
    const jw = saveNote(b, 'delivery_note', '2025-05-02', [row(b.w, 1, 100000)], { purpose: 'job_work' })
    const jwHtml = documentHtml(b.db, COMPANY, jw).html
    expect(jwHtml).toContain('Purpose: Job work')
    expect(jwHtml).not.toContain('<td>CGST</td><td class="r num">9')
    const grnId = saveNote(b, 'receipt_note', '2025-05-03', [row(b.w, 2, 100000)])
    const g = documentHtml(b.db, COMPANY, grnId)
    expect(g.kind).toBe('goods_receipt')
    expect(g.html).toContain('GOODS RECEIPT NOTE')
    expect(g.html).toContain('Received from')
  })
})

describe('voucher editor round trip (WP 2.5b stockNote mode)', () => {
  it('a challan with discount, godown, serials and transport opens in the note form and re-saves identically', () => {
    const b = books()
    const id = saveNote(b, 'delivery_note', '2025-05-01', [
      row(b.w, 3, 99999, { discount: 1234, godownId: b.godown }),
      row(b.phone, 1, 1_500_000, { godownId: b.godown, serials: ['P3'] })
    ], { purpose: 'approval' })
    const v = getVoucher(b.db, id)!
    const c = ctxOf(b.db)
    const plan = planVoucherEdit(v, 'delivery_note', { invoice: c, taxLedgers: c.taxLedgers, itemName: () => '' })
    expect(plan.mode).toBe('stockNote')
    if (plan.mode !== 'stockNote') return
    expect(plan.state.purpose).toBe('approval')
    const r = buildStockNotePayload(plan.state, { ...c, kind: 'delivery_note' }, v.voucherTypeId)
    if (!r.ok) throw new Error(r.error)
    const snap = (): unknown => b.db.prepare('SELECT stock_item_id, godown_id, qty_milli, rate_paise, discount_paise, amount, serials, line_uid FROM inventory_lines WHERE voucher_id = ? ORDER BY line_order').all(id)
    const before = snap()
    saveVoucher(b.db, r.payload, id)
    expect(snap()).toEqual(before)
    expect(getVoucher(b.db, id)!.vehicleNo).toBe('MH12AB1234')
  })
})
