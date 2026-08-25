import { afterEach, describe, expect, it } from "vitest";
import { formatPaise, setDefaultNumberGrouping } from "@shared/money";
import {
  applyAccessibilityPreferences,
  DEFAULT_ACCESSIBILITY_PREFERENCES,
  readAccessibilityPreferences,
} from "../lib/accessibilityPrefs";
import { localizedLabel } from "../lib/localization";
import { focusContextFor } from "../lib/supportContext";

afterEach(() => {
  localStorage.clear();
  setDefaultNumberGrouping("indian");
  document.documentElement.removeAttribute("data-font-scale");
  document.documentElement.removeAttribute("data-motion");
  document.documentElement.removeAttribute("data-reading-mode");
  document.documentElement.removeAttribute("data-ui-language");
  document.documentElement.lang = "";
  document.body.innerHTML = "";
});

describe("accessibility preferences", () => {
  it("applies reading preferences and international grouping without touching values", () => {
    applyAccessibilityPreferences({
      fontScale: "large",
      motion: "reduce",
      readingMode: "dyslexia",
      numberGrouping: "international",
      language: "hi",
    });
    expect(document.documentElement.dataset.fontScale).toBe("large");
    expect(document.documentElement.dataset.motion).toBe("reduce");
    expect(document.documentElement.dataset.readingMode).toBe("dyslexia");
    expect(document.documentElement.lang).toBe("hi");
    expect(formatPaise(1234567890)).toBe("12,345,678.90");
    expect(readAccessibilityPreferences().language).toBe("hi");
  });

  it("falls back safely when stored preferences are malformed", () => {
    localStorage.setItem("total-accessibility-v1", "{bad json");
    expect(readAccessibilityPreferences()).toEqual(
      DEFAULT_ACCESSIBILITY_PREFERENCES,
    );
  });

  it("keeps English accounting terms discoverable in Hindi navigation", () => {
    expect(localizedLabel("Trial balance", "hi")).toBe(
      "ट्रायल बैलेंस (Trial balance)",
    );
    expect(localizedLabel("Unknown screen", "hi")).toBe("Unknown screen");
  });
});

describe("accessibility report focus context", () => {
  it("captures a stable accessible name and never captures an input value", () => {
    document.body.innerHTML = `
      <main data-screen="voucher-entry">
        <label for="narration">Narration</label>
        <input id="narration" data-testid="input-narration" value="private customer details" />
      </main>`;
    const context = focusContextFor(document.querySelector("input"));
    expect(context).toEqual({
      tag: "input",
      role: null,
      name: "Narration",
      testId: "input-narration",
      screen: "voucher-entry",
    });
    expect(JSON.stringify(context)).not.toContain("private customer details");
  });

  it("uses visible button text as the voice-control accessible name", () => {
    document.body.innerHTML = "<button>Save voucher</button>";
    expect(focusContextFor(document.querySelector("button"))?.name).toBe(
      "Save voucher",
    );
  });
});
