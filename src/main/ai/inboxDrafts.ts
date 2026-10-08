// Inbox drops become drafts (WP 5.7). A voucher JSON dropped in <company>/inbox/ used to be
// POSTED straight into the books; it now becomes an ai_drafts row (source 'inbox', flagged
// `unrequested` — nobody in the app asked for it) that the user opens in the voucher editor and
// saves through voucher:save like any other draft. The proposal is checked exactly as the
// assistant's draft_voucher checks one (buildVoucherDraft: voucherInputSchema + validateVoucher +
// the lock date), so a drop that would not post is refused at drop time.
//
// A draft holds an accounting voucher (type, date, party, narration, reference, Dr/Cr lines). A
// drop that carries anything a draft cannot — stock lines, bill-wise references, TDS / TCS, cost
// allocations, a manual number, cheque details, foreign currency, post-dated / optional — is
// refused with the list of fields, never silently trimmed: drop it without them (and add them
// in the editor), or use `total-cli inbox --legacy-inbox-post` (deprecated) to post it as before.
import type { DB } from '../db/connection'
import type { VoucherInputParsed } from '@shared/schemas'
import type { AiDraftDto, AiVoucherDraftPayload } from '@shared/ai'
import { writeAudit } from '../services/audit'
import { buildVoucherDraft, DRAFTABLE_KINDS, type DraftVoucherInput } from './drafts'
import { insertDraft } from './store'

/** Paise → the rupee text draft_voucher takes ("1234.50"); integer maths only. */
export function paiseToRupeeText(paise: number): string {
  return `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`
}

/** Fields of a voucher drop that a draft cannot carry (empty = it can be drafted). */
export function undraftableFields(v: VoucherInputParsed): string[] {
  const out: string[] = []
  if (v.number) out.push('number')
  if (v.instrumentNo || v.instrumentDate) out.push('instrumentNo / instrumentDate')
  if (v.transporterId || v.vehicleNo || v.transportDistanceKm != null) out.push('transport details')
  if (v.posOverride) out.push('posOverride')
  if (v.currencyCode || v.exchangeRate != null) out.push('currencyCode / exchangeRate')
  if (v.postDated) out.push('postDated')
  if (v.isOptional) out.push('isOptional')
  if (v.inventory.length) out.push('inventory')
  if (v.billRefs.length) out.push('billRefs')
  if (v.tds) out.push('tds')
  if (v.tcs) out.push('tcs')
  if (v.trade) out.push('trade')
  if (v.lines.some((l) => l.costAllocations.length)) out.push('costAllocations')
  return out
}

/** Validate one dropped voucher as a draft proposal; throws with the reason when it cannot be one. */
export function inboxDraftProposal(db: DB, v: VoucherInputParsed, today: string): { payload: AiVoucherDraftPayload; summary: string } {
  const type = db.prepare('SELECT kind, name FROM voucher_types WHERE id = ?').get(v.voucherTypeId) as { kind: string; name: string } | undefined
  if (!type) throw new Error(`voucherTypeId ${v.voucherTypeId} does not exist`)
  if (!(DRAFTABLE_KINDS as readonly string[]).includes(type.kind)) {
    throw new Error(`${type.name} (${type.kind}) vouchers cannot be drafted from the inbox yet — only ${DRAFTABLE_KINDS.join(', ')}`)
  }
  const extra = undraftableFields(v)
  if (extra.length) throw new Error(`a draft cannot carry ${extra.join(', ')} — drop the voucher without them and add them in the editor`)
  const input: DraftVoucherInput = {
    kind: type.kind as DraftVoucherInput['kind'],
    voucherTypeId: v.voucherTypeId,
    date: v.date,
    narration: v.narration ?? undefined,
    reference: v.reference ?? undefined,
    lines: v.lines.map((l) => ({ ledgerId: l.ledgerId, drCr: l.drCr, amount: paiseToRupeeText(l.amount) }))
  }
  const { payload, summary } = buildVoucherDraft(db, input, today)
  return { payload: { ...payload, partyLedgerId: v.partyLedgerId ?? null }, summary }
}

/** Store validated proposals as flagged inbox drafts, audited (the caller holds the transaction). */
export function insertInboxDrafts(db: DB, fileName: string, proposals: readonly { payload: AiVoucherDraftPayload; summary: string }[]): AiDraftDto[] {
  return proposals.map((p) => {
    const d = insertDraft(db, { threadId: null, messageId: null, summary: p.summary, payload: p.payload, unrequested: true, source: 'inbox', origin: fileName })
    writeAudit(db, 'ai_draft', d.id, 'create', null, { summary: p.summary, payload: p.payload, source: 'inbox', origin: fileName, unrequested: true })
    return d
  })
}
