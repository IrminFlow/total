import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/client'
import { useSession, useToasts } from '../../state/stores'
import { Button, Panel, SectionTitle, Skeleton } from '../../components/ui'

/**
 * Agent access (lane A bridge, S2 UI): the on/off switch for the inbox watcher, a manual
 * mirror-export button, and the paths an external agent (Claude Code, Codex, …) needs.
 */
export function AgentBridgeSection(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { user, slug } = useSession()
  const isOwner = user?.role === 'owner'
  const { data: config } = useQuery({ queryKey: ['agentConfig'], queryFn: api.agent.getConfig })
  const [toggling, setToggling] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [lastExport, setLastExport] = useState<{ dir: string; files: string[] } | null>(null)

  // Display path — dataRoot() is ~/Documents/total unless TOTAL_DATA_DIR overrides it
  // (driver/CI scripts only, never a real install).
  const companyPath = `~/Documents/total/${slug ?? '<company>'}`

  const toggle = async (): Promise<void> => {
    if (!config) return
    setToggling(true)
    try {
      const r = await api.agent.setConfig(!config.enabled)
      await queryClient.invalidateQueries({ queryKey: ['agentConfig'] })
      toast.push('success', r.enabled ? 'Agent access enabled — inbox is being watched' : 'Agent access disabled')
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setToggling(false)
    }
  }

  const exportMirror = async (): Promise<void> => {
    setExporting(true)
    try {
      const r = await api.agent.exportMirror()
      setLastExport(r)
      toast.push('success', `Mirror exported — ${r.files.length} files`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div>
      <SectionTitle>Agent access</SectionTitle>
      <McpPanel isOwner={isOwner} />
      <Panel className="p-5">
        {!config ? (
          <div className="flex flex-col gap-2.5" aria-hidden="true">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-detail font-medium">Inbox watcher</p>
                <p className="mt-0.5 text-small text-muted">
                  Watches <span className="num">{companyPath}/inbox</span> and posts valid voucher JSON / masters CSV
                  drops through the same validation as the voucher screen. Files land in{' '}
                  <span className="num">processed/</span> or <span className="num">failed/</span>.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span
                  className={`rounded-full border px-2 py-0.5 text-caption ${
                    config.enabled ? 'border-dr/40 text-dr' : 'border-line text-muted'
                  }`}
                >
                  {config.enabled ? 'On' : 'Off'}
                </span>
                <Button
                  variant={config.enabled ? 'default' : 'primary'}
                  data-testid="btn-settings-agent-toggle"
                  disabled={toggling || !isOwner}
                  disabledTitle={!isOwner ? 'Only owners can change agent access' : undefined}
                  onClick={() => void toggle()}
                >
                  {toggling ? 'Saving…' : config.enabled ? 'Turn off' : 'Turn on'}
                </Button>
              </div>
            </div>

            <div className="mt-5 flex items-center justify-between gap-4 border-t border-line pt-4">
              <div>
                <p className="text-detail font-medium">CSV/JSON mirror</p>
                <p className="mt-0.5 text-small text-muted">
                  Writes read-only copies of ledgers, items, vouchers and reports to{' '}
                  <span className="num">{companyPath}/agent</span> — integer paise, lossless.
                </p>
              </div>
              <Button data-testid="btn-settings-agent-export" disabled={exporting} onClick={() => void exportMirror()}>
                {exporting ? 'Exporting…' : 'Export mirror now'}
              </Button>
            </div>
            {lastExport && (
              <p className="mt-2 text-hint text-muted">
                Wrote {lastExport.files.length} files to <span className="num">{lastExport.dir}</span>
              </p>
            )}
          </>
        )}
      </Panel>
      <p className="mt-2 text-hint text-muted">
        How agents connect: <span className="num">AGENTS.md</span> in <span className="num">~/Documents/total</span>{' '}
        documents the folder layout, the drop-file formats and the <span className="num">total-cli</span> commands —
        point Claude Code or any other agent at it.
      </p>
    </div>
  )
}


/**
 * The MCP server: live, validated access to these books for Claude Desktop, Claude Code or Codex.
 *
 * Sits above the file-drop bridge because it supersedes the read mirror for interactive agents —
 * `<company>/agent/*.json` is a snapshot that goes stale the moment someone posts a voucher. It
 * does not supersede the inbox for bulk writes, which is why both are on this screen.
 */
function McpPanel({ isOwner }: { isOwner: boolean }): React.JSX.Element {
  const toast = useToasts()
  const [client, setClient] = useState<'claude-desktop' | 'claude-code' | 'codex'>('claude-desktop')
  const [allowWrites, setAllowWrites] = useState(false)
  const { data: snippet } = useQuery({
    queryKey: ['mcpSnippet', client, allowWrites],
    queryFn: () => api.mcp.snippet(client, allowWrites),
    enabled: isOwner
  })

  return (
    <Panel className="mb-4 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-detail font-medium">Connect an AI agent (MCP)</p>
          <p className="mt-0.5 text-small text-muted">
            Live, read-only access to these books for Claude Desktop, Claude Code or Codex — no export step, and every
            figure comes from the same reports the app draws.
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          {(['claude-desktop', 'claude-code', 'codex'] as const).map((c) => (
            <button
              key={c}
              onClick={() => setClient(c)}
              className={`rounded-md px-2.5 py-1 text-small ${client === c ? 'bg-amberbar/25 font-medium text-ink' : 'text-muted hover:bg-panel2'}`}
            >
              {c === 'claude-desktop' ? 'Claude Desktop' : c === 'claude-code' ? 'Claude Code' : 'Codex'}
            </button>
          ))}
        </div>
      </div>

      <label className="mt-3 flex items-start gap-2 text-small">
        <input
          type="checkbox"
          checked={allowWrites}
          disabled={!isOwner}
          onChange={() => setAllowWrites((v) => !v)}
          className="mt-0.5"
        />
        <span className="text-muted">
          Let the agent post vouchers. Needs the inbox watcher above switched on as well — two separate switches, so
          revoking either one stops writes immediately. Entries are validated exactly as the voucher screen validates
          them, and audited as <span className="num">agent-mcp</span>.
        </span>
      </label>

      {snippet && (
        <>
          <pre className="num mt-3 max-h-48 overflow-auto rounded-md border border-line bg-panel2 p-3 text-caption leading-relaxed whitespace-pre-wrap">
            {snippet.text}
          </pre>
          <div className="mt-2 flex items-center gap-2">
            <Button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(snippet.text)
                  toast.push('success', 'Copied')
                } catch {
                  toast.push('error', 'Clipboard is blocked — select the text above instead')
                }
              }}
            >
              Copy
            </Button>
            <span className="text-hint text-muted">
              {client === 'claude-desktop'
                ? 'Paste into claude_desktop_config.json, then restart Claude.'
                : client === 'claude-code'
                  ? 'Run this in a terminal.'
                  : 'Paste into ~/.codex/config.toml.'}
            </span>
          </div>
        </>
      )}
    </Panel>
  )
}
