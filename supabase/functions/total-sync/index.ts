import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
};
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { ...cors, "content-type": "application/json", "cache-control": "no-store" },
});

const tokenString = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const sha256 = async (value: string): Promise<string> => Array.from(
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
).map((byte) => byte.toString(16).padStart(2, "0")).join("");
const invitationView = (row: Record<string, unknown>) => ({
  id: row.id,
  workspaceId: row.workspace_id,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  acceptedAt: row.accepted_at,
  revokedAt: row.revoked_at,
});

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return json({ error: "Authentication required" }, 401);
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { authorization } } },
  );
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "Invalid or expired access token" }, 401);

  const pathname = new URL(request.url).pathname;
  if (request.method === "POST" && /\/v1\/invitations\/accept$/i.test(pathname)) {
    let body: { invitationCode?: unknown };
    try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
    const code = typeof body.invitationCode === "string" ? body.invitationCode.trim() : "";
    const parsed = /^total-invite-v1:([0-9a-f-]{36}):([A-Za-z0-9_-]{32,128})$/i.exec(code);
    if (!parsed) return json({ error: "Invalid invitation code" }, 400);
    const workspaceId = parsed[1]!;
    const tokenHash = await sha256(parsed[2]!);
    const { error } = await supabase.rpc("total_sync_accept_invitation", {
      p_workspace_id: workspaceId,
      p_token_hash: tokenHash,
    });
    if (error) return json({ error: "Invitation is invalid, expired, revoked or already used" }, 403);
    return json({ workspaceId });
  }

  const invitationMatch = pathname.match(/\/v1\/workspaces\/([0-9a-f-]{36})\/invitations(?:\/([0-9a-f-]{36}))?$/i);
  if (invitationMatch) {
    const workspaceId = invitationMatch[1]!;
    const invitationId = invitationMatch[2];
    if (request.method === "GET" && !invitationId) {
      const { data, error } = await supabase.from("total_sync_invitations")
        .select("id,workspace_id,expires_at,created_at,accepted_at,revoked_at")
        .eq("workspace_id", workspaceId)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) return json({ error: "Workspace owner access required" }, 403);
      return json({ invitations: (data ?? []).map((row) => invitationView(row)) });
    }
    if (request.method === "POST" && !invitationId) {
      let body: { expiresInHours?: unknown } = {};
      try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const expiresInHours = typeof body.expiresInHours === "number" ? body.expiresInHours : 24;
      if (!Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 720)
        return json({ error: "Invitation expiry must be between 1 and 720 hours" }, 400);
      const { data: workspace } = await supabase.from("total_sync_workspaces")
        .select("id").eq("id", workspaceId).maybeSingle();
      if (!workspace) {
        const created = await supabase.from("total_sync_workspaces")
          .insert({ id: workspaceId, owner_id: user.id });
        if (created.error) return json({ error: "Workspace owner access required" }, 403);
        const membership = await supabase.from("total_sync_members")
          .insert({ workspace_id: workspaceId, user_id: user.id, role: "owner" });
        if (membership.error) return json({ error: "Workspace membership could not be created" }, 403);
      }
      const token = tokenString();
      const expiresAt = new Date(Date.now() + expiresInHours * 3_600_000).toISOString();
      const { data, error } = await supabase.rpc("total_sync_create_invitation", {
        p_workspace_id: workspaceId,
        p_token_hash: await sha256(token),
        p_expires_at: expiresAt,
      });
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row) return json({ error: "Workspace owner access required" }, 403);
      return json({
        invitation: invitationView(row as Record<string, unknown>),
        invitationCode: `total-invite-v1:${workspaceId}:${token}`,
      }, 201);
    }
    if (request.method === "DELETE" && invitationId) {
      const { data, error } = await supabase.rpc("total_sync_revoke_invitation", {
        p_invitation_id: invitationId,
      });
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row) return json({ error: "Active invitation not found" }, 403);
      return json({ invitation: invitationView(row as Record<string, unknown>) });
    }
    return json({ error: "Method not allowed" }, 405);
  }

  const match = pathname.match(/\/v1\/workspaces\/([0-9a-f-]{36})\/envelopes$/i);
  if (!match) return json({ error: "Route not found" }, 404);
  const workspaceId = match[1];

  if (request.method === "POST") {
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > 2 * 1024 * 1024) return json({ error: "Request too large" }, 413);
    let body: { envelopes?: unknown[] };
    try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
    if (!Array.isArray(body.envelopes) || body.envelopes.length > 100)
      return json({ error: "Expected at most 100 envelopes" }, 400);

    // A user's first device may create its own workspace. RLS prevents claiming another
    // owner's ID, and the membership insert only allows the owner to add themself.
    const { data: existing } = await supabase.from("total_sync_workspaces").select("id").eq("id", workspaceId).maybeSingle();
    if (!existing) {
      const created = await supabase.from("total_sync_workspaces").insert({ id: workspaceId, owner_id: user.id });
      if (created.error && created.error.code !== "23505")
        return json({ error: "Workspace could not be created" }, 403);
    }
    const { data: selfMembership } = await supabase.from("total_sync_members")
      .select("workspace_id").eq("workspace_id", workspaceId).eq("user_id", user.id).maybeSingle();
    if (!selfMembership) {
      const membership = await supabase.from("total_sync_members").insert(
        { workspace_id: workspaceId, user_id: user.id, role: "owner" },
      );
      if (membership.error) return json({ error: "Workspace access denied" }, 403);
    }

    let rows: Record<string, unknown>[];
    try {
      rows = body.envelopes.map((value) => {
        if (!value || typeof value !== "object") throw new Error("Invalid envelope");
        const envelope = value as Record<string, unknown>;
        if (envelope.protocol !== "total-sync/v1" || envelope.workspaceId !== workspaceId)
          throw new Error("Envelope workspace mismatch");
        if (!['proposal','draft','comment','task'].includes(String(envelope.entityKind)))
          throw new Error("Unsupported collaboration entity");
        if (typeof envelope.envelopeId !== "string" || typeof envelope.deviceId !== "string" ||
            !Number.isSafeInteger(envelope.sequence) || Number(envelope.sequence) < 1 ||
            typeof envelope.entityId !== "string" || envelope.entityId.length > 180)
          throw new Error("Invalid envelope routing metadata");
        return {
          workspace_id: workspaceId,
          envelope_id: envelope.envelopeId,
          device_id: envelope.deviceId,
          sequence: envelope.sequence,
          entity_kind: envelope.entityKind,
          entity_id: envelope.entityId,
          payload: envelope,
        };
      });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Invalid envelope" }, 400);
    }
    const { error } = await supabase.from("total_sync_envelopes").upsert(rows, {
      onConflict: "workspace_id,envelope_id",
      ignoreDuplicates: true,
    });
    if (error) return json({ error: "Encrypted envelopes were not accepted" }, 403);
    return json({ accepted: rows.map((row) => row.envelope_id) });
  }

  if (request.method === "GET") {
    const url = new URL(request.url);
    const cursor = Math.max(0, Number.parseInt(url.searchParams.get("cursor") ?? "0", 10) || 0);
    const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "100", 10) || 100));
    const { data, error } = await supabase.from("total_sync_envelopes")
      .select("relay_id,payload")
      .eq("workspace_id", workspaceId)
      .gt("relay_id", cursor)
      .order("relay_id", { ascending: true })
      .limit(limit);
    if (error) return json({ error: "Workspace access denied" }, 403);
    const rows = data ?? [];
    return json({
      envelopes: rows.map((row) => row.payload),
      cursor: rows.length ? String(rows[rows.length - 1].relay_id) : String(cursor),
    });
  }

  return json({ error: "Method not allowed" }, 405);
});
