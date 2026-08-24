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

## Migration reconciliation

Use one representative, consented export each from Tally, Busy, Marg, Zoho Books and a common
spreadsheet workflow. Work on copies. Hash each source file, preserve the import batch ID and verify
the automatic pre-import backup. Reconcile integer source-versus-Total values for opening debits,
opening credits, voucher count, receivables, payables, stock value, tax liability and attachments.
Resolve or explicitly correct every rejected row. A source passes only when every difference is zero.

## Clean-machine matrix

Use clean Apple Silicon macOS, supported Intel macOS and Windows 11 devices or fresh VMs. Record OS
build, architecture and installer SHA-256. Test fresh install, first launch, a posted voucher, verified
backup/restore, uninstall and preservation of `Documents/total`. Test public v0.4 upgrade on Apple
Silicon and Windows. Intel marks that one check `not_applicable` because v0.4 had no public Intel build;
the v0.5 clean install still must pass.

## Human sessions

Run at least one 60-minute structured session each with a bookkeeper, business owner, chartered
accountant, payroll operator and inventory/manufacturing operator. Give each participant realistic
tasks without coaching. Record at least three scenarios, completion, time, errors and blockers. Any
unresolved P0 data-loss/correctness issue or P1 blocked core workflow is a no-go.

## Mobile devices

Use current physical iOS and Android devices. Capture a real non-sensitive sample, invoke native
sharing, import it on desktop and exercise duplicate review. Simulator-only evidence is rejected.

## Legal review

A qualified lawyer reviews privacy, terms, security and the commercial policy for India and every
intended selling jurisdiction. Engineering cannot self-approve this file. Record reviewer identity,
qualification, document decision and date without including privileged advice in the repository.
