// Scenario 45 — privacy inventory, attachment vault, clipboard expiry and signing identity.
import { scenario, assert, assertEq } from "../lib/harness.mjs";

await scenario("45-privacy-centre", async (h) => {
  await h.createDemoCompany();
  await h.goto("settings");
  await h.page.getByRole("button", { name: "Privacy centre", exact: true }).click();
  await h.page.locator('[data-testid="privacy-settings"]').waitFor();
  await h.page
    .getByText("Know exactly what can leave this device.", { exact: true })
    .waitFor();
  await h.shot("01-privacy-centre");

  await h.page.locator('[data-testid="select-clipboard-expiry"]').selectOption("30");
  await h.page.getByText("Clipboard protection updated", { exact: false }).waitFor();
  const copy = await h.invoke("privacy:clipboard:copySensitive", { text: "temporary-secret" });
  assertEq(copy.clearsAfterSeconds, 30, "sensitive clipboard uses the configured expiry");

  const summary = await h.invoke("privacy:summary");
  assert(!summary.attachmentEncryption, "attachment encryption starts as an explicit opt-in");
  assert(!summary.exportSigning.enabled, "export identity starts as an explicit opt-in");
  assertEq(Object.keys(summary.diagnostics).sort().join(","), "arch,platform,version", "diagnostics remain allow-listed");
  await h.shot("02-policy-updated");
});
