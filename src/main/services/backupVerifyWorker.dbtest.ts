// PR #131 follow-up — the restore check of a backup runs in the check worker (db/checkWorker.ts,
// a 'verify' job) instead of on the main thread. Same check, same verdict: for a good backup, a
// damaged one, one that needs migrating and an encrypted one, the worker path and the in-process
// path record identical backup_runs rows (bar the id) and audit rows. A worker that dies is a
// failed check with the reason (never skipped); stopChecks on the live company file ends a running
// check and records nothing; the scratch folder is always removed.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { migrate } from '../db/migrate'
import { MIGRATIONS } from '../db/migrations'
import { seedCompany } from '../db/seed'
import { TEST_INFO, postSimpleVoucher, testFileDb } from '../db/testdb'
import { rekeyFile } from '../db/encryption'
import { newDataKey } from '../db/keyEnvelope'
import { snapshotTo } from '../db/backup'
import { runningChecks, setCheckWorkerFile, stopChecks } from '../db/checkHost'
import { SYSTEM_AUDIT_USER } from './audit'
import { checkBackupIfDue, recordBackupCheck, verifyBackupFile, verifyBackupFileAsync } from './backupVerify'
import type { DB } from '../db/connection'

const ROOT = mkdtempSync(join(tmpdir(), 'total-verify-worker-'))
const AS_ON = '2026-03-31'
const NOW = new Date('2026-03-31T10:00:00.000Z')
let workerFile = ''
let n = 0

beforeAll(async () => {
  const { buildCheckWorker, sqliteDriverPath } = await import('../../../scripts/build-check-worker.mjs')
  workerFile = join(ROOT, 'checkWorker.js')
  await buildCheckWorker(workerFile, { sqlitePath: sqliteDriverPath() })
}, 60_000)
afterEach(() => setCheckWorkerFile(undefined))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

/** A company file (WAL, seeded, one entry) migrated with `migrations`. */
function companyFile(migrations = MIGRATIONS): string {
  const dir = join(ROOT, `co-${++n}`)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'company.db')
  const db = testFileDb(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db, migrations)
  seedCompany(db, TEST_INFO)
  if (migrations === MIGRATIONS) postSimpleVoucher(db, { date: '2025-05-01', amount: 12_345, kind: 'receipt' })
  db.close()
  return path
}

/** A live company to record checks into. */
function liveDb(): { db: DB; path: string } {
  const path = companyFile()
  const db = testFileDb(path)
  db.pragma('foreign_keys = ON')
  return { db, path }
}

const runRows = (db: DB): unknown[] =>
  db.prepare('SELECT file, tag, encrypted, checked_at, ok, checks_json, error FROM backup_runs ORDER BY id').all()
const auditRows = (db: DB): unknown[] =>
  db.prepare("SELECT entity, entity_id, action, before_json, after_json, user_name FROM audit_log WHERE entity = 'backup_check' ORDER BY id").all()

function damaged(): string {
  const bad = companyFile()
  const bytes = readFileSync(bad)
  bytes.fill(0x42, 4096, Math.min(bytes.length, 4096 * 8))
  writeFileSync(bad, bytes)
  return bad
}

describe('the restore check in the check worker', () => {
  it('records exactly what the in-process check records: good, damaged, needs migration, encrypted', async () => {
    const key = newDataKey()
    const enc = companyFile()
    rekeyFile(enc, null, key)
    const cases: Array<{ name: string; path: string; key: Buffer | null; ok: boolean }> = [
      { name: 'good', path: companyFile(), key: null, ok: true },
      { name: 'damaged', path: damaged(), key: null, ok: false },
      { name: 'needs migration', path: companyFile(MIGRATIONS.slice(0, -1)), key: null, ok: true },
      { name: 'encrypted', path: enc, key, ok: true },
      { name: 'encrypted, no key', path: enc, key: null, ok: false }
    ]
    const inProcess = liveDb()
    const viaWorker = liveDb()
    const scratch = join(ROOT, 'scratch')
    mkdirSync(scratch, { recursive: true })
    for (const c of cases) {
      setCheckWorkerFile(null)
      const a = verifyBackupFile(c.path, { asOn: AS_ON, key: c.key, now: NOW })
      setCheckWorkerFile(workerFile)
      const b = await verifyBackupFileAsync(c.path, { asOn: AS_ON, key: c.key, now: NOW, scratchRoot: scratch })
      expect(b, c.name).toEqual(a)
      expect(a.ok, c.name).toBe(c.ok)
      recordBackupCheck(inProcess.db, a, SYSTEM_AUDIT_USER)
      recordBackupCheck(viaWorker.db, b, SYSTEM_AUDIT_USER)
    }
    expect(runRows(viaWorker.db)).toEqual(runRows(inProcess.db))
    expect(auditRows(viaWorker.db)).toEqual(auditRows(inProcess.db))
    expect(runRows(viaWorker.db)).toHaveLength(cases.length)
    // The migrated case really migrated (its copy), and the original was left as it was.
    const migrated = JSON.parse((runRows(viaWorker.db)[2] as { checks_json: string }).checks_json)
    expect(migrated.migrations).toEqual({ found: MIGRATIONS.length - 1, expected: MIGRATIONS.length, ok: true })
    const orig = testFileDb(cases[2]!.path, { readonly: true })
    expect((orig.prepare('SELECT COUNT(*) AS n FROM migrations').get() as { n: number }).n).toBe(MIGRATIONS.length - 1)
    orig.close()
    // Nothing is left in the scratch folder, nothing is still running.
    expect(readdirSync(scratch)).toEqual([])
    for (const c of cases) expect(runningChecks(c.path)).toBe(0)
    inProcess.db.close()
    viaWorker.db.close()
  }, 120_000)

  it('checkBackupIfDue through the worker: recorded on the live file, audited as the given user', async () => {
    setCheckWorkerFile(workerFile)
    const { db, path } = liveDb()
    const backup = join(ROOT, `snap-${++n}-auto.db`)
    await snapshotTo(db, backup)
    const check = await checkBackupIfDue(db, backup, 'auto', AS_ON, SYSTEM_AUDIT_USER)
    expect(check).toMatchObject({ ok: true, steps: { opens: true, quickCheck: true, company: true } })
    expect(runRows(db)).toHaveLength(1)
    expect(auditRows(db)).toEqual([expect.objectContaining({ user_name: SYSTEM_AUDIT_USER })])
    // At most daily for automatic backups — unchanged.
    expect(await checkBackupIfDue(db, backup, 'auto', AS_ON, SYSTEM_AUDIT_USER)).toBeNull()
    expect(runningChecks(path)).toBe(0)
    db.close()
  }, 60_000)

  it('a worker that dies is a failed check with the reason, never skipped', async () => {
    const dead = join(ROOT, 'dead.js')
    writeFileSync(dead, 'process.exit(3)\n')
    setCheckWorkerFile(dead)
    const { db } = liveDb()
    const backup = join(ROOT, `snap-${++n}-auto.db`)
    await snapshotTo(db, backup)
    const check = await checkBackupIfDue(db, backup, 'auto', AS_ON, SYSTEM_AUDIT_USER)
    expect(check).toMatchObject({ ok: false, file: expect.stringContaining('auto.db'), tag: 'auto' })
    expect(check!.error).toMatch(/could not finish.*exited \(3\)/)
    expect(runRows(db)).toEqual([expect.objectContaining({ ok: 0, error: check!.error })])
    // A failed check makes the next one due again (the after-failure rule, unchanged).
    setCheckWorkerFile(workerFile)
    expect(await checkBackupIfDue(db, backup, 'auto', AS_ON, SYSTEM_AUDIT_USER)).toMatchObject({ ok: true })
    db.close()
  }, 60_000)

  it('stopChecks on the live company file ends a running check; nothing is recorded', async () => {
    const hang = join(ROOT, 'hang.js')
    writeFileSync(hang, 'setInterval(() => {}, 1000)\n')
    setCheckWorkerFile(hang)
    const { db, path } = liveDb()
    const backup = join(ROOT, `snap-${++n}-auto.db`)
    await snapshotTo(db, backup)
    const pending = checkBackupIfDue(db, backup, 'auto', AS_ON, SYSTEM_AUDIT_USER)
    await new Promise((r) => setTimeout(r, 50))
    expect(runningChecks(path)).toBe(1)
    expect(runningChecks(backup)).toBe(1)
    await stopChecks(path)
    expect(await pending).toBeNull()
    expect(runningChecks(path)).toBe(0)
    expect(runningChecks(backup)).toBe(0)
    expect(runRows(db)).toEqual([])
    expect(auditRows(db)).toEqual([])
    db.close()
  }, 60_000)
})
