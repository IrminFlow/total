# Total revamp — master plan (7 phases)

Date: 2026-10-07 · Status: awaiting "implement" · Baseline: v0.4.0 (`a278e7e`), migration 017, 203 IPC channels

This is the master plan. Phases 1 and 2 are specified to work-package (WP) level. Phases 3–7 list
their work packages, data model and acceptance tests; each gets a WP-level brief written by the
orchestrator when the phase starts, against the code as it then stands.

## 0. Ground rules

### 0.1 Roles

- **Orchestrator (Fable):** writes briefs, assigns migration numbers, reviews every diff, runs the
  app, merges, releases, watches CI/Vercel. Writes no feature code.
- **Implementers (Opus 5.5 subagents):** one WP each, in its own git worktree and branch
  (`p<phase>/<wp-slug>`), test-first.
- **Reviewers (fresh Opus 5.5 subagents):** given the diff and the WP brief only, never the
  implementer's summary.

### 0.2 Decisions assumed (change any before "implement")

1. AI is opt-in, off by default; the app stays fully offline until the user turns it on.
2. Each user supplies their own OpenAI API key, stored via Electron `safeStorage`.
3. Manufactured goods enter stock at production cost (materials + labour), never at sale price.
4. Recurring vouchers: UI, IPC, service and engine code removed; table and data left in place.
5. Banking's sidebar section is collapsed by default along with Analysis, Payroll, GST, System
   (the request named four; Banking was not mentioned).

### 0.3 Invariants every WP must keep (from CLAUDE.md)

- Money is integer paise, quantity is integer thousandths. No floats on amounts.
- Reports are computed from `voucher_lines` + openings at query time. No stored balances.
- `src/shared/` stays pure. vitest never imports better-sqlite3.
- Every IPC payload is Zod-parsed; handlers return `{ ok, data | error }`.
- Schema changes are appended migrations. **The orchestrator assigns each migration number**; no
  WP picks its own. A branch that loses a merge race renumbers on rebase.
- Every query on `vouchers`/`voucher_lines`/`inventory_lines` filters soft-deleted vouchers.
- `.kbar-row` selection uses inset box-shadow, never `tr::before`.
- Renderer makes no network calls (CSP stays `default-src 'self'`).

### 0.4 Gate for every WP (all must pass before PR)

`npm run typecheck` · `npm test` · `npm run test:db` · `npm run test:renderer` · `npm run build` ·
`npm run smoke` · the relevant `node scripts/run-e2e.mjs NN` scenarios · fresh-reviewer pass ·
orchestrator reads the diff and drives the feature in the built app on a scratch `TOTAL_DATA_DIR`.

### 0.5 Gate for every phase

Full `npm run e2e` green on macOS, Windows build green, upgrade test (open a v0.4.0 company and a
Demo Traders copy; migrations apply; trial balance totals unchanged unless the phase says
otherwise), CLAUDE.md updated, site changelog entry, `npm version minor`, tag pushed, release
workflow watched to a published (non-draft) release, `/api/latest` and `/api/download` verified.

### 0.6 Release train

| Phase | Version | Depends on |
|---|---|---|
| 1 Foundation + UI/UX | 0.5.0 | — |
| 2 Inventory, manufacturing, trade cycle | 0.6.0 | 1 |
| 3 Compliance suite | 0.7.0 | 1 (runs alongside 2) |
| 4 Banking, receivables, cash | 0.8.0 | 1, 2 (orders feed the forecast) |
| 5 AI agent | 0.9.0 | 1–4 (tools wrap their services) |
| 6 Reports, analytics, data | 0.10.0 | 1 |
| 7 Platform, hardening, production | 1.0.0 | all |

---

## Phase 1 — Foundation and full UI/UX revamp (0.5.0)

### WP 1.0 — Baseline commit
- Commit the pending branding work as its own commit. Add a downscaled logo (≤128px) for the
  renderer instead of bundling the 778 KB PNG; keep the full PNG for the dock/window icon.
- The uncommitted `openai` and `@modelcontextprotocol/sdk` dependencies stay out of this commit and
  are added in Phase 5, so 0.5.0–0.8.0 ship without an unused network SDK.
- Add `typecheck` and `test:renderer` to `release.yml`; add unit + DB tests to the Windows CI job.

### WP 1.1 — Navigation
Files: `lib/screens.ts`, `components/Shell.tsx`, `state/stores.ts`, e2e 02 and 11.
- Sections become collapsible. Defaults: top block and Books open; Analysis, Banking, Payroll, GST,
  System closed. State persisted in localStorage per company. The section containing the active
  screen auto-opens. Headings are buttons with `aria-expanded`; ←/→ collapse/expand.
- "Import from Tally" moves to the last position in System.
- Recurring removal (same files, so same WP): delete `screens/Recurring.tsx`, the registry entry,
  Gateway `DueTodayPanel`, the "Save as recurring" modal and its buttons in `AccountingEntry` and
  `InvoiceEntry`, `recurring:*` IPC, client wrapper, `services/recurring.ts`, `shared/recurring.ts`,
  their tests, `recurringDraft.test.tsx`, and `'recurring'` in the e2e 02 tour. Keep migrations
  008/009, the table, the audit entity name and the `migrations.dbtest.ts` assertions.
- Acceptance: fresh launch shows only Gateway block + Books items; clicking "GST" reveals its
  items; state survives restart; no `recurring` string left outside migrations and audit entities.

### WP 1.2 — Masters shows everything
Files: `services/masters.ts`, `screens/Masters.tsx`, `services/search.ts`.
- Groups tab becomes a full chart of accounts: groups with their ledgers as leaves, ledger count
  and closing balance per node, expand/collapse all, filter that keeps matching leaves' ancestors.
- Ledgers tab: filter matches ledger name, group name, parent-group chain, GSTIN, PAN; a group
  dropdown; a "Group" column.
- Acceptance (dbtest + renderer test): a ledger "Local Sale" under "Sales Accounts" appears under
  that group in the tree and is returned when filtering by "Sales".

### WP 1.3 — Year-opening correctness
Files: `services/reports.ts` (`ledgerStatement`, L428–435), dbtests.
- **Verify first:** read how `trialBalance`, `profitLoss` and `yearEnd` treat income/expense
  ledgers across a financial-year boundary. Then make `ledgerStatement` agree: for ledgers whose
  group nature is income or expense, opening = movements from the start of the financial year
  containing `from` up to the day before `from`; the stored opening balance applies only in the
  first financial year of the books. Asset/liability ledgers are unchanged.
- Must not double-count when a year-end closing voucher exists.
- Acceptance: a purchase ledger with ₹X of prior-year debits opens the next year at 0; ledger
  closing equals the trial-balance figure for the same ledger and period in both the "year-end
  run" and "year-end not run" cases.

### WP 1.4 — One voucher editor, no data loss
Files: `screens/VoucherEntry.tsx`, `voucher/*`.
- Editing routes to the same mode that creates: trading kinds → `InvoiceEntry`, stock journal →
  manufacture/stock-journal editor, physical stock → `PhysicalStockEntry`, the rest →
  `AccountingEntry`. Each mode gains a load-from-voucher path.
- Inventory lines round-trip `batchId`, `isAbsolute`, `discountPaise`, `godownId`.
- Acceptance (dbtest): for every voucher kind, load → save unchanged leaves `voucher_lines`,
  `inventory_lines`, `bill_refs`, `tds_entries` identical apart from ids. Stock journals and
  physical-stock vouchers are editable.

### WP 1.5 — Small correctness fixes
- `LedgerFormModal`: accepts a `ledgerId`, preserves and exposes `rcm` and `itcEligibility`,
  invalidates all report queries on save.
- Clear the react-query cache on company switch.
- New `src/main/services/secrets.ts` over `safeStorage` (per-company namespaced; falls back to
  refusing to store, with a clear message, when encryption is unavailable). NIC credentials move
  out of the `meta` table on first open; the plaintext copy is deleted. Secrets are not in
  backups; after a restore on another machine the user re-enters them.
- Remove the `tds:suggest` side effect that creates a ledger while the user types (the ledger is
  created at save; full TDS redesign is Phase 3).
- Remove the duplicate `report:stockSummary` channel.

### WP 1.6 — Table platform
New: `components/table/` (DataTable, column chooser, filter row, view menu) and
`lib/table/` (pure sort/filter/group logic, unit-tested).
- Column definitions typed by kind: text, money (sorted by paise), quantity, date, enum, link.
- Sort on any column (multi-sort with Shift), per-column filters by kind (contains / range /
  date range / one-of), quick filter across all visible text, grouping with subtotals, totals
  footer, sticky header, row virtualisation (replaces the 500-row paging), column show/hide/reorder/
  resize, saved views per screen (localStorage, keyed by company + screen; replaces
  `useReportConfig`), keyboard navigation via `useKeyNav`, CSV and PDF export of the current view.
- Acceptance: unit tests for sort/filter/group; renderer tests for keyboard and view persistence;
  a 50,000-row table scrolls without dropped frames in the built app.

### WP 1.7a/b/c — Move every screen onto the table platform (three parallel WPs)
- a: Masters, DayBook, TrialBalance, LedgerStatement, Registers, Outstandings.
- b: StockSummary, Banking, Payroll, Budgets, CostCentres, Exceptions, CashFlow.
- c: GstReturns, Gstr2b, Edocs, Tds, Consolidated, YearEnd, Settings lists (Audit, Bin, Users).
- P&L and Balance Sheet keep `StatementTree`, gaining search, expand-to-level and export.
- Acceptance: every list in the app sorts, filters and navigates by keyboard; e2e 11 extended.

### WP 1.8 — Drill-down everywhere
New: `LedgerLink`, `ItemLink`, `VoucherLink`.
- Ledger **name** click opens the ledger edit window (read-only for viewer role). A click on the
  **rest of the row** opens that ledger's statement. Enter = statement, ⌘E = edit.
- Services must return ids, not names: `reports.ts` day-book account string (L369), Outstandings,
  Registers, CostCentres, Banking, CashFlow, YearEnd rows gain `ledgerId`.
- LedgerStatement header gains group breadcrumb and an Edit button.
- Acceptance: e2e walks every report screen, clicks a ledger name, asserts the modal; clicks row
  whitespace, asserts the statement.

### WP 1.9 — Search
Files: `services/search.ts`, `CommandPalette.tsx`, new `screens/SearchResults.tsx`.
- Search ledgers (name, group, GSTIN, PAN), items (name, HSN, barcode), vouchers (number,
  narration, party, exact amount, amount range, date), with typed prefixes (`amt:>50000`,
  `date:apr`, `gstin:`), ranking, 20 results per kind in the palette and a full results screen on
  the table platform. Recent searches and recently opened records.
- Implemented with indexed `LIKE` queries (no FTS shadow tables); all voucher queries filter
  deleted rows. Performance revisited in Phase 7.

### WP 1.10 — Design system and screens
- Tokens: finish the move to the type scale, add spacing/elevation/radius tokens, density setting
  (comfortable/compact), consistent page header (title, period, actions, options).
- Component kit additions: Tabs (LedgerStatement adopts `TabBar`), Drawer, Popover menu, Chip,
  Stat tile, Banner, charts (in-house SVG bar/line/sparkline — no chart dependency).
- Gateway dashboard: sales/purchase trend, cash and bank, receivables/payables ageing, top
  parties, GST and TDS due dates, stock alerts, onboarding checklist. All computed at query time.
- An options panel on every screen (period, columns, grouping, display toggles) with defaults
  saved per screen.
- Invoice/print template designer: multiple templates, logo, column choice, terms, signature
  block, live preview.
- Accessibility pass (focus order, contrast in both themes, labels); e2e 12 extended.

### Phase 1 order
1.0 → {1.1, 1.2, 1.3, 1.5} in parallel → {1.4, 1.6, 1.9} in parallel → {1.7a, 1.7b, 1.7c, 1.8} →
1.10 → phase gate → 0.5.0.

---

## Phase 2 — Inventory, manufacturing and the trade cycle (0.6.0)

### WP 2.1 — Valuation engine: conserved manufacture cost
Files: `shared/valuation.ts`, `services/stockAnalysis.ts`.
- Today the engine walks one item at a time and trusts the stored value on a manufacture's inward
  line. Change to a single global pass ordered by (date, voucher id, outward-before-inward,
  line order) so that, for a manufacture voucher, **inward value = engine-computed cost of that
  voucher's own outward lines + labour**. Works for weighted-average and FIFO items.
- Legacy manufacture vouchers (no `manufacture_details` row) keep today's behaviour exactly, so
  existing books do not change value on upgrade.
- Acceptance (unit): value conservation property — for any sequence, Σ consumed cost + labour =
  finished-goods inward value; a backdated purchase re-prices later manufactures consistently;
  legacy fixtures produce byte-identical summaries before and after.

### WP 2.2 — Manufacture voucher (the screen you specified)
Migration (number assigned at start): `manufacture_details(voucher_id PK, finished_item_id,
qty_milli, sale_rate_paise, sale_amount, labour_paise, labour_expense_ledger_id,
labour_credit_ledger_id, profit_paise)`. These are entry facts, not balances.
- Sidebar: **Manufacture** in the top block, directly under Voucher entry (inventory feature on).
- Header: number, date, godown, narration.
- **Left — Sale Item:** exactly one row, four columns: Item · Quantity · Average price · Amount.
  Average price defaults to the item's average selling rate (from sales in the current year, then
  price list, then blank) and is editable. Amount = quantity × average price.
- **Right — Raw Material:** ten rows, four columns: Raw Material · Quantity · Average cost ·
  Amount. Average cost is supplied by the server **as of the voucher date** and is read-only. If
  the item has a BOM, rows pre-fill from it and stay editable. More rows can be added past ten.
  Below the rows: **Labour cost** (amount), **Production cost** (materials + labour), and
  **Profit** = sale amount − production cost, recalculated on every keystroke.
- **Match rule:** right total (production cost + profit) must equal left amount. With profit as
  the balancing figure this holds by construction, so the server also enforces the substantive
  checks: item and quantity present, every raw row complete, no raw material equal to the finished
  item, sufficient raw stock on the voucher date (existing warn/block setting), and
  `profit = sale amount − production cost` to the paisa. A loss asks for confirmation.
- **Posting on save (one transaction):** one outward inventory line per raw material; one inward
  line for the finished item dated the voucher date; labour as ledger lines Dr Labour Charges
  (Direct Expenses) / Cr the chosen account (default Wages Payable). An "already booked" switch
  capitalises labour without ledger lines for users who post wages separately. The sale price and
  profit are recorded for margin reports and **do not post** — stock enters at cost.
- Edit and delete work through the same screen (depends on WP 1.4).
- Acceptance: dbtests for posting, validation and stock deduction; new e2e `14-manufacture`
  covering create → stock summary shows finished goods in and raw material out on the date →
  edit → delete.

### WP 2.3 — Stock visibility
- Item movement register per stock item (date, voucher, in, out, rate, running quantity and
  value), opened from Stock summary and from any `ItemLink`.
- Generic stock journal and godown transfer screen (today every stock journal is forced into
  manufacture).
- Godown, batch, expiry and serial number selectable on inventory lines in every voucher mode.
- Valuation method (weighted average / FIFO) selectable per item in Masters.
- Reports: stock ageing, negative stock, reorder planning from reorder levels and consumption,
  barcode label printing.

### WP 2.4 — Deeper manufacturing
- Multi-level BOM with explode option, BOM versions with effective dates, scrap and by-product
  lines, "save these rows as the BOM" from the manufacture screen.
- Job work out/in with third-party godowns and challans (feeds ITC-04 in Phase 3).
- Reports: production register, cost sheet per product, expected vs realised margin, material
  variance against BOM.

### WP 2.5 — Sales and purchase cycles
- Non-posting documents: quotation, sales order, purchase order (new tables, own numbering,
  print templates, status: open/partly fulfilled/closed).
- Stock-only vouchers: delivery challan and goods receipt note (new voucher kinds; the
  `voucher_types.kind` CHECK needs a table-rebuild migration).
- An invoice or bill raised against a challan/GRN links line-to-line and does not move stock a
  second time; a bill re-prices its GRN's inward value.
- Pending-order reports, three-way match (PO ↔ GRN ↔ bill) exceptions.
- The line-linking and re-pricing rules are the riskiest design in this phase and get their own
  written design, reviewed before any code.

### WP 2.6 — Pricing and counter billing
Price-list editor, party-wise rates, discount schemes (quantity slabs, date ranges), and a
keyboard/barcode-first counter-billing mode.

### Phase 2 order
2.1 → 2.2 → {2.3, 2.4} → 2.5 → 2.6 → phase gate → 0.6.0.

---

## Phase 3 — Compliance suite (0.7.0)

**Tax-rule sourcing rule for this whole phase:** implementers do not write rates, thresholds,
section numbers or form layouts from memory. Each is taken from the current statute, notification
or official utility, cited in a code comment with its date, effective-dated in the data, and
user-editable. In particular the Income-tax Act, 2025 is understood to apply from 1 April 2026 and
to renumber the TDS provisions; the section master must carry both old-Act and new-Act references
by effective date. This is to be confirmed against the official text at phase start.

- **WP 3.1 TDS core.** Tag column on ledgers for TDS payable ledgers (mirrors `tax_type`), payable
  ledgers created at save in main, effective-dated section/rate/threshold master, deductee types,
  expense ledgers flaggable as TDS-applicable, lower-deduction certificates. Server validates
  `tds_entries` against voucher lines.
- **WP 3.2 TDS in entry and the TDS screen.** TDS suggestion in purchase invoices as well as
  accounting vouchers. TDS screen tabs: *Eligible* (every voucher that should carry TDS and does
  not, with one-click "Move to TDS" that adds the deduction under lock-date and audit rules),
  *Deducted* (every entry, editable and deletable), *Challans* (payment vouchers matched to
  deductions, interest on late payment), *Returns* (26Q/24Q data, Form 16A data), *Sections*.
  New e2e `15-tds`.
- **WP 3.3 TCS** on sales, mirroring 3.1–3.2, with 27EQ data.
- **WP 3.4 GST expansion.** GSTR-9 workings, ITC-04 (from job work), improved 2B matching
  (fuzzy invoice numbers, tolerance, bulk accept), RCM self-invoices, ITC reversal workings.
- **WP 3.5 NIC sandbox run.** Needs sandbox credentials from you; without them this WP stops at
  contract tests against the published spec and the feature keeps its "experimental" label.
- **WP 3.6 Fixed assets.** Asset register, additions/disposals, depreciation under both Acts,
  posting of depreciation journals, asset schedule.
- **WP 3.7 Payroll statutory.** PF, ESI, professional tax, salary TDS workings, Form 16 data.
- **WP 3.8 Audit trail.** Edit-log report suitable for the MCA requirement; audit log cannot be
  disabled or edited from the UI.

## Phase 4 — Banking, receivables and cash (0.8.0)

- **WP 4.1 Banking.** More statement formats (bank CSV variants, Excel, MT940, PDF-table import),
  match rules that learn from confirmed matches, bulk reconcile, cheque printing with layouts,
  post-dated cheque register, bulk payment file export.
- **WP 4.2 Receivables.** Party statements (PDF/email-ready), reminder letters by ageing bucket,
  interest on overdue bills (simple, per-party rates, posts a debit note), credit hold on entry,
  follow-up notes and promised dates per bill.
- **WP 4.3 Payables.** Payment planning by due date, MSME 45-day tracking and report, batch
  payment vouchers.
- **WP 4.4 Cash and finance.** Cash-flow forecast from open bills and orders, budgets vs actuals
  with variance, loans and EMI schedules with interest split, forex revaluation journals.

## Phase 5 — AI agent (0.9.0)

### Architecture (fixed before any feature WP)
- All AI code lives in `src/main/ai/`. The renderer talks to it over typed IPC with streamed
  events. No network from the renderer.
- Provider: OpenAI SDK (dependency added here). Default model `gpt-6.1-sol`, fast model
  `gpt-6-luna`, both configurable in Settings. Exact API model ids and capabilities (tool calling,
  vision, structured output) are confirmed against the provider's model list at phase start.
- Key stored through `services/secrets.ts` (WP 1.5). AI is off until a key is entered and the
  user accepts a plain-language data notice.
- **Tool registry:** each tool has a name, Zod input schema, minimum role and a handler that calls
  existing services. Tools are *read* (reports, ledgers, vouchers, stock, GST, TDS, search) or
  *draft*. **No tool writes to the books.** Draft tools create rows in `ai_drafts`; the user opens
  a draft in the normal voucher editor and saves through `saveVoucher` with all its validation.
- **Numbers rule:** the model never computes money. Figures in answers are rendered from tool
  results and carry a link to the report or vouchers behind them.
- **Untrusted text:** bill contents, narrations and imported text are passed as data, never as
  instructions; nothing they say can trigger a tool beyond drafting.
- Tables: `ai_threads`, `ai_messages`, `ai_drafts`, `ai_memory`, `ai_usage`, `ai_outbound_log`.
- Privacy: outbound log viewable in Settings, optional masking of GSTIN/PAN/bank numbers, optional
  pseudonymised party names mapped back locally, per-company off switch.

### Work packages
- **WP 5.1** Core: provider client, tool registry, streaming, settings, usage/cost meter, mocked
  provider for tests.
- **WP 5.2** Chat panel (docked drawer on every screen, knows the current screen and period),
  "Explain this" on any figure, AI answers inside the command palette.
- **WP 5.3** Voucher drafting from plain language, with the draft review flow.
- **WP 5.4** Document capture: bill photo/PDF → purchase draft (party match, HSN, GST split,
  duplicate check); bank statement → categorised drafts; batch inbox.
- **WP 5.5** Assistants: month-end close checklist, GST 2B mismatch resolution, anomaly and
  duplicate detection, natural-language report building on the table platform.
- **WP 5.6** Per-company memory (preferred ledgers, narration style, recurring parties), editable
  by the user.
- **WP 5.7** MCP server (`total-cli mcp`, stdio) exposing the same tool registry under the same
  read/draft rule; supersedes the file-based agent bridge inbox.
- **WP 5.8** Evaluation suite: a fixture company with known answers; scored on answer accuracy,
  correct tool choice, draft validity and refusal to act on injected instructions. Mocked-provider
  tests run in normal CI; live-model evals run in a separate, manually triggered workflow using a
  repository secret.

## Phase 6 — Reports, analytics and data (0.10.0)

- **WP 6.1** Report builder: choose dimensions (ledger, group, party, item, cost centre, month),
  measures and filters; save, pin to sidebar, export.
- **WP 6.2** Comparatives (period vs period, year vs year), ratio analysis, trend charts,
  scheduled PDF/CSV packs written to a folder.
- **WP 6.3** Excel import/export for masters and vouchers with a mapping-and-preview wizard;
  importers for Busy and Zoho Books exports alongside Tally.
- **WP 6.4** Bulk edit of vouchers and masters with preview and undo (through audit), attachments
  on vouchers and masters (stored in the company folder, included in backups), notes and tasks.
- **WP 6.5** Consolidation with inter-company elimination and group reporting.

## Phase 7 — Platform, hardening and production (1.0.0)

- **WP 7.1** Performance: seeded 100k- and 500k-voucher companies; budgets for launch, each
  report, save and search; index and query work to meet them; a perf check in CI.
- **WP 7.2** Security: company database encryption at rest (design choice — SQLCipher build vs
  file-level — made at phase start with a spike), encrypted scheduled backups with automatic
  restore verification, finer-grained roles, session lock.
- **WP 7.3** Windows parity: every feature verified on Windows; unit, DB and smoke tests in the
  Windows CI job.
- **WP 7.4** Test completeness: an e2e scenario for every feature added in phases 1–6; flake
  budget of zero on three consecutive runs.
- **WP 7.5** Site and docs: feature pages, AI and privacy page (replaces the unconditional
  "fully offline" claim), migration guides, in-app help, changelog.
- **WP 7.6** 1.0.0 release and watch: release workflow, published assets, `/api/latest`,
  `/api/download`, Vercel deploy, in-app update from 0.4.0 and from each intermediate version.

---

## Risks and things only you can supply

| Item | Effect if missing |
|---|---|
| NIC sandbox credentials | e-invoice/e-way stays experimental (WP 3.5) |
| OpenAI API key as a CI secret | live AI evals cannot run; only mocked tests gate releases |
| Apple Developer ID | builds stay unsigned; updates keep using the site fallback |
| Access to a real company file | "Local Sale missing" root cause stays inferred, not confirmed |
| Confirmation of tax rules | Phase 3 figures are sourced and cited but should be checked by a CA before 1.0 |

Known hard parts: the global valuation pass (WP 2.1) must not change any existing company's stock
value; challan/GRN line-linking (WP 2.5); year-boundary treatment (WP 1.3) must agree with trial
balance in both year-end states; database encryption with better-sqlite3 under Electron (WP 7.2).
