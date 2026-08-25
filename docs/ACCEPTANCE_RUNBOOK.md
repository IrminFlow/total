# v0.5 acceptance runbook

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

Migration, clean-machine, human and mobile evidence is release-execution evidence. Record the full
40-character `testedRevision`, UTC `testedAt` and the current product version. The gate accepts
migration and clean-machine evidence for 30 days and human/mobile evidence for 90 days, rejects
future timestamps, and requires approval within 14 days of testing. Release readiness compares the
revision to the exact release commit. Commercial policy and legal document approvals are durable
governance records: they remain versioned but do not need to be re-approved for every code commit.

Start acceptance only after the **Release candidate** workflow succeeds. Download its exact Actions
artifact and retain the run ID, run attempt, artifact ID and candidate-manifest SHA-256 shown in the
workflow summary. Do not rebuild locally. Migration, clean-machine and human evidence must record an
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

## Clean-machine matrix

Use clean Apple Silicon macOS, supported Intel macOS and Windows 11 devices or fresh VMs. Record OS
build, architecture and installer SHA-256. Test fresh install, first launch, a posted voucher, verified
backup/restore, uninstall and preservation of `Documents/total`. Test public v0.4 upgrade on Apple
Silicon and Windows. Intel marks that one check `not_applicable` because v0.4 had no public Intel build;
the v0.5 clean install still must pass. Record the exact installer filename, byte size and SHA-256 for
each platform. When candidate artifacts are available, publication readiness recalculates and compares
those identities; a copied digest or differently signed build does not count.

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

## Mobile devices

Use current physical iOS and Android devices. Capture a real non-sensitive sample, invoke native
sharing, import it on desktop and exercise duplicate review. Simulator-only evidence is rejected.

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
