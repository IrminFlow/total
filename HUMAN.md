# Morning checklist for the product owner

Last updated: 28 August 2026.

This file contains only actions that require your identity, account access, business decision, physical observation, or approval. Coding agents should not mark these complete for you. Do not paste passwords, API keys, recovery keys, certificates, customer books, or personal data into chat, issues, commits, screenshots, or documentation.

The unsigned packages attached to the `v5-cloud-agent-sync` branch are for testing only. They are not public-release installers.

## First 15 minutes

- [ ] Open draft PR [#4](https://github.com/IrminFlow/total/pull/4) and confirm that the scope still matches the v5 release you want.
  - Why: this branch currently contains the complete v5 history plus the latest AI, collaboration, OCR, support, and staged-update work.
  - Success evidence: the PR remains `MERGEABLE`, `CLEAN`, and all checks are green.
  - Can defer: no, if work is continuing on this release.

- [ ] Decide whether Supabase collaboration and hosted support should be enabled for the first beta cohort.
  - Recommended: enable them for internal users first, then a small invited beta.
  - If deferred: the desktop app remains fully usable offline, but collaboration and the Supabase support copy will stay off.
  - Success evidence: write the decision in the PR or project notes without including credentials.

- [ ] Decide whether the first public release is a free beta.
  - Recommended when qualified legal review is unavailable: free beta, no card, no automatic paid conversion, no significant paid marketing.
  - Record explicit owner acceptance of the unreviewed legal risk using the repository’s legal-risk evidence flow.
  - Can defer: paid pricing can be deferred; the release model cannot remain ambiguous at publication time.

## Supabase production decision

Staging setup is complete. The isolated project `cewz…qmlx` exists; all migrations through
`202608280002_collaboration_devices.sql` are applied; `total-sync` v9 and `total-intake` v10 are
active; and unauthenticated `total-sync` access returns HTTP 401. No production Supabase project was
created or changed.

- [ ] Decide whether to create a separate production Supabase project.
  - Do not reuse the staging project for production books or identities.
  - Choose the production region and authentication method deliberately.
  - Record the project reference outside the repository. Never copy a service-role credential into
    source, documentation, issues, screenshots, or chat.

- [ ] When production deployment is approved, authenticate the Supabase CLI and ask the agent to
  apply all four migrations and deploy both Edge Functions.
  - `total-sync` must verify Supabase JWTs.
  - `total-intake` must use a dedicated `TOTAL_INTAKE_SECRET` and perform its own bearer check.
  - The production intake secret must be distinct from every administration, cron, storage, HMAC,
    signing, OpenAI, and Supabase service-role credential.

## Vercel and website setup

The isolated staging site already has support and feedback configured. Synthetic support
create/private-token tracking and feedback idea/vote/follow checks passed. Production remains
untouched.

- [ ] When production configuration is approved, authenticate Vercel on this computer or open the
  production Total site project in the Vercel dashboard.
  - Project root must be `site`.
  - Tell the agent when the session is ready. Do not share the login token.

- [ ] Configure the production website environment.
  - Required for the private-repository download path: `GITHUB_TOKEN`.
  - Site identity: `NEXT_PUBLIC_SITE_URL` and, if needed, `GITHUB_REPO`.
  - Durable support store: `BLOB_READ_WRITE_TOKEN`.
  - Separate control secrets: `INTAKE_SECURITY_SECRET`, `INTAKE_ADMIN_SECRET`, and `CRON_SECRET`.
  - Supabase delivery: `SUPABASE_SUPPORT_URL`, `SUPABASE_FEEDBACK_URL`, and `SUPABASE_INTAKE_SECRET`.
  - `SUPABASE_INTAKE_SECRET` must equal Supabase `TOTAL_INTAKE_SECRET`; all other trust-boundary secrets must be different.
  - Never prefix a secret with `NEXT_PUBLIC_`.
  - Success evidence: a fresh production deployment completes and `/api/deployment` reports the expected immutable revision.

- [ ] Keep Resend optional for the first pass.
  - If enabled, verify the sending domain and the exact `TOTAL_SUPPORT_FROM` address.
  - If deferred, cases must still persist even though email notification is absent.

## Real service acceptance

- [ ] Test collaboration with two different Supabase users.
  - User A creates an encrypted workspace and an expiring invitation.
  - User B accepts the single-use invitation using their own access token.
  - Send the recovery key through a separate trusted channel from the invitation code.
  - Sync a harmless proposal, comment, and task in both directions.
  - Confirm that posted vouchers, masters, company databases, provider keys, and recovery keys do not appear in Supabase.
  - Revoke a second invitation and confirm it cannot be accepted.
  - Let one access token expire and confirm refresh succeeds; then revoke a session and confirm the
    client requires reconnection.
  - Confirm an unknown device or modified signature is rejected and quarantined without blocking a
    later valid envelope.
  - Success evidence: redacted timestamps, workspace ID, invitation state, and local sync result. Do not capture tokens or ciphertext bodies.

- [ ] Test support and feedback in production.
  - The equivalent staging create/private-token tracking and idea/vote/follow checks have passed;
    they do not count as production acceptance.
  - Create a synthetic support case.
  - Confirm the case can be tracked, resolved, reopened, and exactly deleted.
  - Confirm a provider-delivery failure does not lose the stored case.
  - Submit feedback, vote, follow, and delete the synthetic record.
  - Confirm Vercel Blob and Supabase contain the intended copies.
  - Confirm Resend delivery if notifications are enabled.
  - Success evidence: redacted receipt IDs and the generated production-services evidence file.

## Signing identities

- [ ] Add macOS signing and notarization secrets to the reviewer-protected GitHub `release-signing` environment.
  - `MAC_CSC_LINK`
  - `MAC_CSC_KEY_PASSWORD`
  - `APPLE_API_KEY`
  - `APPLE_API_KEY_ID`
  - `APPLE_API_ISSUER`
  - These require an Apple Developer ID Application certificate and App Store Connect notarization key.
  - Can defer: yes for internal unsigned testing; no for a public macOS release.

- [ ] Add Windows Authenticode secrets to the same protected environment.
  - `WIN_CSC_LINK`
  - `WIN_CSC_KEY_PASSWORD`
  - Can defer: yes for internal unsigned testing; no for a trusted public Windows installer.

Do not place certificate files or encoded certificate values in the repository, local evidence, documentation, PR comments, or chat.

## Acceptance material only you can provide

- [ ] Supply representative consented customer exports for Tally, Busy, Marg, Zoho Books, and common spreadsheets.
  - Never commit customer data.
  - Expected reconciliation: opening balances, voucher counts, receivables, payables, stock, tax totals, and attachment lineage.
  - Can defer: individual formats can defer only if the release stops claiming that migration path is accepted.

- [ ] Run short acceptance sessions with the roles you can access.
  - Bookkeeper
  - Business owner
  - Accountant
  - Payroll operator
  - Inventory or manufacturing user
  - Use synthetic books if real users or data are unavailable. Do not fabricate participant evidence.
  - GitHub-hosted macOS and Windows jobs cover clean-environment installation; you do not need separate clean computers.

- [ ] Install one unsigned branch artifact yourself for a basic confidence check.
  - Confirm launch, keyboard shortcuts, quarterly registers, voucher save, backup, restore preview, AI-off operation, and uninstall data preservation.
  - Treat operating-system warnings as expected for unsigned test packages.

## When you are ready to merge

- [ ] Tell the agent explicitly: “start the final review.”
  - The agent will then review the whole v5 diff, correct findings, rerun gates, and update PR #4.
  - This has intentionally not started yet.

- [ ] Approve the final reviewed PR only when checks are green and remaining limitations are written plainly.

- [ ] After merge, dispatch the protected release-candidate workflow with the exact `main` commit SHA and version `5.0.0`.
  - Never create the tag manually.
  - Test and accept the exact signed candidate artifacts.
  - Promote that candidate without rebuilding it.
  - Begin with the internal channel, then beta, then staged stable percentages.

## What you do not need to do

- You do not need to provide clean computers; GitHub-hosted macOS and Windows jobs provide the mandatory clean-environment matrix.
- You do not need a lawyer to run an internal or free beta if you explicitly accept the documented owner risk. Do not begin direct sales or significant paid marketing without qualified review.
- You do not need an OpenAI key for offline accounting or offline OCR.
- You do not need Supabase for a single-device offline user.
- You do not need NIC sandbox or GST portal API credentials for v5.

Detailed deployment instructions: [docs/ENCRYPTED_COLLABORATION.md](docs/ENCRYPTED_COLLABORATION.md), [site/INTAKE_OPERATIONS.md](site/INTAKE_OPERATIONS.md), and [docs/RELEASE_RUNBOOK.md](docs/RELEASE_RUNBOOK.md).
