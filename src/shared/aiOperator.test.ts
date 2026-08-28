import { describe, expect, it } from "vitest";
import { aiOperatorActionSchema, aiOperatorPlanSchema } from "./aiOperator";

const reason = "Needed to complete the requested workflow";

describe("AI Operator schemas", () => {
  it.each([
    { kind: "navigate", screen: "day-book", reason },
    { kind: "search_books", query: "overdue invoices", reason },
    { kind: "draft_voucher", instruction: "Record a cash receipt from Asha for invoice 42", reason },
    { kind: "read_file", path: "/approved/reconciliation.txt", reason },
    { kind: "write_file", path: "/approved/summary.txt", content: "Reviewed", reason },
  ])("accepts the bounded $kind action", (action) => {
    expect(aiOperatorActionSchema.parse(action)).toMatchObject(action);
  });

  it("rejects unknown action kinds and missing action-specific fields", () => {
    expect(() => aiOperatorActionSchema.parse({ kind: "run_shell", command: "whoami", reason })).toThrow();
    expect(() => aiOperatorActionSchema.parse({ kind: "write_file", path: "/approved/file", reason })).toThrow();
    expect(() => aiOperatorActionSchema.parse({ kind: "draft_voucher", instruction: "short", reason })).toThrow();
  });

  it("enforces plan and content bounds", () => {
    const action = { kind: "navigate" as const, screen: "gateway", reason };
    expect(aiOperatorPlanSchema.parse({ summary: "Open the gateway", actions: [action] }).actions).toHaveLength(1);
    expect(() => aiOperatorPlanSchema.parse({ summary: "", actions: [] })).toThrow();
    expect(() => aiOperatorPlanSchema.parse({ summary: "x".repeat(2_001), actions: [] })).toThrow();
    expect(() => aiOperatorPlanSchema.parse({ summary: "Too many", actions: Array(21).fill(action) })).toThrow();
    expect(() => aiOperatorActionSchema.parse({
      kind: "write_file",
      path: "/approved/file",
      content: "x".repeat(1_000_001),
      reason,
    })).toThrow();
  });
});
