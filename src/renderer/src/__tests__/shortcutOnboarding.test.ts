import { describe, expect, it } from "vitest";
import {
  completeShortcutGuide,
  readShortcutGuide,
  SHORTCUT_GUIDE_KEY,
} from "../lib/shortcutOnboarding";

describe("shortcut onboarding", () => {
  it("starts incomplete and records a stable completion timestamp", () => {
    localStorage.clear();
    expect(readShortcutGuide(localStorage)).toEqual({
      completed: false,
      completedAt: null,
    });
    const now = new Date("2026-08-25T10:30:00.000Z");
    expect(completeShortcutGuide(localStorage, now)).toEqual({
      completed: true,
      completedAt: now.toISOString(),
    });
    expect(readShortcutGuide(localStorage).completed).toBe(true);
  });

  it("recovers from malformed device preferences", () => {
    localStorage.setItem(SHORTCUT_GUIDE_KEY, "not-json");
    expect(readShortcutGuide(localStorage).completed).toBe(false);
  });
});
