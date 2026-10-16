import { describe, expect, it } from 'vitest'
import { claudeCodeCommand, claudeDesktopConfig, mcpArgs, mcpAuditUser, mcpEnv, shellQuote } from './mcp'

describe('mcpAuditUser', () => {
  it('is mcp:<cleaned client name>, never a bare user name', () => {
    expect(mcpAuditUser('Claude Desktop')).toBe('mcp:claude-desktop')
    expect(mcpAuditUser('claude-code')).toBe('mcp:claude-code')
    expect(mcpAuditUser('  Owner  ')).toBe('mcp:owner')
    expect(mcpAuditUser('x'.repeat(80))).toBe(`mcp:${'x'.repeat(40)}`)
    expect(mcpAuditUser(null)).toBe('mcp:unknown-client')
    expect(mcpAuditUser('!!!')).toBe('mcp:unknown-client')
  })
})

describe('client config snippets', () => {
  const base = { repoDir: '/Users/me/total/', slug: 'demo-traders', role: 'viewer' as const }

  it('viewer: no role flag, no PIN', () => {
    expect(mcpArgs(base)).toEqual(['/Users/me/total/scripts/total-cli.mjs', 'mcp', '--company', 'demo-traders'])
    expect(claudeCodeCommand(base, true)).toBe('claude mcp add total-demo-traders -- node /Users/me/total/scripts/total-cli.mjs mcp --company demo-traders')
    expect(JSON.parse(claudeDesktopConfig(base, true))).toEqual({
      mcpServers: { 'total-demo-traders': { command: 'node', args: ['/Users/me/total/scripts/total-cli.mjs', 'mcp', '--company', 'demo-traders'] } }
    })
  })

  it('WP 7.3: a Windows checkout gets one backslash path (JSON-escaped in the desktop config)', () => {
    const win = { ...base, repoDir: 'C:\\Users\\Asha\\src\\total\\' }
    expect(mcpArgs(win)[0]).toBe('C:\\Users\\Asha\\src\\total\\scripts\\total-cli.mjs')
    expect(JSON.parse(claudeDesktopConfig(win, false)).mcpServers['total-demo-traders'].args[0]).toBe('C:\\Users\\Asha\\src\\total\\scripts\\total-cli.mjs')
    // Single quotes are literal in PowerShell and Git Bash, where `claude mcp add` is run on Windows.
    expect(claudeCodeCommand(win, false)).toBe("claude mcp add total-demo-traders -- node 'C:\\Users\\Asha\\src\\total\\scripts\\total-cli.mjs' mcp --company demo-traders")
  })

  it('accountant with users: --role, --user and a PIN placeholder in the environment', () => {
    const o = { ...base, role: 'accountant' as const, user: 'Asha K', dataDir: '/tmp/scratch dir' }
    expect(claudeCodeCommand(o, true)).toBe(
      "claude mcp add total-demo-traders -e 'TOTAL_DATA_DIR=/tmp/scratch dir' -e 'TOTAL_MCP_PIN=<your PIN>' -- node /Users/me/total/scripts/total-cli.mjs mcp --company demo-traders --role accountant --user 'Asha K'"
    )
    const cfg = JSON.parse(claudeDesktopConfig(o, true)) as { mcpServers: Record<string, { args: string[]; env: Record<string, string> }> }
    expect(cfg.mcpServers['total-demo-traders']!.env).toEqual({ TOTAL_DATA_DIR: '/tmp/scratch dir', TOTAL_MCP_PIN: '<your PIN>' })
    expect(cfg.mcpServers['total-demo-traders']!.args.slice(-4)).toEqual(['--role', 'accountant', '--user', 'Asha K'])
  })

  it('WP 7.2: a business locked with a passphrase gets a TOTAL_PASSPHRASE placeholder — in the environment, never an argument', () => {
    const o = { ...base, locked: true }
    expect(mcpArgs(o).join(' ')).not.toMatch(/passphrase/i)
    expect(claudeCodeCommand(o, false)).toBe(
      "claude mcp add total-demo-traders -e 'TOTAL_PASSPHRASE=<the passphrase of this business>' -- node /Users/me/total/scripts/total-cli.mjs mcp --company demo-traders"
    )
    const cfg = JSON.parse(claudeDesktopConfig(o, false)) as { mcpServers: Record<string, { env: Record<string, string> }> }
    expect(cfg.mcpServers['total-demo-traders']!.env).toEqual({ TOTAL_PASSPHRASE: '<the passphrase of this business>' })
    expect(Object.keys(mcpEnv(base, false))).not.toContain('TOTAL_PASSPHRASE')
  })

  it('shell-quotes what needs it', () => {
    expect(shellQuote('plain-arg')).toBe('plain-arg')
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
  })
})
