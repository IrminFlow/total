// WP 8.3: the accountant path's seed is frozen. `seedCompany` on a migrated database must dump
// exactly what main produced before the setup wizard existed — the snapshot next to this file
// was generated from origin/main's code (seed.ts + migrations.ts at 070556b0) and is never to be
// regenerated to make a change pass. The only column WP 8.3 adds to a seeded row
// (`ledgers.simple_category`, migration "simple_category") is asserted NULL and left out of the
// comparison, so the snapshot stays the pre-8.3 bytes.
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
    const dump = canonicalDump(db)
    dump.ledgers = dump.ledgers!.map((row) => {
      const r = JSON.parse(row) as Record<string, unknown>
      delete r.simple_category
      return JSON.stringify(r)
    })
    expect(dump).toMatchSnapshot()
    expect(db.prepare('SELECT key FROM meta ORDER BY key').all()).toEqual([{ key: 'company' }])
  })
})
