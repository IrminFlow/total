import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeTallyXml,
  MAX_TALLY_IMPORT_BYTES,
  readTallyXmlFile,
  validateTallyXml,
} from "./tallyInput";

const recognizedXml = "<ENVELOPE><TALLYMESSAGE><GROUP NAME=\"Debtors\"><PARENT>Assets</PARENT></GROUP></TALLYMESSAGE></ENVELOPE>";
let root: string | null = null;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

function tempFile(name: string, contents: Uint8Array): string {
  root ??= mkdtempSync(join(tmpdir(), "total-tally-input-"));
  const path = join(root, name);
  writeFileSync(path, contents);
  return path;
}

function utf16be(value: string): Buffer {
  const little = Buffer.from(value, "utf16le");
  const big = Buffer.alloc(little.length + 2);
  big[0] = 0xfe;
  big[1] = 0xff;
  for (let i = 0; i < little.length; i += 2) {
    big[i + 2] = little[i + 1]!;
    big[i + 3] = little[i]!;
  }
  return big;
}

describe("Tally input boundary", () => {
  it("decodes UTF-8 BOM, UTF-16LE, and UTF-16BE exports", () => {
    expect(decodeTallyXml(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(recognizedXml)]))).toBe(recognizedXml);
    expect(decodeTallyXml(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(recognizedXml, "utf16le")]))).toBe(recognizedXml);
    expect(decodeTallyXml(utf16be(recognizedXml))).toBe(recognizedXml);
  });

  it("stats and caps files before reading them", () => {
    root = mkdtempSync(join(tmpdir(), "total-tally-input-"));
    const path = join(root, "oversized.xml");
    writeFileSync(path, "x");
    truncateSync(path, MAX_TALLY_IMPORT_BYTES + 1);
    expect(() => readTallyXmlFile(path)).toThrow(/64 MB/);
  });

  it("reads supported encoded files and rejects invalid byte encodings", () => {
    expect(readTallyXmlFile(tempFile("export.xml", utf16be(recognizedXml)))).toBe(recognizedXml);
    expect(() => decodeTallyXml(Buffer.from([0xc3, 0x28]))).toThrow(/UTF-8/);
  });

  it("rejects empty, oversized inline, and zero-recognized XML", () => {
    expect(() => validateTallyXml("")).toThrow(/empty/);
    expect(() => validateTallyXml("x".repeat(MAX_TALLY_IMPORT_BYTES + 1))).toThrow(/64 MB/);
    expect(() => validateTallyXml("<ENVELOPE><BODY/></ENVELOPE>")).toThrow(/no recognized/i);
    expect(validateTallyXml(recognizedXml).groups).toBe(1);
  });
});
