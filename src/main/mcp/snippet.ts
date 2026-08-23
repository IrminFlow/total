/**
 * The client configuration a user pastes to connect an agent to their books.
 *
 * Resolving the bundle path at runtime rather than hardcoding it matters: in a packaged app it
 * lives under `app.asar.unpacked` (asar support under ELECTRON_RUN_AS_NODE is not something to
 * bet a feature on, so build.asarUnpack keeps it a real file), and in development it is the
 * checked-out bundle. Getting this wrong produces a "server failed to start" with no explanation.
 */

import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { dataRoot } from '../paths'

export type McpClient = 'claude-desktop' | 'claude-code' | 'codex'

export interface McpSnippet {
  command: string
  args: string[]
  env: Record<string, string>
  resolvedFrom: 'unpacked' | 'asar' | 'dev'
  /** Ready to paste, per client. */
  text: string
}

function bundlePath(): { path: string; resolvedFrom: McpSnippet['resolvedFrom'] } {
  const appPath = app.getAppPath()
  const unpacked = appPath.replace(/app\.asar$/, 'app.asar.unpacked')
  const candidates: [string, McpSnippet['resolvedFrom']][] = [
    [join(unpacked, 'out', 'mcp', 'total-mcp.cjs'), 'unpacked'],
    [join(appPath, 'out', 'mcp', 'total-mcp.cjs'), 'asar']
  ]
  for (const [path, resolvedFrom] of candidates) {
    if (existsSync(path)) return { path, resolvedFrom }
  }
  return { path: join(appPath, 'out', 'mcp', 'total-mcp.cjs'), resolvedFrom: 'dev' }
}

export function mcpSnippet(slug: string, client: McpClient, allowWrites: boolean): McpSnippet {
  const { path, resolvedFrom } = bundlePath()
  const args = [path, '--company', slug, ...(allowWrites ? ['--allow-writes'] : [])]
  const env: Record<string, string> = {
    ELECTRON_RUN_AS_NODE: '1',
    TOTAL_DATA_DIR: dataRoot()
  }
  const name = `total-${slug}`
  const command = process.execPath

  const text =
    client === 'codex'
      ? [
          `[mcp_servers.${name.replace(/-/g, '_')}]`,
          `command = ${JSON.stringify(command)}`,
          `args = ${JSON.stringify(args)}`,
          `env = { ELECTRON_RUN_AS_NODE = "1", TOTAL_DATA_DIR = ${JSON.stringify(env.TOTAL_DATA_DIR)} }`
        ].join('\n')
      : client === 'claude-code'
        ? `claude mcp add ${name} --env ELECTRON_RUN_AS_NODE=1 --env TOTAL_DATA_DIR=${JSON.stringify(env.TOTAL_DATA_DIR)} -- ${JSON.stringify(command)} ${args.map((a) => JSON.stringify(a)).join(' ')}`
        : JSON.stringify({ mcpServers: { [name]: { command, args, env } } }, null, 2)

  return { command, args, env, resolvedFrom, text }
}
