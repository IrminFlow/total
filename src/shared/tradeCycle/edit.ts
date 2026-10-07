// Quotation / sales order / purchase order entry (WP 2.5c, design §5.2): form state ⇄ save
// payload, and the document totals. Pure — the renderer's TradeDocEntry owns the inputs, the
// main process (services/tradeDocs.ts) computes the same totals for lists and prints.
//
// GST is NEVER computed a second way here: totals go through the invoice form's own
// computeInvoice (voucherEdit/invoice.ts) — the same buckets, the same rupee rounding — so an
// order's value equals the invoice it turns into, line for line.

import type { LineSource, TradeDocKind } from '../domain'
import type { TradeDocInputParsed } from '../schemas'
import { computeInvoice, type InvoiceComputed, type InvoiceFormState, type InvoiceRowState } from '../voucherEdit/invoice'
import { qtyText } from '../voucherEdit/payload'
import type { TradeDoc, TradeDocDraft, TradeDocTotals } from './types'

/** An order / quotation grid row: the invoice row plus the order-only line fields. */
export interface TradeDocRowState extends InvoiceRowState {
  /** Free-text line description (printed under the item). */
  description?: string | null
  /** Line-level expected date (orders); null = the document's. */
  dueDate?: string | null
}

export interface TradeDocFormState {
  kind: TradeDocKind
  date: string
  /** '' = the series' next auto number. */
  number: string
  partyId: number | null
  /** Quotations: valid until ('' = no expiry). */
  validUntil: string
  /** Orders: expected delivery / receipt date ('' = none). */
  dueDate: string
  reference: string
  terms: string
  narration: string
  posOverride: string | null
  rows: TradeDocRowState[]
  /** Stored fields the form doesn't edit, posted back as loaded. */
  passthrough: { currencyCode: string | null; exchangeRate: number | null }
}

export interface TradeDocContext {
  kind: TradeDocKind
  companyStateCode: string
  items: ReadonlyMap<number, { gstRate: number | null; cessRate: number | null }>
  ledgers: ReadonlyMap<number, { stateCode: string | null }>
}

export const TRADE_DOC_TITLES: Record<TradeDocKind, string> = {
  quotation: 'Quotation',
  sales_order: 'Sales order',
  purchase_order: 'Purchase order'
}

/** Sales-side documents (quotation, SO) sell to the party; a PO buys from it. */
export const tradeDocIsSales = (kind: TradeDocKind): boolean => kind !== 'purchase_order'

export function emptyTradeDocState(kind: TradeDocKind, date: string): TradeDocFormState {
  return {
    kind, date, number: '', partyId: null, validUntil: '', dueDate: '', reference: '', terms: '', narration: '',
    posOverride: null, rows: [], passthrough: { currencyCode: null, exchangeRate: null }
  }
}

/** The invoice-form state these rows would be — so computeInvoice prices them. */
function asInvoiceState(state: Pick<TradeDocFormState, 'date' | 'partyId' | 'posOverride' | 'rows'>): InvoiceFormState {
  return {
    date: state.date, number: '', partyId: state.partyId, accountId: null,
    rows: state.rows.map((r) => ({ ...r, godownId: r.godownId ?? null, batchId: null })),
    narration: '', vehicleNo: '', transporterId: '', distanceKm: '', currencyCode: '', fxRateText: '',
    posOverride: state.posOverride, optional: false, billName: '', billDueDate: state.date, manualNewBillMode: false,
    noteBillRefs: [], reference: null, instrumentNo: null, instrumentDate: null, tds: null
  }
}

/** Line amounts and GST of the form, through the invoice's own computation. */
export function computeTradeDoc(state: TradeDocFormState, ctx: TradeDocContext): InvoiceComputed {
  return computeInvoice(asInvoiceState(state), {
    kind: tradeDocIsSales(ctx.kind) ? 'sales' : 'purchase',
    companyStateCode: ctx.companyStateCode,
    items: ctx.items,
    ledgers: new Map([...ctx.ledgers].map(([id, l]) => [id, { stateCode: l.stateCode, gstRate: null }]))
  })
}

const totalsOf = (c: InvoiceComputed): TradeDocTotals => ({
  taxable: c.gst.taxable, cgst: c.gst.cgst, sgst: c.gst.sgst, igst: c.gst.igst, cess: c.gst.cess, total: c.rounded, roundOff: c.roundDiff
})

/** A stored document's lines priced at their GST snapshot (lists, prints, the pending value). */
export function storedTradeDocTotals(
  lines: readonly { stockItemId: number; qtyMilli: number; ratePaise: number; discountPaise: number; gstRate: number | null; cessRate: number | null }[],
  opts: { kind: TradeDocKind; companyStateCode: string; partyStateCode: string | null; posOverride: string | null; date: string }
): TradeDocTotals {
  // Every line of one document carries the same snapshot per item (taken at the same save).
  const items = new Map(lines.map((l) => [l.stockItemId, { gstRate: l.gstRate ?? 0, cessRate: l.cessRate ?? 0 }]))
  const rows: TradeDocRowState[] = lines.map((l) => ({
    itemId: l.stockItemId, qtyText: qtyText(l.qtyMilli), rate: l.ratePaise, discount: l.discountPaise || null, godownId: null, batchId: null
  }))
  const c = computeTradeDoc(
    { ...emptyTradeDocState(opts.kind, opts.date), partyId: 0, posOverride: opts.posOverride, rows },
    { kind: opts.kind, companyStateCode: opts.companyStateCode, items, ledgers: new Map([[0, { stateCode: opts.partyStateCode }]]) }
  )
  return totalsOf(c)
}

export type TradeDocBuildResult = { ok: true; payload: TradeDocInputParsed } | { ok: false; error: string }

const blankToNull = (s: string | null | undefined): string | null => {
  const t = (s ?? '').trim()
  return t === '' ? null : t
}

/** The exact payload the entry form posts. */
export function buildTradeDocPayload(state: TradeDocFormState, ctx: TradeDocContext, docTypeId: number): TradeDocBuildResult {
  if (state.partyId == null) return { ok: false, error: 'Pick the party first' }
  const filled = state.rows.filter((r) => r.itemId != null)
  for (const [i, r] of filled.entries()) {
    const q = Math.round(parseFloat(r.qtyText || '0') * 1000)
    if (!Number.isFinite(q) || q <= 0) return { ok: false, error: `Line ${i + 1}: enter a quantity` }
    if (r.rate == null) return { ok: false, error: `Line ${i + 1}: enter a rate (0 is allowed)` }
    if (!ctx.items.has(r.itemId!)) return { ok: false, error: `Line ${i + 1}: unknown stock item` }
  }
  const c = computeTradeDoc({ ...state, rows: filled }, ctx)
  if (c.detail.length === 0) return { ok: false, error: 'Add at least one item line' }
  // computeInvoice keeps every row validated above, in order — detail[i] is filled[i].
  if (c.detail.length !== filled.length) return { ok: false, error: 'A line could not be priced' }
  if (state.kind === 'quotation' && state.validUntil && state.validUntil < state.date) {
    return { ok: false, error: 'Valid until is before the quotation date' }
  }
  if (state.kind !== 'quotation' && state.dueDate && state.dueDate < state.date) {
    return { ok: false, error: 'The expected date is before the order date' }
  }
  return {
    ok: true,
    payload: {
      docTypeId,
      date: state.date,
      ...(state.number.trim() ? { number: state.number.trim() } : {}),
      partyLedgerId: state.partyId,
      validUntil: state.kind === 'quotation' ? blankToNull(state.validUntil) : null,
      dueDate: state.kind === 'quotation' ? null : blankToNull(state.dueDate),
      reference: blankToNull(state.reference),
      terms: blankToNull(state.terms),
      narration: blankToNull(state.narration),
      posOverride: state.posOverride,
      currencyCode: state.passthrough.currencyCode,
      exchangeRate: state.passthrough.exchangeRate,
      lines: c.detail.map((d, i) => {
        const row = filled[i]!
        return {
          ...(d.lineUid ? { lineUid: d.lineUid } : {}),
          stockItemId: d.itemId,
          description: blankToNull(row.description),
          godownId: d.godownId,
          qtyMilli: d.qtyMilli,
          ratePaise: d.ratePaise,
          discountPaise: d.discountPaise,
          amount: d.amount,
          dueDate: row.dueDate ?? null,
          source: d.source ? { lineUid: d.source.lineUid, linkType: d.source.linkType } : null
        }
      })
    }
  }
}

/** The form state of a saved document (an alteration opens with this). */
export function tradeDocStateFromDoc(doc: TradeDoc): TradeDocFormState {
  return {
    kind: doc.kind,
    date: doc.date,
    number: doc.number,
    partyId: doc.partyLedgerId,
    validUntil: doc.validUntil ?? '',
    dueDate: doc.dueDate ?? '',
    reference: doc.reference ?? '',
    terms: doc.terms ?? '',
    narration: doc.narration ?? '',
    posOverride: doc.posOverride,
    rows: doc.lines.map((l) => ({
      itemId: l.stockItemId,
      qtyText: qtyText(l.qtyMilli),
      rate: l.ratePaise,
      discount: l.discountPaise > 0 ? l.discountPaise : null,
      godownId: l.godownId,
      batchId: null,
      lineUid: l.lineUid,
      source: l.source,
      description: l.description,
      dueDate: l.dueDate
    })),
    passthrough: { currencyCode: doc.currencyCode, exchangeRate: doc.exchangeRate }
  }
}

/** The payload that would re-save a stored document exactly as it is (the round-trip oracle). */
export function tradeDocToPayload(doc: TradeDoc): TradeDocInputParsed {
  return {
    docTypeId: doc.docTypeId,
    date: doc.date,
    number: doc.number,
    partyLedgerId: doc.partyLedgerId,
    validUntil: doc.validUntil,
    dueDate: doc.dueDate,
    reference: doc.reference,
    terms: doc.terms,
    narration: doc.narration,
    posOverride: doc.posOverride,
    currencyCode: doc.currencyCode,
    exchangeRate: doc.exchangeRate,
    lines: doc.lines.map((l) => ({
      lineUid: l.lineUid,
      stockItemId: l.stockItemId,
      description: l.description,
      godownId: l.godownId,
      qtyMilli: l.qtyMilli,
      ratePaise: l.ratePaise,
      discountPaise: l.discountPaise,
      amount: l.amount,
      dueDate: l.dueDate,
      source: l.source
    }))
  }
}

/** A new document's form state from a converted / duplicated draft. */
export function tradeDocStateFromDraft(draft: TradeDocDraft, date: string): TradeDocFormState {
  return {
    ...emptyTradeDocState(draft.kind, date),
    partyId: draft.partyLedgerId,
    reference: draft.reference ?? '',
    terms: draft.terms ?? '',
    narration: draft.narration ?? '',
    posOverride: draft.posOverride,
    rows: draft.lines.map((l) => ({
      itemId: l.stockItemId,
      qtyText: qtyText(l.qtyMilli),
      rate: l.ratePaise,
      discount: l.discountPaise > 0 ? l.discountPaise : null,
      godownId: l.godownId,
      batchId: null,
      description: l.description,
      dueDate: l.dueDate,
      ...(l.source ? { source: { ...l.source } as LineSource } : {})
    }))
  }
}

/** Labels for the derived status (fulfilment.ts), per kind. */
export function tradeStatusLabel(kind: TradeDocKind, status: string): string {
  switch (status) {
    case 'open': return 'Open'
    case 'expired': return 'Expired'
    case 'partly_fulfilled': return kind === 'quotation' ? 'Partly converted' : kind === 'purchase_order' ? 'Partly received' : 'Partly delivered'
    case 'fulfilled': return kind === 'quotation' ? 'Converted' : kind === 'purchase_order' ? 'Received' : 'Delivered'
    case 'closed': return kind === 'quotation' ? 'Lost / closed' : 'Short-closed'
    case 'cancelled': return 'Cancelled'
    default: return status
  }
}
