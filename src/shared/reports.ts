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
  /**
   * Bank reconciliation state, for vouchers that touch a bank ledger.
   *
   * `null` means "not a bank voucher" — a cash receipt is not "unreconciled", and showing it as
   * pending would put a permanent to-do beside entries that can never be cleared. `'partial'`
   * covers a voucher touching two bank ledgers where only one leg has been marked off.
   *
   * Absent (rather than null) when the producer did not compute it: the Gateway's eight-row
   * recent list has no reconciliation column, and one value must not have to mean both
   * "not applicable" and "not asked".
   */
  bankStatus?: 'reconciled' | 'partial' | 'pending' | null
}

/** One voucher type's contribution to a period — the Day Book's summary view. */
export interface DayBookTypeRow {
  kind: string
  voucherType: string
  count: number
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

export interface LedgerPeriodRow {
  /** Opaque bucket key from `periodKey` — 'YYYY-MM', 'YYYY-Qn', 'YYYY-Hn' or 'YYYY-FY'. */
  period: string
  /** Ready-to-render column header, e.g. 'Apr 2026' or 'Q1 FY2026-27'. */
  label: string
  debit: number
  credit: number
  /** Signed running balance at period end, positive = Dr. */
  closing: number
}

export interface LedgerStatement {
  ledgerId: number
  ledgerName: string
  opening: number
  rows: LedgerStatementRow[]
  /** Rows in the period, which is more than `rows.length` when a page was requested. */
  totalRows: number
  closing: number
  totalDebit: number
  totalCredit: number
  /** Columnar period matrix — present when requested with a `groupBy` granularity. */
  periods?: LedgerPeriodRow[]
  /**
   * Keyset cursor for the page after this one, or null when this page is the last.
   *
   * Null is the honest end-of-list signal: comparing `rows.length` against `totalRows` cannot be,
   * because a voucher saved between two page fetches changes the denominator.
   */
  nextCursor?: string | null
}

export interface TrialBalanceRow {
  ledgerId: number
  ledgerName: string
  groupName: string
  /**
   * The primary (root) group the ledger's group descends from — 'Current Assets' where
   * `groupName` is 'Sundry Debtors'. Carried so the screen can subtotal at balance-sheet level
   * without a second query; optional so an older payload still renders.
   */
  topGroupName?: string
  /**
   * Nature of the group this ledger sits under.
   *
   * Carried so the screen can flag a balance on the wrong side — a bank account in credit, a
   * customer with a credit balance — without a second query or a name-matching guess.
   */
  nature: Nature
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

/**
 * An item that has fallen to or below its reorder level, with what it would take to restock it.
 *
 * The stock summary already flags "reorder"; a flag is not an action. What turns it into one is
 * how much to buy, who was bought from last, and at what price — the three things someone would
 * otherwise open three screens to find before picking up the phone.
 */
export interface PurchaseSuggestionRow {
  stockItemId: number
  name: string
  unitSymbol: string
  decimals: number
  closingQtyMilli: number
  reorderLevelMilli: number
  /** Quantity needed to reach the reorder level. Always positive — rows at or above it are not here. */
  shortfallQtyMilli: number
  /** The supplier of the most recent purchase of this item, if any. */
  lastSupplier: string | null
  lastSupplierLedgerId: number | null
  lastPurchaseDate: string | null
  /** Paise per whole unit on that last purchase. */
  lastRatePaise: number | null
  /** shortfall × last rate, in paise. Null when nothing was ever bought. */
  estimatedCost: number | null
}

/**
 * One month of payroll, as a trend point.
 *
 * Payroll is usually the largest single expense a small business has and the one it looks at
 * least: the run is committed, the payslips go out, and nobody asks what it did over the year.
 * Headcount beside cost is what makes the question answerable — a cost that rose because two
 * people joined is a different fact from the same cost on the same headcount.
 */
export interface PayrollTrendPoint {
  /** 'YYYY-MM'. */
  month: string
  label: string
  /** People paid in this run. */
  headcount: number
  gross: number
  /** What the employer actually parted with: gross plus its own PF/ESI contributions. */
  employerCost: number
  net: number
  /** Statutory deductions withheld from employees, and the employer's own share. */
  employeeDeductions: number
  employerContributions: number
  /** employerCost / headcount, or 0 when nobody was paid. */
  costPerHead: number
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
  key:
    | 'negativeStock'
    | 'negativeCash'
    | 'missingNarration'
    | 'singleLedger'
    | 'outsidePeriod'
    | 'unbalanced'
    | 'missingGst'
    /** Purchases whose section 16(4) credit window has shut or is about to. */
    | 'itcAtRisk'
    /** Gaps in an auto-numbered voucher series — a missing invoice number an auditor will ask about. */
    | 'numberGaps'
    /** Buyers past the section 206C(1H) receipts threshold, where TCS may be collectible. */
    | 'tcsThreshold'
    /** Vouchers above the amount the user asked to be told about. */
    | 'largeVouchers'
    /** Two or more parties paid into one bank account — a data error, or the fraud the
     *  two-person rule on bank details guards against. */
    | 'sharedBankAccount'
  label: string
  count: number
  /** Detail rows, capped at 200 per section (count is the true total). */
  rows: ExceptionRow[]
}

export interface ExceptionsReport {
  sections: ExceptionSection[]
}

/** One party's contribution to a period's sales or purchases. */
export interface PartyShareRow {
  ledgerId: number
  name: string
  /** Invoice value in paise, net of credit/debit notes on the same party. */
  amount: number
  /** Number of documents behind the figure. */
  documents: number
  /** Share of the period's total, 0–1. */
  share: number
  /** Running share including every party above this one — the "top N account for X%" reading. */
  cumulativeShare: number
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
  /** One twelve-month trend per Gateway tile, keyed by the tile it belongs to. */
  tileSparks: TileSpark[]
}

export type TileSparkKey = 'cash' | 'bank' | 'receivables' | 'payables' | 'sales' | 'gst'

export interface TileSpark {
  key: TileSparkKey
  /** Twelve points, oldest first, ending in the current month. `month` is `YYYY-MM`. */
  points: { month: string; value: number }[]
}

/** A ratio panel with the figures it was computed from, so the screen can show its workings —
 *  a ratio nobody can check is a ratio nobody should act on. */
export interface RatioReport {
  asOn: string
  from: string
  ratios: RatioPanel
  inputs: {
    currentAssets: number
    currentLiabilities: number
    stock: number
    receivables: number
    payables: number
    borrowings: number
    equity: number
    sales: number
    purchases: number
    grossProfit: number
    netProfit: number
    periodDays: number
  }
}

/** Item-wise gross margin, one block per sub-period (v0.3 C72). */
export interface ItemProfitPeriod {
  /** periodKey from @shared/period, e.g. '2026-04' or '2026-Q1'. */
  key: string
  label: string
  from: string
  to: string
  rows: ItemProfitRow[]
  salesValue: number
  cogs: number
  profit: number
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

export interface RegisterPeriodRow {
  /** Opaque bucket key from `periodKey`. */
  period: string
  /** Ready-to-render column header. */
  label: string
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
  /** Party contact, carried through so a reminder can be sent without a second query. */
  phone: string | null
  email: string | null
  /** How many open bills this party has, always present even when `bills` was withheld. */
  billCount: number
  /** Empty when the caller asked for a summary; fetch with `analysis:openBills`. */
  bills: OutstandingBill[]
  /** Bill-reference problems surfaced by the allocator (v0.3 #66), e.g. an 'against' ref
   *  naming a bill that isn't open. */
  warnings?: string[]
}

/**
 * One party as the owner thinks of them: the khata page.
 *
 * "Who owes me, how much, how long, and can they take more" is the question a small business asks
 * every day, and answering it meant three screens. This is that one page — built from the same
 * FIFO allocation the outstandings report uses, so the two can never disagree.
 */
export interface KhataParty {
  ledgerId: number
  name: string
  side: 'receivable' | 'payable'
  /** Balance in the books, positive = they owe us (or we owe them, on the payable side). */
  balance: number
  /** Unsettled bill total from the allocator. Differs from `balance` when payments are
   *  unallocated, which is itself worth seeing. */
  pending: number
  billCount: number
  /** Age of the oldest open bill, in days; 0 when nothing is open. */
  oldestBillDays: number
  /** Days past due on the most overdue bill; 0 when nothing is overdue. */
  worstOverdueDays: number
  /** Ageing buckets from the allocator: 0-30, 31-60, 61-90, 90+. */
  buckets: [number, number, number, number]
  creditLimit: number | null
  /** Fraction of the limit used, or null when there is no limit. Can exceed 1. */
  creditUsed: number | null
  /** Date of the most recent receipt/payment against this party, or null if never. */
  lastPaymentDate: string | null
  phone: string | null
  email: string | null
}

/**
 * Where each bank account stands on reconciliation, on one line.
 *
 * The reconciliation screen answers this one account at a time and only after you pick one. A
 * business with four accounts has no way to see that three are current and one has not been
 * touched since June — which is exactly the account with the problem in it.
 */
export interface ReconciliationStatus {
  ledgerId: number
  name: string
  /** Balance in the books as on the date asked for. */
  bookBalance: number
  /** What the bank statement should read, if every unreconciled entry is genuinely outstanding. */
  bankBalance: number
  /** Lines in the account up to the date, and how many carry a bank date. */
  totalLines: number
  reconciledLines: number
  /** Value still unreconciled, split by direction. */
  unreconciledDeposits: number
  unreconciledWithdrawals: number
  /** Unreconciled line COUNTS by age of the entry: 0-30, 31-60, 61-90, 90+ days. */
  ageing: [number, number, number, number]
  /** The most recent bank date recorded against this account, or null if none ever was. */
  lastReconciledDate: string | null
  /** Age in days of the oldest unreconciled entry; 0 when everything is clear. */
  oldestUnreconciledDays: number
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
