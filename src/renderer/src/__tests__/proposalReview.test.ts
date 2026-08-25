import { describe, expect, it } from "vitest";
import { proposalReviewSummary } from "../lib/proposalReview";

describe("AI and MCP proposal review summary", () => {
  it("explains the accounting effect and calls out missing source context", () => {
    const result = proposalReviewSummary(
      {
        voucherTypeId: 1,
        date: "2026-08-25",
        reference: null,
        narration: "",
        partyLedgerId: null,
        lines: [
          { ledgerId: 10, drCr: "dr", amount: 12500, costAllocations: [] },
          { ledgerId: 20, drCr: "cr", amount: 12500, costAllocations: [] },
        ],
        inventory: [],
        registrations: [],
        isOptional: false,
      },
      new Map([[10, "Rent"], [20, "Bank"]]),
      "Payment",
    );
    expect(result.balanced).toBe(true);
    expect(result.explanation).toContain("debit Rent and credit Bank");
    expect(result.warnings).toEqual([
      expect.stringContaining("Narration is blank"),
      expect.stringContaining("Reference is blank"),
    ]);
  });

  it("blocks an unbalanced proposal and identifies unknown ledgers", () => {
    const result = proposalReviewSummary(
      {
        voucherTypeId: 1,
        date: "2026-08-25",
        reference: "BANK-12",
        narration: "Bank receipt",
        partyLedgerId: null,
        lines: [
          { ledgerId: 10, drCr: "dr", amount: 20000, costAllocations: [] },
          { ledgerId: 99, drCr: "cr", amount: 19900, costAllocations: [] },
        ],
        inventory: [],
        registrations: [],
        isOptional: false,
      },
      new Map([[10, "Bank"]]),
      "Receipt",
    );
    expect(result.balanced).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/differ by/);
    expect(result.warnings.join(" ")).toContain("#99");
  });
});
