import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { supportInstallationId } from "./supportInstallation";

let root = "";

afterEach(() => {
  delete process.env.TOTAL_DATA_DIR;
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

describe("support installation reference", () => {
  it("creates one stable UUID outside every company book", () => {
    root = mkdtempSync(join(tmpdir(), "total-support-installation-"));
    process.env.TOTAL_DATA_DIR = root;
    const first = supportInstallationId();
    expect(first).toMatch(/^[0-9a-f-]{36}$/i);
    expect(supportInstallationId()).toBe(first);
  });
});
