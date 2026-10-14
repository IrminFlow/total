// WP 7.2 — automatic restore check of a backup: is this copy something we could actually go back to?
//
// The backup file is copied into a scratch folder (never touched in place), opened (with the
// company's key when it is encrypted), quick-checked, MIGRATED as a restore would migrate it, and
// then: the migration count must reach this build's, the audit chain must verify, the company row
// must be there and the entries must balance (the trial balance's movement totals, Dr = Cr). The
// verdict goes to `backup_runs` (Home and Settings → Backups read the newest) and the audit trail
// (entity 'backup_check'). Electron-free; the scratch folder is always removed.
import { copyFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import type { DB } from '../db/connection'
import { isEncryptedFile, keyForPath, keyOfHandle, openDb } from '../db/encryption'
import { migrate } from '../db/migrate'
import { MIGRATIONS } from '../db/migrations'
import { tagOf } from '../db/backup'
import { verifyAudit, writeAudit } from './audit'
import { trialBalance } from './reports'
import type { BackupCheck, BackupCheckSteps } from '@shared/backupCheck'

export interface VerifyOptions {
  /** The key of an encrypted backup (omitted = the one remembered for its folder). */
  key?: Buffer | null
  /** Where the scratch folder goes (default: the OS temp dir). */
  scratchRoot?: string
  asOn: string
  now?: Date
}

/** Restore `path` into a scratch folder and check it. Never throws. */
export function verifyBackupFile(path: string, opts: VerifyOptions): BackupCheck {
  const steps: BackupCheckSteps = { opens: false, quickCheck: false, migrations: null, auditChain: null, balanced: null, company: false }
  const encrypted = isEncryptedFile(path)
  const key = opts.key !== undefined ? opts.key : encrypted ? keyForPath(path) : null
  const checkedAt = (opts.now ?? new Date()).toISOString()
  const result = (error: string | null): BackupCheck => ({
    file: basename(path),
    tag: tagOf(basename(path)),
    encrypted,
    checkedAt,
    ok: error === null,
    steps,
    error
  })
  let scratch: string | null = null
  let db: DB | null = null
  try {
    scratch = mkdtempSync(join(opts.scratchRoot ?? tmpdir(), 'total-backup-check-'))
    const copy = join(scratch, 'restore-check.db')
    copyFileSync(path, copy)
    if (encrypted && !key) return result('The backup is locked with a passphrase and the business is not unlocked')
    db = openDb(copy, { key: encrypted ? key : null })
    steps.opens = true
    steps.quickCheck = db.pragma('quick_check', { simple: true }) === 'ok'
    if (!steps.quickCheck) return result('The backup file is damaged (quick_check failed)')
    db.pragma('foreign_keys = ON')
    const before = (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'migrations'").get() as { n: number }).n
      ? (db.prepare('SELECT COUNT(*) AS n FROM migrations').get() as { n: number }).n
      : 0
    if (before > MIGRATIONS.length) {
      steps.migrations = { found: before, expected: MIGRATIONS.length, ok: false }
      return result('The backup was made by a newer version of Total')
    }
    migrate(db)
    const after = (db.prepare('SELECT COUNT(*) AS n FROM migrations').get() as { n: number }).n
    steps.migrations = { found: before, expected: MIGRATIONS.length, ok: after === MIGRATIONS.length }
    if (!steps.migrations.ok) return result('The backup could not be brought up to date')
    steps.company = !!db.prepare("SELECT 1 FROM meta WHERE key = 'company'").get()
    if (!steps.company) return result('The backup has no business details — it is not a Total company file')
    const chain = verifyAudit(db)
    steps.auditChain = { ok: chain.ok, rows: chain.rows }
    if (!chain.ok) return result('The change history in the backup does not verify')
    const tb = trialBalance(db, opts.asOn)
    steps.balanced = { ok: tb.movementDebitTotal === tb.movementCreditTotal, debit: tb.movementDebitTotal, credit: tb.movementCreditTotal }
    if (!steps.balanced.ok) return result('The entries in the backup do not balance')
    return result(null)
  } catch (err) {
    return result(err instanceof Error ? err.message : String(err))
  } finally {
    try {
      db?.close()
    } catch {
      // closing a broken handle
    }
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  }
}

/** Store a check (backup_runs) and audit it. */
export function recordBackupCheck(db: DB, check: BackupCheck, user?: string): BackupCheck {
  db.prepare('INSERT INTO backup_runs (file, tag, encrypted, checked_at, ok, checks_json, error) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    check.file, check.tag, check.encrypted ? 1 : 0, check.checkedAt, check.ok ? 1 : 0, JSON.stringify(check.steps), check.error
  )
  writeAudit(db, 'backup_check', 0, 'create', null, { file: check.file, tag: check.tag, ok: check.ok, encrypted: check.encrypted, error: check.error }, user ? { user } : {})
  return check
}

interface RunRow {
  file: string
  tag: string
  encrypted: number
  checkedAt: string
  ok: number
  checksJson: string
  error: string | null
}

const fromRow = (r: RunRow): BackupCheck => {
  let steps: BackupCheckSteps
  try {
    steps = JSON.parse(r.checksJson) as BackupCheckSteps
  } catch {
    steps = { opens: false, quickCheck: false, migrations: null, auditChain: null, balanced: null, company: false }
  }
  return { file: r.file, tag: r.tag, encrypted: !!r.encrypted, checkedAt: r.checkedAt, ok: !!r.ok, steps, error: r.error }
}

/** The newest check, or null (none yet). */
export function latestBackupCheck(db: DB): BackupCheck | null {
  const r = db.prepare('SELECT file, tag, encrypted, checked_at AS checkedAt, ok, checks_json AS checksJson, error FROM backup_runs ORDER BY id DESC LIMIT 1').get() as RunRow | undefined
  return r ? fromRow(r) : null
}

export function listBackupChecks(db: DB, limit = 20): BackupCheck[] {
  return (db.prepare('SELECT file, tag, encrypted, checked_at AS checkedAt, ok, checks_json AS checksJson, error FROM backup_runs ORDER BY id DESC LIMIT ?').all(limit) as RunRow[]).map(fromRow)
}

/** Automatic backups are checked at most once a day (the newest one), and again right after a
 *  failed check; a backup the user asked for is always checked. */
export const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export function checkDue(db: DB, tag: string, now = new Date()): boolean {
  if (tag === 'manual') return true
  const last = latestBackupCheck(db)
  if (!last || !last.ok) return true
  const at = Date.parse(last.checkedAt)
  return !Number.isFinite(at) || now.getTime() - at >= AUTO_CHECK_INTERVAL_MS
}

/** Check `dest` (a backup just written from `db`) when one is due, with the handle's own key, and
 *  record it. Null when not due or the handle has gone (the company was closed meanwhile). */
export function checkBackupIfDue(db: DB, dest: string, tag: string, asOn: string, user?: string): BackupCheck | null {
  if (!db.open || !checkDue(db, tag)) return null
  const check = verifyBackupFile(dest, { asOn, key: isEncryptedFile(dest) ? keyOfHandle(db) : null })
  if (!db.open) return null
  return recordBackupCheck(db, check, user)
}
