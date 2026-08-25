import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { createConnection } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { mcpPresenceEndpoint, startMcpPresenceBroker, stopMcpPresenceBroker } from "./mcpPresenceBroker";

let root: string | null = null;

afterEach(async () => {
  await stopMcpPresenceBroker();
  delete process.env.TOTAL_DATA_DIR;
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe("MCP local app-presence broker lifecycle", () => {
  it("uses only an owner-private local IPC endpoint and removes it on shutdown", async () => {
    root = mkdtempSync(join(tmpdir(), "total-mcp-presence-"));
    process.env.TOTAL_DATA_DIR = root;
    mkdirSync(join(root, "companies", "presence-books"), { recursive: true });
    writeFileSync(join(root, "mcp-access.json"), JSON.stringify({ version: 1, tokens: [] }));
    writeFileSync(join(root, "device-safety.json"), JSON.stringify({
      aiCopilot: false, mcpAccess: true, supportUploads: false, telemetry: false,
    }));

    const endpoint = await startMcpPresenceBroker(
      () => ({ company: "presence-books", role: "owner" }),
      root,
    );
    expect(endpoint).toBe(mcpPresenceEndpoint(root));
    expect(endpoint).not.toMatch(/^https?:/);
    if (process.platform === "win32") {
      expect(endpoint).toMatch(/^\\\\\.\\pipe\\total-mcp-/);
    } else {
      const stat = statSync(endpoint);
      expect(stat.isSocket()).toBe(true);
      expect(stat.mode & 0o777).toBe(0o600);
    }

    await stopMcpPresenceBroker();
    if (process.platform !== "win32") expect(existsSync(endpoint)).toBe(false);
  });

  it("coalesces concurrent starts, rejects nonce replay, and terminates idle clients", async () => {
    root = mkdtempSync(join(tmpdir(), "total-mcp-presence-"));
    process.env.TOTAL_DATA_DIR = root;
    const company = "presence-books";
    const token = "total_mcp_presence_fixture_secret";
    const tokenHash = createHash("sha256").update(token).digest("hex");
    mkdirSync(join(root, "companies", company), { recursive: true });
    writeFileSync(join(root, "mcp-access.json"), JSON.stringify({
      version: 1,
      tokens: [{
        id: "presence-fixture",
        name: "Presence test",
        company,
        scopes: ["mirror:read"],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        createdAt: new Date().toISOString(),
        createdBy: "Test",
        revokedAt: null,
        tokenHash,
      }],
    }));
    writeFileSync(join(root, "device-safety.json"), JSON.stringify({
      aiCopilot: false, mcpAccess: true, supportUploads: false, telemetry: false,
    }));

    const starts = await Promise.all(Array.from({ length: 12 }, () =>
      startMcpPresenceBroker(() => ({ company, role: "owner" }), root!),
    ));
    expect(new Set(starts)).toEqual(new Set([mcpPresenceEndpoint(root)]));

    const request = async (nonce: string): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const socket = createConnection(starts[0]!);
        let body = "";
        socket.setEncoding("utf8");
        socket.on("connect", () => socket.write(`${JSON.stringify({
          version: 1, nonce, tokenHash, company, scope: "mirror:read",
        })}\n`));
        socket.on("data", (chunk) => { body += chunk; });
        socket.on("end", () => resolve(JSON.parse(body.trim()) as Record<string, unknown>));
        socket.on("error", reject);
      });

    const nonce = "same_nonce_1234567890";
    await expect(request(nonce)).resolves.toMatchObject({ ok: true, nonce });
    await expect(request(nonce)).resolves.toMatchObject({ ok: false, code: "REPLAY_DENIED", nonce });

    const idle = createConnection(starts[0]!);
    await new Promise<void>((resolve, reject) => {
      idle.once("connect", resolve);
      idle.once("error", reject);
    });
    const closed = new Promise<void>((resolve) => idle.once("close", () => resolve()));
    await stopMcpPresenceBroker();
    await expect(closed).resolves.toBeUndefined();
    if (process.platform !== "win32") expect(existsSync(starts[0]!)).toBe(false);
  });
});
