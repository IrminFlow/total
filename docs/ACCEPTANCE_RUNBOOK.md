# v5 acceptance runbook

This runbook produces the human and real-data evidence that automation cannot honestly invent. NIC
live filing and online GST connectivity are excluded. Do not place customer exports, names, GSTINs,
emails or attachment contents in the repository; record only SHA-256 hashes, aggregate totals and
named reviewer decisions.

Validate a completed evidence file with:

```sh
npm run acceptance:gate -- /path/to/evidence.json
```

Only a file with `status: "approved"`, named approvers and every required zero-difference/pass
assertion can unlock its readiness gate. The templates under `docs/acceptance/` deliberately remain
pending and never count as approval.

Migration and human evidence are release-execution evidence. Record the full
40-character `testedRevision`, UTC `testedAt` and the current product version. The gate accepts
migration evidence for 30 days and human evidence for 90 days, rejects
future timestamps, and requires approval within 14 days of testing. Release readiness compares the
revision to the exact release commit. Commercial policy and legal-governance records are durable
governance records: they remain versioned but do not need to be re-approved for every code commit.

Start acceptance only after the **Release candidate** workflow succeeds. Download its exact Actions
artifact and retain the run ID, run attempt, artifact ID and candidate-manifest SHA-256 shown in the
workflow summary. Do not rebuild locally. Migration and human evidence must record an
installer filename, byte size and SHA-256 from that bundle. Promotion downloads the immutable artifact
by ID, recomputes the manifest and every file digest, and rejects evidence created for another build.
After testing, merge only sanitized JSON under `docs/evidence/`; any runtime, site, dependency or
workflow change after the candidate requires a new candidate build.

## Migration reconciliation

Use one representative, consented export each from Tally, Busy, Marg, Zoho Books and a common
spreadsheet workflow. Work on copies. Hash each source file, preserve the import batch ID and verify
the automatic pre-import backup. Record the source application version, export format, importer
profile, import timestamp, a unique non-customer `importExecutionId`, and SHA-256 digests for the
import log, backup and privacy-safe reconciliation manifest. Source, execution, import-log and
manifest identities must be unique across the five runs. Record the exact tested candidate artifact
name, byte size and SHA-256. Reconcile integer source-versus-Total values for opening debits,
opening credits, voucher count, receivables, payables, stock value, tax liability and attachments.
Resolve or explicitly correct every rejected row. A source passes only when every difference is zero,
at least one voucher exists, and at least one accounting-value domain is non-zero. Do not commit the
source, log, backup or detailed manifest; the evidence file contains their digests only.

## Hosted-runner installation matrix

The signed-candidate workflow is the mandatory clean-environment gate. Fresh GitHub-hosted macOS
and Windows jobs install the exact signed candidates, launch with isolated home and profile
directories, post a voucher, create and preview a backup, restore it, upgrade real public v0.4 books,
uninstall the application and prove the company database remains. The workflow records runner image
identity, candidate digest and every result in `install-evidence-mac.json` and
`install-evidence-win.json`; build evidence hashes those records, and promotion rejects missing,
self-hosted, modified or failed evidence.

## Optional physical-machine matrix

Physical Apple Silicon macOS, supported Intel macOS and Windows 11 devices or fresh VMs provide
useful supplementary coverage but do not block v5 when they are unavailable. Record OS
build, architecture and installer SHA-256. Test fresh install, first launch, a posted voucher, verified
backup/restore, uninstall and preservation of `Documents/total`. Test public v0.4 upgrade on Apple
Silicon and Windows. Intel marks that one check `not_applicable` because v0.4 had no public Intel build;
the v5 clean install should still pass when hardware becomes available. Record the exact installer
filename, byte size and SHA-256 for each platform. Never mark this optional matrix complete from
hosted-runner results or assumptions.

## Human sessions

Run at least one 60-minute structured session each with a bookkeeper, business owner, chartered
accountant, payroll operator and inventory/manufacturing operator. Give each participant realistic
tasks without coaching. Record at least three scenarios with a non-placeholder name, positive elapsed
minutes, result and SHA-256 of a privacy-safe evidence note or recording manifest. Keep the underlying
notes and recordings outside the repository. Record exact name, byte size and SHA-256 identities for
the candidate macOS DMG, macOS ZIP and Windows EXE in `testedArtifacts`. Every scenario records the
`artifactIds` it actually exercised, and every release artifact must appear in at least one passed
scenario. Final readiness recalculates all three files, so macOS-only testing cannot approve Windows
UAT or a differently signed build. Record completion, errors and blockers. Any
unresolved P0 data-loss/correctness issue or P1 blocked core workflow is a no-go.

Use `docs/acceptance/HUMAN_SESSION_KIT.md` for the role-specific tasks, expected results, facilitator
rules and pass criteria. Copy `docs/acceptance/human-session.observation.template.json` for each
scenario, then carry only its sanitized evidence hash and result into `human.template.json`.

## Optional phone companion

Phone capture is a convenience workflow on the website, not a native mobile application. It is not
a release gate for the macOS and Windows desktop product. If the companion workflow is promoted,
exercise it on current iOS and Android devices: capture a non-sensitive sample, invoke native
sharing, import it on desktop and exercise duplicate review. Simulator-only evidence must not be
presented as physical-device evidence.

## Legal review

A fresh review packet with the exact current document digests can be created with:

```sh
npm run acceptance:legal-packet
```

A qualified lawyer reviews privacy, terms, security and the commercial policy for India and every
intended selling jurisdiction. Engineering cannot self-approve this file. Record reviewer identity,
qualification, document decision, date and the SHA-256 supplied in the review packet without including
privileged advice in the repository. The gate recomputes each source digest, so a later policy edit
requires a new legal approval rather than silently inheriting the old decision.

For the free v5 public beta only, qualified review is recommended rather than mandatory. The product
owner may instead complete `docs/acceptance/legal-risk.template.json`, acknowledging the exact document
digests and explicitly accepting the risk of publishing without qualified review. This evidence is an
owner decision, not legal advice and not a claim that the documents were legally approved. It cannot
authorize charging users, direct paid sales or significant paid marketing; those activities continue
to require qualified legal review.

Generate a fresh, digest-bound owner-risk packet with `npm run acceptance:legal-risk-packet`. Change
its status, approval date, named product-owner decision, acknowledgement fields and document results
only after the owner has read the exact documents. Validate the completed file with
`npm run acceptance:gate -- /path/to/evidence.json`; do not relabel it as legal review evidence.
