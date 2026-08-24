import type { DB } from '../db/connection'
import { writeAudit } from './audit'

export type VoucherAttachmentKind = 'invoice' | 'receipt' | 'email' | 'delivery' | 'other'
export interface VoucherAttachment {
  id: number
  voucherId: number
  originalName: string
  storedPath: string
  kind: VoucherAttachmentKind
  sizeBytes: number
  addedBy: string
  createdAt: string
}

interface AttachmentRow { id: number; voucher_id: number; original_name: string; stored_path: string; kind: VoucherAttachmentKind; size_bytes: number; added_by: string; created_at: string }
function mapAttachment(row: AttachmentRow): VoucherAttachment { return { id: row.id, voucherId: row.voucher_id, originalName: row.original_name, storedPath: row.stored_path, kind: row.kind, sizeBytes: row.size_bytes, addedBy: row.added_by, createdAt: row.created_at } }

export function listAttachments(db: DB, voucherId: number): VoucherAttachment[] {
  return (db.prepare('SELECT * FROM voucher_attachments WHERE voucher_id=? ORDER BY created_at,id').all(voucherId) as AttachmentRow[]).map(mapAttachment)
}

export function addAttachment(db: DB, input: { voucherId: number; originalName: string; storedPath: string; kind: VoucherAttachmentKind; sizeBytes: number; actor: string }): VoucherAttachment {
  if (!db.prepare('SELECT 1 FROM vouchers WHERE id=? AND deleted_at IS NULL').get(input.voucherId)) throw new Error('Voucher was not found')
  const id = Number(db.prepare('INSERT INTO voucher_attachments(voucher_id,original_name,stored_path,kind,size_bytes,added_by) VALUES(?,?,?,?,?,?)').run(input.voucherId, input.originalName, input.storedPath, input.kind, input.sizeBytes, input.actor).lastInsertRowid)
  writeAudit(db, 'voucher', input.voucherId, 'update', null, { attachmentAdded: id, kind: input.kind, originalName: input.originalName })
  return mapAttachment(db.prepare('SELECT * FROM voucher_attachments WHERE id=?').get(id) as AttachmentRow)
}

export interface SmartLedgerDefaults {
  sourceVoucherId: number
  narration: string | null
  billBehavior: 'against' | 'advance' | 'none'
  taxLedgerIds: number[]
  costAllocations: { ledgerId: number; costCentreId: number }[]
}

/** Derive an explicit, user-applied suggestion from the most recent posted voucher for a party. */
export function smartLedgerDefaults(db: DB, partyLedgerId: number, kind: string): SmartLedgerDefaults | null {
  const voucher = db.prepare(`SELECT v.id,v.narration FROM vouchers v JOIN voucher_types vt ON vt.id=v.voucher_type_id
    WHERE v.party_ledger_id=? AND vt.kind=? AND v.deleted_at IS NULL ORDER BY v.date DESC,v.id DESC LIMIT 1`).get(partyLedgerId, kind) as { id: number; narration: string | null } | undefined
  if (!voucher) return null
  const billKinds = db.prepare('SELECT DISTINCT kind FROM bill_refs WHERE voucher_id=?').all(voucher.id) as { kind: 'new' | 'against' }[]
  const billBehavior = billKinds.some((row) => row.kind === 'against') ? 'against' : billKinds.some((row) => row.kind === 'new') ? 'advance' : 'none'
  const taxLedgerIds = (db.prepare(`SELECT DISTINCT vl.ledger_id AS ledgerId FROM voucher_lines vl JOIN ledgers l ON l.id=vl.ledger_id WHERE vl.voucher_id=? AND l.tax_type IS NOT NULL`).all(voucher.id) as { ledgerId: number }[]).map((row) => row.ledgerId)
  const costAllocations = db.prepare(`SELECT DISTINCT vl.ledger_id AS ledgerId,a.cost_centre_id AS costCentreId FROM voucher_lines vl JOIN voucher_line_cost_allocations a ON a.voucher_line_id=vl.id WHERE vl.voucher_id=?`).all(voucher.id) as { ledgerId: number; costCentreId: number }[]
  return { sourceVoucherId: voucher.id, narration: voucher.narration, billBehavior, taxLedgerIds, costAllocations }
}

export function creditExposure(db: DB, partyLedgerId: number, proposedDebit: number): { exceeded: boolean; ledgerName: string; creditLimit: number | null; currentOutstanding: number; proposedOutstanding: number } {
  const row = db.prepare(`SELECT l.name,l.credit_limit AS creditLimit,l.opening_balance + COALESCE(SUM(CASE WHEN v.id IS NULL THEN 0 WHEN vl.dr_cr='dr' THEN vl.amount ELSE -vl.amount END),0) AS currentOutstanding FROM ledgers l LEFT JOIN voucher_lines vl ON vl.ledger_id=l.id LEFT JOIN vouchers v ON v.id=vl.voucher_id AND v.deleted_at IS NULL AND v.is_optional=0 AND v.post_dated=0 WHERE l.id=? GROUP BY l.id`).get(partyLedgerId) as { name: string; creditLimit: number | null; currentOutstanding: number } | undefined
  if (!row) throw new Error('Customer ledger was not found')
  const proposedOutstanding = row.currentOutstanding + proposedDebit
  return { exceeded: row.creditLimit != null && proposedOutstanding > row.creditLimit, ledgerName: row.name, creditLimit: row.creditLimit, currentOutstanding: row.currentOutstanding, proposedOutstanding }
}
