import { describe, expect, it } from "vitest";
import { feedbackReceiptIdeaId } from "./community";

describe("feedback receipt normalization", () => {
  it("accepts the private Blob submit receipt used in production", () => {
    expect(feedbackReceiptIdeaId("submit", null, {
      ok: true,
      id: "09a74630-4f8b-46dd-81fe-be117cb06484",
      receivedAt: "2026-08-24T12:03:24.000Z",
      status: "awaiting_review",
    })).toBe("09a74630-4f8b-46dd-81fe-be117cb06484");
  });

  it("accepts provider-style receipts and preserves requested vote/follow IDs", () => {
    expect(feedbackReceiptIdeaId("submit", null, { ok: true, ideaId: "new-idea" })).toBe("new-idea");
    expect(feedbackReceiptIdeaId("vote", "mobile-companion", { ok: true, id: "event-id" })).toBe("mobile-companion");
    expect(feedbackReceiptIdeaId("follow", "more-bank-formats", { ok: true })).toBe("more-bank-formats");
  });

  it("rejects invalid or receipt-free submissions", () => {
    expect(() => feedbackReceiptIdeaId("submit", null, { ok: true })).toThrow(/receipt/);
    expect(() => feedbackReceiptIdeaId("submit", null, { ok: false, id: "bad" })).toThrow();
  });
});
