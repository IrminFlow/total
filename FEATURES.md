# Total v5 complete feature catalogue

Last updated: 29 August 2026.

This file lists the implemented capabilities present on the `v5-cloud-agent-sync` branch. It is a
feature inventory, not a claim that every optional cloud service has production credentials or that
the unsigned staging build is a signed public release. Unless a line says otherwise, the code path
and ordinary automated coverage exist. Configuration, representative-data acceptance, installed-
device acceptance, signing, final review, and public release status are tracked separately in
[ROADMAP.md](ROADMAP.md), [TASKS.md](TASKS.md), and [HUMAN.md](HUMAN.md).

## Product boundaries and guarantees

- Total is a macOS and Windows Electron desktop application; it is not a native mobile application.
- Core accounting, reporting, backup, restore, OCR, and non-AI workflows work without an account or
  internet connection.
- Each company has an independent SQLite database. SQLite, not JSON, is the transactional source of
  truth.
- JSON mirrors, portable packages, MCP resources, and agent proposals are controlled integration
  formats. Editing them never posts accounting entries directly.
- Money is stored as integer paise, quantities as integer thousandths, and reports are derived from
  voucher lines and opening balances.
- AI can explain, search, navigate, draft, and propose. AI cannot post accounting changes.
- Optional collaboration synchronizes encrypted proposals, drafts, comments, and tasks. It does not
  synchronize the company database or posted books.
- NIC live filing and online GST portal APIs are not features of v5. Offline GST calculation,
  reconciliation, review, evidence, and government-tool exports are included.
- Secrets are excluded from company books, JSON mirrors, backups, renderer state, logs, diagnostics,
  support payloads, examples, and commits.
- Permanent book access and portable export do not depend on an AI subscription, cloud account, or
  entitlement state.

## Complete desktop surface map

### Application shell and universal surfaces

- **Company selector:** lists local companies, creates new companies, opens demo companies, imports
  portable backups, exposes company-safe metadata, and supports keyboard selection.
- **Lock screen:** supports local owner, accountant, and viewer sign-in, PIN verification, persistent
  throttling, session locking, and protected return to the active company.
- **Financial-workstation shell:** provides collapsible workflow navigation for Home, Create, Sales,
  Purchases, Banking, Inventory, Parties, Compliance, Payroll, Reports, and Automation.
- **Stable top utility bar:** exposes company switching, search, help, theme, support email, settings,
  backup state, and collaboration state without moving between screens.
- **Gateway:** combines keyboard-first task cards, financial snapshot, recent work, work due, alerts,
  trends, configurable layout, workspace profiles, and red mnemonic letters.
- **Command palette:** searches navigation commands, local book records, recent records, periods, and
  company actions from any screen.
- **Shortcut help:** lists global, Gateway, voucher, legacy function-key, and customized bindings;
  detects collisions and can reset overrides.
- **Help centre:** searches bundled offline help, shows screen-aware guidance, troubleshooting,
  release notes, training pathways, and contextual related work.
- **Copilot panel:** previews selected context, manages conversations, answers with citations, drafts
  proposals, supports cancellation and history deletion, and preserves an AI-disabled state.
- **Action Centre:** combines overdue work, exceptions, collections, recurring work, stock ageing,
  approvals, voucher drafts, and personal tasks into one review queue.
- **Task Inbox:** creates assigned tasks with priority, due date, completion history, and typed links
  to records or reports.
- **Control Room:** presents review questions, period sign-off, policy exceptions, session evidence,
  permissions, export controls, department boundaries, retention controls, and the period control
  report.
- **Assist:** contains the document inbox, invoice and receipt extraction, ledger suggestions,
  constrained book search, reconciliation assistance, AI task routing, variance explanations, and
  draft writing.

### Entry, books, and master-data surfaces

- **Voucher Entry:** supports Contra, Payment, Receipt, Journal, Sales, Purchase, Credit Note, Debit
  Note, Stock Journal, and Physical Stock entries with accounting, invoice, manufacturing, and stock-
  count layouts.
- **Voucher Drafts:** lists, resumes, and discards incomplete non-posted accounting work.
- **Entry Templates:** stores reusable accounting and invoice patterns that open as editable drafts.
- **Day Book:** lists vouchers by period and kind, drills into entries, supports bounded paging,
  multi-selection, batch PDF/CSV actions, review evidence, tags, and controlled reversal.
- **Masters:** manages ledgers, groups, stock items, units, voucher types, currencies, godowns, stock
  groups, tax attributes, bill behavior, credit rules, and pricing defaults.
- **Company Details:** manages registration, GSTIN, PAN, address, state, financial-year identity,
  onboarding state, and company-local settings.
- **Ledger Statement:** shows opening balance, activity, running balance, closing balance, bounded
  paging, voucher drill-through, PDF, and CSV.
- **Recurring Vouchers:** creates weekly and monthly templates, previews the next due work, opens
  editable drafts, pauses schedules, posts reviewed occurrences, and preserves history.
- **Import from Tally:** provides source guidance, dry run, duplicate detection, warnings,
  reconciliation, recovery points, and controlled apply.

### Sales, purchases, parties, banking, inventory, and workforce surfaces

- **Sales Desk:** manages quotations, sales orders, delivery challans, proformas, document numbering,
  conversion lineage, recurring invoice drafts, returns, warranties, territories, subscriptions,
  custom fields, and offline customer bundles.
- **Message Outbox:** manages contacts, statement and reminder drafts, review, SMTP profiles, batches,
  attempts, delivery events, retries, acknowledgements, and offline-safe status history.
- **Collections Queue:** ranks overdue receivables and manages ownership, promises, disputes,
  reminders, receipt suggestions, DSO, ageing trends, risk, discounts, and forecasts.
- **Outstandings:** presents bill-wise receivables and payables, ageing, due dates, allocations,
  advances, and ledger drill-through.
- **Procurement:** contains separate requisition, purchase-order, goods-receipt, supplier-intelligence,
  debit-note-claim, reorder, and vendor-verification workspaces.
- **Supplier Due Queue:** ranks payable bills, previews cash coverage, creates payment runs, shows
  supplier advances, and produces payment advice.
- **Banking:** imports statements, manages reconciliation rules and evidence, shows BRS, transfers,
  charges, post-dated items, cheques, opening differences, and match status.
- **Stock Summary:** shows item and godown quantities, value, ageing, batches, movement drill-through,
  and bounded large-book rows.
- **Inventory Control:** manages planning, reservations, transfers, cycle counts, action queues, BOM
  versions, manufacturing orders, serials, landed cost, replenishment, and demand policies.
- **Payroll:** manages employees, pay heads, salary structures, attendance, leave, payroll runs,
  preflight, posting, payslips, loans, reimbursements, contractors, settlements, shifts, provisioning,
  and statutory workspaces.

### Compliance, close, and report surfaces

- **GSTR-1:** calculates outward supplies, validates source data, drills to vouchers, snapshots return
  evidence, and exports offline-tool data.
- **GSTR-3B:** calculates tax and ITC summaries, supports reviewed manual adjustments, snapshots the
  period, and exports offline-tool data.
- **GSTR-2B Reconciliation:** imports source evidence, matches purchases, classifies differences,
  owns ITC follow-up actions, and hands reviewed fixes to entry workflows.
- **e-Invoice and e-Way:** creates reviewed offline JSON, stores imported lifecycle evidence, tracks
  pending/generated/failed/cancelled states, and never claims live NIC filing in v5.
- **TDS:** manages sections, thresholds, PAN-aware rates, deductions, summaries, challans,
  acknowledgements, and quarterly controls.
- **Compliance Centre:** combines registrations, deadlines, GST readiness, LUT/export treatment,
  notice evidence, statutory ownership, and effective-dated tax guidance packs.
- **Month Close:** checks banking, GST, books, suspense, stock, backup, review work, and approvals
  before applying a durable period lock.
- **Year-End Close:** selects a completed financial year, previews Profit and Loss and the closing
  journal, requires an explicit `CLOSE` confirmation, posts the closing journal, and opens the
  created voucher. It refuses to close an in-progress first financial year.
- **Registers:** presents Sales and Purchase registers by month or Indian financial-year quarter,
  totals voucher count, taxable value, GST, and invoice total, drills to exact Day Book dates, and
  exports the selected granularity.
- **Trial Balance:** shows ledger/group closing balances, hierarchy, totals, comparison, saved views,
  export, print, and voucher drill-through.
- **Profit and Loss:** shows trading and P&L hierarchy, gross and net profit, comparisons, annotations,
  saved views, export, print, and source drill-through.
- **Balance Sheet:** shows assets and liabilities, hierarchy, current/prior comparison, annotations,
  saved views, export, print, and source drill-through.
- **Cash Flow:** derives operating, investing, and financing movements with period comparison,
  source drill-through, saved views, export, and print.
- **Consolidated Reports:** combines selected companies using reviewed translation rates,
  eliminations, and explicit source-company columns.
- **Cost Centres:** manages hierarchical operating dimensions and provides statements and P&L with
  allocation-level drill-through.
- **Budgets:** creates financial-year or monthly ledger/group/cost-centre budgets and compares exact
  actuals with variance.
- **Management Insights:** provides owner and accountant decision views, ratios with formulas,
  variance drivers, scenarios, Schedule III mapping, annotations, and portable report packs.
- **Exceptions:** reports suspense, negative stock, unusual entries, unreconciled banking, tax
  problems, deleted work, and other review conditions.

### Settings surfaces

- **Backups:** creates, verifies, restores, replicates, schedules, rotates, forecasts storage, and
  records recovery drills.
- **Bin:** lists soft-deleted vouchers and supports controlled restoration or authorized disposal.
- **Users:** manages owner, accountant, and viewer accounts, PINs, temporary access, roles, and login
  state.
- **Controls:** configures maker-checker rules, approval thresholds, permissions, department scope,
  export permissions, policy exceptions, sign-off, and evidence retention.
- **Audit:** searches append-only audit events, verifies hash integrity, compares before/after fields,
  and exports controlled evidence.
- **NIC:** stores optional credentials through OS-protected secret storage and shows status while live
  NIC operations remain excluded from v5.
- **Features:** toggles inventory, bill-wise accounting, cost centres, TDS, multi-currency, payroll,
  negative-stock blocking, batch tracking, and credit-limit enforcement without deleting data.
- **Invoice:** configures identity, numbering, logo, labels, payment instructions, UPI QR, templates,
  regional customer labels, preview, and PDF behavior.
- **AI:** configures OpenAI, OpenAI-compatible HTTPS, loopback local providers, task routes, models,
  timeouts, context limits, capability tests, encrypted keys, conversations, and AI-off mode.
- **Agents:** configures JSON/CSV mirrors, proposal folders, approved workspace roots, AI Operator,
  MCP tokens, mirror freshness, refresh requests, and local agent instructions.
- **Collaboration:** configures optional Supabase review sync, device identity, recovery keys,
  invitations, membership, pause/resume, conflicts, quarantine, and connection diagnostics.
- **Integrations:** manages declarative plugins, partner import mappings, report extensions, webhooks,
  settlement reviews, ecommerce reviews, shipment exports, and automation schedules.
- **Email:** configures encrypted SMTP credentials, sender identity, capability testing, preview,
  approval, and delivery behavior.
- **Privacy:** shows every network authority, consent, provider endpoint, bank feed, webhook, MCP and
  folder permission, diagnostic payload, crash envelope, retention rule, and deletion control.
- **Data Health:** runs quick/full integrity checks, WAL checkpoint, optimize, size analysis,
  reclaimable-space analysis, destination health, workload status, and copy-based recovery.
- **Accessibility:** configures theme, interface scale, reduced/no motion, spaced text, number grouping,
  Hindi shell language, invoice label language, and support-report consent.
- **Community:** manages the idea board, votes, follows, referral codes, partner mode, training
  companies, practitioner progress, feature tips, and cohort opt-in.
- **About:** shows version, build identity, release notes, update state, licensing promises, support,
  documentation, and diagnostic entry points.

## Detailed feature register

### 1. Onboarding, setup, and activation

1. **Readiness check.** Verifies writable storage, free disk space, system clock, secure credential
   storage, and automatic-backup capability before company creation.
2. **Guided company setup.** Captures business type, GST status, state, books-from date, prior
   software, and optional inventory and payroll scope, then derives reviewable defaults.
3. **Opening-balance review.** Shows assets, liabilities, unresolved rows, total debits, total
   credits, and the remaining difference before normal posting.
4. **Resumable setup progress.** Tracks company details, ledgers, opening stock, bank accounts,
   taxes, backup setup, and first voucher in Company Details.
5. **Business templates.** Provides retailer, wholesaler, service, manufacturer, freelancer, and
   professional-services charts of accounts.
6. **Tally migration wizard.** Sequences export instructions, file validation, dry run, mapping,
   reconciliation, controlled import, and sign-off evidence.
7. **Spreadsheet migration wizard.** Maps arbitrary columns to ledgers, parties, items, vouchers,
   journals, and opening balances with saved profiles and validation preview.
8. **Industry demo companies.** Generates retailer, wholesale, service, manufacturing, freelance,
   and professional-practice books with realistic masters, vouchers, and feature defaults.
9. **First-voucher coaching.** Guides voucher type selection, keyboard use, validation, and saving,
   then dismisses after successful use.
10. **Setup health score.** Measures ledger readiness, opening balance, banking, tax, backup,
    invoice identity, and first-voucher completion.
11. **Accountant setup handoff.** Exports a setup questionnaire and imports the reviewed accountant
    configuration atomically with an explicit checklist.
12. **Prior-software adaptation.** Adjusts migration terminology and guidance for Tally, Busy, Marg,
    Zoho Books, spreadsheets, and first-time bookkeeping.
13. **Sample import generation.** Produces valid CSV and JSON templates using the company’s own IDs,
    settings, and supported schema.
14. **Setup rollback points.** Creates verified recovery points before imports, restores, closes,
    migrations, and other high-risk configuration work.
15. **Private activation milestones.** Measures setup and first-use milestones locally and shares
    only an allowlisted aggregate when the user explicitly opts in.

### 2. Navigation, workspace, and daily operations

16. **Month-close workspace.** Brings bank reconciliation, GST checks, suspense, stock exceptions,
    verified backup, review work, and period locking into one flow.
17. **Universal command actions.** Opens entry, reports, periods, exports, backups, settings, and
    company switching from the command palette.
18. **Shortcut conflict detection.** Validates configurable keyboard bindings separately for
    Gateway, voucher, screen, and global contexts before accepting them.
19. **Custom Gateway layout.** Saves card order, visibility, and compact or comfortable density per
    company.
20. **Saved workspace profiles.** Provides Bookkeeper, Owner, GST, Collections, Inventory, and
    Payroll arrangements.
21. **Continue working.** Restores the last company, screen, working period, report state, selection,
    and safe scroll position after restart.
22. **Recent records.** Reopens recently viewed vouchers, ledgers, parties, items, reports, and
    commands from the palette.
23. **Cross-company switching.** Changes company without returning to the picker and preserves each
    company’s independent workspace and navigation continuation.
24. **Natural date language.** Understands today, yesterday, prior weekdays, months, quarters,
    Indian financial years, and supported shorthand consistently.
25. **Batch action tray.** Applies exact-selection PDF, CSV, print, tagging, review-evidence, and
    authorized reversal actions to selected Day Book rows.
26. **Personal task inbox.** Stores notes, priority, assignee, due date, typed record/report links,
    Action Centre visibility, and completion history.
27. **Device user preferences.** Shares pinned screens and density for one local user across
    companies while keeping company layouts and history isolated.
28. **Focus mode.** Hides unrelated navigation during voucher, reconciliation, return, and close
    work with a full-width canvas and keyboard toggle.
29. **Screen history.** Provides backward, forward, direct timeline jumps, meaningful drill labels,
    and unsaved-change protection.
30. **Morning digest.** Summarizes cash, overdue receivables, overdue payables, exceptions,
    compliance deadlines, recurring work, and direct next actions locally.

### 3. Voucher entry and accounting controls

31. **Duplicate detection.** Warns about repeated supplier invoice numbers, references, dates,
    parties, amounts, and semantically equivalent imported transactions.
32. **Suspicious-entry checks.** Flags future dates, unusual round amounts, unexpected party
    direction, tax asymmetry, sensitive ledgers, and reversed debit/credit patterns.
33. **Explicit reversal.** Creates an immutable linked reversal with reason, author, original trace,
    permission checks, and closed-period guardrails.
34. **Draft vouchers.** Stores incomplete accounting, invoice, manufacturing, and physical-count
    work outside posted books and consumes the draft atomically on posting.
35. **Validation summary.** Shows every blocking error and warning together with links to the exact
    entry fields.
36. **Voucher duplication.** Copies accounting, inventory, tax, and party context while assigning a
    new identity/date and recalculating references.
37. **Entry templates.** Stores reusable accounting and invoice line patterns that always open as
    editable, non-posted drafts.
38. **Party-history defaults.** Suggests narration, tax ledgers, cost centres, pricing, and bill
    behavior without silently applying or posting them.
39. **Split receipt/payment allocation.** Allocates one receipt or payment across open bills,
    discounts, write-offs, and advances with exact-paise validation.
40. **Voucher evidence bundles.** Associates invoices, receipts, email evidence, delivery documents,
    and managed attachments with checksums and optional encryption.
41. **Voucher review comments.** Keeps append-only author/timestamp discussion separate from
    accounting narration and printed documents.
42. **Approval thresholds.** Requires maker-checker approval for configured amounts, voucher types,
    sensitive ledgers, or policy conditions.
43. **Clipboard line import.** Parses bounded Ledger/Debit/Credit tabular text, resolves ledgers,
    converts exact paise, previews rows, and verifies balance before use.
44. **Compound-entry assistant.** Builds reviewable balanced drafts for asset purchases, loan
    repayments, import purchases, and advance adjustments.
45. **Safe macro replay.** Captures supported entry patterns as templates while preserving every
    validation, permission, lock, and approval rule.

### 4. Receivables, collections, and customer credit

46. **Collections queue.** Ranks overdue invoices using amount, age, payment history, dispute state,
    promise date, owner, and risk evidence.
47. **Promise-to-pay tracking.** Records amount, date, owner, notes, outcome, and follow-up history
    without altering books.
48. **Credit-limit enforcement.** Warns or blocks prospective exposure under company settings and
    requires an audited override reason where permitted.
49. **Customer timeline.** Combines invoices, receipts, credit notes, promises, reminders, disputes,
    contacts, and notes chronologically.
50. **Statement generation.** Creates branded date-range statements with opening, activity, closing,
    bill detail, PDF, and CSV.
51. **Reminder drafts.** Produces reviewed email- and WhatsApp-ready messages grounded in selected
    invoices, overdue context, payment instructions, and citations; it does not auto-send.
52. **Reminder cadence.** Stores configurable customer intervals and presents due work in a manual-
    review queue.
53. **Invoice disputes.** Tracks reason, owner, state, resolution, evidence, and exclusion from
    ordinary reminder runs.
54. **Collection ownership.** Assigns parties to staff and shows workload, follow-ups, exposure,
    collected amount, and 90-day performance.
55. **Receipt suggestions.** Ranks open-invoice matches by exact or near amount, payer, reference,
    due date, and history while requiring review.
56. **Ageing trends.** Compares current, 1–30, 31–60, 61–90, and over-90-day customer balances across
    six months.
57. **Collection days.** Calculates customer and company DSO from visible 90-day sales and
    receivables inputs with drill-through.
58. **Customer risk bands.** Produces explainable low, medium, or high risk from lateness, broken
    promises, disputes, and exposure.
59. **Early-payment terms.** Models discount amount, expiry, net receipt, and annualized financing
    cost without automatically changing invoices.
60. **Collections forecast.** Projects receipts using due dates, explicit promises, and observed
    customer payment delay.

### 5. Payables, purchasing, and supplier management

61. **Supplier due queue.** Ranks payable bills by due date, discount deadline, amount, urgency, and
    visible cash or bank coverage.
62. **Payment-run drafts.** Retains exact bill selection, previews bank impact, revalidates stale
    bills, posts atomically after owner review, and preserves the run history.
63. **Three-way matching.** Compares purchase order, goods receipt, and supplier invoice quantities,
    rates, and taxes while ensuring financial posting cannot receive stock twice.
64. **Purchase requisitions.** Records department, need, required date, approval/rejection evidence,
    and controlled conversion to a purchase order.
65. **Purchase orders.** Supports direct and requisition-backed orders with draft, issue, receipt,
    close, and cancel states plus ordered, delivered, accepted, rejected, billed, and outstanding
    quantities.
66. **Goods receipt notes.** Records accepted and rejected inspection quantities, partial receipts,
    linked stock journals, receipt history, and supplier-invoice handoff independently from finance.
67. **Supplier price history.** Shows latest rate, weighted rate, recent trend, and evidence from
    ordinary and GRN-matched purchases during entry.
68. **Supplier comparison.** Compares latest and weighted price, tax-inclusive cost, terms, lead
    time, on-time delivery, and rejection rate with source evidence.
69. **Debit-note claims.** Prepares editable, evidence-linked claims for rejected goods, shortages,
    and invoice-over-PO rate differences without false stock movement or duplicate linking.
70. **Expense approval inbox.** Applies employee/department policy, expense-ledger classification,
    cost-centre context, evidence, different-user approval, and controlled posting.
71. **Payment advice.** Produces supplier-wise remittance detail for settled bills from individual
    payments and posted payment runs.
72. **Supplier advances.** Uses the same FIFO bill allocator as payables to show source payments,
    pending adjustment, ageing, and automatic reduction against later bills.
73. **Reorder-to-PO handoff.** Groups owner-reviewed replenishment suggestions by proven supplier
    into editable purchase-order drafts that are never auto-issued.
74. **Vendor onboarding.** Stores contacts, tax IDs, bank account, IFSC, Udyam evidence, duplicate
    signals, verification/blocking state, and role-based bank masking.
75. **Supplier concentration.** Measures purchase share, category exposure, and sole-source item
    risk for the selected period.

### 6. Banking, cash, and treasury

76. **Learned reconciliation rules.** Retains reviewed description-to-ledger mappings with
    confidence, accepted/rejected feedback, bank and effective-date scope, and rollback.
77. **Reconciliation completeness.** Separates matched, bank-only, book-only, ignored, and timing-
    difference statement rows and retains source evidence.
78. **Opening bank difference.** Compares statement opening balance with books and explains
    unavailable data or mismatch before matching begins.
79. **Multi-format statement import.** Normalizes bounded CSV, XLSX, OFX, QIF, and MT940 files through
    one preview-and-apply pipeline with bank presets.
80. **Reconciliation rule builder.** Supports text, reference, amount range, direction, bank, date,
    target ledger, and narration conditions.
81. **Transfer matching.** Ranks both sides of inter-account transfers, creates a reviewed one-time
    Contra entry, and retains statement links.
82. **Bank-charge extraction.** Splits charges and inclusive GST from settlements and posts a linked
    adjustment without rewriting the original receipt.
83. **Cheque lifecycle.** Tracks issue, deposit, clearing, bounce, cancellation, and stale status
    with explicit dates and evidence.
84. **Cash denomination count.** Compares physical denomination totals with books and permits only an
    owner-approved posting of the exact reviewed difference.
85. **Daily cash position.** Combines cash and bank accounts, open receivables, open payables, and
    recurring commitments.
86. **Thirteen-week cash forecast.** Projects dated open bills, payroll, recurring commitments, and
    manual events with event drill-through and calendar-accurate dates.
87. **Payment-file export.** Generates reviewed Generic NEFT, HDFC, and ICICI files after beneficiary,
    debit-account, and format validation; it never transmits them to a bank.
88. **Optional bank-feed adapter.** Stores revocable read-only consent through encrypted credentials
    and ingests statement data while retaining manual import as a permanent fallback. A real provider
    agreement and production credentials are not bundled.
89. **Liquidity scenarios.** Saves non-posting models for collection timing, major purchases, loans,
    tax payments, and one-off cash events.
90. **Treasury alerts.** Shows configured shortfall and sustained idle-cash thresholds without
    investment advice or automatic money movement.

### 7. GST, TDS, and Indian compliance

91. **GST readiness centre.** Centralizes missing GSTIN, HSN/SAC, place of supply, rate, reverse
    charge, registration, and source-data problems.
92. **Books-to-return bridge.** Drills every GSTR-1 and GSTR-3B amount to the exact voucher and tax
    lines that produced it.
93. **Return freeze.** Snapshots a prepared period and displays later book changes before another
    export or filing decision.
94. **Filing acknowledgement store.** Retains ARN or other acknowledgement, filing date, status,
    submitted JSON evidence, and period linkage when supplied by the user.
95. **GSTR-2B reconciliation.** Retains idempotent source evidence and matches GSTIN, invoice number,
    date, taxable value, and tax using explicit tolerances.
96. **ITC action queue.** Classifies missing, mismatched, blocked, reversed, and supplier-follow-up
    credits with owner, state, evidence, and next action.
97. **e-Invoice lifecycle evidence.** Tracks pending, generated, failed, and cancelled IRN states,
    retry evidence, reviewed offline JSON, and imported results. Live NIC submission is excluded.
98. **e-Way lifecycle evidence.** Tracks generation, extension, cancellation, vehicle updates,
    expiry, reviewed offline JSON, and imported results. Live NIC submission is excluded.
99. **TDS applicability helper.** Suggests section, threshold, PAN treatment, and rate but requires
    confirmation before voucher posting.
100. **Quarterly TDS workspace.** Reconciles deductions, deductees, challans, differences, and filing
    acknowledgements by quarter.
101. **Compliance calendar.** Tracks GST, TDS, PF, ESI, advance tax, state obligations, and custom
    deadlines with owner and status.
102. **LUT and export guidance.** Distinguishes export with payment, export without payment, SEZ, and
    deemed export and stores registration-specific LUT acknowledgement and validity.
103. **Multiple GST registrations.** Supports state registrations, registration-scoped vouchers,
    returns, document numbering, frozen filings, manual 3B adjustments, and stock-location checks.
104. **Notice evidence pack.** Exports selected return snapshots, vouchers, 2B imports,
    reconciliations, attachments, and tamper-evident audit history for a period.
105. **Versioned tax guidance packs.** Stores effective-dated explanatory content separately from
    deterministic GST and TDS calculation code.

### 8. Reports, analysis, and management insight

106. **Universal report drill-down.** Opens the exact contributing voucher set from supported report
    rows and amounts.
107. **Report provenance.** Displays period, as-of date, filters, accounting basis, generation time,
    source freshness, grouping, and comparison on reports and exports.
108. **Saved report views.** Persists filters, columns, sorting, comparison, date logic, grouping,
    density, and company scope.
109. **Budget versus actual.** Compares monthly or financial-year targets with actuals by ledger,
    group, cost centre, department, project, and branch.
110. **Rolling comparisons.** Supports previous month, previous quarter, equal prior period, previous
    year, previous financial year, and custom ranges.
111. **Variance explanations.** Ranks customer, supplier, item, price, quantity, residual, and timing
    drivers with exact voucher evidence.
112. **Ratio definitions.** Shows formulas and source navigation for liquidity, leverage, margin,
    turnover, and collection ratios.
113. **Owner decision desk.** Presents cash, sales, margin, collections, payables, stock, tax, and
    upcoming obligations in direct business language.
114. **Accountant workbench.** Prioritizes suspense, unusual entries, stock exceptions, banking,
    tax differences, and review tasks through Action Centre.
115. **Cost-centre P&L.** Reports parent/child department, project, store, and branch performance with
    allocation-level voucher drill-through.
116. **Branch and company consolidation.** Combines selected companies using reviewed translation
    rates and explicit elimination columns without merging source databases.
117. **Schedule III statements.** Maps groups and notes, compares current and prior periods, and
    blocks silent omission through an unmapped-balance control.
118. **Scenario reports.** Saves conservative, base, and growth assumptions and projections without
    affecting posted books.
119. **Report annotations.** Adds authored notes to periods or rows and includes only selected
    explanations in exports.
120. **Portable report packs.** Generates an indexed PDF/ZIP containing statements, schedules,
    registers, returns, supporting ledgers, a manifest, and optional signature evidence.

### 9. Inventory, fulfilment, and manufacturing

121. **Negative-stock prevention.** Warns or blocks by item, godown, date, and backdated consequence
    according to the company feature setting.
122. **Stock audit trail.** Explains every quantity and value movement from source vouchers,
    transfers, counts, manufacturing, sales, purchases, and returns.
123. **Valuation reconciliation.** Ties closing stock to financial statements and identifies
    quantity, rate, layer, or posting differences.
124. **Batch and expiry tracking.** Stores batch identity, manufacture date, expiry, availability,
    hard quantity checks, ageing, and near-expiry actions.
125. **Serial-number tracking.** Prevents duplicate use and follows each serial through receipt,
    transfer, sale, return, warranty, and current custody.
126. **Multiple godowns and in-transit stock.** Preserves value across dispatch/receipt transfers and
    reports reservations and location availability.
127. **Reorder planner.** Nets reorder policy, lead time, reservations, open purchase orders, safety
    stock, and 90-day demand velocity.
128. **Blind stock counts.** Creates godown-scoped count sessions, supports offline counting, reviews
    variance, and posts an approved Physical Stock voucher.
129. **Barcode and QR labels.** Produces printable A4 sheets with item, SKU/barcode, batch, price,
    serial, and human-readable identity.
130. **Sales reservations.** Reserves stock for confirmed demand and reduces promiseable availability
    without posting or persisting a derived balance.
131. **Manufacturing orders.** Supports planned, released, and completed orders with BOM consumption,
    component sufficiency, finished output, scrap, by-products, work-in-progress, and linked vouchers.
132. **BOM versions.** Stores effective dates, revisions, active/retired history, scrap allowance,
    costing context, and cross-version cycle prevention.
133. **Landed cost.** Allocates freight, duty, insurance, clearing, and other reviewed charges into
    the original inward valuation layer.
134. **Demand forecasts.** Supports velocity, prior-year seasonal, and reviewed monthly policies with
    overrides, 30-day demand, and days-cover signals.
135. **Inventory action queue.** Assigns reorder, transfer, markdown, return, disposal, and review
    actions and retains resolution history.

### 10. Payroll and workforce accounting

136. **Payroll preflight.** Finds missing attendance, salary structures, bank profiles, statutory
    IDs, pay-head configuration, and negative net pay before calculation.
137. **Payroll lock.** Prevents deletion or silent rewriting of an owner-locked reconciled run and
    requires a supplementary or reversing workflow for changes.
138. **Payroll-to-books tie-out.** Reconciles gross earnings, employee deductions, employer costs,
    every payable ledger, net pay, and bank amount.
139. **Attendance import.** Maps biometric or spreadsheet rows, detects duplicates by source hash,
    shows employee exceptions, and requires monthly review before approval.
140. **Leave management.** Derives balances from accrual, carry-forward, request, approval,
    encashment, and unpaid-leave transactions.
141. **Salary revisions.** Stores approved future-effective structures and selects them by pay month
    without rewriting historical payroll.
142. **Employee loans and advances.** Produces reducing-balance schedules with interest, pauses,
    waivers, payroll deductions, and reversal safety.
143. **Reimbursements.** Stores claims, evidence, taxable treatment, approval, balanced payment, and
    book linkage.
144. **Contractor payments.** Manages contractor identity, work period, PAN-aware threshold TDS,
    balanced posting, and 26Q evidence.
145. **Full-and-final settlement.** Calculates notice, leave, gratuity, recovery, advances, loan
    closure, exit evidence, and balanced posting.
146. **Payslip delivery packs.** Produces one PDF per employee plus a machine-readable manifest from
    a locked run for local or out-of-band delivery.
147. **Statutory payroll workspaces.** Reconciles month-wise PF, ESI, professional tax, and TDS from
    posted books to challans and filing periods.
148. **Shift, holiday, and overtime rules.** Applies effective-dated calendars, weekly offs,
    holidays, assignments, and approved overtime to earnings and statutory gross.
149. **Department payroll analysis.** Preserves immutable snapshots of headcount, gross, overtime,
    employer cost, net pay, and prior-year comparison.
150. **Workforce provisioning.** Previews and atomically imports joiners and leavers with effective
    dates, source-hash idempotency, and row-level errors.

### 11. Sales documents and customer operations

151. **Document conversion chain.** Converts quotation to sales order to delivery challan to an
    editable invoice draft with quantity lineage, no duplicate entry, and no premature posting.
152. **Numbering integrity.** Uses immutable financial-year-aware allocations, safe previews,
    configurable prefix/suffix/padding/restart rules, duplicate prevention, and stable document
    identity across revisions.
153. **Quotation builder.** Supports validity, item and free-text lines, optional lines, terms,
    discounts, GST, customer context, approval, and retained revision snapshots.
154. **Sales orders.** Derives allocated, delivered, invoiced, cancelled, returned, open, and
    backordered quantities from document lineage.
155. **Delivery challans.** Supports approved dispatch, purpose and job-work context, partial
    fulfilment, returns, and controlled conversion to invoice drafts.
156. **Proforma invoices.** Keeps proformas visibly non-posting and requires an explicit reviewed
    handoff before creating a tax-invoice draft.
157. **Recurring invoice schedules.** Supports customer-specific monthly, quarterly, and annual
    schedules, multi-cycle preview, retained pricing exceptions, and editable draft-only generation.
158. **Price lists.** Provides wholesale, retail, contract, and customer-specific date-effective item
    rates with automatic reviewed resolution during sales entry.
159. **Discount authority.** Enforces the strictest global, role, item, and customer discount ceiling
    in the main process and records blocked attempts.
160. **Sales returns.** Controls open return quantity against original invoice lines and prepares a
    reviewed, one-time-linked Credit Note draft.
161. **Warranty register.** Connects sold serial, invoice date, coverage expiry, issue, service state,
    outcome, and cost.
162. **Custom document fields.** Adds typed, scoped, required fields with main-process validation
    without changing accounting semantics.
163. **Offline customer portal bundles.** Produces tokenized local folders containing invoice PDFs,
    statements, receipts, activity JSON, an offline index, and a SHA-256 manifest.
164. **Territory and salesperson reporting.** Stores effective-dated customer ownership and analyses
    sales, returns, net performance, and collections by person or geography.
165. **Subscription contracts.** Tracks plan, term, cycle, escalation, pause, resume, renewal, and
    linked recurring invoice schedules.

### 12. Collaboration, review, and internal controls

166. **Maker-checker policy.** Requires a different authorized user to approve configured voucher
    types, amounts, sensitive ledgers, expenses, payments, or policy conditions.
167. **Permission matrix.** Separately controls viewing, creation, editing, approval, export, backup,
    restore, administration, and settings actions by role.
168. **Sensitive-field masking.** Hides salary, bank, tax ID, margin, and other configured fields from
    restricted roles while retaining server-side authorization.
169. **Audit hash-chain verification.** Detects missing, reordered, or altered append-only audit
    events and reports the exact break.
170. **Review inbox.** Assigns voucher-linked questions, owner, due date, priority, answer evidence,
    state, and different-user resolution.
171. **Period sign-off.** Records preparer, reviewer, outstanding issues, evidence, approval,
    reopening reason, and independent sign-off.
172. **Export permissions.** Separately controls PDF, spreadsheet, JSON mirror, portable package, and
    full-data exports in the main process.
173. **Temporary local access.** Grants an accountant or auditor an explicit access window and
    removes the identity from sign-in after expiry.
174. **Session dashboard.** Records signed-in, locked, signed-out, and last-activity evidence for
    shared installations.
175. **Change comparison.** Shows exact field-level before and after values for changed masters and
    vouchers.
176. **Policy exceptions.** Requires reason and independent approval for supported overrides; a
    closed-period exception is consumed once and cannot be replayed.
177. **Encrypted review bundles.** Exchanges AES-256-GCM-protected questions, sign-off evidence, and
    period audit changes for offline accountant collaboration.
178. **Department boundaries.** Restricts cost centres, branches, godowns, and voucher types by role
    and enforces the scope inside nested IPC payloads.
179. **Evidence retention.** Defaults to keep forever, supports explicit policies and legal holds,
    shows advance warnings, and never purges company evidence automatically.
180. **Period control report.** Summarizes overrides, deleted drafts, reversals, late postings,
    privileged actions, sign-off, and unresolved review work.

### 13. Import, export, and migration

181. **Universal import preview.** Shows creates, updates, skips, warnings, errors, source totals,
    and exact row outcomes before touching books.
182. **Atomic import batches.** Applies a reviewed batch in one transaction and rolls it back fully if
    any committed operation fails.
183. **Import reconciliation.** Compares source and imported opening balances, vouchers,
    receivables, payables, stock, tax, attachments, and rejected records by period and type.
184. **Idempotent imports.** Uses file, source-row, and semantic identities to stop duplicate posting;
    semantically equivalent Tally XML is rejected even when formatting or master order changes.
185. **Mapping profiles.** Saves source/target columns, values, ledger, tax, unit, and date rules and
    includes ten Busy, Zoho Books, and Marg presets.
186. **Rejected-row workbooks.** Exports XLSX files containing original values, exact errors, and
    stable source-row fingerprints.
187. **Busy migration.** Imports supported ledger, item, and balanced voucher exports through
    reviewed normalized proposals and an atomic apply step.
188. **Zoho Books migration.** Normalizes contacts, items, openings, invoices, bills, payments, and
    journals through source profiles and review.
189. **Marg migration.** Normalizes supported ledger, item, and retail transaction exports through
    source profiles and review.
190. **Generic journal import.** Groups validated debit/credit rows into balanced vouchers and
    rejects an entire unbalanced group.
191. **Attachment migration.** Matches managed source files by filename and voucher number/reference,
    accepts only one unique active-voucher match, copies into checksummed storage, and links
    idempotently.
192. **Portable JSON export.** Produces a documented schema-v1 package with company identity, core
    entities, counts, amount/quantity units, checksums, and content hash independent of SQLite layout.
193. **Migration dry-run report.** Estimates unsupported fields, duplicate/update risk, cleanup
    reasons, rejected rows, and voucher counts before apply.
194. **Portable schema upgrade CLI.** Writes an upgraded package to a new file and reports every
    transformation without overwriting the source.
195. **Vendor-independent exit package.** Excludes secrets while preserving accounting, inventory,
    tax, audit, attachment lineage, and reconstruction evidence.

### 14. AI, OCR, and safe automation

196. **Cited book answers.** Requires AI claims about company data to reference exact report rows,
    ledgers, vouchers, parties, items, or exceptions.
197. **Context inspector.** Shows every selected context category and field before provider use and
    lets the user remove fields or cancel the request.
198. **Provider boundary enforcement.** Validates provider type, HTTPS or explicit loopback HTTP,
    base URL, timeout, response bounds, capability, cancellation, malformed output, and error state.
199. **Proposal-only accounting.** Converts AI voucher work into inert validated proposals with
    source context, affected ledgers, debit/credit totals, warnings, and explicit human approval.
200. **Invoice OCR inbox.** Extracts supplier, number, date, GSTIN, integer-paise taxable/tax totals,
    and line items into a review queue.
201. **Receipt capture.** Extracts merchant, date, amount, and tax from managed images with size
    limits, source hashes, and duplicate detection before approval.
202. **Evidence-ranked ledger suggestions.** Combines voucher kind, party history, matching
    narrations, name evidence, and local accepted/rejected feedback.
203. **Reconciliation assistant.** Explains the top bank match, lower alternatives, tolerance,
    many-to-one reasoning, and exact voucher citations before clearing.
204. **Deterministic variance narratives.** Formats book figures, ranks measured drivers, and cites
    exact contributing vouchers without uncited conclusions.
205. **Natural-language book search.** Searches a constrained index of vouchers, exact paise,
    ledgers, parties, items, narrations, references, and navigable reports without generated SQL.
206. **Draft reminder writer.** Creates editable, unsent messages grounded only in explicitly
    selected customer invoices with per-invoice citations.
207. **OpenAI-compatible and local providers.** Retains HTTPS-compatible or explicit loopback-local
    profiles with independently encrypted credentials and capability tests.
208. **Per-task AI routing.** Lets the owner select separate configured providers and models for OCR,
    extraction, classification, analysis, and writing.
209. **AI evaluation harness.** Scores extraction accuracy, citation validity, malformed responses,
    and accounting-valid voucher drafts on fixed fixtures with durable run history.
210. **Private feedback learning.** Stores accepted or rejected ledger-ranking feedback in the
    company audit trail, never uploads it, and never changes posted entries.

### 15. Integrations, MCP, and extensibility

211. **Versioned MCP contract.** Publishes v1 schemas, structured success/error envelopes,
    capability metadata, and a machine-readable contract resource.
212. **MCP permission scopes.** Separates company listing, mirror reads, attachment reads, proposal
    creation, proposal reading, proposal discard, and mirror refresh.
213. **MCP audit log.** Records timestamp, client, tool, company, outcome, proposal identity, and
    bounded error code without arguments, book values, tokens, or secrets.
214. **Mirror freshness.** Shows generation time, schema version, manifest files, age, ten-minute
    staleness, and an owner-approved refresh queue.
215. **Scoped local MCP tokens.** Issues one-time plaintext secrets while retaining only SHA-256
    hashes, binds them to one company/actions/expiry, and supports explicit revocation.
216. **Declarative plugin manifests.** Declares contract version, compatibility, permissions,
    screens, imports, reports, and exports; new plugins install disabled and require owner enablement.
217. **Partner importer SDK.** Applies bounded JSON/CSV mappings to source-hashed canonical previews
    without expressions, database access, or posting authority.
218. **Report extension API.** Exposes allowlisted report primitives with period provenance, totals,
    and app-owned ledger/voucher/register drill-through instead of SQL.
219. **Webhook outbox.** Stores optional OS-encrypted HMAC endpoints, customer-visible payloads,
    attempt history, bounded retry, and dead-letter state.
220. **Local automation scheduler.** Schedules verified backups, mirror refreshes, and portable report
    packs with pause, run-now, and retained success/failure history.
221. **Settlement adapters.** Reviews Generic, Razorpay, and Stripe gross, fees, fee GST, refunds,
    withholding, provider net, and bank amount without automatic posting.
222. **Ecommerce adapters.** Reviews Generic, Shopify, and WooCommerce orders, cancellations,
    returns, tax, shipping, and settlement references without automatic invoicing.
223. **Logistics adapters.** Generates Generic, Delhivery, and Shiprocket shipment CSV with integer
    units, content hashes, and a sidecar manifest without carrier credentials or runtime dependency.
224. **Plugin isolation.** Rejects executable entrypoints and grants declarative plugins no ambient
    filesystem, network, database, cross-company, or posting access.
225. **Compatibility kit.** Provides a CLI, example manifest, schemas, settlement fixtures,
    ecommerce fixtures, shipment fixtures, and validation tools for partners.

### 16. Data safety, privacy, and security

226. **Backup verification.** Opens every automatic or manual database backup read-only and runs
    integrity checks before marking it valid.
227. **Restore preview.** Shows company, application/schema version, accounting period, file size,
    voucher count, integrity, and destination before restoring.
228. **Atomic configuration writes.** Uses a temporary file, durability steps where supported, and
    rename for mutable JSON settings so interrupted writes do not leave partial configuration.
229. **Secret inventory.** Documents every credential class, storage location, renderer boundary,
    backup/diagnostic exclusion, and rotation expectation.
230. **Safe diagnostics preview.** Displays the exact allowlisted and redacted support payload before
    the user consents to submission.
231. **Encrypted portable backup.** Creates password-protected complete company archives with
    strength checks, authenticated encryption, clean import, and recovery-safe validation.
232. **Backup destinations.** Replicates verified backups to a chosen local folder, external disk, or
    mounted cloud folder without embedded provider SDKs or cloud credentials.
233. **Recovery drills.** Prompts on a ninety-day schedule and retains read-only company identity,
    schema, voucher-count, and integrity evidence from an actual restore check.
234. **Data-path health.** Reports destination availability, writability, volume type, free space,
    and persistent last success or error state.
235. **Privacy Centre.** Centralizes AI providers, Codex authentication, bank feeds, webhooks, MCP,
    folder authority, collaboration, SMTP, support consent, crash reports, retention, and deletion.
236. **Attachment encryption.** Optionally migrates managed source documents atomically to
    AES-256-GCM storage using a platform-protected random key.
237. **Clipboard protection.** Clears a sensitive copied value after the configured interval only if
    the clipboard still contains Total’s exact value.
238. **Tamper-evident exports.** Uses a device-local Ed25519 identity to sign report packs, portable
    packages, and logistics manifests and writes standalone verification sidecars.
239. **Backup rotation.** Supports daily, weekly, monthly, and year-end retention with retained-point
    and storage-space forecasts.
240. **Threat-model release gate.** Checks renderer, IPC, navigation, filesystem, update, MCP,
    plugin, provider, AI Operator, collaboration, support, migration, and recovery boundaries.

### 17. Performance, resilience, and scale

241. **Startup budgets.** Measures cold start, warm start, company open, and first interactive
    screen against fixed evidence thresholds.
242. **Large-book fixtures.** Exercises realistic companies up to one million requested voucher
    lines and long history while checking report totals.
243. **Query-plan regression.** Requires named indexes for critical ledger/date/report lookups and
    detects accidental full scans.
244. **Crash-safe transactions.** Proves voucher, migration, import, approval, backup, restore,
    export, and atomic-write boundaries under forced termination.
245. **Route-level code splitting.** Lazy-loads heavy workspaces and provides an accessible loading
    state; the release gate enforces entry and asynchronous chunk budgets.
246. **Bounded report windows.** Limits mounted Day Book, Ledger Statement, and Stock Summary rows
    while preserving complete totals and closing balances.
247. **Governed report execution.** Runs deterministic report work in a bounded main-process lane
    outside renderer interaction and rendering.
248. **Query cancellation.** Uses abort signals, opaque request identities, and cancellation-aware
    queues to discard obsolete report or search work.
249. **Progressive report state.** Shows the first bounded rows and an explicit “showing N of total”
    message while complete-result totals remain authoritative.
250. **Database maintenance.** Exposes quick/full integrity check, WAL checkpoint, optimize, schema,
    file size, and reclaimable-space diagnostics safely.
251. **Low-disk mode.** Blocks risky CSV, mapped, attachment, and Tally imports before disk
    exhaustion while preserving ordinary accounting writes.
252. **Copy-based corruption recovery.** Preserves the original database, WAL, and SHM evidence and
    attempts recovery only into a separate copy with a verified recovery backup.
253. **Workload lanes.** Bounds reports, PDF/CSV/export, document/OCR, and maintenance queues with
    cancellation and recent timing visibility.
254. **Memory and bundle budgets.** Measures renderer/main memory and code chunks through heavy
    lazy-loaded workflows and blocks material release regressions.
255. **Anonymized profiler packs.** Produces an owner-approved, optionally signed package containing
    only runtime, storage, counts, category timings, and query plans.

### 18. Accessibility, language, and inclusive design

256. **Keyboard completion.** Supports onboarding, voucher posting, reports, reconciliation,
    settings, backup, and restore without a mouse and exercises those paths in E2E tests.
257. **Focus order.** Uses visible, logical focus, focus trapping, dismissal, and focus restoration
    across dialogs, tables, pickers, menus, popovers, and dynamic validation.
258. **Contrast gates.** Tests light and dark themes, semantic states, selected rows, focus rings,
    errors, warnings, success, disabled content, and tables against defined contrast contracts.
259. **Screen-reader names.** Labels inputs, tables, rows, states, charts, navigation, icons, and
    shortcut destinations with stable semantic names.
260. **Interface scaling.** Provides device-local 100%, 112%, and 122% scales while preserving table,
    dialog, sidebar, and report scrolling.
261. **Reduced and no motion.** Respects the operating-system preference and supports a manual no-
    motion mode without removing state or actions.
262. **Color-independent status.** Pairs red, amber, green, debit, credit, warning, success, and
    readiness colors with text or symbols.
263. **Hindi interface.** Translates persistent navigation, search, company switching, shortcut help,
    utility actions, and guidance while retaining discoverable English accounting terms.
264. **Regional invoice labels.** Supports English, Hindi, Marathi, Gujarati, and Tamil customer-
    facing labels without rewriting names, GST terminology, identifiers, or values.
265. **Number grouping.** Uses Indian lakh/crore grouping consistently and offers an optional device-
    level international three-digit grouping mode.
266. **Accessible PDF templates.** Produces selectable text, document outlines, semantic invoice
    reading order, and structured report pages.
267. **Voice-friendly commands.** Exposes stable accessible names for sidebar and Gateway
    destinations so operating-system dictation and voice control can address them.
268. **Spaced-text reading mode.** Increases spacing and uses alternate system typography locally
    without changing printed or exported documents.
269. **Locale-aware help.** Adjusts filing context, payroll checks, state terminology, and suitable
    invoice languages using company registration and state.
270. **Accessibility issue reporting.** Creates a value-free focus-context report and includes a
    separately consented, bounded screenshot preview only when selected.

### 19. Support, education, community, and commercial operations

271. **Trackable support cases.** Uses `TOT-YYYYMMDD-XXXXXXXXXXXX` references, accepts legacy six-
    character references, and stores a device-local status/consent ledger without message or email
    content.
272. **Granular diagnostic consent.** Separates message, diagnostics, allowlisted activity events,
    company metadata, focus context, and screenshot into independent choices with exact preview.
273. **Offline support bundles.** Creates a standard ZIP containing only chosen fields and protects
    it with AES-256-GCM passphrase encryption for out-of-band delivery.
274. **Contextual help.** Matches guidance to the visible screen, enabled company features, GST
    registration, state terminology, and current workflow.
275. **Offline searchable help.** Bundles a task index for vouchers, reports, banking, GST, recovery,
    migration, inventory, payroll, close, and Assist.
276. **Guided troubleshooting.** Diagnoses updates, Electron/native SQLite ABI, verified backups, AI
    providers, collaboration, and filing configuration with specific manual next actions and no
    automatic diagnostic upload.
277. **In-product release notes.** Shows customer-facing changes once after upgrade and keeps them
    available from Help and About with links to relevant screens.
278. **Feature discovery.** Shows related capabilities after repeated work and supports thirty-day
    dismissal or permanent never-show state stored only on the device.
279. **Idea board.** Lets app and website users submit ideas, vote, follow status, view planning
    stages, and see release linkage through the configured intake backend.
280. **Private cohort milestones.** Sends only an explicit six-event allowlist, activation month,
    and pseudonymous installation reference after opt-in and excludes company identity, amounts,
    vouchers, and text.
281. **Referral codes.** Generates offline attribution codes with typo detection and no identity or
    accounting information.
282. **Accountant partner mode.** Labels and organizes isolated client company folders without
    merging databases, users, backups, audits, or exports.
283. **Training companies.** Creates fresh practice books with repeatable briefs and expected
    evidence without destructively resetting an existing company.
284. **Practitioner pathway.** Tracks local progress through accounting, GST, banking, controls,
    migration, and safe-automation modules while keeping proctored assessment separate.
285. **Transparent licensing promises.** Displays Founding-edition terms, unlimited preview grace,
    no automatic beta conversion, and permanent access to books and portable export.

### 20. Engineering, release, and operational quality

286. **macOS signing pipeline.** Configures Developer ID signing, hardened runtime, entitlements,
    universal packaging, notarization, stapling, Gatekeeper verification, and evidence. It awaits
    protected Apple credentials for the public candidate.
287. **Windows signing pipeline.** Configures Authenticode signing and verifies installer,
    executable, updater metadata, upgrade, uninstall, and data preservation. It awaits protected
    Windows signing credentials for the public candidate.
288. **Upgrade matrix.** Tests migration from the previous public version with real packaged
    execution, accounting-domain checks, second-open idempotency, and exact fixture identity.
289. **Rollback-safe migrations.** Creates a pre-upgrade copy, migrates transactionally, verifies the
    result, and preserves a recoverable source from every historical schema version.
290. **Update-feed contract.** Validates version, architecture, channel, rollout, public assets,
    filenames, sizes, hashes, and same-origin download behavior before publication.
291. **Packaged installation smoke.** Installs the actual DMG/ZIP/EXE, launches, creates a company,
    posts a voucher, previews backup/restore, uninstalls the app, and proves company data remains.
292. **Accounting property tests.** Randomizes balanced postings, bills, tax allocations, and long
    stock-valuation walks without floating-point money.
293. **Boundary fuzzing.** Tests malformed and oversized XML, CSV, XLSX, portable packages, images,
    MCP/plugin inputs, support payloads, and AI/provider responses with resource limits.
294. **Visual regression contracts.** Captures critical light/dark, 1440×900, 1280×800, large Hindi,
    regional invoice, offline help, community, and subview surfaces with layout contracts.
295. **Dependency policy.** Checks registry source, semver range, license, native ABI, direct
    deprecation, reviewed transitive warnings, and security audit state.
296. **Crash reporting.** Stores local-only redacted envelopes with bounded stack frames, exact
    Privacy Centre preview, explicit submission, and failed-delivery fallback.
297. **Feature flags.** Provides versioned device-only flags, bounded change history, kill switches,
    and safe fallbacks that cannot disable migrations, posting, reports, backups, or export.
298. **Build provenance.** Records exact clean revision, tracked-tree and lock hashes, toolchain,
    signing configuration, platform, architecture, and every artifact’s size and SHA-256.
299. **Chaos recovery suite.** Forces termination across vouchers, imports, approvals, migrations,
    backups, restore, exports, and atomic writes and verifies recovery guarantees.
300. **Fail-closed release scorecard.** Blocks publication unless correctness, type safety,
    database/renderer tests, accessibility, restore, performance, security, dependencies, chaos,
    soak, visuals, installer verification, and exact provenance pass.

## Exact keyboard and command reference

The command registry is the single source of truth for the sidebar, Gateway cards, command palette,
shortcut help, visible mnemonics, permissions, feature requirements, customization, and dispatch.
Dispatch priority is blocking modal, active editor, voucher context, current screen, then global
context. Bare shortcuts do not fire while the user is typing in an input, select, textarea, or
content-editable element unless that editor explicitly owns the command.

### Global commands

| Command | Default binding | Result |
| --- | --- | --- |
| Command palette | `Cmd/Ctrl+K` | Searches commands, screens, parties, ledgers, vouchers, items, invoice numbers, narrations, and recent records. |
| Shortcut help | `?` | Opens searchable global, Gateway, voucher, and navigation help. |
| Settings | `Cmd/Ctrl+,` | Opens Settings through normal navigation history. |
| Back | `Cmd/Ctrl+[` | Returns to the previous screen after the unsaved-change guard. |
| Forward | `Cmd/Ctrl+]` | Moves forward through retained navigation history. |
| Close or go back | `Escape` | Closes the top overlay, blurs the active editor, or navigates back as appropriate. |
| Focus mode | `Cmd/Ctrl+Shift+F` | Hides nonessential chrome for the current working surface. |

Supported global navigation bindings are customizable. Overrides are stored on the device, checked
for collisions within their context, reflected in all visible hints, and removable with Reset to
defaults.

### Gateway bare-letter commands

| Key | Destination | Visible mnemonic |
| --- | --- | --- |
| `A` | Action Centre | The `A` in Action is red. |
| `O` | Control Room | The `O` mnemonic is red. |
| `U` | Assist | The `U` mnemonic is red. |
| `V` | Voucher Entry | The `V` in Voucher is red. |
| `L` | Sales Desk | The `L` mnemonic is red. |
| `E` | Message Outbox | The `E` mnemonic is red. |
| `D` | Day Book | The `D` in Day is red. |
| `M` | Masters | The `M` in Masters is red. |
| `T` | Trial Balance | The `T` in Trial is red. |
| `P` | Profit and Loss | The `P` in Profit is red. |
| `B` | Balance Sheet | The `B` in Balance is red. |
| `R` | Procurement | The `R` mnemonic is red. |
| `S` | Stock Summary | The `S` in Stock is red. |
| `I` | Inventory Control | The `I` in Inventory is red. |
| `C` | Month Close | The `C` in Close is red. |
| `1` | GSTR-1 | The `1` is red. |
| `3` | GSTR-3B | The `3` is red. |

The amber row or card indicator remains the active-selection signature. Red is reserved for the
mnemonic character and is not used as the ordinary primary-action color.

### Global Alt navigation

| Binding | Destination |
| --- | --- |
| `Alt+G` | Gateway |
| `Alt+A` | Action Centre |
| `Alt+Shift+A` | Assist |
| `Alt+H` | Task Inbox |
| `Alt+V` | Voucher Entry |
| `Alt+Shift+V` | Voucher Drafts |
| `Alt+Shift+E` | Entry Templates |
| `Alt+R` | Sales Desk |
| `Alt+Shift+G` | Message Outbox |
| `Alt+D` | Day Book |
| `Alt+M` | Masters |
| `Alt+C` | Recurring Vouchers |
| `Alt+I` | Tally Import |
| `Alt+T` | Trial Balance |
| `Alt+L` | Profit and Loss |
| `Alt+B` | Balance Sheet |
| `Alt+F` | Cash Flow |
| `Alt+Shift+R` | Procurement |
| `Alt+S` | Stock Summary |
| `Alt+Shift+N` | Inventory Control |
| `Alt+Q` | Month Close |
| `Alt+Y` | Year End |
| `Alt+E` | Registers |
| `Alt+O` | Outstandings |
| `Alt+Shift+L` | Collections |
| `Alt+N` | Consolidated Reports |
| `Alt+Shift+C` | Cost Centres |
| `Alt+U` | Budgets |
| `Alt+Shift+I` | Management Insights |
| `Alt+X` | Exceptions |
| `Alt+K` | Banking |
| `Alt+Shift+U` | Supplier Dues |
| `Alt+P` | Payroll |
| `Alt+1` | GSTR-1 |
| `Alt+3` | GSTR-3B |
| `Alt+2` | GSTR-2B Reconciliation |
| `Alt+W` | e-Invoice and e-Way Documents |
| `Alt+Shift+T` | TDS |
| `Alt+J` | Compliance Centre |
| `Alt+Shift+S` | Settings |

### Voucher commands

| Voucher type | Bare key | Persistent key | Legacy key |
| --- | --- | --- | --- |
| Contra | `C` | `Alt+C` | `F4` |
| Payment | `P` | `Alt+P` | `F5` |
| Receipt | `R` | `Alt+R` | `F6` |
| Journal | `J` | `Alt+J` | `F7` |
| Sales | `S` | `Alt+S` | `F8` |
| Purchase | `U` | `Alt+U` | `F9` |
| Credit Note | `N` | `Alt+N` | `Alt+F8` and `Cmd/Ctrl+F8` |
| Debit Note | `D` | `Alt+D` | `Alt+F9` and `Cmd/Ctrl+F9` |
| Stock Journal | `K` | `Alt+K` | No function-key alias. |
| Physical Stock | `H` | `Alt+H` | No function-key alias. |

Bare voucher keys work before entry begins or while focus is outside the editor. Persistent Alt
bindings remain available throughout Voucher Entry. Owner and accountant roles can invoke entry
commands; viewer permissions suppress mutation commands.

## Exact register behavior

- Sales and Purchase registers expose a Monthly/Quarterly segmented control.
- Indian financial-year quarters are fixed as Q1 April–June, Q2 July–September, Q3
  October–December, and Q4 January–March.
- Each period row contains a stable key, display label, exact start date, exact end date, voucher
  count, taxable value, GST, and invoice total.
- Period totals are calculated from voucher lines; quarter rows are not stored as balances.
- Clicking a row opens Day Book with its exact From and To dates and the selected Sales or Purchase
  voucher kind.
- CSV and PDF use the current granularity and human-readable period label.
- The compatibility layer continues to accept the former monthly register call while current code
  uses `analysis.register({ kind, from, to, granularity })`.
- Tests cover partial quarters, January–March Q4, financial-year boundaries, empty periods, monthly
  and quarterly total agreement, export labels, and Day Book drill-through.

## Exact AI, Operator, JSON, and MCP behavior

### AI provider choices and data handling

- The official OpenAI JavaScript SDK runs only in the Electron main process.
- OpenAI uses the Responses API.
- OpenAI-compatible providers can use Chat Completions with a user-supplied model and base URL.
- Remote compatible endpoints must use HTTPS. Explicit loopback HTTP is permitted for local
  providers.
- Provider settings include provider type, model, API mode, base URL, timeout, context limit,
  enabled tools, and a capability test.
- API keys are protected with Electron `safeStorage`; they never enter SQLite, JSON mirrors,
  backups, renderer persistence, logs, support payloads, or commits.
- The “Sign in with ChatGPT” path starts official device authentication through an installed Codex
  CLI. Codex owns the credential; Total sees bounded login output and login status but never reads,
  copies, refreshes, stores, exports, or diagnoses the ChatGPT credential.
- No provider is mandatory. Turning AI off leaves all accounting, reporting, migration, backup,
  OCR, and manual workflows available.
- Every request has an explicit context preview, cancellation, bounded usage reporting, provider and
  offline error states, conversation history, single-conversation deletion, and full-history
  deletion.
- Retrieved text and attached documents are treated as untrusted data rather than system
  instructions.
- AI tools receive no shell, raw SQL, credentials, unrestricted filesystem, arbitrary process, or
  unrestricted network authority.

### AI Copilot capabilities

- Explains selected reports and unusual movements with record citations.
- Searches vouchers, ledgers, parties, items, narrations, invoice numbers, outstandings, and book
  exceptions.
- Summarizes receivables, payables, cash, bank, tax readiness, and upcoming obligations from the
  selected context.
- Drafts balanced voucher proposals from natural language.
- Suggests bank classifications, reconciliation explanations, ledger classifications, and GST
  corrections for review.
- Drafts customer collection messages and other grounded business writing.
- Explains management-report variance.
- Explains how to complete a workflow using bundled local help.
- Shows source context, proposed changes, affected ledgers, debit and credit totals, warnings, and a
  plain-language explanation before approval.
- Routes approved proposals through the same validation, period-lock, permission, maker-checker,
  and audit paths as human-created work.

### AI Operator authority

- The Operator is disabled by default and requires owner-configured workspace folders.
- It first creates the smallest visible plan and never claims an action has already happened.
- A plan contains no more than twenty actions and expires after ten minutes.
- Supported actions are `navigate`, `search_books`, `draft_voucher`, `read_file`, and `write_file`.
- Navigation and book search are read-only.
- A voucher action creates a proposal or editable draft and cannot post it.
- File reading accepts text files only inside explicitly approved workspace roots.
- File writing replaces the exact reviewed text only inside explicitly approved workspace roots and
  requires a separate approval token according to the configured approval mode.
- The filesystem boundary rejects the filesystem root, the user home directory, Total’s data root,
  missing roots, non-directory roots, path traversal, escapes through symbolic links, binary
  content, and paths outside the approved real path.
- Retained actions are bound to company, user, plan identifier, action index, and action hash.
- Approval tokens are short-lived, action-specific, and single use. Completed actions cannot run
  again.
- The Operator has no shell command, arbitrary process, SQL, secret, unrestricted file, or
  unrestricted network action.

### Versioned JSON integration

- `company.db` remains authoritative.
- The mirror manifest records format version, schema version, stable identifiers, generation time,
  amount units, file checksums, and validation metadata.
- `agent/` contains read-only projections.
- `proposals/` contains inert structured changes awaiting review.
- `processed/` contains accepted or completed proposal records.
- `failed/` contains rejected or invalid outcomes with bounded validation evidence.
- Direct JSON edits never mutate books. Import applies Zod validation, accounting validation,
  period locks, permissions, maker-checker policy, and one SQLite transaction.
- Managed attachment metadata includes stable IDs and checksums; attachment files remain under the
  company directory and are not embedded in ordinary mirror files.

### MCP server and tools

`total-mcp` is bundled over stdio. It pairs with a running Total process through authenticated local
presence and does not open a remote v5 network listener. A token is bound to one company, client,
scope set, expiry, and revocation state. The one-time token secret is revealed only at creation.

| Tool | Required authority | Behavior |
| --- | --- | --- |
| `get_capabilities` | Pairing only | Describes contract version, stable tools, scopes, units, and structured errors. |
| `list_companies` | `companies:list` | Returns only the company permitted by the token. |
| `get_mirror_status` | `mirror:read` | Returns generation time, schema version, files, age, and stale state. |
| `get_book_snapshot` | `mirror:read` | Reads a bounded generated accounting snapshot. |
| `search_books` | `mirror:read` | Searches generated mirror data without direct SQLite access. |
| `get_voucher` | `mirror:read` | Reads one voucher by stable database identifier. |
| `get_ledger` | `mirror:read` | Reads one ledger by stable identifier or exact case-insensitive name. |
| `run_report` | `mirror:read` | Returns a verified generated report snapshot without recomputing books. |
| `list_outstandings` | `mirror:read` | Reads bounded receivable and payable snapshots. |
| `list_exceptions` | `mirror:read` | Derives bounded explainable exceptions from generated report snapshots. |
| `read_attachment` | `attachment:read` | Reads an explicitly managed attachment allowed by the scoped token. |
| `request_mirror_refresh` | `mirror:refresh` | Creates an owner-review request; it does not refresh silently. |
| `propose_voucher` | `proposal:create` | Writes an inert voucher proposal for in-app review. |
| `propose_master_change` | `proposal:create` | Writes an inert ledger or item proposal for in-app review. |
| `validate_proposal` | `proposal:create` | Runs bounded shape and balance validation without writing or opening SQLite. |
| `list_proposals` | `proposal:read` | Lists bounded proposals created by the exact paired token. |
| `discard_proposal` | `proposal:discard` | Archives the token’s proposal without touching accounting books. |

The MCP audit log records timestamp, client, tool, company, allowed/denied/error outcome, proposal
identifier, and error code. MCP cannot commit accounting changes. Final approval is always inside
Total and inherits the active user’s company, role, period locks, permissions, and controls.

## Exact optional encrypted collaboration behavior

- Collaboration is opt-in and can be disconnected without disabling local books.
- Syncable objects are voucher drafts, AI or MCP proposals, review comments, tasks, decisions,
  invitations, membership metadata, conflicts, and quarantine evidence.
- Posted vouchers, voucher lines, balances, company databases, credentials, managed attachments,
  and raw accounting exports are not sync payloads.
- Payloads are encrypted locally with AES-GCM before transport.
- Device identities use Ed25519 signing.
- Conflict handling uses version/vector-clock evidence and exposes review instead of silently
  overwriting concurrent work.
- Invalid signatures, unknown devices, malformed envelopes, replay attempts, and unsupported
  versions enter quarantine while safe local accounting continues.
- Recovery-key generation, reveal, copy, and two-device handoff are explicit user actions.
- Invitations are single use, expire after a chosen period from one hour through 720 hours, can be
  listed, copied, revoked, accepted, and audited.
- Access and refresh tokens live in operating-system credential storage rather than books or
  renderer persistence.
- Supabase Row Level Security, membership checks, device records, invitation history, token refresh,
  and authenticated Edge Function intake protect the optional relay.
- The UI reports disabled, idle, syncing, conflict, quarantine, and error states plus pending work,
  last attempt, last success, and a bounded recent diagnostic message.
- Installed two-device recovery and conflict acceptance remains an external acceptance gate; code
  and isolated service tests do not replace that real-device check.

## Complete website and browser-companion catalogue

The website is separate from the Electron app. `/capture` is an optional mobile-browser receipt
capture companion; it does not turn Total into a mobile application and does not upload accounting
data by default.

### Public pages

| Route | Features |
| --- | --- |
| `/` | Asymmetric product hero, real application screenshots, macOS and Windows download actions, release-channel strip, local-first explanation, feature narratives, keyboard-shortcut demonstration, documentation links, support email in the top bar, sticky navigation, footer, structured product data, and staging banner when applicable. |
| `/compare` | Clear comparison with Tally across offline use, migration, shortcuts, reports, AI approval controls, portability, support, and update model without fake claims. |
| `/pricing` | Free-beta terms, planned perpetual-major-version direction, permanent book and export access, no automatic beta-to-paid conversion, and draft refund/support language pending owner approval. |
| `/changelog` | Current release notes and source-linked history. |
| `/docs` | Documentation index and task-oriented entry points. |
| `/docs/coming-from-tally` | Tally export, dry run, reconciliation, backup, and migration guidance. |
| `/docs/gst-returns` | Offline GST calculation, review, freeze, acknowledgement, and government-tool export guidance with no live-NIC claim. |
| `/docs/backups` | Snapshot, encrypted portable backup, destination, restore-preview, and recovery-drill guidance. |
| `/docs/ai-data` | Provider choices, context consent, secret handling, draft-then-approve, Operator boundaries, and AI-off behavior. |
| `/docs/faq` | Installation, local data, migration, backup, update, support, AI, and account questions. |
| `/support` | Support case creation, consent explanation, private tracking, fallback instructions, and existing-case lookup. |
| `/feedback` | Public idea board with submission, voting, following, status, and moderation-aware display. |
| `/capture` | Local browser receipt/invoice capture, camera or file picker, classification, IndexedDB storage, preview, delete, Web Share, and download fallback with no default server upload. |
| `/privacy` | Local-first data practices, optional services, consent, retention, deletion, and contact route. |
| `/terms` | Product-use, beta, availability, data-responsibility, acceptable-use, and licensing terms. |
| `/security` | Security architecture, reporting route, local-data boundary, update and secret handling, and responsible disclosure. |

### Website platform behavior

- Responsive navigation, keyboard focus, reduced-motion handling, semantic headings, contrast-safe
  light surfaces, and descriptive image alternatives.
- Real generated application screenshots rather than fabricated testimonial dashboards.
- `manifest.webmanifest`, sitemap, robots policy, canonical metadata, Open Graph metadata, and JSON-LD.
- Staging deployments show a visible environment banner and emit noindex behavior so the main domain
  and search presence remain unchanged.
- Strict security headers include Content Security Policy, HTTP Strict Transport Security,
  cross-origin opener/resource policies, frame protection, MIME sniffing protection, referrer
  policy, and a restrictive permissions policy.
- Download attribution captures only allowlisted campaign fields and release channel.
- Privacy-safe funnel analytics accept only a fixed event allowlist and at most six activation
  milestones. They do not store cookies, IP address, user agent, accounting amounts, company names,
  vouchers, or free text.

## Complete support, feedback, and intake behavior

### Support cases

- Shared app and website case model.
- Category, severity, message, optional reply email, app version, platform, company-safe installation
  identifier, and explicit diagnostic consent.
- Server-side field bounds, attachment type/size limits, honeypot, rate limiting, duplicate
  suppression, and secret/identifier redaction.
- Case reference format `TOT-YYYYMMDD-XXXXXXXXXXXX` plus compatibility with older six-character
  references.
- One-time private tracking token whose hash, rather than raw value, is retained in the index.
- Anonymous status lookup, lifecycle events, owner/admin updates, and deletion handling.
- The app creates a local case record before delivery, queues it while offline, and retains retry or
  discard controls.
- Retrying any attachment upload requires fresh confirmation.
- Diagnostics default to app version, platform, schema version, integrity state, and recent redacted
  logs. Financial values, names, GSTINs, vouchers, databases, secrets, and raw paths are excluded
  unless the user deliberately attaches content under explicit consent.
- Encrypted offline support bundles provide an out-of-band fallback.
- Optional Resend notification failure does not discard the stored ticket.
- A mailto fallback remains available when intake delivery is unavailable.

### Feedback board

- Idea title, job-to-improve description, optional email, and follow preference.
- Public browse, status filtering, voting, following, release linkage, and moderation state.
- Stable vote summary with rebuild support.
- Rate limits, duplicate protection, deletion, and retention controls.
- Supabase-backed intake plus compatibility paths for the staged intake architecture.

### Retention and operations

- Private Blob-backed support and feedback indexes use separate access secrets from user tracking
  tokens and administrative maintenance secrets.
- Resolved support records default to ninety-day retention.
- Feedback records default to twenty-four-month retention.
- Explicit legal or operational holds can retain a record for no more than two years under the
  configured policy.
- A protected daily maintenance route performs exact eligible deletion and index repair.
- Supabase support/feedback copies and Resend notifications are optional secondary delivery paths;
  their absence does not disable local accounting or private fallback handling.

## Import, export, packaging, and release surfaces

### Migration formats and evidence

- Tally XML dry run and controlled apply for groups, ledgers, units, stock items, and vouchers.
- Generic CSV and XLSX mapped imports for the supported business entities.
- CSV, XLSX, OFX, QIF, and MT940 bank-statement ingestion with format detection and canonical
  normalized preview.
- Saved column-mapping profiles, source hashing, duplicate detection, row warnings, error workbooks,
  sample templates, attachment linkage, recovery points, and apply-after-preview.
- Versioned portable JSON packages with stable IDs, manifest, checksums, schema migrations, source
  attachments, reconstruction tests, and accountant handoff.
- Migration certificate containing source identity, imported and skipped counts, opening and closing
  reconciliation evidence, and resulting Trial Balance.
- Real representative customer exports from Tally, Busy, Marg, Zoho Books, and varied spreadsheets
  remain acceptance-pending until such files are supplied and reconciled; fixture tests are not
  labelled as customer acceptance.

### Export formats

- PDF and CSV for core reports.
- Invoice PDF, batch invoice PDF, cheque PDF, payment advice PDF, BRS PDF, barcode/QR labels, GST
  notice packs, payslips, customer portal bundles, accountant review bundles, and CA/report packs.
- Tally XML, GSTR-1 JSON, GSTR-3B JSON, e-invoice JSON, e-way-bill JSON, Form 26Q data, PF ECR, ESI
  CSV, professional-tax CSV, bank-upload files, migration error workbooks, JSON mirror, portable
  packages, `.eml` messages, and signed sidecars.
- Export permission classes separate PDF, spreadsheet, JSON mirror, and full-data authority.

### Desktop packaging and update delivery

- Electron packages target Apple Silicon macOS, Intel macOS where supported, and Windows 11.
- Build products include DMG/ZIP for macOS and NSIS EXE for Windows.
- Stable, beta, and internal channels have separate release lookup and rollout policy.
- Update metadata validates channel, semantic version, architecture, filename, size, SHA-256, origin,
  rollout percentage, rollout salt, and kill switches.
- Private GitHub release assets can be converted into controlled download redirects without changing
  the main branch or main production domain.
- Staging download resolution requires the exact expected `.dmg` and `.exe` assets.
- Release workflows run typecheck, unit, database, renderer, website, E2E, security, dependency,
  package, installer, updater-contract, provenance, and artifact-verification gates.
- Current staging packages are unsigned. The macOS and Windows signing/notarization workflow code is
  present, but signed public candidates require external Apple and Windows credentials.

## Availability and acceptance status

| Status | Meaning | Current examples |
| --- | --- | --- |
| Implemented | Product code and repository tests exist. | Offline accounting, reports, monthly/quarterly registers, shortcuts, backups, OCR, proposals, MCP contract, support UI, website pages. |
| Optional | Code exists but the user must deliberately enable or configure it. | AI providers, Codex device login, SMTP, bank feeds, webhooks, MCP, collaboration, telemetry, support attachments. |
| Staging verified | An isolated non-production service or route has passed staged checks. | Supabase intake/sync paths, staging website/update routing, unsigned package publication workflow. |
| Acceptance pending | Code exists but representative external data, credentials, users, or installed devices are required to prove the whole real-world path. | Customer Tally/Busy/Marg/Zoho migrations, signed installer trust, installed upgrade/uninstall, two-device collaboration recovery, real SMTP/support delivery. |
| Excluded from v5 | A latent or experimental path is not part of the release promise. | NIC live filing, online GST portal APIs, autonomous AI posting, cloud replication of posted books. |
| Later roadmap | Deliberately designed for a later release and not described as shipped. | Optional end-to-end encrypted multi-device book collaboration beyond review objects and provider-dependent commercial connectors. |

External production configuration, signed installer trust, representative migration acceptance,
installed-device acceptance, practitioner sessions, owner commercial decisions, and final merge
review are release gates rather than missing hidden application features. Their current owners and
evidence requirements remain in [TASKS.md](TASKS.md), [HUMAN.md](HUMAN.md), and
[ROADMAP.md](ROADMAP.md).
