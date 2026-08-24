# Total v0.5 completion roadmap

Last updated: 24 August 2026. This records the path from implemented product to public release. The
numbered source of truth is [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md), covering all 300
items in [BACKLOG_300.md](BACKLOG_300.md).

## Product scope implemented

- Daily work: Action Centre, guided setup, keyboard mnemonics, Command K, workspaces, recent work,
  tasks, drafts, templates, reversal and review flows.
- Accounting and reporting: double-entry books, monthly/quarterly registers, comparative statements,
  budgets, cost centres, consolidation, cash forecasts, management insights and portable report packs.
- Receivables and sales: collections ownership, promises, disputes, risk/DSO, reviewed email/WhatsApp
  drafts, contact channels, receipt matching, sales-document chain, returns, warranties, subscriptions,
  pricing, territory reporting and offline customer bundles.
- Payables and procurement: requisitions, orders, GRNs, three-way match, supplier onboarding, advances,
  payment runs/advice, bank files, debit-note claims and concentration analysis.
- Banking and inventory: multi-format statement import, explainable rules, cheque lifecycle, feed adapters,
  cash controls, batches, serials, godowns, landed cost, replenishment, manufacturing and traceability.
- Payroll and workforce: attendance, leave, salary history, loans, reimbursements, contractors, full-and-
  final settlement, statutory workspaces, payslips and payroll-to-books reconciliation.
- Migration and portability: Tally, Busy, Marg, Zoho and spreadsheet workflows, balanced journals, dry
  runs, rejected-row workbooks, attachment lineage, rollback, portable JSON upgrades and complete exit.
- Collaboration and controls: roles, maker-checker, scoped accountant access, voucher questions, sign-off,
  encrypted review bundles, audit hash chain, policy exceptions and retention controls.
- AI and ecosystem: OpenAI SDK, compatible and loopback-local providers, per-task routing, consented
  context, citations, document inbox, balanced proposals, eval thresholds, MCP, plugins and adapters.
- Reliability: atomic files, verified recovery, accessibility/performance/security gates, install/upgrade
  tests, signed-release requirements, updater contracts, support cases and feedback.
- Companion capture: phone-local receipt/invoice queue with native share/AirDrop handoff to Assist; no
  cloud account, website upload or background sync.

## Remaining internal acceptance

1. Run the full release scorecard on the final clean commit.
2. Reconcile representative Tally, Busy, Marg, Zoho and spreadsheet migrations using consented or
   synthetic production-scale data: openings, vouchers, tax totals, outstandings and stock value.
3. Complete bookkeeper, owner, accountant, payroll and inventory acceptance on clean macOS and Windows.
   Automated acceptance now covers the real public v0.4-to-v0.5 migration, repeated reopen, verified
   restore and uninstall-with-data-preservation; the remaining gate is clean-device human use.
4. Exercise phone capture on current iOS and Android, then confirm desktop import and duplicate review.
5. Run an invited cohort, triage blockers and publish an owned support/response SLA.

## Remaining external release operations

- Configure Apple Developer ID/notarization and Windows Authenticode secrets in GitHub Actions.
- Re-run the configured Vercel support, feedback, download and security-header checks on the final
  release deployment. The 24 August production exercise under `docs/evidence/` remains a historical
  audit record; release readiness requires fresh, executed evidence for the exact deployment.
- Obtain legal review of the versioned privacy policy and terms for intended selling jurisdictions.
- Tag only after the final commit is clean and green, then verify installers and updater metadata from
  the public release. See [PRODUCTION_CUTOVER.md](PRODUCTION_CUTOVER.md).

`npm run release:readiness` generates the machine-readable state. Missing credentials are external
blockers and must never be replaced with unsigned-production exceptions.

## Explicitly excluded

NIC live filing and online GST portal connectivity are outside this completion scope. They remain
experimental and must not be included in a production-ready claim. Offline deterministic GST
calculations, validation, frozen evidence and reviewed exports remain supported.

## Product guardrails

- No feature silently changes posted books.
- Every derived number drills down to vouchers or explains why it cannot.
- No AI book context leaves the computer without explicit context selection.
- Every network dependency degrades gracefully; core accounting stays offline.
- JSON is the editable interoperability layer. SQLite remains transactional because live accounting
  writes need constraints, transactions and crash recovery.
