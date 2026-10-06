// WP 1.3 — year-opening correctness. Books begin FY 2025-26 (TEST_INFO.booksFrom = 2025):
// FY1 = 2025-04-01..2026-03-31, FY2 = 2026-04-01..2027-03-31.
import { describe, it, expect } from 'vitest'
import { seededDb, TEST_INFO } from '../db/testdb'
import { createLedger } from './masters'
import { saveVoucher } from './vouchers'
import { postClose } from './yearEnd'
import { balanceSheet, ledgerStatement, trialBalance } from './reports'
import type { VoucherInputParsed } from '@shared/schemas'

type DB = ReturnType<typeof seededDb>

const X = 1_405_061_300 // ₹1,40,50,613.00 of FY1 purchases (the reported figure)
const Y = 25_000_000 // ₹2,50,000.00 of FY2 purchases

function ledger(db: DB, name: string, groupName: string, openingBalance = 0): number {
  const group = db.prepare('SELECT id FROM groups WHERE name = ?').get(groupName) as { id: number }
  return createLedger(db, {
    name, groupId: group.id, openingBalance, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
  }).id
}

function journal(db: DB, date: string, dr: number, cr: number, amount: number): void {
  const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }
  const lines: VoucherInputParsed['lines'] = [
    { ledgerId: dr, drCr: 'dr', amount, costAllocations: [] },
    { ledgerId: cr, drCr: 'cr', amount, costAllocations: [] }
  ]
  saveVoucher(db, {
    voucherTypeId: vt.id, date, number: undefined, partyLedgerId: null, narration: null, reference: null,
    instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null,
    currencyCode: null, exchangeRate: null, lines, inventory: [], billRefs: [], tds: null
  })
}

interface Books {
  db: DB
  purchase: number
  sales: number
  debtor: number
  cash: number
}

/** FY1: purchases X (two halves), sales 3X to a debtor who pays 2X. FY2: purchases Y split
 *  across Q1 and Q2, sales to the debtor. `storedPurchaseOpening` puts a stored opening balance
 *  on the purchase ledger (balanced by capital) — meaningful only in the books' first FY. */
function books(storedPurchaseOpening = 0): Books {
  const db = seededDb()
  const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
  const purchase = ledger(db, 'Local Purchase', 'Purchase Accounts', storedPurchaseOpening)
  const sales = ledger(db, 'Local Sales', 'Sales Accounts')
  const debtor = ledger(db, 'Acme Debtor', 'Sundry Debtors')
  if (storedPurchaseOpening !== 0) ledger(db, "Owner's Capital", 'Capital Account', -storedPurchaseOpening)

  journal(db, '2025-05-10', purchase, cash, X / 2)
  journal(db, '2026-02-20', purchase, cash, X / 2)
  journal(db, '2025-06-01', debtor, sales, 3 * X)
  journal(db, '2025-09-01', cash, debtor, 2 * X)

  journal(db, '2026-05-15', purchase, cash, Y / 5) // Q1 of FY2
  journal(db, '2026-08-15', purchase, cash, (4 * Y) / 5) // Q2 of FY2
  journal(db, '2026-07-10', debtor, sales, Y)
  return { db, purchase, sales, debtor, cash }
}

/** Statement closing == trial-balance closing for the ledger on `to`, the TB balances, and the
 *  monthly view lands on the same closing. Returns the statement for further assertions. */
function consistent(db: DB, ledgerId: number, from: string, to: string): ReturnType<typeof ledgerStatement> {
  const stmt = ledgerStatement(db, ledgerId, from, to)
  const tb = trialBalance(db, to)
  const row = tb.rows.find((r) => r.ledgerId === ledgerId)
  const tbClosing = row ? row.debit - row.credit : 0
  expect(stmt.closing).toBe(tbClosing)
  expect(tb.totalDebit).toBe(tb.totalCredit)
  const monthly = ledgerStatement(db, ledgerId, from, to, 'month')
  expect(monthly.opening).toBe(stmt.opening)
  expect(monthly.closing).toBe(stmt.closing)
  expect(monthly.months!.at(-1)!.closing).toBe(stmt.closing)
  return stmt
}

function close(db: DB): void {
  postClose(db, TEST_INFO, 2025)
}

for (const closed of [false, true]) {
  describe(`year opening — FY1 year-end close ${closed ? 'run' : 'not run'}`, () => {
    it('expense ledger opens FY2 at zero and closes at FY2 purchases only; FY1 unchanged', () => {
      const b = books()
      if (closed) close(b.db)

      const fy2 = consistent(b.db, b.purchase, '2026-04-01', '2027-03-31')
      expect(fy2.opening).toBe(0)
      expect(fy2.closing).toBe(Y)
      expect(fy2.totalDebit).toBe(Y)

      const fy1 = consistent(b.db, b.purchase, '2025-04-01', '2026-03-31')
      expect(fy1.opening).toBe(0)
      // FY1's own movements; the close (dated 31 Mar 2026) zeroes the ledger inside FY1.
      expect(fy1.closing).toBe(closed ? 0 : X)
      expect(fy1.totalDebit).toBe(X)

      // Income ledger behaves the same way.
      const sales = consistent(b.db, b.sales, '2026-04-01', '2027-03-31')
      expect(sales.opening).toBe(0)
      expect(sales.closing).toBe(-Y)
    })

    it('stored opening counts only in the first FY of the books', () => {
      const S = 500_000
      const b = books(S)
      if (closed) close(b.db)

      const fy1 = consistent(b.db, b.purchase, '2025-04-01', '2026-03-31')
      expect(fy1.opening).toBe(S)
      // The close nets FY1 movements only (closePreview), leaving the stored opening behind.
      expect(fy1.closing).toBe(closed ? S : S + X)

      const fy2 = consistent(b.db, b.purchase, '2026-04-01', '2027-03-31')
      expect(fy2.opening).toBe(0)
      expect(fy2.closing).toBe(Y)
    })

    it('mid-year period opens with FY2 movements from 1 April to the day before only', () => {
      const b = books()
      if (closed) close(b.db)
      const q2 = consistent(b.db, b.purchase, '2026-07-01', '2026-09-30')
      expect(q2.opening).toBe(Y / 5)
      expect(q2.closing).toBe(Y)
      expect(q2.rows).toHaveLength(1)
    })

    it('a period spanning both years restarts the P&L ledger at 1 April', () => {
      const b = books()
      if (closed) close(b.db)
      const both = consistent(b.db, b.purchase, '2025-04-01', '2027-03-31')
      expect(both.opening).toBe(0)
      expect(both.closing).toBe(Y)
      const firstFy2Row = both.rows.find((r) => r.date >= '2026-04-01')!
      expect(firstFy2Row.running).toBe(Y / 5)
      const monthly = ledgerStatement(b.db, b.purchase, '2025-04-01', '2027-03-31', 'month')
      expect(monthly.months!.find((m) => m.month === '2026-04')!.closing).toBe(0) // empty April resets
      expect(monthly.months!.find((m) => m.month === '2026-03')!.closing).toBe(closed ? 0 : X)
    })

    it('a debtor carries its balance across the year boundary', () => {
      const b = books()
      if (closed) close(b.db)
      const fy2 = consistent(b.db, b.debtor, '2026-04-01', '2027-03-31')
      expect(fy2.opening).toBe(X) // 3X billed − 2X received in FY1
      expect(fy2.closing).toBe(X + Y)
      const cash = consistent(b.db, b.cash, '2026-04-01', '2027-03-31')
      expect(cash.opening).toBe(2 * X - X)
    })

    it('trial balance places un-closed prior-year profit in a computed P&L opening row', () => {
      const b = books()
      if (closed) close(b.db)
      const tb = trialBalance(b.db, '2027-03-31')
      expect(tb.totalDebit).toBe(tb.totalCredit)
      const pnlOpening = tb.rows.find((r) => r.ledgerId === -5)
      const retained = tb.rows.find((r) => r.ledgerName === 'Retained Earnings')
      const fy1Profit = 3 * X - X
      if (closed) {
        // The close carried FY1 profit to Retained Earnings; nothing left to compute.
        expect(pnlOpening).toBeUndefined()
        expect(retained).toMatchObject({ credit: fy1Profit, debit: 0 })
      } else {
        expect(pnlOpening).toMatchObject({ ledgerName: 'Profit & Loss A/c (opening)', credit: fy1Profit, debit: 0 })
        expect(retained).toBeUndefined()
      }
      // The balance sheet (cumulative P&L since books began) still balances in both states.
      const bs = balanceSheet(b.db, '2025-04-01', '2027-03-31')
      expect(bs.totalAssets).toBe(bs.totalLiabilities)
    })
  })
}
