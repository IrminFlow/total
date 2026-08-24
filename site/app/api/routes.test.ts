import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const blobMocks = vi.hoisted(() => ({
  put: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  del: vi.fn(),
}));

vi.mock("@vercel/blob", () => blobMocks);

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
}));

vi.mock("@/lib/release", () => ({
  RELEASES_PAGE: "https://github.com/IrminFlow/total/releases",
  latestRelease: vi.fn(),
  resolveDownloadUrl: vi.fn(),
}));

const originalEnv = { ...process.env };
let requestNumber = 0;

function post(path: string, body: Record<string, unknown>): NextRequest {
  requestNumber += 1;
  return new NextRequest(`https://total.example${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `192.0.2.${requestNumber}`,
    },
    body: JSON.stringify(body),
  });
}

function installBlobStore(seed: Record<string, unknown> = {}): Map<string, string> {
  const objects = new Map(Object.entries(seed).map(([key, value]) => [key, JSON.stringify(value)]));
  blobMocks.put.mockImplementation(async (pathname: string, value: string, options: { allowOverwrite?: boolean }) => {
    if (objects.has(pathname) && !options.allowOverwrite) throw new Error("already exists");
    objects.set(pathname, value);
    return {};
  });
  blobMocks.get.mockImplementation(async (pathname: string) => {
    const value = objects.get(pathname);
    return value === undefined ? null : { statusCode: 200, stream: new Blob([value]).stream() };
  });
  blobMocks.list.mockImplementation(async ({ prefix, limit = 1_000, cursor }: { prefix: string; limit?: number; cursor?: string }) => {
    const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    const start = cursor ? keys.findIndex((key) => key > cursor) : 0;
    const page = start < 0 ? [] : keys.slice(start, start + limit);
    const hasMore = page.length > 0 && keys.some((key) => key > page.at(-1)!);
    return {
      blobs: page.map((pathname) => ({ pathname, url: `https://blob.example/${pathname}` })),
      hasMore,
      cursor: hasMore ? page.at(-1) : undefined,
    };
  });
  blobMocks.del.mockImplementation(async (target: string | string[]) => {
    for (const item of Array.isArray(target) ? target : [target]) {
      const pathname = item.startsWith("https://blob.example/") ? item.slice("https://blob.example/".length) : item;
      objects.delete(pathname);
    }
  });
  return objects;
}

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.CONVEX_SUPPORT_URL;
  delete process.env.SUPPORT_WEBHOOK_URL;
  delete process.env.CONVEX_FEEDBACK_URL;
  delete process.env.SUPPORT_WEBHOOK_SECRET;
  delete process.env.INTAKE_SECURITY_SECRET;
  delete process.env.CRON_SECRET;
  delete process.env.SUPPORT_FALLBACK_EMAIL;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.VERCEL_OIDC_TOKEN;
  delete process.env.VERCEL_GIT_COMMIT_SHA;
  delete process.env.VERCEL_DEPLOYMENT_ID;
  delete process.env.TOTAL_SITE_REVISION;
  delete process.env.TOTAL_DEPLOYMENT_ID;
  blobMocks.put.mockResolvedValue({});
  blobMocks.get.mockResolvedValue(null);
  blobMocks.list.mockResolvedValue({ blobs: [], hasMore: false, cursor: undefined });
  blobMocks.del.mockResolvedValue(undefined);
});

describe("deployment identity", () => {
  it("exposes the immutable revision, deployment and product version without caching", async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = "a".repeat(40);
    process.env.VERCEL_DEPLOYMENT_ID = "dpl_current123";
    const { GET } = await import("./deployment/route");
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      schema: 1,
      sourceRevision: "a".repeat(40),
      deploymentId: "dpl_current123",
      productVersion: "0.5.0",
    });
  });

  it("fails closed when deployment metadata is unavailable", async () => {
    const { GET } = await import("./deployment/route");
    expect((await GET()).status).toBe(503);
  });
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("support intake", () => {
  it("forwards a bounded case to the configured HTTPS service", async () => {
    process.env.SUPPORT_WEBHOOK_URL = "https://support.example/intake";
    process.env.SUPPORT_WEBHOOK_SECRET = "test-secret";
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./support/route");

    const response = await POST(post("/api/support", {
      category: "bug",
      email: "books@example.com",
      message: "The trial balance screen does not open for this company.",
    }));
    const result = await response.json() as { caseId: string; status: string };

    expect(response.status).toBe(200);
    expect(result.status).toBe("submitted");
    expect(result.caseId).toMatch(/^TOT-\d{8}-[A-F0-9]{12}$/);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://support.example/intake"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer test-secret" }),
      }),
    );
  });

  it("preserves the case id and prepared email when delivery fails", async () => {
    process.env.SUPPORT_WEBHOOK_URL = "https://support.example/intake";
    process.env.SUPPORT_FALLBACK_EMAIL = "help@example.com";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const { POST } = await import("./support/route");

    const response = await POST(post("/api/support", {
      category: "question",
      email: "owner@example.com",
      message: "Please help me restore the verified backup from yesterday.",
    }));
    const result = await response.json() as { caseId: string; status: string; fallbackEmail: string; mailto: string };

    expect(response.status).toBe(202);
    expect(result.status).toBe("fallback");
    expect(result.caseId).toMatch(/^TOT-\d{8}-[A-F0-9]{12}$/);
    expect(result.fallbackEmail).toBe("help@example.com");
    expect(result.mailto).toContain(encodeURIComponent(result.caseId));
  });

  it("rejects invalid support fields before delivery", async () => {
    const { POST } = await import("./support/route");
    const response = await POST(post("/api/support", { message: "short", email: "not-an-email" }));
    expect(response.status).toBe(400);
    const missingEmail = await POST(post("/api/support", {
      message: "Please help me reconcile this opening balance.",
    }));
    expect(missingEmail.status).toBe(400);
    const fakeAnonymousCrash = await POST(post("/api/support", {
      message: "Anonymous crash report",
      crashEnvelope: {},
    }));
    expect(fakeAnonymousCrash.status).toBe(400);
  });

  it("persists a private case and allows email-bound status tracking", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    const { POST, GET } = await import("./support/route");
    const response = await POST(post("/api/support", {
      category: "bug",
      email: "owner@example.com",
      message: "The imported opening balance needs review before month close.",
    }));
    const receipt = await response.json() as { caseId: string; status: string };
    expect(response.status).toBe(200);
    expect(receipt.status).toBe("submitted");
    expect(blobMocks.put).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`${receipt.caseId}\\.json$`)),
      expect.any(String),
      expect.objectContaining({ access: "private", addRandomSuffix: false }),
    );
    const pathname = blobMocks.put.mock.calls.at(-1)![0] as string;
    const stored = JSON.parse(blobMocks.put.mock.calls.at(-1)![1] as string);
    blobMocks.list.mockImplementation(async ({ prefix }: { prefix: string }) => ({
      blobs: prefix === pathname ? [{ pathname, url: `https://private.example/${pathname}` }] : [],
      hasMore: false,
      cursor: undefined,
    }));
    blobMocks.get.mockImplementation(async () => ({ statusCode: 200, stream: new Blob([JSON.stringify(stored)]).stream() }));
    const tracked = await GET(new NextRequest(`https://total.example/api/support?caseId=${receipt.caseId}&email=owner%40example.com`));
    expect(tracked.status).toBe(200);
    expect(await tracked.json()).toMatchObject({ caseId: receipt.caseId, status: "submitted" });
    const hidden = await GET(new NextRequest(`https://total.example/api/support?caseId=${receipt.caseId}&email=wrong%40example.com`));
    expect(hidden.status).toBe(404);
  });

  it("rate limits public tracking without storing raw lookup data", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    process.env.INTAKE_SECURITY_SECRET = "a-separate-test-secret-with-32-bytes";
    const caseId = "TOT-20260824-A1B2C3D4E5F6";
    const email = "owner@example.com";
    const objects = installBlobStore({
      [`support/2026/08/${caseId}.json`]: {
        caseId,
        category: "question",
        email,
        status: "submitted",
        receivedAt: "2026-08-24T10:00:00.000Z",
        updatedAt: "2026-08-24T10:00:00.000Z",
      },
    });
    const { GET } = await import("./support/route");
    const lookup = () => GET(new NextRequest(
      `https://total.example/api/support?caseId=${caseId}&email=${encodeURIComponent(email)}`,
      { headers: { "x-forwarded-for": "203.0.113.90", "user-agent": "test-browser" } },
    ));

    for (let attempt = 1; attempt <= 12; attempt += 1)
      expect((await lookup()).status).toBe(200);
    const rateObjectsAtLimit = [...objects.keys()].filter((key) => key.startsWith("intake-security/rate/support-")).length;
    const limited = await lookup();
    expect(limited.status).toBe(404);
    expect(await limited.json()).toEqual({ error: "Case not found" });
    const persisted = [...objects.entries()]
      .filter(([key]) => key.startsWith("intake-security/rate/support-"))
      .map(([key, value]) => `${key}\n${value}`)
      .join("\n");
    expect(persisted).not.toContain(email);
    expect(persisted).not.toContain("203.0.113.90");
    expect([...objects.keys()].some((key) => key.startsWith("intake-security/rate/support-lookup/"))).toBe(true);
    expect([...objects.keys()].filter((key) => key.startsWith("intake-security/rate/support-")).length).toBe(rateObjectsAtLimit);
  });

  it("uses a generic response for malformed public tracking references", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    const { GET } = await import("./support/route");
    const response = await GET(new NextRequest("https://total.example/api/support?caseId=not-a-case&email=owner%40example.com"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Case not found" });
  });

  it("deduplicates retries across instances without storing a raw client address", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    process.env.INTAKE_SECURITY_SECRET = "a-separate-test-secret-with-32-bytes";
    const objects = installBlobStore();
    const { POST } = await import("./support/route");
    const request = () => new NextRequest("https://total.example/api/support", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.77", "user-agent": "test-browser" },
      body: JSON.stringify({ category: "bug", email: "owner@example.com", message: "The same retry should create only one support case." }),
    });

    const first = await POST(request());
    const second = await POST(request());
    const firstReceipt = await first.json() as { caseId: string };
    const secondReceipt = await second.json() as { caseId: string; duplicate: boolean };

    expect(secondReceipt).toMatchObject({ caseId: firstReceipt.caseId, duplicate: true });
    expect([...objects.keys()].filter((key) => /^support\/.*\.json$/.test(key))).toHaveLength(1);
    expect([...objects.values()].join("\n")).not.toContain("203.0.113.77");
    expect([...objects.keys()].some((key) => key.startsWith("intake-security/rate/support/"))).toBe(true);
  });

  it("indexes resolved cases for 90-day deletion and returns the exact deadline", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    process.env.SUPPORT_WEBHOOK_SECRET = "support-admin-secret";
    const caseId = "TOT-20260824-ABCDEF";
    const casePath = `support/2026/08/${caseId}.json`;
    const objects = installBlobStore({
      [casePath]: {
        caseId,
        category: "question",
        email: "owner@example.com",
        message: "Please verify the retention deadline for this support case.",
        source: "website",
        status: "submitted",
        receivedAt: "2026-08-24T10:00:00.000Z",
        updatedAt: "2026-08-24T10:00:00.000Z",
        resolvedAt: null,
      },
    });
    const { PATCH } = await import("./support/route");
    const response = await PATCH(new NextRequest("https://total.example/api/support", {
      method: "PATCH",
      headers: { authorization: "Bearer support-admin-secret", "content-type": "application/json" },
      body: JSON.stringify({ caseId, status: "resolved" }),
    }));
    const result = await response.json() as { updatedAt: string; deleteAfter: string };

    expect(response.status).toBe(200);
    expect(Date.parse(result.deleteAfter) - Date.parse(result.updatedAt)).toBe(90 * 24 * 60 * 60_000);
    expect([...objects.keys()].some((key) => key.startsWith("retention-index-v2/support/"))).toBe(true);
    expect(objects.has(`retention-pointers/support/${caseId}.json`)).toBe(true);
  });

  it("enforces the shared Blob-backed request limit", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    process.env.INTAKE_SECURITY_SECRET = "a-separate-test-secret-with-32-bytes";
    installBlobStore();
    const { POST } = await import("./support/route");
    const submit = (number: number) => POST(new NextRequest("https://total.example/api/support", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.22", "user-agent": "test-browser" },
      body: JSON.stringify({ email: "owner@example.com", message: `Support request number ${number} has enough detail to be valid.` }),
    }));

    for (let number = 1; number <= 8; number += 1) expect((await submit(number)).status).toBe(200);
    expect((await submit(9)).status).toBe(429);
  });
});

describe("feedback board", () => {
  it("keeps unreleased roadmap work planned until its public version exists", async () => {
    const releaseModule = await import("@/lib/release");
    vi.mocked(releaseModule.latestRelease).mockResolvedValue({
      version: "0.4.0",
      htmlUrl: "https://github.com/IrminFlow/total/releases/tag/v0.4.0",
      assets: {},
    });
    const { GET } = await import("./feedback/route");
    const response = await GET();
    const result = await response.json() as { ideas: Array<{ id: string; status: string; releaseVersion: string | null }> };
    expect(response.status).toBe(200);
    expect(result.ideas.find((idea) => idea.id === "quarter-registers")).toMatchObject({
      status: "planned",
      releaseVersion: null,
    });
  });

  it("marks roadmap work released only when its public version exists", async () => {
    const releaseModule = await import("@/lib/release");
    vi.mocked(releaseModule.latestRelease).mockResolvedValue({
      version: "0.5.0",
      htmlUrl: "https://github.com/IrminFlow/total/releases/tag/v0.5.0",
      assets: {},
    });
    const { GET } = await import("./feedback/route");
    const result = await (await GET()).json() as { ideas: Array<{ id: string; status: string; releaseVersion: string | null }> };
    expect(result.ideas.find((idea) => idea.id === "quarter-registers")).toMatchObject({
      status: "released",
      releaseVersion: "0.5.0",
    });
  });

  it("forwards votes and follows with the shared secret", async () => {
    process.env.CONVEX_FEEDBACK_URL = "https://feedback.example/actions";
    process.env.SUPPORT_WEBHOOK_SECRET = "feedback-secret";
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, votes: 8 }));
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./feedback/route");
    const response = await POST(post("/api/feedback", { action: "follow", ideaId: "mobile-companion", email: "owner@example.com" }));
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://feedback.example/actions"),
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer feedback-secret" }) }),
    );
  });

  it("records private append-only feedback events when Blob is connected", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    const { POST } = await import("./feedback/route");
    const response = await POST(post("/api/feedback", { action: "vote", ideaId: "mobile-companion" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, status: "recorded", receivedAt: expect.any(String) });
    expect(blobMocks.put).toHaveBeenCalledWith(
      expect.stringMatching(/^feedback\/events\//),
      expect.any(String),
      expect.objectContaining({ access: "private", addRandomSuffix: false }),
    );
  });

  it("materializes vote totals and updates them when an event is deleted", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    process.env.SUPPORT_WEBHOOK_SECRET = "feedback-secret";
    const objects = installBlobStore();
    const { GET, POST, DELETE } = await import("./feedback/route");
    const created = await POST(post("/api/feedback", { action: "vote", ideaId: "mobile-companion" }));
    const receipt = await created.json() as { id: string; receivedAt: string };

    expect(created.status).toBe(200);
    expect(objects.has("feedback/materialized/public-summary.json")).toBe(true);
    blobMocks.list.mockClear();
    const firstBoard = await (await GET()).json() as { ideas: Array<{ id: string; votes: number }> };
    expect(firstBoard.ideas.find((idea) => idea.id === "mobile-companion")?.votes).toBe(1);
    expect(blobMocks.list.mock.calls.some(([options]) => options.prefix === "feedback/events/")).toBe(false);

    const removed = await DELETE(new NextRequest("https://total.example/api/feedback", {
      method: "DELETE",
      headers: { authorization: "Bearer feedback-secret", "content-type": "application/json" },
      body: JSON.stringify({ events: [{ id: receipt.id, receivedAt: receipt.receivedAt }] }),
    }));
    expect(removed.status).toBe(200);
    const secondBoard = await (await GET()).json() as { ideas: Array<{ id: string; votes: number }> };
    expect(secondBoard.ideas.find((idea) => idea.id === "mobile-companion")?.votes).toBe(0);
  });

  it("rejects votes for unknown public ideas", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    installBlobStore();
    const { POST } = await import("./feedback/route");
    expect((await POST(post("/api/feedback", { action: "vote", ideaId: "invented-idea" }))).status).toBe(400);
  });

  it("deletes only exact authenticated feedback event references", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    process.env.SUPPORT_WEBHOOK_SECRET = "feedback-secret";
    const { DELETE } = await import("./feedback/route");
    const id = "09a74630-4f8b-46dd-81fe-be117cb06484";
    const receivedAt = "2026-08-24T10:15:30.000Z";
    const response = await DELETE(new NextRequest("https://total.example/api/feedback", {
      method: "DELETE",
      headers: { authorization: "Bearer feedback-secret", "content-type": "application/json" },
      body: JSON.stringify({ events: [{ id, receivedAt }] }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, deleted: 1 });
    expect(blobMocks.del).toHaveBeenCalledWith(`feedback/events/2026-08/${id}.json`);
  });

  it("rejects unauthenticated feedback deletion", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    process.env.SUPPORT_WEBHOOK_SECRET = "feedback-secret";
    const { DELETE } = await import("./feedback/route");
    const response = await DELETE(new NextRequest("https://total.example/api/feedback", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [{ id: "09a74630-4f8b-46dd-81fe-be117cb06484", receivedAt: "2026-08-24T10:15:30.000Z" }] }),
    }));
    expect(response.status).toBe(401);
    expect(blobMocks.del).not.toHaveBeenCalled();
  });
});

describe("download redirect", () => {
  it("selects the Windows installer from an explicit platform request", async () => {
    const releaseModule = await import("@/lib/release");
    vi.mocked(releaseModule.latestRelease).mockResolvedValue({
      version: "0.5.0",
      htmlUrl: "https://github.com/IrminFlow/total/releases/tag/v0.5.0",
      assets: {},
    });
    vi.mocked(releaseModule.resolveDownloadUrl).mockResolvedValue("https://downloads.example/Total-0.5.0.exe");
    const { GET } = await import("./download/route");
    const request = new NextRequest("https://total.example/api/download?platform=win");

    await expect(GET(request)).rejects.toThrow("redirect:https://downloads.example/Total-0.5.0.exe");
    expect(releaseModule.resolveDownloadUrl).toHaveBeenCalledWith(expect.objectContaining({ version: "0.5.0" }), "win");
  });
});

describe("intake retention maintenance", () => {
  it("requires cron authentication and deletes expired case and feedback payloads", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    process.env.CRON_SECRET = "cron-test-secret";
    const caseId = "TOT-20200101-ABCDEF";
    const feedbackId = "09a74630-4f8b-46dd-81fe-be117cb06484";
    const casePath = `support/2020/01/${caseId}.json`;
    const feedbackPath = `feedback/events/2020-01/${feedbackId}.json`;
    const supportIndex = `retention-index/support/2020-04/${caseId}.json`;
    const feedbackIndex = `retention-index/feedback/2022-01/${feedbackId}.json`;
    const objects = installBlobStore({
      [casePath]: { caseId, status: "resolved" },
      [`support-status/2020/01/${caseId}/resolved.json`]: { caseId, status: "resolved" },
      [supportIndex]: { entity: "support", id: caseId, objectPath: casePath, deleteAfter: "2020-04-01T00:00:00.000Z" },
      [`retention-pointers/support/${caseId}.json`]: { indexPath: supportIndex },
      [feedbackPath]: { id: feedbackId, action: "follow" },
      [feedbackIndex]: { entity: "feedback", id: feedbackId, objectPath: feedbackPath, deleteAfter: "2022-01-01T00:00:00.000Z" },
      [`retention-pointers/feedback/${feedbackId}.json`]: { indexPath: feedbackIndex },
    });
    const { GET } = await import("./maintenance/intake/route");

    const denied = await GET(new NextRequest("https://total.example/api/maintenance/intake"));
    expect(denied.status).toBe(401);
    const response = await GET(new NextRequest("https://total.example/api/maintenance/intake?limit=10", {
      headers: { authorization: "Bearer cron-test-secret" },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ support: { deleted: 1 }, feedback: { deleted: 1 } });
    expect(objects.has(casePath)).toBe(false);
    expect(objects.has(feedbackPath)).toBe(false);
    expect([...objects.keys()].some((key) => key.includes(caseId) || key.includes(feedbackId))).toBe(false);
  });

  it("migrates future legacy indexes into the deadline-sorted retention index", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    process.env.CRON_SECRET = "cron-test-secret";
    const caseId = "TOT-20990101-ABCDEF";
    const objectPath = `support/2099/01/${caseId}.json`;
    const legacyPath = `retention-index/support/2099-04/${caseId}.json`;
    const index = { entity: "support", id: caseId, objectPath, deleteAfter: "2099-04-01T00:00:00.000Z" };
    const objects = installBlobStore({
      [objectPath]: { caseId, status: "resolved" },
      [legacyPath]: index,
      [`retention-pointers/support/${caseId}.json`]: { indexPath: legacyPath },
    });
    const { GET } = await import("./maintenance/intake/route");
    const response = await GET(new NextRequest("https://total.example/api/maintenance/intake?limit=10", {
      headers: { authorization: "Bearer cron-test-secret" },
    }));
    const result = await response.json() as { support: { migrated: number; deleted: number } };

    expect(result.support).toMatchObject({ migrated: 1, deleted: 0 });
    expect(objects.has(legacyPath)).toBe(false);
    expect(objects.has(`retention-index-v2/support/2099-04-01T00-00-00-000Z/${caseId}.json`)).toBe(true);
  });

  it("drains cursor-paginated security records and reports remaining backlog", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    process.env.CRON_SECRET = "cron-test-secret";
    const expired = Object.fromEntries(Array.from({ length: 205 }, (_, index) => [
      `intake-security/rate/test/${String(index).padStart(3, "0")}.json`,
      { expiresAt: "2020-01-01T00:00:00.000Z" },
    ]));
    const objects = installBlobStore(expired);
    const { GET } = await import("./maintenance/intake/route");
    const run = () => GET(new NextRequest("https://total.example/api/maintenance/intake?limit=201", {
      headers: { authorization: "Bearer cron-test-secret" },
    }));

    const first = await (await run()).json() as { security: { deleted: number; backlog: boolean } };
    expect(first.security).toEqual(expect.objectContaining({ deleted: 201, backlog: true }));
    const second = await (await run()).json() as { security: { deleted: number; backlog: boolean } };
    expect(second.security).toEqual(expect.objectContaining({ deleted: 4, backlog: false }));
    expect([...objects.keys()].filter((key) => key.startsWith("intake-security/rate/"))).toHaveLength(0);
  });
});
