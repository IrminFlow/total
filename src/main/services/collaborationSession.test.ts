import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CollaborationCredentials } from "./collaborationCredentials";

const mocked = vi.hoisted(() => ({
  credentials: null as CollaborationCredentials | null,
  rotations: [] as Array<{ apiToken: string; refreshToken?: string; accessTokenExpiresAt: string }>,
}));

vi.mock("./collaborationCredentials", () => ({
  readCollaborationCredentials: () => mocked.credentials,
  updateCollaborationSession: (_slug: string, session: { apiToken: string; refreshToken?: string; accessTokenExpiresAt: string }) => {
    mocked.rotations.push(session);
    mocked.credentials = { ...mocked.credentials!, ...session };
    return mocked.credentials;
  },
}));

import { collaborationFetch, supabaseAuthUrl } from "./collaborationSession";

const base = (): CollaborationCredentials => ({
  enabled: true,
  endpoint: "https://project.supabase.co/functions/v1/total-sync",
  workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  apiToken: "old-access",
  refreshToken: "old-refresh",
  anonKey: "public-anon",
  accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
  deviceId: "11111111-1111-4111-8111-111111111111",
  keys: { encryptionKey: Buffer.alloc(32), signingPrivateKey: "private", signingPublicKey: "public" },
});

beforeEach(() => { mocked.credentials = base(); mocked.rotations = []; });

describe("collaboration Supabase session lifecycle", () => {
  it("derives the auth route only for a trusted same-origin Supabase Edge Function", () => {
    expect(supabaseAuthUrl(base())).toBe("https://project.supabase.co/auth/v1/token?grant_type=refresh_token");
    expect(supabaseAuthUrl({ ...base(), endpoint: "https://relay.example/functions/v1/sync" })).toBeNull();
    expect(supabaseAuthUrl({ ...base(), endpoint: "https://project.supabase.co.evil.test/functions/v1/sync" })).toBeNull();
  });

  it("refreshes before expiry and atomically persists rotated access and refresh tokens", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = input.toString(); calls.push(url);
      if (url.includes("/auth/v1/token")) {
        expect(init?.headers).toMatchObject({ apikey: "public-anon" });
        return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
      }
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer new-access");
      return Response.json({ ok: true });
    };
    expect((await collaborationFetch("books", "https://project.supabase.co/functions/v1/total-sync/v1/workspaces", {}, fetchImpl)).ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(mocked.rotations[0]).toMatchObject({ apiToken: "new-access", refreshToken: "new-refresh" });
  });

  it("refreshes once after a 401 and retries with the rotated token", async () => {
    mocked.credentials!.accessTokenExpiresAt = new Date(Date.now() + 3600_000).toISOString();
    let resourceCalls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      if (input.toString().includes("/auth/v1/token")) return Response.json({ access_token: "after-401", expires_in: 3600 });
      resourceCalls += 1;
      return resourceCalls === 1 ? new Response(null, { status: 401 }) : Response.json({ authorization: (init?.headers as Record<string, string>).authorization });
    };
    const response = await collaborationFetch("books", "https://project.supabase.co/functions/v1/total-sync/data", {}, fetchImpl);
    expect(await response.json()).toEqual({ authorization: "Bearer after-401" });
    expect(resourceCalls).toBe(2);
  });

  it("fails safely for revoked and offline refresh sessions without exposing credentials", async () => {
    await expect(collaborationFetch("books", "https://project.supabase.co/functions/v1/total-sync/data", {}, async () => new Response(null, { status: 400 })))
      .rejects.toThrow("revoked or expired");
    await expect(collaborationFetch("books", "https://project.supabase.co/functions/v1/total-sync/data", {}, async () => { throw new Error("old-refresh secret"); }))
      .rejects.toThrow("while offline");
  });

  it("keeps custom bearer endpoints static and never guesses a refresh route", async () => {
    mocked.credentials = { ...base(), endpoint: "https://sync.example/api", accessTokenExpiresAt: new Date(0).toISOString() };
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer old-access");
      return new Response(null, { status: 401 });
    });
    expect((await collaborationFetch("books", "https://sync.example/api/data", {}, fetchImpl)).status).toBe(401);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(mocked.rotations).toEqual([]);
  });

  it("never forwards a collaboration token outside the configured endpoint", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    mocked.credentials!.accessTokenExpiresAt = new Date(Date.now() + 3600_000).toISOString();
    await expect(collaborationFetch("books", "https://evil.example/collect", {}, fetchImpl))
      .rejects.toThrow("left the configured endpoint");
    await expect(collaborationFetch("books", "https://project.supabase.co/functions/v1/other-service", {}, fetchImpl))
      .rejects.toThrow("left the configured endpoint");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
