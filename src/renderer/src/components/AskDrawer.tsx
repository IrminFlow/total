import { useEffect, useRef, useState } from 'react'
import { useAiStream, type ToolTrace } from '../lib/useAiStream'
import { useKeyLayer } from '../lib/keyboard'
import { useScreen } from '../state/stores'
import { screenDef } from '../lib/screens'
import { Button, Kbd, Spinner, inputCls } from './ui'

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
  const screen = useScreen()
  const inputRef = useRef<HTMLInputElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
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
                    {turn.content && <p className="text-detail whitespace-pre-wrap">{turn.content}</p>}
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
        <p className="mt-2 flex items-center gap-2 text-caption text-muted">
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
            </>
          ) : (
            <>
              <Kbd>⌘J</Kbd> opens this anywhere
            </>
          )}
        </p>
      </div>
    </aside>
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
              <pre className="num mt-1 max-h-40 overflow-auto text-label leading-relaxed whitespace-pre-wrap">
                {JSON.stringify(t.result, null, 1)}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
