import type { DB } from '../db/connection'

export type AuditAction = 'create' | 'update' | 'delete'

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

export interface AuditListQuery {
  entity?: string
  /** Inclusive lower bound, 'YYYY-MM-DD'. */
  from?: string
  /** Inclusive upper bound, 'YYYY-MM-DD'. */
  to?: string
  page?: number
}

export const AUDIT_PAGE_SIZE = 100

/** Server-side paged audit_log read, newest first. `to` is inclusive (compares on date(at), not at). */
export function listAudit(db: DB, query: AuditListQuery): { rows: AuditRow[]; total: number } {
  const page = query.page ?? 0
  const conditions: string[] = []
  const params: unknown[] = []
  if (query.entity) {
    conditions.push('entity = ?')
    params.push(query.entity)
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
    .all(...params, AUDIT_PAGE_SIZE, page * AUDIT_PAGE_SIZE) as AuditRow[]

  return { rows, total: totalRow.n }
}
