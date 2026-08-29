import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createBoundedTemporaryDirectory,
  withTemporaryDirectory,
} from "./tempArtifacts";

const leftovers: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const path of leftovers) rmSync(path, { recursive: true, force: true });
  leftovers.length = 0;
});

describe("temporary artifact lifecycle", () => {
  it("removes an import workspace when its callback throws", async () => {
    let created = "";
    await expect(
      withTemporaryDirectory("total-test-import-", (path) => {
        created = path;
        writeFileSync(join(path, "decrypted.db"), "sensitive bytes");
        throw new Error("invalid imported backup");
      }),
    ).rejects.toThrow("invalid imported backup");
    expect(created).not.toBe("");
    expect(existsSync(created)).toBe(false);
  });

  it("expires preview files after the bounded hand-off window", () => {
    vi.useFakeTimers();
    const artifact = createBoundedTemporaryDirectory("total-test-preview-", {
      ttlMs: 1_000,
      staleAfterMs: 60_000,
    });
    writeFileSync(join(artifact.path, "invoice.pdf"), "decrypted preview");
    expect(existsSync(artifact.path)).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(existsSync(artifact.path)).toBe(false);
  });

  it("prunes bounded stale crash leftovers sharing the exact prefix", () => {
    const stale = mkdtempSync(join(tmpdir(), "total-test-stale-"));
    leftovers.push(stale);
    const old = new Date(Date.now() - 120_000);
    utimesSync(stale, old, old);
    const artifact = createBoundedTemporaryDirectory("total-test-stale-", {
      ttlMs: 1_000,
      staleAfterMs: 60_000,
    });
    leftovers.push(artifact.path);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(artifact.path)).toBe(true);
    artifact.dispose();
  });

  it("does not prune a stale lookalike that was not created by mkdtemp", () => {
    const lookalike = join(tmpdir(), "total-test-owned-important-work");
    mkdirSync(lookalike, { recursive: true });
    leftovers.push(lookalike);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lookalike, old, old);
    const artifact = createBoundedTemporaryDirectory("total-test-owned-", {
      ttlMs: 1_000,
      staleAfterMs: 60_000,
    });
    leftovers.push(artifact.path);
    expect(existsSync(lookalike)).toBe(true);
    artifact.dispose();
  });
});
