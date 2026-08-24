import type { OutstandingBill } from './reports'

export interface SupplierDueRow {
  ledgerId: number
  name: string
  pending: number
  overdueAmount: number
  dueNext7: number
  oldestOverdueDays: number
  nextDueDate: string | null
  priority: 'critical' | 'high' | 'normal'
  reason: string
  coveredByCash: boolean
  bills: OutstandingBill[]
}

export interface SupplierDueQueue {
  asOn: string
  availableCash: number
  totalPending: number
  overdueAmount: number
  dueNext7: number
  rows: SupplierDueRow[]
}

export interface SupplierAdvanceRow {
  ledgerId: number
  name: string
  pendingAdjustment: number
  oldestDate: string
  ageDays: number
  paymentVoucherIds: number[]
}

export interface PaymentRunBillInput {
  partyLedgerId: number
  billNumber: string
  billDate: string
  amount: number
}

export interface PaymentAccount {
  ledgerId: number
  name: string
  balance: number
}

export interface PaymentRunItem {
  id: number
  partyLedgerId: number
  partyName: string
  amount: number
  bills: { number: string; date: string; amount: number }[]
  voucherId: number | null
}

export interface PaymentRun {
  id: number
  date: string
  bankLedgerId: number
  bankLedgerName: string
  status: 'draft' | 'posted' | 'cancelled'
  totalAmount: number
  note: string | null
  createdBy: string
  createdAt: string
  postedBy: string | null
  postedAt: string | null
  items: PaymentRunItem[]
}

export interface PaymentRunPreview {
  account: PaymentAccount
  totalAmount: number
  balanceAfter: number
  supplierCount: number
  billCount: number
}
