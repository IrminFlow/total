import { describe, expect, it } from "vitest";
import {
  aiGroundedAnswerSchema,
  extractedDocumentSchema,
  validateAiCitations,
} from "./ai";

const allowed = [
  {
    label: "Trial balance · Cash",
    uri: "total://trial-balance/ledger/1?asOn=2026-03-31",
  },
  { label: "Gateway", uri: "total://gateway?from=2025-04-01&to=2026-03-31" },
];

describe("AI grounding boundary", () => {
  it("accepts, canonicalizes and deduplicates allow-listed citations", () => {
    const result = aiGroundedAnswerSchema.parse({
      answer: "Cash is debit.",
      citations: [
        { label: "invented display label", uri: allowed[0]!.uri },
        { label: "duplicate", uri: allowed[0]!.uri },
      ],
    });
    expect(validateAiCitations(result.citations, allowed)).toEqual([
      allowed[0],
    ]);
  });

  it("rejects uncited book answers and model-invented source URIs", () => {
    expect(() => validateAiCitations([], allowed)).toThrow(/uncited answer/i);
    expect(() =>
      validateAiCitations(
        [{ label: "Fake", uri: "https://example.com/fake" }],
        allowed,
      ),
    ).toThrow(/not in the shared book context/i);
  });

  it("strips all citations when the user shared no book context", () => {
    expect(
      validateAiCitations([{ label: "Anything", uri: allowed[0]!.uri }], null),
    ).toEqual([]);
  });
});

describe("document extraction boundary", () => {
  it("accepts integer paise and quantity thousandths for human review", () => {
    expect(
      extractedDocumentSchema.parse({
        supplierOrMerchant: "Acme",
        documentNumber: "A-1",
        date: "2026-08-24",
        gstin: null,
        subtotal: 10000,
        tax: 1800,
        total: 11800,
        items: [{ description: "Paper", quantityMilli: 1000, amount: 10000 }],
        confidenceBps: 9500,
        warnings: [],
      }).total,
    ).toBe(11800);
  });

  it("rejects floating-point money and out-of-range confidence", () => {
    const base = {
      supplierOrMerchant: null,
      documentNumber: null,
      date: null,
      gstin: null,
      subtotal: null,
      tax: null,
      total: 12.5,
      items: [],
      confidenceBps: 10001,
      warnings: [],
    };
    expect(extractedDocumentSchema.safeParse(base).success).toBe(false);
  });
});
