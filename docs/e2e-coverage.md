# E2E coverage matrix (WP 7.4)

Every work package of the revamp roadmap (`docs/superpowers/specs/2026-10-07-total-revamp-roadmap.md`,
Phases 1–7) and of the simple-for-everyone plan (`2026-10-13-simple-for-everyone-plan.md`, Phases 8–10)
mapped to the UI E2E scenarios in `scripts/e2e/` that exercise it in the BUILT app. "Gap filled" marks
the scenarios WP 7.4 added. Unit / DB tests are listed only where a WP has no UI to drive.

Run them: `npm run build && npm run e2e` (filter: `node scripts/run-e2e.mjs 66 67`, three runs in a
row: `node scripts/run-e2e.mjs --repeat 3`, a CI shard: `--shard 2/3`).

## Phase 1 — Foundation and UI/UX revamp

| WP | Feature | Scenario(s) | Notes |
| --- | --- | --- | --- |
| 1.1 | Collapsible navigation, sections persisted, ←/→ on headings | 02, 11 | |
| 1.2 | Masters chart of accounts tree, ledger filter by group / GSTIN | 66 (gap filled), 01, 15 | |
| 1.3 | Year-opening: income/expense reset, ledger statement = TB across the boundary | 67 (gap filled), 08 | |
| 1.4 | One editor per voucher kind, load → save round trip | 03, 17, 68 (gap filled: physical stock) | DB: `voucherEdit.dbtest.ts` |
| 1.5 | Secrets out of the DB, NIC credentials masked | 13 | |
| 1.6 | Table platform: sort, filters, column chooser, saved views, CSV export | 66 (gap filled), 11 | |
| 1.7 | Every list on the table platform | 02 (tour), 11, 12 (sweep), 66 | |
| 1.8 | Drill-down: name = edit, row = statement, ⌘E | 15 | |
| 1.9 | Search: palette, results screen, prefixes, recents | 14 | |
| 1.10 | Design system, dashboard, options panels, print templates, a11y | 12, 16, 18 | |

## Phase 2 — Inventory, manufacturing, trade cycle

| WP | Feature | Scenario(s) | Notes |
| --- | --- | --- | --- |
| 2.1 | Global valuation pass, conserved manufacture cost | 17, 21 | unit: `valuation.test.ts` |
| 2.2 | Manufacture voucher | 17 | |
| 2.3 | Movement register, stock journal / godown transfer, serials, reorder | 19 | |
| 2.3 | Valuation method per item (FIFO), stock ageing, negative stock, barcode labels, physical stock | 68 (gap filled) | |
| 2.4 | Multi-level BOM, versions, scrap, job work, manufacturing reports | 21 | |
| 2.5 | Quotation / SO / PO, challans / GRNs, returns, linked docs, trade reports | 24, 26, 28 | |
| 2.5b lists | Challans / GRNs lists, convert two challans of one party to one invoice | 24 | renderer: `tradeNoteList.test.tsx`; db: `tradeLists.dbtest.ts`, `tradeConvert.dbtest.ts` |
| 2.6 | Price levels, schemes, counter billing | 29 | |

## Phase 3 — Compliance

| WP | Feature | Scenario(s) | Notes |
| --- | --- | --- | --- |
| 3.1 | TDS core: tagged payable ledgers, suggestion in the invoice form | 03, 20 | |
| 3.2 | TDS screen: eligible → move, deducted, challans, returns | 20 | |
| 3.3 | TCS | 23 | |
| 3.4 | GSTR-9, ITC-04, 2B matching / IMS, RCM self-invoices, ITC reversal | 25, 44 | |
| 3.5 | NIC: connection test against the fake sandbox; e-way JSON | 06, 13 | |
| 3.5 | E-invoice JSON export | 70 (gap filled) | live IRN: see 70's header |
| 3.5 | NIC follow-ups: signed invoice / QR stored and saved, Cancel IRN, cancel e-way bill + history, correction workflow (`irn_frozen` / `irn_live`) | 70 | against the fake sandbox; Extend validity only says when its ±8 h window opens (the fake's clock can't reach it) — the extension itself is in `nicContract.dbtest` / `einvoiceDetails.test` |
| 3.6 | Fixed assets | 22 | |
| 3.7 | Payroll + statutory (PF / ESI / PT / salary TDS / Form 16) | 07, 27 | |
| 3.8 | Audit trail / edit log, chain verification | 30 | |
| — | GSTR-1 / 3B | 06, 46 | |
| — | Year-end close, closing journal immutable, lock date, reopen through the bin | 08, 67 (gap filled) | |
| — | Guided re-close of earlier closes (0.4.0 residual): Check earlier closes → Repair | 67 (step 8) | the residual is made with a stored P&L opening the close never carried — a real 0.4.0 journal (flag set by migration 018) can't be posted over IPC; `yearEndRepair.dbtest.ts` hand-builds one |

## Phase 4 — Banking, receivables, cash

| WP | Feature | Scenario(s) | Notes |
| --- | --- | --- | --- |
| 4.1 | CSV import + BRS | 05 | |
| 4.1 | Column mapping, learned rules, cheque books / printing, register backfill, bulk NEFT file | 31 | |
| 4.1 | MT940 / Excel / CAMT.053 statements, re-import dedupe, post-dated cheques (mature / bounce) | 72 (gap filled) | parsers: `bankFormats.test.ts` |
| 4.2 | Statements, reminders, interest notes, credit hold, follow-ups | 32 | |
| 4.3 | Payment plan, MSME s.15 / s.16, payment runs, Form 1 | 33 | |
| 4.4 | Cash-flow forecast, loans + EMI, forex revaluation, budgets vs actuals | 34 | |
| — | Cost centres, cash flow statement, exceptions, CA pack | 69 (gap filled) | |

## Phase 5 — AI agent

| WP | Feature | Scenario(s) | Notes |
| --- | --- | --- | --- |
| 5.1 | Core: settings, notice, key, mock provider, tool chips, drafts | 35 | |
| 5.2 | Chat panel, Explain this | 39 | |
| 5.3 | Voucher drafting + review | 41 | |
| 5.4 | Document capture, statement categorising | 45 | |
| 5.5 | Assistants: close checklist, 2B mismatches, anomalies, report from a question | 44 | |
| 5.6 | Memory | 43 | |
| 5.7 | MCP server (real stdio client) | 42 | |
| 5.8 | Evaluation suite | — | DB: `aiEvals.dbtest.ts` (mocked, 100 %), `npm run ai:evals` |

## Phase 6 — Reports, analytics, data

| WP | Feature | Scenario(s) | Notes |
| --- | --- | --- | --- |
| 6.1 | Report builder: build, save, pin, export | 37 | |
| 6.2 | Ratios, comparatives, scheduled packs | 37 | |
| 6.3 | Books export → import round trip, Zoho mapping | 36 | |
| 6.3 | Busy import + undo | 71 (gap filled) | |
| 6.4 | Bulk edit of vouchers, attachments in backups | 38 | |
| 6.4 | Bulk edit of masters / party notes | 71 (gap filled) | see 71's header |
| 6.5 | Consolidation with eliminations | 40 | |

## Phase 7 — Platform

| WP | Feature | Scenario(s) | Notes |
| --- | --- | --- | --- |
| 7.1 | Performance budgets | — | `*.perf.dbtest.ts` |
| 7.2 | Security: passphrase lock (encryption at rest), backup restore check, capability flags, session lock (⌘L, auto-lock) | 65, 10 | `security.dbtest.ts`, `db/encryption.dbtest.ts`, `db/encryption.perf.dbtest.ts` |
| 7.3 | Windows parity | — | CI `build-win` (unit + DB + build) |
| 7.4 | This matrix, date helpers, `--repeat`, zero-flake runs | all | |
| — | Tally import, backup / restore, roles + lock | 04, 09, 10 | |

## Phases 8–10 — Simple for everyone

| WP | Feature | Scenario(s) |
| --- | --- | --- |
| 8.0 | Registration rule: unregistered / composition bills, effective-dated registration | 46, 70 (gap filled: Company details change) |
| 8.1 | Company mode, simple shell, Accountant view | 47 |
| 8.2 / 10.4 | i18n, Hindi / Hinglish | 64 |
| 8.3 | Setup wizard, presets, features | 48 |
| 8.4 | Plain pickers, quick-create | 50 |
| 8.5 | Field errors, save card, undo | 49 |
| 8.6 | Simple Home | 52 |
| 8.7 | Opening setup | 51 |
| 9.1 | Intents / `simple:post` | 53–59 (through the flows) |
| 9.2 | Make a bill | 53 |
| 9.3 | Record a purchase | 54 |
| 9.4 | Money in / out / move | 55 |
| 9.5 | Returns | 56 |
| 9.6 | Bank, simple | 57 |
| 9.7 | Stock and Made goods (+ the recipe editor on a product: add a recipe, then make goods with it) | 58 |
| 9.8 | People | 59 |
| 9.9 | Plain reports and Taxes | 61 |
| 9.10 | Accountant-view hand-off | 62 |
| 10.1 | Ask Total | 60 |
| 10.2 | "Why?" sentences | 52, 61 |
| 10.3 | Tour, empty states, help panel | 52, 63 |
| 10.5 | Keyboard / a11y / window size, simple shell | 73 (was 12), 63 |
| 10.6 | AI panel in plain words | 35 | the escalated plain drawer (`ai-panel-plain`) gets the a11y sweep + layout check in both themes, with the "what is sent" strip and "Answered by the AI service" asserted |
| 10.8 | Beginner journey | 60 (extended by WP 10.8) |

## Remaining gaps (deferred)

- Live NIC IRN / e-way generation against the real sandbox (no credentials; the fake NIC covers the
  connection test only).
- Price-list editor UI and party-wise rates are set up over IPC in 29 (the counter flow is UI).
- TDS lower-deduction certificates (DB-tested in `withholding` dbtests, no UI scenario).

## App bugs the new scenarios found

Fixed in this PR: **MT940 / CAMT.053 statements could not be imported** (Banking → Import kept
"Apply the mapping first" for any statement without a column mapping) — e2e 72 tests the fixed path.

Fixed in PR #107 (`fix/year-end-ui-bugs`, merged while this WP ran). The scenarios were written
with workarounds; the review switched them to assert the fixed behaviour where that was cheap:

| Bug | Scenario | Now |
| --- | --- | --- |
| Settings → Period lock is not editable in a company without users | 67 | runs in a company with no users and changes / removes the lock from Settings → About (the lock-screen sign-in stays covered by the other scenarios) |
| The closing journal's Delete is disabled in its editor (inside the read-only fieldset) | 67 | bins it from the banner's Move to Bin; asserts the lock moves back to the day before the FY |
| The editor's pre-save duplicate-number check ignores the financial year | 67 | re-saves last year's No. 1 (the same number as this year's April payment) |
| Stock ageing uses the period END as its as-on date | 68 | the working period stays the whole FY; ageing is as on today |
| Cost-centre report's Net Dr / Cr label is inverted | 69 | asserts a loss reads Dr |
| Import undo leaves the openings unequal (kept masters keep imported openings) | 71 | asserts the kept masters' openings are cleared and the openings tie |

## Date robustness

The app's "today" is the machine's LOCAL date. Scenarios take theirs from `localToday()` /
`fixedToday` / `relativeDate(n)` in `scripts/lib/harness.mjs` (never `toISOString()`, which is the
UTC date), and never clamp a relative date to the financial-year start: a scenario that needs a bill
N days old starts the books early enough (`h.pickSetupStart(N)` in the setup wizard,
`booksStartCovering(N)`; the full company form takes `createCompanyUI(name, { coverDaysBack: N })`,
an already open company `h.coverDaysBack(N)`; `TOTAL_E2E_EARLY_BOOKS=1` forces that branch for a
check on any day). CI runs the e2e job with `TZ=Asia/Kolkata`.

To run a scenario as if on another day, set `TOTAL_E2E_TODAY=YYYY-MM-DD`: the app's clock (main and
renderer, `src/shared/e2eClock.ts` — honoured only with `TOTAL_DATA_DIR` in an unpackaged build)
and the harness's `localToday()` move to that day, and the harness checks both processes see it
before the scenario starts. SQLite's own `'now'` (column defaults such as `vouchers.created_at`,
`datetime('now')` in updates) follows it on every connection `openDb` opens, and file times compared
with today (backup age, stale locks, sweeps) go through `fileTimeMs`, so nothing is half-shifted. A
scenario must not end with unsaved answers on screen (it fails; `{ allowUnsavedOnClose: true }` if
it means to). E.g. `TOTAL_E2E_TODAY=2027-04-05 node scripts/run-e2e.mjs 32 33 57 59`
(1 April – mid May is where a relative bill used to fall into the previous financial year).

## "The app did not close within 20 s — killing it"

This harness line (`Harness.close`, after #128) is not a scenario problem and not specific to one
scenario — it has been seen after 48, 58, 59, 62, 69, 70 and 71, always in runs where the machine
was saturated (other agents' builds and tests; the scenarios themselves ran 3–4× their usual time).
Traced in the #148 review by reproducing it with a bare launch → demo company → close loop under
16 CPU-bound processes on the 8-core laptop, with `before-quit` / `will-quit` / `quit` / `exit`
listeners and a `sample` of the main process 6 s into the close:

- the app's own quit path finishes in ~150 ms every time, hung or not — `before-quit` (the quit
  backup, `closeCurrentCompany`) → window closed → `will-quit` → `process.on('exit')`;
- the main process then stays up inside Electron / Chromium's native teardown: its main thread is
  blocked in `mach_msg` (the browser shutdown waiting on another process), in `v8::Isolate::Dispose`,
  or in `exit()`'s static destructors messaging a system daemon (PowerLog) — no app code, no SQLite
  frame on any thread;
- it happens just as often with no backup check (or any worker) running at quit, so it is not the
  restore check / quick_check worker or `simple:homeAttention`.

On an idle machine the same loop closes in 0.2–0.8 s (59 alone: 0.3–0.7 s, three runs). The 20 s
kill only bounds the wait; the scenario's result line is already decided, so nothing is lost. If the
line shows up on an idle machine, sample the main process (`sample <pid> 2`) while the harness waits.
