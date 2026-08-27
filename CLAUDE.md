# Total project guide

This is the authoritative repository guide for coding agents and maintainers. `AGENTS.md` is the short entry point. `TASKS.md` owns current agent work. `ROADMAP.md` explains product scope. If another guide conflicts with this file, follow this file and repair the conflicting guide.

## Product contract

Total is a local-first Electron accounting application for macOS and Windows. It serves Indian businesses, bookkeepers, accountants, payroll operators, and inventory teams. Core accounting works without an account, AI provider, sync service, or internet connection.

SQLite remains the transactional source of truth, with one database per company. JSON mirrors, portable packages, MCP resources, and agent proposals are integration formats only. Optional Supabase collaboration syncs encrypted drafts and review work, not the live database or posted books.

NIC live filing and online GST portal APIs are excluded from the v0.5 completion scope. Offline GST calculation, review, evidence, and export remain supported.

## Read before changing code

1. Read [TASKS.md](TASKS.md) for current priorities and ownership.
2. Read the relevant guide in [docs/README.md](docs/README.md).
3. Inspect the existing implementation and tests before proposing a new abstraction.
4. Preserve unrelated user changes in a dirty worktree.
5. Do not begin the final merge review until the owner explicitly asks for review.

## Repository layout

```text
src/shared/     Pure engine, types, schemas, calculations, import parsing
src/main/       Electron main process, SQLite, migrations, services, IPC
src/preload/    contextBridge exposure for window.total.invoke
src/renderer/   React interface; main-process calls go through lib/client.ts
site/           Next.js marketing and support website; Vercel root is site
supabase/       Optional collaboration and support/feedback backend assets
scripts/        Tests, E2E drivers, performance gates, release tooling
docs/           Architecture, operations, acceptance, security, and roadmaps
```

## Non-negotiable engineering rules

- Store money as integer paise. Never use floating-point amounts.
- Store quantities as integer thousandths (`qtyMilli`).
- Compute reports from `voucher_lines` and opening balances. Never persist a derived ledger balance.
- Keep `src/shared/` free of Electron and database imports.
- Never import `better-sqlite3` into system-Node unit tests. Database tests use the Electron-as-Node runner.
- Append schema migrations in `src/main/db/migrations.ts`. Never edit an old migration.
- Zod-validate every IPC payload before it reaches a service.
- The renderer calls `window.total.invoke` only through `src/renderer/src/lib/client.ts`.
- Filter soft-deleted vouchers from every normal voucher query.
- Keep provider SDKs, tokens, filesystem operations, SQLite, and network orchestration in the main process.
- Never put secrets in SQLite, JSON mirrors, backups, renderer state, logs, diagnostics, support payloads, tests, examples, or commits.
- AI accounting mutations are proposals. Final posting always requires explicit in-app approval.
- AI filesystem access is disabled by default and limited to owner-approved specific directories. Never grant the filesystem root, home directory, or Total data root.
- Collaboration sync may replicate proposals, drafts, comments, and tasks only. It must not sync the company database or bypass accounting validation.
- Network failures must not prevent offline accounting work.

## UI conventions

- Use Tailwind v4 semantic theme tokens and the existing IBM Plex family.
- Use Phosphor for product icons. Do not introduce a second general icon family.
- Use accessible Radix primitives for dialogs, popovers, and tooltips.
- Preserve the amber selection bar and red mnemonic-letter shortcut treatment.
- Dense accounting tables should favor alignment, hierarchy, keyboard focus, and tabular numbers over decorative cards or motion.
- Support light and dark modes and reduced motion.
- Shortcuts belong in the typed command registry. Do not add isolated global `keydown` listeners.
- Shortcuts must not fire inside editable controls unless the command explicitly supports that context.
- Keep visible copy direct and functional. Avoid inflated marketing language in application surfaces.

## Commands

```bash
npm run dev                 # Electron app with HMR
npm run typecheck           # main/preload/shared and renderer TypeScript
npm test                    # pure and main-side unit tests
npm run test:db             # Electron ABI database tests
npm run test:renderer       # jsdom and React Testing Library
npm run build               # Electron/Vite build and bundled MCP server
npm run smoke               # hermetic IPC smoke test against out/
npm run e2e                 # full built-app E2E suite
npm run test:visual         # visual and accessibility evidence contracts
npm run test:release        # release tooling contract tests
npm run perf:bundle         # renderer bundle budget
npm run security:dependencies
npm run security:audit
npm run security:threat-model
```

Website:

```bash
cd site
npm run dev
npm test
npm run build
```

Run `npm run build` before desktop smoke, E2E, or visual drivers. Filter E2E scenarios with `node scripts/run-e2e.mjs 03 11 45`.

If Electron reports a `better-sqlite3` ABI mismatch:

```bash
npx @electron/rebuild -f -w better-sqlite3
```

## Automation safety

Automation must set an isolated absolute `TOTAL_DATA_DIR` and `TOTAL_SUPPRESS_SYNC_WARNING=1`. Never point a driver at `~/Documents/total/`. Do not delete broad paths, user data, or unrelated worktree changes.

Use `rg` and `rg --files` for repository search. Use `apply_patch` for hand edits. Keep commits scoped and independently understandable.

Before claiming an implementation complete, run at minimum:

```bash
npm run typecheck
npm test
```

Run proportionate database, renderer, build, E2E, visual, website, security, and release gates for affected areas. Report the exact gates and any unavailable verification honestly.

## AI and MCP

- Provider configuration supports OpenAI, HTTPS OpenAI-compatible providers, and explicit loopback HTTP providers.
- OpenAI orchestration uses the official SDK in the main process.
- Codex device authentication runs the installed `codex login --device-auth` command. Total does not read or store ChatGPT credentials.
- The AI Operator presents a plan before execution. Navigation and read actions can execute; accounting creates proposals; file changes follow the configured approval mode.
- Local OCR uses bundled Tesseract English data and produces reviewable extraction results.
- `total-mcp` uses stdio and a paired local broker. It has read and proposal tools but no posting tool.

See [docs/AI_OPERATIONS.md](docs/AI_OPERATIONS.md) and [docs/MCP_CONTRACT_V1.md](docs/MCP_CONTRACT_V1.md).

## Optional Supabase services

Supabase is used for two separate optional surfaces:

1. encrypted collaboration envelopes and team membership;
2. hosted support and feedback intake.

Apply the migrations and deploy the functions under `supabase/`. Keep service-role credentials inside Supabase. The desktop uses a signed-in user's access token for collaboration. Vercel uses a dedicated intake secret for server-to-server support delivery.

See [docs/ENCRYPTED_COLLABORATION.md](docs/ENCRYPTED_COLLABORATION.md) and [site/INTAKE_OPERATIONS.md](site/INTAKE_OPERATIONS.md).

## Release process

Do not tag manually.

1. Complete implementation and ordinary CI on a review branch.
2. Run the final review only when the owner requests it.
3. Merge the reviewed commit to `main`.
4. Dispatch the protected release-candidate workflow with the exact commit SHA and version.
5. Use the signed candidate artifacts for migration, install, upgrade, backup/restore, and human acceptance evidence.
6. Merge only sanitized evidence linked to exact artifact digests.
7. Dispatch promotion with the candidate run and artifact identity. Promotion revalidates and publishes the same bytes.
8. Verify downloads, updater metadata, support intake, and staged rollout behavior.

The `v5-cloud-agent-sync` workflow is test-only. It creates unsigned, non-publishing macOS and Windows packages and content-addressed manifests.

Authoritative details: [docs/RELEASE_RUNBOOK.md](docs/RELEASE_RUNBOOK.md), [docs/PRODUCTION_CUTOVER.md](docs/PRODUCTION_CUTOVER.md), and [docs/STAGED_UPDATES.md](docs/STAGED_UPDATES.md).

## Current handoff

The active v5 branch is `v5-cloud-agent-sync`, with draft PR [#4](https://github.com/IrminFlow/total/pull/4). The branch CI and unsigned package workflows are green. Remaining work depends primarily on Supabase/Vercel setup, signing identities, real service acceptance, final review, and release approval. Keep [TASKS.md](TASKS.md) current as this changes.
