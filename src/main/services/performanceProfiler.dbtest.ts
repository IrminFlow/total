import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openCompanyDb } from "../db/connection";
import { seedCompany } from "../db/seed";
import { TEST_INFO } from "../db/testdb";
import { writePerformanceProfilerPack } from "./performanceProfiler";

let root: string | null = null;
afterEach(() => {
  delete process.env.TOTAL_DATA_DIR;
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe("anonymized performance profiler", () => {
  it("exports only allow-listed runtime, count, timing and plan evidence", () => {
    root = mkdtempSync(join(tmpdir(), "total-profiler-"));
    process.env.TOTAL_DATA_DIR = root;
    const db = openCompanyDb("profile-books");
    seedCompany(db, TEST_INFO);
    const result = writePerformanceProfilerPack(
      db,
      "profile-books",
      "0.5.0",
      "Owner",
    );
    const payload = JSON.parse(readFileSync(result.path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(payload)).toEqual([
      "schema",
      "createdAt",
      "runtime",
      "storage",
      "cardinality",
      "workload",
      "queryPlans",
    ]);
    expect(JSON.stringify(payload)).not.toContain(TEST_INFO.name);
    db.close();
  });
});
