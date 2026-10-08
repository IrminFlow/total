// WP 5.4 — what saving (or discarding) a capture draft does besides consuming it:
//   - a bill draft: the queue item is marked saved inside the save's transaction; the captured
//     file becomes the voucher's attachment (WP 6.4) only AFTER the save commits
//     (flushCaptureAttachments) — a rolled-back save leaves no stored copy behind;
//   - a statement-line draft: the line is reconciled (services/bankImport.reconcileSavedDraft);
//   - a discarded bill draft: the item goes back to 'needs_review' (answer or send again).
// None of this may fail the user's save: a problem is recorded on the draft's audit trail.
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

interface PendingAttach {
  db: DB
  draftId: number
  itemId: number
  voucherId: number
  companyDir: string
}
let pending: PendingAttach[] = []

export function afterDraftSaved(db: DB, draft: AiDraftDto, voucherId: number, ctx: DraftSaveContext): void {
  const p = draft.payload
  if (p.captureItemId) {
    const item = getItem(db, p.captureItemId)
    if (!item) writeAudit(db, 'ai_draft', draft.id, 'update', { status: 'open' }, { voucherId, captureItemId: p.captureItemId, note: 'the capture queue item was removed, so its file is not attached' })
    else {
      patchItem(db, item.id, { status: 'saved', voucherId, error: null }, true)
      if (ctx.companyDir) pending.push({ db, draftId: draft.id, itemId: item.id, voucherId, companyDir: ctx.companyDir })
    }
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

/** The save rolled back: forget the attachments it queued. */
export function dropPendingAttachments(): void {
  pending = []
}

/** After the save committed: attach each captured file to its voucher (own transaction each).
 *  A refused attachment (type policy, size cap, missing file) is noted on the draft and item. */
export function flushCaptureAttachments(): void {
  const work = pending
  pending = []
  for (const w of work) {
    try {
      const item = getItem(w.db, w.itemId)
      if (!item) continue
      const src = captureFilePath(captureFilesDir(w.companyDir), item.storedPath)
      if (!existsSync(src)) throw new Error('the captured file is missing, so it is not attached')
      w.db.transaction(() => addAttachment(w.db, join(w.companyDir, 'attachments'), { entity: 'voucher', entityId: w.voucherId }, src, item.fileName))()
    } catch (err) {
      const note = `the file could not be attached: ${(err as Error).message}`
      try {
        w.db.transaction(() => {
          patchItem(w.db, w.itemId, { error: note }, true)
          writeAudit(w.db, 'ai_draft', w.draftId, 'update', null, { voucherId: w.voucherId, captureItemId: w.itemId, note })
        })()
      } catch {
        /* company closed */
      }
    }
  }
}

/** A discarded bill draft sends its file back to 'needs_review' (the user can answer again,
 *  correct the masters and send again, or remove it). Called inside the discard's transaction. */
export function afterDraftDiscarded(db: DB, draft: AiDraftDto): void {
  const id = draft.payload.captureItemId
  if (!id) return
  const item = getItem(db, id)
  if (!item || item.draftId !== draft.id || item.status !== 'drafted') return
  patchItem(db, id, { status: 'needs_review', draftId: null, error: 'The draft was discarded — answer again, or send the file again' }, true)
}
