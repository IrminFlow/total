// "Add from…" (WP 2.5b, design §5.2): turn source lines picked in the drawer — a party's open
// challan / GRN lines for an invoice / bill, or invoice / bill lines for a credit / debit note —
// into invoice-form rows that carry their `source`. Pure: the drawer and the dbtests share it.

import type { LinkType, VoucherKind } from '../domain'
import type { OpenSourceLine } from '../tradeCycle/types'
import { linkRuleFor, sourceKindsFor } from '../tradeCycle/rules'
import type { InvoiceRowState } from './invoice'
import { qtyText } from './payload'

export interface SourcePick {
  line: OpenSourceLine
  /** Quantity to draw (thousandths), 0 < q ≤ line.pendingMilli. */
  qtyMilli: number
}

/** What the invoice form's "Add from…" button draws on, per kind (null = no button). */
export function addFromFor(kind: VoucherKind): { linkType: LinkType; sourceKinds: VoucherKind[]; label: string } | null {
  switch (kind) {
    case 'sales': return { linkType: 'fulfil', sourceKinds: ['delivery_note'], label: 'Add from challans…' }
    case 'purchase': return { linkType: 'fulfil', sourceKinds: ['receipt_note'], label: 'Add from receipt notes…' }
    case 'credit_note': return { linkType: 'return', sourceKinds: ['sales'], label: 'Against invoice…' }
    case 'debit_note': return { linkType: 'return', sourceKinds: ['purchase'], label: 'Against bill…' }
    default: return null
  }
}

/** Sanity: every kind addFromFor names is an allowed link pair (rules.ts is the authority). */
export function addFromIsAllowed(kind: VoucherKind): boolean {
  const a = addFromFor(kind)
  if (!a) return false
  const allowed = sourceKindsFor(kind, a.linkType)
  return a.sourceKinds.every((s) => allowed.includes(s))
}

/**
 * Rows for the picked lines. Rate (and the line's discount, pro rata) default from the source and
 * stay editable; item, godown and batch are the source's; serials are the first `qty` of the
 * source's (a challan / GRN line's goods are those very units). Foreign-currency invoices type
 * rates in the invoice currency: `fxRate` converts the ₹ source rate back.
 */
export function rowsFromSourcePicks(picks: readonly SourcePick[], opts: { linkType: LinkType; fxRate?: number | null }): InvoiceRowState[] {
  const fx = opts.fxRate && opts.fxRate > 0 ? opts.fxRate : null
  const toCur = (paise: number): number => (fx ? Math.round(paise / fx) : paise)
  return picks
    .filter((p) => p.qtyMilli > 0)
    .map(({ line, qtyMilli }) => {
      const q = Math.min(qtyMilli, line.pendingMilli)
      // The source line's own discount, scaled to the drawn quantity.
      const gross = Math.round((line.qtyMilli * line.ratePaise) / 1000)
      const srcDiscount = Math.max(0, gross - line.amount)
      const discount = srcDiscount > 0 ? Math.round((srcDiscount * q) / line.qtyMilli) : 0
      const units = q % 1000 === 0 ? q / 1000 : 0
      const serials = line.serials.length > 0 && units > 0 ? line.serials.slice(0, units) : []
      return {
        itemId: line.stockItemId,
        qtyText: qtyText(q),
        rate: toCur(line.ratePaise),
        discount: discount > 0 ? toCur(discount) : null,
        godownId: line.godownId,
        batchId: line.batchId,
        ...(serials.length > 0 ? { serials } : {}),
        source: { lineUid: line.lineUid, linkType: opts.linkType }
      }
    })
}

/** Does a row drawn this way keep the source's goods (item / godown / batch / serials locked)?
 *  True for a fulfil link from a stock note (moves_stock = 0, I3); a return moves stock itself, so
 *  only its item is fixed. */
export function sourceLocksGoods(sourceKind: VoucherKind, targetKind: VoucherKind, linkType: LinkType): boolean {
  return linkRuleFor(sourceKind, targetKind, linkType)?.nonMoving ?? false
}
