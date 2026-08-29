# Agent instructions for Total

Read [CLAUDE.md](CLAUDE.md) completely before changing code. It is the authoritative engineering and release guide. Read [TASKS.md](TASKS.md) for current work and [docs/README.md](docs/README.md) for topic-specific guides.

## Product boundary

Total is a local-first Electron accounting application for macOS and Windows. SQLite is authoritative. Optional AI, MCP, Supabase collaboration, support delivery, and update services must not weaken offline accounting or approval controls. NIC live filing and online GST portal APIs are excluded from v5.

## Required invariants

- Money uses integer paise; quantity uses integer thousandths.
- Reports derive from `voucher_lines`; never store derived balances.
- `src/shared/` remains pure TypeScript.
- Append migrations; never rewrite migration history.
- Zod-validate IPC inputs.
- Renderer access goes through the typed client only.
- Filter soft-deleted vouchers from ordinary queries.
- Secrets never enter books, mirrors, backups, renderer state, logs, support payloads, or commits.
- AI may propose accounting work but cannot post it directly.
- Sync may replicate review work but not the company database or posted books.
- Automated tests use an isolated `TOTAL_DATA_DIR`.

## Completion gates

Every change requires:

```bash
npm run typecheck
npm test
```

Database changes also require `npm run test:db`. Renderer changes require `npm run test:renderer`, `npm run build`, and relevant E2E or visual scenarios. Website changes require `cd site && npm test && npm run build`. Release or security changes require the corresponding release-contract and security gates.

## Current branch protocol

Work on `v5-cloud-agent-sync` and draft PR [#4](https://github.com/IrminFlow/total/pull/4) unless the owner changes direction. Do not start the final merge review until the owner explicitly asks for it. Do not create a release tag manually.
