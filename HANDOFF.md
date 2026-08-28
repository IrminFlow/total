# Total PR #2 — handoff

Use this file to continue the project in another chat without relying on the old transcript.

**Last updated:** 26 August 2026  
**Repository:** private GitHub repo `IrminFlow/total`  
**Working directory:** `/Users/irmin/.t3/worktrees/total-t/t3code-fae681b6`  
**Branch:** `t3code/revamp-ledgers-shortcuts`  
**Base branch:** `main`  
**Pull request:** [#2 — Build out the roadmap: 382 of 392 settled](https://github.com/IrminFlow/total/pull/2)  
**Current HEAD:** `5c1e8cb` — `ci: fix two Windows-only failures, and let the E2E suite run before a merge`  
**Commits ahead of main:** 173

---

## 1. Read these files first

In order:

1. `CLAUDE.md` — project architecture, commands, invariants, release process and known gotchas.
2. `HUMAN.md` — everything only the owner can do: certificates, prices, payment setup, support sinks, testimonials, real hardware and NIC credentials.
3. `docs/roadmap.md` — 392 numbered items with detailed ✓ / ✗ / ⏳ reasoning.
4. `docs/plan.md` — why this branch exists and the decisions behind its UI and feature work. Some historical sections describe the work while it was in progress; prefer the exact status below when they disagree.
5. `docs/chrome-spec.md` — the UI consistency contract that the chrome pass implemented.
6. `docs/contributing.md` — codebase invariants and test expectations.
7. `docs/performance.md` — the measured large-book results and later corrections.
8. `site/OPERATOR.md` — marketing-site production configuration.

Do not start by reading the previous chat transcript. The repository and this document are the source of truth.

---

## 2. Product and architecture

Total is a fully offline accounting app for macOS and Windows:

- Electron + React + TypeScript + SQLite (`better-sqlite3`).
- Tally-style double-entry bookkeeping with Indian GST, invoicing, inventory, manufacturing, banking, payroll, TDS, multi-currency and audit controls.
- No cloud account and no hosted database. User data stays under `~/Documents/total/` by default.
- The marketing site is a separate Next.js app under `site/`, deployed on Vercel with the Vercel Root Directory set to `site`.

Important layout:

```text
src/shared/      pure TypeScript engines and most unit tests
src/main/        Electron main, SQLite, migrations, services and IPC
src/preload/     contextBridge API
src/renderer/    React/Tailwind desktop UI
scripts/e2e/     Playwright Electron scenarios against the built app
site/            Next.js marketing site
```

---

## 3. Non-negotiable invariants

These rules are not preferences. Several now have tests that fail when violated.

### Accounting

- Money is integer paise everywhere.
- Quantities are integer thousandths (`qtyMilli`).
- Floats never touch monetary amounts.
- Voucher lines and opening balances are the source of truth. Do not denormalise ledger balances.
- Signed balances are debit-positive.
- Every report is derived from the books at query time.

### Database

- `better-sqlite3` is main-process only.
- `src/shared/` must never import Electron or the database.
- `npm test` must never import `better-sqlite3`; it is built for Electron's ABI, not system Node.
- Migrations are append-only and run **by array position**. `migrate.ts` stores the highest numeric index and resumes from there. Never insert, edit, reorder or renumber an existing migration.
- After adding a migration, regenerate the order pin:

```bash
MIGRATION_HASHES_WRITE=1 npm run test:db -- migrations
```

- Add new tables to `EXPECTED_TABLES` in the migration tests.
- A test that needs the DB “before migration X” must use `migrationIndexOf('CREATE TABLE …')` from `src/main/db/testdb.ts`; never `MIGRATIONS.length - N`, because another branch appending migrations silently moves that cut.
- Every SQL query touching `vouchers` or `voucher_lines` filters deleted vouchers literally in the SQL string. Use `NOT_DELETED` or `IN_BOOKS` as appropriate. `src/main/notDeleted.test.ts` enforces this.
- A deliberately unscoped by-id query goes in that test's `ALLOWED` list with a concrete written reason. Do not add exceptions merely to make the test pass.
- Raw SQL only belongs in `src/main/services` and `src/main/db`; `src/main/dbBoundaries.test.ts` enforces this.

### IPC

- Every IPC payload is parsed with Zod in `src/main/ipc.ts`.
- Handlers return `{ ok, data | error }`.
- The renderer talks to main only through `src/renderer/src/lib/client.ts`.
- `src/main/channels.test.ts` checks that every client and E2E channel has a handler, no channel is registered twice, and names follow `scope:action`.

### React Query

- New query-key families go in the owning screen's `invalidates` list in `src/renderer/src/lib/screens.ts`.
- The default `staleTime` is five seconds. Missing invalidation can serve stale data for five seconds and has caused real E2E failures.
- Query caches are cleared when changing companies. A prior bug let one sample company's feature flags hide screens in the next company.

### UI

- Theme values are `--t-*` CSS variables, exposed through Tailwind v4 `@theme inline` tokens.
- The signature accent is indigo: `accent`, `accentbar`, `onaccent`. The old amber aliases were removed.
- No raw Tailwind palette colours, no raw hexadecimal colours in components, and no new radius scale.
- Containers use `rounded-md`; pills use `rounded-full`.
- The selected `.kbar-row` on a `<tr>` uses an inset box shadow. Never use `tr::before`; it renders as a phantom first cell.
- Anything available with a mouse must be available from the keyboard. Use `RowAction` / `.row-action`; do not hand-roll hover-only fades.
- Numerals remain tabular, Indian-grouped and right aligned.
- Every screen in the registry must be rendered in `App.tsx`; `screensRendered.test.ts` enforces this.
- E2E scenario numbers must be unique and their `scenario('NN-name', …)` IDs must match their filenames; `src/main/e2eScenarios.test.ts` enforces this.

### AI security model

Do not weaken this:

- AI is off by default and checked in main as well as the renderer.
- The API key never reaches the renderer or the company data directory.
- The key is machine-level and protected by the OS keychain/safe storage; no plaintext fallback.
- GSTIN, PAN, bank account, IFSC, email, phone and all payroll details are always redacted from tool results. There is no toggle.
- There is no voucher-write tool. The AI can propose a draft; a human saves it through the ordinary voucher form.
- Tests grep `src/main/services/ai/**` for SQL and voucher mutations.
- Prompt-injection hardening treats every tool result as data, never instructions. A real adversarial DB test verifies both that injected text is quarantined and that an attempted write remains draft-only.
- All aggregates are computed in TypeScript. The model does not calculate money.
- The OpenAI SDK must remain outside the startup import graph. `ai-boundaries.test.ts` walks static imports from the main entry points.
- Zod must remain out of the renderer bundle. `noZod.test.ts` walks the renderer's value-import graph.

---

## 4. Exact roadmap status

The current roadmap contains 392 numbered items:

- **365 built** (`✓`).
- **20 declined** (`✗`) with a detailed reason on each line.
- **1 blocked** (`⏳`) in the roadmap.
- **6 open**, all requiring human/external work rather than implementation.

Open items:

1. **#107 — NIC sandbox validation.** The client is built to the published API but has never used real credentials or the NIC sandbox.
2. **#307 — named beta testimonials.** The component exists; no quote is invented without a real person's permission.
3. **#308 — 90-second GSTR-1 recording.** The `/demo` slot and shot list exist; a human must record it.
4. **#341 — Apple Developer ID enrolment and secrets.** Engineering is wired; enrolment/certificate procurement remains.
5. **#342 — Windows signing certificate or Azure Trusted Signing.** Engineering is wired; organisation vetting remains.
6. **#347 — test at 1366×768 and 125% scaling on a real inexpensive Windows laptop.** CI cannot substitute for this physical check.

Everything the owner must set up is documented in `HUMAN.md` with exact variable and secret names.

---

## 5. Major work implemented in this PR

The branch began as a roadmap build-out and became a full release branch. It changes roughly 800 files and contains over 170 commits.

### Keyboard and data entry

- One accelerator registry drives sidebar, Gateway, palette and shortcut help.
- Global red-letter navigation and per-screen accelerators.
- Layered keyboard dispatch for palette, modal, list, screen and navigation scopes.
- Tally-style F4–F9 voucher switching.
- Enter-chaining through voucher forms.
- Arrow/Home/End/Enter list navigation across screens.
- Inline accept bar and unsaved-change protections.
- Voucher templates without invented recurrence schedules.
- Bulk edit, percentage splits with largest-remainder allocation, quantity expressions, barcode-to-quantity flow, ledger creation with undo, crash-safe local voucher drafts, and a scratchpad ledger.
- A computed focus-ring audit walks every real control, compares resting vs focused state, composites translucent backgrounds, and checks 3:1 contrast.

### Reports and analysis

- Expanded trial balance, P&L, balance sheet, day book, ledger statement and registers.
- Quarterly/half-year/year period groupings using Indian FY quarters.
- Cost centres, budgets and variance.
- Consolidated multi-company reports.
- Exceptions and unusual-balance views.
- Cash-flow forecast.
- Receivables/payables ageing, promises, credit scores, bad-debt tracking and collections desk.
- Party-centric Khata screen.
- Ratio analysis, vertical/common-size comparisons and previous-period views.
- Schedule III balance sheet and P&L presentation.
- Report views/schedules and large export support.

### GST and statutory

- QRMP due dates, PMT-06/IFF support and filing-season flow.
- Composition dealer support: CMP-08 and GSTR-4. The old validator incorrectly rejected composition businesses.
- GSTR-1, GSTR-1A, GSTR-3B, GSTR-9 and 2B reconciliation improvements.
- IMS actions.
- Return snapshots and amendment tables.
- Multi-GSTIN registrations in one book.
- GST registration stored on the voucher so tax does not change when the primary registration changes.
- GST returns, filings, 2B reconciliation, e-invoice/e-way and print documents scoped per GSTIN.
- Branch transfers between registrations of one PAN, with Rule 28 valuation and corresponding output/input tax treatment.
- ISD allocation and GSTR-6 working.
- Reverse-charge self-invoice.
- LUT tracking and expiry.
- E-invoice reporting deadline countdown.
- Effective-dated item GST rates and cess with notification citations.
- ITC-04 and the section 143 job-work clock.
- PIN-distance suggestions that are offered, never silently written.
- Section 197 certificates and 26AS reconciliation.
- TDS challans, 24Q/26Q working, Form 16A, Form 3CD pack and dated Income-tax Act 2025 mappings.
- Related-party report and Rule 3(1) audit-trail statement.

A primary-source verification pass found four serious errors and corrected them:

- 28% GST had not been withdrawn; the notification retained Schedule VII for tobacco/pan masala.
- 1.5% GST was missing.
- The e-TDS record layout was wrong in every record: field counts, ordering, CRLF and Annexure section codes.
- Income-tax Act 2025 mappings were overly broad (`393`) rather than the actual section/table entries.
- The GSTR-1A authority was mis-cited: the window is the proviso to rule 59(1), while 59(4A) governs contents.

The app now blocks current-year 24Q/26Q export because those forms stop at FY 2025-26 and the replacement Form 138/140 file formats are not yet supported. A portal-rejected file is worse than no file.

### Invoicing and documents

- Classic, Modern and Compact invoice templates over one content skeleton.
- 58/80 mm thermal receipt.
- Hindi and Marathi bilingual labels alongside English.
- Amount in words in the chosen language.
- Live invoice preview.
- Multi-page invoices with carried-forward totals.
- Invoice-level discounts apportioned with largest remainder.
- WhatsApp share flow; the UI correctly states that the user must paste the PDF because a `wa.me` link cannot carry a file.
- Sales quotation → order → challan → invoice chain.
- Purchase order → receipt note → purchase invoice chain.
- Per-line fulfilment, partial receipt, over-delivery and three-way matching.
- Company-defined voucher custom fields, with retired definitions preserving values on old documents.
- Batch PDF/export support and dot-matrix printing.

### Inventory and manufacturing

- Batches and expiry.
- Alternative units, conversion and quantity parsing.
- Multiple valuation methods.
- Godown transfers.
- Reorder levels and recommendations.
- Landed-cost allocation.
- Scrap/yield and nested subassemblies.
- Barcode label printing.
- Serial-number tracking.
- Effective-dated price-list versions.
- Standard costing and price/usage variance.
- Item images stored as files, not blobs in SQLite.
- Job-work goods move to a job-worker godown through a stock journal with no ledger lines; company-wide stock quantity/value remains unchanged.
- Waste under section 143(5) leaves the job-worker godown without re-entering stock.

### Banking

- Real Indian bank CSV profiles and signed debit/credit handling.
- Fixed a parser bug where `Math.abs` turned a negative withdrawal reversal into another withdrawal.
- Rule-based and learned narration suggestions.
- Bank charges/interest classification by whole word, avoiding `CHARGE` matching `RECHARGE`.
- UPI/UTR matching before fuzzy amount/date matching.
- Many-to-one and tolerance match suggestions with visible working.
- Reconciliation freeze per account, enforced on both sides of a move and on delete/restore.
- PDC calendar.
- Bounced-cheque reversal, bill re-opening, original due-date preservation and a bounce register.
- Multi-currency bank accounts with effective rates, persisted foreign amount/rate and period-end revaluation journals.
- Cash forecast and drawing-power/stock-statement support.

### Payroll, assets and borrowing

- Dated PF, ESI, EPS and EDLI rates.
- Attendance, loans/advances and payroll desk.
- Weekly and fortnightly pay cycles while statutory contributions are aggregated and true-d up at the monthly level.
- Gratuity and full-and-final settlement with visible working.
- Income-tax regime/slab handling and Form 16.
- Fixed-asset register, capital work in progress and disposal.
- Companies Act depreciation per asset and Income-tax WDV by block.
- Loan register with EMI principal/interest split and schedule.
- Deposits, prepaid/accrued schedules, bank stock statement and drawing power.
- CMA forms I–VI and ratios, with audited `books` cells distinct from `typed` projections and missing history shown as missing rather than zero.

### AI and agent access

- Bring-your-own OpenAI-compatible endpoint/key.
- Local Ollama and LM Studio presets.
- Ask-your-books drawer, deterministic command-palette ask bar and cited source rows.
- Natural-language voucher proposals as human-confirmed drafts.
- GST anomaly explanations, close checklist and anomaly watch.
- Spend caps enforced in main.
- Exact-payload viewer and redaction preview.
- Esc cancellation of streaming answers.
- Assistant audit trail from question → draft → posted voucher.
- Prompt-injection quarantine.
- MCP resources for chart of accounts, voucher schema and changelog.
- MCP writes require both the command-line switch and in-app Agent access, plus a write rate limit.
- AI SDK lazy-loaded and kept out of the main startup graph.

Two AI ideas were deliberately declined:

- Bill-photo extraction because sensitive GSTIN/PAN/bank data is pixels and cannot be reliably redacted before vision-model egress.
- A bank AI re-ranker because deterministic candidates already carry explanations and sending remittance text would expose names, UTRs and account fragments for little value.

### Security, audit and reliability

- NIC credentials moved to safe storage/keychain with no plaintext fallback.
- AI key has the same no-plaintext rule and never enters company backups.
- Encrypted portable backups and restore validation.
- External backup schedule and recovery checks.
- Move data-root safely with copy + verification before switching.
- Duplicate-company detection on restore.
- Vouchers are soft-deleted to a bin and can be restored.
- Hash-chained audit trail.
- Fine-grained deny-only permissions over role ceilings.
- Time-limited read-only auditor sessions.
- Approval limits and two-person flows.
- Bank-detail change approvals.
- Attachments stored outside SQLite with indexed metadata.
- Data archive/read-only controls.
- Offline Ed25519 licence validation. Expiry never locks the user's books; it leaves read/export available forever.
- Error ring buffer and in-app support form with exact pre-send diagnostics preview.
- First-run test from a nonexistent data path.
- Uninstall/reinstall test proving the books survive removal of app-owned user data.

### Interface and UX

- App, site and icon recoloured from amber to indigo.
- Dark theme redesigned around neutral grey rather than navy/muddy amber.
- Seven-step typography scale.
- One toolbar grammar.
- Export formats grouped into a bordered segmented control in PDF → CSV → XLS order.
- Ghost buttons reduced from 142 to 55; remaining ones are actual toolbar toggles.
- One compact table density.
- `RowAction` / `RowLink` grammar across tables.
- Consistent page framing and left alignment.
- Autohiding/thin scrollbars.
- Accessible custom checkbox/radio rendering in both themes.
- Red limited to genuine money/compliance errors rather than whole rows and neutral counters.
- Simplified voucher footer hints.
- Visual regression over every screen in both themes plus an exact theme-token snapshot.

### Marketing site

- Real app screenshots regenerated after the indigo redesign.
- Honest pricing configuration through environment variables; no invented hard-coded prices.
- `/pricing` and `/buy` show “Not yet announced” until a valid whole-rupee amount is configured.
- Checkout refuses an unpriced plan instead of creating a zero-rupee order.
- Razorpay/UPI-first payment flow and optional hosted payment link.
- “An expired licence never locks your books” promoted to a major pricing statement.
- Contact form using the same `/api/feedback` endpoint as the app.
- Honest testimonials/video placeholders; no fabricated customers or logo wall.
- Privacy page lists both app and site network calls.
- Motion added with no-JS, reduced-motion and print-safe behaviour.
- `HUMAN.md` and `site/OPERATOR.md` now name the exact environment variables the code reads.

### Performance and scale

- Keyset pagination for Day Book, ledger statement and e-document lists.
- Long-list virtualisation.
- Day Book measured roughly 373 ms → 46 ms warm.
- E-document list measured roughly 11,252 ms → 1,310 ms warm on an 85,840-voucher book.
- Screen code splitting reduced the renderer entry chunk by roughly 45% at the point it landed.
- Prepared-statement reuse reduced SQL compilation in `saveVoucher` from approximately 25 statements per save to 3–5.
- Zod removed from the renderer value-import graph: entry chunk 1,453 KB → 1,320 KB after the Zod 4 upgrade.
- Streaming CSV export and larger report-PDF support.
- Query-time, startup, memory and bundle budgets.
- A reusable large-book fixture and paired A/B performance runner.
- An 85,840-voucher real-app sweep documented in `docs/performance.md`.
- Four candidate indexes measured and rejected because none improved results outside noise.
- Several caching/recompute/batching/worker ideas measured and declined because their correctness/complexity cost exceeded the time saved.

### Developer experience and test infrastructure

- `docs/contributing.md` records the invariants.
- Migration content/order hash pin.
- SQL-boundary test.
- Soft-delete SQL-scope test.
- IPC channel cross-check.
- Screen registry ↔ `App.tsx` cross-check.
- E2E scenario number/name uniqueness test.
- AI mutation/write-boundary tests.
- Zod-out-of-renderer import-graph test.
- Renderer coverage report and floor.
- Visual-regression signature harness for every screen in both themes.
- Exact palette snapshot test.
- Money/GST mutation-testing harness with crash-recovery journal.
- Dependency freshness report in CI.
- Query-plan and query-budget tests.
- Release script that verifies the GitHub release exists, is not draft/prerelease and contains required assets.
- Windows smoke/E2E jobs and manual branch workflow trigger.

---

## 6. Deliberately declined work

There are 20 `✗` roadmap items. Read the full reasoning on each line before reopening one. They were reviewed after the main build-out; only ISD's reason had expired, and ISD then shipped.

Important examples:

- Type-to-filter on bare letters conflicts with the app-wide red-letter navigation model; `⌘F` exists.
- Per-user remappable shortcuts would fragment the vocabulary across office machines.
- PDF bank-statement extraction is declined because PDFs contain positioned glyphs rather than a table; a guessed column map can silently put money under the wrong heading.
- Emailing an attachment directly would require SMTP credentials the app deliberately does not hold.
- Bill-photo AI cannot uphold the redaction promise.
- SQLCipher database encryption adds key-loss risk while FileVault/BitLocker already address stolen-disk risk; secrets and exports are protected separately.
- Incremental report recomputation/result caching were measured and rejected because current query cost is low and invalidation risk would make balances capable of lying.
- Moving PDF generation off main was measured and found largely already off main; main-loop blocking was small relative to PDF wall time.
- CSV parsing in a renderer worker was rejected because the renderer never parses CSV; main does.
- Imports from Busy/Marg/Vyapar and direct Tally-backup restore remain declined until real files or a published format are available. A parser guessed from memory is unacceptable for multi-year books.

---

## 7. Dependencies and bundle state

Landed:

- `openai` 5 → 7.
- `zod` 3 → 4.

Zod 4 required:

- `.default({})` → `.prefault({})` where nested defaults must still parse.
- A rewrite of the hand-rolled Zod-to-JSON-schema walker.
- Explicit safe-integer min/max bounds for paise so generated schemas retain their published limits.
- New tests pinning AI/MCP tool schema output.

Electron 37 → 44 was attempted and **reverted cleanly**. Do not casually retry it.

- Both API ports were understood: PDF margin options changed; clipboard became async and W3C-style.
- Unit, DB and renderer tests passed on Electron 44.
- The E2E/CDP path wedges deterministically on `goto('edocs') → goto('daybook') → goto('edocs')`; the second synthesised click never returns and both page/app evaluation hang afterwards.
- Passes on Electron 37; fails on 43 and 44, so the regression lies somewhere in 38–43.
- The diagnosis is recorded in `HUMAN.md` and the dependency merge commit.
- Keep Electron 37 / better-sqlite3 12 until the harness issue is solved. Never ship an Electron bump without the full E2E net.

Current approximate bundle status after Zod removal:

- Renderer assets: ~3,023 KB of a 3,200 KB budget.
- Main: ~1,702 KB of a 1,800 KB budget.
- MCP: ~1,252 KB of a 3,000 KB budget.
- Renderer entry chunk: ~1,320 KB of a 1,600 KB budget.

Run `node scripts/bundle-budget.mjs` rather than trusting these copied numbers.

---

## 8. Verification commands

Cheap-to-expensive order:

```bash
npm run typecheck
npm test
npm run test:db
npm run test:renderer
npm run build
node scripts/bundle-budget.mjs
npm run smoke
npm run e2e
npm run visual
```

Or:

```bash
npm run verify
```

Useful variants:

```bash
node scripts/verify.mjs --fast                 # no build/E2E
node scripts/run-e2e.mjs 03 12 52             # filtered scenarios
E2E_SCALE=3 npm run e2e                        # scale wall-clock budgets on a contended machine
TOTAL_QUERY_BUDGET_SCALE=3 npm run test:db -- queryBudget
node scripts/visual-regression.mjs --update    # accept reviewed intended UI drift
node scripts/mutate.mjs --list
node scripts/mutate.mjs --restore              # restore after a hard-killed mutation run
```

Important environment issue: some shells have `ELECTRON_RUN_AS_NODE=1`. That is needed for DB tests but breaks Playwright Electron launch if it leaks. The E2E harness clears it internally, but when diagnosing launch issues run:

```bash
env -u ELECTRON_RUN_AS_NODE npm run e2e
```

If `better-sqlite3` reports a `NODE_MODULE_VERSION` mismatch:

```bash
npx @electron/rebuild -f -w better-sqlite3
```

---

## 9. Current CI and merge status — do not miss this

The branch is pushed and Git reports it **mergeable**, but PR #2 is currently **BLOCKED because CI is red**.

Latest manually-triggered full branch run:

- Run: <https://github.com/IrminFlow/total/actions/runs/32921986284>
- Commit: `5c1e8cb`
- `test`: success.
- `smoke-mac`: success.
- `build-win`: failure.
- `e2e-mac`: failure.
- `e2e-win`: failure.

Known failures from that run:

### Windows DB job

1. `src/main/mcp/mcp.dbtest.ts` — the per-test setup runs every migration and seeds a company. On Windows CI it takes 11–18 seconds and exceeds Vitest's default 10-second hook timeout. A local change has already been committed at HEAD to raise this hook to 60 seconds.
2. `src/main/services/reportsAnalysis.dbtest.ts` — used `/dev/null/not-a-folder` as an impossible path. That is POSIX-specific and becomes an ordinary creatable relative path on Windows. HEAD now uses a directory inside a regular file, which is invalid on every OS.
3. `memoryCeiling.dbtest.ts` — on Windows CI the streaming export reported ~26 MB heap growth against a 12 MB ceiling. This is unresolved. It may be Windows GC/allocator behaviour rather than the export retaining the whole payload. Do not simply raise the ceiling without reproducing or changing the assertion to a platform-independent property. The existing comments already explain why heap deltas are unstable around GC.
4. MCP write-rate-limit test — after the slow setup issue, the final assertion still reported `expected undefined to be true` in the run. Re-run after the hook-timeout fix before assuming it is independent; setup timeouts can leave misleading downstream reports.

### macOS E2E

- `52-branch-transfer` failed: the Branch Transfers tab showed zero invoices after the scenario created one. This passed locally. Needs diagnosis against the CI artefact/log; likely time/date or query invalidation/scope, but do not guess.

### Windows E2E

1. `30-fonts` failed its assertion that IBM Plex Sans itself contains the rupee sign. The app may be using OS font fallback on Windows or Fontsource's `latin` subset may omit `₹`. This is unresolved and is either a packaging bug or an over-strong test. Determine which by checking the shipped woff2 coverage, not by deleting the assertion.
2. `53-isd` timed out clicking “Create & open” on both attempts. The click reached the element and then stalled in/after its action. This may be Windows filesystem/virus-scanner slowness; the harness's `createCompanyUI` currently has a 10-second click timeout and a separate 30-second screen timeout. Diagnose before increasing it.

A manual trigger was added so full E2E can run against a branch before merge:

```bash
gh workflow run ci.yml --ref t3code/revamp-ledgers-shortcuts
```

When CI is fixed, trigger again, wait for all five jobs, then inspect:

```bash
gh run list --branch t3code/revamp-ledgers-shortcuts --limit 3
gh run view <run-id> --json status,conclusion,jobs
gh pr view 2 --json mergeable,mergeStateStatus,statusCheckRollup
```

**Do not merge until this manual run is green**, including Windows E2E.

---

## 10. Current working-tree note

At the time this handoff was written:

```text
branch: t3code/revamp-ledgers-shortcuts
HEAD:   5c1e8cb
status: M .gitignore
```

The modified `.gitignore` was pre-existing local work at the start of the long session and was not intentionally part of the roadmap implementation. Inspect it before deciding whether to commit or revert it; do not discard it blindly.

No source-code modifications should be assumed from the previous chat beyond committed HEAD. Run `git status` at the start of the next session.

---

## 11. Immediate next actions for another agent

Do these in order:

1. Read the files listed in section 1.
2. Run `git status` and verify HEAD/branch.
3. Inspect the `.gitignore` diff; preserve it unless you establish it is disposable.
4. Diagnose/fix the unresolved CI failures in section 9. The two Windows-only fixes at HEAD are already committed; start with `memoryCeiling`, `30-fonts`, `52-branch-transfer`, and `53-isd`.
5. Push fixes and trigger the full manual CI workflow again.
6. Only after all jobs are green, update PR #2's title/body/checklist; it currently says “382 of 392 settled” and is stale. The actual roadmap state is 386 of 392 settled.
7. Run a final high-effort code review. This is a 173-commit release branch; reviewing the whole raw diff as one blob is ineffective. Review the merge commits/dimensions separately: statutory correctness, accounting invariants, migrations, IPC/security, renderer UX, Windows portability, and release/site.
8. Fix verified findings with failing tests first.
9. Re-run the full local verification and full branch CI.
10. Report “ready to merge” only after both local and branch CI evidence is current.

---

## 12. Human/operator setup still required

`HUMAN.md` is authoritative. The high-priority items are:

1. Apple Developer Program enrolment and GitHub secrets:
   - `CSC_LINK`
   - `CSC_KEY_PASSWORD`
   - `APPLE_ID`
   - `APPLE_APP_SPECIFIC_PASSWORD`
   - `APPLE_TEAM_ID`
2. Windows certificate/Trusted Signing and secrets:
   - `WIN_CSC_LINK`
   - `WIN_CSC_KEY_PASSWORD`
3. Prices and payment:
   - `TOTAL_PRICE_ANNUAL_INR`
   - `TOTAL_PRICE_PERPETUAL_INR`
   - optional `TOTAL_PAYMENT_LINK`
   - or full Razorpay keys from `site/OPERATOR.md`
4. At least one feedback sink (`FEEDBACK_GITHUB_TOKEN`, email/webhook alternatives documented in `HUMAN.md` and `site/OPERATOR.md`).
5. Optional `NEXT_PUBLIC_WHATSAPP_NUMBER`.
6. A real testimonial and written permission.
7. A real 90-second GSTR-1 recording and `NEXT_PUBLIC_DEMO_VIDEO_URL`.
8. A physical 1366×768 / 125%-scaling Windows test.
9. NIC sandbox credentials.

Until prices and sinks are configured, the site behaves honestly: it shows “Not yet announced,” refuses zero-price checkout, and the contact form reports failure rather than discarding a message.

---

## 13. What not to redo

- Do not replace SQLite with JSON. The agent JSON bridge and MCP interface already exist; SQLite is the source of truth because atomic double-entry books need it.
- Do not port to Tauri.
- Do not add a write tool to AI.
- Do not add raw PDF bank-table extraction without a reliable, bank-specific, testable source format.
- Do not ship bill-photo vision while claiming sensitive fields are always redacted.
- Do not reintroduce result caching/incremental balances unless new measurements justify the invalidation risk.
- Do not retry Electron 44 without starting from the documented CDP reproducer.
- Do not alter an old migration.
- Do not accept a visual-regression baseline without inspecting every emitted PNG.
- Do not invent prices, testimonials, customers, credentials, statutory section numbers or portal file layouts.
- Do not claim the branch is ready to merge while the full manual CI run is red.

---

## 14. Useful evidence and history

Key documents:

- `docs/roadmap.md` — item-by-item history and rationale.
- `docs/performance.md` — measured 85,840-voucher sweep.
- `docs/chrome-spec.md` — UI consistency decisions.
- `HUMAN.md` — operator actions.
- `site/OPERATOR.md` — production site configuration.

Important recent commits:

```text
5c1e8cb ci: fix two Windows-only failures, and let the E2E suite run before a merge
9c69cad perf(renderer): get zod out of the renderer — entry chunk 1,453 → 1,320 KB
113b3dc docs(human): the Electron debt, and why it was not paid
48430df merge: zod 4 and openai 7 — and Electron 44 reverted with a reproducer
a730667 merge: the chrome pass — one toolbar, one density, one page frame
cb43f21 merge: six statutory flags checked against the notifications — four were wrong
ab71e35 merge: the site can take money, and answer a message
```

The commits are intentionally detailed. For a branch this large, the merge commits are a more useful review index than the 800-file diff.

---

## 15. Definition of “ready to merge”

All of these must be true at the same commit:

- Working tree clean except for deliberately preserved local changes.
- Branch up to date with/predictably mergeable into `main`.
- `npm run typecheck` green.
- `npm test` green.
- `npm run test:db` green.
- `npm run test:renderer` green.
- `npm run build` green.
- Bundle budgets green.
- Smoke green.
- Full macOS E2E green.
- Full Windows build/smoke/E2E green in the manually-triggered branch workflow.
- Visual regression reviewed and green.
- No unresolved high-severity review findings.
- PR title/body/status updated to the current roadmap count.

At handoff time, local evidence is strong, but this definition is **not met** because the full manual CI run is red.

---

# Appendix A — implementation inventory in depth

This appendix expands the high-level inventory above. It is meant for an agent deciding what to
inspect, test or extend, not for marketing copy. A feature named here should be considered
implemented only to the extent described here; when a caveat exists it is stated beside it.

## A.1 Keyboard model and desktop navigation

The branch turns keyboard handling into a system rather than a collection of `keydown` listeners.

### Global destinations

- A single registry in `src/renderer/src/lib/screens.ts` describes every destination.
- The same registry feeds the sidebar, Gateway links, command palette, accelerator badges,
  shortcut help and query invalidation ownership.
- Registry accelerators are unique and guarded by tests. A new screen without an accelerator or
  one that duplicates another fails rather than silently shadowing it.
- Existing Tally-style muscle memory was preserved where it already existed.
- Numeric accelerators and letters that do not occur naturally in labels render as explicit key
  badges rather than as what looks like a data count.
- Global navigation falls through from screen-specific layers. A screen may claim a letter; if it
  does not, the global destination receives it.
- Bare-letter accelerators do not fire while typing in an input, textarea, select or editable
  control.
- `⌘K`/`Ctrl+K` opens the command palette.
- `?` opens shortcut help without leaving a literal question mark in the search box.
- Settings remains available through the platform-native command.
- A panic shortcut locks the app immediately.

### Layered dispatch

The keyboard system models palette, modal, list, screen and navigation scopes explicitly:

- Palette and modal scopes are opaque.
- List and screen scopes are transparent unless they consume a key.
- Escape closes the nearest active layer before it navigates backwards.
- A modal traps focus and returns it when it closes.
- The implementation replaces parallel ad-hoc modal/list stacks that could disagree about which
  layer owned a key.

### Voucher entry

- F4–F9 switch core voucher types and remain the primary path while focus is inside fields.
- Additional voucher kinds have screen-level shortcuts where practical.
- `⌘↵` saves immediately.
- Enter-chaining discovers its field order from the live DOM, skipping controls that are hidden or
  disabled. This supports conditional invoice grids rather than maintaining a second field list
  that drifts from the rendered form.
- Typeahead selection consumes Enter before the field chain, then advances in the same stroke.
- Enter after the final field opens an inline acceptance bar rather than a modal that would break
  the keyboard flow.
- Voucher grids support keyboard movement, line deletion, line repetition and spreadsheet paste.
- A footer bar shows the relevant key vocabulary without duplicating a second paragraph of hints.

### Lists and tables

- A shared table-navigation hook drives active rows, `ArrowUp`/`ArrowDown`, Home, End, Enter and,
  where applicable, Space to fold/expand.
- `rowProps()` supplies the active marker and stable row id so E2E selectors cannot drift from the
  keyboard implementation.
- Quiet row actions reveal on pointer hover, focus-within or active keyboard row.
- Keyboard-only mode removes hover revelation, making visible actions match exactly what a
  keyboard operator can reach.
- A dedicated focus-ring audit walks all real controls and verifies both reachability and visible
  3:1 contrast after compositing translucent backgrounds.

### Native Electron menu

- The app has an explicit native application menu rather than inheriting Electron defaults.
- Native Edit roles remain so Undo/Cut/Copy/Paste continue to work in fields.
- Production removes reload, force-reload and DevTools accelerators.
- Renderer-owned F-keys stay renderer-owned to avoid double-firing inside fields.
- Menu commands cross preload through an explicit event allowlist rather than exposing
  `ipcRenderer`.

## A.2 Core data entry

### Voucher data-entry improvements

- Accounting and invoice entry share parsing/formatting rules rather than accepting arbitrary
  floating-point amounts.
- Quantity expressions are parsed into integer thousandths.
- Percentage splits use largest-remainder allocation so the parts add exactly to the original
  paise total.
- Bulk edits run all-or-nothing.
- Ledger creation is available inline and has an undo path.
- Barcodes can take focus into item/quantity entry without breaking keyboard navigation.
- Narration suggestions are built from voucher facts, not from an LLM.
- Narration memory excludes one-off UTR-like tokens so transaction identifiers are not learned as
  reusable prose.
- Round-off is created and posted through shared money rules.
- A scratchpad ledger under Suspense lets the operator post a balanced voucher when classification
  is genuinely undecided, then reclassify by editing the line. Reclassification honours period
  locks rather than bypassing them with an adjustment journal.

### Crash-safe drafts

- Half-entered vouchers are debounced to Chromium local storage.
- Drafts are scoped by company slug and voucher kind.
- They are machine-local and intentionally absent from company backups, reports and audit trails.
- On next launch the app offers the draft; it never silently overwrites the form with old content.
- Saving or discarding clears the draft.
- E2E verifies the real storage path. A stale DB-backed draft implementation was removed during
  this branch after both versions were found active at once.

### Templates and repetition

- Voucher templates are distinct from recurring vouchers. A template has no invented cadence and
  cannot post itself.
- “Same as last”/duplicate flows create a new draft rather than mutating the old voucher.
- Number series continue to consume cancelled/binned numbers where statutory document continuity
  requires that behaviour.

### Custom fields

- Definitions are per company and voucher type.
- Supported field kinds include text, number, date and list-of-values.
- Values are stored as text keyed by voucher and definition. A numeric custom value is not money
  and is never summed into accounting reports.
- Retiring a definition preserves values already printed on historical vouchers.
- Custom values are saved inside the voucher transaction.
- A purity guard prevents report/statutory services from depending on custom fields.
- Printed invoices include applicable custom fields.

## A.3 Reports and management accounting

### Financial statements

- Trial balance, P&L and balance sheet remain derived from voucher lines and opening balances.
- Period comparison and previous-year views are available where applicable.
- Vertical/common-size analysis and ratios are available.
- Schedule III presentation maps leaf groups rather than swallowing nested groups at the first
  parent match.
- Unclassified balances appear rather than being silently dropped to force the statement to tie.
- Trade payables include the micro/small-business split used by MSME reporting.

### Day book and ledger statement

- Day Book has search, filters, grouping, configurable columns, exports and keyset pagination.
- Ledger statements support month, Indian FY quarter, half-year and year grouping.
- Deep pages use compound cursors down to a unique key to avoid duplicate/omitted rows on dates
  with equal sort keys.
- Long rows are virtualised.
- Export paths fetch complete data rather than exporting only the currently visible page.

### Registers and drill-down

- Sales/purchase registers share period grouping rules with ledger statements.
- Report rows can drill into filtered Day Book/voucher detail.
- Audit/detail affordances remain available from the keyboard.

### Cost centres and budgets

- Cost-centre allocations are part of voucher lines.
- Party default cost centres can fill unallocated lines without overwriting explicit allocations.
- Budgets can be compared with actual figures and variances.
- Budget/cost-centre reports remain derived from the underlying voucher allocation data.

### Consolidation

- Multiple company files can be read for consolidated reports.
- Consolidation remains read-only across books.
- The reports distinguish trial-balance and P&L/statement views and surface mismatches rather than
  inventing eliminations.

### Exceptions and audit-oriented reports

- An Exceptions screen centralises negative/unusual stock, unclassified scratchpad entries and
  other items requiring human attention.
- Related-party transactions are listed from explicit party metadata.
- Rule 3(1) audit-trail statement reports whether the trail can be disabled, retention effects and
  tamper-evidence limits.

### Receivables and collections

- FIFO bill allocation underpins outstandings.
- Receivable/payable ageing includes configurable bands.
- Collections work includes promised dates/amounts, notes, closing promises and follow-up.
- A deterministic credit score and anomaly signals support the work without replacing human
  judgement.
- Overdue interest is computed in integer-safe arithmetic.
- Bad debts can be tracked explicitly.
- Khata packages party balance, old bills, oldest age, credit limit and last payment into a daily
  operating view.
- Collections rows sort by lateness rather than only size.

### MSME section 43B(h)

- Supplier classification distinguishes micro/small from medium.
- Allowed days are 15 without agreement and capped at 45 with agreement.
- Disallowance and overdue interest are computed from dated facts.
- Interest uses integer-safe monthly rests rather than unsafe 53-bit products.

### Cash and bank management packs

- Cash-flow forecast is derived from bills and expected dates.
- Monthly stock statement for a cash-credit bank is generated.
- Drawing power uses the bank's margins and the same underlying classification as CMA working.
- CMA Forms I–VI and core ratios are produced.
- Audited/book-derived CMA cells cannot be typed over.
- Typed estimate/projection cells are labelled as the user's claims.
- Missing historical years are `null`/missing, never zero.
- Fund-flow computation refuses to infer a movement across a year that does not exist.

## A.4 GST and registrations

### Registration model

- A company can hold multiple GST registrations under one PAN.
- Registration facts include GSTIN, state code, trade name, address, effective/surrender dates and
  a primary registration.
- Existing single-GSTIN companies are migrated into the table and existing vouchers/godowns are
  stamped to preserve historical attribution.
- Voucher registration is persisted rather than inferred at report time.
- Any legacy unstamped fallback anchors to the oldest registration, not the current primary.
- Godowns may belong to registrations.
- Books remain one entity: trial balance, P&L and balance sheet are not split by default.
- GST returns and e-documents are scoped per registration.

### Place of supply

- Intra/inter-state treatment compares the party/place of supply with the supplying
  registration's state, not a single company state.
- A test proves the same Surat supply is CGST+SGST from Gujarat and IGST from Maharashtra.

### Branch transfers

- Cross-registration godown transfers are detected.
- A branch-transfer tax invoice is created under Schedule I rather than treating the transfer as
  non-supply merely because the PAN is shared.
- Rule 28 valuation and corresponding tax treatment are represented.
- Output tax and recipient-side input-tax treatment are posted without moving the entity-wide
  trial balance incorrectly.

### GSTR-1/GSTR-1A

- B2B/B2C/note/export tables are generated from vouchers.
- Filing snapshots preserve what was filed.
- GSTR-1A computes amendments relative to the filed snapshot rather than comparing the current
  books with themselves.
- The authority is corrected to the proviso to rule 59(1); rule 59(4A) governs contents.
- Once-per-period, non-nil and current-period restrictions are surfaced.
- Document-series/Table 13 logic treats cancelled vouchers appropriately.

### GSTR-3B

- Return totals are computed from the books.
- Manual buckets use Zod 4 `.prefault()` so nested zero defaults are actually parsed rather than
  skipped.
- Composition/QRMP rules no longer force regular monthly assumptions on every business.

### QRMP and composition

- Compliance deadlines distinguish monthly and quarterly filers.
- IFF/PMT-06 quarterly workflow is represented.
- CMP-08/GSTR-4 are available for composition dealers.
- Composition invoices render as Bills of Supply rather than tax invoices.

### GSTR-2B and IMS

- 2B import/reconciliation identifies matched, missing, mismatch and action states.
- IMS action handling is represented and caveated where current portal behaviour still needs
  external confirmation.

### Annual/other GST

- GSTR-9 working.
- ISD allocation and GSTR-6 data working.
- RCM liability advice and the section 31(3)(f) self-invoice.
- LUT register and expiry.
- ITC-04 working over job-work challans and returns.
- E-invoice window countdown.
- E-way distance suggestions.

### Effective-dated rates

- Per-item GST/cess rates carry effective dates and notification notes.
- Rate-period splitting supports periods that cross changes.
- The slab advisory is separate from per-item rate history.
- Advisory-only slab validation never blocks a voucher merely because a schedule is incomplete.
- The verified 2025 table keeps 28% Schedule VII and 1.5% where applicable; 6% is rejected as a
  central-tax half-rate rather than a full GST slab.

## A.5 TDS and income tax

### TDS masters and deductions

- TDS sections, thresholds, PAN handling and section 206AA logic.
- Dated 1961 Act / Income-tax Act 2025 references selected from the payment date.
- Section 197 lower-deduction certificates include limits/usage.
- TDS challans and deduction links.

### 24Q/26Q and replacement forms

- Protean-format record working was corrected against published workbooks.
- Field counts are 18/72/41/54 for the covered formats.
- Records use required ordering and CRLF.
- Annexure section codes are mapped explicitly; ambiguous 194I/194J limbs block rather than guess.
- Mandatory deductor/responsible-person fields not stored in the books remain named as missing.
- Export remains visibly unverified/non-fileable until mandatory data and FVU validation exist.
- FY 2026-27 export is blocked because 24Q/26Q are replaced by Forms 138/140 and the new format is
  not implemented.

### Certificates and audit packs

- Form 16A working for vendors.
- Form 3CD clause-wise extracts.
- Form 16/payroll tax support.
- 26AS reconciliation.

## A.6 Invoicing, sales and purchases

### A4 invoice family

- Classic, Modern and Compact templates share one document content skeleton.
- Rule-required content does not change with styling.
- Per-registration seller details are printed.
- HSN, discounts, GST split, QR and bank details are configurable.
- Custom fields print below party details.
- Audit references and document metadata are available.

### Thermal and dot-matrix

- 58/80 mm thermal receipt support.
- A receipt that suppresses the tax split says it is not a tax invoice.
- ESC/P/dot-matrix path for legacy hardware.
- Barcode labels produce TSPL with printer-side Code 128 rather than a hand-rolled barcode
  symbology.
- Thermal-label printing has an on-screen preview and whole-job refusal; it remains explicitly
  untested on physical hardware.

### Bilingual printing

- Hindi and Marathi labels accompany English rather than replacing it.
- Amount in words appears in the chosen language.
- Relies on OS fonts rather than bundling large Devanagari font files.

### Sales/purchase document chains

- Outward: quotation → sales order → delivery challan → invoice.
- Inward: purchase order → receipt note → purchase invoice.
- Ordered, fulfilled, pending and over-received quantities are computed per line.
- Over-delivery is accepted inbound because the stock physically arrived; outbound over-delivery
  is refused unless explicitly allowed.
- Receipt without an order is supported and visible as such.
- Three-way match compares order, receipt and invoice and gives over-invoiced variance highest
  severity.

### Sharing and exports

- PDF generation and print preview.
- WhatsApp share opens the chat and puts the generated PDF where the user can paste it.
- Email attachment was deliberately not built because the app does not hold SMTP credentials.
- Batch invoice PDFs go to a folder rather than adding an archive library merely to save a drag.

## A.7 Inventory, serials and costing

### Stock model

- Stock items, groups, godowns and units.
- Alternative-unit conversion.
- Batches/expiry.
- Multiple valuation methods and stock by godown.
- Negative-stock detection and optional prevention.
- Physical count/count-sheet flow.

### Transfers and landed costs

- Godown transfers via stock journals.
- Cross-registration transfers integrate with branch-transfer tax handling.
- Landed cost distributes freight/duties into item cost.
- Reorder rules and suggestions.

### Manufacturing

- BOMs, nested subassemblies and manufacturing entry.
- Component scrap and finished-good yield.
- Standard cost effective dates.
- Price and usage variance split sums exactly to total variance.
- Missing standards are listed rather than scored as zero.

### Serial numbers

- Serial movements are persisted and current status is derived.
- Altering/binning a sale un-issues its serial rather than leaving a sold ghost.

### Item images

- Files live under the company data tree; SQLite stores metadata/path, not image blobs.
- Uses the attachment storage pattern.
- HEIC is refused because Chromium cannot reliably render it.
- Images can appear in item pickers and invoice output.

### Price lists

- Price-list versions have effective dates.
- “As on” resolution uses shared dated-data rules.
- Percentage revisions round once.
- Whole versions can be undone.

### Job work

- One integrated implementation covers paperwork, tax clock and stock movement.
- A challan sends goods to a per-worker godown through a no-ledger-line stock journal.
- Returning goods reverses the location transfer.
- Waste takes only the outward leg and does not re-enter the principal's stock.
- Editing/deleting paperwork re-posts or withdraws movements rather than double-moving stock.
- ITC-04 consumes the same data rather than re-deriving a parallel ledger.

## A.8 Banking and cash

### Import profiles

- CSV parsing handles quoted fields and signed values without floating-point money conversion.
- Per-bank mappings handle different date/description/debit/credit layouts.
- Separate debit/credit columns preserve negative reversals rather than applying `abs()`.
- Duplicate rows are detected.
- Ambiguous dates are surfaced rather than guessed where possible.
- PDF extraction remains declined for silent-layout-error reasons.

### Matching and reconciliation

- Deterministic rules run before learned narration memory.
- UTR matching has priority.
- Many-to-one proposals show the statement row, constituent vouchers, sum and exact difference.
- Tolerance matches state the amount short/over.
- Reconciliation dates are stored per bank line.
- Per-account freeze prevents changing, deleting or restoring entries inside a closed window.

### Bank charges

- Whole-word recognition avoids “CHARGE” matching “RECHARGE.”
- Direction distinguishes charge from refund.
- Setup creates explicit charge/interest ledgers.
- Recoverable bank GST posts to Duties & Taxes rather than P&L.

### Cheques

- PDC month calendar and register.
- Bounce action reverses every original line.
- Bill references re-open under their original names.
- Original due date is retained so ageing is not reset as a reward for a failed cheque.
- Optional charge amount/ledger and bounce register.
- Undo removes bounce and reversal coherently.

### Foreign currency

- Currency on bank ledger.
- Foreign amount and rate stored on voucher lines, not recomputed later.
- Rates use integer micro-rupee representation.
- Revaluation difference posts a real journal and is not reversed automatically next period.
- Same period end cannot be revalued twice.

## A.9 Payroll, assets and borrowing

### Payroll

- Employee/pay-head masters.
- Attendance and leave facts.
- Monthly, weekly and fortnightly cycles.
- Weekly/fortnightly earnings prorate per cycle; PF/ESI/PT/TDS are computed across the statutory
  month and apportioned with a cumulative true-up.
- Mid-month corrections can land as refunds rather than being clamped to zero.
- PF/ESI/EPS/EDLI rates are effective-dated.
- Employee advances and loan recovery.
- Gratuity service length, six-month rounding and cap.
- Full-and-final settlement lines carry their own working/explanation.
- Payslips and statutory summaries.

Known payroll caveat preserved in the roadmap: employee leaving date was not originally available
for every historical path; verify current schema/implementation before claiming mid-cycle leaver
proration in a new flow.

### Fixed assets

- Asset master, location, block, purchase date and cost.
- Opening accumulated depreciation.
- Companies Act SLM/WDV per asset.
- Income-tax block depreciation.
- Days-in-use and half-rate treatment.
- Disposal/scrapping, profit/loss and block adjustments.
- Capital work in progress and capitalisation.

### Borrowing

- Loan register.
- EMI schedule and principal/interest split.
- Monthly posting.
- Deposit register.
- Prepaid/accrued schedules.
- CMA working and drawing power.

## A.10 Controls, users and audit

### Roles and permissions

- Owner/accountant/viewer role ceiling.
- Fine-grained deny-only permissions. A denial may narrow a role; no custom grant may make a
  viewer a posting user.
- Approval thresholds and explicit approver flows.
- Archived books are read/export only and can be unarchived.
- Licence expiry preserves read/export access.

### Auditor mode

- Owner opens a time-limited read-only auditor session.
- Starting it signs out the owner.
- Auditor actions are attributed separately.
- Session ends automatically and does not survive app quit.

### Audit trail

- Append-only events.
- Hash chain plus a stored head detects changed entries and tail truncation.
- This is tamper evidence, not cryptographic prevention; someone with file write access can
  recompute a chain, and the UI says so.
- Daily digest summarises what changed and who did it.
- AI audit chain links question → proposed draft → human-posted voucher.

### Attachments and approvals

- Attachment metadata in SQLite; bytes in the company folder.
- Approval records and status.
- Bank-detail change request/review workflow.
- Sensitive configuration audit records redact credentials and large binary data.

## A.11 AI and MCP implementation detail

### Provider/config

- OpenAI-compatible endpoint and model.
- OpenAI SDK v7.
- Endpoint presets for Ollama and LM Studio at `127.0.0.1`.
- Local endpoints are recognised as no-egress/no-cost.
- Remote HTTP without TLS is refused except loopback/local endpoints.
- Consent re-arms when endpoint changes.

### Streaming

- Main starts a run and returns an id.
- Frames cross preload on an explicit event-channel allowlist.
- Renderer never receives `IpcRendererEvent`/sender.
- Deltas are coalesced rather than one IPC call per token.
- Escape cancels; second Escape closes.

### Grounding

- Tools return formatted currency plus integer paise.
- Aggregates/totals are computed in TypeScript before reaching the model.
- Tool output has stable refs and truncation metadata.
- Citations resolve to source rows; unknown refs remain inert text.
- GST explanations cite provisions and are generated from validation output rather than raw books.

### Injection/redaction

- Instruction-shaped tool-result text causes the entire field to be quarantined.
- Data is wrapped in a `total-books-data` envelope that restates that it is data.
- Prompt-injection tests include hostile voucher narration.
- Redaction runs in tool dispatch, not in individual tools.
- Redaction preview runs the real redactor.
- Payload preview is built by the same assembly function the runner uses.

### Spend/audit

- Session and daily spend caps enforced in main before client construction and during the run.
- Unknown models use a nonzero fallback cost.
- Loopback endpoints report zero cost.
- Run audit logs model, host, locality, tools, quarantine count, draft, final voucher and cost;
  never the key.

### MCP

- Separate packaged bundle.
- Company slug required; no stateful “select company” tool.
- SQLite opens read-only by default.
- Writes require both `--allow-writes` and in-app Agent access.
- Write burst limit with a bulk-inbox alternative.
- Chart of accounts, voucher schema and changelog resources.
- Existing JSON mirror/inbox remains for atomic bulk imports.

## A.12 Reliability, backup and release

### Data ownership

- Default data root under Documents.
- Custom data root can be selected and moved safely.
- Move copies and verifies databases before switching, leaving the original intact.
- Sync-folder warning for cloud-synced locations.
- App uninstall/reinstall test proves the books survive app-owned profile removal.

### Backup/restore

- Automatic and external backup scheduling.
- Encrypted portable backup format.
- Restore verifies integrity and avoids duplicate-company traps.
- Backup restore is a first-class checklist step and can be tested safely.
- Recovery views explain where data lives.

### Errors/support

- Main and renderer error capture to a bounded log ring/file set.
- IPC payloads are never logged.
- Diagnostics show version/platform and safe event lines.
- The user sees the exact diagnostics string before sending.
- In-app and site contact forms share one endpoint.
- If no sink exists, the endpoint reports failure rather than accepting and dropping the report.

### Licensing

- Offline Ed25519-signed licence tokens.
- Public key in app; private key remains operator-side.
- Company/plan/expiry limits.
- Trial support.
- Expiry degrades to read-only-plus-export and never holds books hostage.

### Release pipeline

- macOS hardened runtime and entitlements.
- Secrets-driven signing/notarisation.
- Windows signing secrets wired.
- Release script runs verification, versions/tags/pushes, then polls GitHub and rejects
  draft/prerelease/missing-asset outcomes.
- Site/update APIs share release metadata assumptions.

---

# Appendix B — remaining work in depth

## B.1 Hard blockers requiring the owner

### Apple signing (#341)

Needed:

- Apple Developer Program enrolment.
- Developer ID Application certificate exported as `.p12`.
- App-specific password.
- Team ID.
- GitHub Actions secrets listed in `HUMAN.md`.

Engineering is already wired. Once valid secrets exist, the next tag should sign and notarise
without a source change. Verify the resulting DMG with Gatekeeper on a clean Mac before launch.

### Windows signing (#342)

Choose:

- Azure Trusted Signing, or
- An OV code-signing certificate.

The latter may take one to three weeks of organisation vetting. Add the configured certificate
and password secrets, then verify installer signature and SmartScreen behaviour on a clean
machine.

### NIC sandbox (#107)

Obtain sandbox credentials and run real end-to-end e-invoice/e-way authentication, generation,
cancellation and error handling. Until then, direct NIC filing remains experimental and the
working offline JSON route is the one to promote.

### Testimonials/video (#307/#308)

- Obtain a real customer's quote and explicit permission to name the person/firm.
- Record the GSTR-1 flow using `site/content/screencast-shot-list.md`.
- Set the corresponding site environment variable.
- Do not invent proof.

### Physical Windows check (#347)

On a real low/mid-range 1366×768 Windows laptop at 125% scaling:

- Check modal height/scrolling.
- Check sidebar readability and scrolling.
- Check dense tables and horizontal overflow.
- Check printer/PDF/file-dialog behaviour.
- Check startup and memory subjectively.
- Test an installed build, not only `electron-vite dev`.

## B.2 Current engineering blockers before merge

The last known full manual branch CI run is red. See section 9 above for details. These are the
highest-priority engineering tasks for the next agent:

### 1. Windows memory ceiling

Current failure:

```text
memoryCeiling.dbtest.ts
streaming CSV export heap growth about 26 MB
ceiling 12 MB
```

Investigate whether:

- the Windows allocator/GC retains buffers differently,
- the test runs before a GC opportunity,
- the result is proportional to export size,
- an output buffer is genuinely retained,
- the stream implementation holds source rows.

A better assertion may be a platform-independent relationship rather than an absolute heap delta:
streaming export should not grow linearly with period size, and a larger fixture should not add
its entire encoded CSV size to retained heap. Do not simply raise the number without evidence.

### 2. MCP write-rate-limit Windows test

The setup hook timeout was fixed at HEAD. Re-run on Windows before treating the remaining
`expected undefined to be true` as independent. If it survives:

- inspect whether the token bucket uses wall clock/timer precision differently,
- ensure each write really reaches the same limiter instance,
- verify setup/migration failures are not returning an error shape before the burst is exhausted,
- assert on the response's exact shape rather than only `isError` if the MCP SDK version wraps it.

### 3. macOS branch-transfer E2E

`52-branch-transfer` passes locally and failed on CI because the UI listed zero invoices after
creation.

Check:

- registration/date filtering against the CI clock and FY,
- query invalidation after the branch-transfer invoice is posted,
- whether the screen opens a different registration/tab than the created transfer,
- whether lazy-screen loading races the query,
- database state at the point of UI assertion.

Prefer an E2E diagnostic that logs the IPC list and current selected registration on failure.
Do not weaken the assertion: the whole feature is that the invoice appears in its worklist.

### 4. Windows font coverage

`30-fonts` claims IBM Plex Sans itself contains `₹`; Windows CI says it does not.

Determine whether:

- Fontsource's Latin subset actually contains U+20B9,
- macOS measured an OS fallback rather than the declared face,
- Canvas/font measurement differs on Windows,
- the app visually renders the symbol correctly through fallback even though IBM Plex does not
  contain it.

If the bundled font truly lacks it, import a subset that includes U+20B9 or use a targeted fallback
font. If the app renders correctly and the assertion confuses fallback with coverage, rewrite the
test to assert rendered availability without falsely attributing the glyph to IBM Plex.

### 5. Windows company-creation click timeout

`53-isd` times out while clicking `Create & open`.

Check whether the click itself is stuck or Playwright waits for work triggered by the click. The
log differs between attempts: one stalls performing the action, one completes the action and then
waits for scheduled navigation. Profile migration/seed time on Windows. The harness currently
uses a 10-second generic click timeout and a 30-second screen timeout; company creation may need a
specific action that initiates the click without waiting for navigation, then waits on the target
screen with the longer timeout.

## B.3 Electron upgrade debt

Electron 37 is retained intentionally. The next attempt should:

1. Start with the three-step CDP wedge reproducer.
2. Bisect Electron 38–42.
3. Test whether using DOM `el.click()` only in the harness avoids the wedge without weakening
   production coverage.
4. Try current Playwright when a version newer than 1.62 exists.
5. Preserve native input coverage somewhere; replacing every synthesised action with JS click
   would hide real focus/input bugs.
6. Reapply the known API ports only after the harness path is credible.
7. Run full Windows and macOS E2E before accepting the bump.

## B.4 Forms 138/140

Current-year 24Q/26Q export is blocked correctly. When Protean publishes the replacement formats:

- Obtain primary workbooks/specification.
- Add dated form selection.
- Build mandatory header/annexure fields explicitly.
- Keep old formats available for historical periods.
- Run through FVU; do not change `.unverified.txt` naming or remove the acknowledgement before
  actual FVU evidence.
- Cover Q4 salary Annexure II separately.

## B.5 Physical hardware validation

Unverified hardware paths include:

- TSPL barcode label printer.
- Dot-matrix/ESC-P printer.
- 58/80 mm thermal printer.
- Windows 125% scaling.
- Real WhatsApp PDF paste flow.
- Real installed-app update after signed release.

Tests prove generated bytes/HTML and user flow, not firmware compatibility. Record printer models,
drivers and any command differences after validation.

## B.6 Pricing and operations

Before commercial launch:

- Decide annual and/or perpetual price.
- Set price environment variables.
- Complete Razorpay KYC.
- Choose hosted payment link vs full in-page checkout.
- Configure at least one feedback sink.
- Configure support email/from addresses.
- Add WhatsApp support number if desired.
- Run a one-rupee live checkout.
- Generate a licence with `scripts/make-license.mjs`, deliver it, apply it in app, and verify
  expiry/read-only/export behaviour.
- Test `/api/latest` and `/api/download` against the latest published non-draft release.

## B.7 Product validation beyond the roadmap

The roadmap is implementation breadth, not evidence of market fit. Before calling v5 complete:

- Watch one shopkeeper, one accountant and one CA use the app without coaching.
- Give them a real Tally export and ask them to reach a reconciled trial balance.
- Observe which terms they do not understand rather than asking whether the UI is “clear.”
- Time first voucher, first GST export, first bank import and first reconciliation.
- Run a parallel month against their current software and compare output to the paise.
- Verify printing on the hardware they actually own.
- Collect support questions and turn repeated ones into product fixes rather than documentation.

---

# Appendix C — file map for major features

Use search rather than assuming every name below remains exact, but these are the main starting
points.

## C.1 Navigation/UI infrastructure

- `src/renderer/src/lib/screens.ts`
- `src/renderer/src/lib/keyboard.ts`
- `src/renderer/src/lib/accel.ts`
- `src/renderer/src/components/ui.tsx`
- `src/renderer/src/components/Shell.tsx`
- `src/renderer/src/app.css`
- `src/renderer/src/screens/lazy.ts`

## C.2 Vouchers/masters

- `src/main/services/vouchers.ts`
- `src/main/services/masters.ts`
- `src/shared/schemas.ts`
- `src/renderer/src/screens/VoucherEntry.tsx`
- `src/renderer/src/screens/voucher/AccountingEntry.tsx`
- `src/renderer/src/screens/voucher/InvoiceEntry.tsx`
- `src/renderer/src/screens/Masters.tsx`

## C.3 GST

- `src/main/services/gst.ts`
- `src/main/services/registrations.ts`
- `src/main/services/registrationId.ts`
- `src/main/services/isd.ts`
- `src/main/services/rcm.ts`
- `src/main/services/jobWork.ts`
- `src/shared/gst/`
- `src/renderer/src/screens/GstReturns.tsx`
- `src/renderer/src/screens/Gstr2b.tsx`
- `src/renderer/src/screens/Composition.tsx`
- `src/renderer/src/screens/Filings.tsx`
- `src/renderer/src/screens/Disclosure.tsx`
- `src/renderer/src/screens/JobWork.tsx`

## C.4 Invoicing

- `src/main/services/invoice.ts`
- `src/main/services/edocs.ts`
- `src/main/services/salesDocs.ts`
- `src/shared/invoiceConfig.ts`
- `src/shared/invoiceConfig.schema.ts`
- `src/shared/invoiceTemplates.ts`
- `src/shared/i18n/invoiceLabels.ts`
- `src/renderer/src/screens/Edocs.tsx`
- `src/renderer/src/screens/SalesChain.tsx`
- `src/renderer/src/screens/settings/InvoiceConfigSection.tsx`

## C.5 Banking

- `src/main/services/banking.ts`
- `src/main/services/bankStatement.ts`
- `src/main/services/chequeBounce.ts`
- `src/shared/bankImport.ts`
- `src/shared/pdcCalendar.ts`
- `src/renderer/src/screens/Banking.tsx`

## C.6 Inventory/manufacturing

- `src/main/services/inventory*.ts`
- `src/main/services/serials.ts`
- `src/main/services/itemImages.ts`
- `src/main/services/jobWork.ts`
- `src/shared/reorder.ts`
- `src/shared/landedCost.ts`
- `src/shared/stockTransfer.ts`
- `src/shared/standardCost.ts`
- `src/shared/priceList.ts`
- `src/renderer/src/screens/StockSummary.tsx`
- `src/renderer/src/screens/JobWork.tsx`

## C.7 Payroll/assets/borrowing

- `src/main/services/payroll.ts`
- `src/main/services/attendance.ts`
- `src/main/services/assets.ts`
- `src/main/services/borrowing.ts`
- `src/main/services/cma.ts`
- `src/shared/statutory.ts`
- `src/shared/payCycle.ts`
- `src/shared/gratuity.ts`
- `src/shared/fnf.ts`
- `src/shared/incomeTax.ts`
- `src/shared/depreciation.ts`
- `src/shared/cma.ts`
- `src/renderer/src/screens/Payroll.tsx`
- `src/renderer/src/screens/Assets.tsx`
- `src/renderer/src/screens/Borrowing.tsx`

## C.8 AI/MCP

- `src/main/services/ai/`
- `src/main/services/assistantLog.ts`
- `src/shared/ai/`
- `src/main/mcp/`
- `src/renderer/src/components/AiDrawer.tsx`
- `src/renderer/src/screens/settings/AiSection.tsx`
- `agent-skill/`

## C.9 Backup/security/audit

- `src/main/services/backup*.ts`
- `src/main/services/portable.ts`
- `src/main/services/audit.ts`
- `src/main/services/auditChain.ts`
- `src/main/services/approvals.ts`
- `src/main/services/attachments.ts`
- `src/main/services/bankChanges.ts`
- `src/main/services/authcrypt.ts`
- `src/main/secrets.ts`
- `src/main/log.ts`
- `src/renderer/src/screens/settings/`

## C.10 Performance and guards

- `src/shared/keyset.ts`
- `src/main/db/stmt.ts`
- `src/main/db/bigbook.ts`
- `src/main/services/queryBudget.dbtest.ts`
- `src/main/services/memoryCeiling.dbtest.ts`
- `scripts/perf-sweep.mjs`
- `scripts/perf-ab.mjs`
- `scripts/bundle-budget.mjs`
- `scripts/visual-regression.mjs`
- `scripts/visual-baseline.json`
- `scripts/mutate.mjs`
- `src/main/notDeleted.test.ts`
- `src/main/dbBoundaries.test.ts`
- `src/main/channels.test.ts`
- `src/main/e2eScenarios.test.ts`
- `src/renderer/src/__tests__/screensRendered.test.ts`
- `src/renderer/src/__tests__/palette.test.ts`
- `src/renderer/src/__tests__/noZod.test.ts`

---

# Appendix D — review plan for a branch this large

Do not ask one reviewer to “review the PR” and expect a useful result. Split it into dimensions:

## D.1 Accounting correctness

Review:

- Paise/qty integer invariants.
- Debit-positive signs.
- Voucher transaction boundaries.
- Report tie-outs.
- FX revaluation.
- Branch-transfer journals.
- Job-work stock value conservation.
- Purchase three-way match.
- Payroll monthly statutory true-up.

## D.2 Statutory correctness

Review independently:

- GST rate history and cited notifications.
- QRMP/composition deadlines/forms.
- RCM self-invoice.
- ISD/GSTR-6.
- TDS record layouts and section mappings.
- Forms 3CD/16A/Schedule III.
- Every remaining “unverified” comment.

Use primary sources. Do not accept a tax blog as authority.

## D.3 Migration/upgrade safety

For every appended migration:

- Confirm no old migration hash changed.
- Confirm array order.
- Confirm existing nullable/backfilled data path.
- Confirm indexes and constraints.
- Confirm migrations from an old seeded DB, not only a fresh DB.
- Check tables rebuilt for UNIQUE-key changes preserve every column/index/row.

## D.4 Security and privacy

Review:

- Secrets never in DB/backup/renderer/log.
- AI tool boundary and no-write guarantee.
- Redaction coverage.
- MCP write switches and rate limiter.
- Roles/permissions/approval bypasses.
- CSP/preload event allowlists.
- Feedback diagnostics and site network-call disclosure.

## D.5 Windows portability

Review/search for:

- POSIX-only paths (`/dev/null`, `/tmp`, chmod, shell quoting).
- Case-only filenames.
- Path separators.
- Long paths and drive letters.
- Font fallback.
- Native dialog timing.
- Antivirus-sensitive migration/seeding tests.
- `shell: true` differences.
- Line endings in statutory files.

## D.6 Renderer/UX

Review:

- Query invalidation families.
- Registry/App/lazy-screen consistency.
- Focus visibility.
- Keyboard and pointer parity.
- Table density/action visibility.
- No raw palette leakage.
- Visual regression output in both themes.
- 1366×768 and 125% scaling.

## D.7 Performance

Review with measurements, not intuition:

- Large report pagination.
- Whole-period export vs visible page.
- Prepared statement reuse safety (`pluck/raw/iterate` stickiness).
- Memory ceiling methodology.
- Entry chunk and total bundle budgets.
- Shared-runner wall-clock scaling.

## D.8 Site/operations

Review:

- No invented price/proof.
- Checkout refuses unconfigured plans.
- Feedback never drops silently.
- Env names match code.
- Privacy page covers every request.
- Download/update endpoints point to published non-draft assets.

---

# Appendix E — common failure patterns discovered during this work

These are not hypothetical. They happened in this branch.

1. **Selective staging broke a migration dependency.** Code queried a table whose migration was
   left unstaged. Merge whole vertical slices.
2. **Two agents appended the same migration number.** The number in the comment did not protect
   anything; array order did. Union in order and regenerate the pin.
3. **A migration test used `MIGRATIONS.length - N`.** Later appends moved the cut and silently
   stopped testing the intended upgrade path. Anchor by migration content.
4. **A screen disappeared in a whole-file conflict resolution.** The incoming `App.tsx` predated
   the screen. Typecheck passed. Registry-vs-App guard now catches it.
5. **A formatter threw on empty input.** One null date replaced an entire screen with an error
   boundary. Formatters used in render paths should be total.
6. **Duplicate object keys silently shadowed an API surface.** Two `jobWork:` blocks in the client
   meant only the second existed at runtime. IPC/channel tests do not catch ordinary JS object-key
   shadowing unless specifically covered.
7. **A hover action was keyboard-visible but pointer-invisible.** CSS depended on `.group` that
   most table rows did not carry. Test behaviour, not class intent.
8. **A scenario number collided.** Both still ran, but filtered runs and summaries became
   ambiguous. The guard now enforces uniqueness.
9. **A Zod major changed `.default()` semantics silently.** Nested defaults stopped parsing.
10. **A generated JSON schema lost safe-integer bounds while runtime validation stayed correct.**
    Regenerate and byte-compare published schemas after schema-library upgrades.
11. **A statutory press-summary was mistaken for the actual schedule.** “Two principal slabs” did
    not mean 28% ceased to exist.
12. **A test used a POSIX-only impossible path.** Windows created it successfully.
13. **A slow setup hook looked like four failing assertions.** Read the first failure and timing;
    do not treat every reported test as independent.
14. **A measurement under machine saturation was reported as app performance.** Use paired A/B,
    run on a quiet machine and retract bad figures explicitly.
15. **A signal handler did not restore a mutated file.** Node was blocked in `execFileSync`; a
    disk journal was required.
16. **Visual regression could not see the signature accent.** The screenshot had no selected row,
    and a 3px rule was below coarse-grid tolerance. Combine behavioural setup, visual signatures
    and exact token snapshots.
17. **Old marketing screenshots remained after the capture script failed.** The script matched
    mutable copy rather than a test id and left stale files looking valid.
18. **A branch test asserted a form in a tax year where the form no longer existed.** Move the
    behavioural test to a valid historical year and add a separate refusal test for the new year.
19. **Raw `Math.abs` on debit/credit CSV columns inverted a reversal.** Signed columns must remain
    signed through netting.
20. **An action sentence repeated in every row caused huge payload/UI noise.** Repeated row text is
    usually screen metadata; send a code and render one footnote.

---

# Appendix F — suggested prompts for the next chat

## F.1 Continue fixing CI

> Read `CLAUDE.md`, `HANDOFF.md` section 9, and the latest manual CI run. Fix the remaining Windows
> and macOS branch-CI failures without weakening assertions. Run targeted tests first, then push and
> trigger `ci.yml` manually against `t3code/revamp-ledgers-shortcuts`. Do not claim merge readiness
> until test, smoke-mac, build-win, e2e-mac and e2e-win all pass at the same HEAD.

## F.2 Review migrations

> Review every migration added by `main..HEAD`. Migrations apply by array position. Confirm no old
> hash changed, every table rebuild preserves rows/columns/indexes, and every migration has a real
> upgrade-path test using `migrationIndexOf`, not distance from the end. Report only verified bugs.

## F.3 Review statutory work

> Review the GST/TDS/statutory changes in `main..HEAD` against primary government/Protean sources.
> Treat every unverified flag as a research question. Do not use tax blogs as authority. Write a
> failing test before correcting a rate, section, deadline or record layout.

## F.4 Review AI security

> Audit the AI/MCP paths in `main..HEAD`. Prove the key cannot enter renderer/data/logs, redaction
> covers every sensitive field, no AI path can write a voucher, injection text is data, and MCP
> writes require both switches plus rate limiting. Try to break the filesystem-grep guards rather
> than merely reading them.

## F.5 Final release gate

> Follow `HANDOFF.md` section 15. Verify the branch at current HEAD locally and through the manual
> CI workflow. Update PR #2's stale title/body. Do not merge or cut a release unless every gate is
> green and the signing limitations are stated accurately.
