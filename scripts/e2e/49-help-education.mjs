// Scenario 49: contextual/offline help, guided troubleshooting, release notes and dismissible discovery.
import { scenario, assert, assertEq } from "../lib/harness.mjs";

await scenario("49-help-education", async (h) => {
  await h.createDemoCompany();
  await h.click("btn-help-centre");
  const help = h.page.getByRole("dialog");
  await help.getByText("Help that matches the work in front of you", { exact: true }).waitFor();
  await help.getByText("Work from the keyboard", { exact: true }).waitFor();

  await h.click("help-tab-search");
  await help.getByPlaceholder(/quarterly register/).fill("quarterly purchase register");
  await help.getByText("Monthly and quarterly registers", { exact: true }).first().waitFor();
  await h.shot("01-offline-help-search");

  await h.click("help-tab-troubleshoot");
  await h.stubDialogs();
  await help.getByRole("button", { name: "Run five checks", exact: true }).click();
  await help.getByText("Database and native module · Ready", { exact: true }).waitFor();
  const checkRows = await help.locator("text=/Ready|Needs attention|Optional/").count();
  assert(checkRows >= 5, "guided troubleshooter returns all five bounded checks");
  await h.shot("02-guided-troubleshooting");

  await h.click("help-tab-release");
  await help.getByText("A calmer, faster accounting workspace", { exact: true }).waitFor();
  await help.getByTestId("modal-close").click();

  // A tip appears only after related repeat use, then the permanent opt-out is respected.
  await h.goto("registers");
  await h.goto("gateway");
  await h.goto("registers");
  const discovery = h.page.locator('[data-testid="feature-discovery"]');
  await discovery.getByText("See the same register by quarter", { exact: true }).waitFor();
  await h.shot("03-related-feature-tip");
  await discovery.getByText("Never show this tip", { exact: true }).click();
  await h.goto("gateway");
  await h.goto("registers");
  assertEq(await discovery.count(), 0, "never-show preference suppresses the tip");

  // Existing users see a new version once. First installs were marked current above.
  await h.page.evaluate(() => localStorage.setItem("total:release-notes:last-seen", "0.4.9"));
  await h.page.reload();
  const releaseHeading = h.page
    .getByRole("dialog")
    .getByText("A calmer, faster accounting workspace", { exact: true });
  // An active company restores asynchronously. Do not mistake the brief company-select
  // bootstrap frame for a signed-out state and try to open the company a second time.
  const restored = await releaseHeading.waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
  if (!restored) {
    await h.page.waitForSelector('[data-screen="company-select"]');
    // Opening a remembered company restores the last screen (Registers here), not
    // necessarily Gateway, so wait on the release dialog instead of a screen name.
    await h.clickText("Demo Traders");
  }
  await releaseHeading.waitFor();
  await h.shot("04-upgrade-release-notes");
});
