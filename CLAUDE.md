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
                caPack/recurring/tds/costCentres/budgets/yearEnd/audit/roles/users/etc.),
                IPC handlers with Zod validation, auto-updater.
src/preload/    contextBridge → window.total.invoke(channel, payload).
src/renderer/   React + Tailwind v4 UI. Talks to main ONLY through the typed client in
                src/renderer/src/lib/client.ts. Light theme default + dark toggle.
site/           Next.js 16 marketing site (Vercel root directory = site).
scripts/        e2e/NN-*.mjs — Playwright _electron E2E scenarios (npm run e2e) that launch
                the BUILT app on scratch data dirs; lib/harness.mjs is the shared driver.
.github/        release.yml — builds & publishes DMG/ZIP on v* tags.
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

## Gotchas

- better-sqlite3 must match Electron's ABI. If the app throws `NODE_MODULE_VERSION` errors (e.g. after a plain `npm rebuild`), run `npx @electron/rebuild -f -w better-sqlite3`. `electron-builder install-app-deps` sometimes no-ops.
- npm blocks postinstall scripts (`allowScripts` allowlist in package.json covers electron, better-sqlite3, esbuild).
- `tally:import` and `bank:importCsv` IPC channels accept inline `xmlText`/`csvText` payloads so drivers can test them without native file dialogs.
- A `Demo Traders` company with sample data exists in `~/Documents/total` from verification runs.
- The NIC live-filing client (`src/main/services/nic.ts`) is built to the published API spec (RSA + AES-ECB session crypto) but has **never run against the real portal** — no credentials. Treat as experimental; test on the NIC sandbox first.
- `TOTAL_DATA_DIR` (absolute path, read verbatim by `dataRoot()`) and `TOTAL_SUPPRESS_SYNC_WARNING=1` point driver/CI scripts at a scratch data dir and silence startup sync warnings — set both when scripting the app (see `scripts/smoke-ci.mjs`, `*.dbtest.ts`) so runs stay hermetic and don't touch `~/Documents/total/`.

## Release steps (auto-update pipeline)

For the prepared version already recorded in `package.json`, merge the reviewed release commit to `main`, then tag that exact commit:

```bash
git tag "v$(node -p "require('./package.json').version")"
git push origin main --follow-tags
```

Use `npm version patch` only when intentionally preparing the next patch version; do not run it again for an already-versioned release candidate.

- `.github/workflows/release.yml` runs on `v*` tags (macOS runner, `GITHUB_TOKEN` automatic). `releaseType: "release"` in package.json `build.publish` — releases publish directly, **never leave them as drafts** (drafts are invisible to the `releases/latest` API that feeds updates and the site).
- Installed apps check for updates on launch (`src/main/updater.ts`): electron-updater first; because builds are unsigned and the repo is private, the working path is the fallback — it asks the site's `/api/latest` and offers `/api/download`. Once an Apple Developer ID (`CSC_LINK`/`CSC_KEY_PASSWORD` secrets) exists **and** releases are public, silent in-place updates take over.
- If the repo owner/name ever changes: update package.json `build.publish`, `GITHUB_REPO` + `SITE_LATEST_URL` in `src/main/updater.ts`, and Vercel's `GITHUB_REPO` env.

## Site deploy (Vercel)

- Import the repo, **Root Directory = `site`**, framework auto-detected (Next.js). Auto-deploys on push to `main`.
- Required env while the repo is private: `GITHUB_TOKEN` — fine-grained PAT, read-only on this repo — lets the site show the latest version, serve `/api/download` (exchanges the private DMG asset for a short-lived URL; token never reaches the browser), and answer `/api/latest` for the app's update check.
- Optional env: `NEXT_PUBLIC_SITE_URL` (custom domain, for OG cards), `GITHUB_REPO` (override).
- Support intake: private Blob storage is the v0.5 system of record for tracking, retention and
  deletion. `CONVEX_SUPPORT_URL` or `SUPPORT_WEBHOOK_URL` is an optional notification destination;
  `SUPPORT_WEBHOOK_SECRET`, `INTAKE_SECURITY_SECRET` and `CRON_SECRET` protect administration,
  intake controls and scheduled retention. Without Blob, `/api/support` falls back to email.
- Canonical site URL is `https://devjindal.tech`. `src/shared/product.ts` (`SITE_URL`, `GITHUB_REPO`) is the
  in-app source of truth — `src/main/updater.ts` imports it. The site under `site/` can't import
  `src/shared` (separate tsconfig, no path there) so it stays env-driven instead: `NEXT_PUBLIC_SITE_URL`
  for its own metadataBase (defaults to the canonical URL) and `GITHUB_REPO` for `site/lib/release.ts`
  (defaults to `IrminFlow/total`). If the domain or repo ever changes, update `src/shared/product.ts`,
  Vercel's env vars, and the note above together.
