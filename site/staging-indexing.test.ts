import { afterEach, describe, expect, it } from "vitest";
import nextConfig from "./next.config";
import sitemap from "./app/sitemap";
import {
  STAGING_ROBOTS_HEADER,
  stagingRobotsMetadata,
} from "./lib/stagingIndexing";

const originalMode = process.env.TOTAL_STAGING_MODE;

afterEach(() => {
  if (originalMode === undefined) delete process.env.TOTAL_STAGING_MODE;
  else process.env.TOTAL_STAGING_MODE = originalMode;
});

describe("staging search isolation", () => {
  it("adds response and metadata noindex directives and suppresses the sitemap", async () => {
    process.env.TOTAL_STAGING_MODE = "1";

    const rules = await nextConfig.headers?.();
    const headers = Object.fromEntries((rules?.[0]?.headers ?? []).map(({ key, value }) => [key, value]));
    expect(headers["X-Robots-Tag"]).toBe(STAGING_ROBOTS_HEADER);
    expect(stagingRobotsMetadata()).toMatchObject({ index: false, follow: false, nocache: true });
    expect(sitemap()).toEqual([]);
  });

  it("does not add staging directives to the production site", async () => {
    delete process.env.TOTAL_STAGING_MODE;

    const rules = await nextConfig.headers?.();
    const headers = Object.fromEntries((rules?.[0]?.headers ?? []).map(({ key, value }) => [key, value]));
    expect(headers["X-Robots-Tag"]).toBeUndefined();
    expect(stagingRobotsMetadata()).toBeUndefined();
    expect(sitemap().length).toBeGreaterThan(0);
  });
});
