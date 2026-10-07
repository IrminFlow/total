/** Row / result shapes the payables service returns (WP 4.3) — shared by main and the renderer. */
import type { MsmeAgeBucket, MsmeCategory, S15Deadline, BankRateRow, Disallowance43BhStatus, FormMsme1Period } from './msme'
import type { PlanBucket } from './planning'
import type { ReconPair, ReconStatus } from './supplierRecon'

export interface SupplierMsmeFacts {
  category: MsmeCategory | null
  udyamNo: string | null
  /** Micro / small and registered: s.15–16, s.43B(h) and Form 1 apply. */
  covered: boolean
  agreedCreditDays: number | null
}

/** One open supplier bill on the planning screen. */
export interface PayablePlanRow {
  /** `${ledgerId}|${voucherId ?? 'open'}|${number}` — stable for selection. */
  key: string
  ledgerId: number
  partyName: string
  voucherId: number | null
  /** Bill name (bill-wise reference, or our voucher number). */
  number: string
  /** Supplier's invoice number (vouchers.reference), when entered. */
  supplierRef: string | null
  date: string
  amount: number
  pending: number
  /** Credit-terms due date (bill-wise, else bill date + credit days); null = none known. */
  dueDate: string | null
  msme: SupplierMsmeFacts | null
  /** s.15 deadline (micro / small suppliers only). */
  s15: S15Deadline | null
  /** Earlier of the credit-terms due date (or bill date) and the s.15 deadline. */
  payBy: string
  bucket: PlanBucket
  /** Days from the plan date to payBy (negative = overdue). */
  daysToPay: number
  /** Early-payment discount on the pending amount, when the supplier offers one. */
  discount: { by: string; bp: number; paise: number; available: boolean } | null
  /** Indicative s.16 interest accrued to the plan date (micro / small, past the deadline). */
  interestIndicative: number
}

export interface PlanCashLedger {
  ledgerId: number
  name: string
  kind: 'cash' | 'bank'
  balance: number
}

export interface PayablesPlan {
  asOn: string
  rows: PayablePlanRow[]
  totals: Record<PlanBucket, number> & { pending: number; msmeOverdue: number; discountAvailable: number }
  cash: { ledgers: PlanCashLedger[]; total: number }
}

/** A payment voucher the run will post (preview) or posted. */
export interface PaymentRunLine {
  partyLedgerId: number
  partyName: string
  bankLedgerId: number
  bankName: string
  /** Settled on the supplier's ledger (Dr supplier). */
  amount: number
  /** TDS deducted on payment (WP 3.2's first-of-credit-or-payment rule). */
  tds: { sectionId: number; code: string; base: number; amount: number } | null
  /** Cr bank = amount − tds. */
  bankAmount: number
  bills: { name: string; amount: number }[]
  /** Always 0 since bills picked must equal the amount (kept for the run CSV / UI shape). */
  onAccount: number
  instrumentNo: string | null
  voucherId?: number
  voucherNumber?: string
  errors: string[]
}

export interface PaymentRunPreview {
  lines: PaymentRunLine[]
  totals: { amount: number; tds: number; bank: number; vouchers: number }
  /** Bank balances before / after the run, per bank used. */
  banks: { ledgerId: number; name: string; before: number; after: number }[]
  ok: boolean
}

export interface PaymentRun {
  id: number
  runNo: string
  kind: 'plan' | 'batch'
  date: string
  createdAt: string
  note: string | null
  vouchers: number
  amount: number
  /** Live (not binned) vouchers only. */
  lines: PaymentRunLine[]
}

/** One open MSME bill on the MSME report. */
export interface MsmeBillRow {
  key: string
  ledgerId: number
  partyName: string
  category: MsmeCategory
  udyamNo: string | null
  pan: string | null
  voucherId: number | null
  number: string
  supplierRef: string | null
  date: string
  amount: number
  pending: number
  s15: S15Deadline
  bucket: MsmeAgeBucket
  daysLate: number
  /** Days since acceptance (bill date) as on the report date. */
  ageDays: number
  interest: { paise: number; rateBp: number | null; months: number; days: number }
}

export interface MsmeBill43Bh {
  key: string
  ledgerId: number
  partyName: string
  voucherId: number | null
  number: string
  date: string
  payBy: string
  pendingAtFyEnd: number
  status: Disallowance43BhStatus
  disallowed: number
  atRisk: number
}

export interface MsmeFormRow {
  ledgerId: number
  partyName: string
  pan: string | null
  udyamNo: string | null
  category: MsmeCategory
  voucherId: number | null
  number: string
  supplierRef: string | null
  /** Date of acceptance (bill date). */
  date: string
  amount: number
  /** Outstanding at the half-year end. */
  pending: number
  /** Date from which the amount is due (the day after the s.15 deadline). */
  dueFrom: string
  /** Days outstanding from acceptance to the half-year end. */
  days: number
}

/** One supplier line of the revised MSME Form 1 for a half-year. Settlements by debit note count as
 *  payments; a bill booked and settled on the same day is not seen. */
export interface MsmeForm1Supplier {
  ledgerId: number
  partyName: string
  pan: string | null
  udyamNo: string | null
  paidWithin45: { count: number; amount: number }
  paidAfter45: { count: number; amount: number }
  outstandingUpTo45: number
  outstandingOver45: number
}

export interface MsmeReport {
  asOn: string
  rows: MsmeBillRow[]
  buckets: Record<MsmeAgeBucket, number>
  totalPending: number
  totalInterest: number
  bankRate: BankRateRow | null
  /** 3 × bank rate in force on asOn, bp. */
  s16RateBp: number | null
  /** s.43B(h) for the financial year of asOn (or the requested FY). */
  disallowance: {
    fyStartYear: number
    fyEnd: string
    disallowed: number
    atRisk: number
    bills: MsmeBill43Bh[]
  }
  /** MSME Form 1 data for the half-year requested (default: the last completed half-year):
   *  the revised form's per-supplier lines (S.O. 2751(E), 15 Jul 2024) and the bill detail behind
   *  the "outstanding > 45 days" column. `mustFile`: some amount is outstanding > 45 days. */
  form1: { period: FormMsme1Period; rows: MsmeFormRow[]; total: number; suppliers: MsmeForm1Supplier[]; mustFile: boolean }
  /** Suppliers marked MSME but not classified / without a Udyam number (data gaps). */
  gaps: { ledgerId: number; name: string; issue: string }[]
}

export interface MsmeDueSummary {
  asOn: string
  /** Micro / small dues whose s.15 deadline falls this week (today … Sunday). */
  dueThisWeek: number
  dueThisWeekBills: number
  /** Already past the s.15 deadline. */
  overdue: number
  overdueBills: number
}

/** Year-end close warning (additive on the close preview). */
export interface MsmeYearEndWarning {
  asOn: string
  /** MSME dues past the s.15 deadline on the FY's last day. */
  overdue: number
  bills: number
  parties: number
  /** s.43B(h) figure for the year (definitely disallowed so far). */
  disallowed: number
}

export interface SupplierStatementRow {
  voucherId: number
  date: string
  voucherType: string
  number: string
  supplierRef: string | null
  particulars: string
  narration: string | null
  /** Debit to the supplier (payments, debit notes). */
  debit: number
  /** Credit to the supplier (bills). */
  credit: number
  /** Signed running balance, positive = we owe (Cr). */
  balance: number
}

export interface SupplierStatement {
  ledgerId: number
  name: string
  from: string
  to: string
  /** Positive = we owe (Cr). */
  opening: number
  closing: number
  rows: SupplierStatementRow[]
}

export interface SupplierReconResult {
  ledgerId: number
  name: string
  from: string
  to: string
  pairs: ReconPair[]
  counts: Record<ReconStatus, number>
  supplierBalance: number
  bookBalance: number
  /** bookBalance − supplierBalance for the period's lines. */
  difference: number
  skipped: { line: number; reason: string }[]
  parseError: string | null
}
