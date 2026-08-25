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
  ItemProfitPeriod, RatioReport,
  StockSummaryRow, TrialBalance,
  VoucherListRow
} from '@shared/reports'
import type { ChangeReport } from '@shared/whatChanged'
import type { CashForecast } from '@shared/forecast'
import type { CashFlowStatement } from '@shared/reportMath'
import type { TransferItem, TransferPlan } from '@shared/stockTransfer'
import type { LandedCostBasis } from '@shared/landedCost'
import type { ReorderAlerts } from '@shared/reorder'
import type { Concentration } from '@shared/concentration'
import type { Recon26asResult, Statement26asRow } from '@shared/tds/form26as'
import type { VoucherDraft } from '../state/stores'
import type { Gstr1Result, Gstr3bResult } from '@shared/gst/returns'
import type { GstIssue } from '@shared/gst/validate'
import type { Recon2bResult } from '@shared/gst/recon2b'
import type { AmendmentChange, AmendmentTables } from '@shared/gst/amendments'
import type { RateChange } from '@shared/gst/rateHistory'
import type {
  DeemedSupplyRow, Itc04, Itc04Issue, Itc04Obligation, Itc04Period,
  JobWorkDisposition, JobWorkGoodsType
} from '@shared/gst/itc04'
import type {
  AgentExportInput,
  AuditListInput, BankRuleInput, BatchInput, BomInput, BudgetInput, ChequeConfig, CompanyCreateInput, CostCentreInput,
  CurrencyInput, EmployeeHeadsSetInput, EmployeeInputPayload, GodownInput, GroupInput, Gst3bManualInput, LedgerInput, NicCredentials,
  ItemRateInput,
  PayHeadInput, PriceLevelInput,
  PriceRateInput, RecurringInput,
  RendererLogInput, StockGroupInput, StockItemInput, TdsSectionInput, TdsCertificateInput, UnitInput, UserInput, VoucherTransportInput, VoucherTypeInput,
  VoucherInputParsed
} from '@shared/schemas'
import type { CompanyFeatures } from '@shared/features'
import type { CartTotals, DrawerReconciliation, PricingMode, Tender, TenderResult } from '@shared/counter'
import type { Scheme, SchemeApplication } from '@shared/scheme'
import type { LoanSchedule } from '@shared/loan'
import type { AmortisationRow } from '@shared/prepaid'
import type { DrawingPowerMargins, DrawingPowerResult } from '@shared/drawingPower'
import type { CommissionStatement } from '@shared/commission'
import type { EscpOptions } from '@shared/escp'
import type { SearchHit } from '@shared/search'
import type { InvoiceConfig } from '@shared/invoiceConfig'
import type { CloseLedgerRow } from '@shared/yearEnd'
import type { ConsolidatedResult } from '@shared/consolidate'
import type { Period } from '@shared/period'
import type {
  ScheduleFrequency, SchedulePeriodKind, ScheduleReport
} from '@shared/reportSchedule'
import type { AiConfigView, AiSettings } from '@shared/ai/config'
import type { LicenseState } from '@shared/license'
import type { Cmp08, CompositionCategory, Gstr4 } from '@shared/gst/composition'
import type { FilingLiability, FilingRecord, FilingRow } from '@shared/gst/filings'
import type { Gstr9Working } from '@shared/gst/gstr9'
import type { ChecklistState } from '@shared/onboarding'
import type { RecoveryGuidance } from '@shared/recovery'
import type { Capability } from '@shared/permissions'
import type { DailyDigest } from '@shared/digest'
import type { Registry } from '../types'

/** A saved report view, as the views service returns it. */
export interface ReportView {
  id: number
  screen: string
  name: string
  state: unknown
  createdAt: string
}

export type ScheduleFormatName = 'csv' | 'xls' | 'pdf'

export interface ReportScheduleInput {
  report: ScheduleReport
  periodKind: SchedulePeriodKind
  format: ScheduleFormatName
  frequency: ScheduleFrequency
  folder: string | null
  nextRun: string
  active: boolean
}

export interface ReportSchedule extends ReportScheduleInput {
  id: number
  label: string
  lastRun: string | null
  lastPath: string | null
  lastError: string | null
}

export interface ScheduleRunResult {
  id: number
  report: string
  period: { from: string; to: string }
  path: string | null
  error: string | null
}

/** One sheet of a spreadsheet export. Cells are RAW: money in integer paise, dates ISO. */
export interface XlsExportSheet {
  name: string
  columns: { label: string; kind: 'text' | 'money' | 'date' | 'number' }[]
  rows: { cells: (string | number | null)[]; bold?: boolean }[]
}

export type Role = 'owner' | 'accountant' | 'viewer'

export interface SessionUser {
  id: number
  name: string
  role: Role
  /** Areas cut out of this user's role (roadmap #266); the screens hide what they cannot use. */
  denied: Capability[]
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

/** One dated GST rate change recorded against a stock item (roadmap D-92). */
export interface ItemRateRow extends RateChange {
  id: number
  stockItemId: number
}

export interface ItemRateHistoryView {
  stockItemId: number
  rows: ItemRateRow[]
  /** The change in force on the day asked about, or null when the history does not answer. */
  inForce: RateChange | null
  latestSentence: string | null
  /** The item's own undated rate — what still answers when there are no rows at all. */
  itemRate: { gstRate: number | null; cessRate: number | null }
  warnings: string[]
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

// ---------- counter mode, the sales chain and borrowing (roadmap T and U) ----------
//
// Shapes the main process returns. Declared here, as everything else on this boundary is: the
// renderer cannot import from src/main, and duplicating a type is cheaper than a shared module
// that would drag the services' imports across the process line with it.

export interface CounterItem {
  stockItemId: number
  name: string
  code: string | null
  groupId: number | null
  unitSymbol: string | null
  ratePaise: number
  gstRate: number
  cessRate: number
  costPaise: number | null
  onHandMilli: number
  schemes: DiscountScheme[]
}

export interface DiscountScheme extends Scheme {
  name: string
}

export type SchemeInput = Omit<DiscountScheme, 'id' | 'active'> & { active?: boolean }

export interface CounterCartLineInput {
  stockItemId: number
  qtyMilli: number
  ratePaise?: number
  discountPaise?: number
  noScheme?: boolean
}

export interface PriceCartInput {
  lines: CounterCartLineInput[]
  date?: string
  partyLedgerId?: number | null
  pricingMode?: PricingMode
}

export interface CounterCart extends Omit<CartTotals, 'lines'> {
  lines: (CartTotals['lines'][number] & { onHandMilli: number; scheme: SchemeApplication | null })[]
  supply: 'intra' | 'inter'
  pricingMode: PricingMode
  shortLines: { stockItemId: number; name: string; onHandMilli: number; qtyMilli: number }[]
}

export interface CounterSaleInput extends PriceCartInput {
  tenders: Tender[]
  customerName?: string | null
  customerPhone?: string | null
  narration?: string | null
  returnsVoucherId?: number | null
  kind?: 'sale' | 'return'
}

export interface CounterSaleResult {
  counterSaleId: number
  voucherId: number
  number: string
  cart: CounterCart
  tender: TenderResult
  sessionId: number | null
}

export interface CounterSession {
  id: number
  openedOn: string
  openedAt: string
  operator: string | null
  openingFloatPaise: number
  cashLedgerId: number | null
  closedAt: string | null
  countedPaise: number | null
  variancePaise: number | null
  notes: string | null
}

export interface DrawerMovement {
  id: number
  sessionId: number
  at: string
  kind: 'payin' | 'payout'
  amountPaise: number
  reason: string | null
}

export interface SessionSummary {
  session: CounterSession
  drawer: DrawerReconciliation
  sales: number
  returns: number
  byMode: { mode: string; amountPaise: number }[]
  movements: DrawerMovement[]
  turnoverPaise: number
}

export interface CounterSaleRow {
  id: number
  voucherId: number
  number: string
  date: string
  kind: 'sale' | 'return'
  customerName: string | null
  totalPaise: number
  changePaise: number
  modes: string
}

export interface ReturnableSale {
  voucherId: number
  number: string
  date: string
  totalPaise: number
  customerName: string | null
  lines: { stockItemId: number; name: string; qtyMilli: number; ratePaise: number }[]
}

export type Stage = 'quotation' | 'order' | 'challan'
export type DocStatus = 'open' | 'converted' | 'closed' | 'lost'

export interface SalesDocLine {
  id: number
  stockItemId: number | null
  description: string
  qtyMilli: number
  ratePaise: number
  discountPaise: number
  gstRate: number | null
  hsn: string | null
  fulfilledMilli: number
  pendingMilli: number
  amountPaise: number
}

export interface SalesDoc {
  id: number
  stage: Stage
  number: string
  date: string
  partyLedgerId: number | null
  partyName: string | null
  validUntil: string | null
  reference: string | null
  narration: string | null
  terms: string | null
  fromDocumentId: number | null
  convertedToId: number | null
  invoiceVoucherId: number | null
  convertedOn: string | null
  status: DocStatus
  closedReason: string | null
  createdAt: string
  lines: SalesDocLine[]
  taxablePaise: number
  gst: { taxable: number; cgst: number; sgst: number; igst: number; cess: number; total: number }
  totalPaise: number
  expired: boolean
}

export interface SalesDocInput {
  stage: Stage
  number?: string
  date: string
  partyLedgerId?: number | null
  partyName?: string | null
  validUntil?: string | null
  reference?: string | null
  narration?: string | null
  terms?: string | null
  lines: {
    stockItemId?: number | null
    description: string
    qtyMilli: number
    ratePaise: number
    discountPaise?: number
    gstRate?: number | null
    hsn?: string | null
  }[]
}

export interface InvoiceDraft {
  documentId: number
  documentNumber: string
  date: string
  partyLedgerId: number
  narration: string
  lines: { ledgerName: string; group: string; drCr: 'dr' | 'cr'; amount: number }[]
  inventory: { stockItemId: number; description: string; qtyMilli: number; ratePaise: number; discountPaise: number; amount: number }[]
  gst: { taxable: number; cgst: number; sgst: number; igst: number; cess: number; total: number }
  totalPaise: number
}

export interface SalesPipeline {
  stages: { stage: Stage; open: number; openValuePaise: number; converted: number; lost: number }[]
  expiringSoon: SalesDoc[]
}

// ---------- job work: goods out on challan, and the section 143 clock (roadmap D-89) ----------
//
// The row shapes mirror `src/main/services/jobWork.ts`; the statutory shapes come from the engine
// so the renderer reads the same `// VERIFY:` markers the calculation carries.

export interface JobWorkReturnRow {
  id: number
  challanId: number
  date: string
  number: string | null
  qtyMilli: number
  disposition: JobWorkDisposition
  invoiceVoucherId: number | null
  invoiceNumber: string | null
  notes: string | null
}

export interface JobWorkChallan {
  id: number
  number: string
  date: string
  jobWorkerLedgerId: number | null
  jobWorkerName: string | null
  jobWorkerGstin: string | null
  jobWorkerStateCode: string
  goodsType: JobWorkGoodsType
  stockItemId: number | null
  description: string
  hsn: string | null
  qtyMilli: number
  uqc: string
  taxablePaise: number
  gstRate: number
  mouldsDiesJigsTools: boolean
  receivedByJobWorkerOn: string | null
  extendedDueBackBy: string | null
  notes: string | null
  createdAt: string
  returns: JobWorkReturnRow[]
  accountedMilli: number
  /** Still out with the job worker. Never negative. */
  balanceMilli: number
}

export interface JobWorkChallanInput {
  number?: string
  date: string
  jobWorkerLedgerId?: number | null
  jobWorkerGstin?: string | null
  jobWorkerStateCode?: string | null
  goodsType: JobWorkGoodsType
  stockItemId?: number | null
  description: string
  hsn?: string | null
  qtyMilli: number
  uqc?: string
  taxablePaise?: number
  gstRate?: number
  mouldsDiesJigsTools?: boolean
  receivedByJobWorkerOn?: string | null
  extendedDueBackBy?: string | null
  notes?: string | null
}

export interface JobWorkReturnInput {
  challanId: number
  date: string
  number?: string | null
  qtyMilli: number
  disposition: JobWorkDisposition
  invoiceVoucherId?: number | null
  notes?: string | null
}

export interface JobWorkClockRow extends DeemedSupplyRow {
  challanId: number
  jobWorkerName: string | null
}

export interface JobWorkClock {
  asOn: string
  rows: JobWorkClockRow[]
  /** The ones the clock has run out on — a deemed supply backdated to the despatch date. */
  overdue: JobWorkClockRow[]
  totalDeemedValuePaise: number
  totalDeemedTaxPaise: number
  issues: Itc04Issue[]
}

export interface Itc04Working {
  obligation: Itc04Obligation
  turnoverPaise: number
  turnoverSource: 'declared-band' | 'given'
  periods: Itc04Period[]
  periodIndex: number
  fyStartYear: number
  form: Itc04
  challanIds: Record<string, number>
  jobWorkerNames: Record<string, string>
}

export interface JournalDraft {
  date: string
  narration: string
  lines: { ledgerName: string; group: string; drCr: 'dr' | 'cr'; amount: number }[]
  total: number
}

export type LoanKind = 'term' | 'vehicle' | 'machinery' | 'working_capital' | 'other'

export interface Loan {
  id: number
  name: string
  lender: string | null
  accountNumber: string | null
  kind: LoanKind
  ledgerId: number | null
  interestLedgerId: number | null
  principalPaise: number
  annualRateBp: number
  months: number
  emiPaise: number | null
  disbursedOn: string
  firstInstalmentDate: string
  notes: string | null
  closedOn: string | null
}

export type LoanInput = Omit<Loan, 'id' | 'closedOn'>

export interface LoanPosting {
  instalmentNo: number
  voucherId: number | null
  postedOn: string
  interestPaise: number
  principalPaise: number
}

export interface LoanView {
  loan: Loan
  schedule: LoanSchedule
  postings: LoanPosting[]
  outstandingPaise: number
  unposted: LoanSchedule['rows']
  interestThisYearPaise: number
}

export interface Deposit {
  id: number
  direction: 'paid' | 'received'
  counterparty: string
  partyLedgerId: number | null
  ledgerId: number | null
  purpose: string | null
  amountPaise: number
  paidOn: string
  refundableOn: string | null
  interestRateBp: number | null
  returnedOn: string | null
  returnedAmountPaise: number | null
  notes: string | null
}

export type DepositInput = Omit<Deposit, 'id' | 'returnedOn' | 'returnedAmountPaise'>

export interface DepositSummary {
  paidPaise: number
  receivedPaise: number
  overdue: Deposit[]
  stale: Deposit[]
}

export interface CwipCost {
  id: number
  date: string
  description: string
  amountPaise: number
  voucherId: number | null
  supplier: string | null
}

export interface CwipProject {
  id: number
  name: string
  startedOn: string
  ledgerId: number | null
  notes: string | null
  capitalisedOn: string | null
  fixedAssetId: number | null
  capitalisationVoucherId: number | null
  costs: CwipCost[]
  totalPaise: number
}

export interface CapitalisationDraft extends JournalDraft {
  project: CwipProject
}

export interface PrepaidSchedule {
  id: number
  kind: 'prepaid' | 'accrued'
  name: string
  amountPaise: number
  periodFrom: string
  periodTo: string
  basis: 'month' | 'day'
  expenseLedgerId: number | null
  balanceLedgerId: number | null
  sourceVoucherId: number | null
  notes: string | null
  rows: AmortisationRow[]
  postedMonths: string[]
  duePaise: number
  unexpiredPaise: number
}

export type PrepaidInput = Omit<PrepaidSchedule, 'id' | 'rows' | 'postedMonths' | 'duePaise' | 'unexpiredPaise'>

export interface StockStatement extends DrawingPowerResult {
  id: number | null
  filedOn: string | null
  notes: string | null
  margins: DrawingPowerMargins
  excludedParties: { name: string; pending: number }[]
}

export interface FiledStatement {
  id: number
  asOn: string
  stockPaise: number
  eligibleDebtorsPaise: number
  creditorsPaise: number
  drawingPowerPaise: number
  utilisedPaise: number
  filedOn: string | null
}

export interface CommissionScheme {
  id: number
  salesperson: string
  rateBp: number
  basis: 'gross' | 'net_of_tax'
  fromDate: string
  active: boolean
}

export interface CommissionReport {
  from: string
  to: string
  statements: CommissionStatement[]
  totalCommissionPaise: number
  totalCollectedPaise: number
  unassignedCollectedPaise: number
  withoutScheme: string[]
}

export type CommissionDraft = JournalDraft

export interface RawPrinter {
  name: string
  description: string | null
  isDefault: boolean
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
  /** Whether the trail still hashes to what it says (roadmap #265). */
  tamperEvidence: {
    intact: boolean
    entriesProved: number
    entriesUnproved: number
    findings: string[]
  }
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

/** Mirrors src/main/db/backup.ts's RestorePreview (kept local — main-process only). */
export interface RestorePreview {
  file: string
  problem: string | null
  changes: { what: string; now: string; after: string; loses: boolean }[]
  vouchersLost: number
  vouchersReturned: number
  sample: { date: string; type: string; number: string; amount: number }[]
}

/** Mirrors src/main/services/config.ts's ArchiveState. */
export interface ArchiveState {
  archived: boolean
  note: string | null
  at: string | null
  by: string | null
}

/** The scheduled copy of the books, as the settings screen sees it. */
export interface ExternalBackupView {
  dir: string | null
  everyHours: number
  encrypt: boolean
  keep: number
  lastRunAt: string | null
  lastError: string | null
  description: string
  hasPassphrase: boolean
}

export interface ExternalBackupInput {
  dir: string | null
  everyHours: number
  encrypt: boolean
  keep: number
  passphrase?: string
}

/** An import that may first have to ask whether a second copy of these books is really wanted. */
export type ImportOutcome =
  | { needsConfirmation: true; duplicates: { slug: string; name: string; reason: 'gstin' | 'name' }[]; warning: string | null }
  | { needsConfirmation: false; slug: string; name: string }

/** Mirrors src/main/services/auditChain.ts's ChainVerification. */
export interface ChainVerification {
  ok: boolean
  checked: number
  unchained: number
  problems: { kind: string; id: number; at: string; detail: string }[]
  headHash: string | null
  headId: number | null
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
  /** Areas this account may not reach, on top of its role (roadmap #266). */
  denied: Capability[]
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
  /** The s.197 / 197A certificate in force for this payee, section and date — usually null. */
  certificate: {
    certificateId: number
    certificateNumber: string
    ratePercent: number
    validFrom: string
    validTo: string
    ceilingPaise: number | null
    alreadyPaidPaise: number
    headroomPaise: number | null
  } | null
  /** The rate(s) `tdsPaise` is made of. Two when the payment straddles the Rule 28AA ceiling. */
  ratesApplied: { ratePercent: number; basePaise: number; tdsPaise: number; underCertificate: boolean }[]
  certificateExhausted: boolean
}

/** Mirrors src/main/services/tds.ts's TdsSummaryRow shape (kept local — that file is main-process only). */
export interface TdsSummaryRow {
  sectionCode: string
  quarter: string
  deductees: number
  base: number
  tds: number
}

/** Mirrors src/main/services/tdsCertificates.ts's CertificateWithUsage (s.197 / Rule 28AA). */
export interface TdsCertificateRow {
  id: number
  certificateNumber: string
  pan: string
  sectionCode: string
  ratePercent: number
  validFrom: string
  validTo: string
  /** Rule 28AA(4) ceiling in paise. NULL = the AO named no amount; 0 = nothing left on it. */
  ceilingPaise: number | null
  notes: string | null
  createdAt: string
  usedPaise: number
  headroomPaise: number | null
  exhausted: boolean
}

/** Mirrors src/main/services/form26as.ts's Book26asEntryRef. */
export interface Book26asEntryRow {
  id: number | string
  voucherId: number
  voucherNumber: string
  ledgerName: string
  deductorName: string | null
  deductorTan: string | null
  tanSource: 'statement' | null
  section: string
  date: string
  amountPaise: number
  tdsPaise: number
}

/** Mirrors src/main/services/form26as.ts's Recon26asReport. */
export interface Recon26asReport {
  problems: string[]
  statementRows: Statement26asRow[]
  bookEntries: Book26asEntryRow[]
  result: Recon26asResult
  from: string
  to: string
}

/** Mirrors src/main/services/costCentres.ts's CcReportRow shape (kept local — that file is main-process only). */
export interface CcReportRow {
  /** -1 on the synthetic "Not allocated" reconciling row. */
  costCentreId: number
  name: string
  income: number
  expense: number
  net: number
  /** net ÷ income as a percentage; null when there was no income to take a margin on. */
  marginPct: number | null
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

/**
 * Mirrors src/main/services/amendments.ts (main-process only, so the shapes are restated here).
 * The engine types it composes — AmendmentChange, AmendmentTables — are pure and imported from
 * @shared/gst/amendments.
 */
export interface AmendmentFiledPeriod {
  /** Portal tax period 'MMYYYY'. */
  period: string
  filedAt: string
  docs: number
  /** Only an EARLIER period can be amended in this one. */
  earlier: boolean
}
export interface AmendmentRowInfo {
  table: 'b2ba' | 'b2cla' | 'cdnra' | 'cdnura'
  originalPeriod: string
  originalNumber: string
  originalDate: string
  originalGstin: string | null
  number: string
  date: string
  partyName: string | null
  partyGstin: string | null
  pos: string
  invoiceValue: number
  voucherId: number
  changes: AmendmentChange[]
}
export interface AmendmentDeletedDoc {
  originalPeriod: string
  number: string
  date: string
  partyGstin: string | null
  invoiceValue: number
  voucherId: number | null
  message: string
}
export interface AmendmentAddedDoc {
  originalPeriod: string
  number: string
  date: string
  voucherId: number
  invoiceValue: number
  message: string
}
export interface AmendmentReport {
  period: string
  filedPeriods: AmendmentFiledPeriod[]
  /** True when no earlier period has ever been marked filed — there is nothing to amend AGAINST,
   *  which is a different statement from "nothing changed". */
  noSnapshots: boolean
  tables: AmendmentTables
  rows: AmendmentRowInfo[]
  deleted: AmendmentDeletedDoc[]
  addedAfterFiling: AmendmentAddedDoc[]
  json: Record<string, unknown> | null
  counts: { amended: number; unchanged: number; rejected: number }
}

/** Mirrors src/main/services/edocs.ts's EwayDistanceOffer (main-process only). */
export interface EwayDistanceOffer {
  fromPin: string | null
  toPin: string | null
  toPinSource: 'ship_to' | 'typed' | null
  /** Null when a PIN cannot be placed — an unknown PIN offers nothing at all, never a guess. */
  estimate: { km: number; basis: string; approximate: true } | null
  /** PIN_DISTANCE_DISCLAIMER, shown verbatim beside the figure. */
  disclaimer: string
  storedKm: number | null
  reason: string | null
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
      call<{
        slug: string
        info: CompanyInfo
        integrity: IntegrityResult
        locked: boolean
        archived: boolean
        /** Set when another machine holds these books open, or left them open (roadmap #259). */
        openElsewhere: string | null
      }>('company:open', { slug }),
    close: () => call<null>('company:close'),
    current: () => call<{ slug: string; info: CompanyInfo; locked: boolean } | null>('company:current'),
    updateInfo: (input: CompanyCreateInput) => call<CompanyInfo>('company:updateInfo', input),
    backup: () => call<{ path: string }>('company:backup'),
    revealExports: () => call<null>('company:revealExports'),
    lockGet: () => call<{ date: string | null }>('company:lock:get'),
    lockSet: (date: string | null) => call<{ date: string | null }>('company:lock:set', { date }),
    /** Company-wide read-only lock for books nobody should be posting into (roadmap #257). */
    archiveGet: () => call<ArchiveState>('company:archive:get'),
    archiveSet: (archived: boolean, note: string | null) => call<ArchiveState>('company:archive:set', { archived, note })
  },
  backups: {
    list: () => call<BackupInfo[]>('backup:list'),
    /** What restoring this backup would change, before it changes it (roadmap #246). */
    preview: (file: string) => call<RestorePreview>('backup:preview', { file }),
    /** What to do when the database is damaged (roadmap #248). */
    recovery: () => call<{ integrity: IntegrityResult; guidance: RecoveryGuidance }>('backup:recovery'),
    externalGet: () => call<ExternalBackupView>('backup:external:get'),
    externalChoose: () =>
      call<{ dir: string; verdict: { ok: true; warning: string | null } | { ok: false; error: string } } | null>(
        'backup:external:choose'
      ),
    externalSet: (input: ExternalBackupInput) => call<ExternalBackupView>('backup:external:set', input),
    externalRunNow: () => call<{ ran: boolean; path: string | null; pruned: number }>('backup:external:runNow'),
    run: () => call<{ path: string }>('backup:run'),
    /** Opens the backup and foots its books — the only claim worth making about a backup. */
    verify: (file: string) => call<BackupVerification>('backup:verify', { file }),
    keepGet: () => call<{ keep: number }>('config:backupKeep:get'),
    keepSet: (keep: number) => call<{ keep: number }>('config:backupKeep:set', { keep }),
    restore: (file: string) =>
      call<{ info: CompanyInfo; integrity: IntegrityResult; locked: boolean }>('backup:restore', { file }),
    exportEncrypted: (passphrase: string) => call<{ path: string }>('backup:exportEncrypted', { passphrase }),
    importEncrypted: (passphrase: string, allowDuplicate = false) =>
      call<ImportOutcome | null>('backup:importEncrypted', { passphrase, allowDuplicate })
  },

  /** The books in a documented open format, guaranteed to round-trip (roadmap #254). */
  portable: {
    export: () => call<{ path: string; vouchers: number; ledgers: number }>('export:portable'),
    import: (allowDuplicate = false, json?: string) =>
      call<ImportOutcome | null>('import:portable', { allowDuplicate, json })
  },

  /** The entry somebody was halfway through when the app died (roadmap #250). */
  /** Where the books live, and moving them out of a synced folder (roadmap #244). */
  dataFolder: {
    get: () =>
      call<{
        root: string
        isDefault: boolean
        /** The folder that was chosen has gone; the app has fallen back to the default. */
        chosenMissing: boolean
        syncedBy: string | null
        companyOpen: boolean
      }>('app:dataRoot:get'),
    move: (destination?: string) =>
      call<{ from: string; to: string; companies: number; warning: string | null } | null>('app:dataRoot:move', {
        destination
      })
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
    /**
     * The dated GST rate changes for an item (roadmap D-92). A document is always priced with the
     * rate in force on its OWN date, so this is a list, not a field.
     */
    rates: (stockItemId: number, asOn?: string) =>
      call<ItemRateHistoryView>('item:rates:list', { stockItemId, asOn }),
    /** Warnings never block the save — an unusual rate is usually a real one. */
    saveRate: (data: ItemRateInput, id?: number) =>
      call<{ row: ItemRateRow; warnings: string[] }>('item:rates:save', { id, data }),
    deleteRate: (id: number) => call<null>('item:rates:delete', { id }),
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
    exceptions: (from: string, to: string, largeVoucherPaise?: number) =>
      call<ExceptionsReport>('report:exceptions', { from, to, largeVoucherPaise }),
    /** Every ledger that moved between two dates, biggest mover first (roadmap C66). */
    whatChanged: (from: string, to: string) => call<ChangeReport>('report:whatChanged', { from, to }),
    /** The ratio panel with the figures behind it, as on `to` (roadmap C60). */
    ratios: (fyFrom: string, asOn: string) => call<RatioReport>('report:ratios', { from: fyFrom, to: asOn }),
    itemProfitByPeriod: (from: string, to: string, groupBy: Period) =>
      call<ItemProfitPeriod[]>('report:itemProfitByPeriod', { from, to, groupBy }),
    /** Cash forecast from open bills, PDCs and recurring templates (roadmap C61). */
    cashForecast: (from: string, to: string, bucketDays?: number) =>
      call<CashForecast>('report:cashForecast', { from, to, bucketDays })
  },
  /** Saved report views: named display state per screen (roadmap C58). */
  views: {
    list: (screen?: string) => call<ReportView[]>('view:list', { screen }),
    save: (screen: string, name: string, state: unknown) => call<ReportView>('view:save', { screen, name, state }),
    remove: (id: number) => call<null>('view:delete', { id })
  },
  /** Reports written to a folder on a timer (roadmap C59). */
  schedules: {
    list: () => call<ReportSchedule[]>('schedule:list'),
    save: (data: ReportScheduleInput, id?: number) => call<ReportSchedule>('schedule:save', { data, id }),
    remove: (id: number) => call<null>('schedule:delete', { id }),
    run: (id: number) => call<ScheduleRunResult>('schedule:run', { id })
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
  /** Counter mode: the till, the drawer and the schemes that price it. */
  counter: {
    lookup: (query: string, asOn?: string) => call<CounterItem | null>('counter:lookup', { query, asOn }),
    price: (input: PriceCartInput) => call<CounterCart>('counter:price', input),
    sale: (input: CounterSaleInput) => call<CounterSaleResult>('counter:sale', input),
    session: () => call<CounterSession | null>('counter:session'),
    sessions: (limit?: number) => call<CounterSession[]>('counter:sessions', { limit }),
    open: (input: { openedOn?: string; operator?: string | null; openingFloatPaise: number }) =>
      call<CounterSession>('counter:open', input),
    summary: (sessionId: number) => call<SessionSummary>('counter:summary', { sessionId }),
    close: (sessionId: number, countedPaise: number, notes: string | null) =>
      call<SessionSummary>('counter:close', { sessionId, countedPaise, notes }),
    movement: (sessionId: number, kind: 'payin' | 'payout', amountPaise: number, reason: string | null) =>
      call<DrawerMovement>('counter:movement', { sessionId, kind, amountPaise, reason }),
    sales: (sessionId?: number, limit?: number) => call<CounterSaleRow[]>('counter:sales', { sessionId, limit }),
    findSale: (query: string) => call<ReturnableSale | null>('counter:findSale', { query }),
    schemes: () => call<DiscountScheme[]>('counter:schemes'),
    saveScheme: (data: SchemeInput, id?: number) => call<DiscountScheme>('counter:saveScheme', { data, id }),
    deleteScheme: (id: number) => call<null>('counter:deleteScheme', { id })
  },
  /** Quotation → order → challan → invoice. */
  salesDocs: {
    list: (stage?: Stage, status?: DocStatus) => call<SalesDoc[]>('salesdoc:list', { stage, status }),
    get: (id: number) => call<SalesDoc | null>('salesdoc:get', { id }),
    next: (stage: Stage) => call<{ number: string }>('salesdoc:next', { stage }),
    save: (data: SalesDocInput, id?: number) => call<SalesDoc>('salesdoc:save', { data, id }),
    remove: (id: number) => call<null>('salesdoc:delete', { id }),
    close: (id: number, status: 'closed' | 'lost', reason: string | null) =>
      call<SalesDoc>('salesdoc:close', { id, status, reason }),
    convert: (id: number, opts: { quantities?: { lineId: number; qtyMilli: number }[]; date?: string } = {}) =>
      call<SalesDoc>('salesdoc:convert', { id, ...opts }),
    invoiceDraft: (id: number) => call<InvoiceDraft>('salesdoc:invoiceDraft', { id }),
    markInvoiced: (id: number, voucherId: number) => call<SalesDoc>('salesdoc:markInvoiced', { id, voucherId }),
    pipeline: () => call<SalesPipeline>('salesdoc:pipeline')
  },
  /** Goods out with a job worker, what came back, and what section 143 now deems supplied. */
  jobWork: {
    list: (opts: { from?: string; to?: string; openOnly?: boolean } = {}) =>
      call<JobWorkChallan[]>('jobWork:list', opts),
    get: (id: number) => call<JobWorkChallan | null>('jobWork:get', { id }),
    next: () => call<{ number: string }>('jobWork:next'),
    save: (data: JobWorkChallanInput, id?: number) => call<JobWorkChallan>('jobWork:save', { data, id }),
    remove: (id: number) => call<null>('jobWork:delete', { id }),
    saveReturn: (data: JobWorkReturnInput, id?: number) =>
      call<JobWorkChallan>('jobWork:saveReturn', { data, id }),
    removeReturn: (id: number) => call<JobWorkChallan>('jobWork:deleteReturn', { id }),
    clock: (asOn?: string) => call<JobWorkClock>('jobWork:clock', { asOn }),
    itc04: (opts: { fyStartYear?: number; periodIndex?: number; asOn?: string; aggregateTurnoverPaise?: number } = {}) =>
      call<Itc04Working>('jobWork:itc04', opts)
  },
  /** Loans, deposits, projects, prepayments — and the return the bank asks for every month. */
  borrowing: {
    loans: () => call<Loan[]>('loans:list'),
    saveLoan: (data: LoanInput, id?: number) => call<Loan>('loans:save', { data, id }),
    removeLoan: (id: number) => call<null>('loans:delete', { id }),
    loanView: (id: number, asOn?: string, fyFrom?: string, fyTo?: string) =>
      call<LoanView>('loans:view', { id, asOn, fyFrom, fyTo }),
    instalmentDraft: (id: number, instalmentNo: number) =>
      call<JournalDraft>('loans:instalmentDraft', { id, instalmentNo }),
    postInstalment: (id: number, instalmentNo: number, voucherId: number | null) =>
      call<LoanPosting>('loans:postInstalment', { id, instalmentNo, voucherId }),

    deposits: (includeReturned = false) => call<Deposit[]>('deposits:list', { includeReturned }),
    depositSummary: (asOn?: string) => call<DepositSummary>('deposits:summary', { asOn }),
    saveDeposit: (data: DepositInput, id?: number) => call<Deposit>('deposits:save', { data, id }),
    returnDeposit: (id: number, on: string, amountPaise: number) =>
      call<Deposit>('deposits:return', { id, on, amountPaise }),
    removeDeposit: (id: number) => call<null>('deposits:delete', { id }),

    projects: (includeCapitalised = true) => call<CwipProject[]>('cwip:list', { includeCapitalised }),
    saveProject: (data: { name: string; startedOn: string; ledgerId?: number | null; notes?: string | null }, id?: number) =>
      call<CwipProject>('cwip:save', { data, id }),
    addCost: (
      projectId: number,
      data: { date: string; description: string; amountPaise: number; supplier?: string | null }
    ) => call<CwipProject>('cwip:addCost', { projectId, data }),
    removeCost: (id: number) => call<null>('cwip:removeCost', { id }),
    capitaliseDraft: (id: number, on: string, assetLedgerName: string) =>
      call<CapitalisationDraft>('cwip:capitaliseDraft', { id, on, assetLedgerName }),
    capitalise: (id: number, on: string, fixedAssetId: number | null, voucherId: number | null) =>
      call<CwipProject>('cwip:capitalise', { id, on, fixedAssetId, voucherId }),

    prepaid: (asOn?: string) => call<PrepaidSchedule[]>('prepaid:list', { asOn }),
    savePrepaid: (data: PrepaidInput, id?: number) => call<PrepaidSchedule>('prepaid:save', { data, id }),
    removePrepaid: (id: number) => call<null>('prepaid:delete', { id }),
    prepaidDraft: (id: number, month: string) => call<JournalDraft>('prepaid:draft', { id, month }),
    postPrepaid: (id: number, month: string, voucherId: number | null) =>
      call<PrepaidSchedule>('prepaid:post', { id, month, voucherId }),

    stockStatement: (asOn: string, margins?: DrawingPowerMargins, ccLedgerId?: number | null) =>
      call<StockStatement>('bank:stockStatement', { asOn, margins, ccLedgerId }),
    fileStatement: (asOn: string, margins: DrawingPowerMargins, notes: string | null) =>
      call<StockStatement>('bank:fileStatement', { asOn, margins, notes }),
    statements: () => call<FiledStatement[]>('bank:statements'),
    unfileStatement: (id: number) => call<null>('bank:unfileStatement', { id })
  },
  /** Salesperson commission, computed on the receipt rather than on the invoice. */
  commission: {
    report: (from: string, to: string) => call<CommissionReport>('commission:report', { from, to }),
    draft: (from: string, to: string) => call<CommissionDraft | null>('commission:draft', { from, to }),
    schemes: () => call<CommissionScheme[]>('commission:schemes'),
    saveScheme: (
      data: { salesperson: string; rateBp: number; basis: 'gross' | 'net_of_tax'; fromDate: string; active?: boolean },
      id?: number
    ) => call<CommissionScheme>('commission:saveScheme', { data, id }),
    deleteScheme: (id: number) => call<null>('commission:deleteScheme', { id })
  },
  /** Dot-matrix, printed raw. Untested against a physical printer — see services/rawPrint.ts. */
  rawPrint: {
    printers: () => call<RawPrinter[]>('print:printers'),
    preview: (voucherId: number, options?: EscpOptions) =>
      call<{ number: string; bytes: number; text: string }>('print:escpPreview', { voucherId, options }),
    print: (voucherId: number, printer: string, options?: EscpOptions) =>
      call<{ printer: string | null; bytes: number; path: string | null; number: string }>('print:escp', { voucherId, printer, options }),
    save: (voucherId: number, options?: EscpOptions) =>
      call<{ printer: string | null; bytes: number; path: string | null; number: string }>('print:escpSave', { voucherId, options })
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
    suggest: (partyLedgerId: number, base: number, date: string, excludeVoucherId?: number) =>
      call<TdsSuggestion | null>('tds:suggest', { partyLedgerId, base, date, excludeVoucherId }),
    summary: (fyStartYear: number) => call<TdsSummaryRow[]>('tds:summary', { fyStartYear }),
    export26q: (fyStartYear: number, quarter: number) => call<{ path: string }>('tds:export26q', { fyStartYear, quarter }),
    /** Section 197 / 197A lower-deduction certificates, with their Rule 28AA consumption. */
    certificates: () => call<TdsCertificateRow[]>('tds:certificates'),
    certificateSave: (data: TdsCertificateInput, id?: number) =>
      call<TdsCertificateRow>('tds:certificateSave', { id, data }),
    certificateDelete: (id: number) => call<null>('tds:certificateDelete', { id }),
    /** Reconcile a pasted/loaded Form 26AS against the books. The statement is never stored. */
    recon26as: (text: string, from: string, to: string) =>
      call<Recon26asReport>('tds:recon26as', { text, from, to }),
    pick26as: () => call<{ text: string; fileName: string } | null>('tds:pick26as')
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
  /**
   * GSTR-1 amendments — Tables 9A/9C, diffed against the snapshot taken when each earlier
   * GSTR-1 was marked filed (roadmap D-101).
   */
  amendments: {
    report: (period: string) => call<AmendmentReport>('amendments:report', { period }),
    exportJson: (period: string) =>
      call<{ path: string; counts: { amended: number; unchanged: number; rejected: number } }>(
        'amendments:export',
        { period }
      )
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
      call<VoucherTransport>('edoc:transportSet', { voucherId, data }),
    /** An approximate PIN-to-PIN distance to OFFER for the e-way bill. This call never stores
     *  anything — the user accepts it and saves it through transportSet (roadmap D-96). */
    estimateDistance: (voucherId: number, fromPin: string | null, toPin: string | null) =>
      call<EwayDistanceOffer>('edoc:estimateDistance', { voucherId, fromPin, toPin })
  },
  invoice: {
    pdf: (voucherId: number) => call<{ path: string }>('invoice:pdf', { voucherId }),
    pdfBatch: (voucherIds: number[]) => call<{ dir: string; paths: string[] }>('invoice:pdfBatch', { voucherIds }),
    previewHtml: (voucherId?: number, config?: Partial<InvoiceConfig>) =>
      call<{ html: string }>('invoice:previewHtml', { voucherId, config }),
    thermalPdf: (voucherId: number) => call<{ path: string }>('invoice:thermalPdf', { voucherId }),
    thermalHtml: (voucherId: number) =>
      call<{ html: string; widthMm: number }>('invoice:thermalHtml', { voucherId }),
    /** Renders the PDF, puts it on the clipboard, and hands back the links to open (I-193/I-192). */
    share: (voucherId: number) =>
      call<{
        subject: string
        body: string
        mailto: string
        whatsapp: string | null
        attachmentHint: string
        pdfPath: string
        partyName: string
        clipboard: 'file' | 'path'
      }>('invoice:share', { voucherId })
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
      call<{ voucherId: number; netProfit: number; lockedUpTo: string }>('yearend:close', { fyStartYear }),
    /** Undo a close that was run on the wrong year (roadmap #258). */
    reverse: (fyStartYear: number) =>
      call<{ voucherId: number; lockedUpTo: string | null }>('yearend:reverse', { fyStartYear })
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
    caPack: (from: string, to: string) =>
      call<{ path: string; pdfPath: string; workbookPath: string }>('export:caPack', { from, to }),
    tallyXml: (from: string, to: string) => call<{ path: string }>('export:tallyXml', { from, to })
  },
  exportReport: {
    pdf: (input: ReportPdfInput) => call<{ path: string }>('report:pdf', input),
    csv: (filename: string, csv: string) => call<{ path: string }>('export:csv', { filename, csv }),
    /** Typed cells, not formatted strings: money crosses as integer paise so it lands in the
     *  sheet as a number that adds up. */
    xls: (filename: string, sheets: XlsExportSheet[]) => call<{ path: string }>('export:xls', { filename, sheets })
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
  support: {
    /** Post the report the user just read. Main does the network call — the renderer's CSP is
     *  `default-src 'self'` and could not reach the endpoint if it wanted to. */
    send: (input: { message: string; email: string; log: string }) =>
      call<{ delivered: true }>('support:send', input)
  },
  search: {
    global: (q: string) => call<SearchHit[]>('search:global', { q })
  },
  audit: {
    list: (query: AuditListInput) => call<{ rows: AuditRow[]; total: number }>('audit:list', query),
    /** Does the trail still hash to what it says? (roadmap #265) */
    verifyChain: () => call<ChainVerification>('audit:verifyChain'),
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
