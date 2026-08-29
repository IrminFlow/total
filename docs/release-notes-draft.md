# Release notes draft — next Total release

This is a draft for the immutable release commit. Replace the version/date and remove no caveat
without recorded external validation.

## What is new

- Physical-stock counts now reconcile company and godown quantities and values across transfers,
  later movements, negative stock and every supported valuation method.
- Multi-GSTIN books now scope reverse charge, counter sales, branch transfers, filing activity and
  ISD work to the selected registration.
- Payroll handles leaving dates and mid-cycle leavers; QRMP/IFF retains furnishing provenance and
  correctly excludes invoices already furnished through IFF.
- GSTR-1 amendment validation, GSTR-6/ISD working, ITC-04 job-work chains, Form 26AS reconciliation,
  Forms 138/140 and IMS availability rules have dated statutory validation and expanded tests.
- Renderer accessibility, query invalidation, deleted-voucher filtering, AI/MCP read boundaries,
  migrations and large-book memory behavior received dedicated regression coverage.

## Verification

The product/workflow commit `481ec56e535e80f983bbbd63bd4cb977037230c1` passed the complete
[cross-platform GitHub Actions run](https://github.com/IrminFlow/total/actions/runs/33188585495):
2,323 pure tests, 1,348 Electron/SQLite tests, 196 renderer tests, type checking, build and smoke;
Windows also passed the full DB suite, unsigned directory packaging, and 54/54 real-Electron E2E
in 273 seconds, while macOS passed 54/54 in 227 seconds. A retry-recovered scenario fails the E2E
job, so both green jobs had no accepted flakes. Local verification additionally passed bundle
budgets, a 33-route site build, 54/54 E2E without retry in 198 seconds, and a 72-screen light/dark
visual comparison. Computer Use independently walked onboarding, demo creation,
voucher/dirty-state recovery, reports, GST and Settings.

The later security-hardening source commit `087a1ca9fb64f7b64974b1600a9b7f17a1417f09`
passed [full cross-platform run 33248953167](https://github.com/IrminFlow/total/actions/runs/33248953167):
164 files / 2,337 pure tests, renderer and full Linux/Windows DB suites, build/smoke/unsigned Windows
packaging, and 54/54 no-flake Electron scenarios on both macOS and Windows. Its local macOS E2E run
also passed 54/54 without retry in 245 seconds.

## Important statutory and platform limits

- Direct NIC e-invoice/e-way filing remains experimental until recorded sandbox validation with
  authorized NIC/GSP credentials. JSON generation and offline checks are not portal acceptance.
- GSTR-6 portal-file export remains disabled. The latest official schema located in the audit is a
  2020 Draft; the app provides a complete working/preview but does not claim current portal validity.
- ITC-04 direct portal export remains disabled. The v2.15 preview matches the pinned official
  workbook fields, but requires Windows Excel utility and signed-in GST portal acceptance.
- Form 138/140 files retain the `.unverified.txt` suffix until an app-generated statement passes
  Protean FVU 1.2 with the TAN holder's authenticated CSI. Form 138 Q4 is not emitted because
  Protean still marks that format “Expected soon.”
- IMS is an offline reconciliation worksheet. It does not submit Accept/Reject/Pending actions to
  GSTN.
- PIN-to-PIN e-way distance is an approximate suggestion and is never written without a separate
  user acceptance. NIC/portal distance remains authoritative.
- Electron stays pinned to 37.10.3. A reproducible Playwright/CDP regression begins in Electron 38
  and also affects current Electron 44.0.0; accepting a later runtime requires the native-input
  reproducer plus full macOS/Windows E2E. Newly published Electron advisories make this a
  next-release blocker, not ordinary deferred maintenance. In the meantime the renderer is
  sandboxed and renderer-created OS links are restricted to generated mail and WhatsApp drafts.
- Physical 58/80 mm thermal, ESC/P dot-matrix and Windows 1366×768 checks remain release gates until
  the target hardware is supplied. Signing, notarization and updater verification require the
  owner-managed Apple and Windows certificates.

## Data safety

Total remains offline-first, keeps one SQLite database per company under the configured data
folder, preserves backups and exports in read-only licence states, and never stores derived report
balances. Back up the data folder before installing any release candidate.
