// WP 6.3 import engine: every generic target, duplicate strategies, dry run, the openings
// trial-balance check, the posting rules on vouchers, audit, templates and undo.
import { describe, expect, it } from 'vitest'
import { seededDb } from '../db/testdb'
import type { DB } from '../db/connection'
import { runImport, undoImport, listBatches, saveTemplate, listTemplates, deleteTemplate, openingTotals, type ImportOptions } from './dataImport'
import { autoPlan, parseImportFile, tableSteps } from './importFiles'
import { getLedger } from './masters'
import { getVoucher } from './vouchers'
import { trialBalance } from './reports'
import * as stock from './stockAnalysis'
import { writeXlsx } from '@shared/xlsx'
import { deflateRawSync } from 'zlib'
import { headerSignature } from '@shared/dataImport/detect'

const enc = new TextEncoder()

function run(db: DB, csv: string, opts: Partial<ImportOptions> = {}, dryRun = false, profileId?: string) {
  const f = parseImportFile('test.csv', enc.encode(csv))
  const { steps, profile } = autoPlan(db, f, '27', { profileId })
  return runImport(db, steps, opts, { source: profile.source, profileId: profile.id, fileName: 'test.csv' }, dryRun)
}

const ledgerId = (db: DB, name: string): number | undefined =>
  (db.prepare('SELECT id FROM ledgers WHERE name = ? COLLATE NOCASE').get(name) as { id: number } | undefined)?.id
const count = (db: DB, table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

const LEDGERS = [
  'Name,Group,Opening Balance,GSTIN,State,PAN,Credit Days',
  'Acme Traders,Sundry Debtors,"15,000.00 Dr",27AAPFU0939F1ZV,Maharashtra,,30',
  'Beta Supplies,Sundry Creditors,"5,000.00 Cr",,,ABCDE1234F,',
  'Capital,Capital Account,"10,000.00 Cr",,,,',
  'Bad GSTIN,Sundry Debtors,,27AAPFU0939F1ZX,,,'
].join('\n')

describe('ledgers', () => {
  it('creates ledgers with GST details, reports row errors (GSTIN checksum) and audits a summary row', () => {
    const db = seededDb()
    const r = run(db, LEDGERS)
    expect(r.dryRun).toBe(false)
    expect(r.steps[0]).toMatchObject({ target: 'ledgers', created: 3 })
    expect(r.steps[0]!.errors).toEqual([expect.objectContaining({ line: 5, field: 'gstin', message: expect.stringMatching(/checksum/) })])
    const acme = getLedger(db, ledgerId(db, 'Acme Traders')!)!
    expect(acme).toMatchObject({ openingBalance: 1500000, gstin: '27AAPFU0939F1ZV', stateCode: '27', pan: 'AAPFU0939F', creditDays: 30 })
    expect(getLedger(db, ledgerId(db, 'Beta Supplies')!)!).toMatchObject({ openingBalance: -500000, pan: 'ABCDE1234F' })
    // Each ledger audited by masters.createLedger, plus one csv_import summary row.
    expect(count(db, "audit_log WHERE entity = 'ledger' AND action = 'create'")).toBe(3)
    const summary = db.prepare("SELECT entity_id, after_json FROM audit_log WHERE entity = 'csv_import'").get() as { entity_id: number; after_json: string }
    expect(summary.entity_id).toBe(r.batchId)
    expect(JSON.parse(summary.after_json)).toMatchObject({ source: 'generic', profile: 'generic:ledgers', errors: 1 })
    expect(r.openingCheck).toEqual({ debit: 1500000, credit: 1500000, difference: 0, stockOpening: 0 })
  })

  it('a dry run reports the same counts and writes nothing (not even the audit row)', () => {
    const db = seededDb()
    const before = { ledgers: count(db, 'ledgers'), audit: count(db, 'audit_log'), batches: count(db, 'import_batches') }
    const dry = run(db, LEDGERS, {}, true)
    expect(dry.dryRun).toBe(true)
    expect(dry.batchId).toBeNull()
    expect(dry.steps[0]).toMatchObject({ created: 3 })
    expect({ ledgers: count(db, 'ledgers'), audit: count(db, 'audit_log'), batches: count(db, 'import_batches') }).toEqual(before)
  })

  it('duplicates: skip leaves, update merges (keeping unmapped fields), create adds "(2)"', () => {
    const db = seededDb()
    run(db, LEDGERS)
    const changed = 'Name,Group,Credit Days\nAcme Traders,Sundry Debtors,45'
    expect(run(db, changed, { duplicate: 'skip' }).steps[0]).toMatchObject({ skipped: 1, created: 0 })
    expect(getLedger(db, ledgerId(db, 'Acme Traders')!)!.creditDays).toBe(30)
    expect(run(db, changed, { duplicate: 'update' }).steps[0]).toMatchObject({ updated: 1 })
    expect(getLedger(db, ledgerId(db, 'Acme Traders')!)!).toMatchObject({ creditDays: 45, gstin: '27AAPFU0939F1ZV', openingBalance: 1500000 })
    expect(run(db, changed, { duplicate: 'create' }).steps[0]).toMatchObject({ created: 1 })
    expect(ledgerId(db, 'Acme Traders (2)')).toBeDefined()
  })

  it('an unknown group goes to Suspense A/c with a warning when creating missing masters, else errors', () => {
    const db = seededDb()
    const csv = 'Name,Group\nOdd One,Imaginary Group'
    expect(run(db, csv, { createMissing: false }).steps[0]!.errors[0]!.message).toMatch(/Unknown group "Imaginary Group"/)
    const r = run(db, csv, { createMissing: true })
    expect(r.steps[0]!.warnings[0]).toMatch(/Suspense A\/c/)
    const g = db.prepare('SELECT g.name FROM ledgers l JOIN groups g ON g.id = l.group_id WHERE l.name = ?').get('Odd One') as { name: string }
    expect(g.name).toBe('Suspense A/c')
  })
})

describe('parties, groups, units, godowns, stock groups, items, batches, price lists', () => {
  it('parties default to debtors / creditors by type and take state + PAN', () => {
    const db = seededDb()
    const r = run(db, ['Party Name,Party Type,GSTIN,PAN,Credit Days', 'Kiran Stores,Customer,29AABCF9012G1ZQ,,15', 'Mills Ltd,vendor,,AAACM1234C,'].join('\n'), {}, false, 'generic:parties')
    expect(r.steps[0]).toMatchObject({ created: 2 })
    const grp = (n: string): string => (db.prepare('SELECT g.name FROM ledgers l JOIN groups g ON g.id = l.group_id WHERE l.name = ?').get(n) as { name: string }).name
    expect(grp('Kiran Stores')).toBe('Sundry Debtors')
    expect(grp('Mills Ltd')).toBe('Sundry Creditors')
    expect(getLedger(db, ledgerId(db, 'Kiran Stores')!)!.stateCode).toBe('29')
  })

  it('groups nest in any order (parents later in the file)', () => {
    const db = seededDb()
    const r = run(db, 'Name,Under\nExport Debtors,Overseas\nOverseas,Sundry Debtors', {}, false, 'generic:groups')
    expect(r.steps[0]).toMatchObject({ created: 2 })
    const nature = (db.prepare("SELECT nature FROM groups WHERE name = 'Export Debtors'").get() as { nature: string }).nature
    expect(nature).toBe('asset')
  })

  it('units (UQC mapped), godowns, stock groups and items with opening stock + auto-created references', () => {
    const db = seededDb()
    expect(run(db, 'Name,Symbol,Decimals,UQC\nDozens,Dzn,0,DOZ', {}, false, 'generic:units').steps[0]).toMatchObject({ created: 1 })
    expect(run(db, 'Name,Address\nWarehouse 2,Pune', {}, false, 'generic:godowns').steps[0]).toMatchObject({ created: 1 })
    expect(run(db, 'Name,Under\nFasteners,\nBolts,Fasteners', {}, false, 'generic:stockGroups').steps[0]).toMatchObject({ created: 2 })
    const items = run(db, [
      'Item Name,Group,Unit,HSN,GST Rate,Opening Qty,Opening Value,MRP',
      'Hex Bolt,Bolts,Nos,7318,18,100,"2,500.00",40',
      'Washer,Washers,Packs,7318,18%,10.5,,',
      'Bad HSN,Bolts,Nos,73A8,18,,,'
    ].join('\n'))
    expect(items.steps[0]).toMatchObject({ target: 'items', created: 2 })
    expect(items.steps[0]!.errors.map((e) => e.field)).toEqual(['hsn'])
    expect(db.prepare("SELECT name FROM units WHERE name = 'Packs'").get()).toBeTruthy() // auto-created
    expect(db.prepare("SELECT name FROM stock_groups WHERE name = 'Washers'").get()).toBeTruthy()
    const bolt = db.prepare("SELECT opening_qty_milli AS q, opening_value AS v, mrp_paise AS mrp FROM stock_items WHERE name = 'Hex Bolt'").get()
    expect(bolt).toEqual({ q: 100000, v: 250000, mrp: 4000 })
    // The valuation pass sees the opening (the one inventory pass reads stock_items).
    expect(stock.stockSummary(db, '2025-04-30').find((s) => s.name === 'Hex Bolt')).toMatchObject({ closingQtyMilli: 100000, closingValue: 250000 })
    expect(run(db, 'Item,Batch,Mfg Date,Expiry Date\nHex Bolt,B-01,01/04/2025,31-03-2027', {}, false, 'generic:batches').steps[0]).toMatchObject({ created: 1 })
    expect(db.prepare('SELECT mfg_date, expiry_date FROM batches').get()).toEqual({ mfg_date: '2025-04-01', expiry_date: '2027-03-31' })
    const pl = run(db, 'Price Level,Item,Rate,From Date\nWholesale,Hex Bolt,22.50,2025-04-01\nWholesale,Ghost,1,', {}, false, 'generic:priceLists')
    expect(pl.steps[0]).toMatchObject({ created: 1 })
    expect(pl.steps[0]!.errors[0]!.message).toMatch(/Unknown stock item "Ghost"/)
    expect(db.prepare('SELECT rate FROM price_list_rates').get()).toEqual({ rate: 2250 })
  })
})

describe('opening balances (trial-balance check)', () => {
  const setup = (): DB => {
    const db = seededDb()
    run(db, 'Name,Group\nAcme Traders,Sundry Debtors\nCapital,Capital Account\nHDFC Bank,Bank Accounts')
    return db
  }

  it('block (default): openings that do not tie are refused as a whole', () => {
    const db = setup()
    const r = run(db, 'Ledger,Debit,Credit\nAcme Traders,1000,\nCapital,,900', {}, false, 'generic:openings')
    expect(r.steps[0]!.errors.at(-1)!.message).toMatch(/do not tie.*difference ₹100\.00 Dr/)
    expect(r.steps[0]!.updated).toBe(0)
    expect(getLedger(db, ledgerId(db, 'Acme Traders')!)!.openingBalance).toBe(0)
  })

  it('suspense: the difference goes to an explicit "Difference in Opening Balances" ledger and Dr = Cr', () => {
    const db = setup()
    const r = run(db, 'Ledger,Opening Balance,Dr/Cr\nAcme Traders,1000,Dr\nCapital,900,Cr', { openingDifference: 'suspense' }, false, 'generic:openings')
    expect(r.steps[0]!.updated).toBe(2)
    expect(r.steps[0]!.warnings[0]).toMatch(/Difference in Opening Balances/)
    const diff = getLedger(db, ledgerId(db, 'Difference in Opening Balances')!)!
    expect(diff.openingBalance).toBe(-10000)
    expect(openingTotals(db).difference).toBe(0)
    const tb = trialBalance(db, '2026-03-31')
    expect(tb.totalDebit).toBe(tb.totalCredit)
  })

  it('leave: applied with a warning; the opening stock value counts on the Dr side', () => {
    const db = setup()
    run(db, 'Item,Unit,Opening Qty,Opening Value\nWidget,Nos,10,500')
    const r = run(db, 'Ledger,Opening Balance\nCapital,500 Cr', { openingDifference: 'leave' }, false, 'generic:openings')
    expect(r.steps[0]!.warnings).toEqual([])
    expect(r.openingCheck).toEqual({ debit: 50000, credit: 50000, difference: 0, stockOpening: 50000 })
  })

  it('stock openings set quantity and value per item; undo restores the previous opening', () => {
    const db = setup()
    run(db, 'Item,Unit\nWidget,Nos')
    const r = run(db, 'Item,Quantity,Rate\nWidget,12,25', {}, false, 'generic:stockOpenings')
    expect(r.steps[0]).toMatchObject({ updated: 1 })
    expect(db.prepare("SELECT opening_qty_milli AS q, opening_value AS v FROM stock_items WHERE name = 'Widget'").get()).toEqual({ q: 12000, v: 30000 })
    undoImport(db, r.batchId!)
    expect(db.prepare("SELECT opening_qty_milli AS q, opening_value AS v FROM stock_items WHERE name = 'Widget'").get()).toEqual({ q: 0, v: 0 })
  })
})

const VOUCHERS = [
  'Voucher Type,Date,Number,Party,Ledger,Debit,Credit,Item,Quantity,Rate,Bill Ref,Narration',
  'Sales,05-05-2025,S-1,Acme Traders,Acme Traders,1180,,,,,S-1,First sale',
  ',,,,Sales A/c,,1000,Widget,10,100,,',
  ',,,,CGST Output,,90,,,,,',
  ',,,,SGST Output,,90,,,,,',
  'Receipt,10-05-2025,R-1,Acme Traders,Cash,1180,,,,,S-1,',
  ',,,,Acme Traders,,1180,,,,,',
  'Journal,12-05-2025,J-1,,Cash,100,,,,,,unbalanced',
  ',,,,Capital,,90,,,,,'
].join('\n')

function voucherCompany(): DB {
  const db = seededDb()
  run(db, [
    'Name,Group,Tax Type',
    'Acme Traders,Sundry Debtors,', 'Capital,Capital Account,', 'Sales A/c,Sales Accounts,', 'CGST Output,Duties & Taxes,CGST', 'SGST Output,Duties & Taxes,SGST'
  ].join('\n'))
  run(db, 'Item,Unit,Opening Qty,Opening Value\nWidget,Nos,50,2500')
  return db
}

describe('vouchers', () => {
  it('builds vouchers from continuation rows, runs them through saveVoucher (posting rules) and reports the bad one', () => {
    const db = voucherCompany()
    const r = run(db, VOUCHERS)
    expect(r.steps[0]).toMatchObject({ target: 'vouchers', created: 2 })
    expect(r.steps[0]!.errors).toEqual([expect.objectContaining({ line: 8, message: expect.stringMatching(/debit|credit|balance/i) })])
    const sale = db.prepare("SELECT id FROM vouchers WHERE number = 'S-1'").get() as { id: number }
    const v = getVoucher(db, sale.id)!
    expect(v.lines.map((l) => [l.drCr, l.amount])).toEqual([['dr', 118000], ['cr', 100000], ['cr', 9000], ['cr', 9000]])
    expect(v.inventory.map((i) => [i.direction, i.qtyMilli, i.amount])).toEqual([['out', 10000, 100000]])
    expect(v.billRefs).toEqual([expect.objectContaining({ kind: 'new', name: 'S-1', amount: 118000 })])
    const rcpt = getVoucher(db, (db.prepare("SELECT id FROM vouchers WHERE number = 'R-1'").get() as { id: number }).id)!
    expect(rcpt.billRefs).toEqual([expect.objectContaining({ kind: 'against', name: 'S-1', amount: 118000 })])
    // Every voucher audited by saveVoucher.
    expect(count(db, "audit_log WHERE entity = 'voucher' AND action = 'create'")).toBe(2)
    expect(stock.stockSummary(db, '2025-05-31').find((s) => s.name === 'Widget')!.closingQtyMilli).toBe(40000)
  })

  it('skips duplicates by type + number on a second run, updates them on request', () => {
    const db = voucherCompany()
    run(db, VOUCHERS)
    const again = run(db, VOUCHERS)
    expect(again.steps[0]).toMatchObject({ created: 0, skipped: 2 })
    const upd = run(db, VOUCHERS.replace('First sale', 'Changed'), { duplicate: 'update' })
    expect(upd.steps[0]).toMatchObject({ updated: 2 })
    expect((db.prepare("SELECT narration FROM vouchers WHERE number = 'S-1'").get() as { narration: string }).narration).toBe('Changed')
  })

  it('undo bins the created vouchers, deletes unused masters and keeps the ones binned vouchers use', () => {
    const db = seededDb()
    const masters = run(db, 'Name,Group\nNew Party,Sundry Debtors\nUnused Ledger,Indirect Expenses\nIncome X,Indirect Incomes')
    const vouchers = run(db, 'Voucher Type,Date,Number,Ledger,Debit,Credit\nJournal,2025-06-01,J-9,New Party,500,\nJournal,2025-06-01,J-9,Income X,,500', {}, false)
    expect(vouchers.steps[0]).toMatchObject({ created: 1 })
    const u1 = undoImport(db, vouchers.batchId!)
    expect(u1).toMatchObject({ binned: 1, deleted: 0, kept: [] })
    expect((db.prepare("SELECT deleted_at FROM vouchers WHERE number = 'J-9'").get() as { deleted_at: string | null }).deleted_at).not.toBeNull()
    const u2 = undoImport(db, masters.batchId!)
    expect(u2.deleted).toBe(1) // Unused Ledger
    expect(u2.kept.map((k) => k.reason)).toEqual([expect.stringMatching(/in use/), expect.stringMatching(/in use/)])
    expect(ledgerId(db, 'Unused Ledger')).toBeUndefined()
    expect(listBatches(db).map((b) => b.status)).toEqual(['undone', 'partly_undone'])
    expect(() => undoImport(db, vouchers.batchId!)).toThrow(/already undone/)
    expect(count(db, "audit_log WHERE entity = 'import_batch'")).toBe(2)
  })
})

describe('XLSX input and templates', () => {
  it('reads an .xlsx with a title block above the header (header row auto-detected)', () => {
    const db = seededDb()
    const bytes = writeXlsx([{
      name: 'Accounts', preamble: ['My Company', 'Ledger list'],
      columns: [{ header: 'Ledger Name', kind: 'text' }, { header: 'Under', kind: 'text' }, { header: 'Opening Balance', kind: 'money' }],
      rows: [['Xlsx Party', 'Sundry Debtors', 123456], ['Xlsx Capital', 'Capital Account', -123456]]
    }], (b) => new Uint8Array(deflateRawSync(b)))
    const f = parseImportFile('a.xlsx', bytes)
    expect(f.kind).toBe('table')
    const { steps } = autoPlan(db, f, '27')
    const r = runImport(db, steps, {}, { source: 'generic', profileId: 'generic:ledgers', fileName: 'a.xlsx' }, false)
    expect(r.steps[0]).toMatchObject({ created: 2 })
    expect(getLedger(db, ledgerId(db, 'Xlsx Party')!)!.openingBalance).toBe(123456)
  })

  it('remembers a mapping by header name and finds it again by header signature', () => {
    const db = seededDb()
    const headers = ['Acct', 'Parent']
    const t = saveTemplate(db, { name: 'Old system', profileId: 'generic:ledgers', target: 'ledgers', headerSignature: headerSignature(headers), mapping: { name: 'Acct', group: 'Parent' }, options: {} })
    expect(listTemplates(db, { headerSignature: headerSignature(['Parent', 'ACCT']) }).map((x) => x.id)).toEqual([t.id])
    const f = parseImportFile('x.csv', enc.encode('Acct,Parent\nTemplated,Sundry Debtors'))
    const { steps } = tableSteps(f, { sheet: 'x', headerRow: 0, profileId: 'generic:ledgers', mapping: { name: 0, group: 1 }, dateOrder: 'dmy' }, '27')
    expect(runImport(db, steps, {}, { source: 'generic', profileId: 'generic:ledgers', fileName: null }, false).steps[0]!.created).toBe(1)
    saveTemplate(db, { ...t, mapping: { name: 'Acct', group: null }, options: {} })
    expect(listTemplates(db, { profileId: 'generic:ledgers' })).toHaveLength(1)
    deleteTemplate(db, t.id)
    expect(listTemplates(db)).toEqual([])
    expect(db.prepare("SELECT action FROM audit_log WHERE entity = 'import_template' ORDER BY id").all()).toEqual([{ action: 'create' }, { action: 'update' }, { action: 'delete' }])
  })
})
