// WP 5.4 — the persisted capture queue (capture_items, see the WP 5.4 migration). Every change
// an item goes through is audited as entity 'capture_item' with its METADATA only — file name,
// size, SHA-256, stored path, status, draft / voucher ids, error — never what the file says.
import type { DB } from '../../db/connection'
import type { CaptureItemDto, CaptureMapping, CaptureOrigin, CaptureReview, CaptureStatus } from '@shared/capture/types'
import { writeAudit } from '../../services/audit'
import { captureRefusal, cleanName, putCaptureFile, sha256Of, storedRel } from './files'
import { inspectDocument } from './prepare'

interface Row {
  id: number; kind: string; file_name: string; mime: string; size: number; sha256: string; stored_path: string; pages: number; text_layer: number
  origin: CaptureOrigin; status: CaptureStatus; error: string | null; attempts: number; added_by: string | null; approved_by: string | null
  extraction_json: string | null; review_json: string | null; mapping_json: string | null; supplier_name: string | null; supplier_ledger_id: number | null
  invoice_no: string | null; invoice_date: string | null; total: number | null; duplicate_kind: 'same_invoice' | 'same_amount' | null
  duplicate_voucher_id: number | null; draft_id: number | null; voucher_id: number | null; cost_micro_usd: number | null; created_at: string; updated_at: string
}

export interface CaptureItemRow extends CaptureItemDto {
  sha256: string
  storedPath: string
  approvedBy: string | null
  extractionJson: string | null
}

const parse = <T>(s: string | null): T | null => {
  if (s == null) return null
  try {
    return JSON.parse(s) as T
  } catch {
    return null
  }
}

function toItem(r: Row): CaptureItemRow {
  return {
    id: r.id, fileName: r.file_name, mime: r.mime, size: r.size, pages: r.pages, textLayer: r.text_layer === 1, origin: r.origin, status: r.status,
    error: r.error, attempts: r.attempts, addedBy: r.added_by, supplierName: r.supplier_name, supplierLedgerId: r.supplier_ledger_id, invoiceNo: r.invoice_no,
    invoiceDate: r.invoice_date, total: r.total, duplicateKind: r.duplicate_kind, duplicateVoucherId: r.duplicate_voucher_id, draftId: r.draft_id,
    voucherId: r.voucher_id, costMicroUsd: r.cost_micro_usd, createdAt: r.created_at, updatedAt: r.updated_at,
    review: parse<CaptureReview>(r.review_json), mapping: parse<CaptureMapping>(r.mapping_json),
    sha256: r.sha256, storedPath: r.stored_path, approvedBy: r.approved_by, extractionJson: r.extraction_json
  }
}

/** The renderer's view (no hash / path / raw extraction). */
export function toCaptureDto(i: CaptureItemRow): CaptureItemDto {
  const { sha256: _s, storedPath: _p, approvedBy: _a, extractionJson: _e, ...dto } = i
  return dto
}

/** What the audit trail records about an item. */
export function auditView(i: CaptureItemRow): Record<string, unknown> {
  return {
    fileName: i.fileName, size: i.size, sha256: i.sha256, path: `capture/files/${i.storedPath}`, origin: i.origin, status: i.status,
    ...(i.draftId ? { draftId: i.draftId } : {}), ...(i.voucherId ? { voucherId: i.voucherId } : {}), ...(i.error ? { error: i.error.slice(0, 300) } : {}),
    ...(i.duplicateVoucherId ? { duplicateVoucherId: i.duplicateVoucherId } : {})
  }
}

export function getItem(db: DB, id: number): CaptureItemRow | null {
  const r = db.prepare('SELECT * FROM capture_items WHERE id = ?').get(id) as Row | undefined
  return r ? toItem(r) : null
}

export function listItems(db: DB, limit = 1000): CaptureItemRow[] {
  return (db.prepare('SELECT * FROM capture_items ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map(toItem)
}

export function nextPending(db: DB): CaptureItemRow | null {
  const r = db.prepare("SELECT * FROM capture_items WHERE status = 'pending' ORDER BY id LIMIT 1").get() as Row | undefined
  return r ? toItem(r) : null
}

export const countByStatus = (db: DB, status: CaptureStatus): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM capture_items WHERE status = ?').get(status) as { n: number }).n

export interface ItemPatch {
  status?: CaptureStatus
  error?: string | null
  attempts?: number
  approvedBy?: string | null
  extractionJson?: string | null
  review?: CaptureReview | null
  mapping?: CaptureMapping | null
  supplierName?: string | null
  supplierLedgerId?: number | null
  invoiceNo?: string | null
  invoiceDate?: string | null
  total?: number | null
  duplicateKind?: 'same_invoice' | 'same_amount' | null
  duplicateVoucherId?: number | null
  draftId?: number | null
  voucherId?: number | null
  costMicroUsd?: number | null
}

const COLS: Record<keyof ItemPatch, string> = {
  status: 'status', error: 'error', attempts: 'attempts', approvedBy: 'approved_by', extractionJson: 'extraction_json', review: 'review_json', mapping: 'mapping_json',
  supplierName: 'supplier_name', supplierLedgerId: 'supplier_ledger_id', invoiceNo: 'invoice_no', invoiceDate: 'invoice_date', total: 'total',
  duplicateKind: 'duplicate_kind', duplicateVoucherId: 'duplicate_voucher_id', draftId: 'draft_id', voucherId: 'voucher_id', costMicroUsd: 'cost_micro_usd'
}

/** Update an item; `audit` writes one 'capture_item' row (metadata before / after). */
export function patchItem(db: DB, id: number, patch: ItemPatch, audit: boolean): CaptureItemRow {
  const before = getItem(db, id)
  if (!before) throw new Error('Capture item not found')
  const keys = Object.keys(patch) as (keyof ItemPatch)[]
  if (keys.length) {
    const vals = keys.map((k) => {
      const v = patch[k]
      return k === 'review' || k === 'mapping' ? (v == null ? null : JSON.stringify(v)) : (v as string | number | null)
    })
    db.prepare(`UPDATE capture_items SET ${keys.map((k) => `${COLS[k]} = ?`).join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(...vals, id)
  }
  const after = getItem(db, id)!
  if (audit) writeAudit(db, 'capture_item', id, 'update', auditView(before), auditView(after))
  return after
}

/** On company open: an item that was being processed when the app stopped goes back to the
 *  approved queue (it is sent again — at most one extra call). */
export function recoverQueue(db: DB): number {
  return db.prepare("UPDATE capture_items SET status = 'pending', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE status = 'processing'").run().changes
}

export interface IntakeResult {
  item: CaptureItemRow | null
  refusal: string | null
}

export type CheckedFile = { refusal: string } | { refusal: null; name: string; mime: string; pages: number; textLayer: boolean; sha256: string }

/** The async half of intake (the PDF is read off the main thread): type by extension AND
 *  content, size, password, page count. */
export async function checkCaptureFile(name: string, bytes: Buffer): Promise<CheckedFile> {
  const clean = cleanName(name)
  const { refusal, mime } = captureRefusal(clean, bytes)
  if (refusal) return { refusal }
  try {
    const doc = await inspectDocument(bytes, mime)
    return { refusal: null, name: clean, mime, pages: doc.pages, textLayer: doc.textLayer, sha256: sha256Of(bytes) }
  } catch (err) {
    return { refusal: `${clean}: ${(err as Error).message}` }
  }
}

/** The sync half: refuse the same file twice, store it content-addressed, insert 'queued'
 *  (nothing is sent until the user approves the estimate), audited. */
export function insertCaptureFile(db: DB, filesDir: string, checked: CheckedFile, f: { bytes: Buffer; origin: CaptureOrigin; addedBy: string | null }): IntakeResult {
  if (checked.refusal !== null) return { item: null, refusal: checked.refusal }
  const sha = checked.sha256
  const dup = db.prepare('SELECT id, file_name FROM capture_items WHERE sha256 = ? ORDER BY id LIMIT 1').get(sha) as { id: number; file_name: string } | undefined
  if (dup) return { item: null, refusal: `${checked.name} is already in the capture queue (item #${dup.id}, ${dup.file_name})` }
  const stored = putCaptureFile(filesDir, f.bytes)
  if (stored.rel !== storedRel(sha)) throw new Error('Capture store mismatch')
  const id = Number(
    db
      .prepare('INSERT INTO capture_items (file_name, mime, size, sha256, stored_path, pages, text_layer, origin, added_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(checked.name, checked.mime, f.bytes.length, sha, stored.rel, checked.pages, checked.textLayer ? 1 : 0, f.origin, f.addedBy).lastInsertRowid
  )
  const item = getItem(db, id)!
  writeAudit(db, 'capture_item', id, 'create', null, auditView(item))
  return { item, refusal: null }
}

/** Queue one file (check, then insert). The same file twice is refused. */
export async function addCaptureFile(db: DB, filesDir: string, f: { name: string; bytes: Buffer; origin: CaptureOrigin; addedBy: string | null }): Promise<IntakeResult> {
  return insertCaptureFile(db, filesDir, await checkCaptureFile(f.name, f.bytes), f)
}

/** Remove an item (and its stored file once no other item uses it). An open draft made from it
 *  stays (the user may still save it — the file is then missing, so no attachment). */
export function removeItem(db: DB, id: number): CaptureItemRow {
  const before = getItem(db, id)
  if (!before) throw new Error('Capture item not found')
  if (before.status === 'processing') throw new Error('This file is being read right now — stop the queue first')
  db.prepare('DELETE FROM capture_items WHERE id = ?').run(id)
  writeAudit(db, 'capture_item', id, 'delete', auditView(before), null)
  return before
}

export const fileStillUsed = (db: DB, sha: string): boolean => !!db.prepare('SELECT 1 FROM capture_items WHERE sha256 = ? LIMIT 1').get(sha)
