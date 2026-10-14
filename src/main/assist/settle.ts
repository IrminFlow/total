// Ask Total — consuming a draft when the simple flow saves it (WP 10.1). Kept apart from entry.ts
// so simple:post's handler pulls in only the draft store and the audit writer.
import type { DB } from '../db/connection'
import type { AiDraftDto } from '@shared/ai'
import { ASK_TOTAL_ORIGIN } from '@shared/assist'
import { writeAudit } from '../services/audit'
import { getDraft, setDraftStatus } from '../ai/store'

/** simple:post with `aiDraftId`: the flow saved what an Ask Total draft opened — consume it (in the
 *  post's transaction). Only an OPEN ask-total draft of the same intent kind is consumed; anything
 *  else is left alone (the entry is the user's own either way). */
export function settleAskDraft(db: DB, draftId: number, intentKind: string, voucherIds: readonly number[]): AiDraftDto | null {
  const d = getDraft(db, draftId)
  if (!d || d.source !== 'assistant' || d.origin !== ASK_TOTAL_ORIGIN || d.status !== 'open' || d.payload.simple?.kind !== intentKind) return null
  const voucherId = voucherIds[0] ?? null
  setDraftStatus(db, draftId, 'consumed', voucherId)
  const after = getDraft(db, draftId)!
  writeAudit(db, 'ai_draft', draftId, 'update', { status: d.status }, { status: after.status, ...(voucherId ? { voucherId } : {}), voucherIds: [...voucherIds] })
  return after
}
