import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
  createStoredZip,
  createSupportCase,
  readSupportCases,
  updateSupportCase,
} from "./supportCases";

const consent = {
  message: true,
  diagnostics: true,
  logs: false,
  companyMetadata: false,
  focusContext: false,
  screenshot: false,
};

describe("support case ledger", () => {
  it("retains status and consent without retaining message or contact content", () => {
    const root = mkdtempSync(join(tmpdir(), "total-support-cases-"));
    const path = join(root, "support-cases.json");
    const created = createSupportCase(
      path,
      { category: "bug", consent },
      new Date("2026-08-24T10:00:00.000Z"),
    );
    expect(created.id).toMatch(/^TOT-20260824-[A-F0-9]{6}$/);
    updateSupportCase(
      path,
      created.id,
      { status: "submitted" },
      new Date("2026-08-24T10:01:00.000Z"),
    );
    expect(readSupportCases(path)[0]).toMatchObject({
      id: created.id,
      status: "submitted",
      submittedAt: "2026-08-24T10:01:00.000Z",
    });
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("private message body");
    expect(raw).not.toContain("person@example.com");
    expect(JSON.parse(raw).cases[0]).not.toHaveProperty("email");
  });
});

describe("stored support ZIP", () => {
  it("writes standard local, central-directory and end records", () => {
    const zip = createStoredZip([
      { name: "case.json", data: Buffer.from('{"ok":true}') },
      { name: "screenshot.jpg", data: Buffer.from([1, 2, 3]) },
    ]);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.includes(Buffer.from("case.json"))).toBe(true);
    expect(zip.includes(Buffer.from("screenshot.jpg"))).toBe(true);
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
    expect(zip.readUInt16LE(zip.length - 14)).toBe(2);
  });

  it("rejects traversal and user-controlled entry names", () => {
    expect(() =>
      createStoredZip([{ name: "../secret", data: Buffer.alloc(0) }]),
    ).toThrow("Unsafe support bundle entry name");
  });
});
