import type {
  Batch, BomLine, Budget, CompanyInfo, CostCentre, Currency, Employee, Godown, Group, Ledger, NegativeStockWarning,
  PayrollLine, PayrollRun, PriceLevel, PriceListRate, RecurringTemplate, StockGroup, StockItem, TdsSection, Unit,
  Voucher, VoucherTransport, VoucherType
} from '@shared/domain'
import type { BudgetVarianceRow } from '@shared/budgets'
import type {
  BalanceSheet, BankRecon, DashboardData, DayBookRow, EdocListRow, ExceptionsReport, GroupTreeNode,
  ItemProfitRow, LedgerBalanceRow,
  LedgerStatement, OutstandingBill, OutstandingParty, ProfitAndLoss, RegisterPeriodRow, StockAgeingRow,
  StockSummaryRow, TrialBalance,
  VoucherListRow
} from '@shared/reports'
import type { CashFlowStatement } from '@shared/reportMath'
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
  skipped: number
  warnings: string[]
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
    update: (id: number, data: LedgerInput) => call<Ledger>('master:ledgers:update', { id, data }),
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
    negative: (asOn: string) => call<NegativeStockWarning[]>('stock:negative', { asOn })
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
      call<Voucher & { duplicateNumber?: boolean }>('voucher:save', { data, id }),
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
    ledger: (ledgerId: number, from: string, to: string, groupBy?: Period) =>
      call<LedgerStatement>('report:ledger', { ledgerId, from, to, groupBy }),
    trialBalance: (asOn: string) => call<TrialBalance>('report:trialBalance', { asOn }),
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
    outstandings: (side: 'receivable' | 'payable', asOn: string) =>
      call<OutstandingParty[]>('analysis:outstandings', { side, asOn })
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
      call<{ rows: CloseLedgerRow[]; netProfit: number; alreadyClosed: boolean }>('yearend:preview', { fyStartYear }),
    close: (fyStartYear: number) =>
      call<{ voucherId: number; netProfit: number; lockedUpTo: string }>('yearend:close', { fyStartYear })
  },
  tally: {
    dryRun: (filePath?: string) =>
      call<{ filePath: string | null; summary: TallyImportSummary } | null>('tally:import', { filePath, dryRun: true }),
    apply: (filePath?: string) =>
      call<{ filePath: string | null; summary: TallyImportSummary } | null>('tally:import', { filePath, dryRun: false })
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
  log: {
    renderer: (input: RendererLogInput) => call<null>('log:renderer', input),
    reveal: () => call<null>('log:reveal')
  },
  search: {
    global: (q: string) => call<SearchHit[]>('search:global', { q })
  },
  audit: {
    list: (query: AuditListInput) => call<{ rows: AuditRow[]; total: number }>('audit:list', query),
    retentionGet: () => call<{ keepDays: number | null }>('config:audit:get'),
    retentionSet: (keepDays: number | null) => call<{ keepDays: number | null }>('config:audit:set', { keepDays })
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
