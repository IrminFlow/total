import { describe, expect, it } from "vitest";
import { DEFAULT_FEATURES } from "@shared/features";
import { contextualHelp, searchHelp } from "../lib/helpContent";

describe("offline help index", () => {
  it("ranks exact task language without a network request", () => {
    expect(searchHelp("quarterly purchase register")[0]?.id).toBe("register-periods");
    expect(searchHelp("corrupt sqlite database")[0]?.id).toBe("data-health");
  });

  it("keeps contextual suggestions aligned to enabled features", () => {
    expect(contextualHelp("inventory-control", DEFAULT_FEATURES)[0]?.id).toBe("inventory");
    expect(
      contextualHelp("inventory-control", { ...DEFAULT_FEATURES, inventory: false }),
    ).toEqual([]);
  });
});
