// WP 6.3 review — Books workbook fidelity: a company using every field the workbook carries is
// exported, imported into a NEW company, and a canonical dump of EVERY table (ids and timestamps
// excluded, foreign keys replaced by the referenced row's own canonical form) must be identical.
// Then a second import (skip duplicates) changes nothing.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openCompanyDb, type DB } from '../db/connection'
import { seededDb } from '../db/testdb'
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

let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'total-fidelity-'))
  process.env.TOTAL_DATA_DIR = dataDir
})
afterEach(() => {
  delete process.env.TOTAL_DATA_DIR
  rmSync(dataDir, { recursive: true, force: true })
})

/** Tables that are not books data, or legitimately differ between two companies. */
const NOT_COMPARED = new Set(['audit_log', 'migrations', 'meta', 'sqlite_sequence', 'import_templates', 'import_batches', 'import_batch_items'])
const SKIP_COLUMN = (c: string): boolean => c === 'id' || c.endsWith('_at') || c === 'row_hash' || c === 'prev_hash'

/** Every table as a sorted list of canonical rows. */
export function canonicalDump(db: DB): Record<string, string[]> {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name).filter((t) => !NOT_COMPARED.has(t) && !t.startsWith('sqlite_'))
  const fks = new Map<string, Map<string, { table: string; to: string }>>()
  for (const t of tables) {
    fks.set(t, new Map((db.prepare(`PRAGMA foreign_key_list(${t})`).all() as { from: string; table: string; to: string | null }[]).map((f) => [f.from, { table: f.table, to: f.to ?? 'id' }])))
  }
  const memo = new Map<string, string>()
  const canon = (table: string, row: Record<string, unknown>, depth: number): string => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(row)) {
      if (SKIP_COLUMN(k)) continue
      const ref = fks.get(table)?.get(k)
      out[k] = ref && v !== null && depth < 6 ? refCanon(ref.table, ref.to, v, depth + 1) : v
    }
    return JSON.stringify(out)
  }
  const refCanon = (table: string, to: string, id: unknown, depth: number): string => {
    const key = `${table}#${to}#${String(id)}`
    if (!memo.has(key)) {
      const row = db.prepare(`SELECT * FROM ${table} WHERE ${to} = ?`).get(id) as Record<string, unknown> | undefined
      memo.set(key, row ? canon(table, row, depth) : 'missing')
    }
    return memo.get(key)!
  }
  const dump: Record<string, string[]> = {}
  for (const t of tables) dump[t] = (db.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[]).map((r) => canon(t, r, 0)).sort()
  return dump
}

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
  const capital = createLedger(db, { name: 'Partners Capital', groupId: groupId(db, 'Capital Account'), openingBalance: -500000, pan: null })
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
  saveVoucher(db, {
    ...base, voucherTypeId: vt(db, 'sales'), date: `${prevFy + 1}-05-08`, partyLedgerId: krishna, vehicleNo: 'MH12AB1234', transportDistanceKm: 140,
    lines: [{ ledgerId: krishna, drCr: 'dr', amount: 70000, costAllocations: [] }, { ledgerId: L(db, 'Sales A/c'), drCr: 'cr', amount: 70000, costAllocations: [] }],
    inventory: [{ stockItemId: phone.id, godownId: null, qtyMilli: 1000, ratePaise: 72000, discountPaise: 2000, amount: 70000, direction: 'out', serials: ['SN-1'], source: { lineUid: getVoucher(db, dn.id)!.inventory[0]!.lineUid!, linkType: 'fulfil' } }],
    billRefs: [{ kind: 'new', name: 'INV-K1', amount: 70000, dueDate: null }]
  })
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
