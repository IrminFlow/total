# Encrypted collaboration deployment

Total's optional sync lane is local-first and intentionally separate from accounting posting. It
replicates only proposals, drafts, comments and tasks. The live SQLite file, vouchers, masters,
amounts and provider credentials are never uploaded by this protocol.

## Supabase deployment

The isolated staging project `cewz…qmlx` exists. These migrations are applied:

- `202608270001_encrypted_collaboration.sql`
- `202608270002_support_feedback.sql`
- `202608280001_intake_external_ids.sql`
- `202608280002_collaboration_devices.sql`

`total-sync` v9 and `total-intake` v10 are active. A request to `total-sync` without a Supabase JWT
returns HTTP 401. This proves the unauthenticated boundary on staging; it is not real two-user
acceptance and does not configure production.

For a separate production project or a replacement staging project:

1. Create the Supabase project and enable email or OAuth authentication.
2. Apply every migration in `supabase/migrations` in filename order.
3. Deploy `supabase/functions/total-sync` with JWT verification enabled and deploy
   `supabase/functions/total-intake` with its dedicated bearer boundary.
4. In Total, use `https://PROJECT.supabase.co/functions/v1/total-sync` as the service URL, the
   signed-in user's short-lived access token, and a new workspace UUID.
5. Save the recovery key outside Total. Import the same key and workspace UUID on every device.

The free-tier database only sees signed AES-256-GCM envelopes and routing metadata. Ed25519
signatures reject modified envelopes. Vector clocks and deterministic field-level merging preserve
offline edits; concurrent values create visible local conflict records.

## Protocol contract

- `POST /v1/workspaces/{workspaceId}/envelopes` with `{ envelopes: EncryptedSyncEnvelope[] }`
  returns `{ accepted: string[] }`.
- `GET /v1/workspaces/{workspaceId}/envelopes?cursor=...&limit=100` returns
  `{ envelopes: EncryptedSyncEnvelope[], cursor: string | null }`.
- Requests use `Authorization: Bearer <user access token>`.
- POST is idempotent by workspace and envelope ID. History is append-only.
- Responses and requests are bounded to 100 envelopes and 2 MB.
- The relay verifies every envelope's Ed25519 signature against the public key registered for that
  workspace device. Unknown, revoked or mismatched devices fail closed.
- While enabled, the desktop app polls in the background once per minute and also offers an
  explicit **Sync now** action. Failed polls preserve the outbox and retry without blocking work.

## Session refresh and invalid-envelope handling

Total may store a Supabase refresh token and anon key with the short-lived access token in the
OS-protected device credential store. The pair is optional, but one cannot be configured without the
other. Refresh requests go only to `/auth/v1/token` on the same trusted `*.supabase.co` origin as the
configured Edge Function. Concurrent refreshes share one request. A service call retries once after
HTTP 401; another 401 requires the user to reconnect the workspace.

The desktop verifies the device signature again before decrypting an incoming envelope. A bad
signature, malformed envelope or wrong workspace is recorded as a rejected quarantine row with a
bounded error. The cursor still advances, so one poison row cannot prevent later valid review work
from syncing. Quarantined payloads never enter posted books.

Any Convex, Cloudflare Worker, Fly.io or self-hosted implementation can provide the same two routes.
The backend must authenticate membership, preserve envelope bytes, provide a stable forward cursor,
and never log authorization headers or envelope bodies.

## Local diagnostics

**Settings → Encrypted collaboration** reports the local phase (`not configured`, `paused`, `up
to date`, `waiting to sync`, `syncing now` or `needs attention`), pending-envelope and conflict
counts, the last attempt, the last successful sync and a bounded last error. These diagnostics stay
on the device. They do not contain envelope bodies, recovery material, access tokens, accounting
amounts, names, GSTINs or vouchers.

## Collaboration boundaries

Sync records are a separate CRDT materialized view. Product surfaces must explicitly publish a
collaboration change through `collaboration:publish`; syncing does not mutate posted vouchers or
master records. Promotion of a proposal or draft into the books still uses Total's ordinary local
validation, permission, period-lock and audit paths.

## Team invitations

Company owners create invitations from **Settings → Encrypted collaboration**. The Edge Function
generates a random 256-bit code and stores only its SHA-256 hash. Codes expire after the chosen
period, can be revoked by the owner and are consumed transactionally by exactly one authenticated
Supabase user. Create/list/revoke routes verify workspace ownership both through RLS and the
database function; acceptance verifies the current authenticated user before adding membership.

The invitation code grants backend membership but contains no decryption material. Send the
workspace recovery key through a different trusted channel. The joining company owner enters the
service URL, their own access token, invitation code and recovery key in Total. Nobody should share
Supabase access tokens or service-role keys.

Real acceptance still requires two different authenticated users, separate client sessions,
invitation and revocation checks, bidirectional/offline sync, token expiry and revocation, signature
quarantine, conflict review, and confirmation that no posted books or recovery material reached
Supabase.
