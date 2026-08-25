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

export async function startMcpPresenceBroker(
  getContext: () => McpPresenceContext | null,
  root = dataRoot(),
): Promise<string> {
  if (server) return endpoint!;
  endpoint = mcpPresenceEndpoint(root);
  if (process.platform !== "win32" && existsSync(endpoint)) {
    const entry = lstatSync(endpoint);
    if (!entry.isSocket()) throw new Error("MCP presence endpoint is not a socket");
    unlinkSync(endpoint);
  }
  server = createServer((socket) => {
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
  server.maxConnections = 32;
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(endpoint!, () => {
      server!.off("error", reject);
      resolve();
    });
  });
  if (process.platform !== "win32") chmodSync(endpoint, 0o600);
  return endpoint;
}

export async function stopMcpPresenceBroker(): Promise<void> {
  const active = server;
  const activeEndpoint = endpoint;
  server = null;
  endpoint = null;
  if (active) await new Promise<void>((resolve) => active.close(() => resolve()));
  if (process.platform !== "win32" && activeEndpoint && existsSync(activeEndpoint)) {
    const entry = lstatSync(activeEndpoint);
    if (entry.isSocket()) unlinkSync(activeEndpoint);
  }
}
