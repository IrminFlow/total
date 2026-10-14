// WP 10.6: the AI panel in plain words — what the simple shell shows once Ask Total hands a
// question to the AI service (or "Explain this" / the palette ask it). Same conversation engine as
// the accountant panel (ai:send / ai:regenerate events through lib/aiThread.ts, the same figure
// chips through AnswerMarkdown, the same drafts and memory cards' channels); only the words differ:
// "Answered by the AI service", "This answer used figures from: …" (shared/simple/aiPlain.ts), the
// cost in rupees when priced, a draft as "Save this as a bill?" opening the SIMPLE flow
// pre-filled (WP 10.1 `ask` param — never the accountant editor), provider errors in plain words.
// Model ids, token counts, tool names, the "not asked for" flag's technical label and the screen
// context lines sit behind "Details". The accountant panel (components/ai/AssistantPanel.tsx) is
// untouched.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatMicroUsd, type AiContext, type AiDraftDto, type AiEvent, type AiMessageDto, type AiPreCall } from '@shared/ai'
import { screenContextLines } from '@shared/aiExplain'
import { classifyAiError, draftOffer, draftSentence, figuresFromSentence, turnCostText, usdRateOn } from '@shared/simple/aiPlain'
import { todayISO } from '@shared/dates'
import type { VoucherKind } from '@shared/domain'
import { aiApi, onAiEvent } from '../../lib/aiClient'
import { applyAiEvent, emptyPanel, turnCost, type AiPanelState } from '../../lib/aiThread'
import { cfApi } from '../../lib/cashFinanceClient'
import { useT } from '../../lib/i18n'
import { useNav, useSession, useToasts, type Screen } from '../../state/stores'
import { Banner, Button, DockedDrawer, Spinner, Textarea } from '../../components/kit'
import { AnswerMarkdown } from '../../components/ai/Markdown'

const SETTINGS_KEY = ['aiSettings'] // i18n-technical
const RATES_KEY = ['fxRates'] // i18n-technical
const MEMORY_KEY = ['aiMemory'] // i18n-technical
const DRAFTS_KEY = 'aiDrafts' // i18n-technical
const DRAFT_KEY = 'aiDraft' // i18n-technical

type Action = { type: 'event'; event: AiEvent } | { type: 'reset' } | { type: 'awaiting' } | { type: 'error'; error: string | null }

function reducer(state: AiPanelState, a: Action): AiPanelState {
  if (a.type === 'event') return applyAiEvent(state, a.event)
  if (a.type === 'reset') return emptyPanel()
  if (a.type === 'awaiting') return { ...state, awaitingThread: true, error: null }
  return { ...state, error: a.error, awaitingThread: false }
}

export interface PlainPending {
  id: number
  text: string
  context?: AiContext
  preCall?: AiPreCall
}

/** The provider's words in plain ones, with the original behind Details. */
function PlainProblem({ message, testId }: { message: string; testId: string }): React.JSX.Element {
  const t = useT()
  const e = classifyAiError(message)
  return (
    <Banner tone="danger" testId={testId}>
      <span data-kind={e.kind}>{t(e.key) /* i18n-technical: key from classifyAiError */}</span>
      <details className="mt-1 text-hint text-muted">
        <summary className="cursor-pointer">{t('common.details')}</summary>
        <p className="num mt-0.5 break-words">{t('simple.ai.panel.details.error', { error: message })}</p>
      </details>
    </Banner>
  )
}

export function SimpleAiDrawer({
  onClose,
  onBack,
  width,
  onResize,
  context,
  pending,
  takePending
}: {
  onClose: () => void
  /** Back to Ask Total. */
  onBack: () => void
  width: number
  onResize: (w: number) => void
  /** The current screen's context (sent with each question, as in the accountant panel). */
  context: AiContext
  pending: PlainPending | null
  takePending: () => PlainPending | null
}): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  const queryClient = useQueryClient()
  const { data: view } = useQuery({ queryKey: SETTINGS_KEY, queryFn: aiApi.settings })
  const { data: rates } = useQuery({ queryKey: RATES_KEY, queryFn: cfApi.fx.rates })
  const rate = usdRateOn(rates, todayISO())
  const ready = !!view?.ready
  const [state, dispatch] = useReducer(reducer, emptyPanel())
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const endRef = useRef<HTMLDivElement>(null)

  const startedRuns = useRef(new Set<string>())
  useEffect(
    () =>
      onAiEvent((event) => {
        if (event.type === 'run-start') startedRuns.current.add(event.runId)
        dispatch({ type: 'event', event }) // i18n-technical
      }),
    []
  )
  const adopt = (r: { threadId: number; runId: string; userMessage: AiMessageDto }): void => {
    if (startedRuns.current.has(r.runId)) return
    startedRuns.current.add(r.runId)
    dispatch({ type: 'event', event: { type: 'run-start', threadId: r.threadId, runId: r.runId, userMessage: r.userMessage } }) // i18n-technical
  }
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' })
  }, [state.messages.length, state.running])
  useEffect(() => {
    if (!state.running) {
      void queryClient.invalidateQueries({ queryKey: [DRAFTS_KEY] })
      void queryClient.invalidateQueries({ queryKey: MEMORY_KEY })
    }
  }, [state.running, queryClient])
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const ask = useCallback(async (q: string, ctx: AiContext, threadId: number | null, preCall?: AiPreCall): Promise<void> => {
    setSending(true)
    if (threadId === null) dispatch({ type: 'awaiting' }) // i18n-technical
    try {
      adopt(await aiApi.send({ threadId: threadId ?? undefined, text: q, context: ctx, ...(preCall ? { preCall } : {}) }))
    } catch (err) {
      dispatch({ type: 'error', error: (err as Error).message })
    } finally {
      setSending(false)
    }
  }, [])

  // Ask Total's hand-over, Explain this, the palette: a new conversation, once ready.
  useEffect(() => {
    if (!pending || !ready || sending || state.running) return
    const p = takePending()
    if (!p) return
    dispatch({ type: 'reset' })
    void ask(p.text, p.context ?? context, null, p.preCall)
  }, [pending, ready, sending, state.running, ask, context, takePending])

  const send = (): void => {
    const q = text.trim()
    if (!q || sending || state.running) return
    setText('')
    void ask(q, context, state.threadId)
  }
  const stop = (): void => {
    if (state.threadId !== null) void aiApi.cancel(state.threadId).catch(() => null)
  }

  const footer = (
    <div className="flex w-full flex-col gap-2">
      <Textarea
        ref={inputRef}
        aria-label={t('simple.ai.panel.inputLabel')}
        data-testid="ai-plain-input"
        rows={2}
        placeholder={t('simple.ai.panel.placeholder')}
        value={text}
        disabled={!ready}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            send()
          }
        }}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-hint text-muted">{t('simple.ai.panel.note')}</span>
        {state.running ? (
          <Button variant="danger" size="sm" onClick={stop} data-testid="ai-plain-stop">
            {t('simple.ai.panel.stop')}
          </Button>
        ) : (
          <Button variant="primary" size="sm" onClick={send} disabled={!ready || !text.trim()} loading={sending} data-testid="ai-plain-send">
            {t('simple.ai.panel.send')}
          </Button>
        )}
      </div>
    </div>
  )

  const header = (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="ghost" onClick={onBack} data-testid="btn-back-ask-total">
        {t('assist.panel.back')}
      </Button>
      <span className="flex-1" />
      <Button size="sm" variant="ghost" onClick={() => dispatch({ type: 'reset' }) /* i18n-technical */} disabled={state.running || sending} data-testid="ai-plain-new">
        {t('simple.ai.panel.new')}
      </Button>
    </div>
  )

  const questionOf = (finalId: number): AiMessageDto | undefined => {
    const at = state.messages.findIndex((m) => m.id === finalId)
    for (let i = at; i >= 0; i--) if (state.messages[i]!.role === 'user') return state.messages[i]
    return undefined
  }

  return (
    <DockedDrawer title={t('simple.ai.panel.title')} subtitle={t('simple.ai.panel.sub')} onClose={onClose} width={width} onResize={onResize} testId="ai-panel-plain" header={header} footer={footer}>
      <div className="flex flex-col gap-3" aria-live="polite" data-testid="ai-plain-messages">
        <Banner tone="info" testId="ai-escalated">{t('assist.panel.aiAnswered')}</Banner>
        {view && <PlainSent context={context} privacy={view.settings.privacy} useMemory={view.settings.useMemory} />}
        {view && !ready && (
          <Banner
            tone="info"
            testId="ai-plain-off"
            action={
              <Button size="sm" onClick={() => { onClose(); nav.go({ name: 'simple-ai' }) /* i18n-technical */ }} data-testid="ai-plain-setup">
                {t('simple.ai.panel.setup')}
              </Button>
            }
          >
            {t('simple.ai.panel.off')}
          </Banner>
        )}
        {view?.mock && <Banner tone="warning" testId="ai-plain-mock">{t('simple.ai.test')}</Banner>}
        {state.messages.length === 0 && !state.running && ready && <p className="text-hint text-muted" data-testid="ai-plain-empty">{t('simple.ai.panel.empty')}</p>}
        {state.messages.map((m) => {
          if (m.role === 'user') {
            return (
              <div key={m.id} className="ml-10 self-end rounded-lg bg-panel2 px-3 py-2 text-body-sm whitespace-pre-wrap text-ink" data-testid="ai-plain-question">
                {m.content}
              </div>
            )
          }
          if (m.role === 'tool') {
            if (m.draftId) return <PlainDraftCard key={m.id} draftId={m.draftId} known={state.drafts[m.draftId]} onLeavePanel={onClose} />
            const memoryId = m.toolName === 'remember' && m.toolOk ? (m.toolOutput as { result?: { memoryId?: unknown } } | null)?.result?.memoryId : null
            return typeof memoryId === 'number' ? <PlainMemoryCard key={m.id} memoryId={memoryId} /> : null
          }
          if (m.toolCalls.length > 0) return null // a step: its tools show in the answer's Details
          return <PlainAnswer key={m.id} message={m} all={state.messages} question={questionOf(m.id)} rate={rate} />
        })}
        {state.running && (
          <div className="flex items-center gap-2 text-hint text-muted" data-testid="ai-plain-thinking">
            <Spinner /> {t('simple.ai.panel.thinking')}
          </div>
        )}
        {state.error && <PlainProblem message={state.error} testId="ai-plain-error" />}
        <div ref={endRef} />
      </div>
    </DockedDrawer>
  )
}

/** WP 5.2's "what the model is told" strip in plain words: shown before the first question is
 *  sent (and all along), one click opens the screen-context lines (the system prompt's own). */
function PlainSent({ context, privacy, useMemory }: { context: AiContext; privacy: { maskIds: boolean; pseudonymiseParties: boolean }; useMemory: boolean }): React.JSX.Element {
  const t = useT()
  const lines = screenContextLines(context)
  return (
    <div className="rounded-md border border-line bg-panel2 px-2.5 py-1.5 text-caption text-muted" data-testid="ai-plain-sent">
      <p className="text-ink">{t('simple.ai.panel.sent.what', { screen: context.screen === 'gateway' ? t('simple.nav.home') : (context.label ?? t('simple.ai.panel.sent.screen')) })}</p>
      <p>
        {privacy.maskIds ? t('simple.ai.panel.sent.idsHidden') : t('simple.ai.panel.sent.idsShown')}{' '}
        {privacy.pseudonymiseParties ? t('simple.ai.panel.sent.namesHidden') : t('simple.ai.panel.sent.namesShown')}
        {useMemory ? ` ${t('simple.ai.panel.sent.memory')}` : ''}
      </p>
      <details className="mt-0.5" data-testid="ai-plain-sent-details">
        <summary className="cursor-pointer hover:text-ink">{t('common.details')}</summary>
        <ul className="num mt-0.5 flex flex-col gap-0.5 pl-2" data-testid="ai-plain-sent-lines">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </details>
    </div>
  )
}

function PlainAnswer({ message: m, all, question, rate }: { message: AiMessageDto; all: AiMessageDto[]; question?: AiMessageDto; rate: ReturnType<typeof usdRateOn> }): React.JSX.Element {
  const t = useT()
  if (m.status === 'error') return <PlainProblem message={m.content} testId="ai-plain-answer-error" />
  const from = figuresFromSentence(all, m.id, t)
  const cost = turnCost(all, m.id)
  const costLine = turnCostText(cost.cost, rate, t)
  const unsourced = m.figures.filter((f) => !f.sourced)
  // The turn's tools and models, for Details only.
  const at = all.findIndex((x) => x.id === m.id)
  let start = at
  while (start > 0 && all[start - 1]!.role !== 'user') start--
  const turn = all.slice(start, at + 1)
  const tools = [...new Set(turn.filter((x) => x.role === 'tool' && x.toolName).map((x) => x.toolName!))]
  const models = [...new Set(turn.filter((x) => x.role === 'assistant' && x.model).map((x) => x.model!))]
  const contextLines = screenContextLines(question?.context ?? null)
  return (
    <div className="flex flex-col gap-1.5" data-testid="ai-plain-answer" data-status={m.status}>
      <p className="text-label font-semibold tracking-[0.08em] text-muted uppercase" data-testid="ai-plain-by">{t('simple.ai.panel.answeredBy')}</p>
      {m.content && (
        <div>
          <AnswerMarkdown text={m.content} figures={m.figures} />
          {m.status === 'cancelled' && <span className="text-caption text-muted">{t('simple.ai.panel.stopped')}</span>}
        </div>
      )}
      {unsourced.length > 0 && (
        <Banner tone="warning" testId="ai-plain-unchecked">
          {t('simple.ai.panel.unchecked', { figures: unsourced.map((f) => f.text).join(', ') })}
        </Banner>
      )}
      {from && <p className="text-caption text-muted" data-testid="ai-plain-from">{from}</p>}
      {costLine && <p className="text-caption text-muted" data-testid="ai-plain-cost">{costLine}</p>}
      <details className="text-caption text-muted" data-testid="ai-plain-details">
        <summary className="cursor-pointer hover:text-ink">{t('common.details')}</summary>
        <ul className="num mt-1 flex flex-col gap-0.5" data-testid="ai-plain-details-body">
          {models.length > 0 && <li>{t('simple.ai.panel.details.model', { model: models.join(', ') })}</li>}
          <li>{t('simple.ai.panel.details.tokens', { input: cost.input.toLocaleString('en-IN'), output: cost.output.toLocaleString('en-IN') })}</li>
          {cost.cost != null && <li>{t('simple.ai.panel.details.cost', { cost: formatMicroUsd(cost.cost) })}</li>}
          {tools.length > 0 && <li data-testid="ai-plain-details-tools">{t('simple.ai.panel.details.tools', { tools: tools.join(', ') })}</li>}
        </ul>
        {contextLines.length > 0 && (
          <div className="mt-1">
            <p>{t('simple.ai.panel.details.context')}</p>
            <ul className="num flex flex-col gap-0.5 pl-2" data-testid="ai-plain-details-context">
              {contextLines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </div>
        )}
      </details>
    </div>
  )
}

function PlainDraftCard({ draftId, known, onLeavePanel }: { draftId: number; known?: AiDraftDto; onLeavePanel: () => void }): React.JSX.Element | null {
  const t = useT()
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data } = useQuery({ queryKey: [DRAFT_KEY, draftId], queryFn: () => aiApi.draft(draftId), initialData: known })
  const draft = data ?? known
  if (!draft) return <Spinner />
  const offer = draftOffer(draft)
  const leave = async (): Promise<void> => {
    try {
      await aiApi.discardDraft(draft.id)
      await queryClient.invalidateQueries({ queryKey: [DRAFT_KEY, draftId] })
      toast.push('success', t('simple.ai.draft.left'))
    } catch {
      toast.push('error', t('simple.ai.saveFailed'))
    }
  }
  const open = (): void => {
    onLeavePanel()
    // The flow's first save consumes the draft (simple:post `aiDraftId`, main/assist/settle.ts).
    if (offer.prefill) nav.go({ name: offer.prefill.screen, ask: { draftId: draft.id, prefill: offer.prefill } } as Screen)
    else nav.go({ name: 'voucher-entry', aiDraftId: draft.id, kindHint: draft.payload.voucherKind as VoucherKind })
  }
  return (
    <div className="rounded-md border border-amber/50 bg-amberbar/10 px-3 py-2" data-testid="ai-plain-draft" data-draft-id={draft.id} data-status={draft.status}>
      <p className="text-small font-semibold text-ink">{t('simple.ai.draft.title')}</p>
      <p className="mt-0.5 text-body-sm text-ink" data-testid="ai-plain-draft-what">{draftSentence(draft, t)}</p>
      {draft.unrequested && (
        <p className="mt-1 text-caption text-danger" data-testid="ai-plain-draft-not-asked">
          {t('simple.ai.draft.notAsked')}
        </p>
      )}
      {draft.status === 'open' && (
        <>
          <p className="mt-2 text-body-sm font-medium text-ink" data-testid="ai-plain-draft-question">{t(offer.question) /* i18n-technical: key from draftOffer */}</p>
          <div className="mt-1.5 flex items-center gap-2">
            <Button size="sm" variant="primary" onClick={open} data-testid="ai-plain-draft-open">
              {offer.prefill ? t('simple.ai.draft.open') : t('simple.ai.openFull')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void leave()} data-testid="ai-plain-draft-leave">
              {t('simple.ai.draft.leave')}
            </Button>
          </div>
          {offer.prefill && <p className="mt-1 text-caption text-muted">{t('simple.ai.draft.openNote')}</p>}
        </>
      )}
      {draft.status === 'consumed' && <p className="mt-1 text-caption text-muted">{t('simple.ai.draft.saved')}</p>}
      {draft.status === 'discarded' && <p className="mt-1 text-caption text-muted">{t('simple.ai.draft.left')}</p>}
      <details className="mt-1 text-caption text-muted" data-testid="ai-plain-draft-details">
        <summary className="cursor-pointer">{t('common.details')}</summary>
        <p className="num">{draft.summary}</p>
        {draft.unrequested && <p className="num">{t('simple.ai.panel.details.flag')}</p>}
      </details>
    </div>
  )
}

function PlainMemoryCard({ memoryId }: { memoryId: number }): React.JSX.Element | null {
  const t = useT()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const user = useSession((s) => s.user)
  const canDecide = !user || user.role !== 'viewer'
  const { data } = useQuery({ queryKey: MEMORY_KEY, queryFn: aiApi.memory })
  const m = data?.entries.find((e) => e.id === memoryId)
  const [busy, setBusy] = useState(false)
  if (!m || m.status !== 'suggested') return null
  const decide = async (status: 'active' | 'archived'): Promise<void> => {
    setBusy(true)
    try {
      await aiApi.setMemoryStatus(m.id, status)
      await queryClient.invalidateQueries({ queryKey: MEMORY_KEY })
      toast.push('success', status === 'active' ? t('simple.ai.memory.done') : t('simple.ai.memory.dismissed'))
    } catch {
      toast.push('error', t('simple.ai.saveFailed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="rounded-md border border-line bg-panel px-3 py-2" data-testid="ai-plain-memory" data-memory-id={m.id}>
      <p className="text-small font-semibold text-ink">{t('simple.ai.memory.title')}</p>
      <p className="mt-0.5 text-body-sm text-ink">{m.text}</p>
      <p className="text-caption text-muted">{t('simple.ai.memory.notUsed')}</p>
      {m.unrequested && <p className="mt-1 text-caption text-danger">{t('simple.ai.memory.notAsked')}</p>}
      {canDecide && (
        <div className="mt-1.5 flex gap-2">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void decide('active') /* i18n-technical */} data-testid="ai-plain-memory-yes">
            {t('simple.ai.memory.yes')}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide('archived') /* i18n-technical */} data-testid="ai-plain-memory-no">
            {t('simple.ai.memory.no')}
          </Button>
        </div>
      )}
    </div>
  )
}
