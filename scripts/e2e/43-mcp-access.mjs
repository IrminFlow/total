// Scenario 43 — scoped MCP token issue/revoke UX, one-time secret and mirror freshness.
import { scenario, assert, assertEq } from "../lib/harness.mjs";

await scenario("43-mcp-access", async (h) => {
  await h.createDemoCompany();
  await h.goto("settings");
  await h.page.getByRole("button", { name: "Agent access", exact: true }).click();
  await h.page.locator('[data-testid="agent-access-settings"]').waitFor();
  await h.page.getByText("Useful access, narrow authority.", { exact: true }).waitFor();
  await h.shot("01-agent-access");

  await h.click("btn-settings-agent-export");
  await h.page.getByText("Current", { exact: true }).waitFor();
  const status = await h.invoke("mcp:mirror:status");
  assertEq(status.schemaVersion, 1, "mirror status exposes schema version");
  assert(!status.stale, "new mirror is reported current");

  await h.click("btn-mcp-issue");
  await h.fill("input-mcp-token-name", "Claude Desktop · Review Mac");
  await h.page.getByText("Create review-only proposals", { exact: true }).click();
  await h.click("btn-mcp-token-create");
  const revealed = h.page.locator('[data-testid="mcp-revealed-token"]');
  await revealed.waitFor();
  assert((await revealed.innerText()).startsWith("total_mcp_"), "plaintext token is shown once");
  await h.shot("02-one-time-token");
  await h.page.getByRole("button", { name: "Done", exact: true }).click();

  const tokens = await h.invoke("mcp:tokens:list");
  assertEq(tokens.length, 1, "one scoped token is persisted");
  assert(!("tokenHash" in tokens[0]), "token hash is not exposed to the renderer");
  await h.page.getByText("Claude Desktop · Review Mac", { exact: true }).waitFor();
  await h.shot("03-active-token");
  await h.page.getByRole("button", { name: "Revoke", exact: true }).click();
  await h.page.getByText("Revoked", { exact: true }).waitFor();
  assert((await h.invoke("mcp:tokens:list"))[0].revokedAt, "revocation is durable");
});
