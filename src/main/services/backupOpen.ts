// To-do §4 (PR #118 review) — the backup company:open takes, in two halves.
//
// The SNAPSHOT is what protects the user, so it stays in the open path: the copy is written (and
// its attachments stashed, and the backup audited) before company:open replies. Its quick_check —
// a whole-file read of the copy, as long as the copy itself on a slow disk / huge file — runs after
// the reply, in the check worker (db/checkHost.ts), tracked under the backup file. What the old
// sequence did right after the check waits for its VERDICT:
//   - ok        → the older backups are pruned (backupCompany's rule, unchanged), and the caller
//                 runs the housekeeping that rests on a good backup (the bin purge + attachment sweep);
//   - damaged   → the copy is removed (task Q3 #99: a backup that fails quick_check is worse than
//                 none) and the failure goes to backup_runs — Home's red card, Settings → Backups;
//   - unverified (the check could not finish: the worker died) → the copy is KEPT, the failure is
//                 recorded, nothing is pruned or purged;
//   - stopped   (stopChecks: a restore / delete / passphrase change / data-folder move, or the
//                 company closed meanwhile) → nothing is recorded, pruned or purged.
// A backup without a verdict is listed in meta OPEN_BACKUP_UNVERIFIED_KEY (written right after the
// snapshot, removed with its verdict). When the app quits before the verdict, the next open's
// follow-up re-checks every listed copy that is still there (and removes / flags a damaged one);
// the prune and the purge of that open rest only on that open's own backup.
// Electron-free (dbtests run it directly).
import { existsSync, rmSync } from 'fs'
import { basename, join } from 'path'
import type { DB } from '../db/connection'
import { backupDestFor, pruneCompanyBackups, stashAndAuditBackup } from '../db/connection'
import { snapshotTo, tagOf } from '../db/backup'
import { CheckStoppedError, pragmaCheck } from '../db/checkHost'
import { isEncryptedFile, keyOfHandle } from '../db/encryption'
import { companyBackupsDir } from '../paths'
import { recordBackupCheck } from './backupVerify'
import type { BackupCheck } from '@shared/backupCheck'

/** meta key: the names of open backups still waiting for their quick_check verdict (JSON array). */
export const OPEN_BACKUP_UNVERIFIED_KEY = 'backup.openUnverified'

export type OpenBackupVerdict = 'ok' | 'damaged' | 'unverified' | 'stopped'

export function unverifiedOpenBackups(db: DB): string[] {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(OPEN_BACKUP_UNVERIFIED_KEY) as { value: string } | undefined
  if (!row) return []
  try {
    const v = JSON.parse(row.value) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function writeUnverified(db: DB, files: string[]): void {
  if (files.length === 0) db.prepare('DELETE FROM meta WHERE key = ?').run(OPEN_BACKUP_UNVERIFIED_KEY)
  else db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(OPEN_BACKUP_UNVERIFIED_KEY, JSON.stringify(files))
}

const markUnverified = (db: DB, file: string): void => {
  const files = unverifiedOpenBackups(db)
  if (!files.includes(file)) writeUnverified(db, [...files, file])
}
const clearUnverified = (db: DB, file: string): void => {
  const files = unverifiedOpenBackups(db)
  if (files.includes(file)) writeUnverified(db, files.filter((f) => f !== file))
}

/** The open path's half: the snapshot (+ attachments, audit row), listed as unverified. Throws
 *  when the snapshot cannot be written — then there is no backup, and nothing that rests on one
 *  may run. Not bounded: an online backup / VACUUM INTO given up half way leaves no usable copy,
 *  so a timeout could only turn a slow backup into no backup. */
export async function snapshotOnOpen(db: DB, slug: string, tag = 'open'): Promise<string> {
  const dest = backupDestFor(slug, tag)
  await snapshotTo(db, dest)
  markUnverified(db, basename(dest))
  stashAndAuditBackup(db, slug, dest, tag)
  return dest
}

/** quick_check of a backup copy, as a verdict. Never throws. */
export async function quickCheckVerdict(path: string, key: Buffer | null): Promise<{ verdict: OpenBackupVerdict; error: string | null }> {
  if (!existsSync(path)) return { verdict: 'damaged', error: 'The backup file is missing' }
  try {
    const r = await pragmaCheck(path, 'quick_check', key)
    return r === 'ok' ? { verdict: 'ok', error: null } : { verdict: 'damaged', error: 'The backup file is damaged (quick_check failed)' }
  } catch (err) {
    if (err instanceof CheckStoppedError) return { verdict: 'stopped', error: null }
    return { verdict: 'unverified', error: `The backup could not be checked: ${err instanceof Error ? err.message : String(err)}` }
  }
}

function recordFailure(db: DB, path: string, verdict: OpenBackupVerdict, error: string | null): void {
  const check: BackupCheck = {
    file: basename(path),
    tag: tagOf(basename(path)),
    encrypted: isEncryptedFile(path),
    checkedAt: new Date().toISOString(),
    ok: false,
    steps: { opens: verdict === 'damaged', quickCheck: false, migrations: null, auditChain: null, balanced: null, company: false },
    error
  }
  recordBackupCheck(db, check)
}

export interface OpenBackupSettled {
  verdict: OpenBackupVerdict
  /** Whether the older backups were pruned (only after an ok verdict). */
  pruned: boolean
  /** Earlier open backups that had no verdict yet, re-checked now. */
  rechecked: { file: string; verdict: OpenBackupVerdict }[]
}

/** The half after the reply: the verdict on `dest` (and on any earlier copy still unverified),
 *  then the prune — only on ok. `stillCurrent` is asked after every wait: once it says no (the
 *  company closed, a restore / delete / lock change began) nothing more is written or removed. */
export async function settleOpenBackup(db: DB, slug: string, dest: string, opts: { stillCurrent: () => boolean }): Promise<OpenBackupSettled> {
  const live = (): boolean => db.open && opts.stillCurrent()
  const out: OpenBackupSettled = { verdict: 'stopped', pruned: false, rechecked: [] }
  if (!live()) return out
  const key = keyOfHandle(db)
  const own = await quickCheckVerdict(dest, key)
  out.verdict = own.verdict
  if (!live()) {
    out.verdict = 'stopped'
    return out
  }
  if (own.verdict === 'ok') clearUnverified(db, basename(dest))
  else if (own.verdict === 'damaged') {
    rmSync(dest, { force: true })
    clearUnverified(db, basename(dest))
    recordFailure(db, dest, 'damaged', own.error)
  } else if (own.verdict === 'unverified') recordFailure(db, dest, 'unverified', own.error)
  // Copies an earlier open left without a verdict (the app quit first).
  for (const file of unverifiedOpenBackups(db).filter((f) => f !== basename(dest))) {
    const path = join(companyBackupsDir(slug), file)
    if (!existsSync(path)) {
      clearUnverified(db, file)
      continue
    }
    const r = await quickCheckVerdict(path, isEncryptedFile(path) ? key : null)
    if (!live()) return out
    out.rechecked.push({ file, verdict: r.verdict })
    if (r.verdict === 'ok') clearUnverified(db, file)
    else if (r.verdict === 'damaged') {
      rmSync(path, { force: true })
      clearUnverified(db, file)
      recordFailure(db, path, 'damaged', r.error)
    }
  }
  if (own.verdict === 'ok' && live()) {
    pruneCompanyBackups(slug)
    out.pruned = true
  }
  return out
}
