// WP 7.1 — the off-main-thread checks give the same answers as the checks they stand in for:
// quickCheckOkAsync = quickCheckOk, checkIntegrityAsync = checkIntegrity (sound and unbalanced
// books), runWeeklyIntegrityCheckAsync = runWeeklyIntegrityCheck (stamp + 7-day throttle). The
// dbtests run the sources, so this exercises the in-process path; the worker path runs the same
// runPragmaCheck on its own connection (e2e / smoke cover the built app).
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { migrate } from './migrate'
import { seedCompany } from './seed'
import { TEST_INFO, postSimpleVoucher } from './testdb'
import { quickCheckOk, runWeeklyIntegrityCheck, runWeeklyIntegrityCheckAsync, snapshotTo, INTEGRITY_CHECK_META_KEY } from './backup'
import { checkIntegrity, checkIntegrityAsync, QUICK_CHECK_TIMED_OUT } from './integrity'
import { CheckTimeoutError, pragmaCheck, quickCheckOkAsync, runningChecks, setCheckWorkerFile, stopChecks } from './checkHost'

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

// WP 7.1 review: the worker path itself — the built checkWorker (bundled here with esbuild, as
// electron-vite bundles it), a worker that dies without answering, and stopChecks.
describe('the check worker thread', () => {
  let bundleDir = ''
  const bundle = async (): Promise<string> => {
    const { build } = await import('esbuild')
    bundleDir = mkdtempSync(join(tmpdir(), 'total-checkworker-'))
    const out = join(bundleDir, 'checkWorker.js')
    const sqlite = createRequire(import.meta.url).resolve('better-sqlite3-multiple-ciphers')
    await build({
      entryPoints: [join(__dirname, 'checkWorker.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent',
      plugins: [{ name: 'sqlite', setup: (b) => b.onResolve({ filter: /^better-sqlite3-multiple-ciphers$/ }, () => ({ path: sqlite, external: true })) }]
    })
    return out
  }
  afterEach(() => setCheckWorkerFile(undefined))
  afterAll(() => {
    if (bundleDir) rmSync(bundleDir, { recursive: true, force: true })
  })

  it('answers like the in-process check, on a file the main connection keeps writing', async () => {
    setCheckWorkerFile(await bundle())
    const { db, path, dir } = fileDb()
    const snap = join(dir, 'snap.db')
    await snapshotTo(db, snap)
    const busy = setInterval(() => postSimpleVoucher(db, { date: '2025-05-02', amount: 100, kind: 'receipt' }), 1)
    try {
      expect(await quickCheckOkAsync(snap)).toBe(true)
      expect(await pragmaCheck(path, 'quick_check')).toBe('ok')
      expect(await pragmaCheck(path, 'integrity_check')).toBe('ok')
    } finally {
      clearInterval(busy)
    }
    expect(await checkIntegrityAsync(db, path)).toEqual(checkIntegrity(db))
    expect(await quickCheckOkAsync(join(dir, 'missing.db'))).toBe(false)
    expect(runningChecks(path)).toBe(0)
    db.close()
  }, 60_000)

  it('a worker that exits without answering rejects (company:open never hangs on it)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'total-checkworker-dead-'))
    const dead = join(dir, 'dead.js')
    writeFileSync(dead, 'process.exit(3)\n')
    setCheckWorkerFile(dead)
    const { db, path } = fileDb()
    await expect(pragmaCheck(path, 'quick_check')).rejects.toThrow(/exited/)
    expect(await quickCheckOkAsync(path)).toBe(false)
    // checkIntegrityAsync falls back to the main connection, as before.
    expect(await checkIntegrityAsync(db, path)).toEqual(checkIntegrity(db))
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('the open-time quick_check gives up after its timeout; the open is not held (to-do §4)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'total-checkworker-silent-'))
    const silent = join(dir, 'silent.js')
    writeFileSync(silent, 'setInterval(() => {}, 1000)\n')
    setCheckWorkerFile(silent)
    const { db, path } = fileDb()
    await expect(pragmaCheck(path, 'quick_check', null, { timeoutMs: 50 })).rejects.toBeInstanceOf(CheckTimeoutError)
    await stopChecks(path) // the terminated thread is tracked until it has exited
    expect(runningChecks(path)).toBe(0)
    const started = Date.now()
    const result = await checkIntegrityAsync(db, path, { timeoutMs: 50 })
    expect(Date.now() - started).toBeLessThan(5_000)
    // Not checked is not damaged: the balance check alone decides `ok`; nothing re-ran on `db`.
    expect(result).toEqual({ ok: true, quickCheck: QUICK_CHECK_TIMED_OUT, unbalancedVoucherIds: [] })
    await stopChecks(path)
    expect(runningChecks(path)).toBe(0)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('a timed-out check still reading in native code stays visible to stopChecks until its thread is gone', async () => {
    // terminate() cannot interrupt a pragma inside SQLite: this worker stands for a slow
    // quick_check — one native query of ~1 s — and answers only after it.
    const dir = mkdtempSync(join(tmpdir(), 'total-checkworker-slow-'))
    const slow = join(dir, 'slow.js')
    const sqlite = createRequire(import.meta.url).resolve('better-sqlite3-multiple-ciphers')
    writeFileSync(
      slow,
      `const { parentPort } = require('worker_threads')\nconst Database = require(${JSON.stringify(sqlite)})\n` +
        `parentPort.on('message', (m) => { const db = new Database(':memory:'); const t = Date.now(); let n = 0\n` +
        `  while (Date.now() - t < 1000) n += db.prepare('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 3000000) SELECT count(*) AS k FROM c').get().k\n` +
        `  db.close(); parentPort.postMessage({ id: m.id, ok: true, result: 'ok' }) })\n`
    )
    setCheckWorkerFile(slow)
    const { db, path } = fileDb()
    await expect(pragmaCheck(path, 'quick_check', null, { timeoutMs: 50 })).rejects.toBeInstanceOf(CheckTimeoutError)
    expect(runningChecks(path)).toBe(1)
    await stopChecks(path)
    expect(runningChecks(path)).toBe(0)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }, 30_000)

  it('stopChecks ends a running check; the weekly check then reports and stamps nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'total-checkworker-hang-'))
    const hang = join(dir, 'hang.js')
    writeFileSync(hang, 'setInterval(() => {}, 1000)\n')
    setCheckWorkerFile(hang)
    const { db, path } = fileDb()
    const weekly = runWeeklyIntegrityCheckAsync(db, path)
    await new Promise((r) => setTimeout(r, 50))
    expect(runningChecks(path)).toBe(1)
    await stopChecks(path)
    expect(await weekly).toBeNull()
    expect(runningChecks(path)).toBe(0)
    expect(db.prepare('SELECT 1 FROM meta WHERE key = ?').get(INTEGRITY_CHECK_META_KEY)).toBeUndefined()
    await expect(stopChecks(path)).resolves.toBeUndefined()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
