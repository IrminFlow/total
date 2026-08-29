import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

describe("isolated staging release", () => {
  it("uses explicit HTTPS staging assets without querying GitHub", async () => {
    process.env.TOTAL_STAGING_MODE = "1";
    process.env.TOTAL_STAGING_VERSION = "5.0.0";
    process.env.TOTAL_STAGING_MAC_URL = "https://downloads.example/Total-5.0.0-arm64.dmg";
    process.env.TOTAL_STAGING_WIN_URL = "https://downloads.example/Total-Setup-5.0.0.exe";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { latestRelease, resolveDownloadUrl } = await import("./release");

    const release = await latestRelease();
    expect(release).toMatchObject({ version: "5.0.0" });
    expect(await resolveDownloadUrl(release!, "mac")).toBe(process.env.TOTAL_STAGING_MAC_URL);
    expect(await resolveDownloadUrl(release!, "win")).toBe(process.env.TOTAL_STAGING_WIN_URL);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when a staging asset or version is invalid", async () => {
    process.env.TOTAL_STAGING_MODE = "1";
    process.env.TOTAL_STAGING_VERSION = "v5";
    process.env.TOTAL_STAGING_MAC_URL = "http://downloads.example/Total.dmg";
    process.env.TOTAL_STAGING_WIN_URL = "https://downloads.example/Total.exe";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    const { latestRelease } = await import("./release");

    expect(await latestRelease()).toBeNull();
  });
});
