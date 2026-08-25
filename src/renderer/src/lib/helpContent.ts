import type { CompanyFeatures } from "@shared/features";

export interface HelpArticle {
  id: string;
  title: string;
  summary: string;
  steps: string[];
  keywords: string[];
  screens: string[];
  feature?: keyof CompanyFeatures;
}

export const HELP_ARTICLES: HelpArticle[] = [
  {
    id: "voucher-entry",
    title: "Enter a voucher",
    summary: "Record sales, purchases, receipts, payments, contra and journals without leaving the keyboard.",
    steps: ["Open Voucher entry and choose a type, or use F4–F9.", "Confirm the date, party and balanced lines.", "Save with Command/Ctrl+Enter; warnings never post silently."],
    keywords: ["voucher", "sales", "purchase", "payment", "receipt", "contra", "journal", "f8", "f9"],
    screens: ["voucher-entry", "gateway"],
  },
  {
    id: "register-periods",
    title: "Monthly and quarterly registers",
    summary: "Review sales or purchases month by month, then switch the same evidence to quarter totals.",
    steps: ["Open Registers and select Sales or Purchase.", "Choose Monthly or Quarterly above the table.", "Drill into a period to inspect the vouchers behind its total."],
    keywords: ["register", "quarter", "quarterly", "month", "monthly", "sales ledger", "purchase ledger"],
    screens: ["registers"],
  },
  {
    id: "day-book",
    title: "Find and export entries",
    summary: "Filter the Day book by date or voucher kind, inspect source entries and export selected invoices.",
    steps: ["Set the working period in the top bar.", "Use kind and search filters to narrow the list.", "Select rows for batch PDF or open one row for its complete voucher."],
    keywords: ["day book", "find voucher", "batch pdf", "invoice export"],
    screens: ["daybook"],
  },
  {
    id: "bank-reconciliation",
    title: "Reconcile a bank statement",
    summary: "Import a statement into a review batch, match it to posted vouchers and keep exceptions visible.",
    steps: ["Open Banking and import the bank's CSV.", "Review ranked matches; Total does not clear entries automatically.", "Confirm matches, split fees where needed, then finish the reconciliation."],
    keywords: ["bank", "reconcile", "statement", "csv", "match", "fees"],
    screens: ["banking"],
  },
  {
    id: "gst-returns",
    title: "Prepare GST returns",
    summary: "Build GSTR-1 and GSTR-3B from posted voucher lines and resolve exceptions before export.",
    steps: ["Confirm company GSTIN, state and registration type.", "Open the return for the filing period and resolve highlighted exceptions.", "Export the reviewed JSON; filing remains an explicit portal action."],
    keywords: ["gst", "gstr1", "gstr-1", "gstr3b", "gstr-3b", "filing", "json", "gstin"],
    screens: ["gstr1", "gstr3b", "compliance-centre"],
  },
  {
    id: "gstr2b",
    title: "Reconcile GSTR-2B",
    summary: "Compare portal purchase evidence with your books and review exact matches, differences and missing documents.",
    steps: ["Import the downloaded GSTR-2B file.", "Review exact, probable and unmatched groups.", "Correct the source voucher or retain a documented exception."],
    keywords: ["gstr2b", "gstr-2b", "itc", "purchase", "reconciliation"],
    screens: ["gstr2b"],
  },
  {
    id: "backups",
    title: "Back up and restore safely",
    summary: "Use local snapshots for quick rollback and an encrypted complete backup for clean-machine recovery.",
    steps: ["Open Settings → Backups and save a local snapshot.", "Create a complete backup and store its passphrase separately; it includes managed evidence and portable attachment keys.", "On another computer, choose Restore backup from the company launcher and verify the restored books and documents."],
    keywords: ["backup", "restore", "recovery", "external disk", "encrypted", "lost data"],
    screens: ["settings"],
  },
  {
    id: "tally-import",
    title: "Move books from Tally",
    summary: "Dry-run a Tally XML export, review every warning and apply the accepted batch atomically.",
    steps: ["Export Masters and Vouchers as XML from Tally.", "Open Import and run the preview first.", "Resolve rejected rows, then apply; Total keeps source hashes and import history."],
    keywords: ["tally", "xml", "migration", "import", "move books"],
    screens: ["import-tally"],
  },
  {
    id: "inventory",
    title: "Control stock and manufacturing",
    summary: "Track godowns, batches, serials, reservations, counts, transfers and manufacturing evidence.",
    steps: ["Enable Inventory in company features.", "Create items, units and godowns in Masters.", "Use Inventory control for shortages, counts, transfers and production work."],
    keywords: ["stock", "inventory", "godown", "batch", "serial", "manufacturing", "bom"],
    screens: ["stock-summary", "inventory-control", "masters"],
    feature: "inventory",
  },
  {
    id: "payroll",
    title: "Run payroll with review",
    summary: "Maintain employees and pay heads, calculate a draft run and review statutory totals before posting.",
    steps: ["Create employees and pay heads.", "Generate the period run and resolve missing attendance or configuration.", "Approve and post only after reviewing the accounting and statutory evidence."],
    keywords: ["payroll", "salary", "employee", "payslip", "pf", "esic", "professional tax"],
    screens: ["payroll"],
    feature: "payroll",
  },
  {
    id: "collections",
    title: "Follow up receivables",
    summary: "Prioritise overdue bills, record promises and draft grounded reminders without sending automatically.",
    steps: ["Open Collections queue and review oldest or highest-risk bills.", "Record the next action or promise date.", "Create an editable reminder grounded only in the invoices you selected."],
    keywords: ["collections", "receivable", "overdue", "customer", "reminder", "promise"],
    screens: ["collections", "outstandings"],
  },
  {
    id: "supplier-dues",
    title: "Plan supplier payments",
    summary: "Review due bills, cash pressure and payment proposals while keeping final bank action outside Total.",
    steps: ["Open Supplier dues and inspect priority evidence.", "Select bills for a payment run and review discounts or holds.", "Approve the proposal; export is not a bank instruction."],
    keywords: ["supplier", "payable", "payment run", "bills", "vendor"],
    screens: ["supplier-dues"],
  },
  {
    id: "assist-privacy",
    title: "Use Assist without losing control",
    summary: "Configure OpenAI or a compatible provider, preview context and keep every generated voucher as an inert proposal.",
    steps: ["Configure a provider in Settings → AI; keys use OS-protected storage.", "Preview the exact company context before sending it.", "Review citations and explicitly accept any proposed accounting action."],
    keywords: ["ai", "openai", "compatible", "localhost", "api key", "copilot", "privacy"],
    screens: ["assist", "settings"],
  },
  {
    id: "shortcuts",
    title: "Work from the keyboard",
    summary: "Red letters identify mnemonics; global navigation uses Alt plus the letter and voucher types use F4–F9.",
    steps: ["Press ? to see the complete shortcut map.", "Use Command/Ctrl+K to search anywhere.", "Use Command/Ctrl+[ and ] to move through navigation history."],
    keywords: ["shortcut", "keyboard", "red letter", "mnemonic", "f4", "command k"],
    screens: ["gateway", "voucher-entry"],
  },
  {
    id: "saved-report-views",
    title: "Save a report view",
    summary: "Keep a report's period, grouping and comparison settings for repeat reviews without changing the books.",
    steps: ["Set the report period and grouping you need.", "Choose Views, name the setup and save it for this company.", "Apply or remove the view later; report totals are always recalculated from posted voucher lines."],
    keywords: ["saved view", "report setup", "comparison", "quarter", "register"],
    screens: ["registers", "profit-loss", "balance-sheet"],
  },
  {
    id: "large-ledgers",
    title: "Review a large ledger",
    summary: "Ledger statements load in bounded pages while opening, closing and report totals continue to cover the full period.",
    steps: ["Open the ledger and set the required period.", "Use the page controls or filters instead of widening the period unnecessarily.", "Export the full statement when you need complete evidence outside the on-screen window."],
    keywords: ["large ledger", "pagination", "many vouchers", "slow", "statement"],
    screens: ["ledger-statement"],
  },
  {
    id: "support-retry",
    title: "Retry an offline support case",
    summary: "A failed support delivery stays in the local outbox with its status and never becomes a false success.",
    steps: ["Open Support from the top bar and review the queued case.", "Reconnect, then choose Retry; attachments require fresh approval before upload.", "Keep the local case ID until the support service returns a tracking token."],
    keywords: ["support", "offline", "retry", "queued", "failed", "case"],
    screens: ["gateway", "settings"],
  },
  {
    id: "migration-reconciliation",
    title: "Reconcile a migration",
    summary: "Compare source totals with Total, resolve every rejected row and retain a privacy-safe certificate for the accepted run.",
    steps: ["Run a dry preview using the matching source profile.", "Reconcile openings, vouchers, receivables, payables, stock, tax and attachments.", "Apply only a zero-difference run, then export its certificate and keep the source export outside the repository."],
    keywords: ["busy", "marg", "zoho", "spreadsheet", "migration", "certificate", "reconcile"],
    screens: ["import-tally", "company-info"],
  },
  {
    id: "period-close",
    title: "Close a month or year",
    summary: "Run evidence-based readiness checks, take a verified backup and lock reviewed periods deliberately.",
    steps: ["Open Month close or Year-end close.", "Resolve reconciliation, exception and backup gates.", "Record sign-off and set the period lock only after review."],
    keywords: ["month close", "year end", "lock", "sign off", "closing"],
    screens: ["month-close", "year-end", "control-room"],
  },
  {
    id: "data-health",
    title: "Check data health",
    summary: "Run integrity, storage and maintenance checks without editing accounting data.",
    steps: ["Open Settings → Data health.", "Run Quick check first; use Full check when investigating a problem.", "Keep the original company and contact support before attempting recovery."],
    keywords: ["database", "corrupt", "integrity", "sqlite", "health", "slow", "disk"],
    screens: ["settings"],
  },
];

function tokens(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9₹-]+/g) ?? [];
}

export function searchHelp(query: string, articles = HELP_ARTICLES): HelpArticle[] {
  const terms = [...new Set(tokens(query))];
  if (terms.length === 0) return articles;
  return articles
    .map((article) => {
      const title = article.title.toLowerCase();
      const keywords = article.keywords.join(" ").toLowerCase();
      const body = `${article.summary} ${article.steps.join(" ")}`.toLowerCase();
      const score = terms.reduce(
        (total, term) =>
          total +
          (title.includes(term) ? 8 : 0) +
          (keywords.includes(term) ? 4 : 0) +
          (body.includes(term) ? 1 : 0),
        0,
      );
      return { article, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.article.title.localeCompare(b.article.title))
    .map((item) => item.article);
}

export function contextualHelp(
  screen: string,
  features: CompanyFeatures,
): HelpArticle[] {
  return HELP_ARTICLES.filter(
    (article) =>
      article.screens.includes(screen) &&
      (!article.feature || features[article.feature]),
  );
}
