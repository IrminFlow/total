import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { AiDraftDto } from '@shared/ai'
import type { VoucherKind } from '@shared/domain'
import { toDisplayDateTime } from '@shared/dates'
import { api } from '../../lib/client'
import { aiApi } from '../../lib/aiClient'
import { useNav, useSession, useToasts } from '../../state/stores'
import { Badge, Button, Panel, SectionTitle, Skeleton } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'
import { dataFolder, pathSep } from '../../lib/platform'
import { CAPABILITY_REFUSED_TEXT, capabilityRefused } from '../../lib/capabilities'

/**
 * Agent access: a read-only CSV/JSON mirror of the books for external agents and scripts, and
 * whether it refreshes itself after saves. Drafts the removed MCP server / agent inbox proposed
 * (WP 5.7) are listed while any are still open, to review in the voucher editor or discard.
 */

/** Stored UTC ISO → local display date-time. */
const fmtAt = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : toDisplayDateTime(d)
}

const DRAFT_COLUMNS = defineColumns<AiDraftDto>([
  { id: 'at', header: 'Created', kind: 'text', value: (r) => r.createdAt, text: (r) => fmtAt(r.createdAt), className: 'num text-muted', width: 170 },
  {
    id: 'source', header: 'From', kind: 'enum', width: 190,
    options: [{ value: 'mcp', label: 'MCP client' }, { value: 'inbox', label: 'Inbox file' }],
    value: (r) => r.source,
    text: (r) => `${r.source === 'mcp' ? 'MCP' : 'Inbox'}: ${r.origin ?? '?'}`,
    cell: (r) => (
      <span className="flex min-w-0 items-center gap-1.5" title={r.origin ?? undefined}>
        <Badge tone={r.source === 'mcp' ? 'info' : 'neutral'} className="shrink-0">
          {r.source === 'mcp' ? 'MCP' : 'Inbox'}
        </Badge>
        <span className="num min-w-0 truncate">{r.origin ?? '?'}</span>
      </span>
    )
  },
  {
    id: 'summary', header: 'Proposed entry', kind: 'text', value: (r) => r.summary, hideable: false, minWidth: 240,
    text: (r) => (r.unrequested ? `[Not asked for in Total] ${r.summary}` : r.summary),
    cell: (r) => (
      <span className="flex min-w-0 items-center gap-2" title={r.summary}>
        {r.unrequested && (
          <Badge tone="warning" className="shrink-0">
            Not asked for
          </Badge>
        )}
        <span className="truncate">{r.summary}</span>
      </span>
    )
  }
])

function AgentDraftsPanel({ canDiscard }: { canDiscard: boolean }): React.JSX.Element | null {
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: rows = [] } = useQuery({ queryKey: ['agentDrafts'], queryFn: () => api.agent.drafts('open') })
  const review = (d: AiDraftDto): void => nav.go({ name: 'voucher-entry', aiDraftId: d.id, kindHint: d.payload.voucherKind as VoucherKind })
  const discard = async (d: AiDraftDto): Promise<void> => {
    try {
      await aiApi.discardDraft(d.id)
      await queryClient.invalidateQueries({ queryKey: ['agentDrafts'] })
      toast.push('success', `Draft #${d.id} discarded`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const trailing = (d: AiDraftDto): React.JSX.Element => (
        <span className="flex justify-end gap-1.5">
          <Button size="sm" variant="primary" data-testid="btn-agent-draft-review" onClick={() => review(d)}>
            Review
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid="btn-agent-draft-discard"
            disabled={!canDiscard}
            disabledTitle={!canDiscard ? 'Viewers cannot discard drafts' : undefined}
            onClick={() => void discard(d)}
          >
            Discard
          </Button>
        </span>
  )
  if (!rows.length) return null
  return (
    <div className="mt-6">
      <SectionTitle>Drafts from agents</SectionTitle>
      <p className="mb-2 text-body-sm text-muted">
        Entries an agent proposed over MCP or through the inbox folder, before those were removed. None is in the books: open one to check
        it in the voucher editor and save it there, or discard it.
      </p>
      <Panel>
        <DataTable
          viewId="settings-agent-drafts"
          testId="agent-drafts"
          ariaLabel="Drafts from agents"
          columns={DRAFT_COLUMNS}
          rows={rows}
          rowKey={(r) => r.id}
          maxHeight="40vh"
          onRowActivate={review}
          trailing={trailing}
          trailingWidth={170}
          empty={{ title: 'No drafts waiting', hint: 'Every draft from an agent has been saved or discarded' }}
          toolbarFeatures={{ groupBy: false, density: false }}
        />
      </Panel>
    </div>
  )
}

export function AgentBridgeSection(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { user, slug } = useSession()
  // A company without users has no sign-in: main treats everyone as its owner.
  const isOwner = !user || user.role === 'owner'
  const canDiscard = !user || user.role !== 'viewer'
  const { data: config } = useQuery({ queryKey: ['agentConfig'], queryFn: api.agent.getConfig })
  const [toggling, setToggling] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [lastExport, setLastExport] = useState<{ dir: string; files: string[] } | null>(null)

  // Display path — dataRoot() is ~/Documents/total (Documents\total on Windows) unless
  // TOTAL_DATA_DIR overrides it (driver/CI scripts only, never a real install).
  const companyPath = `${dataFolder}${pathSep}${slug ?? '<company>'}`

  const toggle = async (): Promise<void> => {
    if (!config) return
    setToggling(true)
    try {
      const r = await api.agent.setConfig(!config.enabled)
      await queryClient.invalidateQueries({ queryKey: ['agentConfig'] })
      toast.push('success', r.enabled ? 'The mirror now refreshes after each save' : 'The mirror refreshes only when you export it')
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
      <div>
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
                  <p className="text-detail font-medium">CSV/JSON mirror</p>
                  <p className="mt-0.5 text-small text-muted">
                    Writes read-only copies of ledgers, items, vouchers and reports to{' '}
                    <span className="num">{companyPath}/agent</span> — integer paise, lossless — for an agent or a script to read. Nothing
                    an agent does there reaches the books.
                  </p>
                </div>
                <Button
                  data-testid="btn-settings-agent-export"
                  disabled={exporting || capabilityRefused(user, 'canExport')}
                  disabledTitle={capabilityRefused(user, 'canExport') ? CAPABILITY_REFUSED_TEXT.canExport : undefined}
                  onClick={() => void exportMirror()}
                >
                  {exporting ? 'Exporting…' : 'Export mirror now'}
                </Button>
              </div>
              {lastExport && (
                <p className="mt-2 text-hint text-muted">
                  Wrote {lastExport.files.length} files to <span className="num">{lastExport.dir}</span>
                </p>
              )}

              <div className="mt-5 flex items-center justify-between gap-4 border-t border-line pt-4">
                <div>
                  <p className="text-detail font-medium">Refresh after each save</p>
                  <p className="mt-0.5 text-small text-muted">
                    Writes the mirror again shortly after vouchers are saved, so the copies stay current without exporting by hand.
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
            </>
          )}
        </Panel>
        <p className="mt-2 text-hint text-muted">
          <span className="num">AGENTS.md</span> in <span className="num">{dataFolder}</span> documents the mirror files, the folder layout
          and the <span className="num">total-cli</span> commands — point Claude Code or any other agent at it.
        </p>
      </div>
      <AgentDraftsPanel canDiscard={canDiscard} />
    </div>
  )
}
