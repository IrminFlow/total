import type {
  Batch, BomLine, Budget, CompanyInfo, CostCentre, Currency, Employee, Godown, Group, Ledger, NegativeStockWarning,
  PayrollLine, PayrollRun, PriceLevel, PriceListRate, RecurringTemplate, SaveVoucherWarnings, StockGroup, StockItem, TdsSection, Unit,
  Voucher, VoucherTransport, VoucherType
} from '@shared/domain'
import type { BudgetVarianceRow } from '@shared/budgets'
import type {
  BalanceSheet, BankRecon, DashboardData, DayBookRow, EdocListRow, ExceptionsReport, GroupTreeNode,
  DayBookTypeRow, ItemProfitRow, KhataParty, LedgerBalanceRow, PartyShareRow, PayrollTrendPoint,
  PurchaseSuggestionRow,
  ReconciliationStatus,
  LedgerStatement, OutstandingBill, OutstandingParty, ProfitAndLoss, RegisterPeriodRow, StockAgeingRow,
  StockSummaryRow, TrialBalance,
  VoucherListRow
} from '@shared/reports'
import type { CashFlowStatement } from '@shared/reportMath'
import type { TransferItem, TransferPlan } from '@shared/stockTransfer'
import type { LandedCostBasis } from '@shared/landedCost'
import type { ReorderAlerts } from '@shared/reorder'
import type { Concentration } from '@shared/concentration'
import type { VoucherDraft } from '../state/stores'
import type { Gstr1Result, Gstr3bResult } from '@shared/gst/returns'
import type { GstIssue } from '@shared/gst/validate'
import type { Recon2bResult } from '@shared/gst/recon2b'
import type {
  AgentExportInput,
  AuditListInput, BankRuleInput, BatchInput, BomInput, BudgetInput, ChequeConfig, CompanyCreateInput, CostCentreInput,
  CurrencyInput, EmployeeHeadsSetInput, EmployeeInputPayload, GodownInput, GroupInput, Gst3bManualInput, LedgerInput, NicCredentials,
  PayHeadInput, PriceLevelInput,
  PriceRateInput, RecurringInput,
  RendererLogInput, StockGroupInput, StockItemInput, TdsSectionInput, UnitInput, UserInput, VoucherTransportInput, VoucherTypeInput,
  VoucherInputParsed
} from '@shared/schemas'
import type { CompanyFeatures } from '@shared/features'
import type { SearchHit } from '@shared/search'
import type { InvoiceConfig } from '@shared/invoiceConfig'
import type { CloseLedgerRow } from '@shared/yearEnd'
import type { ConsolidatedResult } from '@shared/consolidate'
import type { Period } from '@shared/period'
import type { AiConfigView, AiSettings } from '@shared/ai/config'
import type { LicenseState } from '@shared/license'
import type { Cmp08, CompositionCategory, Gstr4 } from '@shared/gst/composition'
import type { FilingLiability, FilingRecord, FilingRow } from '@shared/gst/filings'
import type { Gstr9Working } from '@shared/gst/gstr9'
import type { ChecklistState } from '@shared/onboarding'
import type { DailyDigest } from '@shared/digest'
import type { Registry } from '../types'

export type Role = 'owner' | 'accountant' | 'viewer'

export interface SessionUser {
  id: number
  name: string
  role: Role
}

export interface LoginName {
  id: number
  name: string
  role: Role
}

/** Mirrors src/main/db/backup.ts's BackupInfo shape (kept local — that file is main-process only). */
export interface BackupInfo {
  file: string
  sizeBytes: number
  mtime: number
  tag: string
}

/** Mirrors src/main/services/partyNotes.ts (kept local — that file is main-process only). */
export interface PartyNote {
  id: number
  ledgerId: number
  at: string
  userName: string | null
  note: string
  /** ISO date they said they would pay, when they said one. */
  promisedDate: string | null
  promisedAmount: number | null
  closedAt: string | null
}

export interface PromiseRow extends PartyNote {
  partyName: string
  /** Days past the promised date; negative while it is still in the future. */
  overdueDays: number
}


/**
 * The collections desk. Every one of these mirrors a type in src/main/services/receivables.ts —
 * kept local rather than imported because that module reaches for better-sqlite3, which the
 * renderer bundle must never see.
 */
export interface InterestLineView {
  number: string
  date: string
  dueDate: string | null
  pending: number
  overdueDays: number
  chargeableDays: number
  interest: number
}

export interface PartyInterest {
  ledgerId: number
  name: string
  pending: number
  terms: { rateBp: number; graceDays: number }
  termsLabel: string
  interest: { lines: InterestLineView[]; total: number; rateBp: number; graceDays: number }
}

export type CreditBand = 'excellent' | 'good' | 'fair' | 'poor'

export interface CreditScoreView {
  score: number
  band: CreditBand
  avgDaysLate: number
  onTimeRate: number
  worstDaysLate: number
  overdueNow: number
  sample: number
}

export interface PartyCreditScore {
  ledgerId: number
  name: string
  score: CreditScoreView | null
  creditLimit: number | null
  pending: number
}

export interface AllocationView {
  number: string
  voucherId: number | null
  date: string
  pending: number
  applied: number
}

export interface AllocationSuggestion {
  kind: 'exact-single' | 'exact-combination' | 'fifo' | 'fifo-partial'
  label: string
  allocations: AllocationView[]
  leftover: number
  exact: boolean
}

export interface AgeingGroupRow {
  key: string
  pending: number
  billCount: number
  partyCount: number
  buckets: number[]
  worstOverdueDays: number
}

export interface AgeingByResult {
  dimension: 'salesperson' | 'territory' | 'party'
  bandLabels: string[]
  rows: AgeingGroupRow[]
  total: number
  totals: number[]
}

export interface ProvisionBillLine {
  number: string
  date: string
  pending: number
  overdueDays: number
  pct: number
  provision: number
}

export interface ProvisionParty {
  ledgerId: number
  name: string
  pending: number
  provision: number
  bills: ProvisionBillLine[]
}

export interface ProvisionRule {
  afterDays: number
  pct: number
}

export interface ProvisionDraft {
  date: string
  narration: string
  lines: { ledgerName: string; drCr: 'dr' | 'cr'; amount: number }[]
  total: number
  missingLedgers: string[]
}

export interface ProvisionResponse {
  result: { parties: ProvisionParty[]; total: number; policy: ProvisionRule[] }
  draft: ProvisionDraft | null
}

export interface AdvanceRow {
  ledgerId: number
  name: string
  unapplied: number
  openBills: number
  lastReceiptDate: string | null
}

export interface ScheduleBill {
  ledgerId: number
  party: string
  number: string
  date: string
  dueDate: string | null
  pending: number
  overdueDays: number
}

export interface ScheduleDay {
  date: string
  bills: ScheduleBill[]
  due: number
  cumulative: number
  balanceAfter: number
}

export interface PaymentSchedule {
  from: string
  to: string
  funds: number
  overdue: ScheduleBill[]
  overdueTotal: number
  days: ScheduleDay[]
  total: number
  shortfallDate: string | null
}

export type ReminderTone = 'gentle' | 'firm' | 'final'

export interface BulkReminderRow {
  ledgerId: number
  name: string
  pending: number
  worstOverdueDays: number
  tone: ReminderTone
  phone: string | null
  email: string | null
  subject: string
  body: string
  mailto: string
  whatsapp: string | null
  interest: number
}

export interface StatementLine {
  date: string
  number: string
  particulars: string
  debit: number | null
  credit: number | null
  balance: number
  voucherId: number | null
}

export interface PartyStatement {
  ledgerId: number
  name: string
  address: string | null
  gstin: string | null
  phone: string | null
  email: string | null
  from: string
  to: string
  openingBalance: number
  lines: StatementLine[]
  closingBalance: number
  openBills: OutstandingBill[]
  bandLabels: string[]
  buckets: number[]
  interest: { lines: InterestLineView[]; total: number; rateBp: number; graceDays: number } | null
  termsLabel: string | null
}


/** Mirrors src/main/services/attendance.ts and the payroll settlement service. */
export interface AttendanceRow {
  id: number
  employeeId: number
  employeeName: string
  month: string
  presentDays: number
  paidLeaveDays: number
  lopDays: number
  note: string | null
  payableDays: number
  monthDays: number
}

export interface LoanRow {
  id: number
  employeeId: number
  employeeName: string
  grantedOn: string
  principal: number
  instalment: number
  note: string | null
  closedAt: string | null
  recovered: number
  outstanding: number
  instalmentsLeft: number
}

export interface DueRecovery {
  loanId: number
  employeeId: number
  employeeName: string
  amount: number
  outstanding: number
  final: boolean
}

export interface EcrProblem {
  employee: string
  field: 'uan' | 'name' | 'wages' | 'contribution' | 'days'
  severity: 'error' | 'warning'
  message: string
}

export interface EcrCheck {
  month: string
  problems: EcrProblem[]
  uploadable: boolean
  skipped: { name: string; reason: string }[]
  memberCount: number
}

export interface FnfLine {
  label: string
  working: string
  amount: number
  kind: 'payable' | 'recovery'
}

export interface Settlement {
  employeeId: number
  result: {
    employeeName: string
    joined: string
    lastDay: string
    lines: FnfLine[]
    totalPayable: number
    totalRecovery: number
    net: number
    gratuity: {
      eligible: boolean
      reason: string | null
      countedYears: number
      serviceYears: number
      serviceMonths: number
      serviceDays: number
      computed: number
      amount: number
      cappedByCeiling: boolean
    }
    bonus: { eligible: boolean; reason: string | null; calculationBase: number; percent: number; monthsPayable: number; amount: number } | null
    notes: string[]
  }
  draft: {
    date: string
    narration: string
    lines: { ledgerName: string; group: string; drCr: 'dr' | 'cr'; amount: number }[]
  } | null
}

export interface TaxComputation {
  grossSalary: number
  standardDeduction: number
  chapterVIA: number
  professionalTaxAllowed: number
  taxableIncome: number
  taxBeforeRebate: number
  rebate: number
  surcharge: number
  cess: number
  totalTax: number
  rates: { fyStartYear: number; regime: 'new' | 'old'; note: string; assumedFromEarlierYear: boolean }
}

export interface EmployeeTax {
  employeeId: number
  employeeName: string
  regime: 'new' | 'old'
  annualGross: number
  computation: TaxComputation
  deductedSoFar: number
  monthsRemaining: number
  thisMonth: number
}

export interface Form16 {
  employeeId: number
  employeeName: string
  pan: string | null
  designation: string | null
  fyStartYear: number
  fyLabel: string
  ayLabel: string
  regime: 'new' | 'old'
  grossSalary: number
  rows: { label: string; amount: number; indent?: boolean }[]
  computation: TaxComputation
  tdsDeducted: number
  shortfall: number
  monthsPaid: number
  months: { month: string; gross: number; tds: number }[]
}

export interface PayslipDelivery {
  employeeId: number
  employeeName: string
  path: string
  whatsapp: string | null
  mailto: string | null
  net: number
}

export interface StatutoryRates {
  effectiveFrom: string
  pfWageCeiling: number
  pfRate: number
  epsRate: number
  pfAdminRate: number
  edliRate: number
  esiGrossLimit: number
  esiEmpRate: number
  esiErRate: number
  note: string
}

export type ExpiryBucket = 'none' | 'expired' | 'within30' | 'within90' | 'later'

export interface NearExpiryRow {
  batchId: number
  batchName: string
  stockItemId: number
  itemName: string
  unitSymbol: string
  decimals: number
  mfgDate: string | null
  expiryDate: string | null
  closingQtyMilli: number
  bucket: ExpiryBucket
  daysToExpiry: number
  value: number
  ageDays: number | null
}

export interface NearExpiryReport {
  asOn: string
  rows: NearExpiryRow[]
  summary: { bucket: ExpiryBucket; label: string; value: number; batches: number }[]
  atRisk: number
  expired: number
  undatedBatches: number
  undatedQtyMilli: number
}

export interface EffectiveItemTax {
  gstRate: number | null
  cessRate: number | null
  hsn: string | null
  inherited: { gstRate: boolean; cessRate: boolean; hsn: boolean }
  fromGroup: string | null
}

export type DepreciationMethod = 'slm' | 'wdv'

export interface AssetBlock {
  id: number
  name: string
  itRate: number
}

export interface FixedAsset {
  id: number
  name: string
  code: string | null
  blockId: number | null
  blockName: string | null
  itRate: number | null
  ledgerId: number | null
  ledgerName: string | null
  purchaseDate: string
  putToUseDate: string | null
  cost: number
  residualValue: number
  usefulLifeMonths: number
  method: DepreciationMethod
  location: string | null
  notes: string | null
  disposedOn: string | null
  disposalProceeds: number | null
  accumulated: number
  bookValue: number
}

export interface AssetScheduleRow {
  assetId: number
  name: string
  code: string | null
  blockName: string | null
  purchaseDate: string
  putToUseDate: string | null
  method: DepreciationMethod
  cost: number
  openingWdv: number
  depreciation: number
  closingWdv: number
  heldFraction: number
  cappedAtResidual: boolean
  disposedOn: string | null
}

export interface BlockResult {
  blockName: string
  rate: number
  openingWdv: number
  additionsFullRate: number
  additionsHalfRate: number
  deletions: number
  writtenDownBeforeDepreciation: number
  depreciation: number
  closingWdv: number
  blockExhausted: boolean
  shortTermGain: number
}

export interface DepreciationSchedule {
  fyStartYear: number
  from: string
  to: string
  companiesAct: AssetScheduleRow[]
  companiesActTotal: number
  incomeTax: BlockResult[]
  incomeTaxTotal: number
  difference: number
  unblocked: number
  alreadyPosted: boolean
}

export interface DepreciationDraft {
  fyStartYear: number
  date: string
  narration: string
  lines: { ledgerName: string; group: string; drCr: 'dr' | 'cr'; amount: number }[]
  total: number
}

export interface DisposalDraft {
  asset: FixedAsset
  bookValue: number
  proceeds: number
  profitOrLoss: number
  incomeTaxTreatment: string
  lines: { ledgerName: string; group: string; drCr: 'dr' | 'cr'; amount: number }[]
  narration: string
  date: string
}

export interface RelatedPartyTxn {
  voucherId: number
  date: string
  number: string
  kind: string
  amount: number
}

export interface RelatedPartyRow {
  ledgerId: number
  name: string
  relationship: string | null
  closingBalance: number
  debits: number
  credits: number
  transactions: RelatedPartyTxn[]
}

export interface RelatedPartyReport {
  from: string
  to: string
  rows: RelatedPartyRow[]
  totalDebits: number
  totalCredits: number
  dormant: number
}

export interface AuditTrailStatement {
  from: string
  to: string
  entries: number
  firstEntry: string | null
  lastEntry: string | null
  entities: { entity: string; entries: number }[]
  users: { userName: string; entries: number }[]
  canBeDisabled: boolean
  retentionDays: number | null
  retentionAffectsPeriod: boolean
}

export interface Lut {
  arn: string
  fyStartYear: number
  filedOn: string
}

export interface LutStatus {
  state: 'valid' | 'expiring' | 'expired' | 'missing'
  lut: Lut | null
  validFrom: string | null
  validTo: string | null
  daysLeft: number | null
  message: string
}

export type ReportingUrgency = 'reported' | 'expired' | 'critical' | 'due' | 'fine'

export interface EInvoiceWindowRow {
  voucherId: number
  number: string
  date: string
  party: string
  value: number
  irn: string | null
  urgency: ReportingUrgency
  daysLeft: number
  deadline: string
  label: string
}

export interface EInvoiceWindowReport {
  today: string
  applies: boolean
  rows: EInvoiceWindowRow[]
  expired: number
  expiredValue: number
  critical: number
}

export interface CreditStatus {
  ledgerId: number
  name: string
  creditLimit: number | null
  outstanding: number
  after: number
  used: number | null
  exceeds: boolean
  enforced: boolean
  headroom: number | null
}

export type MsmeStatus = 'micro' | 'small' | 'medium' | 'not_registered'

export interface MsmeBillLine {
  number: string
  date: string
  pending: number
  creditDays: number | null
  dueDate: string
  limitLabel: string
  overdueDays: number
  disallowed: boolean
  interest: number
}

export interface MsmeParty {
  ledgerId: number
  name: string
  status: MsmeStatus
  udyamNumber: string | null
  pending: number
  disallowed: number
  interest: number
  bills: MsmeBillLine[]
}

export interface MsmeReport {
  asOn: string
  bankRatePercent: number
  parties: MsmeParty[]
  totalDisallowed: number
  totalPending: number
  totalInterest: number
  unclassifiedParties: number
  unclassifiedPending: number
}

export interface CollectionsPolicy {
  interestRateBp: number
  interestGraceDays: number
  bandCuts: number[]
  provisionPolicy: ProvisionRule[]
  reminderMinOverdueDays: number
  contact: string | null
  msmeBankRatePercent: number
}

/** Mirrors src/main/db/backup.ts's BackupVerification (kept local — main-process only). */
export interface BackupVerification {
  file: string
  integrityOk: boolean
  opensAsCompany: boolean
  voucherCount: number
  balanced: boolean
  totalDebit: number
  totalCredit: number
  problem: string | null
}

/** Mirrors src/main/db/integrity.ts's IntegrityResult shape (kept local — main-process only). */
export interface IntegrityResult {
  ok: boolean
  quickCheck: string
  unbalancedVoucherIds: number[]
}

/** Mirrors src/main/services/vouchers.ts's BinRow shape (kept local — that file is main-process only). */
export interface BinRow {
  id: number
  date: string
  number: string
  voucherType: string
  account: string
  amount: number
  deletedAt: string
}

/** Mirrors src/main/services/users.ts's User shape (kept local — that file is main-process only). */
export interface UserRow {
  id: number
  name: string
  role: Role
  active: boolean
  createdAt: string
}

/** Mirrors src/main/services/audit.ts's AuditRow shape (kept local — that file is main-process only). */
export interface AuditRow {
  id: number
  entity: string
  entityId: number
  action: 'create' | 'update' | 'delete' | 'login' | 'login_failed' | 'logout' | 'export' | 'import'
  at: string
  beforeJson: string | null
  afterJson: string | null
  userName: string | null
  appVersion: string | null
}

/** Mirrors src/main/services/banking.ts's BankRuleRecord shape (kept local — main-process only). */
export interface BankRuleRecord {
  id: number
  pattern: string
  matchField: string
  ledgerId: number
  ledgerName: string
  kind: 'payment' | 'receipt'
  minAmount: number | null
  maxAmount: number | null
  autoApply: boolean
  active: boolean
  hits: number
}

/** Mirrors src/main/services/banking.ts's BankVoucherDraft / BankSuggestionRow / UnmatchedRow /
 *  BankMatchSuggestion / ImportResult / BrsReport shapes (kept local — main-process only). */
export interface BankVoucherDraft {
  date: string
  narration: string
  lines: { ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[]
}

export interface BankUnmatchedRow {
  date: string
  description: string
  reference: string
  amount: number
  kind: 'deposit' | 'withdrawal'
}

export interface BankSuggestion {
  /** null for a suggestion the narration memory produced — no rule behind it yet (#133). */
  ruleId: number | null
  ledgerId: number
  ledgerName: string
  kind: 'payment' | 'receipt'
  voucherDraft: BankVoucherDraft
  source: 'rule' | 'learned'
  /** 0-100; a rule is 100. Bulk accept (#134) compares this against the user's threshold. */
  confidence: number
  matched: string[]
  ambiguous: boolean
}

export interface BankSuggestionRow {
  statementRow: BankUnmatchedRow
  suggestion: BankSuggestion | null
}

/** Mirrors src/shared/bankImport.ts's ProfileColumns / StatementProfile (#131). */
export interface BankProfileColumns {
  date: string
  narration: string
  reference?: string | null
  debit?: string | null
  credit?: string | null
  amount?: string | null
  drCr?: string | null
  balance?: string | null
}

export type BankDateFormat = 'dmy' | 'mdy' | 'ymd'
export type BankAmountConvention = 'debit_credit' | 'signed' | 'flagged'

export interface BankImportProfile {
  id: string
  name: string
  builtIn: boolean
  dateFormat: BankDateFormat
  convention: BankAmountConvention
  debitFlag?: string | null
  columns: BankProfileColumns
}

export interface BankProfileInput {
  name: string
  dateFormat: BankDateFormat
  convention: BankAmountConvention
  debitFlag: string | null
  columns: BankProfileColumns
}

/** A column map the user is trying out in the mapper but has not saved. */
export type BankAdHocProfile = Omit<BankProfileInput, 'name'> & { name?: string }

export interface BankStatementInspection {
  header: string[]
  profileId: string | null
  profileName: string | null
  detected: boolean
  columns: BankProfileColumns | null
  dateFormat: BankDateFormat
  convention: BankAmountConvention
  debitFlag: string | null
  rowsReadable: number
  rowsSkipped: number
  sample: { date: string; description: string; reference: string; deposit: number; withdrawal: number }[]
  error: string | null
  csvText: string
}

export interface BankBulkAcceptRow {
  date: string
  description: string
  amount: number
  kind: 'deposit' | 'withdrawal'
  ledgerId: number
  ledgerName: string
  confidence: number
  source: 'rule' | 'learned'
  voucherId?: number
}

export interface BankBulkAcceptResult {
  minConfidence: number
  accepted: BankBulkAcceptRow[]
  count: number
  depositTotal: number
  withdrawalTotal: number
  skipped: number
  applied: boolean
}

export interface BankNarrationMemoryRow {
  keyword: string
  ledgerId: number
  ledgerName: string
  kind: 'payment' | 'receipt'
  hits: number
  lastSeen: string
}

export interface BankMatchSuggestion {
  statementRow: BankUnmatchedRow
  kind: 'tolerance' | 'many_to_one'
  lines: { lineId: number; voucherId: number; date: string; number: string; amount: number }[]
}

export interface BankImportResult {
  statementRows: number
  matched: number
  alreadyReconciled: number
  unmatched: BankUnmatchedRow[]
  matches: { date: string; description: string; amount: number; kind: 'deposit' | 'withdrawal'; lineId: number }[]
  autoCreated: { date: string; description: string; amount: number; kind: 'deposit' | 'withdrawal'; voucherId: number; ruleId: number }[]
  /** Which profile read the file (#131), and how many lines it could not read. */
  profileId: string
  profileName: string
  skipped: number
}

export interface BrsItem {
  lineId: number
  voucherId: number
  date: string
  voucherType: string
  number: string
  particulars: string
  instrumentNo: string | null
  amount: number
}

export interface BrsReport {
  ledgerId: number
  ledgerName: string
  asOn: string
  bookBalance: number
  uncredited: BrsItem[]
  uncreditedTotal: number
  unpresented: BrsItem[]
  unpresentedTotal: number
  bankBalance: number
}

/** Mirrors src/main/services/payroll.ts's PayHead / EmployeeHeadRow / PtSummaryRow shapes (kept
 *  local — that file is main-process only). */
export interface PayHead {
  id: number
  name: string
  kind: 'earning' | 'deduction'
  calc: 'flat' | 'percent_of_basic'
  /** Paise for 'flat'; percent × 100 (4000 = 40%) for 'percent_of_basic'. */
  value: number
  active: boolean
}

export interface EmployeeHeadRow {
  payHeadId: number
  name: string
  kind: 'earning' | 'deduction'
  calc: 'flat' | 'percent_of_basic'
  value: number
  overrideValue: number | null
}

export interface PtSummaryRow {
  state: string
  employees: number
  gross: number
  pt: number
}

/** Mirrors src/main/services/tds.ts's TdsSuggestion shape (kept local — that file is main-process only). */
export interface TdsSuggestion {
  sectionId: number
  code: string
  rate: number
  tdsPaise: number
  payableLedgerId: number
  panAvailable: boolean
  thresholdCrossed: boolean
}

/** Mirrors src/main/services/tds.ts's TdsSummaryRow shape (kept local — that file is main-process only). */
export interface TdsSummaryRow {
  sectionCode: string
  quarter: string
  deductees: number
  base: number
  tds: number
}

/** Mirrors src/main/services/costCentres.ts's CcReportRow shape (kept local — that file is main-process only). */
export interface CcReportRow {
  costCentreId: number
  name: string
  income: number
  expense: number
  net: number
}

/** Mirrors src/main/services/costCentres.ts's CcStatementRow shape (kept local — that file is main-process only). */
export interface CcStatementRow {
  date: string
  voucherId: number
  number: string
  ledgerName: string
  drCr: 'dr' | 'cr'
  amount: number
}

/** Mirrors src/main/services/importers.ts's ImportKind/ImportPreview/ImportResult shapes (kept
 *  local — that file is main-process only). */
export type ImportKind = 'ledgers' | 'items' | 'openings'

export interface ImportPreview {
  rows: Record<string, unknown>[]
  total: number
  willCreate: number
  /** Rows that exist AND differ. */
  willUpdate: number
  /** Rows that exist and are identical — the ones a re-import would leave alone. */
  unchanged: number
  errors: { line: number; message: string }[]
}

export interface ImportResult {
  created: number
  updated: number
  errors: { line: number; message: string }[]
}

/** Invoke a main-process channel; throws the error message on failure. */
/** Mirrors src/main/services/reportHtml.ts's ReportColumnSpec/ReportRowSpec shapes (kept local —
 *  that file is main-process only). Shared by every screen's PDF/CSV export buttons. */
export interface ReportColumn {
  label: string
  align: 'l' | 'r' | 'c'
  width?: number
}
export interface ReportRow {
  cells: string[]
  bold?: boolean
  indent?: number
  rule?: boolean
}
export interface ReportPdfInput {
  title: string
  periodLabel: string
  columns: ReportColumn[]
  rows: ReportRow[]
  footNote?: string
  filename: string
  /** Landscape orientation for wide reports (lane Q #95); defaults to portrait. */
  landscape?: boolean
}

/** Mirrors src/main/services/tallyImport.ts's ImportSummary shape (kept local — main-process only). */
export interface TallyImportSummary {
  groups: number
  ledgers: number
  units: number
  items: number
  vouchers: number
  skipped: number
  /** Already in these books from an earlier import of the same entries (roadmap O #297). */
  duplicates: number
  warnings: string[]
  /** The user pressed Cancel; nothing was written. */
  cancelled?: boolean
}

/** What an import would do to THESE books, without doing it (roadmap O #296). */
export interface TallyImportDiff {
  masters: { label: string; create: number; exists: number }[]
  vouchers: { create: number; duplicate: number; blocked: number }
  samples: { kind: string; label: string }[]
  warnings: string[]
}

export interface ImportProgress {
  done: number
  total: number
  phase: 'masters' | 'vouchers'
}

/** Mirrors src/main/services/attachments.ts's Attachment (main-process only). */
export interface Attachment {
  id: number
  voucherId: number
  fileName: string
  storedName: string
  byteSize: number
  sha256: string
  note: string | null
  addedAt: string
  addedBy: string | null
  /** The file is no longer in the company folder. Shown rather than hidden — the app losing
   *  evidence has to be visible. */
  missing: boolean
}

/** Mirrors src/main/services/approvals.ts's PendingVoucher (main-process only). */
export interface PendingVoucher {
  voucherId: number
  date: string
  number: string
  voucherType: string
  partyName: string | null
  amount: number
  narration: string | null
  enteredBy: string | null
  enteredAt: string
  state: 'pending' | 'approved' | 'rejected'
  decidedBy: string | null
  decidedAt: string | null
  note: string | null
}

/** Mirrors src/main/services/bankChanges.ts's BankChangeRequest (main-process only). */
export interface BankChangeRequest {
  id: number
  ledgerId: number
  ledgerName: string
  oldAccount: string | null
  oldIfsc: string | null
  oldHolder: string | null
  newAccount: string | null
  newIfsc: string | null
  newHolder: string | null
  state: 'pending' | 'approved' | 'rejected'
  requestedBy: string | null
  requestedAt: string
  decidedBy: string | null
  decidedAt: string | null
  decisionNote: string | null
}

export interface AuditorStatus {
  active: boolean
  expiresAt: string | null
  timeLeft: string | null
  grantedBy: string | null
}

/** Mirrors src/main/services/inventoryTransfer.ts + inventoryLandedCost.ts (main-process only). */
export interface GodownAvailabilityRow {
  stockItemId: number
  name: string
  unitSymbol: string
  decimals: number
  availableQtyMilli: number
  ratePaise: number
}

export interface TransferInput {
  date: string
  fromGodownId: number
  toGodownId: number
  items: TransferItem[]
  narration?: string | null
}

export interface TransferResult {
  voucherId: number
  number: string
  totalValue: number
  lineCount: number
}

export interface TransferListRow {
  voucherId: number
  date: string
  number: string
  narration: string | null
  fromGodown: string
  toGodown: string
  items: number
  totalValue: number
}

export interface LandedCostInputRow {
  ledgerId: number
  label: string
  amount: number
  basis: LandedCostBasis
}

export interface LandedCostView {
  voucherId: number
  date: string
  number: string
  partyName: string | null
  costs: (LandedCostInputRow & { id: number; ledgerName: string })[]
  candidates: { ledgerId: number; ledgerName: string; amount: number; allocated: number }[]
  lines: {
    inventoryLineId: number
    stockItemId: number
    name: string
    unitSymbol: string
    decimals: number
    qtyMilli: number
    amount: number
    ratePaise: number
    extra: number
    effectiveAmount: number
    effectiveRatePaise: number
  }[]
  total: number
  unallocated: number
}

export interface CostedPurchaseRow {
  voucherId: number
  date: string
  number: string
  partyName: string | null
  goodsValue: number
  landed: number
  items: number
}

/** Mirrors src/main/services/stockAnalysis.ts's row shapes (kept local — main-process only). */
export interface GodownStockRow {
  godownId: number | null
  godownName: string
  stockItemId: number
  name: string
  unitSymbol: string
  decimals: number
  closingQtyMilli: number
  closingValue: number
}

export interface BatchStockRow {
  batchId: number
  batchName: string
  stockItemId: number
  itemName: string
  unitSymbol: string
  decimals: number
  mfgDate: string | null
  expiryDate: string | null
  closingQtyMilli: number
}

export interface ExpiryAgeingRow extends BatchStockRow {
  bucket: 'none' | 'expired' | 'within30' | 'within90' | 'later'
}

/** Mirrors priceLevels.PriceRateRow (main-process only). */
export interface PriceRateRow extends PriceListRate {
  itemName: string
  unitSymbol: string
}

/** Mirrors vouchers.PdcRow (main-process only). */
export interface PdcRow {
  id: number
  date: string
  number: string
  voucherTypeName: string
  partyName: string | null
  instrumentNo: string | null
  instrumentDate: string | null
  amount: number
}

async function call<T>(channel: string, payload?: unknown): Promise<T> {
  const result = await window.total.invoke(channel, payload)
  if (!result.ok) throw new Error(result.error ?? 'Unknown error')
  return result.data as T
}

export const api = {
  company: {
    list: () => call<Registry>('company:list'),
    create: (input: CompanyCreateInput) => call<{ slug: string }>('company:create', input),
    createDemo: () => call<{ slug: string }>('company:createDemo'),
    remove: (slug: string, confirmName: string, pin?: string) =>
      call<null>('company:delete', { slug, confirmName, pin }),
    open: (slug: string) =>
      call<{ slug: string; info: CompanyInfo; integrity: IntegrityResult; locked: boolean }>('company:open', { slug }),
    close: () => call<null>('company:close'),
    current: () => call<{ slug: string; info: CompanyInfo; locked: boolean } | null>('company:current'),
    updateInfo: (input: CompanyCreateInput) => call<CompanyInfo>('company:updateInfo', input),
    backup: () => call<{ path: string }>('company:backup'),
    revealExports: () => call<null>('company:revealExports'),
    lockGet: () => call<{ date: string | null }>('company:lock:get'),
    lockSet: (date: string | null) => call<{ date: string | null }>('company:lock:set', { date })
  },
  backups: {
    list: () => call<BackupInfo[]>('backup:list'),
    run: () => call<{ path: string }>('backup:run'),
    /** Opens the backup and foots its books — the only claim worth making about a backup. */
    verify: (file: string) => call<BackupVerification>('backup:verify', { file }),
    keepGet: () => call<{ keep: number }>('config:backupKeep:get'),
    keepSet: (keep: number) => call<{ keep: number }>('config:backupKeep:set', { keep }),
    restore: (file: string) =>
      call<{ info: CompanyInfo; integrity: IntegrityResult; locked: boolean }>('backup:restore', { file }),
    exportEncrypted: (passphrase: string) => call<{ path: string }>('backup:exportEncrypted', { passphrase }),
    importEncrypted: (passphrase: string) =>
      call<{ slug: string; name: string } | null>('backup:importEncrypted', { passphrase })
  },
  groups: {
    list: () => call<Group[]>('master:groups:list'),
    tree: () => call<GroupTreeNode[]>('master:groups:tree'),
    create: (data: GroupInput) => call<Group>('master:groups:create', data),
    update: (id: number, data: GroupInput) => call<Group>('master:groups:update', { id, data }),
    remove: (id: number) => call<null>('master:groups:delete', { id })
  },
  ledgers: {
    list: () => call<Ledger[]>('master:ledgers:list'),
    create: (data: LedgerInput) => call<Ledger>('master:ledgers:create', data),
    /** `bankChange` is non-null when the two-person rule parked the bank details instead of
     *  applying them (roadmap V #388) — the rest of the master saved either way. */
    update: (id: number, data: LedgerInput) =>
      call<Ledger & { bankChange: BankChangeRequest | null }>('master:ledgers:update', { id, data }),
    remove: (id: number) => call<null>('master:ledgers:delete', { id }),
    balances: (asOn: string) => call<LedgerBalanceRow[]>('master:ledgerBalances', { asOn })
  },
  voucherTypes: {
    list: () => call<VoucherType[]>('master:voucherTypes:list'),
    create: (data: VoucherTypeInput) => call<VoucherType>('master:voucherTypes:create', data),
    update: (id: number, data: VoucherTypeInput) => call<VoucherType>('master:voucherTypes:update', { id, data })
  },
  units: {
    list: () => call<Unit[]>('master:units:list'),
    create: (data: UnitInput) => call<Unit>('master:units:create', data)
  },
  stockGroups: {
    list: () => call<StockGroup[]>('master:stockGroups:list'),
    create: (data: StockGroupInput) => call<StockGroup>('master:stockGroups:create', data)
  },
  stockItems: {
    list: () => call<StockItem[]>('master:stockItems:list'),
    create: (data: StockItemInput) => call<StockItem>('master:stockItems:create', data),
    update: (id: number, data: StockItemInput) => call<StockItem>('master:stockItems:update', { id, data }),
    remove: (id: number) => call<null>('master:stockItems:delete', { id })
  },
  godowns: {
    list: () => call<Godown[]>('master:godowns:list'),
    create: (data: GodownInput) => call<Godown>('master:godowns:create', data),
    update: (id: number, data: GodownInput) => call<Godown>('master:godowns:update', { id, data }),
    remove: (id: number) => call<null>('master:godowns:delete', { id })
  },
  batches: {
    list: (stockItemId?: number) => call<Batch[]>('master:batches:list', { stockItemId }),
    create: (data: BatchInput) => call<Batch>('master:batches:create', data)
  },
  stock: {
    summary: (asOn: string, godownId?: number) => call<StockSummaryRow[]>('stock:summary', { asOn, godownId }),
    byGodown: (asOn: string) => call<GodownStockRow[]>('stock:byGodown', { asOn }),
    batches: (asOn: string, stockItemId?: number) => call<BatchStockRow[]>('stock:batches', { asOn, stockItemId }),
    expiry: (asOn: string) => call<ExpiryAgeingRow[]>('stock:expiry', { asOn }),
    negative: (asOn: string) => call<NegativeStockWarning[]>('stock:negative', { asOn }),
    /** What is about to become worthless, and what it is worth. */
    nearExpiry: (asOn: string) => call<NearExpiryReport>('stock:nearExpiry', { asOn }),
    /** The rate and HSN an item actually charges, and which parts came from its group. */
    effectiveTax: (stockItemId: number) => call<EffectiveItemTax>('stock:effectiveTax', { stockItemId }),
    /** Code, then barcode, then exact name — how a person at a counter finds a thing. */
    find: (query: string) => call<StockItem | null>('stock:find', { query }),
    /** What one godown holds — the menu a transfer picks from. */
    godownStock: (asOn: string, godownId: number) =>
      call<GodownAvailabilityRow[]>('stock:godownStock', { asOn, godownId }),
    /** Dry run, so the form can refuse a move before the user presses save. */
    previewTransfer: (input: TransferInput) => call<TransferPlan>('stock:previewTransfer', input),
    saveTransfer: (input: TransferInput) => call<TransferResult>('stock:saveTransfer', input),
    transfers: (from: string, to: string) => call<TransferListRow[]>('stock:transfers', { from, to }),
    /** Purchases carrying stock, so a landed cost has something to be spread over. */
    costablePurchases: (from: string, to: string) =>
      call<CostedPurchaseRow[]>('stock:costablePurchases', { from, to }),
    landedCosts: (voucherId: number) => call<LandedCostView>('stock:landedCosts', { voucherId }),
    saveLandedCosts: (voucherId: number, costs: LandedCostInputRow[]) =>
      call<LandedCostView>('stock:saveLandedCosts', { voucherId, costs }),
    /** What to reorder, grouped into one message per supplier. */
    reorderAlerts: (asOn: string) => call<ReorderAlerts>('stock:reorderAlerts', { asOn })
  },
  priceLevels: {
    list: () => call<PriceLevel[]>('master:priceLevels:list'),
    create: (data: PriceLevelInput) => call<PriceLevel>('master:priceLevels:create', data),
    update: (id: number, data: PriceLevelInput) => call<PriceLevel>('master:priceLevels:update', { id, data }),
    remove: (id: number) => call<null>('master:priceLevels:delete', { id }),
    rates: (priceLevelId: number) => call<PriceRateRow[]>('priceLevels:rates', { priceLevelId }),
    saveRate: (data: PriceRateInput) => call<PriceListRate>('priceLevels:saveRate', data),
    deleteRate: (id: number) => call<null>('priceLevels:deleteRate', { id }),
    /** Rate in force for (level, item) on `date`, or null when no row applies. */
    rateFor: (priceLevelId: number, stockItemId: number, date: string) =>
      call<number | null>('priceLevels:rateFor', { priceLevelId, stockItemId, date })
  },
  pdc: {
    list: () => call<PdcRow[]>('pdc:list'),
    /** Flip one post-dated voucher into the books now (early clearance). */
    mature: (id: number) => call<null>('pdc:mature', { id })
  },
  vouchers: {
    list: (from: string, to: string, voucherTypeId?: number) =>
      call<VoucherListRow[]>('voucher:list', { from, to, voucherTypeId }),
    get: (id: number) => call<Voucher | null>('voucher:get', { id }),
    save: (data: VoucherInputParsed, id?: number) =>
      call<Voucher & { duplicateNumber?: boolean; warnings?: SaveVoucherWarnings }>('voucher:save', { data, id }),
    remove: (id: number) => call<null>('voucher:delete', { id }),
    nextNumber: (voucherTypeId: number, date: string, excludeId?: number) =>
      call<{ number: string }>('voucher:nextNumber', { voucherTypeId, date, excludeId }),
    numberExists: (voucherTypeId: number, number: string, excludeId?: number) =>
      call<boolean>('voucher:numberExists', { voucherTypeId, number, excludeId }),
    duplicates: (data: VoucherInputParsed, excludeId?: number) =>
      call<{ voucherId: number; number: string; date: string }[]>('voucher:duplicates', { data, excludeId }),
    /** The voucher's own shape as a starting point for a new one — party, ledgers, amounts and
     *  narration, but never its date. */
    draftFrom: (voucherId: number) => call<VoucherDraft | null>('voucher:draftFrom', { voucherId }),
    latestOfType: (voucherTypeId: number) =>
      call<{ voucherId: number | null }>('voucher:latestOfType', { voucherTypeId }),
    count: () => call<number>('voucher:count'),
    /** The bin's auto-purge policy, and what the next purge would take. */
    purgePolicy: () =>
      call<{ days: number; count: number; oldestDate: string | null }>('config:binPurge:get'),
    setPurgeDays: (days: number) => call<{ days: number }>('config:binPurge:set', { days }),
    bin: () => call<BinRow[]>('voucher:bin'),
    restore: (id: number) => call<null>('voucher:restore', { id }),
    purge: (id: number) => call<null>('voucher:purge', { id })
  },
  reports: {
    dayBook: (from: string, to: string, includeOutOfBooks?: boolean, page?: { limit: number; offset: number }) =>
      call<{ rows: DayBookRow[]; total: number }>('report:dayBook', {
        from,
        to,
        includeOutOfBooks,
        ...page
      }),
    ledger: (ledgerId: number, from: string, to: string, groupBy?: Period, page?: { limit: number; offset?: number }) =>
      call<LedgerStatement>('report:ledger', { ledgerId, from, to, groupBy, ...page }),
    purchaseSuggestions: (asOn: string) =>
      call<PurchaseSuggestionRow[]>('report:purchaseSuggestions', { asOn }),
    dayBookByType: (from: string, to: string, includeOutOfBooks = false) =>
      call<DayBookTypeRow[]>('report:dayBookByType', { from, to, includeOutOfBooks }),
    trialBalance: (asOn: string, includeZeroBalances = false) =>
      call<TrialBalance>('report:trialBalance', { asOn, includeZeroBalances }),
    profitLoss: (from: string, to: string, comparePrior?: boolean) =>
      call<ProfitAndLoss>('report:profitLoss', { from, to, comparePrior }),
    balanceSheet: (asOn: string, comparePrior?: boolean) =>
      call<BalanceSheet>('report:balanceSheet', { asOn, comparePrior }),
    stockSummary: (asOn: string) => call<StockSummaryRow[]>('report:stockSummary', { asOn }),
    dashboard: (today: string, fyFrom: string) => call<DashboardData>('report:dashboard', { today, fyFrom }),
    cashFlow: (from: string, to: string) => call<CashFlowStatement>('report:cashFlow', { from, to }),
    stockAgeing: (asOn: string) => call<StockAgeingRow[]>('report:stockAgeing', { asOn }),
    itemProfitability: (from: string, to: string) => call<ItemProfitRow[]>('report:itemProfitability', { from, to }),
    exceptions: (from: string, to: string) => call<ExceptionsReport>('report:exceptions', { from, to })
  },
  consolidated: {
    run: (slugs: string[], kind: 'tb' | 'pnl', from: string, to: string) =>
      call<ConsolidatedResult>('consol:run', { slugs, kind, from, to })
  },
  gst: {
    gstr1: (from: string, to: string, period: string) => call<Gstr1Result>('gst:gstr1', { from, to, period }),
    gstr3b: (from: string, to: string, period: string) => call<Gstr3bResult>('gst:gstr3b', { from, to, period }),
    exportGstr1: (from: string, to: string, period: string) =>
      call<{ jsonPath: string; csvPath: string }>('gst:exportGstr1', { from, to, period }),
    exportGstr3b: (from: string, to: string, period: string) =>
      call<{ jsonPath: string }>('gst:exportGstr3b', { from, to, period }),
    recon2b: (jsonText: string, from: string, to: string) =>
      call<{ result: Recon2bResult; errors: string[]; period: string | null }>('gst:recon2b', { jsonText, from, to }),
    recon2bPickFile: () => call<{ jsonText: string; fileName: string } | null>('gst:recon2bPickFile'),
    validate: (from: string, to: string) =>
      call<{
        issues: GstIssue[]
        roundOff: { voucherId: number; number: string; roundOff: number; lines: string[] }[]
      }>('gst:validate', { from, to }),
    get3bManual: (period: string) => call<Gst3bManualInput>('gst:3bManualGet', { period }),
    set3bManual: (period: string, data: Gst3bManualInput) =>
      call<Gst3bManualInput>('gst:3bManualSet', { period, data })
  },
  analysis: {
    register: (kind: 'sales' | 'purchase', from: string, to: string, groupBy?: Period) =>
      call<RegisterPeriodRow[]>('analysis:register', { kind, from, to, groupBy }),
    outstandings: (side: 'receivable' | 'payable', asOn: string, includeBills = true) =>
      call<OutstandingParty[]>('analysis:outstandings', { side, asOn, includeBills }),
    /** The call log: what was said, and what was promised. */
    notes: (ledgerId: number) => call<PartyNote[]>('party:notes', { ledgerId }),
    addNote: (input: {
      ledgerId: number
      note: string
      promisedDate?: string | null
      promisedAmount?: number | null
    }) => call<PartyNote>('party:addNote', input),
    closeNote: (id: number) => call<PartyNote>('party:closeNote', { id }),
    /** Open promises, most overdue first — the follow-up list. */
    promises: () => call<PromiseRow[]>('party:promises'),
    khata: (side: 'receivable' | 'payable', asOn: string) =>
      call<KhataParty[]>('analysis:khata', { side, asOn }),
    partyShares: (kind: 'sales' | 'purchase', from: string, to: string) =>
      call<{ rows: PartyShareRow[]; total: number; concentration: Concentration }>('analysis:partyShares', {
        kind,
        from,
        to
      })
  },
  /**
   * The collections desk: interest, scoring, allocation help, ageing by owner, provisioning,
   * advances, the payment run, bulk reminders and the statement of account.
   */
  receivables: {
    interest: (side: 'receivable' | 'payable', asOn: string) =>
      call<PartyInterest[]>('recv:interest', { side, asOn }),
    creditScores: (asOn: string) => call<PartyCreditScore[]>('recv:creditScores', { asOn }),
    allocationSuggestions: (ledgerId: number, amount: number, asOn: string, side: 'receivable' | 'payable' = 'receivable') =>
      call<AllocationSuggestion[]>('recv:allocationSuggestions', { ledgerId, amount, asOn, side }),
    ageingBy: (
      side: 'receivable' | 'payable',
      asOn: string,
      dimension: 'salesperson' | 'territory' | 'party',
      bandCuts?: number[]
    ) => call<AgeingByResult>('recv:ageingBy', { side, asOn, dimension, bandCuts }),
    provision: (asOn: string) => call<ProvisionResponse>('recv:provision', { asOn }),
    advances: (side: 'receivable' | 'payable', asOn: string) => call<AdvanceRow[]>('recv:advances', { side, asOn }),
    paymentSchedule: (from: string, to: string, side: 'payable' | 'receivable' = 'payable') =>
      call<PaymentSchedule>('recv:paymentSchedule', { from, to, side }),
    reminders: (side: 'receivable' | 'payable', asOn: string, opts: { minOverdueDays?: number; includeInterest?: boolean } = {}) =>
      call<BulkReminderRow[]>('recv:reminders', { side, asOn, ...opts }),
    statement: (ledgerId: number, from: string, to: string) =>
      call<PartyStatement>('recv:statement', { ledgerId, from, to }),
    statementPdf: (ledgerId: number, from: string, to: string, side: 'receivable' | 'payable' = 'receivable') =>
      call<{ path: string; name: string }>('recv:statementPdf', { ledgerId, from, to, side }),
    /** Where a party stands against their limit, including the voucher currently on screen. */
    creditCheck: (ledgerId: number, addPaise = 0) => call<CreditStatus | null>('recv:creditCheck', { ledgerId, addPaise }),
    /** Section 43B(h): what is at risk of disallowance for paying a small supplier late. */
    msme: (asOn: string) => call<MsmeReport>('recv:msme', { asOn }),
    policy: () => call<CollectionsPolicy>('recv:policy'),
    setPolicy: (input: CollectionsPolicy) => call<CollectionsPolicy>('recv:setPolicy', input)
  },
  /** The fixed asset register, and the two depreciation schedules the law asks for. */
  assets: {
    blocks: () => call<AssetBlock[]>('assets:blocks'),
    saveBlock: (data: { name: string; itRate: number }, id?: number) => call<AssetBlock>('assets:saveBlock', { data, id }),
    list: (includeDisposed = false) => call<FixedAsset[]>('assets:list', { includeDisposed }),
    save: (
      data: {
        name: string
        code?: string | null
        blockId?: number | null
        ledgerId?: number | null
        purchaseDate: string
        putToUseDate?: string | null
        cost: number
        residualValue?: number
        usefulLifeMonths: number
        method?: DepreciationMethod
        location?: string | null
        notes?: string | null
      },
      id?: number
    ) => call<FixedAsset>('assets:save', { data, id }),
    remove: (id: number) => call<null>('assets:delete', { id }),
    schedule: (fyStartYear: number) =>
      call<{ schedule: DepreciationSchedule; draft: DepreciationDraft | null }>('assets:schedule', { fyStartYear }),
    postDepreciation: (fyStartYear: number, voucherId: number | null) =>
      call<{ runId: number }>('assets:postDepreciation', { fyStartYear, voucherId }),
    disposalDraft: (assetId: number, on: string, proceeds: number) =>
      call<DisposalDraft>('assets:disposalDraft', { assetId, on, proceeds }),
    dispose: (assetId: number, on: string, proceeds: number, voucherId?: number) =>
      call<FixedAsset>('assets:dispose', { assetId, on, proceeds, voucherId })
  },
  /** Disclosure: related parties, the audit trail about itself, the LUT, the IRP window. */
  disclosure: {
    relatedParties: (from: string, to: string) => call<RelatedPartyReport>('disclosure:relatedParties', { from, to }),
    auditStatement: (from: string, to: string) => call<AuditTrailStatement>('disclosure:auditStatement', { from, to }),
    luts: () => call<Lut[]>('disclosure:luts'),
    lutStatus: () => call<LutStatus>('disclosure:lutStatus'),
    saveLut: (input: Lut) => call<Lut[]>('disclosure:saveLut', input),
    deleteLut: (fyStartYear: number) => call<Lut[]>('disclosure:deleteLut', { fyStartYear }),
    eInvoiceWindow: (from: string, to: string) =>
      call<EInvoiceWindowReport>('disclosure:eInvoiceWindow', { from, to })
  },
  bills: {
    open: (partyLedgerId: number, asOn: string) => call<OutstandingBill[]>('bills:open', { partyLedgerId, asOn })
  },
  tds: {
    sections: () => call<TdsSection[]>('tds:sections'),
    sectionSave: (data: TdsSectionInput) => call<TdsSection>('tds:sectionSave', data),
    suggest: (partyLedgerId: number, base: number, date: string) =>
      call<TdsSuggestion | null>('tds:suggest', { partyLedgerId, base, date }),
    summary: (fyStartYear: number) => call<TdsSummaryRow[]>('tds:summary', { fyStartYear }),
    export26q: (fyStartYear: number, quarter: number) => call<{ path: string }>('tds:export26q', { fyStartYear, quarter })
  },
  cc: {
    list: () => call<CostCentre[]>('cc:list'),
    save: (data: CostCentreInput, id?: number) => call<CostCentre>('cc:save', { id, data }),
    remove: (id: number) => call<null>('cc:delete', { id }),
    report: (from: string, to: string) => call<CcReportRow[]>('cc:report', { from, to }),
    statement: (ccId: number, from: string, to: string) => call<CcStatementRow[]>('cc:statement', { ccId, from, to })
  },
  budget: {
    list: () => call<Budget[]>('budget:list'),
    save: (data: BudgetInput, id?: number) => call<Budget>('budget:save', { id, data }),
    remove: (id: number) => call<null>('budget:delete', { id }),
    variance: (budgetId: number, upToMonth: string) => call<BudgetVarianceRow[]>('budget:variance', { budgetId, upToMonth })
  },
  recurring: {
    list: () => call<RecurringTemplate[]>('recurring:list'),
    save: (data: RecurringInput, id?: number) => call<RecurringTemplate>('recurring:save', { id, data }),
    remove: (id: number) => call<null>('recurring:delete', { id }),
    due: (today: string) => call<RecurringTemplate[]>('recurring:due', { today }),
    post: (id: number, date: string) => call<Voucher>('recurring:post', { id, date }),
    skip: (id: number) => call<RecurringTemplate>('recurring:skip', { id })
  },
  bank: {
    ledgers: () => call<{ id: number; name: string }[]>('bank:ledgers'),
    reconciliationStatus: (asOn: string) =>
      call<ReconciliationStatus[]>('bank:reconciliationStatus', { asOn }),
    recon: (ledgerId: number, from: string, to: string) => call<BankRecon>('bank:recon', { ledgerId, from, to }),
    setBankDate: (lineId: number, bankDate: string | null) => call<null>('bank:setBankDate', { lineId, bankDate }),
    importCsv: (
      ledgerId: number,
      opts?: { csvText?: string; dryRun?: boolean; profileId?: string | null; adHoc?: BankAdHocProfile | null }
    ) => call<(BankImportResult & { csvText: string }) | null>('bank:importCsv', { ledgerId, ...opts }),
    /** Which profile fits a statement, and what it would read — before anything is imported. */
    inspectStatement: (opts: { csvText?: string; profileId?: string | null; adHoc?: BankAdHocProfile | null } = {}) =>
      call<BankStatementInspection | null>('bank:inspectStatement', opts),
    suggest: (ledgerId: number, csvText: string, profile: { profileId?: string | null; adHoc?: BankAdHocProfile | null } = {}) =>
      call<BankSuggestionRow[]>('banking:suggest', { ledgerId, csvText, ...profile }),
    /** Remember that this narration meant this ledger (#133). */
    learn: (description: string, ledgerId: number, kind: 'payment' | 'receipt') =>
      call<{ keywords: string[] }>('banking:learn', { description, ledgerId, kind }),
    memory: () => call<BankNarrationMemoryRow[]>('banking:memory'),
    forget: (keyword: string, ledgerId: number, kind: 'payment' | 'receipt') =>
      call<null>('banking:forget', { keyword, ledgerId, kind }),
    /** Accept every suggestion at or above `minConfidence`. `apply: false` is the preview (#134). */
    bulkAccept: (
      ledgerId: number,
      csvText: string,
      minConfidence: number,
      opts: { apply?: boolean; profileId?: string | null; adHoc?: BankAdHocProfile | null } = {}
    ) => call<BankBulkAcceptResult>('banking:bulkAccept', { ledgerId, csvText, minConfidence, ...opts }),
    matchSuggestions: (ledgerId: number, csvText: string, tolerancePaise?: number) =>
      call<BankMatchSuggestion[]>('banking:matchSuggestions', { ledgerId, csvText, tolerancePaise }),
    brs: (ledgerId: number, asOn: string) => call<BrsReport>('banking:brs', { ledgerId, asOn }),
    brsPdf: (ledgerId: number, asOn: string) => call<{ path: string }>('banking:brsPdf', { ledgerId, asOn })
  },
  bankProfiles: {
    list: () => call<BankImportProfile[]>('bankprofile:list'),
    save: (data: BankProfileInput, id?: number) => call<BankImportProfile>('bankprofile:save', { id, data }),
    remove: (id: number) => call<null>('bankprofile:delete', { id })
  },
  bankRules: {
    list: () => call<BankRuleRecord[]>('bankrule:list'),
    save: (data: BankRuleInput, id?: number) => call<BankRuleRecord>('bankrule:save', { id, data }),
    remove: (id: number) => call<null>('bankrule:delete', { id }),
    hit: (id: number) => call<null>('bankrule:hit', { id })
  },
  edoc: {
    list: (from: string, to: string) => call<EdocListRow[]>('edoc:list', { from, to }),
    exportEInvoice: (from: string, to: string, period: string) =>
      call<{ path: string; count: number }>('edoc:exportEInvoice', { from, to, period }),
    exportEwb: (from: string, to: string, period: string, opts?: { voucherIds?: number[]; includeBelowThreshold?: boolean }) =>
      call<{ path: string; dir: string; count: number; skipped: { number: string; reason: string }[] }>(
        'edoc:exportEwb',
        { from, to, period, ...opts }
      ),
    ewbJson: (voucherId: number) => call<{ path: string }>('edoc:ewbJson', { voucherId }),
    /** The exact JSON an export would write, without writing it. */
    previewJson: (
      kind: 'einvoice' | 'ewb',
      from: string,
      to: string,
      opts?: { voucherId?: number; includeBelowThreshold?: boolean }
    ) => call<{ json: unknown; count: number; issues: string[] }>('edoc:previewJson', { kind, from, to, ...opts }),
    transportGet: (voucherId: number) => call<VoucherTransport | null>('edoc:transportGet', { voucherId }),
    transportSet: (voucherId: number, data: VoucherTransportInput) =>
      call<VoucherTransport>('edoc:transportSet', { voucherId, data })
  },
  invoice: {
    pdf: (voucherId: number) => call<{ path: string }>('invoice:pdf', { voucherId }),
    pdfBatch: (voucherIds: number[]) => call<{ dir: string; paths: string[] }>('invoice:pdfBatch', { voucherIds }),
    previewHtml: (voucherId?: number, config?: Partial<InvoiceConfig>) =>
      call<{ html: string }>('invoice:previewHtml', { voucherId, config })
  },
  cheque: {
    config: {
      get: (bankLedgerId: number) => call<ChequeConfig>('cheque:config:get', { bankLedgerId }),
      set: (bankLedgerId: number, config: ChequeConfig) => call<ChequeConfig>('cheque:config:set', { bankLedgerId, config })
    },
    pdf: (voucherId: number, bankLedgerId: number) => call<{ path: string }>('cheque:pdf', { voucherId, bankLedgerId }),
    testGrid: (bankLedgerId: number) => call<{ path: string }>('cheque:testGrid', { bankLedgerId }),
    advice: (voucherId: number) => call<{ path: string }>('cheque:advice', { voucherId })
  },
  config: {
    features: {
      get: () => call<CompanyFeatures>('config:features:get'),
      set: (data: CompanyFeatures) => call<CompanyFeatures>('config:features:set', data)
    },
    invoice: {
      get: () => call<InvoiceConfig>('config:invoice:get'),
      set: (data: InvoiceConfig) => call<InvoiceConfig>('config:invoice:set', data)
    }
  },
  currencies: {
    list: () => call<Currency[]>('currency:list'),
    create: (data: CurrencyInput) => call<Currency>('currency:create', data),
    remove: (id: number) => call<null>('currency:delete', { id })
  },
  bom: {
    get: (itemId: number) => call<BomLine[]>('bom:get', { itemId }),
    set: (data: BomInput) => call<BomLine[]>('bom:set', data),
    items: () => call<{ itemId: number; name: string; components: number }[]>('bom:items')
  },
  payroll: {
    employees: () => call<Employee[]>('payroll:employees:list'),
    /** What payroll cost, month by month, and how many people it covered. */
    trend: (months?: number) => call<PayrollTrendPoint[]>('payroll:trend', { months }),
    /** The month's bulk transfer file, and who could not be included. */
    transferFile: (runId: number) =>
      call<{
        path: string
        count: number
        totalPaise: number
        skipped: { employeeName: string; reason: string }[]
      }>('payroll:transferFile', { runId }),
    saveEmployee: (data: EmployeeInputPayload, id?: number) => call<Employee>('payroll:employees:save', { data, id }),
    removeEmployee: (id: number) => call<null>('payroll:employees:delete', { id }),
    preview: (month: string, days: { employeeId: number; payableDays: number }[]) =>
      call<Omit<PayrollLine, 'id'>[]>('payroll:preview', { month, days }),
    commit: (month: string, days: { employeeId: number; payableDays: number }[]) =>
      call<PayrollRun>('payroll:commit', { month, days }),
    runs: () => call<PayrollRun[]>('payroll:runs'),
    removeRun: (id: number) => call<null>('payroll:deleteRun', { id }),
    payslip: (runId: number, employeeId: number) => call<{ path: string }>('payroll:payslip', { runId, employeeId }),
    heads: {
      list: () => call<PayHead[]>('payroll:heads:list'),
      save: (data: PayHeadInput, id?: number) => call<PayHead>('payroll:heads:save', { data, id }),
      remove: (id: number) => call<null>('payroll:heads:delete', { id })
    },
    employeeHeads: {
      get: (employeeId: number) => call<EmployeeHeadRow[]>('payroll:employeeHeads:get', { employeeId }),
      set: (input: EmployeeHeadsSetInput) => call<EmployeeHeadRow[]>('payroll:employeeHeads:set', input)
    },
    ecr: (runId: number) => call<{ path: string }>('payroll:ecr', { runId }),
    esiCsv: (runId: number) => call<{ path: string }>('payroll:esi', { runId }),
    ptSummary: (runId: number) => call<PtSummaryRow[]>('payroll:ptSummary', { runId }),
    ptCsv: (runId: number) => call<{ path: string }>('payroll:ptCsv', { runId }),
    /** The month's register: every active employee, defaulting to a full month. */
    attendance: (month: string) => call<AttendanceRow[]>('payroll:attendance', { month }),
    saveAttendance: (input: {
      employeeId: number
      month: string
      presentDays: number
      paidLeaveDays: number
      lopDays: number
      note?: string | null
    }) => call<AttendanceRow>('payroll:saveAttendance', input),
    loans: (opts: { employeeId?: number; openOnly?: boolean } = {}) => call<LoanRow[]>('payroll:loans', opts),
    createLoan: (input: { employeeId: number; grantedOn: string; principal: number; instalment: number; note?: string | null }) =>
      call<LoanRow>('payroll:createLoan', input),
    closeLoan: (id: number) => call<LoanRow>('payroll:closeLoan', { id }),
    dueRecoveries: (month: string) => call<DueRecovery[]>('payroll:dueRecoveries', { month }),
    /** Pre-flight the ECR before EPFO rejects the whole file over one line. */
    ecrCheck: (runId: number) => call<EcrCheck>('payroll:ecrCheck', { runId }),
    settlement: (input: {
      employeeId: number
      lastDay: string
      leaveBalanceDays: number
      noticeShortfallDays?: number
      finalMonthDays?: number
      payBonus?: boolean
      bonusPercent?: number
      waiveGratuityMinimum?: boolean
    }) => call<Settlement>('payroll:settlement', input),
    /** The statutory rates in force for a month, and the history they came from. */
    rates: (month: string) => call<{ rates: StatutoryRates; history: StatutoryRates[] }>('payroll:rates', { month }),
    /** What each employee's TDS should be this month, and the year's tax it comes from. */
    tds: (month: string) => call<EmployeeTax[]>('payroll:tds', { month }),
    form16: (employeeId: number, fyStartYear: number) => call<Form16>('payroll:form16', { employeeId, fyStartYear }),
    form16Pdf: (employeeId: number, fyStartYear: number) =>
      call<{ path: string }>('payroll:form16Pdf', { employeeId, fyStartYear }),
    /** Every payslip for a run, written out, each with a way to send it. */
    payslips: (runId: number) => call<PayslipDelivery[]>('payroll:payslips', { runId })
  },
  yearEnd: {
    preview: (fyStartYear: number) =>
      call<{ rows: CloseLedgerRow[]; netProfit: number; alreadyClosed: boolean }>('yearend:preview', { fyStartYear }),
    close: (fyStartYear: number) =>
      call<{ voucherId: number; netProfit: number; lockedUpTo: string }>('yearend:close', { fyStartYear })
  },
  tally: {
    dryRun: (filePath?: string) =>
      call<{ filePath: string | null; summary: TallyImportSummary; diff: TallyImportDiff } | null>('tally:import', {
        filePath,
        dryRun: true
      }),
    apply: (filePath?: string) =>
      call<{ filePath: string | null; summary: TallyImportSummary } | null>('tally:import', { filePath, dryRun: false }),
    /** Ask the running import to stop. It rolls back — everything or nothing. */
    cancel: () => call<{ cancelling: boolean }>('tally:cancel'),
    /** The PDF a CA signs off (roadmap O #298). Every figure on it is read back out of the books
     *  in main, not taken from this screen. */
    migrationReport: (asOn?: string) => call<{ path: string; outOfBalance: number }>('tally:migrationReport', { asOn }),
    /** Progress from the running import. Returns its own unsubscriber. */
    onProgress: (listener: (progress: ImportProgress) => void): (() => void) =>
      window.total.on('import:progress', (payload) => listener(payload as ImportProgress))
  },

  /** The scan of the bill (roadmap V #387). */
  attachments: {
    list: (voucherId: number) => call<Attachment[]>('voucher:attachments:list', { id: voucherId }),
    /** No payload beyond the voucher opens the file picker; `null` back means they cancelled. */
    add: (voucherId: number, note?: string | null) =>
      call<Attachment | null>('voucher:attachments:add', { voucherId, note }),
    remove: (id: number) => call<{ removed: boolean }>('voucher:attachments:remove', { id }),
    open: (id: number) => call<{ opened: boolean }>('voucher:attachments:open', { id }),
    reveal: (id: number) => call<{ revealed: boolean }>('voucher:attachments:reveal', { id }),
    footprint: () => call<{ files: number; bytes: number }>('voucher:attachments:footprint')
  },

  /** Entries waiting for the owner (roadmap V #386). */
  approvals: {
    list: () =>
      call<{ threshold: number | null; pending: PendingVoucher[]; decided: PendingVoucher[] }>('approvals:list'),
    decide: (voucherId: number, approve: boolean, note?: string | null) =>
      call<PendingVoucher>('approvals:decide', { voucherId, approve, note }),
    thresholdGet: () => call<{ threshold: number | null }>('config:approvalThreshold:get'),
    /** null switches it off; 0 means everything waits. They are different answers. */
    thresholdSet: (threshold: number | null) =>
      call<{ threshold: number | null }>('config:approvalThreshold:set', { threshold })
  },

  /** Bank-detail changes waiting for a second person (roadmap V #388). */
  bankChanges: {
    list: () => call<{ pending: BankChangeRequest[]; decided: BankChangeRequest[] }>('bankChange:list'),
    decide: (id: number, approve: boolean, note?: string | null) =>
      call<BankChangeRequest>('bankChange:decide', { id, approve, note })
  },

  /** A read-only session that expires (roadmap V #391). */
  auditor: {
    status: () => call<AuditorStatus>('auditor:status'),
    begin: (hours: number) => call<AuditorStatus>('auditor:begin', { hours }),
    end: () => call<AuditorStatus>('auditor:end')
  },
  importer: {
    pickCsv: () => call<{ csvText: string; fileName: string } | null>('import:pickCsv'),
    preview: (kind: ImportKind, csvText: string) => call<ImportPreview>('import:preview', { kind, csvText }),
    apply: (kind: ImportKind, csvText: string) => call<ImportResult>('import:apply', { kind, csvText }),
    template: (kind: ImportKind) => call<{ path: string }>('import:template', { kind })
  },
  exporter: {
    caPack: (from: string, to: string) => call<{ path: string }>('export:caPack', { from, to }),
    tallyXml: (from: string, to: string) => call<{ path: string }>('export:tallyXml', { from, to })
  },
  exportReport: {
    pdf: (input: ReportPdfInput) => call<{ path: string }>('report:pdf', input),
    csv: (filename: string, csv: string) => call<{ path: string }>('export:csv', { filename, csv })
  },
  nic: {
    get: () => call<NicCredentials & { secretStorage: 'keychain' | 'session' }>('nic:get'),
    save: (creds: NicCredentials) => call<{ configured: boolean }>('nic:save', creds),
    status: () => call<{ configured: boolean; secretStorage: 'keychain' | 'session' }>('nic:status'),
    generateIrn: (voucherId: number) => call<{ irn: string; ackNo: string; ackDate: string }>('nic:generateIrn', { voucherId }),
    generateEwb: (voucherId: number) => call<{ ewbNo: string; validUpto: string }>('nic:generateEwb', { voucherId })
  },
  intel: {
    suggestLedgers: (kind: string, query: string) =>
      call<{ ledgerId: number; name: string; groupName: string; uses: number }[]>('intel:suggestLedgers', { kind, query }),
    anomaly: (ledgerId: number, amount: number) =>
      call<{ unusual: boolean; typicalAmount: number | null }>('intel:anomaly', { ledgerId, amount })
  },
  ai: {
    getConfig: () => call<AiConfigView>('ai:getConfig'),
    setConfig: (settings: AiSettings) => call<AiConfigView>('ai:setConfig', settings),
    testConnection: () =>
      call<{ ok: true; latencyMs: number; models: string[]; warnings: string[] }>('ai:testConnection'),
    chat: (input: { question: string; screen?: string; history?: { role: 'user' | 'assistant'; content: string }[] }) =>
      call<{ runId: string }>('ai:chat', input),
    cancel: (runId: string) => call<{ cancelled: boolean }>('ai:cancel', { runId })
  },
  annual: {
    /** GSTR-9 working papers: the year's books beside the year's returns. */
    gstr9: (fyStartYear: number) => call<Gstr9Working>('gst:gstr9', { fyStartYear })
  },
  composition: {
    cmp08: (from: string, to: string, category: CompositionCategory, extras: { interest?: number; lateFee?: number } = {}) =>
      call<Cmp08>('gst:cmp08', { from, to, category, ...extras }),
    gstr4: (fyStartYear: number, category: CompositionCategory) =>
      call<Gstr4>('gst:gstr4', { fyStartYear, category })
  },
  filings: {
    register: (fyStartYear: number) => call<FilingRow[]>('filings:register', { fyStartYear }),
    record: (input: {
      form: string
      period: string
      dueDate: string
      filedAt: string | null
      arn: string | null
      taxPaid: number
      notes: string | null
    }) => call<FilingRecord>('filings:record', input),
    liability: (form: string, period: string) =>
      call<FilingLiability>('filings:liability', { form, period })
  },
  mcp: {
    snippet: (client: 'claude-desktop' | 'claude-code' | 'codex', allowWrites: boolean) =>
      call<{ command: string; args: string[]; env: Record<string, string>; resolvedFrom: string; text: string }>(
        'mcp:snippet',
        { client, allowWrites }
      )
  },
  license: {
    get: () => call<LicenseState>('license:get'),
    apply: (token: string) => call<LicenseState>('license:apply', { token })
  },
  log: {
    renderer: (input: RendererLogInput) => call<null>('log:renderer', input),
    reveal: () => call<null>('log:reveal'),
    diagnostics: () =>
      call<{
        version: string
        platform: string
        electron: string
        companyOpen: boolean
        lines: string[]
      }>('log:diagnostics')
  },
  search: {
    global: (q: string) => call<SearchHit[]>('search:global', { q })
  },
  audit: {
    list: (query: AuditListInput) => call<{ rows: AuditRow[]; total: number }>('audit:list', query),
    retentionGet: () => call<{ keepDays: number | null }>('config:audit:get'),
    retentionSet: (keepDays: number | null) => call<{ keepDays: number | null }>('config:audit:set', { keepDays }),
    /** What changed on a day, for the owner who was not there. Defaults to yesterday. */
    digest: (date?: string) => call<DailyDigest>('audit:digest', { date })
  },
  auth: {
    users: () => call<LoginName[]>('auth:users'),
    login: (userId: number, pin: string) => call<SessionUser>('auth:login', { userId, pin }),
    logout: () => call<null>('auth:logout'),
    current: () => call<SessionUser | null>('auth:current')
  },
  users: {
    list: () => call<UserRow[]>('users:list'),
    save: (data: UserInput, id?: number) => call<UserRow & { locked: boolean }>('users:save', { data, id }),
    deactivate: (id: number) => call<null>('users:deactivate', { id })
  },
  agent: {
    exportMirror: (input?: AgentExportInput) => call<{ dir: string; files: string[] }>('agent:exportMirror', input ?? {}),
    getConfig: () => call<{ enabled: boolean }>('agent:getConfig'),
    setConfig: (enabled: boolean) => call<{ enabled: boolean }>('agent:setConfig', { enabled })
  },
  app: {
    info: () => call<{ version: string; platform: string }>('app:info'),
    openExternal: (url: string) => call<null>('app:openExternal', { url }),
    /** The getting-started checklist, derived from the books rather than ticked by hand. */
    checklist: () => call<ChecklistState>('app:checklist'),
    checklistDone: (step: 'backupVerified' | 'sawShortcuts') =>
      call<null>('app:checklistDone', { step }),
    checkUpdates: () =>
      call<{
        status: 'dev' | 'available' | 'up-to-date' | 'error'
        current: string
        latest?: string
        /** Release notes for the newer version, when the source supplied any. */
        notes?: string | null
      }>('app:checkUpdates'),
    notifyDeadlines: (items: { title: string; body: string }[]) =>
      call<null>('app:notifyDeadlines', { items })
  }
}
