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

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.CONVEX_SUPPORT_URL;
  delete process.env.SUPPORT_WEBHOOK_URL;
  delete process.env.CONVEX_FEEDBACK_URL;
  delete process.env.SUPPORT_WEBHOOK_SECRET;
  delete process.env.SUPPORT_FALLBACK_EMAIL;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.VERCEL_OIDC_TOKEN;
  blobMocks.put.mockResolvedValue({});
  blobMocks.get.mockResolvedValue(null);
  blobMocks.list.mockResolvedValue({ blobs: [], hasMore: false, cursor: undefined });
  blobMocks.del.mockResolvedValue(undefined);
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
    expect(result.caseId).toMatch(/^TOT-\d{8}-[A-F0-9]{6}$/);
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
    expect(result.caseId).toMatch(/^TOT-\d{8}-[A-F0-9]{6}$/);
    expect(result.fallbackEmail).toBe("help@example.com");
    expect(result.mailto).toContain(encodeURIComponent(result.caseId));
  });

  it("rejects invalid support fields before delivery", async () => {
    const { POST } = await import("./support/route");
    const response = await POST(post("/api/support", { message: "short", email: "not-an-email" }));
    expect(response.status).toBe(400);
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
});

describe("feedback board", () => {
  it("keeps the public roadmap readable when no provider is configured", async () => {
    const { GET } = await import("./feedback/route");
    const response = await GET();
    const result = await response.json() as { ideas: Array<{ id: string }> };
    expect(response.status).toBe(200);
    expect(result.ideas.some((idea) => idea.id === "quarter-registers")).toBe(true);
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
