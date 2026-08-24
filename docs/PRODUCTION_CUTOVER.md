# Production cutover runbook

Scope: Total v0.5 desktop app, website, downloads, support and feedback. NIC live filing and online
GST portal connectivity are excluded. Offline GST calculations and reviewed exports remain supported.

## 1. Internal acceptance

1. Run `npm run release:readiness` and review `dist/production-readiness.json`. A local result marks
   the two-platform public-v0.4 upgrade as external until packaged-candidate evidence exists; it does
   not infer readiness from the presence of the smoke script.
   After deployment, run `npm run release:live` and review `dist/production-live-readiness.json`.
2. Run `npm run release:scorecard` on a clean checkout. Do not waive a failed category.
3. Test a representative Tally, Busy, Marg, Zoho Books and spreadsheet migration. Reconcile opening
   debits/credits, voucher counts, tax totals, receivables, payables and stock value. Keep the signed
   reconciliation evidence; do not use customer data in the repository.
4. Complete a two-hour bookkeeper workflow, a month-close workflow and a restore drill on a clean OS
   profile. Record version, OS, result and reviewer in the release evidence folder.
5. Confirm the website’s privacy, terms, security, support, feedback and download routes from a phone
   and desktop browser.

## 2. External service configuration

Vercel (`site` as root directory):

- `GITHUB_TOKEN`: fine-grained, read-only access to releases in `IrminFlow/total` while private.
- `NEXT_PUBLIC_SITE_URL`: canonical HTTPS origin.
- `BLOB_READ_WRITE_TOKEN`: private Vercel Blob intake storage (the current production backend), or
  `CONVEX_SUPPORT_URL` / `SUPPORT_WEBHOOK_URL` for an alternate support service.
- `CONVEX_FEEDBACK_URL`: optional alternate feedback backend; private Blob events are the default.
- `SUPPORT_WEBHOOK_SECRET`: shared bearer secret for case status and deletion operations.

Submit a synthetic support case and feedback idea after deployment. Verify private-store receipt, case ID,
rate limiting, fallback behavior and that no book data appears unless explicitly selected.
The release workflow repeats the destructive-safe synthetic lifecycle and cleanup on the exact tagged
site deployment. Vercel must expose `VERCEL_GIT_COMMIT_SHA` and `VERCEL_DEPLOYMENT_ID`; if system
variables are disabled, configure equivalent `TOTAL_SITE_REVISION` and `TOTAL_DEPLOYMENT_ID` values.
Evidence expires after six hours. Files under `docs/evidence/` are historical records and never waive
the executed release gate.

GitHub Actions release secrets:

- macOS: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.
- Windows: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`.

Never place these values in source, local evidence, screenshots or support cases.

## 3. Release

1. Confirm `git status --short` is empty and CI is green on the exact commit.
2. Confirm `package.json` contains the intended version, then tag the reviewed commit with `git tag "v$(node -p "require('./package.json').version")"`.
3. Push `main` and the tag with `git push origin main --follow-tags`.
4. Watch both signed platform jobs and the final publish job. A release is complete only when DMG,
   ZIP, NSIS, updater manifests, scorecards, public-v0.4 upgrade evidence and build evidence are
   present in one public release. The final job must report that both upgrade evidence sets were
   executed for the exact tagged revision and that their candidate artifact sizes and SHA-256
   digests match the downloaded DMG, ZIP and NSIS files. The build evidence must link those same
   artifacts, each platform scorecard and each upgrade-evidence file.
5. Install from the public download page on clean macOS and Windows profiles. Post a voucher, back up,
   restore, relaunch and confirm update checks.
6. Roll back by withdrawing the affected release and publishing a fixed higher version. Never replace
   assets under an existing version or silently downgrade a customer database.

## 4. Go/no-go authority

The release owner makes the final decision. Missing, stale, wrong-revision or digest-mismatched
candidate evidence is a no-go, even if the upgrade script exists or a workflow step has a passing
name. Stale service evidence, a deployment/revision/version mismatch, or configured support secrets
without a completed synthetic exercise is also a no-go. Any correctness, backup, migration, signing, update,
privacy, support-delivery or install failure is a no-go. NIC and online GST portal status must be
described as experimental and outside the production claim everywhere it is mentioned.
