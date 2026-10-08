import { createHash } from 'crypto'
import { userInfo } from 'os'
import type { DB } from '../db/connection'
import { AUDIT_ACTIONS, VOUCHER_ENTITIES, auditActionLabel, auditEntityLabel, auditUserLabel, type AuditAction } from '@shared/auditEntities'
import {
  GENESIS_HASH, auditRowHash, auditTimestampText, clockSkewNote, localIsoWithOffset, rowStatuses, utcSqlDateTime, verificationSummary,
  verifyAuditChain, type AuditChainRow, type AuditRowStatus, type ChainVerification
} from '@shared/auditChain'
import { auditPruneCutoff } from '@shared/auditRetention'
import { diffJsonDeep, diffText } from '@shared/diff'
import { todayISO } from '@shared/dates'

/*
 * Audit trail (edit log) — WP 3.8. What the law asks for, and where each requirement lives:
 *
 * [R3] Companies (Accounts) Rules 2014, rule 3(1) proviso, inserted by the Companies (Accounts)
 *      Amendment Rules 2021, G.S.R. 205(E) of 24-03-2021 — accounting software must have "a
 *      feature of recording audit trail of each and every transaction, creating an edit log of
 *      each change made in books of account along with the date when such changes were made and
 *      ensuring that the audit trail cannot be disabled."
 *      https://egazette.gov.in/WriteReadData/2021/226081.pdf (accessed 2026-10-07)
 *      Deferred by G.S.R. 247(E) of 01-04-2021 (https://egazette.gov.in/WriteReadData/2021/226353.pdf)
 *      and G.S.R. 235(E) of 31-03-2022 (https://egazette.gov.in/WriteReadData/2022/234733.pdf) to
 *      1 April 2023 (both accessed 2026-10-07).
 * [R11] Companies (Audit and Auditors) Rules 2014, rule 11(g), G.S.R. 206(E) of 24-03-2021 — the
 *      auditor reports whether the software's audit trail "has been operated throughout the year
 *      for all transactions … has not been tampered with and … has been preserved … as per the
 *      statutory requirements for record retention."
 *      https://egazette.gov.in/WriteReadData/2021/226082.pdf (accessed 2026-10-07)
 * [S128] Companies Act 2013 s.128(5) — books for "not less than eight financial years immediately
 *      preceding a financial year". https://www.indiacode.nic.in/ (official page blocked when
 *      accessed 2026-10-07; text from its search snippet — UNVERIFIED wording, the 8-year figure
 *      is confirmed by [ICAI] para 19).
 * [ICAI] ICAI Implementation Guide on Reporting on Audit Trail under Rule 11(g), Revised 2024
 *      Edition (AASB): para 20 — capture "when changes were made … who made those changes …
 *      what data was changed", the trail "enabled at the database level … for logging any
 *      direct data changes" and "appropriately protected from any modification"; para 19 — retain
 *      for a minimum of eight years; FAQ 17 — the whole chain of changes, not just the latest;
 *      FAQ 25 — master-data changes too.
 *      https://www.eirc-icai.org/uploads/background_materials/Revised%202024_Implementation%20Guide%20on%20Reporting%20of%20Audit%20Trail%20(1)_1712114860.pdf
 *      (accessed 2026-10-07)
 * [GST] CGST Rules 2017 rule 56(8): for electronic records "a log of every entry edited or deleted
 *      shall be maintained"; CGST Act s.36: keep for 72 months from the annual-return due date.
 *      https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter7/rule56_v1.00.html
 *      (accessed 2026-10-07)
 * Income-tax retention (rule 6F 1962: six years from the end of the AY; Income-tax Rules 2026
 *      rule 46 reportedly seven tax years) is UNVERIFIED and shorter than [S128] in any case.
 *
 * How the app meets them:
 * - every write path calls writeAudit (registry test: src/main/auditCoverage.dbtest.ts) with the
 *   whole before/after record, the signed-in user (id + name; 'system' for migrations and
 *   scheduled jobs; 'os:<login>' when the company has no users), the app version, a UTC and a
 *   local-with-offset timestamp, and a monotonic id;
 * - there is no switch to turn it off, and no IPC that edits or deletes rows. Migration 031's
 *   triggers refuse UPDATE of a sealed row and any DELETE outside the retention job;
 * - retention: by default (`auditTrailRequired`, ON) nothing is ever deleted. With the flag
 *   off, rows older than the configured window may go, but never inside the s.128(5) floor
 *   (src/shared/auditRetention.ts) and never 'migration'/'prune' rows; every prune is itself
 *   logged with the id ranges it removed;
 * - tamper evidence: the SHA-256 hash chain (src/shared/auditChain.ts) — evident, not
 *   prevented: see the note there. Backups are whole-database copies, so they carry the audit
 *   log and its chain; restoring one restores its chain (verify after a restore).
 */

export { AUDIT_ENTITIES, AUDIT_ACTIONS, type AuditEntity, type AuditAction } from '@shared/auditEntities'

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

export interface AuditContext {
  /** Current app version, stamped onto every audit row (electron-builder's package.json version). */
  appVersion: string
  /** Resolves the signed-in user's display name, or null when the company has no users yet
   *  (unlocked) or no one is signed in. */
  getUserName: () => string | null
  /** The signed-in user's id (users.id), when there is one. */
  getUserId?: () => number | null
}

// Default before registerIpc() installs the real context (see ipc.ts) or in any test that
// doesn't call setAuditContext itself.
let context: AuditContext = { appVersion: '', getUserName: () => null }

/** Module-level audit context, set once at app startup (see ipc.ts's registerIpc). */
export function setAuditContext(ctx: AuditContext): void {
  context = ctx
}

/** The name writeAudit would stamp right now (signed-in user, else the OS login) — for tables
 *  that keep their own "by" column (WP 4.2 reminder_log / bill_followups). */
export function currentAuditUserName(): string {
  return context.getUserName() ?? osAuditUser()
}

/** User name stamped on rows written by migrations and scheduled jobs. */
export const SYSTEM_AUDIT_USER = 'system'

/** The OS login, for writes in a company without users (the app then has no sign-in at all). */
export function osAuditUser(): string {
  let name: string | undefined
  try {
    name = userInfo().username
  } catch {
    name = process.env.USER ?? process.env.USERNAME
  }
  return `os:${name && name.trim() ? name.trim() : 'unknown'}`
}

/**
 * Run `fn` with audit rows attributed to `userName` (e.g. 'agent-inbox' for drop-folder posts,
 * 'system' for the jobs that run when a company opens). Synchronous by design — the main
 * process is single-threaded and every service write is sync, so the swap cannot leak across
 * unrelated work. Restores the previous context even if `fn` throws.
 */
export function runAsAuditUser<T>(userName: string, fn: () => T): T {
  const prev = context
  context = { appVersion: prev.appVersion, getUserName: () => userName, getUserId: () => null }
  try {
    return fn()
  } finally {
    context = prev
  }
}

// ---------- chain plumbing ----------

const chainReady = new WeakSet<DB>()

/** True once migration 031 has added the hash-chain columns. Cached per handle once true. */
export function hasAuditChain(db: DB): boolean {
  if (chainReady.has(db)) return true
  const cols = db.prepare('PRAGMA table_info(audit_log)').all() as { name: string }[]
  const ok = cols.some((c) => c.name === 'row_hash')
  if (ok) chainReady.add(db)
  return ok
}

/** Highest audit_log id, 0 when empty or the table doesn't exist yet (migration runner). */
export function auditChainMaxId(db: DB): number {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'").get()
  if (!exists) return 0
  return (db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM audit_log').get() as { m: number }).m
}

interface ChainRowDb {
  id: number
  entity: string
  entityId: number
  action: string
  at: string
  atIso: string | null
  beforeJson: string | null
  afterJson: string | null
  userName: string | null
  userId: number | null
  appVersion: string | null
  clockSkewNote: string | null
  prevHash: string | null
  rowHash: string | null
}

const CHAIN_COLS = `id, entity, entity_id AS entityId, action, at, at_iso AS atIso, before_json AS beforeJson, after_json AS afterJson,
  user_name AS userName, user_id AS userId, app_version AS appVersion, clock_skew_note AS clockSkewNote, prev_hash AS prevHash, row_hash AS rowHash`

function lastSealedHash(db: DB): string {
  const r = db.prepare('SELECT row_hash AS h FROM audit_log WHERE row_hash IS NOT NULL ORDER BY id DESC LIMIT 1').get() as { h: string } | undefined
  return r?.h ?? GENESIS_HASH
}

/**
 * Hash rows that raw SQL inserted without one (migrations — see migrate.ts), in id order,
 * chaining from the last sealed row. Only rows with id > `afterId` are sealed, unless no row
 * has ever been sealed (the migration 031 backfill seals the whole existing log). Rows without
 * a user are attributed to 'system' first, except during the backfill (see below).
 * Returns the number of rows sealed.
 */
export function sealAuditChain(db: DB, afterId = 0): number {
  if (!hasAuditChain(db)) return 0
  const anySealed = db.prepare('SELECT 1 FROM audit_log WHERE row_hash IS NOT NULL LIMIT 1').get() !== undefined
  const rows = db
    .prepare(`SELECT ${CHAIN_COLS} FROM audit_log WHERE row_hash IS NULL AND id > ? ORDER BY id`)
    .all(anySealed ? afterId : 0) as ChainRowDb[]
  if (rows.length === 0) return 0
  let prev = lastSealedHash(db)
  const upd = db.prepare('UPDATE audit_log SET user_name = ?, prev_hash = ?, row_hash = ? WHERE id = ?')
  for (const r of rows) {
    // Backfill (nothing sealed yet): pre-031 rows keep their user as recorded — NULL stays NULL
    // (written before attribution existed); 031 itself already named its migration rows. Later
    // seals only ever see rows a migration just inserted, so those are 'system'.
    const sealed: Omit<AuditChainRow, 'rowHash'> = { ...r, userName: r.userName ?? (anySealed ? SYSTEM_AUDIT_USER : null), prevHash: prev }
    const h = auditRowHash(sealed, sha256Hex)
    upd.run(sealed.userName, prev, h, r.id)
    prev = h
  }
  return rows.length
}

export interface WriteAuditOptions {
  /** Attribute the row to this user instead of the session user (e.g. 'system'). */
  user?: string
}

/** Append one row to audit_log. before/after are JSON.stringify'd; null stays null (not '"null"').
 *  Hash-chained (see the header comment); the insert and its seal are one savepoint. */
export function writeAudit(
  db: DB,
  entity: string,
  entityId: number,
  action: AuditAction,
  before: unknown,
  after: unknown,
  opts: WriteAuditOptions = {}
): void {
  const beforeJson = before === null || before === undefined ? null : JSON.stringify(before)
  const afterJson = after === null || after === undefined ? null : JSON.stringify(after)
  const sessionName = opts.user ? null : context.getUserName()
  const userName = opts.user ?? sessionName ?? osAuditUser()
  const userId = opts.user || sessionName === null ? null : (context.getUserId?.() ?? null)
  const appVersion = context.appVersion

  if (!hasAuditChain(db)) {
    // Pre-031 schema (a migration-slice test, or a DB opened without migrating).
    db.prepare(
      `INSERT INTO audit_log (entity, entity_id, action, before_json, after_json, user_name, app_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(entity, entityId, action, beforeJson, afterJson, userName, appVersion)
    return
  }

  db.transaction(() => {
    const now = new Date()
    const at = utcSqlDateTime(now)
    const atIso = localIsoWithOffset(now)
    const last = db.prepare('SELECT at, at_iso AS atIso FROM audit_log ORDER BY id DESC LIMIT 1').get() as
      | { at: string; atIso: string | null }
      | undefined
    const skew = last ? clockSkewNote(last.atIso, last.at, atIso) : null
    const prevHash = lastSealedHash(db)
    const id = Number(
      db
        .prepare(
          `INSERT INTO audit_log (entity, entity_id, action, at, at_iso, before_json, after_json, user_name, user_id, app_version, clock_skew_note, prev_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(entity, entityId, action, at, atIso, beforeJson, afterJson, userName, userId, appVersion, skew, prevHash).lastInsertRowid
    )
    const rowHash = auditRowHash(
      { id, entity, entityId, action, at, atIso, beforeJson, afterJson, userName, userId, appVersion, clockSkewNote: skew, prevHash },
      sha256Hex
    )
    db.prepare('UPDATE audit_log SET row_hash = ? WHERE id = ?').run(rowHash, id)
  })()
}

// ---------- verification ----------

/** Walk the whole chain (every row, id order) and report the first break. Read-only. */
export function verifyAudit(db: DB): ChainVerification {
  if (!hasAuditChain(db)) {
    return { ok: false, rows: 0, firstId: null, headId: null, headHash: null, prunedRows: 0, issues: [], firstBreak: null }
  }
  const rows = db.prepare(`SELECT ${CHAIN_COLS} FROM audit_log ORDER BY id`).all() as ChainRowDb[]
  const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'audit_log'").get() as { seq: number } | undefined
  return verifyAuditChain(rows, sha256Hex, seq?.seq ?? null)
}

// ---------- retention ----------

const TRAIL_REQUIRED_KEY = 'audit.trailRequired'

/**
 * Whether this company must keep the full audit trail (Companies Act / rule 3(1) companies).
 * Defaults to ON — absent means required. While ON the retention job never deletes anything.
 */
export function getAuditTrailRequired(db: DB): boolean {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(TRAIL_REQUIRED_KEY) as { value: string } | undefined
  if (!row) return true
  try {
    return JSON.parse(row.value) !== false
  } catch {
    return true
  }
}

export function setAuditTrailRequired(db: DB, required: boolean): boolean {
  const before = getAuditTrailRequired(db)
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    TRAIL_REQUIRED_KEY,
    JSON.stringify(required)
  )
  if (before !== required) writeAudit(db, 'company', 0, 'update', { auditTrailRequired: before }, { auditTrailRequired: required })
  return required
}

/** Collapse sorted ids into inclusive [from, to] runs. */
function idRuns(ids: readonly number[]): [number, number][] {
  const out: [number, number][] = []
  for (const id of ids) {
    const last = out[out.length - 1]
    if (last && id === last[1] + 1) last[1] = id
    else out.push([id, id])
  }
  return out
}

/**
 * Audit retention: delete rows dated before the cutoff — the earlier of today − keepDays and the
 * s.128(5) floor (current FY + 8 preceding FYs always stay). Never runs while the company is
 * flagged audit-trail-required (the default), and never deletes 'migration' or 'prune' rows.
 * Writes one 'prune' row recording the id ranges removed, which is what lets the hash chain
 * verify across the gap. Returns the number of rows pruned.
 */
export function pruneAudit(db: DB, keepDays: number, today: string = todayISO()): number {
  if (getAuditTrailRequired(db)) return 0
  const cutoff = auditPruneCutoff(today, keepDays)
  const where = `COALESCE(substr(at_iso, 1, 10), date(at)) < ? AND entity <> 'migration' AND action <> 'prune'`
  const ids = (db.prepare(`SELECT id FROM audit_log WHERE ${where} ORDER BY id`).all(cutoff) as { id: number }[]).map((r) => r.id)
  if (ids.length === 0) return 0
  return db.transaction(() => {
    const guard = db.prepare("INSERT INTO meta (key, value) VALUES ('audit.pruneWindowOpen', '1') ON CONFLICT(key) DO UPDATE SET value = '1'")
    guard.run()
    try {
      db.prepare(`DELETE FROM audit_log WHERE ${where}`).run(cutoff)
    } finally {
      db.prepare("DELETE FROM meta WHERE key = 'audit.pruneWindowOpen'").run()
    }
    writeAudit(db, 'audit_log', 0, 'prune', null, { keepDays, cutoff, count: ids.length, ranges: idRuns(ids) }, { user: SYSTEM_AUDIT_USER })
    return ids.length
  })()
}

// ---------- reading: the edit-log report ----------

export interface AuditRow {
  id: number
  entity: string
  entityId: number
  action: AuditAction
  at: string
  atIso: string | null
  beforeJson: string | null
  afterJson: string | null
  userName: string | null
  userId: number | null
  appVersion: string | null
  clockSkewNote: string | null
  rowHash: string | null
  /** Human reference: the record's number / name / code when its JSON carries one. */
  ref: string | null
}

export interface AuditListQuery {
  entity?: string
  action?: string
  user?: string
  /** Rows about one voucher: the voucher entities by id, any other entity by a voucherId field. */
  voucherId?: number
  /** Inclusive lower bound, 'YYYY-MM-DD' (local date the row was written). */
  from?: string
  /** Inclusive upper bound, 'YYYY-MM-DD'. */
  to?: string
  page?: number
  /** Rows per page (default AUDIT_PAGE_SIZE). */
  pageSize?: number
}

export const AUDIT_PAGE_SIZE = 100

const jsonField = (col: string, path: string): string => `CASE WHEN json_valid(${col}) THEN json_extract(${col}, '${path}') END`
const REF_SQL = `COALESCE(${['$.number', '$.code', '$.name'].flatMap((p) => [jsonField('after_json', p), jsonField('before_json', p)]).join(', ')})`
const LOCAL_DATE_SQL = `COALESCE(substr(at_iso, 1, 10), date(at))`

function whereOf(query: AuditListQuery, chain: boolean): { where: string; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []
  const dateSql = chain ? LOCAL_DATE_SQL : 'date(at)'
  if (query.entity) {
    conditions.push('entity = ?')
    params.push(query.entity)
  }
  if (query.action) {
    conditions.push('action = ?')
    params.push(query.action)
  }
  if (query.user) {
    conditions.push('user_name = ?')
    params.push(query.user)
  }
  if (query.voucherId !== undefined) {
    const ents = VOUCHER_ENTITIES.map(() => '?').join(', ')
    conditions.push(
      `((entity IN (${ents}) AND entity_id = ?) OR ${jsonField('after_json', '$.voucherId')} = ? OR ${jsonField('before_json', '$.voucherId')} = ?)`
    )
    params.push(...VOUCHER_ENTITIES, query.voucherId, query.voucherId, query.voucherId)
  }
  if (query.from) {
    conditions.push(`${dateSql} >= ?`)
    params.push(query.from)
  }
  if (query.to) {
    conditions.push(`${dateSql} <= ?`)
    params.push(query.to)
  }
  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params }
}

function selectCols(chain: boolean): string {
  const base = `id, entity, entity_id AS entityId, action, at, before_json AS beforeJson, after_json AS afterJson,
    user_name AS userName, app_version AS appVersion, ${REF_SQL} AS ref`
  return chain
    ? `${base}, at_iso AS atIso, user_id AS userId, clock_skew_note AS clockSkewNote, row_hash AS rowHash`
    : `${base}, NULL AS atIso, NULL AS userId, NULL AS clockSkewNote, NULL AS rowHash`
}

const normaliseRef = (r: AuditRow): AuditRow => ({ ...r, ref: r.ref === null || r.ref === undefined ? null : String(r.ref) })

/** Server-side paged audit_log read, newest first, plus the distinct user names for the filter. */
export function listAudit(db: DB, query: AuditListQuery): { rows: AuditRow[]; total: number; users: string[] } {
  const page = query.page ?? 0
  const pageSize = query.pageSize ?? AUDIT_PAGE_SIZE
  const chain = hasAuditChain(db)
  const { where, params } = whereOf(query, chain)
  const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${where}`).get(...params) as { n: number }
  const rows = (
    db.prepare(`SELECT ${selectCols(chain)} FROM audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, page * pageSize) as AuditRow[]
  ).map(normaliseRef)
  const users = (db.prepare('SELECT DISTINCT user_name AS u FROM audit_log WHERE user_name IS NOT NULL ORDER BY user_name').all() as { u: string }[]).map((r) => r.u)
  return { rows, total: totalRow.n, users }
}

/** Upper bound on rows in one export — far above any realistic year of edits. */
export const AUDIT_EXPORT_MAX = 200_000

/** Every matching row, oldest first (the order an auditor reads a log in), for exports. */
export function auditRowsForExport(db: DB, query: AuditListQuery): AuditRow[] {
  const chain = hasAuditChain(db)
  const { where, params } = whereOf(query, chain)
  return (db.prepare(`SELECT ${selectCols(chain)} FROM audit_log ${where} ORDER BY id LIMIT ?`).all(...params, AUDIT_EXPORT_MAX) as AuditRow[]).map(normaliseRef)
}

export const STATUS_TEXT: Record<AuditRowStatus, string> = {
  verified: 'verified',
  altered: 'ALTERED',
  link_broken: 'CHAIN BROKEN',
  unsealed: 'NO HASH'
}

export interface EditLogExport {
  /** Header lines: company, period, filters, generation time, verification. */
  header: string[]
  columns: string[]
  rows: string[][]
  verification: ChainVerification
}

export const EDIT_LOG_COLUMNS = ['#', 'Date/time', 'User', 'Entity', 'Id / number', 'Action', 'Field-level changes', 'App version', 'Hash']

/** The edit-log report as rows of text — shared by the CSV, the PDF and the CA pack. */
export function editLogExport(
  db: DB,
  company: { name: string; gstin: string | null },
  query: AuditListQuery,
  opts: { diffMaxLen?: number; now?: Date } = {}
): EditLogExport {
  const verification = verifyAudit(db)
  const statuses = rowStatuses(verification)
  const rows = auditRowsForExport(db, query)
  const filters = [
    query.entity ? `entity ${auditEntityLabel(query.entity)}` : null,
    query.action ? `action ${auditActionLabel(query.action)}` : null,
    query.user ? `user ${query.user}` : null,
    query.voucherId !== undefined ? `voucher #${query.voucherId}` : null
  ].filter((x): x is string => x !== null)
  const now = opts.now ?? new Date()
  const header = [
    `Company: ${company.name}${company.gstin ? ` (GSTIN ${company.gstin})` : ''}`,
    `Period: ${query.from ?? 'beginning'} to ${query.to ?? 'today'}${filters.length ? ` · filters: ${filters.join(', ')}` : ''}`,
    `Generated: ${auditTimestampText(utcSqlDateTime(now), localIsoWithOffset(now))} by Total ${context.appVersion || ''}`.trim(),
    `Entries in this report: ${rows.length}${rows.length >= AUDIT_EXPORT_MAX ? ' (truncated)' : ''}`,
    verificationSummary(verification),
    'Amounts in the changes column are as stored: integer paise (2500000 = Rs 25,000.00); quantities in thousandths.',
    'Audit trail per Companies (Accounts) Rules 2014 r.3(1); verification walks the SHA-256 hash chain over every audit entry of the company (rule 11(g) reporting aid). It reveals edits to the file; it cannot prevent them.'
  ]
  const out = rows.map((r) => {
    const status: AuditRowStatus = statuses.get(r.id) ?? (r.rowHash ? 'verified' : 'unsealed')
    const changes = diffText(diffJsonDeep(r.beforeJson, r.afterJson), opts.diffMaxLen)
    return [
      String(r.id),
      auditTimestampText(r.at, r.atIso) + (r.clockSkewNote ? ' (clock went backwards)' : ''),
      r.userName === null ? 'unknown (before user attribution)' : auditUserLabel(r.userName),
      auditEntityLabel(r.entity),
      r.entityId === 0 ? (r.ref ?? '—') : r.ref ? `${r.entityId} · ${r.ref}` : String(r.entityId),
      auditActionLabel(r.action),
      changes || (r.beforeJson === null && r.afterJson === null ? '(no details)' : '(no field changes)'),
      r.appVersion ?? '',
      STATUS_TEXT[status]
    ]
  })
  return { header, columns: EDIT_LOG_COLUMNS, rows: out, verification }
}

export const isAuditAction = (a: string): a is AuditAction => (AUDIT_ACTIONS as readonly string[]).includes(a)
