// Trade-cycle link rules (WP 2.5, design §2.4) — pure data. A line link joins one SOURCE line
// (an order / quotation line, or a voucher's inventory line) to one TARGET line that fulfils or
// returns it. Only the pairs listed here are allowed; services/tradeLinks.ts enforces them, and
// derives the target line's `moves_stock` from them.

import type { LinkType, TradeDocKind, VoucherKind } from '../domain'

/** Either side of a link: a voucher kind or a trade-doc (order / quotation) kind. */
export type TradeSideKind = VoucherKind | TradeDocKind

export interface LinkRule {
  linkType: LinkType
  source: TradeSideKind
  target: TradeSideKind
  /** The target line's goods moved on the source (a stock-only voucher line): moves_stock = 0. */
  nonMoving: boolean
  /** The target (a purchase bill) re-prices the source GRN line in stock (§3) unless frozen. */
  reprices: boolean
}

const rule = (linkType: LinkType, source: TradeSideKind, target: TradeSideKind, nonMoving = false, reprices = false): LinkRule => ({
  linkType, source, target, nonMoving, reprices
})

/** Every allowed (link type, source kind → target kind) pair. Anything else is rejected. */
export const LINK_RULES: readonly LinkRule[] = [
  rule('fulfil', 'quotation', 'sales_order'),
  rule('fulfil', 'quotation', 'sales'),
  rule('fulfil', 'sales_order', 'delivery_note'),
  rule('fulfil', 'sales_order', 'sales'),
  rule('fulfil', 'delivery_note', 'sales', true),
  rule('fulfil', 'purchase_order', 'receipt_note'),
  rule('fulfil', 'purchase_order', 'purchase'),
  rule('fulfil', 'receipt_note', 'purchase', true, true),
  rule('return', 'sales', 'credit_note'),
  rule('return', 'purchase', 'debit_note'),
  // Rejections before invoicing: goods back in against a challan, out against a GRN.
  rule('return', 'delivery_note', 'receipt_note'),
  rule('return', 'receipt_note', 'delivery_note')
]

export function linkRuleFor(source: TradeSideKind, target: TradeSideKind, linkType: LinkType): LinkRule | null {
  return LINK_RULES.find((r) => r.source === source && r.target === target && r.linkType === linkType) ?? null
}

/** Does a target line of `target` kind, linked this way to a `source` line, move stock itself?
 *  (Trade-doc targets — orders — never move stock; null for a pair that isn't allowed.) */
export function movesStockFor(source: TradeSideKind, target: TradeSideKind, linkType: LinkType): boolean | null {
  const r = linkRuleFor(source, target, linkType)
  return r ? !r.nonMoving : null
}

/** Source kinds whose capacity is shared by fulfilment AND returns (Σ fulfil + Σ return ≤ qty):
 *  the stock-only notes, whose goods either go on to an invoice or come back. Orders and
 *  invoices check the two separately (Σ fulfil ≤ qty, Σ return ≤ qty). */
export const SHARED_CAPACITY_SOURCES: readonly TradeSideKind[] = ['delivery_note', 'receipt_note']

/** Kinds a link may target (anything else never carries a `source`). */
export const LINKABLE_TARGETS: ReadonlySet<TradeSideKind> = new Set(LINK_RULES.map((r) => r.target))

/** The source kinds a target kind can draw on with `linkType` (the "Add from…" drawer's filter). */
export function sourceKindsFor(target: TradeSideKind, linkType: LinkType): TradeSideKind[] {
  return LINK_RULES.filter((r) => r.target === target && r.linkType === linkType).map((r) => r.source)
}

export const TRADE_DOC_KIND_SET: ReadonlySet<string> = new Set(['quotation', 'sales_order', 'purchase_order'])
export const isTradeDocKind = (k: string): k is TradeDocKind => TRADE_DOC_KIND_SET.has(k)
