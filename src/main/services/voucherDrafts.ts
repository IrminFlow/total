import type { DB } from '../db/connection'
import type { VoucherKind } from '@shared/domain'
import type { VoucherDraftMode, VoucherWorkDraft, VoucherWorkDraftInput } from '@shared/voucherDrafts'
import { writeAudit } from './audit'

interface DraftRow {
  id: number; voucher_type_id: number; voucher_type_name: string; kind: VoucherKind
  mode: VoucherDraftMode; title: string; payload_version: number; payload_json: string
  created_by: string; created_at: string; updated_at: string
}

function mapDraft(row: DraftRow): VoucherWorkDraft {
  let payload: Record<string, unknown>
  try { payload = JSON.parse(row.payload_json) as Record<string, unknown> }
  catch { throw new Error(`Draft #${row.id} has invalid JSON and cannot be opened`) }
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') throw new Error(`Draft #${row.id} has an invalid payload`)
  return {
    id: row.id, voucherTypeId: row.voucher_type_id, voucherTypeName: row.voucher_type_name,
    kind: row.kind, mode: row.mode, title: row.title, payloadVersion: row.payload_version,
    payload, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at
  }
}

const SELECT = `SELECT d.*, vt.name AS voucher_type_name, vt.kind
  FROM voucher_drafts d JOIN voucher_types vt ON vt.id = d.voucher_type_id`

export function listVoucherDrafts(db: DB): VoucherWorkDraft[] {
  return (db.prepare(`${SELECT} ORDER BY d.updated_at DESC, d.id DESC`).all() as DraftRow[]).map(mapDraft)
}

export function getVoucherDraft(db: DB, id: number): VoucherWorkDraft | null {
  const row = db.prepare(`${SELECT} WHERE d.id = ?`).get(id) as DraftRow | undefined
  return row ? mapDraft(row) : null
}

export function saveVoucherDraft(db: DB, input: VoucherWorkDraftInput, author: string, id?: number): VoucherWorkDraft {
  const updating = id !== undefined
  const title = input.title.trim().replace(/\s+/g, ' ')
  if (!title || title.length > 120) throw new Error('Draft title must be between 1 and 120 characters')
  if (!db.prepare('SELECT 1 FROM voucher_types WHERE id = ?').get(input.voucherTypeId)) throw new Error('Voucher type was not found')
  const payloadJson = JSON.stringify(input.payload)
  if (Buffer.byteLength(payloadJson, 'utf8') > 262144) throw new Error('Draft is too large to save')
  if (id) {
    if (!getVoucherDraft(db, id)) throw new Error('Voucher draft was not found')
    db.prepare(`UPDATE voucher_drafts SET voucher_type_id = ?, mode = ?, title = ?, payload_version = ?,
      payload_json = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(input.voucherTypeId, input.mode, title, input.payloadVersion, payloadJson, id)
  } else {
    id = Number(db.prepare(`INSERT INTO voucher_drafts
      (voucher_type_id, mode, title, payload_version, payload_json, created_by)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(input.voucherTypeId, input.mode, title, input.payloadVersion, payloadJson, author.trim() || 'Local user').lastInsertRowid)
  }
  writeAudit(db, 'voucher_draft', id, updating ? 'update' : 'create', null, { title, mode: input.mode })
  return getVoucherDraft(db, id)!
}

export function deleteVoucherDraft(db: DB, id: number): void {
  const before = getVoucherDraft(db, id)
  if (!before) throw new Error('Voucher draft was not found')
  db.prepare('DELETE FROM voucher_drafts WHERE id = ?').run(id)
  writeAudit(db, 'voucher_draft', id, 'delete', { title: before.title }, null)
}
