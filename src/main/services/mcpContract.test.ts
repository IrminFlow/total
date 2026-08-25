import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMcpPresenceBroker, stopMcpPresenceBroker } from "./mcpPresenceBroker";

let root: string | null = null;
afterEach(async () => {
  await stopMcpPresenceBroker();
  delete process.env.TOTAL_DATA_DIR;
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

function fixture(scopes: string[]): { token: string; company: string } {
  root = mkdtempSync(join(tmpdir(), "total-mcp-contract-"));
  process.env.TOTAL_DATA_DIR = root;
  const company = "contract-books";
  const token = "total_mcp_contract_fixture_secret";
  const agent = join(root, "companies", company, "agent");
  mkdirSync(agent, { recursive: true });
  writeFileSync(
    join(root, "total.json"),
    JSON.stringify({
      companies: [
        { slug: company, name: "Contract Books", lastOpenedAt: null },
      ],
    }),
  );
  writeFileSync(
    join(root, "mcp-access.json"),
    JSON.stringify({
      version: 1,
      tokens: [
        {
          id: "fixture",
          name: "Test client",
          company,
          scopes,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          createdAt: new Date().toISOString(),
          createdBy: "Test",
          revokedAt: null,
          tokenHash: createHash("sha256").update(token).digest("hex"),
        },
      ],
    }),
  );
  writeFileSync(
    join(root, "device-safety.json"),
    JSON.stringify({ aiCopilot: false, mcpAccess: true, supportUploads: false, telemetry: false }),
  );
  writeFileSync(
    join(agent, "meta.json"),
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      files: ["ledgers.json", "vouchers-2025-26.json", "trial-balance.json", "outstandings.json"],
    }),
  );
  writeFileSync(
    join(agent, "ledgers.json"),
    JSON.stringify([{ id: 1, name: "Cash", groupName: "Cash-in-Hand", openingBalance: 0 }]),
  );
  writeFileSync(join(agent, "vouchers-2025-26.json"), JSON.stringify([{
    id: 7, date: "2025-08-01", number: "R-1", narration: "Fixture",
    lines: [
      { ledgerId: 1, drCr: "dr", amount: 10000 },
      { ledgerId: 2, drCr: "cr", amount: 10000 },
    ],
  }]));
  writeFileSync(join(agent, "trial-balance.json"), JSON.stringify({
    asOn: "2026-03-31", rows: [], totalDebit: 10000, totalCredit: 10000,
  }));
  writeFileSync(join(agent, "outstandings.json"), JSON.stringify({
    asOn: "2026-03-31",
    receivable: [{ ledgerId: 2, name: "Buyer", pending: 10000, warnings: ["Reference needs review"], bills: [
      { voucherId: 7, pending: 10000, overdueDays: 12 },
    ] }],
    payable: [],
  }));
  writeFileSync(join(root, "companies", company, "company.db"), "authoritative-db-sentinel");
  return { token, company };
}

async function connect(
  token: string,
  presence: { company: string; role: "viewer" | "accountant" | "owner" } | null | false = {
    company: "contract-books", role: "owner",
  },
): Promise<{ client: Client; transport: StdioClientTransport }> {
  if (presence !== false) await startMcpPresenceBroker(() => presence, root!);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "scripts", "total-mcp.mjs")],
    cwd: process.cwd(),
    stderr: "pipe",
    env: {
      ...environment,
      TOTAL_DATA_DIR: root!,
      TOTAL_MCP_TOKEN: token,
      TOTAL_MCP_CLIENT: "Contract test",
    },
  });
  const client = new Client(
    { name: "total-contract-test", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return { client, transport };
}

describe("Total MCP contract v1", () => {
  it("publishes capabilities, freshness and scoped mirror data with stable structured output", async () => {
    const { token, company } = fixture([
      "companies:list",
      "mirror:read",
      "proposal:create",
      "proposal:read",
      "proposal:discard",
      "mirror:refresh",
    ]);
    const { client, transport } = await connect(token);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "get_capabilities",
          "get_mirror_status",
          "get_book_snapshot",
          "request_mirror_refresh",
          "propose_voucher",
          "get_voucher",
          "get_ledger",
          "run_report",
          "list_outstandings",
          "list_exceptions",
          "propose_master_change",
          "validate_proposal",
          "list_proposals",
          "discard_proposal",
        ]),
      );
      const capabilities = await client.callTool({
        name: "get_capabilities",
        arguments: {},
      });
      expect(capabilities.structuredContent).toMatchObject({
        contractVersion: 1,
        capabilities: { contract: "total.mcp", contractVersion: 1, mirrorSchemaVersions: [1, 2] },
      });
      const snapshot = await client.callTool({
        name: "get_book_snapshot",
        arguments: { company, view: "ledgers" },
      });
      expect(snapshot.structuredContent).toMatchObject({
        contractVersion: 1,
        company,
        mirror: { schemaVersion: 1, stale: false },
        data: [expect.objectContaining({ id: 1, name: "Cash" })],
      });
      const proposal = await client.callTool({
        name: "propose_voucher",
        arguments: {
          company,
          summary: "Review fixture",
          voucher: {
            voucherTypeId: 1,
            date: "2025-08-01",
            lines: [
              { ledgerId: 1, drCr: "dr", amount: 10000 },
              { ledgerId: 2, drCr: "cr", amount: 10000 },
            ],
          },
        },
      });
      expect(proposal.structuredContent).toMatchObject({
        accepted: true,
        posted: false,
      });
      expect(
        readFileSync(
          join(root!, "companies", company, "mcp", "audit.jsonl"),
          "utf8",
        ),
      ).toContain('"proposalId"');
    } finally {
      await transport.close();
    }
  }, 15_000);

  it("serves bounded v5 reads, token-owned inert proposals and protected resources without touching books", async () => {
    const { token, company } = fixture([
      "companies:list", "mirror:read", "proposal:create", "proposal:read", "proposal:discard",
    ]);
    const dbPath = join(root!, "companies", company, "company.db");
    const beforeDb = readFileSync(dbPath);
    const { client, transport } = await connect(token);
    try {
      const voucher = await client.callTool({ name: "get_voucher", arguments: { company, id: 7 } });
      expect(voucher.structuredContent).toMatchObject({ voucher: { id: 7, number: "R-1" } });
      const ledger = await client.callTool({ name: "get_ledger", arguments: { company, name: "cash" } });
      expect(ledger.structuredContent).toMatchObject({ ledger: { id: 1, name: "Cash" } });
      const report = await client.callTool({
        name: "run_report", arguments: { company, report: "trial_balance", asOn: "2026-03-31" },
      });
      expect(report.structuredContent).toMatchObject({ snapshot: true, data: { totalDebit: 10000, totalCredit: 10000 } });
      const outstanding = await client.callTool({
        name: "list_outstandings", arguments: { company, side: "receivable", limit: 10 },
      });
      expect(outstanding.structuredContent).toMatchObject({ receivable: [{ ledgerId: 2, pending: 10000 }] });
      const exceptions = await client.callTool({ name: "list_exceptions", arguments: { company, limit: 10 } });
      expect(exceptions.structuredContent).toMatchObject({ exceptions: expect.arrayContaining([
        expect.objectContaining({ kind: "bill_allocation_warning" }),
        expect.objectContaining({ kind: "overdue_bill", voucherId: 7 }),
      ]) });

      const invalid = await client.callTool({
        name: "validate_proposal",
        arguments: { company, kind: "voucher", payload: {
          voucherTypeId: 1, date: "2025-08-01",
          lines: [{ ledgerId: 1, drCr: "dr", amount: 100 }, { ledgerId: 2, drCr: "cr", amount: 90 }],
        } },
      });
      expect(invalid.structuredContent).toMatchObject({ valid: false, posted: false, databaseValidated: false });

      const proposed = await client.callTool({
        name: "propose_master_change",
        arguments: { company, summary: "Create review-only ledger", change: {
          entity: "ledger", operation: "create", values: { name: "Review only", groupId: 1 },
        } },
      });
      const proposalId = (proposed.structuredContent as { proposalId: string }).proposalId;
      expect(proposed.structuredContent).toMatchObject({ accepted: true, posted: false, approvalAvailable: false });
      const foreignId = `2026-08-25T00-00-00-000Z-${randomUUID()}.json`;
      writeFileSync(join(root!, "companies", company, "proposals", foreignId), JSON.stringify({
        version: 1, id: foreignId, createdAt: new Date().toISOString(), source: "mcp",
        tokenId: "different-pairing", status: "pending", proposalKind: "voucher",
        summary: "Must remain isolated", voucher: {},
      }));
      const listed = await client.callTool({ name: "list_proposals", arguments: { company } });
      expect(listed.structuredContent).toMatchObject({ proposals: [expect.objectContaining({
        id: proposalId, proposalKind: "master", posted: false,
      })] });
      const foreignDiscard = await client.callTool({
        name: "discard_proposal", arguments: { company, proposalId: foreignId },
      });
      expect(foreignDiscard).toMatchObject({ isError: true, structuredContent: { error: { code: "INVALID_RESOURCE" } } });
      expect(readFileSync(join(root!, "companies", company, "proposals", foreignId), "utf8")).toContain("different-pairing");
      const discarded = await client.callTool({ name: "discard_proposal", arguments: { company, proposalId } });
      expect(discarded.structuredContent).toMatchObject({ discarded: true, posted: false });

      const resources = await client.listResources();
      expect(resources.resources.map((resource) => resource.uri)).toEqual(expect.arrayContaining([
        "total://company/current", "total://docs/accounting-schema", "total://mirror/manifest",
        "total://reports/definitions", "total://schema/voucher", "total://help/product",
      ]));
      const manifest = await client.readResource({ uri: "total://mirror/manifest" });
      expect(manifest.contents[0]).toMatchObject({ mimeType: "application/json" });
      expect(readFileSync(dbPath)).toEqual(beforeDb);
    } finally {
      await transport.close();
    }
  }, 15_000);

  it("returns a stable SCOPE_DENIED error instead of leaking mirror data", async () => {
    const { token, company } = fixture(["companies:list"]);
    const { client, transport } = await connect(token);
    try {
      const result = await client.callTool({
        name: "get_book_snapshot",
        arguments: { company, view: "ledgers" },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: "SCOPE_DENIED", retryable: false },
      });
    } finally {
      await transport.close();
    }
  }, 15_000);

  it("rejects an otherwise valid existing token when the device kill switch is off", async () => {
    const { token, company } = fixture(["companies:list", "mirror:read"]);
    writeFileSync(
      join(root!, "device-safety.json"),
      JSON.stringify({ aiCopilot: false, mcpAccess: false, supportUploads: false, telemetry: false }),
    );
    const { client, transport } = await connect(token);
    try {
      const result = await client.callTool({
        name: "get_book_snapshot",
        arguments: { company, view: "ledgers" },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: "MCP_DISABLED", retryable: false },
      });
    } finally {
      await transport.close();
    }
  }, 15_000);

  it("fails closed when the desktop app is not running or has no active signed-in company", async () => {
    const { token, company } = fixture(["mirror:read"]);
    let connection = await connect(token, false);
    try {
      const closed = await connection.client.callTool({
        name: "get_book_snapshot", arguments: { company, view: "ledgers" },
      });
      expect(closed.structuredContent).toMatchObject({ error: { code: "APP_UNAVAILABLE", retryable: true } });
    } finally {
      await connection.transport.close();
    }
    await startMcpPresenceBroker(() => null, root!);
    connection = await connect(token, null);
    try {
      const locked = await connection.client.callTool({
        name: "get_book_snapshot", arguments: { company, view: "ledgers" },
      });
      expect(locked.structuredContent).toMatchObject({ error: { code: "APP_SESSION_REQUIRED" } });
    } finally {
      await connection.transport.close();
    }
  }, 15_000);

  it("enforces the active company and current desktop role after token scope checks", async () => {
    const { token, company } = fixture(["mirror:read", "proposal:create"]);
    let connection = await connect(token, { company: "other-books", role: "owner" });
    try {
      const inactive = await connection.client.callTool({
        name: "get_book_snapshot", arguments: { company, view: "ledgers" },
      });
      expect(inactive.structuredContent).toMatchObject({ error: { code: "COMPANY_INACTIVE" } });
    } finally {
      await connection.transport.close();
      await stopMcpPresenceBroker();
    }
    connection = await connect(token, { company, role: "viewer" });
    try {
      const denied = await connection.client.callTool({
        name: "validate_proposal", arguments: { company, kind: "master", payload: {} },
      });
      expect(denied.structuredContent).toMatchObject({ error: { code: "ROLE_DENIED" } });
    } finally {
      await connection.transport.close();
    }
  }, 15_000);
});
