// Scenario 50: transparent plan, privacy-first cohort preview, referrals, partner mode and training.
import { scenario, assert, assertEq } from "../lib/harness.mjs";

await scenario("50-community-learning", async (h) => {
  await h.createDemoCompany();
  await h.goto("settings");
  await h.page.getByRole("button", { name: "Community & learning", exact: true }).click();
  const section = h.page.locator('[data-testid="community-settings"]');
  await section.getByText("₹0 in beta. Perpetual licences after beta.", { exact: true }).waitFor();
  await h.shot("01-plan-and-community");

  await section.getByText("Share this bounded aggregate envelope only when I choose Send.", { exact: true }).click();
  const preview = await section.locator("pre").first().textContent();
  assert(preview.includes('"schema": 1'), "aggregate preview has a versioned schema");
  assert(!preview.toLowerCase().includes("demo traders"), "aggregate preview excludes company name");
  assert(!preview.toLowerCase().includes("voucheramount"), "aggregate preview excludes accounting values");
  const referral = await section.getByText(/^TOTAL-[A-Z0-9]{8}-[A-Z0-9]{2}$/).textContent();
  assert(/^TOTAL-[A-Z0-9]{8}-[A-Z0-9]{2}$/.test(referral), "offline referral code is visible");

  await section.getByRole("button", { name: "Turn on partner mode", exact: true }).click();
  await section.getByText("companies/demo-traders/ · isolated", { exact: true }).waitFor();
  await section.getByText("Double-entry foundations", { exact: true }).click();
  await section.getByText("1/6", { exact: true }).waitFor();
  await section.getByText("Total practitioner pathway", { exact: true }).scrollIntoViewIfNeeded();
  await h.shot("02-partner-training-pathway");

  const before = await h.invoke("company:list");
  await section.getByRole("button", { name: "Create fresh training company", exact: true }).click();
  await h.page.waitForFunction(async (count) => {
    const result = await window.total.invoke("company:list");
    return result.ok && result.data.companies.length === count + 1;
  }, before.companies.length);
  const after = await h.invoke("company:list");
  assertEq(after.companies.length, before.companies.length + 1, "fresh training pack creates an isolated resettable company");
});
