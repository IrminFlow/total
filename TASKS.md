# Agent work — current Total application

This is the canonical queue for every task the agent can perform with code, shell, browser,
GitHub, E2E automation, visual inspection, or Computer Use. `HUMAN.md` contains only genuine
human/external blockers.

## Scope boundary

The two large rewrite PRs are **not part of this goal**. Do not inspect, reconcile, merge, close,
retitle, or otherwise act on them until the owner starts a separate merge project. This queue is
only for making the current checked-out application independently correct and release-ready.

## Completion rules

A task is complete only when:

1. The cause is understood and the smallest correct change is implemented.
2. Accounting amounts remain integer paise and quantities remain integer thousandths.
3. A regression test fails before the fix where practical and passes afterwards.
4. `npm test` and `npm run typecheck` pass.
5. Relevant DB, renderer, build, smoke, E2E, visual, and platform checks pass.
6. A retry-recovered E2E scenario is still treated as a failure until the flake is fixed.
7. Statutory changes cite dated primary government/Protean material and preserve an explicit
   warning wherever authoritative validation is unavailable.

## P0 — establish and maintain the work queues

- [x] Read the complete handoff and every tracked project/operator document.
- [x] Separate human-only work into `HUMAN.md` and executable work into this file.
- [x] Keep both files current as new evidence changes ownership or status. This remains a standing
  maintenance rule; the 2026-08-28 reconciliation is recorded below.

## P0 — make the current branch deterministic

- [x] Fix E2E `37-amendments`: select a new POS different from the document's effective
  `target.pos`, not merely from nullable `voucher.posOverride`; retain the substantive amendment
  assertions.
- [x] Fix E2E `52-branch-transfer`: add diagnostics for registration, date range, IPC register and
  visible query state; correct the invalidation/readiness race instead of adding a blind delay.
- [x] Replace the suite-order-sensitive absolute heap assertion in `memoryCeiling.dbtest.ts` with a
  platform-independent streaming/scaling property or isolated process measurement. Do not just
  raise the ceiling.
- [x] Reproduce the Windows MCP write-rate-limit failure and assert the exact SDK response shape;
  verify all writes hit the same limiter instance.
- [x] Inspect shipped WOFF2 coverage for U+20B9 and fix either the bundled font subset or the E2E
  claim so Windows and macOS both prove the rupee glyph actually renders.
- [x] Make ISD's `Create & open` E2E action initiate the real pointer click and durable gateway wait
  concurrently under the explicit company-creation budget. A `noWaitAfter`-only first pass still
  let Windows delay CDP click acknowledgement past the generic 10-second action timeout in final
  run 33189506456; the corrected helper no longer misclassifies synchronous migration/seeding as a
  click failure.
- [x] Remove the Next.js multiple-lockfile/workspace-root warning by defining the correct site root
  or rationalizing the lockfile layout without breaking Vercel's `site/` root.
- [x] Review the `Recurring.tsx` static/dynamic import warning and preserve real code splitting if
  that screen is intended to be lazy.

## P0 — fix verified product-correctness debt

- [x] Fix company-wide physical stock counts with godown-attributed movements. Per-godown rows must
  sum exactly to item closing quantity and value after a physical count; cover transfers,
  subsequent movements, negative stock, rounding and all valuation methods.
- [x] Verify and test payroll leaving-date/mid-cycle leaver proration.
- [x] Audit multi-GSTIN scope for reverse charge, counter sales and branch-transfer Table 13; either
  implement correct registration attribution or show an explicit limitation where the statutory
  source does not support automation.
- [x] Verify QRMP/IFF snapshot and amendment behaviour, including missed invoices in months one and
  two of a quarter. IFF has durable nil-capable headers and M1/M2 provenance; the next IFF may pick
  up an earlier missed registered record, the quarter excludes IFF-furnished vouchers, and records
  first furnished in the quarter remain ordinary rather than amendments. Covered by focused DB,
  migration-upgrade, build/typecheck and real-Electron E2E scenarios 37 and 54.

## P1 — statutory verification work the agent owns

- [x] Validate GSTR-1 amendment field names, registered-to-unregistered corrections, and whether the
  current offline utility accepts amendment-only uploads. GSTN Save API v5.0 schema validation and
  a checked-in golden file now pin `ctin` + `oinum`/`oidt` and `ont_num`/`ont_dt`; invalid `octin`
  was removed. Recipient GSTIN changes are explicitly refused because GSTN marks the field
  non-amendable. The v5 root permits partial table payloads and the current manual permits multiple
  JSON chunks. Pure/DB/typecheck/build and real-Electron E2E 37/54 pass.
- [x] Validate the ISD GSTR-6 JSON against the current GSTN offline-tool schema before enabling a
  portal-file claim. The 2026-08-28 official-source audit found only GSTR-6 Save v1.0 Draft
  (published 2020-06-02) and an offline-tool manual updated 2021-02-03. That audit identified the
  invoice/POS/rate-wise and source-head-lineage gaps subsequently closed in the next task. Pure/DB/
  typecheck/build and E2E 53 cover the deliberately disabled portal-file result.
- [x] Extend ISD credit capture and persisted distributions with supplier invoice value, place of
  supply, rate-wise tax items, and source-to-destination tax-head lineage. Build a schema-validated
  preview fixture, but do not enable portal export until GSTN publishes a current Final schema or
  its current official utility and signed-in portal accept the generated file. Migration 59
  backfills legacy credits as explicitly unclassified rate rows; the Draft-v1.0-shaped preview
  refuses to call those rows portal-valid until they are edited. The UI captures and edits all
  Table 3 facts, issued documents persist exact source-to-destination lineage, and focused pure/DB/
  migration/typecheck/build plus the real-Electron scenario 53 are green.
- [x] Validate ITC-04 Table 4/5 readings, due periods, boundary dates, exclusions, and job-worker
  return paths against notifications and the current form. The 2026-08-28 official-source audit
  corrected Table 5B (receipt from a different worker, not onward despatch), kept the original
  section 143 clock running through onward moves, pinned Notification 35/2021-CT and the FY
  2021-22 transition periods, grounded the inclusive anniversary in General Clauses Act s.9, and
  removed the false nil-filing claim. Portal JSON stays disabled with dated blockers.
- [x] Extend job-work movements with destination/returning-worker identity, endorsed or fresh
  onward-challan provenance, job-worker SEZ status, cess, and form-row loss/waste UQC+quantity.
  Preserve one section 143 clock from the first despatch through the full worker chain, model 5B
  returns and 5C supply/loss rows exactly. Migration 60 backfills legacy source/waste facts, a
  holder ledger prevents two workers returning the same goods, and the v2.15 JSON preview matches
  a checked-in golden reconstructed from the official workbook's hidden fields and VBA. The
  current official zip is SHA-256 pinned. Computer Use proved the workbook itself fails in Excel
  for Mac with `Compile error in hidden module: MainModule`; Windows-Excel and signed-in portal
  acceptance are now explicit `HUMAN.md` dependencies, so direct export remains disabled. Focused
  pure/DB/migration/typecheck/build and real-Electron E2E 38 are green.
- [x] Validate Form 26AS import wording, TAN handling, debit-note/refund netting, and GST exclusion
  using a sanctioned sample export. The 2026-08-28 official-source audit pins the current TRACES
  Part I hierarchy and native caret-delimited text format, keeps Form 26AS distinct from AIS,
  inherits deductor TAN/name from summary rows into nested transactions, and preserves
  parenthesised negative corrections. Migration 58 adds nullable party TAN for exact later
  matching; TDS-receivable credits remain negative. GST-inclusive party gross is context, never
  compared as the section base (CBDT Circular 23/2017). Unlinked 26AS rows are investigation
  items, not automatically labelled omitted income. Pure/DB/migration/typecheck coverage passes.
- [x] Validate the consolidated RCM self-invoice interpretation and retain the per-supply safe
  path. The 2026-08-28 CBIC audit confirms Rule 46 permits month-end consolidation only for
  supplies actually covered by section 9(4), subject to its daily aggregate wording. Amended
  section 9(4) (effective 2019-02-01) no longer covers every unregistered vendor; Notification
  07/2019-CTR is a notified promoter/real-estate regime the app does not model. Consolidation is
  therefore disabled and rejected at the service boundary. Per-supply section 31(3)(f) documents
  are now limited to notified RCM purchases from unregistered suppliers; registered 9(3)
  suppliers remain in GSTR-3B but their own RCM invoice is the document. Pure/DB/typecheck pass.
- [x] Check current IMS actions and portal availability; date the result. GSTN's current manual
  keeps IMS at Services → Returns → Invoice Management System, with Accept/Reject/Pending and
  deemed acceptance for no-action records. The 2026-08-28 audit pins the prospective October
  2025 change: original credit notes gain Pending from that tax period; before it they expose only
  Accept/Reject. Original invoices and debit notes retain all three. Book-only reconciliation
  rows now expose no action because no IMS portal record exists, and the service rejects forged
  local decisions for unavailable actions. The worksheet remains explicitly offline and cannot
  take portal action. Pure/DB/typecheck coverage passes.
- [x] Review approximate PIN-distance data and ensure estimates are never written automatically.
  The 2026-08-28 audit checked the civil two-digit prefix set against the Department of Posts'
  official OGD PIN directory (updated 2025-10-03), corrected the false name “postal circle” to
  India Post's “postal sub-region”, and removed the false claim that NIC rejects distance zero
  (zero asks the API to use NIC's stored distance where available). NIC's April 2019 guide and
  current API documentation confirm its route calculation is proprietary and portal-authoritative;
  Total's city-centre/sub-region table and 1.25 factor remain explicitly approximate. The estimator
  is a read-only IPC, the UI requires a separate acceptance click, and focused DB plus real-Electron
  E2E 37 prove the stored transport distance is byte-for-byte unchanged before acceptance and after
  an unknown PIN.
- [x] Obtain official Forms 138/140 specifications when published, implement dated selection and
  mandatory records, and retain historical 24Q/26Q. On 2026-08-28 the agent implemented Protean's
  22 July 2026 Form 138 Q1-Q3 and Form 140 Q1-Q4 release: official samples and absolute-position
  tests pin FH/BH/CD/DD at 18/72/30/45, new four-digit Annexure 2 codes are explicit, one CD is
  emitted per actual challan, the legal-category meanings are corrected, and a complete filing
  profile is editable in Electron. Form 138 Q4 remains blocked because Protean still marks it
  “Expected soon.” FVU 1.2 was executed but requires a TAN-specific authenticated CSI; the suffix
  correctly remains `.unverified.txt`, with the CSI access dependency isolated in `HUMAN.md`.
- [x] Prepare a native-language review sheet for every Hindi/Marathi `VERIFY` marker and apply only
  changes approved by fluent accounting users. `docs/native-language-review.md` covers all eight
  Hindi and seven Marathi markers, supplies invoice/amount-in-words context, and leaves explicit
  KEEP/REPLACE/CONTEXT decisions for the reviewers. No unapproved wording was changed; completed
  review remains the corresponding `HUMAN.md` dependency.

## P1 — architecture, security and upgrade audits

- [x] Review every migration added after `main`: append order, hash pins, rebuild preservation,
  indexes, expected tables, and real upgrade-path fixtures. All 60 migrations are append-only and
  hash-pinned; a missing pre-58 fixture now proves legacy facts survive the Form 26AS/TAN upgrade,
  with foreign-key and integrity checks green.
- [x] Red-team AI/MCP boundaries: key containment, sensitive-field redaction, prompt injection,
  filesystem access, write switches, rate limiting, and the no-voucher-write invariant. Model tools
  now import only named read services, a structural test prevents namespace regressions, and the
  fourth concurrent AI run is refused after stale-run pruning. Focused pure/DB tests pass.
- [x] Review every voucher/voucher-line SQL path for deleted-row and registration scope. The audit
  fixed binned counter vouchers leaking into till summaries, blocked stale bank-line mutation,
  scoped filing activity to the selected GST registration, and expanded structural/regression
  coverage for future voucher-line aggregate queries.
- [x] Review renderer registry/lazy loading, React Query invalidation families, keyboard/pointer
  parity, focus restoration and error-boundary behaviour. Pointer-only drilldowns are now semantic
  buttons; three missing query families are registered; direct tests pin modal focus restoration
  and recoverable error-boundary logging/navigation. Renderer suite passes.
- [x] Revisit Electron 37 security debt from the existing three-step CDP wedge reproducer; bisect
  Electron 38-42 and test a current Playwright without sacrificing native-input coverage. A bounded
  reusable reproducer proves 37.10.3 passes and the first bad major is 38: latest 38-42 patches all
  wedge on the third native click. A DOM click on 42 also wedges evaluation. Playwright 1.62.1 is
  still current on 2026-08-28, so Electron remains pinned pending an upstream fix; native coverage
  remains intact.
- [x] Keep runtime dependency audit at zero high/critical vulnerabilities and document any accepted
  exception with a release-blocking review date. On 2026-08-28 `npm audit --omit=dev` reports zero
  vulnerabilities for both the Electron app and `site/`; there is no accepted exception.

## P1 — complete verification campaign

- [x] `npm test` — 163 files / 2,323 pure tests green on macOS.
- [x] `npm run test:db` — 109 files / 1,348 Electron/SQLite tests green on macOS, including
  migrations, 4,000-voucher scale and memory ceilings.
- [x] Repeat the full DB suite on Windows at the immutable product/workflow commit. GitHub Actions
  run [33188585495](https://github.com/IrminFlow/total/actions/runs/33188585495) passed the full
  Windows DB layer on `481ec56e535e80f983bbbd63bd4cb977037230c1`.
- [x] `npm run test:renderer` — 28 files / 196 renderer tests green.
- [x] `npm run typecheck` — both node and web projects green.
- [x] `npm run build`, `npm run bundle:budget`, and `npm run smoke` green. The closest budgets are
  main at 98% and renderer assets at 96%; treat growth as release-sensitive.
- [x] `site/npm run build` green across 33 routes with no workspace/config warning.
- [x] All 54 E2E scenarios green without retries on macOS in 198 seconds of the 600-second budget
  on the exact staged release candidate.
- [x] Repeat all 54 E2E scenarios without a retry-recovered result on Windows at the same immutable
  commit. Run 33188585495 passed 54/54 in 273 seconds; the runner makes every retry-recovered flake
  fail the job. The matching macOS job passed 54/54 in 227 seconds.
- [x] Visual regression green for 72 light/dark screen captures with no drift. There were no new
  baselines to accept; representative changed surfaces were also inspected through Computer Use.
- [x] Computer Use walkthrough of onboarding, demo company, voucher entry, reports, GST export,
  backup/restore, settings, keyboard navigation and error recovery. If the Computer Use host is
  unavailable, record the exact blocker and repeat after it is restored. On 2026-08-28 Computer Use
  created the trading demo, exercised the voucher form and its dirty-navigation guard, opened Trial
  Balance/GSTR-1/Settings by global keys, and visually inspected backup and export controls.
- [x] Large-book performance run on a quiet machine: 4,000-voucher report/pagination fixture,
  7,800-row memory/export fixture, query budgets and four cold starts (fastest settled screen 734ms)
  all passed. Day-book/ledger pages stayed proportional to page size and repeated sweeps stayed
  within the pinned heap ceiling.
- [x] PDF/invoice render inspection for classic/modern/compact, bilingual, multi-page, thermal and
  dot-matrix output. E2E 39 and pure invoice/ESC-P tests pin all variants; the generated A4 invoice
  was rendered at 150 DPI and manually inspected for clipping, totals, QR, typography and footer.
  Physical thermal/dot-matrix output remains the hardware-only check in `HUMAN.md`.
- [ ] Test fresh install, existing-company upgrade, backup restore, N-1 to N updater, uninstall data
  preservation and offline operation on signed artefacts once certificates exist.

## P1 — site and operational work after owner inputs exist

- [ ] Add approved testimonials without inventing or paraphrasing claims beyond permission.
- [ ] Publish the approved real 90-second GSTR-1 app walkthrough from the existing shot list after
  the human recording/voice asset and publication approval exist.
- [ ] Verify pricing, buy, checkout refusal, success, webhook idempotence, feedback failure/success,
  privacy, download and `/api/latest` behaviour in preview and production.
- [x] Generate a test licence, apply it, verify expiry/read-only/export behaviour, and document the
  operator flow without exposing the signing key. E2E 16 generates an ephemeral Ed25519 pair,
  proves valid/expired/revalidated behavior, preserved reports/backups and blocked writes; the
  production key split and operator procedure are documented in `site/OPERATOR.md`.
- [ ] Run NIC sandbox e-invoice/e-way tests after credentials are configured; keep live filing
  experimental until evidence is recorded.
- [x] Prepare physical Windows/printer/WhatsApp checklists in
  `docs/physical-validation-checklists.md`; analysing returned evidence remains agent work when the
  human-provided hardware/access and approved recipient exist.

## Final release evidence

- [x] One immutable product/workflow commit has green local verification and green macOS/Windows
  GitHub CI: `481ec56e535e80f983bbbd63bd4cb977037230c1`, run
  [33188585495](https://github.com/IrminFlow/total/actions/runs/33188585495). A later
  documentation-only evidence commit may sit above this baseline.
- [x] No E2E scenario is marked flaky and no executable release gate was skipped. Both platform
  jobs passed 54/54; the Windows job also passed typecheck, renderer, full DB, build, smoke, artifact
  upload and an unsigned `electron-builder --win --dir` package.
- [x] All remaining open items are genuine `HUMAN.md` dependencies. No known local implementation,
  macOS verification, Windows CI, or unsigned packaging task remains deferred.
- [x] `docs/release-notes-draft.md` states experimental/unverified statutory and platform paths
  accurately and now contains immutable macOS/Windows CI evidence. Replace only the version/date
  after owner approval and before publishing.
- [x] Present the owner with current evidence and request explicit approval before publishing or
  merging. The final goal handoff provides that evidence; rewrite-PR integration remains a separate
  future goal and was not inspected or acted on here.
