// Which entry mode opens a voucher. New vouchers: by kind. Saved vouchers: the mode that
// creates that kind — but only when it can show the voucher faithfully (reconstruct → rebuild
// → compare); otherwise the lossless fallback for the kind, with the reason for the banner.

import type { Voucher, VoucherKind } from '../domain'
import { accountingStateFromVoucher, type AccountingFormState } from './accounting'
import { invoiceRepresentation, type InvoiceContext, type InvoiceFormState, type TaxLedgerIds } from './invoice'
import { manufactureRepresentation, type ManufactureFormState } from './manufacture'
import type { ManufactureDetails } from '../manufacture'
import { physicalRepresentation, type PhysicalFormState } from './physical'
import { stockLinesStateFromVoucher, type StockLinesFormState } from './stockLines'
import { transferRepresentation, type TransferFormState } from './stockJournal'
import { jobWorkSendRepresentation, type JobWorkSendFormState } from './jobWork'
import type { JobWorkChallan } from '../jobWork'
import { TRADING_KINDS } from './payload'

export type EntryMode = 'invoice' | 'accounting' | 'manufacture' | 'physical' | 'stockLines' | 'transfer' | 'jobWorkSend'

export function modeForKind(kind: VoucherKind): Exclude<EntryMode, 'stockLines' | 'transfer' | 'jobWorkSend'> {
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
  | { mode: 'stockLines'; state: StockLinesFormState; fallbackReason: string | null; legacy?: boolean }
  | { mode: 'transfer'; state: TransferFormState }
  | { mode: 'jobWorkSend'; state: JobWorkSendFormState }

/** Banner for a stock journal saved before the Manufacture screen existed (no details row). */
export const LEGACY_STOCK_JOURNAL_BANNER = 'Created before 0.6.0 — costed at the saved amounts'

export interface EditPlanContext {
  invoice: Omit<InvoiceContext, 'kind'>
  taxLedgers: TaxLedgerIds
  /** The stock journal's manufacture_details row (null = none: a legacy journal). Only read for
   *  stock journals. */
  manufacture?: ManufactureDetails | null
  /** WP 2.4: the stock journal's job_work_challans row (send / return challans open in the
   *  Send-to-job-worker form). Only read for stock journals without manufacture details. */
  jobWork?: JobWorkChallan | null
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
      // Legacy journals (no details row) are never converted: they keep their stored costing
      // and open as plain stock lines.
      if (!ctx.manufacture) {
        if (ctx.jobWork && ctx.jobWork.kind !== 'receive') {
          const j = jobWorkSendRepresentation(v, ctx.jobWork)
          if (j.ok) return { mode: 'jobWorkSend', state: j.state }
          return { mode: 'stockLines', state: stockLinesStateFromVoucher(v), fallbackReason: j.reason }
        }
        // WP 2.3: a same-item godown transfer (stored costing, no details row) opens in the
        // transfer form, which re-saves it byte-for-byte.
        const t = transferRepresentation(v)
        if (t.ok) return { mode: 'transfer', state: t.state }
        return { mode: 'stockLines', state: stockLinesStateFromVoucher(v), fallbackReason: LEGACY_STOCK_JOURNAL_BANNER, legacy: true }
      }
      const r = manufactureRepresentation(v, ctx.manufacture, { itemName: ctx.itemName })
      if (r.ok) return { mode: 'manufacture', state: r.state }
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
