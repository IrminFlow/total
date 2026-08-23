/**
 * The MCP server: Total's books, exposed to Claude Desktop, Claude Code and Codex.
 *
 * This is the interface the "let an agent work with my books" request actually wants. It is
 * strictly better than the file mirror it complements: live queries with no export step, and
 * every write validated by the same code the voucher screen uses.
 *
 * Relationship to the existing agent bridge (services/agentBridge.ts):
 *  - MCP supersedes the READ mirror for interactive agents — `<company>/agent/*.json` is a
 *    snapshot that goes stale the moment someone posts a voucher.
 *  - It does NOT supersede the inbox for bulk writes. A 200-voucher backfill is one atomic file
 *    drop; here it would be 200 round trips.
 * Both stay.
 *
 * Safety:
 *  - Read tools reuse the AI tool set, so an agent and the in-app assistant see the same shapes.
 *  - Writes need BOTH `--allow-writes` on the command line AND agent access switched on in the
 *    app. Two independent switches, one of them visible to the owner in a UI they can revoke.
 *  - Without `--allow-writes` the database is opened read-only at the SQLite level, so a write
 *    is impossible rather than merely absent.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js'
import { toJsonSchema } from '@shared/ai/jsonSchema'
import { fyOf, todayISO } from '@shared/dates'
import { voucherInputSchema } from '@shared/schemas'
import { TOOLS, dispatch, type AiToolCtx } from '../services/ai/tools'
import { getAgentBridgeEnabled } from '../services/config'
import { saveVoucher } from '../services/vouchers'
import { listLedgers } from '../services/masters'
import { runAsAuditUser } from '../services/audit'
import { voucherJsonSchema } from '../cli/schemaDoc'
import type { OpenedCompany } from './companyDb'

const WRITE_TOOL = 'post_voucher'

export function buildServer(company: OpenedCompany): Server {
  const server = new Server(
    { name: 'total-books', version: '1' },
    { capabilities: { tools: {}, resources: {} } }
  )

  const fy = fyOf(todayISO())
  const ctx: AiToolCtx = {
    db: company.db,
    slug: company.slug,
    info: company.info,
    today: todayISO(),
    fyFrom: fy.from,
    fyTo: fy.to
  }

  /** Writes need the command-line flag AND the in-app switch. Checked per call, not at start-up,
   *  so revoking agent access in the app takes effect on the very next request. */
  const writesAllowed = (): boolean => company.writable && getAgentBridgeEnabled(company.db)

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      ...TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: toJsonSchema(t.params)
      })),
      ...(company.writable
        ? [
            {
              name: WRITE_TOOL,
              description:
                'Post one voucher. ALL AMOUNTS ARE INTEGER PAISE and debits must equal credits — the same validation the voucher screen runs. Requires agent access to be switched on in Total (Settings → Agent access).',
              inputSchema: voucherJsonSchema()
            }
          ]
        : [])
    ]
  }))

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const { name, arguments: args } = request.params

    if (name === WRITE_TOOL) {
      if (!writesAllowed()) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: 'Writes are off. Start the server with --allow-writes AND switch on Settings → Agent access in Total.'
            }
          ]
        }
      }
      const input = voucherInputSchema.parse(args)
      // Audited as its own pseudo-user, alongside the existing agent-inbox and agent-cli, so the
      // audit log always says which surface an entry came through.
      const saved = runAsAuditUser('agent-mcp', () => saveVoucher(company.db, input))
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, voucherId: saved.id }) }] }
    }

    return { content: [{ type: 'text' as const, text: JSON.stringify(dispatch(ctx, name, args)) }] }
  })

  // Resources rather than tools for the things an agent wants once per session — pulling the
  // ledger list or the voucher contract into context should not cost a tool call.
  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [
      {
        uri: `total://company/${company.slug}/meta`,
        name: `${company.info.name} — company details`,
        mimeType: 'application/json'
      },
      {
        uri: `total://company/${company.slug}/ledgers`,
        name: `${company.info.name} — ledger list`,
        mimeType: 'application/json'
      },
      {
        uri: 'total://voucher-schema',
        name: 'Voucher input JSON Schema',
        mimeType: 'application/json'
      }
    ]
  }))

  server.setRequestHandler(ReadResourceRequestSchema, (request) => {
    const { uri } = request.params
    const json = (value: unknown): { contents: { uri: string; mimeType: string; text: string }[] } => ({
      contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }]
    })

    if (uri.endsWith('/meta')) {
      return json({
        name: company.info.name,
        stateCode: company.info.stateCode,
        gstRegistrationType: company.info.gstRegistrationType,
        financialYear: { from: fy.from, to: fy.to },
        writable: writesAllowed(),
        units: 'Amounts are integer paise; quantities are integer thousandths.'
      })
    }
    if (uri.endsWith('/ledgers')) {
      return json(listLedgers(company.db).map((l) => ({ id: l.id, name: l.name, groupId: l.groupId })))
    }
    if (uri === 'total://voucher-schema') return json(voucherJsonSchema())
    throw new Error(`Unknown resource: ${uri}`)
  })

  return server
}

export async function serve(company: OpenedCompany): Promise<void> {
  await buildServer(company).connect(new StdioServerTransport())
}
