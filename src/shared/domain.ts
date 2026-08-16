/** Core domain types shared by main (SQL) and renderer (UI). */

export type Nature = 'asset' | 'liability' | 'income' | 'expense'
export type DrCr = 'dr' | 'cr'

export interface Group {
  id: number
  name: string
  parentId: number | null
  nature: Nature
  /** True for trading-account groups (Sales, Purchase, Direct Inc/Exp, Stock) — used by P&L gross profit. */
  affectsGrossProfit: boolean
  isSystem: boolean
}

export type TaxType = 'cgst' | 'sgst' | 'igst' | 'cess'

export interface Ledger {
  id: number
  name: string
  groupId: number
  /** Signed paise: positive = debit opening balance, negative = credit. */
  openingBalance: number
  // Party details (Sundry Debtors / Creditors)
  gstin: string | null
  /** Two-digit GST state code, e.g. "27". */
  stateCode: string | null
  address: string | null
  /** For ledgers under Duties & Taxes: which GST component this ledger collects. */
  taxType: TaxType | null
  /** Default GST rate percent for sales/purchase ledgers (overridden by stock item rate). */
  gstRate: number | null
  /** HSN/SAC for service ledgers billed without stock items. */
  hsn: string | null
  /** Section this party is flagged for TDS deduction under, if any. */
  tdsSectionId: number | null
  /** Deductee's Income Tax PAN (drives the no-PAN 20% TDS rate). */
  pan: string | null
  /** Default bill-to-bill credit period in days, used when a bill has no explicit due date. */
  creditDays: number | null
  /** SEZ/export classification for GST e-invoicing (task 2.8); null for a normal domestic party. */
  exportType: 'sez_wp' | 'sez_wop' | 'exp_wp' | 'exp_wop' | null
  isSystem: boolean
}

export interface TdsSection {
  id: number
  /** e.g. "194C" */
  code: string
  description: string
  /** Percent. */
  rate: number
  /** Paise; 0 = no single-transaction threshold. */
  thresholdSingle: number
  /** Paise; 0 = no FY-cumulative threshold. */
  thresholdAnnual: number
}

export interface CostCentre {
  id: number
  name: string
  parentId: number | null
  active: boolean
}

/** One line of a Budget (task 2.6): a target amount for either a single ledger or a whole group
 *  (rolled up over its descendants at report time), for one month or the whole financial year. */
export interface BudgetLine {
  id: number
  ledgerId: number | null
  groupId: number | null
  /** 'YYYY-MM' within the budget's FY, or null for an annual figure. */
  month: string | null
  /** Paise. */
  amount: number
}

/** A named budget scoped to one financial year, with its lines. */
export interface Budget {
  id: number
  name: string
  fyStartYear: number
  lines: BudgetLine[]
}

/** A saved voucher shape (exact VoucherInputParsed JSON) that recurring:post re-validates and
 *  re-posts on a monthly/weekly cadence (task 2.3). */
export interface RecurringTemplate {
  id: number
  name: string
  voucherJson: string
  cadence: 'monthly' | 'weekly'
  dayOfMonth: number | null
  weekday: number | null
  nextDue: string
  lastPosted: string | null
  active: boolean
  /** The stored voucher's type kind (joined off voucher_types via the denormalized
   *  voucher_type_id column) — null only if that voucher type has since been deleted. Drives
   *  which entry form "Open in voucher entry" opens (kindHint). */
  voucherKind: VoucherKind | null
}

export type VoucherKind =
  | 'contra'
  | 'payment'
  | 'receipt'
  | 'journal'
  | 'sales'
  | 'purchase'
  | 'credit_note'
  | 'debit_note'
  | 'stock_journal'
  | 'physical_stock'

export interface VoucherType {
  id: number
  name: string
  kind: VoucherKind
  /** 'auto' = numbered per FY from 1; 'manual' = user types the number. */
  numbering: 'auto' | 'manual'
  prefix: string
  /** Appended after the (optionally zero-padded) sequence, e.g. '/24-25' → INV-1/24-25. */
  suffix: string
  /** Zero-pad width for the numeric sequence; 0 = no padding (1, 2, 3…; padWidth 3 → 001, 002…). */
  padWidth: number
  /** true (default) = sequence restarts at 1 each financial year; false = one running sequence
   *  across FYs (e.g. Tally's "Prevent duplicates" numbering that never resets). */
  restartFy: boolean
  isSystem: boolean
}

export interface VoucherLineCostAllocation {
  costCentreId: number
  amount: number
}

export interface VoucherLine {
  id: number
  ledgerId: number
  drCr: DrCr
  /** Paise, always > 0. */
  amount: number
  /** Bank statement date once reconciled (bank ledger lines only). */
  bankDate: string | null
  /** Optional split of this line's amount across cost centres. */
  costAllocations: VoucherLineCostAllocation[]
}

export interface VoucherBillRef {
  kind: 'new' | 'against'
  name: string
  amount: number
  dueDate: string | null
}

export interface VoucherTds {
  sectionId: number
  baseAmount: number
  tdsAmount: number
}

export interface InventoryLine {
  id: number
  stockItemId: number
  godownId: number | null
  /** Quantity in base-unit thousandths (qty × 1000) to avoid float drift. */
  qtyMilli: number
  /** Paise per whole unit. */
  ratePaise: number
  /** Paise. */
  amount: number
  direction: 'in' | 'out'
}

export interface Voucher {
  id: number
  voucherTypeId: number
  date: string
  number: string
  /** Party (debtor/creditor) for trading vouchers; drives GST B2B attribution. */
  partyLedgerId: number | null
  narration: string | null
  reference: string | null
  /** Cheque/UTR number for payments and receipts. */
  instrumentNo: string | null
  instrumentDate: string | null
  /** Dispatch details for e-way bills (sales vouchers). */
  transporterId: string | null
  vehicleNo: string | null
  transportDistanceKm: number | null
  /** Foreign-currency invoice: ISO code + base-currency (INR) per unit rate. */
  currencyCode: string | null
  exchangeRate: number | null
  /** Live-filing results, once generated on the portal. */
  irn: string | null
  irnAckNo: string | null
  irnAckDate: string | null
  ewbNo: string | null
  ewbValidUpto: string | null
  /** Set once the voucher is moved to the bin (soft delete); null while active. */
  deletedAt: string | null
  lines: VoucherLine[]
  inventory: InventoryLine[]
  /** Bill-by-bill references against the party ledger line. */
  billRefs: VoucherBillRef[]
  /** TDS deducted on this voucher, if any. */
  tds: VoucherTds | null
  createdAt: string
  updatedAt: string
}

export interface StockGroup {
  id: number
  name: string
  parentId: number | null
}

export interface Unit {
  id: number
  name: string
  symbol: string
  /** Decimal places allowed when entering quantities (0-3). */
  decimals: number
  /** GST portal UQC code, e.g. "NOS", "KGS". */
  uqc: string
}

export interface StockItem {
  id: number
  name: string
  groupId: number | null
  unitId: number
  hsn: string | null
  gstRate: number | null
  cessRate: number | null
  openingQtyMilli: number
  openingValue: number
  /** Scannable barcode/SKU (unique when set). */
  barcode: string | null
}

export interface Godown {
  id: number
  name: string
}

export interface CompanyInfo {
  name: string
  /** Two-digit GST state code of the company's registration. */
  stateCode: string
  gstin: string | null
  gstRegistrationType: 'regular' | 'composition' | 'unregistered'
  address: string
  /** FY start year of the earliest books, e.g. 2025. */
  booksFrom: number
  email: string | null
  phone: string | null
  /** Company's Income Tax PAN, e.g. "ABCDE1234F". */
  pan: string | null
  /** Company's TAN (for TDS filings), e.g. "ABCD12345E". */
  tan: string | null
}

export interface CompanySummary {
  slug: string
  name: string
  stateCode: string
  gstin: string | null
  lastOpenedAt: string | null
}

export interface Currency {
  id: number
  code: string
  symbol: string
  name: string
  decimals: number
}

export interface Employee {
  id: number
  name: string
  code: string | null
  designation: string | null
  joined: string | null
  pan: string | null
  uan: string | null
  esicNo: string | null
  /** Monthly amounts in paise. */
  basic: number
  hra: number
  special: number
  pfEnabled: boolean
  esiEnabled: boolean
  ptEnabled: boolean
  active: boolean
}

export interface PayrollLine {
  id: number
  employeeId: number
  employeeName: string
  payableDays: number
  monthDays: number
  basic: number
  hra: number
  special: number
  gross: number
  pfEmp: number
  pfEr: number
  esiEmp: number
  esiEr: number
  pt: number
  net: number
}

export interface PayrollRun {
  id: number
  month: string
  voucherId: number | null
  createdAt: string
  lines: PayrollLine[]
}

export interface BomLine {
  id: number
  componentId: number
  componentName: string
  unitSymbol: string
  /** Component quantity (thousandths) needed per ONE unit of the parent item. */
  qtyMilliPerUnit: number
}

export interface AuditEntry {
  id: number
  entity: 'voucher' | 'ledger' | 'stock_item'
  entityId: number
  action: 'create' | 'update' | 'delete'
  at: string
  before: string | null
  after: string | null
}
