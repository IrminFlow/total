/** Result shapes for every report screen. Computed in main, rendered in renderer. */
import type { DrCr, Nature } from './domain'
import type { RatioPanel } from './reportMath'

export interface DayBookRow {
  voucherId: number
  date: string
  voucherType: string
  /** Voucher-type kind ('sales', 'payment', …) — drives kind-based affordances (invoice PDF)
   *  without brittle voucher-type-name matching (v0.3 S5). */
  kind: string
  number: string
  /** Primary party/account shown in the list. */
  account: string
  narration: string | null
  debit: number
  credit: number
  /** Memorandum voucher — never counts toward the books or totals (v0.3 S5). */
  isOptional: boolean
  /** Post-dated and not yet matured — kept out of the books until its date arrives (v0.3 S5). */
  postDated: boolean
  /** Day Book workflow metadata; omitted by compact consumers such as Dashboard recent rows. */
  tags?: string[]
  reviewedAt?: string | null
  reviewedBy?: string | null
  reversalOfId?: number | null
  reversedById?: number | null
}

export interface LedgerStatementRow {
  voucherId: number
  date: string
  voucherType: string
  number: string
  /** The "other side" ledger(s) of the voucher. */
  particulars: string
  narration: string | null
  debit: number
  credit: number
  /** Signed running balance, positive = Dr. */
  running: number
}

export interface LedgerMonthRow {
  /** 'YYYY-MM' */
  month: string
  debit: number
  credit: number
  /** Signed running balance at month end, positive = Dr. */
  closing: number
}

export interface LedgerStatement {
  ledgerId: number
  ledgerName: string
  opening: number
  rows: LedgerStatementRow[]
  closing: number
  totalDebit: number
  totalCredit: number
  /** Columnar month matrix (v0.3 #55) — present when requested with groupBy: 'month'. */
  months?: LedgerMonthRow[]
}

export interface TrialBalanceRow {
  ledgerId: number
  ledgerName: string
  groupName: string
  /** Closing balance split by side (paise). */
  debit: number
  credit: number
  /** Book opening balance, signed dr-positive (v0.3 #56 opt-in column). */
  opening: number
  /** Gross movement up to asOn, by side (v0.3 #56 opt-in columns). */
  movementDebit: number
  movementCredit: number
}

export interface TrialBalance {
  rows: TrialBalanceRow[]
  totalDebit: number
  totalCredit: number
  openingDebitTotal: number
  openingCreditTotal: number
  movementDebitTotal: number
  movementCreditTotal: number
}

export interface StatementNode {
  /** group or ledger id */
  id: number
  kind: 'group' | 'ledger' | 'computed'
  name: string
  /** Signed paise. Meaning depends on the statement side. */
  amount: number
  children: StatementNode[]
}

export interface ProfitAndLoss {
  period: { from: string; to: string }
  /** Trading section */
  openingStock: number
  closingStock: number
  tradingExpenses: StatementNode[]
  tradingIncomes: StatementNode[]
  grossProfit: number
  /** P&L section */
  indirectExpenses: StatementNode[]
  indirectIncomes: StatementNode[]
  netProfit: number
  /** Same statement for the corresponding prior-year period (v0.3 #57, opt-in; never nested). */
  prior?: ProfitAndLoss
}

export interface BalanceSheet {
  asOn: string
  liabilities: StatementNode[]
  assets: StatementNode[]
  /** Current-period P&L folded into liabilities side. */
  profitCurrentPeriod: number
  totalLiabilities: number
  totalAssets: number
  /** Same statement as on the prior-year date (v0.3 #57, opt-in; never nested). */
  prior?: BalanceSheet
}

export interface StockSummaryRow {
  stockItemId: number
  name: string
  unitSymbol: string
  decimals: number
  /** Book opening (v0.3 #64 — previously folded into inwardQtyMilli). */
  openingQtyMilli: number
  openingValue: number
  /** Pure period inwards, opening excluded. */
  inwardQtyMilli: number
  outwardQtyMilli: number
  closingQtyMilli: number
  closingValue: number
}

export interface StockAgeingRow {
  stockItemId: number
  name: string
  unitSymbol: string
  decimals: number
  closingQtyMilli: number
  /** Qty (milli) by age of the stock still held: 0–30, 31–60, 61–90, 90+ days. */
  buckets: [number, number, number, number]
  lastOutwardDate: string | null
  /** Held stock with no outward movement in the last 90 days. */
  slowMoving: boolean
  reorderLevelMilli: number | null
  /** True when a reorder level is set and closing qty is at or below it. */
  belowReorder: boolean
}

export interface ItemProfitRow {
  stockItemId: number
  name: string
  unitSymbol: string
  decimals: number
  /** Qty sold (sales vouchers' outward lines) in the period. */
  outQtyMilli: number
  salesValue: number
  /** Weighted-average cost of the qty sold. */
  cogs: number
  profit: number
}

export interface ExceptionRow {
  label: string
  detail: string
  voucherId?: number
  ledgerId?: number
  amount?: number
}

export interface ExceptionSection {
  key: 'negativeStock' | 'negativeCash' | 'missingNarration' | 'singleLedger' | 'outsidePeriod' | 'unbalanced' | 'missingGst'
  label: string
  count: number
  /** Detail rows, capped at 200 per section (count is the true total). */
  rows: ExceptionRow[]
}

export interface ExceptionsReport {
  sections: ExceptionSection[]
}

export interface TopLedgerRow {
  ledgerId: number
  name: string
  amount: number
}

export interface CashSparkPoint {
  date: string
  balance: number
}

export interface DashboardData {
  cashBalance: number
  bankBalance: number
  todaySales: number
  monthSales: number
  monthPurchases: number
  receivables: number
  payables: number
  gstPayable: number
  recentVouchers: DayBookRow[]
  /** Top 5 debtors by outstanding Dr balance, descending. */
  topReceivables: TopLedgerRow[]
  /** Top 5 creditors by outstanding Cr balance (positive amount), descending. */
  topPayables: TopLedgerRow[]
  /** Cash + bank running balance, one point per day, trailing 30 days ending today. */
  cashSpark: CashSparkPoint[]
  voucherCount: number
  partyCount: number
  itemCount: number
  hasEmployees: boolean
  /** Financial ratio panel, FY-to-date (v0.3 #54). */
  ratios: RatioPanel
}

export interface VoucherListRow {
  id: number
  date: string
  voucherType: string
  kind: string
  number: string
  account: string
  narration: string | null
  amount: number
  /** Memorandum voucher — never counts toward the books. */
  isOptional: boolean
  /** Post-dated and not yet matured — out of the books until its date arrives. */
  postDated: boolean
}

export interface LedgerBalanceRow {
  ledgerId: number
  name: string
  groupId: number
  groupName: string
  /** Signed paise, positive = Dr, includes opening. */
  balance: number
}

export interface GroupTreeNode {
  id: number
  name: string
  parentId: number | null
  nature: Nature
  isSystem: boolean
  children: GroupTreeNode[]
}

export interface VoucherDetailLine {
  ledgerId: number
  ledgerName: string
  drCr: DrCr
  amount: number
}

export interface RegisterMonthRow {
  /** 'YYYY-MM' */
  month: string
  vouchers: number
  taxable: number
  tax: number
  total: number
}

export type RegisterGranularity = 'month' | 'quarter'

export interface RegisterPeriodRow {
  /** YYYY-MM for a month, or FY-label-Qn for an Indian financial quarter. */
  key: string
  label: string
  from: string
  to: string
  vouchers: number
  taxable: number
  tax: number
  total: number
}

export interface OutstandingBill {
  voucherId: number | null
  number: string
  date: string
  /** Original bill amount (paise). */
  amount: number
  /** Still-unsettled portion (paise). */
  pending: number
  ageDays: number
  /** Named due date (explicit ref, or date + party credit_days); null when neither is known. */
  dueDate: string | null
  /** Days past dueDate (or past the bill date when dueDate is null); 0 when not yet due. */
  overdueDays: number
}

export interface OutstandingParty {
  ledgerId: number
  name: string
  /** Total pending (paise, positive). */
  pending: number
  buckets: [number, number, number, number] // 0-30, 31-60, 61-90, 90+
  bills: OutstandingBill[]
  /** Bill-reference problems surfaced by the allocator (v0.3 #66), e.g. an 'against' ref
   *  naming a bill that isn't open. */
  warnings?: string[]
}

export interface BankLineRow {
  lineId: number
  voucherId: number
  date: string
  voucherType: string
  number: string
  particulars: string
  instrumentNo: string | null
  /** Paise into the bank (dr) or out (cr). */
  deposit: number
  withdrawal: number
  bankDate: string | null
}

export interface BankRecon {
  ledgerId: number
  ledgerName: string
  bookBalance: number
  unreconciledDeposits: number
  unreconciledWithdrawals: number
  /** bookBalance − unreconciled deposits + unreconciled withdrawals. */
  bankBalance: number
  rows: BankLineRow[]
}

export interface EdocListRow {
  voucherId: number
  number: string
  date: string
  docType: 'INV' | 'CRN' | 'DBN'
  partyName: string | null
  partyGstin: string | null
  total: number
  vehicleNo: string | null
  hasHsn: boolean
  irn: string | null
  ewbNo: string | null
  /** Outward (sales-side) debit note — exports in EWB files as docType 'OTH'. */
  outwardDbn: boolean
  /** Why this row is NOT e-way-bill eligible; null when eligible. The ₹50,000-threshold
   *  reason is advisory — the per-bill export overrides it. */
  ewbReason: string | null
}
