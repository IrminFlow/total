// WP 5.8 — MCP parity: the same tool through the MCP server (a real SDK client over an in-memory
// transport, the Server object `total-cli mcp` serves) and straight through the registry must give
// the same result. The registry side is shaped exactly as the server returns it (outboundResult:
// field masking + budget), so any drift in arguments, context (today / period / role) or privacy
// between the two paths shows up as a diff. Kept apart from runner.ts so the runner itself never
// reaches the MCP SDK; only the CLI and the dbtest wire it in.
import type { EvalCheck } from '@shared/aiEvalScoring'
import { fyOf } from '@shared/dates'
import { setMcpConfig } from '../../services/config'
import type { Role } from '../../services/roles'
import { companyPseudonymiser } from '../store'
import { createToolRegistry } from '../tools'
import { connectInProcess, createMcpServer, MCP_DRAFT_REQUEST, outboundResult, type InProcessMcpClient } from '../../mcp/server'
import type { EvalFixture } from './fixture'
import type { McpCase } from './types'

export type McpParity = (c: McpCase, f: EvalFixture) => Promise<EvalCheck[]>

/** A parity runner with one connected client per (role, masking) pair, opened lazily. */
export function createMcpParity(): { run: McpParity; close: () => Promise<void> } {
  const clients = new Map<string, InProcessMcpClient>()
  const registry = createToolRegistry()

  async function client(f: EvalFixture, role: Role, masked: boolean): Promise<InProcessMcpClient> {
    const key = `${role}:${masked}`
    const have = clients.get(key)
    if (have) return have
    setMcpConfig(f.db, { enabled: true })
    const handle = createMcpServer({
      db: f.db,
      slug: 'eval-traders',
      identity: { role, userName: null, userId: null },
      privacy: { maskIds: masked, pseudonymiseParties: false },
      version: 'evals',
      registry,
      today: () => f.today
    })
    const c = await connectInProcess(handle, 'Total evals')
    clients.set(key, c)
    return c
  }

  const run: McpParity = async (c, f) => {
    const role = c.role ?? 'viewer'
    const masked = !!c.masked
    const mcp = await client(f, role, masked)
    if (c.tool === 'tools/list') {
      const listed = (await mcp.listTools()).sort()
      const want = registry
        .available(role)
        .filter((t) => t.kind === 'read' || t.kind === 'draft')
        .map((t) => t.name)
        .sort()
      return [{ name: 'tools/list = registry.available(role)', ok: JSON.stringify(listed) === JSON.stringify(want), detail: JSON.stringify(listed) === JSON.stringify(want) ? undefined : `MCP ${listed.join(', ')} vs registry ${want.join(', ')}` }]
    }
    const args = c.args(f)
    const viaMcp = await mcp.callTool(c.tool, args)
    const tool = registry.get(c.tool)
    const direct = await registry.run(c.tool, JSON.stringify(args), {
      db: f.db, company: f.company, role, userName: null, threadId: null, messageId: null, today: f.today, period: fyOf(f.today),
      userRequest: tool?.kind === 'draft' ? MCP_DRAFT_REQUEST : undefined
    })
    const privacy = { maskIds: masked, pseudonymiser: null as ReturnType<typeof companyPseudonymiser> | null }
    if (c.refused) {
      return [
        { name: 'MCP refuses', ok: viaMcp.isError, detail: viaMcp.isError ? undefined : viaMcp.text.slice(0, 200) },
        { name: 'registry refuses', ok: !direct.ok, detail: direct.ok ? 'the registry ran it' : undefined }
      ]
    }
    const expected = direct.ok ? outboundResult({ ok: true, result: direct.data }, privacy) : null
    const same = expected !== null && expected === viaMcp.text
    return [
      { name: 'registry call succeeds', ok: direct.ok, detail: direct.ok ? undefined : direct.error },
      { name: 'MCP call succeeds', ok: !viaMcp.isError, detail: viaMcp.isError ? viaMcp.text.slice(0, 200) : undefined },
      { name: 'MCP result = registry result', ok: same, detail: same ? undefined : firstDifference(expected ?? '', viaMcp.text) }
    ]
  }

  return {
    run,
    close: async () => {
      for (const c of clients.values()) await c.close()
      clients.clear()
    }
  }
}

function firstDifference(a: string, b: string): string {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return `differs at char ${i}: registry …${JSON.stringify(a.slice(Math.max(0, i - 40), i + 60))} vs MCP …${JSON.stringify(b.slice(Math.max(0, i - 40), i + 60))}`
}
