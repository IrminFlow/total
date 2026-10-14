// WP 7.1 — the off-main-thread checks give the same answers as the checks they stand in for:
// quickCheckOkAsync = quickCheckOk, checkIntegrityAsync = checkIntegrity (sound and unbalanced
// books), runWeeklyIntegrityCheckAsync = runWeeklyIntegrityCheck (stamp + 7-day throttle). The
// dbtests run the sources, so this exercises the in-process path; the worker path runs the same
// runPragmaCheck on its own connection (e2e / smoke cover the built app).
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { migrate } from './migrate'
import { seedCompany } from './seed'
import { TEST_INFO, postSimpleVoucher } from './testdb'
import { quickCheckOk, runWeeklyIntegrityCheck, runWeeklyIntegrityCheckAsync, snapshotTo, INTEGRITY_CHECK_META_KEY } from './backup'
import { checkIntegrity, checkIntegrityAsync } from './integrity'
import { pragmaCheck, quickCheckOkAsync } from './checkHost'

function fileDb(): { db: Database.Database; path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'total-checkhost-'))
  const path = join(dir, 'company.db')
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  migrate(db)
  seedCompany(db, TEST_INFO)
  postSimpleVoucher(db, { date: '2025-05-01', amount: 12_345, kind: 'receipt' })
  return { db, path, dir }
}

describe('off-main-thread SQLite checks (WP 7.1)', () => {
  it('quickCheckOkAsync agrees with quickCheckOk', async () => {
    const { db, dir } = fileDb()
    const snap = join(dir, 'snap.db')
    await snapshotTo(db, snap)
    expect(await quickCheckOkAsync(snap)).toBe(quickCheckOk(snap))
    expect(await quickCheckOkAsync(snap)).toBe(true)
    expect(await quickCheckOkAsync(join(dir, 'missing.db'))).toBe(false)
    const junk = join(dir, 'junk.db')
    writeFileSync(junk, 'not a database')
    expect(await quickCheckOkAsync(junk)).toBe(quickCheckOk(junk))
    expect(await pragmaCheck(snap, 'integrity_check')).toBe('ok')
    db.close()
  })

  it('checkIntegrityAsync equals checkIntegrity, sound books and an unbalanced voucher alike', async () => {
    const { db, path } = fileDb()
    expect(await checkIntegrityAsync(db, path)).toEqual(checkIntegrity(db))
    expect((await checkIntegrityAsync(db, path)).ok).toBe(true)
    const line = db.prepare('SELECT id FROM voucher_lines ORDER BY id LIMIT 1').get() as { id: number }
    db.prepare('UPDATE voucher_lines SET amount = amount + 1 WHERE id = ?').run(line.id)
    const sync = checkIntegrity(db)
    expect(sync.ok).toBe(false)
    expect(await checkIntegrityAsync(db, path)).toEqual(sync)
    db.close()
  })

  it('runWeeklyIntegrityCheckAsync stamps and throttles exactly like the sync check', async () => {
    const { db, path } = fileDb()
    const first = await runWeeklyIntegrityCheckAsync(db, path)
    expect(first).toEqual({ ran: true, ok: true, detail: 'ok' })
    expect(db.prepare('SELECT 1 FROM meta WHERE key = ?').get(INTEGRITY_CHECK_META_KEY)).toBeTruthy()
    expect(await runWeeklyIntegrityCheckAsync(db, path)).toEqual(runWeeklyIntegrityCheck(db))
    expect((await runWeeklyIntegrityCheckAsync(db, path))!.ran).toBe(false)
    const later = new Date(Date.now() + 8 * 86_400_000)
    expect(await runWeeklyIntegrityCheckAsync(db, path, later)).toEqual({ ran: true, ok: true, detail: 'ok' })
    db.close()
    // A company closed before the check ends: nothing is stamped or reported.
    expect(await runWeeklyIntegrityCheckAsync(db, path, new Date(Date.now() + 30 * 86_400_000))).toBeNull()
  })
})
