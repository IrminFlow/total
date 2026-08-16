import Database from 'better-sqlite3'
import { existsSync } from 'fs'
import { log } from '../log'
import { usersExist } from './users'
import { verifyPin } from './authcrypt'

/**
 * Authorizes deleting the company database at `dbPath`, called from company:delete (ipc.ts)
 * *after* the typed-name confirmation has already matched — that check alone protects nothing
 * once a company has users, since anyone at the pre-login company picker can read the name off
 * the same screen. This is the actual gate.
 *
 * - No DB file at `dbPath` (already gone, or never created): nothing to protect. Allow.
 * - DB exists but won't open read-only (corrupt/unreadable): it can't prove it has users either
 *   way, and deleting is the only way out of a company stuck like that — allow, but log loudly
 *   so an attempt to dodge the PIN gate by corrupting the file doesn't pass silently.
 * - DB opens and has zero users: brand-new/never-logged-into company. Allow on the name check
 *   alone, same as today.
 * - DB opens and has users: `pin` must verify against SOME active owner's PIN hash. Throws
 *   otherwise.
 *
 * Throws to refuse the delete; returns normally to allow it.
 */
export function assertDeleteAuthorized(dbPath: string, pin: string | undefined): void {
  if (!existsSync(dbPath)) return

  // SQLite opens the file lazily — a bogus/corrupt file doesn't fail the `new Database(...)`
  // call itself, only the first real read against it. So the "can we even read this?" probe
  // (open + usersExist) is one try/catch, separate from the PIN check below — otherwise a
  // corruption error and the intentional "protected" refusal would look identical to the caller.
  let db: Database.Database | null = null
  let hasUsers: boolean
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
    hasUsers = usersExist(db)
  } catch (err) {
    db?.close()
    log('warn', 'company-delete-unreadable-db', {
      dbPath,
      error: err instanceof Error ? err.message : String(err)
    })
    return
  }

  try {
    if (!hasUsers) return
    const owners = db
      .prepare("SELECT pin_hash AS pinHash FROM users WHERE role = 'owner' AND active = 1")
      .all() as { pinHash: string }[]
    const verified = pin !== undefined && owners.some((o) => verifyPin(pin, o.pinHash))
    if (!verified) throw new Error('This company is protected — an owner PIN is required to delete it')
  } finally {
    db.close()
  }
}

/**
 * Record that a company is about to be deleted (task Q1 #90). The durable record is the app-level
 * log line the caller writes (log.ts lives outside the company dir, so it survives the rmSync);
 * this additionally appends a best-effort audit row into the company DB itself moments before
 * deletion, so any copy of the file made after this point carries the tombstone. Never throws —
 * a corrupt/locked DB must not block the delete it was already authorized for.
 */
export function auditCompanyDeletion(dbPath: string, slug: string, userName: string | null): void {
  if (!existsSync(dbPath)) return
  let db: Database.Database | null = null
  try {
    db = new Database(dbPath)
    db.prepare(
      `INSERT INTO audit_log (entity, entity_id, action, before_json, after_json, user_name, app_version)
       VALUES ('company', 0, 'delete', ?, NULL, ?, NULL)`
    ).run(JSON.stringify({ slug }), userName)
  } catch (err) {
    log('warn', 'company-delete-audit-write-failed', {
      dbPath,
      error: err instanceof Error ? err.message : String(err)
    })
  } finally {
    db?.close()
  }
}
