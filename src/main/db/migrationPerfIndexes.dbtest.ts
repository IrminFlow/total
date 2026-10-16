// WP 7.1 — the performance-index migration: right before WP 7.2's (number by position), CREATE INDEX IF NOT
// EXISTS only (no table rebuild, no data written), and the books read the same before and after.
import { describe, expect, it } from 'vitest'
import { MIGRATIONS } from './migrations'
import { migrate, schemaVersion } from './migrate'
import { freshPartialDb, TEST_INFO, postSimpleVoucher } from './testdb'
import { seedCompany } from './seed'
import { trialBalance, profitAndLoss } from '../services/reports'

const M = MIGRATIONS.findIndex((sql) => sql.includes('idx_lines_voucher_cover'))
const INDEXES = [
  'idx_lines_voucher_cover', 'idx_lines_ledger_cover', 'idx_vouchers_books_date', 'idx_vouchers_type_number', 'idx_inv_voucher_cover', 'idx_bill_refs_party_cover'
]

describe('WP 7.1 performance indexes migration', () => {
  it('comes right before WP 7.2 security (backup_runs) and only creates indexes', () => {
    expect(M).toBe(MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE backup_runs')) - 1)
    const statements = MIGRATIONS[M]!.split(';').map((s) => s.replace(/--.*$/gm, '').trim()).filter(Boolean)
    expect(statements.length).toBe(INDEXES.length)
    for (const s of statements) expect(s).toMatch(/^CREATE INDEX IF NOT EXISTS idx_\w+ ON \w+\([^)]*\)$/)
    expect(MIGRATIONS[M]!.startsWith('-- @foreign-keys-off')).toBe(false)
  })

  it('adds the indexes and leaves every row and figure unchanged', () => {
    const db = freshPartialDb(M)
    seedCompany(db, TEST_INFO)
    postSimpleVoucher(db, { date: '2025-05-01', amount: 123456, kind: 'receipt' })
    postSimpleVoucher(db, { date: '2025-06-01', amount: 99_00, kind: 'sales' })
    const dump = (): unknown => ['vouchers', 'voucher_lines', 'ledgers', 'audit_log'].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())
    const before = { rows: dump(), tb: trialBalance(db, '2026-03-31'), pnl: profitAndLoss(db, '2025-04-01', '2026-03-31') }
    migrate(db)
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
    expect({ rows: dump(), tb: trialBalance(db, '2026-03-31'), pnl: profitAndLoss(db, '2025-04-01', '2026-03-31') }).toEqual(before)
    const names = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((r) => r.name))
    for (const n of INDEXES) expect(names.has(n), n).toBe(true)
    // Re-running the statements is a no-op (IF NOT EXISTS).
    expect(() => db.exec(MIGRATIONS[M]!)).not.toThrow()
  })
})
