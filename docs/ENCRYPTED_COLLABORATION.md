# Encrypted collaboration deployment

Total's optional sync lane is local-first and intentionally separate from accounting posting. It
replicates only proposals, drafts, comments and tasks. The live SQLite file, vouchers, masters,
amounts and provider credentials are never uploaded by this protocol.

## Supabase deployment

1. Create a Supabase project and enable email or OAuth authentication.
2. Apply `supabase/migrations/202608270001_encrypted_collaboration.sql`.
3. Deploy `supabase/functions/total-sync` with JWT verification enabled.
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
- While enabled, the desktop app polls in the background once per minute and also offers an
  explicit **Sync now** action. Failed polls preserve the outbox and retry without blocking work.

Any Convex, Cloudflare Worker, Fly.io or self-hosted implementation can provide the same two routes.
The backend must authenticate membership, preserve envelope bytes, provide a stable forward cursor,
and never log authorization headers or envelope bodies.

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
