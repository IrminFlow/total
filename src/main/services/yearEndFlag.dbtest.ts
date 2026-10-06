// WP 1.3 / migration 018: year-end closing journals are flagged (vouchers.is_year_end_close).
// Profit reports exclude them (a closed year shows its real profit); TB, statements and balances
// keep them; the balance sheet's P&L A/c nets out what they transferred to Retained Earnings.
import { describe, it, expect } from 'vitest'
import { freshDb, seededDb, TEST_INFO } from '../db/testdb'
import { seedCompany } from '../db/seed'
import type { DB } from '../db/connection'
import { createLedger } from './masters'
import { deleteVoucher, getVoucher, restoreVoucher, saveVoucher, setLockDate } from './vouchers'
import { closePreview, postClose } from './yearEnd'
import { balanceSheet, cashFlow, dayBook, ledgerStatement, profitAndLoss, trialBalance } from './reports'

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
function books(): { db: DB; purchase: number; sales: number; debtor: number; rent: number } {
  const db = seededDb()
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

  it('editing a flagged closing journal keeps the flag', () => {
    const b = books()
    const { voucherId } = postClose(b.db, TEST_INFO, 2025)
    setLockDate(b.db, null) // the close locks its year; editing needs the lock moved first
    const v = getVoucher(b.db, voucherId)!
    saveVoucher(b.db, {
      voucherTypeId: v.voucherTypeId, date: v.date, number: v.number, partyLedgerId: null,
      narration: 'Closing entry (edited)', reference: null, instrumentNo: null, instrumentDate: null,
      transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: v.lines.map((l) => ({ ledgerId: l.ledgerId, drCr: l.drCr, amount: l.amount, costAllocations: [] })),
      inventory: [], billRefs: [], tds: null
    }, voucherId)
    expect(flag(b.db, voucherId)).toBe(1)
    expect(closePreview(b.db, 2025).alreadyClosed).toBe(true)
    expect(profitAndLoss(b.db, '2025-04-01', '2026-03-31').netProfit).toBe(15_000_00)
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
