// WP 7.2 — turning the passphrase lock on and off for a company file (docs/security/encryption-at-rest.md).
//
// Both directions are the same verified-copy procedure, run on the OPEN company:
//   1. a compacted copy beside the file (`company.db.converting`) with the target key
//      (db/encryption.ts copyWithKey — VACUUM INTO + rekey);
//   2. the copy is opened with that key and its facts compared with the live file's: every table's
//      row count, the migration count, the audit chain's head and verdict, the trial balance's
//      movement totals — any difference and the copy is deleted, nothing changed
//      (`security_verify_failed`);
//   3. the change is audited INSIDE the copy (entity 'security'), so the row lives in the books it
//      describes, chained on the live file's last row;
//   4. the live handle is closed and the copy renamed over the original (same directory: atomic);
//      the caller reopens.
// Re-runnable: a crash before step 4 leaves the original untouched (a stale `.converting` file is
// replaced on the next run); after it, the file IS the converted, verified copy.
//
// The company's backups are converted after the swap (each one copied, rekeyed, quick-checked,
// renamed over itself), so no plaintext backup is left behind a locked company — and none
// encrypted behind an unlocked one. Electron-free.
import { closeSync, copyFileSync, existsSync, fsyncSync, openSync, readdirSync, renameSync, rmSync, statSync } from 'fs'
import { dirname, join } from 'path'
import type { DB } from '../db/connection'
import { copyWithKey, isEncryptedFile, keyOfHandle, openDb, rekeyFile, removeDbFiles } from '../db/encryption'
import { quickCheckOk } from '../db/backup'
import { AppError } from '@shared/errors'
import { verifyAudit, writeAudit } from './audit'
import { trialBalance } from './reports'

export interface BookFacts {
  tables: Record<string, number>
  migrations: number
  auditOk: boolean
  auditHead: string | null
  movementDebit: number
  movementCredit: number
}

/** What must be identical between a file and its converted copy. */
export function bookFacts(db: DB, asOn: string): BookFacts {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name)
  const tables: Record<string, number> = {}
  for (const n of names) tables[n] = (db.prepare(`SELECT COUNT(*) AS n FROM "${n.replace(/"/g, '""')}"`).get() as { n: number }).n
  const chain = verifyAudit(db)
  const tb = trialBalance(db, asOn)
  return {
    tables,
    migrations: tables['migrations'] ?? 0,
    auditOk: chain.ok,
    auditHead: chain.headHash,
    movementDebit: tb.movementDebitTotal,
    movementCredit: tb.movementCreditTotal
  }
}

export function sameFacts(a: BookFacts, b: BookFacts): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export interface ConvertOptions {
  /** The open company handle (left open; the caller closes every handle before the commit). */
  db: DB
  dbPath: string
  /** The key to convert to; null = take the passphrase lock off (plaintext). */
  to: Buffer | null
  asOn: string
  /** Audit row written into the converted copy. */
  audit: { before: unknown; after: unknown; user?: string }
}

/** Steps 1–3 above: the verified, audited copy beside the file. Throws `security_verify_failed`
 *  (the copy removed, nothing changed) when it differs. Returns the copy's path. */
export function prepareConvertedCopy(opts: ConvertOptions): string {
  const { db, dbPath, to } = opts
  const tmp = `${dbPath}.converting`
  db.pragma('wal_checkpoint(TRUNCATE)')
  const live = bookFacts(db, opts.asOn)
  let copy: DB | null = null
  try {
    copyWithKey(db, tmp, to)
    if (to ? !isEncryptedFile(tmp) : isEncryptedFile(tmp)) throw new Error('the copy is not in the expected form')
    copy = openDb(tmp, { key: to })
    const quick = copy.pragma('quick_check', { simple: true })
    if (quick !== 'ok') throw new Error(`quick_check: ${String(quick)}`)
    if (!sameFacts(live, bookFacts(copy, opts.asOn))) throw new Error('the copy does not match the books')
    writeAudit(copy, 'security', 0, 'update', opts.audit.before, opts.audit.after, opts.audit.user ? { user: opts.audit.user } : {})
    copy.close()
    copy = null
    return tmp
  } catch (err) {
    copy?.close()
    removeDbFiles(tmp)
    throw new AppError('security_verify_failed', `The converted copy could not be verified — nothing was changed (${err instanceof Error ? err.message : String(err)})`)
  }
}

/** fsync a file (libuv uses F_FULLFSYNC on macOS, so the bytes are on the disk, not only in its
 *  cache) — the converted copy must be durable BEFORE it replaces the only other copy. */
export function fsyncFile(path: string): void {
  const fd = openSync(path, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** fsync a directory so a rename in it is durable (POSIX; Windows cannot open a directory — the
 *  rename there is MoveFileEx, journalled by NTFS). Best effort. */
export function fsyncDir(dir: string): void {
  if (process.platform === 'win32') return
  try {
    const fd = openSync(dir, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // a file system that cannot sync a directory
  }
}

/** Step 4: the copy renamed over the original (same directory — atomic). Every handle on
 *  `dbPath` must be closed first. Refused (nothing changed, the copy removed) while the original
 *  still has a WAL with frames in it: those frames belong to the OLD file — they were not in the
 *  copy, and next to the new file they would be read as its pages. A cleanly closed WAL database
 *  has no `-wal` (or an empty one after the TRUNCATE checkpoint). */
export function commitConvertedCopy(tmp: string, dbPath: string): void {
  const wal = `${dbPath}-wal`
  if (existsSync(wal) && statSync(wal).size > 0) {
    removeDbFiles(tmp)
    throw new AppError('security_verify_failed', 'The books were still in use while being converted — nothing was changed; try again')
  }
  fsyncFile(tmp)
  renameSync(tmp, dbPath)
  fsyncDir(dirname(dbPath))
  for (const p of [wal, `${dbPath}-shm`, `${tmp}-journal`]) rmSync(p, { force: true })
}

/** Remove what an interrupted conversion / restore / export may have left in a company folder:
 *  `company.db.converting` (a copy of the books — PLAINTEXT when the lock was being taken off),
 *  backups' `*.converting` / `*.restore-tmp`, and the encrypted export's plaintext snapshot.
 *  Called before the company is opened; never touches the books or a finished backup. */
export function removeLeftoverCopies(dbPath: string, backupsDir: string, exportsDir: string): void {
  removeDbFiles(`${dbPath}.converting`)
  const sweep = (dir: string, match: (f: string) => boolean): void => {
    if (!existsSync(dir)) return
    for (const f of readdirSync(dir)) if (match(f)) rmSync(join(dir, f), { force: true })
  }
  sweep(backupsDir, (f) => /\.db\.(converting|restore-tmp)(-journal|-wal|-shm)?$/.test(f))
  // An export may still be writing its snapshot (it awaits the file encryption): only an old one.
  const hourAgo = Date.now() - 60 * 60 * 1000
  sweep(exportsDir, (f) => /^\.export-tmp-.*\.db(-journal|-wal|-shm)?$/.test(f) && statSync(join(exportsDir, f)).mtimeMs < hourAgo)
}

/** Steps 1–4 for a handle nothing else holds (tests): `db` is closed on success. */
export function convertCompanyFile(opts: ConvertOptions): void {
  const tmp = prepareConvertedCopy(opts)
  opts.db.close()
  commitConvertedCopy(tmp, opts.dbPath)
}

export interface BackupConversion {
  converted: number
  failed: string[]
}

/** Convert every backup in `dir` that is not yet in the target form (`from` = the key the
 *  encrypted ones use; `to` = the target, null = plaintext). Each one is copied, rekeyed,
 *  quick-checked and renamed over itself — a failure leaves that backup as it was. */
export function convertBackups(dir: string, from: Buffer | null, to: Buffer | null): BackupConversion {
  const out: BackupConversion = { converted: 0, failed: [] }
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.db')).sort()) {
    const path = join(dir, f)
    const enc = isEncryptedFile(path)
    if (!to && !enc) continue
    if (to && enc) {
      // Already encrypted: fine when the target key opens it, else (another key, not a database)
      // it is reported — never silently counted as converted.
      if (!quickCheckOk(path, to)) out.failed.push(f)
      continue
    }
    const tmp = `${path}.converting`
    try {
      removeDbFiles(tmp)
      copyFileSync(path, tmp)
      rekeyFile(tmp, enc ? from : null, to)
      if (!quickCheckOk(tmp, to)) throw new Error('quick_check')
      fsyncFile(tmp)
      renameSync(tmp, path)
      out.converted++
    } catch {
      removeDbFiles(tmp)
      out.failed.push(f)
    }
  }
  if (out.converted) fsyncDir(dir)
  return out
}

/** Whether an open handle is encrypted (opened with a key). */
export function handleIsEncrypted(db: DB): boolean {
  return keyOfHandle(db) !== null
}
