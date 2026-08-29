// Scenario 44 — declarative integration boundary, visible webhook outbox and local schedules.
import { scenario, assert, assertEq } from "../lib/harness.mjs";

await scenario("44-integration-control", async (h) => {
  await h.createDemoCompany();
  await h.goto("settings");
  await h.page.getByRole("button", { name: "Integrations", exact: true }).click();
  await h.page.locator('[data-testid="integrations-settings"]').waitFor();
  await h.page
    .getByText("Connect the edges. Keep the books sovereign.", { exact: true })
    .waitFor();
  await h.shot("01-integration-control");

  await h.page.getByRole("button", { name: "New schedule", exact: true }).click();
  await h.fill("input-automation-name", "Daily fresh mirror");
  await h.page.locator('[data-testid="select-automation-task"]').selectOption("mirror");
  await h.page.locator('[data-testid="select-automation-cadence"]').selectOption("daily");
  await h.fill("input-automation-time", "21:45");
  await h.page.getByRole("button", { name: "Create schedule", exact: true }).click();
  await h.page.getByText("Daily fresh mirror", { exact: true }).waitFor();
  const schedules = await h.invoke("integrations:automation:schedules");
  assertEq(schedules.length, 1, "one visible schedule is retained");
  assertEq(schedules[0].taskKind, "mirror", "schedule retains its exact task");
  await h.shot("02-scheduled");

  await h.page.getByTitle("Run now").click();
  await h.page.getByText("Last run succeeded", { exact: false }).waitFor();
  const runs = await h.invoke("integrations:automation:runs", { limit: 10 });
  assert(runs[0]?.status === "succeeded", "manual run records success evidence");
  await h.shot("03-run-history");
});
