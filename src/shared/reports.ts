/** Result shapes for every report screen. Computed in main, rendered in renderer. */
import type { DrCr, Nature } from './domain'

export interface DayBookRow {
  voucherId: number
  date: string
  voucherType: string
  number: string
  /** Primary party/account shown in the list. */
  account: string
  narration: string | null
  debit: number
  credit: number
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

export interface LedgerStatement {
  ledgerId: number
  ledgerName: string
  opening: number
  rows: LedgerStatementRow[]
  closing: number
  totalDebit: number
  totalCredit: number
}

export interface TrialBalanceRow {
  ledgerId: number
  ledgerName: string
  groupName: string
  debit: number
  credit: number
}

export interface TrialBalance {
  rows: TrialBalanceRow[]
  totalDebit: number
  totalCredit: number
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
}

export interface BalanceSheet {
  asOn: string
  liabilities: StatementNode[]
  assets: StatementNode[]
  /** Current-period P&L folded into liabilities side. */
  profitCurrentPeriod: number
  totalLiabilities: number
  totalAssets: number
}

export interface StockSummaryRow {
  stockItemId: number
  name: string
  unitSymbol: string
  decimals: number
  inwardQtyMilli: number
  outwardQtyMilli: number
  closingQtyMilli: number
  closingValue: number
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
}
