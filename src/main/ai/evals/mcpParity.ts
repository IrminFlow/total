// WP 5.8 — MCP parity: the same tool through the MCP server (a real SDK client over an in-memory
// transport, the Server object `total-cli mcp` serves) and straight through the registry must give
// the same result. The registry side is shaped exactly as the server returns it (outboundResult:
// field masking + budget), so any drift in arguments, context (today / period / role) or privacy
// between the two paths shows up as a diff. Kept apart from runner.ts so the runner itself never
// reaches the MCP SDK; only the CLI and the dbtest wire it in.
import { leakedSecrets, type EvalCheck } from '@shared/aiEvalScoring'
import { setAuditContext } from '../../services/audit'
import { setDefaultDraftOrigin } from '../store'
import { EVAL_SECRETS } from './data'
import { fyOf } from '@shared/dates'
import type { Role } from '../../services/roles'
import { companyPseudonymiser } from '../store'
import { createToolRegistry } from '../tools'
import { connectInProcess, createMcpServer, installMcpProcessContext, MCP_DRAFT_REQUEST, outboundResult, type InProcessMcpClient, type McpServerHandle } from '../../mcp/server'
import type { EvalFixture } from './fixture'
import type { McpCase } from './types'

export type McpParity = (c: McpCase, f: EvalFixture) => Promise<EvalCheck[]>

/** A parity runner with one connected client per (role, masking) pair, opened lazily. */
export function createMcpParity(): { run: McpParity; close: () => Promise<void> } {
  const clients = new Map<string, InProcessMcpClient>()
  const handles = new Map<string, McpServerHandle>()
  const registry = createToolRegistry()

  async function client(f: EvalFixture, role: Role, masked: boolean): Promise<InProcessMcpClient> {
    const key = `${role}:${masked}`
    const have = clients.get(key)
    if (have) return have
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
    handles.set(key, handle)
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
    if (c.draft) return draftOverMcp(c.tool, args, f, mcp, handles.get(`${role}:${masked}`)!)
    const viaMcp = await mcp.callTool(c.tool, args)
    const tool = registry.get(c.tool)
    const direct = await registry.run(c.tool, JSON.stringify(args), {
      db: f.db, company: f.company, role, userName: null, threadId: null, messageId: null, today: f.today, period: fyOf(f.today),
      userRequest: tool?.kind === 'draft' ? MCP_DRAFT_REQUEST : undefined
    })
    const privacy = { maskIds: masked, pseudonymiser: null as ReturnType<typeof companyPseudonymiser> | null }
    if (c.refused) {
      const re = c.refused
      return [
        { name: `MCP refuses (${re.source})`, ok: viaMcp.isError && re.test(viaMcp.text), detail: viaMcp.isError && re.test(viaMcp.text) ? undefined : viaMcp.text.slice(0, 200) },
        { name: `registry refuses (${re.source})`, ok: !direct.ok && re.test(direct.error), detail: !direct.ok && re.test(direct.error) ? undefined : direct.ok ? 'the registry ran it' : direct.error }
      ]
    }
    const expected = direct.ok ? outboundResult({ ok: true, result: direct.data }, privacy) : null
    const same = expected !== null && expected === viaMcp.text
    // Masked: the identifiers must be gone from what the client got — a mask that does nothing
    // would still be "equal" on both paths.
    const leaks = masked ? leakedSecrets([viaMcp.text], [...EVAL_SECRETS.gstins, ...EVAL_SECRETS.pans, ...EVAL_SECRETS.accountNumbers, ...EVAL_SECRETS.ifsc]) : []
    return [
      ...(masked ? [{ name: 'MCP result carries no identifier', ok: leaks.length === 0, detail: leaks.length ? `leaked ${leaks.join(', ')}` : undefined }] : []),
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

/** An accountant's draft over MCP: one ai_drafts row with source 'mcp' and origin = the client,
 *  its audit row by `mcp:<client>`, books unchanged (the runner checks). The process context
 *  (`installMcpProcessContext`, as `total-cli mcp` does) is restored afterwards. */
async function draftOverMcp(tool: string, args: Record<string, unknown>, f: EvalFixture, mcp: InProcessMcpClient, handle: McpServerHandle): Promise<EvalCheck[]> {
  const maxDraft = (f.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM ai_drafts').get() as { m: number }).m
  const maxAudit = (f.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM audit_log').get() as { m: number }).m
  installMcpProcessContext(handle, 'evals')
  let r: { isError: boolean; text: string }
  try {
    r = await mcp.callTool(tool, args)
  } finally {
    setAuditContext({ appVersion: '', getUserName: () => null })
    setDefaultDraftOrigin({ source: 'chat', origin: () => null })
  }
  const drafts = f.db.prepare('SELECT id, source, origin, unrequested FROM ai_drafts WHERE id > ?').all(maxDraft) as { id: number; source: string; origin: string | null; unrequested: number }[]
  const audit = f.db.prepare("SELECT user_name AS u FROM audit_log WHERE id > ? AND entity = 'ai_draft'").all(maxAudit) as { u: string | null }[]
  return [
    { name: 'MCP draft call succeeds', ok: !r.isError, detail: r.isError ? r.text.slice(0, 200) : undefined },
    { name: "one draft, source 'mcp', origin = the client, not flagged", ok: drafts.length === 1 && drafts[0]!.source === 'mcp' && drafts[0]!.origin === 'Total evals' && !drafts[0]!.unrequested, detail: JSON.stringify(drafts) },
    { name: 'audited as mcp:<client>', ok: audit.length === 1 && audit[0]!.u === handle.auditUser() && handle.auditUser().startsWith('mcp:'), detail: `${JSON.stringify(audit)} vs ${handle.auditUser()}` }
  ]
}

function firstDifference(a: string, b: string): string {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return `differs at char ${i}: registry …${JSON.stringify(a.slice(Math.max(0, i - 40), i + 60))} vs MCP …${JSON.stringify(b.slice(Math.max(0, i - 40), i + 60))}`
}
