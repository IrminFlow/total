# Total — project guide

Total is a **fully offline accounting app for macOS** (Electron + React + TypeScript + SQLite): Tally-grade double-entry books with GST returns, invoicing/PDF, inventory + manufacturing (BOM), banking reconciliation, payroll, multi-currency, Tally XML import, and optional live e-invoice/e-way-bill filing via the NIC APIs. All user data lives in `~/Documents/total/` — no cloud, no accounts. The repo also contains the marketing site (`site/`, Next.js, deployed on Vercel).

GitHub: **private repo `IrminFlow/total`** (HTTPS remote, `gh` credential helper).

## Repo layout

```
src/shared/     Pure TypeScript engine — money, dates, GST calc/validators, GSTR-1/3B +
                e-invoice/e-way builders, posting rules, payroll math, Tally XML parser.
                Zero Electron imports; ALL unit tests live here (+ src/main/**/*.test.ts
                for pure main-side code like the CSV parser).
src/main/       Electron main: SQLite via better-sqlite3 (main process only), migrations,
                services (masters/vouchers/reports/gst/analysis/banking/payroll/edocs/
                invoice/nic/tallyImport, plus later additions — importers/consolidated/
                caPack/tds/costCentres/budgets/yearEnd/audit/roles/users/search/dashboard/
                secrets/printTemplates/etc.), IPC handlers with Zod validation, auto-updater.
src/preload/    contextBridge → window.total.invoke(channel, payload).
src/renderer/   React + Tailwind v4 UI. Talks to main ONLY through the typed client in
                src/renderer/src/lib/client.ts. Light theme default + dark toggle.
                components/kit/ is the component kit (README there); components/table/ is the
                shared DataTable every list screen uses (README there); components/links.tsx
                holds LedgerLink/ItemLink/VoucherLink (name click = edit, row = statement).
docs/superpowers/specs/  The revamp master plan (2026-10-07-total-revamp-roadmap.md) and the
                trade-cycle design (2026-10-07-wp2.5-trade-cycle-design.md).
site/           Next.js 16 marketing site (Vercel root directory = site).
scripts/        e2e/NN-*.mjs — Playwright _electron E2E scenarios (npm run e2e) that launch
                the BUILT app on scratch data dirs; lib/harness.mjs is the shared driver.
.github/        ci.yml — tests on every push/PR (Linux unit+DB, mac smoke, mac e2e on push,
                Windows unit+DB+build); release.yml — builds & publishes DMG/ZIP/EXE on v* tags.
```

## Commands

```bash
npm run dev          # app with HMR
npm test             # vitest — engine tests (pure TS only, no DB)
npm run test:db      # vitest for src/main/**/*.dbtest.ts, run under Electron-as-Node (ABI-matched better-sqlite3)
npm run typecheck    # tsc for main+preload+shared and renderer projects
npm run build        # electron-vite build → out/
npm run build:mac    # build + electron-builder DMG → dist/
npm run smoke        # hermetic IPC smoke test against the BUILT app (out/); run `npm run build` first
npm run test:renderer                    # renderer hook/helper tests (jsdom + RTL)
npm run e2e          # full UI E2E suite (scripts/e2e/*.mjs) against out/; build first.
                     # Filter: node scripts/run-e2e.mjs 03 06
cd site && npm run dev / npm run build   # marketing site
```

## Hard rules & conventions

- **Money is integer paise everywhere**; quantities are integer thousandths (`qtyMilli`). Floats never touch amounts. Formatting/parsing only via `src/shared/money.ts`.
- **Voucher lines are the source of truth** — every report is computed from `voucher_lines` + opening balances at query time. Never denormalise balances.
- The engine (`src/shared/`) stays pure: no Electron, no DB. Anything testable goes here or in pure main-side modules; **vitest must never import better-sqlite3** (it's built for Electron's ABI, not system Node).
- Every IPC payload is Zod-parsed in `src/main/ipc.ts`; handlers return `{ ok, data | error }`.
- Schema changes = append a numbered migration in `src/main/db/migrations.ts` (never edit old ones).
- Debit/credit: signed balances are dr-positive; Tally XML import converts Tally's negative-=-debit convention.
- UI: theme tokens are `--t-*` CSS vars on `[data-theme]`, mapped through Tailwind `@theme inline` — components use token utilities only. The amber `.kbar-row` selection bar on `<tr>` uses an inset box-shadow, **never `::before`** (a `tr::before` renders as a phantom first cell).
- Vouchers are soft-deleted (`vouchers.deleted_at`, moved to the bin) — every new SQL query touching `vouchers`/`voucher_lines` must filter `deleted_at IS NULL` (see `NOT_DELETED` in `src/main/services/vouchers.ts`) unless it's explicitly reading the bin, `getVoucher`, or `nextVoucherNumber`.
- Income/expense ledgers reset every financial year (`src/shared/yearOpening.ts`); profit for a period is defined once (`pnlLedgerAmounts` in reports.ts) and excludes year-end closing journals (`vouchers.is_year_end_close`, migration 018). Closing journals are immutable — bin to reopen a year. Any new report that touches P&L figures must go through these helpers, never re-derive them.
- Audit trail (MCA rule 3(1) edit log, WP 3.8): every write goes through `writeAudit` (services/audit.ts) with the whole before/after. `audit_log` is append-only and hash-chained (migration 031 triggers + `src/shared/auditChain.ts`) — never UPDATE/DELETE it; only `pruneAudit` may delete, and never while `auditTrailRequired` (default on). A new write IPC channel must be mapped in `src/main/auditCoverage.ts` and a new entity added to `src/shared/auditEntities.ts` — `auditCoverage.dbtest.ts` fails otherwise. A migration that inserts audit rows with raw SQL gets them sealed by the runner; one that rebuilds `audit_log` must recreate both triggers.
- Secrets live in `src/main/services/secrets.ts` (safeStorage, `<dataRoot>/secrets.json`), never in a company DB or backup: NIC credentials under `companyScope(slug)`, the AI provider key under scope `'app'` (shared by all companies; only a hint like `…a1b2` ever reaches the renderer).
- AI agent (WP 5.1): all AI code lives in `src/main/ai/` (shapes the renderer needs in `src/shared/ai.ts`); only `ai/provider.ts` imports `openai` and only main touches the network (`networkBoundary.test.ts`). Tools are `defineTool` entries over existing services — `read` or `draft`, never writing the books; a draft is an `ai_drafts` row the user opens in VoucherEntry (`aiDraftId`) and saves through `voucher:save`, which consumes it. Tool results format money (the model quotes, never computes — answers' figures are checked against tool results). Settings are per company (meta `ai`, off by default, data notice first); what is sent is masked/pseudonymised per the privacy toggles and logged in `ai_outbound_log`, costs in `ai_usage`.
- Every list screen uses `DataTable`; new screens must too (sort/filter/views/keyboard/export come for free). Report rows must carry `ledgerId`/`itemId`/`voucherId` so names can be links.
- Voucher load/save mapping per entry mode lives in `src/shared/voucherEdit/`; a voucher must round-trip unchanged through its editor (dbtest `voucherEdit.dbtest.ts` enforces it).
- Inventory valuation is ONE chronological pass (`runInventoryPass` in `src/shared/valuation.ts`, loaded by `stockAnalysis.ts`). Per-voucher costing rules: `stored` (legacy), `derived` (manufacture: finished goods = engine cost of the same voucher's consumption + labour, marked by `manufacture_details`), `transfer` (same-item godown moves), `linked` (GRN re-priced by its bill via `line_links`). Never store or re-derive stock values elsewhere; the legacy snapshot tests (`stockValuation`, `tradeLegacy`) must stay byte-identical.
- Every stock reader filters `inventory_lines.moves_stock` (`MOVES_STOCK` constant; `movesStockLint.test.ts` fails on a missed one). Invoice lines raised against a challan/GRN do not move stock.
- Trade documents (quotation/SO/PO) live in `trade_docs`; challans and GRNs are stock-only voucher kinds (`delivery_note`/`receipt_note`, kinds in the `voucher_kinds` table — no CHECK list). Links between lines use `line_links` keyed by `inventory_lines.line_uid`; rules I1–I7 in `src/shared/tradeCycle/rules.ts` and `services/tradeLinks.ts`. Design: `docs/superpowers/specs/2026-10-07-wp2.5-trade-cycle-design.md`.
- Migrations may start with `-- @foreign-keys-off` (runner turns FKs off outside the transaction and runs `foreign_key_check` before commit) — only for table rebuilds.
- Withholding taxes: TDS and TCS share `src/shared/withholding.ts`; payable ledgers are tagged (`tds_payable_section_id` / `tcs_payable_section_id`, like GST's `tax_type`); every rate/threshold row is effective-dated and carries a `source` citation; entries are validated against voucher lines at save. **Tax rules are never written from memory** — cite the official text next to the number and list anything unverified.
- Audit log: every write channel must be mapped in `src/main/auditCoverage.ts` (dbtest enforces it); rows are hash-chained (`row_hash`/`prev_hash`) and never edited or deleted from code except the retention job; write `writeAudit` with before/after JSON.
- Pricing: `resolvePrice` in `src/shared/pricing.ts` is the only rate resolver (party rate → level → scheme → default level → MRP/last purchase); a user-typed rate is never overridden.
- Trade cycle (WP 2.5): line links live in `line_links`, owned and rewritten by the TARGET's save (`services/tradeLinks.ts`, invariants I1–I7); allowed pairs are data in `shared/tradeCycle/rules.ts`. Returns (credit / debit notes, rejection GRNs / challans) are `return` links and never re-open an order. Closure is manual and doc-level only (`trade_docs.status`, `trade_voucher_details.closed_at`). Every trade report (`tradeReports.ts`, `tradeAnalysis.ts`, `tradeChain.ts`) is computed from documents + live links at query time; GRNI / GDNI must equal the pending-challan / pending-GRN values (supply / approval / purchase purposes) — the year-end close only warns with them.
- Receivables (WP 4.2, migration 032, `services/receivables.ts`, `shared/receivables/`): statements of account and reminder letters are print kinds (`statement` / `reminder`, party documents rendered by `print/render.ts`); every figure comes from `ledgerStatement` + the Outstandings allocation at query time. Only non-derivable facts are stored: `reminder_log`, `interest_charges` (owned by the debit note that posted them — a binned note's periods stop counting, restoring one over a re-charged period is refused), `bill_followups`, and the ledger's credit hold / interest terms. Interest is simple, actual/365, from due + grace; bills are identified by `stableBillKey` (voucher id, never the renumberable bill name — the ref name only for opening-balance bills, which run from the books-begin date, never the FY re-dated one). GST on interest follows the ORIGINAL invoice's GSTR-1 class (`gst.ts outwardSupplyClass`: SEZ / export, pos override) and its (rate, cess) classes, posted one credit line per bill per class so the note equals what GSTR-1 reports; rules and UNVERIFIED points in `shared/receivables/sources.ts`. Interest notes are immutable (bin to redo). A save that creates new credit (new / larger / moved / optional→real / post-dated→dated sales invoice or delivery challan) to a party on hold is refused in `saveVoucher` unless an owner override (`creditHoldOverride`, audited as `credit_override`); holds are owner-only. Ledgers carry `cess_rate` (migration 032) for ledger-line supplies. As-on dates for reminders / interest / credit control never run past today.

## Gotchas

- better-sqlite3 must match Electron's ABI. If the app throws `NODE_MODULE_VERSION` errors (e.g. after a plain `npm rebuild`), run `npx @electron/rebuild -f -w better-sqlite3`. `electron-builder install-app-deps` sometimes no-ops.
- npm blocks postinstall scripts (`allowScripts` allowlist in package.json covers electron, better-sqlite3, esbuild).
- `tally:import` and `bank:importCsv` IPC channels accept inline `xmlText`/`csvText` payloads so drivers can test them without native file dialogs.
- The e2e demo tour (`scripts/e2e/02-demo-tour.mjs`) seeds a `Demo Traders` company into the scratch data dir; reuse that seeding for manual checks instead of assuming one exists in `~/Documents/total` (it does not on every machine).
- The NIC live-filing client (`src/main/services/nic.ts`) is built to the published API spec (RSA + AES-ECB session crypto) but has **never run against the real portal** — no credentials. Treat as experimental; test on the NIC sandbox first.
- `TOTAL_DATA_DIR` (absolute path, read verbatim by `dataRoot()`) and `TOTAL_SUPPRESS_SYNC_WARNING=1` point driver/CI scripts at a scratch data dir and silence startup sync warnings — set both when scripting the app (see `scripts/smoke-ci.mjs`, `*.dbtest.ts`) so runs stay hermetic and don't touch `~/Documents/total/`. With `TOTAL_DATA_DIR` set the app also keeps Electron `userData` (localStorage etc.) inside the scratch dir. `TOTAL_INSECURE_TEST_SECRETS=1` (only honoured with `TOTAL_DATA_DIR` and an unpackaged build) swaps safeStorage for a test cipher so smoke/e2e never touch the keychain.
- Shells spawned by agent tooling may inherit `ELECTRON_RUN_AS_NODE=1`, which makes the app fail to launch under Playwright — run `env -u ELECTRON_RUN_AS_NODE npm run smoke` / `npm run e2e` in that case (`test:db` sets the flag itself on purpose).
- `TOTAL_AI_MOCK=1` (only with `TOTAL_DATA_DIR`, unpackaged) swaps the OpenAI provider for the scripted demo `MockProvider` (`src/main/ai/mockProvider.ts`) — e2e 35 uses it. The default model ids `gpt-6.1-sol` / `gpt-6-luna` are unverified until Settings → AI → Test connection lists the key's models.
- Recurring vouchers were removed in 0.5.0; migrations 008/009 and the `recurring_templates` table remain, untouched.

## Release steps (auto-update pipeline)

```bash
npm version patch      # bumps version, commits, tags vX.Y.Z
git push --follow-tags # → GitHub Actions: tests, DMG+ZIP build, publishes the release
```

- `.github/workflows/release.yml` runs on `v*` tags (macOS runner, `GITHUB_TOKEN` automatic). `releaseType: "release"` in package.json `build.publish` — releases publish directly, **never leave them as drafts** (drafts are invisible to the `releases/latest` API that feeds updates and the site).
- Installed apps check for updates on launch (`src/main/updater.ts`): electron-updater first; because builds are unsigned and the repo is private, the working path is the fallback — it asks the site's `/api/latest` and offers `/api/download`. Once an Apple Developer ID (`CSC_LINK`/`CSC_KEY_PASSWORD` secrets) exists **and** releases are public, silent in-place updates take over.
- If the repo owner/name ever changes: update package.json `build.publish`, `GITHUB_REPO` + `SITE_LATEST_URL` in `src/main/updater.ts`, and Vercel's `GITHUB_REPO` env.

## Site deploy (Vercel)

- Import the repo, **Root Directory = `site`**, framework auto-detected (Next.js). Auto-deploys on push to `main`.
- Required env while the repo is private: `GITHUB_TOKEN` — fine-grained PAT, read-only on this repo — lets the site show the latest version, serve `/api/download` (exchanges the private DMG asset for a short-lived URL; token never reaches the browser), and answer `/api/latest` for the app's update check.
- Optional env: `NEXT_PUBLIC_SITE_URL` (custom domain, for OG cards), `GITHUB_REPO` (override).
- Canonical site URL is `https://devjindal.tech`. `src/shared/product.ts` (`SITE_URL`, `GITHUB_REPO`) is the
  in-app source of truth — `src/main/updater.ts` imports it. The site under `site/` can't import
  `src/shared` (separate tsconfig, no path there) so it stays env-driven instead: `NEXT_PUBLIC_SITE_URL`
  for its own metadataBase (defaults to the canonical URL) and `GITHUB_REPO` for `site/lib/release.ts`
  (defaults to `IrminFlow/total`). If the domain or repo ever changes, update `src/shared/product.ts`,
  Vercel's env vars, and the note above together.
