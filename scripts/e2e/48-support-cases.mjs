// Scenario 48: explicit support consent, local case history and encrypted offline bundles.
import * as fs from "node:fs";
import * as path from "node:path";
import { createDecipheriv, scryptSync } from "node:crypto";
import { scenario, assert, assertEq } from "../lib/harness.mjs";

function decryptBundle(file, passphrase) {
  const encrypted = fs.readFileSync(file);
  assertEq(encrypted.subarray(0, 8).toString("utf8"), "TOTALBK1", "bundle encryption header");
  const salt = encrypted.subarray(8, 24);
  const iv = encrypted.subarray(24, 36);
  const tag = encrypted.subarray(encrypted.length - 16);
  const ciphertext = encrypted.subarray(36, encrypted.length - 16);
  const key = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

await scenario("48-support-cases", async (h) => {
  await h.createDemoCompany();
  await h.click("link-support");
  const modal = h.page.getByRole("dialog");
  await modal.getByLabel("How can we help?").fill("The register filter needs help.");
  await modal.getByText("Send this message.", { exact: false }).click();
  await modal
    .getByText("Include up to 50 recent event names", { exact: false })
    .click();
  await h.page.locator('[data-testid="support-context-preview"]').waitFor();
  await h.shot("01-exact-consent-preview");

  await modal.getByText("Close", { exact: true }).click();

  const consent = {
    message: true,
    diagnostics: true,
    logs: false,
    companyMetadata: false,
    focusContext: false,
    screenshot: false,
  };
  const supportCase = await h.invoke("support:case:create", {
    category: "bug",
    consent,
  });
  assert(/^TOT-\d{8}-[A-F0-9]{12}$/.test(supportCase.id), "high-entropy trackable case ID is generated");

  const encryptedPath = path.join(h.dataDir, "offline-support.zip.enc");
  await h.stubDialogs({ savePath: encryptedPath });
  const passphrase = "Support Bundle Passphrase 48";
  const saved = await h.invoke("support:bundleOffline", {
    caseId: supportCase.id,
    category: "bug",
    email: "",
    message: "The register filter needs help.",
    includeMessage: true,
    includeDiagnostics: true,
    includeLogs: false,
    includeCompanyMetadata: false,
    focusContext: null,
    screenshotDataUrl: null,
    passphrase,
  });
  assertEq(saved.status, "saved_offline", "offline case status");
  assert(fs.existsSync(encryptedPath), "encrypted bundle is written");
  const zip = decryptBundle(encryptedPath, passphrase);
  assertEq(zip.readUInt32LE(0), 0x04034b50, "decrypted payload is a ZIP");
  assert(zip.includes(Buffer.from("case.json")), "case metadata is included");
  assert(zip.includes(Buffer.from("message.txt")), "consented message is included");
  assert(zip.includes(Buffer.from("diagnostics.json")), "consented diagnostics are included");
  assert(!zip.includes(Buffer.from("logs.json")), "unselected logs are excluded");
  assert(!zip.includes(Buffer.from("company.json")), "unselected company metadata is excluded");

  await h.click("link-support");
  const caseId = modal.getByText(supportCase.id, { exact: true });
  await caseId.waitFor();
  await modal.getByText("Saved offline · bug", { exact: true }).waitFor();
  await caseId.scrollIntoViewIfNeeded();
  await h.shot("02-local-case-history");
});
