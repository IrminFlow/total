// WP 6.3 review — Books workbook fidelity: a company using every field the workbook carries is
// exported, imported into a NEW company, and a canonical dump of EVERY table (ids and timestamps
// excluded, foreign keys replaced by the referenced row's own canonical form) must be identical.
// Then a second import (skip duplicates) changes nothing.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openCompanyDb, type DB } from '../db/connection'
import { freshDb, seededDb } from '../db/testdb'
import { applySetup } from './companySetup'
import { readCompanyInfo, writeCompanyInfo } from '../db/seed'
import { fyOf, todayISO } from '@shared/dates'
import { createDemoCompany } from './demo'
import { buildBooksWorkbook } from './booksExport'
import { xlsxBytes } from './xlsxFile'
import { parseImportFile, planSteps } from './importFiles'
import { runImport, type ImportOptions } from './dataImport'
import { createGodown, createLedger, createStockItem, getLedger, updateLedger } from './masters'
import { getLockDate, getVoucher, saveVoucher } from './vouchers'
import { saveTradeDoc } from './tradeDocs'
import { listTradeDocTypes } from './tradeDocTypes'
import * as priceLevels from './priceLevels'
import { saveCostCentre } from './costCentres'
import { setBankDate } from './banking'
import { setCreditHold } from './receivables'
import { postClose } from './yearEnd'
import { trialBalance } from './reports'
import { canonicalDump } from './canonicalDump.testutil'
import { replaceOpeningBills } from './openingBills'
import { outstandings } from './analysis'

let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'total-fidelity-'))
  process.env.TOTAL_DATA_DIR = dataDir
})
afterEach(() => {
  delete process.env.TOTAL_DATA_DIR
  rmSync(dataDir, { recursive: true, force: true })
})

const id = (db: DB, sql: string, ...p: unknown[]): number => (db.prepare(sql).get(...p) as { id: number }).id
const groupId = (db: DB, name: string): number => id(db, 'SELECT id FROM groups WHERE name = ?', name)
const vt = (db: DB, kind: string): number => id(db, 'SELECT id FROM voucher_types WHERE kind = ? ORDER BY is_system DESC, id LIMIT 1', kind)
const L = (db: DB, name: string): number => id(db, 'SELECT id FROM ledgers WHERE name = ?', name)
const base = { partyLedgerId: null, narration: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null, inventory: [], billRefs: [], tds: null }

/** The demo company plus every field the workbook claims to carry. */
function richCompany(): { db: DB; prevFy: number } {
  const { slug } = createDemoCompany()
  const db = openCompanyDb(slug)
  const prevFy = fyOf(todayISO()).startYear - 1
  writeCompanyInfo(db, { ...readCompanyInfo(db), booksFrom: prevFy })

  // Masters with extras.
  const bank = createLedger(db, { name: 'HDFC Current', groupId: groupId(db, 'Bank Accounts'), pan: null })
  const capital = createLedger(db, { name: 'Partners Capital', groupId: groupId(db, 'Capital Account'), openingBalance: -950000, pan: null })
  // WP 8.7: a debtor whose opening is split into two opening bills (one settled in part below).
  const obCo = createLedger(db, { name: 'Opening Bills Co', groupId: groupId(db, 'Sundry Debtors'), openingBalance: 450000, pan: null })
  replaceOpeningBills(db, obCo.id, [
    { name: 'OB-1', date: `${prevFy - 1}-12-10`, dueDate: `${prevFy}-01-09`, amount: 300000 },
    { name: 'Opening', date: `${prevFy}-04-01`, dueDate: null, amount: 150000 }
  ])
  createLedger(db, { name: 'Office Furniture', groupId: groupId(db, 'Fixed Assets'), openingBalance: 500000, pan: null })
  const rent = createLedger(db, { name: 'Office Rent', groupId: groupId(db, 'Indirect Expenses'), pan: null })
  const income = createLedger(db, { name: 'Consulting Income', groupId: groupId(db, 'Indirect Incomes'), pan: null })
  createLedger(db, { name: 'TDS Payable 194C', groupId: groupId(db, 'Duties & Taxes'), pan: null, tdsPayableSectionId: id(db, "SELECT id FROM tds_sections WHERE code = '194C'") })
  const lvl = priceLevels.savePriceLevel(db, { name: 'Wholesale', inclusiveOfTax: true })
  const supplier = L(db, 'Bharat Steel Suppliers')
  updateLedger(db, supplier, {
    ...getLedger(db, supplier)!, rcm: true, itcEligibility: 'input_services', email: 'accounts@bharat.example', interestRateBp: 1800, interestGraceDays: 7,
    msmeRegistered: true, msmeCategory: 'micro', udyamNo: 'UDYAM-MH-26-0012345', agreedCreditDays: 30, priceLevelId: lvl.id
  } as never)
  const nos = id(db, "SELECT id FROM units WHERE symbol = 'Nos'")
  const phone = createStockItem(db, { name: 'Phone', groupId: null, unitId: nos, hsn: '8517', gstRate: 18, cessRate: null, openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null, trackSerials: true, valuationMethod: 'fifo', standardCostPaise: 45000 })
  const laptop = id(db, `SELECT id FROM stock_items WHERE name = 'Laptop 14"'`)
  priceLevels.saveRate(db, { priceLevelId: lvl.id, stockItemId: laptop, rate: 4400000, effectiveFrom: `${prevFy}-04-01`, effectiveTo: `${prevFy + 1}-03-31`, minQtyMilli: 2000, discountBp: 250 })
  createGodown(db, { name: 'Job Shop', kind: 'job_worker', partyLedgerId: supplier })
  const centre = saveCostCentre(db, { name: 'Head Office', parentId: null, active: true })

  // Previous FY: income, two receipts "1" (one per FY — numbers restart), then the close.
  saveVoucher(db, { ...base, voucherTypeId: vt(db, 'journal'), date: `${prevFy}-06-01`, lines: [{ ledgerId: capital.id, drCr: 'dr', amount: 120000, costAllocations: [] }, { ledgerId: income.id, drCr: 'cr', amount: 120000, costAllocations: [] }] })
  const umbrella = L(db, 'Umbrella Retail')
  const receipt = (date: string): number =>
    saveVoucher(db, { ...base, voucherTypeId: vt(db, 'receipt'), number: '1', date, partyLedgerId: umbrella, instrumentNo: 'CHQ-77', instrumentDate: date, lines: [{ ledgerId: bank.id, drCr: 'dr', amount: 25000, costAllocations: [] }, { ledgerId: umbrella, drCr: 'cr', amount: 25000, costAllocations: [] }] }).id
  receipt(`${prevFy}-07-01`)
  postClose(db, readCompanyInfo(db), prevFy)

  // Current FY.
  const r2 = receipt(`${prevFy + 1}-05-02`)
  setBankDate(db, getVoucher(db, r2)!.lines[0]!.id, `${prevFy + 1}-05-04`)
  saveVoucher(db, { ...base, voucherTypeId: vt(db, 'journal'), date: `${prevFy + 1}-05-03`, lines: [{ ledgerId: rent.id, drCr: 'dr', amount: 50000, costAllocations: [{ costCentreId: centre.id, amount: 50000 }] }, { ledgerId: capital.id, drCr: 'cr', amount: 50000, costAllocations: [] }] })
  saveVoucher(db, { ...base, voucherTypeId: vt(db, 'journal'), date: `${prevFy + 1}-05-03`, isOptional: true, lines: [{ ledgerId: rent.id, drCr: 'dr', amount: 100, costAllocations: [] }, { ledgerId: capital.id, drCr: 'cr', amount: 100, costAllocations: [] }] })
  saveVoucher(db, {
    ...base, voucherTypeId: vt(db, 'purchase'), date: `${prevFy + 1}-05-05`, partyLedgerId: supplier,
    lines: [{ ledgerId: L(db, 'Purchase A/c'), drCr: 'dr', amount: 100000, costAllocations: [] }, { ledgerId: supplier, drCr: 'cr', amount: 100000, costAllocations: [] }],
    inventory: [{ stockItemId: phone.id, godownId: null, qtyMilli: 2000, ratePaise: 50000, amount: 100000, direction: 'in', serials: ['SN-1', 'SN-2'] }],
    billRefs: [{ kind: 'new', name: 'BS-9', amount: 100000, dueDate: `${prevFy + 1}-06-04` }]
  })
  // Order → challan → invoice (the invoice line does not move stock: it moved on the challan).
  const krishna = L(db, 'Krishna Enterprises')
  const so = saveTradeDoc(db, {
    docTypeId: listTradeDocTypes(db).find((t) => t.kind === 'sales_order')!.id, date: `${prevFy + 1}-05-06`, number: 'SO-1', partyLedgerId: krishna, terms: 'Net 30',
    lines: [{ stockItemId: phone.id, qtyMilli: 1000, ratePaise: 70000, discountPaise: 0, amount: 70000, description: 'Phone, black' }]
  }).doc
  const dn = saveVoucher(db, {
    ...base, voucherTypeId: vt(db, 'delivery_note'), date: `${prevFy + 1}-05-07`, partyLedgerId: krishna, lines: [], trade: { purpose: 'supply' },
    inventory: [{ stockItemId: phone.id, godownId: null, qtyMilli: 1000, ratePaise: 70000, amount: 70000, direction: 'out', serials: ['SN-1'], source: { lineUid: so.lines[0]!.lineUid, linkType: 'fulfil' } }]
  })
  const krishnaInvoice = saveVoucher(db, {
    ...base, voucherTypeId: vt(db, 'sales'), date: `${prevFy + 1}-05-08`, partyLedgerId: krishna, vehicleNo: 'MH12AB1234', transportDistanceKm: 140,
    lines: [{ ledgerId: krishna, drCr: 'dr', amount: 70000, costAllocations: [] }, { ledgerId: L(db, 'Sales A/c'), drCr: 'cr', amount: 70000, costAllocations: [] }],
    inventory: [{ stockItemId: phone.id, godownId: null, qtyMilli: 1000, ratePaise: 72000, discountPaise: 2000, amount: 70000, direction: 'out', serials: ['SN-1'], source: { lineUid: getVoucher(db, dn.id)!.inventory[0]!.lineUid!, linkType: 'fulfil' } }],
    billRefs: [{ kind: 'new', name: 'INV-K1', amount: 70000, dueDate: null }]
  })
  // A part receipt matched to the named opening bill.
  saveVoucher(db, {
    ...base, voucherTypeId: vt(db, 'receipt'), date: `${prevFy + 1}-05-09`, partyLedgerId: obCo.id,
    lines: [{ ledgerId: bank.id, drCr: 'dr', amount: 100000, costAllocations: [] }, { ledgerId: obCo.id, drCr: 'cr', amount: 100000, costAllocations: [] }],
    billRefs: [{ kind: 'against', name: 'OB-1', amount: 100000, dueDate: null }]
  })
  // NIC follow-up: what the IRP / EWB system returned for the invoice (as the live client stores
  // it) — signed copies, a recorded IRN cancel and the e-way bill's history — rides in the workbook.
  db.prepare(
    `UPDATE vouchers SET irn = ?, irn_ack_no = '112610000000042', irn_ack_date = '${prevFy + 1}-05-08 11:02:00',
            irn_signed_invoice = 'eyJhbGciOiJSUzI1NiJ9.eyJkYXRhIjoiaW52In0.c2ln', irn_signed_qr = 'eyJhbGciOiJSUzI1NiJ9.eyJkYXRhIjoicXIifQ.c2ln',
            irn_cancelled_at = '${prevFy + 1}-05-08 15:40:00', irn_cancel_reason = 'data_entry_mistake', irn_cancel_remark = 'Wrong rate',
            ewb_date = NULL, ewb_history = ? WHERE id = ?`
  ).run('f'.repeat(64), JSON.stringify([
    { action: 'generate', ewbNo: '391000000101', at: `${prevFy + 1}-05-08 11:05:00`, validUpto: `${prevFy + 1}-05-09 23:59:00` },
    { action: 'cancel', ewbNo: '391000000101', at: `08/05/${prevFy + 1} 03:30:00 PM`, reason: 'data_entry_mistake', remark: 'Wrong rate' }
  ]), krishnaInvoice.id)
  setCreditHold(db, krishna, true, 'Cheque bounced')
  return { db, prevFy }
}

function importBooks(dst: DB, bytes: Uint8Array, opts: Partial<ImportOptions>) {
  const f = parseImportFile('books.xlsx', bytes)
  return runImport(dst, planSteps(f), { applyBooksFrom: Number(f.manifest!.booksFrom), lockDate: String(f.manifest!.lockDate) || null, sourceNamespace: `${f.manifest!.company}|${f.manifest!.gstin}`, ...opts }, { source: 'total-books', profileId: null, fileName: 'books.xlsx' }, false)
}

describe('Books workbook fidelity', () => {
  it('export → import into a new company reproduces every table, line by line', () => {
    const { db: src, prevFy } = richCompany()
    const bytes = xlsxBytes(buildBooksWorkbook(src, readCompanyInfo(src), '0.0.0-test').sheets)
    const dst = seededDb()
    const r = importBooks(dst, bytes, { duplicate: 'update' })
    expect(r.blocked).toBeUndefined()
    expect(r.steps.flatMap((s) => s.errors.map((e) => `${s.sheet}:${e.line} ${e.message}`))).toEqual([])
    expect(r.warnings).toEqual([])
    const a = canonicalDump(src)
    const b = canonicalDump(dst)
    for (const t of Object.keys(a)) expect({ table: t, rows: b[t] }).toEqual({ table: t, rows: a[t] })
    expect(readCompanyInfo(dst).booksFrom).toBe(prevFy)
    expect(getLockDate(dst)).toBe(getLockDate(src))
    // The closing journal is a closing journal again (immutable, out of profit).
    expect(dst.prepare('SELECT COUNT(*) AS n FROM vouchers WHERE is_year_end_close = 1').get()).toEqual({ n: 1 })
    expect(trialBalance(dst, `${prevFy + 1}-12-31`).totalDebit).toBe(trialBalance(src, `${prevFy + 1}-12-31`).totalDebit)
    // WP 8.7: the opening bills and the receipt matched to one of them come back intact.
    expect(dst.prepare("SELECT b.name, b.date, b.due_date AS dueDate, b.amount FROM opening_bills b JOIN ledgers l ON l.id = b.party_ledger_id WHERE l.name = 'Opening Bills Co' ORDER BY b.date").all()).toEqual([
      { name: 'OB-1', date: `${prevFy - 1}-12-10`, dueDate: `${prevFy}-01-09`, amount: 300000 },
      { name: 'Opening', date: `${prevFy}-04-01`, dueDate: null, amount: 150000 }
    ])
    const ob = (d: DB): unknown => outstandings(d, 'receivable', `${prevFy + 1}-06-30`).find((p) => p.name === 'Opening Bills Co')?.bills.map((x) => [x.number, x.pending])
    expect(ob(dst)).toEqual([['OB-1', 200000], ['Opening', 150000]])
    expect(ob(dst)).toEqual(ob(src))
    // The NIC facts — the cancel timestamp too, which the canonical dump skips as an `_at` column.
    const nicFacts = (d: DB): unknown => d.prepare(
      `SELECT irn, irn_ack_no, irn_ack_date, irn_signed_invoice, irn_signed_qr, irn_cancelled_at, irn_cancel_reason, irn_cancel_remark, ewb_no, ewb_date, ewb_history
         FROM vouchers WHERE irn IS NOT NULL ORDER BY date, number`
    ).all()
    expect(nicFacts(dst)).toEqual(nicFacts(src))
    expect((nicFacts(dst) as { irn_cancelled_at: string }[])[0]!.irn_cancelled_at).toBe(`${prevFy + 1}-05-08 15:40:00`)

    // A second import changes nothing (Source IDs match; both receipts "1" are found in their own FY).
    const again = importBooks(dst, bytes, { duplicate: 'skip' })
    expect(again.steps.reduce((n, s) => n + s.created + s.updated, 0)).toBe(0)
    expect(canonicalDump(dst)).toEqual(b)
    src.close()
  })

  it('a journal claiming to be a closing entry is imported, but not flagged, unless it is shaped like one', () => {
    const { db: src } = richCompany()
    const sheets = buildBooksWorkbook(src, readCompanyInfo(src), '0.0.0-test').sheets
    // Forge the flag onto an ordinary mid-year journal in the file.
    const vouchers = sheets.find((s) => s.name === 'Vouchers')!
    const cols = vouchers.columns.map((c) => c.header)
    const vmore = cols.indexOf('Voucher Details (JSON)')
    const type = cols.indexOf('Voucher Type')
    const date = cols.indexOf('Date')
    let forged = 0
    for (const row of vouchers.rows as (string | number | null)[][]) {
      if (row[type] === 'Journal' && String(row[date]).endsWith('-05-03') && row[vmore]) {
        row[vmore] = JSON.stringify({ ...JSON.parse(String(row[vmore])), is_year_end_close: 1 })
        forged++
      }
    }
    expect(forged).toBeGreaterThan(0)
    const dst = seededDb()
    const r = importBooks(dst, xlsxBytes(sheets), {})
    expect(r.warnings.filter((w) => /not a closing entry/.test(w)).length).toBeGreaterThan(0)
    expect(dst.prepare('SELECT COUNT(*) AS n FROM vouchers WHERE is_year_end_close = 1').get()).toEqual({ n: 1 }) // only the real one
    src.close()
  })
})

describe('Books workbook fidelity — a setup-preset company (WP 8.3)', () => {
  it('round-trips the preset accounts with their simple categories, unit and books', () => {
    const src = freshDb()
    applySetup(src, {
      name: 'Preset Round Trip', stateCode: '27', businessType: 'restaurant', gst: 'regular', gstin: '27AAPFU0939F1ZV', filing: 'quarterly',
      stock: true, startDate: `${fyOf(todayISO()).startYear}-04-01`, fresh: true
    }, todayISO())
    saveVoucher(src, {
      ...base, voucherTypeId: vt(src, 'sales'), date: todayISO(), number: undefined, partyLedgerId: L(src, 'Cash'),
      lines: [
        { ledgerId: L(src, 'Cash'), drCr: 'dr', amount: 11_800, costAllocations: [] },
        { ledgerId: L(src, 'Sales'), drCr: 'cr', amount: 10_000, costAllocations: [] },
        { ledgerId: L(src, 'Output CGST'), drCr: 'cr', amount: 900, costAllocations: [] },
        { ledgerId: L(src, 'Output SGST'), drCr: 'cr', amount: 900, costAllocations: [] }
      ]
    })
    const bytes = xlsxBytes(buildBooksWorkbook(src, readCompanyInfo(src), '0.0.0-test').sheets)
    const dst = seededDb()
    const r = importBooks(dst, bytes, { duplicate: 'update' })
    expect(r.blocked).toBeUndefined()
    expect(r.steps.flatMap((s) => s.errors.map((e) => `${s.sheet}:${e.line} ${e.message}`))).toEqual([])
    const a = canonicalDump(src)
    const b = canonicalDump(dst)
    for (const t of Object.keys(a)) expect({ table: t, rows: b[t] }).toEqual({ table: t, rows: a[t] })
    expect(dst.prepare("SELECT simple_category FROM ledgers WHERE name = 'Kitchen supplies'").get()).toEqual({ simple_category: 'kitchen_supplies' })
    src.close()
  })
})
