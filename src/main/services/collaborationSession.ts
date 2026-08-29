import { z } from "zod";
import {
  readCollaborationCredentials,
  updateCollaborationSession,
  type CollaborationCredentials,
} from "./collaborationCredentials";

const REFRESH_SKEW_MS = 60_000;
const REFRESH_TIMEOUT_MS = 20_000;
const refreshes = new Map<string, Promise<CollaborationCredentials>>();

function jwtExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch { return null; }
}

export function supabaseAuthUrl(credentials: CollaborationCredentials): string | null {
  if (!credentials.refreshToken || !credentials.anonKey) return null;
  const endpoint = new URL(credentials.endpoint);
  const trustedHost = endpoint.hostname.endsWith(".supabase.co") && endpoint.hostname.split(".").length >= 3;
  if (endpoint.protocol !== "https:" || !trustedHost || !endpoint.pathname.startsWith("/functions/v1/")) return null;
  return new URL("/auth/v1/token?grant_type=refresh_token", endpoint.origin).toString();
}

function assertCredentialTarget(credentials: CollaborationCredentials, value: string): void {
  const endpoint = new URL(credentials.endpoint);
  const target = new URL(value);
  const basePath = endpoint.pathname.replace(/\/$/, "");
  if (target.origin !== endpoint.origin || (target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`)))
    throw new Error("Collaboration request was blocked because it left the configured endpoint");
}

function expiresSoon(credentials: CollaborationCredentials, now = Date.now()): boolean {
  const expiry = credentials.accessTokenExpiresAt
    ? Date.parse(credentials.accessTokenExpiresAt)
    : jwtExpiry(credentials.apiToken);
  return expiry !== null && Number.isFinite(expiry) && expiry <= now + REFRESH_SKEW_MS;
}

async function refreshSession(
  companySlug: string,
  credentials: CollaborationCredentials,
  fetchImpl: typeof fetch,
): Promise<CollaborationCredentials> {
  const authUrl = supabaseAuthUrl(credentials);
  if (!authUrl) throw new Error("Collaboration session expired; reconnect this workspace");
  let response: Response;
  try {
    response = await fetchImpl(authUrl, {
      method: "POST",
      headers: { apikey: credentials.anonKey!, "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: credentials.refreshToken }),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Collaboration session could not be refreshed while offline; reconnect and try again");
  }
  if (!response.ok) throw new Error("Collaboration session was revoked or expired; reconnect this workspace");
  const session = z.object({
    access_token: z.string().min(1).max(4096),
    refresh_token: z.string().min(1).max(4096).optional(),
    expires_in: z.number().positive().max(604800),
  }).safeParse(await response.json().catch(() => null));
  if (!session.success) throw new Error("Collaboration session refresh returned an invalid response; reconnect this workspace");
  return updateCollaborationSession(companySlug, {
    apiToken: session.data.access_token,
    refreshToken: session.data.refresh_token,
    accessTokenExpiresAt: new Date(Date.now() + session.data.expires_in * 1000).toISOString(),
  });
}

async function currentSession(companySlug: string, fetchImpl: typeof fetch, force: boolean): Promise<CollaborationCredentials> {
  const credentials = readCollaborationCredentials(companySlug);
  if (!credentials?.enabled) throw new Error("Encrypted collaboration is not enabled");
  if (!supabaseAuthUrl(credentials)) {
    if (force) return credentials;
    return credentials;
  }
  if (!force && !expiresSoon(credentials)) return credentials;
  const existing = refreshes.get(companySlug);
  if (existing) return existing;
  const pending = refreshSession(companySlug, credentials, fetchImpl).finally(() => refreshes.delete(companySlug));
  refreshes.set(companySlug, pending);
  return pending;
}

export async function collaborationFetch(
  companySlug: string,
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  let credentials = await currentSession(companySlug, fetchImpl, false);
  assertCredentialTarget(credentials, url);
  const request = () => fetchImpl(url, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${credentials.apiToken}` },
  });
  let response = await request();
  if (response.status !== 401 || !supabaseAuthUrl(credentials)) return response;
  credentials = await currentSession(companySlug, fetchImpl, true);
  response = await request();
  if (response.status === 401) throw new Error("Collaboration session was revoked or expired; reconnect this workspace");
  return response;
}
