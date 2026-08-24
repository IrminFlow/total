import type {
  Batch,
  BomLine,
  Budget,
  CompanyInfo,
  CostCentre,
  Currency,
  Employee,
  Godown,
  Group,
  Ledger,
  NegativeStockWarning,
  PayrollLine,
  PayrollRun,
  PriceLevel,
  PriceListRate,
  RecurringTemplate,
  StockGroup,
  StockItem,
  TdsSection,
  Unit,
  Voucher,
  VoucherKind,
  VoucherTransport,
  VoucherType,
} from "@shared/domain";
import { call, cancellableCall } from "./ipcClient";
import type { BudgetVarianceRow } from "@shared/budgets";
import type {
  BalanceSheet,
  BankRecon,
  DashboardData,
  DayBookRow,
  EdocListRow,
  ExceptionsReport,
  GroupTreeNode,
  ItemProfitRow,
  LedgerBalanceRow,
  LedgerStatement,
  OutstandingBill,
  OutstandingParty,
  ProfitAndLoss,
  RegisterGranularity,
  RegisterPeriodRow,
  StockAgeingRow,
  StockSummaryRow,
  TrialBalance,
  VoucherListRow,
} from "@shared/reports";
import type { CashFlowStatement } from "@shared/reportMath";
import type {
  ControlReport,
  DepartmentBoundary,
  ExportPermissionMatrix,
  PeriodSignoff,
  PolicyException,
  PolicyKind,
  RetentionPolicy,
  ReviewPriority,
  ReviewQuestion,
  ReviewStatus,
  SessionRecord,
} from "@shared/internalControls";
import type {
  AiTaskRoute,
  ConstrainedSearchResult,
  DocumentInboxRow,
  EvidenceSuggestion,
} from "@shared/assistiveAutomation";
import type {
  McpAuditEvent,
  McpMirrorStatus,
  McpRefreshRequest,
  McpScope,
  McpTokenSummary,
} from "@shared/mcp";
import type {
  AutomationRun,
  AutomationSchedule,
  ExtensionReportResult,
  InstalledPlugin,
  WebhookEndpointSummary,
  WebhookOutboxEvent,
} from "@shared/integrations";
import type {
  EcommerceOrder,
  EcommerceOrderReview,
  LogisticsFormat,
  SettlementInput,
  SettlementReview,
  ShipmentInput,
} from "@shared/integrationAdapters";
import type {
  BackupDestination,
  BackupRotationPolicy,
  BackupSpaceForecast,
  RecoveryDrill,
} from "@shared/resilience";
import type { Gstr1Result, Gstr3bResult } from "@shared/gst/returns";
import type { GstIssue } from "@shared/gst/validate";
import type { Recon2bResult } from "@shared/gst/recon2b";
import type {
  AgentExportInput,
  AuditListInput,
  BankRuleInput,
  BatchInput,
  BomInput,
  BudgetInput,
  ChequeConfig,
  CompanyCreateInput,
  CostCentreInput,
  CurrencyInput,
  EmployeeHeadsSetInput,
  EmployeeInputPayload,
  GodownInput,
  GroupInput,
  Gst3bManualInput,
  LedgerInput,
  NicCredentials,
  PayHeadInput,
  PriceLevelInput,
  PriceRateInput,
  RecurringInput,
  RendererLogInput,
  StockGroupInput,
  StockItemInput,
  TdsSectionInput,
  UnitInput,
  UserInput,
  VoucherTransportInput,
  VoucherTypeInput,
  VoucherInputParsed,
} from "@shared/schemas";
import type { CompanyFeatures } from "@shared/features";
import type { SearchHit } from "@shared/search";
import type { InvoiceConfig } from "@shared/invoiceConfig";
import type { CloseLedgerRow } from "@shared/yearEnd";
import type { ConsolidatedResult } from "@shared/consolidate";
import type { Registry } from "../types";
import type {
  AiAnswer,
  AiContextFieldId,
  AiContextPreview,
  AiProviderConfig,
  AiProviderInput,
} from "@shared/ai";
import type { MonthCloseStatus } from "@shared/monthClose";
import type {
  CollectionCustomerSettings,
  CollectionCustomerWorkspace,
  CollectionPromise,
  CollectionQueueRow,
  ReceiptSuggestion,
} from "@shared/collections";
import type {
  PaymentAccount,
  PaymentRun,
  PaymentRunBillInput,
  PaymentRunPreview,
  SupplierAdvanceRow,
  SupplierDueQueue,
} from "@shared/payables";
import type {
  PersonalTask,
  PersonalTaskInput,
  TaskStatus,
} from "@shared/tasks";
import type { VoucherComment } from "@shared/voucherComments";
import type {
  VoucherWorkDraft,
  VoucherWorkDraftInput,
} from "@shared/voucherDrafts";
import type {
  SalesDocument,
  SalesDocumentConversionInput,
  SalesDocumentConversionResult,
  SalesDocumentInput,
  SalesDocumentKind,
  SalesDocumentNumberPreview,
  SalesDocumentSeries,
  SalesDocumentSeriesInput,
  SalesDocumentStatus,
} from "@shared/salesDocuments";
import type {
  SalesDiscountPolicy,
  SalesDiscountPolicyInput,
  SalesRecurringBatch,
  SalesRecurringPreview,
  SalesRecurringSchedule,
  SalesRecurringScheduleInput,
} from "@shared/salesBilling";
import type {
  CustomerPortalBundle,
  SalesCustomerAssignment,
  SalesCustomFieldDefinition,
  SalesCustomFieldInput,
  SalesReturnCandidate,
  SalesReturnDraftInput,
  SalesTerritory,
  SubscriptionContract,
  SubscriptionContractInput,
  TerritorySalesRow,
  WarrantyClaim,
} from "@shared/customerOperations";
import type { VoucherEntryTemplate } from "@shared/entryTemplates";
import type {
  GoodsReceipt,
  GoodsReceiptInput,
  InvoiceMatchCandidate,
  InvoiceMatchInput,
  InvoiceMatchPreview,
  ProcurementDebitNoteClaim,
  PurchaseOrder,
  PurchaseOrderInput,
  PurchaseRequisition,
  ReorderSuggestion,
  RequisitionInput,
  RequisitionStatus,
  SupplierComparisonRow,
  SupplierConcentrationReport,
  SupplierPriceHistoryRow,
  VendorProfile,
  VendorProfileInput,
} from "@shared/procurement";
import type {
  ManagementScenario,
  ManagementScenarioInput,
  ReportAnnotation,
  ScenarioProjection,
  ScheduleIiiMapping,
  ScheduleIiiStatement,
  VarianceExplanation,
} from "@shared/management";
import type {
  DailyCashPosition,
  LiquidityScenario,
  LiquidityScenarioInput,
  TreasuryAlert,
  TreasuryAlertSettings,
  TreasuryForecast,
} from "@shared/treasury";
import type { PayrollPreflight, PayrollTieOut } from "@shared/payrollOps";
import type {
  AcceptanceResolution,
  OutboundDraftInput,
  OutboundDraftUpdate,
  OutboundMessage,
  OutboundMessageEvent,
  OutboundMessageStatus,
  PartyContact,
  PartyContactInput,
  SmtpProfileInput,
  SmtpProfileSummary,
  SmtpProfileUpdate,
} from "@shared/communications";
import type {
  DepartmentPayrollRow,
  ProvisioningKind,
  ProvisioningPreview,
  ShiftAssignment,
  ShiftRule,
  StatutoryKind,
  StatutoryWorkspaceRow,
  WorkforceHoliday,
} from "@shared/workforceOps";
import type {
  AttendanceImportPreview,
  AttendanceInput,
  AttendanceMonthSummary,
  AttendanceRecord,
  Contractor,
  ContractorPayment,
  EmployeeLoan,
  EmployeeReimbursement,
  FinalSettlement,
  FinalSettlementPreview,
  LeaveBalance,
  LeaveTransaction,
  LeaveType,
  SalaryRevision,
} from "@shared/workforce";
import type {
  BomVersion,
  DemandOverride,
  InventoryActionItem,
  InventoryPlannerRow,
  InventoryPlanningInput,
  InventorySerial,
  LandedCostAllocation,
  ManufacturingOrder,
  StockCountSession,
  StockReservation,
  StockTransfer,
} from "@shared/inventoryControl";

export type Role = "owner" | "accountant" | "viewer";

export interface SessionUser {
  id: number;
  name: string;
  role: Role;
}

export interface LoginName {
  id: number;
  name: string;
  role: Role;
}

/** Mirrors src/main/db/backup.ts's BackupInfo shape (kept local — that file is main-process only). */
export interface BackupInfo {
  file: string;
  sizeBytes: number;
  mtime: number;
  tag: string;
}

export interface BackupPreview {
  valid: boolean;
  integrity: "ok" | "failed";
  detail: string;
  company: { name: string; booksFrom: number; stateCode: string } | null;
  schemaVersion: number | null;
  firstVoucherDate: string | null;
  lastVoucherDate: string | null;
  voucherCount: number | null;
  sizeBytes: number;
}

/** Mirrors src/main/db/integrity.ts's IntegrityResult shape (kept local — main-process only). */
export interface IntegrityResult {
  ok: boolean;
  quickCheck: string;
  unbalancedVoucherIds: number[];
}

export interface SystemHealthSummary {
  quickCheck: string;
  databaseBytes: number;
  walBytes: number;
  pageBytes: number;
  reclaimableBytes: number;
  schemaVersion: number;
  journalMode: string;
  freeBytes: number;
  diskState: "healthy" | "warning" | "critical";
  riskyImportsAllowed: boolean;
  workload: {
    active: Record<"report" | "export" | "document" | "maintenance", number>;
    queued: Record<"report" | "export" | "document" | "maintenance", number>;
    completed: number;
    cancelled: number;
    peakQueued: number;
    recent: Array<{
      kind: "report" | "export" | "document" | "maintenance";
      queuedMs: number;
      durationMs: number;
      outcome: "completed" | "failed" | "cancelled";
      at: string;
    }>;
  };
}

export interface RecoveryCopyResult {
  success: boolean;
  detail: string;
  preservedFolder: string;
  recoveredBackup: string | null;
}

export interface AgentProposal {
  version: 1;
  id: string;
  createdAt: string;
  source: "mcp" | "ai" | "external";
  status: "pending";
  summary: string;
  voucher: unknown;
}

export interface GstReturnStatus {
  registrationId: number | null;
  returnType: "gstr1" | "gstr3b";
  period: string;
  from: string;
  to: string;
  status: "not_prepared" | "prepared" | "filed";
  frozenAt: string | null;
  changedSinceFreeze: boolean;
  filedAt: string | null;
  arn: string | null;
  hasSubmittedJson: boolean;
}

/** Mirrors src/main/services/vouchers.ts's BinRow shape (kept local — that file is main-process only). */
export interface BinRow {
  id: number;
  date: string;
  number: string;
  voucherType: string;
  account: string;
  amount: number;
  deletedAt: string;
}

/** Mirrors src/main/services/users.ts's User shape (kept local — that file is main-process only). */
export interface UserRow {
  id: number;
  name: string;
  role: Role;
  active: boolean;
  createdAt: string;
  accessExpiresAt: string | null;
}

export interface ApprovalPolicy {
  enabled: boolean;
  thresholdPaise: number | null;
  voucherTypeIds: number[];
  expenseEnabled: boolean;
  expenseThresholdPaise: number | null;
}

export interface ApprovalRequest {
  id: number;
  status: "pending" | "approved" | "rejected";
  makerUserId: number;
  makerName: string;
  checkerUserId: number | null;
  checkerName: string | null;
  targetVoucherId: number | null;
  postedVoucherId: number | null;
  summary: string;
  amount: number;
  payload: VoucherInputParsed;
  decisionNote: string | null;
  createdAt: string;
  reviewedAt: string | null;
  requestKind: "voucher" | "expense";
  expenseLedgers: string[];
  departments: string[];
}

export type VoucherSaveResult =
  | ((Voucher & { duplicateNumber?: boolean }) & { approvalRequired: false })
  | { approvalRequired: true; request: ApprovalRequest };

export type PermissionAction =
  "view" | "create" | "edit" | "approve" | "export" | "backup" | "settings";
export type PermissionMatrix = Record<Role, Record<PermissionAction, boolean>>;

/** Mirrors src/main/services/audit.ts's AuditRow shape (kept local — that file is main-process only). */
export interface AuditRow {
  id: number;
  entity: string;
  entityId: number;
  action:
    | "create"
    | "update"
    | "delete"
    | "login"
    | "login_failed"
    | "logout"
    | "export"
    | "import";
  at: string;
  beforeJson: string | null;
  afterJson: string | null;
  userName: string | null;
  appVersion: string | null;
}
export interface AuditIntegrityStatus {
  ok: boolean;
  rowsChecked: number;
  firstBrokenId: number | null;
  reason:
    | "anchor_mismatch"
    | "previous_hash_mismatch"
    | "row_hash_mismatch"
    | "head_mismatch"
    | null;
  verifiedAt: string;
  headHash: string;
}

/** Mirrors src/main/services/banking.ts's BankRuleRecord shape (kept local — main-process only). */
export interface BankRuleRecord {
  id: number;
  pattern: string;
  matchField: string;
  ledgerId: number;
  ledgerName: string;
  kind: "payment" | "receipt";
  minAmount: number | null;
  maxAmount: number | null;
  autoApply: boolean;
  active: boolean;
  hits: number;
  confidenceBp: number;
  reviewedHits: number;
  rejectedHits: number;
  source: "manual" | "learned";
  rolledBackAt: string | null;
  bankLedgerId: number | null;
  bankLedgerName: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  narrationTemplate: string | null;
}

/** Mirrors src/main/services/banking.ts's BankVoucherDraft / BankSuggestionRow / UnmatchedRow /
 *  BankMatchSuggestion / ImportResult / BrsReport shapes (kept local — main-process only). */
export interface BankVoucherDraft {
  date: string;
  narration: string;
  lines: { ledgerId: number; drCr: "dr" | "cr"; amount: number }[];
}

export interface BankUnmatchedRow {
  rowNo: number;
  date: string;
  description: string;
  reference: string;
  amount: number;
  kind: "deposit" | "withdrawal";
}

export interface BankSuggestionRow {
  statementRow: BankUnmatchedRow;
  suggestion: {
    ruleId: number;
    ledgerId: number;
    ledgerName: string;
    kind: "payment" | "receipt";
    voucherDraft: BankVoucherDraft;
  } | null;
}

export interface BankMatchSuggestion {
  statementRow: BankUnmatchedRow;
  kind: "tolerance" | "many_to_one";
  lines: {
    lineId: number;
    voucherId: number;
    date: string;
    number: string;
    amount: number;
  }[];
}

export interface BankImportResult {
  importId: number | null;
  openingBalance: number | null;
  closingBalance: number | null;
  statementRows: number;
  matched: number;
  alreadyReconciled: number;
  unmatched: BankUnmatchedRow[];
  matches: {
    date: string;
    description: string;
    amount: number;
    kind: "deposit" | "withdrawal";
    lineId: number;
  }[];
  autoCreated: {
    date: string;
    description: string;
    amount: number;
    kind: "deposit" | "withdrawal";
    voucherId: number;
    ruleId: number;
  }[];
}

export interface BankReconciliationWorkspace {
  ledgerId: number;
  ledgerName: string;
  latestImport: null | {
    id: number;
    format: "csv" | "xlsx" | "ofx" | "qif" | "mt940";
    fileName: string | null;
    periodFrom: string;
    periodTo: string;
    importedBy: string;
    importedAt: string;
    openingBalance: number | null;
    closingBalance: number | null;
  };
  statementOpeningBalance: number | null;
  bookOpeningBalance: number;
  openingDifference: number | null;
  counts: {
    matched: number;
    bankOnly: number;
    bookOnly: number;
    ignored: number;
    timingDifference: number;
  };
  statementRows: {
    id: number;
    rowNo: number;
    date: string;
    description: string;
    reference: string;
    direction: "deposit" | "withdrawal";
    amount: number;
    runningBalance: number | null;
    status: "bank_only" | "matched" | "ignored" | "timing_difference";
    matchedLineId: number | null;
    createdVoucherId: number | null;
    note: string | null;
    reviewedBy: string | null;
    reviewedAt: string | null;
  }[];
  bookOnlyRows: {
    lineId: number;
    voucherId: number;
    date: string;
    number: string;
    particulars: string;
    direction: "deposit" | "withdrawal";
    amount: number;
  }[];
}

export interface BankTransferSuggestion {
  withdrawalRowId: number;
  depositRowId: number;
  amount: number;
  withdrawalDate: string;
  depositDate: string;
  fromLedgerId: number;
  fromLedgerName: string;
  toLedgerId: number;
  toLedgerName: string;
  reference: string;
  description: string;
  confidence: number;
}

export interface BankChargeSuggestion {
  statementRowId: number;
  settlementLineId: number;
  bankLedgerId: number;
  bankLedgerName: string;
  date: string;
  description: string;
  netAmount: number;
  grossBookAmount: number;
  deductionAmount: number;
  suggestedFeeAmount: number;
  suggestedTaxAmount: number;
  voucherId: number;
  voucherNumber: string;
  confidence: number;
}

export interface ChequeLifecycleRow {
  voucherId: number;
  date: string;
  number: string;
  voucherKind: "payment" | "receipt";
  instrumentNo: string;
  instrumentDate: string | null;
  bankLedgerId: number;
  bankLedgerName: string;
  partyName: string;
  amount: number;
  status:
    "issued" | "deposited" | "cleared" | "bounced" | "cancelled" | "stale";
  statusDate: string;
  note: string | null;
  updatedBy: string | null;
}

export interface CashDenomination {
  denominationPaise: number;
  count: number;
}
export interface CashCountSession {
  id: number;
  date: string;
  cashLedgerId: number;
  cashLedgerName: string;
  denominations: CashDenomination[];
  physicalTotal: number;
  bookBalance: number;
  difference: number;
  status: "draft" | "posted" | "cancelled";
  note: string | null;
  countedBy: string;
  countedAt: string;
  postedBy: string | null;
  postedAt: string | null;
  adjustmentVoucherId: number | null;
}

export type PaymentFileFormat = "generic_neft" | "hdfc_bulk" | "icici_bulk";
export interface PaymentFilePreview {
  runId: number;
  format: PaymentFileFormat;
  totalAmount: number;
  rows: {
    partyLedgerId: number;
    beneficiaryName: string;
    bankAccount: string;
    ifsc: string;
    amount: number;
    reference: string;
  }[];
  blockers: string[];
}

export interface BankFeedConnection {
  id: number;
  bankLedgerId: number;
  bankLedgerName: string;
  provider: "custom_open_banking";
  displayName: string;
  endpoint: string;
  consentScope: "statements.read";
  consentExpiresAt: string;
  status: "connected" | "paused" | "revoked";
  lastSyncAt: string | null;
  lastError: string | null;
  hasCredential: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface BrsItem {
  lineId: number;
  voucherId: number;
  date: string;
  voucherType: string;
  number: string;
  particulars: string;
  instrumentNo: string | null;
  amount: number;
}

export interface BrsReport {
  ledgerId: number;
  ledgerName: string;
  asOn: string;
  bookBalance: number;
  uncredited: BrsItem[];
  uncreditedTotal: number;
  unpresented: BrsItem[];
  unpresentedTotal: number;
  bankBalance: number;
}

/** Mirrors src/main/services/payroll.ts's PayHead / EmployeeHeadRow / PtSummaryRow shapes (kept
 *  local — that file is main-process only). */
export interface PayHead {
  id: number;
  name: string;
  kind: "earning" | "deduction";
  calc: "flat" | "percent_of_basic";
  /** Paise for 'flat'; percent × 100 (4000 = 40%) for 'percent_of_basic'. */
  value: number;
  active: boolean;
}

export interface EmployeeHeadRow {
  payHeadId: number;
  name: string;
  kind: "earning" | "deduction";
  calc: "flat" | "percent_of_basic";
  value: number;
  overrideValue: number | null;
}

export interface PtSummaryRow {
  state: string;
  employees: number;
  gross: number;
  pt: number;
}

/** Mirrors src/main/services/tds.ts's TdsSuggestion shape (kept local — that file is main-process only). */
export interface TdsSuggestion {
  sectionId: number;
  code: string;
  rate: number;
  tdsPaise: number;
  payableLedgerId: number;
  panAvailable: boolean;
  thresholdCrossed: boolean;
}

/** Mirrors src/main/services/tds.ts's TdsSummaryRow shape (kept local — that file is main-process only). */
export interface TdsSummaryRow {
  sectionCode: string;
  quarter: string;
  deductees: number;
  base: number;
  tds: number;
}

export interface Gst2bImportRow {
  id: number;
  period: string;
  sourceHash: string;
  fileName: string | null;
  toleranceValue: number;
  toleranceTax: number;
  summary: Recon2bResult["buckets"];
  importedBy: string;
  importedAt: string;
}
export interface ItcActionRow {
  id: number;
  importId: number;
  period: string;
  sourceKey: string;
  bucket: string;
  classification:
    "missing" | "mismatched" | "blocked" | "reversed" | "follow_up";
  status: "open" | "waiting_supplier" | "resolved" | "dismissed";
  owner: string | null;
  dueDate: string | null;
  note: string | null;
  voucherId: number | null;
  portal: Record<string, unknown> | null;
  book: Record<string, unknown> | null;
  updatedBy: string;
  updatedAt: string;
}
export interface EdocEvent {
  id: number;
  voucherId: number;
  kind: "einvoice" | "eway";
  status:
    | "pending"
    | "generated"
    | "failed"
    | "cancelled"
    | "extended"
    | "vehicle_updated"
    | "expired";
  requestKey: string | null;
  documentNo: string | null;
  validUntil: string | null;
  vehicleNo: string | null;
  reason: string | null;
  actor: string;
  occurredAt: string;
}
export interface TdsChallan {
  id: number;
  fyStartYear: number;
  quarter: number;
  bsrCode: string;
  challanSerial: string;
  depositDate: string;
  amount: number;
  note: string | null;
  createdBy: string;
  createdAt: string;
}
export interface TdsWorkspace {
  fyStartYear: number;
  quarter: 1 | 2 | 3 | 4;
  deducted: number;
  deposited: number;
  difference: number;
  sections: TdsSummaryRow[];
  challans: TdsChallan[];
  returnStatus: {
    status: "draft" | "prepared" | "filed" | "revised";
    token: string | null;
    filedAt: string | null;
    note: string | null;
    updatedBy: string | null;
    updatedAt: string | null;
  };
}
export interface ComplianceObligation {
  id: number;
  stableKey: string;
  kind: "gst" | "tds" | "pf" | "esi" | "advance-tax" | "state" | "custom";
  title: string;
  dueDate: string;
  status: "open" | "in_progress" | "filed" | "paid" | "not_applicable";
  owner: string | null;
  note: string | null;
  source: "statutory" | "custom";
  updatedBy: string;
  updatedAt: string;
}
export interface GstRegistration {
  id: number;
  gstin: string;
  legalName: string;
  stateCode: string;
  address: string;
  registrationType: "regular" | "composition";
  isPrimary: boolean;
  active: boolean;
  invoicePrefix: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
export interface GstRegistrationSeries {
  id: number;
  registrationId: number;
  voucherTypeId: number;
  voucherTypeName: string;
  prefix: string;
  suffix: string;
  padWidth: number;
  restartFy: boolean;
}
export interface LutAuthorization {
  id: number;
  registrationId: number;
  registrationGstin: string;
  fyStartYear: number;
  arn: string;
  filedDate: string;
  validFrom: string;
  validTo: string;
  note: string | null;
  createdBy: string;
  createdAt: string;
}
export interface TaxContentPack {
  id: number;
  packKey: string;
  version: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  title: string;
  content: Record<string, unknown>;
  sourceUrl: string | null;
  installedBy: string;
  installedAt: string;
  active: boolean;
}

/** Mirrors src/main/services/costCentres.ts's CcReportRow shape (kept local — that file is main-process only). */
export interface CcReportRow {
  costCentreId: number;
  name: string;
  income: number;
  expense: number;
  net: number;
}

/** Mirrors src/main/services/costCentres.ts's CcStatementRow shape (kept local — that file is main-process only). */
export interface CcStatementRow {
  date: string;
  voucherId: number;
  number: string;
  ledgerName: string;
  drCr: "dr" | "cr";
  amount: number;
}

/** Mirrors src/main/services/importers.ts's ImportKind/ImportPreview/ImportResult shapes (kept
 *  local — that file is main-process only). */
export type ImportKind =
  | "ledgers"
  | "items"
  | "openings"
  | "generic_journal"
  | "busy"
  | "zoho_books"
  | "marg";
export interface MappingProfile {
  id: number;
  name: string;
  sourceKind: "generic" | "busy" | "zoho_books" | "marg";
  targetKind: "ledgers" | "items" | "openings" | "generic_journal";
  fieldMappings: Record<string, string>;
  valueMappings: Record<string, Record<string, string>>;
  dateFormat: string;
  active: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
export interface MigrationDryRun {
  sourceRows: number;
  acceptedRows: number;
  unsupportedColumns: string[];
  duplicateRisk: "none" | "updates" | "already_imported";
  manualCleanup: string[];
  estimatedVouchers: number;
  profileName: string;
}

export interface ImportReconciliation {
  sourceRows: number;
  parsedRows: number;
  acceptedRows: number;
  rejectedRows: number;
  sourceAmount: number;
  acceptedAmount: number;
  rejectedAmount: number;
  rowsAccountedFor: boolean;
  amountsAccountedFor: boolean;
}

export interface ImportPreview {
  rows: Record<string, unknown>[];
  total: number;
  willCreate: number;
  willUpdate: number;
  errors: { line: number; message: string }[];
  reconciliation: ImportReconciliation;
  sourceHash: string;
  alreadyImported: { id: number; appliedAt: string } | null;
}

export interface ImportResult {
  created: number;
  updated: number;
  errors: { line: number; message: string }[];
  reconciliation: ImportReconciliation;
  sourceHash: string;
  batchId: number;
}

export interface MigrationCertificateExport {
  jsonPath: string;
  pdfPath: string;
  contentSha256: string;
  status: "internal_checks_passed" | "attention_required";
  signaturePaths?: { json: string; pdf: string };
}

/** Invoke a main-process channel; throws the error message on failure. */
/** Mirrors src/main/services/reportHtml.ts's ReportColumnSpec/ReportRowSpec shapes (kept local —
 *  that file is main-process only). Shared by every screen's PDF/CSV export buttons. */
export interface ReportColumn {
  label: string;
  align: "l" | "r" | "c";
  width?: number;
}
export interface ReportRow {
  cells: string[];
  bold?: boolean;
  indent?: number;
  rule?: boolean;
}
export interface ReportPdfInput {
  title: string;
  periodLabel: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  footNote?: string;
  provenance: ReportProvenance;
  filename: string;
  /** Landscape orientation for wide reports (lane Q #95); defaults to portrait. */
  landscape?: boolean;
}
export interface ReportProvenance {
  period: string;
  accountingBasis: string;
  dataFreshness: string;
  generatedAt: string;
}

/** Mirrors src/main/services/tallyImport.ts's ImportSummary shape (kept local — main-process only). */
export interface TallyImportSummary {
  groups: number;
  ledgers: number;
  units: number;
  items: number;
  vouchers: number;
  skipped: number;
  warnings: string[];
  batchId?: number;
  sourceHash?: string;
  alreadyImported?: { id: number; appliedAt: string } | null;
}

/** Mirrors src/main/services/stockAnalysis.ts's row shapes (kept local — main-process only). */
export interface GodownStockRow {
  godownId: number | null;
  godownName: string;
  stockItemId: number;
  name: string;
  unitSymbol: string;
  decimals: number;
  closingQtyMilli: number;
  closingValue: number;
}

export interface BatchStockRow {
  batchId: number;
  batchName: string;
  stockItemId: number;
  itemName: string;
  unitSymbol: string;
  decimals: number;
  mfgDate: string | null;
  expiryDate: string | null;
  closingQtyMilli: number;
}

export interface StockMovementTrailRow {
  lineId: number;
  voucherId: number;
  date: string;
  voucherType: string;
  number: string;
  partyName: string | null;
  godownName: string | null;
  batchName: string | null;
  direction: "in" | "out";
  isAbsolute: boolean;
  qtyMilli: number;
  amount: number;
  runningQtyMilli: number;
  runningValue: number;
  consumedValue: number;
}

export interface StockValuationReconciliation {
  asOn: string;
  inventoryValue: number;
  financialStatementValue: number;
  difference: number;
  mode: "computed_closing_stock" | "stock_ledger_balance";
  carryingLedgerCount: number;
}

export interface ExpiryAgeingRow extends BatchStockRow {
  bucket: "none" | "expired" | "within30" | "within90" | "later";
}

/** Mirrors priceLevels.PriceRateRow (main-process only). */
export interface PriceRateRow extends PriceListRate {
  itemName: string;
  unitSymbol: string;
}

/** Mirrors vouchers.PdcRow (main-process only). */
export interface PdcRow {
  id: number;
  date: string;
  number: string;
  voucherTypeName: string;
  partyName: string | null;
  instrumentNo: string | null;
  instrumentDate: string | null;
  amount: number;
}

export type SupportCategory = "question" | "bug" | "idea" | "accessibility";
export type SupportCaseStatus =
  "draft" | "sending" | "submitted" | "failed" | "saved_offline";
export interface SupportConsent {
  message: boolean;
  diagnostics: boolean;
  logs: boolean;
  companyMetadata: boolean;
  focusContext: boolean;
  screenshot: boolean;
}
export interface SupportCaseRecord {
  id: string;
  category: SupportCategory;
  status: SupportCaseStatus;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  consent: SupportConsent;
  lastError: string | null;
}
export interface SupportFocusContext {
  tag: string;
  role: string | null;
  name: string;
  testId: string | null;
  screen: string | null;
}
export interface SupportContextPreview {
  logs: { ts: string; level: string; event: string; version: string }[];
  company: {
    name: string;
    stateCode: string;
    gstRegistrationType: string;
    schemaVersion: number;
    voucherCount: number;
    enabledFeatures: string[];
  } | null;
}
export interface SupportPayload {
  caseId: string;
  category: SupportCategory;
  email: string;
  message: string;
  includeMessage: boolean;
  includeDiagnostics: boolean;
  includeLogs: boolean;
  includeCompanyMetadata: boolean;
  focusContext: SupportFocusContext | null;
  screenshotDataUrl: string | null;
}
export interface FeedbackIdea {
  id: string;
  title: string;
  detail: string;
  status: "considering" | "planned" | "building" | "released";
  votes: number;
  releaseVersion: string | null;
}
export interface CrashEnvelope {
  id: string;
  timestamp: string;
  kind: "renderer" | "main_exception" | "main_rejection" | "renderer_gone";
  appVersion: string;
  platform: string;
  arch: string;
  screen: string | null;
  fingerprint: string;
  message: string;
  stackFrames: string[];
}

export type BusinessType =
  | "retailer"
  | "wholesaler"
  | "service"
  | "manufacturer"
  | "freelancer"
  | "professional";
export type PriorSoftware =
  "tally" | "busy" | "marg" | "zoho" | "excel" | "first-time";
export interface OnboardingSelection {
  businessType: BusinessType;
  priorSoftware: PriorSoftware;
  needsInventory: boolean;
  needsPayroll: boolean;
}
export interface OnboardingStatus {
  profile: OnboardingSelection & {
    schema: 1;
    createdAt: string;
    setupSteps: Record<string, boolean>;
  };
  score: number;
  openingDifference: number;
  openingRows: { id: number; name: string; openingBalance: number }[];
  missing: string[];
}
export interface VoucherAttachment {
  id: number;
  voucherId: number;
  originalName: string;
  kind: "invoice" | "receipt" | "email" | "delivery" | "other";
  sizeBytes: number;
  addedBy: string;
  createdAt: string;
}
export interface SmartLedgerDefaults {
  sourceVoucherId: number;
  narration: string | null;
  billBehavior: "against" | "advance" | "none";
  taxLedgerIds: number[];
  costAllocations: { ledgerId: number; costCentreId: number }[];
}

export const api = {
  company: {
    list: () => call<Registry>("company:list"),
    create: (
      input: CompanyCreateInput & { onboarding?: OnboardingSelection },
    ) => call<{ slug: string }>("company:create", input),
    createDemo: (businessType: BusinessType = "retailer") =>
      call<{ slug: string }>("company:createDemo", businessType),
    remove: (slug: string, confirmName: string, pin?: string) =>
      call<null>("company:delete", { slug, confirmName, pin }),
    open: (slug: string) =>
      call<{
        slug: string;
        info: CompanyInfo;
        integrity: IntegrityResult;
        locked: boolean;
      }>("company:open", { slug }),
    close: () => call<null>("company:close"),
    current: () =>
      call<{ slug: string; info: CompanyInfo; locked: boolean } | null>(
        "company:current",
      ),
    updateInfo: (input: CompanyCreateInput) =>
      call<CompanyInfo>("company:updateInfo", input),
    backup: () => call<{ path: string }>("company:backup"),
    revealExports: () => call<null>("company:revealExports"),
    lockGet: () => call<{ date: string | null }>("company:lock:get"),
    lockSet: (date: string | null, exceptionId?: number) =>
      call<{ date: string | null }>("company:lock:set", { date, exceptionId }),
  },
  onboarding: {
    preflight: () =>
      call<{
        writable: boolean;
        freeBytes: number;
        diskReady: boolean;
        clockReady: boolean;
        secureCredentials: boolean;
        automaticBackups: boolean;
        dataPath: string;
      }>("onboarding:preflight"),
    status: () => call<OnboardingStatus>("onboarding:status"),
    update: (input: Partial<OnboardingSelection>) =>
      call<OnboardingStatus>("onboarding:update", input),
    exportHandoff: () => call<{ path: string }>("onboarding:handoff:export"),
    importHandoff: () =>
      call<OnboardingStatus | null>("onboarding:handoff:import"),
  },
  backups: {
    list: () => call<BackupInfo[]>("backup:list"),
    run: () => call<{ path: string }>("backup:run"),
    preview: (file: string) => call<BackupPreview>("backup:preview", { file }),
    restore: (file: string) =>
      call<{ info: CompanyInfo; integrity: IntegrityResult; locked: boolean }>(
        "backup:restore",
        { file },
      ),
    exportEncrypted: (passphrase: string) =>
      call<{
        path: string;
        sizeBytes: number;
        entries: number;
        attachments: number;
      }>("backup:exportEncrypted", { passphrase }),
    importEncrypted: (passphrase: string) =>
      call<{
        slug: string;
        name: string;
        format: "complete" | "legacy-db";
        attachmentsRestored: number;
      } | null>("backup:importEncrypted", { passphrase }),
    destinations: () => call<BackupDestination[]>("backup:destinations:list"),
    addDestination: (name: string) =>
      call<BackupDestination | null>("backup:destinations:add", { name }),
    setDestinationActive: (id: number, active: boolean) =>
      call<BackupDestination>("backup:destinations:setActive", { id, active }),
    drills: () =>
      call<{ due: boolean; rows: RecoveryDrill[] }>("backup:drills:list"),
    runDrill: (destinationId?: number | null) =>
      call<RecoveryDrill>("backup:drills:run", { destinationId }),
    rotation: () =>
      call<{ policy: BackupRotationPolicy; forecast: BackupSpaceForecast }>(
        "backup:rotation:get",
      ),
    setRotation: (
      input: Omit<BackupRotationPolicy, "updatedBy" | "updatedAt">,
    ) =>
      call<{ policy: BackupRotationPolicy; forecast: BackupSpaceForecast }>(
        "backup:rotation:set",
        input,
      ),
  },
  groups: {
    list: () => call<Group[]>("master:groups:list"),
    tree: () => call<GroupTreeNode[]>("master:groups:tree"),
    create: (data: GroupInput) => call<Group>("master:groups:create", data),
    update: (id: number, data: GroupInput) =>
      call<Group>("master:groups:update", { id, data }),
    remove: (id: number) => call<null>("master:groups:delete", { id }),
  },
  ledgers: {
    list: () => call<Ledger[]>("master:ledgers:list"),
    create: (data: LedgerInput) => call<Ledger>("master:ledgers:create", data),
    update: (id: number, data: LedgerInput) =>
      call<Ledger>("master:ledgers:update", { id, data }),
    remove: (id: number) => call<null>("master:ledgers:delete", { id }),
    balances: (asOn: string) =>
      call<LedgerBalanceRow[]>("master:ledgerBalances", { asOn }),
  },
  communications: {
    contacts: {
      list: (ledgerId: number, includeInactive = false) =>
        call<PartyContact[]>("communications:contacts:list", {
          ledgerId,
          includeInactive,
        }),
      save: (data: PartyContactInput, id?: number) =>
        call<PartyContact>("communications:contacts:save", { id, data }),
      remove: (id: number) =>
        call<null>("communications:contacts:delete", { id }),
    },
    smtp: {
      list: () => call<SmtpProfileSummary[]>("communications:smtp:list"),
      create: (data: SmtpProfileInput) =>
        call<SmtpProfileSummary>("communications:smtp:create", data),
      update: (id: number, data: SmtpProfileUpdate) =>
        call<SmtpProfileSummary>("communications:smtp:update", { id, data }),
      remove: (id: number) => call<null>("communications:smtp:delete", { id }),
      test: (id: number) =>
        call<{ ok: true; serverResponse: string }>("communications:smtp:test", {
          id,
        }),
    },
    messages: {
      list: (
        filter: {
          ledgerId?: number;
          status?: OutboundMessageStatus;
          limit?: number;
        } = {},
      ) => call<OutboundMessage[]>("communications:messages:list", filter),
      get: (id: string) =>
        call<OutboundMessage>("communications:messages:get", { id }),
      events: (id: string) =>
        call<OutboundMessageEvent[]>("communications:messages:events", { id }),
      createDraft: (data: OutboundDraftInput) =>
        call<OutboundMessage>("communications:messages:createDraft", data),
      updateDraft: (id: string, data: OutboundDraftUpdate) =>
        call<OutboundMessage>("communications:messages:updateDraft", {
          id,
          data,
        }),
      review: (id: string, expectedRevision: number) =>
        call<OutboundMessage>("communications:messages:review", {
          id,
          expectedRevision,
        }),
      queue: (id: string, smtpProfileId: number) =>
        call<OutboundMessage>("communications:messages:queue", {
          id,
          smtpProfileId,
        }),
      deliver: (id: string) =>
        call<OutboundMessage>("communications:messages:deliver", { id }),
      resolveAcceptance: (id: string, resolution: AcceptanceResolution) =>
        call<OutboundMessage>("communications:messages:resolveAcceptance", {
          id,
          resolution,
        }),
      cancel: (id: string) =>
        call<OutboundMessage>("communications:messages:cancel", { id }),
      exportEml: (id: string, smtpProfileId?: number) =>
        call<{ path: string; message: OutboundMessage } | null>(
          "communications:messages:exportEml",
          { id, smtpProfileId },
        ),
    },
  },
  voucherTypes: {
    list: () => call<VoucherType[]>("master:voucherTypes:list"),
    create: (data: VoucherTypeInput) =>
      call<VoucherType>("master:voucherTypes:create", data),
    update: (id: number, data: VoucherTypeInput) =>
      call<VoucherType>("master:voucherTypes:update", { id, data }),
  },
  units: {
    list: () => call<Unit[]>("master:units:list"),
    create: (data: UnitInput) => call<Unit>("master:units:create", data),
  },
  stockGroups: {
    list: () => call<StockGroup[]>("master:stockGroups:list"),
    create: (data: StockGroupInput) =>
      call<StockGroup>("master:stockGroups:create", data),
  },
  stockItems: {
    list: () => call<StockItem[]>("master:stockItems:list"),
    create: (data: StockItemInput) =>
      call<StockItem>("master:stockItems:create", data),
    update: (id: number, data: StockItemInput) =>
      call<StockItem>("master:stockItems:update", { id, data }),
    remove: (id: number) => call<null>("master:stockItems:delete", { id }),
  },
  godowns: {
    list: () => call<Godown[]>("master:godowns:list"),
    create: (data: GodownInput) => call<Godown>("master:godowns:create", data),
    update: (id: number, data: GodownInput) =>
      call<Godown>("master:godowns:update", { id, data }),
    remove: (id: number) => call<null>("master:godowns:delete", { id }),
  },
  batches: {
    list: (stockItemId?: number) =>
      call<Batch[]>("master:batches:list", { stockItemId }),
    create: (data: BatchInput) => call<Batch>("master:batches:create", data),
  },
  stock: {
    summary: (asOn: string, godownId?: number) =>
      call<StockSummaryRow[]>("stock:summary", { asOn, godownId }),
    byGodown: (asOn: string) =>
      call<GodownStockRow[]>("stock:byGodown", { asOn }),
    batches: (asOn: string, stockItemId?: number) =>
      call<BatchStockRow[]>("stock:batches", { asOn, stockItemId }),
    expiry: (asOn: string) => call<ExpiryAgeingRow[]>("stock:expiry", { asOn }),
    negative: (asOn: string) =>
      call<NegativeStockWarning[]>("stock:negative", { asOn }),
    trail: (stockItemId: number, asOn: string) =>
      call<StockMovementTrailRow[]>("stock:trail", { stockItemId, asOn }),
    reconcile: (asOn: string) =>
      call<StockValuationReconciliation>("stock:reconcile", { asOn }),
  },
  inventoryControl: {
    planner: (asOn: string) =>
      call<InventoryPlannerRow[]>("inventory:planner", { asOn }),
    savePlanning: (data: InventoryPlanningInput) =>
      call<void>("inventory:planning:save", data),
    forecasts: () => call<DemandOverride[]>("inventory:forecast:list"),
    saveForecast: (data: {
      stockItemId: number;
      month: string;
      qtyMilli: number;
      reason: string;
    }) => call<DemandOverride>("inventory:forecast:save", data),
    actions: () => call<InventoryActionItem[]>("inventory:actions:list"),
    createAction: (data: {
      stockItemId: number;
      action: InventoryActionItem["action"];
      dueDate: string | null;
      owner: string | null;
      note: string | null;
    }) => call<InventoryActionItem>("inventory:actions:create", data),
    setActionStatus: (id: number, status: InventoryActionItem["status"]) =>
      call<InventoryActionItem>("inventory:actions:status", { id, status }),
    reservations: () => call<StockReservation[]>("inventory:reservations:list"),
    createReservation: (data: {
      stockItemId: number;
      godownId: number | null;
      batchId: number | null;
      qtyMilli: number;
      requiredDate: string;
      reference: string;
      customerLedgerId: number | null;
    }) => call<StockReservation>("inventory:reservations:create", data),
    setReservationStatus: (
      id: number,
      status: "fulfilled" | "released" | "expired",
    ) =>
      call<StockReservation>("inventory:reservations:status", { id, status }),
    counts: () => call<StockCountSession[]>("inventory:counts:list"),
    createCount: (data: {
      name: string;
      countDate: string;
      godownId: number;
      blindCount: boolean;
    }) => call<StockCountSession>("inventory:counts:create", data),
    saveCountLine: (data: {
      sessionId: number;
      lineId: number;
      countedQtyMilli: number;
      note: string | null;
    }) => call<StockCountSession>("inventory:counts:line", data),
    setCountStatus: (id: number, status: "review" | "posted" | "cancelled") =>
      call<StockCountSession>("inventory:counts:status", { id, status }),
    serials: (stockItemId?: number) =>
      call<InventorySerial[]>("inventory:serials:list", { stockItemId }),
    assignSerials: (data: {
      inventoryLineId: number;
      serials: {
        serialNo: string;
        warrantyUntil: string | null;
        note: string | null;
      }[];
    }) => call<InventorySerial[]>("inventory:serials:assign", data),
    transfers: () => call<StockTransfer[]>("inventory:transfers:list"),
    createTransfer: (data: {
      transferDate: string;
      fromGodownId: number;
      toGodownId: number;
      expectedArrival: string | null;
      note: string | null;
      lines: {
        stockItemId: number;
        batchId: number | null;
        qtyMilli: number;
      }[];
    }) => call<StockTransfer>("inventory:transfers:create", data),
    setTransferStatus: (
      id: number,
      status: "dispatched" | "received" | "cancelled",
    ) => call<StockTransfer>("inventory:transfers:status", { id, status }),
    bomVersions: (itemId?: number) =>
      call<BomVersion[]>("inventory:bomVersions:list", { itemId }),
    createBomVersion: (data: {
      itemId: number;
      version: string;
      effectiveFrom: string;
      effectiveTo: string | null;
      note: string | null;
      lines: {
        componentId: number;
        qtyMilliPerUnit: number;
        scrapPct: number;
      }[];
    }) => call<BomVersion>("inventory:bomVersions:create", data),
    activateBomVersion: (id: number) =>
      call<BomVersion>("inventory:bomVersions:activate", { id }),
    manufacturingOrders: () =>
      call<ManufacturingOrder[]>("inventory:manufacturing:list"),
    createManufacturingOrder: (data: {
      stockItemId: number;
      plannedQtyMilli: number;
      dueDate: string;
      godownId: number | null;
      bomVersionId: number | null;
      note: string | null;
    }) => call<ManufacturingOrder>("inventory:manufacturing:create", data),
    setManufacturingStatus: (
      id: number,
      status: "released" | "completed" | "cancelled",
    ) =>
      call<ManufacturingOrder>("inventory:manufacturing:status", {
        id,
        status,
      }),
    landedCosts: () =>
      call<LandedCostAllocation[]>("inventory:landedCosts:list"),
    addLandedCost: (data: {
      sourceVoucherId: number;
      inventoryLineId: number;
      costLedgerId: number | null;
      amount: number;
      method: LandedCostAllocation["method"];
      note: string | null;
    }) => call<LandedCostAllocation>("inventory:landedCosts:add", data),
    barcodeLabelsPdf: (items: { stockItemId: number; copies: number }[]) =>
      call<{ path: string }>("inventory:barcodeLabels:pdf", { items }),
  },
  priceLevels: {
    list: () => call<PriceLevel[]>("master:priceLevels:list"),
    create: (data: PriceLevelInput) =>
      call<PriceLevel>("master:priceLevels:create", data),
    update: (id: number, data: PriceLevelInput) =>
      call<PriceLevel>("master:priceLevels:update", { id, data }),
    remove: (id: number) => call<null>("master:priceLevels:delete", { id }),
    rates: (priceLevelId: number) =>
      call<PriceRateRow[]>("priceLevels:rates", { priceLevelId }),
    saveRate: (data: PriceRateInput) =>
      call<PriceListRate>("priceLevels:saveRate", data),
    deleteRate: (id: number) => call<null>("priceLevels:deleteRate", { id }),
    /** Rate in force for (level, item) on `date`, or null when no row applies. */
    rateFor: (priceLevelId: number, stockItemId: number, date: string) =>
      call<number | null>("priceLevels:rateFor", {
        priceLevelId,
        stockItemId,
        date,
      }),
  },
  pdc: {
    list: () => call<PdcRow[]>("pdc:list"),
    /** Flip one post-dated voucher into the books now (early clearance). */
    mature: (id: number) => call<null>("pdc:mature", { id }),
  },
  vouchers: {
    list: (from: string, to: string, voucherTypeId?: number) =>
      call<VoucherListRow[]>("voucher:list", { from, to, voucherTypeId }),
    get: (id: number) => call<Voucher | null>("voucher:get", { id }),
    save: (
      data: VoucherInputParsed,
      id?: number,
      draftId?: number,
      procurementMatch?: InvoiceMatchInput,
      procurementClaimKey?: string,
      creditOverrideReason?: string,
    ) =>
      call<VoucherSaveResult>("voucher:save", {
        data,
        id,
        draftId,
        procurementMatch,
        procurementClaimKey,
        creditOverrideReason,
      }),
    remove: (id: number) => call<null>("voucher:delete", { id }),
    batchTag: (ids: number[], tag: string) =>
      call<null>("voucher:batchTag", { ids, tag }),
    batchReview: (ids: number[]) => call<null>("voucher:batchReview", { ids }),
    comments: (id: number) =>
      call<VoucherComment[]>("voucher:comments", { id }),
    addComment: (id: number, body: string) =>
      call<VoucherComment>("voucher:commentAdd", { id, body }),
    smartDefaults: (partyLedgerId: number, kind: VoucherKind) =>
      call<SmartLedgerDefaults | null>("voucher:smartDefaults", {
        partyLedgerId,
        kind,
      }),
    creditExposure: (partyLedgerId: number, proposedDebit: number) =>
      call<{
        exceeded: boolean;
        ledgerName: string;
        creditLimit: number | null;
        currentOutstanding: number;
        proposedOutstanding: number;
      }>("voucher:creditExposure", { partyLedgerId, proposedDebit }),
    clipboardLines: () => call<{ text: string }>("voucher:clipboardLines"),
    attachments: (id: number) =>
      call<VoucherAttachment[]>("voucher:attachments", { id }),
    addAttachments: (id: number, kind: VoucherAttachment["kind"]) =>
      call<VoucherAttachment[]>("voucher:attachmentAdd", { id, kind }),
    openAttachment: (id: number) =>
      call<null>("voucher:attachmentOpen", { id }),
    batchReverse: (ids: number[], date: string, reason: string) =>
      call<Voucher[]>("voucher:batchReverse", { ids, date, reason }),
    nextNumber: (voucherTypeId: number, date: string, excludeId?: number) =>
      call<{ number: string }>("voucher:nextNumber", {
        voucherTypeId,
        date,
        excludeId,
      }),
    numberExists: (voucherTypeId: number, number: string, excludeId?: number) =>
      call<boolean>("voucher:numberExists", {
        voucherTypeId,
        number,
        excludeId,
      }),
    duplicates: (data: VoucherInputParsed, excludeId?: number) =>
      call<
        {
          voucherId: number;
          number: string;
          date: string;
          reasons: (
            "same_party_amount" | "same_reference" | "same_bill_reference"
          )[];
        }[]
      >("voucher:duplicates", { data, excludeId }),
    suspicious: (data: VoucherInputParsed) =>
      call<
        {
          code:
            | "future_date"
            | "round_amount"
            | "party_direction"
            | "tax_asymmetry";
          message: string;
        }[]
      >("voucher:suspicious", data),
    bin: () => call<BinRow[]>("voucher:bin"),
    restore: (id: number) => call<null>("voucher:restore", { id }),
    purge: (id: number) => call<null>("voucher:purge", { id }),
  },
  voucherDrafts: {
    list: () => call<VoucherWorkDraft[]>("voucherDraft:list"),
    get: (id: number) =>
      call<VoucherWorkDraft | null>("voucherDraft:get", { id }),
    save: (data: VoucherWorkDraftInput, id?: number) =>
      call<VoucherWorkDraft>("voucherDraft:save", { id, data }),
    remove: (id: number) => call<null>("voucherDraft:delete", { id }),
  },
  salesDocuments: {
    series: (kind?: SalesDocumentKind) =>
      call<SalesDocumentSeries[]>("salesDocument:seriesList", { kind }),
    saveSeries: (data: SalesDocumentSeriesInput, id?: number) =>
      call<SalesDocumentSeries>("salesDocument:seriesSave", { id, data }),
    numberPreview: (seriesId: number, date: string) =>
      call<SalesDocumentNumberPreview>("salesDocument:numberPreview", {
        seriesId,
        date,
      }),
    list: (kind?: SalesDocumentKind, status?: SalesDocumentStatus) =>
      call<SalesDocument[]>("salesDocument:list", { kind, status }),
    get: (id: number) =>
      call<SalesDocument | null>("salesDocument:get", { id }),
    create: (data: SalesDocumentInput) =>
      call<SalesDocument>("salesDocument:create", data),
    revise: (id: number, data: SalesDocumentInput, reason: string) =>
      call<SalesDocument>("salesDocument:revise", { id, data, reason }),
    setStatus: (id: number, status: SalesDocumentStatus) =>
      call<SalesDocument>("salesDocument:setStatus", { id, status }),
    convert: (data: SalesDocumentConversionInput) =>
      call<SalesDocumentConversionResult>("salesDocument:convert", data),
  },
  salesRecurring: {
    list: () => call<SalesRecurringSchedule[]>("salesRecurring:list"),
    save: (data: SalesRecurringScheduleInput, id?: number) =>
      call<SalesRecurringSchedule>("salesRecurring:save", { id, data }),
    preview: (asOn: string) =>
      call<SalesRecurringPreview>("salesRecurring:preview", { asOn }),
    generate: (asOn: string, scheduleIds: number[]) =>
      call<SalesRecurringBatch>("salesRecurring:generate", {
        asOn,
        scheduleIds,
      }),
  },
  salesDiscounts: {
    list: () => call<SalesDiscountPolicy[]>("salesDiscount:list"),
    save: (data: SalesDiscountPolicyInput, id?: number) =>
      call<SalesDiscountPolicy>("salesDiscount:save", { id, data }),
  },
  customerOperations: {
    returnCandidates: (partyLedgerId?: number) =>
      call<SalesReturnCandidate[]>("customerOps:returnCandidates", {
        partyLedgerId,
      }),
    returnDraft: (input: SalesReturnDraftInput) =>
      call<VoucherWorkDraft>("customerOps:returnDraft", input),
    warranties: () => call<WarrantyClaim[]>("customerOps:warranties"),
    openWarranty: (serialId: number, openedDate: string, issue: string) =>
      call<WarrantyClaim>("customerOps:warrantyOpen", {
        serialId,
        openedDate,
        issue,
      }),
    resolveWarranty: (
      id: number,
      status: "in_service" | "resolved" | "rejected",
      outcome: string | null,
      serviceCost: number,
      resolvedDate: string | null,
    ) =>
      call<WarrantyClaim>("customerOps:warrantyResolve", {
        id,
        status,
        outcome,
        serviceCost,
        resolvedDate,
      }),
    customFields: () =>
      call<SalesCustomFieldDefinition[]>("customerOps:customFields"),
    saveCustomField: (input: SalesCustomFieldInput) =>
      call<SalesCustomFieldDefinition>("customerOps:customFieldSave", input),
    saveTerritory: (name: string, parentId: number | null) =>
      call<SalesTerritory>("customerOps:territorySave", { name, parentId }),
    assignCustomer: (
      customerLedgerId: number,
      territoryId: number,
      salesperson: string,
      effectiveFrom: string,
      effectiveTo: string | null,
    ) =>
      call<SalesCustomerAssignment>("customerOps:customerAssign", {
        customerLedgerId,
        territoryId,
        salesperson,
        effectiveFrom,
        effectiveTo,
      }),
    territorySales: (from: string, to: string) =>
      call<TerritorySalesRow[]>("customerOps:territorySales", { from, to }),
    subscriptions: () =>
      call<SubscriptionContract[]>("customerOps:subscriptions"),
    createSubscription: (input: SubscriptionContractInput) =>
      call<SubscriptionContract>("customerOps:subscriptionCreate", input),
    setSubscriptionStatus: (
      id: number,
      status: SubscriptionContract["status"],
    ) =>
      call<SubscriptionContract>("customerOps:subscriptionStatus", {
        id,
        status,
      }),
    portalBundle: (customerLedgerId: number, from: string, to: string) =>
      call<CustomerPortalBundle>("customerOps:portalBundle", {
        customerLedgerId,
        from,
        to,
      }),
  },
  entryTemplates: {
    list: () => call<VoucherEntryTemplate[]>("entryTemplate:list"),
    save: (data: VoucherWorkDraftInput & { name: string }) =>
      call<VoucherEntryTemplate>("entryTemplate:save", data),
    instantiate: (id: number) =>
      call<VoucherWorkDraft>("entryTemplate:instantiate", { id }),
    remove: (id: number) => call<null>("entryTemplate:delete", { id }),
  },
  procurement: {
    requisitions: () => call<PurchaseRequisition[]>("procurement:requisitions"),
    createRequisition: (data: RequisitionInput) =>
      call<PurchaseRequisition>("procurement:requisitionCreate", data),
    setRequisitionStatus: (
      id: number,
      status: Extract<
        RequisitionStatus,
        "submitted" | "approved" | "rejected" | "cancelled"
      >,
      note?: string | null,
    ) =>
      call<PurchaseRequisition>("procurement:requisitionStatus", {
        id,
        status,
        note,
      }),
    orders: () => call<PurchaseOrder[]>("procurement:orders"),
    createOrder: (data: PurchaseOrderInput) =>
      call<PurchaseOrder>("procurement:orderCreate", data),
    setOrderStatus: (id: number, status: "issued" | "closed" | "cancelled") =>
      call<PurchaseOrder>("procurement:orderStatus", { id, status }),
    receipts: () => call<GoodsReceipt[]>("procurement:receipts"),
    createReceipt: (data: GoodsReceiptInput) =>
      call<GoodsReceipt>("procurement:receiptCreate", data),
    invoiceCandidates: (supplierLedgerId?: number) =>
      call<InvoiceMatchCandidate[]>("procurement:invoiceCandidates", {
        supplierLedgerId,
      }),
    invoiceMatchPreview: (data: InvoiceMatchInput) =>
      call<InvoiceMatchPreview>("procurement:invoiceMatchPreview", data),
    priceHistory: (stockItemIds: number[], supplierLedgerId?: number) =>
      call<SupplierPriceHistoryRow[]>("procurement:priceHistory", {
        stockItemIds,
        supplierLedgerId,
      }),
    supplierComparison: (stockItemId: number) =>
      call<SupplierComparisonRow[]>("procurement:supplierComparison", {
        stockItemId,
      }),
    debitNoteClaims: () =>
      call<ProcurementDebitNoteClaim[]>("procurement:debitNoteClaims"),
    createDebitNoteDraft: (sourceKey: string) =>
      call<VoucherWorkDraft>("procurement:debitNoteDraft", { sourceKey }),
    supplierConcentration: (from: string, to: string) =>
      call<SupplierConcentrationReport>("procurement:supplierConcentration", {
        from,
        to,
      }),
    reorderSuggestions: (asOn: string) =>
      call<ReorderSuggestion[]>("procurement:reorderSuggestions", { asOn }),
    createReorderOrders: (asOn: string, stockItemIds: number[]) =>
      call<PurchaseOrder[]>("procurement:reorderCreateOrders", {
        asOn,
        stockItemIds,
      }),
    vendors: () => call<VendorProfile[]>("procurement:vendors"),
    saveVendor: (input: VendorProfileInput) =>
      call<VendorProfile>("procurement:vendorSave", input),
    setVendorStatus: (
      ledgerId: number,
      status: "verified" | "blocked" | "draft",
      note?: string | null,
    ) =>
      call<VendorProfile>("procurement:vendorStatus", {
        ledgerId,
        status,
        note,
      }),
  },
  reports: {
    dayBook: (
      from: string,
      to: string,
      includeOutOfBooks?: boolean,
      signal?: AbortSignal,
    ) =>
      cancellableCall<DayBookRow[]>(
        "report:dayBook",
        { from, to, includeOutOfBooks },
        signal,
      ),
    ledger: (
      ledgerId: number,
      from: string,
      to: string,
      groupBy?: "month",
      signal?: AbortSignal,
    ) =>
      cancellableCall<LedgerStatement>(
        "report:ledger",
        { ledgerId, from, to, groupBy },
        signal,
      ),
    trialBalance: (asOn: string, signal?: AbortSignal) =>
      cancellableCall<TrialBalance>("report:trialBalance", { asOn }, signal),
    profitLoss: (
      from: string,
      to: string,
      comparePrior?: boolean,
      signal?: AbortSignal,
    ) =>
      cancellableCall<ProfitAndLoss>(
        "report:profitLoss",
        { from, to, comparePrior },
        signal,
      ),
    balanceSheet: (
      asOn: string,
      comparePrior?: boolean,
      signal?: AbortSignal,
    ) =>
      cancellableCall<BalanceSheet>(
        "report:balanceSheet",
        { asOn, comparePrior },
        signal,
      ),
    stockSummary: (asOn: string, signal?: AbortSignal) =>
      cancellableCall<StockSummaryRow[]>(
        "report:stockSummary",
        { asOn },
        signal,
      ),
    dashboard: (today: string, fyFrom: string, signal?: AbortSignal) =>
      cancellableCall<DashboardData>(
        "report:dashboard",
        { today, fyFrom },
        signal,
      ),
    cashFlow: (from: string, to: string, signal?: AbortSignal) =>
      cancellableCall<CashFlowStatement>(
        "report:cashFlow",
        { from, to },
        signal,
      ),
    stockAgeing: (asOn: string, signal?: AbortSignal) =>
      cancellableCall<StockAgeingRow[]>("report:stockAgeing", { asOn }, signal),
    itemProfitability: (from: string, to: string, signal?: AbortSignal) =>
      cancellableCall<ItemProfitRow[]>(
        "report:itemProfitability",
        { from, to },
        signal,
      ),
    exceptions: (from: string, to: string, signal?: AbortSignal) =>
      cancellableCall<ExceptionsReport>(
        "report:exceptions",
        { from, to },
        signal,
      ),
  },
  systemHealth: {
    summary: () => call<SystemHealthSummary>("system:health"),
    runMaintenance: (mode: "quick" | "optimize" | "full") =>
      call<SystemHealthSummary & { mode: string; detail: string }>(
        "system:maintenance:run",
        { mode },
      ),
    attemptRecovery: () => call<RecoveryCopyResult>("system:recovery:attempt"),
    exportProfiler: () =>
      call<{ path: string; fields: string[] }>("system:profiler:export"),
  },
  monthClose: {
    status: (from: string, to: string) =>
      call<MonthCloseStatus>("monthClose:status", { from, to }),
  },
  consolidated: {
    run: (
      slugs: string[],
      kind: "tb" | "pnl",
      from: string,
      to: string,
      translationRates: Record<string, number> = {},
      eliminations: {
        name: string;
        group: string;
        amount: number;
        reason: string;
      }[] = [],
    ) =>
      call<ConsolidatedResult>("consol:run", {
        slugs,
        kind,
        from,
        to,
        translationRates,
        eliminations,
      }),
  },
  gst: {
    gstr1: (
      from: string,
      to: string,
      period: string,
      registrationId?: number | null,
    ) => call<Gstr1Result>("gst:gstr1", { from, to, period, registrationId }),
    gstr3b: (
      from: string,
      to: string,
      period: string,
      registrationId?: number | null,
    ) => call<Gstr3bResult>("gst:gstr3b", { from, to, period, registrationId }),
    exportGstr1: (
      from: string,
      to: string,
      period: string,
      registrationId?: number | null,
    ) =>
      call<{ jsonPath: string; csvPath: string }>("gst:exportGstr1", {
        from,
        to,
        period,
        registrationId,
      }),
    exportGstr3b: (
      from: string,
      to: string,
      period: string,
      registrationId?: number | null,
    ) =>
      call<{ jsonPath: string }>("gst:exportGstr3b", {
        from,
        to,
        period,
        registrationId,
      }),
    recon2b: (jsonText: string, from: string, to: string) =>
      call<{ result: Recon2bResult; errors: string[]; period: string | null }>(
        "gst:recon2b",
        { jsonText, from, to },
      ),
    recon2bSave: (
      jsonText: string,
      fileName: string | null,
      from: string,
      to: string,
      period: string,
    ) =>
      call<{
        imported: Gst2bImportRow;
        result: Recon2bResult;
        errors: string[];
        duplicate: boolean;
      }>("gst:recon2bSave", { jsonText, fileName, from, to, period }),
    recon2bImports: (period?: string) =>
      call<Gst2bImportRow[]>("gst:recon2bImports", { period }),
    itcActions: (period?: string) =>
      call<ItcActionRow[]>("gst:itcActions", { period }),
    itcActionUpdate: (
      input: Pick<
        ItcActionRow,
        "id" | "classification" | "status" | "owner" | "dueDate" | "note"
      >,
    ) => call<ItcActionRow>("gst:itcActionUpdate", input),
    registrations: () => call<GstRegistration[]>("gst:registrations"),
    registrationSave: (
      input: Omit<
        GstRegistration,
        "id" | "createdBy" | "createdAt" | "updatedAt"
      > & { id?: number },
    ) => call<GstRegistration>("gst:registrationSave", input),
    registrationSeries: (registrationId?: number) =>
      call<GstRegistrationSeries[]>("gst:registrationSeries", {
        registrationId,
      }),
    registrationSeriesSave: (
      input: Omit<GstRegistrationSeries, "id" | "voucherTypeName">,
    ) => call<GstRegistrationSeries>("gst:registrationSeriesSave", input),
    luts: (registrationId?: number) =>
      call<LutAuthorization[]>("gst:luts", { registrationId }),
    lutSave: (
      input: Omit<
        LutAuthorization,
        "id" | "registrationGstin" | "createdBy" | "createdAt"
      >,
    ) => call<LutAuthorization>("gst:lutSave", input),
    taxPacks: () => call<TaxContentPack[]>("gst:taxPacks"),
    taxPackInstall: (input: {
      packKey: string;
      version: string;
      effectiveFrom: string;
      effectiveTo?: string | null;
      title: string;
      content: Record<string, unknown>;
      sourceUrl?: string | null;
    }) => call<TaxContentPack>("gst:taxPackInstall", input),
    noticePack: (from: string, to: string) =>
      call<{ dir: string; manifestPath: string }>("gst:noticePack", {
        from,
        to,
      }),
    recon2bPickFile: () =>
      call<{ jsonText: string; fileName: string } | null>(
        "gst:recon2bPickFile",
      ),
    validate: (from: string, to: string, registrationId?: number | null) =>
      call<{
        issues: GstIssue[];
        roundOff: {
          voucherId: number;
          number: string;
          roundOff: number;
          lines: string[];
        }[];
      }>("gst:validate", { from, to, registrationId }),
    returnStatus: (
      type: "gstr1" | "gstr3b",
      from: string,
      to: string,
      period: string,
      registrationId?: number | null,
    ) =>
      call<GstReturnStatus>("gst:returnStatus", {
        type,
        from,
        to,
        period,
        registrationId,
      }),
    freezeReturn: (
      type: "gstr1" | "gstr3b",
      from: string,
      to: string,
      period: string,
      registrationId?: number | null,
    ) =>
      call<GstReturnStatus>("gst:returnFreeze", {
        type,
        from,
        to,
        period,
        registrationId,
      }),
    acknowledgeReturn: (
      type: "gstr1" | "gstr3b",
      from: string,
      to: string,
      period: string,
      input: { arn: string; filedAt: string; submittedJson: string | null },
      registrationId?: number | null,
    ) =>
      call<GstReturnStatus>("gst:returnAcknowledge", {
        type,
        from,
        to,
        period,
        registrationId,
        ...input,
      }),
    get3bManual: (period: string, registrationId?: number | null) =>
      call<Gst3bManualInput>("gst:3bManualGet", { period, registrationId }),
    set3bManual: (
      period: string,
      data: Gst3bManualInput,
      registrationId?: number | null,
    ) =>
      call<Gst3bManualInput>("gst:3bManualSet", {
        period,
        data,
        registrationId,
      }),
  },
  analysis: {
    register: (
      kind: "sales" | "purchase",
      from: string,
      to: string,
      granularity: RegisterGranularity = "month",
    ) =>
      call<RegisterPeriodRow[]>("analysis:register", {
        kind,
        from,
        to,
        granularity,
      }),
    outstandings: (side: "receivable" | "payable", asOn: string) =>
      call<OutstandingParty[]>("analysis:outstandings", { side, asOn }),
  },
  management: {
    variance: (
      currentFrom: string,
      currentTo: string,
      comparisonFrom: string,
      comparisonTo: string,
    ) =>
      call<VarianceExplanation>("management:variance", {
        currentFrom,
        currentTo,
        comparisonFrom,
        comparisonTo,
      }),
    scenarios: () => call<ManagementScenario[]>("management:scenarios"),
    scenarioSave: (data: ManagementScenarioInput, id?: number) =>
      call<ManagementScenario>("management:scenarioSave", { id, data }),
    scenarioDelete: (id: number) =>
      call<null>("management:scenarioDelete", { id }),
    scenarioProjection: (
      from: string,
      to: string,
      data: ManagementScenarioInput,
    ) =>
      call<ScenarioProjection>("management:scenarioProjection", {
        from,
        to,
        data,
      }),
    annotations: (reportKey: string, from: string, to: string) =>
      call<ReportAnnotation[]>("management:annotations", {
        reportKey,
        from,
        to,
      }),
    annotationSave: (data: {
      reportKey: string;
      rowKey: string;
      from: string;
      to: string;
      note: string;
      includeInExport: boolean;
    }) => call<ReportAnnotation>("management:annotationSave", data),
    scheduleMappings: () =>
      call<ScheduleIiiMapping[]>("management:scheduleMappings"),
    scheduleMappingSave: (
      data: Omit<
        ScheduleIiiMapping,
        "id" | "groupName" | "updatedBy" | "updatedAt"
      >,
    ) => call<ScheduleIiiMapping>("management:scheduleMappingSave", data),
    scheduleStatement: (asOn: string, priorAsOn: string) =>
      call<ScheduleIiiStatement>("management:scheduleStatement", {
        asOn,
        priorAsOn,
      }),
  },
  collections: {
    queue: (asOn: string) =>
      call<CollectionQueueRow[]>("collections:queue", { asOn }),
    promises: (ledgerId?: number) =>
      call<CollectionPromise[]>("collections:promises", { ledgerId }),
    savePromise: (input: {
      ledgerId: number;
      amount: number;
      promisedDate: string;
      owner: string;
      note: string | null;
    }) => call<CollectionPromise>("collections:promiseSave", input),
    resolvePromise: (
      id: number,
      status: "kept" | "broken" | "cancelled",
      outcomeNote: string | null,
    ) =>
      call<CollectionPromise>("collections:promiseResolve", {
        id,
        status,
        outcomeNote,
      }),
    workspace: (ledgerId: number, asOn: string) =>
      call<CollectionCustomerWorkspace>("collections:workspace", {
        ledgerId,
        asOn,
      }),
    saveSettings: (ledgerId: number, settings: CollectionCustomerSettings) =>
      call<CollectionCustomerSettings>("collections:settingsSave", {
        ledgerId,
        settings,
      }),
    openDispute: (
      ledgerId: number,
      voucherId: number,
      reason: string,
      owner: string,
    ) =>
      call<null>("collections:disputeOpen", {
        ledgerId,
        voucherId,
        reason,
        owner,
      }),
    resolveDispute: (id: number, resolution: string) =>
      call<null>("collections:disputeResolve", { id, resolution }),
    addNote: (ledgerId: number, body: string) =>
      call<null>("collections:noteAdd", { ledgerId, body }),
    draftReminder: (input: {
      ledgerId: number;
      voucherId: number | null;
      channel: "email" | "whatsapp" | "phone";
      body: string;
      dueDate: string;
    }) => call<null>("collections:reminderDraft", input),
    receiptSuggestions: (
      amount: number,
      date: string,
      reference: string,
      payer: string,
    ) =>
      call<ReceiptSuggestion[]>("collections:receiptSuggestions", {
        amount,
        date,
        reference,
        payer,
      }),
    ownerWorkload: (asOn: string) =>
      call<
        {
          owner: string;
          customers: number;
          overdue: number;
          followUpsDue: number;
          collected90Days: number;
        }[]
      >("collections:ownerWorkload", { asOn }),
  },
  payables: {
    queue: (asOn: string) => call<SupplierDueQueue>("payables:queue", { asOn }),
    advances: (asOn: string) =>
      call<SupplierAdvanceRow[]>("payables:advances", { asOn }),
    paymentAccounts: (asOn: string) =>
      call<PaymentAccount[]>("paymentRun:accounts", { asOn }),
    paymentRunPreview: (
      bankLedgerId: number,
      date: string,
      bills: PaymentRunBillInput[],
    ) =>
      call<PaymentRunPreview>("paymentRun:preview", {
        bankLedgerId,
        date,
        bills,
        note: null,
      }),
    paymentRuns: () => call<PaymentRun[]>("paymentRun:list"),
    createPaymentRun: (input: {
      bankLedgerId: number;
      date: string;
      note: string | null;
      bills: PaymentRunBillInput[];
    }) => call<PaymentRun>("paymentRun:create", input),
    postPaymentRun: (id: number) => call<PaymentRun>("paymentRun:post", { id }),
    cancelPaymentRun: (id: number) =>
      call<PaymentRun>("paymentRun:cancel", { id }),
    paymentFilePreview: (id: number, format: PaymentFileFormat) =>
      call<PaymentFilePreview>("paymentRun:filePreview", { id, format }),
    paymentFileExport: (id: number, format: PaymentFileFormat) =>
      call<{ path: string; rows: number; totalAmount: number }>(
        "paymentRun:fileExport",
        { id, format },
      ),
  },
  tasks: {
    list: (status?: TaskStatus) =>
      call<PersonalTask[]>("task:list", { status }),
    save: (data: PersonalTaskInput, id?: number) =>
      call<PersonalTask>("task:save", { id, data }),
    complete: (id: number) => call<PersonalTask>("task:complete", { id }),
    cancel: (id: number) => call<PersonalTask>("task:cancel", { id }),
  },
  bills: {
    open: (partyLedgerId: number, asOn: string) =>
      call<OutstandingBill[]>("bills:open", { partyLedgerId, asOn }),
  },
  tds: {
    sections: () => call<TdsSection[]>("tds:sections"),
    sectionSave: (data: TdsSectionInput) =>
      call<TdsSection>("tds:sectionSave", data),
    suggest: (partyLedgerId: number, base: number, date: string) =>
      call<TdsSuggestion | null>("tds:suggest", { partyLedgerId, base, date }),
    summary: (fyStartYear: number) =>
      call<TdsSummaryRow[]>("tds:summary", { fyStartYear }),
    export26q: (fyStartYear: number, quarter: number) =>
      call<{ path: string }>("tds:export26q", { fyStartYear, quarter }),
    workspace: (fyStartYear: number, quarter: 1 | 2 | 3 | 4) =>
      call<TdsWorkspace>("tds:workspace", { fyStartYear, quarter }),
    challanAdd: (input: {
      fyStartYear: number;
      quarter: 1 | 2 | 3 | 4;
      bsrCode: string;
      challanSerial: string;
      depositDate: string;
      amount: number;
      note: string | null;
    }) => call<TdsChallan>("tds:challanAdd", input),
    returnStatusSet: (input: {
      fyStartYear: number;
      quarter: 1 | 2 | 3 | 4;
      status: TdsWorkspace["returnStatus"]["status"];
      token: string | null;
      filedAt: string | null;
      note: string | null;
    }) => call<TdsWorkspace>("tds:returnStatusSet", input),
  },
  compliance: {
    list: (from?: string, to?: string) =>
      call<ComplianceObligation[]>("compliance:list", { from, to }),
    sync: (today: string) =>
      call<ComplianceObligation[]>("compliance:sync", { today }),
    save: (input: {
      id?: number;
      title: string;
      dueDate: string;
      kind: ComplianceObligation["kind"];
      status: ComplianceObligation["status"];
      owner?: string | null;
      note?: string | null;
    }) => call<ComplianceObligation>("compliance:save", input),
  },
  cc: {
    list: () => call<CostCentre[]>("cc:list"),
    save: (data: CostCentreInput, id?: number) =>
      call<CostCentre>("cc:save", { id, data }),
    remove: (id: number) => call<null>("cc:delete", { id }),
    report: (from: string, to: string) =>
      call<CcReportRow[]>("cc:report", { from, to }),
    statement: (ccId: number, from: string, to: string) =>
      call<CcStatementRow[]>("cc:statement", { ccId, from, to }),
  },
  budget: {
    list: () => call<Budget[]>("budget:list"),
    save: (data: BudgetInput, id?: number) =>
      call<Budget>("budget:save", { id, data }),
    remove: (id: number) => call<null>("budget:delete", { id }),
    variance: (budgetId: number, upToMonth: string) =>
      call<BudgetVarianceRow[]>("budget:variance", { budgetId, upToMonth }),
  },
  recurring: {
    list: () => call<RecurringTemplate[]>("recurring:list"),
    save: (data: RecurringInput, id?: number) =>
      call<RecurringTemplate>("recurring:save", { id, data }),
    remove: (id: number) => call<null>("recurring:delete", { id }),
    due: (today: string) =>
      call<RecurringTemplate[]>("recurring:due", { today }),
    post: (id: number, date: string) =>
      call<VoucherSaveResult>("recurring:post", { id, date }),
    skip: (id: number) => call<RecurringTemplate>("recurring:skip", { id }),
  },
  bank: {
    ledgers: () => call<{ id: number; name: string }[]>("bank:ledgers"),
    recon: (ledgerId: number, from: string, to: string) =>
      call<BankRecon>("bank:recon", { ledgerId, from, to }),
    setBankDate: (lineId: number, bankDate: string | null) =>
      call<null>("bank:setBankDate", { lineId, bankDate }),
    workspace: (ledgerId: number) =>
      call<BankReconciliationWorkspace>("bank:workspace", { ledgerId }),
    classifyRow: (
      id: number,
      status: "bank_only" | "ignored" | "timing_difference",
      note?: string | null,
    ) => call<null>("bank:classifyRow", { id, status, note }),
    transferSuggestions: () =>
      call<BankTransferSuggestion[]>("bank:transferSuggestions"),
    postTransfer: (withdrawalRowId: number, depositRowId: number) =>
      call<{ voucherId: number }>("bank:postTransfer", {
        withdrawalRowId,
        depositRowId,
      }),
    chargeSuggestions: () =>
      call<BankChargeSuggestion[]>("bank:chargeSuggestions"),
    postChargeExtraction: (input: {
      statementRowId: number;
      settlementLineId: number;
      feeLedgerId: number;
      taxLedgerId: number | null;
      feeAmount: number;
      taxAmount: number;
    }) => call<{ voucherId: number }>("bank:postChargeExtraction", input),
    cheques: (asOn: string) =>
      call<ChequeLifecycleRow[]>("bank:cheques", { asOn }),
    chequeStatus: (
      voucherId: number,
      status: "issued" | "deposited" | "cleared" | "bounced" | "cancelled",
      statusDate: string,
      note?: string | null,
    ) =>
      call<null>("bank:chequeStatus", { voucherId, status, statusDate, note }),
    cashLedgers: () => call<{ id: number; name: string }[]>("bank:cashLedgers"),
    cashCounts: () => call<CashCountSession[]>("bank:cashCounts"),
    cashCountPreview: (
      ledgerId: number,
      date: string,
      lines: CashDenomination[],
    ) =>
      call<
        Omit<
          CashCountSession,
          | "id"
          | "cashLedgerName"
          | "status"
          | "note"
          | "countedBy"
          | "countedAt"
          | "postedBy"
          | "postedAt"
          | "adjustmentVoucherId"
        >
      >("bank:cashCountPreview", { ledgerId, date, lines }),
    cashCountSave: (
      ledgerId: number,
      date: string,
      lines: CashDenomination[],
      note?: string | null,
    ) =>
      call<CashCountSession>("bank:cashCountSave", {
        ledgerId,
        date,
        lines,
        note,
      }),
    cashCountPost: (id: number, adjustmentLedgerId: number | null) =>
      call<CashCountSession>("bank:cashCountPost", { id, adjustmentLedgerId }),
    importCsv: (
      ledgerId: number,
      opts?: {
        csvText?: string;
        dryRun?: boolean;
        format?: "csv" | "xlsx" | "ofx" | "qif" | "mt940";
        fileName?: string | null;
      },
    ) =>
      call<
        | (BankImportResult & {
            csvText: string;
            format: "csv" | "xlsx" | "ofx" | "qif" | "mt940";
            fileName: string | null;
          })
        | null
      >("bank:importCsv", { ledgerId, ...opts }),
    suggest: (ledgerId: number, csvText: string) =>
      call<BankSuggestionRow[]>("banking:suggest", { ledgerId, csvText }),
    matchSuggestions: (
      ledgerId: number,
      csvText: string,
      tolerancePaise?: number,
    ) =>
      call<BankMatchSuggestion[]>("banking:matchSuggestions", {
        ledgerId,
        csvText,
        tolerancePaise,
      }),
    brs: (ledgerId: number, asOn: string) =>
      call<BrsReport>("banking:brs", { ledgerId, asOn }),
    brsPdf: (ledgerId: number, asOn: string) =>
      call<{ path: string }>("banking:brsPdf", { ledgerId, asOn }),
  },
  bankRules: {
    list: () => call<BankRuleRecord[]>("bankrule:list"),
    save: (data: BankRuleInput, id?: number) =>
      call<BankRuleRecord>("bankrule:save", { id, data }),
    remove: (id: number) => call<null>("bankrule:delete", { id }),
    hit: (id: number) => call<null>("bankrule:hit", { id }),
    reject: (id: number) => call<BankRuleRecord>("bankrule:reject", { id }),
    rollback: (id: number) => call<BankRuleRecord>("bankrule:rollback", { id }),
  },
  treasury: {
    position: (asOn: string) =>
      call<DailyCashPosition>("treasury:position", { asOn }),
    forecast: (asOn: string, scenarioId?: number | null) =>
      call<TreasuryForecast>("treasury:forecast", { asOn, scenarioId }),
    scenarios: () => call<LiquidityScenario[]>("treasury:scenarios"),
    scenarioSave: (data: LiquidityScenarioInput, id?: number) =>
      call<LiquidityScenario>("treasury:scenarioSave", { id, data }),
    scenarioDelete: (id: number) =>
      call<null>("treasury:scenarioDelete", { id }),
    alertSettings: () => call<TreasuryAlertSettings>("treasury:alertSettings"),
    alertSettingsSet: (settings: TreasuryAlertSettings) =>
      call<TreasuryAlertSettings>("treasury:alertSettingsSet", settings),
    alerts: (asOn: string, scenarioId?: number | null) =>
      call<TreasuryAlert[]>("treasury:alerts", { asOn, scenarioId }),
  },
  bankFeeds: {
    list: () => call<BankFeedConnection[]>("bankFeed:list"),
    save: (input: {
      id?: number;
      bankLedgerId: number;
      displayName: string;
      endpoint: string;
      consentExpiresAt: string;
      accessToken?: string;
    }) => call<BankFeedConnection>("bankFeed:save", input),
    setStatus: (id: number, status: "connected" | "paused" | "revoked") =>
      call<BankFeedConnection>("bankFeed:status", { id, status }),
    sync: (id: number) =>
      call<{
        importId: number | null;
        statementRows: number;
        matched: number;
        unmatched: number;
      }>("bankFeed:sync", { id }),
  },
  edoc: {
    list: (from: string, to: string) =>
      call<EdocListRow[]>("edoc:list", { from, to }),
    events: (voucherId?: number) =>
      call<EdocEvent[]>("edoc:events", { voucherId }),
    eventAdd: (input: {
      voucherId: number;
      kind: EdocEvent["kind"];
      status: EdocEvent["status"];
      requestKey: string | null;
      documentNo: string | null;
      validUntil: string | null;
      vehicleNo: string | null;
      reason: string | null;
    }) => call<EdocEvent>("edoc:eventAdd", input),
    exportEInvoice: (from: string, to: string, period: string) =>
      call<{ path: string; count: number }>("edoc:exportEInvoice", {
        from,
        to,
        period,
      }),
    exportEwb: (
      from: string,
      to: string,
      period: string,
      opts?: { voucherIds?: number[]; includeBelowThreshold?: boolean },
    ) =>
      call<{
        path: string;
        dir: string;
        count: number;
        skipped: { number: string; reason: string }[];
      }>("edoc:exportEwb", { from, to, period, ...opts }),
    ewbJson: (voucherId: number) =>
      call<{ path: string }>("edoc:ewbJson", { voucherId }),
    transportGet: (voucherId: number) =>
      call<VoucherTransport | null>("edoc:transportGet", { voucherId }),
    transportSet: (voucherId: number, data: VoucherTransportInput) =>
      call<VoucherTransport>("edoc:transportSet", { voucherId, data }),
  },
  invoice: {
    pdf: (voucherId: number) =>
      call<{ path: string }>("invoice:pdf", { voucherId }),
    pdfBatch: (voucherIds: number[]) =>
      call<{ dir: string; paths: string[] }>("invoice:pdfBatch", {
        voucherIds,
      }),
    previewHtml: (voucherId?: number, config?: Partial<InvoiceConfig>) =>
      call<{ html: string }>("invoice:previewHtml", { voucherId, config }),
  },
  cheque: {
    config: {
      get: (bankLedgerId: number) =>
        call<ChequeConfig>("cheque:config:get", { bankLedgerId }),
      set: (bankLedgerId: number, config: ChequeConfig) =>
        call<ChequeConfig>("cheque:config:set", { bankLedgerId, config }),
    },
    pdf: (voucherId: number, bankLedgerId: number) =>
      call<{ path: string }>("cheque:pdf", { voucherId, bankLedgerId }),
    testGrid: (bankLedgerId: number) =>
      call<{ path: string }>("cheque:testGrid", { bankLedgerId }),
    advice: (voucherId: number) =>
      call<{ path: string }>("cheque:advice", { voucherId }),
  },
  config: {
    features: {
      get: () => call<CompanyFeatures>("config:features:get"),
      set: (data: CompanyFeatures) =>
        call<CompanyFeatures>("config:features:set", data),
    },
    invoice: {
      get: () => call<InvoiceConfig>("config:invoice:get"),
      set: (data: InvoiceConfig) =>
        call<InvoiceConfig>("config:invoice:set", data),
    },
  },
  currencies: {
    list: () => call<Currency[]>("currency:list"),
    create: (data: CurrencyInput) => call<Currency>("currency:create", data),
    remove: (id: number) => call<null>("currency:delete", { id }),
  },
  bom: {
    get: (itemId: number) => call<BomLine[]>("bom:get", { itemId }),
    set: (data: BomInput) => call<BomLine[]>("bom:set", data),
    items: () =>
      call<{ itemId: number; name: string; components: number }[]>("bom:items"),
  },
  payroll: {
    employees: () => call<Employee[]>("payroll:employees:list"),
    saveEmployee: (data: EmployeeInputPayload, id?: number) =>
      call<Employee>("payroll:employees:save", { data, id }),
    removeEmployee: (id: number) =>
      call<null>("payroll:employees:delete", { id }),
    preview: (
      month: string,
      days: { employeeId: number; payableDays: number }[],
    ) => call<Omit<PayrollLine, "id">[]>("payroll:preview", { month, days }),
    preflight: (
      month: string,
      days: { employeeId: number; payableDays: number }[],
    ) => call<PayrollPreflight>("payroll:preflight", { month, days }),
    commit: (
      month: string,
      days: { employeeId: number; payableDays: number }[],
    ) => call<PayrollRun>("payroll:commit", { month, days }),
    runs: () => call<PayrollRun[]>("payroll:runs"),
    tieOut: (id: number) => call<PayrollTieOut>("payroll:tieOut", { id }),
    lockRun: (id: number) => call<PayrollRun>("payroll:lockRun", { id }),
    attendance: {
      list: (month: string) =>
        call<AttendanceRecord[]>("payroll:attendance:list", { month }),
      summary: (month: string) =>
        call<AttendanceMonthSummary>("payroll:attendance:summary", { month }),
      save: (input: AttendanceInput) =>
        call<AttendanceRecord>("payroll:attendance:save", input),
      previewImport: (month: string, sourceName: string, csvText: string) =>
        call<AttendanceImportPreview>("payroll:attendance:previewImport", {
          month,
          sourceName,
          csvText,
        }),
      applyImport: (month: string, sourceName: string, csvText: string) =>
        call<AttendanceImportPreview>("payroll:attendance:applyImport", {
          month,
          sourceName,
          csvText,
        }),
      approveMonth: (month: string) =>
        call<AttendanceRecord[]>("payroll:attendance:approveMonth", { month }),
    },
    leave: {
      types: () => call<LeaveType[]>("payroll:leaveTypes:list"),
      saveType: (data: Omit<LeaveType, "id">, id?: number) =>
        call<LeaveType>("payroll:leaveTypes:save", { data, id }),
      transactions: (employeeId?: number) =>
        call<LeaveTransaction[]>("payroll:leave:transactions", { employeeId }),
      balances: (asOn: string) =>
        call<LeaveBalance[]>("payroll:leave:balances", { asOn }),
      record: (input: {
        employeeId: number;
        leaveTypeId: number;
        date: string;
        qtyMilli: number;
        kind: LeaveTransaction["kind"];
        status: LeaveTransaction["status"];
        note?: string | null;
      }) => call<LeaveTransaction>("payroll:leave:record", input),
    },
    salaryRevisions: {
      list: (employeeId?: number) =>
        call<SalaryRevision[]>("payroll:salaryRevisions:list", { employeeId }),
      save: (input: {
        employeeId: number;
        effectiveFrom: string;
        heads: SalaryRevision["heads"];
        reason: string;
        status: "draft" | "approved";
      }) => call<SalaryRevision>("payroll:salaryRevisions:save", input),
    },
    loans: {
      list: (employeeId?: number) =>
        call<EmployeeLoan[]>("payroll:loans:list", { employeeId }),
      create: (input: {
        employeeId: number;
        disbursedDate: string;
        principal: number;
        annualInterestBps: number;
        installmentAmount: number;
        firstDeductionMonth: string;
        note?: string | null;
      }) => call<EmployeeLoan>("payroll:loans:create", input),
      setInstallment: (
        installmentId: number,
        status: "scheduled" | "paused" | "waived",
      ) =>
        call<EmployeeLoan>("payroll:loans:setInstallment", {
          installmentId,
          status,
        }),
    },
    reimbursements: {
      list: (status?: EmployeeReimbursement["status"]) =>
        call<EmployeeReimbursement[]>("payroll:reimbursements:list", {
          status,
        }),
      submit: (input: {
        employeeId: number;
        claimDate: string;
        category: string;
        amount: number;
        taxable: boolean;
        description: string;
        attachmentPath?: string | null;
      }) => call<EmployeeReimbursement>("payroll:reimbursements:submit", input),
      decide: (id: number, decision: "approved" | "rejected") =>
        call<EmployeeReimbursement>("payroll:reimbursements:decide", {
          id,
          decision,
        }),
      pay: (id: number, date: string, bankLedgerId: number) =>
        call<EmployeeReimbursement>("payroll:reimbursements:pay", {
          id,
          date,
          bankLedgerId,
        }),
    },
    contractors: {
      list: () => call<Contractor[]>("payroll:contractors:list"),
      save: (
        data: {
          name: string;
          pan?: string | null;
          bankAccount?: string | null;
          bankIfsc?: string | null;
          tdsSectionId?: number | null;
          active: boolean;
        },
        id?: number,
      ) => call<Contractor>("payroll:contractors:save", { data, id }),
      payments: () => call<ContractorPayment[]>("payroll:contractors:payments"),
      postPayment: (input: {
        contractorId: number;
        periodFrom: string;
        periodTo: string;
        gross: number;
        bankLedgerId: number;
        date: string;
        note?: string | null;
      }) => call<ContractorPayment>("payroll:contractors:postPayment", input),
    },
    settlements: {
      list: () => call<FinalSettlement[]>("payroll:settlements:list"),
      preview: (employeeId: number, lastWorkingDate: string) =>
        call<FinalSettlementPreview>("payroll:settlements:preview", {
          employeeId,
          lastWorkingDate,
        }),
      create: (input: {
        employeeId: number;
        lastWorkingDate: string;
        salaryDue: number;
        noticePay: number;
        leaveEncashment: number;
        gratuity: number;
        recovery: number;
        advanceRecovery: number;
        note?: string | null;
      }) => call<FinalSettlement>("payroll:settlements:create", input),
      post: (id: number, date: string, bankLedgerId: number) =>
        call<FinalSettlement>("payroll:settlements:post", {
          id,
          date,
          bankLedgerId,
        }),
    },
    statutory: {
      workspace: (month: string) =>
        call<StatutoryWorkspaceRow[]>("payroll:statutory:workspace", { month }),
      save: (input: {
        month: string;
        kind: StatutoryKind;
        amount: number;
        paidDate?: string | null;
        reference?: string | null;
        status: "due" | "paid" | "filed";
        filedReference?: string | null;
      }) => call<StatutoryWorkspaceRow>("payroll:statutory:save", input),
    },
    shifts: {
      list: () => call<ShiftRule[]>("payroll:shifts:list"),
      save: (data: Omit<ShiftRule, "id">, id?: number) =>
        call<ShiftRule>("payroll:shifts:save", { data, id }),
      assignments: () => call<ShiftAssignment[]>("payroll:shifts:assignments"),
      assign: (input: {
        employeeId: number;
        shiftRuleId: number;
        effectiveFrom: string;
        effectiveTo?: string | null;
      }) => call<ShiftAssignment>("payroll:shifts:assign", input),
      holidays: (from: string, to: string) =>
        call<WorkforceHoliday[]>("payroll:holidays:list", { from, to }),
      saveHoliday: (input: {
        date: string;
        name: string;
        department?: string;
      }) => call<WorkforceHoliday>("payroll:holidays:save", input),
    },
    departmentAnalysis: (fromMonth: string, toMonth: string) =>
      call<DepartmentPayrollRow[]>("payroll:departmentAnalysis", {
        fromMonth,
        toMonth,
      }),
    provisioning: {
      preview: (kind: ProvisioningKind, sourceName: string, csvText: string) =>
        call<ProvisioningPreview>("payroll:provisioning:preview", {
          kind,
          sourceName,
          csvText,
        }),
      apply: (kind: ProvisioningKind, sourceName: string, csvText: string) =>
        call<ProvisioningPreview>("payroll:provisioning:apply", {
          kind,
          sourceName,
          csvText,
        }),
    },
    removeRun: (id: number) => call<null>("payroll:deleteRun", { id }),
    payslip: (runId: number, employeeId: number) =>
      call<{ path: string }>("payroll:payslip", { runId, employeeId }),
    payslipPack: (runId: number) =>
      call<{ folder: string; files: string[] }>("payroll:payslipPack", {
        runId,
      }),
    heads: {
      list: () => call<PayHead[]>("payroll:heads:list"),
      save: (data: PayHeadInput, id?: number) =>
        call<PayHead>("payroll:heads:save", { data, id }),
      remove: (id: number) => call<null>("payroll:heads:delete", { id }),
    },
    employeeHeads: {
      get: (employeeId: number) =>
        call<EmployeeHeadRow[]>("payroll:employeeHeads:get", { employeeId }),
      set: (input: EmployeeHeadsSetInput) =>
        call<EmployeeHeadRow[]>("payroll:employeeHeads:set", input),
    },
    ecr: (runId: number) => call<{ path: string }>("payroll:ecr", { runId }),
    esiCsv: (runId: number) => call<{ path: string }>("payroll:esi", { runId }),
    ptSummary: (runId: number) =>
      call<PtSummaryRow[]>("payroll:ptSummary", { runId }),
    ptCsv: (runId: number) =>
      call<{ path: string }>("payroll:ptCsv", { runId }),
  },
  yearEnd: {
    preview: (fyStartYear: number) =>
      call<{
        rows: CloseLedgerRow[];
        netProfit: number;
        alreadyClosed: boolean;
      }>("yearend:preview", { fyStartYear }),
    close: (fyStartYear: number) =>
      call<{ voucherId: number; netProfit: number; lockedUpTo: string }>(
        "yearend:close",
        { fyStartYear },
      ),
  },
  tally: {
    dryRun: (filePath?: string) =>
      call<{ filePath: string | null; summary: TallyImportSummary } | null>(
        "tally:import",
        { filePath, dryRun: true },
      ),
    apply: (filePath?: string) =>
      call<{ filePath: string | null; summary: TallyImportSummary } | null>(
        "tally:import",
        { filePath, dryRun: false },
      ),
  },
  importer: {
    pickCsv: () =>
      call<{
        csvText: string;
        fileName: string;
        sheetName: string | null;
        sourceFormat: "csv" | "tsv" | "xlsx";
      } | null>("import:pickCsv"),
    preview: (kind: ImportKind, csvText: string) =>
      call<ImportPreview>("import:preview", { kind, csvText }),
    apply: (kind: ImportKind, csvText: string) =>
      call<ImportResult>("import:apply", { kind, csvText }),
    template: (kind: ImportKind) =>
      call<{ path: string }>("import:template", { kind }),
    profiles: () => call<MappingProfile[]>("import:profiles:list"),
    profileSave: (
      data: Omit<
        MappingProfile,
        "id" | "createdBy" | "createdAt" | "updatedAt"
      >,
      id?: number,
    ) => call<MappingProfile>("import:profiles:save", { data, id }),
    profilePreview: (profileId: number, csvText: string) =>
      call<{
        normalizedCsv: string;
        preview: ImportPreview;
        dryRun: MigrationDryRun;
      }>("import:profilePreview", { profileId, csvText }),
    profileApply: (profileId: number, csvText: string) =>
      call<ImportResult>("import:profileApply", { profileId, csvText }),
    errorWorkbook: (fileName: string, csvText: string, kind: ImportKind) =>
      call<{ path: string }>("import:errorWorkbook", {
        fileName,
        csvText,
        kind,
      }),
    attachments: (batchId: number, csvText: string) =>
      call<{ linked: number; missing: string[] } | null>("import:attachments", {
        batchId,
        csvText,
      }),
    certificate: (batchId: number) =>
      call<MigrationCertificateExport>("export:migrationCertificate", {
        batchId,
      }),
  },
  exporter: {
    caPack: (from: string, to: string) =>
      call<{ path: string }>("export:caPack", { from, to }),
    tallyXml: (from: string, to: string) =>
      call<{ path: string }>("export:tallyXml", { from, to }),
    portable: () =>
      call<{
        path: string;
        manifestHash: string;
        counts: Record<string, number>;
      }>("export:portable"),
  },
  exportReport: {
    pdf: (input: ReportPdfInput) => call<{ path: string }>("report:pdf", input),
    csv: (filename: string, csv: string, provenance: ReportProvenance) =>
      call<{ path: string; metadataPath: string }>("export:csv", {
        filename,
        csv,
        provenance,
      }),
  },
  nic: {
    get: () => call<NicCredentials>("nic:get"),
    save: (creds: NicCredentials) =>
      call<{ configured: boolean }>("nic:save", creds),
    status: () => call<{ configured: boolean }>("nic:status"),
    generateIrn: (voucherId: number) =>
      call<{ irn: string; ackNo: string; ackDate: string }>("nic:generateIrn", {
        voucherId,
      }),
    generateEwb: (voucherId: number) =>
      call<{ ewbNo: string; validUpto: string }>("nic:generateEwb", {
        voucherId,
      }),
  },
  intel: {
    suggestLedgers: (kind: string, query: string) =>
      call<
        { ledgerId: number; name: string; groupName: string; uses: number }[]
      >("intel:suggestLedgers", { kind, query }),
    anomaly: (ledgerId: number, amount: number) =>
      call<{ unusual: boolean; typicalAmount: number | null }>(
        "intel:anomaly",
        { ledgerId, amount },
      ),
  },
  log: {
    renderer: (input: RendererLogInput) => call<null>("log:renderer", input),
    reveal: () => call<null>("log:reveal"),
  },
  search: {
    global: (q: string) => call<SearchHit[]>("search:global", { q }),
    natural: (query: string) =>
      call<ConstrainedSearchResult[]>("search:natural", { query }),
  },
  audit: {
    list: (query: AuditListInput) =>
      call<{ rows: AuditRow[]; total: number }>("audit:list", query),
    verify: () => call<AuditIntegrityStatus>("audit:verify"),
    retentionGet: () => call<{ keepDays: number | null }>("config:audit:get"),
    retentionSet: (keepDays: number | null) =>
      call<{ keepDays: number | null }>("config:audit:set", { keepDays }),
  },
  auth: {
    users: () => call<LoginName[]>("auth:users"),
    login: (userId: number, pin: string) =>
      call<SessionUser>("auth:login", { userId, pin }),
    logout: () => call<null>("auth:logout"),
    current: () => call<SessionUser | null>("auth:current"),
  },
  users: {
    list: () => call<UserRow[]>("users:list"),
    save: (data: UserInput, id?: number) =>
      call<UserRow & { locked: boolean }>("users:save", { data, id }),
    deactivate: (id: number) => call<null>("users:deactivate", { id }),
  },
  approvals: {
    getPolicy: () => call<ApprovalPolicy>("approval:policy:get"),
    setPolicy: (policy: ApprovalPolicy) =>
      call<ApprovalPolicy>("approval:policy:set", policy),
    list: (status: ApprovalRequest["status"] = "pending") =>
      call<ApprovalRequest[]>("approval:list", { status }),
    approve: (id: number, note: string | null = null) =>
      call<Voucher>("approval:approve", { id, note }),
    reject: (id: number, note: string) =>
      call<null>("approval:reject", { id, note }),
  },
  permissions: {
    get: () => call<PermissionMatrix>("permissions:get"),
    set: (matrix: PermissionMatrix) =>
      call<PermissionMatrix>("permissions:set", matrix),
  },
  controls: {
    reviews: (status?: ReviewStatus) =>
      call<ReviewQuestion[]>("controls:review:list", { status }),
    reviewCreate: (input: {
      voucherId: number;
      question: string;
      assignedToUserId: number | null;
      dueDate: string | null;
      priority: ReviewPriority;
    }) => call<ReviewQuestion>("controls:review:create", input),
    reviewAnswer: (id: number, answer: string) =>
      call<ReviewQuestion>("controls:review:answer", { id, answer }),
    reviewResolve: (id: number) =>
      call<ReviewQuestion>("controls:review:resolve", { id }),
    signoff: (from: string, to: string) =>
      call<PeriodSignoff | null>("controls:signoff:get", { from, to }),
    signoffPrepare: (input: {
      from: string;
      to: string;
      outstandingIssues: string[];
      evidence: string[];
    }) => call<PeriodSignoff>("controls:signoff:prepare", input),
    signoffReview: (from: string, to: string, note: string) =>
      call<PeriodSignoff>("controls:signoff:review", { from, to, note }),
    signoffReopen: (from: string, to: string, reason: string) =>
      call<PeriodSignoff>("controls:signoff:reopen", { from, to, reason }),
    exportPermissions: () =>
      call<ExportPermissionMatrix>("controls:exports:get"),
    exportPermissionsSet: (matrix: ExportPermissionMatrix) =>
      call<ExportPermissionMatrix>("controls:exports:set", matrix),
    sessions: () => call<SessionRecord[]>("controls:sessions:list"),
    exceptions: (status?: PolicyException["status"]) =>
      call<PolicyException[]>("controls:exceptions:list", { status }),
    exceptionRequest: (input: {
      policyKind: PolicyKind;
      entityType: string;
      entityId: number | null;
      reason: string;
    }) => call<PolicyException>("controls:exceptions:request", input),
    exceptionDecide: (id: number, approved: boolean, note: string) =>
      call<PolicyException>("controls:exceptions:decide", {
        id,
        approved,
        note,
      }),
    boundaries: () => call<DepartmentBoundary[]>("controls:boundaries:list"),
    boundarySet: (input: {
      role: "accountant" | "viewer";
      dimensionKind: DepartmentBoundary["dimensionKind"];
      dimensionId: number;
      allowed: boolean;
    }) => call<DepartmentBoundary[]>("controls:boundaries:set", input),
    retention: () => call<RetentionPolicy[]>("controls:retention:list"),
    retentionSet: (input: {
      evidenceKind: RetentionPolicy["evidenceKind"];
      keepDays: number | null;
      warnDays: number;
      purgeRequiresApproval: boolean;
    }) => call<RetentionPolicy[]>("controls:retention:set", input),
    report: (from: string, to: string) =>
      call<ControlReport>("controls:report", { from, to }),
    reviewBundle: (from: string, to: string, passphrase: string) =>
      call<{ path: string; questionCount: number; evidenceCount: number }>(
        "export:reviewBundle",
        { from, to, passphrase },
      ),
  },
  agent: {
    exportMirror: (input?: AgentExportInput) =>
      call<{ dir: string; files: string[] }>("agent:exportMirror", input ?? {}),
    getConfig: () => call<{ enabled: boolean }>("agent:getConfig"),
    setConfig: (enabled: boolean) =>
      call<{ enabled: boolean }>("agent:setConfig", { enabled }),
    listProposals: () => call<AgentProposal[]>("agent:listProposals"),
    approveProposal: (file: string) =>
      call<VoucherSaveResult>("agent:approveProposal", { file }),
    discardProposal: (file: string) =>
      call<null>("agent:discardProposal", { file }),
  },
  mcp: {
    tokens: () => call<McpTokenSummary[]>("mcp:tokens:list"),
    issueToken: (input: {
      name: string;
      scopes: McpScope[];
      expiresAt: string;
    }) =>
      call<{ token: string; record: McpTokenSummary }>(
        "mcp:tokens:issue",
        input,
      ),
    revokeToken: (id: string) =>
      call<McpTokenSummary>("mcp:tokens:revoke", { id }),
    audit: (limit = 200) => call<McpAuditEvent[]>("mcp:audit:list", { limit }),
    mirrorStatus: () => call<McpMirrorStatus>("mcp:mirror:status"),
    refreshRequests: () => call<McpRefreshRequest[]>("mcp:refresh:list"),
    decideRefresh: (id: string, approved: boolean) =>
      call<{ request: McpRefreshRequest; files: string[] }>(
        "mcp:refresh:decide",
        { id, approved },
      ),
  },
  integrations: {
    plugins: () => call<InstalledPlugin[]>("integrations:plugins:list"),
    installPlugin: () =>
      call<InstalledPlugin | null>("integrations:plugins:install"),
    setPluginEnabled: (id: string, enabled: boolean) =>
      call<InstalledPlugin>("integrations:plugins:setEnabled", { id, enabled }),
    previewImport: (input: {
      pluginId: string;
      importerId: string;
      source: string;
    }) => call<unknown>("integrations:imports:preview", input),
    runReport: (pluginId: string, reportId: string, from: string, to: string) =>
      call<ExtensionReportResult>("integrations:reports:run", {
        pluginId,
        reportId,
        from,
        to,
      }),
    webhookEndpoints: () =>
      call<WebhookEndpointSummary[]>("integrations:webhooks:endpoints"),
    saveWebhookEndpoint: (input: {
      name: string;
      endpoint: string;
      eventTypes: string[];
      secret: string;
    }) => call<WebhookEndpointSummary>("integrations:webhooks:save", input),
    setWebhookActive: (id: number, active: boolean) =>
      call<WebhookEndpointSummary>("integrations:webhooks:setActive", {
        id,
        active,
      }),
    webhookOutbox: (limit = 200) =>
      call<WebhookOutboxEvent[]>("integrations:webhooks:outbox", { limit }),
    enqueueTestWebhook: (eventType: string, payload: unknown) =>
      call<WebhookOutboxEvent[]>("integrations:webhooks:test", {
        eventType,
        payload,
      }),
    deliverWebhook: (id: string) =>
      call<WebhookOutboxEvent>("integrations:webhooks:deliver", { id }),
    schedules: () =>
      call<AutomationSchedule[]>("integrations:automation:schedules"),
    saveSchedule: (input: {
      name: string;
      taskKind: AutomationSchedule["taskKind"];
      cadence: AutomationSchedule["cadence"];
      localTime: string;
      dayOfWeek?: number | null;
      dayOfMonth?: number | null;
      config?: Record<string, unknown>;
    }) => call<AutomationSchedule>("integrations:automation:save", input),
    setScheduleEnabled: (id: number, enabled: boolean) =>
      call<AutomationSchedule>("integrations:automation:setEnabled", {
        id,
        enabled,
      }),
    automationRuns: (limit = 100) =>
      call<AutomationRun[]>("integrations:automation:runs", { limit }),
    runAutomation: (id: number) =>
      call<AutomationRun>("integrations:automation:run", { id }),
    settlementReviews: () =>
      call<SettlementReview[]>("integrations:adapters:settlements:list"),
    reviewSettlement: (input: SettlementInput) =>
      call<SettlementReview>("integrations:adapters:settlements:review", input),
    ecommerceReviews: () =>
      call<EcommerceOrderReview[]>("integrations:adapters:ecommerce:list"),
    reviewEcommerceOrder: (input: EcommerceOrder) =>
      call<EcommerceOrderReview>(
        "integrations:adapters:ecommerce:review",
        input,
      ),
    exportLogistics: (format: LogisticsFormat, shipments: ShipmentInput[]) =>
      call<{
        id: number;
        path: string;
        manifestPath: string;
        shipmentCount: number;
        manifestHash: string;
      }>("export:logisticsAdapter", { format, shipments }),
  },
  privacy: {
    summary: () =>
      call<{
        clipboardClearSeconds: number;
        attachmentEncryption: boolean;
        exportSigning: {
          enabled: boolean;
          keyId: string | null;
          publicKeyPem: string | null;
          createdAt: string | null;
        };
        network: {
          ai: { enabled: boolean; provider: string; endpoint: string };
          bankFeeds: Array<{
            name: string;
            endpoint: string;
            status: string;
            consentExpiresAt: string;
          }>;
          webhooks: Array<{
            name: string;
            endpoint: string;
            active: boolean;
            eventTypes: string[];
          }>;
          mcpTokens: number;
          dropFolderEnabled: boolean;
        };
        retention: RetentionPolicy[];
        diagnostics: { version: string; platform: string; arch: string };
      }>("privacy:summary"),
    setClipboardClear: (seconds: number) =>
      call<{ seconds: number }>("privacy:clipboard:set", { seconds }),
    setAttachmentEncryption: (enabled: boolean) =>
      call<{ enabled: boolean; migratedFiles: number }>(
        "privacy:attachments:setEncryption",
        { enabled },
      ),
    initializeSigning: () =>
      call<{
        enabled: boolean;
        keyId: string;
        publicKeyPem: string;
        createdAt: string;
      }>("privacy:signing:initialize"),
    copySensitive: (text: string) =>
      call<{ clearsAfterSeconds: number }>("privacy:clipboard:copySensitive", {
        text,
      }),
  },
  ai: {
    getConfig: () => call<AiProviderConfig>("ai:getConfig"),
    setConfig: (input: AiProviderInput) =>
      call<AiProviderConfig>("ai:setConfig", input),
    testConnection: () =>
      call<{ ok: true; model: string }>("ai:testConnection"),
    contextPreview: (from: string, to: string, fields?: AiContextFieldId[]) =>
      call<AiContextPreview>("ai:contextPreview", { from, to, fields }),
    ask: (
      prompt: string,
      from: string,
      to: string,
      includeContext: boolean,
      contextFields?: AiContextFieldId[],
    ) =>
      call<AiAnswer>("ai:ask", {
        prompt,
        from,
        to,
        includeContext,
        contextFields,
      }),
    draftVoucher: (prompt: string, shareMasterData: boolean) =>
      call<AgentProposal>("ai:draftVoucher", { prompt, shareMasterData }),
    documents: () => call<DocumentInboxRow[]>("ai:documents:list"),
    captureDocument: (kind: "supplier_invoice" | "receipt") =>
      call<DocumentInboxRow | null>("ai:documents:capture", { kind }),
    reviewDocument: (id: number, status: "approved" | "dismissed") =>
      call<DocumentInboxRow>("ai:documents:review", { id, status }),
    ledgerSuggestions: (
      kind: string,
      query: string,
      contextKey: string,
      partyLedgerId?: number | null,
    ) =>
      call<EvidenceSuggestion[]>("ai:ledgerSuggestions", {
        kind,
        query,
        contextKey,
        partyLedgerId,
      }),
    ledgerFeedback: (
      contextKey: string,
      ledgerId: number,
      outcome: "accepted" | "rejected",
    ) => call<null>("ai:ledgerFeedback", { contextKey, ledgerId, outcome }),
    reconciliationExplain: (
      kind: "tolerance" | "many_to_one",
      statementAmount: number,
      lines: {
        voucherId: number;
        date: string;
        number: string;
        amount: number;
      }[],
    ) =>
      call<{ summary: string; reasons: string[]; citations: string[] }>(
        "ai:reconciliationExplain",
        { kind, statementAmount, lines },
      ),
    varianceNarrative: (
      currentFrom: string,
      currentTo: string,
      comparisonFrom: string,
      comparisonTo: string,
    ) =>
      call<{ text: string; citations: string[] }>("ai:varianceNarrative", {
        currentFrom,
        currentTo,
        comparisonFrom,
        comparisonTo,
      }),
    collectionMessage: (
      ledgerId: number,
      asOn: string,
      tone: "polite" | "firm",
      billVoucherIds: number[],
    ) =>
      call<{ message: string; citations: string[] }>("ai:collectionMessage", {
        ledgerId,
        asOn,
        tone,
        billVoucherIds,
      }),
    routes: () => call<AiTaskRoute[]>("ai:routes:list"),
    routeSet: (input: {
      taskKind: AiTaskRoute["taskKind"];
      provider: AiTaskRoute["provider"];
      model: string | null;
    }) => call<AiTaskRoute[]>("ai:routes:set", input),
  },
  support: {
    diagnostics: () =>
      call<{ version: string; platform: string; arch: string }>(
        "support:diagnostics",
      ),
    captureScreenshot: () =>
      call<{ dataUrl: string; width: number; height: number }>(
        "support:captureScreenshot",
      ),
    cases: () => call<SupportCaseRecord[]>("support:case:list"),
    createCase: (input: {
      category: SupportCategory;
      consent: SupportConsent;
    }) => call<SupportCaseRecord>("support:case:create", input),
    contextPreview: () => call<SupportContextPreview>("support:contextPreview"),
    submit: (input: SupportPayload) =>
      call<{ ok: true; caseId: string; status: SupportCaseStatus }>(
        "support:submit",
        input,
      ),
    bundleOffline: (input: SupportPayload & { passphrase: string }) =>
      call<{
        path: string;
        caseId: string;
        status: SupportCaseStatus;
      } | null>("support:bundleOffline", input),
  },
  community: {
    ideas: () => call<FeedbackIdea[]>("community:feedback:list"),
    submitIdea: (title: string, detail: string, email: string) =>
      call<{ ok: true; ideaId: string }>("community:feedback:action", {
        action: "submit",
        title,
        detail,
        email,
      }),
    vote: (ideaId: string) =>
      call<{ ok: true; ideaId: string }>("community:feedback:action", {
        action: "vote",
        ideaId,
      }),
    follow: (ideaId: string, email: string) =>
      call<{ ok: true; ideaId: string }>("community:feedback:action", {
        action: "follow",
        ideaId,
        email,
      }),
    submitCohort: (payload: Record<string, unknown>) =>
      call<{ ok: true }>("community:cohort:submit", payload),
  },
  crashes: {
    list: () => call<CrashEnvelope[]>("crash:list"),
    record: (input: { message: string; stack?: string; screen?: string }) =>
      call<CrashEnvelope>("crash:record", input),
    submit: (id: string) =>
      call<{ ok: true; caseId: string }>("crash:submit", { id }),
  },
  app: {
    info: () => call<{ version: string; platform: string }>("app:info"),
    checkUpdates: () =>
      call<{
        status: "dev" | "available" | "up-to-date" | "error";
        current: string;
        latest?: string;
      }>("app:checkUpdates"),
    notifyDeadlines: (items: { title: string; body: string }[]) =>
      call<null>("app:notifyDeadlines", { items }),
  },
};
