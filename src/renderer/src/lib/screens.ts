import type { Screen } from "../state/stores";
import type { CompanyFeatures } from "@shared/features";

/**
 * The single screen registry — Shell's sidebar NAV, the Gateway cards, the CommandPalette's
 * navigation commands, ShortcutHelp's Gateway group, and App.tsx's scoped query invalidation
 * all derive from this list. Add a screen once here and every surface picks it up.
 */

export type NavSectionId =
  | "home"
  | "create"
  | "sales"
  | "purchases"
  | "banking"
  | "inventory"
  | "parties"
  | "compliance"
  | "payroll"
  | "reports"
  | "automation";

type LegacyNavSectionId = "top" | "books" | "analysis" | "banking" | "payroll" | "gst" | "system";

/** Sidebar section order + titles (null = the untitled block at the top). */
export const NAV_SECTIONS: {
  id: NavSectionId;
  title: string | null;
  feature?: keyof CompanyFeatures;
}[] = [
  { id: "home", title: "Home" },
  { id: "create", title: "Create" },
  { id: "sales", title: "Sales" },
  { id: "purchases", title: "Purchases" },
  { id: "banking", title: "Banking" },
  { id: "inventory", title: "Inventory" },
  { id: "parties", title: "Parties" },
  { id: "compliance", title: "Compliance" },
  { id: "payroll", title: "Payroll", feature: "payroll" },
  { id: "reports", title: "Reports" },
  { id: "automation", title: "Automation" },
];

export interface ScreenDef {
  name: Screen["name"];
  /** Canonical name — used by the command palette (and the sidebar unless navLabel differs). */
  title: string;
  /** Default navigation target (screens with required params aren't navigable from here). */
  screen: Screen | null;
  /** Sidebar placement; null = not in the sidebar. */
  navSection: NavSectionId | LegacyNavSectionId | null;
  /** Sidebar label when shorter than the palette title. */
  navLabel?: string;
  /** Hidden everywhere (render-only) when this feature is off. */
  feature?: keyof CompanyFeatures;
  /** Gateway card: subtitle + single-letter shortcut (also ShortcutHelp's Gateway group). */
  card?: { sub: string; key: string };
  /** Extra command-palette search terms beyond the title. */
  keywords?: string[];
  /**
   * Query-key families to refresh when this screen becomes visible (App.tsx). Each entry must
   * be the FIRST element of a real `useQuery` key somewhere under screens/** — invalidation
   * matches by prefix, so a name no query uses is a silent no-op. When adding a query to a
   * screen (including expandable sub-queries), add its family here too.
   */
  invalidates: string[];
}

export const SCREENS: ScreenDef[] = [
  {
    name: "gateway",
    title: "Gateway",
    screen: { name: "gateway" },
    navSection: "top",
    invalidates: ["dashboard", "recurring"],
  },
  {
    name: "action-centre",
    keywords: ["attention", "tasks", "overdue", "due", "exceptions", "alerts"],
    title: "Action centre",
    screen: { name: "action-centre" },
    navSection: "top",
    card: { sub: "What needs attention now", key: "A" },
    invalidates: [
      "dashboard",
      "exceptions",
      "collections",
      "recurring",
      "stockAgeing",
      "tasks",
      "voucher-drafts",
      "approvals",
    ],
  },
  {
    name: "task-inbox",
    keywords: ["tasks", "notes", "follow up", "todo", "due dates"],
    title: "Task inbox",
    screen: { name: "task-inbox" },
    navSection: "top",
    invalidates: ["tasks"],
  },
  {
    name: "control-room",
    keywords: [
      "review",
      "sign-off",
      "audit",
      "exceptions",
      "sessions",
      "permissions",
      "evidence",
    ],
    title: "Control room",
    screen: { name: "control-room" },
    navSection: "top",
    card: { sub: "Reviews, access & sign-off", key: "O" },
    invalidates: [
      "controlReport",
      "controlReviews",
      "controlSignoff",
      "controlExceptions",
      "controlSessions",
      "controlExportPermissions",
      "controlBoundaries",
      "controlRetention",
    ],
  },
  {
    name: "assist",
    keywords: [
      "ai",
      "ocr",
      "invoice capture",
      "receipt capture",
      "ledger suggestion",
      "book search",
      "writing",
      "task routing",
    ],
    title: "Assist",
    screen: { name: "assist" },
    navSection: "top",
    card: { sub: "Capture, find & explain", key: "U" },
    invalidates: [
      "aiDocuments",
      "evidenceLedgerSuggestions",
      "naturalSearch",
      "aiRoutes",
      "collections",
      "ledgers",
    ],
  },
  {
    name: "voucher-entry",
    title: "Voucher entry",
    screen: { name: "voucher-entry" },
    navSection: "top",
    card: { sub: "Sales, purchase, payment…", key: "V" },
    invalidates: [
      "voucher",
      "nextNumber",
      "billsOpen",
      "ledgers",
      "stockItems",
      "units",
      "currencies",
      "voucherTypes",
    ],
  },
  {
    name: "voucher-drafts",
    keywords: ["draft vouchers", "unfinished entries", "resume voucher"],
    title: "Voucher drafts",
    screen: { name: "voucher-drafts" },
    navSection: "top",
    invalidates: ["voucher-drafts"],
  },
  {
    name: "sales-documents",
    keywords: [
      "quotation",
      "sales order",
      "delivery challan",
      "proforma",
      "quote",
      "dispatch",
    ],
    title: "Sales desk",
    screen: { name: "sales-documents" },
    navSection: "top",
    card: { sub: "Quotes, orders & delivery", key: "L" },
    invalidates: [
      "salesDocuments",
      "salesDocumentSeries",
      "salesDocumentNumber",
      "ledgers",
      "stockItems",
    ],
  },
  {
    name: "communications",
    keywords: ["email", "outbox", "smtp", "reminders", "messages", "contacts"],
    title: "Message outbox",
    screen: { name: "communications" },
    navSection: "top",
    card: { sub: "Draft, review and save email", key: "E" },
    invalidates: ["outboundMessages", "smtpProfiles", "partyContacts", "ledgers", "permissionMatrix"],
  },
  {
    name: "entry-templates",
    keywords: ["voucher patterns", "rent", "utilities", "bank charges"],
    title: "Entry templates",
    screen: { name: "entry-templates" },
    navSection: "top",
    invalidates: ["entry-templates"],
  },
  {
    name: "daybook",
    title: "Day book",
    screen: { name: "daybook" },
    navSection: "top",
    card: { sub: "Every entry, in order", key: "D" },
    invalidates: ["daybook"],
  },
  {
    name: "masters",
    keywords: [
      "ledgers",
      "items",
      "groups",
      "units",
      "voucher types",
      "currencies",
      "godowns",
      "stock groups",
    ],
    title: "Masters",
    screen: { name: "masters" },
    navSection: "top",
    card: { sub: "Ledgers, items, groups", key: "M" },
    invalidates: [
      "ledgers",
      "groups",
      "groupTree",
      "stockItems",
      "units",
      "voucherTypes",
      "currencies",
      "bom",
      "godowns",
      "stockGroups",
    ],
  },
  {
    name: "recurring",
    keywords: ["templates", "scheduled"],
    title: "Recurring vouchers",
    screen: { name: "recurring" },
    navSection: "top",
    invalidates: ["recurring"],
  },
  {
    name: "import-tally",
    title: "Import from Tally",
    screen: { name: "import-tally" },
    navSection: "top",
    invalidates: [],
  },

  {
    name: "trial-balance",
    title: "Trial balance",
    screen: { name: "trial-balance" },
    navSection: "books",
    card: { sub: "All closing balances", key: "T" },
    invalidates: ["trialBalance"],
  },
  {
    name: "profit-loss",
    title: "Profit & Loss",
    screen: { name: "profit-loss" },
    navSection: "books",
    card: { sub: "Trading + P&L account", key: "P" },
    invalidates: ["pnl"],
  },
  {
    name: "balance-sheet",
    title: "Balance sheet",
    screen: { name: "balance-sheet" },
    navSection: "books",
    card: { sub: "Assets and liabilities", key: "B" },
    invalidates: ["balanceSheet"],
  },
  {
    name: "cash-flow",
    keywords: ["cash flow statement"],
    title: "Cash flow",
    screen: { name: "cash-flow" },
    navSection: "books",
    invalidates: ["cashFlow"],
  },
  {
    name: "procurement",
    keywords: [
      "purchase requisition",
      "purchase order",
      "goods receipt",
      "grn",
      "buying",
    ],
    title: "Procurement",
    screen: { name: "procurement" },
    navSection: "books",
    card: { sub: "Requisitions, orders & receipts", key: "R" },
    feature: "inventory",
    invalidates: [
      "procurement-requisitions",
      "procurement-orders",
      "procurement-receipts",
      "procurement-debit-note-claims",
      "procurement-vendors",
      "ledgers",
      "groups",
      "stockItems",
    ],
  },
  {
    name: "stock-summary",
    title: "Stock summary",
    screen: { name: "stock-summary" },
    navSection: "books",
    feature: "inventory",
    card: { sub: "Quantities and value", key: "S" },
    invalidates: [
      "stockSummary",
      "stockAgeing",
      "stockByGodown",
      "stockBatches",
    ],
  },
  {
    name: "inventory-control",
    keywords: [
      "inventory planner",
      "reservations",
      "cycle count",
      "reorder",
      "forecast",
      "slow stock",
    ],
    title: "Inventory control",
    screen: { name: "inventory-control" },
    navSection: "books",
    feature: "inventory",
    card: { sub: "Supply, commitments & counts", key: "I" },
    invalidates: [
      "inventoryPlanner",
      "inventoryReservations",
      "inventoryTransfers",
      "inventoryCounts",
      "inventoryActions",
      "inventoryBomVersions",
      "inventoryManufacturing",
      "inventorySerials",
      "inventoryLandedCosts",
      "stockItems",
      "godowns",
      "ledgers",
    ],
  },
  {
    name: "month-close",
    keywords: ["month end", "close checklist", "period lock", "reconciliation"],
    title: "Month close",
    screen: { name: "month-close" },
    navSection: "books",
    card: { sub: "Reconcile, verify and lock", key: "C" },
    invalidates: ["monthClose"],
  },
  {
    name: "year-end",
    title: "Year-end close",
    screen: { name: "year-end" },
    navSection: "books",
    invalidates: ["yearEndPreview"],
  },

  {
    name: "registers",
    keywords: ["sales register", "purchase register"],
    title: "Registers",
    screen: { name: "registers" },
    navSection: "analysis",
    invalidates: ["register"],
  },
  {
    name: "collections",
    keywords: [
      "receivables",
      "overdue",
      "promise to pay",
      "follow up",
      "customer credit",
    ],
    title: "Collections queue",
    screen: { name: "collections" },
    navSection: "analysis",
    invalidates: ["collections"],
  },
  {
    name: "outstandings",
    keywords: ["ageing", "receivables", "payables", "bills"],
    title: "Outstandings",
    screen: { name: "outstandings" },
    navSection: "analysis",
    invalidates: ["outstandings"],
  },
  {
    name: "consolidated",
    title: "Consolidated reports",
    screen: { name: "consolidated" },
    navSection: "analysis",
    invalidates: ["consolidated", "company-registry"],
  },
  {
    name: "cost-centres",
    title: "Cost centres",
    screen: { name: "cost-centres" },
    navSection: "analysis",
    feature: "costCentres",
    invalidates: ["costCentres", "ccReport", "ccStatement"],
  },
  {
    name: "budgets",
    title: "Budgets",
    screen: { name: "budgets" },
    navSection: "analysis",
    invalidates: ["budgets", "budgetVariance"],
  },
  {
    name: "management-insights",
    keywords: [
      "owner dashboard",
      "variance",
      "ratios",
      "scenario",
      "schedule iii",
      "annotations",
      "report pack",
    ],
    title: "Management insights",
    screen: { name: "management-insights" },
    navSection: "analysis",
    invalidates: [
      "dashboard",
      "managementVariance",
      "managementScenarios",
      "scheduleMappings",
      "scheduleStatement",
      "reportAnnotations",
    ],
  },
  {
    name: "exceptions",
    keywords: ["exception reports", "negative stock", "unreconciled"],
    title: "Exceptions",
    screen: { name: "exceptions" },
    navSection: "analysis",
    invalidates: ["exceptions"],
  },

  {
    name: "supplier-dues",
    keywords: ["payables", "supplier payments", "cash coverage", "bills due"],
    title: "Supplier due queue",
    screen: { name: "supplier-dues" },
    navSection: "banking",
    invalidates: ["supplierDues", "supplierAdvances"],
  },
  {
    name: "banking",
    keywords: ["bank reconciliation", "brs", "post-dated", "pdc"],
    title: "Banking — reconciliation, BRS & post-dated",
    screen: { name: "banking" },
    navSection: "banking",
    navLabel: "Reconciliation",
    invalidates: [
      "bankLedgers",
      "bankRecon",
      "bankRules",
      "chequeConfig",
      "brs",
      "pdc",
    ],
  },

  {
    name: "payroll",
    title: "Payroll — employees & runs",
    screen: { name: "payroll" },
    navSection: "payroll",
    navLabel: "Employees & runs",
    feature: "payroll",
    invalidates: [
      "employees",
      "payrollRuns",
      "payrollPreview",
      "payHeads",
      "employeeHeads",
      "ptSummary",
    ],
  },

  {
    name: "gstr1",
    title: "GSTR-1",
    screen: { name: "gstr1" },
    navSection: "gst",
    card: { sub: "Outward supplies return", key: "1" },
    invalidates: ["gstr1", "gstValidate"],
  },
  {
    name: "gstr3b",
    title: "GSTR-3B",
    screen: { name: "gstr3b" },
    navSection: "gst",
    card: { sub: "Summary return + ITC", key: "3" },
    invalidates: ["gstr3b", "gst3bManual"],
  },
  {
    name: "gstr2b",
    keywords: ["reconciliation", "itc"],
    title: "GSTR-2B recon",
    screen: { name: "gstr2b" },
    navSection: "gst",
    invalidates: ["gstr2b", "ledgers"],
  },
  {
    name: "edocs",
    keywords: ["e-invoice", "e-way bill", "irn", "ewb"],
    title: "e-Invoice & e-Way",
    screen: { name: "edocs" },
    navSection: "gst",
    invalidates: ["edocList", "nicStatus", "nicCreds"],
  },
  {
    name: "tds",
    title: "TDS",
    screen: { name: "tds" },
    navSection: "gst",
    feature: "tds",
    invalidates: ["tdsSummary", "tdsSections"],
  },
  {
    name: "compliance-centre",
    keywords: [
      "calendar",
      "deadlines",
      "filing",
      "gst registration",
      "lut",
      "notice",
      "tax guidance",
    ],
    title: "Compliance centre",
    screen: { name: "compliance-centre" },
    navSection: "gst",
    invalidates: ["complianceCalendar", "gstRegistrations", "taxPacks"],
  },

  {
    name: "settings",
    title: "Settings",
    screen: { name: "settings" },
    navSection: "system",
    invalidates: [
      "backups",
      "bin",
      "users",
      "audit",
      "nicCreds",
      "nicStatus",
      "features",
      "invoiceConfig",
      "invoicePreview",
      "appInfo",
      "companyLock",
      "agentConfig",
      "aiConfig",
    ],
  },

  // Not in the sidebar — reached from the header / other screens — but the palette and the
  // invalidation map still need them.
  {
    name: "company-info",
    keywords: ["company details", "gstin", "pan"],
    title: "Company details",
    screen: { name: "company-info" },
    navSection: null,
    invalidates: [],
  },
  {
    name: "ledger-statement",
    title: "Ledger statement",
    screen: null, // needs a ledgerId — reached from ledger lists/search, never bare navigation
    navSection: null,
    invalidates: ["ledgerStatement"],
  },
];

const byName = new Map(SCREENS.map((s) => [s.name, s]));

export function screenDef(name: Screen["name"]): ScreenDef | undefined {
  return byName.get(name);
}

const WORKFLOW_SECTIONS: Partial<Record<Screen["name"], NavSectionId>> = {
  gateway: "home",
  "action-centre": "home",
  "task-inbox": "home",
  "control-room": "home",
  "voucher-entry": "create",
  "voucher-drafts": "create",
  "entry-templates": "create",
  daybook: "create",
  "sales-documents": "sales",
  communications: "sales",
  collections: "sales",
  procurement: "purchases",
  "supplier-dues": "purchases",
  banking: "banking",
  "stock-summary": "inventory",
  "inventory-control": "inventory",
  masters: "parties",
  outstandings: "parties",
  gstr1: "compliance",
  gstr2b: "compliance",
  gstr3b: "compliance",
  edocs: "compliance",
  tds: "compliance",
  "compliance-centre": "compliance",
  "month-close": "compliance",
  "year-end": "compliance",
  payroll: "payroll",
  "trial-balance": "reports",
  "profit-loss": "reports",
  "balance-sheet": "reports",
  "cash-flow": "reports",
  registers: "reports",
  consolidated: "reports",
  "cost-centres": "reports",
  budgets: "reports",
  "management-insights": "reports",
  exceptions: "reports",
  assist: "automation",
  recurring: "automation",
  "import-tally": "automation",
  settings: "automation",
};

export function navigationSection(def: ScreenDef): NavSectionId | null {
  return WORKFLOW_SECTIONS[def.name] ?? null;
}

/** Gateway cards, in registry order. */
export const CARD_SCREENS: (ScreenDef & {
  card: NonNullable<ScreenDef["card"]>;
  screen: Screen;
})[] = SCREENS.filter(
  (
    s,
  ): s is ScreenDef & {
    card: NonNullable<ScreenDef["card"]>;
    screen: Screen;
  } => !!s.card && !!s.screen,
);

/** Query-key families to refresh when `name` becomes the visible screen. */
export function invalidationFamilies(name: Screen["name"]): string[] {
  return byName.get(name)?.invalidates ?? [];
}
