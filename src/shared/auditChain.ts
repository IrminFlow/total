/**
 * Audit-trail hash chain (WP 3.8) — pure, so the canonical form and the verifier are unit-tested
 * without a database. The SHA-256 itself is injected (`HashFn`): main passes node:crypto, tests
 * may do the same.
 *
 * Each audit_log row stores `prev_hash` (the previous row's `row_hash`, or GENESIS_HASH for the
 * first row) and `row_hash = sha256(canonicalAuditPayload(row))`, where the payload covers every
 * stored column of the row plus prev_hash. Editing any column of any row, deleting a row, or
 * inserting one in the middle breaks the chain from that point; the verifier reports the first
 * break and lists every inconsistency it finds.
 *
 * WHAT THIS IS AND IS NOT. The company file is an ordinary SQLite database on the user's own
 * machine (the app is fully offline). The chain makes tampering *evident* — a row changed with a
 * SQLite editor no longer verifies — but it cannot *prevent* it, and someone who also recomputes
 * every later hash with this published algorithm produces a chain that verifies again. The
 * defences against that are external anchors: the chain head (last row id + hash) printed on
 * every edit-log export and in the CA pack, which an auditor can compare with a later copy.
 * Restoring a backup restores that backup's chain (verify after a restore). Rows the app deletes
 * deliberately — only the retention job, and only when the company is not flagged
 * audit-trail-required — are recorded in a 'prune' row whose `ranges` cover the deleted ids, so
 * those gaps verify.
 *
 * Sources for what the edit log must contain — see src/main/services/audit.ts (header comment).
 */

export const GENESIS_HASH = '0'.repeat(64)

/** Version tag inside the canonical payload; bump (with a migration that re-hashes) if the
 *  payload layout ever changes. */
export const AUDIT_CHAIN_VERSION = 'total-audit-v1'

export type HashFn = (text: string) => string

/** The stored columns of one audit_log row that the hash covers. */
export interface AuditChainRow {
  id: number
  entity: string
  entityId: number
  action: string
  /** UTC 'YYYY-MM-DD HH:MM:SS' (SQLite datetime('now') format). */
  at: string
  /** Local ISO 8601 with offset and milliseconds (null on rows written before migration 031). */
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

/** Deterministic text the row hash is computed over: a JSON array in a fixed column order.
 *  JSON.stringify is deterministic for strings/numbers/null, so this never depends on key order. */
export function canonicalAuditPayload(r: Omit<AuditChainRow, 'rowHash'>): string {
  return JSON.stringify([
    AUDIT_CHAIN_VERSION,
    r.id,
    r.entity,
    r.entityId,
    r.action,
    r.at,
    r.atIso,
    r.beforeJson,
    r.afterJson,
    r.userName,
    r.userId,
    r.appVersion,
    r.clockSkewNote,
    r.prevHash
  ])
}

export function auditRowHash(r: Omit<AuditChainRow, 'rowHash'>, hash: HashFn): string {
  return hash(canonicalAuditPayload(r))
}

export type ChainIssueKind =
  /** The row's content no longer matches its own hash — a column was edited. */
  | 'altered'
  /** prev_hash does not match the previous row — rows were deleted (or inserted) here. */
  | 'link_broken'
  /** No hash at all — the row was inserted outside the app. */
  | 'unsealed'
  /** sqlite_sequence says rows were written after the last one present — the newest rows were deleted. */
  | 'missing_tail'

export interface ChainIssue {
  /** The row the problem was found at (for missing_tail: the last row present, or 0). */
  rowId: number
  kind: ChainIssueKind
  message: string
}

export interface ChainVerification {
  ok: boolean
  /** Rows checked. */
  rows: number
  firstId: number | null
  /** Chain head — what an auditor compares against a later copy. */
  headId: number | null
  headHash: string | null
  /** The first break in id order, or null when the chain verifies. */
  firstBreak: ChainIssue | null
  /** Every issue found (capped at MAX_ISSUES). */
  issues: ChainIssue[]
  /** Ids removed by recorded retention prunes (verified as legitimate gaps). */
  prunedRows: number
}

export const MAX_ISSUES = 200

/** A sorted, merged list of inclusive id ranges. */
export function mergeRanges(ranges: readonly (readonly [number, number])[]): [number, number][] {
  const sorted = ranges
    .filter((r) => Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[0] <= r[1])
    .map((r) => [r[0], r[1]] as [number, number])
    .sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1])
    else out.push([r[0], r[1]])
  }
  return out
}

/** True when every id in [from, to] (inclusive) is inside the merged ranges. Empty span → false. */
export function rangeCovered(merged: readonly [number, number][], from: number, to: number): boolean {
  if (from > to) return false
  let cursor = from
  for (const [a, b] of merged) {
    if (b < cursor) continue
    if (a > cursor) return false
    cursor = b + 1
    if (cursor > to) return true
  }
  return false
}

/** Id ranges recorded by the app's own 'prune' rows (after_json.ranges). Malformed JSON is ignored. */
export function prunedRangesOf(rows: readonly AuditChainRow[]): [number, number][] {
  const ranges: [number, number][] = []
  for (const r of rows) {
    if (r.action !== 'prune' || !r.afterJson) continue
    try {
      const parsed = JSON.parse(r.afterJson) as { ranges?: unknown }
      if (!Array.isArray(parsed.ranges)) continue
      for (const x of parsed.ranges) {
        if (Array.isArray(x) && x.length === 2 && typeof x[0] === 'number' && typeof x[1] === 'number') ranges.push([x[0], x[1]])
      }
    } catch {
      // a malformed prune row simply justifies nothing
    }
  }
  return mergeRanges(ranges)
}

/**
 * Walk the chain in id order. `rows` must be ALL audit_log rows sorted by id; `sequence` is
 * sqlite_sequence's value for audit_log (the highest id ever issued), or null if unknown.
 */
export function verifyAuditChain(rows: readonly AuditChainRow[], hash: HashFn, sequence: number | null = null): ChainVerification {
  const pruned = prunedRangesOf(rows)
  const issues: ChainIssue[] = []
  const add = (i: ChainIssue): void => {
    if (issues.length < MAX_ISSUES) issues.push(i)
  }
  let prev: AuditChainRow | null = null
  for (const r of rows) {
    if (!r.rowHash || !r.prevHash) {
      // The app chains past an unsealed row (writeAudit links to the last SEALED row), so the
      // walk does too: the forged row is reported once, the chain carries on unbroken.
      add({ rowId: r.id, kind: 'unsealed', message: `Row ${r.id} has no hash — it was written outside the app` })
      continue
    }
    const expected = auditRowHash(r, hash)
    if (expected !== r.rowHash) {
      add({ rowId: r.id, kind: 'altered', message: `Row ${r.id} was changed after it was written (its content no longer matches its hash)` })
    }
    const expectedPrev = prev ? prev.rowHash : GENESIS_HASH
    if (r.prevHash !== expectedPrev) {
      const gapFrom = prev ? prev.id + 1 : 1
      const gapTo = r.id - 1
      const justified = rangeCovered(pruned, gapFrom, gapTo)
      if (!justified) {
        const gap = gapTo >= gapFrom
          ? gapFrom === gapTo ? `row ${gapFrom} is missing` : `rows ${gapFrom}–${gapTo} are missing`
          : 'a row was inserted or reordered'
        add({ rowId: r.id, kind: 'link_broken', message: `Chain broken before row ${r.id}: ${gap}` })
      }
    }
    prev = r
  }
  const last = rows.length > 0 ? rows[rows.length - 1]! : null
  if (sequence !== null && sequence > (last?.id ?? 0)) {
    const from = (last?.id ?? 0) + 1
    if (!rangeCovered(pruned, from, sequence)) {
      add({
        rowId: last?.id ?? 0,
        kind: 'missing_tail',
        message: from === sequence ? `Row ${from} (the newest) is missing` : `Rows ${from}–${sequence} (the newest) are missing`
      })
    }
  }
  const sorted = [...issues].sort((a, b) => a.rowId - b.rowId)
  let prunedRows = 0
  for (const [a, b] of pruned) prunedRows += b - a + 1
  return {
    ok: issues.length === 0,
    rows: rows.length,
    firstId: rows[0]?.id ?? null,
    headId: last?.id ?? null,
    headHash: last?.rowHash ?? null,
    firstBreak: sorted[0] ?? null,
    issues: sorted,
    prunedRows
  }
}

/** One-line summary for export headers, the CA pack and the Audit screen banner. */
export function verificationSummary(v: ChainVerification): string {
  if (v.rows === 0 && v.ok) return 'Chain verified: no audit entries yet'
  if (v.ok) {
    return `Chain verified: ${v.rows} entries, rows ${v.firstId}–${v.headId}; head hash ${v.headHash}` +
      (v.prunedRows > 0 ? `; ${v.prunedRows} rows removed by recorded retention` : '')
  }
  const more = v.issues.length > 1 ? ` (+${v.issues.length - 1} more issue${v.issues.length > 2 ? 's' : ''})` : ''
  return `Chain BROKEN at row ${v.firstBreak!.rowId}: ${v.firstBreak!.message}${more}`
}

/** Per-row status for the edit-log report's "Hash" column. */
export type AuditRowStatus = 'verified' | 'altered' | 'link_broken' | 'unsealed'

export function rowStatuses(v: ChainVerification): Map<number, AuditRowStatus> {
  const m = new Map<number, AuditRowStatus>()
  for (const i of v.issues) {
    if (i.kind === 'missing_tail') continue
    // 'altered' outranks a broken link on the same row.
    if (m.get(i.rowId) === 'altered') continue
    m.set(i.rowId, i.kind as AuditRowStatus)
  }
  return m
}

/**
 * Clock-skew note for a new row: the machine is offline, so its clock is the only clock. If it
 * reads earlier than the previous row's time, the row is still appended (id order is the
 * authoritative sequence) but carries a note an auditor will see.
 */
export function clockSkewNote(prevAtIso: string | null, prevAtUtc: string | null, nowIso: string): string | null {
  const prevMs = prevAtIso ? Date.parse(prevAtIso) : prevAtUtc ? Date.parse(`${prevAtUtc.replace(' ', 'T')}Z`) : NaN
  const nowMs = Date.parse(nowIso)
  if (!Number.isFinite(prevMs) || !Number.isFinite(nowMs) || nowMs >= prevMs) return null
  const secs = Math.round((prevMs - nowMs) / 1000)
  return `System clock went backwards: this entry's time is ${secs}s earlier than the previous entry (${prevAtIso ?? `${prevAtUtc} UTC`}). Entry order (id) is authoritative.`
}

/** Local ISO 8601 with numeric offset, e.g. 2026-10-07T15:25:53.123+05:30. */
export function localIsoWithOffset(d: Date): string {
  const pad = (n: number, w = 2): string => String(Math.abs(n)).padStart(w, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  )
}

/** The timestamp as recorded, for reports: local time with its offset ('2026-10-07 15:25:53
 *  +05:30'), or the UTC `at` for rows written before migration 031 ('2026-10-07 09:55:53 UTC'). */
export function auditTimestampText(at: string, atIso: string | null): string {
  if (atIso && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(atIso)) {
    const offset = atIso.match(/([+-]\d{2}:\d{2}|Z)$/)?.[1] ?? ''
    return `${atIso.slice(0, 10)} ${atIso.slice(11, 19)}${offset ? ` ${offset === 'Z' ? 'UTC' : offset}` : ''}`
  }
  return `${at} UTC`
}

/** UTC 'YYYY-MM-DD HH:MM:SS' — the format of audit_log.at (SQLite datetime('now')). */
export function utcSqlDateTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ')
}
