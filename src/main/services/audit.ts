import type { DB } from '../db/connection'
import {
  AUDIT_GENESIS_HASH,
  auditRowHash,
  setAuditChainAnchor,
  setAuditChainHead,
  type AuditHashFields
} from '../db/auditHash'

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

/** Append one row to audit_log. before/after are JSON.stringify'd; null stays null (not '"null"'). */
export function writeAudit(
  db: DB,
  entity: string,
  entityId: number,
  action: AuditAction,
  before: unknown,
  after: unknown
): void {
  const beforeJson = before === null || before === undefined ? null : JSON.stringify(before)
  const afterJson = after === null || after === undefined ? null : JSON.stringify(after)
  const userName = context.getUserName()
  const appVersion = context.appVersion || null
  const at = new Date().toISOString()
  db.transaction(() => {
    const previous = db.prepare('SELECT id, row_hash AS rowHash FROM audit_log ORDER BY id DESC LIMIT 1').get() as
      | { id: number; rowHash: string }
      | undefined
    const prevHash = previous?.rowHash ?? AUDIT_GENESIS_HASH
    if (!/^[a-f0-9]{64}$/.test(prevHash)) throw new Error('Audit chain is not initialized or has a missing tail hash')
    const result = db.prepare(
      `INSERT INTO audit_log (
         entity, entity_id, action, at, before_json, after_json, user_name, app_version, prev_hash, row_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '')`
    ).run(entity, entityId, action, at, beforeJson, afterJson, userName, appVersion, prevHash)
    const id = Number(result.lastInsertRowid)
    const rowHash = auditRowHash({ id, entity, entityId, action, at, beforeJson, afterJson, userName, appVersion, prevHash })
    db.prepare('UPDATE audit_log SET row_hash = ? WHERE id = ?').run(rowHash, id)
    setAuditChainHead(db, id, rowHash)
  })()
}

/**
 * Audit retention (task Q1 #92): delete audit rows older than `keepDays`. Only ever called when
 * the company has an explicit `auditKeepDays` configured (see config.ts) — the default is to keep
 * the trail forever. Single batched SQL; returns the number of rows pruned.
 */
export function pruneAudit(db: DB, keepDays: number): number {
  const res = db.prepare(`DELETE FROM audit_log WHERE at < datetime('now', ?)`).run(`-${keepDays} days`)
  const first = db.prepare('SELECT prev_hash AS prevHash FROM audit_log ORDER BY id LIMIT 1').get() as { prevHash: string } | undefined
  if (first) setAuditChainAnchor(db, first.prevHash)
  else {
    setAuditChainAnchor(db, AUDIT_GENESIS_HASH)
    setAuditChainHead(db, 0, AUDIT_GENESIS_HASH)
  }
  return res.changes
}

export interface AuditIntegrityStatus {
  ok: boolean
  rowsChecked: number
  firstBrokenId: number | null
  reason: 'anchor_mismatch' | 'previous_hash_mismatch' | 'row_hash_mismatch' | 'head_mismatch' | null
  verifiedAt: string
  headHash: string
}

/** Verify row contents, ordering, links, retained-prefix anchor, and the separately stored tail. */
export function verifyAuditChain(db: DB): AuditIntegrityStatus {
  const rows = db.prepare(
    `SELECT id, entity, entity_id AS entityId, action, at, before_json AS beforeJson,
            after_json AS afterJson, user_name AS userName, app_version AS appVersion,
            prev_hash AS prevHash, row_hash AS rowHash
     FROM audit_log ORDER BY id`
  ).all() as (AuditHashFields & { rowHash: string })[]
  const meta = new Map((db.prepare("SELECT key, value FROM meta WHERE key IN ('audit_chain_anchor','audit_chain_head')").all() as { key: string; value: string }[]).map((row) => [row.key, row.value]))
  const verifiedAt = new Date().toISOString()
  const anchor = meta.get('audit_chain_anchor') ?? AUDIT_GENESIS_HASH
  const fail = (reason: AuditIntegrityStatus['reason'], firstBrokenId: number | null, headHash: string): AuditIntegrityStatus =>
    ({ ok: false, rowsChecked: rows.length, firstBrokenId, reason, verifiedAt, headHash })
  if (rows.length > 0 && rows[0]!.prevHash !== anchor) return fail('anchor_mismatch', rows[0]!.id, rows.at(-1)!.rowHash)
  let expectedPrev = anchor
  for (const row of rows) {
    if (row.prevHash !== expectedPrev) return fail('previous_hash_mismatch', row.id, rows.at(-1)!.rowHash)
    const computed = auditRowHash(row)
    if (row.rowHash !== computed) return fail('row_hash_mismatch', row.id, rows.at(-1)!.rowHash)
    expectedPrev = row.rowHash
  }
  let storedHead: { id: number; hash: string }
  try {
    storedHead = JSON.parse(meta.get('audit_chain_head') ?? '{}') as { id: number; hash: string }
  } catch {
    return fail('head_mismatch', rows.at(-1)?.id ?? null, expectedPrev)
  }
  const lastId = rows.at(-1)?.id ?? 0
  if (storedHead.id !== lastId || storedHead.hash !== expectedPrev) return fail('head_mismatch', lastId || null, expectedPrev)
  return { ok: true, rowsChecked: rows.length, firstBrokenId: null, reason: null, verifiedAt, headHash: expectedPrev }
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
