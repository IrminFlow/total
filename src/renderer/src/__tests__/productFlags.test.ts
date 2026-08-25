import { describe, expect, it } from "vitest";
import { readProductFlags, setProductFlag } from "../lib/productFlags";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, clear: () => values.clear(), getItem: (key) => values.get(key) ?? null, key: (index) => [...values.keys()][index] ?? null, removeItem: (key) => void values.delete(key), setItem: (key, value) => void values.set(key, value) };
}

describe("local product flags", () => {
  it("defaults to stable public features and retains a bounded local history", () => {
    const storage = memoryStorage();
    expect(readProductFlags(storage).flags.guidedHelp).toBe(true);
    expect(readProductFlags(storage).flags.smtpDeliveryPreview).toBe(false);
    expect(readProductFlags(storage).flags).toMatchObject({
      aiCopilot: false,
      mcpAccess: false,
      supportUploads: false,
      telemetry: false,
    });
    setProductFlag(storage, "featureDiscovery", false, new Date("2026-08-24T00:00:00Z"));
    const state = readProductFlags(storage);
    expect(state.flags.featureDiscovery).toBe(false);
    expect(state.history[0]).toMatchObject({ flag: "featureDiscovery", enabled: false });
  });
});
