// PR #131 follow-up — the restore check of a backup runs in the check worker (db/checkWorker.ts,
// a 'verify' job) instead of on the main thread. Same check, same verdict: for a good backup, a
// damaged one, one that needs migrating and an encrypted one, the worker path and the in-process
// path record identical backup_runs rows (bar the id) and audit rows. A worker that dies is a
// failed check with the reason (never skipped); a restore's stopChecks(live file) leaves a running
// check alone, stopChecksUnder(folder) (delete / passphrase change) ends it and nothing is
// recorded; the scratch folder is always removed.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { migrate } from '../db/migrate'
import { MIGRATIONS } from '../db/migrations'
import { seedCompany } from '../db/seed'
import { TEST_INFO, postSimpleVoucher, testFileDb } from '../db/testdb'
import { rekeyFile } from '../db/encryption'
import { newDataKey } from '../db/keyEnvelope'
import { snapshotTo } from '../db/backup'
import { runningChecks, setCheckWorkerFile, stopAllChecks, stopChecks, stopChecksUnder } from '../db/checkHost'
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

  it('stopChecks on the live company file (backup:restore) does not stop or wait for a backup\'s check', async () => {
    const hang = join(ROOT, 'hang.js')
    writeFileSync(hang, 'setInterval(() => {}, 1000)\n')
    setCheckWorkerFile(hang)
    const { db, path } = liveDb()
    const backup = join(dirname(path), 'backups', `snap-${++n}-auto.db`)
    mkdirSync(dirname(backup), { recursive: true })
    await snapshotTo(db, backup)
    const pending = checkBackupIfDue(db, backup, 'auto', AS_ON, SYSTEM_AUDIT_USER)
    await new Promise((r) => setTimeout(r, 50))
    expect(runningChecks(backup)).toBe(1)
    // The check reads the backup and its own scratch copy, never the live file: a restore's
    // stopChecks(live file) returns at once and leaves it running.
    expect(runningChecks(path)).toBe(0)
    const t0 = Date.now()
    await stopChecks(path)
    expect(Date.now() - t0).toBeLessThan(500)
    expect(runningChecks(backup)).toBe(1)
    // Delete / passphrase change stop it through the folder (company folder, backups folder).
    await stopChecksUnder(dirname(path))
    expect(await pending).toBeNull()
    expect(runningChecks(backup)).toBe(0)
    expect(runRows(db)).toEqual([])
    expect(auditRows(db)).toEqual([])
    db.close()
  }, 60_000)

  it('stopChecksUnder stops only checks inside the folder', async () => {
    const hang = join(ROOT, 'hang2.js')
    writeFileSync(hang, 'setInterval(() => {}, 1000)\n')
    setCheckWorkerFile(hang)
    const a = liveDb()
    const b = liveDb()
    const backupA = join(dirname(a.path), `snap-${++n}-auto.db`)
    const backupB = join(dirname(b.path), `snap-${++n}-auto.db`)
    await snapshotTo(a.db, backupA)
    await snapshotTo(b.db, backupB)
    const pa = checkBackupIfDue(a.db, backupA, 'auto', AS_ON, SYSTEM_AUDIT_USER)
    const pb = verifyBackupFileAsync(backupB, { asOn: AS_ON, key: null, now: NOW })
    await new Promise((r) => setTimeout(r, 50))
    // A folder that is only a prefix of the name (ROOT/co vs ROOT/co-12) is not "inside".
    await stopChecksUnder(join(ROOT, 'co'))
    expect(runningChecks(backupA)).toBe(1)
    await stopChecksUnder(dirname(a.path))
    expect(await pa).toBeNull()
    expect(runningChecks(backupA)).toBe(0)
    expect(runningChecks(backupB)).toBe(1)
    await stopChecksUnder(dirname(b.path))
    await expect(pb).rejects.toThrow()
    expect(runningChecks(backupB)).toBe(0)
    a.db.close()
    b.db.close()
  }, 60_000)

  it('stopAllChecks (a data-folder move) ends running restore checks too, nothing recorded', async () => {
    const hang = join(ROOT, 'hang3.js')
    writeFileSync(hang, 'setInterval(() => {}, 1000)\n')
    setCheckWorkerFile(hang)
    const a = liveDb()
    const b = liveDb()
    const backupA = join(dirname(a.path), 'backups', `snap-${++n}-auto.db`)
    mkdirSync(dirname(backupA), { recursive: true })
    const backupB = join(dirname(b.path), `snap-${++n}-auto.db`)
    await snapshotTo(a.db, backupA)
    await snapshotTo(b.db, backupB)
    const pa = checkBackupIfDue(a.db, backupA, 'auto', AS_ON, SYSTEM_AUDIT_USER)
    const pb = verifyBackupFileAsync(backupB, { asOn: AS_ON, key: null, now: NOW })
    await new Promise((r) => setTimeout(r, 50))
    expect(runningChecks(backupA)).toBe(1)
    expect(runningChecks(backupB)).toBe(1)
    await stopAllChecks()
    expect(await pa).toBeNull()
    await expect(pb).rejects.toThrow()
    expect(runningChecks(backupA)).toBe(0)
    expect(runningChecks(backupB)).toBe(0)
    expect(runRows(a.db)).toEqual([])
    expect(auditRows(a.db)).toEqual([])
    a.db.close()
    b.db.close()
  }, 60_000)
})

// The balance verdict does not depend on the financial year: a business with entries in more than
// one year and no year-end closing journal passes (the trial balance's movement columns are
// cumulative for balance-sheet accounts but FY-only for income / expense ones, so they differ by
// the earlier years' profit); a line tampered out of balance still fails — worker and in-process.
describe('the balance verdict over several financial years', () => {
  function twoYears(): string {
    const dir = join(ROOT, `co-${++n}`)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'company.db')
    const db = testFileDb(path)
    db.pragma('foreign_keys = ON')
    migrate(db)
    seedCompany(db, TEST_INFO) // books from FY 2025-26
    postSimpleVoucher(db, { date: '2025-05-01', amount: 12_345, kind: 'receipt' }) // last year: Cash Dr / Sales Cr
    postSimpleVoucher(db, { date: '2026-05-01', amount: 500, kind: 'receipt' })
    db.close()
    return path
  }
  const AS_ON_NEXT_YEAR = '2026-06-30'

  it('a two-year business with no closing journal passes; the totals cover every year', async () => {
    const path = twoYears()
    setCheckWorkerFile(null)
    const a = verifyBackupFile(path, { asOn: AS_ON_NEXT_YEAR, key: null, now: NOW })
    expect(a.error).toBeNull()
    expect(a.steps.balanced).toEqual({ ok: true, debit: 12_845, credit: 12_845 })
    setCheckWorkerFile(workerFile)
    expect(await verifyBackupFileAsync(path, { asOn: AS_ON_NEXT_YEAR, key: null, now: NOW })).toEqual(a)
  }, 60_000)

  it('a line tampered out of balance fails (an earlier year too)', async () => {
    const path = twoYears()
    const db = testFileDb(path)
    const line = db.prepare("SELECT vl.id FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id WHERE v.date = '2025-05-01' AND vl.dr_cr = 'cr'").get() as { id: number }
    db.prepare('UPDATE voucher_lines SET amount = amount - 1 WHERE id = ?').run(line.id)
    db.close()
    setCheckWorkerFile(null)
    const a = verifyBackupFile(path, { asOn: AS_ON_NEXT_YEAR, key: null, now: NOW })
    expect(a).toMatchObject({ ok: false, error: 'The entries in the backup do not balance' })
    expect(a.steps.balanced).toEqual({ ok: false, debit: 12_845, credit: 12_844 })
    setCheckWorkerFile(workerFile)
    expect(await verifyBackupFileAsync(path, { asOn: AS_ON_NEXT_YEAR, key: null, now: NOW })).toEqual(a)
  }, 60_000)
})
