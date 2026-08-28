# v5 staging readiness checklist

Last updated: 28 August 2026.

Use this checklist to decide whether one exact Total v5 commit may enter the isolated staging
environment. It is an admission gate, not a production-release approval. Every required box must be
checked against the same commit and deployment. A passing result from another revision is not valid.

Platform signing, notarization, installer, operating-system upgrade, clean-machine, and
platform-specific verification are intentionally outside this checklist.

## Completion record

Complete this block before running any gate. Do not use a branch name where a full immutable SHA is
requested.

- [ ] Product version: `5.0.0`
- [ ] Source branch: `v5-cloud-agent-sync`
- [ ] Full source commit SHA: `________________________________________`
- [ ] Draft PR: `https://github.com/IrminFlow/total/pull/4`
- [ ] Staging website origin: `________________________________________`
- [ ] Staging deployment ID: `________________________________________`
- [ ] Staging Supabase project reference or isolated backend ID: `________________`
- [ ] Staging support-store ID: `________________________________________`
- [ ] Evidence directory outside customer-data locations: `________________________`
- [ ] Gate started at, in UTC: `________________________________________`
- [ ] Gate owner: `________________________________________`

Rules for this record:

- [ ] The source SHA is 40 lowercase hexadecimal characters and exists on the remote branch.
- [ ] The application and website report the same version.
- [ ] `/api/deployment` reports the recorded SHA, deployment ID, and product version.
- [ ] Evidence names include the source SHA and execution timestamp.
- [ ] Evidence contains statuses, counts, hashes, and redacted errors only—never secrets or book data.
- [ ] A failed item is fixed and rerun. It is never converted to `N/A` to obtain approval.
- [ ] A genuinely inapplicable item records a reason and named approver beside the checkbox.

## 1. Environment isolation

- [ ] Staging uses a separate Vercel project or an equivalent isolated hosting project.
- [ ] The staging deployment has its own URL and is not aliased to `devjindal.tech`.
- [ ] No production domain, production deployment, or `main` branch setting is changed.
- [ ] Staging uses a separate Supabase project, or a deliberately isolated staging namespace with
      independently verified RLS and no production rows.
- [ ] Support cases, feedback, rate-limit records, retention indexes, and attachments use a staging
      store—not the production support store.
- [ ] Staging notifications go only to an allowlisted test inbox or mail sink.
- [ ] Staging AI credentials have a separate project, explicit spend limit, and no production data
      access.
- [ ] Staging provider tokens, webhook secrets, recovery keys, and signing keys are different from
      production values.
- [ ] Staging contains only generated, synthetic, or explicitly consented and redacted data.
- [ ] Analytics and error reporting are disabled or point to a separate staging dataset.
- [ ] The update feed and branch downloads cannot become the production `latest` release.
- [ ] Staging kill switches can disable AI, MCP, collaboration, support upload, feedback delivery,
      telemetry, and update offers independently.

Stop if any staging service can read, write, notify, update, or delete production state.

## 2. Exact source and repository hygiene

Run these checks from the repository root:

```bash
git fetch origin --prune
git branch --show-current
git rev-parse HEAD
git rev-parse origin/v5-cloud-agent-sync
git status --short
git diff --check
node -p "require('./package.json').version"
node -p "require('./site/package.json').version"
gh pr view 4 --json headRefName,headRefOid,isDraft,state,mergeable,url
```

- [ ] The current branch is `v5-cloud-agent-sync`.
- [ ] Local `HEAD`, the remote branch SHA, the PR head SHA, and the completion record all match.
- [ ] The PR remains a draft unless the owner separately requests final review.
- [ ] The working tree is clean for the candidate commit. Local experiments are not part of staging.
- [ ] `git diff --check` reports no whitespace or conflict-marker errors.
- [ ] Root and website package versions both equal `5.0.0`.
- [ ] Lockfiles match their package manifests and both dependency trees install with `npm ci`.
- [ ] Generated output, credentials, `.env` files, databases, documents, and customer exports are not
      tracked.
- [ ] New database changes append migrations; existing migration history is unchanged.
- [ ] No merge commit, tag, GitHub Release, or production deployment is created as part of staging
      admission.

## 3. Automated quality gates

Run all commands against the recorded SHA. Use an isolated absolute `TOTAL_DATA_DIR` for every app
driver and database-producing process. Never point automation at a real Total data directory.

```bash
npm ci
npm run typecheck
npm test
npm run test:db
npm run test:renderer
npm run build
npm run smoke
npm run e2e
npm run test:visual
npm run test:release
npm run test:large
npm run test:chaos
npm run perf:bundle
npm run security:dependencies
npm run security:audit
npm run security:threat-model

cd site
npm ci
npm test
npm run build
```

- [ ] Every command exits successfully.
- [ ] No required suite is skipped, silently filtered, retried until green, or replaced by a narrower
      command.
- [ ] The E2E runner executes the requested scenarios exactly once and uses only isolated data.
- [ ] Visual evidence covers light, dark, reduced-motion, keyboard focus, loading, empty, error, and
      large-data states at the documented desktop viewport sizes.
- [ ] Bundle budgets pass with useful headroom; a warning close to the limit has an owner and task.
- [ ] Dependency and security gates contain no unresolved high or critical production finding.
- [ ] Test output is saved with the source SHA and contains no tokens, customer data, local home paths,
      or sensitive fixture content.

## 4. Accounting and report integrity

Use a fresh synthetic company and a deterministic seeded company. Record the opening trial balance
and final trial balance for comparison.

- [ ] Every supported voucher kind can be drafted, validated, posted through the normal service path,
      reopened, and viewed in Day Book.
- [ ] Every posted voucher remains exactly balanced in integer paise.
- [ ] Quantities remain integer thousandths throughout entry, inventory, reports, imports, and export.
- [ ] Ordinary queries omit soft-deleted vouchers, while authorized recovery can find and restore them.
- [ ] Period locks reject prohibited posting, deletion, AI proposals, and imported changes.
- [ ] Duplicate invoice and voucher warnings appear without blocking legitimate distinct entries.
- [ ] Trial Balance, Profit and Loss, Balance Sheet, Cash Flow, ledgers, outstandings, stock, GST, TDS,
      payroll, and banking reports derive from voucher lines and reconcile to the seeded expectations.
- [ ] Monthly Sales and Purchase registers match quarterly totals exactly.
- [ ] Indian financial-year quarters use Apr–Jun, Jul–Sep, Oct–Dec, and Jan–Mar boundaries.
- [ ] Quarterly drill-through opens Day Book with the exact date range and voucher kind.
- [ ] Quarterly PDF and CSV labels and totals match the selected period.
- [ ] Partial, empty, Jan–Mar, and cross-financial-year report periods behave correctly.
- [ ] Prior-period comparisons never mix financial years or silently change filters.
- [ ] Receivables, payables, inventory valuation, tax totals, and cash balances agree before and after
      backup and restore.
- [ ] NIC live filing and online GST portal actions remain absent from the staging release claim.

Any unexplained one-paise difference, unbalanced posting, stored derived balance, missing soft-delete
filter, or report mismatch is an immediate staging no-go.

## 5. Database, migration, backup, and recovery

- [ ] A new company reaches the current schema with `quick_check` and `foreign_key_check` passing.
- [ ] Every repository migration fixture reaches the current schema without rewriting migration
      history.
- [ ] A simulated migration failure restores the verified pre-migration snapshot.
- [ ] Startup refuses an unsupported future schema rather than attempting a destructive downgrade.
- [ ] Backup creation, verification, listing, restore preview, and restore complete successfully in an
      isolated data directory.
- [ ] A corrupt, truncated, wrong-passphrase, or checksum-mismatched backup fails closed.
- [ ] Restoring one company cannot overwrite or expose another company.
- [ ] Repeated company switching closes old handles and never mixes ledgers, attachments, drafts, or
      report caches.
- [ ] Attachment files and metadata remain checksum-consistent through backup and restore.
- [ ] The JSON mirror manifest includes stable IDs, schema version, generation time, units, and
      checksums.
- [ ] Direct JSON edits do not mutate books; only validated proposals can reach review.
- [ ] Proposal processing moves accepted and failed files to the documented outcome directories.
- [ ] No API key, access token, recovery key, or device private key appears in a database, mirror,
      backup, portable export, or diagnostic bundle.

## 6. Imports and exports

- [ ] Tally XML, Busy, Marg, Zoho Books, CSV, XLSX, and portable-package parsers reject malformed and
      oversized input within bounded time and memory.
- [ ] Import preview identifies counts, mappings, warnings, duplicates, and unsupported rows before
      any transaction begins.
- [ ] Import cancellation and validation failure leave the company unchanged.
- [ ] Successful synthetic imports reconcile openings, vouchers, receivables, payables, stock, tax,
      and attachments against expected values.
- [ ] Spreadsheet formula injection, external links, malformed XML entities, corrupt images, and
      unsafe archive paths fail closed.
- [ ] PDF, CSV, XLSX, JSON, and portable exports contain the selected scope and no hidden unrelated
      company data.
- [ ] Portable export round trips preserve stable identifiers, units, checksums, and supported
      accounting content.
- [ ] Exported filenames are bounded and safe on common filesystems.

Real customer migration acceptance may remain a later release gate, but staging must not claim it was
performed when only synthetic fixtures were used.

## 7. Keyboard, accessibility, and workflow acceptance

- [ ] The typed command registry is the only global shortcut source and reports no collisions.
- [ ] Bare `V` opens Voucher Entry from Home.
- [ ] Voucher keys `C`, `P`, `R`, `J`, `S`, `U`, `N`, `D`, `K`, and `H` select the documented kinds.
- [ ] The corresponding `Alt` bindings work in voucher context without corrupting active edits.
- [ ] Existing function-key voucher shortcuts remain compatible.
- [ ] Shortcuts do not fire while typing in inputs, selects, textareas, or content-editable controls.
- [ ] Modal, editor, voucher, screen, and global shortcut priority behaves in that order.
- [ ] Unsaved-change, period-lock, permission, and destructive-action guards cannot be bypassed with a
      shortcut or command-palette action.
- [ ] Every navigation item exposes its mnemonic visually; red is used only for mnemonic letters.
- [ ] Keyboard-only users can reach, operate, and leave every dialog, table, menu, and popover.
- [ ] Focus is visible, restored after dialogs, and never trapped behind an overlay.
- [ ] Semantic names, contrast, tab order, error association, reduced motion, and zoom pass the
      accessibility contract.
- [ ] Loading, empty, permission-denied, offline, provider-error, and large-result states give a clear
      next action.
- [ ] Onboarding covers company creation, import, first voucher, backup, GST setup, and shortcut help.

## 8. AI, Operator, OCR, and MCP boundaries

- [ ] All accounting and reporting workflows remain usable with AI disabled and without internet.
- [ ] Provider tests cover OpenAI, HTTPS OpenAI-compatible endpoints, and explicit loopback HTTP only.
- [ ] Provider keys remain in OS-backed secure storage and are never returned to the renderer.
- [ ] Context preview lists exactly what will leave the device before an AI request is sent.
- [ ] Cancellation, timeout, network loss, rate limit, malformed response, and unsupported-provider
      behavior fail without changing books.
- [ ] Prompt-injected documents cannot obtain shell, SQL, credential, arbitrary filesystem, or open
      network access.
- [ ] Every accounting mutation becomes a reviewable proposal with balanced totals and warnings.
- [ ] AI cannot post, approve, bypass roles, bypass period locks, or hide affected ledgers.
- [ ] Operator is disabled by default and rejects the filesystem root, home directory, Total data
      directory, symlinks, binary files, and oversized text files.
- [ ] Every Operator plan is shown before execution; file writes follow the configured approval mode.
- [ ] Codex device authentication leaves credentials owned by the Codex CLI and records only bounded
      status output.
- [ ] Offline OCR works without a provider and always creates reviewable extraction results.
- [ ] Low-confidence, rotated, low-contrast, multi-rate, and unreadable OCR samples remain visibly
      flagged; no OCR output posts automatically.
- [ ] MCP uses stdio and authenticated local pairing only; no remote listener opens.
- [ ] MCP role, company, expiry, replay, app-closed, and bad-pairing failures return bounded errors.
- [ ] MCP provides read and proposal tools only and has no route that commits accounting changes.

## 9. Encrypted collaboration

- [ ] Collaboration is optional, off by default, and a failed service never blocks local accounting.
- [ ] Only drafts, proposals, comments, tasks, conflict records, and required routing metadata enter the
      sync lane; the company database and posted books do not.
- [ ] Requests require the signed-in user's short-lived access token and verified workspace membership.
- [ ] Invitation creation, expiry, revocation, single use, wrong-user acceptance, and ownership checks
      pass against staging.
- [ ] Invitation codes are stored only as hashes; recovery keys travel through a different trusted
      channel.
- [ ] Envelopes are authenticated and encrypted before upload; corrupt signatures fail closed.
- [ ] Request and response limits enforce 100 envelopes and 2 MB.
- [ ] Duplicate envelopes, cursor replay, offline retry, concurrent edits, and visible conflicts are
      deterministic and idempotent.
- [ ] App-closed and paused states preserve the outbox without spinning or losing work.
- [ ] Local diagnostics show phase, pending count, conflict count, last attempt, last success, and a
      bounded redacted error.
- [ ] Logs and diagnostics contain no tokens, recovery material, envelope bodies, names, GSTINs,
      vouchers, or accounting amounts.

## 10. Staging website and API configuration

Record only whether each variable is present and scoped correctly. Never copy its value into this
checklist or evidence.

- [ ] `NEXT_PUBLIC_SITE_URL` contains only the staging HTTPS origin.
- [ ] `GITHUB_TOKEN` is read-only and limited to the required repository resources.
- [ ] `BLOB_READ_WRITE_TOKEN` points to the private staging intake store.
- [ ] `INTAKE_SECURITY_SECRET`, `INTAKE_ADMIN_SECRET`, and `CRON_SECRET` are present, independently
      generated, and at least 32 random characters where required.
- [ ] `SUPABASE_SUPPORT_URL` and `SUPABASE_FEEDBACK_URL` point only to staging functions.
- [ ] `SUPABASE_INTAKE_SECRET` matches staging `TOTAL_INTAKE_SECRET` and no other secret.
- [ ] Optional provider secrets are set only when their corresponding staging destination exists.
- [ ] No server secret uses a `NEXT_PUBLIC_` prefix.
- [ ] Administration, cron, HMAC, storage, provider, collaboration, AI, and test-download credentials
      are distinct trust boundaries.
- [ ] Vercel system deployment metadata is enabled, or explicit staging-only revision and deployment
      values are configured.
- [ ] The deployment command is executed from the isolated staging project and cannot target the
      production project by default.

After deployment:

```bash
curl -fsS "$TOTAL_STAGING_URL/api/deployment"
curl -fsSI "$TOTAL_STAGING_URL/"
curl -fsSI "$TOTAL_STAGING_URL/support"
curl -fsSI "$TOTAL_STAGING_URL/feedback"
curl -fsSI "$TOTAL_STAGING_URL/privacy"
curl -fsSI "$TOTAL_STAGING_URL/security"
```

- [ ] `/api/deployment` matches the completion record and sends `Cache-Control: private, no-store`.
- [ ] Home, support, feedback, pricing, privacy, terms, security, documentation, and capture routes
      return their intended status without a cross-origin redirect.
- [ ] Strict transport security, CSP, frame denial, MIME sniffing denial, referrer policy, and
      permissions policy are present.
- [ ] CSP allows only documented app resources and provider connections.
- [ ] Robots and sitemap behavior are intentional for staging; staging is not accidentally indexed.
- [ ] Error pages disclose no stack, environment value, token, filesystem path, or provider response.

## 11. Support, feedback, retention, and abuse controls

Use unique synthetic identifiers for this candidate, then delete every created object.

- [ ] Submit a synthetic support case through the public staging form.
- [ ] Confirm its case ID, anonymous tracking, initial status, private durable record, and intended
      staging notification.
- [ ] Resolve, reopen, and resolve the case through authenticated administration.
- [ ] Exercise provider failure and confirm the durable case remains available with a clear fallback.
- [ ] Submit synthetic feedback, then vote and follow it.
- [ ] Confirm feedback aggregation is correct and duplicate operations remain idempotent.
- [ ] Exercise attachment type, size, consent, and offline retry controls with synthetic files only.
- [ ] Confirm default diagnostics contain only version, platform, architecture, schema/integrity state,
      and allowlisted redacted logs.
- [ ] Confirm amounts, names, GSTINs, vouchers, databases, attachments, document bodies, tokens, and
      keys are absent unless a tester deliberately attaches synthetic material.
- [ ] Rate limiting, deduplication, malformed references, cross-origin requests, oversized payloads,
      and repeated abuse fail with generic bounded responses.
- [ ] Create and release a temporary retention hold, then confirm the original deletion deadline is
      restored.
- [ ] Run bounded retention maintenance and verify indexes, pointers, status history, provider copies,
      and primary objects are handled consistently.
- [ ] Delete the exact synthetic support and feedback objects and prove no staging copy remains.
- [ ] Notification failure never deletes or loses the durable case.

## 12. Security and privacy admission

- [ ] The current threat model covers Electron boundaries, IPC, imports, AI, Operator filesystem roots,
      MCP pairing, collaboration invitations, encrypted envelopes, intake duplication, and updates.
- [ ] Every credential class used by staging appears in the secret inventory with storage, exposure,
      backup, and rotation rules.
- [ ] Secret scanning covers tracked files, generated configuration, example manifests, logs, and
      evidence.
- [ ] IPC payloads are Zod-validated, permission-checked, bounded, and handled in the main process.
- [ ] Renderer code cannot access Node, arbitrary filesystem, credentials, SQLite, or unrestricted
      network APIs.
- [ ] Electron renderer windows use sandboxing, context isolation, strict navigation and popup
      allowlists, safe external links, and permission denial by default.
- [ ] Logs use allowlisted fields and redact bearer tokens, API keys, email addresses, paths, GSTINs,
      company names, document content, and accounting data.
- [ ] Malicious XML, spreadsheets, images, archives, plugin manifests, MCP payloads, and AI responses
      are covered by bounded negative tests.
- [ ] Staging data retention and deletion periods are documented and executable.
- [ ] A tester can delete AI history, revoke MCP access, disable collaboration, clear provider
      credentials, and remove staging support data.
- [ ] No production credential appears in staging environment metadata or provider dashboards.

## 13. Observability and failure drills

- [ ] Health probes cover deployment identity, required routes, TLS, security headers, Supabase
      functions, support delivery, feedback delivery, and retention maintenance.
- [ ] Probes store status, duration, count, version, and redacted error class only.
- [ ] Staging alerts have an owner and a tested destination.
- [ ] A backend outage leaves local books usable and produces one bounded actionable status.
- [ ] An AI outage disables AI work without affecting manual work.
- [ ] A support-provider outage preserves queued or durable submissions.
- [ ] A collaboration outage preserves the local outbox and backs off retries.
- [ ] An invalid update response produces no update offer.
- [ ] Repeated company switching, imports, backups, large reports, and sync retries complete a bounded
      soak without growing handles, timers, queues, or memory without limit.
- [ ] Kill switches are exercised once in staging and their recovery path is documented.
- [ ] The person on duty knows where to find deployment logs, redacted app diagnostics, support state,
      sync state, and rollback controls.

## 14. Product and tester readiness

- [ ] Staging has deterministic demo companies for a business owner, bookkeeper, accountant, payroll
      operator, and inventory/manufacturing user.
- [ ] Test accounts use distinct roles; expected permissions and denied actions are documented.
- [ ] Demo data is unmistakably synthetic and can be recreated from source-controlled generators.
- [ ] Release notes describe what changed, what remains offline, and what is excluded.
- [ ] The staging banner says the build is test-only, identifies version and short SHA, and links to
      the staging support form.
- [ ] Known limitations and reset instructions are visible to testers before they begin.
- [ ] Support contact information is visible in the stable utility area.
- [ ] Help covers shortcuts, quarterly registers, backup, restore, imports, AI privacy, MCP pairing,
      collaboration recovery, and support diagnostics.
- [ ] A tester can complete onboarding and the core accounting workflow without enabling AI or sync.
- [ ] Feedback asks for reproduction steps and expected behavior without requesting customer books or
      secrets.

## 15. Rollback preparation

- [ ] Record the currently working staging website deployment ID and backend function versions.
- [ ] Record the current database migration level and take a verified staging snapshot before applying
      new migrations.
- [ ] Confirm website rollback can restore the previous immutable deployment without changing the
      production alias.
- [ ] Confirm function rollback uses a known previous bundle while preserving compatible migrations.
- [ ] Never roll back a database by rewriting migration history; restore the isolated snapshot or ship
      a forward repair migration.
- [ ] Confirm AI, MCP, collaboration, support uploads, feedback delivery, telemetry, and update offers
      can each be disabled without redeploying the accounting engine.
- [ ] Define who can stop staging, who can rotate staging secrets, and who can delete staging data.
- [ ] Define the reset procedure for demo companies, support records, feedback, collaboration
      workspaces, AI history, and test files.

## 16. Final staging decision

The gate owner checks each statement only after reviewing the evidence from this run.

- [ ] All required checklist items pass for the recorded source SHA.
- [ ] All automated checks and staging service exercises use that same SHA and version.
- [ ] No accounting mismatch, data-loss risk, secret exposure, cross-company leak, approval bypass,
      production-state access, or unbounded failure remains open.
- [ ] Every staging-created support, feedback, attachment, AI, and collaboration test object is either
      deliberately retained for the test cohort or deleted with evidence.
- [ ] Rollback identifiers and kill-switch owners are recorded.
- [ ] Known non-blocking limitations have an owner, severity, workaround, and target milestone.
- [ ] The product owner approves the named tester cohort and staging duration.
- [ ] The gate owner records `GO` or `NO-GO` below.

Decision: `________________`  
Source SHA: `________________________________________`  
Staging deployment ID: `________________________________________`  
Decided by: `________________________________________`  
UTC timestamp: `________________________________________`

## Automatic no-go conditions

Staging admission is denied immediately if any of these conditions is true:

- The candidate identity, deployment identity, or version is missing or inconsistent.
- The worktree contains uncommitted candidate changes or the remote branch does not contain the SHA.
- Any required test, build, security, database, renderer, website, or release-contract gate fails.
- An accounting total changes unexpectedly or a voucher can become unbalanced.
- Backup, restore, migration recovery, SQLite integrity, or company isolation fails.
- A secret, customer identifier, book value, document body, or credential appears in logs, telemetry,
  support defaults, mirrors, or evidence.
- AI, MCP, collaboration, import, or JSON proposal paths can bypass validation, roles, period locks,
  review, or audit.
- Staging can mutate production services, data, domains, notifications, update feeds, or aliases.
- Support or feedback can be accepted without durable receipt, bounded abuse controls, or deletion.
- A required rollback, kill switch, or staging-data reset cannot be demonstrated.
- NIC live filing or online GST portal connectivity is represented as part of the v5 staging claim.
