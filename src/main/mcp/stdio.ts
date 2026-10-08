// `total-cli mcp` over stdio (WP 5.7). stdout carries ONLY the protocol; every human message goes
// to stderr. Refuses to start when the company's kill switch is on or the identity check fails.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { DB } from '../db/connection'
import { MCP_DISABLED_MESSAGE } from '@shared/mcp'
import { getMcpConfig } from '../services/config'
import { runAsAuditUser } from '../services/audit'
import { createMcpServer, installMcpProcessContext } from './server'
import { resolveMcpIdentity, type McpSessionRequest } from './session'

export interface McpStdioOptions extends McpSessionRequest {
  db: DB
  slug: string
  maskIds: boolean
  pseudonymiseParties: boolean
  version: string
}

/** Start the server; resolves when the client disconnects (stdin closes). */
export async function runMcpStdio(o: McpStdioOptions): Promise<void> {
  if (!getMcpConfig(o.db).enabled) throw new Error(MCP_DISABLED_MESSAGE)
  // A failed PIN is audited like the lock screen's; the attempt is attributed to the MCP launcher.
  const identity = runAsAuditUser('mcp:startup', () => resolveMcpIdentity(o.db, o))
  const handle = createMcpServer({
    db: o.db,
    slug: o.slug,
    identity,
    privacy: { maskIds: o.maskIds, pseudonymiseParties: o.pseudonymiseParties },
    version: o.version
  })
  installMcpProcessContext(handle, o.version)
  const transport = new StdioServerTransport()
  const closed = new Promise<void>((resolve) => {
    handle.server.onclose = () => resolve()
    process.stdin.on('end', () => resolve())
  })
  await handle.server.connect(transport)
  process.stderr.write(
    `Total MCP server: company ${o.slug}, role ${identity.role}${identity.userName ? ` (${identity.userName})` : ''}, ` +
      `masking ${o.maskIds ? 'on' : 'OFF'}, party pseudonyms ${o.pseudonymiseParties ? 'on' : 'off'} — read and draft tools only, nothing posts.\n`
  )
  await closed
  await handle.server.close().catch(() => undefined)
}
