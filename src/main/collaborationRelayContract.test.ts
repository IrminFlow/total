import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LocalCollaborationRelay } from "./testing/localCollaborationRelay";

const OWNER = "11111111-1111-4111-8111-111111111111";
const MEMBER = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENDPOINT = "http://localhost/v1";

async function body(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

function request(relay: LocalCollaborationRelay, token: string, path: string, method = "GET", value?: unknown) {
  return relay.fetch(`${ENDPOINT}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(value === undefined ? {} : { "content-type": "application/json" }) },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
}

async function createInvitation(relay: LocalCollaborationRelay, ownerToken: string, expiresInHours = 24) {
  const response = await request(relay, ownerToken, `/workspaces/${WORKSPACE}/invitations`, "POST", { expiresInHours });
  expect(response.status).toBe(201);
  return body(response);
}

describe("Supabase-compatible collaboration relay contract", () => {
  it("validates the request bearer token without relying on an Edge Function auth session", () => {
    const source = readFileSync(
      resolve(process.cwd(), "supabase/functions/total-sync/index.ts"),
      "utf8",
    );
    expect(source).toMatch(/const accessToken = authorization\.slice\([^\n]+\.trim\(\)/);
    expect(source).toMatch(/authClient\.auth\.getUser\(accessToken\)/);
    expect(source).not.toMatch(/\.auth\.getUser\(\)/);
    expect(source).toMatch(/\.eq\("owner_id", user\.id\)\.maybeSingle\(\)/);
    expect(source).toMatch(/\.eq\("workspace_id", workspaceId\)\.eq\("user_id", user\.id\)\.maybeSingle\(\)/);
  });

  it("keeps deployed workspace RLS checks non-recursive", () => {
    const migration = readFileSync(
      resolve(process.cwd(), "supabase/migrations/202608280003_collaboration_rls.sql"),
      "utf8",
    );
    expect(migration).toMatch(/security definer set search_path = public/);
    expect(migration).toMatch(/total_sync_is_workspace_owner\(workspace_id, auth\.uid\(\)\)/);
    expect(migration).toMatch(/total_sync_is_workspace_member\(workspace_id, auth\.uid\(\)\)/);
    expect(migration).not.toMatch(/exists \(\s*select 1 from public\.total_sync_(?:members|workspaces) [mw]\s+where [\s\S]{0,160}create policy/);
  });

  it("allows accepted-user deletion without erasing invitation history", () => {
    const migration = readFileSync(
      resolve(process.cwd(), "supabase/migrations/202608280004_collaboration_invitation_history.sql"),
      "utf8",
    );
    expect(migration).toMatch(/drop constraint if exists total_sync_invitations_check/);
    expect(migration).toMatch(/accepted_by is null or accepted_at is not null/);
  });

  it("rejects expired invitations without creating membership", async () => {
    const relay = new LocalCollaborationRelay();
    const ownerToken = relay.registerUser(OWNER);
    const memberToken = relay.registerUser(MEMBER);
    const created = await createInvitation(relay, ownerToken, 1);
    relay.advanceTime(3_600_001);
    const response = await request(relay, memberToken, "/invitations/accept", "POST", { invitationCode: created.invitationCode });
    expect(response.status).toBe(403);
    expect(relay.memberRole(WORKSPACE, MEMBER)).toBeNull();
  });

  it("rejects revoked invitations and keeps owner-only revocation", async () => {
    const relay = new LocalCollaborationRelay();
    const ownerToken = relay.registerUser(OWNER);
    const memberToken = relay.registerUser(MEMBER);
    const created = await createInvitation(relay, ownerToken);
    const forbidden = await request(relay, memberToken, `/workspaces/${WORKSPACE}/invitations/${created.invitation.id}`, "DELETE");
    expect(forbidden.status).toBe(403);
    expect((await request(relay, ownerToken, `/workspaces/${WORKSPACE}/invitations/${created.invitation.id}`, "DELETE")).status).toBe(200);
    expect((await request(relay, memberToken, "/invitations/accept", "POST", { invitationCode: created.invitationCode })).status).toBe(403);
  });

  it("consumes an invitation once and binds membership to the authenticated caller", async () => {
    const relay = new LocalCollaborationRelay();
    const ownerToken = relay.registerUser(OWNER);
    const memberToken = relay.registerUser(MEMBER);
    const otherToken = relay.registerUser(OTHER);
    const created = await createInvitation(relay, ownerToken);
    expect((await request(relay, memberToken, "/invitations/accept", "POST", { invitationCode: created.invitationCode })).status).toBe(200);
    expect(relay.memberRole(WORKSPACE, MEMBER)).toBe("member");
    expect((await request(relay, otherToken, "/invitations/accept", "POST", { invitationCode: created.invitationCode })).status).toBe(403);
    expect(relay.memberRole(WORKSPACE, OTHER)).toBeNull();
  });

  it("prevents non-owners and outsiders from managing a workspace", async () => {
    const relay = new LocalCollaborationRelay();
    const ownerToken = relay.registerUser(OWNER);
    const memberToken = relay.registerUser(MEMBER);
    const otherToken = relay.registerUser(OTHER);
    const created = await createInvitation(relay, ownerToken);
    await request(relay, memberToken, "/invitations/accept", "POST", { invitationCode: created.invitationCode });
    expect((await request(relay, memberToken, `/workspaces/${WORKSPACE}/invitations`)).status).toBe(403);
    expect((await request(relay, memberToken, `/workspaces/${WORKSPACE}/invitations`, "POST", { expiresInHours: 24 })).status).toBe(403);
    expect((await request(relay, otherToken, `/workspaces/${WORKSPACE}/envelopes`)).status).toBe(403);
  });

  it("keeps envelope uploads idempotent and cursors stable across replay", async () => {
    const relay = new LocalCollaborationRelay();
    const ownerToken = relay.registerUser(OWNER);
    const envelope = {
      protocol: "total-sync/v1", workspaceId: WORKSPACE,
      envelopeId: "44444444-4444-4444-8444-444444444444",
      deviceId: "55555555-5555-4555-8555-555555555555",
      sequence: 1, entityKind: "task", entityId: "close-books",
    };
    const path = `/workspaces/${WORKSPACE}/envelopes`;
    expect((await request(relay, ownerToken, path, "POST", { envelopes: [envelope] })).status).toBe(200);
    expect((await request(relay, ownerToken, path, "POST", { envelopes: [envelope] })).status).toBe(200);
    expect(relay.envelopeCount(WORKSPACE)).toBe(1);
    const first = await body(await request(relay, ownerToken, `${path}?limit=100`));
    const replay = await body(await request(relay, ownerToken, `${path}?limit=100&cursor=0`));
    const after = await body(await request(relay, ownerToken, `${path}?limit=100&cursor=${first.cursor}`));
    expect(replay).toEqual(first);
    expect(after).toEqual({ envelopes: [], cursor: first.cursor });
  });

  it("bounds envelope batches and request bytes", async () => {
    const relay = new LocalCollaborationRelay();
    const ownerToken = relay.registerUser(OWNER);
    const path = `/workspaces/${WORKSPACE}/envelopes`;
    expect((await request(relay, ownerToken, path, "POST", { envelopes: Array.from({ length: 101 }, () => ({})) })).status).toBe(400);
    expect((await request(relay, ownerToken, path, "POST", { envelopes: [], padding: "x".repeat(2 * 1024 * 1024) })).status).toBe(413);
  });
});
