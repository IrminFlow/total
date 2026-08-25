import { createHash } from 'crypto'
import type { DB } from './connection'

export const AUDIT_GENESIS_HASH = '0'.repeat(64)

export interface AuditHashFields {
  id: number
  entity: string
  entityId: number
  action: string
  at: string
  beforeJson: string | null
  afterJson: string | null
  userName: string | null
  appVersion: string | null
  prevHash: string
}

/** Length-delimited by JSON's array encoding, so field boundaries and nulls are unambiguous. */
export function auditRowHash(row: AuditHashFields): string {
  return createHash('sha256').update(JSON.stringify([
    row.id,
    row.entity,
    row.entityId,
    row.action,
    row.at,
    row.beforeJson,
    row.afterJson,
    row.userName,
    row.appVersion,
    row.prevHash
  ])).digest('hex')
}

export function setAuditChainHead(db: DB, id: number, hash: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('audit_chain_head', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(JSON.stringify({ id, hash }))
}

export function setAuditChainAnchor(db: DB, hash: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('audit_chain_anchor', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(hash)
}

/** Migration-only backfill. Existing audit rows retain their ids and original timestamps. */
export function backfillAuditChain(db: DB): void {
  const rows = db.prepare(
    `SELECT id, entity, entity_id AS entityId, action, at, before_json AS beforeJson,
            after_json AS afterJson, user_name AS userName, app_version AS appVersion
     FROM audit_log ORDER BY id`
  ).all() as Omit<AuditHashFields, 'prevHash'>[]
  const update = db.prepare('UPDATE audit_log SET prev_hash = ?, row_hash = ? WHERE id = ?')
  let prevHash = AUDIT_GENESIS_HASH
  let lastId = 0
  for (const row of rows) {
    const rowHash = auditRowHash({ ...row, prevHash })
    update.run(prevHash, rowHash, row.id)
    prevHash = rowHash
    lastId = row.id
  }
  setAuditChainAnchor(db, AUDIT_GENESIS_HASH)
  setAuditChainHead(db, lastId, prevHash)
}
