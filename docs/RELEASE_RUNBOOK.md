# Production release runbook

Total releases are fail-closed. A tag is published only after macOS and Windows artifacts have
both passed signing, integrity, updater-manifest and packaged-launch checks.

## One-time repository secrets

- `MAC_CSC_LINK`: base64 Developer ID Application `.p12`
- `MAC_CSC_KEY_PASSWORD`: password for that certificate
- `APPLE_API_KEY`: base64 App Store Connect `.p8` notarization key
- `APPLE_API_KEY_ID`: App Store Connect key ID
- `APPLE_API_ISSUER`: App Store Connect issuer ID
- `WIN_CSC_LINK`: base64 Windows code-signing `.pfx`
- `WIN_CSC_KEY_PASSWORD`: password for that certificate
- `GITHUB_TOKEN`: supplied automatically by GitHub Actions

Never store certificates or secret values in the repository. The release workflow refuses to
build when any credential is absent and electron-builder's `forceCodeSigning` prevents an
unsigned fallback.

## Release

1. Confirm main CI is green, including the site build and macOS UI suite.
2. Confirm `package.json` already contains the intended release version. If it does not, set the intended semver version and review that commit before continuing.
3. Tag the reviewed `main` commit with `git tag "v$(node -p "require('./package.json').version")"`, then push with `git push origin main --follow-tags`.
4. Watch all three release jobs. The final `publish` job starts only after both signed builds pass.
5. Confirm the GitHub release contains DMG, ZIP, EXE, blockmaps, `latest-mac.yml`, and `latest.yml`.
6. Confirm the website's `/api/latest` reports the new version and `/api/download` returns the
   correct platform artifact.

Do not manually create the release before the workflow. The final job refuses to overwrite an
existing release because partial or mixed-version assets would break auto-update guarantees.

## What the gates prove

- Every historical database migration path reaches the current schema and passes SQLite
  `quick_check` plus `foreign_key_check`.
- A failed migration restores the exact verified pre-upgrade snapshot.
- The macOS app and native SQLite module are universal Intel/Apple Silicon binaries.
- The macOS signature, Gatekeeper assessment and stapled notarization ticket are valid.
- The Windows application and NSIS installer have valid Authenticode signatures.
- Both packaged applications launch with `app.isPackaged === true`.
- The actual public v0.4 packaged app creates representative inventory and batch movements, a
  reconciled bank receipt, a committed payroll run, GST and TDS transactions, and owner/viewer
  access with a company lock. Each platform candidate opens the same books twice and preserves the
  exact fixture digest, registry entry and lock; the first migrated open also produces a verified
  backup. The evidence records that v0.4 has no managed voucher attachments, rather than pretending
  an unsupported attachment migration was exercised.
- The final publication job recalculates the DMG, ZIP and NSIS digests and requires them to match
  both the executed platform-upgrade evidence and the clean-commit build evidence. It also requires
  the platform scorecards and evidence files to be hashed by that build evidence. A copied label,
  an existing script or stale evidence from another commit cannot satisfy the gate.
- Uninstall removes the installed application while leaving the company database intact.
- Update manifests match the tag, include SHA-512 integrity metadata, and reference assets in the
  same release.

## Readiness before and after artifacts

`npm run release:readiness` remains useful on a developer machine: before candidate artifacts exist,
the public-v0.4 gate is reported as `external` and the command writes the other readiness findings to
`dist/production-readiness.json`. The release workflow alone uses `--strict --pre-artifact` before
building; this permits only the upgrade gate to remain pending while all other strict gates still
apply.

Publication runs readiness again without `--pre-artifact`, with
`RELEASE_CANDIDATE_EVIDENCE_DIR` pointing at the downloaded macOS and Windows workflow artifacts and
`RELEASE_REVISION` set to the tagged commit. Missing, modified, wrong-version or wrong-revision
evidence is a release failure. Do not use `--pre-artifact` in the publication job or as a manual
waiver.
