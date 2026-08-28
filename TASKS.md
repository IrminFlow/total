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
- `DONE` The isolated Supabase staging project `cewz…qmlx` has all migrations through
  `202608280002_collaboration_devices.sql`. `total-sync` v9 and `total-intake` v10 are active, and an
  unauthenticated `total-sync` request returns HTTP 401.
- `DONE` The isolated staging site has support and feedback delivery configured. Synthetic support
  create/private-token tracking and feedback idea/vote/follow checks passed against staging.
- `DONE` Desktop and website support intake expose severity and privacy/deletion requests. Desktop
  diagnostics use a random device-scoped installation reference and exclude company/user identity,
  books, file paths, logs and credentials unless the user separately opts into allowed context.
- `DONE` Branch desktop packages compile the staging origin into `app.asar` and disable update
  checks. The package contract rejects production origins in a staging artifact.
- `DONE` NIC live filing and online GST portal APIs remain excluded.

## Ready now

- `READY` Complete the fail-closed [v5 staging readiness checklist](docs/STAGING_READINESS_CHECKLIST.md)
  against one exact branch commit before admitting external testers. Keep staging services, data,
  notifications, downloads and domains isolated from production; platform verification is a later
  release gate and is not part of this admission checklist.

- `READY` Keep root documentation and topic guides consistent.
  - Update `ROADMAP.md` when scope or status changes.
  - Update `HUMAN.md` when an external action is completed.
  - Update this file whenever an agent task changes status.
  - Keep [docs/README.md](docs/README.md) complete when adding a guide.

- `READY` Maintain branch health while credentials are pending.
  - Rebase or merge `main` only when necessary and without rewriting shared history.
  - Rerun focused tests after every correction.
  - Keep PR #4 in draft until the owner requests final review.

- `DONE` Automated AI Operator coverage is complete for the v5 contract.
  - `DONE` Pure schemas cover every action kind and plan/content bounds.
  - `DONE` Service tests cover root containment, symlinks, file kinds and sizes, approval modes,
    retained company/user/action binding, one-time approval tokens and expiry.
  - `DONE` Mocked-provider tests cover malformed plans, cancellation, and unsupported
    compatible-provider responses.
  - `DONE` Installed-app E2E covers AI-disabled fallback, plan preview, per-action execution,
    exact file approval, delayed provider context and accounting proposal handoff without posting.

- `DONE` Automated encrypted-collaboration protocol coverage is complete for the v5 contract.
  - `DONE` Edge contracts cover invitation expiry, revocation, reuse, caller binding, ownership,
    idempotent upload, cursors and request bounds.
  - `DONE` Database and session tests cover offline retry, concurrent edits, duplicate envelopes,
    signature quarantine, oversized responses, app-closed delivery and token refresh/revocation.
  - `DONE` A hermetic local relay exercises conflict resolution, offline retry and app-closed
    delivery in database tests.
  - Real two-user acceptance remains separately `WAITING` below because it requires two identities.

- `DONE` Offline OCR parser acceptance covers reviewed clean, phone-like, rotated, low-contrast,
  multiple-tax-rate and unreadable recognition output, with accuracy recorded separately from any
  provider route. Binary camera-image accuracy remains a human acceptance gate; unsupported
  languages are not claimed.

- `DONE` Privacy-safe observability and production probe code is implemented.
  - `DONE` Settings shows local sync phase, pending/conflict/quarantine counts, last attempt, last
    success and a bounded last security/error message without envelope or book content.
  - `DONE` Allowlisted probes cover support delivery, feedback delivery, update manifests, TLS and
    download redirects. Running them against production remains an external deployment gate.
  - Keep amounts, names, GSTINs, vouchers, document bodies, tokens, and recovery material out of telemetry.

- `DONE` Security and operating documentation covers collaboration credentials and refresh,
  envelope signing and quarantine, AI retained-plan approvals, private support tracking tokens,
  migration deduplication and attachment handling, and the isolated desktop staging profile.

- `DONE` Status ambiguity is removed from the planning documents.
  - Make [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) clearly distinguish code-complete, configured, accepted, and released.
  - Mark [docs/BACKLOG_300.md](docs/BACKLOG_300.md) as the historical opportunity catalogue rather than the current execution list.
  - Keep `ROADMAP.md` as the current product source of truth.

## Staging services complete; production remains pending

- `DONE` Supabase staging deployment and unauthenticated-boundary probe.
  - The staging project exists, the four current migrations are applied, both Edge Functions are at
    v9, and `total-sync` rejects an unauthenticated request with HTTP 401.
  - This does not configure or approve a production Supabase project.

- `WAITING` Configure Vercel production environment and redeploy.
  - Blocker: product owner must authenticate Vercel or set values in the dashboard.
  - Agent action after unblock: validate required variable names, deploy, verify `/api/deployment`, support, feedback, download, headers, and update routes.

- `WAITING` Run real two-user encrypted collaboration acceptance.
  - Blocker: two authenticated Supabase test users on separate client sessions. The staging backend
    is deployed; the real invitation, refresh, device-signature, quarantine and bidirectional-sync
    exercise has not been completed.
  - Agent action after unblock: execute invitation, revoke, accept, bidirectional sync, offline retry, conflict, and no-posted-books checks.

- `WAITING` Run production support and feedback acceptance.
  - Blocker: deployed Vercel, Blob, Supabase, and optional Resend configuration.
  - Agent action after unblock: synthetic create, track, resolve, reopen, vote, follow, failure fallback, exact deletion, and retention evidence.

- `WAITING` Build signed release candidates.
  - Blocker: Apple and Windows signing secrets in the protected GitHub environment.
  - Agent action after unblock: dispatch candidate workflow, verify signatures/notarization, download exact artifacts, and bind evidence to their digests.

- `WAITING` Reconcile real migration samples.
  - Blocker: representative consented customer exports for Tally, Busy, Marg, Zoho, and
    spreadsheets. Repository fixtures test behavior but are not customer migration acceptance.
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
