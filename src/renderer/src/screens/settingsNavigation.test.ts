import { describe, expect, it } from "vitest";
import { filterSettingsGroups, SETTINGS_GROUPS } from "./Settings";

const EXPECTED_DESTINATIONS = [
  "about",
  "accessibility",
  "agents",
  "ai",
  "audit",
  "backups",
  "bin",
  "community",
  "controls",
  "email",
  "features",
  "health",
  "integrations",
  "invoice",
  "nic",
  "privacy",
  "users",
];

describe("settings navigation", () => {
  it("keeps every deep-link destination exactly once", () => {
    const destinations = SETTINGS_GROUPS.flatMap((group) =>
      group.items.map((item) => item.id),
    );

    expect(destinations).toHaveLength(new Set(destinations).size);
    expect([...destinations].sort()).toEqual(EXPECTED_DESTINATIONS);
  });

  it("finds destinations by task and integration keywords", () => {
    expect(
      filterSettingsGroups(SETTINGS_GROUPS, "restore").flatMap((group) =>
        group.items.map((item) => item.id),
      ),
    ).toEqual(["backups"]);
    expect(
      filterSettingsGroups(SETTINGS_GROUPS, "SMTP").flatMap((group) =>
        group.items.map((item) => item.id),
      ),
    ).toEqual(["email"]);
  });

  it("returns a complete group when its label matches", () => {
    const result = filterSettingsGroups(SETTINGS_GROUPS, "permissions");

    expect(result).toHaveLength(1);
    expect(result[0]?.items.map((item) => item.id)).toEqual([
      "users",
      "controls",
      "audit",
    ]);
  });

  it("returns no groups for an unknown setting", () => {
    expect(filterSettingsGroups(SETTINGS_GROUPS, "satellite modem")).toEqual(
      [],
    );
  });
});
