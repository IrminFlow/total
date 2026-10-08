// Drafts proposed by the GST 2B assistant (WP 5.5): a purchase for an invoice missing in the
// books, a debit note for an entry that overstates what the supplier reported. Built from a
// DraftPlan (src/shared/gst/mismatch2b.ts — amounts straight from the 2B document / the books),
// checked like a save would check it (voucherInputSchema + validateVoucher + the lock date) and
// stored as an ai_drafts row. NOTHING is posted: the user opens the draft in the voucher editor
// (VoucherEntry aiDraftId — a draft with ledger lines opens in accounting mode) and saves it
// through voucher:save, which consumes the draft.
import type { DB } from '../db/connection'
import { formatPaise } from '@shared/money'
import { voucherInputSchema } from '@shared/schemas'
import { validateVoucher } from '@shared/posting'
import type { VoucherKind } from '@shared/domain'
import type { AiDraftDto, AiVoucherDraftPayload } from '@shared/ai'
import { planLines, type DraftPlan } from '@shared/gst/mismatch2b'
import { getLockDate, ledgerFactsResolver } from '../services/vouchers'
import { descendantIdsByName } from '../services/masters'
import { writeAudit } from '../services/audit'
import { insertDraft } from './store'

const firstId = (db: DB, sql: string, ...args: unknown[]): number | null => (db.prepare(sql).get(...args) as { id: number } | undefined)?.id ?? null

/** Validate a plan and build the stored payload; throws with the reasons when it would not post. */
export function buildPlanDraft(db: DB, plan: DraftPlan): { payload: AiVoucherDraftPayload; summary: string } {
  const type = db.prepare('SELECT id, kind, name FROM voucher_types WHERE kind = ? ORDER BY id LIMIT 1').get(plan.kind) as { id: number; kind: VoucherKind; name: string } | undefined
  if (!type) throw new Error(`No ${plan.kind.replace('_', ' ')} voucher type in this company`)
  const purchaseGroups = [...descendantIdsByName(db, ['Purchase Accounts'])]
  const purchase = purchaseGroups.length
    ? firstId(db, `SELECT id FROM ledgers WHERE group_id IN (${purchaseGroups.map(() => '?').join(',')}) ORDER BY id LIMIT 1`, ...purchaseGroups)
    : null
  if (purchase == null) throw new Error('There is no ledger under Purchase Accounts — create one first')
  const tax = (t: string): number | null => firstId(db, 'SELECT id FROM ledgers WHERE tax_type = ? ORDER BY id LIMIT 1', t)
  const lines = planLines(plan, { purchase, igst: tax('igst'), cgst: tax('cgst'), sgst: tax('sgst'), cess: tax('cess') })
  if ('missing' in lines) throw new Error(`The company has no ${lines.missing.join(' / ')} ledger — create it (Duties & Taxes, with its tax type) first`)
  const voucher = voucherInputSchema.parse({
    voucherTypeId: type.id,
    date: plan.date,
    partyLedgerId: plan.partyLedgerId,
    narration: plan.narration,
    reference: plan.reference,
    lines: lines.map((l) => ({ ...l, costAllocations: [] })),
    inventory: [],
    billRefs: [],
    tds: null
  })
  const errors = validateVoucher(voucher, type.kind, ledgerFactsResolver(db))
  if (errors.length) throw new Error(errors.map((e) => e.message).join('; '))
  const lock = getLockDate(db)
  if (lock && plan.date <= lock) throw new Error(`Books are locked up to ${lock} — the draft would be dated ${plan.date}; unlock or re-date it in the editor`)
  const party = (db.prepare('SELECT name FROM ledgers WHERE id = ?').get(plan.partyLedgerId) as { name: string } | undefined)?.name ?? `#${plan.partyLedgerId}`
  const total = lines[lines.length - 1]!.amount
  const summary = `${type.name} of ${formatPaise(total, { symbol: true })} on ${plan.date} — ${party}, ref ${plan.reference}`
  return {
    payload: { voucherTypeId: type.id, voucherKind: type.kind, date: plan.date, partyLedgerId: plan.partyLedgerId, narration: voucher.narration, reference: voucher.reference, lines },
    summary
  }
}

/** Store a plan as a draft (audited). `origin` names the assistant when it came from the screen. */
export function insertPlanDraft(
  db: DB,
  plan: DraftPlan,
  o: { threadId: number | null; messageId: number | null; unrequested?: boolean; source?: 'chat'; origin?: string | null }
): AiDraftDto {
  const { payload, summary } = buildPlanDraft(db, plan)
  return db.transaction(() => {
    const d = insertDraft(db, { threadId: o.threadId, messageId: o.messageId, summary, payload, unrequested: o.unrequested, ...(o.source ? { source: o.source, origin: o.origin ?? null } : {}) })
    writeAudit(db, 'ai_draft', d.id, 'create', null, { summary, payload, threadId: o.threadId, unrequested: !!o.unrequested, origin: d.origin })
    return d
  })()
}
