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
                invoice/nic/tallyImport), IPC handlers with Zod validation, auto-updater.
src/preload/    contextBridge → window.total.invoke(channel, payload).
src/renderer/   React + Tailwind v4 UI. Talks to main ONLY through the typed client in
                src/renderer/src/lib/client.ts. Light theme default + dark toggle.
site/           Next.js 16 marketing site (Vercel root directory = site).
scripts/        drive*.mjs — Playwright _electron smoke drivers that launch the BUILT app
                and screenshot flows (run `npm run build` first).
.github/        release.yml — builds & publishes DMG/ZIP on v* tags.
```

## Commands

```bash
npm run dev          # app with HMR
npm test             # vitest — engine tests (pure TS only, no DB)
npm run typecheck    # tsc for main+preload+shared and renderer projects
npm run build        # electron-vite build → out/
npm run build:mac    # build + electron-builder DMG → dist/
cd site && npm run dev / npm run build   # marketing site
node scripts/drive6.mjs                  # example smoke driver (build app first)
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
- The app assumes the site at `https://total-site.vercel.app` (`SITE_LATEST_URL`) — update if the deployed domain differs.
