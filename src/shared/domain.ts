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
  /** Deductee's Income Tax PAN (drives the no-PAN TDS rate and, when deducteeType is unset,
   *  the deductee type via its fourth character). */
  pan: string | null
  /** Deductee class for TDS rates (individual/HUF vs company vs firm vs other); null = derive
   *  from the PAN (see deducteeTypeFromPan). */
  deducteeType: 'individual_huf' | 'company' | 'firm' | 'other' | null
  /** Tags this ledger as the TDS payable ledger for a section — the TDS mirror of `taxType`.
   *  Reports and save-time validation find TDS payable lines by this tag, never by name. */
  tdsPayableSectionId: number | null
  /** Expense ledgers: the TDS section a debit to this ledger usually attracts (e.g. Rent →
   *  194-I). Used for the suggestion when the party itself has no section. */
  tdsDefaultSectionId: number | null
  /** TCS (WP 3.3): section this buyer is flagged for collection under (the collectee). */
  tcsSectionId?: number | null
  /** Tags this ledger as a TCS section's payable ledger (the TCS mirror of tdsPayableSectionId). */
  tcsPayableSectionId?: number | null
  /** Sales ledgers: the TCS section a sale credited here attracts (e.g. "Scrap Sales" → 206C(1)). */
  tcsDefaultSectionId?: number | null
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
  isSystem: boolean
}

export interface TdsSection {
  id: number
  /** e.g. "194C" */
  code: string
  description: string
  /** Legacy (pre-migration-020) single rate, percent — mirrors the latest 'any'/'other' row of
   *  the effective-dated rate table so older screens keep reading something sensible. The rate
   *  actually applied comes from `tds_section_rates` (listRates / tdsSuggestion). */
  rate: number
  /** Paise; 0 = no single-transaction threshold. Legacy mirror, see `rate`. */
  thresholdSingle: number
  /** Paise; 0 = no FY-cumulative threshold. Legacy mirror, see `rate`. */
  thresholdAnnual: number
  /** Payment nature in plain words (e.g. "Payment to contractors / sub-contractors"). */
  nature: string | null
  /** Act the `code` is written under. */
  act: 'it_act_1961' | 'it_act_2025'
  /** Income-tax Act, 1961 section (e.g. "194C"); null for a section with no 1961 equivalent. */
  legacyCode: string | null
  /** Income-tax Act, 2025 reference (e.g. "393(1) Table Sl. 6(i)"); null when not mapped. */
  newReference: string | null
  /** 'tds' (deducted by us as payer) or 'tcs' (collected by us as seller, WP 3.3 — migration 027
   *  shares the section master). Absent on pre-3.3 fixtures = 'tds'. */
  kind?: 'tds' | 'tcs'
}

export interface TdsRate {
  id: number
  sectionId: number
  effectiveFrom: string
  effectiveTo: string | null
  deducteeType: 'individual_huf' | 'company' | 'firm' | 'other' | 'any'
  /** Basis points (100 = 1%). */
  rateBp: number
  thresholdSinglePaise: number
  thresholdAnnualPaise: number
  thresholdBasis: 'fy' | 'month'
  /** The rate applies only to the part of the aggregate above the threshold (194Q). */
  thresholdExcessOnly: boolean
  /** 26Q section code / Form 140 payment code for this period; null = none recorded. */
  returnCode: string | null
  noPanRateBp: number
  /** TCS rows: the base includes the GST charged (migration 027). Absent = false. */
  baseIncludesGst?: boolean
  /** Citation for a seeded row; null for rows the user added. */
  source: string | null
}

export interface TdsCertificateRow {
  id: number
  ledgerId: number
  sectionId: number | null
  certificateNo: string
  rateBp: number
  validFrom: string
  validTo: string
  capPaise: number | null
}

export interface TdsChallan {
  id: number
  date: string
  bsrCode: string
  challanNo: string
  amountPaise: number
  /** Payment voucher that paid the challan (Dr TDS Payable / Cr Bank), if linked. */
  paymentVoucherId: number | null
  quarter: 1 | 2 | 3 | 4
  fyStartYear: number
  /** Sum of TDS on the entries allocated to this challan. */
  allocatedPaise: number
  entryCount: number
  /** 'tcs' for a TCS deposit (migration 027); absent on pre-3.3 fixtures = 'tds'. */
  kind?: 'tds' | 'tcs'
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

/** Every voucher kind — mirrors the `voucher_kinds` lookup table (migration 024; a dbtest pins
 *  the two equal). Adding a kind = append here + one INSERT INTO voucher_kinds migration. */
export const VOUCHER_KINDS = [
  'contra',
  'payment',
  'receipt',
  'journal',
  'sales',
  'purchase',
  'credit_note',
  'debit_note',
  'stock_journal',
  'physical_stock',
  /** Delivery challan (WP 2.5): goods out, no ledger lines. */
  'delivery_note',
  /** Goods receipt note (WP 2.5): goods in, no ledger lines. */
  'receipt_note'
] as const

export type VoucherKind = (typeof VOUCHER_KINDS)[number]

/** Kinds that move stock only and post no ledger lines (voucher_kinds.stock_only = 1). */
export const STOCK_ONLY_KINDS: readonly VoucherKind[] = ['stock_journal', 'physical_stock', 'delivery_note', 'receipt_note']

/** The trade-cycle stock notes (WP 2.5): a party, inventory lines in one direction, no ledger lines. */
export const STOCK_NOTE_KINDS: readonly VoucherKind[] = ['delivery_note', 'receipt_note']

/** Why goods moved on a delivery challan / GRN (trade_voucher_details.purpose, migration 025). */
export const TRADE_PURPOSES = ['supply', 'job_work', 'approval', 'liquid_gas', 'non_supply', 'purchase', 'return'] as const
export type TradePurpose = (typeof TRADE_PURPOSES)[number]

/** Order / quotation kinds (trade_doc_types.kind) — non-posting documents (WP 2.5c screens). */
export const TRADE_DOC_KINDS = ['quotation', 'sales_order', 'purchase_order'] as const
export type TradeDocKind = (typeof TRADE_DOC_KINDS)[number]

export type LinkType = 'fulfil' | 'return'

/** Where an inventory line came from (WP 2.5 line_links): the source line's stable uid. */
export interface LineSource {
  lineUid: string
  linkType: LinkType
}

/** A numbering series for orders / quotations — same knobs as VoucherType. */
export interface TradeDocType {
  id: number
  name: string
  kind: TradeDocKind
  numbering: 'auto' | 'manual'
  prefix: string
  suffix: string
  padWidth: number
  restartFy: boolean
  isSystem: boolean
}

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
  /** The user typed the deduction instead of taking the rate table's figure: saveVoucher then
   *  only checks that a TDS payable credit exists, not that amount = rate × base. Absent = false. */
  isManual?: boolean
  // ---- basis recorded at save (read-only; never part of voucher input) ----
  /** Effective rate the deduction was checked against, basis points; null = manual/legacy. */
  rateBp?: number | null
  deducteeType?: string | null
  certificateId?: number | null
  /** Id of the stored tds_entries row (stable across edits — challan allocations key on it). */
  entryId?: number
}

/** TCS collected on this voucher (WP 3.3) — stored in tds_entries under a TCS section. Same
 *  shape as VoucherTds with the amount named for what it is. */
export interface VoucherTcs {
  sectionId: number
  baseAmount: number
  tcsAmount: number
  isManual?: boolean
  rateBp?: number | null
  /** Collectee type recorded at save. */
  deducteeType?: string | null
  certificateId?: number | null
  /** The base included the GST charged (recorded at save from the rate row in force). */
  gstInBase?: boolean | null
  entryId?: number
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
  /** Serial numbers this line moves (serial-tracked items, WP 2.3); getVoucher always sets it
   *  ([] when none). Optional only so older hand-built fixtures keep compiling. */
  serials?: string[]
  /** Stable line identity (migration 024) — survives edits; trade links key on it. getVoucher
   *  always sets it. Optional only so older hand-built fixtures keep compiling. */
  lineUid?: string
  /** false = the goods moved on the linked challan / GRN line (server-derived, WP 2.5). */
  movesStock?: boolean
  /** The line this one fulfils / returns (null = none). */
  source?: LineSource | null
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
  /** Year-end closing journal posted by the year-end close (migration 018). Immutable: the server
   *  refuses edits; binning it reopens the year. Never settable from voucher input. */
  isYearEndClose: boolean
  /** Set once the voucher is moved to the bin (soft delete); null while active. */
  deletedAt: string | null
  lines: VoucherLine[]
  inventory: InventoryLine[]
  /** Bill-by-bill references against the party ledger line. */
  billRefs: VoucherBillRef[]
  /** TDS deducted on this voucher, if any. */
  tds: VoucherTds | null
  /** TCS collected on this voucher, if any (WP 3.3). getVoucher always sets it; optional only so
   *  hand-built fixtures keep compiling. */
  tcs?: VoucherTcs | null,
  /** Delivery challan / GRN facts (trade_voucher_details, WP 2.5); null for every other kind.
   *  Optional only so older hand-built fixtures keep compiling. */
  trade?: { purpose: TradePurpose } | null
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
  /** Every movement names one serial number per unit (WP 2.3, src/shared/serials.ts). */
  trackSerials: boolean
  /** TCS (WP 3.3): goods category — selling this item attracts TCS under this section (scrap,
   *  timber, minerals, a motor vehicle …). null / absent = none. */
  tcsSectionId?: number | null
}

export interface Godown {
  id: number
  name: string
  address: string | null
  /** WP 2.4: 'job_worker' = a third party's premises holding our material for job work. */
  kind: 'own' | 'job_worker'
  /** The job worker's party ledger (required for kind 'job_worker'; null for own godowns). */
  partyLedgerId: number | null
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
  /** WP 2.5c (§9 Q9, Orders & challans on): the party's open sales-order value with GST — a
   *  separate, warn-only figure (outstandings stay invoice-based). Absent when the flag is off. */
  openSalesOrders?: number
  /** True when only outstanding + open orders passes the limit (the outstanding alone doesn't):
   *  a warning that never blocks, even under enforceCreditLimit. */
  ordersOnly?: boolean
}

/** Non-blocking issues detected while saving a voucher. Additive: the saved Voucher rides
 *  alongside (see SaveVoucherResult in src/main/services/vouchers.ts). */
export interface SaveVoucherWarnings {
  negativeStock: NegativeStockWarning[]
  creditLimitExceeded: CreditLimitWarning | null
  /** WP 2.5 I7: linked lines whose source document is dated after this voucher. */
  linkDates?: string[]
  /** WP 2.5 §3.4: GRN lines this bill draws on that sit in a locked period / closed year — the
   *  price difference is not loaded into stock (the link is frozen, reprices = 0). */
  frozenRepricing?: string[]
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
  /** Professional-tax state code (PT_SLABS key in src/shared/payroll.ts), e.g. 'MH'. */
  ptState: string
  active: boolean
  /** WP 3.7 statutory profile (migration 029). */
  /** EPF member id (establishment code + member number), as on the ECR / pay slip. */
  pfNumber: string | null
  gender: 'male' | 'female' | 'other' | null
  dob: string | null
  /** Income-tax regime the employee opted for this year (new = default regime). */
  taxRegime: 'new' | 'old'
  /** Voluntary PF over the 12%, basis points of PF wages. */
  vpfRateBp: number
  /** EPF on actual basic above the ₹15,000 ceiling (joint option, EPF Scheme para 26A(2)). */
  pfOnFullWage: boolean
  /** EPS member (false: joined on/after 1-9-2014 above the ceiling, or 58+). */
  epsEligible: boolean
  /** Person with disability — ESI ceiling ₹25,000. */
  disabled: boolean
  /** Rents in a metro city (HRA exemption 50% vs 40%). */
  metro: boolean
  /** Deduct salary TDS in pay runs. */
  tdsEnabled: boolean
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
  /** WP 3.7 (0 / false / null on lines posted before migration 029). */
  vpf: number
  epfWage: number
  epsWage: number
  edliWage: number
  esiCovered: boolean
  esiWage: number
  /** Salary TDS deducted this month. */
  tds: number
  /** The year's projection the TDS came from (null when TDS is off / pre-029). */
  tdsWorkings: SalaryWorkingsSnapshot | null
}

/** The TDS projection behind one month's deduction (mirrors payrollStatutory.SalaryWorkings plus
 *  the spread inputs). */
export interface SalaryWorkingsSnapshot {
  regime: 'new' | 'old'
  act: '1961' | '2025'
  gross: number
  hraExemption: number
  standardDeduction: number
  professionalTax: number
  otherIncome: number
  housePropertyLoss: number
  deductionsTotal: number
  totalIncome: number
  annualTax: number
  previousEmployerTds: number
  deductedBefore: number
  monthsRemaining: number
}

export interface PayrollRun {
  id: number
  month: string
  voucherId: number | null
  createdAt: string
  /** EPFO minimum admin-charge top-up posted on the run (0 when the 0.5% already exceeds it). */
  pfAdminTopUp: number
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
