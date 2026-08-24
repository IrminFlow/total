import { describe, expect, it } from "vitest";
import { seededDb } from "../db/testdb";
import { applyBusinessTemplate, defaultOnboardingProfile, onboardingStatus } from "./onboarding";

describe("guided company setup", () => {
  it("derives an editable industry chart and a transparent setup score", () => {
    const db = seededDb();
    const created = applyBusinessTemplate(db, "retailer");
    expect(created).toEqual(["Retail Sales", "Shop Rent", "Card Settlement"]);
    const status = onboardingStatus(db, defaultOnboardingProfile({ businessType: "retailer", needsInventory: true }), 0);
    expect(status.openingDifference).toBe(0);
    expect(status.profile.setupSteps.ledgers).toBe(true);
    expect(status.profile.setupSteps.bank).toBe(true);
    expect(status.profile.setupSteps.backup).toBe(false);
    expect(status.score).toBeGreaterThan(40);
    db.close();
  });
});
