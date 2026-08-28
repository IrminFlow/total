# Total

Total is a local-first accounting workstation for Indian businesses. It combines double-entry books, GST-ready offline workflows, invoicing, inventory, banking, payroll, migration tools, reporting, optional AI assistance, and optional encrypted collaboration in one Electron desktop application for macOS and Windows.

The accounting engine never needs an account or an internet connection. Each company keeps its own SQLite database under the user-controlled Total data directory. Optional network features are separately enabled, can be disabled without affecting the books, and never replace SQLite as the accounting source of truth.

## Current release state

- Version: `5.0.0`
- Active integration branch: `v5-cloud-agent-sync`
- Draft pull request: [#4](https://github.com/IrminFlow/total/pull/4)
- CI: application tests, database tests, renderer tests, macOS E2E, Windows build, visual contracts, website build, and unsigned macOS/Windows packages pass on the branch
- Public release: not yet approved or signed
- Explicitly excluded: NIC live filing and online GST portal APIs

Start with the document that matches your role:

- Product owner: [HUMAN.md](HUMAN.md)
- Coding agent: [TASKS.md](TASKS.md) and [CLAUDE.md](CLAUDE.md)
- Product and delivery roadmap: [ROADMAP.md](ROADMAP.md)
- Documentation index: [docs/README.md](docs/README.md)
- Release operator: [docs/RELEASE_RUNBOOK.md](docs/RELEASE_RUNBOOK.md)

## Product capabilities

### Accounting and daily work

- Multi-company double-entry books with append-only migrations and audit history
- Contra, Payment, Receipt, Journal, Sales, Purchase, Credit Note, Debit Note, Stock Journal, and Physical Stock vouchers
- Autosaved drafts, duplication warnings, linked reversals, soft-delete recovery, comments, templates, and maker-checker approval
- Global command palette, contextual keyboard shortcuts, red mnemonic letters, screen history, saved workspaces, and focused work modes
- Monthly and Indian financial-year quarterly Sales and Purchase registers with export and Day Book drill-through

### Business operations

- Receivables, payables, ageing, collections, promises to pay, reminders, and customer statements
- Banking reconciliation, statement imports, rules, cheque lifecycle, payment runs, and cash forecasts
- Inventory, godowns, batches, serials, reorder controls, weighted-average valuation, BOM, and manufacturing
- Purchase requisitions, purchase orders, GRNs, three-way matching, debit-note claims, and vendor controls
- Payroll, attendance, salary structures, statutory calculations, payslips, loans, reimbursements, and final settlement
- Budgets, cost centres, consolidation, management insights, cash-flow scenarios, and portable report packs

### Compliance and migration

- GSTR-1 and GSTR-3B calculations, GST action centre, GSTR-2B reconciliation, return snapshots, and offline portal exports
- Offline e-Invoice and e-Way Bill JSON exports
- TDS controls and compliance calendar
- Tally XML plus Busy, Marg, Zoho, and spreadsheet migration workbenches
- Pre-import snapshots, validation previews, reconciliation evidence, and rollback points

### Optional intelligence and collaboration

- OpenAI Responses API support and OpenAI-compatible endpoints
- Legitimate ChatGPT/Codex device login through the installed Codex CLI
- AI explanations, searches, document extraction, bank suggestions, and balanced voucher proposals
- AI Operator with a visible action plan and owner-approved filesystem roots
- Bundled offline English OCR through Tesseract
- Local stdio MCP server with read tools and proposal-only write tools
- End-to-end encrypted Supabase collaboration for proposals, drafts, comments, and tasks
- Expiring, revocable, single-use team invitations with separate recovery-key exchange

AI cannot post accounting entries directly. Posted-book changes always use the ordinary validation, permissions, period-lock, approval, transaction, and audit paths.

## Architecture

```text
src/shared/      Pure TypeScript accounting rules and schemas
src/main/        Electron main process, SQLite, services, IPC, AI, sync
src/preload/     Narrow contextBridge API
src/renderer/    React 19 and Tailwind v4 desktop interface
site/            Next.js 16 marketing, download, support, and feedback site
supabase/        Optional encrypted-sync and hosted-intake migrations/functions
scripts/         E2E, performance, security, evidence, and release tooling
docs/            Product, operational, security, acceptance, and release guides
```

Important invariants:

- Money is integer paise. Quantities are integer thousandths.
- Reports derive from `voucher_lines`; derived balances are not stored.
- SQLite is authoritative. JSON is the portable human and agent interface.
- New schemas use appended migrations. Historical migrations are never rewritten.
- Renderer code calls the typed client only. It does not access SQLite, credentials, or provider SDKs.
- Optional network services fail closed while local accounting remains available.

## Development

Requirements: Node.js 22, npm, and the platform build tools required by Electron.

```bash
npm install
npm run dev
```

`npm run dev` starts Electron with hot module replacement. Automation must use a scratch company-data directory rather than production data.

Core verification:

```bash
npm run typecheck
npm test
npm run test:db
npm run test:renderer
npm run build
npm run smoke
npm run e2e
```

Additional release gates:

```bash
npm run test:release
npm run test:visual
npm run perf:bundle
npm run security:dependencies
npm run security:audit
npm run security:threat-model
cd site && npm test && npm run build
```

If `better-sqlite3` reports a `NODE_MODULE_VERSION` mismatch, rebuild it for Electron:

```bash
npx @electron/rebuild -f -w better-sqlite3
```

## Data and secret safety

Production company data defaults to `~/Documents/total/`. Every automated driver must use a temporary `TOTAL_DATA_DIR` and must never operate on the real directory. Uninstallers are configured to preserve company data.

Provider keys, collaboration tokens, recovery material, and signing credentials must not enter SQLite, JSON mirrors, backups, renderer state, logs, support payloads, commits, or documentation. Desktop secrets use the operating-system credential facility.

## Shipping

Do not create a release tag manually. The reviewed release commit is merged to `main`, built through the protected release-candidate workflow, accepted against exact artifact digests, and promoted without rebuilding. The authoritative sequence is in [docs/RELEASE_RUNBOOK.md](docs/RELEASE_RUNBOOK.md).

The branch workflow in `.github/workflows/v5-cloud-agent-sync.yml` creates unsigned, non-publishing macOS and Windows test packages. It cannot create a public release.

## Documentation

[docs/README.md](docs/README.md) explains which guides are authoritative, operational, historical, or generated. When implementation and documentation differ, update the implementation status and the relevant operational guide in the same change.
