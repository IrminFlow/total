// Guided re-close of 0.4.0 closes (to-do §4, the 0.4.0 → 0.5.0 upgrade note).
// A 0.4.0 close (git show v0.4.0:src/main/services/yearEnd.ts) netted each income / expense
// ledger's FY MOVEMENTS only — the books' first FY's stored P&L openings never reached Retained
// Earnings and sit for ever in the trial balance's computed "Profit & Loss A/c (opening)" row.
import { describe, it, expect } from 'vitest'
import { freshDb, seededDb, TEST_INFO } from '../db/testdb'
import { seedCompany } from '../db/seed'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { createLedger } from './masters'
import { getLockDate, getVoucher, restoreVoucher, saveVoucher, setLockDate } from './vouchers'
import { postClose, retainedEarningsLedger } from './yearEnd'
import { repairCloses, repairPreview } from './yearEndRepair'
import { balanceSheet, profitAndLoss, trialBalance } from './reports'
import { simpleHome } from './simpleHome'
import { verifyAudit } from './audit'

const INFO: CompanyInfo = { ...TEST_INFO, booksFrom: 2024 }

function ledger(db: DB, name: string, groupName: string, openingBalance = 0): number {
  const group = db.prepare('SELECT id FROM groups WHERE name = ?').get(groupName) as { id: number }
  return createLedger(db, {
    name, groupId: group.id, openingBalance, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
  }).id
}

function journal(db: DB, date: string, lines: [number, 'dr' | 'cr', number][], narration: string | null = null): number {
  const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal' AND is_system = 1").get() as { id: number }
  return saveVoucher(db, {
    voucherTypeId: vt.id, date, number: undefined, partyLedgerId: null, narration, reference: null,
    instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null,
    currencyCode: null, exchangeRate: null,
    lines: lines.map(([ledgerId, drCr, amount]) => ({ ledgerId, drCr, amount, costAllocations: [] })),
    inventory: [], billRefs: [], tds: null
  }).id
}

const auditCount = (db: DB): number => (db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n
const voucherCount = (db: DB): number => (db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n
const openingRow = (db: DB, asOn: string) => trialBalance(db, asOn).rows.find((r) => r.ledgerName === 'Profit & Loss A/c (opening)')
const net = (row: { debit: number; credit: number } | undefined): number => (row ? row.debit - row.credit : 0)

/**
 * Books from FY 2024-25. Bank stored opening Dr 5,000, Sales stored opening Cr 5,000 (the first
 * FY's stored P&L opening). FY 2024-25: sales 30,000, rent 10,000 → today's profit 35,000 − 10,000
 * = 25,000. FY 2025-26: sales 8,000, rent 3,000 → profit 5,000. FY 2026-27 (running): sales 1,000.
 */
function books(): { db: DB; bank: number; sales: number; rent: number } {
  const db = freshDb()
  seedCompany(db, INFO)
  const bank = ledger(db, 'Bank', 'Bank Accounts', 5_000_00)
  const sales = ledger(db, 'Sales', 'Sales Accounts', -5_000_00)
  const rent = ledger(db, 'Rent', 'Indirect Expenses')
  journal(db, '2024-06-01', [[bank, 'dr', 30_000_00], [sales, 'cr', 30_000_00]])
  journal(db, '2024-07-01', [[rent, 'dr', 10_000_00], [bank, 'cr', 10_000_00]])
  journal(db, '2025-06-01', [[bank, 'dr', 8_000_00], [sales, 'cr', 8_000_00]])
  journal(db, '2025-07-01', [[rent, 'dr', 3_000_00], [bank, 'cr', 3_000_00]])
  journal(db, '2026-05-01', [[bank, 'dr', 1_000_00], [sales, 'cr', 1_000_00]])
  return { db, bank, sales, rent }
}

/** The 0.4.0 close of FY 2024-25: movements only — Dr Sales 30,000 / Cr Rent 10,000 / Cr Retained
 *  Earnings 20,000 — flagged by migration 018's backfill, books locked to 31 Mar 2025. */
function close040(db: DB, sales: number, rent: number): number {
  const re = retainedEarningsLedger(db)
  const id = journal(db, '2025-03-31', [[sales, 'dr', 30_000_00], [rent, 'cr', 10_000_00], [re, 'cr', 20_000_00]], 'Year-end closing entry [year-end close FY2024]')
  db.prepare('UPDATE vouchers SET is_year_end_close = 1 WHERE id = ?').run(id)
  setLockDate(db, '2025-03-31')
  return id
}

describe('guided re-close of a 0.4.0 close', () => {
  it('finds the stored-opening residual, repairs oldest first, and leaves no "(opening)" row', () => {
    const { db, sales, rent } = books()
    const oldId = close040(db, sales, rent)
    postClose(db, INFO, 2025) // a correct close of FY 2025-26 (today's rule)
    expect(getLockDate(db)).toBe('2026-03-31')

    // Before: the TB carries the 5,000 stored opening as a credit "(opening)" row for ever.
    expect(net(openingRow(db, '2026-06-30'))).toBe(-5_000_00)
    const pnlNow = profitAndLoss(db, '2026-04-01', '2027-03-31')
    const homeBefore = simpleHome(db, INFO, { today: '2026-06-30', backups: [] })
    const bsBefore = balanceSheet(db, '2026-04-01', '2026-06-30')

    const p = repairPreview(db)
    expect(p.years.map((y) => [y.fyStartYear, y.needsRepair])).toEqual([[2024, true], [2025, false]])
    const y24 = p.years[0]!
    expect(y24.residual).toBe(-5_000_00) // a profit of 5,000 left in Sales
    expect(y24.netProfit).toBe(25_000_00)
    expect(y24.blocked).toBeNull()
    expect(y24.diffs.map((d) => [d.name, d.stored, d.expected, d.transfer])).toEqual([
      ['Sales', 30_000_00, 35_000_00, false],
      ['Retained Earnings', -20_000_00, -25_000_00, true]
    ])
    expect(y24.corrected.map((l) => [l.name, l.drCr, l.amount])).toEqual([
      ['Rent', 'cr', 10_000_00],
      ['Sales', 'dr', 35_000_00],
      ['Retained Earnings', 'cr', 25_000_00]
    ])

    // A later year alone is refused: oldest first.
    const audit0 = auditCount(db)
    expect(() => repairCloses(db, INFO, { fingerprint: p.fingerprint, fyStartYears: [2025] })).toThrow(/earliest year first: FY 2024-25/)
    // A stale fingerprint is refused.
    expect(() => repairCloses(db, INFO, { fingerprint: '0'.repeat(64) })).toThrow(/changed/)
    expect(auditCount(db)).toBe(audit0)

    const r = repairCloses(db, INFO, { fingerprint: p.fingerprint })
    expect(r.repaired).toHaveLength(1)
    expect(r.repaired[0]).toMatchObject({ fyStartYear: 2024, oldVoucherId: oldId, netProfit: 25_000_00, residual: -5_000_00 })
    // Old journal in the bin; the new one flagged, dated the same day, Retained Earnings 25,000.
    expect(getVoucher(db, oldId)?.deletedAt).not.toBeNull()
    const fresh = getVoucher(db, r.repaired[0]!.voucherId)!
    expect(fresh.date).toBe('2025-03-31')
    expect(fresh.isYearEndClose).toBe(true)
    expect(getLockDate(db)).toBe('2026-03-31') // put back where it was

    // After: no "(opening)" residual anywhere; the TB and balance sheet balance.
    for (const asOn of ['2025-06-30', '2026-03-31', '2026-06-30']) {
      expect(openingRow(db, asOn)).toBeUndefined()
      const tb = trialBalance(db, asOn)
      expect(tb.totalDebit).toBe(tb.totalCredit)
    }
    const bs = balanceSheet(db, '2026-04-01', '2026-06-30')
    expect(bs.totalAssets).toBe(bs.totalLiabilities)
    expect(bs.totalAssets).toBe(bsBefore.totalAssets)
    // Retained Earnings now 25,000 + 5,000 (FY 2025-26).
    const re = trialBalance(db, '2026-06-30').rows.find((x) => x.ledgerName === 'Retained Earnings')!
    expect(re.credit).toBe(30_000_00)

    // The running FY's figures are unchanged; the closed year keeps its real profit.
    expect(profitAndLoss(db, '2026-04-01', '2027-03-31').netProfit).toBe(pnlNow.netProfit)
    expect(profitAndLoss(db, '2024-04-01', '2025-03-31').netProfit).toBe(25_000_00)
    expect(simpleHome(db, INFO, { today: '2026-06-30', backups: [] }).profit).toEqual(homeBefore.profit)

    // Idempotent: nothing left to repair, a second run writes nothing.
    const again = repairPreview(db)
    expect(again.years.every((y) => !y.needsRepair)).toBe(true)
    const audit1 = auditCount(db)
    const vouchers1 = voucherCount(db)
    expect(repairCloses(db, INFO, { fingerprint: again.fingerprint }).repaired).toEqual([])
    expect(auditCount(db)).toBe(audit1)
    expect(voucherCount(db)).toBe(vouchers1)

    // The old journal can't come back while the corrected one is live.
    setLockDate(db, null)
    expect(() => restoreVoucher(db, oldId)).toThrow(/already has a year-end closing entry/)
    expect(verifyAudit(db).ok).toBe(true)
  })

  it('walks several 0.4.0 years oldest first and restores a cleared lock', () => {
    const { db, bank, sales, rent } = books()
    close040(db, sales, rent)
    // FY 2025-26 also closed by a stale journal (one rent entry added after it was posted).
    postClose(db, INFO, 2025)
    setLockDate(db, null)
    journal(db, '2026-02-01', [[rent, 'dr', 1_000_00], [bank, 'cr', 1_000_00]])
    const p = repairPreview(db)
    expect(p.years.map((y) => [y.fyStartYear, y.needsRepair, y.residual])).toEqual([[2024, true, -5_000_00], [2025, true, 1_000_00]])
    expect(() => repairCloses(db, INFO, { fingerprint: p.fingerprint, fyStartYears: [2025] })).toThrow(/earliest/)
    // Only the oldest is fine.
    const one = repairCloses(db, INFO, { fingerprint: p.fingerprint, fyStartYears: [2024] })
    expect(one.repaired.map((r) => r.fyStartYear)).toEqual([2024])
    expect(getLockDate(db)).toBeNull()
    const p2 = repairPreview(db)
    const two = repairCloses(db, INFO, { fingerprint: p2.fingerprint })
    expect(two.repaired.map((r) => [r.fyStartYear, r.netProfit])).toEqual([[2025, 4_000_00]])
    expect(getLockDate(db)).toBeNull()
    expect(openingRow(db, '2026-06-30')).toBeUndefined()
  })

  it('a correct close: preview finds nothing and Repair writes nothing', () => {
    const db = seededDb()
    const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const sales = ledger(db, 'Sales', 'Sales Accounts', -2_000_00)
    ledger(db, 'Capital', 'Capital Account', 2_000_00)
    journal(db, '2025-06-01', [[cash, 'dr', 9_000_00], [sales, 'cr', 9_000_00]])
    postClose(db, TEST_INFO, 2025)
    const p = repairPreview(db)
    expect(p.years).toHaveLength(1)
    expect(p.years[0]).toMatchObject({ needsRepair: false, residual: 0, diffs: [] })
    const before = auditCount(db)
    expect(repairCloses(db, TEST_INFO, { fingerprint: p.fingerprint }).repaired).toEqual([])
    expect(auditCount(db)).toBe(before)
    expect(repairPreview(seededDb()).years).toEqual([])
  })
})

describe('guided re-close: review cases (chained years, misnatured groups)', () => {
  it('two years closed by 0.4.0, repaired in ONE run: each year is re-closed on the books as they stand after the earlier repair', () => {
    // Hand-worked. FY 2024-25: the stored Sales opening Cr 5,000 + sales 30,000 − rent 10,000 →
    // profit 25,000; 0.4.0 carried only 20,000. FY 2025-26: sales 8,000 − rent 3,000, and a rent
    // entry of 1,000 booked after a 0.4.0-style close (the lock was cleared) → profit 4,000; the
    // stale close carried 5,000. FY 2025-26 is not the books' first FY, so its figures do not
    // depend on FY 2024-25's journal — the run must post 25,000 and 4,000, Retained Earnings 29,000.
    const { db, bank, sales, rent } = books()
    close040(db, sales, rent)
    const re = retainedEarningsLedger(db)
    // 0.4.0's FY 2025-26 close (movements only — the same as today's rule for a later year).
    const old25 = journal(db, '2026-03-31', [[sales, 'dr', 8_000_00], [rent, 'cr', 3_000_00], [re, 'cr', 5_000_00]], 'Year-end closing entry [year-end close FY2025]')
    db.prepare('UPDATE vouchers SET is_year_end_close = 1 WHERE id = ?').run(old25)
    setLockDate(db, null)
    journal(db, '2026-02-01', [[rent, 'dr', 1_000_00], [bank, 'cr', 1_000_00]])
    setLockDate(db, '2026-03-31')

    const p = repairPreview(db, INFO.booksFrom)
    expect(p.years.map((y) => [y.fyStartYear, y.needsRepair, y.residual, y.netProfit])).toEqual([
      [2024, true, -5_000_00, 25_000_00],
      [2025, true, 1_000_00, 4_000_00]
    ])
    const r = repairCloses(db, INFO, { fingerprint: p.fingerprint })
    expect(r.repaired.map((x) => [x.fyStartYear, x.netProfit])).toEqual([[2024, 25_000_00], [2025, 4_000_00]])
    expect(getLockDate(db)).toBe('2026-03-31')
    const lines = (id: number): [string, string, number][] =>
      getVoucher(db, id)!.lines.map((l) => [(db.prepare('SELECT name FROM ledgers WHERE id = ?').get(l.ledgerId) as { name: string }).name, l.drCr, l.amount] as [string, string, number])
        .sort((a, b) => a[0].localeCompare(b[0]))
    expect(lines(r.repaired[0]!.voucherId)).toEqual([['Rent', 'cr', 10_000_00], ['Retained Earnings', 'cr', 25_000_00], ['Sales', 'dr', 35_000_00]])
    expect(lines(r.repaired[1]!.voucherId)).toEqual([['Rent', 'cr', 4_000_00], ['Retained Earnings', 'cr', 4_000_00], ['Sales', 'dr', 8_000_00]])
    for (const asOn of ['2025-03-31', '2025-06-30', '2026-03-31', '2026-06-30']) {
      expect(openingRow(db, asOn)).toBeUndefined()
      const tb = trialBalance(db, asOn)
      expect(tb.totalDebit).toBe(tb.totalCredit)
    }
    expect(trialBalance(db, '2026-06-30').rows.find((x) => x.ledgerId === re)!.credit).toBe(29_000_00)
    expect(profitAndLoss(db, '2025-04-01', '2026-03-31').netProfit).toBe(4_000_00)
    expect(profitAndLoss(db, '2026-04-01', '2027-03-31').netProfit).toBe(1_000_00)
    expect(repairPreview(db, INFO.booksFrom).years.every((y) => !y.needsRepair)).toBe(true)
    expect(verifyAudit(db).ok).toBe(true)
  })

  it('a 0.4.0 close on groups migration 018 repaired: the missed income ledger is closed, the zeroed asset restored, the profit goes to the renamed Retained Earnings — never to the asset', () => {
    // Hand-worked. FY 2024-25 on books(): Sales opening Cr 5,000 + sales 30,000, rent 10,000,
    // furniture bought 25,000 (its group was misnatured "expense" under 0.4.0), commission 1,000
    // (its group was misnatured "asset"). 0.4.0's movements-only close: Dr Sales 30,000, Cr Rent
    // 10,000, Cr Furniture 25,000, Dr Retained Earnings 5,000 (a "loss" of 5,000); commission
    // missed. Today: profit = 35,000 + 1,000 − 10,000 = 26,000. Retained Earnings was renamed
    // "Profit Reserve" since; Furniture's line (25,000) is LARGER than the transfer's (5,000).
    const { db, bank, sales, rent } = books()
    const furniture = ledger(db, 'Furniture', 'Fixed Assets')
    const commission = ledger(db, 'Commission', 'Indirect Incomes')
    journal(db, '2024-08-01', [[furniture, 'dr', 25_000_00], [bank, 'cr', 25_000_00]])
    journal(db, '2024-09-01', [[bank, 'dr', 1_000_00], [commission, 'cr', 1_000_00]])
    const re = retainedEarningsLedger(db)
    const old = journal(db, '2025-03-31', [[sales, 'dr', 30_000_00], [rent, 'cr', 10_000_00], [furniture, 'cr', 25_000_00], [re, 'dr', 5_000_00]], 'Year-end closing entry [year-end close FY2024]')
    db.prepare('UPDATE vouchers SET is_year_end_close = 1 WHERE id = ?').run(old)
    db.prepare("UPDATE ledgers SET name = 'Profit Reserve' WHERE id = ?").run(re)
    setLockDate(db, '2025-03-31')
    // Before: Furniture reads 0 (zeroed) and the opening row carries 5,000 + 1,000.
    expect(trialBalance(db, '2025-06-30').rows.find((x) => x.ledgerId === furniture)).toMatchObject({ debit: 0, credit: 0 })
    expect(net(openingRow(db, '2025-06-30'))).toBe(-6_000_00)

    const p = repairPreview(db, INFO.booksFrom)
    const y = p.years[0]!
    expect(y).toMatchObject({ needsRepair: true, blocked: null, residual: -6_000_00, netProfit: 26_000_00 })
    expect(y.corrected.map((l) => [l.name, l.drCr, l.amount])).toEqual([
      ['Commission', 'dr', 1_000_00],
      ['Rent', 'cr', 10_000_00],
      ['Sales', 'dr', 35_000_00],
      ['Profit Reserve', 'cr', 26_000_00]
    ])
    expect(y.diffs.find((d) => d.ledgerId === furniture)).toMatchObject({ stored: -25_000_00, expected: 0, transfer: false })
    repairCloses(db, INFO, { fingerprint: p.fingerprint })
    const tb = trialBalance(db, '2025-06-30')
    expect(openingRow(db, '2025-06-30')).toBeUndefined()
    expect(tb.rows.find((x) => x.ledgerId === furniture)!.debit).toBe(25_000_00)
    expect(tb.rows.find((x) => x.ledgerId === re)!.credit).toBe(26_000_00)
    expect(tb.totalDebit).toBe(tb.totalCredit)
    expect(getLockDate(db)).toBe('2025-03-31')
  })

  it('a close whose transfer ledger can’t be told apart is left alone (blocked, nothing written)', () => {
    // Two equity ledgers on the old journal, neither named Retained Earnings: Drawings (zeroed by
    // a misnatured group) and the renamed transfer ledger. Total must not guess.
    const { db, bank, sales, rent } = books()
    const drawings = ledger(db, 'Drawings', 'Capital Account')
    journal(db, '2024-10-01', [[drawings, 'dr', 3_000_00], [bank, 'cr', 3_000_00]])
    const re = retainedEarningsLedger(db)
    const old = journal(db, '2025-03-31', [[sales, 'dr', 30_000_00], [rent, 'cr', 10_000_00], [drawings, 'cr', 3_000_00], [re, 'cr', 17_000_00]])
    db.prepare('UPDATE vouchers SET is_year_end_close = 1 WHERE id = ?').run(old)
    db.prepare("UPDATE ledgers SET name = 'Profit Reserve' WHERE id = ?").run(re)
    setLockDate(db, '2025-03-31')
    const p = repairPreview(db, INFO.booksFrom)
    expect(p.years[0]).toMatchObject({ needsRepair: true })
    expect(p.years[0]!.blocked).toMatch(/can’t tell which one took the profit/)
    const audit0 = auditCount(db)
    const v0 = voucherCount(db)
    expect(() => repairCloses(db, INFO, { fingerprint: p.fingerprint })).toThrow(/can’t tell/)
    expect(auditCount(db)).toBe(audit0)
    expect(voucherCount(db)).toBe(v0)
    expect(getVoucher(db, old)!.deletedAt).toBeNull()
  })

  it('a voucher booked in the closed year after the preview (lock moved) refuses the repair; the old journal can never be restored next to the new one', () => {
    const { db, bank, sales, rent } = books()
    const oldId = close040(db, sales, rent)
    const p = repairPreview(db, INFO.booksFrom)
    setLockDate(db, null)
    journal(db, '2024-12-01', [[rent, 'dr', 500_00], [bank, 'cr', 500_00]])
    setLockDate(db, '2025-03-31')
    const audit0 = auditCount(db)
    expect(() => repairCloses(db, INFO, { fingerprint: p.fingerprint })).toThrow(/changed since you checked/)
    expect(auditCount(db)).toBe(audit0)
    const r = repairCloses(db, INFO, { fingerprint: repairPreview(db, INFO.booksFrom).fingerprint })
    expect(r.repaired[0]!.netProfit).toBe(24_500_00)
    // Binning the corrected one reopens the year; the old one may then come back (the user's
    // own choice), but never while a close is live.
    setLockDate(db, null)
    expect(() => restoreVoucher(db, oldId)).toThrow(/already has a year-end closing entry/)
  })
})
