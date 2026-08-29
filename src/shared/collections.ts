import type { OutstandingBill } from './reports'

export interface CollectionPromise {
  id: number
  ledgerId: number
  amount: number
  promisedDate: string
  owner: string
  note: string | null
  status: 'pending' | 'kept' | 'broken' | 'cancelled'
  outcomeNote: string | null
  createdAt: string
  resolvedAt: string | null
}

export interface CollectionQueueRow {
  ledgerId: number
  name: string
  pending: number
  overdueAmount: number
  oldestOverdueDays: number
  brokenPromises: number
  priorityScore: number
  priority: 'critical' | 'high' | 'normal'
  reason: string
  nextPromise: CollectionPromise | null
  bills: OutstandingBill[]
}

export interface CollectionCustomerSettings {
  owner: string
  reminderDays: number[]
  earlyDiscountBps: number
  earlyDays: number
}

export interface CollectionTimelineItem {
  id: string
  at: string
  kind: 'invoice' | 'receipt' | 'credit_note' | 'promise' | 'reminder' | 'dispute' | 'note'
  title: string
  detail: string
  amount: number | null
  voucherId: number | null
  status: string | null
}

export interface CollectionCustomerWorkspace {
  ledgerId: number
  name: string
  settings: CollectionCustomerSettings
  timeline: CollectionTimelineItem[]
  disputes: { id: number; voucherId: number; reason: string; owner: string; status: 'open' | 'resolved'; resolution: string | null; createdAt: string }[]
  ageingTrend: { asOn: string; buckets: [number, number, number, number]; pending: number }[]
  dso: { customerDays: number | null; companyDays: number | null; periodDays: number; customerCreditSales: number; companyCreditSales: number; customerReceivable: number; companyReceivable: number }
  risk: { band: 'low' | 'medium' | 'high'; score: number; reasons: string[] }
  earlyPayment: { discountAmount: number; payAmount: number; expiresOn: string | null; annualizedCostBps: number | null }
  forecast: { date: string; amount: number; source: 'promise' | 'due_date' | 'behavior'; voucherId: number | null; label: string }[]
  remindersDue: { voucherId: number | null; billNumber: string; overdueDays: number; cadenceDay: number }[]
}

export interface ReceiptSuggestion {
  voucherId: number | null
  billNumber: string
  partyLedgerId: number
  partyName: string
  pending: number
  dueDate: string | null
  score: number
  reasons: string[]
}
