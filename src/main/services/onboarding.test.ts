import { describe, expect, it } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { defaultOnboardingProfile, readOnboardingProfile, writeOnboardingProfile } from "./onboarding";

describe("onboarding profile", () => {
  it("round-trips a versioned, device-local setup plan atomically", () => {
    const file = join(mkdtempSync(join(tmpdir(), "total-onboarding-")), "setup.json");
    const profile = defaultOnboardingProfile({ businessType: "retailer", priorSoftware: "tally", needsInventory: true, now: new Date("2026-08-24T00:00:00Z") });
    writeOnboardingProfile(file, profile);
    expect(readOnboardingProfile(file)).toEqual(profile);
  });
});
