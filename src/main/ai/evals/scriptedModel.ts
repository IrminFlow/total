// WP 5.8 — the mocked model of the evaluation suite: each case's ROUTE (types.ts) is turned into a
// MockProvider script. Step n of the route answers model call n of the turn; a step either asks for
// tool calls (arguments may depend on earlier results) or gives the final answer, built from the
// tool results the mock actually received in the request — masked / pseudonymised exactly as a
// real model would see them, so the numbers check, the alias mapping and the outbound log are all
// exercised for real.
import type { ChatItem, ChatRequest } from '../types'
import { MockProvider, type MockStep } from '../mockProvider'
import type { EvalFixture } from './fixture'
import type { Route, RouteCtx, SeenToolResult } from './types'

/** This turn's tool results in a request (everything after the last user message). */
export function turnResults(input: readonly ChatItem[]): SeenToolResult[] {
  let at = -1
  for (let i = input.length - 1; i >= 0; i--) {
    const it = input[i]!
    if (it.type === 'message' && it.role === 'user') {
      at = i
      break
    }
  }
  const names = new Map<string, string>()
  const out: SeenToolResult[] = []
  for (const it of input.slice(at + 1)) {
    if (it.type === 'tool_call') names.set(it.callId, it.name)
    if (it.type !== 'tool_result') continue
    let parsed: { ok?: boolean; result?: unknown; error?: string } = {}
    try {
      parsed = JSON.parse(it.output) as typeof parsed
    } catch {
      parsed = { ok: false, error: 'unreadable (trimmed) result' }
    }
    out.push({ name: names.get(it.callId) ?? '?', ok: parsed.ok === true, result: parsed.result, error: parsed.error, text: it.output })
  }
  return out
}

export function routeCtx(req: ChatRequest, f: EvalFixture, question: string): RouteCtx {
  const results = turnResults(req.input)
  const lastUser = [...req.input].reverse().find((it) => it.type === 'message' && it.role === 'user') as { content: string } | undefined
  return {
    f,
    question,
    sentQuestion: lastUser?.content ?? '',
    results,
    instructions: req.instructions,
    last: (name) => [...results].reverse().find((r) => r.name === name)?.result
  }
}

/** The MockProvider that plays `route` for one turn. A route that runs out answers with an error
 *  step (the case fails loudly instead of hanging). */
export function routeProvider(route: Route, f: EvalFixture, question: string, model: string): MockProvider {
  return new MockProvider(
    (req, index): MockStep => {
      const step = route[index]
      if (!step) return { error: `eval route has no step #${index + 1}` }
      const ctx = routeCtx(req, f, question)
      if ('calls' in step) return { toolCalls: step.calls(ctx), model }
      return { text: step.answer(ctx), model }
    },
    { models: [model], chunk: 64 }
  )
}
