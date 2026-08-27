# Agent-owned task list

Last updated: 28 August 2026.

This file tracks work a coding agent can perform. Human-only account, credential, business, and acceptance actions live in [HUMAN.md](HUMAN.md). Product scope and feature explanations live in [ROADMAP.md](ROADMAP.md).

Status vocabulary:

- `DONE`: implemented and verified on the current branch
- `READY`: can be performed without new credentials or a product decision
- `WAITING`: implementation exists but the next step needs a human action
- `MERGE`: reserved for the final review and merge sequence
- `LATER`: deliberately scheduled after v5.0

## Current verified baseline

- `DONE` Branch `v5-cloud-agent-sync` is pushed.
- `DONE` Draft PR [#4](https://github.com/IrminFlow/total/pull/4) is mergeable and clean.
- `DONE` GitHub application, database, renderer, E2E, visual, website, macOS, and Windows checks pass.
- `DONE` Unsigned macOS and Windows test packages and content-addressed manifests were produced.
- `DONE` Encrypted collaboration, distinct-user invitations, support intake, offline OCR, AI Operator, Codex device authentication, Radix primitives, and staged rollout code are implemented.
- `DONE` NIC live filing and online GST portal APIs remain excluded.

## Ready now

- `READY` Keep root documentation and topic guides consistent.
  - Update `ROADMAP.md` when scope or status changes.
  - Update `HUMAN.md` when an external action is completed.
  - Update this file whenever an agent task changes status.
  - Keep [docs/README.md](docs/README.md) complete when adding a guide.

- `READY` Maintain branch health while credentials are pending.
  - Rebase or merge `main` only when necessary and without rewriting shared history.
  - Rerun focused tests after every correction.
  - Keep PR #4 in draft until the owner requests final review.

- `READY` Expand automated AI Operator coverage.
  - Add pure schema tests for all action types and plan bounds.
  - Add service tests for approved-root traversal, symlink rejection, size limits, binary rejection, and approval modes.
  - Add mocked-provider tests for malformed plans, cancellation, and unsupported compatible-provider responses.
  - Add E2E coverage for AI-disabled, plan preview, per-action execution, file approval, and accounting proposal handoff.

- `READY` Expand encrypted-collaboration protocol coverage.
  - Add Edge Function contract tests for invitation expiry, revocation, reuse, wrong-user acceptance, and workspace ownership.
  - Add deterministic offline/concurrent edit fixtures and visible conflict-resolution tests.
  - Add retry, cursor replay, duplicate-envelope, corrupt-signature, oversized-response, and app-closed tests.
  - Add a local Supabase-compatible test harness if it can remain hermetic in CI.

- `READY` Expand offline OCR acceptance.
  - Add reviewed fixtures for clean scans, phone photos, rotations, low contrast, multiple tax rates, and unreadable fields.
  - Record extraction accuracy separately from provider OCR.
  - Add language packs only when a real acceptance corpus exists; do not claim unsupported languages.

- `READY` Improve observability without collecting book content.
  - Add explicit local sync state and last-error diagnostics.
  - Add allowlisted production probes for support delivery, feedback delivery, update manifests, TLS, and download redirects.
  - Keep amounts, names, GSTINs, vouchers, document bodies, tokens, and recovery material out of telemetry.

- `READY` Update incomplete security documentation.
  - Add Supabase intake secret, user access token, recovery key, device signing key, Codex credential boundary, and OCR asset trust to [docs/SECURITY_SECRET_INVENTORY.md](docs/SECURITY_SECRET_INVENTORY.md).
  - Update [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for collaboration invitations, encrypted envelopes, AI filesystem roots, device-auth subprocesses, and intake duplication.
  - Update [docs/AI_OPERATIONS.md](docs/AI_OPERATIONS.md) for Operator actions, approval modes, Codex login, and offline OCR.

- `READY` Remove status ambiguity from legacy planning documents.
  - Make [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) clearly distinguish code-complete, configured, accepted, and released.
  - Mark [docs/BACKLOG_300.md](docs/BACKLOG_300.md) as the historical opportunity catalogue rather than the current execution list.
  - Keep `ROADMAP.md` as the current product source of truth.

## Waiting for authenticated services

- `WAITING` Deploy Supabase migrations and functions.
  - Blocker: product owner must create the project and authenticate `supabase login`.
  - Agent action after unblock: link the project, push migrations, deploy `total-sync` and `total-intake`, verify RLS and bounded request behavior, and record redacted evidence.

- `WAITING` Configure Vercel production environment and redeploy.
  - Blocker: product owner must authenticate Vercel or set values in the dashboard.
  - Agent action after unblock: validate required variable names, deploy, verify `/api/deployment`, support, feedback, download, headers, and update routes.

- `WAITING` Run real two-user encrypted collaboration acceptance.
  - Blocker: two authenticated Supabase test users and a deployed backend.
  - Agent action after unblock: execute invitation, revoke, accept, bidirectional sync, offline retry, conflict, and no-posted-books checks.

- `WAITING` Run production support and feedback acceptance.
  - Blocker: deployed Vercel, Blob, Supabase, and optional Resend configuration.
  - Agent action after unblock: synthetic create, track, resolve, reopen, vote, follow, failure fallback, exact deletion, and retention evidence.

- `WAITING` Build signed release candidates.
  - Blocker: Apple and Windows signing secrets in the protected GitHub environment.
  - Agent action after unblock: dispatch candidate workflow, verify signatures/notarization, download exact artifacts, and bind evidence to their digests.

- `WAITING` Reconcile real migration samples.
  - Blocker: synthetic or consented Tally, Busy, Marg, Zoho, and spreadsheet exports.
  - Agent action after unblock: run dry-run imports and compare openings, vouchers, receivables, payables, stock, tax, and attachments.

## Final review and merge

- `MERGE` Wait for the owner to say “start the final review.” Do not begin earlier.
- `MERGE` Review the complete PR against `main`, including generated workflows and release boundaries.
- `MERGE` Correct every confirmed finding in reviewable commits.
- `MERGE` Run the full gate matrix on the final commit:

```bash
npm run typecheck
npm test
npm run test:db
npm run test:renderer
npm run build
npm run smoke
npm run e2e
npm run test:visual
npm run test:release
npm run perf:bundle
npm run security:dependencies
npm run security:audit
npm run security:threat-model
cd site && npm test && npm run build
```

- `MERGE` Confirm the PR is clean, mergeable, fully green, and still contains no NIC/GST online API dependency.
- `MERGE` Move the PR from draft only after review findings are resolved.
- `MERGE` Merge through GitHub after owner approval. Do not manually tag.

## Release sequence after merge

- `WAITING` Confirm exact `main` SHA and version.
- `WAITING` Dispatch the protected release-candidate workflow.
- `WAITING` Validate signed macOS and Windows artifacts, update metadata, install, v0.4 upgrade, backup/restore, and uninstall data preservation.
- `WAITING` Attach only sanitized, digest-bound acceptance evidence.
- `WAITING` Promote the same candidate bytes.
- `WAITING` Verify public downloads and updater behavior.
- `WAITING` Roll out internal, beta, 10%, 50%, then 100%, preserving the cohort salt.
- `WAITING` Use kill switches immediately if accounting, migration, credential, support, accessibility, signing, or updater blockers appear.

## Post-v5 work

- `LATER` Additional OCR languages based on reviewed user documents.
- `LATER` Hosted customer and supplier portals.
- `LATER` Broader payment, bank-feed, e-commerce, courier, WhatsApp Business, and SMTP connectors that require provider agreements or credentials.
- `LATER` More granular collaborative entity types only after the review-only sync lane proves safe.
- `LATER` Optional encrypted cloud backup to user-owned storage.
- `LATER` Native mobile companion only if the product strategy changes; the v5 product is a desktop application.
- `LATER` NIC live filing and online GST APIs only under a separate approved project.

## Rules for updating this file

- Do not mark a service `DONE` because code exists. It is done only when the stated validation level has passed.
- Do not fabricate human acceptance, credential configuration, notification delivery, migration reconciliation, signatures, or legal review.
- Do not turn a deferred provider integration into a release blocker unless the release claims that integration.
- Link every new task to the relevant source file, test, guide, PR, or evidence artifact.
