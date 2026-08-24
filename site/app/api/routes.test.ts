import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

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
    const response = await POST(post("/api/feedback", { action: "follow", ideaId: "mobile-companion" }));
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://feedback.example/actions"),
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer feedback-secret" }) }),
    );
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
