// The party phone migration (WP 8.4): two nullable columns on ledgers, appended LAST — its number
// is its position (re-placed when main gains migrations first).
import { describe, expect, it } from 'vitest'
import { MIGRATIONS } from './migrations'
import { migrate, schemaVersion } from './migrate'
import { freshPartialDb, TEST_INFO, postSimpleVoucher } from './testdb'
import { seedCompany } from './seed'
import { trialBalance } from '../services/reports'

const M_PHONE = MIGRATIONS.findIndex((sql) => sql.includes('ADD COLUMN phone'))

describe('ledger phone migration', () => {
  it('is the last migration', () => {
    expect(M_PHONE).toBe(MIGRATIONS.length - 1)
    expect(MIGRATIONS[M_PHONE]!.startsWith('-- @foreign-keys-off')).toBe(false)
  })

  it('adds nullable phone / whatsapp and leaves existing ledgers and the books unchanged', () => {
    const db = freshPartialDb(M_PHONE)
    seedCompany(db, TEST_INFO)
    postSimpleVoucher(db, { date: '2025-05-01', amount: 123456, kind: 'receipt' })
    const before = trialBalance(db, '2026-03-31')
    const ledgersBefore = db.prepare('SELECT * FROM ledgers ORDER BY id').all()
    migrate(db)
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
    expect(trialBalance(db, '2026-03-31')).toEqual(before)
    const after = db.prepare('SELECT * FROM ledgers ORDER BY id').all() as Record<string, unknown>[]
    expect(after.map(({ phone, whatsapp, ...rest }) => (expect(phone).toBeNull(), expect(whatsapp).toBeNull(), rest))).toEqual(ledgersBefore)
    const cols = db.prepare('PRAGMA table_info(ledgers)').all() as { name: string; notnull: number; dflt_value: unknown }[]
    for (const name of ['phone', 'whatsapp']) expect(cols.find((c) => c.name === name)).toMatchObject({ notnull: 0, dflt_value: null })
  })
})
