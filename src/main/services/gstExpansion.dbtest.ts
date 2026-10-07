// WP 3.4 — GST expansion on a real (in-memory) company: GSTR-9 workings tie to Σ the monthly
// GSTR-1 / GSTR-3B (and exclude binned / optional vouchers), ITC-04 from a job-work cycle, 2B
// tolerances + IMS persistence + bulk accept, RCM 3.1(d) / 4(A)(3) and self-invoices, ITC
// reversal workings (rule 42 / 43 / 37, s.17(5)) applied to 3B and posted as a journal.
import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { DB } from '../db/connection'
import type { CompanyInfo, DrCr } from '@shared/domain'
import { seededDb, TEST_INFO } from '../db/testdb'
import { MIGRATIONS } from '../db/migrations'
import { stockItemInputSchema, type VoucherInput } from '@shared/schemas'
import type { ManufactureInput } from '@shared/manufacture'
import { createGodown, createLedger, createStockItem } from './masters'
import { deleteVoucher, getVoucher, saveVoucher } from './vouchers'
import { gstr1, gstr3b, recon2b } from './gst'
import { exportGstr9, exportItc04, gstr9, itc04, recordGstr1Export } from './gstAnnual'
import { exportImsActions, getRecon2bTolerances, listImsActions, setImsActions, setRecon2bTolerances } from './gstIms'
import { generateSelfInvoice, listSelfInvoices, selfInvoiceDocument, selfInvoiceHtml, setSelfInvoiceSeries } from './gstRcm'
import { applyItcReversalTo3b, itcReversal, postItcReversal } from './gstItcReversal'
import { getGst3bManual } from './config'
import { costPreview, saveManufacture } from './manufacture'
import { saveJobWorkChallan } from './jobWork'
import { ensureCompanyTree } from '../paths'
import { bulkAcceptKeys, imsRows } from '@shared/gst/ims'
import { recon2bOptionsFrom } from '@shared/gst/recon2b'

const INFO: CompanyInfo = { ...TEST_INFO, gstin: '27AAAAA0000A1Z5' }
const SLUG = 'gst-expansion-test'

beforeAll(() => {
  process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-gst34-'))
  ensureCompanyTree(SLUG)
})

const rs = (rupees: number): number => Math.round(rupees * 100)

function books() {
  const db = seededDb()
  const groupId = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const vtId = (kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
  const L = (input: Parameters<typeof createLedger>[1]): number => createLedger(db, input).id
  const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
  const l = {
    cash,
    buyer: L({ name: 'Umbrella Retail', groupId: groupId('Sundry Debtors'), gstin: '27AABCD1234E1Z8', stateCode: '27' }),
    buyer29: L({ name: 'Krishna Enterprises', groupId: groupId('Sundry Debtors'), gstin: '29AABCF9012G1ZQ', stateCode: '29' }),
    sales: L({ name: 'Sales 18', groupId: groupId('Sales Accounts'), gstRate: 18, hsn: '9983' }),
    exempt: L({ name: 'Sales Exempt', groupId: groupId('Sales Accounts'), gstRate: 0, hsn: '9992' }),
    cgstOut: L({ name: 'CGST Output', groupId: groupId('Duties & Taxes'), taxType: 'cgst' }),
    sgstOut: L({ name: 'SGST Output', groupId: groupId('Duties & Taxes'), taxType: 'sgst' }),
    igstOut: L({ name: 'IGST Output', groupId: groupId('Duties & Taxes'), taxType: 'igst' }),
    cgstIn: L({ name: 'CGST Input', groupId: groupId('Duties & Taxes'), taxType: 'cgst' }),
    sgstIn: L({ name: 'SGST Input', groupId: groupId('Duties & Taxes'), taxType: 'sgst' }),
    igstIn: L({ name: 'IGST Input', groupId: groupId('Duties & Taxes'), taxType: 'igst' }),
    purchases: L({ name: 'Purchases 18', groupId: groupId('Purchase Accounts'), gstRate: 18 }),
    freight: L({ name: 'Freight Inward', groupId: groupId('Direct Expenses'), gstRate: 18, hsn: '9965' }),
    machinery: L({ name: 'Machinery', groupId: groupId('Fixed Assets') }),
    vendor: L({ name: 'Bharat Steel Suppliers', groupId: groupId('Sundry Creditors'), gstin: '27AABCG3456H1ZN', stateCode: '27' }),
    transporter: L({ name: 'Local Transporter', groupId: groupId('Sundry Creditors'), stateCode: '27', rcm: true }),
    caterer: L({ name: 'Caterer', groupId: groupId('Sundry Creditors'), gstin: '27AABCE5678F1ZH', stateCode: '27', itcEligibility: 'blocked' })
  }
  const post = (kind: string, date: string, partyId: number | null, lines: [number, DrCr, number][], o: { isOptional?: boolean; reference?: string } = {}) =>
    saveVoucher(db, {
      voucherTypeId: vtId(kind), date, partyLedgerId: partyId, reference: o.reference ?? null, isOptional: o.isOptional,
      lines: lines.map(([ledgerId, drCr, amount]) => ({ ledgerId, drCr, amount: rs(amount), costAllocations: [] })), inventory: [], billRefs: [], tds: null
    } as VoucherInput)
  const sale = (date: string, party: number, taxable: number, o: { inter?: boolean; isOptional?: boolean } = {}) =>
    post('sales', date, party, o.inter
      ? [[party, 'dr', taxable * 1.18], [l.sales, 'cr', taxable], [l.igstOut, 'cr', taxable * 0.18]]
      : [[party, 'dr', taxable * 1.18], [l.sales, 'cr', taxable], [l.cgstOut, 'cr', taxable * 0.09], [l.sgstOut, 'cr', taxable * 0.09]], o)
  const buy = (date: string, party: number, taxable: number, ledger = l.purchases, reference?: string) =>
    post('purchase', date, party, [[ledger, 'dr', taxable], [l.cgstIn, 'dr', taxable * 0.09], [l.sgstIn, 'dr', taxable * 0.09], [party, 'cr', taxable * 1.18]], { reference })
  return { db, l, post, sale, buy }
}

describe('migration 028', () => {
  it('creates gst_ims_actions and gst_self_invoices (self-contained, appended last)', () => {
    const at = MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE gst_ims_actions'))
    expect(at).toBe(MIGRATIONS.length - 1)
    expect(MIGRATIONS[at]).toContain('CREATE TABLE gst_self_invoices')
    const db = seededDb()
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
    expect(cols('gst_ims_actions')).toEqual(expect.arrayContaining(['period', 'supplier_gstin', 'doc_no', 'doc_date', 'action', 'note', 'decided_at']))
  })
})

describe('GSTR-9 workings', () => {
  function seeded() {
    const b = books()
    const { l } = b
    b.sale('2026-04-05', l.buyer, 10000)
    b.sale('2026-04-08', l.buyer29, 20000, { inter: true })
    b.post('sales', '2026-04-09', l.cash, [[l.cash, 'dr', 5000], [l.exempt, 'cr', 5000]]) // nil rated
    b.buy('2026-04-10', l.vendor, 8000)
    b.post('purchase', '2026-04-12', l.transporter, [[l.freight, 'dr', 2000], [l.transporter, 'cr', 2000]]) // RCM, unregistered
    b.post('credit_note', '2026-05-03', l.buyer, [[l.sales, 'dr', 1000], [l.cgstOut, 'dr', 90], [l.sgstOut, 'dr', 90], [l.buyer, 'cr', 1180]])
    b.buy('2026-05-06', l.caterer, 3000) // s.17(5) blocked credit
    const binned = b.sale('2026-05-07', l.buyer, 99999)
    deleteVoucher(b.db, binned.id)
    const optional = b.sale('2026-05-08', l.buyer, 77777, { isOptional: true })
    b.sale('2026-06-02', l.buyer, 4000)
    return { ...b, binned: binned.id, optional: optional.id }
  }

  it('every table ties to Σ the monthly GSTR-1 / GSTR-3B, and binned / optional vouchers are nowhere', () => {
    const s = seeded()
    const r = gstr9(s.db, INFO, 2026)
    for (const c of r.compare) expect({ id: c.id, diff: c.diff }).toEqual({ id: c.id, diff: { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 } })
    const row = (id: string) => r.rows.find((x) => x.id === id)!
    expect(row('4B').amounts).toEqual({ taxable: rs(34000), igst: rs(3600), cgst: rs(1260), sgst: rs(1260), cess: 0 })
    expect(row('4I').amounts.taxable).toBe(rs(1000))
    expect(row('5E').amounts.taxable).toBe(rs(5000))
    expect(row('4G').amounts).toEqual({ taxable: rs(2000), igst: 0, cgst: rs(180), sgst: rs(180), cess: 0 })
    expect(row('6C-IS').amounts).toMatchObject({ cgst: rs(180), sgst: rs(180) }) // freight = an input service
    expect(row('7E').amounts).toMatchObject({ cgst: rs(270), sgst: rs(270) })
    expect(row('6J').amounts).toEqual({ taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 })
    // Σ the year's monthly 3B 3.1(a)+(b) tax = Table 9 tax payable (+ RCM).
    let payable = 0
    for (const m of ['04', '05', '06']) {
      const g = gstr3b(s.db, INFO, `2026-${m}-01`, `2026-${m}-${m === '04' || m === '06' ? 30 : 31}`, `${m}2026`)
      payable += g.outward.cgst + g.outward.igst + g.outward.sgst + g.rcm.cgst + g.rcm.sgst
    }
    expect(r.paid.slice(0, 4).reduce((t, p) => t + p.payable, 0)).toBe(payable)
    const allDocs = r.rows.flatMap((x) => x.docs.map((d) => d.voucherId))
    expect(allDocs).not.toContain(s.binned)
    expect(allDocs).not.toContain(s.optional)
    expect(r.months.every((m) => m.source === 'books')).toBe(true)
  })

  it('compares against the exported snapshot: a voucher entered after export shows as a difference', () => {
    const s = seeded()
    recordGstr1Export(s.db, '042026', gstr1(s.db, INFO, '2026-04-01', '2026-04-30', '042026').json)
    s.sale('2026-04-20', s.l.buyer, 500)
    const r = gstr9(s.db, INFO, 2026)
    expect(r.months.find((m) => m.period === '042026')!.source).toBe('exported')
    expect(r.compare.find((c) => c.id === 'g1-taxable')!.diff).toMatchObject({ taxable: rs(500), cgst: rs(45), sgst: rs(45) })
    // 3B was not exported — rebuilt from the books, so it still ties.
    expect(r.compare.find((c) => c.id === '3b-out')!.diff.taxable).toBe(0)
  })

  it('exports CSV and JSON (own layout, flagged)', () => {
    const s = seeded()
    const { jsonPath, csvPath } = exportGstr9(s.db, INFO, SLUG, 2026)
    const json = JSON.parse(readFileSync(jsonPath, 'utf8')) as { verified_against_offline_tool: boolean; table4: Record<string, { txval: number }> }
    expect(json.verified_against_offline_tool).toBe(false)
    expect(json.table4.b!.txval).toBe(34000)
    expect(readFileSync(csvPath, 'utf8').split('\n')[0]).toContain('Particulars')
  })
})

describe('RCM: 3.1(d) and 4(A)(3) from the party rcm flag; self-invoices', () => {
  it('3B carries the RCM liability (cash only) and the same ITC under 4(A)(3)', () => {
    const b = books()
    b.sale('2026-04-05', b.l.buyer, 10000)
    b.post('purchase', '2026-04-12', b.l.transporter, [[b.l.freight, 'dr', 2000], [b.l.transporter, 'cr', 2000]])
    const g = gstr3b(b.db, INFO, '2026-04-01', '2026-04-30', '042026')
    expect(g.rcm).toEqual({ taxable: rs(2000), igst: 0, cgst: rs(180), sgst: rs(180), cess: 0 })
    expect(g.itcParts.isrc).toEqual({ igst: 0, cgst: rs(180), sgst: rs(180), cess: 0 })
    expect(g.rcmPayable).toEqual({ igst: 0, cgst: rs(180), sgst: rs(180), cess: 0 })
    // The RCM credit is set off against output tax; the RCM tax itself is still paid in cash.
    expect(g.netPayable.cgst).toBe(rs(900 - 180))
    const sup = g.json.sup_details as { isup_rev: { txval: number; camt: number } }
    expect(sup.isup_rev).toMatchObject({ txval: 2000, camt: 180 })
  })

  it('self-invoice: consecutive FY series, rule 47A status, refuses registered suppliers, prints', () => {
    const b = books()
    const p1 = b.post('purchase', '2026-04-12', b.l.transporter, [[b.l.freight, 'dr', 2000], [b.l.transporter, 'cr', 2000]], { reference: 'LR-55' })
    const p2 = b.post('purchase', '2026-05-20', b.l.transporter, [[b.l.freight, 'dr', 1000], [b.l.transporter, 'cr', 1000]])
    const reg = b.buy('2026-05-21', b.l.vendor, 100)
    let list = listSelfInvoices(b.db, INFO, '2026-04-01', '2026-06-30', '2026-05-25')
    expect(list.map((r) => [r.voucherId, r.status, r.dueDate])).toEqual([[p1.id, 'overdue', '2026-05-12'], [p2.id, 'due', '2026-06-19']])
    expect(list[0]!.tax).toBe(rs(360))
    const si1 = generateSelfInvoice(b.db, p1.id, '2026-04-15')
    const si2 = generateSelfInvoice(b.db, p2.id)
    expect([si1.number, si2.number]).toEqual(['SI/26-27/0001', 'SI/26-27/0002'])
    expect(si2.date).toBe('2026-05-20')
    expect(() => generateSelfInvoice(b.db, p1.id)).toThrow(/already exists/)
    expect(() => generateSelfInvoice(b.db, reg.id)).toThrow(/not marked reverse charge|registered/)
    list = listSelfInvoices(b.db, INFO, '2026-04-01', '2026-06-30', '2026-05-25')
    expect(list.map((r) => r.status)).toEqual(['generated', 'generated'])
    const doc = selfInvoiceDocument(b.db, INFO, p1.id)
    expect(doc.invoice).toMatchObject({ number: 'SI/26-27/0001', rchrg: true, taxable: rs(2000), cgst: rs(180), sgst: rs(180), total: rs(2360), partyName: 'Local Transporter' })
    const html = selfInvoiceHtml(b.db, INFO, p1.id)
    expect(html).toContain('SELF INVOICE')
    expect(html).toContain('Tax payable on reverse charge')
    expect(html).toContain('Supplier (unregistered)')
    // A binned purchase keeps its number: the list shows it cancelled.
    deleteVoucher(b.db, p2.id)
    expect(listSelfInvoices(b.db, INFO, '2026-04-01', '2026-06-30', '2026-05-25').map((r) => r.status)).toEqual(['generated', 'cancelled'])
    setSelfInvoiceSeries(b.db, { prefix: 'RC-' })
    const p3 = b.post('purchase', '2026-06-01', b.l.transporter, [[b.l.freight, 'dr', 10], [b.l.transporter, 'cr', 10]])
    expect(generateSelfInvoice(b.db, p3.id).number).toBe('RC-26-27/0003')
  })
})

describe('GSTR-2B tolerances, IMS actions and bulk accept', () => {
  const twoB = (inum: string, val: number, idt: string) =>
    JSON.stringify({ data: { rtnprd: '042026', docdata: { b2b: [{ ctin: '27AABCG3456H1ZN', inv: [{ inum, idt, val, items: [{ txval: val / 1.18, camt: (val / 1.18) * 0.09, samt: (val / 1.18) * 0.09 }] }] }] } } })

  it('tolerances persist and drive the matcher', () => {
    const b = books()
    expect(getRecon2bTolerances(b.db)).toEqual({ amountPaise: 100, amountPct: 0, dateDays: 7, fuzzyNumbers: true })
    b.buy('2026-04-10', b.l.vendor, 8000, b.l.purchases, 'BSS/2026-27/0012')
    const json = twoB('12', 9440, '20-04-2026') // 10 days later than the bill
    const tight = recon2b(b.db, json, '2026-04-01', '2026-04-30', recon2bOptionsFrom(getRecon2bTolerances(b.db)))
    expect(tight.result.pairs[0]).toMatchObject({ bucket: 'matched', matchedBy: 'numberCore' })
    setRecon2bTolerances(b.db, { amountPaise: 100, amountPct: 0, dateDays: 7, fuzzyNumbers: false })
    const strict = recon2b(b.db, json, '2026-04-01', '2026-04-30', recon2bOptionsFrom(getRecon2bTolerances(b.db)))
    expect(strict.result.buckets.matched.count).toBe(0)
    expect(() => setRecon2bTolerances(b.db, { amountPaise: -1, amountPct: 0, dateDays: 7, fuzzyNumbers: true })).toThrow()
  })

  it('bulk accept stores an accept per matched record; actions upsert, clear and export', () => {
    const b = books()
    const bill = b.buy('2026-04-10', b.l.vendor, 8000, b.l.purchases, '12')
    const json = JSON.stringify({ data: { rtnprd: '042026', docdata: { b2b: [{ ctin: '27AABCG3456H1ZN', inv: [
      { inum: '12', idt: '10-04-2026', val: 9440, items: [{ txval: 8000, camt: 720, samt: 720 }] },
      { inum: '99', idt: '11-04-2026', val: 118, items: [{ txval: 100, camt: 9, samt: 9 }] }
    ] }] } } })
    const { result } = recon2b(b.db, json, '2026-04-01', '2026-04-30')
    let rows = imsRows('042026', result.pairs, listImsActions(b.db, '042026'))
    const keys = new Set(bulkAcceptKeys(rows))
    expect(keys.size).toBe(1)
    const decide = (r: (typeof rows)[number], action: 'accept' | 'reject' | 'pending' | null, note: string | null = null) => ({
      supplierGstin: r.portal.gstin, docType: r.docType, docNo: r.portal.number, docDate: r.portal.date, action, note, voucherId: r.voucherId,
      value: r.portal.value, taxable: r.portal.taxable, igst: r.portal.igst, cgst: r.portal.cgst, sgst: r.portal.sgst, cess: r.portal.cess
    })
    expect(setImsActions(b.db, '042026', rows.filter((r) => keys.has(r.key)).map((r) => decide(r, 'accept')))).toEqual({ saved: 1, cleared: 0 })
    setImsActions(b.db, '042026', rows.filter((r) => !keys.has(r.key)).map((r) => decide(r, 'pending', 'Ask supplier')))
    let stored = listImsActions(b.db, '042026')
    expect(stored.map((s) => [s.docNo, s.action, s.voucherId, s.note])).toEqual([['12', 'accept', bill.id, null], ['99', 'pending', null, 'Ask supplier']])
    expect(stored[0]!.value).toBe(rs(9440))
    // Upsert: change the decision; the unique key keeps one row.
    rows = imsRows('042026', result.pairs, stored)
    setImsActions(b.db, '042026', [decide(rows.find((r) => r.portal.number === '99')!, 'reject', 'Not our purchase')])
    stored = listImsActions(b.db, '042026')
    expect(stored).toHaveLength(2)
    expect(stored.find((s) => s.docNo === '99')!.action).toBe('reject')
    expect(imsRows('042026', result.pairs, stored).map((r) => r.action)).toEqual(['accept', 'reject'])
    // Export, then clear one.
    const ex = exportImsActions(b.db, SLUG, INFO.gstin!, '042026')
    expect(ex.count).toBe(2)
    const j = JSON.parse(readFileSync(ex.jsonPath, 'utf8')) as { records: { action: string }[] }
    expect(j.records.map((x) => x.action)).toEqual(['A', 'R'])
    expect(existsSync(ex.csvPath)).toBe(true)
    setImsActions(b.db, '042026', [decide(rows.find((r) => r.portal.number === '99')!, null)])
    expect(listImsActions(b.db, '042026')).toHaveLength(1)
    // A binned voucher is dropped from the decision rather than refused.
    deleteVoucher(b.db, bill.id)
    setImsActions(b.db, '042026', [decide(rows.find((r) => r.portal.number === '12')!, 'accept')])
    expect(listImsActions(b.db, '042026')[0]!.voucherId).toBeNull()
  })
})

describe('ITC reversal workings (rule 42 / 43 / 37, s.17(5))', () => {
  // February 2026: a bill of ₹11,800 (CGST/SGST ₹900 each), ₹5,900 paid in March — unpaid half on
  // the 180th day (9 Aug 2026) → reversed in the September 2026 return, re-availed when paid in
  // October. September 2026: taxable sales ₹80,000 + exempt ₹20,000 (E/F 20%), inputs ₹50,000
  // (ITC ₹9,000), blocked catering ₹3,000 (ITC ₹540), machinery ₹1,00,000 (ITC ₹18,000).
  function seeded() {
    const b = books()
    const { l } = b
    b.buy('2026-02-10', l.vendor, 10000, l.purchases, 'OLD-1')
    b.post('payment', '2026-03-05', null, [[l.vendor, 'dr', 5900], [l.cash, 'cr', 5900]])
    b.sale('2026-09-05', l.buyer, 80000)
    b.post('sales', '2026-09-06', l.cash, [[l.cash, 'dr', 20000], [l.exempt, 'cr', 20000]])
    b.buy('2026-09-10', l.vendor, 50000)
    b.buy('2026-09-11', l.caterer, 3000)
    b.post('purchase', '2026-09-12', l.vendor, [[l.machinery, 'dr', 100000], [l.cgstIn, 'dr', 9000], [l.sgstIn, 'dr', 9000], [l.vendor, 'cr', 118000]])
    return b
  }
  const SEP = ['2026-09-01', '2026-09-30', '092026'] as const

  it('computes rule 42 D1, rule 43 Te, rule 37 reversal with interest and the blocked credit', () => {
    const b = seeded()
    const v = itcReversal(b.db, INFO, ...SEP)
    expect(v.turnover).toEqual({ E: rs(20000), F: rs(100000), borrowed: false })
    expect(v.rule42.T).toEqual({ igst: 0, cgst: rs(4500 + 270), sgst: rs(4500 + 270), cess: 0 })
    expect(v.rule42.C2).toEqual({ igst: 0, cgst: rs(4500), sgst: rs(4500), cess: 0 })
    expect(v.summary.rule42).toEqual({ igst: 0, cgst: rs(900), sgst: rs(900), cess: 0 })
    // Tc ₹9,000 per head / 60 = ₹150; × 20% = ₹30.
    expect(v.rule43.Tm).toEqual({ igst: 0, cgst: rs(150), sgst: rs(150), cess: 0 })
    expect(v.summary.rule43).toEqual({ igst: 0, cgst: rs(30), sgst: rs(30), cess: 0 })
    expect(v.rule37).toHaveLength(1)
    expect(v.rule37[0]!.reversed).toEqual({ igst: 0, cgst: rs(450), sgst: rs(450), cess: 0 })
    expect(v.rule37[0]!.interestDays).toBe(214) // 20 Mar 2026 → 20 Oct 2026
    expect(v.summary.blocked175).toEqual({ igst: 0, cgst: rs(270), sgst: rs(270), cess: 0 })
    expect(v.summary.table4B1).toEqual({ igst: 0, cgst: rs(930), sgst: rs(930), cess: 0 })
    expect(v.summary.table4B2).toEqual({ igst: 0, cgst: rs(450), sgst: rs(450), cess: 0 })
    expect(v.posted).toBeNull()
    expect(v.applied).toBe(false)
  })

  it('applies to the 3B (4(B)(1) + automatic s.17(5), 4(B)(2), 5.1) and posts the journal once', () => {
    const b = seeded()
    const applied = applyItcReversalTo3b(b.db, INFO, ...SEP)
    expect(applied.applied).toBe(true)
    const manual = getGst3bManual(b.db, '092026')
    expect(manual.itcRevRul.cgst).toBe(rs(930))
    expect(manual.itcRevOth.cgst).toBe(rs(450))
    expect(manual.interest.cgst).toBe(applied.summary.interest.cgst)
    const g = gstr3b(b.db, INFO, ...SEP)
    const rev = (g.json.itc_elg as { itc_rev: { ty: string; camt: number }[] }).itc_rev
    expect(rev.find((x) => x.ty === 'RUL')!.camt).toBe(930 + 270)
    expect(rev.find((x) => x.ty === 'OTH')!.camt).toBe(450)
    // 4(A)(5) carries the blocked credit (Circular 170), 4(C) nets it out again.
    expect(g.itcParts.oth.cgst).toBe(rs(4500 + 270 + 9000))
    expect(g.itc.cgst).toBe(rs(4500 + 270 + 9000 - 930 - 270 - 450))

    const posted = postItcReversal(b.db, INFO, ...SEP)
    const j = getVoucher(b.db, posted.voucherId)!
    const dr = j.lines.filter((x) => x.drCr === 'dr').reduce((t, x) => t + x.amount, 0)
    const cr = j.lines.filter((x) => x.drCr === 'cr').reduce((t, x) => t + x.amount, 0)
    expect(dr).toBe(cr)
    const name = (id: number) => (b.db.prepare('SELECT name FROM ledgers WHERE id = ?').get(id) as { name: string }).name
    const byName = Object.fromEntries(j.lines.map((x) => [name(x.ledgerId), [x.drCr, x.amount]]))
    // 900 + 30 + 450 + 270 per head.
    expect(byName['CGST Input']).toEqual(['cr', rs(1650)])
    expect(byName['SGST Input']).toEqual(['cr', rs(1650)])
    expect(byName['ITC Reversal']).toEqual(['dr', rs(3300)])
    expect(byName['GST Interest Payable']![0]).toBe('cr')
    expect(j.date).toBe('2026-09-30')
    expect(itcReversal(b.db, INFO, ...SEP).posted).toEqual(posted)
    expect(() => postItcReversal(b.db, INFO, ...SEP)).toThrow(/Already posted/)
    // GSTR-9 Table 7 splits the applied reversal by rule.
    const r9 = gstr9(b.db, INFO, 2026)
    const row = (id: string) => r9.rows.find((x) => x.id === id)!.amounts.cgst
    expect([row('7A'), row('7C'), row('7D'), row('7E'), row('7H')]).toEqual([rs(450), rs(900), rs(30), rs(270), 0])
  })

  it('re-avails in the month the rest is paid (4(D)(1))', () => {
    const b = seeded()
    b.post('payment', '2026-10-15', null, [[b.l.vendor, 'dr', 5900], [b.l.cash, 'cr', 5900]])
    const oct = itcReversal(b.db, INFO, '2026-10-01', '2026-10-31', '102026')
    expect(oct.summary.reclaimed).toEqual({ igst: 0, cgst: rs(450), sgst: rs(450), cess: 0 })
    expect(oct.summary.rule37).toEqual({ igst: 0, cgst: 0, sgst: 0, cess: 0 })
    expect(oct.proposal.find((p) => p.role === 'input_tax')).toMatchObject({ drCr: 'dr' })
  })
})

describe('ITC-04 from a job-work cycle', () => {
  it('Table 4 sent, 5A received back (processed with losses, and unprocessed), CSV/JSON', () => {
    const db: DB = seededDb()
    const groupId = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
    const typeId = (kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
    const unit = db.prepare("SELECT id FROM units WHERE uqc = 'KGS' LIMIT 1").get() as { id: number } | undefined
    const unitId = unit?.id ?? (db.prepare('SELECT id FROM units ORDER BY id LIMIT 1').get() as { id: number }).id
    const item = (name: string, q = 0, v = 0) => createStockItem(db, stockItemInputSchema.parse({ name, unitId, openingQtyMilli: q, openingValue: v, hsn: '7308', gstRate: 18 })).id
    const steel = item('Steel Rod', 20000, 300000)
    const frame = item('Frame')
    const worker = createLedger(db, { name: 'Ravi Fabricators', groupId: groupId('Sundry Creditors'), gstin: '29AABCF9012G1ZQ', stateCode: '29' }).id
    const own = createGodown(db, { name: 'Main' }).id
    const jw = createGodown(db, { name: 'Ravi (job work)', kind: 'job_worker', partyLedgerId: worker }).id
    const blank = { partyLedgerId: null, narration: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null, posOverride: null, currencyCode: null, exchangeRate: null }
    const cost = costPreview(db, { date: '2025-05-01', lines: [{ itemId: steel, qtyMilli: 8000 }] }).totalPaise
    const s = saveJobWorkChallan(db, {
      voucher: { ...blank, voucherTypeId: typeId('stock_journal'), date: '2025-05-01', lines: [], inventory: [
        { stockItemId: steel, godownId: own, batchId: null, qtyMilli: 8000, ratePaise: 0, amount: cost, direction: 'out' },
        { stockItemId: steel, godownId: jw, batchId: null, qtyMilli: 8000, ratePaise: 0, amount: cost, direction: 'in' }
      ] } as VoucherInput,
      challan: { kind: 'send', godownId: jw, natureOfProcessing: 'Bending and welding', goodsType: 'inputs' }
    })
    const input: Omit<ManufactureInput, 'profitPaise'> = {
      date: '2025-05-20', godownId: own, finishedItemId: frame, qtyMilli: 4000, saleRatePaise: 0,
      raw: [{ stockItemId: steel, qtyMilli: 6000, lossQtyMilli: 400 }], labourPaise: 0, labourPosted: false,
      jobWork: { godownId: jw, challanNo: 'RF/112', challanDate: '2025-05-19', natureOfProcessing: 'Bending and welding', originalChallanVoucherId: s.id }
    }
    const p = costPreview(db, { date: input.date, lines: input.raw.map((r) => ({ itemId: r.stockItemId, qtyMilli: r.qtyMilli })) })
    saveManufacture(db, { ...input, profitPaise: -p.totalPaise, confirmLoss: true } as ManufactureInput)
    saveJobWorkChallan(db, {
      voucher: { ...blank, voucherTypeId: typeId('stock_journal'), date: '2025-05-25', lines: [], inventory: [
        { stockItemId: steel, godownId: jw, batchId: null, qtyMilli: 2000, ratePaise: 15000, amount: 30000, direction: 'out' },
        { stockItemId: steel, godownId: own, batchId: null, qtyMilli: 2000, ratePaise: 15000, amount: 30000, direction: 'in' }
      ] } as VoucherInput,
      challan: { kind: 'return', godownId: jw, challanNo: 'RF/115', challanDate: '2025-05-25', goodsType: 'inputs', originalChallanVoucherId: s.id }
    })

    const v = itc04(db, INFO, { fyStartYear: 2025, kind: 'FY' })
    expect(v.derivedPeriodicity).toBe('annual')
    expect(v.result.period).toMatchObject({ kind: 'FY', from: '2025-04-01', to: '2026-03-31', dueDate: '2026-04-25' })
    const sv = getVoucher(db, s.id)!
    expect(v.result.sent).toEqual([expect.objectContaining({
      voucherId: s.id, challanNo: sv.number, challanDate: '2025-05-01', jwGstin: '29AABCF9012G1ZQ', jwStateCode: '29', partyLedgerId: worker,
      description: 'Steel Rod', qtyMilli: 8000, taxableValuePaise: cost, goodsType: 'inputs', igstRate: 18, cgstRate: 0, natureOfProcessing: 'Bending and welding'
    })])
    expect(v.result.received).toEqual([
      expect.objectContaining({ kind: 'processed', jwChallanNo: 'RF/112', jwChallanDate: '2025-05-19', originalChallanNo: sv.number, description: 'Frame', qtyMilli: 4000, lossQtyMilli: 400 }),
      expect.objectContaining({ kind: 'unprocessed', jwChallanNo: 'RF/115', originalChallanNo: sv.number, description: 'Steel Rod', qtyMilli: 2000 })
    ])
    expect(v.result.issues.filter((i) => i.severity === 'blocking')).toEqual([])
    // Half-yearly override: H1 holds the cycle, H2 is empty.
    expect(itc04(db, INFO, { fyStartYear: 2025, kind: 'H2', periodicity: 'half_yearly' }).result.sent).toEqual([])
    expect(itc04(db, INFO, { fyStartYear: 2025, kind: 'H1', periodicity: 'half_yearly' }).result.sent).toHaveLength(1)
    const ex = exportItc04(db, INFO, SLUG, { fyStartYear: 2025, kind: 'FY' })
    expect((JSON.parse(readFileSync(ex.jsonPath, 'utf8')) as { table4: unknown[] }).table4).toHaveLength(1)
    expect(readFileSync(ex.csvPath, 'utf8').split('\n')).toHaveLength(4)
  })
})
