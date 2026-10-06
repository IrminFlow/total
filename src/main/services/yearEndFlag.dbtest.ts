// WP 1.3 / migration 018: year-end closing journals are flagged (vouchers.is_year_end_close).
// Profit reports exclude them (a closed year shows its real profit); TB, statements and balances
// keep them; the balance sheet's P&L A/c nets out what they transferred to Retained Earnings.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openCompanyDb } from '../db/connection'
import { upsertCompany } from '../registry'
import { consolidated } from './consolidated'
import { exportCaPack } from './caPack'
import { freshDb, seededDb, TEST_INFO } from '../db/testdb'
import { seedCompany } from '../db/seed'
import type { DB } from '../db/connection'
import { createLedger } from './masters'
import { deleteVoucher, getVoucher, listVouchers, restoreVoucher, saveVoucher, setLockDate } from './vouchers'
import { closePreview, postClose } from './yearEnd'
import { balanceSheet, cashFlow, dashboard, dayBook, exceptions, ledgerStatement, profitAndLoss, trialBalance } from './reports'
import { budgetVarianceReport, saveBudget } from './budgets'

function ledger(db: DB, name: string, groupName: string, openingBalance = 0): number {
  const group = db.prepare('SELECT id FROM groups WHERE name = ?').get(groupName) as { id: number }
  return createLedger(db, {
    name, groupId: group.id, openingBalance, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
  }).id
}

function journal(db: DB, date: string, dr: number, cr: number, amount: number): number {
  const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }
  return saveVoucher(db, {
    voucherTypeId: vt.id, date, number: undefined, partyLedgerId: null, narration: null, reference: null,
    instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null,
    currencyCode: null, exchangeRate: null,
    lines: [
      { ledgerId: dr, drCr: 'dr', amount, costAllocations: [] },
      { ledgerId: cr, drCr: 'cr', amount, costAllocations: [] }
    ],
    inventory: [], billRefs: [], tds: null
  }).id
}

const cashOf = (db: DB): number => (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
const flag = (db: DB, id: number): number =>
  (db.prepare('SELECT is_year_end_close AS f FROM vouchers WHERE id = ?').get(id) as { f: number }).f
const retained = (db: DB, asOn: string): number => {
  const row = trialBalance(db, asOn).rows.find((r) => r.ledgerName === 'Retained Earnings')
  return row ? row.credit - row.debit : 0
}

function balanced(db: DB, booksFrom: string, asOn: string): ReturnType<typeof balanceSheet> {
  const tb = trialBalance(db, asOn)
  expect(tb.totalDebit).toBe(tb.totalCredit)
  const bs = balanceSheet(db, booksFrom, asOn)
  expect(bs.totalAssets).toBe(bs.totalLiabilities)
  return bs
}

/** Books from FY 2025-26: FY1 sales 30,000 on credit (debtor pays 20,000), purchases 10,000 cash,
 *  stored Dr opening 5,000 on Purchase; FY2 sales 8,000 cash, rent 3,000 cash. */
function books(db: DB = seededDb()): { db: DB; purchase: number; sales: number; debtor: number; rent: number } {
  const cash = cashOf(db)
  const purchase = ledger(db, 'Purchase', 'Purchase Accounts', 5_000_00)
  ledger(db, 'Capital', 'Capital Account', -5_000_00)
  const sales = ledger(db, 'Sales', 'Sales Accounts')
  const debtor = ledger(db, 'Debtor', 'Sundry Debtors')
  const rent = ledger(db, 'Rent', 'Indirect Expenses')
  journal(db, '2025-05-01', purchase, cash, 10_000_00)
  journal(db, '2025-06-01', debtor, sales, 30_000_00)
  journal(db, '2025-08-01', cash, debtor, 20_000_00)
  journal(db, '2026-05-01', cash, sales, 8_000_00)
  journal(db, '2026-06-01', rent, cash, 3_000_00)
  return { db, purchase, sales, debtor, rent }
}

describe('year-end closing journal flag', () => {
  it('postClose flags its journal; the closed year keeps its real P&L; next year unaffected', () => {
    const b = books()
    const fy2Before = profitAndLoss(b.db, '2026-04-01', '2027-03-31').netProfit
    expect(fy2Before).toBe(5_000_00)
    const { voucherId, netProfit } = postClose(b.db, TEST_INFO, 2025)
    expect(netProfit).toBe(15_000_00)
    expect(flag(b.db, voucherId)).toBe(1)

    const fy1 = profitAndLoss(b.db, '2025-04-01', '2026-03-31')
    expect(fy1.netProfit).toBe(15_000_00)
    expect(fy1.tradingIncomes.find((n) => n.name === 'Sales Accounts')!.amount).toBe(30_000_00)
    expect(profitAndLoss(b.db, '2026-04-01', '2027-03-31').netProfit).toBe(fy2Before)

    // Trial balance and ledger statements keep the closing journal (real postings).
    expect(trialBalance(b.db, '2026-03-31').rows.find((r) => r.ledgerId === b.sales)).toMatchObject({ debit: 0, credit: 0 })
    expect(ledgerStatement(b.db, b.sales, '2025-04-01', '2026-03-31').rows.some((r) => r.voucherId === voucherId)).toBe(true)
    // And the Day Book tags it.
    expect(dayBook(b.db, '2026-03-31', '2026-03-31').find((r) => r.voucherId === voucherId)!.yearEndClose).toBe(true)
  })

  it('balance sheet: closed-year profit sits in Retained Earnings, not in the P&L A/c line', () => {
    const b = books()
    const open = balanced(b.db, '2025-04-01', '2026-03-31')
    expect(open.profitCurrentPeriod).toBe(15_000_00)
    const { voucherId } = postClose(b.db, TEST_INFO, 2025)

    const closedMar = balanced(b.db, '2025-04-01', '2026-03-31')
    expect(closedMar.profitCurrentPeriod).toBe(0)
    expect(closedMar.liabilities.find((n) => n.name === 'Profit & Loss A/c')).toBeUndefined()
    expect(retained(b.db, '2026-03-31')).toBe(15_000_00)
    expect(balanced(b.db, '2025-04-01', '2026-04-01').profitCurrentPeriod).toBe(0)
    expect(balanced(b.db, '2025-04-01', '2027-03-31').profitCurrentPeriod).toBe(5_000_00) // FY2 only

    // Reopen (unlock + bin): the P&L A/c carries both years again; restore re-closes.
    setLockDate(b.db, null)
    deleteVoucher(b.db, voucherId)
    expect(closePreview(b.db, 2025).alreadyClosed).toBe(false)
    expect(balanced(b.db, '2025-04-01', '2026-03-31').profitCurrentPeriod).toBe(15_000_00)
    expect(balanced(b.db, '2025-04-01', '2026-04-01').profitCurrentPeriod).toBe(15_000_00)
    expect(balanced(b.db, '2025-04-01', '2027-03-31').profitCurrentPeriod).toBe(20_000_00)
    restoreVoucher(b.db, voucherId)
    expect(closePreview(b.db, 2025).alreadyClosed).toBe(true)
    expect(flag(b.db, voucherId)).toBe(1)
    expect(balanced(b.db, '2025-04-01', '2027-03-31').profitCurrentPeriod).toBe(5_000_00)
  })

  it('cash flow of a closed year uses the real profit and still reconciles', () => {
    const b = books()
    const before = cashFlow(b.db, '2025-04-01', '2026-03-31')
    postClose(b.db, TEST_INFO, 2025)
    const after = cashFlow(b.db, '2025-04-01', '2026-03-31')
    expect(after.netProfit).toBe(15_000_00)
    expect(after).toEqual(before) // the closing journal changes nothing in the statement
    expect(after.netChange).toBe(after.closingCash - after.openingCash)
    const twoYears = cashFlow(b.db, '2025-04-01', '2027-03-31')
    expect(twoYears.netChange).toBe(twoYears.closingCash - twoYears.openingCash)
  })

  it('a closing journal is immutable: date, type, lines and narration edits are all refused', () => {
    const b = books()
    const { voucherId } = postClose(b.db, TEST_INFO, 2025)
    setLockDate(b.db, null) // even with the lock moved away
    const v = getVoucher(b.db, voucherId)!
    expect(v.isYearEndClose).toBe(true)
    const contra = b.db.prepare("SELECT id FROM voucher_types WHERE kind = 'contra'").get() as { id: number }
    const base = {
      voucherTypeId: v.voucherTypeId, date: v.date, number: v.number, partyLedgerId: null,
      narration: v.narration, reference: null, instrumentNo: null, instrumentDate: null,
      transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: v.lines.map((l) => ({ ledgerId: l.ledgerId, drCr: l.drCr, amount: l.amount, costAllocations: [] })),
      inventory: [], billRefs: [], tds: null
    }
    const cash = cashOf(b.db)
    const edits = [
      { ...base, date: '2026-03-30' },
      { ...base, voucherTypeId: contra.id },
      { ...base, lines: [...base.lines,
        { ledgerId: b.rent, drCr: 'dr' as const, amount: 100_00, costAllocations: [] },
        { ledgerId: cash, drCr: 'cr' as const, amount: 100_00, costAllocations: [] }] },
      { ...base, narration: 'Closing entry (edited)' }
    ]
    for (const edit of edits) {
      expect(() => saveVoucher(b.db, edit, voucherId)).toThrow(/Year-end closing entries can't be edited/)
    }
    const after = getVoucher(b.db, voucherId)!
    expect(after.date).toBe('2026-03-31')
    expect(after.lines).toHaveLength(v.lines.length)
    expect(closePreview(b.db, 2025).alreadyClosed).toBe(true)
    expect(() => postClose(b.db, TEST_INFO, 2025)).toThrow(/already closed/)
    expect(retained(b.db, '2026-03-31')).toBe(15_000_00)
    // No input field can set the flag: a fresh journal saved with extra keys stays unflagged.
    const id = saveVoucher(b.db, { ...base, narration: 'x', isYearEndClose: true } as typeof base).id
    expect(flag(b.db, id)).toBe(0)
  })

  it('bin → reopen → close again transfers once; restoring the first close is then refused', () => {
    const b = books()
    const first = postClose(b.db, TEST_INFO, 2025).voucherId
    setLockDate(b.db, null)
    deleteVoucher(b.db, first)
    expect(closePreview(b.db, 2025).alreadyClosed).toBe(false)
    expect(retained(b.db, '2026-03-31')).toBe(0)
    const second = postClose(b.db, TEST_INFO, 2025).voucherId
    expect(retained(b.db, '2026-03-31')).toBe(15_000_00) // exactly once
    setLockDate(b.db, null)
    expect(() => restoreVoucher(b.db, first)).toThrow(/already has a year-end closing entry/)
    expect(retained(b.db, '2026-03-31')).toBe(15_000_00)
    // Binning the live one makes the old one restorable again.
    deleteVoucher(b.db, second)
    restoreVoucher(b.db, first)
    expect(closePreview(b.db, 2025).alreadyClosed).toBe(true)
    expect(retained(b.db, '2026-03-31')).toBe(15_000_00)
    expect(listVouchers(b.db, '2026-03-31', '2026-03-31').find((r) => r.id === first)!.isYearEndClose).toBe(true)
  })

  it('a live flagged voucher dated anywhere in the FY reads as closed (legacy odd dates)', () => {
    const b = books()
    const { voucherId } = postClose(b.db, TEST_INFO, 2025)
    b.db.prepare("UPDATE vouchers SET date = '2026-03-15' WHERE id = ?").run(voucherId)
    expect(closePreview(b.db, 2025).alreadyClosed).toBe(true)
    expect(closePreview(b.db, 2026).alreadyClosed).toBe(false)
  })

  it('exceptions report legacy closes that break the invariant (extra lines, two live closes)', () => {
    const b = books()
    const { voucherId } = postClose(b.db, TEST_INFO, 2025)
    expect(exceptions(b.db, '2025-04-01', '2026-03-31').sections.find((s) => s.key === 'yearEndClose')!.count).toBe(0)
    // Simulate legacy data: a flagged journal carrying cash, and a second live flagged close.
    const cash = cashOf(b.db)
    b.db.prepare("INSERT INTO voucher_lines (voucher_id, ledger_id, dr_cr, amount, line_order) VALUES (?, ?, 'dr', 100, 9), (?, ?, 'cr', 100, 10)")
      .run(voucherId, b.rent, voucherId, cash)
    const section = exceptions(b.db, '2025-04-01', '2026-03-31').sections.find((s) => s.key === 'yearEndClose')!
    expect(section.rows.map((r) => r.voucherId)).toEqual([voucherId])
    setLockDate(b.db, null)
    const dup = journal(b.db, '2026-01-01', b.rent, cashOf(b.db), 1)
    b.db.prepare('UPDATE vouchers SET is_year_end_close = 1 WHERE id = ?').run(dup)
    const two = exceptions(b.db, '2025-04-01', '2026-03-31').sections.find((s) => s.key === 'yearEndClose')!
    expect(two.rows.map((r) => r.voucherId ?? 0).sort((x, y) => x - y)).toEqual([voucherId, dup].sort((x, y) => x - y))
    expect(two.rows.every((r) => /more than one/.test(r.detail))).toBe(true)
  })

  it('budget variance actuals exclude closing journals', () => {
    const b = books()
    const budget = saveBudget(b.db, {
      name: 'FY1', fyStartYear: 2025,
      lines: [{ ledgerId: b.sales, groupId: null, month: '2026-03', amount: 1_00 }, { ledgerId: b.sales, groupId: null, month: null, amount: 1_00 }]
    })
    const before = budgetVarianceReport(b.db, budget.id, '2026-03')
    postClose(b.db, TEST_INFO, 2025)
    const after = budgetVarianceReport(b.db, budget.id, '2026-03')
    expect(after).toEqual(before)
    expect(after.find((r) => r.month === null)!.actual).toBe(30_000_00)
    expect(after.find((r) => r.month === '2026-03')!.actual).toBe(0)
  })

  it('two consecutive closed years each keep their P&L; TB and BS balance at every boundary', () => {
    const db = freshDb()
    const info = { ...TEST_INFO, booksFrom: 2024 }
    seedCompany(db, info)
    const cash = cashOf(db)
    const sales = ledger(db, 'Sales', 'Sales Accounts')
    const rent = ledger(db, 'Rent', 'Indirect Expenses')
    journal(db, '2024-06-01', cash, sales, 40_000_00)
    journal(db, '2024-07-01', rent, cash, 10_000_00)
    postClose(db, info, 2024) // profit 30,000
    journal(db, '2025-06-01', cash, sales, 12_000_00)
    journal(db, '2025-07-01', rent, cash, 20_000_00)
    postClose(db, info, 2025) // loss 8,000
    journal(db, '2026-06-01', cash, sales, 1_000_00)

    expect(profitAndLoss(db, '2024-04-01', '2025-03-31').netProfit).toBe(30_000_00)
    expect(profitAndLoss(db, '2025-04-01', '2026-03-31').netProfit).toBe(-8_000_00)
    expect(profitAndLoss(db, '2026-04-01', '2027-03-31').netProfit).toBe(1_000_00)
    expect(profitAndLoss(db, '2024-04-01', '2027-03-31').netProfit).toBe(23_000_00)
    expect(retained(db, '2026-04-01')).toBe(22_000_00)
    const from = '2024-04-01'
    for (const asOn of ['2025-03-31', '2025-04-01', '2026-03-31', '2026-04-01', '2027-03-31']) {
      const bs = balanced(db, from, asOn)
      expect(trialBalance(db, asOn).rows.find((r) => r.ledgerId === -5)).toBeUndefined()
      expect(bs.profitCurrentPeriod).toBe(asOn === '2027-03-31' ? 1_000_00 : 0) // FY3 sale is 1 Jun
    }
    const cf = cashFlow(db, '2025-04-01', '2026-03-31')
    expect(cf.netProfit).toBe(-8_000_00)
    expect(cf.netChange).toBe(cf.closingCash - cf.openingCash)
  })
})

describe('profit consumers after a close (dashboard, CA pack, consolidated)', () => {
  let dataDir = ''
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'total-yeflag-'))
    process.env.TOTAL_DATA_DIR = dataDir
  })
  afterEach(() => {
    delete process.env.TOTAL_DATA_DIR
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('all report the closed year’s real profit', () => {
    const slug = 'closed-co'
    const db = openCompanyDb(slug)
    seedCompany(db, TEST_INFO)
    upsertCompany({ slug, name: TEST_INFO.name, stateCode: TEST_INFO.stateCode, gstin: null, lastOpenedAt: null })
    const b = books(db)
    // A sales-kind voucher so the dashboard's FY margin has a sales base: 10,000 more profit.
    const salesType = db.prepare("SELECT id FROM voucher_types WHERE kind = 'sales'").get() as { id: number }
    saveVoucher(db, {
      voucherTypeId: salesType.id, date: '2025-11-01', number: undefined, partyLedgerId: b.debtor, narration: null,
      reference: null, instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
      transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: b.debtor, drCr: 'dr', amount: 10_000_00, costAllocations: [] },
        { ledgerId: b.sales, drCr: 'cr', amount: 10_000_00, costAllocations: [] }
      ],
      inventory: [], billRefs: [], tds: null
    })
    const marginBefore = dashboard(db, '2026-03-31', '2025-04-01').ratios.netMarginPct
    expect(marginBefore).toBe(250) // 25,000 profit on 10,000 of sales-kind vouchers
    postClose(db, TEST_INFO, 2025)

    expect(dashboard(db, '2026-03-31', '2025-04-01').ratios.netMarginPct).toBe(marginBefore)
    const { path: dir } = exportCaPack(db, TEST_INFO, slug, '2025-04-01', '2026-03-31')
    const pnlCsv = readFileSync(join(dir, 'profit-and-loss.csv'), 'utf8')
    expect(pnlCsv).toMatch(/Net Profit"?,"?25000\.00/)
    db.close()

    const result = consolidated([slug], 'pnl', '2025-04-01', '2026-03-31')
    expect(result.warnings).toEqual([])
    expect(result.rows.find((r) => r.name === 'Sales')!.perCompany).toEqual([-40_000_00])
    expect(result.rows.find((r) => r.name === 'Purchase')!.perCompany).toEqual([15_000_00])
  })
})
