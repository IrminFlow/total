import { describe, expect, it } from "vitest";
import { DESKTOP_BUILD_PROFILE, desktopServiceUrl, parseDesktopBuildProfile } from "./desktopBuildProfile";

describe("desktop build profile", () => {
  it("uses the fail-closed staging profile when no bundler profile is injected", () => {
    expect(DESKTOP_BUILD_PROFILE).toEqual({
      schema: 1,
      name: "staging",
      siteOrigin: "https://total-v5-staging.vercel.app",
      servicesOrigin: "https://total-v5-staging.vercel.app",
      updatesEnabled: false,
    });
    expect(desktopServiceUrl("/api/support")).toBe("https://total-v5-staging.vercel.app/api/support");
  });

  it("accepts only bare HTTPS origins and a known profile name", () => {
    expect(parseDesktopBuildProfile({
      schema: 1,
      name: "production",
      siteOrigin: "https://devjindal.tech",
      servicesOrigin: "https://devjindal.tech",
      updatesEnabled: true,
    }).name).toBe("production");
    expect(() => parseDesktopBuildProfile({
      schema: 1,
      name: "staging",
      siteOrigin: "http://total-v5-staging.vercel.app",
      servicesOrigin: "https://total-v5-staging.vercel.app/path",
      updatesEnabled: false,
    })).toThrow("bare HTTPS origin");
  });

  it("rejects a staging label with another origin or enabled updates", () => {
    expect(() => parseDesktopBuildProfile({
      schema: 1,
      name: "staging",
      siteOrigin: "https://example.com",
      servicesOrigin: "https://example.com",
      updatesEnabled: false,
    })).toThrow("isolated staging origin");
    expect(() => parseDesktopBuildProfile({
      schema: 1,
      name: "staging",
      siteOrigin: "https://total-v5-staging.vercel.app",
      servicesOrigin: "https://total-v5-staging.vercel.app",
      updatesEnabled: true,
    })).toThrow("updates disabled");
  });
});
