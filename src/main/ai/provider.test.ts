// The OpenAI adapter against a fake SDK client: request shape, streamed deltas, tool calls,
// usage, retries with backoff (only before anything streamed), cancellation and key redaction.
import { describe, expect, it } from 'vitest'
import OpenAI from 'openai'
import { OpenAiProvider, buildResponsesBody, redactSecrets, type OpenAiLike } from './provider'
import { AiAbortError, AiProviderError, type ChatRequest } from './types'
import { MockProvider } from './mockProvider'

const KEY = 'sk-test-abcdefghijklmnopqrstuvwxyz0123456789'

async function* events(list: Record<string, unknown>[], opts: { failAfter?: number; err?: unknown; signal?: AbortSignal } = {}): AsyncGenerator<Record<string, unknown>> {
  for (let i = 0; i <= list.length; i++) {
    if (opts.failAfter !== undefined && i === opts.failAfter) throw opts.err
    if (i === list.length) return
    if (opts.signal?.aborted) throw new OpenAI.APIUserAbortError()
    yield list[i]!
  }
}

function fakeClient(attempts: ((body: Record<string, unknown>, signal?: AbortSignal) => AsyncIterable<Record<string, unknown>>)[], models: string[] = []): OpenAiLike & { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = []
  let n = 0
  return {
    bodies,
    responses: {
      create: async (body, opts) => {
        bodies.push(body)
        const a = attempts[Math.min(n++, attempts.length - 1)]!
        return a(body, opts?.signal)
      }
    },
    models: {
      list: () =>
        (async function* () {
          for (const id of models) yield { id }
        })()
    }
  }
}

const REQ: ChatRequest = {
  model: 'gpt-6.1-sol',
  instructions: 'sys',
  input: [
    { type: 'message', role: 'user', content: 'hi' },
    { type: 'tool_call', callId: 'c1', name: 'trial_balance', arguments: '{"asOn":"2025-07-31"}' },
    { type: 'tool_result', callId: 'c1', output: '{"ok":true}' }
  ],
  tools: [{ name: 'trial_balance', description: 'TB', parameters: { type: 'object', properties: {} } }]
}

const COMPLETED = {
  type: 'response.completed',
  response: { model: 'gpt-6.1-sol-2026', usage: { input_tokens: 1200, output_tokens: 80, input_tokens_details: { cached_tokens: 1000 }, output_tokens_details: { reasoning_tokens: 30 } } }
}

describe('OpenAiProvider', () => {
  it('builds a Responses API request: streamed, not stored, tools as functions, history items mapped', () => {
    const body = buildResponsesBody({ ...REQ, responseFormat: { name: 'answer', schema: { type: 'object' } }, maxOutputTokens: 500 })
    expect(body).toMatchObject({ model: 'gpt-6.1-sol', instructions: 'sys', stream: true, store: false, tool_choice: 'auto', max_output_tokens: 500 })
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'function_call', call_id: 'c1', name: 'trial_balance', arguments: '{"asOn":"2025-07-31"}' },
      { type: 'function_call_output', call_id: 'c1', output: '{"ok":true}' }
    ])
    expect(body.tools).toEqual([{ type: 'function', name: 'trial_balance', description: 'TB', parameters: { type: 'object', properties: {} }, strict: false }])
    expect(body.text).toEqual({ format: { type: 'json_schema', name: 'answer', schema: { type: 'object' }, strict: true } })
    expect(buildResponsesBody({ ...REQ, tools: [] }).tools).toBeUndefined()
  })

  it('streams text deltas, collects tool calls and usage', async () => {
    const client = fakeClient([
      () =>
        events([
          { type: 'response.created' },
          { type: 'response.output_text.delta', delta: 'Let me ' },
          { type: 'response.output_text.delta', delta: 'check.' },
          { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_9', name: 'trial_balance', arguments: '{"asOn":"2025-07-31"}' } },
          COMPLETED
        ])
    ])
    const p = new OpenAiProvider({ apiKey: KEY, client })
    const deltas: string[] = []
    const r = await p.chat(REQ, { onTextDelta: (d) => deltas.push(d) })
    expect(deltas).toEqual(['Let me ', 'check.'])
    expect(r).toEqual({
      text: 'Let me check.',
      toolCalls: [{ callId: 'call_9', name: 'trial_balance', arguments: '{"asOn":"2025-07-31"}' }],
      usage: { inputTokens: 1200, cachedTokens: 1000, outputTokens: 80, reasoningTokens: 30 },
      model: 'gpt-6.1-sol-2026',
      finish: 'tool_calls'
    })
  })

  it('retries a retryable failure (429 / 5xx / network) with exponential backoff before anything streamed', async () => {
    const waits: number[] = []
    const rateLimited = new OpenAI.RateLimitError(429, { message: 'slow down' }, 'slow down', new Headers())
    const client = fakeClient([
      () => events([], { failAfter: 0, err: rateLimited }),
      () => events([], { failAfter: 0, err: new OpenAI.APIConnectionError({ message: 'reset' }) }),
      () => events([{ type: 'response.output_text.delta', delta: 'ok' }, COMPLETED])
    ])
    const p = new OpenAiProvider({ apiKey: KEY, client, backoffMs: 100, random: () => 0, sleep: async (ms) => void waits.push(ms) })
    const r = await p.chat(REQ)
    expect(r.text).toBe('ok')
    expect(waits).toEqual([100, 200])
    expect(client.bodies).toHaveLength(3)
  })

  it('does not retry after text has streamed, nor on a 4xx; errors are redacted', async () => {
    const midStream = fakeClient([
      () => events([{ type: 'response.output_text.delta', delta: 'partial' }, COMPLETED], { failAfter: 1, err: new OpenAI.InternalServerError(500, {}, 'boom', new Headers()) })
    ])
    const p1 = new OpenAiProvider({ apiKey: KEY, client: midStream, sleep: async () => {} })
    await expect(p1.chat(REQ)).rejects.toBeInstanceOf(AiProviderError)
    expect(midStream.bodies).toHaveLength(1)

    const bad = new OpenAI.AuthenticationError(401, {}, `Incorrect API key provided: ${KEY}`, new Headers())
    const unauthorised = fakeClient([() => events([], { failAfter: 0, err: bad })])
    const p2 = new OpenAiProvider({ apiKey: KEY, client: unauthorised, sleep: async () => {} })
    const err = await p2.chat(REQ).catch((e: Error) => e)
    expect(unauthorised.bodies).toHaveLength(1)
    expect(String((err as Error).message)).toMatch(/rejected the API key/)
    expect(String((err as Error).message)).not.toContain(KEY)
  })

  it('surfaces a failed response and redacts any key-shaped text in it', async () => {
    const client = fakeClient([() => events([{ type: 'response.failed', response: { error: { message: `bad key ${KEY}`, code: 'invalid' } } }])])
    const err = await new OpenAiProvider({ apiKey: KEY, client }).chat(REQ).catch((e: Error) => e)
    expect((err as Error).message).toBe('bad key [redacted key]')
  })

  it('stops on abort with AiAbortError', async () => {
    const ctrl = new AbortController()
    const client = fakeClient([
      (_b, signal) =>
        (async function* () {
          yield { type: 'response.output_text.delta', delta: 'a' }
          ctrl.abort()
          if (signal?.aborted) throw new OpenAI.APIUserAbortError()
          yield { type: 'response.output_text.delta', delta: 'b' }
        })()
    ])
    await expect(new OpenAiProvider({ apiKey: KEY, client }).chat({ ...REQ, signal: ctrl.signal })).rejects.toBeInstanceOf(AiAbortError)
  })

  it('lists models (sorted)', async () => {
    const client = fakeClient([], ['gpt-6-luna', 'gpt-6.1-sol', 'a-model'])
    expect(await new OpenAiProvider({ apiKey: KEY, client }).models()).toEqual(['a-model', 'gpt-6-luna', 'gpt-6.1-sol'])
  })
})

describe('redactSecrets', () => {
  it('removes the key, key-shaped tokens and bearer tokens', () => {
    expect(redactSecrets(`x ${KEY} y`, KEY)).toBe('x [redacted key] y')
    expect(redactSecrets('use sk-proj-ABCDEFGHIJKLMNOP now')).toBe('use sk-…[redacted] now')
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnop')).toBe('Authorization: Bearer [redacted]')
  })
})

describe('MockProvider', () => {
  it('replays a script deterministically, streams text and records requests', async () => {
    const m = new MockProvider([{ toolCalls: [{ name: 'trial_balance', arguments: { asOn: '2025-07-31' } }] }, { text: 'Done here.' }], { chunk: 4 })
    const first = await m.chat(REQ)
    expect(first.toolCalls).toEqual([{ callId: 'call_1_1', name: 'trial_balance', arguments: '{"asOn":"2025-07-31"}' }])
    const deltas: string[] = []
    const second = await m.chat(REQ, { onTextDelta: (d) => deltas.push(d) })
    expect(second.text).toBe('Done here.')
    expect(deltas).toEqual(['Done', ' her', 'e.'])
    expect(m.requests).toHaveLength(2)
    await expect(m.chat(REQ)).rejects.toThrow(/no scripted step #3/)
  })
})
