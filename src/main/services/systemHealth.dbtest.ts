import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openCompanyDb } from "../db/connection";
import { seedCompany } from "../db/seed";
import { TEST_INFO } from "../db/testdb";
import {
  attemptRecoveryCopy,
  diskState,
  runMaintenance,
  systemHealth,
} from "./systemHealth";

let root: string | null = null;
afterEach(() => {
  delete process.env.TOTAL_DATA_DIR;
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe("database health and copy-based recovery", () => {
  it("reports storage state and runs safe maintenance", () => {
    root = mkdtempSync(join(tmpdir(), "total-health-"));
    process.env.TOTAL_DATA_DIR = root;
    const db = openCompanyDb("health-books");
    seedCompany(db, TEST_INFO);
    expect(systemHealth(db, "health-books")).toMatchObject({
      quickCheck: "ok",
      journalMode: "wal",
    });
    expect(
      runMaintenance(db, "health-books", "optimize", "Owner"),
    ).toMatchObject({ mode: "optimize", quickCheck: "ok" });
    db.close();
  });

  it("preserves originals and creates a verified recovery backup without replacing live data", async () => {
    root = mkdtempSync(join(tmpdir(), "total-recovery-"));
    process.env.TOTAL_DATA_DIR = root;
    const db = openCompanyDb("recovery-books");
    seedCompany(db, TEST_INFO);
    db.close();
    const result = await attemptRecoveryCopy("recovery-books");
    expect(result.success).toBe(true);
    expect(result.recoveredBackup).toMatch(/recovered-copy\.db$/);
  });

  it("classifies critical space relative to both book and incoming write size", () => {
    expect(diskState(100, 10, 40)).toBe("critical");
    expect(diskState(3 * 1024 ** 3, 10, 40)).toBe("healthy");
  });
});
