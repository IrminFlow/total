// To-do §4 (PR #118 review): company:open waits for the open backup's SNAPSHOT only. Its quick_check
// runs after the reply, in the check worker; the prune of older backups and the bin purge rest on
// that verdict. Through the IPC handlers (electron mocked, a scratch TOTAL_DATA_DIR) with a stand-in
// check worker whose answer for a backup copy the test gives by writing a file:
//  (a) the open returns before the verdict;
//  (b) no prune / purge while the backup is unverified, or after it failed (damaged → removed + flagged;
//      the worker died → kept + flagged);
//  (c) the prune and the purge after an ok verdict;
//  (d) closed (quit) before the verdict → the copy stays listed as unverified; the next open purges
//      nothing until ITS backup is ok, and re-checks the earlier copy;
//  (e) backup:restore and company:delete stop the pending check.
import { TRUSTED_EVENT } from './ipcSender.testutil'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { postSimpleVoucher, testFileDb } from './db/testdb'

type Result = { ok: boolean; data?: unknown; error?: string; code?: string }
const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<Result>>()

vi.mock('electron', () => ({
  app: { getVersion: () => '0.12.0-test', getPath: () => tmpdir(), isPackaged: false, on: () => {} },
  ipcMain: { handle: (ch: string, fn: (e: unknown, p: unknown) => Promise<Result>) => handlers.set(ch.replace(/^total:/, ''), fn) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '', showItemInFolder: () => {}, openExternal: async () => {} },
  Notification: class {},
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./updater', () => ({ checkForUpdatesInteractive: async () => null }))

const DATA_DIR = mkdtempSync(join(tmpdir(), 'total-openwait-'))
const CTL = mkdtempSync(join(tmpdir(), 'total-openwait-ctl-'))
process.env.TOTAL_DATA_DIR = DATA_DIR
process.env.TOTAL_SUPPRESS_SYNC_WARNING = '1'
process.env.TOTAL_INSECURE_TEST_SECRETS = '1'

// The stand-in worker: the live file (company:open's own quick_check) is 'ok' at once; a copy in a
// backups folder waits for <CTL>/<file>.verdict — 'ok', 'damaged', or 'die' (the thread exits).
const WORKER = join(CTL, 'worker.js')
writeFileSync(
  WORKER,
  `const { parentPort } = require('worker_threads')
const { existsSync, readFileSync, writeFileSync } = require('fs')
const { basename, join } = require('path')
const CTL = ${JSON.stringify(CTL)}
parentPort.on('message', (m) => {
  if (!/[\\\\/]backups[\\\\/]/.test(m.path)) return parentPort.postMessage({ id: m.id, ok: true, result: 'ok' })
  const ctl = join(CTL, basename(m.path) + '.verdict')
  writeFileSync(join(CTL, basename(m.path) + '.asked'), '1')
  const t = setInterval(() => {
    if (!existsSync(ctl)) return
    clearInterval(t)
    const v = readFileSync(ctl, 'utf8').trim()
    if (v === 'die') process.exit(3)
    parentPort.postMessage({ id: m.id, ok: true, result: v === 'ok' ? 'ok' : '*** page 2 is never used' })
  }, 10)
})
`
)

async function call(channel: string, payload?: unknown): Promise<Result> {
  const h = handlers.get(channel)
  if (!h) throw new Error(`no handler ${channel}`)
  return h(TRUSTED_EVENT, payload)
}
async function ok<T>(channel: string, payload?: unknown): Promise<T> {
  const r = await call(channel, payload)
  if (!r.ok) throw new Error(`${channel}: ${r.error} (${r.code ?? ''})`)
  return r.data as T
}

const company = (name: string): Record<string, unknown> => ({
  name, stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null
})
const backupsDir = (slug: string): string => join(DATA_DIR, 'companies', slug, 'backups')
const dbFile = (slug: string): string => join(DATA_DIR, 'companies', slug, 'company.db')
const openBackups = (slug: string): string[] => readdirSync(backupsDir(slug)).filter((f) => f.endsWith('-open.db')).sort()
const allBackups = (slug: string): string[] => readdirSync(backupsDir(slug)).filter((f) => f.endsWith('.db'))
const verdict = (file: string, v: 'ok' | 'damaged' | 'die'): void => writeFileSync(join(CTL, `${file}.verdict`), v)
const asked = (file: string): boolean => existsSync(join(CTL, `${file}.asked`))
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await sleep(10)
  }
}

// IPC dbtests import ./ipc at COLLECTION, never inside beforeAll (WP 7.3: the import was ~95 % of the
// hook and broke the 10 s hookTimeout on Windows).
const ipc = await import('./ipc')
const checkHost = await import('./db/checkHost')
const backupOpen = await import('./services/backupOpen')
const vouchers = await import('./services/vouchers')
const encryption = await import('./db/encryption')
const { newDataKey } = await import('./db/keyEnvelope')

beforeAll(() => {
  ipc.registerIpc()
  checkHost.setCheckWorkerFile(WORKER)
})

afterEach(async () => {
  // Let nothing from one case run into the next.
  for (const f of readdirSync(CTL).filter((x) => x.endsWith('.asked'))) verdict(f.replace(/\.asked$/, ''), 'ok')
  await ipc.pendingOpenFollowUp()
})

afterAll(() => {
  ipc.closeCurrentCompany()
  checkHost.setCheckWorkerFile(undefined)
  rmSync(DATA_DIR, { recursive: true, force: true })
  rmSync(CTL, { recursive: true, force: true })
})

/** A company with one voucher binned 40 days ago (the open's bin purge takes 30+ days) and 21 old
 *  automatic backups (the prune keeps 20). Closed; `company:open` is the test's. */
async function prepared(name: string): Promise<string> {
  const { slug } = await ok<{ slug: string }>('company:create', company(name))
  // Set up with the in-process check (this open's backup is not under test).
  const worker = checkHost.checkWorkerFile()
  checkHost.setCheckWorkerFile(null)
  try {
    await ok('company:open', { slug })
    await ipc.pendingOpenFollowUp()
    ipc.closeCurrentCompany()
  } finally {
    checkHost.setCheckWorkerFile(worker)
  }
  const d = testFileDb(dbFile(slug))
  const v = postSimpleVoucher(d, { date: '2026-04-10', amount: 100, kind: 'receipt' })
  vouchers.setLockDate(d, '2026-04-30') // the bin purge takes only vouchers inside the lock
  d.prepare("UPDATE vouchers SET number = 'J-OLD', deleted_at = datetime('now', '-40 days') WHERE id = ?").run(v.id)
  d.close()
  // 21 older automatic backups, oldest first (the prune goes by mtime).
  const seedCopy = join(backupsDir(slug), allBackups(slug)[0]!)
  for (let i = 0; i < 21; i++) {
    const f = join(backupsDir(slug), `2020-01-${String(i + 1).padStart(2, '0')}T00-00-00-auto.db`)
    copyFileSync(seedCopy, f)
    const t = new Date(2020, 0, i + 1).getTime() / 1000
    utimesSync(f, t, t)
  }
  return slug
}

const binned = (slug: string): number => {
  const d = testFileDb(dbFile(slug))
  try {
    return (d.prepare("SELECT COUNT(*) AS n FROM vouchers WHERE number = 'J-OLD'").get() as { n: number }).n
  } finally {
    d.close()
  }
}
const newestOpen = (slug: string): string => openBackups(slug).at(-1)!
const unverified = (slug: string): string[] => {
  const d = testFileDb(dbFile(slug))
  try {
    const r = d.prepare('SELECT value FROM meta WHERE key = ?').get(backupOpen.OPEN_BACKUP_UNVERIFIED_KEY) as { value: string } | undefined
    return r ? (JSON.parse(r.value) as string[]) : []
  } finally {
    d.close()
  }
}

describe('company:open waits for the snapshot only (to-do §4)', () => {
  it('(a) + (c) the open replies before the verdict; prune and bin purge come after an ok verdict', async () => {
    const slug = await prepared('Verdict Ok')
    await sleep(1100) // a new backup name (stamped to the second)
    const before = allBackups(slug).length
    const opened = await ok<{ slug: string }>('company:open', { slug })
    expect(opened.slug).toBe(slug)
    const file = newestOpen(slug)
    // The reply is here; the copy is written, its check asked for, no verdict yet.
    await until(() => asked(file))
    expect(ipc.pendingOpenFollowUp()).not.toBeNull()
    expect(allBackups(slug).length).toBe(before + 1)
    // (b) unverified: nothing pruned, nothing purged.
    await sleep(200)
    expect(allBackups(slug).length).toBe(before + 1)
    verdict(file, 'ok')
    const settled = await ipc.pendingOpenFollowUp()
    expect(settled).toMatchObject({ verdict: 'ok', pruned: true })
    expect(allBackups(slug).length).toBe(20)
    expect(allBackups(slug)).toContain(file)
    ipc.closeCurrentCompany()
    expect(binned(slug)).toBe(0)
    expect(unverified(slug)).toEqual([])
  }, 60_000)

  it('(b) a damaged copy is removed and flagged; nothing pruned or purged', async () => {
    const slug = await prepared('Verdict Damaged')
    await sleep(1100)
    const before = allBackups(slug).length
    await ok('company:open', { slug })
    const file = newestOpen(slug)
    await until(() => asked(file))
    verdict(file, 'damaged')
    expect(await ipc.pendingOpenFollowUp()).toMatchObject({ verdict: 'damaged', pruned: false })
    expect(allBackups(slug)).not.toContain(file)
    expect(allBackups(slug).length).toBe(before)
    const checks = await ok<{ ok: boolean; file: string }[]>('backup:checks')
    expect(checks[0]).toMatchObject({ ok: false, file })
    ipc.closeCurrentCompany()
    expect(binned(slug)).toBe(1)
  }, 60_000)

  it('(b) a check that cannot finish keeps the copy, flags it, prunes and purges nothing', async () => {
    const slug = await prepared('Verdict Unverified')
    await sleep(1100)
    const before = allBackups(slug).length
    await ok('company:open', { slug })
    const file = newestOpen(slug)
    await until(() => asked(file))
    verdict(file, 'die')
    expect(await ipc.pendingOpenFollowUp()).toMatchObject({ verdict: 'unverified', pruned: false })
    expect(allBackups(slug)).toContain(file)
    expect(allBackups(slug).length).toBe(before + 1)
    const checks = await ok<{ ok: boolean; file: string }[]>('backup:checks')
    expect(checks[0]).toMatchObject({ ok: false, file })
    ipc.closeCurrentCompany()
    expect(binned(slug)).toBe(1)
    expect(unverified(slug)).toContain(file)
  }, 60_000)

  it('(d) closed before the verdict: the next open purges nothing until its own backup is ok, and re-checks the earlier copy', async () => {
    const slug = await prepared('Quit Early')
    await sleep(1100)
    const before = allBackups(slug).length
    await ok('company:open', { slug })
    const first = newestOpen(slug)
    await until(() => asked(first))
    // "Quit": the company closes with no verdict.
    ipc.closeCurrentCompany()
    verdict(first, 'ok') // the old worker's late answer must change nothing
    expect(await ipc.pendingOpenFollowUp()).toMatchObject({ verdict: 'stopped', pruned: false })
    expect(unverified(slug)).toEqual([first])
    expect(allBackups(slug).length).toBe(before + 1)
    expect(binned(slug)).toBe(1)
    rmSync(join(CTL, `${first}.verdict`))
    rmSync(join(CTL, `${first}.asked`))

    await sleep(1100)
    await ok('company:open', { slug })
    const second = newestOpen(slug)
    expect(second).not.toBe(first)
    await until(() => asked(second))
    await sleep(200)
    expect(allBackups(slug).length).toBe(before + 2) // nothing pruned yet
    verdict(second, 'ok')
    await until(() => asked(first)) // the earlier copy is checked again
    verdict(first, 'ok')
    const settled = await ipc.pendingOpenFollowUp()
    expect(settled).toMatchObject({ verdict: 'ok', pruned: true, rechecked: [{ file: first, verdict: 'ok' }] })
    ipc.closeCurrentCompany()
    expect(unverified(slug)).toEqual([])
    expect(binned(slug)).toBe(0)
    expect(allBackups(slug).length).toBe(20)
  }, 60_000)

  it('(e) backup:restore stops the pending check (nothing pruned or purged around the swap)', async () => {
    const slug = await prepared('Restore Stops')
    await sleep(1100)
    await ok('company:open', { slug })
    const file = newestOpen(slug)
    await until(() => asked(file))
    expect(checkHost.runningChecks(join(backupsDir(slug), file))).toBe(1)
    const pending = ipc.pendingOpenFollowUp()
    await ok('backup:restore', { file })
    expect(await pending).toMatchObject({ verdict: 'stopped', pruned: false })
    expect(checkHost.runningChecks(join(backupsDir(slug), file))).toBe(0)
    // The restored books still hold the binned voucher (no purge ran).
    ipc.closeCurrentCompany()
    expect(binned(slug)).toBe(1)
  }, 60_000)

  it('(e) company:delete stops the pending check', async () => {
    const slug = await prepared('Delete Stops')
    await sleep(1100)
    await ok('company:open', { slug })
    const file = newestOpen(slug)
    await until(() => asked(file))
    const path = join(backupsDir(slug), file)
    expect(checkHost.runningChecks(path)).toBe(1)
    const pending = ipc.pendingOpenFollowUp()
    await ok('company:delete', { slug, confirmName: 'Delete Stops' })
    expect(await pending).toMatchObject({ verdict: 'stopped' })
    expect(checkHost.runningChecks(path)).toBe(0)
    expect(existsSync(join(DATA_DIR, 'companies', slug))).toBe(false)
  }, 60_000)
})

describe('PR #175 review', () => {
  it('a backup taken while the open copy waits for its verdict does not count that copy toward the 20', async () => {
    const slug = await prepared('Manual During Check')
    await sleep(1100)
    const before = allBackups(slug).length // 1 open (setup) + 21 auto
    await ok('company:open', { slug })
    const file = newestOpen(slug)
    await until(() => asked(file))
    // A manual backup now prunes the automatic ones past the window — the pending open copy is
    // kept without taking a slot, so only before + 2 - 21 (20 counted + the pending one) are kept.
    const run = ok('backup:run')
    // backupCompany's own quick_check of the manual copy (the stand-in waits for every backups/ file).
    await until(() => readdirSync(CTL).some((f) => f.endsWith('-manual.db.asked')))
    verdict(readdirSync(CTL).find((f) => f.endsWith('-manual.db.asked'))!.replace(/\.asked$/, ''), 'ok')
    await run
    expect(allBackups(slug)).toContain(file)
    expect(allBackups(slug).length).toBe(21)
    expect(before + 2 - allBackups(slug).length).toBe(3)
    verdict(file, 'ok')
    expect(await ipc.pendingOpenFollowUp()).toMatchObject({ verdict: 'ok', pruned: true })
    expect(allBackups(slug).length).toBe(20)
    expect(allBackups(slug)).toContain(file)
    ipc.closeCurrentCompany()
  }, 60_000)

  it('a new open stops the re-check of an EARLIER copy too, and the stale run writes nothing', async () => {
    const slug = await prepared('Reopen During Recheck')
    await sleep(1100)
    await ok('company:open', { slug })
    const first = newestOpen(slug)
    await until(() => asked(first))
    ipc.closeCurrentCompany()
    verdict(first, 'ok') // the closed open's late answer
    expect(await ipc.pendingOpenFollowUp()).toMatchObject({ verdict: 'stopped' })
    rmSync(join(CTL, `${first}.verdict`))
    rmSync(join(CTL, `${first}.asked`))
    await sleep(1100)
    await ok('company:open', { slug })
    const second = newestOpen(slug)
    await until(() => asked(second))
    verdict(second, 'ok')
    await until(() => asked(first)) // the earlier copy's re-check is running
    const firstPath = join(backupsDir(slug), first)
    expect(checkHost.runningChecks(firstPath)).toBe(1)
    await sleep(1100)
    await ok('company:open', { slug }) // reopen: the second open's follow-up is cancelled
    expect(checkHost.runningChecks(firstPath)).toBe(0)
    const third = newestOpen(slug)
    expect(unverified(slug)).toEqual(expect.arrayContaining([first, third]))
    await until(() => asked(third))
    verdict(third, 'ok')
    verdict(first, 'ok') // the third open re-checks the earlier copy again
    const settled = await ipc.pendingOpenFollowUp()
    expect(settled).toMatchObject({ verdict: 'ok', pruned: true })
    ipc.closeCurrentCompany()
    expect(unverified(slug)).toEqual([])
  }, 60_000)

  it('an encrypted copy checked without its key, or with a wrong one, is "could not finish" — never damaged, never removed', async () => {
    const worker = checkHost.checkWorkerFile()
    checkHost.setCheckWorkerFile(null) // the in-process check: the real driver's answer
    try {
      const dir = mkdtempSync(join(tmpdir(), 'total-openwait-enc-'))
      const plain = testFileDb(join(dir, 'plain.db'))
      plain.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1)')
      const key = newDataKey()
      const copy = join(dir, 'copy.db')
      encryption.copyWithKey(plain, copy, key)
      plain.close()
      expect(encryption.isEncryptedFile(copy)).toBe(true)
      expect(await backupOpen.quickCheckVerdict(copy, key)).toMatchObject({ verdict: 'ok' })
      expect((await backupOpen.quickCheckVerdict(copy, null)).verdict).toBe('unverified')
      expect((await backupOpen.quickCheckVerdict(copy, newDataKey())).verdict).toBe('unverified')
      expect(existsSync(copy)).toBe(true)
      rmSync(dir, { recursive: true, force: true })
    } finally {
      checkHost.setCheckWorkerFile(worker)
    }
  }, 60_000)
})

describe('settleOpenBackup in-process (no worker: dbtests, the CLI)', () => {
  it('the same verdicts with the in-process quick_check', async () => {
    checkHost.setCheckWorkerFile(null)
    try {
      const slug = await prepared('In Process')
      await sleep(1100)
      await ok('company:open', { slug })
      expect(await ipc.pendingOpenFollowUp()).toMatchObject({ verdict: 'ok', pruned: true })
      ipc.closeCurrentCompany()
      expect(binned(slug)).toBe(0)
      expect(allBackups(slug).length).toBe(20)
    } finally {
      checkHost.setCheckWorkerFile(WORKER)
    }
  }, 60_000)
})
