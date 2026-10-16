// Ask Total — consuming a draft when the simple flow saves it (WP 10.1). Kept apart from entry.ts
// so simple:post's handler pulls in only the draft store and the audit writer.
import type { DB } from '../db/connection'
import type { AiDraftDto } from '@shared/ai'
import { ASK_TOTAL_ORIGIN } from '@shared/assist'
import { writeAudit } from '../services/audit'
import { getDraft, listDrafts, setDraftStatus } from '../ai/store'

/** WP 10.6: the simple flow a chat (AI panel) draft of each voucher kind opens in — the panel's
 *  `draftOffer` (shared/simple/aiPlain.ts) uses the same pairs. */
export const CHAT_DRAFT_INTENT: Readonly<Record<string, string>> = { sales: 'sale', purchase: 'purchase', payment: 'money_out', receipt: 'money_in' }

/** A chat draft the simple flow may consume: an open AI-panel draft of that flow's kind, made in
 *  the accounting / invoice editor's form, and not a capture or statement-line draft (those settle
 *  through voucher:save, which attaches the file / reconciles the line). */
function chatDraftFits(d: AiDraftDto, intentKind: string): boolean {
  const form = d.payload.form ?? 'accounting'
  return d.source === 'chat' && (form === 'accounting' || form === 'invoice') && !d.payload.captureItemId && !d.payload.bankLine && CHAT_DRAFT_INTENT[d.payload.voucherKind] === intentKind
}

/** simple:post with `aiDraftId`: the flow saved what an Ask Total draft — or (WP 10.6) a draft the
 *  AI panel offered as "Save this as a bill?" — opened: consume it (in the post's transaction).
 *  Only an OPEN ask-total draft of the same intent kind, or an open chat draft whose voucher kind
 *  maps to it, is consumed; anything else is left alone (the entry is the user's own either way). */
export function settleAskDraft(db: DB, draftId: number, intentKind: string, voucherIds: readonly number[]): AiDraftDto | null {
  const d = getDraft(db, draftId)
  if (!d || d.status !== 'open') return null
  const askTotal = d.source === 'assistant' && d.origin === ASK_TOTAL_ORIGIN && d.payload.simple?.kind === intentKind
  if (!askTotal && !chatDraftFits(d, intentKind)) return null
  const voucherId = voucherIds[0] ?? null
  setDraftStatus(db, draftId, 'consumed', voucherId)
  const after = getDraft(db, draftId)!
  writeAudit(db, 'ai_draft', draftId, 'update', { status: d.status }, { status: after.status, ...(voucherId ? { voucherId } : {}), voucherIds: [...voucherIds] })
  return after
}

/** An open Ask Total draft (source 'assistant', origin 'ask-total'). */
export const isOpenAskDraft = (d: AiDraftDto | null): d is AiDraftDto =>
  !!d && d.status === 'open' && d.source === 'assistant' && d.origin === ASK_TOTAL_ORIGIN && !!d.payload.simple

const askerOf = (d: AiDraftDto): string | null => d.payload.simple?.askedBy ?? null

/** Discard one open Ask Total draft — status 'discarded', audited exactly as Settings → AI drafts'
 *  Discard (ai/drafts.ts discardDraft: the status before / after). */
function discard(db: DB, d: AiDraftDto): AiDraftDto {
  setDraftStatus(db, d.id, 'discarded')
  const after = getDraft(db, d.id)!
  writeAudit(db, 'ai_draft', d.id, 'update', { status: d.status }, { status: after.status })
  return after
}

/** assist:draft:discard — the flow an Ask Total draft opened was left without saving: the draft
 *  goes (it never stays open in Settings → AI drafts). Only an OPEN Ask Total draft asked by the
 *  same person; anything else (a chat draft, one already saved or discarded, someone else's) is
 *  left alone and null comes back. */
export function discardAskDraft(db: DB, draftId: number, askedBy: string | null): AiDraftDto | null {
  const d = getDraft(db, draftId)
  if (!isOpenAskDraft(d) || askerOf(d) !== askedBy) return null
  return db.transaction(() => discard(db, d))()
}

/** A new Ask Total draft replaces the person's older open ones (one open at a time). Call inside
 *  the transaction that inserts the new draft. */
export function discardOlderAskDrafts(db: DB, askedBy: string | null, keepId: number): number[] {
  const older = listDrafts(db, 'open', undefined, ['assistant']).filter((d) => d.id !== keepId && isOpenAskDraft(d) && askerOf(d) === askedBy)
  return older.map((d) => discard(db, d).id)
}
