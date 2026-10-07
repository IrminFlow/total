// Row shapes of payroll statutory (WP 3.7), shared by main (src/main/services/payrollStatutory.ts)
// and the renderer / print path. Types only.
import type { StatutoryPaymentKind, StatutoryRateKind } from './schemas'
import type { DeclarationSection, IncomeTaxYear, SalaryWorkings } from './payrollStatutory'

export interface StatutoryRate {
  id: number
  kind: StatutoryRateKind
  state: string | null
  effectiveFrom: string
  effectiveTo: string | null
  rateBp: number | null
  ceilingPaise: number | null
  thresholdPaise: number | null
  minPaise: number | null
  slabFromPaise: number | null
  slabToPaise: number | null
  amountPaise: number | null
  basis: 'month' | 'half_year' | 'year'
  gender: 'any' | 'male' | 'female'
  variant: 'standard' | 'disabled'
  specialMonth: number | null
  specialAmountPaise: number | null
  source: string
  verified: boolean
  isSeeded: boolean
}

export interface TaxDeclaration {
  section: DeclarationSection
  label: string
  amountPaise: number
  proofReceived: boolean
}

export type DueStatus = 'paid' | 'part' | 'unpaid' | 'overdue' | 'nil'

export interface StatutoryDueRow {
  /** kind:period[:state] — stable row key. */
  key: string
  kind: StatutoryPaymentKind
  period: string
  state: string | null
  runId: number
  voucherId: number | null
  employees: number
  /** Employee share deducted (PF incl. VPF / ESI / PT / TDS). */
  employeePaise: number
  /** Employer share + charges (PF: EPF+EPS + EDLI + admin; ESI: 3.25%). */
  employerPaise: number
  payablePaise: number
  paidPaise: number
  outstandingPaise: number
  dueDate: string
  status: DueStatus
  /** Ledger to debit when paying. */
  ledgerId: number | null
}

export interface StatutoryPayment {
  id: number
  kind: StatutoryPaymentKind
  period: string
  state: string | null
  amountPaise: number
  paymentVoucherId: number | null
  voucherNumber: string | null
  reference: string | null
  paidOn: string
  tdsChallanId: number | null
}

export interface Form24qDeducteeRow {
  serial: number
  entryId: number
  voucherId: number
  employeeId: number
  employeeName: string
  pan: string | null
  /** Section code the return carries for salary ('92B' non-government employees; under the 2025
   *  Act's Form 138 the salary payment code). */
  sectionCode: string
  paymentDate: string
  amountPaise: number
  tdsPaise: number
  deductionDate: string
  challanSerial: number | null
  bsrCode: string | null
  challanDate: string | null
  challanNo: string | null
}

export interface Form24qSalaryRow {
  employeeId: number
  employeeName: string
  pan: string | null
  regime: 'new' | 'old'
  periodFrom: string
  periodTo: string
  workings: SalaryWorkings
  tdsDeductedPaise: number
  /** Positive: short-deducted; negative: excess. */
  shortfallPaise: number
}

export interface Form24qData {
  fyStartYear: number
  quarter: 1 | 2 | 3 | 4
  /** 'form24q' up to FY 2025-26; 'form138' (24Q under the Income-tax Rules 2026) from 1 Apr 2026. */
  layout: 'form24q' | 'form138'
  deductees: Form24qDeducteeRow[]
  challans: { serial: number; challanId: number; bsrCode: string; date: string; challanNo: string; amountPaise: number }[]
  /** Annexure II — salary details for the whole year (Q4 only; empty otherwise). */
  salaries: Form24qSalaryRow[]
  totals: { amountPaise: number; tdsPaise: number; depositedPaise: number }
}

export interface Form16Employee {
  employeeId: number
  name: string
  pan: string | null
  designation: string | null
  address: string | null
  periodFrom: string
  periodTo: string
  regime: 'new' | 'old'
  workings: SalaryWorkings
  /** Part A summary — TDS per quarter with deposits. */
  quarters: { quarter: 1 | 2 | 3 | 4; amountPaise: number; tdsPaise: number; depositedPaise: number }[]
  challans: { bsrCode: string; date: string; challanNo: string; tdsPaise: number }[]
  tdsDeductedPaise: number
  refs: IncomeTaxYear['refs']
}

export interface Form16Data {
  deductor: { name: string; address: string; pan: string | null; tan: string | null }
  fyStartYear: number
  /** Assessment year (1961 Act) / tax year (2025 Act) label. */
  yearLabel: string
  act: '1961' | '2025'
  formName: string
  employees: Form16Employee[]
}
