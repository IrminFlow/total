// Lane Q, task Q3 #99: backup post-write verification + scheduled weekly full integrity check.
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { migrate } from './migrate'
import { seedCompany } from './seed'
import { TEST_INFO, seededDb } from './testdb'
import { quickCheckOk, runWeeklyIntegrityCheck, snapshotTo, INTEGRITY_CHECK_META_KEY } from './backup'

describe('quickCheckOk (backup post-write verification)', () => {
  it('passes a real snapshot of a live company DB', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'total-hardening-'))
    const db = new Database(join(dir, 'company.db'))
    db.pragma('journal_mode = WAL')
    migrate(db)
    seedCompany(db, TEST_INFO)

    const snap = join(dir, 'snap.db')
    await snapshotTo(db, snap)
    expect(quickCheckOk(snap)).toBe(true)
    db.close()
  })

  it('fails a missing file and a non-SQLite file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'total-hardening-'))
    expect(quickCheckOk(join(dir, 'nope.db'))).toBe(false)

    const junk = join(dir, 'junk.db')
    writeFileSync(junk, 'this is definitely not a sqlite database, not even close, padding padding')
    expect(quickCheckOk(junk)).toBe(false)
  })
})

describe('runWeeklyIntegrityCheck', () => {
  it('runs on first call, stamps meta, and skips within the 7-day window', () => {
    const db = seededDb()

    const first = runWeeklyIntegrityCheck(db)
    expect(first).toMatchObject({ ran: true, ok: true, detail: 'ok' })

    const stamped = db.prepare('SELECT value FROM meta WHERE key = ?').get(INTEGRITY_CHECK_META_KEY) as {
      value: string
    }
    expect(typeof JSON.parse(stamped.value)).toBe('string')

    const second = runWeeklyIntegrityCheck(db)
    expect(second.ran).toBe(false)
  })

  it('runs again once the stamp is older than a week and refreshes it', () => {
    const db = seededDb()
    runWeeklyIntegrityCheck(db)
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(JSON.stringify(eightDaysAgo), INTEGRITY_CHECK_META_KEY)

    const again = runWeeklyIntegrityCheck(db)
    expect(again).toMatchObject({ ran: true, ok: true })

    const stamped = db.prepare('SELECT value FROM meta WHERE key = ?').get(INTEGRITY_CHECK_META_KEY) as {
      value: string
    }
    expect(JSON.parse(stamped.value)).not.toBe(eightDaysAgo)
  })
})
