import { describe, expect, it } from "vitest";
import { certificationProgress, cohortPayload, freshCommercialState, recordCohortEvent, referralCode, validReferralCode, writeCommercialState } from "../lib/commercialOps";
import { setProductFlag } from "../lib/productFlags";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, clear: () => values.clear(), getItem: (key) => values.get(key) ?? null, key: (index) => [...values.keys()][index] ?? null, removeItem: (key) => void values.delete(key), setItem: (key, value) => void values.set(key, value) };
}

describe("commercial operations preferences", () => {
  it("generates typo-detecting referral codes that work offline", () => {
    const code = referralCode("abcd1234");
    expect(validReferralCode(code)).toBe(true);
    expect(validReferralCode(`${code.slice(0, -1)}Z`)).toBe(false);
  });

  it("builds an allow-listed cohort envelope without book or company fields", () => {
    const storage = memoryStorage();
    const state = freshCommercialState("install123456", new Date("2026-08-01T00:00:00Z"));
    state.analytics.enabled = true;
    writeCommercialState(storage, state);
    setProductFlag(storage, "telemetry", true);
    recordCohortEvent(storage, "first_voucher_posted", new Date("2026-08-02T00:00:00Z"));
    recordCohortEvent(storage, "voucher_amount_999", new Date("2026-08-02T00:00:00Z"));
    const payload = cohortPayload(JSON.parse(storage.getItem("total:commercial:v1")!), "0.5.0", "darwin");
    expect(JSON.stringify(payload)).toContain("first_voucher_posted");
    expect(JSON.stringify(payload)).not.toContain("voucher_amount_999");
    expect(payload).not.toHaveProperty("company");
  });

  it("records nothing when the independent telemetry kill switch is off", () => {
    const storage = memoryStorage();
    const state = freshCommercialState("install123456", new Date("2026-08-01T00:00:00Z"));
    state.analytics.enabled = true;
    writeCommercialState(storage, state);
    recordCohortEvent(storage, "first_voucher_posted", new Date("2026-08-02T00:00:00Z"));
    expect(JSON.parse(storage.getItem("total:commercial:v1")!).analytics.events).toEqual({});
  });

  it("does not claim certification before every module is completed", () => {
    const state = freshCommercialState("training");
    expect(certificationProgress(state).eligible).toBe(false);
  });
});
