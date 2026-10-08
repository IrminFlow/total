// Draft tools and the draft lifecycle (WP 5.1). `draft_voucher` validates a proposed accounting
// voucher exactly as saveVoucher would (voucherInputSchema + validateVoucher + the lock date) and
// writes an ai_drafts row — it NEVER saves a voucher. The user opens the draft in the voucher
// editor (VoucherEntry `aiDraftId`), and saving there goes through voucher:save → saveVoucher
// with all its checks; that save marks the draft consumed (consumeDraft, audited).
import { z } from 'zod'
import type { DB } from '../db/connection'
import { parseRupees, formatPaise } from '@shared/money'
import { isoDate, voucherInputSchema } from '@shared/schemas'
import { validateVoucher } from '@shared/posting'
import type { VoucherKind } from '@shared/domain'
import type { AiDraftDto, AiVoucherDraftPayload } from '@shared/ai'
import { getLockDate, ledgerFactsResolver } from '../services/vouchers'
import { writeAudit } from '../services/audit'
import { defineTool } from './tools/registry'
import { getDraft, insertDraft, setDraftStatus } from './store'

/** Accounting kinds the 5.1 drafting covers (invoices with stock lines come with WP 5.3). */
export const DRAFTABLE_KINDS = ['payment', 'receipt', 'contra', 'journal'] as const

const amountText = z
  .string()
  .trim()
  .regex(/^₹?\s?\d[\d,]*(\.\d{1,2})?$/, 'Amount in rupees as text, e.g. "5000" or "5,000.50"')
  .describe('Amount in rupees exactly as the user gave it, e.g. "5000" or "12,500.50" — never a computed figure')

export const draftVoucherInput = z.object({
  kind: z.enum(DRAFTABLE_KINDS).describe('payment = money out of cash/bank; receipt = money in; contra = between cash and bank; journal = no cash/bank'),
  voucherTypeId: z.number().int().positive().optional().describe('A specific voucher type of that kind; omit for the default'),
  date: isoDate.optional().describe('Voucher date (YYYY-MM-DD); omit for today'),
  narration: z.string().max(500).optional(),
  reference: z.string().max(120).optional(),
  lines: z
    .array(z.object({ ledgerId: z.number().int().positive(), drCr: z.enum(['dr', 'cr']), amount: amountText }))
    .min(2)
    .max(20)
    .describe('Debit and credit lines; debits must equal credits')
})
export type DraftVoucherInput = z.infer<typeof draftVoucherInput>

function ledgerName(db: DB, id: number): string {
  return (db.prepare('SELECT name FROM ledgers WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? `#${id}`
}

/** Validate a proposal and build the stored payload; throws with the reasons when it would not post. */
export function buildVoucherDraft(db: DB, input: DraftVoucherInput, today: string): { payload: AiVoucherDraftPayload; summary: string } {
  const type = input.voucherTypeId
    ? (db.prepare('SELECT id, kind, name FROM voucher_types WHERE id = ?').get(input.voucherTypeId) as { id: number; kind: VoucherKind; name: string } | undefined)
    : (db.prepare('SELECT id, kind, name FROM voucher_types WHERE kind = ? ORDER BY id LIMIT 1').get(input.kind) as
        | { id: number; kind: VoucherKind; name: string }
        | undefined)
  if (!type) throw new Error(`No ${input.kind} voucher type in this company`)
  if (type.kind !== input.kind) throw new Error(`Voucher type ${type.name} is a ${type.kind}, not a ${input.kind}`)

  const lines = input.lines.map((l, i) => {
    const amount = parseRupees(l.amount)
    if (amount === null || amount <= 0) throw new Error(`Line ${i + 1}: "${l.amount}" is not a positive rupee amount`)
    return { ledgerId: l.ledgerId, drCr: l.drCr, amount }
  })
  const date = input.date ?? today
  const voucher = voucherInputSchema.parse({
    voucherTypeId: type.id,
    date,
    partyLedgerId: null,
    narration: input.narration?.trim() || null,
    reference: input.reference?.trim() || null,
    lines: lines.map((l) => ({ ...l, costAllocations: [] })),
    inventory: [],
    billRefs: [],
    tds: null
  })
  const errors = validateVoucher(voucher, type.kind, ledgerFactsResolver(db))
  const dr = lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
  const cr = lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
  if (dr !== cr && !errors.some((e) => e.code === 'unbalanced')) errors.push({ code: 'unbalanced', message: `Debits (${formatPaise(dr)}) and credits (${formatPaise(cr)}) differ` })
  if (errors.length) throw new Error(errors.map((e) => e.message).join('; '))
  const lock = getLockDate(db)
  if (lock && date <= lock) throw new Error(`Books are locked up to ${lock}; pick a later date`)

  const drNames = lines.filter((l) => l.drCr === 'dr').map((l) => ledgerName(db, l.ledgerId))
  const crNames = lines.filter((l) => l.drCr === 'cr').map((l) => ledgerName(db, l.ledgerId))
  const summary = `${type.name} of ${formatPaise(dr, { symbol: true })} on ${date}: Dr ${drNames.join(', ')} / Cr ${crNames.join(', ')}`
  return {
    payload: { voucherTypeId: type.id, voucherKind: type.kind, date, partyLedgerId: null, narration: voucher.narration, reference: voucher.reference, lines },
    summary
  }
}

export const draftVoucherTool = defineTool({
  name: 'draft_voucher',
  description:
    'Prepare (NOT save) a payment, receipt, contra or journal voucher for the user to review. It is checked like a real save — balanced, known ledgers, not in a locked period — and stored as a draft; the user opens it in the voucher editor and saves it themselves.',
  input: draftVoucherInput,
  kind: 'draft',
  minRole: 'accountant',
  handler: (input, ctx) => {
    const { payload, summary } = buildVoucherDraft(ctx.db, input, ctx.today)
    const draft = ctx.db.transaction(() => {
      const d = insertDraft(ctx.db, { threadId: ctx.threadId, messageId: ctx.messageId, summary, payload })
      writeAudit(ctx.db, 'ai_draft', d.id, 'create', null, { summary, payload, threadId: ctx.threadId })
      return d
    })()
    return {
      data: { draftId: draft.id, status: 'open', summary, note: 'Draft only — nothing is in the books until the user reviews and saves it.' },
      draftId: draft.id,
      sources: [
        { kind: 'screen', screen: 'voucher-entry', label: 'Review draft', params: { aiDraftId: draft.id } },
        ...payload.lines.map((l) => ({ kind: 'ledger' as const, ledgerId: l.ledgerId, label: ledgerName(ctx.db, l.ledgerId) }))
      ]
    }
  }
})

/** voucher:save with `aiDraftId`: the saved voucher came from this draft. */
export function consumeDraft(db: DB, draftId: number, voucherId: number): AiDraftDto {
  const before = getDraft(db, draftId)
  if (!before) throw new Error('AI draft not found')
  if (before.status !== 'open') throw new Error(`This draft is already ${before.status}`)
  setDraftStatus(db, draftId, 'consumed', voucherId)
  const after = getDraft(db, draftId)!
  writeAudit(db, 'ai_draft', draftId, 'update', { status: before.status }, { status: after.status, voucherId })
  return after
}

/** voucher:save with `aiDraftId`: consume the draft when it is still open. A draft discarded or
 *  deleted (Delete all AI data, thread delete) while the user was reviewing it must not block the
 *  save — the voucher is the user's own; the audit trail records that the draft was no longer open. */
export function settleDraftOnSave(db: DB, draftId: number, voucherId: number): void {
  const d = getDraft(db, draftId)
  if (d?.status === 'open') {
    consumeDraft(db, draftId, voucherId)
    return
  }
  writeAudit(db, 'ai_draft', draftId, 'update', d ? { status: d.status } : null, {
    voucherId,
    note: d ? `draft no longer open (${d.status}); voucher saved without consuming it` : 'draft no longer exists; voucher saved without it'
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
