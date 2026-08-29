# Support and feedback data operations

The website accepts support and feedback at same-origin API routes. Private Vercel Blob remains the
website's durable support case store and supplies rate limiting, case tracking, retention indexes and
exact deletion. The recommended Supabase intake function receives a second support copy and is the
hosted feedback provider. Request controls persist keyed HMAC digests, timestamps, route names, and
opaque receipt IDs. They do not store client IP addresses or user-agent strings.

## Current staging status

The isolated site is deployed at `https://total-v5-staging.vercel.app`. Its support and feedback
provider variables point to the isolated Supabase project `cewz…qmlx`, where all migrations through
`202608280004_collaboration_invitation_history.sql` are applied and `total-intake` v10 is active. `total-sync` v13
is also active and returns HTTP 401 without a Supabase JWT.

A staging synthetic run passed support creation, private-token status tracking, feedback idea
submission, voting and following. This is staging evidence only. The production domain, production
Vercel environment and production Supabase configuration remain untouched and pending.

## Required production configuration

- `BLOB_READ_WRITE_TOKEN`: private Blob storage for cases, events, rate records, and retention indexes.
- `INTAKE_SECURITY_SECRET`: at least 32 random bytes, required with shared Blob storage and used only for keyed rate-limit and dedupe identities.
- `INTAKE_ADMIN_SECRET`: at least 32 random characters; authenticates support/feedback administration, exact deletion, and legal/security hold changes. It is never sent externally.
- `CRON_SECRET`: at least 32 random characters; authenticates the Vercel retention cron.
- `SUPABASE_SUPPORT_URL` (recommended), `CONVEX_SUPPORT_URL`, or `SUPPORT_WEBHOOK_URL`: optional HTTPS support intake/notification endpoint. Supabase takes precedence when more than one is configured.
- `SUPABASE_FEEDBACK_URL` (recommended) or `CONVEX_FEEDBACK_URL`: optional HTTPS feedback provider. Supabase takes precedence when both are configured.
- `SUPABASE_INTAKE_SECRET`: server-only bearer credential for both `SUPABASE_*` targets. Configure
  the identical value as `TOTAL_INTAKE_SECRET` in the Supabase function. It is never included in a
  browser response, client bundle, support payload, feedback payload, or log.
- `SUPPORT_PROVIDER_SECRET`, `FEEDBACK_PROVIDER_SECRET`, and `COHORT_PROVIDER_SECRET`: optional,
  provider-specific outbound bearer credentials for non-Supabase destinations. Never reuse an
  administration, cron, storage, Supabase intake, or intake-HMAC credential.

Every configured administration, cron, intake-HMAC and provider credential must be distinct. The
single `SUPABASE_INTAKE_SECRET` is intentionally shared only by the two paths of the same Supabase
function. The API fails closed if privileged credentials are shorter than 32 characters or if any
separate trust boundaries collide.

## Deploy a separate production or replacement intake backend

For a separate production project or a replacement staging project, create the project, install and
authenticate the Supabase CLI, then run these commands from the repository root. The migrations
create support and feedback tables with row-level security enabled and remove all direct `anon` and
`authenticated` access. Only the Edge Function service role can write.

```bash
export TOTAL_SUPABASE_PROJECT_REF="your-project-ref"
supabase link --project-ref "$TOTAL_SUPABASE_PROJECT_REF"
supabase db push
supabase functions deploy total-intake --project-ref "$TOTAL_SUPABASE_PROJECT_REF" --no-verify-jwt
```

Create a local environment file outside the repository with permissions limited to your account:

```dotenv
TOTAL_INTAKE_SECRET=<at-least-32-random-bytes>
RESEND_API_KEY=<resend-server-api-key>
TOTAL_SUPPORT_EMAIL=support@example.com
TOTAL_SUPPORT_FROM=Total Support <support@notifications.example.com>
```

- `TOTAL_INTAKE_SECRET` authenticates only Vercel-to-Supabase requests. Generate a new random value;
  do not reuse an administrator, cron, database, Supabase service-role, or OpenAI key.
- `RESEND_API_KEY` is optional. When present, the function asks Resend to notify the support team.
- `TOTAL_SUPPORT_EMAIL` is the private destination for support notifications and is required when
  `RESEND_API_KEY` is configured.
- `TOTAL_SUPPORT_FROM` is optional and must use a sender/domain verified in Resend. The built-in
  default is suitable only after `notifications.devjindal.tech` has been verified for the project.

Upload those values directly to Supabase without committing the file:

```bash
supabase secrets set --project-ref "$TOTAL_SUPABASE_PROJECT_REF" --env-file /absolute/path/to/total-intake.env
```

Then configure the server-side Vercel environment for the `site` project:

```dotenv
SUPABASE_SUPPORT_URL=https://<project-ref>.supabase.co/functions/v1/total-intake/support
SUPABASE_FEEDBACK_URL=https://<project-ref>.supabase.co/functions/v1/total-intake/feedback
SUPABASE_INTAKE_SECRET=<the-same-value-as-supabase-TOTAL_INTAKE_SECRET>
```

Use the Vercel dashboard or `vercel env add` so the credential is stored as a secret. Do not prefix
it with `NEXT_PUBLIC_`; only `NEXT_PUBLIC_*` values are eligible for browser bundles. Redeploy after
changing any environment value:

```bash
vercel deploy --prod
```

The Supabase function's `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` values are platform-provided.
Never copy the service-role key into Vercel, the desktop app, local company files, or documentation.

`vercel.json` calls `GET /api/maintenance/intake?limit=500` every day at 03:17 UTC. Vercel sends `Authorization: Bearer $CRON_SECRET`. A run deletes at most 500 due support records and 500 due feedback records; each invocation also uses bounded index and security-record scan budgets. Repeated runs drain a backlog without an unbounded scan.

Resolved support cases are indexed for deletion 90 days after resolution. Reopening a case removes its deletion index. Blob-backed feedback events are indexed for deletion 24 calendar months after their recorded activity. Cleanup removes the primary object, its retention index, its pointer, and support status history together.

## Deletion and holds

Support creation returns a random private tracking token. Blob stores only its SHA-256 hash with the
case. Status lookup accepts that token or the matching reply email, applies keyed rate limits and
returns the same not-found response for an invalid reference. The desktop stores its token only in
the device-local `support-cases.json` status ledger and sends it only to the HTTPS status route. It
must never enter app logs, diagnostics, mirrors or company backups.

Authenticated support deletion uses `DELETE /api/support?caseId=…`. Feedback deletion uses `DELETE /api/feedback` with 1 to 20 exact `{ id, receivedAt }` references. Both use `Authorization: Bearer $INTAKE_ADMIN_SECRET` and reject active holds.

Create a temporary hold with `PATCH /api/maintenance/intake` and `Authorization: Bearer $INTAKE_ADMIN_SECRET`, plus a JSON body containing `entity`, `id`, `reasonCode` (`legal` or `security`), and `holdUntil`. A hold may last up to two years and can be extended. Release it with `DELETE /api/maintenance/intake?entity=…&id=…`; the original deletion date is restored. Scheduled cleanup accepts only `CRON_SECRET`.

After deployment, submit one synthetic case and one feedback event, resolve the case through the authenticated API, confirm their retention indexes in private Blob storage, confirm the corresponding rows in Supabase, invoke the maintenance endpoint with a small limit, and retain the redacted JSON response as release evidence. Supabase or any other configured provider must apply the same deletion rules to its copy; the website cannot delete externally held data without that provider's deletion procedure. Until provider-side deletion is automated, delete due Supabase rows through an authenticated administrative process before claiming retention compliance.

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
The successful staging synthetic run is also not production acceptance and must not be reused as
evidence for another deployment revision.
