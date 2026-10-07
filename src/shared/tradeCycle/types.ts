// Shapes the trade-cycle IPC channels return (WP 2.5a) — shared so the renderer's typed client
// can name them (it can't import main-process modules).

import type { LineSource, LinkType, TradeDocKind, TradePurpose, VoucherKind } from '../domain'
import type { TradeSideKind } from './rules'
import type { TradeDocStatus } from './fulfilment'

export interface VoucherKindRow {
  kind: VoucherKind
  stockOnly: boolean
}

export interface VoucherLinkRow {
  linkId: number
  linkType: LinkType
  qtyMilli: number
  reprices: boolean
  /** This voucher's line (upstream: the target line; downstream: the source line). */
  lineUid: string
  /** The other document's line. */
  otherLineUid: string
  otherVoucherId: number | null
  otherTradeDocId: number | null
  /** "Delivery Note 12 line 2". */
  otherLabel: string
  otherDate: string | null
  /** The other side counts (upstream: the source is not binned; downstream: the target is live). */
  live: boolean
}

export interface VoucherLinks {
  /** Lines this voucher draws on (it is the target). */
  upstream: VoucherLinkRow[]
  /** Documents drawing on this voucher's lines (it is the source). */
  downstream: VoucherLinkRow[]
}

/** A source line a party could still draw on (links:openSourceLines — the 2.5b "Add from…"). */
export interface OpenSourceLine {
  lineUid: string
  voucherId: number | null
  tradeDocId: number | null
  kind: TradeSideKind
  label: string
  date: string
  stockItemId: number
  godownId: number | null
  batchId: number | null
  serials: string[]
  qtyMilli: number
  /** Live quantity already linked (fulfil + return for challans / GRNs; the asked link type otherwise). */
  doneMilli: number
  pendingMilli: number
  ratePaise: number
  amount: number
}

/** One open line of a delivery challan not yet invoiced / GRN not yet billed (trade:pending). */
export interface PendingNoteRow {
  voucherId: number
  number: string
  date: string
  purpose: TradePurpose
  partyLedgerId: number | null
  partyName: string | null
  lineUid: string
  /** 1-based line number on the note. */
  lineNo: number
  stockItemId: number
  itemName: string
  unit: string | null
  /** The unit's display decimals. */
  decimals: number
  godownId: number | null
  godownName: string | null
  qtyMilli: number
  /** Invoiced / billed (plus returned) by documents dated on or before the as-on date. */
  doneMilli: number
  pendingMilli: number
  ratePaise: number
  /** Taxable value of the pending quantity (pro rata of the line's value). */
  pendingValue: number
  /** Days since the note's date, as on the report date. */
  ageDays: number
}

// ---------- quotations / orders (WP 2.5c) ----------

/** A document drawing on (downstream) or drawn on by (upstream) a trade doc. */
export interface TradeDocLinkedDoc {
  voucherId: number | null
  tradeDocId: number | null
  kind: TradeSideKind
  /** "Sales Order SO-4". */
  label: string
  date: string
  /** Σ linked quantity (thousandths). */
  qtyMilli: number
  /** The other document counts (not binned / cancelled / optional). */
  live: boolean
}

export interface TradeDocLine {
  id: number
  lineUid: string
  stockItemId: number
  description: string | null
  godownId: number | null
  qtyMilli: number
  /** Paise per whole unit (base ₹). */
  ratePaise: number
  discountPaise: number
  /** Taxable value, post-discount. */
  amount: number
  /** GST / cess % snapshot taken when the line was saved (prints stay stable). */
  gstRate: number | null
  cessRate: number | null
  dueDate: string | null
  /** The quotation line this order line converts (null = none). */
  source: LineSource | null
  /** Live fulfilled quantity drawn from this line (challans / invoices / orders). */
  doneMilli: number
  pendingMilli: number
}

export interface TradeDocTotals {
  taxable: number
  cgst: number
  sgst: number
  igst: number
  cess: number
  /** Taxable + tax, rounded to the rupee (the invoice rule). */
  total: number
  roundOff: number
}

export interface TradeDoc {
  id: number
  docTypeId: number
  kind: TradeDocKind
  typeName: string
  number: string
  date: string
  partyLedgerId: number
  partyName: string
  validUntil: string | null
  dueDate: string | null
  reference: string | null
  terms: string | null
  narration: string | null
  posOverride: string | null
  currencyCode: string | null
  exchangeRate: number | null
  /** The stored, manual state. */
  manualStatus: 'open' | 'closed' | 'cancelled'
  /** The shown, derived state (fulfilment.ts docStatus) as on the read date. */
  status: TradeDocStatus
  closedAt: string | null
  closeReason: string | null
  deletedAt: string | null
  lines: TradeDocLine[]
  totals: TradeDocTotals
  /** Pending value: the open quantity's taxable value (pro rata per line); 0 once closed / cancelled. */
  pendingValue: number
  /** Documents drawn from this one, and the ones it draws on. */
  downstream: TradeDocLinkedDoc[]
  upstream: TradeDocLinkedDoc[]
  createdAt: string
  updatedAt: string
}

export interface TradeDocListRow {
  id: number
  kind: TradeDocKind
  number: string
  date: string
  partyLedgerId: number
  partyName: string
  reference: string | null
  validUntil: string | null
  dueDate: string | null
  lineCount: number
  taxable: number
  total: number
  /** Taxable value still open (pro rata of each line's pending quantity); 0 once closed / cancelled. */
  pendingValue: number
  /** Fulfilled share by taxable value, 0–100. */
  fulfilledPct: number
  status: TradeDocStatus
  /** True when the document is in the bin. */
  binned: boolean
  closeReason: string | null
  /** Live downstream documents ("Sales Order SO-4"). */
  downstreamLabels: string[]
}

/** A converted / duplicated document, ready for the entry form (never saved by the call). */
export interface TradeDocDraft {
  kind: TradeDocKind
  partyLedgerId: number
  reference: string | null
  terms: string | null
  narration: string | null
  posOverride: string | null
  lines: {
    stockItemId: number
    description: string | null
    godownId: number | null
    qtyMilli: number
    ratePaise: number
    discountPaise: number
    dueDate: string | null
    source: LineSource | null
  }[]
}

/** One open order line (trade:pendingOrders): ordered, done, pending, value and ageing. */
export interface PendingOrderRow {
  docId: number
  number: string
  date: string
  dueDate: string | null
  partyLedgerId: number
  partyName: string
  lineUid: string
  lineNo: number
  stockItemId: number
  itemName: string
  unit: string | null
  decimals: number
  qtyMilli: number
  /** Delivered / invoiced (sales orders) or received / billed (purchase orders) by live documents
   *  dated on or before the as-on date. */
  doneMilli: number
  pendingMilli: number
  ratePaise: number
  /** Taxable value of the pending quantity. */
  pendingValue: number
  /** Days since the order date. */
  ageDays: number
  /** Days past the line's (else the order's) expected date; 0 when not yet due or no date. */
  overdueDays: number
}

export type QuotationOutcome = 'open' | 'expired' | 'converted' | 'partly_converted' | 'lost' | 'cancelled'

/** One quotation in the pipeline (trade:quotationPipeline). */
export interface QuotationPipelineRow {
  docId: number
  number: string
  date: string
  validUntil: string | null
  partyLedgerId: number
  partyName: string
  taxable: number
  total: number
  /** Taxable value converted into orders / invoices (live, by line share). */
  convertedValue: number
  outcome: QuotationOutcome
  /** Orders / invoices drawn from it. */
  convertedTo: string[]
  closeReason: string | null
}

export interface QuotationPipeline {
  rows: QuotationPipelineRow[]
  /** Quotations converted (fully or partly) ÷ decided (converted + lost + expired), 0–100 to one
   *  decimal; null when none is decided. Open and cancelled quotations are not decided. */
  conversionRatePct: number | null
  /** Converted taxable value ÷ quoted taxable value, 0–100; null when nothing was quoted. */
  valueConversionPct: number | null
}
