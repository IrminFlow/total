// WP 7.3 review: `npm run test:db` really runs its scratch company DBs with synchronous=OFF (the
// gate in testPragmas.ts sees VITEST inside the Electron-as-Node worker), and the pragma is set
// per connection — nothing persists into the file.
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'

process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-sync-pragma-'))
const { openCompanyDb } = await import('./connection')
const { companyDbPath } = await import('../paths')

describe('test:db synchronous pragma', () => {
  it('is OFF on a scratch company DB under test:db, and the build default (NORMAL) for a plain connection to the same file', () => {
    const db = openCompanyDb('sync-check')
    const expected = process.env.TOTAL_TEST_DB_SYNCHRONOUS?.toLowerCase() === 'off' ? 0 : 1
    expect(db.pragma('synchronous', { simple: true })).toBe(expected)
    db.close()
    const plain = new Database(companyDbPath('sync-check'))
    // What real books run with: better-sqlite3 is built with SQLITE_DEFAULT_WAL_SYNCHRONOUS=1, so a
    // WAL database is NORMAL (1) — fsync at checkpoints, not every commit. Not stored in the file.
    expect(plain.pragma('synchronous', { simple: true })).toBe(1)
    plain.close()
    rmSync(process.env.TOTAL_DATA_DIR!, { recursive: true, force: true })
  })
})
