import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "fs";
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
});
