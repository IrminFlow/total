// Scenario 53: contacts/outbox foundation, explicit review and local .eml fallback.
import * as path from "node:path";
import { scenario, assert } from "../lib/harness.mjs";

await scenario("53-communications", async (h) => {
  await h.createDemoCompany();
  await h.goto("communications");

  await h.page.getByText("Preview foundation.", { exact: true }).waitFor();
  await h.page.getByRole("button", { name: "New message" }).click();
  await h.page.getByRole("textbox", { name: /^To / }).fill("accounts@example.com");
  await h.page.getByLabel("Subject").fill("August account statement");
  await h.page.getByRole("textbox", { name: "Message", exact: true }).fill("Please review the attached account statement.");
  await h.click("btn-message-save-draft");
  await h.page.getByText("August account statement", { exact: true }).first().waitFor();
  await h.page.getByRole("button", { name: "Review and approve" }).click();
  await h.page.getByText("Reviewed", { exact: true }).first().waitFor();

  const emlPath = path.join(h.dataDir, "august-statement.eml");
  await h.stubDialogs({ savePath: emlPath });
  await h.page.getByRole("button", { name: "Save .eml…" }).click();
  await h.page.getByText("Saved as .eml", { exact: true }).first().waitFor();
  const result = await h.page.evaluate((destination) => window.total.invoke("communications:messages:list", { limit: 10 }).then((response) => ({ response, destination })), emlPath);
  assert(result.response.ok && result.response.data[0]?.status === "exported", "reviewed draft is recorded as exported after local .eml fallback");
  await h.shot("01-outbox-eml-exported");
});
