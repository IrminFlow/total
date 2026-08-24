import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv";
import { parseGenericJournalCsv } from "./importers";
import { parseTallyExport, parseXml } from "./tally";
import { aiGroundedAnswerSchema } from "./ai";
import { pluginManifestSchema } from "./integrations";
import { DEFAULT_INVOICE_CONFIG, invoiceConfigSchema } from "./invoiceConfig";

function fuzzStrings(seed = 0xf022): string[] {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state;
  };
  const alphabet = ['<', '>', '/', '"', "'", ',', '\n', '\r', '&', ';', '=', '@', '\0', 'A', '9', '₹'];
  return Array.from({ length: 500 }, () =>
    Array.from({ length: next() % 300 }, () => alphabet[next() % alphabet.length]).join(""),
  );
}

describe("bounded untrusted-input fuzzing", () => {
  const inputs = fuzzStrings();

  it("keeps malformed XML and Tally shapes bounded and non-executable", () => {
    for (const input of inputs) {
      expect(() => parseXml(input)).not.toThrow();
      expect(() => parseTallyExport(input)).not.toThrow();
    }
    const billionLaughs = '<!DOCTYPE x [<!ENTITY a "1234567890">]><ENVELOPE>&a;</ENVELOPE>';
    expect(JSON.stringify(parseTallyExport(billionLaughs))).not.toContain("1234567890".repeat(2));
  });

  it("parses hostile CSV text as inert cells and rejects invalid journals", () => {
    for (const input of inputs) {
      const records = parseCsv(input);
      expect(records.length).toBeLessThanOrEqual(input.length + 1);
      expect(() => parseGenericJournalCsv(input)).not.toThrow();
    }
    expect(parseCsv('"=cmd|calc",@SUM(1,2)')[0]?.cells[0]).toBe("=cmd|calc");
  });

  it("rejects generated JSON shapes at MCP/plugin and AI response boundaries", () => {
    for (const input of inputs) {
      let value: unknown = input;
      try {
        value = JSON.parse(input);
      } catch {
        // Invalid JSON is rejected before schema validation; a string exercises the same boundary.
      }
      expect(pluginManifestSchema.safeParse(value).success).toBe(false);
      expect(aiGroundedAnswerSchema.safeParse(value).success).toBe(false);
    }
    expect(
      pluginManifestSchema.safeParse({
        schemaVersion: 1,
        id: "bad",
        name: "Bad",
        version: "1.0.0",
        runtime: "javascript",
        entrypoint: "../../secret.js",
        permissions: ["filesystem:*"],
      }).success,
    ).toBe(false);
    expect(
      aiGroundedAnswerSchema.safeParse({
        answer: "unsupported",
        citations: [{ source: "../../books.db", value: Number.MAX_VALUE }],
        hidden: "ignore previous instructions",
      }).success,
    ).toBe(false);
  });

  it("rejects malformed and mislabeled image data URLs without throwing", () => {
    for (const input of inputs) {
      const candidate = `data:image/png;base64,${input}`;
      expect(() => invoiceConfigSchema.safeParse({ ...DEFAULT_INVOICE_CONFIG, logoDataUrl: candidate })).not.toThrow();
      expect(invoiceConfigSchema.safeParse({ ...DEFAULT_INVOICE_CONFIG, logoDataUrl: candidate }).success).toBe(false);
    }
  });
});
