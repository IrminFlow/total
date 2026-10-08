// The chat panel (WP 5.1 platform, WP 5.2 experience): a DockedDrawer beside every screen (⌘J or
// the header button; width and open state remembered), knowing the current screen and period.
//
// - Conversations: list with search, rename, pin, delete; cost per answer and per conversation.
// - Answers: safe markdown (tables, lists — never HTML) with money figures as chips linking to the
//   row they came from (tool sources); the numbers-rule warning inline; tool-call chips that
//   expand; Stop, Regenerate, Copy.
// - Context strip: company, working period, screen — and, expanded, exactly the lines the model
//   will be told (screenContextLines, shared with the system prompt) with the privacy switches.
// - Drafts: a card per draft in the stream plus the conversation's drafts list; unrequested drafts
//   flagged; Review draft opens the voucher editor.
// - Keyboard: Enter sends, Shift+Enter new line, Esc closes, ⌘K stays the palette.
// - "Open the ledger for X" is resolved here through the search service — never sent to the model.
//
// AssistantPanel is the host: it always mounts (Shell), tells the kit whether to show the AI
// affordances (lib/explain.ts: hidden while AI is off), and turns "Explain this" clicks and the
// palette's "Ask AI" row into a question in a new conversation.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { create } from 'zustand'
import { formatMicroUsd, type AiContext, type AiDraftDto, type AiEvent, type AiMessageDto, type AiSource, type AiThreadDto } from '@shared/ai'
import { explainContextFor, parseNavIntent, screenContextLines } from '@shared/aiExplain'
import { fyOf, todayISO, toDisplayDate } from '@shared/dates'
import type { VoucherKind } from '@shared/domain'
import { aiApi, onAiEvent } from '../../lib/aiClient'
import { applyAiEvent, emptyPanel, loadThread, resultFor, turnCost, type AiPanelState } from '../../lib/aiThread'
import { AS_ON_SCREENS, screenContextFor, screenTitle, useAiScreenParams } from '../../lib/aiContext'
import { explainTargetFor, useExplain, type ExplainInput } from '../../lib/explain'
import { api } from '../../lib/client'
import { openLedgerStatement, openVoucher } from '../../lib/drill'
import { SCREENS } from '../../lib/screens'
import { useNav, useScreen, useSession, useToasts, type Screen } from '../../state/stores'
import { Badge, Banner, Button, DockedDrawer, EmptyState, IconButton, Spinner, TextInput, Textarea } from '../kit'
import { ItemLink, LedgerLink, VoucherLink } from '../links'
import { confirmDialog } from '../../lib/dialogs'
import { AnswerMarkdown } from './Markdown'
import { screenFor } from './screenTargets'

export { screenFor }

// ---------- open / width (remembered) and the pending question ----------

const PREFS_KEY = 'total-ai-panel'
const DEFAULT_WIDTH = 460

interface PendingAsk {
  id: number
  text: string
  context?: AiContext
}

interface AssistantStore {
  open: boolean
  width: number
  /** A question to send in a NEW conversation as soon as the panel is ready (Explain this, palette). */
  pending: PendingAsk | null
  setOpen: (open: boolean) => void
  toggle: () => void
  setWidth: (width: number) => void
  ask: (text: string, context?: AiContext) => void
  takePending: () => PendingAsk | null
}

function loadPrefs(): { open: boolean; width: number } {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as { open?: unknown; width?: unknown }
    return { open: p.open === true, width: typeof p.width === 'number' && p.width >= 340 && p.width <= 760 ? p.width : DEFAULT_WIDTH }
  } catch {
    return { open: false, width: DEFAULT_WIDTH }
  }
}

function savePrefs(s: { open: boolean; width: number }): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ open: s.open, width: s.width }))
  } catch {
    /* storage full / unavailable: preferences are best-effort */
  }
}

let askSeq = 0

export const useAssistantPanel = create<AssistantStore>((set, get) => ({
  ...loadPrefs(),
  pending: null,
  setOpen: (open) => {
    set({ open })
    savePrefs(get())
  },
  toggle: () => get().setOpen(!get().open),
  setWidth: (width) => {
    set({ width })
    savePrefs(get())
  },
  ask: (text, context) => {
    set({ open: true, pending: { id: ++askSeq, text, context } })
    savePrefs(get())
  },
  takePending: () => {
    const p = get().pending
    if (p) set({ pending: null })
    return p
  }
}))

/** The current screen's context (nav + period + what the screen registered). */
export function useCurrentAiContext(): AiContext {
  const screen = useScreen()
  const { from, to, workingDate } = useSession()
  const extra = useAiScreenParams((s) => s.byScreen[screen.name])
  // WP 5.3: the working date travels with every question — drafts resolve relative dates against it.
  return useMemo(() => ({ ...screenContextFor(screen, from, to, extra), workingDate }), [screen, from, to, extra, workingDate])
}

// ---------- the host ----------

export function AssistantPanel(): React.JSX.Element | null {
  const { open, setOpen } = useAssistantPanel()
  const { data: view } = useQuery({ queryKey: ['aiSettings'], queryFn: aiApi.settings })
  const ready = !!view?.ready

  // The kit's Explain-this affordances follow the assistant: hidden while it is off.
  useEffect(() => {
    const ex = useExplain.getState()
    ex.setReady(ready)
    ex.setHandler(ready ? explainHandler : null)
    return () => {
      useExplain.getState().setReady(false)
      useExplain.getState().setHandler(null)
    }
  }, [ready])

  // ⌘⇧E: explain the focused row / statement line, or the active table row (WP 5.2 review).
  useEffect(() => {
    if (!ready) return
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey || e.key.toLowerCase() !== 'e') return
      const target = explainTargetFor(document)
      if (!target) return
      e.preventDefault()
      target.click()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ready])

  if (!open) return null
  return <AssistantDrawer onClose={() => setOpen(false)} />
}

/** "Explain this": the figure + the current screen → a prefilled question in a new conversation. */
function explainHandler(f: ExplainInput): void {
  const nav = useNav.getState()
  const screen = nav.stack[nav.stack.length - 1]!
  const { from, to } = useSession.getState()
  const ctx = screenContextFor(screen, from, to, useAiScreenParams.getState().byScreen[screen.name])
  const asOn = f.asOn ?? (AS_ON_SCREENS.has(screen.name) && !f.from ? to : undefined)
  const { question, context } = explainContextFor({
    ...f,
    screen: f.screen ?? screen.name,
    screenLabel: f.screen ? screenTitle(f.screen) : ctx.label,
    params: ctx.params,
    from: f.from ?? from,
    to: f.to ?? to,
    ...(asOn ? { asOn } : {})
  })
  useAssistantPanel.getState().ask(question, context)
}

// ---------- the drawer ----------

type Action =
  | { type: 'event'; event: AiEvent }
  | { type: 'load'; state: AiPanelState }
  | { type: 'awaiting' }
  | { type: 'error'; error: string | null }

function reducer(state: AiPanelState, a: Action): AiPanelState {
  if (a.type === 'event') return applyAiEvent(state, a.event)
  if (a.type === 'load') return a.state
  if (a.type === 'awaiting') return { ...state, awaitingThread: true, error: null }
  return { ...state, error: a.error, awaitingThread: false }
}

/** Exported for renderer tests (mounted without the store). `onClose` closes the panel. */
export function AssistantDrawer({ onClose }: { onClose: () => void }): React.JSX.Element {
  const queryClient = useQueryClient()
  const toast = useToasts()
  const nav = useNav()
  const info = useSession((s) => s.info)
  const { from, to } = useSession()
  const width = useAssistantPanel((s) => s.width)
  const setWidth = useAssistantPanel((s) => s.setWidth)
  const pending = useAssistantPanel((s) => s.pending)
  const context = useCurrentAiContext()
  const { data: view, isLoading: viewLoading, error: viewError } = useQuery({ queryKey: ['aiSettings'], queryFn: aiApi.settings })
  const { data: threads } = useQuery({ queryKey: ['aiThreads'], queryFn: aiApi.threads, enabled: !!view })
  const [state, dispatch] = useReducer(reducer, emptyPanel())
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [mode, setMode] = useState<'chat' | 'threads'>('chat')
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const ready = !!view?.ready
  const { data: draftRows } = useQuery({
    queryKey: ['aiDrafts', state.threadId],
    queryFn: () => aiApi.drafts(undefined, state.threadId!),
    enabled: ready && state.threadId !== null
  })
  const drafts = draftRows ?? [] // a null reply (no list) renders as no drafts

  // Runs whose run-start already streamed in: the IPC reply must not start them again (a fast
  // run may even have finished before the reply arrives).
  const startedRuns = useRef(new Set<string>())
  useEffect(
    () =>
      onAiEvent((event) => {
        if (event.type === 'run-start') startedRuns.current.add(event.runId)
        dispatch({ type: 'event', event })
      }),
    []
  )
  const adopt = (r: { threadId: number; runId: string; userMessage: AiMessageDto }): void => {
    if (startedRuns.current.has(r.runId)) return
    startedRuns.current.add(r.runId)
    dispatch({ type: 'event', event: { type: 'run-start', threadId: r.threadId, runId: r.runId, userMessage: r.userMessage } })
  }
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' })
  }, [state.messages.length, state.streaming, state.pendingTools.length])
  // A finished answer changes the conversation list (title, cost) and the drafts.
  useEffect(() => {
    if (!state.running) {
      void queryClient.invalidateQueries({ queryKey: ['aiThreads'] })
      void queryClient.invalidateQueries({ queryKey: ['aiDrafts'] })
    }
  }, [state.running, queryClient])
  useEffect(() => {
    if (mode === 'chat') inputRef.current?.focus()
  }, [mode])

  const openThread = async (id: number): Promise<void> => {
    try {
      const t = await aiApi.thread(id)
      dispatch({ type: 'load', state: loadThread(id, t.messages, t.running) })
      setMode('chat')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const newThread = (): void => {
    dispatch({ type: 'load', state: emptyPanel() })
    setMode('chat')
  }

  const ask = useCallback(
    async (q: string, ctx: AiContext, threadId: number | null): Promise<void> => {
      setSending(true)
      if (threadId === null) dispatch({ type: 'awaiting' })
      try {
        const r = await aiApi.send({ threadId: threadId ?? undefined, text: q, context: ctx })
        // run-start normally arrives before the reply; make sure the thread is adopted either way.
        adopt(r)
        return
      } catch (err) {
        dispatch({ type: 'error', error: (err as Error).message })
        throw err
      } finally {
        setSending(false)
      }
    },
    []
  )

  // Explain this / palette questions: a new conversation, sent once the assistant is ready.
  useEffect(() => {
    if (!pending || !ready || sending || state.running) return
    const p = useAssistantPanel.getState().takePending()
    if (!p) return
    dispatch({ type: 'load', state: emptyPanel() })
    setMode('chat')
    void ask(p.text, p.context ?? context, null).catch(() => null)
  }, [pending, ready, sending, state.running, ask, context])

  /** "Open the ledger for Acme" → the search service, then navigate. True when handled. */
  const navigateByIntent = async (q: string): Promise<boolean> => {
    const intent = parseNavIntent(q)
    if (!intent) return false
    const screenDef = intent.kind === null ? SCREENS.find((s) => s.screen && s.title.toLowerCase() === intent.target.toLowerCase()) : undefined
    if (screenDef?.screen) {
      nav.go(screenDef.screen)
      toast.push('success', `Opened ${screenDef.title}`)
      return true
    }
    if (intent.kind === null) return false
    try {
      const r = await api.search.query({ q: intent.target, today: todayISO(), fyStartYear: fyOf(from).startYear, limitPerKind: 3 })
      if (intent.kind === 'ledger' && r.ledgers?.rows[0]) {
        openLedgerStatement(r.ledgers.rows[0].id)
        toast.push('success', `Opened ${r.ledgers.rows[0].name} (found by search)`)
      } else if (intent.kind === 'item' && r.items?.rows[0]) {
        nav.go({ name: 'stock-movements', itemId: r.items.rows[0].id })
        toast.push('success', `Opened ${r.items.rows[0].name} (found by search)`)
      } else if (intent.kind === 'voucher' && r.vouchers?.rows[0]) {
        openVoucher(r.vouchers.rows[0].id)
        toast.push('success', `Opened ${r.vouchers.rows[0].typeName} ${r.vouchers.rows[0].number} (found by search)`)
      } else {
        toast.push('error', `Nothing in the books matches “${intent.target}”`)
      }
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
    return true
  }

  const send = async (): Promise<void> => {
    const q = text.trim()
    if (!q || sending || state.running) return
    if (await navigateByIntent(q)) {
      setText('')
      return
    }
    try {
      await ask(q, context, state.threadId)
      setText('')
    } catch {
      /* shown in the panel */
    }
  }

  const stop = async (): Promise<void> => {
    if (state.threadId !== null) await aiApi.cancel(state.threadId).catch(() => null)
  }

  const regenerate = async (): Promise<void> => {
    if (state.threadId === null || state.running || sending) return
    setSending(true)
    try {
      // Main re-asks with the context stored on the question (the screen and figure it was asked
      // with), never the screen open now.
      const r = await aiApi.regenerate(state.threadId)
      // run-start (streamed before this reply) already dropped the old answer; adopt it either way.
      adopt(r)
    } catch (err) {
      dispatch({ type: 'error', error: (err as Error).message })
    } finally {
      setSending(false)
    }
  }

  const removeThread = async (id: number): Promise<void> => {
    const ok = await confirmDialog({ title: 'Delete conversation', message: 'Delete this conversation? Drafts it created stay until you save or discard them.', confirmLabel: 'Delete', danger: true })
    if (!ok) return
    try {
      await aiApi.deleteThread(id)
      if (state.threadId === id) newThread()
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
  const lastFinal = [...state.messages].reverse().find((m) => m.role === 'assistant' && m.toolCalls.length === 0)
  const subtitle = current ? (
    <span data-testid="ai-thread-subtitle" className="flex min-w-0" title={current.title}>
      <span className="min-w-0 truncate">{current.title}</span>
      <span className="num shrink-0 whitespace-pre" title="Cost of this conversation">{` · ${formatMicroUsd(current.costMicroUsd)}`}</span>
    </span>
  ) : (
    'New conversation'
  )

  const toolbar = (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant={mode === 'threads' ? 'secondary' : 'ghost'} onClick={() => setMode(mode === 'threads' ? 'chat' : 'threads')} data-testid="btn-ai-threads" aria-pressed={mode === 'threads'}>
          Conversations{threads?.length ? ` (${threads.length})` : ''}
        </Button>
        <Button size="sm" variant="ghost" onClick={newThread} data-testid="btn-ai-new" disabled={state.running || sending}>
          New
        </Button>
        <span className="flex-1" />
        {state.threadId !== null && current && (
          <>
            <IconButton size="sm" label={current.pinned ? 'Unpin conversation' : 'Pin conversation'} data-testid="btn-ai-pin" onClick={() => void pinThread(current, queryClient, toast)}>
              {current.pinned ? '★' : '☆'}
            </IconButton>
            <IconButton size="sm" label="Delete conversation" data-testid="btn-ai-delete-thread" disabled={state.running} onClick={() => void removeThread(current.id)}>
              🗑
            </IconButton>
          </>
        )}
      </div>
      <ContextStrip companyName={info?.name ?? ''} context={context} privacy={view?.settings.privacy} from={from} to={to} />
    </div>
  )

  const footer = (
    <div className="flex w-full flex-col gap-2">
      <Textarea
        ref={inputRef}
        aria-label="Ask the assistant"
        data-testid="ai-input"
        rows={3}
        placeholder={ready ? 'Ask about your books — “why is this high?”, “sales in July?”, “open the ledger for …”' : 'The assistant is off'}
        value={text}
        disabled={!ready}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void send()
          }
        }}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-hint text-muted">Enter send · Shift+Enter new line · Esc close · reads your books, drafts only</span>
        {state.running ? (
          <Button variant="danger" size="sm" onClick={() => void stop()} data-testid="btn-ai-stop">
            Stop
          </Button>
        ) : (
          <Button variant="primary" size="sm" onClick={() => void send()} disabled={!ready || !text.trim()} loading={sending} data-testid="btn-ai-send">
            Send
          </Button>
        )}
      </div>
    </div>
  )

  return (
    <DockedDrawer title="Assistant" subtitle={subtitle} onClose={onClose} width={width} onResize={setWidth} testId="ai-panel" header={toolbar} footer={footer}>
      {viewLoading && (
        <div className="flex items-center gap-2 text-hint text-muted" data-testid="ai-loading">
          <Spinner /> Loading…
        </div>
      )}
      {viewError && (
        <Banner tone="danger" className="mb-3" testId="ai-settings-error">
          {(viewError as Error).message}
        </Banner>
      )}
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

      {mode === 'threads' ? (
        <ThreadList threads={threads ?? []} currentId={state.threadId} onOpen={(id) => void openThread(id)} onDelete={(id) => void removeThread(id)} />
      ) : (
        <>
          {drafts.length > 0 && <DraftsList drafts={drafts} />}
          <div data-testid="ai-messages" aria-live="polite" className="flex flex-col gap-3">
            {state.messages.length === 0 && !state.running && ready && (
              <EmptyState
                compact
                title="Ask about your books"
                hint="Answers quote your reports and link to them; figures are chips you can open. Hover a money figure anywhere and press AI to have it explained. The assistant can draft a voucher for you to review — it never saves anything."
              />
            )}
            {state.messages.map((m) => (
              <MessageView
                key={m.id}
                message={m}
                all={state.messages}
                drafts={state.drafts}
                canRegenerate={!state.running && !sending && m.id === lastFinal?.id}
                onRegenerate={() => void regenerate()}
                onCloseForReview={onClose}
              />
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
        </>
      )}
    </DockedDrawer>
  )
}

async function pinThread(t: AiThreadDto, queryClient: ReturnType<typeof useQueryClient>, toast: { push: (tone: 'error', msg: string) => void }): Promise<void> {
  try {
    await aiApi.pinThread(t.id, !t.pinned)
    await queryClient.invalidateQueries({ queryKey: ['aiThreads'] })
  } catch (err) {
    toast.push('error', (err as Error).message)
  }
}

// ---------- context strip ----------

function ContextStrip({
  companyName,
  context,
  privacy,
  from,
  to
}: {
  companyName: string
  context: AiContext
  privacy?: { maskIds: boolean; pseudonymiseParties: boolean }
  from: string
  to: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const lines = screenContextLines(context)
  return (
    <div className="rounded-md border border-line bg-panel2 px-2.5 py-1.5 text-caption" data-testid="ai-context">
      <button type="button" className="flex w-full items-center gap-2 text-left" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="btn-ai-context">
        <span className="truncate text-ink">
          <span className="font-medium">{companyName}</span>
          <span className="text-muted"> · </span>
          <span className="num">
            {toDisplayDate(from)} → {toDisplayDate(to)}
          </span>
          <span className="text-muted"> · </span>
          <span data-testid="ai-context-screen">{context.label ?? context.screen}</span>
        </span>
        <span className="ml-auto shrink-0 text-muted">{open ? 'Hide' : 'What the model is told'}</span>
      </button>
      {open && (
        <div className="mt-1.5 border-t border-line pt-1.5" data-testid="ai-context-detail">
          <ul className="num flex flex-col gap-0.5 text-muted">
            {lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <p className="mt-1 text-muted">
            Plus the company, today’s date, your role and the list of tools. GSTIN / PAN / bank numbers {privacy?.maskIds ? 'are masked' : 'are sent as they are'}; party names{' '}
            {privacy?.pseudonymiseParties ? 'are replaced by aliases' : 'are sent as they are'} (Settings → AI). Every request is in the outbound log.
          </p>
        </div>
      )}
    </div>
  )
}

// ---------- conversations ----------

function ThreadList({
  threads,
  currentId,
  onOpen,
  onDelete
}: {
  threads: AiThreadDto[]
  currentId: number | null
  onOpen: (id: number) => void
  onDelete: (id: number) => void
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const toast = useToasts()
  const [q, setQ] = useState('')
  const [renaming, setRenamingState] = useState<{ id: number; title: string } | null>(null)
  // The edit lives in a ref too: Enter then the blur it causes must save once, and Esc must not
  // be followed by a save from the blur's stale closure.
  const renamingRef = useRef<{ id: number; title: string } | null>(null)
  const setRenaming = (v: { id: number; title: string } | null): void => {
    renamingRef.current = v
    setRenamingState(v)
  }
  const shown = threads.filter((t) => t.title.toLowerCase().includes(q.trim().toLowerCase()))
  const saveRename = async (): Promise<void> => {
    const r = renamingRef.current
    if (!r) return
    renamingRef.current = null // claimed: a second Enter / the blur do nothing
    try {
      await aiApi.renameThread(r.id, r.title)
      setRenamingState(null)
      await queryClient.invalidateQueries({ queryKey: ['aiThreads'] })
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  return (
    <div className="flex flex-col gap-2" data-testid="ai-thread-list">
      <TextInput aria-label="Search conversations" placeholder="Search conversations" value={q} onChange={(e) => setQ(e.target.value)} data-testid="input-ai-thread-search" />
      {shown.length === 0 && <p className="text-hint text-muted">{threads.length ? 'No conversation matches.' : 'No conversations yet.'}</p>}
      <ul className="flex flex-col gap-1">
        {shown.map((t) => (
          <li
            key={t.id}
            data-testid={`ai-thread-${t.id}`}
            className={`group/thread flex items-center gap-1.5 rounded-md border px-2 py-1.5 ${t.id === currentId ? 'border-amber/60 bg-amberbar/10' : 'border-line bg-panel'}`}
          >
            {renaming?.id === t.id ? (
              <TextInput
                autoFocus
                aria-label="Conversation title"
                value={renaming.title}
                data-testid="input-ai-thread-title"
                onChange={(e) => setRenaming({ id: t.id, title: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveRename()
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    setRenaming(null)
                  }
                }}
                onBlur={() => void saveRename()}
              />
            ) : (
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpen(t.id)} data-testid={`btn-ai-open-thread-${t.id}`}>
                <span className="block truncate text-small text-ink">
                  {t.pinned && <span aria-label="pinned" className="mr-1 text-amber">★</span>}
                  {t.title}
                </span>
                <span className="block text-caption text-muted">
                  {t.running ? 'answering…' : `${t.messageCount} messages`} · <span className="num">{formatMicroUsd(t.costMicroUsd)}</span>
                </span>
              </button>
            )}
            <IconButton size="sm" label={t.pinned ? 'Unpin' : 'Pin'} onClick={() => void pinThread(t, queryClient, toast)} data-testid={`btn-ai-pin-${t.id}`}>
              {t.pinned ? '★' : '☆'}
            </IconButton>
            <IconButton size="sm" label="Rename" onClick={() => setRenaming({ id: t.id, title: t.title })} data-testid={`btn-ai-rename-${t.id}`}>
              ✎
            </IconButton>
            <IconButton size="sm" label="Delete" onClick={() => onDelete(t.id)} disabled={t.running}>
              🗑
            </IconButton>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------- drafts ----------

function DraftsList({ drafts }: { drafts: AiDraftDto[] }): React.JSX.Element {
  const [open, setOpen] = useState(drafts.some((d) => d.status === 'open'))
  const openCount = drafts.filter((d) => d.status === 'open').length
  return (
    <div className="mb-3 rounded-md border border-line bg-panel" data-testid="ai-drafts">
      <button type="button" className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-small" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="font-medium text-ink">Drafts in this conversation</span>
        <Badge tone={openCount ? 'amber' : 'neutral'}>{openCount ? `${openCount} to review` : drafts.length}</Badge>
        {drafts.some((d) => d.unrequested && d.status === 'open') && <Badge tone="danger">unrequested</Badge>}
        <span className="ml-auto text-caption text-muted">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <ul className="flex flex-col gap-1 border-t border-line px-2.5 py-2">
          {drafts.map((d) => (
            <li key={d.id} className="flex items-center gap-2 text-small" data-testid="ai-drafts-row" data-status={d.status}>
              <span className="min-w-0 flex-1 truncate text-ink" title={d.summary}>
                {d.summary}
              </span>
              {d.unrequested && <Badge tone="danger">not asked for</Badge>}
              <DraftStatus status={d.status} />
              {d.status === 'open' && <ReviewDraftButton draft={d} testId={`btn-ai-review-draft-${d.id}`} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const DRAFT_STATUS: Record<AiDraftDto['status'], string> = { open: 'Not saved', consumed: 'Saved', discarded: 'Discarded', superseded: 'Replaced by a regenerated answer' }

function DraftStatus({ status }: { status: AiDraftDto['status'] }): React.JSX.Element {
  return <Badge tone={status === 'open' ? 'amber' : status === 'consumed' ? 'success' : 'neutral'}>{DRAFT_STATUS[status]}</Badge>
}

function ReviewDraftButton({ draft, testId, onBeforeNavigate }: { draft: AiDraftDto; testId: string; onBeforeNavigate?: () => void }): React.JSX.Element {
  const nav = useNav()
  return (
    <Button
      size="sm"
      variant="primary"
      data-testid={testId}
      onClick={() => {
        // The editor needs the room: the panel closes for the review (reopen with ⌘J).
        onBeforeNavigate?.()
        useAssistantPanel.getState().setOpen(false)
        nav.go({ name: 'voucher-entry', aiDraftId: draft.id, kindHint: draft.payload.voucherKind as VoucherKind })
      }}
    >
      Review draft
    </Button>
  )
}

// ---------- messages ----------

function MessageView({
  message: m,
  all,
  drafts,
  canRegenerate,
  onRegenerate,
  onCloseForReview
}: {
  message: AiMessageDto
  all: AiMessageDto[]
  drafts: Record<number, AiDraftDto>
  canRegenerate: boolean
  onRegenerate: () => void
  onCloseForReview: () => void
}): React.JSX.Element | null {
  const toast = useToasts()
  if (m.role === 'user') {
    return (
      <div className="ml-10 self-end rounded-lg bg-panel2 px-3 py-2 text-body-sm whitespace-pre-wrap text-ink" data-testid="ai-msg-user">
        {m.content}
      </div>
    )
  }
  if (m.role === 'tool') {
    // Rendered by the assistant message that called it; a draft also gets its card here.
    return m.draftId ? <DraftCard draftId={m.draftId} known={drafts[m.draftId]} onCloseForReview={onCloseForReview} /> : null
  }
  const isFinal = m.toolCalls.length === 0
  const unsourced = m.figures.filter((f) => !f.sourced)
  const cost = isFinal ? turnCost(all, m.id) : null
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(m.content)
      toast.push('success', 'Copied')
    } catch {
      toast.push('error', 'Could not copy')
    }
  }
  return (
    <div className="flex flex-col gap-1.5" data-testid={isFinal ? 'ai-msg-answer' : 'ai-msg-step'} data-status={m.status}>
      {m.content &&
        (m.status === 'error' ? (
          <div className="text-body-sm whitespace-pre-wrap text-danger">{m.content}</div>
        ) : (
          <div>
            <AnswerMarkdown text={m.content} figures={m.figures} />
            {m.status === 'cancelled' && <span className="text-caption text-muted">(stopped)</span>}
          </div>
        ))}
      {m.toolCalls.map((c) => {
        const r = resultFor(all, c.callId)
        return <ToolChip key={c.callId} name={c.name} input={c.input} result={r} />
      })}
      {unsourced.length > 0 && (
        <Banner tone="warning" testId="ai-unsourced">
          Not in any report result the assistant saw in this conversation, so it may be its own calculation — check before relying on it:{' '}
          {unsourced.map((f) => f.text).join(', ')}
        </Banner>
      )}
      {isFinal && m.sources.length > 0 && <Sources sources={m.sources} />}
      {isFinal && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted">
          {cost && (m.model || cost.input > 0) && (
            <span data-testid="ai-cost">
              {m.model ?? ''} · {cost.input.toLocaleString('en-IN')} in / {cost.output.toLocaleString('en-IN')} out tokens · cost {formatMicroUsd(cost.cost)}
            </span>
          )}
          <span className="flex-1" />
          {m.content && (
            <button type="button" className="hover:text-ink" onClick={() => void copy()} data-testid="btn-ai-copy">
              Copy
            </button>
          )}
          {canRegenerate && (
            <button type="button" className="hover:text-ink" onClick={onRegenerate} data-testid="btn-ai-regenerate">
              Regenerate
            </button>
          )}
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
  draft_voucher: 'Draft voucher',
  current_screen_data: 'This screen',
  explain_figure: 'Explain the figure',
  item_movements: 'Item movements',
  manufacture_register: 'Manufacture register',
  trade_pending: 'Pending documents',
  bank_unreconciled: 'Bank reconciliation',
  tds_eligible: 'TDS workbench',
  budget_variance: 'Budget variance',
  forecast_summary: 'Cash-flow forecast',
  audit_log_recent: 'Audit trail'
}

function ToolChip({ name, input, result, pending }: { name: string; input: unknown; result?: AiMessageDto; pending?: boolean }): React.JSX.Element {
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
          {result && result.sources.length > 0 && <Sources sources={result.sources} />}
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

function Sources({ sources }: { sources: AiSource[] }): React.JSX.Element {
  const nav = useNav()
  const items: ReactNode[] = sources.slice(0, 16).map((s, i) => {
    if (s.kind === 'ledger') return <LedgerLink key={i} ledgerId={s.ledgerId} name={s.label} />
    if (s.kind === 'item') return <ItemLink key={i} itemId={s.itemId} name={s.label} />
    if (s.kind === 'voucher') return <VoucherLink key={i} voucherId={s.voucherId} label={s.label} />
    const screen: Screen | null = screenFor(s)
    if (!screen) return <span key={i}>{s.label}</span>
    return (
      <button
        key={i}
        type="button"
        className="drill-link cursor-pointer underline-offset-2 hover:underline"
        data-testid="ai-source-screen"
        data-screen-target={s.screen}
        onClick={() => nav.go(screen)}
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

function DraftCard({ draftId, known, onCloseForReview }: { draftId: number; known?: AiDraftDto; onCloseForReview: () => void }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data } = useQuery({ queryKey: ['aiDraft', draftId], queryFn: () => aiApi.draft(draftId), initialData: known })
  const draft = data ?? known
  if (!draft) return <div className="text-hint text-muted">Loading draft…</div>
  const discard = async (): Promise<void> => {
    try {
      await aiApi.discardDraft(draft.id)
      await queryClient.invalidateQueries({ queryKey: ['aiDraft', draftId] })
      await queryClient.invalidateQueries({ queryKey: ['aiDrafts'] })
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
        <DraftStatus status={draft.status} />
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
          <ReviewDraftButton draft={draft} testId="btn-ai-review-draft" onBeforeNavigate={onCloseForReview} />
          <Button size="sm" variant="ghost" onClick={() => void discard()} data-testid="btn-ai-discard-draft">
            Discard
          </Button>
        </div>
      )}
      {draft.status === 'consumed' && draft.voucherId && (
        <p className="mt-1 text-caption text-muted">
          <VoucherLink voucherId={draft.voucherId} label="Open the saved voucher" />
        </p>
      )}
    </div>
  )
}
