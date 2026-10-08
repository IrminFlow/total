import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { AiDraftDto } from '@shared/ai'
import type { VoucherKind } from '@shared/domain'
import { claudeCodeCommand, claudeDesktopConfig, type McpLogRow, type McpRole } from '@shared/mcp'
import { toDisplayDateTime } from '@shared/dates'
import { api } from '../../lib/client'
import { aiApi } from '../../lib/aiClient'
import { useNav, useSession, useToasts } from '../../state/stores'
import { Badge, Button, Panel, SectionTitle, Segmented, Skeleton } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'

/**
 * Agent access: how external agents (Claude Code, Claude Desktop, Codex, …) reach the books.
 * - MCP server (WP 5.7): how to start `total-cli mcp`, copyable client config, the kill switch
 *   and the request log. Read and draft tools only — nothing an agent does posts to the books.
 * - Drafts from agents: what MCP clients and inbox drops proposed, to review in the voucher
 *   editor (the review rule) or discard.
 * - The inbox watcher (drops become drafts) and the read-only CSV/JSON mirror.
 */

/** Stored UTC ISO → local display date-time. */
const fmtAt = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : toDisplayDateTime(d)
}

const LOG_COLUMNS = defineColumns<McpLogRow>([
  { id: 'at', header: 'When', kind: 'text', value: (r) => r.at, text: (r) => fmtAt(r.at), className: 'num text-muted', width: 170, hideable: false },
  { id: 'client', header: 'Client', kind: 'text', value: (r) => r.clientName ?? '', width: 130 },
  { id: 'method', header: 'Request', kind: 'text', value: (r) => r.method, className: 'num', width: 150 },
  { id: 'target', header: 'Tool / resource', kind: 'text', value: (r) => r.target ?? '', className: 'num', minWidth: 150 },
  {
    id: 'ok', header: 'Result', kind: 'text', value: (r) => (r.ok ? 'ok' : (r.error ?? 'refused')), minWidth: 110,
    cell: (r) => (r.ok ? <span className="text-muted">ok</span> : <span className="text-danger">{r.error ?? 'refused'}</span>)
  },
  { id: 'role', header: 'Role', kind: 'text', value: (r) => (r.userName ? `${r.role} (${r.userName})` : r.role), width: 120 },
  {
    id: 'privacy', header: 'Privacy', kind: 'text', width: 190,
    value: (r) => [r.masked ? 'IDs masked' : 'IDs in clear', r.pseudonymised ? 'parties aliased' : 'names in clear'].join(' · ')
  },
  { id: 'bytes', header: 'Size (bytes)', kind: 'number', value: (r) => r.responseBytes, text: (r) => r.responseBytes.toLocaleString('en-IN'), width: 110 },
  { id: 'draft', header: 'Draft', kind: 'number', value: (r) => r.draftId, text: (r) => (r.draftId ? `#${r.draftId}` : ''), width: 80 },
  { id: 'hash', header: 'Response SHA-256', kind: 'text', value: (r) => r.responseSha256 ?? '', text: (r) => (r.responseSha256 ? `${r.responseSha256.slice(0, 16)}…` : ''), className: 'num text-muted', defaultHidden: true, width: 160 },
  { id: 'session', header: 'Session', kind: 'text', value: (r) => r.sessionId, text: (r) => r.sessionId.slice(0, 8), className: 'num text-muted', defaultHidden: true, width: 100 }
])

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

function CopyBlock({ label, text, testId, wrap = false }: { label: string; text: string; testId: string; wrap?: boolean }): React.JSX.Element {
  const toast = useToasts()
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      toast.push('success', `${label} copied`)
    } catch {
      toast.push('error', 'Could not copy — select the text instead')
    }
  }
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-small font-medium text-ink">{label}</p>
        <Button size="sm" variant="ghost" data-testid={`btn-copy-${testId}`} onClick={() => void copy()}>
          Copy
        </Button>
      </div>
      <pre
        data-testid={`mcp-snippet-${testId}`}
        className={'num mt-1 max-h-56 overflow-auto rounded-md border border-line bg-panel2 px-3 py-2 text-caption text-ink select-all ' + (wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre')}
      >
        {text}
      </pre>
    </div>
  )
}

function McpPanel({ isOwner, slug }: { isOwner: boolean; slug: string }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: view } = useQuery({ queryKey: ['agentMcp'], queryFn: api.agent.mcp })
  const [role, setRole] = useState<McpRole>('viewer')
  const [saving, setSaving] = useState(false)

  const toggle = async (): Promise<void> => {
    if (!view) return
    setSaving(true)
    try {
      const r = await api.agent.setMcp(!view.config.enabled)
      await queryClient.invalidateQueries({ queryKey: ['agentMcp'] })
      toast.push('success', r.enabled ? 'MCP server turned on for this company' : 'MCP server turned off — sessions are refused')
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (!view) {
    return (
      <Panel className="p-5">
        <div className="flex flex-col gap-2.5" aria-hidden="true">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-full" />
        </div>
      </Panel>
    )
  }
  const enabled = view.config.enabled
  const opts = { repoDir: view.repoDir ?? '/path/to/total', slug, role, user: role !== 'viewer' && view.usersExist ? '<your user name>' : null, dataDir: view.dataDir }
  const needsPin = view.usersExist && role !== 'viewer'

  return (
    <Panel className="p-5" testId="settings-mcp">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-detail font-medium">MCP server</p>
          <p className="mt-0.5 text-small text-muted">
            Lets an AI client on this computer read these books and propose entries through the same tools as the in-app assistant. It only
            reads and drafts — nothing it does posts to the books; you review every draft below and save it yourself.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span
            data-testid="mcp-status"
            className={`rounded-full border px-2 py-0.5 text-caption ${enabled ? 'border-dr/40 text-dr' : 'border-line text-muted'}`}
          >
            {enabled ? 'On' : 'Off'}
          </span>
          <Button
            variant={enabled ? 'default' : 'primary'}
            data-testid="btn-settings-mcp-toggle"
            disabled={saving || !isOwner}
            disabledTitle={!isOwner ? 'Only owners can change agent access' : undefined}
            onClick={() => void toggle()}
          >
            {saving ? 'Saving…' : enabled ? 'Turn off' : 'Turn on'}
          </Button>
        </div>
      </div>
      {!enabled && (
        <p className="mt-2 text-small text-muted" data-testid="mcp-killed">
          Off (the default): the server refuses to start for this company and a running session gets every request refused. The snippets below
          work once an owner turns it on.
        </p>
      )}

      <div className="mt-4 border-t border-line pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-small text-muted">
            Start it from a terminal (it talks over stdin/stdout) or let your client start it with the snippets below.
          </p>
          <Segmented
            label="Role for the snippets"
            size="sm"
            value={role}
            onChange={setRole}
            testId="mcp-role"
            options={[
              { value: 'viewer', label: 'Viewer (read)' },
              { value: 'accountant', label: 'Accountant (drafts)' }
            ]}
          />
        </div>
        <ul className="mt-2 list-disc pl-5 text-small text-muted">
          <li>
            Role <span className="num">viewer</span> (default) gets read tools and resources only. <span className="num">--role accountant</span>{' '}
            adds the draft tools{view.usersExist ? ' and needs --user plus the PIN in TOTAL_MCP_PIN' : ''}.
          </li>
          <li>
            GSTIN, PAN and bank numbers are masked in everything returned unless you add <span className="num">--no-mask</span>;{' '}
            <span className="num">--pseudonymise</span> replaces party names with aliases.
          </li>
          {!view.repoDir && <li>The CLI runs from a Total source checkout — replace /path/to/total with where it lives.</li>}
        </ul>
        {needsPin && (
          <p className="mt-3 rounded-md border border-warning/50 bg-warning-soft px-3 py-2 text-small text-ink" data-testid="mcp-pin-warning">
            The PIN goes into the client’s configuration as TOTAL_MCP_PIN, in plain text — anyone who can read that file can draft as this user.
            Changing the user’s PIN ends any running MCP session.
          </p>
        )}
        <CopyBlock label="Claude Code" text={claudeCodeCommand(opts, needsPin)} testId="claude-code" wrap />
        <CopyBlock label="Claude Desktop (claude_desktop_config.json)" text={claudeDesktopConfig(opts, needsPin)} testId="claude-desktop" />
      </div>
    </Panel>
  )
}

function McpLogPanel(): React.JSX.Element {
  const { data: rows = [], isLoading } = useQuery({ queryKey: ['agentMcpLog'], queryFn: api.agent.mcpLog })
  return (
    <div className="mt-6">
      <SectionTitle>MCP request log</SectionTitle>
      <p className="mb-2 text-body-sm text-muted">
        One row per request an MCP client made: the tool or resource, the role and privacy options in force, the result, its size and a SHA-256
        fingerprint of exactly what was returned. The content itself is not kept.
      </p>
      <Panel>
        <DataTable
          viewId="settings-mcp-log"
          testId="mcp-log"
          ariaLabel="MCP request log"
          columns={LOG_COLUMNS}
          rows={rows}
          rowKey={(r) => r.id}
          loading={isLoading}
          maxHeight="40vh"
          empty={{ title: 'No MCP requests yet', hint: 'Requests appear here once a client connects' }}
          toolbarFeatures={{ groupBy: false, density: false }}
        />
      </Panel>
    </div>
  )
}

function AgentDraftsPanel({ canDiscard }: { canDiscard: boolean }): React.JSX.Element {
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: rows = [], isLoading } = useQuery({ queryKey: ['agentDrafts'], queryFn: () => api.agent.drafts('open') })
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
  return (
    <div className="mt-6">
      <SectionTitle>Drafts from agents</SectionTitle>
      <p className="mb-2 text-body-sm text-muted">
        Entries proposed over MCP or dropped in the inbox. None is in the books: open one to check it in the voucher editor and save it there,
        or discard it. Inbox drops are always marked “Not asked for” — nobody asked for them inside Total.
      </p>
      <Panel>
        <DataTable
          viewId="settings-agent-drafts"
          testId="agent-drafts"
          ariaLabel="Drafts from agents"
          columns={DRAFT_COLUMNS}
          rows={rows}
          rowKey={(r) => r.id}
          loading={isLoading}
          maxHeight="40vh"
          onRowActivate={review}
          trailing={trailing}
          trailingWidth={170}
          empty={{ title: 'No drafts waiting', hint: 'Drafts from MCP clients and inbox drops appear here' }}
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

  // Display path — dataRoot() is ~/Documents/total unless TOTAL_DATA_DIR overrides it
  // (driver/CI scripts only, never a real install).
  const companyPath = `~/Documents/total/${slug ?? '<company>'}`

  const toggle = async (): Promise<void> => {
    if (!config) return
    setToggling(true)
    try {
      const r = await api.agent.setConfig(!config.enabled)
      await queryClient.invalidateQueries({ queryKey: ['agentConfig'] })
      toast.push('success', r.enabled ? 'Inbox watcher on — drops become drafts for review' : 'Inbox watcher off')
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
      <McpPanel isOwner={isOwner} slug={slug ?? '<company>'} />
      <AgentDraftsPanel canDiscard={canDiscard} />
      <McpLogPanel />

      <div className="mt-6">
        <SectionTitle>Inbox and mirror</SectionTitle>
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
                    Watches <span className="num">{companyPath}/inbox</span> and turns valid voucher JSON drops into drafts for review (listed
                    above) — nothing is posted. Files land in <span className="num">processed/</span> or <span className="num">failed/</span>;
                    masters CSVs go through Data import instead.
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
                    <span className="num">{companyPath}/agent</span> — integer paise, lossless. MCP clients read the same files as resources,
                    computed fresh.
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
          <span className="num">AGENTS.md</span> in <span className="num">~/Documents/total</span> documents the MCP server, its tools and
          resources, the folder layout and the <span className="num">total-cli</span> commands — point Claude Code or any other agent at it.
        </p>
      </div>
    </div>
  )
}
