import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { seededDb } from "../db/testdb";
import { companyDir, ensureCompanyTree } from "../paths";
import {
  decideRefreshRequest,
  issueToken,
  listAudit,
  listRefreshRequests,
  listTokens,
  mirrorStatus,
  revokeToken,
} from "./mcpAccess";
import { exportMirror } from "./agentBridge";

let root: string | null = null;
const slug = "mcp-books";
function setup(): void {
  root = mkdtempSync(join(tmpdir(), "total-mcp-access-"));
  process.env.TOTAL_DATA_DIR = root;
  ensureCompanyTree(slug);
}
afterEach(() => {
  delete process.env.TOTAL_DATA_DIR;
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe("MCP access control and owner approvals", () => {
  it("issues one-time plaintext tokens while retaining only a scoped, revocable hash", () => {
    setup();
    const db = seededDb();
    const issued = issueToken(
      db,
      slug,
      {
        name: "Quarterly review",
        scopes: ["mirror:read", "proposal:create"],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
      "Owner",
    );
    expect(issued.token).toMatch(/^total_mcp_[A-Za-z0-9_-]{40,}$/);
    expect(issued.record).not.toHaveProperty("tokenHash");
    const file = readFileSync(join(root!, "mcp-access.json"), "utf8");
    expect(file).not.toContain(issued.token);
    expect(listTokens(slug)[0]).toMatchObject({
      name: "Quarterly review",
      company: slug,
      scopes: ["mirror:read", "proposal:create"],
      revokedAt: null,
    });
    expect(
      revokeToken(db, slug, issued.record.id, "Owner").revokedAt,
    ).not.toBeNull();
  });

  it("shows mirror freshness and requires an owner decision before a refresh touches the mirror", () => {
    setup();
    const db = seededDb();
    expect(mirrorStatus(slug)).toMatchObject({
      generatedAt: null,
      stale: true,
    });
    exportMirror(db, slug);
    expect(mirrorStatus(slug)).toMatchObject({
      schemaVersion: 1,
      stale: false,
    });
    const id = randomUUID();
    const dir = join(companyDir(slug), "mcp", "refresh-requests");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({
        id,
        company: slug,
        client: "Claude Desktop",
        requestedAt: new Date().toISOString(),
        status: "pending",
      }),
    );
    expect(listRefreshRequests(slug)).toHaveLength(1);
    const result = decideRefreshRequest(db, slug, id, true, "Owner");
    expect(result.files).toContain("meta.json");
    expect(listRefreshRequests(slug)).toHaveLength(0);
    expect(
      db
        .prepare("SELECT COUNT(*) n FROM audit_log WHERE entity='mcp_refresh'")
        .get(),
    ).toEqual({ n: 1 });
  });

  it("reads bounded append-only MCP audit evidence without malformed lines", () => {
    setup();
    const dir = join(companyDir(slug), "mcp");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "audit.jsonl"),
      `${JSON.stringify({ timestamp: "2026-08-24T10:00:00.000Z", client: "Codex", tool: "get_book_snapshot", company: slug, outcome: "allowed", proposalId: null, errorCode: null })}\nmalformed\n`,
    );
    expect(listAudit(slug)).toEqual([
      expect.objectContaining({
        client: "Codex",
        tool: "get_book_snapshot",
        outcome: "allowed",
      }),
    ]);
  });
});
