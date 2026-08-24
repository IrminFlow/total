import { describe, expect, it } from "vitest";
import { feedbackDeleteAfter, supportDeleteAfter } from "./intakeRetention";

describe("intake retention periods", () => {
  it("keeps resolved support cases for exactly 90 days", () => {
    expect(supportDeleteAfter("2026-01-01T00:00:00.000Z")).toBe("2026-04-01T00:00:00.000Z");
  });

  it("uses calendar months for the 24-month feedback period", () => {
    expect(feedbackDeleteAfter("2024-02-29T10:15:00.000Z")).toBe("2026-02-28T10:15:00.000Z");
  });
});
