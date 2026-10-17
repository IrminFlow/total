// To-do §4 GST — tax-fact snapshots. A bill saved from now on keeps the rate, cess, HSN and the
// party's class (GSTIN, state, SEZ / export type, reverse charge) the masters had when it was saved:
// changing the item, the ledger or the party afterwards leaves its GSTR-1, GSTR-3B, HSN summary,
// e-invoice JSON and print exactly as they were. A voucher without a snapshot (saved before the
// migration — NULL) keeps following the masters, as every reader did before; saving it again
// freezes it. Imports that restore history store only the facts they carry.
import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { CompanyInfo } from '@shared/domain'
import { buildEInvoiceJson } from '@shared/gst/edocs'
import { seededDb, TEST_INFO } from '../db/testdb'
import type { DB } from '../db/connection'
import { ensureCompanyTree } from '../paths'
import { createLedger, createStockItem, getLedger, getStockItem, updateLedger, updateStockItem } from './masters'
import { getVoucher, saveVoucher } from './vouchers'
import { bookedItcByVoucher, extractOutwardDocs, extractPurchaseDocs, gstr1, gstr3b, rcmInwardByVoucher } from './gst'
import { extractEdocInvoices, listSalesInvoices } from './edocs'
import { gstr9 } from './gstAnnual'
import { documentHtml } from './printTemplates'
import { readTaxFacts, taxFactsDiff, writeTaxFacts } from './taxFacts'
import { applyBulk, undoBulk } from './bulkEdit'

const INFO: CompanyInfo = { ...TEST_INFO, name: 'Snapshot Traders', gstin: '27AAPFU0939F1ZV', address: '12 MG Road, Pune 411001' }
const FROM = '2025-07-01'
const TO = '2025-07-31'
const EDOC_CO = { name: INFO.name, gstin: INFO.gstin!, stateCode: INFO.stateCode, address: INFO.address }

beforeAll(() => {
  process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-tax-facts-'))
  ensureCompanyTree('tax-facts-test')
})

function setup() {
  const db = seededDb()
  const g = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const vt = (kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ? ORDER BY id').get(kind) as { id: number }).id
  const nos = (db.prepare("SELECT id FROM units WHERE symbol = 'Nos'").get() as { id: number }).id
  const buyer = createLedger(db, { name: 'Ramesh Stores', groupId: g('Sundry Debtors'), gstin: '27AABCS1429B1ZU', stateCode: '27' }).id
  const salesAc = createLedger(db, { name: 'Sales A/c', groupId: g('Sales Accounts') }).id
  const consulting = createLedger(db, { name: 'Consulting', groupId: g('Sales Accounts'), gstRate: 18, hsn: '998311' }).id
  const cgst = createLedger(db, { name: 'Output CGST', groupId: g('Duties & Taxes'), taxType: 'cgst' }).id
  const sgst = createLedger(db, { name: 'Output SGST', groupId: g('Duties & Taxes'), taxType: 'sgst' }).id
  const phone = createStockItem(db, {
    name: 'Phone', groupId: null, unitId: nos, hsn: '8517', gstRate: 18, cessRate: null, openingQtyMilli: 10_000, openingValue: 500_000,
    barcode: null, reorderLevelMilli: null
  }).id
  const base = { reference: null, narration: null, instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null, billRefs: [], tds: null }
  const line = (ledgerId: number, drCr: 'dr' | 'cr', amount: number) => ({ ledgerId, drCr, amount, costAllocations: [] })
  // Item invoice: 2 phones x ₹500 = ₹1,000 + 9 % + 9 %.
  const itemInput = {
    ...base, voucherTypeId: vt('sales'), date: '2025-07-05', partyLedgerId: buyer,
    lines: [line(buyer, 'dr', 118_000), line(salesAc, 'cr', 100_000), line(cgst, 'cr', 9_000), line(sgst, 'cr', 9_000)],
    inventory: [{ stockItemId: phone, godownId: null, qtyMilli: 2_000, ratePaise: 50_000, amount: 100_000, direction: 'out' as const }]
  }
  // Ledger-line (service) invoice: ₹500 consulting @ 18 %.
  const serviceInput = {
    ...base, voucherTypeId: vt('sales'), date: '2025-07-06', partyLedgerId: buyer,
    lines: [line(buyer, 'dr', 59_000), line(consulting, 'cr', 50_000), line(cgst, 'cr', 4_500), line(sgst, 'cr', 4_500)],
    inventory: []
  }
  return { db, buyer, consulting, phone, itemInput, serviceInput }
}

/** Everything the GST readers say about the period, plus each voucher's e-invoice JSON and print. */
function readers(db: DB, ids: number[]) {
  const edocs = extractEdocInvoices(db, INFO, FROM, TO)
  const annual = gstr9(db, INFO, 2025)
  return {
    docs: JSON.parse(JSON.stringify(extractOutwardDocs(db, INFO, FROM, TO))),
    gstr1: gstr1(db, INFO, FROM, TO, '072025').json,
    gstr3b: JSON.parse(JSON.stringify(gstr3b(db, INFO, FROM, TO, '072025'))),
    gstr9Hsn: JSON.parse(JSON.stringify({ out: annual.hsnOutward, in: annual.hsnInward })),
    edocs: JSON.parse(JSON.stringify(edocs)),
    einvoice: buildEInvoiceJson(edocs, EDOC_CO),
    prints: ids.map((id) => documentHtml(db, INFO, id).html)
  }
}

/** The masters move on: new rates and HSNs, and the customer turns out to be an SEZ unit in Karnataka. */
function editMasters(db: DB, s: ReturnType<typeof setup>): void {
  updateStockItem(db, s.phone, { ...getStockItem(db, s.phone)!, gstRate: 12, hsn: '8471' } as never)
  updateLedger(db, s.consulting, { ...getLedger(db, s.consulting)!, gstRate: 5, hsn: '998312' } as never)
  updateLedger(db, s.buyer, { ...getLedger(db, s.buyer)!, gstin: '29AABCF9012G1ZQ', stateCode: '29', exportType: 'sez_wp' } as never)
}

describe('tax-fact snapshots (to-do §4 GST)', () => {
  it('a bill saved now is frozen: master edits leave its returns, HSN, e-invoice JSON and print unchanged', () => {
    const s = setup()
    const a = saveVoucher(s.db, s.itemInput).id
    const b = saveVoucher(s.db, s.serviceInput).id
    expect(readTaxFacts(s.db, a)).toEqual({
      party: { gstin: '27AABCS1429B1ZU', state: '27', exportType: null, rcm: 0 },
      lines: [{ gstRate: null, cessRate: null, hsn: null }, { gstRate: null, cessRate: null, hsn: null }, { gstRate: null, cessRate: null, hsn: null }, { gstRate: null, cessRate: null, hsn: null }],
      inventory: [{ gstRate: 18, cessRate: null, hsn: '8517' }]
    })
    expect(readTaxFacts(s.db, b)!.lines[1]).toEqual({ gstRate: 18, cessRate: null, hsn: '998311' })
    const before = readers(s.db, [a, b])
    // Sanity: what was frozen is what the readers report.
    expect(before.docs.map((d: { items: { rate: number }[] }) => d.items.map((i) => i.rate))).toEqual([[18], [18]])
    expect(before.docs.map((d: { hsnLines: { hsn: string }[] }) => d.hsnLines.map((h) => h.hsn))).toEqual([['8517'], ['998311']])
    expect(before.docs.map((d: { invTyp: string; pos: string }) => [d.invTyp, d.pos])).toEqual([['R', '27'], ['R', '27']])

    expect(before.prints[0]).toContain('8517')
    expect(before.prints[1]).toContain('998311')
    expect(before.einvoice.map((e) => (e as { ItemList: { HsnCd: string; GstRt: number }[] }).ItemList.map((i) => [i.HsnCd, i.GstRt]))).toEqual([[['8517', 18]], [['998311', 18]]])

    editMasters(s.db, s)
    expect(readers(s.db, [a, b])).toEqual(before)
  })

  it('a voucher without a snapshot (saved before the migration) still follows the masters; re-saving it freezes it', () => {
    const s = setup()
    const a = saveVoucher(s.db, s.itemInput).id
    const b = saveVoucher(s.db, s.serviceInput).id
    const frozen = readers(s.db, [a, b])
    // As a pre-migration voucher: no snapshot at all.
    writeTaxFacts(s.db, a, null)
    writeTaxFacts(s.db, b, null)
    expect(readTaxFacts(s.db, a)).toBeNull()
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM vouchers WHERE snap_tax_facts IS NOT NULL OR snap_party_gstin IS NOT NULL').get()).toEqual({ n: 0 })
    // Unchanged masters: the same output either way.
    expect(readers(s.db, [a, b])).toEqual(frozen)

    editMasters(s.db, s)
    const follows = readers(s.db, [a, b])
    expect(follows.docs.map((d: { items: { rate: number }[] }) => d.items.map((i) => i.rate))).toEqual([[12], [5]])
    expect(follows.docs.map((d: { hsnLines: { hsn: string }[] }) => d.hsnLines.map((h) => h.hsn))).toEqual([['8471'], ['998312']])
    expect(follows.docs.map((d: { invTyp: string; pos: string; partyGstin: string }) => [d.invTyp, d.pos, d.partyGstin])).toEqual([['SEWP', '29', '29AABCF9012G1ZQ'], ['SEWP', '29', '29AABCF9012G1ZQ']])
    expect(follows.edocs.map((d: { supTyp: string }) => d.supTyp)).toEqual(['SEZWP', 'SEZWP'])
    expect(follows.prints[0]).toContain('8471')
    expect(follows.prints[0]).not.toContain('8517')
    expect(follows.gstr3b).not.toEqual(frozen.gstr3b)

    // Saved again (unchanged input): frozen on today's masters from now on.
    const v = getVoucher(s.db, a)!
    saveVoucher(s.db, { ...s.itemInput, number: v.number }, a)
    expect(readTaxFacts(s.db, a)!.inventory).toEqual([{ gstRate: 12, cessRate: null, hsn: '8471' }])
    expect(readTaxFacts(s.db, a)!.party).toEqual({ gstin: '29AABCF9012G1ZQ', state: '29', exportType: 'sez_wp', rcm: 0 })
    const resaved = readers(s.db, [a, b])
    updateStockItem(s.db, s.phone, { ...getStockItem(s.db, s.phone)!, gstRate: 28, hsn: '8528' } as never)
    expect(readers(s.db, [a, b]).docs[0]).toEqual(resaved.docs[0])
  })

  it('a historic import stores no snapshot unless it carries one; a carried one is stored exactly', () => {
    const s = setup()
    const a = saveVoucher(s.db, s.itemInput, undefined, { historicImport: true }).id
    expect(readTaxFacts(s.db, a)).toBeNull()
    const facts = { party: { gstin: 'X', state: '24', exportType: null, rcm: 1 }, lines: s.itemInput.lines.map(() => ({ gstRate: null, cessRate: null, hsn: null })), inventory: [{ gstRate: 5, cessRate: 1, hsn: '1234' }] }
    const b = saveVoucher(s.db, s.itemInput, undefined, { historicImport: true, taxFacts: facts }).id
    expect(readTaxFacts(s.db, b)).toEqual(facts)
    // A snapshot that no longer fits the lines is never attached to the wrong line.
    const c = saveVoucher(s.db, s.itemInput, undefined, { historicImport: true, taxFacts: { ...facts, inventory: [] } }).id
    expect(readTaxFacts(s.db, c)).toBeNull()
    // The audit row carries the snapshot beside the voucher.
    const after = JSON.parse((s.db.prepare("SELECT after_json AS a FROM audit_log WHERE entity = 'voucher' AND entity_id = ? ORDER BY id DESC LIMIT 1").get(b) as { a: string }).a)
    expect(after.taxFacts).toEqual(facts)
  })

  it('a bulk edit re-saves (today\'s masters); its undo puts the earlier snapshot back exactly', () => {
    const s = setup()
    const a = saveVoucher(s.db, s.itemInput).id
    const frozen = readTaxFacts(s.db, a)
    updateStockItem(s.db, s.phone, { ...getStockItem(s.db, s.phone)!, gstRate: 12, hsn: '8471' } as never)
    const res = applyBulk(s.db, { target: 'voucher', ids: [a], change: { field: 'narration', mode: 'replace', text: 'checked' } })
    expect(readTaxFacts(s.db, a)!.inventory).toEqual([{ gstRate: 12, cessRate: null, hsn: '8471' }])
    undoBulk(s.db, res.batchId!)
    expect(getVoucher(s.db, a)!.narration).toBeNull()
    expect(readTaxFacts(s.db, a)).toEqual(frozen)
  })
})

// ---------------------------------------------------------------------------------------------
// Review of #172: the SNAPSHOT path must give exactly what the masters path gave at save time —
// for every document class, not just a plain invoice. One company, masters M1: every voucher is
// read with its snapshot (A), with the snapshot cleared (B — the pre-PR path on the same masters),
// after the masters move on (D — must differ: a NULL-snapshot voucher follows them), and with the
// saved snapshot written back (E). A = B = E for a regular, a composition and an unregistered
// company's readers; GSTR-3B 3.1(d) and ITC 4(A)(3) agree on the same RCM purchase.
// ---------------------------------------------------------------------------------------------
describe('tax-fact snapshots — the snapshot path equals the masters path at save time (every class)', () => {
  const INFOS = { regular: INFO, composition: { ...INFO, gstRegistrationType: 'composition' as const }, unregistered: { ...INFO, gstRegistrationType: 'unregistered' as const } }
  function corpus() {
    const db = seededDb()
    const g = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
    const vt = (kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ? ORDER BY id').get(kind) as { id: number }).id
    const nos = (db.prepare("SELECT id FROM units WHERE symbol = 'Nos'").get() as { id: number }).id
    const L = (i: Parameters<typeof createLedger>[1]): number => createLedger(db, i).id
    const debtors = g('Sundry Debtors')
    const creditors = g('Sundry Creditors')
    const buyer27 = L({ name: 'Buyer 27', groupId: debtors, gstin: '27AABCS1429B1ZU', stateCode: '27' })
    const noState = L({ name: 'Walk-in, no state', groupId: debtors })
    const sezWop = L({ name: 'SEZ WOP', groupId: debtors, gstin: '27AABCS1429B1ZU', stateCode: '27', exportType: 'sez_wop' })
    const expWp = L({ name: 'Export WP', groupId: debtors, stateCode: '96', exportType: 'exp_wp' })
    const supplierRcm = L({ name: 'RCM supplier', groupId: creditors, gstin: '27AAPFU0939F1ZV', stateCode: '27', rcm: true })
    const supplier29 = L({ name: 'Supplier 29', groupId: creditors, gstin: '29AABCF9012G1ZQ', stateCode: '29' })
    const sales = g('Sales Accounts')
    const bare = L({ name: 'Sales bare', groupId: sales, hsn: '9983' })
    const s18 = L({ name: 'Sales 18', groupId: sales, hsn: '9983', gstRate: 18 })
    const purchases = L({ name: 'Purchases', groupId: g('Purchase Accounts'), gstRate: 18, hsn: '9983' })
    const duties = g('Duties & Taxes')
    const cgst = L({ name: 'Output CGST', groupId: duties, taxType: 'cgst' })
    const sgst = L({ name: 'Output SGST', groupId: duties, taxType: 'sgst' })
    const igst = L({ name: 'Output IGST', groupId: duties, taxType: 'igst' })
    const cess = L({ name: 'Output Cess', groupId: duties, taxType: 'cess' })
    const inIgst = L({ name: 'Input IGST', groupId: duties, taxType: 'igst' })
    const item = (name: string, hsn: string, gstRate: number | null, cessRate: number | null): number =>
      createStockItem(db, { name, groupId: null, unitId: nos, hsn, gstRate, cessRate, openingQtyMilli: 50_000, openingValue: 2_500_000, barcode: null, reorderLevelMilli: null }).id
    const phone = item('Phone', '8517', 18, null)
    const cola = item('Cola', '2202', 28, 12)
    const base = { reference: null, narration: null, instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null, billRefs: [], tds: null }
    const line = (ledgerId: number, drCr: 'dr' | 'cr', amount: number) => ({ ledgerId, drCr, amount, costAllocations: [] })
    const inv = (stockItemId: number, qtyMilli: number, ratePaise: number, direction: 'in' | 'out', discountPaise = 0) =>
      ({ stockItemId, godownId: null, qtyMilli, ratePaise, amount: Math.round((qtyMilli * ratePaise) / 1000) - discountPaise, direction, discountPaise })
    let day = 1
    const post = (kind: string, party: number | null, lines: ReturnType<typeof line>[], inventory: ReturnType<typeof inv>[] = [], extra: Record<string, unknown> = {}): number =>
      saveVoucher(db, { ...base, voucherTypeId: vt(kind), date: `2025-07-${String(day++).padStart(2, '0')}`, partyLedgerId: party, lines, inventory, ...extra } as never).id
    const ids = [
      // Item invoice, two rates, cess, a discount: phones 2 × 500 = 1,000 @ 18 %; cola 1 × 1,000 − 100 = 900 @ 28 % + 12 % cess.
      post('sales', buyer27, [line(buyer27, 'dr', 244_000), line(s18, 'cr', 190_000), line(cgst, 'cr', 21_600), line(sgst, 'cr', 21_600), line(cess, 'cr', 10_800)],
        [inv(phone, 2_000, 50_000, 'out'), inv(cola, 1_000, 100_000, 'out', 10_000)]),
      // Ledger-line invoice on a RATE-LESS ledger with posted tax (the posted-rate rule: 18 %).
      post('sales', buyer27, [line(buyer27, 'dr', 118_000), line(bare, 'cr', 100_000), line(cgst, 'cr', 9_000), line(sgst, 'cr', 9_000)]),
      // Ledger-line invoice on the same rate-less ledger with NO tax posted.
      post('sales', buyer27, [line(buyer27, 'dr', 100_000), line(bare, 'cr', 100_000)]),
      // SEZ without payment (items) and export with payment of IGST.
      post('sales', sezWop, [line(sezWop, 'dr', 50_000), line(s18, 'cr', 50_000)], [inv(phone, 1_000, 50_000, 'out')]),
      post('sales', expWp, [line(expWp, 'dr', 59_000), line(s18, 'cr', 50_000), line(igst, 'cr', 9_000)], [inv(phone, 1_000, 50_000, 'out')]),
      // Place-of-supply override to Karnataka on a Maharashtra buyer: IGST.
      post('sales', buyer27, [line(buyer27, 'dr', 118_000), line(s18, 'cr', 100_000), line(igst, 'cr', 18_000)], [], { posOverride: '29' }),
      // A party ledger WITHOUT a state (the POS falls back to the company's state either way).
      post('sales', noState, [line(noState, 'dr', 118_000), line(s18, 'cr', 100_000), line(cgst, 'cr', 9_000), line(sgst, 'cr', 9_000)]),
      // Reverse-charge purchases: items (master rate 18 % → self-assessed 9 % + 9 %) and an amount.
      post('purchase', supplierRcm, [line(purchases, 'dr', 50_000), line(supplierRcm, 'cr', 50_000)], [inv(phone, 1_000, 50_000, 'in')]),
      post('purchase', supplierRcm, [line(purchases, 'dr', 20_000), line(supplierRcm, 'cr', 20_000)]),
      // An inter-state purchase with booked input IGST (ITC 4(A)(5), GSTR-9 Table 6 / 18 HSN).
      post('purchase', supplier29, [line(purchases, 'dr', 100_000), line(inIgst, 'dr', 18_000), line(supplier29, 'cr', 118_000)], [inv(phone, 2_000, 50_000, 'in')]),
      // A credit note for one phone of the first bill.
      post('credit_note', buyer27, [line(s18, 'dr', 50_000), line(cgst, 'dr', 4_500), line(sgst, 'dr', 4_500), line(buyer27, 'cr', 59_000)], [inv(phone, 1_000, 50_000, 'in')])
    ]
    const editMasters = (): void => {
      updateStockItem(db, phone, { ...getStockItem(db, phone)!, gstRate: 12, hsn: '8471' } as never)
      updateStockItem(db, cola, { ...getStockItem(db, cola)!, gstRate: 18, cessRate: null, hsn: '2201' } as never)
      updateLedger(db, bare, { ...getLedger(db, bare)!, gstRate: 5, hsn: '998312' } as never)
      updateLedger(db, s18, { ...getLedger(db, s18)!, gstRate: 12 } as never)
      updateLedger(db, purchases, { ...getLedger(db, purchases)!, gstRate: 5 } as never)
      updateLedger(db, buyer27, { ...getLedger(db, buyer27)!, gstin: '29AABCF9012G1ZQ', stateCode: '29', exportType: 'sez_wp' } as never)
      updateLedger(db, noState, { ...getLedger(db, noState)!, stateCode: '29' } as never)
      updateLedger(db, sezWop, { ...getLedger(db, sezWop)!, exportType: null } as never)
      updateLedger(db, supplierRcm, { ...getLedger(db, supplierRcm)!, rcm: false, gstin: '29AABCF9012G1ZQ', stateCode: '29' } as never)
      updateLedger(db, supplier29, { ...getLedger(db, supplier29)!, stateCode: '96' } as never)
    }
    return { db, ids, editMasters, buyer27, supplierRcm, phone, s18, cgst, sgst, base, line, inv, vt }
  }
  const SPAN = ['2025-07-01', '2025-07-31'] as const
  function everything(db: DB, ids: number[]) {
    const out: Record<string, unknown> = {}
    for (const [k, info] of Object.entries(INFOS)) {
      const edocs = extractEdocInvoices(db, info, ...SPAN)
      out[k] = JSON.parse(JSON.stringify({
        docs: extractOutwardDocs(db, info, ...SPAN),
        gstr1: gstr1(db, info, ...SPAN, '072025').json,
        gstr3b: gstr3b(db, info, ...SPAN, '072025'),
        gstr9: gstr9(db, info, 2025),
        edocs,
        edocList: listSalesInvoices(db, ...SPAN, info),
        einvoice: buildEInvoiceJson(edocs, { ...EDOC_CO, name: info.name }),
        rcm: rcmInwardByVoucher(db, info, ...SPAN),
        itc: bookedItcByVoucher(db, ...SPAN),
        prints: ids.map((id) => documentHtml(db, info, id).html)
      }))
    }
    return out
  }
  const clearAll = (db: DB): void => {
    db.prepare('UPDATE vouchers SET snap_tax_facts = NULL, snap_party_gstin = NULL, snap_party_state = NULL, snap_party_export_type = NULL, snap_party_rcm = NULL').run()
    db.prepare('UPDATE voucher_lines SET snap_gst_rate = NULL, snap_cess_rate = NULL, snap_hsn = NULL').run()
    db.prepare('UPDATE inventory_lines SET snap_gst_rate = NULL, snap_cess_rate = NULL, snap_hsn = NULL').run()
  }

  it('A (snapshot) = B (no snapshot, same masters) = E (snapshot written back after the masters moved); D follows the masters', () => {
    const c = corpus()
    const a = everything(c.db, c.ids)
    // Sanity: the corpus exercises what it claims to.
    const docs = (a.regular as { docs: { voucherId: number; invTyp: string; pos: string; items: { rate: number; cess: number }[] }[] }).docs
    expect(docs.find((d) => d.voucherId === c.ids[0])!.items.map((i) => [i.rate, i.cess])).toEqual([[18, 0], [28, 10_800]])
    expect(docs.find((d) => d.voucherId === c.ids[1])!.items.map((i) => i.rate)).toEqual([18]) // posted-rate rule on a NULL snapshot rate
    expect(docs.find((d) => d.voucherId === c.ids[2])!.items).toEqual([]) // no tax posted, rate-less: nil
    expect(docs.filter((d) => [c.ids[3], c.ids[4], c.ids[5], c.ids[6]].includes(d.voucherId)).map((d) => [d.invTyp, d.pos])).toEqual([['SEWOP', '27'], ['EXPWP', '96'], ['R', '29'], ['R', '27']])
    const g3 = (a.regular as { gstr3b: { rcm: { taxable: number; cgst: number; sgst: number; igst: number; cess: number }; itcParts: { isrc: { cgst: number; sgst: number; igst: number; cess: number } } } }).gstr3b
    expect(g3.rcm).toEqual({ taxable: 70_000, cgst: 6_300, sgst: 6_300, igst: 0, cess: 0 }) // 9 % + 9 % on 500 + 200
    expect(g3.itcParts.isrc).toEqual({ cgst: 6_300, sgst: 6_300, igst: 0, cess: 0 }) // 3.1(d) and 4(A)(3) agree
    expect((a.composition as { prints: string[] }).prints[0]).toContain('BILL OF SUPPLY')
    expect((a.unregistered as { prints: string[] }).prints[0]).toContain('INVOICE')
    expect((a.unregistered as { prints: string[] }).prints[0]).not.toContain('BILL OF SUPPLY')

    const saved = c.ids.map((id) => readTaxFacts(c.db, id)!)
    expect(saved.every(Boolean)).toBe(true)
    clearAll(c.db)
    expect(everything(c.db, c.ids)).toEqual(a) // B

    c.editMasters()
    const d = everything(c.db, c.ids)
    expect(d).not.toEqual(a)
    const dDocs = (d.regular as { docs: typeof docs }).docs
    expect(dDocs.find((x) => x.voucherId === c.ids[0])!.items.map((i) => i.rate)).toEqual([12, 18])
    expect(dDocs.find((x) => x.voucherId === c.ids[1])!.items.map((i) => i.rate)).toEqual([5]) // the ledger is rated now: its rate stays, the posted tax only validates
    expect((d.regular as { rcm: unknown[] }).rcm).toEqual([]) // the supplier is no longer flagged RCM

    c.ids.forEach((id, i) => writeTaxFacts(c.db, id, saved[i]!))
    expect(everything(c.db, c.ids)).toEqual(a) // E
  })

  it('GSTR-2B matching reads the LIVE supplier GSTIN (a typo fixed on the ledger heals earlier bills); returns keep the snapshot', () => {
    const c = corpus()
    const purchaseIds = c.ids.slice(7, 10)
    expect(extractPurchaseDocs(c.db, ...SPAN).map((p) => p.partyGstin)).toEqual(['27AAPFU0939F1ZV', '27AAPFU0939F1ZV', '29AABCF9012G1ZQ'])
    updateLedger(c.db, c.supplierRcm, { ...getLedger(c.db, c.supplierRcm)!, gstin: '27AABCS1429B1ZU' } as never)
    expect(extractPurchaseDocs(c.db, ...SPAN).filter((p) => purchaseIds.includes(p.voucherId)).map((p) => p.partyGstin)).toEqual(['27AABCS1429B1ZU', '27AABCS1429B1ZU', '29AABCF9012G1ZQ'])
    expect(rcmInwardByVoucher(c.db, INFO, ...SPAN).map((r) => r.partyGstin)).toEqual(['27AAPFU0939F1ZV', '27AAPFU0939F1ZV'])
  })

  it('altering a snapshotted bill after the party moved warns what moved (the party facts are not in the editor); an unchanged re-save does not', () => {
    const c = corpus()
    const id = c.ids[0]!
    const v = getVoucher(c.db, id)!
    const again = { ...c.base, voucherTypeId: v.voucherTypeId, date: v.date, number: v.number, partyLedgerId: v.partyLedgerId, lines: v.lines.map((l) => ({ ledgerId: l.ledgerId, drCr: l.drCr, amount: l.amount, costAllocations: [] })), inventory: v.inventory.map((l) => ({ stockItemId: l.stockItemId, godownId: l.godownId, qtyMilli: l.qtyMilli, ratePaise: l.ratePaise, amount: l.amount, direction: l.direction, discountPaise: l.discountPaise })) }
    expect(saveVoucher(c.db, again as never, id).warnings.taxFactsChanged).toBeUndefined()
    updateLedger(c.db, c.buyer27, { ...getLedger(c.db, c.buyer27)!, gstin: '29AABCF9012G1ZQ', stateCode: '29' } as never)
    updateStockItem(c.db, c.phone, { ...getStockItem(c.db, c.phone)!, hsn: '8471' } as never)
    const w = saveVoucher(c.db, again as never, id).warnings.taxFactsChanged
    expect(w).toHaveLength(1)
    expect(w![0]).toContain('party GSTIN 27AABCS1429B1ZU → 29AABCF9012G1ZQ')
    expect(w![0]).toContain('party state 27 → 29')
    expect(w![0]).toContain('item line 1 HSN 8517 → 8471')
    expect(readTaxFacts(c.db, id)!.party.state).toBe('29')
    // The pure diff: nothing for equal facts; line facts only while the line count is unchanged.
    const f = readTaxFacts(c.db, id)!
    expect(taxFactsDiff(f, f)).toEqual([])
    expect(taxFactsDiff({ ...f, inventory: [] }, f)).toEqual([])
  })
})
