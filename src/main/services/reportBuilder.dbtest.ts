// WP 6.1 / 6.2 — report builder, comparatives, ratios and scheduled packs against real databases.
// The equality proofs: a builder report defined like an existing report returns the same figures
// (trial balance, P&L via pnlLedgerAmounts, sales / purchase registers, cost-centre P&L, stock
// movements); migration 038; ratio values on a hand-computed fixture; the pack scheduler runs a
// missed job exactly once.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { DB } from '../db/connection'
import { openCompanyDb } from '../db/connection'
import { MIGRATIONS } from '../db/migrations'
import { freshPartialDb, seededDb, TEST_INFO } from '../db/testdb'
import { migrate } from '../db/migrate'
import { todayISO, fyOf } from '@shared/dates'
import type { VoucherInputParsed } from '@shared/schemas'
import type { ReportModelInput, ReportResult } from '@shared/reportBuilder/model'
import { createLedger, createStockItem } from './masters'
import { saveVoucher } from './vouchers'
import { saveCostCentre, ccReport } from './costCentres'
import { saveBudget } from './budgets'
import { pnlLedgerAmounts, profitAndLoss, trialBalance } from './reports'
import { registerByMonth } from './analysis'
import { stockSummary } from './stockAnalysis'
import { createDemoCompany } from './demo'
import {
  deleteReport, duplicateReport, getSavedReport, listSavedReports, renameReport, runReport, saveReport, setReportPinned
} from './reportBuilder'
import { budgetAmounts, comparativePnl, ratioReport } from './reportAnalytics'
import { listRuns, runDuePacks, runPack, savePack } from './reportPacks'

const M038 = MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE saved_reports'))

function run(db: DB, model: ReportModelInput, from: string, to: string): ReportResult {
  return runReport(db, model, { working: { from, to }, today: to })
}
const byId = (r: ReportResult, mi = 0): Map<number | string | null, number> => new Map(r.rows.map((row) => [row.keys[0]!.id, row.values[mi]!]))

// ---------------------------------------------------------------- fixtures

function groupId(db: DB, name: string): number {
  return (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
}
function ledger(db: DB, name: string, group: string, openingBalance = 0, extra: Record<string, unknown> = {}): number {
  return createLedger(db, {
    name, groupId: groupId(db, group), openingBalance, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null,
    hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null, ...extra
  } as Parameters<typeof createLedger>[1]).id
}
function voucher(
  db: DB, kind: string, date: string, lines: [number, 'dr' | 'cr', number, { costCentreId: number; amount: number }[]?][],
  extra: Partial<VoucherInputParsed> = {}
): number {
  const vt = (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
  return saveVoucher(db, {
    voucherTypeId: vt, date, number: undefined, partyLedgerId: null, narration: null, reference: null, instrumentNo: null, instrumentDate: null,
    transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
    lines: lines.map(([ledgerId, drCr, amount, cc]) => ({ ledgerId, drCr, amount, costAllocations: cc ?? [] })),
    inventory: [], billRefs: [], tds: null, ...extra
  } as VoucherInputParsed).id
}

// ---------------------------------------------------------------- migration 038

describe('migration 038 — saved reports and report packs', () => {
  it('is appended after every earlier migration (assigned number 038; lands after 032–037)', () => {
    // Array position = migration number − 1. On this branch it follows 031 directly; once the
    // parallel 032–037 merge it must sit after them (numbers are array positions).
    expect(M038).toBeGreaterThanOrEqual(31)
    expect(MIGRATIONS.slice(M038 + 1).some((sql) => sql.includes('saved_reports'))).toBe(false)
  })

  it('creates the three tables with their constraints, from the previous schema', () => {
    const db = freshPartialDb(M038)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'saved_reports'").get()).toBeUndefined()
    migrate(db)
    db.prepare("INSERT INTO saved_reports (name, model_json) VALUES ('Sales', '{}')").run()
    expect(() => db.prepare("INSERT INTO saved_reports (name, model_json) VALUES ('sales', '{}')").run()).toThrow(/UNIQUE/)
    expect(() => db.prepare("INSERT INTO saved_reports (name, model_json, pinned) VALUES ('X', '{}', 2)").run()).toThrow(/CHECK/)
    expect(db.prepare('SELECT pinned, schedule_json FROM saved_reports').get()).toEqual({ pinned: 0, schedule_json: null })
    db.prepare("INSERT INTO report_packs (name, reports_json, period_rule, frequency) VALUES ('Monthly', '[]', 'lastMonth', 'monthly')").run()
    expect(() => db.prepare("INSERT INTO report_packs (name, reports_json, period_rule, frequency) VALUES ('B', '[]', 'nextYear', 'monthly')").run()).toThrow(/CHECK/)
    expect(db.prepare('SELECT formats_json, active, output_dir FROM report_packs').get()).toEqual({ formats_json: '["pdf","csv"]', active: 1, output_dir: null })
    db.prepare("INSERT INTO report_pack_runs (pack_id, trigger, started_at, period_from, period_to, status) VALUES (1, 'manual', 'x', 'a', 'b', 'ok')").run()
    db.prepare('DELETE FROM report_packs').run()
    expect((db.prepare('SELECT COUNT(*) AS n FROM report_pack_runs').get() as { n: number }).n).toBe(0)
  })
})

// ---------------------------------------------------------------- equality proofs on the demo company

describe('builder equals the existing reports (demo company)', () => {
  let dataDir: string
  let db: DB
  const today = todayISO()
  const fy = fyOf(today)

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'total-rb-'))
    process.env.TOTAL_DATA_DIR = dataDir
    const { slug } = createDemoCompany()
    db = openCompanyDb(slug)
  })
  afterAll(() => {
    db.close()
    delete process.env.TOTAL_DATA_DIR
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('closing balance by ledger = the trial balance, ledger by ledger', () => {
    const tb = trialBalance(db, today)
    const r = run(db, { source: 'accounts', dimensions: [{ key: 'ledger' }], measures: ['balance'] }, fy.from, today)
    const built = byId(r)
    const real = tb.rows.filter((row) => row.ledgerId > 0)
    expect(real.length).toBeGreaterThan(5)
    for (const row of real) expect(built.get(row.ledgerId) ?? 0, row.ledgerName).toBe(row.debit - row.credit)
    for (const [id, v] of built) if (v !== 0) expect(real.some((row) => row.ledgerId === id)).toBe(true)
  })

  it('debit / credit by ledger over the FY = the trial balance movement columns', () => {
    const tb = trialBalance(db, today)
    const r = run(db, { source: 'accounts', dimensions: [{ key: 'ledger' }], measures: ['debit', 'credit'] }, fy.from, today)
    const dr = byId(r, 0)
    const cr = byId(r, 1)
    for (const row of tb.rows.filter((x) => x.ledgerId > 0 && x.groupName !== 'Sales Accounts' && x.groupName !== 'Purchase Accounts')) {
      // Asset/liability TB movements are cumulative; demo vouchers all fall inside this FY.
      expect(dr.get(row.ledgerId) ?? 0).toBe(row.movementDebit)
      expect(cr.get(row.ledgerId) ?? 0).toBe(row.movementCredit)
    }
  })

  it('profit by ledger = pnlLedgerAmounts; Σ profit + stock change = P&L net profit', () => {
    const { amounts } = pnlLedgerAmounts(db, fy.from, today)
    const r = run(db, { source: 'accounts', dimensions: [{ key: 'ledger' }], measures: ['profit'] }, fy.from, today)
    const built = byId(r)
    for (const [id, amount] of amounts) expect(built.get(id) ?? 0).toBe(-amount)
    const pnl = profitAndLoss(db, fy.from, today)
    const total = run(db, { source: 'accounts', measures: ['profit'] }, fy.from, today).totals[0]!
    expect(total + pnl.closingStock - pnl.openingStock).toBe(pnl.netProfit)
    // By group level 1 the trading groups add up to the same total.
    const byGroup = run(db, { source: 'accounts', dimensions: [{ key: 'group', level: 1 }], measures: ['profit'] }, fy.from, today)
    expect(byGroup.totals[0]).toBe(total)
  })

  it('taxable / GST / vouchers by month for sales and purchases = the registers', () => {
    for (const kind of ['sales', 'purchase'] as const) {
      const reg = registerByMonth(db, kind, fy.from, today)
      const r = run(db, { source: 'accounts', dimensions: [{ key: 'month' }], measures: ['taxable', 'gst', 'count'], filters: { voucherKinds: [kind] } }, fy.from, today)
      expect(reg.length).toBeGreaterThan(0)
      expect(r.rows.map((row) => [row.keys[0]!.id, ...row.values])).toEqual(reg.map((m) => [m.month, m.taxable, m.tax, m.vouchers]))
      const comps = run(db, { source: 'accounts', measures: ['cgst', 'sgst', 'igst', 'cess', 'gst'], filters: { voucherKinds: [kind] } }, fy.from, today).totals
      expect(comps[0]! + comps[1]! + comps[2]! + comps[3]!).toBe(comps[4])
    }
  })

  it('sales by party by month (the e2e report) sums to the sales register', () => {
    const reg = registerByMonth(db, 'sales', fy.from, today)
    const r = run(db, {
      source: 'accounts', dimensions: [{ key: 'party' }, { key: 'month' }], measures: ['taxable'], filters: { voucherKinds: ['sales'] }, pivot: 'month'
    }, fy.from, today)
    expect(r.totals[0]).toBe(reg.reduce((s, m) => s + m.taxable, 0))
    expect(r.rows.every((row) => typeof row.keys[0]!.id === 'number')).toBe(true)
  })

  it('stock qty in / out by item = the stock summary', () => {
    const summary = stockSummary(db, today)
    const r = run(db, { source: 'inventory', dimensions: [{ key: 'item' }], measures: ['qtyIn', 'qtyOut', 'qtyNet'] }, '2000-01-01', today)
    const rows = new Map(r.rows.map((row) => [row.keys[0]!.id, row.values]))
    for (const s of summary) {
      const v = rows.get(s.stockItemId) ?? [0, 0, 0]
      expect(v[0]).toBe(s.inwardQtyMilli)
      expect(v[1]).toBe(s.outwardQtyMilli)
      expect(v[2]).toBe(s.closingQtyMilli - s.openingQtyMilli)
    }
  })

  it('caps rows and warns', () => {
    const r = runReport(db, { source: 'accounts', dimensions: [{ key: 'voucher' }], measures: ['debit'] }, { working: { from: fy.from, to: today }, today, rowCap: 3 })
    expect(r.truncated).toBe(true)
    expect(r.rows).toHaveLength(3)
    expect(r.warnings.join(' ')).toMatch(/first 3 rows/)
  })
})

// ---------------------------------------------------------------- seeded fixtures

describe('builder on hand-built books', () => {
  it('cost-centre dimension = the cost-centre P&L; the unallocated rest ties the total to the books', () => {
    const db = seededDb()
    const north = saveCostCentre(db, { name: 'North', parentId: null, active: true })
    const south = saveCostCentre(db, { name: 'South', parentId: null, active: true })
    const cash = ledger(db, 'Till', 'Cash-in-Hand')
    const travel = ledger(db, 'Travel', 'Indirect Expenses')
    const fees = ledger(db, 'Fees', 'Direct Incomes')
    voucher(db, 'journal', '2025-05-01', [[travel, 'dr', 10_000, [{ costCentreId: north.id, amount: 6_000 }, { costCentreId: south.id, amount: 3_000 }]], [cash, 'cr', 10_000]])
    voucher(db, 'journal', '2025-06-01', [[cash, 'dr', 50_000], [fees, 'cr', 50_000, [{ costCentreId: south.id, amount: 50_000 }]]])
    voucher(db, 'journal', '2025-06-02', [[travel, 'cr', 2_000, [{ costCentreId: north.id, amount: 2_000 }]], [cash, 'dr', 2_000]])
    const cc = ccReport(db, '2025-04-01', '2026-03-31')
    const r = run(db, { source: 'accounts', dimensions: [{ key: 'costCentre' }], measures: ['profit'] }, '2025-04-01', '2026-03-31')
    const built = byId(r)
    for (const row of cc) expect(built.get(row.costCentreId)).toBe(row.net)
    expect(built.get(null)).toBe(-1_000) // travel's unallocated ₹10
    const { amounts } = pnlLedgerAmounts(db, '2025-04-01', '2026-03-31')
    expect(r.totals[0]).toBe(-[...amounts.values()].reduce((s, v) => s + v, 0))
    // Filtering to one centre keeps only its allocations.
    const north1 = run(db, { source: 'accounts', measures: ['profit'], filters: { costCentreIds: [north.id] } }, '2025-04-01', '2026-03-31')
    expect(north1.totals[0]).toBe(cc.find((c) => c.costCentreId === north.id)!.net)
  })

  it('closing balance across a financial-year boundary follows the year-opening rule, month by month', () => {
    const db = seededDb()
    const cash = ledger(db, 'Till', 'Cash-in-Hand', 100_000)
    const rent = ledger(db, 'Rent', 'Indirect Expenses', 5_000) // stored P&L opening (books' first FY)
    const capital = ledger(db, 'Owner', 'Capital Account', -105_000)
    void capital
    voucher(db, 'payment', '2026-02-10', [[rent, 'dr', 20_000], [cash, 'cr', 20_000]])
    voucher(db, 'payment', '2026-05-10', [[rent, 'dr', 7_000], [cash, 'cr', 7_000]])
    const r = run(db, { source: 'accounts', dimensions: [{ key: 'ledger' }, { key: 'month' }], measures: ['balance'], filters: { ledgerIds: [cash, rent] } }, '2026-01-01', '2026-06-30')
    const series = (id: number): number[] => r.rows.filter((x) => x.keys[0]!.id === id).map((x) => x.values[0]!)
    // Rent: 5,000 stored + 20,000 in Feb; resets on 1 April; 7,000 in May.
    expect(series(rent)).toEqual([5_000, 25_000, 25_000, 0, 7_000, 7_000])
    expect(series(cash)).toEqual([100_000, 80_000, 80_000, 80_000, 73_000, 73_000])
    for (const asOn of ['2026-03-31', '2026-06-30']) {
      const tb = trialBalance(db, asOn)
      const one = run(db, { source: 'accounts', dimensions: [{ key: 'ledger' }], measures: ['balance'] }, '2026-01-01', asOn)
      for (const row of tb.rows.filter((x) => x.ledgerId > 0)) expect(byId(one).get(row.ledgerId) ?? 0).toBe(row.debit - row.credit)
    }
    // Totals of a balance by month = the last month's balances.
    expect(r.totals[0]).toBe(73_000 + 7_000)
  })

  it('soft-deleted, optional and post-dated vouchers are left out', () => {
    const db = seededDb()
    const cash = ledger(db, 'Till', 'Cash-in-Hand')
    const fees = ledger(db, 'Fees', 'Direct Incomes')
    voucher(db, 'receipt', '2025-05-01', [[cash, 'dr', 1_000], [fees, 'cr', 1_000]])
    voucher(db, 'receipt', '2025-05-02', [[cash, 'dr', 2_000], [fees, 'cr', 2_000]], { isOptional: true })
    const binned = voucher(db, 'receipt', '2025-05-03', [[cash, 'dr', 4_000], [fees, 'cr', 4_000]])
    db.prepare("UPDATE vouchers SET deleted_at = datetime('now') WHERE id = ?").run(binned)
    const r = run(db, { source: 'accounts', measures: ['credit', 'count'], filters: { ledgerIds: [fees] } }, '2025-04-01', '2026-03-31')
    expect(r.totals).toEqual([1_000, 1])
  })

  it('previous-year comparative lines months up; budget comparative splits annual lines by month', () => {
    const db = seededDb()
    const cash = ledger(db, 'Till', 'Cash-in-Hand')
    const fees = ledger(db, 'Fees', 'Direct Incomes')
    const rent = ledger(db, 'Rent', 'Indirect Expenses')
    voucher(db, 'receipt', '2025-05-05', [[cash, 'dr', 30_000], [fees, 'cr', 30_000]])
    voucher(db, 'receipt', '2026-05-05', [[cash, 'dr', 45_000], [fees, 'cr', 45_000]])
    voucher(db, 'payment', '2026-05-06', [[rent, 'dr', 9_000], [cash, 'cr', 9_000]])
    const cmp = run(db, { source: 'accounts', dimensions: [{ key: 'month' }], measures: ['profit'], comparative: { kind: 'previousYear' } }, '2026-04-01', '2026-06-30')
    expect(cmp.compare).toMatchObject({ kind: 'previousYear', from: '2025-04-01', to: '2025-06-30' })
    const may = cmp.rows.find((x) => x.keys[0]!.id === '2026-05')!
    expect(may.values[0]).toBe(36_000)
    expect(may.compare![0]).toBe(30_000)

    const budget = saveBudget(db, {
      name: 'FY26', fyStartYear: 2026,
      lines: [
        { ledgerId: fees, groupId: null, month: null, amount: 1_200_000 },
        { ledgerId: rent, groupId: null, month: '2026-05', amount: 10_000 }
      ]
    })
    const b = run(db, { source: 'accounts', dimensions: [{ key: 'ledger' }], measures: ['profit'], comparative: { kind: 'budget', budgetId: budget.id } }, '2026-04-01', '2026-06-30')
    const rows = new Map(b.rows.map((x) => [x.keys[0]!.id, x]))
    expect(rows.get(fees)!.compare![0]).toBe(300_000) // three of twelve months of 12,000.00
    expect(rows.get(rent)!.compare![0]).toBe(-10_000) // expense: negative profit
    expect(budgetAmounts(db, budget.id, '2026-04-01', '2026-06-30')).toMatchObject({ ledgers: { [fees]: 300_000, [rent]: 10_000 } })
    expect(comparativePnl(db, '2026-04-01', '2026-06-30').statements.map((s) => s.netProfit)).toEqual([36_000, 0, 30_000])
  })

  it('ratio values on a fixture match the published formulas', () => {
    const db = seededDb()
    const cash = ledger(db, 'Till', 'Cash-in-Hand', 1_000_000)
    ledger(db, 'Owner', 'Capital Account', -1_000_000)
    const debtor = ledger(db, 'Asha Stores', 'Sundry Debtors')
    const creditor = ledger(db, 'Bharat Mills', 'Sundry Creditors')
    const sales = ledger(db, 'Sales', 'Sales Accounts')
    const purchase = ledger(db, 'Purchases', 'Purchase Accounts')
    const loan = ledger(db, 'Term loan', 'Unsecured Loans')
    voucher(db, 'purchase', '2025-05-03', [[purchase, 'dr', 400_000], [creditor, 'cr', 400_000]], { partyLedgerId: creditor })
    voucher(db, 'sales', '2025-05-10', [[debtor, 'dr', 600_000], [sales, 'cr', 600_000]], { partyLedgerId: debtor })
    voucher(db, 'journal', '2025-05-15', [[cash, 'dr', 200_000], [loan, 'cr', 200_000]])
    voucher(db, 'receipt', '2025-05-20', [[cash, 'dr', 100_000], [debtor, 'cr', 100_000]], { partyLedgerId: debtor })
    const r = ratioReport(db, '2025-05-01', '2025-05-31').period.ratios
    expect(r).toEqual({
      currentRatio: 4.5, quickRatio: 4.5, cashRatio: 3.25,
      grossMarginPct: 33.33, netMarginPct: 33.33, returnOnEquityPct: 18.18, returnOnAssetsPct: 14.29,
      debtEquity: 0.17, equityRatio: 0.67,
      inventoryTurnover: null, receivablesTurnover: 2.4, payablesTurnover: 2, netCapitalTurnover: 0.43, assetTurnover: 0.43,
      debtorDays: 25.83, creditorDays: 31, inventoryDays: 0, cashConversionDays: -5.17
    })
    const months = ratioReport(db, '2025-04-01', '2025-06-30').months
    expect(months.map((m) => m.key)).toEqual(['2025-04', '2025-05', '2025-06'])
    expect(months[1]!.ratios.currentRatio).toBe(4.5)
  })
})

// ---------------------------------------------------------------- saved reports + packs

describe('saved reports and scheduled packs', () => {
  it('saves, renames, pins, duplicates and deletes — each audited', () => {
    const db = seededDb()
    const model: ReportModelInput = { source: 'accounts', dimensions: [{ key: 'party' }], measures: ['taxable'] }
    const a = saveReport(db, { name: 'Sales by party', model }, undefined, 'asha')
    expect(a).toMatchObject({ name: 'Sales by party', owner: 'asha', pinned: false, problem: null })
    expect(() => saveReport(db, { name: 'sales BY party', model }, undefined, null)).toThrow(/already exists/)
    expect(setReportPinned(db, a.id, true).pinned).toBe(true)
    expect(renameReport(db, a.id, 'Party sales').name).toBe('Party sales')
    const copy = duplicateReport(db, a.id, 'ravi')
    expect(copy).toMatchObject({ name: 'Party sales (copy)', pinned: false, owner: 'ravi' })
    expect(duplicateReport(db, a.id, null).name).toBe('Party sales (copy 2)')
    deleteReport(db, copy.id)
    expect(listSavedReports(db).map((r) => r.name)).toEqual(['Party sales', 'Party sales (copy 2)'])
    const audit = db.prepare("SELECT action FROM audit_log WHERE entity = 'saved_report' ORDER BY id").all() as { action: string }[]
    expect(audit.map((x) => x.action)).toEqual(['create', 'update', 'update', 'create', 'create', 'delete'])
    // A stored model that no longer validates loads with its problem instead of failing the list.
    db.prepare("UPDATE saved_reports SET model_json = '{\"source\":\"accounts\",\"measures\":[\"qtyIn\"]}' WHERE id = ?").run(a.id)
    expect(getSavedReport(db, a.id)).toMatchObject({ model: null, problem: 'Qty in is not available for accounts' })
  })

  it('runs a missed monthly pack once on open, writes PDF + CSV, logs and audits the run; refuses to delete a report in a pack', async () => {
    const db = seededDb()
    const cash = ledger(db, 'Till', 'Cash-in-Hand')
    const fees = ledger(db, 'Fees', 'Direct Incomes')
    voucher(db, 'receipt', '2025-05-05', [[cash, 'dr', 30_000], [fees, 'cr', 30_000]])
    const saved = saveReport(db, { name: 'Fees by month', model: { source: 'accounts', dimensions: [{ key: 'month' }], measures: ['credit'], filters: { ledgerIds: [fees] } } }, undefined, null)
    const out = mkdtempSync(join(tmpdir(), 'total-pack-'))
    try {
      const pack = savePack(db, {
        name: 'Month end', reports: [{ kind: 'builtin', key: 'trialBalance' }, { kind: 'builtin', key: 'profitLoss' }, { kind: 'saved', id: saved.id }],
        periodRule: 'lastMonth', frequency: 'monthly', formats: ['pdf', 'csv'], outputDir: out
      })
      expect(() => deleteReport(db, saved.id)).toThrow(/scheduled pack/)
      // Created three months ago, never run: one run, not three.
      db.prepare("UPDATE report_packs SET created_at = '2025-03-02 10:00:00' WHERE id = ?").run(pack.id)
      const rendered: string[] = []
      const renderPdf = async (html: string): Promise<Buffer> => { rendered.push(html); return Buffer.from('%PDF-test') }
      const now = new Date('2025-06-03T09:00:00Z')
      const runs = await runDuePacks(db, 'test-co', TEST_INFO, { now, renderPdf })
      expect(runs).toHaveLength(1)
      expect(runs[0]).toMatchObject({ trigger: 'schedule', status: 'ok', periodFrom: '2025-05-01', periodTo: '2025-05-31' })
      expect(runs[0]!.files).toHaveLength(6)
      for (const f of runs[0]!.files) expect(existsSync(f)).toBe(true)
      const csv = readFileSync(runs[0]!.files.find((f) => f.endsWith('03-fees-by-month.csv'))!, 'utf8')
      expect(csv).toContain('May 2025')
      expect(csv).toContain('300.00')
      expect(rendered[0]).toContain('Trial balance')
      // Same day again: nothing due. Next month: due again.
      expect(await runDuePacks(db, 'test-co', TEST_INFO, { now, renderPdf })).toHaveLength(0)
      expect(await runDuePacks(db, 'test-co', TEST_INFO, { now: new Date('2025-07-01T08:00:00Z'), renderPdf })).toHaveLength(1)
      // Run now always runs, and is logged as manual.
      const manual = await runPack(db, 'test-co', TEST_INFO, pack.id, { trigger: 'manual', now, renderPdf })
      expect(manual.trigger).toBe('manual')
      expect(listRuns(db, pack.id).map((r) => r.trigger)).toEqual(['manual', 'schedule', 'schedule'])
      const audit = db.prepare("SELECT action, user_name AS user FROM audit_log WHERE entity = 'report_pack' ORDER BY id").all() as { action: string; user: string }[]
      expect(audit.map((x) => x.action)).toEqual(['create', 'export', 'export', 'export'])
      expect(audit[1]!.user).toBe('system')
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('a report that fails leaves the run partial with the error logged', async () => {
    const db = seededDb()
    const out = mkdtempSync(join(tmpdir(), 'total-pack-'))
    try {
      const pack = savePack(db, { name: 'P', reports: [{ kind: 'builtin', key: 'trialBalance' }], periodRule: 'fyToDate', frequency: 'daily', formats: ['csv', 'pdf'], outputDir: out })
      const run1 = await runPack(db, 'test-co', TEST_INFO, pack.id, { trigger: 'manual', renderPdf: async () => { throw new Error('printer on fire') } })
      expect(run1.status).toBe('partial')
      expect(run1.error).toMatch(/printer on fire/)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })
})
