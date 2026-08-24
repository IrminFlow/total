import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "crypto";
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

let root: string | null = null;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

function fixture(scopes: string[]): { token: string; company: string } {
  root = mkdtempSync(join(tmpdir(), "total-mcp-contract-"));
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
    join(agent, "meta.json"),
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      files: ["ledgers.json"],
    }),
  );
  writeFileSync(
    join(agent, "ledgers.json"),
    JSON.stringify([{ id: 1, name: "Cash" }]),
  );
  return { token, company };
}

async function connect(
  token: string,
): Promise<{ client: Client; transport: StdioClientTransport }> {
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
        ]),
      );
      const capabilities = await client.callTool({
        name: "get_capabilities",
        arguments: {},
      });
      expect(capabilities.structuredContent).toMatchObject({
        contractVersion: 1,
        capabilities: { contract: "total.mcp", contractVersion: 1 },
      });
      const snapshot = await client.callTool({
        name: "get_book_snapshot",
        arguments: { company, view: "ledgers" },
      });
      expect(snapshot.structuredContent).toMatchObject({
        contractVersion: 1,
        company,
        mirror: { schemaVersion: 1, stale: false },
        data: [{ id: 1, name: "Cash" }],
      });
      const proposal = await client.callTool({
        name: "propose_voucher",
        arguments: {
          company,
          summary: "Review fixture",
          voucher: { voucherTypeId: 1 },
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
});
