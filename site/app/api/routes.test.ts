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

function installBlobStore(
  seed: Record<string, unknown> = {},
): Map<string, string> {
  const objects = new Map(
    Object.entries(seed).map(([key, value]) => [key, JSON.stringify(value)]),
  );
  blobMocks.put.mockImplementation(
    async (
      pathname: string,
      value: string,
      options: { allowOverwrite?: boolean },
    ) => {
      if (objects.has(pathname) && !options.allowOverwrite)
        throw new Error("already exists");
      objects.set(pathname, value);
      return {};
    },
  );
  blobMocks.get.mockImplementation(async (pathname: string) => {
    const value = objects.get(pathname);
    return value === undefined
      ? null
      : { statusCode: 200, stream: new Blob([value]).stream() };
  });
  blobMocks.list.mockImplementation(
    async ({
      prefix,
      limit = 1_000,
      cursor,
    }: {
      prefix: string;
      limit?: number;
      cursor?: string;
    }) => {
      const keys = [...objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort();
      const start = cursor ? keys.findIndex((key) => key > cursor) : 0;
      const page = start < 0 ? [] : keys.slice(start, start + limit);
      const hasMore = page.length > 0 && keys.some((key) => key > page.at(-1)!);
      return {
        blobs: page.map((pathname) => ({
          pathname,
          url: `https://blob.example/${pathname}`,
        })),
        hasMore,
        cursor: hasMore ? page.at(-1) : undefined,
      };
    },
  );
  blobMocks.del.mockImplementation(async (target: string | string[]) => {
    for (const item of Array.isArray(target) ? target : [target]) {
      const pathname = item.startsWith("https://blob.example/")
        ? item.slice("https://blob.example/".length)
        : item;
      objects.delete(pathname);
    }
  });
  return objects;
}

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.SUPABASE_SUPPORT_URL;
  delete process.env.SUPABASE_FEEDBACK_URL;
  delete process.env.SUPABASE_INTAKE_SECRET;
  delete process.env.CONVEX_SUPPORT_URL;
  delete process.env.SUPPORT_WEBHOOK_URL;
  delete process.env.CONVEX_FEEDBACK_URL;
  delete process.env.SUPPORT_PROVIDER_SECRET;
  delete process.env.FEEDBACK_PROVIDER_SECRET;
  delete process.env.COHORT_PROVIDER_SECRET;
  delete process.env.INTAKE_ADMIN_SECRET;
  process.env.INTAKE_SECURITY_SECRET =
    "test-intake-hmac-secret-with-at-least-32-bytes";
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
  blobMocks.list.mockResolvedValue({
    blobs: [],
    hasMore: false,
    cursor: undefined,
  });
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
      productVersion: "5.0.0",
    });
  });

  it("fails closed when deployment metadata is unavailable", async () => {
    const { GET } = await import("./deployment/route");
    expect((await GET()).status).toBe(503);
  });
});

describe("desktop update feed", () => {
  it("publishes channel, cohort and kill-switch controls with the installer URL", async () => {
    process.env.UPDATE_ROLLOUT_PERCENTAGE_BETA = "25";
    process.env.UPDATE_ROLLOUT_SALT_BETA = "beta-wave-2026";
    process.env.UPDATE_AUTO_DOWNLOAD = "false";
    const releaseModule = await import("@/lib/release");
    vi.mocked(releaseModule.latestRelease).mockResolvedValue({
      version: "0.6.0-beta.2",
      htmlUrl: "https://github.com/IrminFlow/total/releases/tag/v0.6.0-beta.2",
      assets: {},
    });
    const { GET } = await import("./latest/route");
    const response = await GET(new NextRequest("https://total.example/api/latest?channel=beta"));

    expect(releaseModule.latestRelease).toHaveBeenCalledWith("beta");
    expect(await response.json()).toEqual({
      version: "0.6.0-beta.2",
      downloadUrl: "https://total.example/api/download?channel=beta",
      channel: "beta",
      rollout: { percentage: 25, salt: "beta-wave-2026" },
      killSwitches: { updates: true, autoDownload: false, manualDownload: true },
    });
  });
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("support intake", () => {
  it("rejects an explicit foreign origin before storing a support case", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    installBlobStore();
    const { POST } = await import("./support/route");
    const response = await POST(
      new NextRequest("https://total.example/api/support", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://foreign.example",
        },
        body: JSON.stringify({
          category: "question",
          message: "This foreign-origin request must not create a support case.",
        }),
      }),
    );
    expect(response.status).toBe(403);
    expect(blobMocks.put).not.toHaveBeenCalled();
  });

  it("prefers Supabase and never exposes its relay secret to the client", async () => {
    process.env.SUPABASE_SUPPORT_URL =
      "https://project.supabase.co/functions/v1/total-intake/support";
    process.env.CONVEX_SUPPORT_URL = "https://convex.example/support";
    process.env.SUPPORT_WEBHOOK_URL = "https://webhook.example/support";
    process.env.SUPABASE_INTAKE_SECRET =
      "supabase-relay-secret-for-test-only-0001";
    process.env.SUPPORT_PROVIDER_SECRET = "other-provider-secret";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./support/route");

    const response = await POST(
      post("/api/support", {
        category: "question",
        email: "owner@example.com",
        message: "Please help me verify yesterday's closing balances.",
      }),
    );
    const responseText = await response.text();
    const requestInit = fetchMock.mock.calls[0]![1]!;

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        "https://project.supabase.co/functions/v1/total-intake/support",
      ),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization:
            "Bearer supabase-relay-secret-for-test-only-0001",
        }),
      }),
    );
    expect(String(requestInit.body)).not.toContain(
      "supabase-relay-secret-for-test-only-0001",
    );
    expect(responseText).not.toContain(
      "supabase-relay-secret-for-test-only-0001",
    );
    expect(responseText).not.toContain("other-provider-secret");
  });

  it("forwards a bounded case to the configured HTTPS service", async () => {
    process.env.SUPPORT_WEBHOOK_URL = "https://support.example/intake";
    process.env.SUPPORT_PROVIDER_SECRET = "test-secret";
    process.env.INTAKE_ADMIN_SECRET =
      "different-admin-secret-for-test-only-0001";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./support/route");

    const response = await POST(
      post("/api/support", {
        category: "privacy",
        email: "books@example.com",
        message: "The trial balance screen does not open for this company.",
      }),
    );
    const result = (await response.json()) as {
      caseId: string;
      status: string;
    };

    expect(response.status).toBe(200);
    expect(result.status).toBe("submitted");
    expect(result.caseId).toMatch(/^TOT-\d{8}-[A-F0-9]{12}$/);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://support.example/intake"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer test-secret",
          "idempotency-key": expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    );
  });

  it("never accepts the outbound support-provider secret for administration", async () => {
    process.env.SUPPORT_PROVIDER_SECRET = "provider-only-secret";
    const { PATCH } = await import("./support/route");
    const response = await PATCH(
      new NextRequest("https://total.example/api/support", {
        method: "PATCH",
        headers: {
          authorization: "Bearer provider-only-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          caseId: "TOT-20260824-ABCDEF",
          status: "resolved",
        }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("fails closed when provider and administrator credentials collide", async () => {
    const collided = "collided-secret-for-test-only-00000001";
    process.env.SUPPORT_PROVIDER_SECRET = collided;
    process.env.INTAKE_ADMIN_SECRET = collided;
    const { PATCH } = await import("./support/route");
    const response = await PATCH(
      new NextRequest("https://total.example/api/support", {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${collided}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          caseId: "TOT-20260824-ABCDEF",
          status: "resolved",
        }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("preserves the case id and prepared email when delivery fails", async () => {
    process.env.SUPPORT_WEBHOOK_URL = "https://support.example/intake";
    process.env.SUPPORT_FALLBACK_EMAIL = "help@example.com";
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./support/route");

    const retryPayload = {
      category: "question",
      email: "owner@example.com",
      message: "Please help me restore the verified backup from yesterday.",
    };
    const retryRequest = () =>
      new NextRequest("https://total.example/api/support", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "192.0.2.2",
        },
        body: JSON.stringify(retryPayload),
      });
    const response = await POST(retryRequest());
    const result = (await response.json()) as {
      caseId: string;
      status: string;
      fallbackEmail: string;
      mailto: string;
    };

    expect(response.status).toBe(202);
    expect(result.status).toBe("fallback");
    expect(result.caseId).toMatch(/^TOT-\d{8}-[A-F0-9]{12}$/);
    expect(result.fallbackEmail).toBe("help@example.com");
    expect(result.mailto).toContain(encodeURIComponent(result.caseId));
    const retried = await POST(retryRequest());
    expect(retried.status).toBe(200);
    const firstDelivery = JSON.parse(
      String(fetchMock.mock.calls[0]![1]?.body),
    ) as { caseId: string };
    const secondDelivery = JSON.parse(
      String(fetchMock.mock.calls[1]![1]?.body),
    ) as { caseId: string };
    expect(secondDelivery.caseId).toBe(firstDelivery.caseId);
    expect(fetchMock.mock.calls[1]![1]?.headers).toMatchObject({
      "idempotency-key": (
        fetchMock.mock.calls[0]![1]?.headers as Record<string, string>
      )["idempotency-key"],
    });
  });

  it("rejects invalid support fields before delivery", async () => {
    const { POST } = await import("./support/route");
    const response = await POST(
      post("/api/support", { message: "short", email: "not-an-email" }),
    );
    expect(response.status).toBe(400);
    const missingEmail = await POST(
      post("/api/support", {
        message: "Please help me reconcile this opening balance.",
      }),
    );
    expect(missingEmail.status).toBe(202);
    const fakeAnonymousCrash = await POST(
      post("/api/support", {
        message: "Anonymous crash report",
        crashEnvelope: {},
      }),
    );
    expect(fakeAnonymousCrash.status).toBe(400);
  });

  it("persists a private case and allows token or email-bound status tracking", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    const { POST, GET } = await import("./support/route");
    const response = await POST(
      post("/api/support", {
        category: "bug",
        severity: "critical",
        email: "owner@example.com",
        message:
          "The imported opening balance needs review before month close.",
        diagnostics: {
          version: "5.0.0",
          platform: "darwin",
          arch: "arm64",
          installationId: "11111111-1111-4111-8111-111111111111",
        },
      }),
    );
    const receipt = (await response.json()) as {
      caseId: string;
      status: string;
      trackingToken: string;
    };
    expect(response.status).toBe(200);
    expect(receipt.status).toBe("submitted");
    expect(receipt.trackingToken).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
    expect(blobMocks.put).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`${receipt.caseId}\\.json$`)),
      expect.any(String),
      expect.objectContaining({ access: "private", addRandomSuffix: false }),
    );
    const pathname = blobMocks.put.mock.calls.at(-1)![0] as string;
    const stored = JSON.parse(blobMocks.put.mock.calls.at(-1)![1] as string);
    expect(stored).toMatchObject({
      category: "bug",
      severity: "critical",
      diagnostics: { installationId: "11111111-1111-4111-8111-111111111111" },
    });
    blobMocks.list.mockImplementation(
      async ({ prefix }: { prefix: string }) => ({
        blobs:
          prefix === pathname
            ? [{ pathname, url: `https://private.example/${pathname}` }]
            : [],
        hasMore: false,
        cursor: undefined,
      }),
    );
    blobMocks.get.mockImplementation(async () => ({
      statusCode: 200,
      stream: new Blob([JSON.stringify(stored)]).stream(),
    }));
    const tracked = await GET(
      new NextRequest(
        `https://total.example/api/support?caseId=${receipt.caseId}&email=owner%40example.com`,
      ),
    );
    expect(tracked.status).toBe(200);
    expect(await tracked.json()).toMatchObject({
      caseId: receipt.caseId,
      status: "submitted",
    });
    const anonymouslyTracked = await GET(
      new NextRequest(
        `https://total.example/api/support?caseId=${receipt.caseId}&token=${receipt.trackingToken}`,
      ),
    );
    expect(anonymouslyTracked.status).toBe(200);
    const badToken = await GET(
      new NextRequest(
        `https://total.example/api/support?caseId=${receipt.caseId}&token=${"a".repeat(64)}`,
      ),
    );
    expect(badToken.status).toBe(404);
    const hidden = await GET(
      new NextRequest(
        `https://total.example/api/support?caseId=${receipt.caseId}&email=wrong%40example.com`,
      ),
    );
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
    const lookup = () =>
      GET(
        new NextRequest(
          `https://total.example/api/support?caseId=${caseId}&email=${encodeURIComponent(email)}`,
          {
            headers: {
              "x-forwarded-for": "203.0.113.90",
              "user-agent": "test-browser",
            },
          },
        ),
      );

    for (let attempt = 1; attempt <= 12; attempt += 1)
      expect((await lookup()).status).toBe(200);
    const rateObjectsAtLimit = [...objects.keys()].filter((key) =>
      key.startsWith("intake-security/rate/support-"),
    ).length;
    const limited = await lookup();
    expect(limited.status).toBe(404);
    expect(await limited.json()).toEqual({ error: "Case not found" });
    const persisted = [...objects.entries()]
      .filter(([key]) => key.startsWith("intake-security/rate/support-"))
      .map(([key, value]) => `${key}\n${value}`)
      .join("\n");
    expect(persisted).not.toContain(email);
    expect(persisted).not.toContain("203.0.113.90");
    expect(
      [...objects.keys()].some((key) =>
        key.startsWith("intake-security/rate/support-lookup/"),
      ),
    ).toBe(true);
    expect(
      [...objects.keys()].filter((key) =>
        key.startsWith("intake-security/rate/support-"),
      ).length,
    ).toBe(rateObjectsAtLimit);
  });

  it("uses a generic response for malformed public tracking references", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    const { GET } = await import("./support/route");
    const response = await GET(
      new NextRequest(
        "https://total.example/api/support?caseId=not-a-case&email=owner%40example.com",
      ),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Case not found" });
  });

  it("deduplicates retries across instances without storing a raw client address", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    process.env.INTAKE_SECURITY_SECRET = "a-separate-test-secret-with-32-bytes";
    const objects = installBlobStore();
    const { POST } = await import("./support/route");
    const request = () =>
      new NextRequest("https://total.example/api/support", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.77",
          "user-agent": "test-browser",
        },
        body: JSON.stringify({
          category: "bug",
          email: "owner@example.com",
          message: "The same retry should create only one support case.",
        }),
      });

    const first = await POST(request());
    const second = await POST(request());
    const firstReceipt = (await first.json()) as { caseId: string };
    const secondReceipt = (await second.json()) as {
      caseId: string;
      duplicate: boolean;
    };

    expect(secondReceipt).toMatchObject({
      caseId: firstReceipt.caseId,
      duplicate: true,
    });
    expect(
      [...objects.keys()].filter((key) => /^support\/.*\.json$/.test(key)),
    ).toHaveLength(1);
    expect([...objects.values()].join("\n")).not.toContain("203.0.113.77");
    expect(
      [...objects.keys()].some((key) =>
        key.startsWith("intake-security/rate/support/"),
      ),
    ).toBe(true);
  });

  it("allows an honest retry when private case storage fails", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    process.env.INTAKE_SECURITY_SECRET = "a-separate-test-secret-with-32-bytes";
    const objects = installBlobStore();
    const normalPut = blobMocks.put.getMockImplementation()!;
    let failCaseWrite = true;
    blobMocks.put.mockImplementation(
      async (...args: Parameters<typeof normalPut>) => {
        if (failCaseWrite && String(args[0]).startsWith("support/")) {
          failCaseWrite = false;
          throw new Error("case storage unavailable");
        }
        return normalPut(...args);
      },
    );
    const { POST } = await import("./support/route");
    const request = () =>
      new NextRequest("https://total.example/api/support", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.78",
        },
        body: JSON.stringify({
          category: "bug",
          email: "owner@example.com",
          message: "Retry this support case after storage recovers.",
        }),
      });

    expect((await POST(request())).status).toBe(202);
    const retried = await POST(request());
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ status: "submitted" });
    expect(
      [...objects.keys()].filter((key) => /^support\/.*\.json$/.test(key)),
    ).toHaveLength(1);
  });

  it("keeps a durably stored support case successful when dedupe finalization fails", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    const objects = installBlobStore();
    const normalPut = blobMocks.put.getMockImplementation()!;
    blobMocks.put.mockImplementation(
      async (...args: Parameters<typeof normalPut>) => {
        const options = args[2] as { allowOverwrite?: boolean };
        if (
          String(args[0]).startsWith("intake-security/dedup/support/") &&
          options.allowOverwrite
        )
          throw new Error("dedupe finalization unavailable");
        return normalPut(...args);
      },
    );
    const { POST } = await import("./support/route");
    const response = await POST(
      post("/api/support", {
        category: "bug",
        email: "owner@example.com",
        message:
          "The durable support case must still receive an acknowledgement.",
      }),
    );

    expect(response.status).toBe(200);
    const receipt = (await response.json()) as {
      caseId: string;
      status: string;
    };
    expect(receipt.status).toBe("submitted");
    expect(
      objects.has(
        `support/${receipt.caseId.slice(4, 8)}/${receipt.caseId.slice(8, 10)}/${receipt.caseId}.json`,
      ),
    ).toBe(true);
  });

  it("indexes resolved cases for 90-day deletion and returns the exact deadline", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    process.env.INTAKE_ADMIN_SECRET = "support-admin-secret-for-test-only-0001";
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
    const response = await PATCH(
      new NextRequest("https://total.example/api/support", {
        method: "PATCH",
        headers: {
          authorization: "Bearer support-admin-secret-for-test-only-0001",
          "content-type": "application/json",
        },
        body: JSON.stringify({ caseId, status: "resolved" }),
      }),
    );
    const result = (await response.json()) as {
      updatedAt: string;
      deleteAfter: string;
    };

    expect(response.status).toBe(200);
    expect(Date.parse(result.deleteAfter) - Date.parse(result.updatedAt)).toBe(
      90 * 24 * 60 * 60_000,
    );
    expect(
      [...objects.keys()].some((key) =>
        key.startsWith("retention-index-v2/support/"),
      ),
    ).toBe(true);
    expect(objects.has(`retention-pointers/support/${caseId}.json`)).toBe(true);
  });

  it("deletes the Supabase copy before removing the durable local case", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    process.env.INTAKE_ADMIN_SECRET = "support-admin-delete-secret-for-test-0001";
    process.env.SUPABASE_INTAKE_SECRET = "support-provider-delete-secret-test-0001";
    process.env.SUPABASE_SUPPORT_URL =
      "https://project.supabase.co/functions/v1/total-intake/support";
    const caseId = "TOT-20260824-ABCDEF";
    const casePath = `support/2026/08/${caseId}.json`;
    const objects = installBlobStore({ [casePath]: { caseId, status: "submitted" } });
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, deleted: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const { DELETE } = await import("./support/route");
    const response = await DELETE(new NextRequest(`https://total.example/api/support?caseId=${caseId}`, {
      method: "DELETE",
      headers: { authorization: "Bearer support-admin-delete-secret-for-test-0001" },
    }));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(process.env.SUPABASE_SUPPORT_URL),
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(objects.has(casePath)).toBe(false);
  });

  it("enforces the shared Blob-backed request limit", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    process.env.INTAKE_SECURITY_SECRET = "a-separate-test-secret-with-32-bytes";
    installBlobStore();
    const { POST } = await import("./support/route");
    const submit = (number: number) =>
      POST(
        new NextRequest("https://total.example/api/support", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": "198.51.100.22",
            "user-agent": `rotating-agent-${number}`,
          },
          body: JSON.stringify({
            email: "owner@example.com",
            message: `Support request number ${number} has enough detail to be valid.`,
          }),
        }),
      );

    for (let number = 1; number <= 8; number += 1)
      expect((await submit(number)).status).toBe(200);
    expect((await submit(9)).status).toBe(429);
  });
});

describe("feedback board", () => {
  it("rejects an explicit foreign origin before storing feedback", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    installBlobStore();
    const { POST } = await import("./feedback/route");
    const response = await POST(
      new NextRequest("https://total.example/api/feedback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://foreign.example",
        },
        body: JSON.stringify({ action: "vote", ideaId: "mobile-companion" }),
      }),
    );
    expect(response.status).toBe(403);
    expect(blobMocks.put).not.toHaveBeenCalled();
  });

  it("prefers Supabase and never exposes its relay secret to the client", async () => {
    process.env.SUPABASE_FEEDBACK_URL =
      "https://project.supabase.co/functions/v1/total-intake/feedback";
    process.env.CONVEX_FEEDBACK_URL = "https://convex.example/feedback";
    process.env.SUPABASE_INTAKE_SECRET =
      "supabase-relay-secret-for-test-only-0002";
    process.env.FEEDBACK_PROVIDER_SECRET = "other-feedback-secret";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ ok: true, votes: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./feedback/route");

    const response = await POST(
      post("/api/feedback", {
        action: "vote",
        ideaId: "mobile-companion",
      }),
    );
    const responseText = await response.text();
    const requestInit = fetchMock.mock.calls[0]![1]!;

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        "https://project.supabase.co/functions/v1/total-intake/feedback",
      ),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization:
            "Bearer supabase-relay-secret-for-test-only-0002",
        }),
      }),
    );
    expect(String(requestInit.body)).not.toContain(
      "supabase-relay-secret-for-test-only-0002",
    );
    expect(responseText).not.toContain(
      "supabase-relay-secret-for-test-only-0002",
    );
    expect(responseText).not.toContain("other-feedback-secret");
  });

  it("keeps unreleased roadmap work planned until its public version exists", async () => {
    const releaseModule = await import("@/lib/release");
    vi.mocked(releaseModule.latestRelease).mockResolvedValue({
      version: "0.4.0",
      htmlUrl: "https://github.com/IrminFlow/total/releases/tag/v0.4.0",
      assets: {},
    });
    const { GET } = await import("./feedback/route");
    const response = await GET();
    const result = (await response.json()) as {
      ideas: Array<{
        id: string;
        status: string;
        releaseVersion: string | null;
      }>;
    };
    expect(response.status).toBe(200);
    expect(
      result.ideas.find((idea) => idea.id === "quarter-registers"),
    ).toMatchObject({
      status: "planned",
      releaseVersion: null,
    });
  });

  it("marks roadmap work released only when its public version exists", async () => {
    const releaseModule = await import("@/lib/release");
    vi.mocked(releaseModule.latestRelease).mockResolvedValue({
      version: "5.0.0",
      htmlUrl: "https://github.com/IrminFlow/total/releases/tag/v5.0.0",
      assets: {},
    });
    const { GET } = await import("./feedback/route");
    const result = (await (await GET()).json()) as {
      ideas: Array<{
        id: string;
        status: string;
        releaseVersion: string | null;
      }>;
    };
    expect(
      result.ideas.find((idea) => idea.id === "quarter-registers"),
    ).toMatchObject({
      status: "released",
      releaseVersion: "5.0.0",
    });
  });

  it("forwards votes and follows with a provider-only secret", async () => {
    process.env.CONVEX_FEEDBACK_URL = "https://feedback.example/actions";
    process.env.FEEDBACK_PROVIDER_SECRET = "feedback-secret";
    process.env.INTAKE_ADMIN_SECRET =
      "different-admin-secret-for-test-only-0002";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ ok: true, votes: 8 }));
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./feedback/route");
    const response = await POST(
      post("/api/feedback", {
        action: "follow",
        ideaId: "mobile-companion",
        email: "owner@example.com",
      }),
    );
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://feedback.example/actions"),
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer feedback-secret",
        }),
      }),
    );
  });

  it("identifies provider-managed feedback before synthetic events are created", async () => {
    process.env.CONVEX_FEEDBACK_URL = "https://feedback.example/actions";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ ideas: [] })),
    );
    const { GET } = await import("./feedback/route");

    expect(await (await GET()).json()).toMatchObject({ storage: "provider" });
  });

  it("fails closed when shared intake storage has no independent HMAC secret", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    delete process.env.INTAKE_SECURITY_SECRET;
    const { POST } = await import("./feedback/route");
    const response = await POST(
      post("/api/feedback", { action: "vote", ideaId: "mobile-companion" }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Feedback storage is unavailable",
    });
    expect(blobMocks.put).not.toHaveBeenCalled();
  });

  it("never accepts the outbound feedback-provider secret for deletion", async () => {
    process.env.FEEDBACK_PROVIDER_SECRET = "provider-only-secret";
    const { DELETE } = await import("./feedback/route");
    const response = await DELETE(
      new NextRequest("https://total.example/api/feedback", {
        method: "DELETE",
        headers: {
          authorization: "Bearer provider-only-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ events: [] }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("records private append-only feedback events when Blob is connected", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    const { POST } = await import("./feedback/route");
    const response = await POST(
      post("/api/feedback", { action: "vote", ideaId: "mobile-companion" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      status: "recorded",
      receivedAt: expect.any(String),
    });
    expect(blobMocks.put).toHaveBeenCalledWith(
      expect.stringMatching(/^feedback\/events\//),
      expect.any(String),
      expect.objectContaining({ access: "private", addRandomSuffix: false }),
    );
  });

  it("keeps the Blob receipt when the optional feedback provider fails", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    process.env.SUPABASE_FEEDBACK_URL =
      "https://project.supabase.co/functions/v1/total-intake/feedback";
    process.env.SUPABASE_INTAKE_SECRET = "feedback-provider-failure-secret-test-0001";
    const objects = installBlobStore();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    const { POST } = await import("./feedback/route");
    const response = await POST(
      post("/api/feedback", { action: "vote", ideaId: "mobile-companion" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, providerDelivery: "failed" });
    expect([...objects.keys()].some((key) => key.startsWith("feedback/events/"))).toBe(true);
  });

  it("lets authenticated production monitors rerun without reusing duplicate receipts", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    process.env.INTAKE_ADMIN_SECRET =
      "feedback-admin-secret-for-monitor-rerun-0001";
    const objects = installBlobStore();
    const { POST } = await import("./feedback/route");
    const send = (syntheticRunId: string) =>
      POST(
        new NextRequest("https://total.example/api/feedback", {
          method: "POST",
          headers: {
            authorization:
              "Bearer feedback-admin-secret-for-monitor-rerun-0001",
            "content-type": "application/json",
            "x-forwarded-for": "192.0.2.240",
          },
          body: JSON.stringify({
            action: "vote",
            ideaId: "mobile-companion",
            syntheticRunId,
          }),
        }),
      );

    const first = await send("monitor-first-run");
    const second = await send("monitor-second-run");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).not.toMatchObject({ duplicate: true });
    expect(
      [...objects.keys()].filter((key) => key.startsWith("feedback/events/")),
    ).toHaveLength(2);
  });

  it("allows an honest retry when private feedback storage fails", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    process.env.INTAKE_SECURITY_SECRET = "a-separate-test-secret-with-32-bytes";
    const objects = installBlobStore();
    const normalPut = blobMocks.put.getMockImplementation()!;
    let failEventWrite = true;
    blobMocks.put.mockImplementation(
      async (...args: Parameters<typeof normalPut>) => {
        if (failEventWrite && String(args[0]).startsWith("feedback/events/")) {
          failEventWrite = false;
          throw new Error("event storage unavailable");
        }
        return normalPut(...args);
      },
    );
    const { POST } = await import("./feedback/route");
    const request = () =>
      new NextRequest("https://total.example/api/feedback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.79",
        },
        body: JSON.stringify({ action: "vote", ideaId: "mobile-companion" }),
      });

    expect((await POST(request())).status).toBe(503);
    const retried = await POST(request());
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ status: "recorded" });
    expect(
      [...objects.keys()].filter((key) => key.startsWith("feedback/events/")),
    ).toHaveLength(1);
  });

  it("keeps a durably stored feedback event successful when dedupe finalization fails", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    const objects = installBlobStore();
    const normalPut = blobMocks.put.getMockImplementation()!;
    blobMocks.put.mockImplementation(
      async (...args: Parameters<typeof normalPut>) => {
        const options = args[2] as { allowOverwrite?: boolean };
        if (
          String(args[0]).startsWith("intake-security/dedup/feedback/") &&
          options.allowOverwrite
        )
          throw new Error("dedupe finalization unavailable");
        return normalPut(...args);
      },
    );
    const { POST } = await import("./feedback/route");
    const response = await POST(
      post("/api/feedback", { action: "vote", ideaId: "mobile-companion" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "recorded" });
    expect(
      [...objects.keys()].filter((key) => key.startsWith("feedback/events/")),
    ).toHaveLength(1);
  });

  it("allows an honest retry when the configured feedback provider fails", async () => {
    process.env.CONVEX_FEEDBACK_URL = "https://feedback.example/actions";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ok: true, votes: 9 }));
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./feedback/route");
    const request = () =>
      new NextRequest("https://total.example/api/feedback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.80",
        },
        body: JSON.stringify({
          action: "follow",
          ideaId: "mobile-companion",
          email: "owner@example.com",
        }),
      });

    expect((await POST(request())).status).toBe(502);
    expect((await POST(request())).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0]![1]!;
    const second = fetchMock.mock.calls[1]![1]!;
    expect(second.headers).toMatchObject({
      "idempotency-key": (first.headers as Record<string, string>)[
        "idempotency-key"
      ],
    });
    expect(JSON.parse(String(second.body))).toMatchObject({
      id: JSON.parse(String(first.body)).id,
      receivedAt: JSON.parse(String(first.body)).receivedAt,
    });
  });

  it("materializes vote totals and updates them when an event is deleted", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    process.env.INTAKE_ADMIN_SECRET =
      "feedback-admin-secret-for-test-only-0001";
    const objects = installBlobStore();
    const { GET, POST, DELETE } = await import("./feedback/route");
    const created = await POST(
      post("/api/feedback", { action: "vote", ideaId: "mobile-companion" }),
    );
    const receipt = (await created.json()) as {
      id: string;
      receivedAt: string;
    };

    expect(created.status).toBe(200);
    expect(objects.has("feedback/materialized/public-summary.json")).toBe(true);
    blobMocks.list.mockClear();
    const firstBoard = (await (await GET()).json()) as {
      ideas: Array<{ id: string; votes: number }>;
    };
    expect(
      firstBoard.ideas.find((idea) => idea.id === "mobile-companion")?.votes,
    ).toBe(1);
    expect(
      blobMocks.list.mock.calls.some(
        ([options]) => options.prefix === "feedback/events/",
      ),
    ).toBe(false);

    const removed = await DELETE(
      new NextRequest("https://total.example/api/feedback", {
        method: "DELETE",
        headers: {
          authorization: "Bearer feedback-admin-secret-for-test-only-0001",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          events: [{ id: receipt.id, receivedAt: receipt.receivedAt }],
        }),
      }),
    );
    expect(removed.status).toBe(200);
    const secondBoard = (await (await GET()).json()) as {
      ideas: Array<{ id: string; votes: number }>;
    };
    expect(
      secondBoard.ideas.find((idea) => idea.id === "mobile-companion")?.votes,
    ).toBe(0);
  });

  it("rejects votes for unknown public ideas", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    installBlobStore();
    const { POST } = await import("./feedback/route");
    expect(
      (
        await POST(
          post("/api/feedback", { action: "vote", ideaId: "invented-idea" }),
        )
      ).status,
    ).toBe(400);
  });

  it("deletes only exact authenticated feedback event references", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    process.env.INTAKE_ADMIN_SECRET =
      "feedback-admin-secret-for-test-only-0002";
    const { DELETE } = await import("./feedback/route");
    const id = "09a74630-4f8b-46dd-81fe-be117cb06484";
    const receivedAt = "2026-08-24T10:15:30.000Z";
    const response = await DELETE(
      new NextRequest("https://total.example/api/feedback", {
        method: "DELETE",
        headers: {
          authorization: "Bearer feedback-admin-secret-for-test-only-0002",
          "content-type": "application/json",
        },
        body: JSON.stringify({ events: [{ id, receivedAt }] }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, deleted: 1 });
    expect(blobMocks.del).toHaveBeenCalledWith(
      `feedback/events/2026-08/${id}.json`,
    );
  });

  it("rejects unauthenticated feedback deletion", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    process.env.INTAKE_ADMIN_SECRET =
      "feedback-admin-secret-for-test-only-0003";
    const { DELETE } = await import("./feedback/route");
    const response = await DELETE(
      new NextRequest("https://total.example/api/feedback", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          events: [
            {
              id: "09a74630-4f8b-46dd-81fe-be117cb06484",
              receivedAt: "2026-08-24T10:15:30.000Z",
            },
          ],
        }),
      }),
    );
    expect(response.status).toBe(401);
    expect(blobMocks.del).not.toHaveBeenCalled();
  });
});

describe("privacy-safe attribution", () => {
  it("stores only fixed funnel dimensions and rounds the event time", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    const { POST } = await import("./attribution/route");
    const response = await POST(
      new Request("https://total.example/api/attribution", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://total.example" },
        body: JSON.stringify({
          event: "pricing_view",
          source: "google",
          medium: "organic",
          campaign: "v5-beta",
        }),
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(blobMocks.put).toHaveBeenCalledOnce();
    const [pathname, raw] = blobMocks.put.mock.calls[0]!;
    expect(pathname).toMatch(/^attribution\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]+\.json$/);
    const stored = JSON.parse(String(raw));
    expect(stored).toMatchObject({
      schema: 1,
      event: "pricing_view",
      source: "google",
      medium: "organic",
      campaign: "v5-beta",
    });
    expect(stored.receivedHour).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/);
    expect(Object.keys(stored).sort()).toEqual([
      "campaign",
      "event",
      "medium",
      "receivedHour",
      "schema",
      "source",
    ]);
  });

  it("rejects unknown fields and arbitrary campaign values", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    const { POST } = await import("./attribution/route");
    for (const body of [
      { event: "landing_view", ledgerName: "Sales" },
      { event: "landing_view", source: "customer-name" },
      { event: "download", source: "direct" },
    ]) {
      const response = await POST(
        new Request("https://total.example/api/attribution", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://total.example" },
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(400);
    }
    expect(blobMocks.put).not.toHaveBeenCalled();
  });

  it("rejects cross-origin and oversized attribution requests", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    const { POST } = await import("./attribution/route");
    const crossOrigin = await POST(
      new Request("https://total.example/api/attribution", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://elsewhere.example" },
        body: JSON.stringify({ event: "landing_view", source: "direct" }),
      }),
    );
    expect(crossOrigin.status).toBe(403);
    const oversized = await POST(
      new Request("https://total.example/api/attribution", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://total.example" },
        body: JSON.stringify({ event: "landing_view", source: "direct", padding: "x".repeat(600) }),
      }),
    );
    expect(oversized.status).toBe(413);
    expect(blobMocks.put).not.toHaveBeenCalled();
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
    vi.mocked(releaseModule.resolveDownloadUrl).mockResolvedValue(
      "https://downloads.example/Total-0.5.0.exe",
    );
    const { GET } = await import("./download/route");
    const request = new NextRequest(
      "https://total.example/api/download?platform=win",
    );

    await expect(GET(request)).rejects.toThrow(
      "redirect:https://downloads.example/Total-0.5.0.exe",
    );
    expect(releaseModule.resolveDownloadUrl).toHaveBeenCalledWith(
      expect.objectContaining({ version: "0.5.0" }),
      "win",
    );
  });

  it("records only allowlisted download attribution without affecting the redirect", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    const releaseModule = await import("@/lib/release");
    vi.mocked(releaseModule.latestRelease).mockResolvedValue({
      version: "0.5.0",
      htmlUrl: "https://github.com/IrminFlow/total/releases/tag/v0.5.0",
      assets: {},
    });
    vi.mocked(releaseModule.resolveDownloadUrl).mockResolvedValue(
      "https://downloads.example/Total-0.5.0.dmg",
    );
    const { GET } = await import("./download/route");
    const request = new NextRequest(
      "https://total.example/api/download?platform=mac&source=linkedin&medium=social&campaign=v5-beta&company=PrivateCo",
    );

    await expect(GET(request)).rejects.toThrow(
      "redirect:https://downloads.example/Total-0.5.0.dmg",
    );
    const stored = JSON.parse(String(blobMocks.put.mock.calls[0]![1]));
    expect(stored).toMatchObject({
      event: "download",
      platform: "mac",
      source: "linkedin",
      medium: "social",
      campaign: "v5-beta",
    });
    expect(JSON.stringify(stored)).not.toContain("PrivateCo");
  });
});

describe("intake retention maintenance", () => {
  it("requires cron authentication and deletes expired case and feedback payloads", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    process.env.CRON_SECRET = "cron-secret-for-test-only-0000000001";
    const caseId = "TOT-20200101-ABCDEF";
    const feedbackId = "09a74630-4f8b-46dd-81fe-be117cb06484";
    const casePath = `support/2020/01/${caseId}.json`;
    const feedbackPath = `feedback/events/2020-01/${feedbackId}.json`;
    const supportIndex = `retention-index/support/2020-04/${caseId}.json`;
    const feedbackIndex = `retention-index/feedback/2022-01/${feedbackId}.json`;
    const objects = installBlobStore({
      [casePath]: { caseId, status: "resolved" },
      [`support-status/2020/01/${caseId}/resolved.json`]: {
        caseId,
        status: "resolved",
      },
      [supportIndex]: {
        entity: "support",
        id: caseId,
        objectPath: casePath,
        deleteAfter: "2020-04-01T00:00:00.000Z",
      },
      [`retention-pointers/support/${caseId}.json`]: {
        indexPath: supportIndex,
      },
      [feedbackPath]: { id: feedbackId, action: "follow" },
      [feedbackIndex]: {
        entity: "feedback",
        id: feedbackId,
        objectPath: feedbackPath,
        deleteAfter: "2022-01-01T00:00:00.000Z",
      },
      [`retention-pointers/feedback/${feedbackId}.json`]: {
        indexPath: feedbackIndex,
      },
    });
    const { GET } = await import("./maintenance/intake/route");

    const denied = await GET(
      new NextRequest("https://total.example/api/maintenance/intake"),
    );
    expect(denied.status).toBe(401);
    const response = await GET(
      new NextRequest("https://total.example/api/maintenance/intake?limit=10", {
        headers: {
          authorization: "Bearer cron-secret-for-test-only-0000000001",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      support: { deleted: 1 },
      feedback: { deleted: 1 },
    });
    expect(objects.has(casePath)).toBe(false);
    expect(objects.has(feedbackPath)).toBe(false);
    expect(
      [...objects.keys()].some(
        (key) => key.includes(caseId) || key.includes(feedbackId),
      ),
    ).toBe(false);
  });

  it("migrates future legacy indexes into the deadline-sorted retention index", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    process.env.CRON_SECRET = "cron-secret-for-test-only-0000000002";
    const caseId = "TOT-20990101-ABCDEF";
    const objectPath = `support/2099/01/${caseId}.json`;
    const legacyPath = `retention-index/support/2099-04/${caseId}.json`;
    const index = {
      entity: "support",
      id: caseId,
      objectPath,
      deleteAfter: "2099-04-01T00:00:00.000Z",
    };
    const objects = installBlobStore({
      [objectPath]: { caseId, status: "resolved" },
      [legacyPath]: index,
      [`retention-pointers/support/${caseId}.json`]: { indexPath: legacyPath },
    });
    const { GET } = await import("./maintenance/intake/route");
    const response = await GET(
      new NextRequest("https://total.example/api/maintenance/intake?limit=10", {
        headers: {
          authorization: "Bearer cron-secret-for-test-only-0000000002",
        },
      }),
    );
    const result = (await response.json()) as {
      support: { migrated: number; deleted: number };
    };

    expect(result.support).toMatchObject({ migrated: 1, deleted: 0 });
    expect(objects.has(legacyPath)).toBe(false);
    expect(
      objects.has(
        `retention-index-v2/support/2099-04-01T00-00-00-000Z/${caseId}.json`,
      ),
    ).toBe(true);
  });

  it("drains cursor-paginated security records and reports remaining backlog", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test-token";
    process.env.CRON_SECRET = "cron-secret-for-test-only-0000000003";
    const expired = Object.fromEntries(
      Array.from({ length: 205 }, (_, index) => [
        `intake-security/rate/test/${String(index).padStart(3, "0")}.json`,
        { expiresAt: "2020-01-01T00:00:00.000Z" },
      ]),
    );
    const objects = installBlobStore(expired);
    const { GET } = await import("./maintenance/intake/route");
    const run = () =>
      GET(
        new NextRequest(
          "https://total.example/api/maintenance/intake?limit=201",
          {
            headers: {
              authorization: "Bearer cron-secret-for-test-only-0000000003",
            },
          },
        ),
      );

    const first = (await (await run()).json()) as {
      security: { deleted: number; backlog: boolean };
    };
    expect(first.security).toEqual(
      expect.objectContaining({ deleted: 201, backlog: true }),
    );
    const second = (await (await run()).json()) as {
      security: { deleted: number; backlog: boolean };
    };
    expect(second.security).toEqual(
      expect.objectContaining({ deleted: 4, backlog: false }),
    );
    expect(
      [...objects.keys()].filter((key) =>
        key.startsWith("intake-security/rate/"),
      ),
    ).toHaveLength(0);
  });
});
