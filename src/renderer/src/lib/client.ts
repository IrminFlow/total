import type {
  Batch, BomLine, Budget, CompanyInfo, CostCentre, Currency, Employee, Godown, Group, Ledger, NegativeStockWarning,
  PayrollLine, PayrollRun, PriceLevel, PriceListRate, StockGroup, StockItem, TdsSection, Unit,
  TdsRate, TdsCertificateRow, TdsChallan,
  Voucher, VoucherTransport, VoucherType, TradeDocType, SaveVoucherWarnings
} from '@shared/domain'
import type { BudgetVarianceRow } from '@shared/budgets'
import type {
  TdsEligibleRow, TdsDeductedRow, TdsLedgerSummaryRow, TdsPaymentCandidate, TdsChallanRow, TdsChallanEntryInterest,
  Form26qData, Form16aData
} from '@shared/tdsTypes'
import type {
  BalanceSheet, BankRecon, DashboardData, DayBookRow, EdocListRow, ExceptionsReport, GroupTreeNode,
  ItemProfitRow, LedgerBalanceRow,
  LedgerStatement, OutstandingBill, OutstandingParty, ProfitAndLoss, RegisterMonthRow, StockAgeingRow,
  StockSummaryRow, TrialBalance,
  VoucherListRow
} from '@shared/reports'
import type { CashFlowStatement } from '@shared/reportMath'
import type { DashboardSeries } from '@shared/dashboard'
import type { MsmeYearEndWarning } from '@shared/payables/types'
import type { Gstr1Result, Gstr3bResult } from '@shared/gst/returns'
import type { GstIssue } from '@shared/gst/validate'
import type { Recon2bResult, Recon2bTolerances } from '@shared/gst/recon2b'
import type { ImsActionRecord } from '@shared/gst/ims'
import type { Gstr3bView, Gstr9View, Itc04View, ItcReversalView } from '@shared/gst/views'
import type { Itc04PeriodKind, Itc04Periodicity } from '@shared/gst/itc04'
import type { SelfInvoiceRow } from '@shared/gst/selfInvoice'
import type { ImsDecisionInput, ItcReversalInputs, SelfInvoiceSeries } from '@shared/gst/expansionSchemas'

/** gst:imsSet decision (schema defaults optional on the way in). */
export type ImsDecisionPayload = Omit<ImsDecisionInput, 'note' | 'voucherId' | 'value' | 'taxable' | 'igst' | 'cgst' | 'sgst' | 'cess'> &
  Partial<Pick<ImsDecisionInput, 'note' | 'voucherId' | 'value' | 'taxable' | 'igst' | 'cgst' | 'sgst' | 'cess'>>
import type {
  AgentExportInput,
  AuditExportInput, AuditListInput, BankRuleInput, BatchInput, BomInput, BudgetInput, ChequeConfig, CompanyCreateInput, CostCentreInput,
  CurrencyInput, EmployeeHeadsSetInput, EmployeeInputPayload, GodownInput, GroupInput, Gst3bManualInput, LedgerInput, NicCredentials,
  PayHeadInput, PriceLevelInput,
  PriceRateInput,
  RendererLogInput, SearchQueryInput, StockGroupInput, StockItemInput, TdsSectionInput, UnitInput, UserInput, VoucherTransportInput, VoucherTypeInput, TradeDocTypeInput, OpenSourceLinesQuery,
  TradeDocInputParsed, TradeDocListQuery,
  TdsRateInput, TdsCertificateInput, TdsChallanInput,
  VoucherInputParsed
} from '@shared/schemas'
import type { CompanyFeatures } from '@shared/features'
import type { StockCostPosition, ConsumptionCosting, ProposedOutward } from '@shared/valuation'
import type { ManufactureDetails, ManufactureInput } from '@shared/manufacture'
import type { BomVersion, ExplosionResult } from '@shared/bom'
import type { CostSheet, MarginRow, ProductionRegisterRow, VarianceReportRow } from '@shared/manufactureReports'
import type { Itc04Data, JobWorkChallan, JobWorkPendingRow } from '@shared/jobWork'
import type { JobWorkChallanPayload } from '@shared/voucherEdit'
import type { ExpiryReportRow, ReorderRow, SerialListRow, StockMovementRegister } from '@shared/stockPlanning'
import type { SerialStatus } from '@shared/serials'
import type {
  OpenSourceLine, PendingNoteRow, PendingOrderRow, QuotationPipeline, TradeDoc, TradeDocDraft, TradeDocListRow, VoucherKindRow, VoucherLinks,
  ItemDemandRow, LeadTimeRow, NoteClosure, OrderBookRow, ReturnRateRow, ReturnRow, ReturnSide, StaleDocRow, TradeChain, UnbilledGoods
} from '@shared/tradeCycle/types'
import type { MatchRow, MatchTolerances } from '@shared/tradeCycle/match'
import type { TradeDocKind } from '@shared/domain'
import type { XlsxSheet } from '@shared/xlsx/writer'

/** stock:labelsHtml / stock:labelsPdf query (mirrors stockLabelsSchema). */
export interface StockLabelsQuery {
  items: { itemId: number; copies: number }[]
  /** Omitted = the first price list; null = print no price. */
  priceLevelId?: number | null
  date: string
}
import type { SearchHit, SearchResponse } from '@shared/search'
import type { ChartGroupNode } from '@shared/chartOfAccounts'
import type { InvoiceConfig } from '@shared/invoiceConfig'
import type { PrintDocKind, PrintTemplate, TemplateList } from '@shared/printTemplates'
import type { CloseLedgerRow } from '@shared/yearEnd'
import type { DepreciationYearStatus } from '@shared/fixedAssets'
import type { ConsolidatedResult } from '@shared/consolidate'
import type { Registry } from '../types'
import type { ChainVerification } from '@shared/auditChain'
import type { AuditAction } from '@shared/auditEntities'

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
  action: AuditAction
  /** UTC 'YYYY-MM-DD HH:MM:SS'. */
  at: string
  /** Local ISO with offset (null before migration 031). */
  atIso: string | null
  beforeJson: string | null
  afterJson: string | null
  userName: string | null
  userId: number | null
  appVersion: string | null
  clockSkewNote: string | null
  rowHash: string | null
  /** The record's number / code / name when its JSON carries one. */
  ref: string | null
}

export type { ChainVerification }

export interface AuditSettings {
  keepDays: number | null
  trailRequired: boolean
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

export interface BankSuggestionRow {
  statementRow: BankUnmatchedRow
  suggestion: {
    ruleId: number
    ledgerId: number
    ledgerName: string
    kind: 'payment' | 'receipt'
    voucherDraft: BankVoucherDraft
  } | null
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
}

export interface BrsItem {
  lineId: number
  voucherId: number
  date: string
  voucherType: string
  number: string
  particulars: string
  /** A counter-side ledger of the voucher (its first line) — the drill target for `particulars`. */
  particularsLedgerId: number | null
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
  /** WP 3.7: "wages" under the Code on Social Security s.2(88) (false = excluded, e.g. HRA). */
  inWages: boolean
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

export type {
  TdsEligibleRow, TdsDeductedRow, TdsLedgerSummaryRow, TdsPaymentCandidate, TdsChallanRow, TdsChallanEntryInterest,
  Form26qData, Form26qDeducteeRow, Form26qChallanRow, Form16aData
} from '@shared/tdsTypes'

/** Mirrors src/main/services/tds.ts's TdsSuggestion shape (kept local — that file is main-process only). */
export interface TdsSuggestion {
  sectionId: number
  code: string
  /** Section reference for the voucher date (1961 code before 1 Apr 2026, Act-2025 after). */
  reference: string
  /** Effective rate, percent. */
  rate: number
  rateBp: number
  basis: 'section' | 'no_pan' | 'certificate'
  tdsPaise: number
  /** null until the payable ledger exists — saveVoucher creates it (tds.autoPayable). */
  payableLedgerId: number | null
  payableLedgerName: string
  panAvailable: boolean
  deducteeType: 'individual_huf' | 'company' | 'firm' | 'other' | null
  thresholdCrossed: boolean
  threshold: {
    reason: 'single' | 'aggregate' | 'none' | 'below'
    singlePaise: number
    aggregateLimitPaise: number
    basis: 'fy' | 'month'
    priorPaise: number
  }
  certificate: { id: number; certificateNo: string; rateBp: number; validTo?: string } | null
  sectionFrom: 'party' | 'ledger' | 'chosen' | 'credits'
  /** Base the deduction is computed on (a payment: undeducted bills + advance). Older mains
   *  don't send it — callers fall back to the candidate base. */
  basePaise?: number
  /** Sections the banner offers (party's own, the debited ledger's default, …). */
  candidates?: { sectionId: number; code: string; from: 'party' | 'ledger' | 'credits' }[]
  /** Payments: bills liable and not deducted at credit time, and the advance part. */
  payment?: { undeductedBillsPaise: number; advancePaise: number; deductedAtCredit: boolean } | null
}

/** Mirrors src/main/services/tcs.ts's TcsSuggestion (WP 3.3): the TDS banner's shape — the
 *  amount to collect rides in `tdsPaise` — plus the TCS basis. */
export type TcsSuggestion = Omit<TdsSuggestion, 'sectionFrom' | 'candidates'> & {
  kind: 'tcs'
  sectionFrom: 'party' | 'goods' | 'ledger' | 'chosen' | 'credits'
  candidates: { sectionId: number; code: string; from: 'party' | 'goods' | 'ledger' | 'credits' }[]
  gstInBase: boolean
}

/** tcs:suggest payload (src/shared/schemas.ts tcsSuggestSchema). */
export interface TcsSuggestRequest {
  partyLedgerId: number
  date: string
  voucherKind: 'sales' | 'receipt'
  taxablePaise: number
  gstPaise?: number
  salesLedgerId?: number | null
  items?: { stockItemId: number; amount: number }[]
  excludeVoucherId?: number
  sectionId?: number | null
}

/** Mirrors src/main/services/tds.ts's TdsSummaryRow shape (kept local — that file is main-process only). */
export interface TdsSummaryRow {
  sectionCode: string
  quarter: string
  deductees: number
  base: number
  tds: number
  payableCredited: number
  payableDebited: number
  allocatedToChallan: number
}

/** Mirrors src/main/services/tds.ts's TdsEntryRow shape (kept local — that file is main-process only). */
export interface TdsEntryRow {
  entryId: number
  voucherId: number
  voucherNumber: string
  date: string
  partyLedgerId: number
  partyName: string
  pan: string | null
  sectionId: number
  sectionCode: string
  baseAmount: number
  tdsAmount: number
  rateBp: number | null
  deducteeType: string | null
  isManual: boolean
  challanId: number | null
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
  ledgerId: number
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
  willUpdate: number
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
  /** Sales / purchase orders → trade docs (WP 6.3). */
  orders?: number
  skipped: number
  /** FY start year the import set as the books' first year (null = unchanged). */
  booksFromSet?: number | null
  warnings: string[]
}

// ---------- WP 6.3 import wizard (mirrors src/main/services/dataImport.ts + importFiles.ts) ----------

export interface ImportWizardOptions {
  duplicate: 'skip' | 'update' | 'create'
  createMissing: boolean
  openingDifference: 'block' | 'suspense' | 'leave'
  dateOrder: 'dmy' | 'mdy' | 'ymd'
  /** Numbers use a decimal comma ("1.234,56"). */
  decimalComma: boolean
  bankLedgerId?: number
  applyBooksFrom: boolean
}
export interface ImportRowError { line: number; field?: string; message: string }
export interface ImportTemplateRow {
  id: number; name: string; profileId: string; target: string; headerSignature: string
  mapping: Record<string, string | null>; options: Record<string, unknown>; updatedAt: string; lastUsedAt: string | null
}
export interface ImportSheetSummary {
  name: string
  rowCount: number
  headerRow: number
  headerLine: number
  headers: string[]
  sample: string[][]
  guesses: { profileId: string; score: number; requiredMissing: string[] }[]
  templates: ImportTemplateRow[]
}
export interface ImportLoadResult {
  token: string
  fileName: string
  kind: 'table' | 'books' | 'busyXml'
  manifest: Record<string, string | number> | null
  busy: { groups: number; ledgers: number; units: number; godowns: number; items: number; vouchers: number; warnings: string[] } | null
  sheets: (ImportSheetSummary | { name: string; rowCount: number })[]
}
export interface ImportTableQuery {
  token: string
  sheet: string
  headerRow: number
  profileId: string
  mapping: Record<string, number | null>
  options: Partial<ImportWizardOptions>
}
export interface ImportStepResult {
  target: string; sheet?: string; created: number; updated: number; skipped: number; errors: ImportRowError[]; warnings: string[]
}
export interface ImportRunResult {
  dryRun: boolean
  batchId: number | null
  steps: ImportStepResult[]
  outcomes: { line: number; target: string; label: string; action: 'create' | 'update' | 'skip' | 'error'; message?: string }[]
  outcomesTruncated: number
  openingCheck: { debit: number; credit: number; difference: number; stockOpening: number } | null
  bank?: { statementRows: number; matched: number; alreadyReconciled: number; unmatched: number }
  /** The whole run was refused (openings did not tie under "Stop"). */
  blocked?: string
  booksFromSet: number | null
  warnings: string[]
}
export interface ImportBatchRow {
  id: number; source: string; profileId: string | null; fileName: string | null; status: 'applied' | 'undone' | 'partly_undone'
  createdAt: string; createdBy: string | null; undoneAt: string | null; errorCount: number; created: number; updated: number; summary: unknown
}
export interface ImportUndoResult { binned: number; deleted: number; restored: number; kept: { entity: string; id: number; reason: string }[] }

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

/** Mirrors stockAnalysis.CostAsOfResult (main-process only). */
export interface StockCostAsOf {
  positions: StockCostPosition[]
  consumption: ConsumptionCosting | null
}

/** manufacture:get — a stock journal and its manufacture_details row (null = legacy). */
export interface ManufactureRecord {
  voucher: Voucher
  details: ManufactureDetails | null
}

/** manufacture:costPreview (mirrors services/manufacture.ts CostPreview). */
export interface ManufactureCostPreview {
  lines: { itemId: number; qtyMilli: number; costPaise: number; unitCostPaise: number; onHandQtyMilli: number }[]
  totalPaise: number
  saleRate: { ratePaise: number | null; source: 'sales' | 'priceList' | null }
}

/** manufacture:register (mirrors services/manufacture.ts ManufactureRegisterRow): engine cost
 *  NOW next to the save-time figures (WP 2.4). */
export interface ManufactureRegisterRow {
  voucherId: number
  date: string
  number: string
  finishedItemId: number
  itemName: string
  unitSymbol: string
  decimals: number
  qtyMilli: number
  materialPaise: number
  labourPaise: number
  byProductPaise: number
  /** Cost now (materials + labour − by-products). */
  productionCost: number
  costAtSave: number
  saleAmount: number
  /** sale − cost now. */
  profitPaise: number
  profitAtSave: number
  repriced: boolean
  jobWork: boolean
}

/** manufacture:costSheet (mirrors services/manufactureReports.ts CostSheetReport). */
export interface CostSheetReport {
  itemId: number
  itemName: string
  unitSymbol: string
  decimals: number
  manufactures: CostSheet[]
  average: CostSheet
}

export type SavedJobWorkChallan = Voucher & { duplicateNumber?: boolean; warnings: { negativeStock: NegativeStockWarning[] }; challan: JobWorkChallan }

/** stock:movements — one item's inventory lines (minimal movement list, WP 2.2). */
export interface ItemMovementRow {
  voucherId: number
  date: string
  number: string
  voucherType: string
  kind: string
  inQtyMilli: number
  outQtyMilli: number
  isAbsolute: boolean
  amount: number
}

export type SavedManufacture = Voucher & {
  duplicateNumber?: boolean
  warnings: { negativeStock: NegativeStockWarning[] }
  manufacture: ManufactureDetails
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
  partyLedgerId: number | null
  partyName: string | null
  instrumentNo: string | null
  instrumentDate: string | null
  amount: number
}

export async function call<T>(channel: string, payload?: unknown): Promise<T> {
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
    restore: (file: string) =>
      call<{ info: CompanyInfo; integrity: IntegrityResult; locked: boolean }>('backup:restore', { file }),
    exportEncrypted: (passphrase: string) => call<{ path: string }>('backup:exportEncrypted', { passphrase }),
    importEncrypted: (passphrase: string) =>
      call<{ slug: string; name: string } | null>('backup:importEncrypted', { passphrase })
  },
  groups: {
    list: () => call<Group[]>('master:groups:list'),
    tree: () => call<GroupTreeNode[]>('master:groups:tree'),
    /** Groups with their ledgers as leaves, closing balances as on `asOn`. */
    chart: (asOn: string) => call<ChartGroupNode[]>('master:chartOfAccounts', { asOn }),
    create: (data: GroupInput) => call<Group>('master:groups:create', data),
    update: (id: number, data: GroupInput) => call<Group>('master:groups:update', { id, data }),
    remove: (id: number) => call<null>('master:groups:delete', { id })
  },
  ledgers: {
    list: () => call<Ledger[]>('master:ledgers:list'),
    create: (data: LedgerInput) => call<Ledger>('master:ledgers:create', data),
    update: (id: number, data: LedgerInput) => call<Ledger>('master:ledgers:update', { id, data }),
    remove: (id: number) => call<null>('master:ledgers:delete', { id }),
    balances: (asOn: string) => call<LedgerBalanceRow[]>('master:ledgerBalances', { asOn })
  },
  voucherTypes: {
    list: () => call<VoucherType[]>('master:voucherTypes:list'),
    create: (data: VoucherTypeInput) => call<VoucherType>('master:voucherTypes:create', data),
    update: (id: number, data: VoucherTypeInput) => call<VoucherType>('master:voucherTypes:update', { id, data })
  },
  /** WP 2.5a — the voucher_kinds lookup table. */
  voucherKinds: {
    list: () => call<VoucherKindRow[]>('voucherKinds:list')
  },
  /** WP 2.5a — quotation / order numbering series (documents and screens: WP 2.5c). */
  tradeDocTypes: {
    list: () => call<TradeDocType[]>('tradeDocTypes:list'),
    save: (data: TradeDocTypeInput, id?: number) => call<TradeDocType>('tradeDocTypes:save', { data, ...(id ? { id } : {}) }),
    nextNumber: (docTypeId: number, date: string) => call<string>('tradeDocs:nextNumber', { docTypeId, date })
  },
  /** WP 2.5a — trade-cycle line links. */
  links: {
    forVoucher: (voucherId: number) => call<VoucherLinks>('links:forVoucher', { voucherId }),
    openSourceLines: (q: OpenSourceLinesQuery) => call<OpenSourceLine[]>('links:openSourceLines', q)
  },
  /** WP 2.5b — trade-cycle reports. */
  trade: {
    pending: (stage: 'delivery_note' | 'receipt_note', asOn: string) => call<PendingNoteRow[]>('trade:pending', { stage, asOn }),
    /** WP 2.5c — open sales / purchase order lines as on a date. */
    pendingOrders: (kind: 'sales_order' | 'purchase_order', asOn: string) => call<PendingOrderRow[]>('trade:pendingOrders', { kind, asOn }),
    quotationPipeline: (from: string, to: string, asOn: string) => call<QuotationPipeline>('trade:quotationPipeline', { from, to, asOn }),
    openSalesOrderValue: (partyLedgerId: number) => call<number>('trade:openSalesOrderValue', { partyLedgerId }),
    /** WP 2.5d — the linked-documents chain around a voucher or a trade doc. */
    chain: (q: { voucherId: number } | { tradeDocId: number }) => call<TradeChain>('trade:chain', q),
    threeWayMatch: (q: { from: string; to: string } & Partial<MatchTolerances>) => call<MatchRow[]>('trade:threeWayMatch', q),
    itemDemand: (asOn: string, onlyOpen = true) => call<ItemDemandRow[]>('trade:itemDemand', { asOn, onlyOpen }),
    orderBook: (kind: 'sales_order' | 'purchase_order', from: string, to: string) => call<OrderBookRow[]>('trade:orderBook', { kind, from, to }),
    leadTime: (kind: 'sales_order' | 'purchase_order', from: string, to: string, asOn: string) =>
      call<LeadTimeRow[]>('trade:leadTime', { kind, from, to, asOn }),
    returnsRegister: (side: ReturnSide, from: string, to: string) => call<ReturnRow[]>('trade:returnsRegister', { side, from, to }),
    returnsRate: (side: ReturnSide, from: string, to: string, by: 'item' | 'party') =>
      call<ReturnRateRow[]>('trade:returnsRate', { side, from, to, by }),
    unbilledGoods: (asOn: string) => call<UnbilledGoods>('trade:unbilledGoods', { asOn }),
    staleDocuments: (asOn: string, orderAgeDays: number, noteAgeDays: number) =>
      call<StaleDocRow[]>('trade:staleDocuments', { asOn, orderAgeDays, noteAgeDays }),
    noteClosure: (voucherId: number) => call<NoteClosure>('trade:noteClosure', { voucherId }),
    closeVoucher: (voucherId: number, reason: string | null) => call<NoteClosure>('trade:closeVoucher', { voucherId, reason }),
    reopenVoucher: (voucherId: number, reason: string | null) => call<NoteClosure>('trade:reopenVoucher', { voucherId, reason }),
    closeStaleQuotations: (asOn: string, ids?: number[], reason?: string | null) =>
      call<{ closed: number[] }>('trade:closeStaleQuotations', { asOn, ...(ids ? { ids } : {}), reason: reason ?? null })
  },
  /** WP 2.5c — quotations, sales orders, purchase orders. */
  tradeDocs: {
    list: (q: TradeDocListQuery) => call<TradeDocListRow[]>('tradeDocs:list', q),
    get: (id: number) => call<TradeDoc | null>('tradeDocs:get', { id }),
    /** `aiDraftId` (WP 5.3): the document was reviewed from an AI draft — main marks it consumed. */
    save: (data: TradeDocInputParsed, id?: number, opts?: { aiDraftId?: number }) =>
      call<{ doc: TradeDoc; warnings: { linkDates: string[] } }>('tradeDocs:save', { data, ...(id ? { id } : {}), ...(opts?.aiDraftId ? { aiDraftId: opts.aiDraftId } : {}) }),
    remove: (id: number) => call<null>('tradeDocs:delete', { id }),
    restore: (id: number) => call<TradeDoc>('tradeDocs:restore', { id }),
    cancel: (id: number, reason: string | null) => call<TradeDoc>('tradeDocs:cancel', { id, reason }),
    close: (id: number, reason: string | null) => call<TradeDoc>('tradeDocs:close', { id, reason }),
    reopen: (id: number, reason: string | null = null) => call<TradeDoc>('tradeDocs:reopen', { id, reason }),
    convert: (id: number, to: TradeDocKind) => call<TradeDocDraft>('tradeDocs:convert', { id, to }),
    duplicate: (id: number) => call<TradeDocDraft>('tradeDocs:duplicate', { id }),
    pdf: (id: number) => call<{ path: string }>('tradeDocs:pdf', { id }),
    previewHtml: (id: number) => call<{ html: string }>('tradeDocs:previewHtml', { id })
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
    /** Exact engine cost as of a voucher date (WP 2.1): running average / FIFO next layer per
     *  item, and the cost proposed outward lines would be charged. Pass `voucherId` when
     *  editing so the voucher's own saved lines are left out. */
    costAsOf: (q: { date: string; voucherId?: number; itemIds?: number[]; lines?: ProposedOutward[] }) =>
      call<StockCostAsOf>('stock:costAsOf', q),
    /** WP 2.2 — one item's plain inventory lines (the list under a Stock summary row). */
    movements: (stockItemId: number, from: string, to: string) =>
      call<ItemMovementRow[]>('stock:movements', { stockItemId, from, to }),
    /** WP 2.3 — one item's movement register with running quantity/value from the pass. */
    register: (q: { itemId: number; from: string; to: string; godownId?: number }) =>
      call<StockMovementRegister>('stock:register', q),
    reorder: (from: string, to: string, onlyBelow = true) => call<ReorderRow[]>('stock:reorder', { from, to, onlyBelow }),
    expiryReport: (asOn: string, withinDays: number) => call<ExpiryReportRow[]>('stock:expiryReport', { asOn, withinDays }),
    labelsHtml: (q: StockLabelsQuery) => call<{ html: string }>('stock:labelsHtml', q),
    labelsPdf: (q: StockLabelsQuery) => call<{ path: string }>('stock:labelsPdf', q)
  },
  serials: {
    list: (q: { stockItemId?: number; status?: SerialStatus } = {}) => call<SerialListRow[]>('serials:list', q),
    /** Serials an outward line may pick (in stock, plus those `voucherId` itself took out). */
    available: (stockItemId: number, voucherId?: number) => call<string[]>('serials:available', { stockItemId, voucherId })
  },
  manufacture: {
    get: (id: number) => call<ManufactureRecord | null>('manufacture:get', { id }),
    /** `aiDraftId` (WP 5.3): reviewed from an AI draft — main marks it consumed. */
    save: (data: ManufactureInput, id?: number, opts?: { aiDraftId?: number }) =>
      call<SavedManufacture>('manufacture:save', { data, id, ...(opts?.aiDraftId ? { aiDraftId: opts.aiDraftId } : {}) }),
    /** Raw rows priced as of the voucher date (+ the finished item's suggested sale rate). */
    costPreview: (q: { date: string; voucherId?: number; finishedItemId?: number | null; lines: { itemId: number; qtyMilli: number }[] }) =>
      call<ManufactureCostPreview>('manufacture:costPreview', q),
    register: (from: string, to: string, itemId?: number) => call<ManufactureRegisterRow[]>('manufacture:register', { from, to, itemId }),
    // WP 2.4 reports
    production: (from: string, to: string) => call<ProductionRegisterRow[]>('manufacture:production', { from, to }),
    costSheet: (itemId: number, from: string, to: string) => call<CostSheetReport>('manufacture:costSheet', { itemId, from, to }),
    margin: (from: string, to: string) => call<MarginRow[]>('manufacture:margin', { from, to }),
    variance: (from: string, to: string, itemId?: number) => call<VarianceReportRow[]>('manufacture:variance', { from, to, itemId })
  },
  jobWork: {
    get: (id: number) => call<JobWorkChallan | null>('jobWork:get', { id }),
    saveChallan: (data: JobWorkChallanPayload, id?: number) => call<SavedJobWorkChallan>('jobWork:saveChallan', { ...data, id }),
    sendChallans: (godownId: number) => call<{ voucherId: number; number: string; date: string }[]>('jobWork:sendChallans', { id: godownId }),
    pending: (asOn: string, pendingDays: number) => call<JobWorkPendingRow[]>('jobWork:pending', { asOn, pendingDays }),
    itc04: (from: string, to: string) => call<Itc04Data>('jobWork:itc04', { from, to })
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
    /** `creditHoldOverride` (WP 4.2): an owner's reason for invoicing a party on credit hold.
     *  `aiDraftId` (WP 5.1): the voucher was reviewed from an AI draft — main marks it consumed. */
    save: (data: VoucherInputParsed, id?: number, opts?: { creditHoldOverride?: { reason: string }; aiDraftId?: number }) =>
      call<Voucher & { duplicateNumber?: boolean; warnings?: SaveVoucherWarnings }>('voucher:save', {
        data,
        id,
        ...(opts?.creditHoldOverride ? { creditHoldOverride: opts.creditHoldOverride } : {}),
        ...(opts?.aiDraftId ? { aiDraftId: opts.aiDraftId } : {})
      }),
    remove: (id: number) => call<null>('voucher:delete', { id }),
    nextNumber: (voucherTypeId: number, date: string, excludeId?: number) =>
      call<{ number: string }>('voucher:nextNumber', { voucherTypeId, date, excludeId }),
    numberExists: (voucherTypeId: number, number: string, excludeId?: number) =>
      call<boolean>('voucher:numberExists', { voucherTypeId, number, excludeId }),
    duplicates: (data: VoucherInputParsed, excludeId?: number) =>
      call<{ voucherId: number; number: string; date: string }[]>('voucher:duplicates', { data, excludeId }),
    bin: () => call<BinRow[]>('voucher:bin'),
    restore: (id: number) => call<null>('voucher:restore', { id }),
    purge: (id: number) => call<null>('voucher:purge', { id })
  },
  reports: {
    dayBook: (from: string, to: string, includeOutOfBooks?: boolean) =>
      call<DayBookRow[]>('report:dayBook', { from, to, includeOutOfBooks }),
    ledger: (ledgerId: number, from: string, to: string, groupBy?: 'month') =>
      call<LedgerStatement>('report:ledger', { ledgerId, from, to, groupBy }),
    trialBalance: (asOn: string) => call<TrialBalance>('report:trialBalance', { asOn }),
    profitLoss: (from: string, to: string, comparePrior?: boolean) =>
      call<ProfitAndLoss>('report:profitLoss', { from, to, comparePrior }),
    balanceSheet: (asOn: string, comparePrior?: boolean) =>
      call<BalanceSheet>('report:balanceSheet', { asOn, comparePrior }),
    dashboard: (today: string, fyFrom: string) => call<DashboardData>('report:dashboard', { today, fyFrom }),
    /** Gateway dashboard cards (WP 1.10b) — sectioned: each card's data or its own error. */
    dashboardSeries: (today: string, from: string, to: string) =>
      call<DashboardSeries>('report:dashboardSeries', { today, from, to }),
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
    gstr3b: (from: string, to: string, period: string) => call<Gstr3bView>('gst:gstr3b', { from, to, period }),
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
      call<Gst3bManualInput>('gst:3bManualSet', { period, data }),
    // ---------- WP 3.4: GST expansion ----------
    recon2bTolerances: () => call<Recon2bTolerances>('gst:recon2bTolerancesGet'),
    setRecon2bTolerances: (t: Recon2bTolerances) => call<Recon2bTolerances>('gst:recon2bTolerancesSet', t),
    imsList: (period: string) => call<ImsActionRecord[]>('gst:imsList', { period }),
    imsSet: (period: string, decisions: ImsDecisionPayload[]) => call<{ saved: number; cleared: number }>('gst:imsSet', { period, decisions }),
    imsExport: (period: string) => call<{ jsonPath: string; csvPath: string; count: number }>('gst:imsExport', { period }),
    gstr9: (fyStartYear: number) => call<Gstr9View>('gst:gstr9', { fyStartYear }),
    exportGstr9: (fyStartYear: number) => call<{ jsonPath: string; csvPath: string }>('gst:exportGstr9', { fyStartYear }),
    itc04: (q: { fyStartYear: number; kind: Itc04PeriodKind; periodicity?: Itc04Periodicity }) => call<Itc04View>('gst:itc04', q),
    exportItc04: (q: { fyStartYear: number; kind: Itc04PeriodKind; periodicity?: Itc04Periodicity }) =>
      call<{ jsonPath: string; csvPath: string }>('gst:exportItc04', q),
    selfInvoices: (from: string, to: string) => call<SelfInvoiceRow[]>('gst:selfInvoices', { from, to }),
    selfInvoiceGenerate: (voucherId: number, date?: string) =>
      call<{ voucherId: number; number: string; date: string }>('gst:selfInvoiceGenerate', { voucherId, date }),
    selfInvoicePdf: (voucherId: number) => call<{ path: string }>('gst:selfInvoicePdf', { voucherId }),
    selfInvoiceSeries: () => call<SelfInvoiceSeries>('gst:selfInvoiceSeriesGet'),
    setSelfInvoiceSeries: (s: SelfInvoiceSeries) => call<SelfInvoiceSeries>('gst:selfInvoiceSeriesSet', s),
    itcReversal: (from: string, to: string, period: string, inputs?: ItcReversalInputs) =>
      call<ItcReversalView>('gst:itcReversal', { from, to, period, inputs }),
    setItcReversalInputs: (period: string, inputs: ItcReversalInputs) => call<ItcReversalInputs>('gst:itcReversalInputsSet', { period, inputs }),
    itcReversalApply: (from: string, to: string, period: string) => call<ItcReversalView>('gst:itcReversalApply', { from, to, period }),
    itcReversalPost: (from: string, to: string, period: string) => call<{ voucherId: number; number: string }>('gst:itcReversalPost', { from, to, period })
  },
  analysis: {
    register: (kind: 'sales' | 'purchase', from: string, to: string) =>
      call<RegisterMonthRow[]>('analysis:register', { kind, from, to }),
    outstandings: (side: 'receivable' | 'payable', asOn: string) =>
      call<OutstandingParty[]>('analysis:outstandings', { side, asOn })
  },
  bills: {
    open: (partyLedgerId: number, asOn: string) => call<OutstandingBill[]>('bills:open', { partyLedgerId, asOn })
  },
  tds: {
    sections: () => call<TdsSection[]>('tds:sections'),
    sectionSave: (data: TdsSectionInput) => call<TdsSection>('tds:sectionSave', data),
    suggest: (
      partyLedgerId: number,
      base: number,
      date: string,
      opts: {
        expenseLedgerId?: number | null
        excludeVoucherId?: number
        sectionId?: number | null
        voucherKind?: 'purchase' | 'journal' | 'payment'
      } = {}
    ) => call<TdsSuggestion | null>('tds:suggest', { partyLedgerId, base, date, ...opts }),
    ensurePayable: (sectionId: number) => call<{ ledgerId: number }>('tds:ensurePayable', { sectionId }),
    rates: (sectionId?: number) => call<TdsRate[]>('tds:rates', { sectionId }),
    rateSave: (data: TdsRateInput) => call<TdsRate>('tds:rateSave', data),
    rateDelete: (id: number) => call<void>('tds:rateDelete', { id }),
    certificates: (ledgerId?: number) => call<TdsCertificateRow[]>('tds:certificates', { ledgerId }),
    certificateSave: (data: TdsCertificateInput) => call<TdsCertificateRow>('tds:certificateSave', data),
    certificateDelete: (id: number) => call<void>('tds:certificateDelete', { id }),
    challans: (fyStartYear: number, quarter?: number) => call<TdsChallan[]>('tds:challans', { fyStartYear, quarter }),
    challanSave: (data: TdsChallanInput) => call<TdsChallan>('tds:challanSave', data),
    challanDelete: (id: number) => call<void>('tds:challanDelete', { id }),
    allocate: (challanId: number, entryIds: number[]) => call<TdsChallan>('tds:allocate', { challanId, entryIds }),
    unallocate: (entryIds: number[]) => call<void>('tds:unallocate', { entryIds }),
    unallocated: (fyStartYear: number, quarter?: number) => call<TdsEntryRow[]>('tds:unallocated', { fyStartYear, quarter }),
    summary: (fyStartYear: number) => call<TdsSummaryRow[]>('tds:summary', { fyStartYear }),
    export26q: (fyStartYear: number, quarter: number) => call<{ path: string }>('tds:export26q', { fyStartYear, quarter }),
    // WP 3.2 — the TDS screen
    eligible: (from: string, to: string, includeExempt = false) => call<TdsEligibleRow[]>('tds:eligible', { from, to, includeExempt }),
    deducted: (from: string, to: string) => call<TdsDeductedRow[]>('tds:deducted', { from, to }),
    ledgerSummary: (fyStartYear: number, quarter: number) => call<TdsLedgerSummaryRow[]>('tds:ledgerSummary', { fyStartYear, quarter }),
    applyToVoucher: (voucherId: number, opts: { sectionId?: number | null; manualPaise?: number | null } = {}) =>
      call<Voucher>('tds:applyToVoucher', { voucherId, ...opts }),
    applyMany: (voucherIds: number[]) =>
      call<({ voucherId: number; ok: true } | { voucherId: number; ok: false; error: string })[]>('tds:applyMany', { voucherIds }),
    removeFromVoucher: (voucherId: number) => call<Voucher>('tds:removeFromVoucher', { voucherId }),
    exempt: (voucherId: number, reason: string) => call<null>('tds:exempt', { voucherId, reason }),
    unexempt: (voucherId: number) => call<null>('tds:unexempt', { voucherId }),
    exemption: (voucherId: number) => call<{ reason: string | null }>('tds:exemption', { voucherId }),
    paymentCandidates: (fyStartYear: number) => call<TdsPaymentCandidate[]>('tds:paymentCandidates', { fyStartYear }),
    challanRows: (fyStartYear: number, quarter?: number, rateBp?: number) => call<TdsChallanRow[]>('tds:challanRows', { fyStartYear, quarter, rateBp }),
    challanFromPayment: (data: {
      paymentVoucherId: number; bsrCode: string; challanNo: string; date?: string | null
      quarter?: number | null; fyStartYear?: number | null; autoAllocate?: boolean
    }) => call<TdsChallanRow>('tds:challanFromPayment', data),
    autoAllocate: (challanId: number) => call<{ entryIds: number[] }>('tds:autoAllocate', { challanId }),
    challanInterest: (challanId: number, rateBp?: number) => call<TdsChallanEntryInterest[]>('tds:challanInterest', { challanId, rateBp }),
    form26q: (fyStartYear: number, quarter: number) => call<Form26qData>('tds:form26q', { fyStartYear, quarter }),
    form16a: (fyStartYear: number, quarter: number, partyLedgerId?: number) => call<Form16aData>('tds:form16a', { fyStartYear, quarter, partyLedgerId }),
    form16aPdf: (fyStartYear: number, quarter: number, partyLedgerId?: number) => call<{ path: string }>('tds:form16aPdf', { fyStartYear, quarter, partyLedgerId })
  },
  // WP 3.3 — TCS on sales: the same calls as `tds` over the kind-tagged tables (the TDS screen's
  // tab components take a kind and use whichever namespace), plus the TCS-only suggestion and the
  // Form 27EQ / Form 27D data.
  tcs: {
    sections: () => call<TdsSection[]>('tcs:sections'),
    sectionSave: (data: TdsSectionInput) => call<TdsSection>('tcs:sectionSave', data),
    suggest: (input: TcsSuggestRequest) => call<TcsSuggestion | null>('tcs:suggest', input),
    rates: (sectionId?: number) => call<TdsRate[]>('tcs:rates', { sectionId }),
    rateSave: (data: TdsRateInput) => call<TdsRate>('tcs:rateSave', data),
    rateDelete: (id: number) => call<void>('tcs:rateDelete', { id }),
    certificates: (ledgerId?: number) => call<TdsCertificateRow[]>('tcs:certificates', { ledgerId }),
    certificateSave: (data: TdsCertificateInput) => call<TdsCertificateRow>('tcs:certificateSave', data),
    certificateDelete: (id: number) => call<void>('tcs:certificateDelete', { id }),
    challanSave: (data: TdsChallanInput) => call<TdsChallan>('tcs:challanSave', data),
    challanDelete: (id: number) => call<void>('tcs:challanDelete', { id }),
    allocate: (challanId: number, entryIds: number[]) => call<TdsChallan>('tcs:allocate', { challanId, entryIds }),
    unallocate: (entryIds: number[]) => call<void>('tcs:unallocate', { entryIds }),
    unallocated: (fyStartYear: number, quarter?: number) => call<TdsEntryRow[]>('tcs:unallocated', { fyStartYear, quarter }),
    eligible: (from: string, to: string, includeExempt = false) => call<TdsEligibleRow[]>('tcs:eligible', { from, to, includeExempt }),
    deducted: (from: string, to: string) => call<TdsDeductedRow[]>('tcs:deducted', { from, to }),
    ledgerSummary: (fyStartYear: number, quarter: number) => call<TdsLedgerSummaryRow[]>('tcs:ledgerSummary', { fyStartYear, quarter }),
    applyToVoucher: (voucherId: number, opts: { sectionId?: number | null; manualPaise?: number | null } = {}) =>
      call<Voucher>('tcs:applyToVoucher', { voucherId, ...opts }),
    applyMany: (voucherIds: number[]) =>
      call<({ voucherId: number; ok: true } | { voucherId: number; ok: false; error: string })[]>('tcs:applyMany', { voucherIds }),
    removeFromVoucher: (voucherId: number) => call<Voucher>('tcs:removeFromVoucher', { voucherId }),
    exempt: (voucherId: number, reason: string) => call<null>('tcs:exempt', { voucherId, reason }),
    unexempt: (voucherId: number) => call<null>('tcs:unexempt', { voucherId }),
    exemption: (voucherId: number) => call<{ reason: string | null }>('tcs:exemption', { voucherId }),
    paymentCandidates: (fyStartYear: number) => call<TdsPaymentCandidate[]>('tcs:paymentCandidates', { fyStartYear }),
    challanRows: (fyStartYear: number, quarter?: number, rateBp?: number) => call<TdsChallanRow[]>('tcs:challanRows', { fyStartYear, quarter, rateBp }),
    challanFromPayment: (data: {
      paymentVoucherId: number; bsrCode: string; challanNo: string; date?: string | null
      quarter?: number | null; fyStartYear?: number | null; autoAllocate?: boolean
    }) => call<TdsChallanRow>('tcs:challanFromPayment', data),
    autoAllocate: (challanId: number) => call<{ entryIds: number[] }>('tcs:autoAllocate', { challanId }),
    challanInterest: (challanId: number, rateBp?: number) => call<TdsChallanEntryInterest[]>('tcs:challanInterest', { challanId, rateBp }),
    form27eq: (fyStartYear: number, quarter: number) => call<Form26qData>('tcs:form27eq', { fyStartYear, quarter }),
    export27eq: (fyStartYear: number, quarter: number) => call<{ path: string }>('tcs:export27eq', { fyStartYear, quarter }),
    form27d: (fyStartYear: number, quarter: number, partyLedgerId?: number) => call<Form16aData>('tcs:form27d', { fyStartYear, quarter, partyLedgerId }),
    form27dPdf: (fyStartYear: number, quarter: number, partyLedgerId?: number) => call<{ path: string }>('tcs:form27dPdf', { fyStartYear, quarter, partyLedgerId })
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
  bank: {
    ledgers: () => call<{ id: number; name: string }[]>('bank:ledgers'),
    recon: (ledgerId: number, from: string, to: string) => call<BankRecon>('bank:recon', { ledgerId, from, to }),
    setBankDate: (lineId: number, bankDate: string | null) => call<null>('bank:setBankDate', { lineId, bankDate }),
    importCsv: (ledgerId: number, opts?: { csvText?: string; dryRun?: boolean }) =>
      call<(BankImportResult & { csvText: string }) | null>('bank:importCsv', { ledgerId, ...opts }),
    suggest: (ledgerId: number, csvText: string) => call<BankSuggestionRow[]>('banking:suggest', { ledgerId, csvText }),
    matchSuggestions: (ledgerId: number, csvText: string, tolerancePaise?: number) =>
      call<BankMatchSuggestion[]>('banking:matchSuggestions', { ledgerId, csvText, tolerancePaise }),
    brs: (ledgerId: number, asOn: string) => call<BrsReport>('banking:brs', { ledgerId, asOn }),
    brsPdf: (ledgerId: number, asOn: string) => call<{ path: string }>('banking:brsPdf', { ledgerId, asOn })
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
  /** Print templates (WP 1.10c) — Settings → Invoice templates. */
  templates: {
    list: () => call<TemplateList>('template:list'),
    get: (id: string) => call<PrintTemplate>('template:get', { id }),
    save: (template: PrintTemplate) => call<PrintTemplate>('template:save', { template }),
    duplicate: (id: string) => call<PrintTemplate>('template:duplicate', { id }),
    remove: (id: string) => call<{ ok: true }>('template:delete', { id }),
    reset: (id: string) => call<PrintTemplate>('template:reset', { id }),
    setDefault: (kind: PrintDocKind, id: string) => call<TemplateList>('template:setDefault', { kind, id }),
    previewHtml: (template: PrintTemplate, opts: { voucherId?: number; kind?: PrintDocKind } = {}) =>
      call<{ html: string }>('template:previewHtml', { template, ...opts }),
    testPdf: (template: PrintTemplate, kind?: PrintDocKind) => call<{ path: string }>('template:testPdf', { template, kind }),
    exportJson: (id: string) => call<{ path: string }>('template:export', { id }),
    importJson: (jsonText?: string) => call<PrintTemplate | null>('template:import', jsonText === undefined ? {} : { jsonText })
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
    items: () => call<{ itemId: number; name: string; components: number }[]>('bom:items'),
    // WP 2.4 versions
    /** One item's versions, or every item's (omit itemId — what the Manufacture screen explodes with). */
    versions: (itemId?: number) => call<BomVersion[]>('bom:versions', { itemId }),
    saveVersion: (data: {
      id?: number; itemId: number; name: string; effectiveFrom: string | null; effectiveTo: string | null; isDefault: boolean
      lines: { componentId: number; qtyMilliPerUnit: number; scrapPctBp: number | null }[]
    }) => call<BomVersion>('bom:saveVersion', data),
    deleteVersion: (id: number) => call<null>('bom:deleteVersion', { id }),
    explode: (q: { itemId: number; qtyMilli: number; date: string; versionId?: number | null; levels: 'single' | 'full' }) =>
      call<ExplosionResult>('bom:explode', q)
  },
  payroll: {
    employees: () => call<Employee[]>('payroll:employees:list'),
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
    ptCsv: (runId: number) => call<{ path: string }>('payroll:ptCsv', { runId })
  },
  yearEnd: {
    preview: (fyStartYear: number) =>
      call<{ rows: CloseLedgerRow[]; netProfit: number; alreadyClosed: boolean; depreciation?: DepreciationYearStatus; unbilled?: UnbilledGoods; msme?: MsmeYearEndWarning }>('yearend:preview', { fyStartYear }),
    close: (fyStartYear: number) =>
      call<{ voucherId: number; netProfit: number; lockedUpTo: string }>('yearend:close', { fyStartYear })
  },
  tally: {
    dryRun: (filePath?: string) =>
      call<{ filePath: string | null; summary: TallyImportSummary } | null>('tally:import', { filePath, dryRun: true }),
    apply: (filePath?: string) =>
      call<{ filePath: string | null; summary: TallyImportSummary } | null>('tally:import', { filePath, dryRun: false })
  },
  /** WP 6.3 import wizard + books export (src/main/ipcDataImport.ts). */
  dataImport: {
    load: (inline?: { fileName?: string; csvText?: string; xmlText?: string; xlsxBase64?: string }) => call<ImportLoadResult | null>('importwiz:load', inline ?? {}),
    sheet: (token: string, sheet: string, headerRow?: number) => call<ImportSheetSummary>('importwiz:sheet', { token, sheet, headerRow }),
    preview: (q: ImportTableQuery) => call<ImportRunResult>('importwiz:preview', q),
    run: (q: ImportTableQuery & { saveTemplate?: { name: string } | null }) => call<ImportRunResult>('importwiz:run', q),
    planPreview: (token: string, options: Partial<ImportWizardOptions>) => call<ImportRunResult>('importwiz:planPreview', { token, options }),
    planRun: (token: string, options: Partial<ImportWizardOptions>) => call<ImportRunResult>('importwiz:planRun', { token, options }),
    batches: () => call<ImportBatchRow[]>('importwiz:batches'),
    undo: (batchId: number) => call<ImportUndoResult>('importwiz:undo', { batchId }),
    templates: (profileId?: string) => call<ImportTemplateRow[]>('importwiz:templates', { profileId }),
    deleteTemplate: (id: number) => call<null>('importwiz:templateDelete', { id }),
    sample: (profileId: string) => call<{ path: string }>('importwiz:sample', { profileId }),
    exportBooks: () => call<{ path: string; counts: Record<string, number> }>('export:books', {})
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
    csv: (filename: string, csv: string) => call<{ path: string }>('export:csv', { filename, csv }),
    xlsx: (filename: string, sheets: XlsxSheet[]) => call<{ path: string }>('export:xlsx', { filename, sheets })
  },
  nic: {
    get: () => call<NicCredentials>('nic:get'),
    save: (creds: NicCredentials) => call<{ configured: boolean }>('nic:save', creds),
    status: () => call<{ configured: boolean }>('nic:status'),
    /** Auth handshake only (WP 3.5) — files nothing. */
    testConnection: () => call<{ ok: true; endpoint: string; sandbox: boolean; tokenExpiry: string }>('nic:testConnection'),
    generateIrn: (voucherId: number) => call<{ irn: string; ackNo: string; ackDate: string }>('nic:generateIrn', { voucherId }),
    generateEwb: (voucherId: number) => call<{ ewbNo: string; validUpto: string }>('nic:generateEwb', { voucherId })
  },
  intel: {
    suggestLedgers: (kind: string, query: string) =>
      call<{ ledgerId: number; name: string; groupName: string; uses: number }[]>('intel:suggestLedgers', { kind, query }),
    anomaly: (ledgerId: number, amount: number) =>
      call<{ unusual: boolean; typicalAmount: number | null }>('intel:anomaly', { ledgerId, amount })
  },
  log: {
    renderer: (input: RendererLogInput) => call<null>('log:renderer', input),
    reveal: () => call<null>('log:reveal')
  },
  search: {
    global: (q: string) => call<SearchHit[]>('search:global', { q }),
    /** Books search with the query language — see src/shared/searchQuery.ts. */
    query: (input: SearchQueryInput) => call<SearchResponse>('search:query', input)
  },
  audit: {
    list: (query: AuditListInput) => call<{ rows: AuditRow[]; total: number; users: string[] }>('audit:list', query),
    verify: () => call<ChainVerification>('audit:verify'),
    exportCsv: (query: AuditExportInput) => call<{ path: string; rows: number; verification: ChainVerification }>('audit:exportCsv', query),
    exportPdf: (query: AuditExportInput) => call<{ path: string; rows: number; verification: ChainVerification }>('audit:exportPdf', query),
    settings: () => call<AuditSettings>('config:audit:get'),
    retentionSet: (keepDays: number | null) => call<AuditSettings>('config:audit:set', { keepDays }),
    setRequired: (required: boolean) => call<AuditSettings>('config:audit:required', { required })
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
    checkUpdates: () =>
      call<{ status: 'dev' | 'available' | 'up-to-date' | 'error'; current: string; latest?: string }>(
        'app:checkUpdates'
      ),
    notifyDeadlines: (items: { title: string; body: string }[]) =>
      call<null>('app:notifyDeadlines', { items })
  }
}
