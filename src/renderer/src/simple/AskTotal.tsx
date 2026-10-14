// WP 10.1 — Ask Total: the assistant panel's simple-mode face (⌘J), answering from the books with
// NO key and no network (src/main/assist/ — a fixed set of questions, templated sentences, figures
// from the screens' own services). Figures are chips that open the row / screen they came from;
// "Which Ramesh?" is asked, never guessed; an entry request ("paid 500 for tea in cash") opens its
// simple flow pre-filled and saves only when the user presses Save there. With an AI key and the
// assistant on, a question Total can't answer goes to the model (the WP 5.x panel, every rule
// unchanged) — each answer says which one answered.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import type { AssistAnswer, AssistFigure } from '@shared/assist'
import type { Language } from '@shared/i18n'
import { api } from '../lib/client'
import { useLanguage, useT } from '../lib/i18n'
import { useNav, useSession, useToasts, type Screen } from '../state/stores'
import { Badge, Button, DockedDrawer, Textarea } from '../components/kit'
import { askScreen } from './askTargets'
import { HELP } from '../help/articles'
import { useHelpPanel } from '../help/store'

// ---------- the pending question (Home's Ask box, a suggestion) ----------

interface AskTotalStore {
  pending: { id: number; text: string } | null
  ask: (text: string) => void
  take: () => { id: number; text: string } | null
  /** The conversation so far — kept here so "Back to Ask Total" after an escalation (the drawer
   *  remounts) still shows it. */
  turns: Turn[]
  /** Whose conversation it is (company + signed-in user) — another company or user starts empty. */
  owner: string | null
  setTurns: (fn: (all: Turn[]) => Turn[]) => void
  claim: (owner: string) => void
}

let seq = 0
export const useAskTotal = create<AskTotalStore>((set, get) => ({
  pending: null,
  turns: [],
  owner: null,
  setTurns: (fn) => set((s) => ({ turns: fn(s.turns) })),
  claim: (owner) => {
    if (get().owner !== owner) set({ owner, turns: [] })
  },
  ask: (text) => set({ pending: { id: ++seq, text } }),
  take: () => {
    const p = get().pending
    if (p) set({ pending: null })
    return p
  }
}))

interface Turn {
  id: number
  text: string
  picks?: { party?: number; item?: number }
  answer?: AssistAnswer
  failed?: boolean
}

/** A sentence with each figure's text turned into a chip that opens where it came from. */
function Sentence({ text, figures, onOpen }: { text: string; figures: AssistFigure[]; onOpen: (s: Screen) => void }): React.JSX.Element {
  const parts: (string | AssistFigure)[] = []
  let rest = text
  for (;;) {
    let best: { at: number; f: AssistFigure } | null = null
    for (const f of figures) {
      const at = rest.indexOf(f.text)
      if (at >= 0 && (!best || at < best.at)) best = { at, f }
    }
    if (!best) break
    parts.push(rest.slice(0, best.at), best.f)
    rest = rest.slice(best.at + best.f.text.length)
  }
  parts.push(rest)
  return (
    <p className="text-body-sm text-ink">
      {parts.map((p, i) => {
        if (typeof p === 'string') return <span key={i}>{p}</span>
        const to = askScreen(p.target)
        return to ? (
          <button
            key={i}
            type="button"
            data-testid="ask-figure"
            title={p.source?.label}
            onClick={() => onOpen(to)}
            className="num mx-0.5 rounded border border-amber/50 bg-amber/10 px-1 font-semibold text-ink hover:border-amber hover:bg-amber/20"
          >
            {p.text}
          </button>
        ) : (
          <span key={i} data-testid="ask-figure" className="num font-semibold">
            {p.text}
          </span>
        )
      })}
    </p>
  )
}

function AnswerView({ turn, onAsk, onOpen, onEntry, busy }: {
  turn: Turn
  onAsk: (text: string, picks?: Turn['picks']) => void
  onOpen: (s: Screen) => void
  onEntry: (turn: Turn) => void
  busy: boolean
}): React.JSX.Element {
  const t = useT()
  const [lang] = useLanguage()
  const a = turn.answer
  // WP 10.3: a question Total can't answer also searches the help articles (the glossary stays
  // below as the second source).
  const helpHits = useMemo(() => (a && !a.understood ? HELP.search(turn.text, lang as Language, 3) : []), [a, turn.text, lang])
  return (
    <div className="flex flex-col gap-2" data-testid="ask-turn">
      <div className="max-w-[85%] self-end rounded-lg border border-amber/40 bg-amber/10 px-3 py-2 text-body-sm text-ink" data-testid="ask-question">
        {turn.text}
      </div>
      {!a && !turn.failed && <p className="text-hint text-muted">{t('assist.panel.thinking')}</p>}
      {turn.failed && <p className="text-body-sm text-danger" data-testid="ask-error">{t('assist.panel.error')}</p>}
      {a && (
        <div className="rounded-lg border border-line bg-panel p-3" data-testid="ask-answer" data-intent={a.intent}>
          <div className="flex flex-col gap-1.5">
            {a.sentences.map((s, i) => (
              <Sentence key={i} text={s} figures={a.figures} onOpen={onOpen} />
            ))}
          </div>
          {a.choice && (
            <div className="mt-2 flex flex-wrap gap-2" data-testid="ask-choice">
              {a.choice.options.map((o) => (
                <Button key={o.id} size="sm" variant="secondary" disabled={busy} onClick={() => onAsk(turn.text, { ...turn.picks, [a.choice!.slot]: o.id })}>
                  {o.label}
                  {o.sub ? <span className="ml-1 text-muted">· {o.sub}</span> : null}
                </Button>
              ))}
            </div>
          )}
          {a.entry && a.entry.canDraft && (
            <div className="mt-3">
              <Button size="sm" variant="primary" data-testid="ask-open-entry" disabled={busy} onClick={() => onEntry(turn)}>
                {t('assist.panel.openFlow', { screen: t(FLOW_LABEL[a.entry.prefill.screen]) }) /* i18n-technical: keyed in FLOW_LABEL */}
              </Button>
            </div>
          )}
          {a.links.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {a.links.map((l, i) => {
                const to = askScreen(l.target)
                return to ? (
                  <Button key={i} size="sm" variant="ghost" data-testid="ask-link" onClick={() => onOpen(to)}>
                    {l.label} →
                  </Button>
                ) : null
              })}
            </div>
          )}
          {a.suggestions && (
            <div className="mt-2 flex flex-wrap gap-2" data-testid="ask-suggestions">
              {a.suggestions.map((s) => (
                <Button key={s} size="sm" variant="secondary" disabled={busy} onClick={() => onAsk(s)}>
                  {s}
                </Button>
              ))}
            </div>
          )}
          {!a.understood && helpHits.length > 0 && (
            <div className="mt-3 border-t border-line pt-2" data-testid="ask-help-articles">
              <p className="text-hint font-semibold text-muted">{t('simple.help.fromHelp')}</p>
              <div className="mt-1 flex flex-col items-start gap-1">
                {helpHits.map((h) => (
                  <button
                    key={h.article.id}
                    type="button"
                    data-testid="ask-help-article"
                    data-article={h.article.id}
                    onClick={() => useHelpPanel.getState().openArticle(h.article.id)}
                    className="text-left text-hint text-blue hover:underline"
                  >
                    {h.article.title}
                  </button>
                ))}
              </div>
            </div>
          )}
          {a.help && a.help.length > 0 && (
            <div className="mt-3 border-t border-line pt-2" data-testid="ask-help">
              <p className="text-hint font-semibold text-muted">{t('assist.panel.help')}</p>
              {a.help.map((h) => (
                <p key={h.term} className="mt-1 text-hint text-ink">
                  <span className="font-semibold">{h.plain}</span> — {h.explain}
                </p>
              ))}
            </div>
          )}
          <div className="mt-2">
            <Badge tone="neutral" testId="ask-by-total">
              {t('assist.panel.byTotal')}
            </Badge>
          </div>
        </div>
      )}
    </div>
  )
}

const FLOW_LABEL = {
  'simple-money-out': 'assist.place.moneyOut',
  'simple-money-in': 'assist.place.moneyIn',
  'simple-sell': 'assist.place.makeBill',
  'simple-buy': 'assist.place.recordPurchase'
} as const

const EXAMPLES = ['assist.suggest.owed', 'assist.suggest.profitHinglish', 'assist.suggest.cash', 'assist.suggest.entry'] as const

/**
 * The drawer. `aiReady` = the owner turned the AI assistant on with a key: a question Total
 * doesn't understand is handed to it (`onEscalate`).
 */
export function AskTotalDrawer({ onClose, width, onResize, aiReady, onEscalate }: {
  onClose: () => void
  width: number
  onResize: (w: number) => void
  aiReady: boolean
  onEscalate?: (text: string) => void
}): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  const toast = useToasts()
  const workingDate = useSession((s) => s.workingDate)
  const [lang] = useLanguage()
  const slug = useSession((s) => s.slug)
  const userId = useSession((s) => s.user?.id ?? null)
  const owner = `${slug ?? ''}:${userId ?? '-'}` // i18n-technical
  const storedOwner = useAskTotal((s) => s.owner)
  const storedTurns = useAskTotal((s) => s.turns)
  const turns = storedOwner === owner ? storedTurns : []
  const setTurns = useAskTotal((s) => s.setTurns)
  useEffect(() => useAskTotal.getState().claim(owner), [owner])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const pending = useAskTotal((s) => s.pending)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' })
  }, [turns])

  const open = useCallback(
    (s: Screen) => {
      nav.go(s)
    },
    [nav]
  )

  const ask = useCallback(
    async (q: string, picks?: Turn['picks']): Promise<void> => {
      const question = q.trim()
      if (!question) return
      const id = ++seq
      setTurns((all) => [...all, { id, text: question, ...(picks ? { picks } : {}) }])
      setBusy(true)
      try {
        const answer = await api.assist.ask({ text: question, today: workingDate, ...(picks ? { picks } : {}), lang: lang as Language })
        setTurns((all) => all.map((x) => (x.id === id ? { ...x, answer } : x)))
        const to = askScreen(answer.open)
        if (to) nav.go(to)
        if (!answer.understood && aiReady && onEscalate) onEscalate(question)
      } catch {
        setTurns((all) => all.map((x) => (x.id === id ? { ...x, failed: true } : x)))
      } finally {
        setBusy(false)
      }
    },
    [workingDate, lang, aiReady, onEscalate, nav]
  )

  useEffect(() => {
    if (!pending || busy) return
    const p = useAskTotal.getState().take()
    if (p) void ask(p.text)
  }, [pending, busy, ask])

  /** "Open Money out": store the request as a draft (accountant+), then open the flow pre-filled. */
  const openEntry = async (turn: Turn): Promise<void> => {
    const offer = turn.answer?.entry
    if (!offer) return
    setBusy(true)
    try {
      const d = await api.assist.draft({ text: turn.text, today: workingDate, ...(turn.picks ? { picks: turn.picks } : {}), lang: lang as Language })
      nav.go({ name: d.prefill.screen, ask: { draftId: d.draftId, prefill: d.prefill } } as Screen)
    } catch {
      toast.push('error', t('assist.panel.draftError'))
    } finally {
      setBusy(false)
    }
  }

  const send = (): void => {
    const q = text
    setText('')
    void ask(q)
  }

  const footer = (
    <div className="flex w-full flex-col gap-2">
      <Textarea
        ref={inputRef}
        aria-label={t('assist.panel.inputLabel')}
        data-testid="ask-input"
        rows={2}
        placeholder={t('assist.panel.placeholder')}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            send()
          }
        }}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-hint text-muted">{aiReady ? t('assist.panel.aiNote') : t('assist.panel.offline')}</span>
        <Button variant="primary" size="sm" onClick={send} disabled={!text.trim() || busy} data-testid="ask-send">
          {t('assist.panel.ask')}
        </Button>
      </div>
    </div>
  )

  return (
    <DockedDrawer title={t('assist.panel.title')} subtitle={t('assist.panel.sub')} onClose={onClose} width={width} onResize={onResize} testId="ask-panel" footer={footer}>
      <div className="flex flex-col gap-4" aria-live="polite" data-testid="ask-messages">
        {turns.length === 0 && (
          <div className="flex flex-col gap-2" data-testid="ask-empty">
            <p className="text-body-sm font-semibold text-ink">{t('assist.panel.emptyTitle')}</p>
            <p className="text-hint text-muted">{t('assist.panel.emptyHint')}</p>
            <div className="mt-1 flex flex-wrap gap-2">
              {EXAMPLES.map((k) => (
                <Button key={k} size="sm" variant="secondary" onClick={() => void ask(t(k)) /* i18n-technical: keyed in EXAMPLES */}>
                  {t(k) /* i18n-technical: keyed in EXAMPLES */}
                </Button>
              ))}
            </div>
          </div>
        )}
        {turns.map((turn) => (
          <AnswerView key={turn.id} turn={turn} onAsk={(q, picks) => void ask(q, picks)} onOpen={open} onEntry={(x) => void openEntry(x)} busy={busy} />
        ))}
        <div ref={endRef} />
      </div>
    </DockedDrawer>
  )
}
