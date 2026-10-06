// WP 1.3 review follow-ups: one definition of profit for a period, books-begin fallback,
// reopening a close, boundary dates, out-of-books vouchers, chart of accounts, group nature
// cascade. Books begin FY 2025-26 (TEST_INFO.booksFrom = 2025).
import { describe, it, expect } from 'vitest'
import { seededDb, TEST_INFO } from '../db/testdb'
import { createGroup, createLedger, updateGroup } from './masters'
import { deleteVoucher, saveVoucher, setLockDate } from './vouchers'
import { closePreview, postClose } from './yearEnd'
import { balanceSheet, cashFlow, chartOfAccounts, ledgerStatement, profitAndLoss, trialBalance } from './reports'
import { booksFromYear } from './booksStart'
import { fyOf, todayISO } from '@shared/dates'

type DB = ReturnType<typeof seededDb>

const X = 1_405_061_300
const Y = 25_000_000
const S = 500_000

function ledger(db: DB, name: string, groupName: string, openingBalance = 0): number {
  const group = db.prepare('SELECT id FROM groups WHERE name = ?').get(groupName) as { id: number }
  return createLedger(db, {
    name, groupId: group.id, openingBalance, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
  }).id
}

function journal(
  db: DB, date: string, dr: number, cr: number, amount: number,
  flags: { isOptional?: boolean; postDated?: boolean } = {}
): number {
  const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }
  return saveVoucher(db, {
    voucherTypeId: vt.id, date, number: undefined, partyLedgerId: null, narration: null,
    reference: null, instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
    transportDistanceKm: null, currencyCode: null, exchangeRate: null, ...flags,
    lines: [
      { ledgerId: dr, drCr: 'dr', amount, costAllocations: [] },
      { ledgerId: cr, drCr: 'cr', amount, costAllocations: [] }
    ],
    inventory: [], billRefs: [], tds: null
  }).id
}

const cashOf = (db: DB): number => (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id

function tbClosing(db: DB, ledgerId: number, asOn: string): number {
  const row = trialBalance(db, asOn).rows.find((r) => r.ledgerId === ledgerId)
  return row ? row.debit - row.credit : 0
}

const retainedCredit = (db: DB, asOn: string): number => {
  const row = trialBalance(db, asOn).rows.find((r) => r.ledgerName === 'Retained Earnings')
  return row ? row.credit - row.debit : 0
}

/** TB and balance sheet as on `asOn` both balance. */
function balanced(db: DB, asOn: string): ReturnType<typeof trialBalance> {
  const tb = trialBalance(db, asOn)
  expect(tb.totalDebit).toBe(tb.totalCredit)
  const bs = balanceSheet(db, '2025-04-01', asOn)
  expect(bs.totalAssets).toBe(bs.totalLiabilities)
  return tb
}

/** Statement invariants (see yearOpening.dbtest.ts) plus TB/BS balancing. */
function statement(db: DB, ledgerId: number, from: string, to: string): ReturnType<typeof ledgerStatement> {
  const stmt = ledgerStatement(db, ledgerId, from, to)
  expect(stmt.closing).toBe(stmt.opening + stmt.totalDebit - stmt.totalCredit)
  expect(ledgerStatement(db, ledgerId, from, to, 'month').months!.at(-1)!.closing).toBe(stmt.closing)
  if (fyOf(from).startYear === fyOf(to).startYear) expect(stmt.closing).toBe(tbClosing(db, ledgerId, to))
  balanced(db, to)
  return stmt
}

/** FY1: purchases X, sales 3X to a debtor who pays 2X. FY2: purchases Y (Q1 Y/5, Q2 4Y/5),
 *  sales Y. Optional stored opening on the purchase ledger, balanced by capital. */
function books(stored = 0): { db: DB; purchase: number; sales: number; debtor: number; cash: number } {
  const db = seededDb()
  const cash = cashOf(db)
  const purchase = ledger(db, 'Local Purchase', 'Purchase Accounts', stored)
  const sales = ledger(db, 'Local Sales', 'Sales Accounts')
  const debtor = ledger(db, 'Acme Debtor', 'Sundry Debtors')
  if (stored !== 0) ledger(db, "Owner's Capital", 'Capital Account', -stored)
  journal(db, '2025-05-10', purchase, cash, X)
  journal(db, '2025-06-01', debtor, sales, 3 * X)
  journal(db, '2025-09-01', cash, debtor, 2 * X)
  journal(db, '2026-05-15', purchase, cash, Y / 5)
  journal(db, '2026-08-15', purchase, cash, (4 * Y) / 5)
  journal(db, '2026-07-10', debtor, sales, Y)
  return { db, purchase, sales, debtor, cash }
}

/** The reviewer's scenario: Purchase stored opening Dr 5,000.00 (balanced by Capital); FY1
 *  purchases 10,000.00 and sales 30,000.00 for cash. */
function reviewerBooks(): { db: DB; purchase: number } {
  const db = seededDb()
  const cash = cashOf(db)
  const purchase = ledger(db, 'Purchase', 'Purchase Accounts', 5_000_00)
  ledger(db, 'Capital', 'Capital Account', -5_000_00)
  const sales = ledger(db, 'Sales', 'Sales Accounts')
  journal(db, '2025-05-01', purchase, cash, 10_000_00)
  journal(db, '2025-06-01', cash, sales, 30_000_00)
  return { db, purchase }
}

describe('one definition of profit for a period (stored P&L openings in the first FY)', () => {
  it('P&L net profit == closePreview == Retained Earnings transfer, before and after the close', () => {
    const b = reviewerBooks()
    const pnl = profitAndLoss(b.db, '2025-04-01', '2026-03-31')
    expect(pnl.netProfit).toBe(15_000_00) // 30,000 − 10,000 − 5,000 stored
    expect(pnl.tradingExpenses.find((n) => n.name === 'Purchase Accounts')!.amount).toBe(15_000_00)
    expect(closePreview(b.db, 2025).netProfit).toBe(pnl.netProfit)
    expect(tbClosing(b.db, b.purchase, '2026-03-31')).toBe(15_000_00)
    // Cash flow uses the same profit and still reconciles (stored opening added back, non-cash).
    const cf = cashFlow(b.db, '2025-04-01', '2026-03-31')
    expect(cf.netProfit).toBe(pnl.netProfit)
    expect(cf.netChange).toBe(cf.closingCash - cf.openingCash)
    balanced(b.db, '2026-03-31')

    const result = postClose(b.db, TEST_INFO, 2025)
    expect(result.netProfit).toBe(pnl.netProfit)
    expect(retainedCredit(b.db, '2026-03-31')).toBe(pnl.netProfit)
    expect(tbClosing(b.db, b.purchase, '2026-03-31')).toBe(0)
    // The 31-Mar closing journal sits inside FY1, so the P&L of the closed year and a re-run of
    // the preview both read 0 (review item 2, not changed — see the WP report). They agree.
    const after = profitAndLoss(b.db, '2025-04-01', '2026-03-31')
    expect(after.netProfit).toBe(0)
    expect(closePreview(b.db, 2025).netProfit).toBe(0)
    const cfAfter = cashFlow(b.db, '2025-04-01', '2026-03-31')
    expect(cfAfter.netChange).toBe(cfAfter.closingCash - cfAfter.openingCash)
    balanced(b.db, '2026-03-31')
    balanced(b.db, '2027-03-31')
  })

  it('a sub-period of the first FY not starting on 1 April leaves stored openings in its opening', () => {
    const b = reviewerBooks()
    expect(profitAndLoss(b.db, '2025-07-01', '2025-09-30').netProfit).toBe(0)
    expect(ledgerStatement(b.db, b.purchase, '2025-07-01', '2025-09-30').opening).toBe(15_000_00)
    expect(profitAndLoss(b.db, '2025-04-01', '2025-06-30').netProfit).toBe(15_000_00)
    const cf = cashFlow(b.db, '2025-07-01', '2025-09-30')
    expect(cf.netChange).toBe(cf.closingCash - cf.openingCash)
  })

  it('the balance sheet (P&L since books began) balances with stored P&L openings, closed or not', () => {
    const open = books(S)
    for (const asOn of ['2025-04-01', '2026-03-31', '2026-04-01', '2027-03-31']) balanced(open.db, asOn)
    const closed = books(S)
    postClose(closed.db, TEST_INFO, 2025)
    for (const asOn of ['2026-03-31', '2026-04-01', '2027-03-31']) balanced(closed.db, asOn)
  })
})

describe('books-begin year unreadable', () => {
  it('falls back to the FY of the earliest in-books voucher', () => {
    const b = books(S)
    b.db.prepare("DELETE FROM meta WHERE key = 'company'").run()
    expect(booksFromYear(b.db)).toBe(2025)
    // The stored opening counts in FY1 only — never in every year.
    expect(ledgerStatement(b.db, b.purchase, '2025-04-01', '2026-03-31').opening).toBe(S)
    expect(ledgerStatement(b.db, b.purchase, '2026-04-01', '2027-03-31').opening).toBe(0)
    expect(closePreview(b.db, 2026).rows.find((r) => r.ledgerId === b.purchase)!.net).toBe(Y)
    expect(closePreview(b.db, 2025).rows.find((r) => r.ledgerId === b.purchase)!.net).toBe(S + X)
    const tb = trialBalance(b.db, '2027-03-31')
    expect(tb.totalDebit).toBe(tb.totalCredit)
  })

  it('with no in-books vouchers treats the current FY as the first', () => {
    const db = seededDb()
    db.prepare("UPDATE meta SET value = 'not json' WHERE key = 'company'").run()
    const cash = cashOf(db)
    expect(booksFromYear(db)).toBe(fyOf(todayISO()).startYear)
    journal(db, '2024-06-01', ledger(db, 'Rent', 'Indirect Expenses'), cash, 100, { isOptional: true })
    expect(booksFromYear(db)).toBe(fyOf(todayISO()).startYear) // optional vouchers are out of the books
    journal(db, '2026-05-01', ledger(db, 'Travel', 'Indirect Expenses'), cash, 100)
    expect(booksFromYear(db)).toBe(2026)
  })
})

describe('closing, reopening and boundary dates', () => {
  it('TB/BS balance on 31 Mar, 1 Apr and the next 31 Mar; the computed row returns when a close is undone', () => {
    const b = books(S)
    const { voucherId } = postClose(b.db, TEST_INFO, 2025)
    const fy1Profit = 3 * X - X - S
    for (const asOn of ['2026-03-31', '2026-04-01', '2027-03-31']) {
      expect(balanced(b.db, asOn).rows.find((r) => r.ledgerId === -5)).toBeUndefined()
    }
    // Exactly 1 April after the close: P&L ledgers are nil, Retained Earnings holds FY1.
    expect(trialBalance(b.db, '2026-04-01').rows.find((r) => r.ledgerId === b.purchase)).toBeUndefined()
    expect(retainedCredit(b.db, '2026-04-01')).toBe(fy1Profit)

    // Reopen: unlock and bin the closing journal.
    setLockDate(b.db, null)
    deleteVoucher(b.db, voucherId)
    expect(closePreview(b.db, 2025).alreadyClosed).toBe(false)
    expect(balanced(b.db, '2026-03-31').rows.find((r) => r.ledgerId === -5)).toBeUndefined()
    expect(tbClosing(b.db, b.purchase, '2026-03-31')).toBe(S + X)
    for (const asOn of ['2026-04-01', '2027-03-31']) {
      const tb = balanced(b.db, asOn)
      expect(tb.rows.find((r) => r.ledgerId === -5)).toMatchObject({ credit: fy1Profit, debit: 0 })
      expect(tb.rows.find((r) => r.ledgerName === 'Retained Earnings')).toBeUndefined()
    }
  })

  it('a loss year puts the computed opening row on the Dr side', () => {
    const db = seededDb()
    const cash = cashOf(db)
    const rent = ledger(db, 'Rent', 'Indirect Expenses')
    const sales = ledger(db, 'Sales', 'Sales Accounts')
    journal(db, '2025-06-01', rent, cash, 80_000_00)
    journal(db, '2025-07-01', cash, sales, 30_000_00)
    expect(balanced(db, '2026-04-30').rows.find((r) => r.ledgerId === -5)).toMatchObject({ debit: 50_000_00, credit: 0 })
    postClose(db, TEST_INFO, 2025)
    expect(balanced(db, '2026-04-30').rows.find((r) => r.ledgerId === -5)).toBeUndefined()
    expect(retainedCredit(db, '2026-04-30')).toBe(-50_000_00)
  })

  it('optional, post-dated and soft-deleted vouchers inside the FY window are excluded', () => {
    const b = books()
    journal(b.db, '2026-06-01', b.purchase, b.cash, 111_00, { isOptional: true })
    journal(b.db, '2026-06-02', b.purchase, b.cash, 222_00, { postDated: true })
    deleteVoucher(b.db, journal(b.db, '2026-06-03', b.purchase, b.cash, 333_00))
    journal(b.db, '2026-04-10', b.purchase, b.cash, 444_00, { isOptional: true }) // in a mid-year opening window
    const fy2 = statement(b.db, b.purchase, '2026-04-01', '2027-03-31')
    expect(fy2.closing).toBe(Y)
    expect(fy2.rows).toHaveLength(2)
    expect(statement(b.db, b.purchase, '2026-07-01', '2026-09-30').opening).toBe(Y / 5)
    expect(profitAndLoss(b.db, '2026-04-01', '2027-03-31').tradingExpenses
      .find((n) => n.name === 'Purchase Accounts')!.amount).toBe(Y)
  })

  it('a two-year statement with a stored opening opens with it and accumulates both years', () => {
    const open = books(S)
    const both = statement(open.db, open.purchase, '2025-04-01', '2027-03-31')
    expect(both.opening).toBe(S)
    expect(both.closing).toBe(S + X + Y)
    const closed = books(S)
    postClose(closed.db, TEST_INFO, 2025)
    const closedBoth = statement(closed.db, closed.purchase, '2025-04-01', '2027-03-31')
    expect(closedBoth.opening).toBe(S)
    expect(closedBoth.totalCredit).toBe(S + X) // the first-FY close credits stored opening + FY1
    expect(closedBoth.closing).toBe(Y)
  })

  it('chart of accounts with a stored opening, before and after the close, equals the TB', () => {
    const b = books(S)
    const leafOf = (asOn: string): number => {
      const walk = (nodes: ReturnType<typeof chartOfAccounts>): number | undefined => {
        for (const n of nodes) {
          const hit = n.ledgers.find((l) => l.id === b.purchase)
          if (hit) return hit.balance
          const deep = walk(n.children)
          if (deep !== undefined) return deep
        }
        return undefined
      }
      return walk(chartOfAccounts(b.db, asOn))!
    }
    expect(leafOf('2026-03-31')).toBe(S + X)
    expect(leafOf('2027-03-31')).toBe(Y)
    postClose(b.db, TEST_INFO, 2025)
    expect(leafOf('2026-03-31')).toBe(0)
    expect(leafOf('2027-03-31')).toBe(Y)
    for (const asOn of ['2026-03-31', '2027-03-31']) expect(leafOf(asOn)).toBe(tbClosing(b.db, b.purchase, asOn))
  })
})

describe('updateGroup cascades nature to descendant groups', () => {
  it('a sub-group moved with its parent from expenses to assets becomes an asset group', () => {
    const db = seededDb()
    const gid = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
    const parent = createGroup(db, { name: 'Shop Costs', parentId: gid('Indirect Expenses') })
    const child = createGroup(db, { name: 'Shop Fit-out', parentId: parent.id })
    const grandchild = createGroup(db, { name: 'Shop Fixtures', parentId: child.id })
    expect(grandchild.nature).toBe('expense')

    updateGroup(db, parent.id, { name: 'Shop Assets', parentId: gid('Current Assets') })
    const natureOf = (id: number): { nature: string; gp: number } =>
      db.prepare('SELECT nature, affects_gross_profit AS gp FROM groups WHERE id = ?').get(id) as { nature: string; gp: number }
    for (const id of [parent.id, child.id, grandchild.id]) expect(natureOf(id)).toEqual({ nature: 'asset', gp: 0 })
    expect((db.prepare('SELECT name FROM groups WHERE id = ?').get(parent.id) as { name: string }).name).toBe('Shop Assets')
    expect(natureOf(gid('Indirect Expenses')).nature).toBe('expense') // untouched

    // A ledger in the moved subtree now carries its balance across years like any asset.
    const fixture = ledger(db, 'Counter', 'Shop Fixtures')
    journal(db, '2025-06-01', fixture, cashOf(db), 12_000_00)
    expect(ledgerStatement(db, fixture, '2026-04-01', '2027-03-31').opening).toBe(12_000_00)
    balanced(db, '2027-03-31')
  })
})
