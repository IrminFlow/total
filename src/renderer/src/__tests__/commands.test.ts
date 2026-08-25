import { beforeEach, describe, expect, it } from "vitest";
import {
  COMMANDS,
  VOUCHER_COMMANDS,
  commandAvailable,
  commandForScreen,
  effectiveBindings,
  findCommandConflicts,
  matchesShortcut,
  readShortcutOverrides,
  resetShortcutOverrides,
  setShortcutOverride,
  voucherKindForKeyboardEvent,
} from "../lib/commands";
import { DEFAULT_FEATURES } from "@shared/features";
import { NAV_SECTIONS, navigationSection, screenDef } from "../lib/screens";

beforeEach(() => resetShortcutOverrides());

describe("command registry", () => {
  it("ships without collisions and makes V the Home voucher mnemonic", () => {
    expect(findCommandConflicts()).toEqual([]);
    const voucher = commandForScreen("voucher-entry")!;
    expect(effectiveBindings(voucher)).toContainEqual({ key: "v", context: "gateway" });
    expect(effectiveBindings(voucher)).toContainEqual({ key: "v", context: "global", alt: true });
  });

  it("defines every requested voucher letter and preserves F4-F9", () => {
    expect(VOUCHER_COMMANDS.map((command) => command.mnemonic)).toEqual([
      "c", "p", "r", "j", "s", "u", "n", "d", "k", "h",
    ]);
    for (const [key, kind] of [["F4", "contra"], ["F5", "payment"], ["F6", "receipt"], ["F7", "journal"], ["F8", "sales"], ["F9", "purchase"]] as const) {
      expect(voucherKindForKeyboardEvent(new KeyboardEvent("keydown", { key }))).toBe(kind);
    }
    expect(voucherKindForKeyboardEvent(new KeyboardEvent("keydown", { key: "F8", altKey: true }))).toBe("credit_note");
    expect(voucherKindForKeyboardEvent(new KeyboardEvent("keydown", { key: "F9", ctrlKey: true }))).toBe("debit_note");
  });

  it("persists a valid override and rejects a collision", () => {
    expect(setShortcutOverride("navigate.daybook", [{ key: "z", context: "global", alt: true }])).toEqual([]);
    expect(readShortcutOverrides()["navigate.daybook"]).toEqual([{ key: "z", context: "global", alt: true }]);
    const conflicts = setShortcutOverride("navigate.registers", [{ key: "z", context: "global", alt: true }]);
    expect(conflicts[0]?.commands).toEqual(["navigate.daybook", "navigate.registers"]);
    expect(readShortcutOverrides()["navigate.registers"]).toBeUndefined();
  });

  it("matches exact modifiers and filters voucher mutations for viewers", () => {
    const altV = effectiveBindings(commandForScreen("voucher-entry")!).find((binding) => binding.context === "global")!;
    expect(matchesShortcut(new KeyboardEvent("keydown", { key: "v", altKey: true }), altV)).toBe(true);
    expect(matchesShortcut(new KeyboardEvent("keydown", { key: "v" }), altV)).toBe(false);
    expect(commandAvailable(VOUCHER_COMMANDS[0]!, DEFAULT_FEATURES, "viewer")).toBe(false);
    expect(commandAvailable(VOUCHER_COMMANDS[0]!, DEFAULT_FEATURES, "accountant")).toBe(true);
  });

  it("keeps every command ID unique", () => {
    expect(new Set(COMMANDS.map((command) => command.id)).size).toBe(COMMANDS.length);
  });

  it("detects case-insensitive modifier collisions but permits the same key in another context", () => {
    const conflicts = findCommandConflicts([
      { id: "one", context: "global", label: "One", bindings: [{ key: "Z", context: "global", alt: true }] },
      { id: "two", context: "global", label: "Two", bindings: [{ key: "z", context: "global", alt: true }] },
      { id: "three", context: "voucher", label: "Three", bindings: [{ key: "z", context: "voucher", alt: true }] },
    ]);
    expect(conflicts).toEqual([{ context: "global", binding: "alt+z", commands: ["one", "two"] }]);
  });

  it("ignores corrupt or structurally invalid persisted overrides", () => {
    localStorage.setItem("total.shortcut-overrides.v1", "{truncated");
    expect(readShortcutOverrides()).toEqual({});
    localStorage.setItem("total.shortcut-overrides.v1", JSON.stringify({
      "navigate.daybook": [{ key: "", context: "global" }],
      "navigate.registers": [{ key: "z", context: "unknown" }],
    }));
    expect(readShortcutOverrides()).toEqual({});
    expect(findCommandConflicts()).toEqual([]);
  });

  it("groups navigation in plain workflow language", () => {
    expect(NAV_SECTIONS.map((section) => section.title)).toEqual([
      "Home", "Create", "Sales", "Purchases", "Banking", "Inventory",
      "Parties", "Compliance", "Payroll", "Reports", "Automation",
    ]);
    expect(navigationSection(screenDef("voucher-entry")!)).toBe("create");
    expect(navigationSection(screenDef("registers")!)).toBe("reports");
    expect(navigationSection(screenDef("settings")!)).toBe("automation");
  });
});
