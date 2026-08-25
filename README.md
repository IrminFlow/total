# Total

**Fully offline accounting for macOS.** Tally-grade double-entry books with GST, inventory, and portal-ready returns — reimagined with a modern, keyboard-first interface. No cloud, no account, no internet. All data lives in `~/Documents/total/`.

## What it does

- **Multi-company books** — one SQLite file per company under `~/Documents/total/companies/<slug>/`, auto-backed-up on every open (last 20 snapshots kept in `backups/`).
- **Masters** — Tally's 28 default account groups seeded verbatim, ledgers with GST/party details, stock items (HSN, GST rate, cess), units with GST UQC codes, godowns, configurable voucher-type numbering.
- **Vouchers** — Contra, Payment, Receipt, Journal, Sales, Purchase, Credit Note, Debit Note, Stock Journal, Physical Stock. Invoice mode computes GST live (intra → CGST+SGST, inter → IGST from state codes), rounds off to the rupee, and posts balanced double-entry lines. Every edit/delete lands in an audit log.
- **Reports** — Day Book, Ledger statement, Trial Balance, P&L (trading + P&L with opening/closing stock), Balance Sheet, Stock Summary (weighted-average valuation). Reports drill down: statement → group → ledger → voucher.
- **GST** — GSTR-1 (B2B/B2CL/B2CS/CDNR/HSN) and GSTR-3B computed from vouchers; **Export portal JSON** writes offline-tool-schema files into the company's `exports/` folder, ready to upload. GSTIN checksum validation, HSN validation, state-mismatch warnings. **e-Invoice** (NIC schema 1.1) and **e-way bill** bulk JSON exports for the government offline tools, with per-invoice dispatch details (vehicle, transporter, distance).
- **Invoice printing** — GST tax invoice as PDF (HSN column, tax breakup, amount in words, declaration + signatory), from voucher entry ("Save + invoice PDF"), the Day Book, or the e-Invoice screen. PDFs land in `exports/` and open automatically.
- **Registers & outstandings** — monthly Sales/Purchase registers (count, taxable, GST, total) and party-wise receivable/payable **ageing** (0-30/31-60/61-90/90+) with FIFO bill settlement and drill-down to open bills.
- **Banking** — bank reconciliation per bank ledger: books vs bank balance, cheque/UTR numbers on payments and receipts, manual bank-date marking, and **statement CSV import** with automatic matching by amount and date (±5 days).
- **Two themes** — light (default) and dark, toggle in the header, remembered across launches.
- **Payroll** — employees with salary structures (Basic/HRA/Special), statutory EPF (12%+12%, ₹15,000 ceiling), ESI (0.75%/3.25% under ₹21,000), simplified professional tax; monthly pay runs with attendance proration post one balanced Journal voucher (salaries + employer contributions vs PF/ESI/PT/Salaries payable) and produce payslip PDFs.
- **Manufacturing / BOM** — bill of materials on stock items; the Stock Journal voucher becomes a Manufacture screen: pick the output and quantity, components are consumed at weighted-average cost (plus an overhead %), finished goods enter stock at cost.
- **Multi-currency** — add currencies in Masters; sales invoices can be priced in a foreign currency with an exchange rate — books stay in ₹, the currency and rate are stored on the voucher.
- **Tally import** — reads Tally's Masters and Day Book XML exports (groups, ledgers with opening balances and GSTINs, units, stock items, vouchers with Tally's Dr/Cr sign conventions). Best-effort with a warnings report; auto-backup before every import.
- **Live filing (optional)** — NIC e-invoice API client (auth with RSA + AES session encryption, generate IRN per invoice, generate e-way bill against the IRN); paste your API credentials once under e-Invoice → Set up live filing. Fully optional — the offline JSON exports remain the default path.
- **Offline intelligence** — ledger autosuggest ranked by usage per voucher kind, duplicate-voucher warning (same party + amount ± 3 days), anomaly nudge on unusual amounts, Tally-style smart dates (`7`, `7/4`, `y`, `t`), amount-in-words on invoices.

## Keyboard

`⌘K` command palette · `F4`–`F9` voucher type switching · `⌘↵` save voucher · `Esc` back · arrow keys + `Enter` drive every list (the accent bar is the cursor) · single letters on the Gateway (`V` voucher, `D` day book, `B` balance sheet…).

## Shipping: GitHub, Vercel, auto-updates

One repo holds both the app and the marketing site (`site/`, Next.js).

The repo lives (private) at `IrminFlow/total`. If the owner/name ever changes, update `build.publish` in `package.json`, `GITHUB_REPO` + `SITE_LATEST_URL` in `src/main/updater.ts`, and the `GITHUB_REPO` env on Vercel.

1. **Releases (auto-update feed)** — pushing a version tag makes GitHub Actions build the DMG+ZIP and attach them to a release (`.github/workflows/release.yml`):
   ```bash
   npm version patch        # bumps package.json, commits, tags v0.1.1
   git push --follow-tags
   ```
2. **Vercel** — import the repo and set **Root Directory to `site`**. Required env var while the repo is private: `GITHUB_TOKEN` — a fine-grained PAT with *read* access to this repo's contents, so the site can show the latest version and serve `/api/download` (it exchanges the asset for a short-lived public URL; the token never reaches the browser). Optional: `NEXT_PUBLIC_SITE_URL` (your domain, for social cards), `GITHUB_REPO` (owner/repo override).
3. **How updates reach users** — installed apps check the site's `/api/latest` on launch (this works while the repo is private) and offer the new DMG via `/api/download`. Unsigned builds always use this prompt-to-download path; once you add `CSC_LINK`/`CSC_KEY_PASSWORD` secrets (Apple Developer ID) *and* the repo/releases are public, electron-updater's silent in-place updates take over. If `src/main/updater.ts`'s `SITE_LATEST_URL` doesn't match your real Vercel domain, update it.

## Development

```bash
npm install                 # postinstall rebuilds better-sqlite3 for Electron
npm run dev                 # dev app with HMR
npm test                    # engine test suite (money, GST, posting, GSTR builders)
npm run typecheck
npm run build:mac           # DMG in dist/
```

If better-sqlite3 complains about `NODE_MODULE_VERSION`, rebuild it for Electron:
`npx @electron/rebuild -f -w better-sqlite3` (needed after any plain `npm rebuild`, which targets system Node instead).

`scripts/e2e/*.mjs` (run with `npm run e2e`) are Playwright E2E scenarios that launch the built app on scratch data dirs and walk onboarding → vouchers → GST → payroll → backup, saving screenshots and JSON results (run `npm run build` first).

## Architecture

- `src/shared/` — the pure engine: money (integer paise), dates/FY, double-entry posting rules, GST calculator, GSTIN/HSN validators, GSTR-1/3B builders, seed data. Zero Electron imports; fully unit-tested.
- `src/main/` — Electron main process: SQLite (better-sqlite3, WAL, migrations), company registry, services (masters/vouchers/reports/gst/intel), IPC handlers with Zod validation on every payload.
- `src/renderer/` — React + Tailwind UI. Talks to main only through `window.total.invoke` (contextBridge); all money stays in paise until display.

Voucher lines are the source of truth — every report is computed from `voucher_lines` + opening balances at query time; nothing is denormalised, so books can never drift.
