# Support and feedback data operations

The website stores support cases and feedback events only when private Vercel Blob storage is connected. Request controls persist keyed HMAC digests, timestamps, route names, and opaque receipt IDs. They do not store client IP addresses or user-agent strings.

## Required production configuration

- `BLOB_READ_WRITE_TOKEN`: private Blob storage for cases, events, rate records, and retention indexes.
- `INTAKE_SECURITY_SECRET`: at least 32 random bytes, required with shared Blob storage and used only for keyed rate-limit and dedupe identities.
- `INTAKE_ADMIN_SECRET`: at least 32 random characters; authenticates support/feedback administration, exact deletion, and legal/security hold changes. It is never sent externally.
- `CRON_SECRET`: at least 32 random characters; authenticates the Vercel retention cron.
- `CONVEX_SUPPORT_URL` or `SUPPORT_WEBHOOK_URL`: optional HTTPS support notification endpoint.
- `CONVEX_FEEDBACK_URL`: optional HTTPS feedback provider.
- `SUPPORT_PROVIDER_SECRET`, `FEEDBACK_PROVIDER_SECRET`, and `COHORT_PROVIDER_SECRET`: optional,
  provider-specific outbound bearer credentials. Never reuse an administration, cron, storage, or
  intake-HMAC credential.

Every configured administration, cron, intake-HMAC and provider credential must be distinct. The API
fails closed if privileged credentials are shorter than 32 characters or any configured values collide.

`vercel.json` calls `GET /api/maintenance/intake?limit=100` every day at 03:17 UTC. Vercel sends `Authorization: Bearer $CRON_SECRET`. A run examines at most 100 support indexes, 100 feedback indexes, and 100 records from each security prefix. Repeated runs drain a backlog without an unbounded scan.

Resolved support cases are indexed for deletion 90 days after resolution. Reopening a case removes its deletion index. Blob-backed feedback events are indexed for deletion 24 calendar months after their recorded activity. Cleanup removes the primary object, its retention index, its pointer, and support status history together.

## Deletion and holds

Authenticated support deletion uses `DELETE /api/support?caseId=…`. Feedback deletion uses `DELETE /api/feedback` with 1 to 20 exact `{ id, receivedAt }` references. Both use `Authorization: Bearer $INTAKE_ADMIN_SECRET` and reject active holds.

Create a temporary hold with `PATCH /api/maintenance/intake` and `Authorization: Bearer $INTAKE_ADMIN_SECRET`, plus a JSON body containing `entity`, `id`, `reasonCode` (`legal` or `security`), and `holdUntil`. A hold may last up to two years and can be extended. Release it with `DELETE /api/maintenance/intake?entity=…&id=…`; the original deletion date is restored. Scheduled cleanup accepts only `CRON_SECRET`.

After deployment, submit one synthetic case and one feedback event, resolve the case through the authenticated API, confirm their retention indexes in private Blob storage, invoke the maintenance endpoint with a small limit, and retain the redacted JSON response as release evidence. If `CONVEX_FEEDBACK_URL` is used, that provider must apply the same 24-month deletion rule to its copy; the website cannot delete data held by an external provider without that provider's deletion contract.

## Release evidence

`/api/deployment` returns the current immutable source revision, deployment ID and site version with
`Cache-Control: private, no-store`. Vercel supplies `VERCEL_GIT_COMMIT_SHA` and
`VERCEL_DEPLOYMENT_ID`; `TOTAL_SITE_REVISION` and `TOTAL_DEPLOYMENT_ID` are explicit fallbacks when
system variables are not exposed.

The release gate runs `npm run release:live -- --intake-evidence` with the expected commit and an
authenticated synthetic email. It must complete support create, track, resolve and delete plus
feedback vote, follow, submit and exact cleanup. The resulting `dist/production-services.json` is
valid for six hours and only for its exact source revision, deployment ID and product version.
Configuration presence and the dated files in `docs/evidence/` are not production acceptance.
