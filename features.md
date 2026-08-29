# Total — Complete Feature Catalogue

This document is the canonical catalogue of functionality present in the Total repository as of 29 August 2026. It covers the macOS desktop application, the offline accounting engine, statutory and business workflows, internal tools, exports, the public website, release infrastructure, and known product boundaries. It was reconciled against `CLAUDE.md`, `HANDOFF.md`, `docs/roadmap.md`, the renderer screen registry, IPC registry, shared-domain modules, database services and migrations, end-to-end drivers, scripts, and site routes.

## 1. Product scope and foundations

- Offline-first accounting application for Indian businesses, delivered as an Electron desktop app with a React and TypeScript interface.
- One SQLite database per company, stored locally under `~/Documents/total/` by default.
- Configurable local data root with a verified move workflow that preserves the original until the moved copy passes validation.
- No server dependency for day-to-day bookkeeping, reports, inventory, payroll, statutory preparation, invoicing, or backups.
- Double-entry accounting with every posted voucher required to balance.
- Money is stored and calculated as integer paise.
- Quantities are stored as integer thousandths.
- Exchange rates use fixed integer precision rather than binary floating-point amounts.
- Reports are derived from voucher lines and opening balances rather than stored balance snapshots.
- Financial years, effective-dated rules, company settings, and registration scope are explicit throughout the product.
- Feature controls can enable or hide inventory, bill-wise accounting, cost centres, TDS, multi-currency, payroll, negative-stock prevention, batches, credit-limit enforcement, and AI.
- Feature controls hide product affordances without mutating or deleting existing books.
- Private-company data remains locally owned and can be exported in open formats.
- Desktop builds target macOS and Windows; platform signing and notarisation remain release gates described in section 32.

## 2. Company lifecycle and company identity

- Create a new company with legal name, display name, address, state, PIN, PAN, GST status, financial-year start, books start, base currency, and contact details.
- Create a ready-to-use demo company populated with sample transactions.
- Sample-company profiles for trading, manufacturing, and services businesses.
- List, open, close, and switch between company databases.
- Display the currently open company and active financial year in the application shell.
- Update company identity and statutory information after creation.
- Archive and unarchive a company without deleting its database.
- Archive mode supports read and export access while preventing ordinary posting.
- Delete-company workflow with explicit confirmation and service-side safeguards.
- Company-level backup before risky lifecycle operations.
- Reveal the company export folder from the application.
- Independent data, users, settings, audit chain, features, numbering, and backups for each company.
- Company identity validation, including state, GSTIN, PAN, and address-related checks.
- Multiple GST registrations within one legal entity, while retaining whole-entity books.
- Primary GST registration selection and effective-dated registration records.
- Registration-specific legal name, trade name, address, state, PIN, GSTIN, contact, bank, and invoice identity.
- GST registration migration and historical voucher stamping so old returns retain their original registration scope.
- Godown-to-GST-registration association for supply and transfer workflows.

## 3. Onboarding, migration, and sample data

- First-run company creation wizard.
- Guided opening-balance entry for ledgers and inventory.
- Opening balances validate debit and credit equality and preserve integer precision.
- Spreadsheet and CSV import templates for masters and opening balances.
- CSV preview before applying imported data.
- Field mapping, validation errors, row-level acceptance, and rejected-row visibility.
- Deterministic import keys for safe re-import and idempotence.
- Import dry-run support before committing rows.
- Progress reporting and cancellation for long-running imports.
- Tally XML company and voucher import.
- Tally import preview, validation, cancellation, and repeat-import protection.
- Tally reconciliation report down to the paise.
- Tally migration report with source totals, imported totals, differences, warnings, and PDF output.
- Tally XML export for supported company data.
- Portable open-data export and import for moving books between installations.
- Encrypted portable backup export and import.
- Persistent onboarding checklist derived from actual company state.
- Checklist completion tracking for company details, ledgers, opening balances, first voucher, backups, and essential settings.
- Keyboard-first onboarding checklist and shortcut education.
- Guided demo tour using realistic books and workflows.
- Fresh-machine end-to-end scenario covering first launch through usable company state.

## 4. Application shell, navigation, and keyboard operation

- Gateway home screen with company context, shortcuts, dashboard information, and primary work areas.
- Sidebar grouped into top-level, Books, Analysis, Banking, Payroll, GST, and System sections.
- Red-letter accelerator badges on sidebar destinations and the Gateway.
- A shared screen registry drives sidebar navigation, Gateway links, command-palette entries, shortcut help, and cache invalidation.
- Command palette opened with Command or Control plus K.
- Global search from the command palette across screens and supported company entities.
- Search result ranking, result limits, and debounced queries.
- Searchable shortcut-help overlay opened with `?`.
- Native Electron application menu with platform-appropriate edit roles.
- Production menu removes development reload and developer-tools commands.
- Explicit renderer command allowlist for menu-to-renderer events.
- Platform-appropriate Settings shortcut.
- Panic-lock shortcut that immediately returns the application to its lock screen.
- Command or Control plus F opens report filtering where supported.
- Command or Control plus left bracket and right bracket navigates screen history.
- Command or Control plus 1 through 9 opens assigned major destinations.
- Command or Control plus backtick opens recently visited screens.
- Remembered active tabs on multi-tab desks and settings pages.
- Layered keyboard dispatch for global navigation, screen controls, tables, forms, pickers, and modals.
- Escape closes the nearest active surface before affecting its parent screen.
- Modal focus trapping and focus restoration to the launching control.
- Function-key voucher navigation, including F4 through F9 mappings for common voucher types.
- Command or Control plus Enter saves supported forms.
- Keypad Enter support in entry workflows.
- Enter-based field chaining in voucher forms.
- Inline Accept bar that makes the end of the Enter chain visible.
- Typeahead pickers with keyboard selection and inline create actions.
- Arrow, Home, End, Page Up, Page Down, Enter, and Space navigation in shared tables.
- Space expands and collapses the active tree row.
- Optional Vim-style `gg` and `G` movement to the first and last row.
- Spreadsheet-like grid navigation, cell repetition, line reordering, row deletion, and pasted tabular data.
- Command or Control plus D duplicates supported rows or records.
- Command or Control plus Delete invokes supported delete-and-undo behavior.
- Command or Control plus Shift plus F opens global search scoped to the current screen.
- Command or Control plus Shift plus P opens the keyboard-driven period picker.
- Alt plus Up or Down reorders supported entry lines.
- Post-and-new flow for consecutive voucher entry.
- Same-as-last and repeat-entry flows for fast bookkeeping.
- Repeat-last-line action for rapidly entering similar voucher rows.
- Footer hint bars display the current screen's valid keyboard vocabulary.
- Stable row identifiers, active-row highlighting, and keyboard-accessible contextual actions.
- Unsaved-change guard before navigation, closing, or destructive replacement.
- Shortcut conflict detection and shortcut-preference validation.
- Keyboard-only appearance mode that suppresses hover affordances while retaining all actions through focus and keys.
- No global shortcut is allowed to hijack ordinary typing in an input or editor.

## 5. Appearance and accessibility

- Light theme.
- Dark theme.
- High-contrast theme.
- Configurable interface font scaling.
- Visible, contrast-checked focus rings.
- Reduced-motion support following the operating-system preference.
- Accessible names for controls, icon buttons, fields, dialogs, tabs, and navigation regions.
- Scoped table headers and semantic table relationships.
- Screen-reader announcements for errors, recovery actions, active rows, and status changes.
- Toast and live-region feedback for asynchronous operations.
- Text labels for debit and credit meaning rather than colour-only communication.
- Keyboard alternatives for hover-only row actions.
- Focus trapping and focus restoration in dialogs.
- Skip-navigation support for keyboard and assistive-technology users.
- Document language metadata and multilingual invoice-language handling.
- Recovery and lock surfaces verified for accessible keyboard use.
- Design-system tests that prevent inaccessible or inconsistent UI primitives.

## 6. Masters and configuration

### 6.1 Accounting masters

- Create, edit, list, search, and soft-delete ledgers.
- Inline ledger creation without leaving voucher entry.
- Undo path after accidental inline ledger creation.
- Display ledger balances during selection and entry.
- Create, edit, list, tree-view, and soft-delete ledger groups.
- System groups with protected accounting behavior.
- Party master details, including GST, PAN, address, credit terms, credit limit, MSME status, and default transaction behavior.
- Party-specific price level, bill-wise defaults, tax defaults, cost-centre defaults, and narration behavior.
- Create and maintain voucher types.
- Voucher-type numbering configuration.
- Financial-year-specific number series, prefixes, suffixes, and continuity checks.
- Duplicate voucher-number and numbering-gap detection.

### 6.2 Inventory masters

- Create, edit, list, search, and soft-delete stock items.
- Stock item codes, aliases, barcodes, HSN/SAC, GST rate, cess, valuation method, units, reorder settings, and default godown.
- Create and list stock groups with inherited tax and HSN defaults.
- Create and manage godowns.
- Associate godowns with GST registrations.
- Create units and alternative-unit conversions.
- Exact quantity-expression parsing with unit conversion.
- Create and list batches with manufacture and expiry information.
- Create and manage price levels and customer price lists.
- Effective-dated item tax rates.
- Effective-dated price-list versions and revisions.
- Preview and apply price revisions with undo-safe version history.
- Item images stored as files with database metadata rather than database blobs.
- Image set, get, batch fetch, clear, and orphan sweep operations.
- HEIC image refusal where reliable decoding is unavailable.

### 6.3 Other masters

- Create, list, and delete currencies.
- Exchange-rate entry on foreign-currency transactions.
- Create, edit, list, and delete cost centres.
- Cost-centre defaults on ledgers and voucher lines.
- Employee and pay-head masters.
- Fixed-asset blocks, fixed assets, CWIP records, loan facilities, deposits, recurring templates, report schedules, custom fields, and commission schemes.

## 7. Voucher entry and the accounting engine

- Double-entry posting engine with debit-credit equality enforcement.
- Contra vouchers.
- Payment vouchers.
- Receipt vouchers.
- Journal vouchers.
- Sales vouchers and tax invoices.
- Purchase vouchers.
- Credit notes.
- Debit notes.
- Stock journals.
- Physical-stock vouchers.
- Manufacturing vouchers driven by bills of materials.
- Memo and pro-forma document flows where posting is intentionally deferred.
- Voucher creation, retrieval, editing, listing, counting, duplication, deletion, restoration, and permanent purge.
- Soft-delete bin so ordinary deletion is recoverable.
- Transactional save: the voucher header, lines, inventory movements, bill references, cost allocations, taxes, custom fields, attachments, and audit event succeed or fail together.
- Integer-paise amount entry and calculation.
- Amount expressions with arithmetic operators and `k`, lakh, and crore suffixes.
- Integer-thousandth quantity entry and quantity expressions.
- Exact largest-remainder percentage allocation for splits.
- Debit and credit accounting-entry mode.
- Item invoice-entry mode.
- Manufacture-entry mode.
- Physical-stock count-entry mode.
- Round-off calculation and configurable round-off ledger behavior.
- GST calculation by intra-state or inter-state supply, place of supply, item tax rate, and registration.
- Invoice-level and line-level discount handling.
- Bill-wise references, new references, advances, on-account amounts, and allocations.
- Cost-centre allocations with exact totals.
- Multi-currency voucher amounts and rates.
- Narration entry, deterministic automatic narration, and narration memory.
- Narration memory excludes probable UTR, reference-number, and sensitive-token values.
- Barcode lookup that can jump directly to an item line.
- Party defaults and current balance shown during entry.
- Credit-limit warning or enforcement according to company policy.
- Negative-stock warning, prevention, and authorised override according to company policy.
- Open-period and year-lock checks before posting.
- Approval-threshold checks before a high-value voucher becomes final.
- Duplicate-voucher detection and duplicate-number validation.
- Duplicate candidate detection by party, date, and amount.
- Transport-detail capture for applicable invoices and e-way documents.
- Custom fields rendered according to voucher type.
- Attachments shown and managed from voucher entry.
- Approval status and decisions shown on the voucher.
- Create a draft from an existing voucher.
- Retrieve the latest voucher of a type for repetition.
- Template-based voucher creation.
- Recurring-template generation.
- All-or-nothing bulk edit of eligible voucher fields.
- Confirmed bulk move-to-bin from the Day Book.
- Crash-safe machine-local drafts scoped by company and voucher kind.
- Draft restore offer after an interrupted entry session.
- Last-used voucher type remembered across application sessions.
- Scratchpad/Suspense posting for transactions that cannot yet be classified.
- Later scratchpad reclassification with lock and audit checks.
- Immediate post-and-new flow for continuous data entry.
- Post-and-new can retain the current date and party for the next voucher.

## 8. Voucher templates, recurring work, and bulk operations

- Save, list, use, and delete named voucher templates.
- Separate reusable templates from scheduled recurring vouchers.
- Configure recurring cadence, start date, next due date, and source draft.
- List upcoming and overdue recurring transactions.
- Post an occurrence from a recurring template.
- Skip an occurrence without deleting the template.
- Delete obsolete recurring schedules.
- Preserve statutory number-series continuity when generating recurring entries.
- Same-as-last and source-voucher draft generation.
- Bulk field edits validated against locks, approvals, permissions, accounting balance, and statutory integrity.
- Spreadsheet paste into supported grids with row-level validation.

## 9. Core books and financial reports

- Day Book with date range, voucher type, ledger, amount, text, and status filtering.
- Day Book free-text search.
- Day Book grouping by voucher type.
- Day Book reconciliation-status column for bank-related vouchers.
- Day Book configurable columns and saved views.
- Day Book drill-down into voucher detail.
- Day Book keyset pagination and virtualised rows for large books.
- Day Book by voucher-type summary.
- Ledger statement with granular period presets and custom ranges.
- Quarterly, half-yearly, and annual period granularity.
- Ledger statement running balances, opening balance, debit/credit totals, and closing balance.
- Ledger statement drill-down to vouchers.
- Ledger statement keyset pagination and full-data export.
- Trial Balance derived from voucher lines and openings.
- Trial Balance collapsible group and primary-group summaries.
- Trial Balance opening, period movement, and closing columns.
- Profit and Loss statement.
- Balance Sheet.
- Time-travel Balance Sheet date scrubber for recomputing an as-on position.
- Cash-flow statement.
- Comparative current-period and previous-period statements.
- Common-size statement percentages.
- Financial ratios with documented calculation bases.
- Ratio panel and trend sparklines.
- Twelve-month Gateway tile sparklines.
- Schedule III presentation with unclassified balances surfaced explicitly.
- Schedule III CSV export.
- MSME payable split and disclosure support.
- Sales register.
- Purchase register.
- Register drill-down into voucher and party detail.
- Item profitability and gross-margin analysis.
- Item profit by period.
- Party sales share and concentration analysis.
- Cash forecast based on books, outstanding items, and explicitly labelled assumptions.
- Cash forecast inputs from open bills, post-dated cheques, and due recurring templates.
- Dashboard totals and status indicators.
- “What changed” comparison between report periods.
- Accounting exception report for abnormal balances, missing narration, unusual values, and policy breaches.
- Negative-balance highlighting for ledgers whose accounting nature should not normally be negative.
- Report footer definitions, generation context, and date scope.
- Repeating report headers with company name, GSTIN, and exact report period on printed pages.
- Zero-balance visibility toggle.
- Profit and Loss percentage display.
- Saved report views.
- Scheduled report definitions and on-demand schedule execution.
- Report export to CSV.
- Streaming CSV export for large result sets.
- SpreadsheetML/XLS export.
- A4 PDF report rendering.
- Chartered-accountant pack export.
- Open portable export.
- Report output is independent of custom presentation fields and never stores derived balances back into the books.

## 10. Cost centres, budgets, and consolidation

- Cost-centre master management.
- Cost-centre allocation at voucher-line level.
- Cost-centre report and statement.
- Cost-centre profitability with a reconciling unallocated bucket.
- Cost-centre-aware salary allocation.
- Budget creation, editing, listing, and deletion.
- Budgets by ledger, group, cost centre, and period where supported.
- Actual-versus-budget variance reporting.
- Read-only consolidation across selected company databases.
- Consolidated Trial Balance, Profit and Loss, and Balance Sheet inputs.
- Company-to-company mismatch visibility.
- Explicit refusal to invent elimination entries or silently mask differences.
- Source-company attribution in consolidated results.

## 11. Receivables, payables, and party relationship management

- Bill-wise open-item tracking for receivables and payables.
- FIFO outstanding allocation where an explicit allocation is absent.
- Allocation suggestions for receipts and payments.
- Configurable ageing buckets.
- Ageing by due date, voucher date, or supported policy basis.
- Ageing analysis by salesperson or territory where those party dimensions are maintained.
- Receivables and payables statements with opening, movement, allocation, and balance detail.
- Party statement PDF generation.
- Customer advances and unallocated receipts.
- Payment schedules.
- Credit-limit checks during entry.
- Credit scores based on transparent book-derived factors.
- Credit policy configuration.
- Credit-limit enforcement feature toggle.
- Overdue-interest calculation without silently posting an accounting entry.
- Bad-debt and provision calculation support.
- MSME creditor classification for micro and small enterprises.
- Section 43B(h) due dates using 15-day or 45-day rules.
- MSME disallowance and interest analysis.
- Collection reminders and follow-up worklist.
- Bulk reminder preparation for overdue parties.
- Promises-to-pay with dates and status.
- Party notes with open and closed states.
- Khata view for compact party-ledger review.
- Collections desk sorted by lateness and collection status.
- Gateway “who to chase today” list.
- Party phone and email details used by collection and sharing workflows.
- Shareable statement output and WhatsApp-oriented handoff.
- Customer and vendor concentration reporting.
- Commission schemes, draft commission calculation, and commission reports.
- Salesperson commission earned on allocated collections rather than billing, including proportional commission on part-paid invoices.
- Gross-receipt or tax-exclusive commission basis and a journal draft for the period liability.

## 12. Inventory, warehousing, and valuation

- Perpetual inventory movement from voucher and stock-document activity.
- Stock Summary by item.
- Stock by godown.
- Godown stock lookup.
- Item and barcode search.
- Batch tracking.
- Batch manufacture date and expiry date.
- Expired-stock and near-expiry reports.
- Stock ageing by item and batch.
- Serial-number tracking.
- Serial list, counts, movement history, and current status.
- Serial corrections through auditable movement reversal rather than silent history replacement.
- FIFO valuation.
- Average-cost valuation.
- Per-item valuation-method configuration.
- Negative-stock detection.
- Optional negative-stock blocking with permission-aware override.
- Per-item negative-stock policy that can override the company default in either direction.
- Physical-stock count and adjustment workflow.
- Printable physical-stock count sheets with blank quantity columns.
- Printable stock-taking support through report and label outputs.
- Inter-godown stock transfers.
- Transfer preview before posting.
- GST-registration-aware cross-branch transfers.
- Branch-transfer register and transfer PDF.
- Landed-cost allocation over eligible purchases.
- Exact landed-cost distribution and saved allocation records.
- Reorder levels and reorder quantities.
- Reorder alerts.
- Reorder alert handoff for WhatsApp-oriented or externally delivered follow-up.
- Purchase suggestions derived from stock and reorder configuration.
- Costable-purchase selection for landed costs.
- Item tax rate effective as of a transaction date.
- Item-level image retrieval in entry and master contexts.
- Optional item images in invoice and picker contexts.
- Stock labels with barcode preview and printing.
- TSPL-oriented raw label output.
- Stock statement for bank reporting.
- Standard costs with effective dates.
- Material price variance and usage variance.

## 13. Bills of materials, manufacturing, and job work

- Bill of materials per manufactured item.
- Effective BOM detail retrieval and editing.
- Nested BOM explosion.
- Cycle and depth protection for nested BOMs.
- Standard input quantities.
- Expected output, actual output, yield, and scrap handling.
- Manufacturing voucher that consumes components and produces finished goods.
- Standard-cost versions and effective dates.
- Material price and quantity/usage variance.
- Job-work outward challans.
- Job-work returns.
- Job-work due-date clock.
- Next document number generation.
- Job-work item and quantity status.
- ITC-04 Table 4 reporting.
- ITC-04 Table 5A reporting.
- ITC-04 Table 5B reporting.
- ITC-04 Table 5C reporting.
- ITC-04 JSON preview/export aligned to the supported schema fixture.
- Job-work records share the same stock movement and tax lineage used by inventory and statutory reports.

## 14. Sales, purchase, fulfilment, and counter workflows

### 14.1 Outward document chain

- Quotations.
- Sales orders.
- Delivery challans.
- Conversion from quotation to order, order to challan, and eligible document to invoice draft.
- Fulfilment quantities and remaining quantities.
- Partial fulfilment.
- Close and reopen-safe status handling through explicit document operations.
- Over-delivery validation.
- Pipeline summary and document status views.
- Mark-invoiced workflow with source-document traceability.

### 14.2 Inward document chain

- Purchase orders.
- Receipt notes.
- Receipt without an order when policy permits.
- Purchase invoice matching.
- Three-way match among purchase order, receipt note, and purchase invoice.
- Quantity and value mismatch visibility.
- Partial receipt and partial invoicing.

### 14.3 Counter mode

- Fast item lookup by name, code, alias, or barcode.
- Price lookup from the applicable price list.
- Counter sessions with open and close controls.
- Opening cash float, mid-session pay-ins and payouts, closing count, expected cash, and signed over/short variance.
- Counter sale posting.
- Tax-inclusive and tax-exclusive counter pricing.
- Shelf-price tax back-out for tax-inclusive rates.
- Price-below-cost warning using the known item cost, without treating missing cost as zero.
- Cash tender.
- Card tender.
- UPI tender.
- On-account tender.
- Mixed-tender summary where supported by the sale model.
- Change calculation constrained to cash tender, with denomination breakdown.
- Counter sales history and sale lookup.
- Walk-in customer name and phone captured on the sale without creating a permanent ledger master.
- Return and exchange lookup by receipt number or phone.
- Counter returns posted through linked credit-note accounting and stock movement.
- Counter movement log.
- Counter session totals and closing summary.
- Pricing and promotional schemes with create and delete controls.
- Quantity-break percentage discounts.
- Quantity-break slab rates.
- Buy-quantity-get-quantity-free schemes that move the free stock while discounting its selling value.
- Best-applicable-scheme selection with item-specific tie-breaking.
- Customer-facing cart display panel with line totals, payable amount, and savings.
- Thermal receipt output for 58 mm and 80 mm paper.

## 15. Banking, statement import, and reconciliation

- Bank-ledger discovery and bank-account setup.
- CSV bank-statement import with quoted-field support.
- Signed-amount files and separate debit/credit-column files.
- Import preview before filing a statement.
- Per-bank import profiles, including reusable column and date mappings.
- Create, edit, list, and delete bank profiles.
- Ambiguous date detection rather than silent guessing.
- Duplicate transaction and repeat-file protection.
- Stable imported-statement identifiers.
- Statement filing and unfiling.
- Reconciliation suggestions using amount, date, party, cheque, narration, and reference evidence.
- UTR and strong bank-reference priority.
- Exact and tolerance-aware matching with the difference shown.
- One-to-one and many-to-one reconciliation.
- Split one statement line across several book vouchers.
- Bulk acceptance of supported high-confidence matches.
- Manual bank date assignment to book entries.
- Reconciliation status and progress summary.
- Reconciliation progress by bank account.
- Bank Reconciliation Statement comparing books and statement.
- BRS PDF output.
- Unreconciled ageing.
- Per-bank-account reconciliation freeze and lock history.
- Learned categorisation memory from accepted matches.
- Forget learned match memory.
- Deterministic bank rules with priority, direction, text conditions, hit counts, and deletion.
- Bank charge recognition using whole-word and direction-aware logic.
- Bank charge and GST ledger setup.
- GST recovery treatment for bank charges.
- Draft and post supported bank-charge and interest entries from matched statement rows.
- UPI statement parsing.
- Post-dated cheque register and calendar.
- PDC maturity action.
- Cheque-print configuration, grid calibration, advice output, and PDF printing.
- Cheque bounce workflow that reverses the receipt/payment effect and reopens bill references.
- Optional bounce-charge voucher.
- Bounce removal/undo safeguards.
- Bank-detail change requests subject to approval.
- Duplicate bank-detail exception detection.
- Two-person decision workflow for sensitive bank-detail changes.
- PDF bank-statement extraction is not offered; see section 32.

## 16. Multi-currency and foreign-exchange accounting

- Currency masters with code, symbol, and precision settings.
- Foreign-currency bank and ledger accounts.
- Transaction foreign amount and exchange rate stored with base-currency paise.
- Fixed-precision exchange-rate calculation.
- Foreign-currency account listing.
- Revaluation preview as of a selected date.
- Realised and unrealised difference support through explicit voucher drafts.
- Post foreign-exchange revaluation journals.
- Prevent duplicate revaluation for the same account and period.
- List and remove eligible revaluation records with accounting safeguards.
- BRS and account views retain foreign-currency context.

## 17. GST registrations, tax calculation, and returns

### 17.1 GST identity and calculation

- Multiple GSTIN registrations within one company.
- Primary-registration selection.
- Effective registration dates and historical identity preservation.
- Registration-specific place of business, bank, contact, and invoice identity.
- GSTIN format and checksum validation.
- State-code and place-of-supply validation.
- HSN/SAC and GST-rate validation.
- Intra-state CGST and SGST calculation.
- Inter-state IGST calculation.
- Cess support.
- Effective-dated GST and cess rates at item level.
- Dated slab history covering the September 2025 GST rationalisation rules maintained by the application.
- Tax-rate advisory using the maintained slab catalogue.
- Supplying registration drives place-of-supply and return scope.
- GST threshold and turnover analysis.
- Tax-period split handling when effective rules change.
- Notifications and advisory language kept separate from posted accounting facts.

### 17.2 GSTR-1 and amendments

- GSTR-1 B2B invoices.
- B2C large invoices.
- Automatic B2C-large threshold classification.
- B2C small summaries.
- Credit and debit notes, including registered-party note reporting.
- Export invoices.
- Export invoices with payment of tax and without payment of tax.
- SEZ supplies with payment of tax and without payment of tax.
- Advance receipts and advance adjustments for Tables 11A and 11B.
- HSN summary.
- Document-number and cancellation summary, including Table 13 data.
- Registration-scoped and period-scoped GSTR-1 preparation.
- GSTR-1 validation before export.
- Export-blocking validation gate until all return errors are cleared.
- GSTR-1 JSON export.
- Frozen GSTR-1 snapshots preserving the filed-period basis.
- Amendment report comparing current books with a selected snapshot.
- Supported amendment fields from the v5 return shape.
- B2BA, B2CLA, CDNRA, and CDNURA amendment tables.
- Amendment-only export.
- Refusal to rewrite a prior return under a different GSTIN after a registration transition.
- GSTR-1A snapshot and export flow.
- Once-per-period safeguards for GSTR-1A.
- Current-period, non-nil, and source-return checks.

### 17.3 GSTR-3B and annual return

- GSTR-3B calculation from books.
- Manual GSTR-3B buckets with explicit stored adjustments.
- GSTR-3B validation and JSON export.
- GSTR-9 annual-return preparation from supported book data.
- GST liability summary.
- Late-fee and interest calculation for delayed filings.
- Filing register links between prepared values, recorded filings, and source periods.

### 17.4 QRMP, IFF, and composition

- QRMP deadline and period logic.
- Invoice Furnishing Facility period handling.
- PMT-06 deadline support.
- PMT-06 challan tracking against GST liability.
- Month-one and month-two freeze provenance.
- Nil-period headers.
- Nil-return shortcut for transaction-free periods.
- Quarter exclusions that prevent duplicate inclusion.
- CMP-08 preparation for composition taxpayers.
- GSTR-4 preparation.
- Bill of Supply support.
- Composition-period validation.

### 17.5 GSTR-2B and IMS

- GSTR-2B file selection and import.
- Reconciliation with purchase records.
- Matched, amount mismatch, date mismatch, missing in 2B, and missing in books classifications.
- Match detail and confidence evidence.
- Fuzzy party-name evidence for GSTR-2B purchase matching.
- ITC ageing.
- IMS worklist with dated accept, reject, and pending decisions.
- Bulk acceptance of eligible matched IMS items.
- IMS clear/reset operation.
- IMS decisions remain local preparation records and are not represented as portal filing.

### 17.6 Reverse charge, self-invoice, branch transfer, LUT, ISD, and job work

- Reverse-charge register.
- Automatic reverse-charge ledger suggestion for configured notified supplies.
- Issue and delete reverse-charge records with voucher linkage.
- Self-invoice for eligible notified supplies from unregistered suppliers.
- Supplier-invoice treatment for registered-supplier section 9(3) transactions.
- Explicit refusal to fabricate promoter section 9(4) consolidated self-invoice treatment.
- Reverse-charge PDF output.
- Schedule I branch transfer between GST registrations.
- Rule 28 value support and transfer accounting.
- Branch-transfer register and invoice PDF.
- Letter of Undertaking register.
- LUT save, delete, expiry, and status tracking.
- Related-party disclosure support.
- Input Service Distributor credit register.
- ISD source and destination registration lineage.
- ISD distribution, withdrawal, and desk view.
- GSTR-6 working preparation.
- ISD PDF output.
- GSTR-6 is marked as a working preview rather than represented as portal-ready filing.
- ITC-04 job-work tables and supported JSON output.

## 18. E-invoice, e-way bill, and statutory filing records

- E-invoice JSON generation using the supported schema 1.1 shape.
- E-invoice JSON preview before export.
- Invoice Reference Number eligibility and deadline countdown.
- Declared-turnover-band awareness for e-invoice applicability and reporting deadlines.
- Signed QR and invoice QR data handling when returned by an external provider.
- E-way bill bulk JSON generation.
- E-way bill JSON preview before export.
- Transporter, vehicle, mode, document, and distance fields.
- PIN-to-PIN distance suggestion.
- Distance suggestions require user acceptance and are not silently posted.
- E-invoice and e-way document register.
- Export generated statutory files to a user-selected location.
- Experimental NIC live-filing configuration.
- NIC credentials stored through the operating-system keychain rather than ordinary configuration text.
- RSA/AES request preparation for supported NIC interaction.
- NIC status, configuration, IRN generation, and e-way generation commands.
- Sensitive NIC values masked in logs and diagnostics.
- Filing register for return type, period, ARN or acknowledgement, filed date, liability, source snapshot, and notes.
- Record and list filing events without pretending that a local record is a portal confirmation.
- Deadline notifications from local filing and company context.

## 19. TDS, TCS, income-tax, and audit disclosures

- TDS section catalogue with effective thresholds and rates.
- PAN validation and section 206AA higher-rate handling.
- Deduction suggestions based on ledger, party, section, date, amount, and prior threshold usage.
- Save and maintain section configuration.
- TDS summary and deduction worklist.
- Challan creation, editing, listing, and deletion.
- Link deductions to challans.
- Section 197 lower or nil deduction certificates.
- Certificate date, amount limit, rate, usage, balance, and expiry tracking.
- 24Q and 26Q preparation for supported historical periods.
- Income-tax Act 2025 form mapping for financial year 2026–27.
- Form 138 and Form 140 record layouts where supported.
- Field count, field order, code values, and CRLF output validation.
- Filing-profile configuration.
- Q4 Form 138 refusal where the implemented statutory model cannot produce a valid result.
- Return summary, CSV, and text return-file output.
- Unverified filename marking until external FVU and CSI validation has occurred.
- Form 16A deductee selection, generation, and PDF output.
- Form 3CD report and CSV export.
- Form 3CD clause extracts for supported stock valuation, depreciation, cash-payment, MSME, related-party, section 43B, loan/deposit, TDS, ratio, and expenditure data.
- Supported Form 3CD output includes clauses 14(a), 18, 21(d), 22, 23, 26, 31(a), 31(c), 34(a), 40, and 44, with caveats and explicit reasons for empty extracts.
- TCS calculation support in the shared tax engine.
- Import Form 26AS caret-delimited and CSV data.
- 26AS reconciliation by PAN, amount, date, section, and deductor identity.
- 26AS buckets for matched, amount mismatch, date drift, not in 26AS, and not in books.
- TAN and deductor-name inheritance where the source file supplies it.
- Signed reversal handling.
- Unlinked tax-credit investigation instead of silent allocation.
- Dated mapping between Income-tax Act 1961 and Income-tax Act 2025 concepts.
- Related-party disclosures.
- Rule 3(1) books and records disclosure support.
- Audit statement and audit-oriented exception output.

## 20. Payroll and employee compliance

- Employee master create, update, list, and deactivate/delete workflow.
- Employee identity, joining date, leaving date, bank, tax, PF, ESI, cost centre, and compensation data.
- Pay-head masters.
- Employee-specific pay-head assignment.
- Attendance and leave entry.
- Monthly attendance persistence.
- Monthly payroll cycle.
- Weekly payroll cycle.
- Fortnightly payroll cycle.
- Proration for joining and leaving dates.
- Payroll preview before commitment.
- Payroll run commit and deletion safeguards.
- Statutory monthly true-up for non-monthly pay cycles.
- Refund handling when a true-up reverses an excess deduction.
- Effective-dated PF rates and limits.
- Effective-dated EPS and EDLI treatment.
- Effective-dated ESI rates and limits.
- Professional Tax calculation and summaries.
- Effective-dated Professional Tax slabs by supported employee state.
- Payroll TDS calculation.
- Bonus calculation support.
- Gratuity calculation support.
- Full-and-final settlement.
- Employee advances and loans.
- Create, list, recover, and close employee loans.
- Due-recovery worklist.
- Payslip generation.
- Batch payslip generation.
- Payslip PDF and sharing/export handoff.
- EPFO ECR generation and structural validation.
- ESI contribution CSV.
- Professional Tax CSV and summary.
- Form 16 generation and PDF output.
- Salary bank-transfer file.
- Salary-transfer totals and bank-detail checks.
- Payroll trend report.
- Cost-centre-aware salary posting.
- Payroll run and statutory revision history through auditable postings.
- Employee salary-revision history derived from effective pay-head assignments and the audit trail.
- Employee-specific payslip export suitable for self-service handoff.

## 21. Fixed assets, CWIP, loans, deposits, prepaids, and bank finance

### 21.1 Fixed assets and CWIP

- Fixed-asset block master.
- Asset register with description, date, cost, location, block, useful life, method, and opening depreciation.
- Companies Act straight-line depreciation.
- Companies Act written-down-value depreciation.
- Income-tax block depreciation.
- Half-rate treatment for eligible additions.
- Depreciation schedule by period.
- Post depreciation through an explicit voucher.
- Disposal draft and posted asset disposal.
- Gain or loss calculation on disposal.
- Capital-work-in-progress register.
- Add and remove CWIP costs.
- Capitalisation preview and asset draft.
- Capitalise CWIP into a fixed asset with traceability.

### 21.2 Borrowing and treasury

- Loan and borrowing master.
- Principal, rate, tenure, instalment, lender, and ledger linkage.
- Instalment schedule view.
- Instalment voucher draft.
- Post loan instalments with principal and interest split.
- Deposit register.
- Deposit return workflow and summary.
- Prepaid-expense and accrued-expense schedule.
- Prepaid posting draft and period posting.
- Cash-credit and bank-facility master.
- Drawing-power calculation.
- Stock statement for lenders.
- CMA pack preparation.
- CMA Forms I through VI where supported by available book and estimate inputs.
- Prefill CMA packs from books.
- Explicit estimate inputs with visible labels.
- Missing historical years remain blank/null rather than invented.
- Fund flow is not inferred when the required source information is absent.
- Save multiple CMA packs and facility configurations.

## 22. Invoices, PDFs, sharing, and printing

- Classic invoice template.
- Modern invoice template.
- Compact invoice template.
- Shared invoice data model so all templates use the same posted facts.
- Registration-specific seller identity.
- Customer billing and shipping details.
- Item descriptions, HSN/SAC, quantity, rate, discount, taxable value, GST, cess, and totals.
- Invoice-level discount allocation.
- Bank details.
- UPI payment QR.
- E-invoice QR where available.
- Custom voucher fields.
- Audit and print metadata.
- Logo.
- Letterhead controls.
- Footer text.
- Authorised-signature image.
- Stamp image.
- Terms and conditions.
- Original, duplicate, triplicate, and office-copy labels.
- Invoice number prefix and suffix.
- Pro-forma watermark where applicable.
- Multipage tables with repeated headers and carried-forward totals.
- Amount in words using Indian and supported international numbering rules.
- English invoice labels.
- Hindi invoice labels alongside English.
- Marathi invoice labels alongside English.
- Operating-system font use for reliable script rendering.
- HTML print preview.
- Live invoice preview while editing invoice-print configuration.
- PDF invoice generation.
- Batch invoice PDF generation to a selected folder.
- Share action that prepares text and file handoff.
- WhatsApp-compatible clipboard text and `wa.me` handoff.
- No hidden SMTP or automatic email sending.
- 58 mm thermal receipt output.
- 80 mm thermal receipt output.
- Clear non-tax-receipt disclosure on applicable counter receipts.
- ESC/P raw-print generation and preview.
- Installed-printer listing.
- Save raw print data to a file when direct printing is unavailable.
- Barcode-label preview and TSPL-oriented label printing.
- Cheque PDF and advice printing.
- Branch-transfer, RCM, payslip, Form 16, Form 16A, BRS, statements, ISD, migration, reports, and CA-pack document generation.

## 23. Custom fields, attachments, and document evidence

- Company-defined custom fields by voucher type.
- Text custom fields.
- Number custom fields.
- Date custom fields.
- List/select custom fields.
- Required-field configuration.
- Field ordering.
- Add, update, list, and retire custom-field definitions.
- Historical values remain readable after a field definition is retired.
- Custom fields save transactionally with the voucher.
- Custom fields can appear on invoice output.
- Financial reports remain derived from accounting lines and are not altered by presentation-only custom fields.
- Add file attachments to a voucher.
- Store attachment metadata in SQLite and file content on disk.
- List, open, reveal, and remove attachments.
- Attachment storage-footprint reporting.
- Attachment approval and audit context.
- Safe filename and path handling.
- Attachment actions respect company, user, lock, and permission scope.

## 24. Users, roles, permissions, approvals, and locks

- Local users per company.
- User create/update, list, login, logout, and deactivation.
- Owner role.
- Accountant role.
- Viewer role.
- Deny-oriented granular permission overrides.
- Permissions enforced in the main process rather than only hidden in the renderer.
- Separate rights for reading, posting, editing, deleting, exporting, settings, users, approvals, and sensitive operations.
- Approval threshold configuration.
- Approval worklist.
- Approve or reject pending transactions.
- Approver identity, decision time, reason, and linked voucher.
- High-value voucher approval enforcement.
- Sensitive bank-detail approval workflow.
- Company financial-year lock.
- Lock-date enforcement across posting, edit, delete, reclassification, and import paths.
- Year-end close preview.
- Year-end close operation.
- Year-end reversal with audit trace.
- Archived-company read/export behavior.
- Licence-expiry read/export behavior so books are never held hostage.
- Temporary auditor session with time-limited read-only access.
- Owner must explicitly start and end auditor mode.
- Auditor actions are attributed.
- Auditor mode automatically expires and is not silently persisted across sessions.
- Device lock screen.
- Automatic inactivity lock.
- PIN/password throttling and lockout behavior.
- Current-authentication status available to the UI.

## 25. Audit trail, integrity, and diagnostics

- Append-oriented audit trail for material company actions.
- Before-and-after change summaries.
- Actor, time, entity, action, and reference attribution.
- Audit entries for voucher, master, settings, user, approval, filing, backup, restore, import, AI, and sensitive banking operations where applicable.
- Hash-linked audit chain.
- Audit-chain verification.
- Tail-truncation detection.
- Explicit disclosure that a local hash chain is tamper-evident, not an independently notarised ledger.
- Daily audit digest.
- Auditor-focused digest and exception review.
- AI conversation links to source voucher and audit context when explicitly linked.
- Sensitive-value redaction from audit and diagnostic output.
- In-memory and on-disk error reporting with bounded logs.
- Error ring buffer included only through a visible pre-send feedback preview.
- Renderer error reporting to the main-process logger.
- Diagnostic bundle preview.
- Diagnostic export/reveal workflow.
- IPC payloads, credentials, API keys, and full financial records are excluded from routine logs.
- Support-send workflow with visible failure handling.
- Shared feedback endpoint support for configured deployment channels.

## 26. Backups, restore, recovery, and data safety

- Manual company backup.
- Automatic backup scheduling.
- External backup-folder selection.
- External backup schedule configuration.
- Run external backup immediately.
- Backup retention setting from 5 through 200 retained copies.
- Backup list with metadata.
- SQLite integrity verification for backups.
- Restore preview before replacing current books.
- Restore preview explains source company, backup age, integrity, and what newer work would be lost.
- Restore operation with safety backup.
- Recovery listing for available safe copies.
- Duplicate-as-new-company recovery path.
- Encrypted portable backup export.
- Encrypted portable backup import.
- Open JSON/portable round-trip support.
- Data-root move with copy, verification, switch, and original preservation.
- Warning when a selected data path appears to be a synchronised cloud folder.
- Machine-profile and uninstall safety verification.
- File heartbeat and database-open safety checks.
- SQLite integrity checks on critical recovery paths.
- Migration hashes and migration-integrity verification.
- Forward-only schema migrations.
- Voucher bin and restore.
- Configurable automatic bin purge.
- Explicit permanent purge action.
- Year locks, archive mode, and licence expiry do not prevent safe export.

## 27. AI assistant and intelligent assistance

- AI is disabled by default.
- AI code and provider dependencies are loaded only when the feature is enabled and used.
- Bring-your-own-key support for OpenAI-compatible providers.
- Local Ollama and LM Studio loopback support.
- Local-provider mode can operate without usage charges or financial-data egress.
- Remote plain-HTTP endpoints are rejected.
- Provider connection test.
- Provider configuration, model, limits, and consent settings.
- Operating-system protected secret storage for provider keys.
- Consent state resets when privacy-relevant provider configuration changes.
- Streaming assistant responses.
- Per-run identifiers and event allowlist.
- Event coalescing to avoid renderer overload.
- Escape/cancel support for an in-progress run.
- Reset assistant session.
- Preview the exact redacted data envelope before sending.
- Deterministic redaction of configured sensitive fields.
- Prompt-injection quarantine for untrusted imported and attachment-derived text.
- Bounded context and response truncation with visible notices.
- Integer-paise facts and formatted display amounts in AI tool results.
- TypeScript-computed aggregates rather than model-calculated accounting totals.
- Source references and citations in supported answers.
- GST explanations grounded in local return and voucher facts.
- Natural-language voucher draft generation.
- Generated vouchers remain drafts and require normal validation and user posting.
- Ledger suggestions based on book context.
- Anomaly detection for unusual or inconsistent bookkeeping.
- Period-close checklist assistant.
- Ask drawer available from the application shell.
- Run log and local assistant history.
- Link an assistant run to a voucher.
- Per-run and period spend estimates.
- Spend caps.
- Provider fallback cost handling.
- Audit records omit API keys and raw secrets.
- No autonomous silent posting, filing, deletion, or correction.

## 28. Agent access and MCP

- Separate local MCP server for external agent access.
- Agent access disabled by default.
- Company selected by stable company slug.
- Read-only access is the default permission posture.
- Two explicit enablement switches before agent access is active.
- Rate limiting.
- Agent-access configuration in Settings.
- Generate a connection snippet for supported clients.
- Export a structured JSON mirror for offline inspection.
- Inbox/output directories for controlled file exchange.
- MCP resources for chart of accounts, schema information, and agent-facing changelog.
- Read operations for supported company, ledger, voucher, report, GST, and inventory context.
- Write operations remain constrained by configuration, schema validation, permissions, locks, and ordinary business rules.
- MCP bundle build and bundle-integrity test.
- Agent actions are attributable and auditable.
- The agent bridge does not bypass approval, statutory, lock, or accounting invariants.

## 29. Search, saved views, schedules, CLI, and interoperability

- Global entity and navigation search.
- Search across supported vouchers, ledgers, parties, items, and screens.
- Ledger suggestions and contextual lookup.
- Saved report and Day Book views.
- Create, list, run, and delete report schedules.
- Scheduled output targets a local folder selected by the user.
- CSV export.
- Streaming CSV export.
- SpreadsheetML/XLS export.
- PDF export.
- Portable open-data export/import.
- Tally XML import and export.
- GST, TDS, payroll, banking, e-invoice, and e-way statutory file formats described in their respective sections.
- Command-line interface for supported local company inspection and export tasks.
- CLI documentation generation.
- Machine-readable schema documentation.
- Voucher JSON Schema generation.
- Separate MCP build command.
- No background cloud sync is required for interoperability.

## 30. Public website, commerce, documentation, and support

### 30.1 Public pages

- Product home page.
- Pricing page.
- Purchase page.
- Download page.
- Chartered-accountant page.
- Partner page.
- Product comparison page.
- Public roadmap page.
- Changelog page.
- Contact page.
- Privacy page.
- Demo page.
- Search-engine landing pages generated from maintained SEO content.
- Sitemap and robots metadata.

### 30.2 Documentation

- Documentation home.
- Getting-started guidance.
- Backup and restore guide.
- Coming-from-Tally guide.
- GST returns guide.
- Frequently asked questions.
- Sidebar navigation and shared documentation layout.
- Markdown-backed product and release content where configured.

### 30.3 Pricing, checkout, licences, and referrals

- Product and edition catalogue.
- Fail-soft pricing presentation when optional commerce configuration is absent.
- Checkout refuses with a service-unavailable response when payment or pricing configuration is incomplete.
- Razorpay order creation.
- Checkout verification.
- Payment webhook processing.
- Hosted-payment-link fallback where configured.
- Coupon rules.
- Referral-code redirects and attribution.
- Partner/referral support.
- Optional server-side licence delivery after verified payment.
- Configurable licence delivery through email and WhatsApp after verified payment.
- Offline Ed25519 licence verification in the desktop app.
- Public verification key separated from private licence-signing material.
- Trial and edition limits.
- Free chartered-accountant edition with unlimited client companies and membership-number positioning.
- Licence application in Settings.
- Licence expiry preserves read and export access.

### 30.4 Downloads, updates, feedback, and reminders

- Latest-release API.
- Private-GitHub-release proxy support using a read-only token.
- Platform and architecture download selection.
- Release checksums.
- Download API.
- Desktop update check.
- Release notes and in-app changelog context.
- Site fallback for update discovery.
- Feedback API with configured GitHub, email, or webhook delivery paths.
- Feedback failure is reported rather than silently discarded.
- Trial reminder API.
- Explicit opt-in email capture for one trial-expiry reminder; the desktop app does not transmit an address automatically.
- Localised indicative price display for supported visitor countries while charging the stated INR amount.
- Testimonials data model.
- Honest placeholders where real testimonials or a real product video have not been supplied.

## 31. Performance, quality, security, and release engineering

### 31.1 Scale and performance

- Indexed SQLite query paths for major books and reports.
- Prepared-statement wrapper and statement-boundary tests.
- Keyset pagination for large Day Book and ledger datasets.
- Renderer row virtualisation.
- Streaming CSV output to avoid constructing very large exports in memory.
- Lazy-loaded screens.
- Lazy-loaded AI surface.
- Debounced global search.
- 30,000-voucher and 100,000-voucher scale fixtures and benchmarks.
- Startup-time budget scenario.
- Query-time budgets.
- Memory-ceiling tests.
- Bundle-size budget.
- Performance sweep and A/B comparison scripts.
- Large-book database generator.

### 31.2 Security and privacy

- Electron context isolation and preload bridge.
- Zod-validated IPC inputs.
- Typed renderer client as the single supported renderer-to-main invocation path.
- Strict IPC and event allowlists.
- Renderer Content Security Policy tests.
- Sandboxed renderer configuration.
- External URLs opened only through an explicit scheme and destination allowlist.
- Operating-system keychain storage for NIC and AI credentials.
- No secret values in logs, diagnostics, audit records, or renderer configuration.
- Local lock screen and inactivity lock.
- Authentication throttling.
- Permission checks in services.
- SQL query boundaries and soft-delete predicates tested.
- Dependency vulnerability gate and dependency freshness report.
- AI egress preview, endpoint validation, redaction, consent, and injection defences.
- Offline user data by default.

### 31.3 Automated verification

- Shared-domain unit tests.
- Property-based accounting and posting tests.
- Database integration tests.
- Migration tests and migration-hash checks.
- IPC channel registry tests.
- Renderer component and hook tests.
- Accessibility and design-system tests.
- Security-boundary tests.
- Golden statutory fixtures for GSTR-1, GSTR-3B, amendments, e-way bill, and ITC-04.
- Invoice and report snapshots.
- Mutation-testing script.
- Visual-regression script and baseline manifest.
- Desktop smoke test.
- Built-Electron Playwright end-to-end suite.
- Fifty-four named end-to-end journeys covering onboarding, demo, voucher lifecycle, Tally import, banking, GST, payroll, year end, backup/restore, roles, keyboard, accessibility, NIC masking, AI, licensing, GST composition, turnover, filings, entry guidance, report toggles, views, repeat entry, Khata, collections, payroll desk, inventory, assets, fonts, analysis, fresh machine, support, statutory depth, sample trades, CMA, amendments, job work, invoice print, rate history, TDS certificates, multi-GSTIN, custom fields, purchase chain, attachments, counter, data safety, bank desk, entry ergonomics, startup budget, inventory lane, branch transfer, ISD, and QRMP/IFF.
- macOS CI build and test workflow.
- Windows CI build and test workflow.
- Packaging smoke checks.
- Release verification script.
- Update-artifact verification script.
- Bundle-budget script.
- Dependency-report script.
- App and website screenshot drivers.
- App-icon generation and verification.
- Contributor and release guidance in repository documentation.

### 31.4 Release and update mechanics

- Versioned desktop packaging.
- DMG and ZIP-oriented macOS release outputs.
- Windows packaging path.
- Git tag and GitHub Release workflow.
- Release automation refuses draft releases because the update feed relies on `releases/latest`.
- Site auto-deployment from the `site/` root on the main branch.
- Update metadata and checksum verification.
- Electron updater integration.
- Installed app polling through the site's latest-release API.
- Hardened runtime and entitlement configuration scaffolding.
- Secret-presence and release-readiness checks.

## 32. Explicit boundaries, gated features, and work that is not represented as complete

This section is part of the feature catalogue. It prevents an experimental surface, an external dependency, or a deliberately rejected design from being mistaken for a completed production feature.

### 32.1 Deliberately not implemented

- Arbitrary type-to-filter behavior across every screen is not implemented because it conflicts with safe keyboard entry and explicit search focus.
- Per-user remapping of every keyboard shortcut is not implemented; the app provides fixed, validated Tally-oriented accelerators and conflict detection.
- PDF bank-statement extraction is not implemented. CSV statement import is the supported path.
- Automatic invoice email with an SMTP client is not implemented. PDF export, folder batch output, clipboard sharing, and WhatsApp handoff are supported.
- Invoice ZIP generation is not implemented. Batch PDFs are written to a selected local folder.
- Bill-photo vision extraction is not implemented.
- An AI anomaly auto-fix path is not implemented. Anomalies can be inspected, and any correction must pass through ordinary entry and approval controls.
- Database-wide SQLCipher encryption is not implemented. Portable backup encryption, protected secrets, local access control, and operating-system disk encryption are the supported layers.
- Direct restore from a native Tally backup file is not implemented. Tally XML is the supported migration source.
- Dedicated Busy, Marg, and Vyapar importers are not implemented. Generic CSV and spreadsheet imports remain available.
- A LAN companion app is not implemented.
- A separate replay-log subsystem is not implemented; the product uses the voucher history, audit trail, attachments, filings, and hash chain.
- Broad report-result caching, incremental report materialisation, progressive partial reports, renderer-worker CSV generation, and IPC batching are not implemented as product features. Indexed SQL, keyset pagination, virtualisation, lazy loading, and streaming export are the chosen scale mechanisms.
- Off-main-process PDF rendering is not represented as complete.
- Startup chunk splitting beyond the existing lazy-screen and lazy-AI boundaries is not represented as complete.

### 32.2 Implemented as preview or experimental capability

- NIC live e-invoice and e-way filing is experimental and requires valid external credentials, network access, and real portal validation.
- The Electron renderer sandbox and external-navigation allowlist are implemented in code and tests, but production packaging must still be checked on the final signed artifacts.
- ISD/GSTR-6 is a working preparation and PDF surface, not a claim of live portal-ready filing.
- ITC-04 output is schema-backed preparation and must still be validated against the live portal for the filing period.
- TDS return files remain named as unverified until they have passed the external FVU and CSI tools.
- Raw ESC/P receipt and TSPL label output can be previewed and saved; final printer behavior depends on the user's exact printer, driver, paper, and encoding.

### 32.3 Human or external release gates

- Apple Developer signing credentials, hardened-runtime signing, notarisation, and final Gatekeeper validation require the repository owner’s Apple account and secrets.
- Windows code-signing credentials and SmartScreen reputation require the repository owner’s certificate and release history.
- Final validation on representative physical Windows hardware remains a human hardware check.
- Live NIC portal validation requires the owner's GST/NIC credentials and authority to perform real statutory actions.
- TDS FVU/CSI validation requires the official external utilities and period-specific source files.
- Real checkout validation requires production payment credentials and an authorised low-value transaction.
- Real invoice, receipt, cheque, label, and statutory printing requires the intended physical printers and stationery.
- The marketing site needs real customer-approved testimonials before testimonials can be represented as published social proof.
- The demo page needs a real recorded product video before it can be represented as a completed product demonstration.
- Final legal, tax, privacy, and accounting review must be performed by qualified humans for the release jurisdiction and target customer segment.

## 33. Complete application screen index

The following index lists every routed desktop screen in the shared screen registry, including non-sidebar detail screens.

### Top level

1. Gateway
2. Voucher entry

### Books

3. Day Book
4. Masters
5. Recurring vouchers
6. Import from Tally

### Analysis

7. Trial Balance
8. Profit & Loss
9. Balance Sheet
10. Cash Flow
11. Stock Summary
12. Year-end close
13. Registers
14. Outstandings
15. Consolidated reports
16. Cost centres
17. Budgets
18. Exceptions

### Banking and finance

19. Banking — reconciliation, BRS & post-dated
20. Fixed assets
21. Borrowing & the bank

### Payroll

22. Payroll — employees & runs

### GST and statutory

23. GSTR-1
24. GSTR-3B
25. GSTR-2B reconciliation
26. e-Invoice & e-Way
27. Job work & ITC-04
28. Disclosure
29. Filing register
30. Composition — CMP-08 & GSTR-4
31. TDS

### Selling and collections

32. Khata
33. Collections
34. Counter mode
35. Quotations, orders & challans

### System

36. Settings

### Non-sidebar and detail screens

37. Company details
38. Ledger statement
39. Company selection
40. Opening balances

## 34. Complete settings index

1. Appearance
2. Backups
3. Bin
4. Users
5. Audit trail
6. Approvals
7. Auditor and digest
8. NIC live filing
9. Features
10. Invoice print
11. Custom fields
12. Collections
13. Scheduled reports
14. Agent access
15. AI assistant
16. Licence
17. About
18. Data root, move, restore, recovery, and related data-safety panels

## 35. Complete major desk and tab index

- Masters: Ledgers, Groups, Stock items, Stock groups, Godowns, Units, Voucher types, Currencies, and Price lists.
- Banking: Status, Reconciliation, Bank Reconciliation Statement, Post-dated cheques, and Foreign currency.
- TDS: Deductions, Challans, TDS return, Form 16A, Section 197, and Form 26AS.
- Payroll: Employees, Pay heads, Attendance, Payroll runs, statutory outputs, loans/advances, settlement, and trends.
- Composition: CMP-08 and GSTR-4.
- Job work: Challans and ITC-04.
- Fixed assets: Asset register and depreciation schedule.
- Borrowing: Loans, Deposits, Prepaids/accruals, Facilities/drawing power, and CMA packs.
- Sales chain: Quotations, Sales orders, Delivery challans, Purchase orders, and Receipt notes.
- Stock specialist desks: Standard costs, Serials, and Labels.
- Multi-GSTIN controls: Registration list, primary registration, registration detail, and cross-registration transfers.
- GSTR-2B/IMS classifications: Matched, amount mismatch, date drift, not in GSTR-2B, and not in books.
- ITC-04 tables: Table 4, Table 5A, Table 5B, and Table 5C.
- Counter tenders: Cash, Card, UPI, and On account.

## 36. Capability registry coverage

The application’s validated IPC registry exposes the following complete capability families. Each family is described functionally in the sections above and is listed here to make omissions mechanically detectable during future maintenance.

- Agent bridge: configuration, connection snippet, and mirror export.
- AI: configuration, connection test, preview, chat, streaming cancellation, session reset, spend, log, and voucher linking.
- Amendments: report and export.
- Analysis: registers, outstandings, Khata, and party shares.
- Application: product info, updates, checklist, deadline notifications, external links, and data-root management.
- Approvals: list and decide.
- Assets and CWIP: blocks, register, schedules, depreciation, disposal, capitalisation, and deletion.
- Audit and auditor mode: list, digest, chain verification, begin, status, and end.
- Authentication and users: current user, login, logout, list, save, and deactivate.
- Backup and recovery: manual, scheduled external, encrypted portable, preview, verify, restore, and recovery.
- Banking: statement inspection/import/filing, reconciliation, BRS, learned matches, rules, charges, locks, cheques, PDC, bounce, and bank-detail approvals.
- Bills and receivables: open bills, advances, allocations, ageing, credit policy, credit scores, interest, MSME, provisions, reminders, schedules, and statements.
- BOM and manufacturing: items, detail, get, and set.
- Branch transfer and RCM: issue, register, PDF, and delete.
- Budgets and cost centres: create, update, list, delete, reports, statements, and variance.
- Cheque printing: configuration, grid test, advice, and PDF.
- CMA: facilities, packs, prefill, inputs, save, and delete.
- Commissions: schemes, drafts, and reports.
- Company: create, demo, list, open, current, close, update, archive, lock, backup, delete, and reveal exports.
- Configuration: features, invoice, approvals, audit, backup retention, and bin purge.
- Consolidation: run.
- Counter: sessions, lookup, prices, schemes, sales, movements, summaries, and close.
- Currencies and foreign exchange: currencies, accounts, preview, revalue, list, and remove.
- Custom fields: definitions and voucher-specific fields.
- Deposits, loans, and prepaids: save, view, schedule, draft, post, return, summary, and delete.
- Disclosures: audit statement, related parties, e-invoice window, and LUTs.
- E-documents: list, transport details, distance, preview, e-invoice, and e-way bill.
- Exports: CA pack, CSV, streaming CSV, XLS, portable, and Tally XML.
- Filings: liability, record, and register.
- GST: GSTR-1, snapshots, GSTR-1A, GSTR-3B, manual buckets, GSTR-9, CMP-08, GSTR-4, GSTR-2B, validation, tax rates, registrations, and cross-transfers.
- IMS and ISD: worklist, decisions, matched acceptance, credits, distributions, withdrawals, GSTR-6, desk, and PDF.
- Imports: CSV picker, template, preview, apply, portable, and Tally migration.
- Intelligence: anomalies and ledger suggestions.
- Invoice and printing: HTML preview, PDF, batch PDF, share, thermal, ESC/P, printers, and labels.
- Item rates and price levels: effective rates, versions, revisions, preview, apply, and delete.
- Job work: challans, returns, clock, numbering, and ITC-04.
- Licensing: status and apply.
- Logs and support: renderer log, diagnostics, reveal, and support send.
- Masters: ledgers, groups, stock groups, stock items, godowns, units, batches, voucher types, currencies, balances, and price levels.
- MCP: client snippet.
- NIC: configuration, status, IRN, and e-way generation.
- Party relationship: notes and promises.
- Payroll: employees, heads, attendance, runs, preview, commit, payslips, ECR, ESI, PT, TDS, Form 16, transfers, loans, settlement, and trends.
- PDC: list and mature.
- Recurring and templates: create, use/post, due, skip, list, and delete.
- Reports: dashboard, core statements, Day Book, ledger, stock, exceptions, ratios, forecast, profitability, Schedule III, Form 3CD, purchase suggestions, PDF, and change comparison.
- Sales documents: create, retrieve, list, convert, match, fulfil, invoice draft, close, pipeline, and delete.
- Saved views and schedules: create, list, run, and delete.
- Scratchpad: ensure, list, and classify.
- Search: global search.
- Stock: lookup, summary, by godown, batches, expiry, transfers, landed costs, reorder, rates, images, serials, standard costs, variance, and labels.
- TDS: sections, suggestions, summary, challans, linking, returns, filing profile, Form 16A, section 197 certificates, 26AS import, and reconciliation.
- Vouchers: list, count, retrieve, save, number checks, latest, draft, duplicate detection, delete, restore, purge, bin, bulk edit, attachments, and approval-aware lifecycle.
- Year end: preview, close, and reverse.

## 37. Maintenance rule

Any change that adds, removes, gates, renames, or materially changes a user-visible screen, IPC capability family, statutory output, site route, import/export format, settings control, release dependency, or explicit product boundary must update this file in the same change. A feature must not be moved from preview or gated status to complete status without corresponding automated evidence and any required real-world or owner validation.
