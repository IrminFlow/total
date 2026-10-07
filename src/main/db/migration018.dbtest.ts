// Migration 018 (WP 1.3): vouchers.is_year_end_close backfill + group nature repair, run on a
// fixture built at schema version 017.
import { describe, it, expect } from 'vitest'
import { migrate } from './migrate'
import { MIGRATIONS } from './migrations'
import { freshPartialDb, TEST_INFO } from './testdb'
import { seedCompany } from './seed'
import type { DB } from './connection'
import { findOrCreateLedger } from '../services/masters'
import { balanceSheet, exceptions, profitAndLoss, trialBalance } from '../services/reports'
import { closePreview } from '../services/yearEnd'

const V017 = 17

// The fixture is staged at schema 017 with raw SQL, not the services: createLedger/saveVoucher
// track the LATEST schema (e.g. migration 020's ledger/TDS columns) and can't run on a 017 DB.
function ledger(db: DB, name: string, groupName: string, openingBalance = 0): number {
  const group = db.prepare('SELECT id FROM groups WHERE name = ?').get(groupName) as { id: number }
  return Number(
    db.prepare('INSERT INTO ledgers (name, group_id, opening_balance, is_system) VALUES (?, ?, ?, 0)').run(name, group.id, openingBalance)
      .lastInsertRowid
  )
}

let journalSeq = 0
function journal(db: DB, date: string, narration: string | null, lines: [number, 'dr' | 'cr', number][]): number {
  const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }
  const id = Number(
    db.prepare('INSERT INTO vouchers (voucher_type_id, date, number, narration) VALUES (?, ?, ?, ?)')
      .run(vt.id, date, `J-${++journalSeq}`, narration).lastInsertRowid
  )
  const line = db.prepare('INSERT INTO voucher_lines (voucher_id, ledger_id, dr_cr, amount, line_order) VALUES (?, ?, ?, ?, ?)')
  lines.forEach(([ledgerId, drCr, amount], i) => line.run(id, ledgerId, drCr, amount, i))
  return id
}

function audit(db: DB, afterJson: string | null): void {
  db.prepare("INSERT INTO audit_log (entity, entity_id, action, after_json) VALUES ('year_end', 2025, 'create', ?)").run(afterJson)
}

const flag = (db: DB, id: number): number =>
  (db.prepare('SELECT is_year_end_close AS f FROM vouchers WHERE id = ?').get(id) as { f: number }).f

/** Credit (positive) posted to `ledgerId` by voucher `voucherId` — the closing journal's transfer. */
const transferred = (db: DB, voucherId: number, ledgerId: number): number =>
  (db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN dr_cr = 'cr' THEN amount ELSE -amount END), 0) AS t
     FROM voucher_lines WHERE voucher_id = ? AND ledger_id = ?`
  ).get(voucherId, ledgerId) as { t: number }).t

describe('migration 018', () => {
  it('starts from a 017 fixture without the column', () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(18)
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
    // (5) exact marker but balance-sheet lines on two ledgers (not a closing shape: a close has
    //     exactly one transfer ledger).
    const wrongShape = journal(db, '2026-03-31', 'Copied [year-end close FY2025]', [
      [salary, 'dr', 2_000], [cash, 'cr', 1_000], [provision, 'cr', 1_000]
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

    // The trace: one system audit row listing what the migration did.
    const trace = db.prepare("SELECT action, user_name AS userName, after_json AS j FROM audit_log WHERE entity = 'migration' AND entity_id = 18").all() as
      { action: string; userName: string | null; j: string }[]
    expect(trace).toHaveLength(1)
    expect(trace[0]!.userName).toBeNull()
    expect(JSON.parse(trace[0]!.j)).toEqual({
      migration: 18,
      flaggedViaAudit: [auditLinked],
      flaggedViaNarration: [narrationOnly, binned].sort((a, b) => a - b),
      groupsRepaired: [
        { id: fitout, name: 'Shop Fit-out', nature: { from: 'expense', to: 'asset' }, affectsGrossProfit: { from: 0, to: 0 } },
        { id: fixtures, name: 'Shop Fixtures', nature: { from: 'expense', to: 'asset' }, affectsGrossProfit: { from: 1, to: 0 } }
      ]
    })

    // After the migration the closed year reports its real profit, equal to the preview and to
    // what the backfilled closing journal transferred to Retained Earnings.
    expect(profitAndLoss(db, '2024-04-01', '2025-03-31').netProfit).toBe(60_000)
    expect(closePreview(db, 2024)).toMatchObject({ netProfit: 60_000, alreadyClosed: true })
    expect(transferred(db, narrationOnly, retained)).toBe(60_000)
    for (const asOn of ['2025-03-31', '2025-04-01', '2026-03-31', '2026-04-01']) {
      const tb = trialBalance(db, asOn)
      expect(tb.totalDebit).toBe(tb.totalCredit)
      const bs = balanceSheet(db, '2024-04-01', asOn)
      expect(bs.totalAssets).toBe(bs.totalLiabilities)
    }
  })

  it('2a: a close whose expense ledger sat under a mis-natured sub-group is still flagged', () => {
    const db = freshPartialDb(V017)
    seedCompany(db, { ...TEST_INFO, booksFrom: 2024 })
    const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const gid = (n: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(n) as { id: number }).id
    const ins = db.prepare('INSERT INTO groups (name, parent_id, nature, affects_gross_profit, is_system) VALUES (?, ?, ?, ?, 0)')
    // Old updateGroup bug: 'Shop' moved from Indirect Expenses to Current Assets; its sub-group
    // kept 'expense', so postClose (reading g.nature) treated the wage ledger as an expense.
    const shop = Number(ins.run('Shop', gid('Current Assets'), 'asset', 0).lastInsertRowid)
    const wagesGroup = Number(ins.run('Shop Wages', shop, 'expense', 0).lastInsertRowid)
    const wages = Number(
      db.prepare('INSERT INTO ledgers (name, group_id, opening_balance, is_system) VALUES (?, ?, 0, 0)').run('Shop Wage', wagesGroup).lastInsertRowid
    )
    const sales = ledger(db, 'Sales', 'Sales Accounts')
    const retained = findOrCreateLedger(db, 'Retained Earnings', 'Reserves & Surplus')
    journal(db, '2024-06-01', null, [[cash, 'dr', 100_000], [sales, 'cr', 100_000]])
    journal(db, '2024-07-01', null, [[wages, 'dr', 30_000], [cash, 'cr', 30_000]])
    const close = journal(db, '2025-03-31', 'Year-end closing entry [year-end close FY2024]', [
      [sales, 'dr', 100_000], [wages, 'cr', 30_000], [retained, 'cr', 70_000]
    ])

    migrate(db)

    expect(flag(db, close)).toBe(1)
    expect((db.prepare('SELECT nature FROM groups WHERE id = ?').get(wagesGroup) as { nature: string }).nature).toBe('asset')
    expect(closePreview(db, 2024).alreadyClosed).toBe(true)
    // After the repair the journal carries a balance-sheet line besides the transfer: reported,
    // not auto-repaired.
    const section = exceptions(db, '2024-04-01', '2025-03-31').sections.find((s) => s.key === 'yearEndClose')!
    expect(section.rows.map((r) => r.voucherId)).toEqual([close])
  })

  it('2b: a close whose Retained Earnings ledger was renamed is still flagged; profit == preview == transfer', () => {
    const db = freshPartialDb(V017)
    seedCompany(db, { ...TEST_INFO, booksFrom: 2024 })
    const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const sales = ledger(db, 'Sales', 'Sales Accounts')
    const rent = ledger(db, 'Rent', 'Indirect Expenses')
    const transfer = findOrCreateLedger(db, 'Retained Earnings', 'Reserves & Surplus')
    journal(db, '2024-06-01', null, [[cash, 'dr', 90_000], [sales, 'cr', 90_000]])
    journal(db, '2024-07-01', null, [[rent, 'dr', 25_000], [cash, 'cr', 25_000]])
    const close = journal(db, '2025-03-31', 'Year-end closing entry [year-end close FY2024]', [
      [sales, 'dr', 90_000], [rent, 'cr', 25_000], [transfer, 'cr', 65_000]
    ])
    db.prepare("UPDATE ledgers SET name = 'Accumulated Profits' WHERE id = ?").run(transfer)

    migrate(db)

    expect(flag(db, close)).toBe(1)
    expect(profitAndLoss(db, '2024-04-01', '2025-03-31').netProfit).toBe(65_000)
    expect(closePreview(db, 2024)).toMatchObject({ netProfit: 65_000, alreadyClosed: true })
    expect(transferred(db, close, transfer)).toBe(65_000)
    expect(exceptions(db, '2024-04-01', '2025-03-31').sections.find((s) => s.key === 'yearEndClose')!.count).toBe(0)
  })
})
