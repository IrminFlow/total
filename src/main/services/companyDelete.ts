import Database from 'better-sqlite3'
import { existsSync, renameSync } from 'fs'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { log } from '../log'
import { ensureDeletedCompaniesDir, existingCompanyPaths } from '../paths'
import { AUTH_THROTTLE_MESSAGE, clearAuthFailures, isAuthThrottled, recordAuthFailure, usersExist } from './users'
import { verifyPin } from './authcrypt'
import { runAsAuditUser, writeAudit } from './audit'

/**
 * Authorizes deleting the company database at `dbPath`, called from company:delete (ipc.ts)
 * *after* the typed-name confirmation has already matched — that check alone protects nothing
 * once a company has users, since anyone at the pre-login company picker can read the name off
 * the same screen. This is the actual gate.
 *
 * - No DB file at `dbPath`: refuse. Other files in the company directory may be the only recovery
 *   material, and a missing DB cannot prove that the company was unprotected.
 * - DB exists but is corrupt/unreadable: refuse. Corruption must never bypass the owner-PIN gate.
 * - DB opens and has zero users: brand-new/never-logged-into company. Allow on the name check
 *   alone, same as today.
 * - DB opens and has users: `pin` must verify against SOME active owner's PIN hash. Throws
 *   otherwise.
 *
 * PIN attempts here consume the SAME persisted throttle as auth:login (meta `auth.fails.<id>`,
 * users.ts) — v0.3 review F3: company:delete was an unthrottled PIN oracle, letting a caller
 * brute-force '0000'..'9999' at full speed while the login screen was locked out. An owner locked
 * out at login is locked out here too; wrong delete-PINs count toward the login lockout and are
 * audited as 'login_failed'. (This is why the DB is opened read-write, not readonly.)
 *
 * Throws to refuse the delete; returns normally to allow it.
 */
export function assertDeleteAuthorized(dbPath: string, pin: string | undefined): void {
  if (!existsSync(dbPath)) {
    throw new Error('Company database is missing. Nothing was removed; use recovery tools or contact support.')
  }

  // SQLite opens the file lazily — a bogus/corrupt file doesn't fail the `new Database(...)`
  // call itself, only the first real read against it. So the "can we even read this?" probe
  // (open + usersExist) is one try/catch, separate from the PIN check below — otherwise a
  // corruption error and the intentional "protected" refusal would look identical to the caller.
  let db: Database.Database | null = null
  let hasUsers: boolean
  try {
    db = new Database(dbPath, { fileMustExist: true })
    const quickCheck = db.pragma('quick_check') as Array<{ quick_check: string }>
    if (quickCheck[0]?.quick_check !== 'ok') {
      throw new Error(`quick_check: ${quickCheck[0]?.quick_check ?? 'no result'}`)
    }
    hasUsers = usersExist(db)
  } catch (err) {
    db?.close()
    log('warn', 'company-delete-unreadable-db', {
      dbPath,
      error: err instanceof Error ? err.message : String(err)
    })
    throw new Error('Company database could not be verified. Nothing was removed; restore a backup or contact support.')
  }

  try {
    if (!hasUsers) return
    const owners = db
      .prepare("SELECT id, pin_hash AS pinHash FROM users WHERE role = 'owner' AND active = 1")
      .all() as { id: number; pinHash: string }[]
    const now = Date.now()
    // Locked-out owners are skipped entirely (their hash is never even checked, mirroring
    // login); when every active owner is locked out, refuse with the throttle message so the
    // caller can't distinguish PIN-space progress during the lockout window.
    const unlocked = owners.filter((o) => !isAuthThrottled(db!, o.id, now))
    if (owners.length > 0 && unlocked.length === 0) {
      throw new Error(AUTH_THROTTLE_MESSAGE)
    }
    const matched = pin === undefined ? undefined : unlocked.find((o) => verifyPin(pin, o.pinHash))
    if (!matched) {
      // Only an actual wrong guess consumes throttle budget — the pin-less first call is how the
      // UI discovers that the company is protected, not an attack.
      if (pin !== undefined) {
        for (const o of unlocked) recordAuthFailure(db, o.id, now)
      }
      throw new Error('This company is protected — an owner PIN is required to delete it')
    }
    clearAuthFailures(db, matched.id)
  } finally {
    db.close()
  }
}

export interface QuarantinedCompany {
  slug: string
  originalPath: string
  quarantinePath: string
}

/** Move a verified company directory into Total's recoverable holding area. This intentionally
 * uses a same-data-root rename: it is atomic, preserves the DB, WAL, attachments, exports and
 * backups together, and never degrades into recursive deletion. */
export function quarantineCompanyDirectory(slug: string): QuarantinedCompany {
  const { directory } = existingCompanyPaths(slug)
  const quarantineRoot = ensureDeletedCompaniesDir()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const quarantinePath = join(quarantineRoot, `${slug}-${stamp}-${randomUUID().slice(0, 8)}`)
  renameSync(directory, quarantinePath)
  return { slug, originalPath: directory, quarantinePath }
}

/** Best-effort transaction rollback used if registry removal fails after the directory move. */
export function restoreQuarantinedCompanyDirectory(move: QuarantinedCompany): void {
  if (existsSync(move.originalPath)) {
    throw new Error('Cannot restore quarantined company because its original path is occupied')
  }
  renameSync(move.quarantinePath, move.originalPath)
  // Re-validate the restored location before declaring rollback successful.
  existingCompanyPaths(move.slug)
}

/**
 * Record that a company is about to be deleted (task Q1 #90). The durable record is the app-level
 * log line the caller writes (log.ts lives outside the company dir, so it survives quarantine);
 * this additionally appends a best-effort audit row into the company DB itself moments before
 * deletion, so any copy of the file made after this point carries the tombstone. Never throws —
 * a corrupt/locked DB must not block the delete it was already authorized for.
 */
export function auditCompanyDeletion(dbPath: string, slug: string, userName: string | null): void {
  if (!existsSync(dbPath)) return
  let db: Database.Database | null = null
  try {
    db = new Database(dbPath)
    runAsAuditUser(userName ?? 'company-picker', () => writeAudit(db!, 'company', 0, 'delete', { slug }, null))
  } catch (err) {
    log('warn', 'company-delete-audit-write-failed', {
      dbPath,
      error: err instanceof Error ? err.message : String(err)
    })
  } finally {
    db?.close()
  }
}
