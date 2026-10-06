// Migration 018 (WP 1.3): vouchers.is_year_end_close backfill + group nature repair, run on a
// fixture built at schema version 017.
import { describe, it, expect } from 'vitest'
import { migrate } from './migrate'
import { MIGRATIONS } from './migrations'
import { freshPartialDb, TEST_INFO } from './testdb'
import { seedCompany } from './seed'
import type { DB } from './connection'
import { createLedger, findOrCreateLedger } from '../services/masters'
import { saveVoucher } from '../services/vouchers'
import { balanceSheet, profitAndLoss, trialBalance } from '../services/reports'

const V017 = 17

function ledger(db: DB, name: string, groupName: string, openingBalance = 0): number {
  const group = db.prepare('SELECT id FROM groups WHERE name = ?').get(groupName) as { id: number }
  return createLedger(db, {
    name, groupId: group.id, openingBalance, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
  }).id
}

function journal(db: DB, date: string, narration: string | null, lines: [number, 'dr' | 'cr', number][]): number {
  const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }
  return saveVoucher(db, {
    voucherTypeId: vt.id, date, number: undefined, partyLedgerId: null, narration, reference: null,
    instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null,
    currencyCode: null, exchangeRate: null,
    lines: lines.map(([ledgerId, drCr, amount]) => ({ ledgerId, drCr, amount, costAllocations: [] })),
    inventory: [], billRefs: [], tds: null
  }).id
}

function audit(db: DB, afterJson: string | null): void {
  db.prepare("INSERT INTO audit_log (entity, entity_id, action, after_json) VALUES ('year_end', 2025, 'create', ?)").run(afterJson)
}

const flag = (db: DB, id: number): number =>
  (db.prepare('SELECT is_year_end_close AS f FROM vouchers WHERE id = ?').get(id) as { f: number }).f

describe('migration 018', () => {
  it('is the last migration and starts from a 017 fixture without the column', () => {
    expect(MIGRATIONS.length).toBe(18)
    const db = freshPartialDb(V017)
    const cols = (db.prepare('PRAGMA table_info(vouchers)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).not.toContain('is_year_end_close')
  })

  it('backfills closing journals conservatively and repairs group natures', () => {
    const db = freshPartialDb(V017)
    seedCompany(db, { ...TEST_INFO, booksFrom: 2024 })
    const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const sales = ledger(db, 'Sales', 'Sales Accounts')
    const rent = ledger(db, 'Rent', 'Indirect Expenses')
    const salary = ledger(db, 'Salary', 'Indirect Expenses')
    const provision = ledger(db, 'Bonus Payable', 'Provisions')
    const retained = findOrCreateLedger(db, 'Retained Earnings', 'Reserves & Surplus')

    journal(db, '2024-06-01', null, [[cash, 'dr', 100_000], [sales, 'cr', 100_000]])
    journal(db, '2024-07-01', null, [[rent, 'dr', 40_000], [cash, 'cr', 40_000]])

    // (1) v0.2.0-style close: exact marker, journal, 31 Mar, P&L + Retained Earnings lines only.
    const narrationOnly = journal(db, '2025-03-31', 'Year-end closing entry [year-end close FY2024]', [
      [sales, 'dr', 100_000], [rent, 'cr', 40_000], [retained, 'cr', 60_000]
    ])

    journal(db, '2025-06-01', null, [[cash, 'dr', 50_000], [sales, 'cr', 50_000]])
    // (2) audit-linked close whose narration the user later edited (no marker left).
    const auditLinked = journal(db, '2026-03-31', 'Closing FY 2025-26 (edited)', [
      [sales, 'dr', 50_000], [retained, 'cr', 50_000]
    ])
    audit(db, JSON.stringify({ voucherId: auditLinked, netProfit: 50_000, lockedUpTo: '2026-03-31' }))
    // Malformed / dangling audit rows are skipped, not fatal.
    audit(db, 'not json')
    audit(db, JSON.stringify({ voucherId: 99_999 }))
    audit(db, JSON.stringify({ voucherId: 'abc' }))
    audit(db, null)

    // (3) a binned close (marker, right shape) — flagged so a later restore is still a close.
    const binned = journal(db, '2026-03-31', 'Year-end closing entry [year-end close FY2025]', [
      [sales, 'dr', 1_000], [retained, 'cr', 1_000]
    ])
    db.prepare("UPDATE vouchers SET deleted_at = datetime('now') WHERE id = ?").run(binned)

    // Must NOT be flagged:
    // (4) an ordinary journal that merely mentions year-end.
    const ordinary = journal(db, '2026-03-31', 'Year-end bonus provision', [
      [salary, 'dr', 7_000], [provision, 'cr', 7_000]
    ])
    // (5) exact marker but a non-Retained-Earnings balance-sheet line (not a closing shape).
    const wrongShape = journal(db, '2026-03-31', 'Copied [year-end close FY2025]', [
      [salary, 'dr', 2_000], [cash, 'cr', 2_000]
    ])
    // (6) exact marker but not dated that FY's 31 March / marker of a different FY.
    const wrongDate = journal(db, '2026-03-30', 'Year-end closing entry [year-end close FY2025]', [
      [sales, 'dr', 3_000], [retained, 'cr', 3_000]
    ])
    const wrongFy = journal(db, '2026-03-31', 'Year-end closing entry [year-end close FY2024]', [
      [sales, 'dr', 4_000], [retained, 'cr', 4_000]
    ])

    // Group nature drift as the old updateGroup left it: 'Shop Costs' moved under Current Assets
    // (its own nature re-derived), its sub-groups still 'expense'.
    const gid = (n: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(n) as { id: number }).id
    const ins = db.prepare('INSERT INTO groups (name, parent_id, nature, affects_gross_profit, is_system) VALUES (?, ?, ?, ?, 0)')
    const shop = Number(ins.run('Shop Costs', gid('Current Assets'), 'asset', 0).lastInsertRowid)
    const fitout = Number(ins.run('Shop Fit-out', shop, 'expense', 0).lastInsertRowid)
    const fixtures = Number(ins.run('Shop Fixtures', fitout, 'expense', 1).lastInsertRowid)
    const okChild = Number(ins.run('Freight', gid('Direct Expenses'), 'expense', 1).lastInsertRowid)
    const systemBefore = db.prepare('SELECT id, nature, affects_gross_profit AS gp FROM groups WHERE is_system = 1 ORDER BY id').all()

    migrate(db)

    expect(flag(db, narrationOnly)).toBe(1)
    expect(flag(db, auditLinked)).toBe(1)
    expect(flag(db, binned)).toBe(1)
    expect(flag(db, ordinary)).toBe(0)
    expect(flag(db, wrongShape)).toBe(0)
    expect(flag(db, wrongDate)).toBe(0)
    expect(flag(db, wrongFy)).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM vouchers WHERE is_year_end_close = 1').get() as { n: number }).n).toBe(3)

    const natureOf = (id: number): unknown => db.prepare('SELECT nature, affects_gross_profit AS gp FROM groups WHERE id = ?').get(id)
    for (const id of [shop, fitout, fixtures]) expect(natureOf(id)).toEqual({ nature: 'asset', gp: 0 })
    expect(natureOf(okChild)).toEqual({ nature: 'expense', gp: 1 })
    expect(db.prepare('SELECT id, nature, affects_gross_profit AS gp FROM groups WHERE is_system = 1 ORDER BY id').all()).toEqual(systemBefore)
    // No group left differing from its parent.
    const drift = db.prepare(
      `SELECT c.name FROM groups c JOIN groups p ON p.id = c.parent_id
        WHERE c.nature <> p.nature OR c.affects_gross_profit <> p.affects_gross_profit`
    ).all()
    expect(drift).toEqual([])

    // After the migration the closed years report their real profit and the books balance.
    expect(profitAndLoss(db, '2024-04-01', '2025-03-31').netProfit).toBe(60_000)
    for (const asOn of ['2025-03-31', '2025-04-01', '2026-03-31', '2026-04-01']) {
      const tb = trialBalance(db, asOn)
      expect(tb.totalDebit).toBe(tb.totalCredit)
      const bs = balanceSheet(db, '2024-04-01', asOn)
      expect(bs.totalAssets).toBe(bs.totalLiabilities)
    }
  })
})
