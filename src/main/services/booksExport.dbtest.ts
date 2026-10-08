// WP 6.3 — the Books workbook round trip: export the demo company (plus an order, a sub-group,
// a price list and opening balances), import the .xlsx into a NEW company, and the trial
// balance, stock and orders come out identical. A second import changes nothing.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openCompanyDb, type DB } from '../db/connection'
import { seededDb } from '../db/testdb'
import { readCompanyInfo } from '../db/seed'
import { createDemoCompany } from './demo'
import { buildBooksWorkbook } from './booksExport'
import { xlsxBytes } from './xlsxFile'
import { parseImportFile, planSteps } from './importFiles'
import { runImport, undoImport } from './dataImport'
import { trialBalance } from './reports'
import { stockSummary } from './stockAnalysis'
import { createGroup, createLedger, getLedger } from './masters'
import { saveTradeDoc } from './tradeDocs'
import { listTradeDocTypes } from './tradeDocTypes'
import * as priceLevels from './priceLevels'

let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'total-books-'))
  process.env.TOTAL_DATA_DIR = dataDir
})
afterEach(() => {
  delete process.env.TOTAL_DATA_DIR
  rmSync(dataDir, { recursive: true, force: true })
})

const AS_ON = '2099-03-31'
const tbRows = (db: DB): string[] =>
  trialBalance(db, AS_ON).rows.map((r) => `${r.ledgerName}|${r.groupName}|${r.debit}|${r.credit}`).sort()
const stockRows = (db: DB): string[] => stockSummary(db, AS_ON).map((s) => `${s.name}|${s.closingQtyMilli}|${s.closingValue}`).sort()
const id = (db: DB, sql: string, ...p: unknown[]): number => (db.prepare(sql).get(...p) as { id: number }).id

function sourceCompany(): DB {
  const { slug } = createDemoCompany()
  const db = openCompanyDb(slug)
  const sub = createGroup(db, { name: 'Export Debtors', parentId: id(db, "SELECT id FROM groups WHERE name = 'Sundry Debtors'") })
  createLedger(db, { name: 'Overseas Buyer', groupId: sub.id, openingBalance: 250000, pan: null })
  createLedger(db, { name: 'Partners Capital', groupId: id(db, "SELECT id FROM groups WHERE name = 'Capital Account'"), openingBalance: -250000, pan: null })
  const item = id(db, 'SELECT id FROM stock_items ORDER BY id LIMIT 1')
  const so = listTradeDocTypes(db).find((t) => t.kind === 'sales_order')!
  saveTradeDoc(db, {
    docTypeId: so.id, date: '2025-06-01', number: 'SO-77', partyLedgerId: id(db, "SELECT id FROM ledgers WHERE name = 'Overseas Buyer'"),
    lines: [{ stockItemId: item, qtyMilli: 3000, ratePaise: 10000, discountPaise: 500, amount: 29500 }]
  })
  const lvl = priceLevels.savePriceLevel(db, { name: 'Wholesale' })
  priceLevels.saveRate(db, { priceLevelId: lvl.id, stockItemId: item, rate: 9900, effectiveFrom: '2025-04-01' })
  return db
}

describe('Books workbook', () => {
  it('has a Manifest, a sheet per entity and the (info) sheets', () => {
    const db = sourceCompany()
    const { sheets, counts } = buildBooksWorkbook(db, readCompanyInfo(db), '0.0.0-test', AS_ON)
    expect(sheets.map((s) => s.name)).toEqual([
      'Manifest', 'Groups', 'Units', 'Stock Groups', 'Price Levels', 'Ledgers', 'Godowns', 'Stock Items', 'Batches', 'Price Lists', 'Voucher Types', 'Cost Centres', 'Orders', 'Vouchers', 'GST (info)', 'Stock (info)'
    ])
    expect(counts.Orders).toBe(1)
    expect(counts.Vouchers).toBeGreaterThan(40)
    const manifest = Object.fromEntries((sheets[0]!.rows as string[][]).map((r) => [r[0], r[1]]))
    expect(manifest).toMatchObject({ format: 'total-books', schemaVersion: '1', company: 'Demo Traders' })
    db.close()
  })

  it('round-trips into a new company: identical trial balance, stock and orders; re-import is a no-op; undo empties it', () => {
    const src = sourceCompany()
    const info = readCompanyInfo(src)
    const bytes = xlsxBytes(buildBooksWorkbook(src, info, '0.0.0-test', AS_ON).sheets)
    const f = parseImportFile('books.xlsx', bytes)
    expect(f.kind).toBe('books')

    const dst = seededDb()
    const r = runImport(dst, planSteps(f), { duplicate: 'update', applyBooksFrom: info.booksFrom }, { source: 'total-books', profileId: null, fileName: 'books.xlsx' }, false)
    const errors = r.steps.flatMap((s) => s.errors.map((e) => `${s.sheet}:${e.line} ${e.message}`))
    expect(errors).toEqual([])
    expect(readCompanyInfo(dst).booksFrom).toBe(info.booksFrom)
    expect(tbRows(dst)).toEqual(tbRows(src))
    const tb = trialBalance(dst, AS_ON)
    expect(tb.totalDebit).toBe(trialBalance(src, AS_ON).totalDebit)
    expect(stockRows(dst)).toEqual(stockRows(src))
    expect(dst.prepare("SELECT d.number, l.qty_milli, l.rate_paise, l.discount_paise, l.amount FROM trade_docs d JOIN trade_doc_lines l ON l.doc_id = d.id").all())
      .toEqual([{ number: 'SO-77', qty_milli: 3000, rate_paise: 10000, discount_paise: 500, amount: 29500 }])
    expect(getLedger(dst, id(dst, "SELECT id FROM ledgers WHERE name = 'Overseas Buyer'"))!.openingBalance).toBe(250000)
    expect(dst.prepare('SELECT rate FROM price_list_rates').all()).toEqual([{ rate: 9900 }])
    // Same voucher numbers and count.
    const nums = (db: DB): string[] => (db.prepare('SELECT vt.name || \'/\' || v.number AS n FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id WHERE v.deleted_at IS NULL').all() as { n: string }[]).map((x) => x.n).sort()
    expect(nums(dst)).toEqual(nums(src))

    const again = runImport(dst, planSteps(parseImportFile('books.xlsx', bytes)), { duplicate: 'skip' }, { source: 'total-books', profileId: null, fileName: 'books.xlsx' }, false)
    expect(again.steps.reduce((n, s) => n + s.created + s.updated, 0)).toBe(0)
    expect(tbRows(dst)).toEqual(tbRows(src))

    const u = undoImport(dst, r.batchId!)
    expect(u.binned).toBe(nums(src).length + 1) // every voucher + the order
    expect(dst.prepare('SELECT COUNT(*) AS n FROM vouchers WHERE deleted_at IS NULL').get()).toEqual({ n: 0 })
    src.close()
  })
})
