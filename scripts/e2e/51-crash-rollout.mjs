// Scenario 51: redacted local crash envelopes and reversible, device-only UI rollout controls.
import { scenario, assert, assertEq } from "../lib/harness.mjs";

await scenario("51-crash-rollout", async (h) => {
  await h.createDemoCompany();

  const envelope = await h.invoke("crash:record", {
    message: "Failure /Users/private/books/acme.db person@example.com sk-secretVALUE123",
    stack: "Error: private\n    at save (/Users/private/src/save.ts:12:4)",
    screen: "voucher-entry",
  });
  assert(envelope.id.startsWith("CR-"), "crash envelope receives a local case identifier");
  assert(!JSON.stringify(envelope).includes("/Users/private"), "home paths are redacted before persistence");
  assert(!JSON.stringify(envelope).includes("person@example.com"), "email addresses are redacted before persistence");
  assert(!JSON.stringify(envelope).includes("secretVALUE123"), "credential-looking values are redacted before persistence");

  await h.goto("settings");
  await h.page.getByRole("button", { name: "Privacy centre", exact: true }).click();
  const preview = h.page.getByTestId("crash-envelope-preview");
  await preview.waitFor();
  const previewText = await preview.textContent();
  assert(previewText.includes(envelope.id), "privacy centre previews the exact retained envelope");
  assert(!previewText.includes("/Users/private"), "preview contains no private home path");
  await h.shot("01-redacted-crash-envelope");

  await h.page.getByRole("button", { name: "About", exact: true }).click();
  await h.page.getByText("Device rollout controls", { exact: true }).waitFor();
  const guidedHelp = h.page.getByLabel("Guided offline help");
  assert(await guidedHelp.isChecked(), "guided help starts enabled");
  await guidedHelp.uncheck();
  const stored = await h.page.evaluate(() => JSON.parse(localStorage.getItem("total:product-flags:v1") ?? "null"));
  assertEq(stored.flags.guidedHelp, false, "rollout switch is stored only on this device");
  assertEq(stored.history.at(-1).flag, "guidedHelp", "rollout changes retain a bounded local audit history");
  await h.shot("02-device-rollout-controls");

  await h.page.getByTestId("btn-help-centre").click();
  await h.page.getByText("Keyboard shortcuts", { exact: true }).waitFor();
  assert((await h.page.getByText("Voucher entry", { exact: true }).count()) > 0, "disabled guided help falls back to shortcut help");
});
