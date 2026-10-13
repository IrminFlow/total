// WP 8.3: the accountant path's seed is frozen. `seedCompany` on a migrated database must dump
// exactly what main produced before the setup wizard existed — the snapshot next to this file
// was generated from origin/main's code (seed.ts + migrations.ts at d32eadb1, before WP 8.3) and is never to be
// regenerated to make a change pass. The only column WP 8.3 adds to a seeded row
// (`ledgers.simple_category`, migration "simple_category") is asserted NULL and left out of the
// comparison, so the snapshot stays the pre-8.3 bytes. WP 8.4's `phone` / `whatsapp` (migration
// "phone") are treated the same way.
import { describe, expect, it } from 'vitest'
import { freshDb, TEST_INFO } from './testdb'
import { seedCompany } from './seed'
import { canonicalDump } from '../services/canonicalDump.testutil'

describe('accountant seed (seedCompany) is unchanged', () => {
  it('dumps byte-identically to main', () => {
    const db = freshDb()
    seedCompany(db, TEST_INFO)
    const hasCategory = (db.prepare('PRAGMA table_info(ledgers)').all() as { name: string }[]).some((c) => c.name === 'simple_category')
    if (hasCategory) expect(db.prepare('SELECT COUNT(*) AS n FROM ledgers WHERE simple_category IS NOT NULL').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM ledgers WHERE phone IS NOT NULL OR whatsapp IS NOT NULL').get()).toEqual({ n: 0 })
    const dump = canonicalDump(db)
    dump.ledgers = dump.ledgers!.map((row) => {
      const r = JSON.parse(row) as Record<string, unknown>
      delete r.simple_category
      delete r.phone
      delete r.whatsapp
      return JSON.stringify(r)
    })
    // Only the rows the seed writes are frozen — a later migration's new (empty) table is not a
    // change to the seed.
    const seeded = Object.fromEntries(Object.entries(dump).filter(([, rows]) => rows.length > 0))
    expect(seeded).toMatchSnapshot()
    expect(db.prepare('SELECT key FROM meta ORDER BY key').all()).toEqual([{ key: 'company' }])
  })
})
