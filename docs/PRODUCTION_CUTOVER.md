# Production cutover runbook

Scope: Total v0.5 desktop app, website, downloads, support and feedback. NIC live filing and online
GST portal connectivity are excluded. Offline GST calculations and reviewed exports remain supported.

## 1. Internal acceptance

1. Run `npm run release:readiness` and review `dist/production-readiness.json`.
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

GitHub Actions release secrets:

- macOS: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.
- Windows: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`.

Never place these values in source, local evidence, screenshots or support cases.

## 3. Release

1. Confirm `git status --short` is empty and CI is green on the exact commit.
2. Run `npm version patch`; review the generated version commit and tag.
3. Push the branch and tag with `git push --follow-tags`.
4. Watch both signed platform jobs and the final publish job. A release is complete only when DMG,
   ZIP, NSIS, updater manifests, scorecards and build evidence are present in one public release.
5. Install from the public download page on clean macOS and Windows profiles. Post a voucher, back up,
   restore, relaunch and confirm update checks.
6. Roll back by withdrawing the affected release and publishing a fixed higher version. Never replace
   assets under an existing version or silently downgrade a customer database.

## 4. Go/no-go authority

The release owner makes the final decision. Any correctness, backup, migration, signing, update,
privacy, support-delivery or install failure is a no-go. NIC and online GST portal status must be
described as experimental and outside the production claim everywhere it is mentioned.
