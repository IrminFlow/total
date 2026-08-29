import type { DB } from '../db/connection'
import type { VoucherEntryTemplate } from '@shared/entryTemplates'
import type { VoucherDraftMode, VoucherWorkDraftInput } from '@shared/voucherDrafts'
import type { VoucherKind } from '@shared/domain'
import { saveVoucherDraft } from './voucherDrafts'
import { writeAudit } from './audit'

interface Row { id: number; name: string; voucher_type_id: number; voucher_type_name: string; kind: VoucherKind; mode: VoucherDraftMode; payload_version: number; payload_json: string; created_by: string; created_at: string; updated_at: string }
const SELECT = `SELECT t.*, vt.name AS voucher_type_name, vt.kind FROM voucher_entry_templates t JOIN voucher_types vt ON vt.id = t.voucher_type_id`
function map(row: Row): VoucherEntryTemplate { return { id: row.id, name: row.name, voucherTypeId: row.voucher_type_id, voucherTypeName: row.voucher_type_name, kind: row.kind, mode: row.mode, payloadVersion: row.payload_version, payload: JSON.parse(row.payload_json) as Record<string, unknown>, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at } }

export function listEntryTemplates(db: DB): VoucherEntryTemplate[] { return (db.prepare(`${SELECT} ORDER BY t.name`).all() as Row[]).map(map) }
export function getEntryTemplate(db: DB, id: number): VoucherEntryTemplate | null { const row = db.prepare(`${SELECT} WHERE t.id = ?`).get(id) as Row | undefined; return row ? map(row) : null }
export function saveEntryTemplate(db: DB, input: VoucherWorkDraftInput & { name: string }, author: string): VoucherEntryTemplate {
  const name = input.name.trim().replace(/\s+/g, ' ')
  if (!name || name.length > 120) throw new Error('Template name must be between 1 and 120 characters')
  if (!db.prepare('SELECT 1 FROM voucher_types WHERE id = ?').get(input.voucherTypeId)) throw new Error('Voucher type was not found')
  const json = JSON.stringify(input.payload)
  if (Buffer.byteLength(json, 'utf8') > 262144) throw new Error('Template is too large to save')
  let id: number
  try { id = Number(db.prepare(`INSERT INTO voucher_entry_templates (name, voucher_type_id, mode, payload_version, payload_json, created_by) VALUES (?, ?, ?, ?, ?, ?)`).run(name, input.voucherTypeId, input.mode, input.payloadVersion, json, author.trim() || 'Local user').lastInsertRowid) }
  catch (error) { if (String(error).includes('UNIQUE')) throw new Error('An entry template with this name already exists'); throw error }
  writeAudit(db, 'entry_template', id, 'create', null, { name, mode: input.mode })
  return getEntryTemplate(db, id)!
}
export function instantiateEntryTemplate(db: DB, id: number, author: string) {
  const template = getEntryTemplate(db, id)
  if (!template) throw new Error('Entry template was not found')
  return saveVoucherDraft(db, { voucherTypeId: template.voucherTypeId, mode: template.mode, title: template.name, payloadVersion: template.payloadVersion, payload: template.payload }, author)
}
export function deleteEntryTemplate(db: DB, id: number): void { const row = getEntryTemplate(db, id); if (!row) throw new Error('Entry template was not found'); db.prepare('DELETE FROM voucher_entry_templates WHERE id = ?').run(id); writeAudit(db, 'entry_template', id, 'delete', { name: row.name }, null) }
