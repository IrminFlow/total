import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`sealed:${value}`, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8").replace(/^sealed:/, ""),
  },
}));

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { companyExportsDir, ensureCompanyTree } from "../paths";
import {
  initializeSigningIdentity,
  signExportArtifact,
  signingStatus,
  verifyExportSignature,
} from "./exportSigning";

let root: string | null = null;
afterEach(() => {
  delete process.env.TOTAL_DATA_DIR;
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe("tamper-evident export identity", () => {
  it("signs a company export and detects later mutation", () => {
    root = mkdtempSync(join(tmpdir(), "total-signing-"));
    process.env.TOTAL_DATA_DIR = root;
    const slug = "signed-books";
    ensureCompanyTree(slug);
    expect(signingStatus().enabled).toBe(false);
    expect(initializeSigningIdentity().keyId).toMatch(/^[a-f0-9]{20}$/);
    const artifact = join(companyExportsDir(slug), "report.json");
    writeFileSync(artifact, '{"total":125000}');
    const signed = signExportArtifact(slug, artifact);
    expect(verifyExportSignature(artifact, signed.signaturePath)).toBe(true);
    writeFileSync(artifact, '{"total":125001}');
    expect(verifyExportSignature(artifact, signed.signaturePath)).toBe(false);
  });
});
