// Scenario 42 — human-controlled AI workspace, evidence suggestions, constrained search and routing.
import { scenario, assert } from "../lib/harness.mjs";

await scenario("42-assist-workspace", async (h) => {
  await h.createDemoCompany();

  // The Gateway mnemonic is intentionally a bare red U, matching the visible card.
  await h.page.keyboard.press("u");
  await h.waitScreen("assist");
  await h.page.getByText("Human-controlled intelligence", { exact: true }).waitFor();
  assert(
    (await h.page.getByText("No silent postings.", { exact: false }).count()) > 0,
    "Assist states its proposal-only safety contract",
  );
  await h.shot("01-document-inbox");

  await h.click("assist-tab-ledgers");
  await h.fill("assist-ledger-query", "Sales");
  await h.page.waitForFunction(() => document.body.innerText.includes("prior uses in"));
  assert(
    (await h.page.locator("ul li").filter({ hasText: "prior uses in" }).count()) > 0,
    "ledger suggestion shows ranking evidence",
  );
  await h.shot("02-evidence-ledgers");

  await h.click("assist-tab-search");
  await h.fill("assist-search-input", "Cash");
  await h.page.getByText("total://ledger/", { exact: false }).first().waitFor();
  assert(
    (await h.page.getByText("cannot generate or execute", { exact: false }).count()) > 0,
    "search explains its constrained boundary",
  );
  await h.shot("03-constrained-search");

  await h.click("assist-tab-writing");
  await h.click("assist-generate-writing");
  await h.page.waitForFunction(
    () => (document.querySelector('[data-testid="assist-writing-draft"]')?.value ?? "").length > 20,
  );
  assert(
    await h.page.locator('[data-testid="assist-writing-draft"]').isEditable(),
    "generated writing stays editable",
  );
  await h.shot("04-editable-writing");

  await h.click("assist-tab-routing");
  await h.page.locator('[data-testid="assist-route-ocr"]').waitFor();
  assert(
    (await h.page.locator('[data-testid^="assist-route-"]').count()) === 4,
    "all four task routes are visible",
  );
  await h.shot("05-task-routing");
});
