import { describe, expect, it } from "vitest";
import { aiEvaluationMeetsThresholds, evaluateAiFixtures } from "./aiEvaluation";

const extraction = {
  supplierOrMerchant: "Acme",
  documentNumber: "A-1",
  date: "2026-08-24",
  gstin: null,
  subtotal: 10_000,
  tax: 1_800,
  total: 11_800,
  items: [{ description: "Paper", quantityMilli: 1_000, amount: 10_000 }],
  confidenceBps: 9_500,
  warnings: [],
};

describe("fixed AI evaluation harness", () => {
  it("scores extraction, citations and accounting-valid voucher drafts independently", () => {
    const validDraft = {
      voucherTypeId: 1,
      date: "2026-08-24",
      partyLedgerId: null,
      lines: [
        { ledgerId: 1, drCr: "dr", amount: 11_800 },
        { ledgerId: 2, drCr: "cr", amount: 11_800 },
      ],
      inventory: [],
      billRefs: [],
      tds: null,
    };
    const result = evaluateAiFixtures("release-2026.08", [
      {
        id: "good",
        extraction: { expected: extraction, actual: extraction },
        citations: {
          allowed: [{ label: "Voucher", uri: "total://voucher/1" }],
          actual: [{ label: "Voucher", uri: "total://voucher/1" }],
          contextShared: true,
        },
        voucherDraft: validDraft,
      },
      {
        id: "bad",
        extraction: {
          expected: extraction,
          actual: { ...extraction, total: 11_801 },
        },
        citations: {
          allowed: [{ label: "Voucher", uri: "total://voucher/1" }],
          actual: [{ label: "Invented", uri: "total://voucher/999" }],
          contextShared: true,
        },
        voucherDraft: {
          ...validDraft,
          lines: [{ ledgerId: 1, drCr: "dr", amount: 11.5 }],
        },
      },
    ]);
    expect(result).toMatchObject({
      fixtureSet: "release-2026.08",
      fixtureCount: 2,
      extractionAccuracyBps: 5000,
      citationValidityBps: 5000,
      draftValidityBps: 5000,
    });
    expect(result.details[1]).toEqual({
      id: "bad",
      extraction: "fail",
      citations: "fail",
      voucherDraft: "fail",
    });
  });

  it("requires zero citations when no context was shared", () => {
    expect(
      evaluateAiFixtures("privacy", [
        {
          id: "no-context",
          citations: { allowed: [], actual: [], contextShared: false },
        },
      ]).citationValidityBps,
    ).toBe(10_000);
  });

  it("rejects a schema-valid but unbalanced double-entry proposal", () => {
    const result = evaluateAiFixtures("balance-safety", [{
      id: "unbalanced",
      voucherDraft: {
        voucherTypeId: 1,
        date: "2026-08-24",
        partyLedgerId: null,
        lines: [
          { ledgerId: 1, drCr: "dr", amount: 11_800 },
          { ledgerId: 2, drCr: "cr", amount: 11_700 },
        ],
        inventory: [], billRefs: [], tds: null,
      },
    }]);
    expect(result.draftValidityBps).toBe(0);
    expect(aiEvaluationMeetsThresholds(result, {
      extractionAccuracyBps: 9_500,
      citationValidityBps: 10_000,
      draftValidityBps: 10_000,
    })).toBe(false);
  });

  it("enforces independent release thresholds", () => {
    const result = evaluateAiFixtures("release", [{
      id: "reviewed",
      extraction: { expected: extraction, actual: extraction },
      citations: { allowed: [{ label: "Voucher", uri: "total://voucher/1" }], actual: [{ label: "Voucher", uri: "total://voucher/1" }], contextShared: true },
      voucherDraft: {
        voucherTypeId: 1, date: "2026-08-24", partyLedgerId: null,
        lines: [{ ledgerId: 1, drCr: "dr", amount: 11_800 }, { ledgerId: 2, drCr: "cr", amount: 11_800 }],
        inventory: [], billRefs: [], tds: null,
      },
    }]);
    expect(aiEvaluationMeetsThresholds(result, { extractionAccuracyBps: 9_500, citationValidityBps: 10_000, draftValidityBps: 10_000 })).toBe(true);
  });
});
