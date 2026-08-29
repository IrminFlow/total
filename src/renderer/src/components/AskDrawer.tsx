import { useEffect, useRef, useState } from 'react'
import { useAiStream, type AiDraft, type ToolTrace } from '../lib/useAiStream'
import { useKeyLayer } from '../lib/keyboard'
import { nextDraftId, useAsk, useNav, useScreen, type Screen } from '../state/stores'
import { screenDef } from '../lib/screens'
import { api } from '../lib/client'
import { parseAnswer, type CitationTarget } from '@shared/ai/citations'
import { formatPaise } from '@shared/money'
import type { VoucherKind } from '@shared/domain'
import { Button, Kbd, Modal, Spinner, inputCls } from './ui'

/**
 * "Ask your books" — a right-hand drawer, ⌘J from anywhere.
 *
 * The design point is the sources block under every answer. Tool results stream to the renderer
 * regardless of what the model says about them, so the real rows are rendered from the data, not
 * from the prose. A figure the model invented has nothing underneath it, which is visible at a
 * glance — that is the verification surface, and it is not optional.
 */
export function AskDrawer({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { state, ask, cancel, reset } = useAiStream()
  const [question, setQuestion] = useState('')
  const [payloadOpen, setPayloadOpen] = useState(false)
  const screen = useScreen()
  const takePending = useAsk((s) => s.takePending)
  const inputRef = useRef<HTMLInputElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    // A question handed over by the palette or a screen is asked once, on open. Leaving it in the
    // store would re-ask it every time the drawer reopened.
    const pending = takePending()
    if (pending) void ask(pending, screenDef(screen.name)?.title)
    // Mount only: this is a hand-off, not a subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [state.turns])

  // Esc cancels a running answer first and only closes the drawer on a second press — losing a
  // half-finished answer to a stray Esc would be worse than an extra keystroke.
  useKeyLayer(
    'modal',
    (e) => {
      if (e.key !== 'Escape') return false
      // The payload viewer is a modal over the drawer and owns its own Escape.
      if (payloadOpen) return false
      e.preventDefault()
      if (state.running) cancel()
      else onClose()
      return true
    },
    { opaque: true }
  )

  const submit = (): void => {
    const q = question.trim()
    if (!q || state.running) return
    setQuestion('')
    void ask(q, screenDef(screen.name)?.title)
  }

  return (
    <aside
      data-testid="ask-drawer"
      className="flex w-[420px] shrink-0 flex-col border-l border-line bg-panel"
      aria-label="Ask your books"
    >
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <p className="text-detail font-medium">Ask your books</p>
        <div className="flex items-center gap-2">
          {state.turns.length > 0 && (
            <button className="text-hint text-muted hover:text-ink" onClick={reset}>
              Clear
            </button>
          )}
          <button className="text-hint text-muted hover:text-ink" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {state.turns.length === 0 ? (
          <div className="text-body-sm text-muted">
            <p>Questions about this company&rsquo;s books, answered from the books themselves.</p>
            <ul className="mt-3 flex flex-col gap-1.5">
              {[
                'Who owes me the most right now?',
                'What did I sell last quarter?',
                'Why is my cash balance lower than last month?',
                'What is blocking my GSTR-1 this period?'
              ].map((example) => (
                <li key={example}>
                  <button
                    className="text-left text-blue hover:underline"
                    onClick={() => {
                      setQuestion(example)
                      inputRef.current?.focus()
                    }}
                  >
                    {example}
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-hint text-muted/80">
              Every figure is quoted from a report, with the rows shown underneath. The assistant
              cannot change anything.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {state.turns.map((turn, i) => (
              <div key={i}>
                {turn.role === 'user' ? (
                  <p className="rounded-md bg-panel2 px-3 py-2 text-detail">{turn.content}</p>
                ) : (
                  <div>
                    {turn.content && <Answer text={turn.content} />}
                    {!turn.content && !turn.error && state.running && (
                      <p className="flex items-center gap-2 text-body-sm text-muted">
                        <Spinner /> Reading the books…
                      </p>
                    )}
                    {turn.error && (
                      <p className="rounded-md border border-cr/40 bg-cr/10 px-3 py-2 text-body-sm text-cr">
                        {turn.error}
                      </p>
                    )}
                    {turn.draft && <DraftCard draft={turn.draft} onClose={onClose} />}
                    {turn.tools && turn.tools.length > 0 && <Sources tools={turn.tools} />}
                  </div>
                )}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <div className="border-t border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            data-testid="input-ask"
            className={inputCls}
            value={question}
            placeholder="Ask about these books…"
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              }
            }}
          />
          {state.running ? (
            <Button onClick={cancel}>Stop</Button>
          ) : (
            <Button variant="primary" data-testid="btn-ask" disabled={!question.trim()} onClick={submit}>
              Ask
            </Button>
          )}
        </div>
        <div className="mt-2 flex items-center justify-between gap-2 text-caption text-muted">
          <p className="flex items-center gap-2">
            {state.endpoint ? (
              <>
                <span className="num">{state.endpoint.model}</span>
                <span>·</span>
                <span className="num">{state.endpoint.local ? 'on this machine' : state.endpoint.host}</span>
                {state.usage && (
                  <>
                    <span>·</span>
                    <span className="num">
                      {state.usage.promptTokens} in / {state.usage.completionTokens} out
                    </span>
                  </>
                )}
                {/* Cost is shown only when there is one. On a local endpoint the honest figure is
                    nothing, and printing "0.00" invites the reader to wonder what it counts. */}
                {state.spend && !state.endpoint.local && (
                  <>
                    <span>·</span>
                    <span className="num" data-testid="ai-spend">
                      ≈{formatPaise(state.spend.sessionPaise)} this session
                    </span>
                  </>
                )}
              </>
            ) : (
              <>
                <Kbd>⌘J</Kbd> opens this anywhere · <Kbd>Esc</Kbd> stops an answer
              </>
            )}
          </p>
          <button
            className="shrink-0 underline decoration-dotted underline-offset-2 hover:text-ink"
            data-testid="btn-ai-payload"
            onClick={() => setPayloadOpen(true)}
          >
            What gets sent
          </button>
        </div>
      </div>

      {payloadOpen && (
        <PayloadViewer
          // What is in the box if anything, else the last thing actually asked. A viewer that
          // shows "(your question)" after a conversation has happened answers a question nobody
          // has: what matters is what a follow-up in THIS conversation would carry.
          question={question.trim() || [...state.turns].reverse().find((t) => t.role === 'user')?.content || ''}
          history={state.turns.filter((t) => !t.error).map((t) => ({ role: t.role, content: t.content }))}
          onClose={() => setPayloadOpen(false)}
        />
      )}
    </aside>
  )
}

/**
 * An answer with its citations turned into links.
 *
 * The refs come from the tool rows, so a link here always lands on a screen that recomputes the
 * figure from the books. That is the difference between a citation and a footnote: the reader can
 * go and disagree with it. An unrecognised ref is left as literal text by the parser — a model
 * that invents "[q4:99]" produces a visible dead string rather than a link to nowhere.
 */
function Answer({ text }: { text: string }): React.JSX.Element {
  const nav = useNav()
  const go = (target: CitationTarget): void => {
    if (target.kind === 'ledger') nav.go({ name: 'ledger-statement', ledgerId: target.ledgerId })
    else if (target.kind === 'voucher') nav.go({ name: 'voucher-entry', voucherId: target.voucherId })
    else if (target.kind === 'stock-item') nav.go({ name: 'stock-summary' })
    else if (target.kind === 'registers') nav.go({ name: 'registers' })
    else nav.go({ name: 'exceptions' })
  }

  return (
    <p className="text-detail whitespace-pre-wrap">
      {parseAnswer(text).map((segment, i) =>
        segment.type === 'text' ? (
          <span key={i}>{segment.text}</span>
        ) : (
          <button
            key={i}
            data-testid="ai-citation"
            title={`Open the ${segment.label} this figure came from`}
            className="mx-0.5 rounded-md border border-line bg-panel2 px-1 text-caption text-blue hover:underline"
            onClick={() => go(segment.target)}
          >
            {segment.ref}
          </button>
        )
      )}
    </p>
  )
}

/**
 * The voucher-entry screen a draft opens, with the lines pre-filled.
 *
 * Exported and pure so the mapping is tested rather than eyeballed: paise are paise on both
 * sides of it, and `aiRunId` is what lets a SAVED voucher be joined back to the question that
 * produced it (roadmap #217). A silent unit change here would put a hundredfold amount in front
 * of someone about to press Save.
 */
export function screenForDraft(draft: AiDraft): Screen {
  return {
    name: 'voucher-entry',
    kindHint: draft.draft.kind as VoucherKind,
    draft: {
      date: draft.draft.date,
      narration: draft.draft.narration,
      partyLedgerId: draft.draft.partyLedgerId,
      lines: draft.draft.lines.map((l) => ({ ledgerId: l.ledgerId, drCr: l.drCr, amount: l.amountPaise })),
      aiRunId: draft.runId
    },
    draftId: nextDraftId()
  }
}

/**
 * A proposed voucher.
 *
 * Nothing on this card saves anything. The button opens the ordinary voucher screen with the
 * lines filled in, where the ordinary validation runs and the ordinary Save button is under the
 * ordinary person's hand — which is the whole reason the assistant is allowed to propose at all.
 */
function DraftCard({ draft, onClose }: { draft: AiDraft; onClose: () => void }): React.JSX.Element {
  const nav = useNav()
  const blocking = draft.issues.filter((i) => i.severity === 'blocking')

  const open = (): void => {
    onClose()
    nav.go(screenForDraft(draft))
  }

  return (
    <div className="mt-2 rounded-md border border-line bg-panel2 p-3" data-testid="ai-draft">
      <p className="text-caption font-semibold tracking-[0.08em] text-muted uppercase">Draft — nothing is saved</p>
      <p className="mt-1.5 text-detail">{draft.summary}</p>
      <table className="mt-2 w-full text-body-sm">
        <tbody>
          {draft.draft.lines.map((line, i) => (
            <tr key={i}>
              <td className="py-0.5">{line.ledgerName}</td>
              <td className="py-0.5 text-caption text-muted">{line.drCr === 'dr' ? 'Dr' : 'Cr'}</td>
              <td className="num py-0.5 text-right">{formatPaise(line.amountPaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {draft.issues.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {draft.issues.map((issue, i) => (
            <li
              key={i}
              className={issue.severity === 'blocking' ? 'text-body-sm text-cr' : 'text-body-sm text-warn'}
            >
              {issue.message}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex justify-end">
        <Button
          variant="primary"
          data-testid="btn-ai-draft-open"
          disabled={!draft.openable || blocking.length > 0}
          onClick={open}
        >
          Open in voucher entry
        </Button>
      </div>
    </div>
  )
}

/**
 * "Show me exactly what would be sent."
 *
 * Built in main by the same code that builds a real request, and shown without sending anything —
 * it works with no key, no network and a misconfigured endpoint, which is the state a person is
 * in when they are deciding whether to configure this at all.
 */
function PayloadViewer({
  question,
  history,
  onClose
}: {
  question: string
  history: { role: 'user' | 'assistant'; content: string }[]
  onClose: () => void
}): React.JSX.Element {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.ai.preview>> | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.ai
      .preview({ question: question.trim() || undefined, history })
      .then(setData)
      .catch((err: Error) => setError(err.message))
    // The payload is a snapshot taken when the viewer opened; re-fetching it as the conversation
    // moves underneath would show something the user never asked about.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question])

  return (
    <Modal title="What gets sent" onClose={onClose} wide>
      {error && <p className="text-body-sm text-cr">{error}</p>}
      {!data && !error && <Spinner />}
      {data && (
        <div data-testid="ai-payload" className="flex flex-col gap-4">
          <p className="text-body-sm text-muted">
            {data.payload.local ? (
              <>
                <b className="text-ink num">{data.payload.host}</b> runs on this computer, so this leaves nothing.
              </>
            ) : (
              <>
                This is the whole of what would go to <b className="text-ink num">{data.payload.host}</b> when you ask —{' '}
                <span className="num">{data.payload.characters.toLocaleString('en-IN')}</span> characters, about{' '}
                <span className="num">{formatPaise(data.payload.estimatedCostPaise)}</span>. Rows from your books are
                added only as the assistant reads them, and each one is redacted first.
              </>
            )}
          </p>

          {data.payload.messages.map((message, i) => (
            <div key={i} className="rounded-md border border-line bg-panel2 p-2">
              <p className="text-caption font-semibold tracking-wide text-muted uppercase">{message.role}</p>
              <pre className="mt-1 max-h-56 overflow-auto font-mono text-label leading-relaxed break-words whitespace-pre-wrap">
                {message.content}
              </pre>
            </div>
          ))}

          <div>
            <p className="text-caption font-semibold tracking-[0.08em] text-muted uppercase">
              Tools the assistant may call
            </p>
            <p className="mt-1 text-body-sm text-muted">
              {data.payload.tools.join(', ')} — every one of them reads. There is no tool that writes.
            </p>
          </div>

          <RedactionPreview data={data} />
        </div>
      )}
    </Modal>
  )
}

/** What is stripped from every row before it can leave, run through the real redactor. */
function RedactionPreview({ data }: { data: Awaited<ReturnType<typeof api.ai.preview>> }): React.JSX.Element {
  return (
    <div data-testid="ai-redaction">
      <p className="text-caption font-semibold tracking-[0.08em] text-muted uppercase">Never sent</p>
      <table className="mt-2 w-full text-body-sm">
        <thead>
          <tr className="text-caption text-muted">
            <th className="py-1 text-left font-medium">Field</th>
            <th className="py-1 text-left font-medium">In your books</th>
            <th className="py-1 text-left font-medium">What leaves</th>
          </tr>
        </thead>
        <tbody>
          {data.redaction.withheld.map((field) => (
            <tr key={field.field} className="border-t border-line">
              <td className="num py-1">{field.field}</td>
              <td className="num py-1 text-muted line-through">{field.before}</td>
              <td className="num py-1">{field.after}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-hint text-muted">
        This table is produced by running a sample row through the same function every tool result
        passes through. It is not a description of the rules — it is the rules, executed.
      </p>
    </div>
  )
}

/**
 * The rows behind an answer, rendered from the tool results themselves. This is what makes an
 * unbacked number visible: the model's prose and this table come from different places.
 */
function Sources({ tools }: { tools: ToolTrace[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const withResults = tools.filter((t) => t.result !== undefined)

  return (
    <div className="mt-2">
      <button
        className="text-hint text-muted hover:text-ink"
        data-testid="btn-toggle-sources"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? '▾' : '▸'} {withResults.length} source{withResults.length === 1 ? '' : 's'}
      </button>
      {open && (
        <div className="mt-1.5 flex flex-col gap-2">
          {withResults.map((t, i) => (
            <div key={i} className="rounded-md border border-line bg-panel2 p-2">
              <p className="num text-caption text-muted">{t.name}</p>
              <pre className="mt-1 max-h-40 overflow-auto font-mono text-label leading-relaxed break-words whitespace-pre-wrap">
                {JSON.stringify(t.result, null, 1)}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
