// WP 5.4 — what saving a capture draft does besides consuming it (called by settleDraftOnSave,
// inside the save's transaction, after the voucher saved):
//   - a bill draft: the captured file becomes the voucher's attachment (WP 6.4 — content-addressed
//     in the company's attachments folder, audited) and the queue item is marked saved;
//   - a statement-line draft: the line is reconciled (services/bankImport.reconcileSavedDraft).
// Neither may fail the user's save: a problem is recorded on the draft's audit trail instead.
import { existsSync } from 'fs'
import { join } from 'path'
import type { DB } from '../../db/connection'
import type { AiDraftDto } from '@shared/ai'
import { writeAudit } from '../../services/audit'
import { addAttachment } from '../../services/attachments'
import { reconcileSavedDraft } from '../../services/bankImport'
import { captureFilePath, captureFilesDir } from './files'
import { getItem, patchItem } from './store'

export interface DraftSaveContext {
  /** <dataRoot>/companies/<slug> — where capture/files and attachments live. */
  companyDir?: string
}

export function afterDraftSaved(db: DB, draft: AiDraftDto, voucherId: number, ctx: DraftSaveContext): void {
  const p = draft.payload
  if (p.captureItemId) {
    const item = getItem(db, p.captureItemId)
    const notes: string[] = []
    if (!item) notes.push('the capture queue item was removed, so its file is not attached')
    else if (!ctx.companyDir) notes.push('no company folder to attach the file from')
    else {
      const src = captureFilePath(captureFilesDir(ctx.companyDir), item.storedPath)
      if (!existsSync(src)) notes.push('the captured file is missing, so it is not attached')
      else {
        try {
          // A savepoint of its own: a refused attachment (type policy, size cap) leaves the save intact.
          db.transaction(() => addAttachment(db, join(ctx.companyDir!, 'attachments'), { entity: 'voucher', entityId: voucherId }, src, item.fileName))()
        } catch (err) {
          notes.push(`the file could not be attached: ${(err as Error).message}`)
        }
      }
      patchItem(db, item.id, { status: 'saved', voucherId, error: notes.length ? notes.join('; ') : null }, true)
    }
    if (notes.length) writeAudit(db, 'ai_draft', draft.id, 'update', { status: 'open' }, { voucherId, captureItemId: p.captureItemId, note: notes.join('; ') })
  }
  if (p.bankLine) {
    let r: { ok: true } | { ok: false; reason: string }
    try {
      r = db.transaction(() => reconcileSavedDraft(db, p.bankLine!.bankLedgerId, p.bankLine!.statementLineId, voucherId))()
    } catch (err) {
      r = { ok: false, reason: (err as Error).message }
    }
    if (!r.ok) {
      writeAudit(db, 'ai_draft', draft.id, 'update', { status: 'open' }, { voucherId, statementLineId: p.bankLine.statementLineId, note: `not reconciled: ${r.reason}` })
    }
  }
}
