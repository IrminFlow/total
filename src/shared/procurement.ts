export type RequisitionStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'converted' | 'cancelled'
export type PurchaseOrderStatus = 'draft' | 'issued' | 'part_received' | 'received' | 'closed' | 'cancelled'

export interface RequisitionLine { id: number; stockItemId: number; itemName: string; unitSymbol: string; qtyMilli: number; note: string | null }
export interface PurchaseRequisition { id: number; number: string; date: string; neededBy: string | null; department: string | null; note: string | null; status: RequisitionStatus; requestedBy: string; approvedBy: string | null; approvalNote: string | null; createdAt: string; updatedAt: string; lines: RequisitionLine[] }
export interface RequisitionInput { date: string; neededBy: string | null; department: string | null; note: string | null; lines: { stockItemId: number; qtyMilli: number; note: string | null }[] }

export interface PurchaseOrderLine { id: number; stockItemId: number; itemName: string; unitSymbol: string; qtyOrderedMilli: number; qtyReceivedMilli: number; qtyAcceptedMilli: number; qtyRejectedMilli: number; outstandingQtyMilli: number; qtyBilledMilli: number; outstandingBillQtyMilli: number; ratePaise: number; gstRate: number }
export interface PurchaseOrder { id: number; number: string; date: string; expectedDate: string | null; supplierLedgerId: number; supplierName: string; requisitionId: number | null; status: PurchaseOrderStatus; note: string | null; createdBy: string; createdAt: string; updatedAt: string; lines: PurchaseOrderLine[] }
export interface PurchaseOrderInput { date: string; expectedDate: string | null; supplierLedgerId: number; requisitionId: number | null; note: string | null; lines: { stockItemId: number; qtyMilli: number; ratePaise: number; gstRate: number }[] }

export interface GoodsReceiptLine { id: number; purchaseOrderLineId: number; stockItemId: number; itemName: string; unitSymbol: string; qtyReceivedMilli: number; qtyAcceptedMilli: number; qtyRejectedMilli: number }
export interface GoodsReceipt { id: number; number: string; purchaseOrderId: number; purchaseOrderNumber: string; date: string; status: 'posted' | 'cancelled'; note: string | null; inventoryVoucherId: number; receivedBy: string; createdAt: string; lines: GoodsReceiptLine[] }
export interface GoodsReceiptInput { purchaseOrderId: number; date: string; note: string | null; lines: { purchaseOrderLineId: number; qtyReceivedMilli: number; qtyAcceptedMilli: number; qtyRejectedMilli: number }[] }

export interface InvoiceMatchCandidate {
  goodsReceiptId: number
  goodsReceiptNumber: string
  goodsReceiptDate: string
  purchaseOrderId: number
  purchaseOrderNumber: string
  supplierLedgerId: number
  supplierName: string
  lines: {
    purchaseOrderLineId: number
    stockItemId: number
    itemName: string
    unitSymbol: string
    orderedQtyMilli: number
    acceptedQtyMilli: number
    poRatePaise: number
    gstRate: number
  }[]
}

export interface InvoiceMatchLineInput { stockItemId: number; qtyMilli: number; ratePaise: number; amount: number; gstRate: number }
export interface InvoiceMatchInput { goodsReceiptId: number; lines: InvoiceMatchLineInput[] }
export interface InvoiceMatchPreviewLine extends InvoiceMatchLineInput {
  itemName: string
  unitSymbol: string
  orderedQtyMilli: number
  acceptedQtyMilli: number
  poRatePaise: number
  quantityVarianceMilli: number
  rateVariancePaise: number
}
export interface InvoiceMatchPreview {
  goodsReceiptId: number
  goodsReceiptNumber: string
  purchaseOrderId: number
  purchaseOrderNumber: string
  supplierLedgerId: number
  supplierName: string
  status: 'exact' | 'variance'
  quantityVarianceCount: number
  rateVarianceCount: number
  lines: InvoiceMatchPreviewLine[]
}

export interface SupplierPriceHistoryRow {
  stockItemId: number
  itemName: string
  supplierLedgerId: number
  supplierName: string
  date: string
  voucherId: number
  voucherNumber: string
  qtyMilli: number
  ratePaise: number
  source: 'purchase_invoice' | 'matched_invoice'
}

export interface SupplierComparisonRow {
  supplierLedgerId: number
  supplierName: string
  creditDays: number | null
  lastRatePaise: number
  effectiveRateIncTaxPaise: number
  weightedAverageRatePaise: number
  orderCount: number
  orderedQtyMilli: number
  acceptedQtyMilli: number
  rejectedQtyMilli: number
  rejectionRate: number
  onTimeDeliveryRate: number | null
  averageLeadDays: number | null
}

export interface ProcurementDebitNoteClaim {
  sourceKey: string
  reason: 'shortage' | 'rejection' | 'rate_difference'
  purchaseOrderId: number
  purchaseOrderNumber: string
  goodsReceiptId: number | null
  goodsReceiptNumber: string | null
  invoiceMatchId: number | null
  supplierLedgerId: number
  supplierName: string
  amount: number
  detail: string
  lines: { stockItemId: number; itemName: string; qtyMilli: number; ratePaise: number; gstRate: number }[]
}

export interface SupplierConcentrationRow {
  supplierLedgerId: number
  supplierName: string
  purchaseAmount: number
  sharePercent: number
  soleSourcedItemCount: number
  categories: string[]
  risk: 'high' | 'watch' | 'diversified'
}
export interface SupplierConcentrationReport { totalPurchases: number; rows: SupplierConcentrationRow[] }

export interface ReorderSuggestion {
  stockItemId: number
  itemName: string
  unitSymbol: string
  closingQtyMilli: number
  reorderLevelMilli: number
  suggestedQtyMilli: number
  supplierLedgerId: number | null
  supplierName: string | null
  lastRatePaise: number | null
  gstRate: number
}

export interface VendorOnboardingIssue { field: 'gstin' | 'pan' | 'email' | 'phone' | 'bank_account'; severity: 'block' | 'review'; message: string }
export interface VendorProfile {
  id: number
  ledgerId: number
  supplierName: string
  gstin: string | null
  pan: string | null
  contactName: string | null
  email: string | null
  phone: string | null
  bankName: string | null
  bankAccount: string | null
  ifsc: string | null
  udyamNumber: string | null
  status: 'draft' | 'verified' | 'blocked'
  reviewNote: string | null
  verifiedBy: string | null
  verifiedAt: string | null
  updatedAt: string
  issues: VendorOnboardingIssue[]
}
export interface VendorProfileInput { ledgerId: number; contactName: string | null; email: string | null; phone: string | null; bankName: string | null; bankAccount: string | null; ifsc: string | null; udyamNumber: string | null }
