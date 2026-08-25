// Scenario 46 — database diagnostics, governed maintenance and copy-based recovery.
import { scenario, assert, assertEq } from "../lib/harness.mjs";

await scenario("46-data-health", async (h) => {
  await h.createDemoCompany();
  await h.stubDialogs();
  await h.goto("settings");
  await h.page
    .getByRole("button", { name: "Data health", exact: true })
    .click();
  await h.page.locator('[data-testid="data-health-settings"]').waitFor();
  await h.page
    .getByText("See risk before it becomes downtime.", { exact: true })
    .waitFor();
  await h.shot("01-data-health");

  const before = await h.invoke("system:health");
  assertEq(before.quickCheck, "ok", "quick integrity check is visible");
  assert(before.freeBytes > 0, "free-space diagnostic is populated");
  const maintained = await h.invoke("system:maintenance:run", {
    mode: "optimize",
  });
  assertEq(maintained.quickCheck, "ok", "maintenance preserves integrity");
  assert(
    maintained.detail.includes("optimization"),
    "maintenance explains what ran",
  );

  const recovery = await h.invoke("system:recovery:attempt");
  assert(recovery.success, "recovery produces a verified separate copy");
  assert(
    recovery.recoveredBackup.endsWith("recovered-copy.db"),
    "recovery copy appears as a backup",
  );
  await h.shot("02-maintained");
});
