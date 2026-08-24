export type SalesDocumentKind = 'quotation' | 'order' | 'challan' | 'proforma'

export type SalesDocumentStatus =
  | 'draft' | 'sent' | 'accepted' | 'rejected' | 'confirmed'
  | 'part_fulfilled' | 'fulfilled' | 'cancelled' | 'approved'
  | 'returned' | 'converted' | 'expired'

export interface SalesDocumentSeries {
  id: number
  kind: SalesDocumentKind
  name: string
  prefix: string
  suffix: string
  padWidth: number
  restartFy: boolean
  active: boolean
}

export interface SalesDocumentSeriesInput {
  kind: SalesDocumentKind
  name: string
  prefix: string
  suffix: string
  padWidth: number
  restartFy: boolean
  active: boolean
}

export interface SalesDocumentLineInput {
  stockItemId: number | null
  description: string
  qtyMilli: number
  rate: number
  discountBps: number
  gstRate: number
  optional?: boolean
  metadata?: Record<string, unknown>
}

export interface SalesDocumentInput {
  kind: SalesDocumentKind
  seriesId: number
  partyLedgerId: number
  date: string
  validUntil: string | null
  purpose: string | null
  gstRegistrationId: number | null
  terms: string[]
  customFields: Record<string, string>
  lines: SalesDocumentLineInput[]
}

export interface SalesDocumentLine extends SalesDocumentLineInput {
  id: number
  lineOrder: number
  cancelledQtyMilli: number
  allocatedQtyMilli: number
  deliveredQtyMilli: number
  invoicedQtyMilli: number
  returnedQtyMilli: number
  openQtyMilli: number
  baseAmount: number
  discountAmount: number
  taxableAmount: number
  taxAmount: number
  totalAmount: number
}

export interface SalesDocumentTotals {
  baseAmount: number
  discountAmount: number
  taxableAmount: number
  taxAmount: number
  totalAmount: number
}

export interface SalesDocument {
  id: number
  kind: SalesDocumentKind
  seriesId: number
  seriesName: string
  number: string
  revisionNo: number
  partyLedgerId: number
  partyName: string
  date: string
  validUntil: string | null
  status: SalesDocumentStatus
  parentDocumentId: number | null
  purpose: string | null
  gstRegistrationId: number | null
  terms: string[]
  customFields: Record<string, string>
  invoiceDraftId: number | null
  createdBy: string
  createdAt: string
  updatedAt: string
  lines: SalesDocumentLine[]
  totals: SalesDocumentTotals
}

export interface SalesDocumentNumberPreview {
  seriesId: number
  fyStartYear: number
  sequence: number
  number: string
}

export interface SalesDocumentConversionLineInput {
  sourceLineId: number
  qtyMilli: number
}

export interface SalesDocumentConversionInput {
  sourceDocumentId: number
  targetKind: SalesDocumentKind | 'invoice'
  targetSeriesId?: number
  date: string
  lines: SalesDocumentConversionLineInput[]
}

export interface SalesDocumentConversionResult {
  source: SalesDocument
  targetDocument: SalesDocument | null
  invoiceDraftId: number | null
}

/** Integer-paise calculation for one operational document line. */
export function salesLineAmounts(line: Pick<SalesDocumentLineInput, 'qtyMilli' | 'rate' | 'discountBps' | 'gstRate'>): SalesDocumentTotals {
  const baseAmount = Math.round((line.qtyMilli * line.rate) / 1000)
  const discountAmount = Math.round((baseAmount * line.discountBps) / 10_000)
  const taxableAmount = baseAmount - discountAmount
  const taxAmount = Math.round((taxableAmount * line.gstRate) / 100)
  return { baseAmount, discountAmount, taxableAmount, taxAmount, totalAmount: taxableAmount + taxAmount }
}

export function salesDocumentTotals(lines: Array<Pick<SalesDocumentLine, 'baseAmount' | 'discountAmount' | 'taxableAmount' | 'taxAmount' | 'totalAmount'>>): SalesDocumentTotals {
  return lines.reduce((sum, line) => ({
    baseAmount: sum.baseAmount + line.baseAmount,
    discountAmount: sum.discountAmount + line.discountAmount,
    taxableAmount: sum.taxableAmount + line.taxableAmount,
    taxAmount: sum.taxAmount + line.taxAmount,
    totalAmount: sum.totalAmount + line.totalAmount
  }), { baseAmount: 0, discountAmount: 0, taxableAmount: 0, taxAmount: 0, totalAmount: 0 })
}

export const SALES_STATUS_TRANSITIONS: Record<SalesDocumentKind, Partial<Record<SalesDocumentStatus, SalesDocumentStatus[]>>> = {
  quotation: { draft: ['sent', 'cancelled'], sent: ['accepted', 'rejected', 'expired', 'cancelled'], accepted: ['part_fulfilled', 'converted', 'cancelled'], part_fulfilled: ['converted', 'cancelled'] },
  order: { draft: ['confirmed', 'cancelled'], confirmed: ['part_fulfilled', 'fulfilled', 'cancelled'], part_fulfilled: ['fulfilled', 'cancelled'] },
  challan: { draft: ['approved', 'cancelled'], approved: ['part_fulfilled', 'fulfilled', 'returned', 'cancelled'], part_fulfilled: ['fulfilled', 'returned', 'cancelled'] },
  proforma: { draft: ['sent', 'cancelled'], sent: ['accepted', 'rejected', 'expired', 'cancelled'], accepted: ['part_fulfilled', 'converted', 'cancelled'], part_fulfilled: ['converted', 'cancelled'] }
}
