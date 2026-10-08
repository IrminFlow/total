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
import { fyOf } from '@shared/dates'
import { normalizeInvoiceNumber } from '@shared/gst/recon2b'
import { IN_BOOKS } from '../services/vouchers'
import { planLines, type DraftPlan } from '@shared/gst/mismatch2b'
import { writeAudit } from '../services/audit'
import { insertDraft } from './store'
import { DraftWork, loadMasters, underGroup } from './drafting/work'
import { buildLedgerInvoiceDraft, type BuiltDraft } from './drafting/builders'

const HEAD_WHY: Record<string, string> = {
  igst: 'IGST in GSTR-2B', cgst: 'CGST in GSTR-2B', sgst: 'SGST in GSTR-2B', cess: 'cess in GSTR-2B'
}

/** Refuse a draft that would duplicate the books or another open draft: a purchase from the same
 *  supplier with the same (normalised) bill number in this or the previous financial year, or an
 *  open draft of the same kind for the same supplier and reference. */
export function guardDuplicate(db: DB, plan: DraftPlan): void {
  const ref = normalizeInvoiceNumber(plan.reference)
  if (plan.kind === 'purchase') {
    const fy = fyOf(plan.date)
    const rows = db
      .prepare(
        `SELECT v.number, v.date, v.reference FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
         WHERE vt.kind = 'purchase' AND v.party_ledger_id = ? AND v.reference IS NOT NULL AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}`
      )
      .all(plan.partyLedgerId, `${fy.startYear - 1}-04-01`, fy.to) as { number: string; date: string; reference: string }[]
    const dup = rows.find((r) => normalizeInvoiceNumber(r.reference) === ref)
    if (dup) throw new Error(`Bill ${plan.reference} from this supplier is already in the books (purchase ${dup.number} dated ${dup.date}) — open it instead of drafting another`)
  }
  const open = db.prepare("SELECT id, payload_json AS p FROM ai_drafts WHERE status = 'open'").all() as { id: number; p: string }[]
  for (const d of open) {
    try {
      const p = JSON.parse(d.p) as { voucherKind?: string; partyLedgerId?: number | null; reference?: string | null }
      if (p.voucherKind === plan.kind && p.partyLedgerId === plan.partyLedgerId && p.reference && normalizeInvoiceNumber(p.reference) === ref) {
        throw new Error(`An open draft (#${d.id}) already records ${plan.reference} — review or discard it first`)
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('An open draft')) throw err
    }
  }
}

/** The plan as a WP 5.3 draft (ledger lines; rehearsed). Throws with the reason when it would not save. */
export function buildPlanDraft(w: DraftWork, plan: DraftPlan): BuiltDraft {
  const m = w.m
  guardDuplicate(m.db, plan)
  const purchase = m.ledgers.find((l) => underGroup(m, l, ['Purchase Accounts']))
  if (!purchase) throw new Error('There is no ledger under Purchase Accounts — create one first')
  const tax = (head: string): number | null => pickTaxLedger(m.ledgers, head, 'input')
  const lines = planLines(plan, { purchase: purchase.id, igst: tax('igst'), cgst: tax('cgst'), sgst: tax('sgst'), cess: tax('cess') })
  if ('missing' in lines) throw new Error(`The company has no ${lines.missing.join(' / ')} ledger — create it (Duties & Taxes, with its tax type) first`)
  const taxIds = new Map(['igst', 'cgst', 'sgst', 'cess'].map((h) => [tax(h), h]))
  // pickTaxLedger falls back to any ledger of the tax type: say so when that is an Output one.
  for (const l of lines) {
    const head = taxIds.get(l.ledgerId)
    const ledger = head ? m.ledgers.find((x) => x.id === l.ledgerId) : undefined
    if (ledger && /\b(output|payable|out)\b/i.test(ledger.name) && !/\b(input|itc|receivable|credit)\b/i.test(ledger.name)) {
      w.assume(`No input ${head!.toUpperCase()} ledger was found — ${ledger.name} (an output ledger) is used; create an input tax ledger before saving`)
    }
  }
  if (plan.itcIneligible) w.assume('GSTR-2B marks the ITC as not available (itcavl = N): the tax is part of the purchase cost, not input tax')
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
    const d = insertDraft(db, { threadId: o.threadId, messageId: o.messageId, summary, payload, unrequested: o.unrequested, source: 'assistant', origin: o.origin ?? null })
    writeAudit(db, 'ai_draft', d.id, 'create', null, { tool: 'gst2b_assistant', summary, payload, threadId: o.threadId, unrequested: !!o.unrequested, origin: d.origin })
    return d
  })()
}
