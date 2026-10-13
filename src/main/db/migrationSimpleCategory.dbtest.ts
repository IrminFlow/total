// The simple_category migration (WP 8.3): one nullable column on ledgers, appended LAST — its
// number is its position (re-placed when main gains migrations first). WP 8.7's opening_bills
// migration follows it.
import { describe, expect, it } from 'vitest'
import { MIGRATIONS } from './migrations'
import { migrate, schemaVersion } from './migrate'
import { freshPartialDb, TEST_INFO, postSimpleVoucher } from './testdb'
import { seedCompany } from './seed'
import { trialBalance } from '../services/reports'

const M_SIMPLE = MIGRATIONS.findIndex((sql) => sql.includes('ADD COLUMN simple_category'))

describe('simple_category migration', () => {
  it('comes after the undo migration (WP 8.7 opening bills follow it)', () => {
    expect(M_SIMPLE).toBeGreaterThan(MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE undo_groups')))
    expect(MIGRATIONS[M_SIMPLE]!.startsWith('-- @foreign-keys-off')).toBe(false)
  })

  it('adds a nullable column and leaves existing ledgers and the books unchanged', () => {
    const db = freshPartialDb(M_SIMPLE)
    seedCompany(db, TEST_INFO)
    postSimpleVoucher(db, { date: '2025-05-01', amount: 123456, kind: 'receipt' })
    const before = trialBalance(db, '2026-03-31')
    const ledgersBefore = db.prepare('SELECT * FROM ledgers ORDER BY id').all()
    migrate(db)
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
    expect(trialBalance(db, '2026-03-31')).toEqual(before)
    const after = db.prepare('SELECT * FROM ledgers ORDER BY id').all() as Record<string, unknown>[]
    expect(after.map(({ simple_category, ...rest }) => (expect(simple_category).toBeNull(), rest))).toEqual(ledgersBefore)
    const col = (db.prepare('PRAGMA table_info(ledgers)').all() as { name: string; notnull: number; dflt_value: unknown }[]).find((c) => c.name === 'simple_category')
    expect(col).toMatchObject({ notnull: 0, dflt_value: null })
  })
})
