// The minimal chat panel (WP 5.1) — enough to drive the agent platform end to end; the full chat
// experience is WP 5.2. A right Drawer (kit) with the conversation list, the message stream with
// tool-call chips (expand for input / output / source links), Stop, cost per answer and a
// "Review draft" button that opens an AI draft in the real voucher editor.
import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { create } from 'zustand'
import { formatMicroUsd, type AiDraftDto, type AiEvent, type AiMessageDto, type AiSource } from '@shared/ai'
import type { VoucherKind } from '@shared/domain'
import { aiApi, onAiEvent } from '../../lib/aiClient'
import { applyAiEvent, emptyPanel, loadThread, resultFor, turnCost, type AiPanelState } from '../../lib/aiThread'
import { useNav, useScreen, useSession, useToasts } from '../../state/stores'
import { Badge, Banner, Button, Drawer, EmptyState, MenuButton, Spinner, Textarea } from '../kit'
import { ItemLink, LedgerLink, VoucherLink } from '../links'
import { confirmDialog } from '../../lib/dialogs'

// ---------- open/closed (the header button and any "Ask" entry point share it) ----------

interface AssistantStore {
  open: boolean
  setOpen: (open: boolean) => void
  toggle: () => void
}

export const useAssistantPanel = create<AssistantStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open }))
}))

type Action = { type: 'event'; event: AiEvent } | { type: 'load'; state: AiPanelState } | { type: 'awaiting' } | { type: 'error'; error: string | null }

function reducer(state: AiPanelState, a: Action): AiPanelState {
  if (a.type === 'event') return applyAiEvent(state, a.event)
  if (a.type === 'load') return a.state
  if (a.type === 'awaiting') return { ...state, awaitingThread: true, error: null }
  return { ...state, error: a.error, awaitingThread: false }
}

export function AssistantPanel(): React.JSX.Element | null {
  const { open, setOpen } = useAssistantPanel()
  if (!open) return null
  return <AssistantDrawer onClose={() => setOpen(false)} />
}

/** Exported for renderer tests (mounted without the store). */
export function AssistantDrawer({ onClose }: { onClose: () => void }): React.JSX.Element {
  const queryClient = useQueryClient()
  const toast = useToasts()
  const nav = useNav()
  const screen = useScreen()
  const { from, to } = useSession()
  const { data: view } = useQuery({ queryKey: ['aiSettings'], queryFn: aiApi.settings })
  const { data: threads } = useQuery({ queryKey: ['aiThreads'], queryFn: aiApi.threads, enabled: !!view })
  const [state, dispatch] = useReducer(reducer, emptyPanel())
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => onAiEvent((event) => dispatch({ type: 'event', event })), [])
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' })
  }, [state.messages.length, state.streaming, state.pendingTools.length])
  // A finished answer changes the conversation list (title, cost) and any draft.
  useEffect(() => {
    if (!state.running) void queryClient.invalidateQueries({ queryKey: ['aiThreads'] })
  }, [state.running, queryClient])

  const openThread = async (id: number): Promise<void> => {
    try {
      const t = await aiApi.thread(id)
      dispatch({ type: 'load', state: loadThread(id, t.messages, t.running) })
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const newThread = (): void => dispatch({ type: 'load', state: emptyPanel() })

  const send = async (): Promise<void> => {
    const q = text.trim()
    if (!q || sending || state.running) return
    setSending(true)
    if (state.threadId === null) dispatch({ type: 'awaiting' })
    try {
      const r = await aiApi.send({ threadId: state.threadId ?? undefined, text: q, context: { screen: screen.name, from, to } })
      setText('')
      // run-start normally arrives before the reply; make sure the thread is adopted either way.
      dispatch({ type: 'event', event: { type: 'run-start', threadId: r.threadId, runId: r.runId, userMessage: r.userMessage } })
    } catch (err) {
      dispatch({ type: 'error', error: (err as Error).message })
    } finally {
      setSending(false)
    }
  }

  const stop = async (): Promise<void> => {
    if (state.threadId !== null) await aiApi.cancel(state.threadId).catch(() => null)
  }

  const removeThread = async (): Promise<void> => {
    if (state.threadId === null) return
    const ok = await confirmDialog({ title: 'Delete conversation', message: 'Delete this conversation? Drafts it created stay until you save or discard them.', confirmLabel: 'Delete', danger: true })
    if (!ok) return
    try {
      await aiApi.deleteThread(state.threadId)
      newThread()
      await queryClient.invalidateQueries({ queryKey: ['aiThreads'] })
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const goSettings = (): void => {
    onClose()
    nav.go({ name: 'settings', tab: 'ai' })
  }

  const current = threads?.find((t) => t.id === state.threadId)
  const footer = (
    <div className="flex w-full flex-col gap-2">
      <Textarea
        aria-label="Ask the assistant"
        data-testid="ai-input"
        rows={3}
        placeholder={view?.ready ? 'Ask about your books — e.g. "What were sales in July?"' : 'The assistant is off'}
        value={text}
        disabled={!view?.ready}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void send()
          }
        }}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-hint text-muted">Enter to send · Shift+Enter new line · reads your books, drafts only</span>
        {state.running ? (
          <Button variant="danger" size="sm" onClick={() => void stop()} data-testid="btn-ai-stop">
            Stop
          </Button>
        ) : (
          <Button variant="primary" size="sm" onClick={() => void send()} disabled={!view?.ready || !text.trim()} loading={sending} data-testid="btn-ai-send">
            Send
          </Button>
        )}
      </div>
    </div>
  )

  return (
    <Drawer
      title="Assistant"
      subtitle={current ? current.title : 'New conversation'}
      onClose={onClose}
      width={480}
      testId="ai-panel"
      footer={footer}
    >
      <div className="mb-3 flex items-center gap-2">
        <MenuButton
          label="Conversations"
          testId="btn-ai-threads"
          align="left"
          width={320}
          items={
            threads?.length
              ? threads.map((t) => ({
                  label: t.title,
                  hint: t.running ? 'answering…' : formatMicroUsd(t.costMicroUsd),
                  onSelect: () => void openThread(t.id),
                  testId: `ai-thread-${t.id}`
                }))
              : [{ label: 'No conversations yet', onSelect: () => {}, disabled: true }]
          }
        >
          Conversations{threads?.length ? ` (${threads.length})` : ''}
        </MenuButton>
        <Button size="sm" variant="ghost" onClick={newThread} data-testid="btn-ai-new" disabled={state.running || sending}>
          New
        </Button>
        <span className="flex-1" />
        {state.threadId !== null && (
          <Button size="sm" variant="ghost" onClick={() => void removeThread()} data-testid="btn-ai-delete-thread" disabled={state.running}>
            Delete
          </Button>
        )}
      </div>

      {view && !view.ready && (
        <Banner tone="info" className="mb-3" testId="ai-off-banner" action={<Button size="sm" onClick={goSettings} data-testid="btn-ai-open-settings">Settings → AI</Button>}>
          {view.blocker}. The assistant is optional and off until you turn it on; nothing leaves this computer until then.
        </Banner>
      )}
      {view?.mock && (
        <Badge tone="warning" className="mb-3" testId="ai-mock-badge">
          Offline test assistant (TOTAL_AI_MOCK)
        </Badge>
      )}

      <div data-testid="ai-messages" aria-live="polite" className="flex flex-col gap-3">
        {state.messages.length === 0 && !state.running && view?.ready && (
          <EmptyState compact title="Ask about your books" hint="Answers quote your reports and link to them. The assistant can draft a voucher for you to review; it never saves anything." />
        )}
        {state.messages.map((m) => (
          <MessageView key={m.id} message={m} all={state.messages} drafts={state.drafts} onNavigate={onClose} />
        ))}
        {/* A call already shown under its assistant step renders there (running → done). */}
        {state.pendingTools.filter((t) => !state.messages.some((m) => m.toolCalls.some((c) => c.callId === t.callId))).map((t) => (
          <ToolChip key={t.callId} name={t.name} input={t.input} pending />
        ))}
        {state.streaming && (
          <div data-testid="ai-streaming" className="whitespace-pre-wrap text-body-sm text-ink">
            {state.streaming}
          </div>
        )}
        {state.running && !state.streaming && state.pendingTools.length === 0 && (
          <div className="flex items-center gap-2 text-hint text-muted" data-testid="ai-thinking">
            <Spinner /> Thinking…
          </div>
        )}
        {state.error && (
          <Banner tone="danger" testId="ai-error">
            {state.error}
          </Banner>
        )}
        <div ref={endRef} />
      </div>
    </Drawer>
  )
}

function MessageView({
  message: m,
  all,
  drafts,
  onNavigate
}: {
  message: AiMessageDto
  all: AiMessageDto[]
  drafts: Record<number, AiDraftDto>
  onNavigate: () => void
}): React.JSX.Element | null {
  if (m.role === 'user') {
    return (
      <div className="ml-10 self-end rounded-lg bg-panel2 px-3 py-2 text-body-sm whitespace-pre-wrap text-ink" data-testid="ai-msg-user">
        {m.content}
      </div>
    )
  }
  if (m.role === 'tool') {
    // Rendered by the assistant message that called it; a draft also gets its card here.
    return m.draftId ? <DraftCard draftId={m.draftId} known={drafts[m.draftId]} onNavigate={onNavigate} /> : null
  }
  const isFinal = m.toolCalls.length === 0
  const unsourced = m.figures.filter((f) => !f.sourced)
  const cost = isFinal ? turnCost(all, m.id) : null
  return (
    <div className="flex flex-col gap-1.5" data-testid={isFinal ? 'ai-msg-answer' : 'ai-msg-step'} data-status={m.status}>
      {m.content && (
        <div className={`text-body-sm whitespace-pre-wrap ${m.status === 'error' ? 'text-danger' : 'text-ink'}`}>
          {m.content}
          {m.status === 'cancelled' && <span className="ml-1 text-muted">(stopped)</span>}
        </div>
      )}
      {m.toolCalls.map((c) => {
        const r = resultFor(all, c.callId)
        return <ToolChip key={c.callId} name={c.name} input={c.input} result={r} onNavigate={onNavigate} />
      })}
      {unsourced.length > 0 && (
        <Banner tone="warning" testId="ai-unsourced">
          Not in any report result the assistant saw in this conversation, so it may be its own calculation — check before relying on it:{' '}
          {unsourced.map((f) => f.text).join(', ')}
        </Banner>
      )}
      {isFinal && m.sources.length > 0 && <Sources sources={m.sources} onNavigate={onNavigate} />}
      {cost && (m.model || cost.input > 0) && (
        <div className="text-caption text-muted" data-testid="ai-cost">
          {m.model ?? ''} · {cost.input.toLocaleString('en-IN')} in / {cost.output.toLocaleString('en-IN')} out tokens · cost {formatMicroUsd(cost.cost)}
        </div>
      )}
    </div>
  )
}

const TOOL_LABELS: Record<string, string> = {
  get_company_info: 'Company details',
  list_ledgers: 'Ledgers',
  ledger_statement: 'Ledger statement',
  trial_balance: 'Trial balance',
  profit_and_loss: 'Profit & loss',
  balance_sheet: 'Balance sheet',
  outstandings: 'Outstandings',
  search_books: 'Search',
  day_book: 'Day book',
  stock_summary: 'Stock summary',
  gst_summary: 'GSTR-3B summary',
  tds_summary: 'TDS summary',
  draft_voucher: 'Draft voucher'
}

function ToolChip({
  name,
  input,
  result,
  pending,
  onNavigate
}: {
  name: string
  input: unknown
  result?: AiMessageDto
  pending?: boolean
  onNavigate?: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const status = pending || !result ? 'running' : result.toolOk ? 'ok' : 'error'
  return (
    <div className="rounded-md border border-line bg-panel" data-testid="ai-tool-chip" data-tool={name} data-status={status}>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-small"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid={`ai-tool-chip-${name}`}
      >
        {status === 'running' ? <Spinner /> : <span aria-hidden="true" className={status === 'ok' ? 'text-success' : 'text-danger'}>{status === 'ok' ? '✓' : '!'}</span>}
        <span className="font-medium text-ink">{TOOL_LABELS[name] ?? name}</span>
        <span className="num truncate text-caption text-muted">{name}</span>
        {result?.truncated && <Badge tone="warning">trimmed for the model</Badge>}
        <span className="ml-auto text-caption text-muted">{open ? 'Hide' : 'Details'}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t border-line px-2.5 py-2" data-testid="ai-tool-detail">
          <JsonBlock label="Input" value={input} />
          {result && <JsonBlock label={result.toolOk ? 'Result' : 'Error'} value={result.toolOutput} />}
          {result && result.sources.length > 0 && onNavigate && <Sources sources={result.sources} onNavigate={onNavigate} />}
        </div>
      )}
    </div>
  )
}

function JsonBlock({ label, value }: { label: string; value: unknown }): React.JSX.Element {
  return (
    <div>
      <div className="mb-0.5 text-label font-semibold tracking-[0.08em] text-muted uppercase">{label}</div>
      <pre className="num max-h-48 overflow-auto rounded-sm bg-panel2 p-2 text-caption whitespace-pre-wrap text-ink">{JSON.stringify(value, null, 2)}</pre>
    </div>
  )
}

function Sources({ sources, onNavigate }: { sources: AiSource[]; onNavigate: () => void }): React.JSX.Element {
  const nav = useNav()
  const items: ReactNode[] = sources.slice(0, 16).map((s, i) => {
    if (s.kind === 'ledger') return <LedgerLink key={i} ledgerId={s.ledgerId} name={s.label} />
    if (s.kind === 'item') return <ItemLink key={i} itemId={s.itemId} name={s.label} />
    if (s.kind === 'voucher') {
      return (
        // Capture runs before the link's own click: close the (modal) panel, then navigate.
        <span key={i} onClickCapture={onNavigate}>
          <VoucherLink voucherId={s.voucherId} label={s.label} />
        </span>
      )
    }
    const screen = screenFor(s)
    if (!screen) return <span key={i}>{s.label}</span>
    return (
      <button
        key={i}
        type="button"
        className="drill-link cursor-pointer underline-offset-2 hover:underline"
        data-testid="ai-source-screen"
        data-screen-target={s.screen}
        onClick={() => {
          onNavigate()
          nav.go(screen)
        }}
      >
        {s.label}
      </button>
    )
  })
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-caption text-muted" data-testid="ai-sources">
      <span>Sources:</span>
      {items.map((it, i) => (
        <span key={i} className="max-w-full">
          {it}
          {i < items.length - 1 ? <span aria-hidden="true" className="ml-2">·</span> : null}
        </span>
      ))}
    </div>
  )
}

type NavScreen = Parameters<ReturnType<typeof useNav.getState>['go']>[0]

/** Screen sources → nav targets. Unknown screens render as plain text. */
export function screenFor(s: Extract<AiSource, { kind: 'screen' }>): NavScreen | null {
  const p = s.params ?? {}
  switch (s.screen) {
    case 'ledger-statement':
      return typeof p.ledgerId === 'number' ? { name: 'ledger-statement', ledgerId: p.ledgerId } : null
    case 'search':
      return { name: 'search', q: typeof p.q === 'string' ? p.q : undefined }
    case 'voucher-entry':
      return typeof p.aiDraftId === 'number' ? { name: 'voucher-entry', aiDraftId: p.aiDraftId } : null
    case 'masters':
      return { name: 'masters', tab: 'ledgers' }
    case 'company-info':
    case 'trial-balance':
    case 'profit-loss':
    case 'balance-sheet':
    case 'outstandings':
    case 'daybook':
    case 'stock-summary':
    case 'gstr3b':
    case 'tds':
      return { name: s.screen } as NavScreen
    default:
      return null
  }
}

function DraftCard({ draftId, known, onNavigate }: { draftId: number; known?: AiDraftDto; onNavigate: () => void }): React.JSX.Element {
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data } = useQuery({ queryKey: ['aiDraft', draftId], queryFn: () => aiApi.draft(draftId), initialData: known })
  const draft = data ?? known
  if (!draft) return <div className="text-hint text-muted">Loading draft…</div>
  const review = (): void => {
    onNavigate()
    nav.go({ name: 'voucher-entry', aiDraftId: draft.id, kindHint: draft.payload.voucherKind as VoucherKind })
  }
  const discard = async (): Promise<void> => {
    try {
      await aiApi.discardDraft(draft.id)
      await queryClient.invalidateQueries({ queryKey: ['aiDraft', draftId] })
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  return (
    <div className="rounded-md border border-amber/50 bg-amberbar/10 px-3 py-2" data-testid="ai-draft-card" data-draft-id={draft.id} data-status={draft.status}>
      <div className="flex items-center gap-2">
        <span className="text-small font-semibold text-ink">Draft voucher</span>
        {draft.unrequested && (
          <Badge tone="danger" testId="ai-draft-unrequested">
            You did not ask for this
          </Badge>
        )}
        <Badge tone={draft.status === 'open' ? 'amber' : draft.status === 'consumed' ? 'success' : 'neutral'}>
          {draft.status === 'open' ? 'Not saved' : draft.status === 'consumed' ? 'Saved' : 'Discarded'}
        </Badge>
      </div>
      <p className="mt-1 text-body-sm text-ink">{draft.summary}</p>
      {draft.unrequested && (
        <p className="mt-1 text-caption text-danger">
          Your question did not ask for an entry — text in your books (a narration or imported note) may have prompted this. Discard it unless you
          really want it.
        </p>
      )}
      {draft.status === 'open' && (
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="primary" onClick={review} data-testid="btn-ai-review-draft">
            Review draft
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void discard()} data-testid="btn-ai-discard-draft">
            Discard
          </Button>
        </div>
      )}
      {draft.status === 'consumed' && draft.voucherId && (
        <p className="mt-1 text-caption text-muted">
          <span onClickCapture={onNavigate}>
            <VoucherLink voucherId={draft.voucherId} label="Open the saved voucher" />
          </span>
        </p>
      )}
    </div>
  )
}
