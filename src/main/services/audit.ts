import type { DB } from '../db/connection'
import { buildDigest, type DailyDigest, type DigestAuditRow } from '@shared/digest'

// The write side owns the entity vocabulary; the list itself lives in src/shared so the
// Settings → Audit filter can import it too (renderer can't reach main-process modules).
export { AUDIT_ENTITIES, type AuditEntity } from '@shared/auditEntities'

/** Mirrors migration 017's audit_log action CHECK. 'login'/'login_failed'/'logout' come from the
 *  auth flow (users.ts + ipc.ts), 'export' from every file-export IPC handler, 'import' from bulk
 *  imports (Tally XML, bank statements). */
export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'login'
  | 'login_failed'
  | 'logout'
  | 'export'
  | 'import'

export interface AuditContext {
  /** Current app version, stamped onto every audit row (electron-builder's package.json version). */
  appVersion: string
  /** Resolves the signed-in user's display name, or null when the company has no users yet
   *  (unlocked) or no one is signed in. */
  getUserName: () => string | null
}

// Default before registerIpc() installs the real context (see ipc.ts) or in any test that
// doesn't call setAuditContext itself.
let context: AuditContext = { appVersion: '', getUserName: () => null }

/** Module-level audit context, set once at app startup (see ipc.ts's registerIpc). */
export function setAuditContext(ctx: AuditContext): void {
  context = ctx
}

/**
 * Run `fn` with audit rows attributed to `userName` (e.g. 'agent-inbox' for drop-folder posts,
 * inside an app whose session user would otherwise be stamped). Synchronous by design — the main
 * process is single-threaded and every service write is sync, so the swap cannot leak across
 * unrelated work. Restores the previous context even if `fn` throws.
 */
export function runAsAuditUser<T>(userName: string, fn: () => T): T {
  const prev = context
  context = { appVersion: prev.appVersion, getUserName: () => userName }
  try {
    return fn()
  } finally {
    context = prev
  }
}

/** The signed-in user's display name, or null. Exposed so a service that stamps its own
 *  `..._by` column (attachments, approvals, bank-detail requests) attributes it to exactly the
 *  same person the audit row will name, rather than reaching into ipc.ts for the session. */
export function currentAuditUser(): string | null {
  return context.getUserName()
}

/** Append one row to audit_log. before/after are JSON.stringify'd; null stays null (not '"null"'). */
export function writeAudit(
  db: DB,
  entity: string,
  entityId: number,
  action: AuditAction,
  before: unknown,
  after: unknown
): void {
  db.prepare(
    `INSERT INTO audit_log (entity, entity_id, action, before_json, after_json, user_name, app_version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entity,
    entityId,
    action,
    before === null || before === undefined ? null : JSON.stringify(before),
    after === null || after === undefined ? null : JSON.stringify(after),
    context.getUserName(),
    context.appVersion
  )
}

/**
 * Audit retention (task Q1 #92): delete audit rows older than `keepDays`. Only ever called when
 * the company has an explicit `auditKeepDays` configured (see config.ts) — the default is to keep
 * the trail forever. Single batched SQL; returns the number of rows pruned.
 */
export function pruneAudit(db: DB, keepDays: number): number {
  const res = db.prepare(`DELETE FROM audit_log WHERE at < datetime('now', ?)`).run(`-${keepDays} days`)
  return res.changes
}

export interface AuditRow {
  id: number
  entity: string
  entityId: number
  action: AuditAction
  at: string
  beforeJson: string | null
  afterJson: string | null
  userName: string | null
  appVersion: string | null
}

/**
 * One day's audit rows, oldest first, for the daily digest (roadmap V #390).
 *
 * `date(at, 'localtime')`, not `date(at)`: audit rows are stamped by SQLite's `datetime('now')`,
 * which is UTC, while the day an owner means by "yesterday" is the one they lived through. In
 * India that is UTC+5:30, so a plain UTC comparison files everything entered before 5:30 am under
 * the previous day — the digest would be quietly wrong every single morning.
 *
 * Unpaged and unlimited on purpose: a day of a small business's book is tens of rows, hundreds at
 * the very worst, and the digest has to count ALL of them — a page of 100 would report "100
 * changes" on the one day that mattered. The shaping into sections is pure (src/shared/digest.ts).
 */
export function auditRowsForDay(db: DB, date: string): DigestAuditRow[] {
  return db
    .prepare(
      `SELECT entity, entity_id AS entityId, action, at, user_name AS userName,
              before_json AS beforeJson, after_json AS afterJson
       FROM audit_log WHERE date(at, 'localtime') = ? ORDER BY id`
    )
    .all(date) as DigestAuditRow[]
}

/** The digest itself: the day's rows, shaped by the pure builder. */
export function dailyDigest(db: DB, date: string): DailyDigest {
  return buildDigest(date, auditRowsForDay(db, date))
}

export interface AuditListQuery {
  entity?: string
  /** One record's history. Ignored without `entity`: ids are per-entity, so voucher 7 and
   *  ledger 7 are different records and filtering on the id alone would mix them. */
  entityId?: number
  /** Inclusive lower bound, 'YYYY-MM-DD'. */
  from?: string
  /** Inclusive upper bound, 'YYYY-MM-DD'. */
  to?: string
  page?: number
  /** Rows per page (default AUDIT_PAGE_SIZE). */
  pageSize?: number
}

export const AUDIT_PAGE_SIZE = 100

/** Server-side paged audit_log read, newest first. `to` is inclusive (compares on date(at), not at). */
export function listAudit(db: DB, query: AuditListQuery): { rows: AuditRow[]; total: number } {
  const page = query.page ?? 0
  const pageSize = query.pageSize ?? AUDIT_PAGE_SIZE
  const conditions: string[] = []
  const params: unknown[] = []
  if (query.entity) {
    conditions.push('entity = ?')
    params.push(query.entity)
  }
  // Only meaningful alongside an entity: ids are per-entity, so voucher 7 and ledger 7 are
  // different records and filtering on the id alone would mix them.
  if (query.entityId != null && query.entity) {
    conditions.push('entity_id = ?')
    params.push(query.entityId)
  }
  if (query.from) {
    conditions.push('date(at) >= ?')
    params.push(query.from)
  }
  if (query.to) {
    conditions.push('date(at) <= ?')
    params.push(query.to)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${where}`).get(...params) as { n: number }

  const rows = db
    .prepare(
      `SELECT id, entity, entity_id AS entityId, action, at, before_json AS beforeJson, after_json AS afterJson,
              user_name AS userName, app_version AS appVersion
       FROM audit_log
       ${where}
       ORDER BY id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, page * pageSize) as AuditRow[]

  return { rows, total: totalRow.n }
}
