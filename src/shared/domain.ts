/** Core domain types shared by main (SQL) and renderer (UI). */

import type { TurnoverBand } from './gst/turnover'

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
  /** Reverse charge applies to supplies from/to this party (GSTR-1 rchrg, GSTR-3B 3.1(d)). */
  rcm: boolean
  /** ITC eligibility class for purchases booked against this party — 'blocked' feeds 3B 4(D). */
  itcEligibility: 'eligible' | 'blocked' | 'capital_goods' | 'input_services'
  /** Price level whose rates prefill this party's invoice lines; null = item base rate. */
  priceLevelId: number | null
  /** Credit limit in paise; null = no limit. saveVoucher warns (or blocks, under F11
   *  enforceCreditLimit) when the party's outstanding would exceed it. */
  creditLimit: number | null
  /** Party contact. `phone` drives the WhatsApp reminder; both are optional everywhere. */
  phone: string | null
  email: string | null
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
  /** Batch this quantity moves in/out of (F11 `batches`); null = untracked. */
  batchId: number | null
  /** Quantity in base-unit thousandths (qty × 1000) to avoid float drift. */
  qtyMilli: number
  /** Paise per whole unit. */
  ratePaise: number
  /** Per-line trade discount in paise (display + gross computation only): gross = qty × rate,
   *  `amount` = gross − discount. GST always derives from `amount`, never from this. */
  discountPaise: number
  /** Paise. */
  amount: number
  direction: 'in' | 'out'
  /** Physical Stock line: qtyMilli is the counted closing quantity, not a movement. */
  isAbsolute: boolean
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
  /** Place-of-supply override (two-digit state code); null = derive from party/company state. */
  posOverride: string | null
  /** Foreign-currency invoice: ISO code + base-currency (INR) per unit rate. */
  currencyCode: string | null
  exchangeRate: number | null
  /** Live-filing results, once generated on the portal. */
  irn: string | null
  irnAckNo: string | null
  irnAckDate: string | null
  ewbNo: string | null
  ewbValidUpto: string | null
  /** Post-dated cheque/voucher: excluded from books until it matures (auto-flipped to false
   *  once its date arrives — see maturePostDated). */
  postDated: boolean
  /** Optional (memorandum) voucher: never counts toward the books. */
  isOptional: boolean
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

/** Per-voucher transport + ship-to details (voucher_transport row) for e-way bills /
 *  e-invoices. All fields nullable — the row exists only once the user opens the
 *  Transport details modal (or an importer writes it). */
export interface VoucherTransport {
  voucherId: number
  /** NIC mode: '1' road, '2' rail, '3' air, '4' ship. */
  transMode: string | null
  transDistanceKm: number | null
  transporterId: string | null
  transporterName: string | null
  /** Transport doc (LR/RR/airway bill) — doubles as the shipping bill for exports. */
  transDocNo: string | null
  transDocDate: string | null
  vehicleNo: string | null
  /** 'R' regular / 'O' over-dimensional cargo. */
  vehicleType: string | null
  shipToName: string | null
  shipToGstin: string | null
  shipToAddr1: string | null
  shipToAddr2: string | null
  shipToPlace: string | null
  shipToPincode: string | null
  shipToState: string | null
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
  /** Reorder level in integer thousandths; null = no reorder alert (v0.3 #58). */
  reorderLevelMilli: number | null
  /** How this item's stock is valued (src/shared/valuation.ts). */
  valuationMethod: 'weighted_avg' | 'fifo'
}

export interface Godown {
  id: number
  name: string
  address: string | null
}

/** A batch/lot of a stock item (F11 `batches`), created on the fly from voucher entry. */
export interface Batch {
  id: number
  stockItemId: number
  name: string
  mfgDate: string | null
  expiryDate: string | null
}

/** A named price list (e.g. Retail / Wholesale) assignable to party ledgers. */
export interface PriceLevel {
  id: number
  name: string
}

/** A date-effective per-item rate under a price level. `rate` is paise per whole unit. */
export interface PriceListRate {
  id: number
  priceLevelId: number
  stockItemId: number
  rate: number
  effectiveFrom: string
}

// ---------- saveVoucher warnings (lane I: negative stock + credit limit) ----------

export interface NegativeStockWarning {
  stockItemId: number
  name: string
  unitSymbol: string
  /** Closing quantity (thousandths) as of the voucher date — negative. */
  closingQtyMilli: number
}

export interface CreditLimitWarning {
  ledgerId: number
  ledgerName: string
  /** Paise. */
  creditLimit: number
  /** Party's outstanding (dr-positive, incl. this voucher), paise. */
  outstanding: number
}

/** Non-blocking issues detected while saving a voucher. Additive: the saved Voucher rides
 *  alongside (see SaveVoucherResult in src/main/services/vouchers.ts). */
export interface SaveVoucherWarnings {
  negativeStock: NegativeStockWarning[]
  creditLimitExceeded: CreditLimitWarning | null
}

export interface CompanyInfo {
  name: string
  /** Two-digit GST state code of the company's registration. */
  stateCode: string
  gstin: string | null
  gstRegistrationType: 'regular' | 'composition' | 'unregistered'
  /**
   * How often GST returns are filed.
   *
   * QRMP (Quarterly Return, Monthly Payment) is available to registrations with aggregate
   * turnover up to Rs 5 crore, which is most small businesses. Under it GSTR-1 and GSTR-3B are
   * quarterly, tax is still paid monthly by PMT-06 challan, and an optional IFF lets a filer
   * push B2B invoices to their buyers in the first two months of the quarter.
   *
   * Defaults to monthly so an existing company's calendar does not change under it.
   */
  gstFilingFrequency: 'monthly' | 'quarterly'
  address: string
  /**
   * Declared aggregate annual turnover band, or null if never declared.
   *
   * Declared rather than computed: the statutory figure is aggregate turnover across every GSTIN
   * on the same PAN, including exempt supplies and the part of the year before these books
   * begin. Nearly every GST threshold keys off it -- e-invoicing, QRMP, HSN digit count,
   * composition ceilings. See src/shared/gst/turnover.ts.
   */
  turnoverBand: TurnoverBand | null
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
  /** Professional-tax state code (PT_SLABS key in src/shared/payroll.ts), e.g. 'MH'. */
  ptState: string
  active: boolean
}

/** One computed pay-head amount on a payroll line (mirrors PayHeadAmount in src/shared/payroll.ts). */
export interface PayrollHeadAmount {
  name: string
  kind: 'earning' | 'deduction'
  amount: number
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
  /** Custom earning heads beyond Basic/HRA/Special (prorated paise). */
  otherEarnings: number
  /** Custom deduction heads (subtracted from net). */
  otherDeductions: number
  gross: number
  pfEmp: number
  pfEr: number
  /** Employer 12% split (epsEr + the EPF remainder = pfEr) + EPFO admin/EDLI charges. */
  epsEr: number
  pfAdmin: number
  edli: number
  esiEmp: number
  esiEr: number
  pt: number
  net: number
  /** Per-head prorated amounts (empty for pre-pay-heads runs). */
  headAmounts: PayrollHeadAmount[]
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
