// The draft lifecycle (WP 5.1) and the WP 5.1 entry points kept for callers and tests.
// The draft tools themselves live in drafting/ (WP 5.3: every voucher kind, name resolution with
// clarification, the editor's own form state, a rehearsed save). A draft tool NEVER saves a
// voucher: the user opens the draft in its editor (VoucherEntry / TradeDocEntry `aiDraftId`),
// and saving there goes through voucher:save / manufacture:save / tradeDocs:save with all their
// checks; that save marks the draft consumed (settleDraftOnSave, audited).
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { AiDraftDto, AiVoucherDraftPayload } from '@shared/ai'
import { readCompanyInfo } from '../db/seed'
import { writeAudit } from '../services/audit'
import { getDraft, setDraftStatus } from './store'
import { DraftWork, NeedsClarification, loadMasters } from './drafting/work'
import { buildAccountingDraft } from './drafting/builders'
import { DRAFTABLE_KINDS, draftVoucherInput, draftVoucherTool, isRequestedDraft, type DraftVoucherInput } from './drafting/tools'

export { DRAFTABLE_KINDS, draftVoucherInput, draftVoucherTool, isRequestedDraft, type DraftVoucherInput }

/** Validate an accounting proposal and build the stored payload; throws with the reasons when it
 *  would not post (or needs a clarification). */
export function buildVoucherDraft(
  db: DB,
  input: DraftVoucherInput,
  today: string,
  company?: CompanyInfo
): { payload: AiVoucherDraftPayload; summary: string } {
  const w = new DraftWork(loadMasters(db, company ?? readCompanyInfo(db), today))
  try {
    return buildAccountingDraft(w, draftVoucherInput.parse(input))
  } catch (err) {
    if (err instanceof NeedsClarification) throw new Error(w.clarifications.map((c) => c.question).join(' '))
    throw err
  }
}

/** What a save produced from a draft: a voucher (every voucher kind, manufacture included) or a
 *  trade document (quotation / order — ai_drafts.voucher_id stays null; the audit row names it). */
export interface DraftSaveTarget {
  voucherId?: number | null
  tradeDocId?: number | null
}

function targetOf(t: number | DraftSaveTarget): DraftSaveTarget {
  return typeof t === 'number' ? { voucherId: t } : t
}

/** The save consumed the draft. */
export function consumeDraft(db: DB, draftId: number, saved: number | DraftSaveTarget): AiDraftDto {
  const t = targetOf(saved)
  const before = getDraft(db, draftId)
  if (!before) throw new Error('AI draft not found')
  if (before.status !== 'open') throw new Error(`This draft is already ${before.status}`)
  setDraftStatus(db, draftId, 'consumed', t.voucherId ?? null)
  const after = getDraft(db, draftId)!
  writeAudit(db, 'ai_draft', draftId, 'update', { status: before.status }, { status: after.status, ...(t.voucherId ? { voucherId: t.voucherId } : {}), ...(t.tradeDocId ? { tradeDocId: t.tradeDocId } : {}) })
  return after
}

/** A save with `aiDraftId`: consume the draft when it is still open. A draft discarded or
 *  deleted (Delete all AI data, thread delete) while the user was reviewing it must not block the
 *  save — the entry is the user's own; the audit trail records that the draft was no longer open. */
export function settleDraftOnSave(db: DB, draftId: number, saved: number | DraftSaveTarget): void {
  const t = targetOf(saved)
  const d = getDraft(db, draftId)
  if (d?.status === 'open') {
    consumeDraft(db, draftId, t)
    return
  }
  writeAudit(db, 'ai_draft', draftId, 'update', d ? { status: d.status } : null, {
    ...(t.voucherId ? { voucherId: t.voucherId } : {}),
    ...(t.tradeDocId ? { tradeDocId: t.tradeDocId } : {}),
    note: d ? `draft no longer open (${d.status}); saved without consuming it` : 'draft no longer exists; saved without it'
  })
}

export function discardDraft(db: DB, draftId: number): AiDraftDto {
  const before = getDraft(db, draftId)
  if (!before) throw new Error('AI draft not found')
  if (before.status !== 'open') throw new Error(`This draft is already ${before.status}`)
  setDraftStatus(db, draftId, 'discarded')
  const after = getDraft(db, draftId)!
  writeAudit(db, 'ai_draft', draftId, 'update', { status: before.status }, { status: after.status })
  return after
}
