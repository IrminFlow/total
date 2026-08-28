export interface DesktopBuildProfile {
  schema: 1;
  name: "production" | "staging";
  siteOrigin: string;
  servicesOrigin: string;
  updatesEnabled: boolean;
}

declare const __TOTAL_DESKTOP_BUILD_PROFILE__: unknown;

function secureOrigin(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Desktop build profile ${field} is missing`);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error(`Desktop build profile ${field} must be a bare HTTPS origin`);
  return url.origin;
}

export function parseDesktopBuildProfile(value: unknown): DesktopBuildProfile {
  if (!value || typeof value !== "object") throw new Error("Desktop build profile is missing");
  const row = value as Record<string, unknown>;
  if (row.schema !== 1 || (row.name !== "production" && row.name !== "staging") || typeof row.updatesEnabled !== "boolean")
    throw new Error("Desktop build profile is invalid");
  const profile: DesktopBuildProfile = {
    schema: 1,
    name: row.name,
    siteOrigin: secureOrigin(row.siteOrigin, "siteOrigin"),
    servicesOrigin: secureOrigin(row.servicesOrigin, "servicesOrigin"),
    updatesEnabled: row.updatesEnabled,
  };
  if (
    profile.name === "staging" &&
    (profile.siteOrigin !== "https://total-v5-staging.vercel.app" ||
      profile.servicesOrigin !== "https://total-v5-staging.vercel.app" ||
      profile.updatesEnabled)
  ) {
    throw new Error("Staging desktop build profile must use only the isolated staging origin with updates disabled");
  }
  return profile;
}

// electron-vite replaces this object at build time. The fallback exists only for direct pure-TS
// tests, where Vite is not involved; it is deliberately staging/offline-safe rather than production.
const rawProfile = typeof __TOTAL_DESKTOP_BUILD_PROFILE__ === "undefined"
  ? {
      schema: 1,
      name: "staging",
      siteOrigin: "https://total-v5-staging.vercel.app",
      servicesOrigin: "https://total-v5-staging.vercel.app",
      updatesEnabled: false,
    }
  : __TOTAL_DESKTOP_BUILD_PROFILE__;

export const DESKTOP_BUILD_PROFILE = parseDesktopBuildProfile(rawProfile);

export function desktopServiceUrl(path: `/api/${string}`): string {
  return new URL(path, DESKTOP_BUILD_PROFILE.servicesOrigin).toString();
}
