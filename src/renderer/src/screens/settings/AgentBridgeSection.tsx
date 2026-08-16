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
                <p className="text-[13px] font-medium">Inbox watcher</p>
                <p className="mt-0.5 text-[12px] text-muted">
                  Watches <span className="num">{companyPath}/inbox</span> and posts valid voucher JSON / masters CSV
                  drops through the same validation as the voucher screen. Files land in{' '}
                  <span className="num">processed/</span> or <span className="num">failed/</span>.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span
                  className={`rounded-full border px-2 py-0.5 text-[11px] ${
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
                <p className="text-[13px] font-medium">CSV/JSON mirror</p>
                <p className="mt-0.5 text-[12px] text-muted">
                  Writes read-only copies of ledgers, items, vouchers and reports to{' '}
                  <span className="num">{companyPath}/agent</span> — integer paise, lossless.
                </p>
              </div>
              <Button data-testid="btn-settings-agent-export" disabled={exporting} onClick={() => void exportMirror()}>
                {exporting ? 'Exporting…' : 'Export mirror now'}
              </Button>
            </div>
            {lastExport && (
              <p className="mt-2 text-[11.5px] text-muted">
                Wrote {lastExport.files.length} files to <span className="num">{lastExport.dir}</span>
              </p>
            )}
          </>
        )}
      </Panel>
      <p className="mt-2 text-[11.5px] text-muted">
        How agents connect: <span className="num">AGENTS.md</span> in <span className="num">~/Documents/total</span>{' '}
        documents the folder layout, the drop-file formats and the <span className="num">total-cli</span> commands —
        point Claude Code or any other agent at it.
      </p>
    </div>
  )
}
