import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
} from "fs";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { basename, join } from "path";
import type { DB } from "../db/connection";
import { atomicWriteFile } from "../atomicFile";
import { companyDir, dataRoot } from "../paths";
import { writeAudit } from "./audit";
import { exportMirror } from "./agentBridge";
import type {
  McpAuditEvent,
  McpRefreshRequest,
  McpMirrorStatus,
  McpScope,
  McpTokenSummary,
} from "@shared/mcp";

interface StoredToken extends McpTokenSummary {
  tokenHash: string;
}
interface TokenStore {
  version: 1;
  tokens: StoredToken[];
}

const accessPath = (): string => join(dataRoot(), "mcp-access.json");
const emptyStore = (): TokenStore => ({ version: 1, tokens: [] });

function readStore(): TokenStore {
  try {
    const parsed = JSON.parse(readFileSync(accessPath(), "utf8")) as TokenStore;
    if (parsed.version !== 1 || !Array.isArray(parsed.tokens))
      return emptyStore();
    return parsed;
  } catch {
    return emptyStore();
  }
}

function writeStore(store: TokenStore): void {
  mkdirSync(dataRoot(), { recursive: true });
  atomicWriteFile(accessPath(), JSON.stringify(store, null, 2));
}

const publicToken = ({
  tokenHash: _secret,
  ...token
}: StoredToken): McpTokenSummary => token;

export function listTokens(company: string): McpTokenSummary[] {
  return readStore()
    .tokens.filter((token) => token.company === company)
    .map(publicToken)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Broker-only token lookup. Receives a one-way digest, never the plaintext pairing secret. */
export function authorizeTokenHash(
  company: string,
  scope: string,
  tokenHash: string,
): McpTokenSummary | null {
  if (!/^[a-f0-9]{64}$/.test(tokenHash)) return null;
  const supplied = Buffer.from(tokenHash, "hex");
  const stored = readStore().tokens.find((candidate) => {
    if (candidate.company !== company || candidate.revokedAt ||
      !candidate.expiresAt || Date.parse(candidate.expiresAt) <= Date.now() ||
      !candidate.scopes.includes(scope as McpScope) || !/^[a-f0-9]{64}$/.test(candidate.tokenHash)) return false;
    return timingSafeEqual(Buffer.from(candidate.tokenHash, "hex"), supplied);
  });
  return stored ? publicToken(stored) : null;
}

export function issueToken(
  db: DB,
  company: string,
  input: { name: string; scopes: McpScope[]; expiresAt: string },
  actor: string,
): { token: string; record: McpTokenSummary } {
  const token = `total_mcp_${randomBytes(32).toString("base64url")}`;
  const stored: StoredToken = {
    id: randomUUID(),
    name: input.name,
    company,
    scopes: [...new Set(input.scopes)],
    expiresAt: input.expiresAt,
    createdAt: new Date().toISOString(),
    createdBy: actor,
    revokedAt: null,
    tokenHash: createHash("sha256").update(token).digest("hex"),
  };
  const store = readStore();
  store.tokens.push(stored);
  writeStore(store);
  const record = publicToken(stored);
  writeAudit(db, "mcp_token", 0, "create", null, record);
  return { token, record };
}

export function revokeToken(
  db: DB,
  company: string,
  id: string,
  actor: string,
): McpTokenSummary {
  const store = readStore();
  const token = store.tokens.find(
    (candidate) => candidate.id === id && candidate.company === company,
  );
  if (!token) throw new Error("MCP token not found");
  const before = publicToken(token);
  token.revokedAt ??= new Date().toISOString();
  writeStore(store);
  const after = publicToken(token);
  writeAudit(db, "mcp_token", 0, "update", before, {
    ...after,
    revokedBy: actor,
  });
  return after;
}

export function listAudit(company: string, limit = 200): McpAuditEvent[] {
  const path = join(companyDir(company), "mcp", "audit.jsonl");
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  if (Buffer.byteLength(text) > 5 * 1024 * 1024)
    throw new Error("MCP audit file exceeds the 5 MB display limit");
  return text
    .split("\n")
    .filter(Boolean)
    .slice(-Math.max(1, Math.min(1000, limit)))
    .reverse()
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as McpAuditEvent];
      } catch {
        return [];
      }
    });
}

export function mirrorStatus(company: string): McpMirrorStatus {
  const path = join(companyDir(company), "agent", "meta.json");
  if (!existsSync(path))
    return {
      generatedAt: null,
      schemaVersion: null,
      files: [],
      ageSeconds: null,
      stale: true,
    };
  const text = readFileSync(path, "utf8");
  if (Buffer.byteLength(text) > 1024 * 1024)
    throw new Error("Mirror metadata exceeds the 1 MB safety limit");
  const meta = JSON.parse(text) as {
    generatedAt?: unknown;
    schemaVersion?: unknown;
    files?: unknown;
  };
  const generatedAt =
    typeof meta.generatedAt === "string" ? meta.generatedAt : null;
  const ageSeconds = generatedAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(generatedAt)) / 1000))
    : null;
  return {
    generatedAt,
    schemaVersion:
      typeof meta.schemaVersion === "number" ? meta.schemaVersion : null,
    files: Array.isArray(meta.files)
      ? meta.files.filter((file): file is string => typeof file === "string")
      : [],
    ageSeconds,
    stale: ageSeconds === null || ageSeconds > 10 * 60,
  };
}

const requestsDir = (company: string): string =>
  join(companyDir(company), "mcp", "refresh-requests");

export function listRefreshRequests(company: string): McpRefreshRequest[] {
  const dir = requestsDir(company);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, 100)
    .flatMap((name) => {
      try {
        const parsed = JSON.parse(
          readFileSync(join(dir, name), "utf8"),
        ) as McpRefreshRequest;
        return parsed.status === "pending" && parsed.company === company
          ? [parsed]
          : [];
      } catch {
        return [];
      }
    });
}

function takeRequest(
  company: string,
  id: string,
  status: "approved" | "rejected",
): McpRefreshRequest {
  if (basename(id) !== id || !/^[a-zA-Z0-9-]+$/.test(id))
    throw new Error("Invalid refresh request");
  const dir = requestsDir(company);
  const path = join(dir, `${id}.json`);
  if (!existsSync(path)) throw new Error("Refresh request no longer exists");
  const request = JSON.parse(readFileSync(path, "utf8")) as McpRefreshRequest;
  if (request.company !== company || request.status !== "pending")
    throw new Error("Invalid refresh request");
  const reviewed = join(dir, "reviewed");
  mkdirSync(reviewed, { recursive: true });
  const next = { ...request, status, reviewedAt: new Date().toISOString() };
  atomicWriteFile(join(reviewed, `${id}.json`), JSON.stringify(next, null, 2));
  renameSync(path, join(reviewed, `${id}.request.json`));
  return request;
}

export function decideRefreshRequest(
  db: DB,
  company: string,
  id: string,
  approved: boolean,
  actor: string,
): { request: McpRefreshRequest; files: string[] } {
  const request = takeRequest(company, id, approved ? "approved" : "rejected");
  const files = approved ? exportMirror(db, company).files : [];
  writeAudit(db, "mcp_refresh", 0, "update", request, {
    decision: approved ? "approved" : "rejected",
    actor,
    files,
  });
  return { request, files };
}
