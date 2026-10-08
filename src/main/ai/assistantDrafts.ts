// Drafts proposed by the GST 2B assistant (WP 5.5): a purchase for an invoice missing in the
// books, a debit note for an entry that overstates what the supplier reported. A DraftPlan
// (src/shared/gst/mismatch2b.ts — amounts straight from the 2B document / the books) becomes
// ledger lines and goes through the WP 5.3 drafting pipeline: buildLedgerInvoiceDraft builds the
// accounting form's own state, the save is rehearsed (every save rule — lock date, credit hold —
// surfaces as an error, nothing persists) and the draft carries sources and assumptions like any
// other. A 2B document has no item detail, so the invoice builder (items) cannot take it; the
// accounting form is the editor's own mode for a trading voucher without stock lines. NOTHING is
// posted: the user opens the draft in the voucher editor and saves it through voucher:save.
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { AiDraftDto } from '@shared/ai'
import { pickTaxLedger } from '@shared/voucherEdit/invoice'
import { planLines, type DraftPlan } from '@shared/gst/mismatch2b'
import { writeAudit } from '../services/audit'
import { insertDraft } from './store'
import { DraftWork, loadMasters, underGroup } from './drafting/work'
import { buildLedgerInvoiceDraft, type BuiltDraft } from './drafting/builders'

const HEAD_WHY: Record<string, string> = {
  igst: 'IGST in GSTR-2B', cgst: 'CGST in GSTR-2B', sgst: 'SGST in GSTR-2B', cess: 'cess in GSTR-2B'
}

/** The plan as a WP 5.3 draft (ledger lines; rehearsed). Throws with the reason when it would not save. */
export function buildPlanDraft(w: DraftWork, plan: DraftPlan): BuiltDraft {
  const m = w.m
  const purchase = m.ledgers.find((l) => underGroup(m, l, ['Purchase Accounts']))
  if (!purchase) throw new Error('There is no ledger under Purchase Accounts — create one first')
  const tax = (head: string): number | null => pickTaxLedger(m.ledgers, head, 'input')
  const lines = planLines(plan, { purchase: purchase.id, igst: tax('igst'), cgst: tax('cgst'), sgst: tax('sgst'), cess: tax('cess') })
  if ('missing' in lines) throw new Error(`The company has no ${lines.missing.join(' / ')} ledger — create it (Duties & Taxes, with its tax type) first`)
  const taxIds = new Map(['igst', 'cgst', 'sgst', 'cess'].map((h) => [tax(h), h]))
  return buildLedgerInvoiceDraft(w, {
    kind: plan.kind,
    date: plan.date,
    partyLedgerId: plan.partyLedgerId,
    reference: plan.reference,
    narration: plan.narration,
    partyWhy: plan.kind === 'purchase' ? 'the only ledger carrying the supplier’s GSTIN from GSTR-2B' : 'the supplier on the purchase in the books',
    lines: lines.map((l) => ({
      ...l,
      why:
        l.ledgerId === plan.partyLedgerId
          ? 'the document value (taxable + tax)'
          : l.ledgerId === purchase.id
            ? `taxable value${plan.kind === 'debit_note' ? ' above GSTR-2B' : ' in GSTR-2B'} — the first Purchase Accounts ledger`
            : `${HEAD_WHY[taxIds.get(l.ledgerId) ?? ''] ?? 'tax in GSTR-2B'} — the input tax ledger`
    }))
  })
}

/** The Assistants screen's "Draft the purchase" (no AI): the same draft, named for the assistant. */
export function insertPlanDraft(
  db: DB,
  company: CompanyInfo,
  today: string,
  plan: DraftPlan,
  o: { threadId: number | null; messageId: number | null; unrequested?: boolean; origin?: string | null }
): AiDraftDto {
  const { payload, summary } = buildPlanDraft(new DraftWork(loadMasters(db, company, today)), plan)
  return db.transaction(() => {
    const d = insertDraft(db, { threadId: o.threadId, messageId: o.messageId, summary, payload, unrequested: o.unrequested, source: 'chat', origin: o.origin ?? null })
    writeAudit(db, 'ai_draft', d.id, 'create', null, { tool: 'gst2b_assistant', summary, payload, threadId: o.threadId, unrequested: !!o.unrequested, origin: d.origin })
    return d
  })()
}
