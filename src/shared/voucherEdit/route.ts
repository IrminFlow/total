// Which entry mode opens a voucher. New vouchers: by kind. Saved vouchers: the mode that
// creates that kind — but only when it can show the voucher faithfully (reconstruct → rebuild
// → compare); otherwise the lossless fallback for the kind, with the reason for the banner.

import type { Voucher, VoucherKind } from '../domain'
import { accountingStateFromVoucher, type AccountingFormState } from './accounting'
import { invoiceRepresentation, type InvoiceContext, type InvoiceFormState, type TaxLedgerIds } from './invoice'
import { manufactureRepresentation, type BomComponent, type ManufactureFormState } from './manufacture'
import { physicalRepresentation, type PhysicalFormState } from './physical'
import { stockLinesStateFromVoucher, type StockLinesFormState } from './stockLines'
import { transferRepresentation, type TransferFormState } from './stockJournal'
import { TRADING_KINDS } from './payload'

export type EntryMode = 'invoice' | 'accounting' | 'manufacture' | 'physical' | 'stockLines' | 'transfer'

export function modeForKind(kind: VoucherKind): Exclude<EntryMode, 'stockLines' | 'transfer'> {
  if (TRADING_KINDS.includes(kind)) return 'invoice'
  if (kind === 'stock_journal') return 'manufacture'
  if (kind === 'physical_stock') return 'physical'
  return 'accounting'
}

export type EditPlan =
  | { mode: 'invoice'; state: InvoiceFormState }
  | { mode: 'accounting'; state: AccountingFormState; fallbackReason: string | null }
  | { mode: 'manufacture'; state: ManufactureFormState }
  | { mode: 'physical'; state: PhysicalFormState }
  | { mode: 'stockLines'; state: StockLinesFormState; fallbackReason: string | null }
  | { mode: 'transfer'; state: TransferFormState }

export interface EditPlanContext {
  invoice: Omit<InvoiceContext, 'kind'>
  taxLedgers: TaxLedgerIds
  bomFor: (itemId: number) => readonly BomComponent[] | undefined
  itemName: (itemId: number) => string
}

export function planVoucherEdit(v: Voucher, kind: VoucherKind, ctx: EditPlanContext): EditPlan {
  switch (modeForKind(kind)) {
    case 'invoice': {
      const r = invoiceRepresentation(v, { ...ctx.invoice, kind }, ctx.taxLedgers)
      if (r.ok) return { mode: 'invoice', state: r.state }
      return { mode: 'accounting', state: accountingStateFromVoucher(v), fallbackReason: r.reason }
    }
    case 'manufacture': {
      const r = manufactureRepresentation(v, { bomFor: ctx.bomFor, itemName: ctx.itemName })
      if (r.ok) return { mode: 'manufacture', state: r.state }
      // WP 2.3: a same-item godown transfer opens in the transfer form.
      const t = transferRepresentation(v)
      if (t.ok) return { mode: 'transfer', state: t.state }
      return { mode: 'stockLines', state: stockLinesStateFromVoucher(v), fallbackReason: r.reason }
    }
    case 'physical': {
      const r = physicalRepresentation(v, { itemName: ctx.itemName })
      if (r.ok) return { mode: 'physical', state: r.state }
      return { mode: 'stockLines', state: stockLinesStateFromVoucher(v), fallbackReason: r.reason }
    }
    default:
      return { mode: 'accounting', state: accountingStateFromVoucher(v), fallbackReason: null }
  }
}

/** The produced item a stock journal would be "manufacturing" (its last line, when inward) —
 *  the editor fetches that item's BOM before planning. */
export function candidateProducedItem(v: Voucher): number | null {
  const last = v.inventory[v.inventory.length - 1]
  return last && last.direction === 'in' && !last.isAbsolute ? last.stockItemId : null
}
