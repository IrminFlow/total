import { chmodSync, existsSync, lstatSync, unlinkSync } from "fs";
import { createHash } from "crypto";
import { createServer, type Server, type Socket } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { dataRoot } from "../paths";
import { readDeviceSafetyControls } from "./deviceSafety";
import { authorizeTokenHash } from "./mcpAccess";
import { roleAllows, type Role } from "./roles";

export interface McpPresenceContext {
  company: string;
  role: Role;
}

interface PresenceRequest {
  version: 1;
  nonce: string;
  tokenHash: string;
  company: string;
  scope: string;
}

const MAX_REQUEST_BYTES = 8 * 1024;
const REQUEST_TIMEOUT_MS = 1_500;

export function mcpPresenceEndpoint(root = dataRoot()): string {
  const suffix = createHash("sha256").update(root).digest("hex").slice(0, 24);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\total-mcp-${suffix}`
    : join(tmpdir(), `total-mcp-${suffix}.sock`);
}

const minRoleForScope = (scope: string): Role | null => ({
  "companies:list": "viewer",
  "mirror:read": "viewer",
  "attachment:read": "accountant",
  "proposal:create": "accountant",
  "proposal:read": "accountant",
  "proposal:discard": "accountant",
  "mirror:refresh": "owner",
})[scope] as Role | undefined ?? null;

function parseRequest(text: string): PresenceRequest | null {
  try {
    const value = JSON.parse(text) as Partial<PresenceRequest>;
    return value.version === 1 && typeof value.nonce === "string" && /^[a-zA-Z0-9_-]{16,128}$/.test(value.nonce) &&
      typeof value.tokenHash === "string" && /^[a-f0-9]{64}$/.test(value.tokenHash) &&
      typeof value.company === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.company) &&
      typeof value.scope === "string" && minRoleForScope(value.scope) !== null
      ? value as PresenceRequest
      : null;
  } catch {
    return null;
  }
}

function send(socket: Socket, nonce: string | null, value: Record<string, unknown>): void {
  socket.end(`${JSON.stringify({ version: 1, nonce, ...value })}\n`);
}

let server: Server | null = null;
let endpoint: string | null = null;
let startPromise: Promise<string> | null = null;
const activeSockets = new Set<Socket>();
const seenNonces = new Map<string, number>();
const NONCE_TTL_MS = 2 * 60_000;
const MAX_SEEN_NONCES = 2_048;

function claimNonce(tokenHash: string, nonce: string, now = Date.now()): boolean {
  for (const [key, seenAt] of seenNonces) {
    if (now - seenAt > NONCE_TTL_MS) seenNonces.delete(key);
  }
  const key = `${tokenHash}:${nonce}`;
  if (seenNonces.has(key)) return false;
  seenNonces.set(key, now);
  while (seenNonces.size > MAX_SEEN_NONCES) {
    const oldest = seenNonces.keys().next().value as string | undefined;
    if (!oldest) break;
    seenNonces.delete(oldest);
  }
  return true;
}

export async function startMcpPresenceBroker(
  getContext: () => McpPresenceContext | null,
  root = dataRoot(),
): Promise<string> {
  if (startPromise) return startPromise;
  if (server) return endpoint!;
  endpoint = mcpPresenceEndpoint(root);
  if (process.platform !== "win32" && existsSync(endpoint)) {
    const entry = lstatSync(endpoint);
    if (!entry.isSocket()) throw new Error("MCP presence endpoint is not a socket");
    unlinkSync(endpoint);
  }
  const nextServer = createServer((socket) => {
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));
    let body = "";
    socket.setEncoding("utf8");
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
    socket.on("data", (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) return socket.destroy();
      const newline = body.indexOf("\n");
      if (newline < 0) return;
      socket.pause();
      const request = parseRequest(body.slice(0, newline));
      if (!request) return send(socket, null, { ok: false, code: "INVALID_REQUEST" });
      if (!readDeviceSafetyControls().mcpAccess)
        return send(socket, request.nonce, { ok: false, code: "MCP_DISABLED" });
      const token = authorizeTokenHash(request.company, request.scope, request.tokenHash);
      if (!token) return send(socket, request.nonce, { ok: false, code: "AUTH_DENIED" });
      if (!claimNonce(request.tokenHash, request.nonce))
        return send(socket, request.nonce, { ok: false, code: "REPLAY_DENIED" });
      const context = getContext();
      if (!context) return send(socket, request.nonce, { ok: false, code: "APP_SESSION_REQUIRED" });
      if (context.company !== request.company)
        return send(socket, request.nonce, { ok: false, code: "COMPANY_INACTIVE" });
      const minimum = minRoleForScope(request.scope)!;
      if (!roleAllows(context.role, minimum))
        return send(socket, request.nonce, { ok: false, code: "ROLE_DENIED", requiredRole: minimum });
      return send(socket, request.nonce, { ok: true, role: context.role, tokenId: token.id });
    });
    socket.on("error", () => { /* malformed/disconnected clients are isolated */ });
  });
  nextServer.maxConnections = 32;
  server = nextServer;
  startPromise = new Promise<string>((resolve, reject) => {
    const fail = (error: Error): void => {
      nextServer.off("error", fail);
      if (server === nextServer) server = null;
      endpoint = null;
      startPromise = null;
      reject(error);
    };
    nextServer.once("error", fail);
    nextServer.listen(endpoint!, () => {
      nextServer.off("error", fail);
      if (process.platform !== "win32") chmodSync(endpoint!, 0o600);
      const readyEndpoint = endpoint!;
      startPromise = null;
      resolve(readyEndpoint);
    });
  });
  return startPromise;
}

export async function stopMcpPresenceBroker(): Promise<void> {
  if (startPromise) {
    try { await startPromise; } catch { /* failed starts are already cleared */ }
  }
  const active = server;
  const activeEndpoint = endpoint;
  server = null;
  endpoint = null;
  startPromise = null;
  seenNonces.clear();
  for (const socket of activeSockets) socket.destroy();
  activeSockets.clear();
  if (active) await new Promise<void>((resolve) => active.close(() => resolve()));
  if (process.platform !== "win32" && activeEndpoint && existsSync(activeEndpoint)) {
    const entry = lstatSync(activeEndpoint);
    if (entry.isSocket()) unlinkSync(activeEndpoint);
  }
}
