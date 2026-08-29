import { describe, expect, it } from "vitest";
import { dismissDiscovery, releaseNotesDue, visitForDiscovery } from "../lib/productEducation";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

describe("product education", () => {
  it("shows release notes once for an upgrade, not a first install", () => {
    const storage = memoryStorage();
    expect(releaseNotesDue(storage, "0.5.0")).toBe(false);
    expect(releaseNotesDue(storage, "0.5.1")).toBe(true);
  });

  it("waits for related use and respects dismiss and never-show choices", () => {
    const storage = memoryStorage();
    const now = new Date("2026-08-24T00:00:00.000Z");
    expect(visitForDiscovery(storage, "registers", now)).toBeNull();
    expect(visitForDiscovery(storage, "registers", now)?.id).toBe("register-quarter");
    dismissDiscovery(storage, "register-quarter", false, now);
    expect(visitForDiscovery(storage, "registers", now)).toBeNull();
    dismissDiscovery(storage, "register-quarter", true, new Date("2026-10-01T00:00:00.000Z"));
    expect(visitForDiscovery(storage, "registers", new Date("2027-01-01T00:00:00.000Z"))).toBeNull();
  });
});
