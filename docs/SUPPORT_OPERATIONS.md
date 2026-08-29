# Support and feedback operations

Total v5 stores website support cases and feedback events as private objects in the Vercel Blob
store connected to the `total-site` project. The store is located in Mumbai (`bom1`). Public Blob
URLs cannot read these objects; operators need project access. A configured webhook is an optional
notification path, not the system of record.

## Case workflow

1. A valid submission receives a `TOT-YYYYMMDD-XXXXXXXXXXXX` reference only after the private object is
   written. If storage fails, the UI preserves the reference and opens a prepared email fallback.
2. Confirm intake in Vercel Storage under `support/YYYY/MM/<case-id>.json`. Never download case
   content to an unmanaged device or paste it into issues, chat, CI logs or screenshots.
3. Use `PATCH /api/support` with the admin bearer secret to move the case through `submitted`,
   `in_review`, `waiting_for_customer` and `resolved`. The submitter can see only that status,
   category and timestamps after supplying the case ID and matching email.
4. Keep customer replies under the same case reference. Do not request passwords, provider keys,
   bank credentials or full books.

The production/preview admin secret is stored in Vercel, GitHub Actions and the local macOS Keychain
item `total-support-admin` for account `IrminFlow`. Rotate all three copies together and immediately
exercise create, track, update and delete.

## Retention and deletion

- Resolve inactive cases after confirming the outcome; delete them 90 days after resolution.
- Retain feedback suggestions and follow contacts for no more than 24 months after last activity.
- A verified deletion request is acknowledged and completed within 30 days. Match both the case ID
  and submission email before deleting.
- `DELETE /api/support?caseId=...` requires the admin bearer secret and removes the whole case JSON,
  including its message, diagnostics and screenshot. Confirm the object is absent and case tracking
  returns 404, then record only the case ID, deletion date and operator in the internal deletion log.
- Pause deletion only for a documented legal or security hold. Record the reason, owner and review
  date without copying the case payload.

Monthly operations review resolved-case age, feedback age, storage access membership, failed
notifications, deletion requests and a synthetic no-customer-data case. Blob deletion is
irreversible; confirm the exact case reference before running it.

## Feedback moderation

Votes and follows are append-only private events. Suggested ideas remain private until a product
owner reviews them for personal information, customer book data, abuse and duplication. Only a
sanitized title and product-job description may be promoted to the public board. Release linkage is
added only after the feature is present in a published build.
