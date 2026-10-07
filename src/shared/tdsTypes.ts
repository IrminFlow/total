// Row shapes of the TDS screen's IPC (WP 3.2), shared by main (src/main/services/tdsWorkbench.ts)
// and the renderer (screens/Tds.tsx). Types only.
//
// WP 3.3: the TCS screen (screens/Tcs.tsx, the same tab components with kind 'tcs') uses the
// same shapes — for TCS "deductee" reads collectee (the buyer), "deducted" collected, the
// expense ledger is the sales ledger (or the goods, see TcsEligibleRow), Form 26Q is Form 27EQ
// and Form 16A is Form 27D.

/** Which withholding a row / call is about: tax deducted (we pay) or collected (we sell). */
export type WithholdingKind = 'tds' | 'tcs'
import type { VoucherKind } from './domain'
import type { DeducteeType } from './tds'
import type { EligibleReason } from './tdsEligibility'

/** Eligible tab: a voucher that should carry TDS and does not. */
export interface TdsEligibleRow {
  voucherId: number
  voucherNumber: string
  date: string
  kind: VoucherKind
  partyLedgerId: number
  partyName: string
  pan: string | null
  deducteeType: DeducteeType | null
  expenseLedgerId: number | null
  expenseLedgerName: string | null
  sectionId: number
  sectionCode: string
  /** Base the deduction would be recorded on, paise. */
  basePaise: number
  /** Effective rate (section / no-PAN / certificate), basis points; null = no rate in force. */
  rateBp: number | null
  /** Suggested deduction, paise; null = no rate in force. */
  tdsPaise: number | null
  reason: EligibleReason
  /** Set when the row is a "Not applicable" mark (only listed with includeExempt). */
  exemptReason: string | null
  candidates: { sectionId: number; code: string }[]
  /** TCS: the stock item whose goods category set the section, if any. */
  stockItemId?: number | null
  stockItemName?: string | null
}

export type ChallanStatus = 'unallocated' | 'allocated' | 'paid'

/** Deducted tab: a recorded tds_entry. */
export interface TdsDeductedRow {
  entryId: number
  voucherId: number
  voucherNumber: string
  date: string
  kind: VoucherKind
  partyLedgerId: number
  partyName: string
  pan: string | null
  sectionId: number
  sectionCode: string
  basePaise: number
  rateBp: number | null
  tdsPaise: number
  deducteeType: DeducteeType | null
  isManual: boolean
  certificateNo: string | null
  challanId: number | null
  challanNo: string | null
  challanStatus: ChallanStatus
}

/** The TDS ledger summary card: a section's tagged payable ledger(s) for the quarter. */
export interface TdsLedgerSummaryRow {
  sectionId: number
  sectionCode: string
  /** First tagged ledger (link target). */
  ledgerId: number | null
  ledgerName: string
  /** Credit balance (owed to the government) at the start of the quarter, paise. */
  openingPaise: number
  /** Credits in the quarter (deductions booked). */
  deductedPaise: number
  /** Debits in the quarter (deposits). */
  depositedPaise: number
  /** Credit balance at the end of the quarter. */
  outstandingPaise: number
  /** Recorded deductions (tds_entries) in the quarter and how many deductees. */
  entriesTdsPaise: number
  deductees: number
}

/** A payment voucher that debits a tagged TDS payable ledger (a deposit). */
export interface TdsPaymentCandidate {
  voucherId: number
  voucherNumber: string
  date: string
  amountPaise: number
  sectionIds: number[]
  sectionCodes: string
  challanId: number | null
}

export interface TdsChallanRow {
  id: number
  date: string
  bsrCode: string
  challanNo: string
  amountPaise: number
  paymentVoucherId: number | null
  paymentVoucherNumber: string | null
  quarter: 1 | 2 | 3 | 4
  fyStartYear: number
  allocatedPaise: number
  entryCount: number
  /** Indicative interest on late deposit over its allocated entries, paise. */
  interestPaise: number
}

export interface TdsChallanEntryInterest {
  entryId: number
  voucherId: number
  voucherNumber: string
  date: string
  partyName: string
  sectionCode: string
  tdsPaise: number
  dueDate: string
  months: number
  interestPaise: number
}

export interface Form26qDeducteeRow {
  serial: number
  entryId: number
  voucherId: number
  partyLedgerId: number
  partyName: string
  pan: string | null
  /** '01' company, '02' other than company; '' unknown. */
  deducteeCode: string
  sectionCode: string
  /** Return section / payment code in force on the date (26Q "94C" / Form 140 "1024"). */
  returnCode: string | null
  paymentDate: string
  amountPaise: number
  tdsPaise: number
  deductionDate: string
  rateBp: number | null
  /** 'A' certificate u/s 197 / 'C' higher rate, no PAN / '' — 26Q annexure reason codes. */
  reasonCode: string
  challanSerial: number | null
  bsrCode: string | null
  challanDate: string | null
  challanNo: string | null
}

export interface Form26qChallanRow {
  serial: number
  challanId: number
  bsrCode: string
  date: string
  challanNo: string
  amountPaise: number
  allocatedPaise: number
  entries: number
}

export interface Form26qData {
  fyStartYear: number
  quarter: 1 | 2 | 3 | 4
  /** TDS: 'form26q' up to FY 2025-26; 'form140' (26Q under the 2025 Act) from 1 Apr 2026.
   *  TCS: 'form27eq' up to FY 2025-26; 'form143' (27EQ under the 2025 Act / Income-tax Rules
   *  2026) from 1 Apr 2026 — see migration 027. */
  layout: 'form26q' | 'form140' | 'form27eq' | 'form143'
  deductees: Form26qDeducteeRow[]
  challans: Form26qChallanRow[]
  totals: { amountPaise: number; tdsPaise: number; depositedPaise: number }
}

export interface Form16aParty {
  partyLedgerId: number
  partyName: string
  pan: string | null
  address: string | null
  payments: { date: string; sectionCode: string; nature: string; amountPaise: number; tdsPaise: number; voucherNumber: string }[]
  challans: { bsrCode: string; date: string; challanNo: string; tdsPaise: number }[]
  totals: { amountPaise: number; tdsPaise: number; depositedPaise: number }
}

export interface Form16aData {
  deductor: { name: string; address: string; pan: string | null; tan: string | null }
  fyStartYear: number
  quarter: 1 | 2 | 3 | 4
  period: { from: string; to: string }
  /** e.g. "2026-27" for FY 2025-26 (1961 Act) — the tax year label under the 2025 Act. */
  assessmentYear: string
  parties: Form16aParty[]
}
