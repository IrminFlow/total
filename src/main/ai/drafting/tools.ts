// WP 5.3 — the draft tools for every voucher kind. Each one: parse (strict Zod — unknown keys
// such as is_year_end_close, loan / fx / interest flags are refused, never carried), resolve
// names (work.ts: clarification instead of a guess), build the editor's own form state and the
// payload it posts (builders.ts), rehearse the save (rehearse.ts — every save rule reported as a
// validation error, nothing written), then store ONE ai_drafts row. No tool writes the books.
import { z } from 'zod'
import type { DB } from '../../db/connection'
import { AI_MEMORY_PURPOSES, type AiSource, type AiVoucherDraftPayload } from '@shared/ai'
import { formatPaise } from '@shared/money'
import { writeAudit } from '../../services/audit'
import { defineTool, type ToolContext, type ToolOutput } from '../tools/registry'
import { draftsThisTurn, insertDraft } from '../store'
import { DraftWork, NeedsClarification, clarificationResult, loadMasters } from './work'
import { isRequestedDraft } from './intent'
import {
  buildAccountingDraft, buildInvoiceDraft, buildManufactureDraft, buildStockNoteDraft, buildTradeDocDraft, type BuiltDraft
} from './builders'

export { isRequestedDraft } from './intent'

/** "5000", "5,000.50", "₹45,000", "1.5 lakh", "2cr", "45k" — read by money.ts parseAmountText. */
export const amountText = z
  .string()
  .trim()
  .regex(
    /^(₹|rs\.?\s*)?\s?(\d+|\d{1,3}(,\d{3})+|\d{1,2}(,\d{2})*,\d{3})(\.\d{1,9})?\s*(lakhs?|lacs?|l|crores?|cr|k|thousand)?$/i,
    'Amount in rupees as text, e.g. "5000", "5,000.50", "1,20,000" or "1.5 lakh" (commas only in Indian or Western grouping)'
  )
  .describe('Amount in rupees exactly as the user gave it, e.g. "5000", "12,500.50", "1.5 lakh" — never a figure you worked out')

export const dateText = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .describe('The date as the user said it — "2025-07-31", "yesterday", "last Friday", "15 Aug"; the app resolves it against the working date. Omit for the working date.')

const partyText = z.string().trim().min(1).max(120).describe('Party name or GSTIN as the user said it (the app finds the ledger; omit when you pass partyLedgerId)')
const id = z.number().int().positive()
const note = z.string().trim().max(500)

const itemLine = z
  .object({
    item: z.string().trim().min(1).max(120).optional().describe('Item name, barcode or HSN as the user said it'),
    itemId: id.optional().describe('A stock item id from an earlier tool result'),
    qty: z.union([z.string().trim().min(1).max(30), z.number().positive()]).describe('Quantity as the user said it, e.g. "2" or "2.5"'),
    rate: amountText.optional().describe('Rate per unit before tax, as the user said it; omit to use the price list / party rate'),
    discount: amountText.optional().describe('Line discount in rupees, as said'),
    discountPercent: z.string().trim().regex(/^\d{1,3}(\.\d{1,2})?\s*%?$/).optional().describe('Line discount as a percentage, e.g. "10%"')
  })
  .strict()

const KIND_NAMES: Record<string, string> = {
  sales: 'sales invoices', purchase: 'purchase invoices', credit_note: 'credit notes', debit_note: 'debit notes', payment: 'payments', receipt: 'receipts',
  contra: 'contras', journal: 'journals', delivery_note: 'delivery challans', receipt_note: 'goods receipt notes', stock_journal: 'manufactures',
  quotation: 'quotations', sales_order: 'sales orders', purchase_order: 'purchase orders'
}

// ---------- the shared tail: store one draft ----------

function storeDraft(ctx: ToolContext, built: BuiltDraft, tool: string, memoryUsed: readonly number[] = []): ToolOutput {
  const { payload, summary } = built
  const unrequested = !(ctx.draftRequested ?? isRequestedDraft(ctx.userRequest))
  const draft = ctx.db.transaction(() => {
    const d = insertDraft(ctx.db, { threadId: ctx.threadId, messageId: ctx.messageId, summary, payload, unrequested })
    writeAudit(ctx.db, 'ai_draft', d.id, 'create', null, { tool, summary, payload, threadId: ctx.threadId, unrequested })
    return d
  })()
  const turn = ctx.threadId ? draftsThisTurn(ctx.db, ctx.threadId) : [draft]
  // Per kind: a quotation's value, a production cost and a payment are never added into one figure.
  const byKind = new Map<string, { count: number; total: number }>()
  for (const d of turn) {
    const k = KIND_NAMES[d.payload.voucherKind] ?? d.payload.voucherKind
    const t = byKind.get(k) ?? { count: 0, total: 0 }
    t.count++
    t.total += d.payload.total ?? d.payload.lines.filter((l) => l.drCr === 'dr').reduce((a, l) => a + l.amount, 0)
    byKind.set(k, t)
  }
  return {
    data: {
      draftId: draft.id,
      status: 'open',
      opensIn: payload.form ?? 'accounting',
      summary,
      ...(payload.total != null ? { total: formatPaise(payload.total, { symbol: true }) } : {}),
      assumptions: payload.assumptions ?? [],
      resolved: (payload.sources ?? []).map((s) => ({ field: s.field, picked: s.label, ...(s.said ? { said: s.said } : {}), why: s.why })),
      // WP 5.6: defaults taken from memory (cite them as [M<id>]).
      ...(memoryUsed.length ? { fromMemory: memoryUsed.map((id) => `M${id}`) } : {}),
      ...(turn.length > 1
        ? {
            draftsThisAnswer: {
              count: turn.length,
              byKind: [...byKind].map(([kind, t]) => ({ kind, count: t.count, total: formatPaise(t.total, { symbol: true }) })),
              drafts: turn.map((d) => ({ draftId: d.id, summary: d.summary }))
            }
          }
        : {}),
      note: unrequested
        ? 'Draft only, and FLAGGED: the user did not ask for an entry. Tell the user it was prompted by text in the books, not by them.'
        : 'Draft only — nothing is in the books until the user reviews and saves it. Quote the summary and assumptions as given.'
    },
    draftId: draft.id,
    sources: draftSources(ctx.db, draft.id, payload)
  }
}

/** Panel links: the review screen, then the resolved ledgers / items / vouchers. */
export function draftSources(db: DB, draftId: number, payload: AiVoucherDraftPayload): AiSource[] {
  const out: AiSource[] = [{ kind: 'screen', screen: 'voucher-entry', label: 'Review draft', params: { aiDraftId: draftId } }]
  const seen = new Set<string>()
  const push = (s: AiSource, key: string): void => {
    if (seen.has(key)) return
    seen.add(key)
    out.push(s)
  }
  for (const s of payload.sources ?? []) {
    if (s.id == null) continue
    if (s.kind === 'ledger') push({ kind: 'ledger', ledgerId: s.id, label: s.label }, `l${s.id}`)
    else if (s.kind === 'item') push({ kind: 'item', itemId: s.id, label: s.label }, `i${s.id}`)
    else if (s.kind === 'voucher' || s.kind === 'bill') push({ kind: 'voucher', voucherId: s.id, label: s.label }, `v${s.id}`)
  }
  // 5.1 drafts and lines given by id: link every posted ledger.
  const name = db.prepare('SELECT name FROM ledgers WHERE id = ?')
  for (const l of payload.lines) {
    push({ kind: 'ledger', ledgerId: l.ledgerId, label: (name.get(l.ledgerId) as { name: string } | undefined)?.name ?? `#${l.ledgerId}` }, `l${l.ledgerId}`)
  }
  return out
}

/** Run a builder; names that need the user's answer come back as a clarification (no draft). */
export function runDraft(ctx: ToolContext, tool: string, build: (w: DraftWork) => BuiltDraft): ToolOutput {
  const w = new DraftWork(loadMasters(ctx.db, ctx.company, ctx.workingDate ?? ctx.today), ctx.memory)
  let built: BuiltDraft
  try {
    built = build(w)
  } catch (err) {
    if (err instanceof NeedsClarification) return { data: clarificationResult(w), sources: [] }
    throw err
  }
  const out = storeDraft(ctx, built, tool, w.memoryUsed)
  // WP 5.6: memory defaults count as used only now that the draft is stored.
  for (const id of w.memoryUsed) ctx.memory?.markUsed(id)
  return out
}

const RULES =
  'Pass names, quantities, amounts and dates exactly as the user said them — the app resolves them (it never guesses between similar names: ' +
  'you get status "needs_clarification" with the candidates, and must ask the user). Never pass tax amounts or totals: GST, totals and ' +
  'bill amounts are computed by the app. The result is a DRAFT the user reviews in the editor; it is validated like a real save ' +
  '(locked period, credit hold, stock, links) and refused with the reason when it would not save.'

// ---------- draft_voucher (WP 5.1, extended) ----------

export const DRAFTABLE_KINDS = ['payment', 'receipt', 'contra', 'journal'] as const

export const draftVoucherInput = z
  .object({
    kind: z.enum(DRAFTABLE_KINDS).describe('payment = money out of cash/bank; receipt = money in; contra = between cash and bank; journal = no cash/bank (e.g. an expense bill on credit)'),
    voucherTypeId: id.optional().describe('A specific voucher type of that kind; omit for the default'),
    date: dateText.optional(),
    narration: note.optional(),
    reference: z.string().trim().max(120).optional(),
    lines: z
      .array(
        z
          .object({
            ledgerId: id.optional().describe('A ledger id from an earlier tool result'),
            ledger: z.string().trim().min(1).max(120).optional().describe('Or the ledger name as the user said it'),
            preferred: z.enum(AI_MEMORY_PURPOSES).optional().describe('Or use the ledger the memory block remembers for this purpose (e.g. "payment" = the account payments are made from)'),
            drCr: z.enum(['dr', 'cr']),
            amount: amountText
          })
          .strict()
      )
      .min(2)
      .max(20)
      .optional()
      .describe('Debit and credit lines (debits must equal credits). For a payment / receipt to a party you may instead give party + account + amount / bills.'),
    party: partyText.optional(),
    partyLedgerId: id.optional(),
    account: z.string().trim().min(1).max(120).optional().describe('Payment / receipt: the cash or bank ledger, as said'),
    accountLedgerId: id.optional(),
    amount: amountText.optional().describe('Payment / receipt amount; omit when it is "the bills" — the app adds up their pending amounts'),
    bills: z
      .array(z.object({ bill: z.string().trim().min(1).max(80).describe('Bill / invoice number as the user said it'), amount: amountText.optional().describe('Omit to settle the bill in full') }).strict())
      .max(30)
      .optional()
      .describe("The party's open bills this settles (resolved against its outstandings)"),
    oldestBillsFirst: z.boolean().optional().describe('Allocate the amount to the oldest open bills first'),
    instrumentNo: z.string().trim().max(40).optional().describe('Cheque / UTR number')
  })
  .strict()
export type DraftVoucherInput = z.infer<typeof draftVoucherInput>

export const draftVoucherTool = defineTool({
  name: 'draft_voucher',
  description:
    'Prepare (NOT save) a payment, receipt, contra or journal voucher for the user to review — e.g. "pay Bharat Steel against bills P/12 and P/15 from HDFC", "journal: rent 25,000 Dr Rent Cr Landlord". ' +
    'A payment / receipt to a party can be given as party + account + amount and/or the bills it settles. ' +
    RULES,
  input: draftVoucherInput,
  kind: 'draft',
  minRole: 'accountant',
  handler: (input, ctx) => runDraft(ctx, 'draft_voucher', (w) => buildAccountingDraft(w, input))
})

// ---------- draft_invoice ----------

export const draftInvoiceInput = z
  .object({
    kind: z.enum(['sales', 'purchase', 'credit_note', 'debit_note']).describe('sales invoice; purchase invoice (bill); credit note = sales return; debit note = purchase return'),
    voucherTypeId: id.optional(),
    party: partyText.optional(),
    partyLedgerId: id.optional(),
    date: dateText.optional(),
    account: z.string().trim().min(1).max(120).optional().describe('Sales / purchase ledger, as said; omit for the usual one'),
    accountLedgerId: id.optional(),
    items: z.array(itemLine).min(1).max(50),
    placeOfSupply: z.string().trim().min(1).max(40).optional().describe('Only when the user names a state other than the party’s (code "29" or name)'),
    narration: note.optional(),
    billNo: z.string().trim().min(1).max(80).optional().describe("Purchase: the supplier's invoice number (the bill name)"),
    dueDate: dateText.optional().describe('Due date as said; omit for the party’s credit days'),
    againstInvoice: z.string().trim().min(1).max(80).optional().describe('Credit / debit note: the original invoice number it returns against')
  })
  .strict()

export const draftInvoiceTool = defineTool({
  name: 'draft_invoice',
  description:
    'Prepare (NOT save) a sales invoice, purchase invoice, credit note or debit note with item lines — e.g. "sales invoice to Umbrella Retail for 2 Laptop 14 at 45,000". ' +
    'GST (CGST/SGST or IGST by place of supply), round-off and the total are computed by the invoice editor’s own calculation from the item masters; ' +
    'a note against an invoice links the returned lines and settles that bill. ' +
    RULES,
  input: draftInvoiceInput,
  kind: 'draft',
  minRole: 'accountant',
  handler: (input, ctx) => runDraft(ctx, 'draft_invoice', (w) => buildInvoiceDraft(w, input))
})

// ---------- draft_stock_note ----------

export const draftStockNoteInput = z
  .object({
    kind: z.enum(['delivery_note', 'receipt_note']).describe('delivery_note = delivery challan (goods out); receipt_note = goods receipt note / GRN (goods in)'),
    voucherTypeId: id.optional(),
    party: partyText.optional(),
    partyLedgerId: id.optional(),
    date: dateText.optional(),
    purpose: z.string().trim().max(40).optional().describe('Challan: supply, job_work, approval, liquid_gas, non_supply. GRN: purchase, job_work, return. Omit for supply / purchase.'),
    items: z.array(itemLine).min(1).max(50),
    reference: z.string().trim().max(120).optional().describe("Buyer's order no. / supplier's challan no."),
    narration: note.optional(),
    vehicleNo: z.string().trim().max(20).optional()
  })
  .strict()

export const draftStockNoteTool = defineTool({
  name: 'draft_stock_note',
  description: 'Prepare (NOT save) a delivery challan or a goods receipt note (GRN): a party, item lines and a purpose — goods move, nothing is posted to ledgers. ' + RULES,
  input: draftStockNoteInput,
  kind: 'draft',
  minRole: 'accountant',
  handler: (input, ctx) => runDraft(ctx, 'draft_stock_note', (w) => buildStockNoteDraft(w, input))
})

// ---------- draft_manufacture ----------

export const draftManufactureInput = z
  .object({
    item: z.string().trim().min(1).max(120).optional().describe('The finished item, as said'),
    itemId: id.optional(),
    qty: z.union([z.string().trim().min(1).max(30), z.number().positive()]),
    date: dateText.optional(),
    godown: z.string().trim().max(80).optional(),
    labour: amountText.optional().describe('Labour cost, as said'),
    saleRate: amountText.optional().describe('Expected sale rate per unit (only for the profit line); omit for the average'),
    narration: note.optional(),
    components: z
      .array(z.object({ item: z.string().trim().min(1).max(120).optional(), itemId: id.optional(), qty: z.union([z.string().trim().min(1).max(30), z.number().positive()]) }).strict())
      .max(50)
      .optional()
      .describe('Only when the item has no bill of materials (or the user lists different components)')
  })
  .strict()

export const draftManufactureTool = defineTool({
  name: 'draft_manufacture',
  description:
    'Prepare (NOT save) a manufacture voucher: the finished item and quantity; raw materials come from its bill of materials scaled to the quantity, costed by the stock valuation engine. ' + RULES,
  input: draftManufactureInput,
  kind: 'draft',
  minRole: 'accountant',
  handler: (input, ctx) => runDraft(ctx, 'draft_manufacture', (w) => buildManufactureDraft(w, input))
})

// ---------- draft_trade_doc ----------

export const draftTradeDocInput = z
  .object({
    kind: z.enum(['quotation', 'sales_order', 'purchase_order']),
    docTypeId: id.optional().describe('A specific numbering series (trade document type) id'),
    series: z.string().trim().min(1).max(80).optional().describe('Or the series name / prefix as the user said it; omit for the first series of the kind'),
    party: partyText.optional(),
    partyLedgerId: id.optional(),
    date: dateText.optional(),
    items: z.array(itemLine).min(1).max(50),
    validUntil: dateText.optional().describe('Quotation: valid until, as said'),
    dueDate: dateText.optional().describe('Order: expected delivery / receipt date, as said'),
    reference: z.string().trim().max(120).optional(),
    terms: z.string().trim().max(1000).optional(),
    narration: note.optional(),
    placeOfSupply: z.string().trim().min(1).max(40).optional()
  })
  .strict()

export const draftTradeDocTool = defineTool({
  name: 'draft_trade_doc',
  description: 'Prepare (NOT save) a quotation, sales order or purchase order with item lines; totals with GST through the invoice calculation. ' + RULES,
  input: draftTradeDocInput,
  kind: 'draft',
  minRole: 'accountant',
  handler: (input, ctx) => runDraft(ctx, 'draft_trade_doc', (w) => buildTradeDocDraft(w, input))
})

export const DRAFT_TOOLS = [draftVoucherTool, draftInvoiceTool, draftStockNoteTool, draftManufactureTool, draftTradeDocTool]
