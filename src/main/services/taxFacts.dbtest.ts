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
import { extractOutwardDocs, gstr1, gstr3b } from './gst'
import { extractEdocInvoices } from './edocs'
import { gstr9 } from './gstAnnual'
import { documentHtml } from './printTemplates'
import { readTaxFacts, writeTaxFacts } from './taxFacts'
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
