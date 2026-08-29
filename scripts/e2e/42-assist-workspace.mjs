// Scenario 42 — human-controlled AI workspace, controlled operator, evidence suggestions,
// constrained search and routing.
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scenario, assert } from "../lib/harness.mjs";

const operatorWorkspace = mkdtempSync(join(tmpdir(), "total-e2e-operator-"));
const operatorOutput = join(operatorWorkspace, "review.txt");
const provider = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const input = JSON.parse(body);
  const system = input.messages?.[0]?.content ?? "";
  let content;
  if (system.includes("Convert the user request into one Total voucher draft")) {
    const reference = JSON.parse(system.split("Allowed local references: ")[1]);
    content = JSON.stringify({
      voucherTypeId: reference.voucherTypes[0].id,
      date: "2026-08-28",
      narration: "Operator acceptance proposal",
      lines: [
        { ledgerId: reference.ledgers[0].id, drCr: "dr", amount: 10000 },
        { ledgerId: reference.ledgers[1].id, drCr: "cr", amount: 10000 },
      ],
    });
  } else {
    content = JSON.stringify({
      summary: "Prepare the review file and voucher proposal",
      actions: [
        { kind: "write_file", path: operatorOutput, content: "Reviewed by the operator acceptance test", reason: "Save the reviewed summary" },
        { kind: "draft_voucher", instruction: "Prepare a balanced test journal voucher for review", reason: "Create an accounting proposal" },
      ],
    });
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    id: "chatcmpl-operator-e2e",
    object: "chat.completion",
    created: 0,
    model: "operator-e2e",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
  }));
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
provider.unref();
const providerPort = provider.address().port;

await scenario("42-assist-workspace", async (h) => {
  await h.createDemoCompany();

  // The Gateway mnemonic is intentionally a bare red U, matching the visible card.
  await h.page.keyboard.press("u");
  await h.waitScreen("assist");
  await h.page.getByText("AI assistance", { exact: true }).waitFor();
  assert(
    (await h.page.getByText("No silent postings.", { exact: false }).count()) > 0,
    "Assist states its proposal-only safety contract",
  );

  await h.click("assist-tab-operator");
  await h.page.getByText("AI Operator is off", { exact: true }).waitFor();
  assert(
    (await h.page.getByText("The rest of Total remains fully available without AI.", { exact: false }).count()) > 0,
    "offline users receive an explicit non-AI fallback",
  );

  await h.invoke("device-safety:set", { aiCopilot: true, mcpAccess: false, supportUploads: false, telemetry: false });
  await h.app.evaluate(({ safeStorage }) => {
    safeStorage.isEncryptionAvailable = () => true;
    safeStorage.encryptString = (plain) => Buffer.from(`sealed:${plain}`, "utf8");
    safeStorage.decryptString = (encrypted) => Buffer.from(encrypted).toString("utf8").replace(/^sealed:/, "");
  });
  await h.invoke("ai:setConfig", {
    enabled: true,
    provider: "compatible",
    apiMode: "chat_completions",
    model: "operator-e2e",
    baseUrl: `http://127.0.0.1:${providerPort}/v1`,
    apiKey: "operator-e2e-not-a-real-key",
  });
  await h.invoke("ai:operator:setConfig", {
    enabled: true,
    approvalMode: "every_change",
    workspaceRoots: [operatorWorkspace],
  });
  // Provider/operator configuration is deliberately cached in the renderer. Reloading proves
  // the persisted main-process policy is the source of truth rather than mutating query state.
  await h.page.reload();
  await h.page.waitForFunction(() => Boolean(window.total));
  await h.waitScreen("company-select");
  await h.clickText("Demo Traders");
  await h.waitScreen("assist");
  await h.click("assist-tab-operator");
  await h.fill("operator-prompt", "Prepare the review file and a voucher proposal");
  await h.click("operator-build-plan");
  await h.page.getByText("Prepare the review file and voucher proposal", { exact: true }).waitFor();
  assert((await h.page.locator('[data-testid^="operator-action-"]').count()) === 2, "operator previews every action before execution");

  await h.click("operator-run-0");
  await h.page.getByText(`Approve replacing ${operatorOutput} with the exact content shown`, { exact: true }).waitFor();
  assert(!existsSync(operatorOutput), "every-change mode does not write before approval");
  await h.click("operator-approve-0");
  await h.page.getByText("Wrote 40 bytes", { exact: true }).waitFor();
  assert(readFileSync(operatorOutput, "utf8") === "Reviewed by the operator acceptance test", "approved file action writes the planned content");

  await h.click("operator-run-1");
  await h.page.getByText("Approve sharing ledger and voucher-type names with the configured AI provider to create this proposal", { exact: true }).waitFor();
  assert((await h.invoke("agent:listProposals")).length === 0, "voucher planning does not contact the provider or create a proposal before approval");
  await h.click("operator-approve-1");
  await h.page.getByText("Voucher proposal created for review", { exact: true }).waitFor();
  const proposals = await h.invoke("agent:listProposals");
  assert(proposals.length === 1 && proposals[0].source === "ai", "accounting action hands off one AI proposal without posting");
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
await new Promise((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
