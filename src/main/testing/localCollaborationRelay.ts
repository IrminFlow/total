import { createHash, randomBytes, randomUUID } from "node:crypto";

type Invitation = {
  id: string;
  workspaceId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedBy: string | null;
  revokedAt: string | null;
};

type RelayEnvelope = Record<string, unknown> & {
  protocol: string;
  workspaceId: string;
  envelopeId: string;
  deviceId: string;
  sequence: number;
  entityKind: string;
  entityId: string;
};

type Workspace = {
  ownerId: string;
  members: Set<string>;
  envelopes: Array<{ relayId: number; payload: RelayEnvelope }>;
  invitationIds: string[];
};

const MAX_BYTES = 2 * 1024 * 1024;
const ENTITY_KINDS = new Set(["proposal", "draft", "comment", "task"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVITE = /^total-invite-v1:([0-9a-f-]{36}):([A-Za-z0-9_-]{32,128})$/i;

function json(body: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extraHeaders },
  });
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function invitationView(invitation: Invitation): Record<string, unknown> {
  return {
    id: invitation.id,
    workspaceId: invitation.workspaceId,
    expiresAt: invitation.expiresAt,
    createdAt: invitation.createdAt,
    acceptedAt: invitation.acceptedAt,
    revokedAt: invitation.revokedAt,
  };
}

/** Hermetic implementation of the documented total-sync/v1 HTTP contract.
 * It deliberately models Supabase Auth/RLS behavior, not encryption or merge behavior. */
export class LocalCollaborationRelay {
  private readonly users = new Map<string, string>();
  private readonly workspaces = new Map<string, Workspace>();
  private readonly invitations = new Map<string, Invitation>();
  private nowMs = Date.parse("2026-08-28T08:00:00.000Z");

  registerUser(userId: string, token = `token-${userId}`): string {
    if (!UUID.test(userId)) throw new Error("Test user IDs must be UUIDs");
    this.users.set(token, userId);
    return token;
  }

  advanceTime(milliseconds: number): void {
    this.nowMs += milliseconds;
  }

  memberRole(workspaceId: string, userId: string): "owner" | "member" | null {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace || !workspace.members.has(userId)) return null;
    return workspace.ownerId === userId ? "owner" : "member";
  }

  envelopeCount(workspaceId: string): number {
    return this.workspaces.get(workspaceId)?.envelopes.length ?? 0;
  }

  /** Inserts opaque relay data to exercise hostile/corrupt server responses. */
  injectEnvelope(workspaceId: string, payload: RelayEnvelope): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new Error("Workspace does not exist");
    workspace.envelopes.push({ relayId: workspace.envelopes.length + 1, payload });
  }

  fetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    const auth = headers.get("authorization") ?? "";
    const userId = auth.startsWith("Bearer ") ? this.users.get(auth.slice(7)) : undefined;
    if (!userId) return json({ error: "Invalid or expired access token" }, 401);
    const bodyText = typeof init.body === "string" ? init.body : "";
    if (Buffer.byteLength(bodyText, "utf8") > MAX_BYTES) return json({ error: "Request too large" }, 413);

    if (method === "POST" && /\/v1\/invitations\/accept$/i.test(url.pathname)) {
      let body: { invitationCode?: unknown };
      try { body = JSON.parse(bodyText) as { invitationCode?: unknown }; }
      catch { return json({ error: "Invalid JSON" }, 400); }
      const match = typeof body.invitationCode === "string" ? INVITE.exec(body.invitationCode.trim()) : null;
      if (!match) return json({ error: "Invalid invitation code" }, 400);
      const invitation = [...this.invitations.values()].find((candidate) =>
        candidate.workspaceId === match[1] && candidate.tokenHash === hash(match[2]!),
      );
      if (!invitation || invitation.acceptedAt || invitation.revokedAt || Date.parse(invitation.expiresAt) <= this.nowMs)
        return json({ error: "Invitation is invalid, expired, revoked or already used" }, 403);
      const workspace = this.workspaces.get(invitation.workspaceId);
      if (!workspace) return json({ error: "Invitation is invalid" }, 403);
      workspace.members.add(userId);
      invitation.acceptedAt = new Date(this.nowMs).toISOString();
      invitation.acceptedBy = userId;
      return json({ workspaceId: invitation.workspaceId });
    }

    const invitationRoute = url.pathname.match(/\/v1\/workspaces\/([0-9a-f-]{36})\/invitations(?:\/([0-9a-f-]{36}))?$/i);
    if (invitationRoute) {
      const workspaceId = invitationRoute[1]!;
      const invitationId = invitationRoute[2];
      let workspace = this.workspaces.get(workspaceId);
      if (method === "POST" && !workspace) {
        workspace = { ownerId: userId, members: new Set([userId]), envelopes: [], invitationIds: [] };
        this.workspaces.set(workspaceId, workspace);
      }
      if (!workspace || workspace.ownerId !== userId)
        return json({ error: "Workspace owner access required" }, 403);
      if (method === "GET" && !invitationId) {
        return json({ invitations: workspace.invitationIds
          .map((id) => this.invitations.get(id)!)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 100)
          .map(invitationView) });
      }
      if (method === "POST" && !invitationId) {
        let body: { expiresInHours?: unknown };
        try { body = JSON.parse(bodyText) as { expiresInHours?: unknown }; }
        catch { return json({ error: "Invalid JSON" }, 400); }
        const hours = body.expiresInHours ?? 24;
        if (!Number.isInteger(hours) || Number(hours) < 1 || Number(hours) > 720)
          return json({ error: "Invitation expiry must be between 1 and 720 hours" }, 400);
        const token = randomBytes(32).toString("base64url");
        const invitation: Invitation = {
          id: randomUUID(), workspaceId, tokenHash: hash(token),
          createdAt: new Date(this.nowMs).toISOString(),
          expiresAt: new Date(this.nowMs + Number(hours) * 3_600_000).toISOString(),
          acceptedAt: null, acceptedBy: null, revokedAt: null,
        };
        this.invitations.set(invitation.id, invitation);
        workspace.invitationIds.push(invitation.id);
        return json({ invitation: invitationView(invitation), invitationCode: `total-invite-v1:${workspaceId}:${token}` }, 201);
      }
      if (method === "DELETE" && invitationId) {
        const invitation = this.invitations.get(invitationId);
        if (!invitation || invitation.workspaceId !== workspaceId || invitation.acceptedAt || invitation.revokedAt)
          return json({ error: "Active invitation not found" }, 403);
        invitation.revokedAt = new Date(this.nowMs).toISOString();
        return json({ invitation: invitationView(invitation) });
      }
      return json({ error: "Method not allowed" }, 405);
    }

    const envelopeRoute = url.pathname.match(/\/v1\/workspaces\/([0-9a-f-]{36})\/envelopes$/i);
    if (!envelopeRoute) return json({ error: "Route not found" }, 404);
    const workspaceId = envelopeRoute[1]!;
    let workspace = this.workspaces.get(workspaceId);
    if (method === "POST" && !workspace) {
      workspace = { ownerId: userId, members: new Set([userId]), envelopes: [], invitationIds: [] };
      this.workspaces.set(workspaceId, workspace);
    }
    if (!workspace?.members.has(userId)) return json({ error: "Workspace access denied" }, 403);

    if (method === "POST") {
      let body: { envelopes?: unknown };
      try { body = JSON.parse(bodyText) as { envelopes?: unknown }; }
      catch { return json({ error: "Invalid JSON" }, 400); }
      if (!Array.isArray(body.envelopes) || body.envelopes.length > 100)
        return json({ error: "Expected at most 100 envelopes" }, 400);
      const candidates: RelayEnvelope[] = [];
      for (const value of body.envelopes) {
        if (!value || typeof value !== "object") return json({ error: "Invalid envelope" }, 400);
        const envelope = value as RelayEnvelope;
        if (envelope.protocol !== "total-sync/v1" || envelope.workspaceId !== workspaceId)
          return json({ error: "Envelope workspace mismatch" }, 400);
        if (!ENTITY_KINDS.has(String(envelope.entityKind))) return json({ error: "Unsupported collaboration entity" }, 400);
        if (!UUID.test(String(envelope.envelopeId)) || !UUID.test(String(envelope.deviceId)) ||
          !Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1 ||
          typeof envelope.entityId !== "string" || envelope.entityId.length < 1 || envelope.entityId.length > 180)
          return json({ error: "Invalid envelope routing metadata" }, 400);
        candidates.push(envelope);
      }
      for (const envelope of candidates) {
        const duplicateId = workspace.envelopes.some((row) => row.payload.envelopeId === envelope.envelopeId);
        if (duplicateId) continue;
        const duplicateSequence = workspace.envelopes.some((row) =>
          row.payload.deviceId === envelope.deviceId && row.payload.sequence === envelope.sequence,
        );
        if (duplicateSequence) return json({ error: "Encrypted envelopes were not accepted" }, 403);
        workspace.envelopes.push({ relayId: workspace.envelopes.length + 1, payload: envelope });
      }
      return json({ accepted: candidates.map((envelope) => envelope.envelopeId) });
    }

    if (method === "GET") {
      const cursor = Math.max(0, Number.parseInt(url.searchParams.get("cursor") ?? "0", 10) || 0);
      const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "100", 10) || 100));
      const rows = workspace.envelopes.filter((row) => row.relayId > cursor).slice(0, limit);
      return json({
        envelopes: rows.map((row) => row.payload),
        cursor: String(rows.at(-1)?.relayId ?? cursor),
      });
    }
    return json({ error: "Method not allowed" }, 405);
  };
}
