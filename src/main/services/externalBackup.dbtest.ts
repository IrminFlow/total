import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, utimesSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { migrate } from '../db/migrate'
import { seedCompany } from '../db/seed'
import { TEST_INFO, postSimpleVoucher } from '../db/testdb'
import { decryptFile } from '../db/crypt'
import { verifyBackup } from '../db/backup'
import { setAuditContext } from './audit'
import { getExternalBackup, setExternalBackup } from './config'
import { pruneExternal, runExternalBackup, runIfDue } from './externalBackup'
import { DEFAULT_EXTERNAL_BACKUP } from '@shared/backupSchedule'

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** A company on disk with two entries in it, and a destination folder somewhere else. */
function scenario(): { db: Database.Database; dest: string } {
  setAuditContext({ appVersion: '0.4.0-test', getUserName: () => 'Asha' })
  const home = tmpDir('total-ext-src-')
  const db = new Database(join(home, 'company.db'))
  db.pragma('journal_mode = WAL')
  migrate(db)
  seedCompany(db, TEST_INFO)
  postSimpleVoucher(db, { date: '2026-04-01', amount: 125000, kind: 'receipt' })
  postSimpleVoucher(db, { date: '2026-04-02', amount: 25000, kind: 'payment' })
  return { db, dest: tmpDir('total-ext-dest-') }
}

describe('the backup that leaves the machine', () => {
  beforeEach(() => {
    setAuditContext({ appVersion: '0.4.0-test', getUserName: () => 'Asha' })
  })

  it('writes a copy whose books open, foot and hold every voucher', async () => {
    const { db, dest } = scenario()
    const run = await runExternalBackup(db, 'acme', { ...DEFAULT_EXTERNAL_BACKUP, dir: dest }, null)
    expect(run.ran).toBe(true)

    // The claim is not "a file appeared". It is that the books inside it are the books.
    const proof = verifyBackup(run.path!)
    expect(proof.integrityOk).toBe(true)
    expect(proof.opensAsCompany).toBe(true)
    expect(proof.balanced).toBe(true)
    expect(proof.voucherCount).toBe(2)
    expect(proof.totalDebit).toBe(150000)
    db.close()
  })

  it('writes an encrypted copy that decrypts back to the same books', async () => {
    const { db, dest } = scenario()
    const run = await runExternalBackup(
      db,
      'acme',
      { ...DEFAULT_EXTERNAL_BACKUP, dir: dest, encrypt: true },
      'correct horse battery staple'
    )
    expect(run.path!.endsWith('.totalbak')).toBe(true)

    // Nothing readable is left lying in the destination: the plaintext staging file is gone.
    expect(readdirSync(dest).filter((f) => f.endsWith('.db'))).toEqual([])

    const restored = join(tmpDir('total-ext-restore-'), 'restored.db')
    await decryptFile(run.path!, restored, 'correct horse battery staple')
    const proof = verifyBackup(restored)
    expect(proof.balanced).toBe(true)
    expect(proof.voucherCount).toBe(2)
    expect(proof.totalDebit).toBe(150000)
    db.close()
  })

  it('refuses the wrong passphrase rather than handing over the books', async () => {
    const { db, dest } = scenario()
    const run = await runExternalBackup(db, 'acme', { ...DEFAULT_EXTERNAL_BACKUP, dir: dest, encrypt: true }, 'right one')
    const out = join(tmpDir('total-ext-restore-'), 'restored.db')
    await expect(decryptFile(run.path!, out, 'wrong one')).rejects.toThrow()
    db.close()
  })

  it('will not pretend to encrypt when it has no passphrase', async () => {
    const { db, dest } = scenario()
    await expect(
      runExternalBackup(db, 'acme', { ...DEFAULT_EXTERNAL_BACKUP, dir: dest, encrypt: true }, null)
    ).rejects.toThrow(/passphrase/)
    db.close()
  })

  it('says the drive is not plugged in instead of failing silently', async () => {
    const { db, dest } = scenario()
    setExternalBackup(db, { ...DEFAULT_EXTERNAL_BACKUP, dir: join(dest, 'not-mounted') })
    const run = await runIfDue(db, 'acme', null)
    expect(run.ran).toBe(false)
    expect(run.error).toMatch(/not there/)
    // And the schedule stays due, so the next tick tries again rather than waiting a day.
    expect(getExternalBackup(db).lastRunAt).toBeNull()
    expect(getExternalBackup(db).lastError).toMatch(/not there/)
    db.close()
  })

  it('runs when due, and not again until the interval has passed', async () => {
    const { db, dest } = scenario()
    setExternalBackup(db, { ...DEFAULT_EXTERNAL_BACKUP, dir: dest, everyHours: 24 })

    const first = await runIfDue(db, 'acme', null, new Date('2026-04-10T09:00:00Z'))
    expect(first.ran).toBe(true)
    const tooSoon = await runIfDue(db, 'acme', null, new Date('2026-04-10T20:00:00Z'))
    expect(tooSoon.ran).toBe(false)
    const nextDay = await runIfDue(db, 'acme', null, new Date('2026-04-11T09:00:00Z'))
    expect(nextDay.ran).toBe(true)
    db.close()
  })

  it('prunes its own old copies and never anybody else’s files', () => {
    const dest = tmpDir('total-ext-prune-')
    const stranger = join(dest, 'family-photos.db')
    const otherCompany = join(dest, 'total-other-2026-01-01T00-00-00.db')
    writeFileSync(stranger, 'not ours')
    writeFileSync(otherCompany, 'someone else’s company')
    for (let i = 1; i <= 5; i++) {
      const file = join(dest, `total-acme-2026-04-0${i}T00-00-00.db`)
      writeFileSync(file, 'x')
      const when = new Date(`2026-04-0${i}T00:00:00Z`).getTime() / 1000
      utimesSync(file, when, when)
    }

    const pruned = pruneExternal(dest, 'acme', 3)
    expect(pruned).toBe(2)
    const left = readdirSync(dest).sort()
    expect(left).toContain('family-photos.db')
    expect(left).toContain('total-other-2026-01-01T00-00-00.db')
    expect(left.filter((f) => f.startsWith('total-acme-'))).toHaveLength(3)
    // The three kept are the newest three.
    expect(left).toContain('total-acme-2026-04-05T00-00-00.db')
    expect(left).not.toContain('total-acme-2026-04-01T00-00-00.db')
  })

  it('leaves no half-written staging file in the destination', async () => {
    // A sync client watching this folder must never see a file SQLite is still writing.
    const { db, dest } = scenario()
    const readOnlyish = join(dest, 'sub')
    mkdirSync(readOnlyish)
    const run = await runExternalBackup(db, 'acme', { ...DEFAULT_EXTERNAL_BACKUP, dir: readOnlyish }, null)
    expect(run.ran).toBe(true)
    expect(readdirSync(readOnlyish).filter((f) => f.startsWith('.total-staging'))).toEqual([])
    expect(existsSync(run.path!)).toBe(true)
    db.close()
  })
})
