# Agent instructions — Total

**Read `CLAUDE.md` for the full project guide** (architecture, conventions, gotchas, release and deploy steps). This file is the tool-agnostic summary; if the two ever disagree, CLAUDE.md wins.

## What this is

Fully offline accounting app for macOS (Electron + React + TS + better-sqlite3) for Indian businesses — double-entry books, GST returns + e-invoice/e-way exports, invoice PDFs, inventory/BOM manufacturing, banking reconciliation, payroll, multi-currency, Tally XML import. User data: one SQLite DB per company under `~/Documents/total/`. Marketing site: `site/` (Next.js 16, Vercel, root directory `site`). Private repo `IrminFlow/total`.

## Working here

- Layers: `src/shared/` = pure engine (all tests), `src/main/` = SQLite + services + Zod-validated IPC, `src/renderer/` = React UI calling `window.total.invoke` via `src/renderer/src/lib/client.ts` only.
- Money = integer paise; quantity = integer thousandths. No floats on amounts, ever.
- Reports are always computed from `voucher_lines`; never store derived balances.
- New DB schema = append a migration in `src/main/db/migrations.ts`.
- Tests (`npm test`) run under system Node: never import better-sqlite3 from a test (it's compiled for Electron's ABI). If the app itself hits `NODE_MODULE_VERSION` errors: `npx @electron/rebuild -f -w better-sqlite3`.
- Verify UI changes by building (`npm run build`) and running a `scripts/drive*.mjs` Playwright driver against the built app.
- Before claiming done: `npm test` and `npm run typecheck` must pass.

## Ship

- Release: tag the reviewed `main` commit with the version already in `package.json`, then `git push origin main --follow-tags`; GitHub Actions builds and publishes DMG/ZIP. Use `npm version patch` only when preparing a new patch version. Releases must publish directly (never drafts — the update feed reads `releases/latest`).
- App updates: installed apps poll the site's `/api/latest` (private-repo path); electron-updater goes silent only once builds are signed and releases public.
- Site: Vercel auto-deploys `site/` on push to `main`; needs `GITHUB_TOKEN` (read-only PAT) env while the repo is private.
