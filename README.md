# Total

**Accounting for small Indian businesses, kept on your own computer.** Total is a double-entry books
app (Electron, React, TypeScript, SQLite) with GST returns, invoicing, stock and manufacturing, banking,
payroll, multi-currency and Tally import. Every company is one file under `~/Documents/total/`. There
is no account to create and no cloud copy of your books.

It has two views of the same books:

- **Simple mode** for owners who do not know accounting words: a setup wizard, a short sidebar (Home,
  Sell, Buy, Money, Stock, People, Reports, Taxes, Settings), "Why?" under every figure, undo after
  saving, Ask Total, and an offline help panel. Hindi and Hinglish are available for simple mode
  (machine-drafted, awaiting native review).
- **The accountant view**: the full app with every voucher, ledger and report, Tally-style keyboard use,
  an audit trail, TDS/TCS, GSTR-1/3B/9 workings and more. Every simple screen has an "Accountant view"
  button, and existing companies open in this view unchanged.

Read [docs/features.md](docs/features.md) to see whether it fits you.

## What "offline" means here

Your books are never uploaded or synced. Total is not completely offline, though: it makes a few
network calls. The update check is on by default and cannot be switched off. [docs/ai-and-privacy.md](docs/ai-and-privacy.md) lists every one and the code
that makes it. In short: an update check at launch (it asks GitHub, and the project's site if that fails, for the
newest version and may download it); an optional AI helper, off until you accept a data notice and
add **your own** OpenAI key, which sends the figures and text a question needs (identifiers masked)
to OpenAI; optional live e-invoice filing (experimental, never run against the real portal); and an
optional MCP server for developers (stdio only, run from a source checkout, no network port). Total prepares GST figures and
files; you file the returns on gst.gov.in.

## Install (testers)

Releases are on GitHub: <https://github.com/IrminFlow/total/releases>. The macOS builds are for Apple
Silicon (`Total-<version>-arm64.dmg`, plus a ZIP). Open the DMG and drag Total to Applications.
Builds are not code-signed yet, so macOS says the app "is damaged and can't be opened". Right-click,
Open does **not** get past this for the current build (see the site's Getting started page). Clear the
quarantine flag once per downloaded version:

```bash
xattr -cr /Applications/Total.app
open /Applications/Total.app
```

**From a DMG you built yourself** (a tester build that is not a release): see "Build from source"
below, then open `dist/Total-<version>-arm64.dmg`, drag Total to Applications, and run the `xattr`
line. The version in the file name is the one in `package.json`, so a test build looks like the last
release until the version is bumped.

Back up before you open an existing company in a newer build. Database updates run on first open and
there is no downgrade; restore the backup instead. Details: [CHANGELOG.md](CHANGELOG.md).

**Windows**: run `Total-Setup-<version>.exe` from the release (installs for you only, no
administrator password). It is not code-signed yet, so Windows may show "Windows protected your PC":
choose **More info → Run anyway**. Your books live in `Documents\total`. What is verified on Windows
and what differs: [docs/windows.md](docs/windows.md).

## Build from source

Needs Node 22 (the version CI uses) and npm.

```bash
npm ci                      # postinstall rebuilds better-sqlite3 for Electron
npm run dev                 # the app with hot reload
npm test                    # engine tests (pure TypeScript, no database)
npm run test:db             # database tests, run under Electron-as-Node
npm run test:renderer       # screen tests (jsdom)
npm run typecheck
npm run build               # → out/
npm run build:mac           # build + DMG and ZIP in dist/
npm run smoke               # headless IPC check of the built app (run build first)
npm run e2e                 # Playwright UI scenarios against out/ (run build first)
```

If better-sqlite3 complains about `NODE_MODULE_VERSION`, rebuild it for Electron:
`npx @electron/rebuild -f -w better-sqlite3`. If a shell sets `ELECTRON_RUN_AS_NODE=1`, unset it for
`smoke` and `e2e` (`env -u ELECTRON_RUN_AS_NODE npm run e2e`). `TOTAL_DATA_DIR=/some/scratch` points the
app at a scratch data folder instead of `~/Documents/total/`. More in [CLAUDE.md](CLAUDE.md).

## Documentation

| Page | What it is |
|---|---|
| [docs/features.md](docs/features.md) | What each section does, simple and accountant |
| [docs/ai-and-privacy.md](docs/ai-and-privacy.md) | What stays on your computer and what can leave |
| [docs/migration-guides/from-tally.md](docs/migration-guides/from-tally.md) | Importing from Tally: what comes, what does not, merge rules |
| [docs/migration-guides/from-a-spreadsheet.md](docs/migration-guides/from-a-spreadsheet.md) | Excel, CSV, Busy, Zoho; books export and import |
| [docs/migration-guides/from-0.10-to-simple-mode.md](docs/migration-guides/from-0.10-to-simple-mode.md) | Upgrading an existing company; switching views |
| [docs/migration-guides/for-a-ca.md](docs/migration-guides/for-a-ca.md) | A CA receiving a backup |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each version, with the pull requests |
| [docs/ai-evals.md](docs/ai-evals.md) | How the AI helper is scored |
| [CLAUDE.md](CLAUDE.md) | The engineering reference: rules, architecture, gotchas |
| `docs/superpowers/specs/` | The revamp roadmap and the simple-mode plan |

Inside the app, press `?` (simple mode) for the help panel; `Cmd+K` searches the books and runs
commands.

## How the code is laid out

- `src/shared/` is the pure engine: money as integer paise, dates and financial years, GST calculation
  and validators, GSTR-1/3B and e-invoice builders, posting rules, payroll, the Tally parser. No
  Electron, no database. All the unit tests live here.
- `src/main/` is the Electron main process: SQLite through better-sqlite3, numbered migrations, the
  services, and IPC handlers that validate every payload with Zod.
- `src/renderer/` is the React and Tailwind UI. It reaches main only through the typed client in
  `src/renderer/src/lib/client.ts`.
- `site/` is the marketing site (Next.js). `scripts/e2e/` holds the end-to-end scenarios.

Voucher lines are the source of truth. Every report is computed from them, plus opening balances, at
the time you open it. Nothing is stored as a balance, so the books cannot drift from their reports.
