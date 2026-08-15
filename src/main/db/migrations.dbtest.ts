import { describe, it, expect } from 'vitest'
import { migrate } from './migrate'
import { MIGRATIONS } from './migrations'
import { freshDb } from './testdb'

const EXPECTED_TABLES = [
  'meta',
  'groups',
  'ledgers',
  'voucher_types',
  'vouchers',
  'voucher_lines',
  'stock_groups',
  'units',
  'stock_items',
  'godowns',
  'inventory_lines',
  'audit_log',
  'currencies',
  'bom_lines',
  'employees',
  'payroll_runs',
  'payroll_lines',
  'users',
  'migrations'
]

describe('migrate', () => {
  it('applies every migration exactly once and records them all', () => {
    const db = freshDb()
    const row = db.prepare('SELECT COUNT(*) AS n FROM migrations').get() as { n: number }
    expect(row.n).toBe(MIGRATIONS.length)
  })

  it('running migrate again is a no-op', () => {
    const db = freshDb()
    migrate(db)
    const row = db.prepare('SELECT COUNT(*) AS n FROM migrations').get() as { n: number }
    expect(row.n).toBe(MIGRATIONS.length)
  })

  it('creates exactly the expected tables', () => {
    const db = freshDb()
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
    const names = rows.map((r) => r.name).sort()
    expect(names).toEqual([...EXPECTED_TABLES].sort())
  })

  it('creates the partial index backing the bin (deleted_at lookups)', () => {
    const db = freshDb()
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_vouchers_deleted'")
      .get() as { name: string } | undefined
    expect(row?.name).toBe('idx_vouchers_deleted')
  })

  it('creates the audit_log indexes and the user_name/app_version columns', () => {
    const db = freshDb()
    const indexNames = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'audit_log'").all() as {
        name: string
      }[]
    ).map((r) => r.name)
    expect(indexNames).toEqual(expect.arrayContaining(['idx_audit_at', 'idx_audit_entity']))

    const columns = (db.prepare('PRAGMA table_info(audit_log)').all() as { name: string }[]).map((c) => c.name)
    expect(columns).toEqual(
      expect.arrayContaining(['id', 'entity', 'entity_id', 'action', 'at', 'before_json', 'after_json', 'user_name', 'app_version'])
    )
  })

  it('creates the users table with the expected columns and role CHECK constraint', () => {
    const db = freshDb()
    const columns = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name)
    expect(columns).toEqual(
      expect.arrayContaining(['id', 'name', 'pin_hash', 'role', 'active', 'created_at'])
    )

    db.prepare("INSERT INTO users (name, pin_hash, role) VALUES ('Owner', 'x', 'owner')").run()
    expect(() =>
      db.prepare("INSERT INTO users (name, pin_hash, role) VALUES ('Bad', 'x', 'superuser')").run()
    ).toThrow()
  })

  it('users.name is unique case-insensitively', () => {
    const db = freshDb()
    db.prepare("INSERT INTO users (name, pin_hash, role) VALUES ('Alice', 'x', 'owner')").run()
    expect(() =>
      db.prepare("INSERT INTO users (name, pin_hash, role) VALUES ('alice', 'x', 'accountant')").run()
    ).toThrow()
  })

  it('creates the covering perf indexes and drops the superseded single-column ledger index', () => {
    const db = freshDb()
    const indexNames = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
    ).map((r) => r.name)
    expect(indexNames).toEqual(
      expect.arrayContaining([
        'idx_lines_ledger_voucher',
        'idx_lines_voucher_drcr_amount',
        'idx_vouchers_type_date',
        'idx_vouchers_party'
      ])
    )
    expect(indexNames).not.toContain('idx_lines_ledger')
  })
})
