import { beforeEach, describe, expect, it, vi } from "vitest";

const blob = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}));

vi.mock("@vercel/blob", () => blob);

import { listJson, listJsonEntriesPage } from "./intakeStore";

describe("intakeStore listJson", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    blob.get.mockImplementation(async (pathname: string) => ({
      statusCode: 200,
      stream: new Response(JSON.stringify({ pathname })).body,
    }));
  });

  it("reads every cursor page instead of truncating public aggregates", async () => {
    blob.list
      .mockResolvedValueOnce({
        blobs: [{ pathname: "feedback/events/one.json" }],
        hasMore: true,
        cursor: "next-page",
      })
      .mockResolvedValueOnce({
        blobs: [{ pathname: "feedback/events/two.json" }],
        hasMore: false,
      });

    await expect(listJson<{ pathname: string }>("feedback/events/")).resolves.toEqual([
      { pathname: "feedback/events/one.json" },
      { pathname: "feedback/events/two.json" },
    ]);
    expect(blob.list).toHaveBeenNthCalledWith(2, {
      prefix: "feedback/events/",
      limit: 1_000,
      cursor: "next-page",
    });
  });

  it("honours an explicit item cap", async () => {
    blob.list.mockResolvedValueOnce({
      blobs: [{ pathname: "support/status/one.json" }],
      hasMore: true,
      cursor: "ignored",
    });
    await listJson("support/status/", 1);
    expect(blob.list).toHaveBeenCalledTimes(1);
    expect(blob.list).toHaveBeenCalledWith({ prefix: "support/status/", limit: 1 });
  });

  it("exposes the storage cursor when callers drain work in bounded pages", async () => {
    blob.list.mockResolvedValueOnce({
      blobs: [{ pathname: "retention-index-v2/support/2026-08-24/one.json" }],
      hasMore: true,
      cursor: "opaque-next-page",
    });
    await expect(listJsonEntriesPage<{ pathname: string }>("retention-index-v2/support/", 25)).resolves.toEqual({
      entries: [{
        pathname: "retention-index-v2/support/2026-08-24/one.json",
        value: { pathname: "retention-index-v2/support/2026-08-24/one.json" },
      }],
      hasMore: true,
      cursor: "opaque-next-page",
    });
  });
});
