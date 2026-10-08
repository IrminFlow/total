// MCP server shapes and pure helpers (WP 5.7) — shared by the CLI server (src/main/mcp/), the
// main-process settings channels and Settings → Agent access. No SDK import here: the
// @modelcontextprotocol/sdk package is used only by src/main/mcp/server.ts, bundled into the CLI.
import { z } from 'zod'

export type McpRole = 'viewer' | 'accountant' | 'owner'

export const MCP_SERVER_NAME = 'total'

/** Resource URIs. Everything is computed from the database when it is read — never from files. */
export const MCP_RESOURCES = {
  company: 'total://company',
  chartOfAccounts: 'total://chart-of-accounts',
  /** `total://mirror/<file>` — the same files `total-cli export` writes under <company>/agent/. */
  mirrorPrefix: 'total://mirror/'
} as const

/** Company setting (meta 'mcp'), default off: sessions are refused while `enabled` is false. */
export interface McpConfig {
  enabled: boolean
}

export const mcpConfigSchema = z.object({ enabled: z.boolean() })

/** What Settings → Agent access needs to show the MCP section. */
export interface McpSettingsView {
  config: McpConfig
  /** Source checkout the CLI runs from (development builds); null in a packaged app. */
  repoDir: string | null
  /** The data root when it is not the default ~/Documents/total (scratch dirs in tests). */
  dataDir: string | null
  /** A signed-in role (accountant / owner) then needs --user and TOTAL_MCP_PIN. */
  usersExist: boolean
}

export const MCP_DISABLED_MESSAGE = 'MCP access is off for this company — the owner turns it on in Settings → Agent access → MCP server'

/** One mcp_log row as the Settings log viewer shows it. Never the content — sizes and a hash. */
export interface McpLogRow {
  id: number
  at: string
  sessionId: string
  clientName: string | null
  clientVersion: string | null
  role: McpRole
  userName: string | null
  method: string
  target: string | null
  ok: boolean
  error: string | null
  responseBytes: number
  responseSha256: string | null
  masked: boolean
  pseudonymised: boolean
  draftId: number | null
  durationMs: number
}

/** The audit user for writes made over MCP: `mcp:<client name>`, the name cleaned to a short
 *  token (a client chooses its own name — it must not be able to impersonate a user). */
export function mcpAuditUser(clientName: string | null | undefined): string {
  const clean = (clientName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `mcp:${clean || 'unknown-client'}`
}

/** Shell-quote one argument for the copyable command lines (POSIX sh). */
export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

export interface McpLaunchOptions {
  /** Absolute path of the Total source checkout (the CLI runs from it). */
  repoDir: string
  slug: string
  role: McpRole
  user?: string | null
  /** Data root when it is not ~/Documents/total. */
  dataDir?: string | null
}

/** argv for `node <repo>/scripts/total-cli.mjs mcp …`. */
export function mcpArgs(o: McpLaunchOptions): string[] {
  const args = [`${o.repoDir.replace(/\/+$/, '')}/scripts/total-cli.mjs`, 'mcp', '--company', o.slug]
  if (o.role !== 'viewer') args.push('--role', o.role)
  if (o.user && o.role !== 'viewer') args.push('--user', o.user)
  return args
}

/** Environment the client must pass: the data root override and, for a signed-in role in a
 *  company with users, the PIN (left as a placeholder — the app never shows a PIN). */
export function mcpEnv(o: McpLaunchOptions, needsPin: boolean): Record<string, string> {
  const env: Record<string, string> = {}
  if (o.dataDir) env.TOTAL_DATA_DIR = o.dataDir
  if (needsPin && o.role !== 'viewer') env.TOTAL_MCP_PIN = '<your PIN>'
  return env
}

/** `claude mcp add …` for Claude Code. */
export function claudeCodeCommand(o: McpLaunchOptions, needsPin: boolean): string {
  const env = Object.entries(mcpEnv(o, needsPin)).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  return ['claude', 'mcp', 'add', `total-${o.slug}`, ...env, '--', 'node', ...mcpArgs(o)].map(shellQuote).join(' ')
}

/** The `mcpServers` entry for Claude Desktop's claude_desktop_config.json. */
export function claudeDesktopConfig(o: McpLaunchOptions, needsPin: boolean): string {
  const env = mcpEnv(o, needsPin)
  const server: Record<string, unknown> = { command: 'node', args: mcpArgs(o) }
  if (Object.keys(env).length) server.env = env
  return JSON.stringify({ mcpServers: { [`total-${o.slug}`]: server } }, null, 2)
}

/** Who proposed a draft, for the voucher editor's banner. */
export function aiDraftByLabel(d: { source?: 'chat' | 'mcp' | 'inbox' | 'assistant' | 'capture'; origin?: string | null }): string {
  if (d.source === 'assistant') return `Suggested by ${d.origin ?? 'an assistant'} (Analysis → Assistants)`
  // WP 5.4: a captured bill, or a categorised bank statement line.
  if (d.source === 'capture') return d.origin?.startsWith('Statement line') ? `From the bank statement (${d.origin.toLowerCase()})` : `Read from the captured file ${d.origin ?? ''}`.trim()
  if (d.source === 'mcp') return `Proposed over MCP by ${d.origin ?? 'an MCP client'}`
  if (d.source === 'inbox') return `From ${d.origin ? `the inbox file ${d.origin}` : 'an inbox file'} (not asked for in Total)`
  return 'Drafted by the assistant'
}
