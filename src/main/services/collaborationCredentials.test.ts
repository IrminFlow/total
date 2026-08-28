import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8").replace(/^encrypted:/, ""),
  },
}));

import {
  configureCollaborationCredentials,
  readCollaborationCredentials,
  updateCollaborationSession,
} from "./collaborationCredentials";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "total-collaboration-credentials-")); process.env.TOTAL_DATA_DIR = root; });
afterEach(() => { delete process.env.TOTAL_DATA_DIR; rmSync(root, { recursive: true, force: true }); });

describe("encrypted collaboration session storage", () => {
  it("reads legacy static credentials and atomically persists rotated Supabase tokens", () => {
    configureCollaborationCredentials("books", {
      endpoint: "https://project.supabase.co/functions/v1/total-sync",
      workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      apiToken: "legacy-access",
      enabled: true,
    });
    const legacy = readCollaborationCredentials("books");
    expect(legacy).toMatchObject({ apiToken: "legacy-access" });
    expect(legacy).not.toHaveProperty("refreshToken");
    updateCollaborationSession("books", {
      apiToken: "rotated-access",
      refreshToken: "rotated-refresh",
      accessTokenExpiresAt: "2026-08-29T10:00:00.000Z",
    });
    expect(readCollaborationCredentials("books")).toMatchObject({
      apiToken: "rotated-access", refreshToken: "rotated-refresh", accessTokenExpiresAt: "2026-08-29T10:00:00.000Z",
    });
    const wrapper = readFileSync(join(root, "collaboration-credentials.json"), "utf8");
    expect(wrapper).not.toContain("rotated-access");
    expect(wrapper).not.toContain("rotated-refresh");
  });
});
