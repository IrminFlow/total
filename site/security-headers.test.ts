import { describe, expect, it } from "vitest";
import nextConfig from "./next.config";

describe("production security headers", () => {
  it("applies framing, MIME, referrer, permissions and CSP protections to every route", async () => {
    expect(nextConfig.poweredByHeader).toBe(false);
    const rules = await nextConfig.headers?.();
    expect(rules).toHaveLength(1);
    const headers = Object.fromEntries((rules?.[0]?.headers ?? []).map(({ key, value }) => [key, value]));
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["Strict-Transport-Security"]).toContain("max-age=31536000");
    expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(headers["Cross-Origin-Resource-Policy"]).toBe("same-origin");
    expect(headers["X-DNS-Prefetch-Control"]).toBe("off");
    expect(headers["Permissions-Policy"]).toContain("camera=(self)");
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(headers["Content-Security-Policy"]).toContain("base-uri 'self'");
  });
});
