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
2. Update release notes and run `npm version patch` (or the intended semver level).
3. Push the commit and tag together with `git push --follow-tags`.
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
- The actual public v0.4 packaged app creates a company which the candidate opens twice without
  changing its registry entry, voucher count, reference or trial-balance totals; the migrated
  company also produces a verified backup.
- Uninstall removes the installed application while leaving the company database intact.
- Update manifests match the tag, include SHA-512 integrity metadata, and reference assets in the
  same release.
