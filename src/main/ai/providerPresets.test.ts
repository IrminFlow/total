// Phase 3a: the provider factory per preset through the REAL OpenAI SDK client with a mocked
// HTTP layer (an injected fetch — nothing reaches the network): the URL each preset calls, the
// key / no-key Authorization, custom headers, Chat Completions streaming (text, tool calls in
// pieces, usage), capability refusals before anything is sent, a "not supported" error in plain
// words, and the stream_options fallback.
import { describe, expect, it } from 'vitest'
import { AI_PRESETS, AiCapabilityError, resolveAiProvider, type AiPresetId } from '@shared/aiProviders'
import { NO_KEY, buildChatBody, createProvider, toChatMessages, unmetNeed } from './provider'
import { FIXED_ENDPOINTS } from './providerConfig'
import { AiProviderError, type ChatRequest } from './types'

const KEY = 'gsk-test-abcdefghijklmnopqrstuvwxyz0123'

interface Seen {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown> | null
}

function sse(chunks: unknown[]): Response {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** A fetch that records each request and answers from `reply`. */
function mockFetch(reply: (seen: Seen, n: number) => Response): { fetch: (url: string, init?: Record<string, unknown>) => Promise<Response>; seen: Seen[] } {
  const seen: Seen[] = []
  return {
    seen,
    fetch: async (url, init) => {
      const h = new Headers((init?.headers as HeadersInit) ?? {})
      const headers: Record<string, string> = {}
      h.forEach((v, k) => (headers[k] = v))
      const raw = init?.body
      const s: Seen = { url: String(url), method: String(init?.method ?? 'GET'), headers, body: typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : null }
      seen.push(s)
      return reply(s, seen.length)
    }
  }
}

const REQ: ChatRequest = {
  model: 'm-1',
  instructions: 'sys',
  input: [
    { type: 'message', role: 'user', content: 'TB total?' },
    { type: 'message', role: 'assistant', content: 'Checking.' },
    { type: 'tool_call', callId: 'c1', name: 'trial_balance', arguments: '{"asOn":"2025-07-31"}' },
    { type: 'tool_result', callId: 'c1', output: '{"total":"₹1,50,000.00"}' },
    { type: 'reasoning', item: { type: 'reasoning', id: 'rs_1' } }
  ],
  tools: [{ name: 'trial_balance', description: 'TB', parameters: { type: 'object', properties: {} } }]
}

const resolved = (preset: AiPresetId, baseUrl: string | null = null, caps = null as null | (typeof AI_PRESETS)['custom']['caps']) =>
  resolveAiProvider({ preset, baseUrl, caps }, FIXED_ENDPOINTS)

const CHAT_STREAM = [
  { id: 'x', object: 'chat.completion.chunk', model: 'm-1-0001', choices: [{ index: 0, delta: { role: 'assistant', content: 'Let me ' } }] },
  { id: 'x', object: 'chat.completion.chunk', model: 'm-1-0001', choices: [{ index: 0, delta: { content: 'check.' } }] },
  { id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_7', type: 'function', function: { name: 'trial_', arguments: '{"asOn":' } }] } }] },
  { id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'balance', arguments: '"2025-07-31"}' } }] } }] },
  { id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  { id: 'x', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 900, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 0 } } }
]

describe('createProvider per preset (mocked HTTP)', () => {
  const cases: [AiPresetId, string][] = [
    ['openrouter', 'https://openrouter.ai/api/v1/chat/completions'],
    ['groq', 'https://api.groq.com/openai/v1/chat/completions'],
    ['gemini', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions']
  ]
  for (const [preset, url] of cases) {
    it(`${preset}: Chat Completions at its own endpoint with the key as a bearer`, async () => {
      const m = mockFetch(() => sse(CHAT_STREAM))
      const p = createProvider(resolved(preset), KEY, {}, { fetch: m.fetch, sleep: async () => {} })
      expect(p.name).toBe(preset)
      const deltas: string[] = []
      const r = await p.chat(REQ, { onTextDelta: (d) => deltas.push(d) })
      expect(m.seen).toHaveLength(1)
      expect(m.seen[0]).toMatchObject({ url, method: 'POST' })
      expect(m.seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`)
      expect(deltas).toEqual(['Let me ', 'check.'])
      expect(r).toEqual({
        text: 'Let me check.',
        toolCalls: [{ callId: 'call_7', name: 'trial_balance', arguments: '{"asOn":"2025-07-31"}' }],
        usage: { inputTokens: 900, cachedTokens: 100, outputTokens: 40, reasoningTokens: 0 },
        model: 'm-1-0001',
        finish: 'tool_calls',
        reasoning: []
      })
    })
  }

  it('openai keeps the Responses API at api.openai.com (unchanged for existing users)', async () => {
    const m = mockFetch(() =>
      new Response(
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { model: 'm-1', usage: { input_tokens: 5, output_tokens: 1 } } })}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )
    )
    const p = createProvider(resolved('openai'), KEY, {}, { fetch: m.fetch })
    expect(p.name).toBe('openai')
    const r = await p.chat({ ...REQ, tools: [] })
    expect(r.text).toBe('ok')
    expect(m.seen[0]!.url).toBe('https://api.openai.com/v1/responses')
    expect(m.seen[0]!.body).toMatchObject({ store: false, stream: true, include: ['reasoning.encrypted_content'] })
  })

  it('ollama / lmstudio: localhost, no key needed (a placeholder bearer), long timeouts', async () => {
    for (const [preset, url] of [['ollama', 'http://localhost:11434/v1/chat/completions'], ['lmstudio', 'http://127.0.0.1:1234/v1/chat/completions']] as const) {
      const m = mockFetch(() => sse(CHAT_STREAM.slice(0, 2)))
      const p = createProvider(resolved(preset, preset === 'lmstudio' ? 'http://127.0.0.1:1234/v1' : null), null, {}, { fetch: m.fetch })
      const r = await p.chat({ ...REQ, tools: [] })
      expect(r.text).toBe('Let me check.')
      expect(m.seen[0]!.url).toBe(url)
      expect(m.seen[0]!.headers.authorization).toBe(`Bearer ${NO_KEY}`)
    }
  })

  it('custom: its address, its own headers, the caps the user declared', async () => {
    const m = mockFetch(() => sse(CHAT_STREAM.slice(0, 2)))
    const caps = { tools: false, structured: false, images: false, files: false }
    const p = createProvider(resolved('custom', 'https://llm.example.com/openai/v1', caps), null, { 'X-Api-Key': 'gateway-secret' }, { fetch: m.fetch })
    await p.chat({ ...REQ, tools: [] })
    expect(m.seen[0]!.url).toBe('https://llm.example.com/openai/v1/chat/completions')
    expect(m.seen[0]!.headers['x-api-key']).toBe('gateway-secret')
    // Declared unable: refused before any request.
    await expect(p.chat(REQ)).rejects.toBeInstanceOf(AiCapabilityError)
    expect(m.seen).toHaveLength(1)
  })

  it('a hosted preset without a key is refused before anything is built', () => {
    expect(() => createProvider(resolved('groq'), null)).toThrow(/No API key for Groq/)
    expect(() => createProvider(resolved('custom'), null)).toThrow(/address/)
  })

  it('lists models from {base}/models', async () => {
    const m = mockFetch(() => new Response(JSON.stringify({ object: 'list', data: [{ id: 'qwen2.5:14b', object: 'model' }, { id: 'llama3.2:3b', object: 'model' }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const ids = await createProvider(resolved('ollama'), null, {}, { fetch: m.fetch }).models()
    expect(ids).toEqual(['llama3.2:3b', 'qwen2.5:14b'])
    expect(m.seen[0]!.url).toBe('http://localhost:11434/v1/models')
  })
})

describe('capability fallbacks', () => {
  const photo: ChatRequest = {
    model: 'm', instructions: 'x', tools: [], responseFormat: { name: 'bill', schema: { type: 'object' } },
    input: [{ type: 'message', role: 'user', content: 'read', attachments: [{ kind: 'image', mime: 'image/png', base64: 'iVBOR' }] }]
  }
  const pdf: ChatRequest = { ...photo, input: [{ type: 'message', role: 'user', content: 'read', attachments: [{ kind: 'file', mime: 'application/pdf', base64: 'JVBER', filename: 'bill.pdf' }] }] }

  it('unmetNeed names what a request needs that the endpoint lacks', () => {
    const all = { tools: true, structured: true, images: true, files: true }
    expect(unmetNeed(REQ, all)).toBeNull()
    expect(unmetNeed(REQ, { ...all, tools: false })).toBe('tools')
    expect(unmetNeed({ ...REQ, tools: [] }, { ...all, tools: false })).toBeNull()
    expect(unmetNeed(photo, { ...all, structured: false })).toBe('structured')
    expect(unmetNeed(photo, { ...all, images: false })).toBe('images')
    expect(unmetNeed(pdf, { ...all, files: false })).toBe('files')
    expect(unmetNeed(pdf, { ...all, images: false })).toBeNull()
  })

  it('Groq / Gemini / local presets refuse a scanned PDF in plain words, before sending', async () => {
    for (const preset of ['groq', 'gemini', 'ollama', 'lmstudio'] as const) {
      const m = mockFetch(() => sse([]))
      const p = createProvider(resolved(preset), KEY, {}, { fetch: m.fetch })
      const err = await p.chat(pdf).catch((e: Error) => e)
      expect(err).toBeInstanceOf(AiCapabilityError)
      expect((err as Error).message).toMatch(/can’t read PDF files that are scans/)
      expect(m.seen).toHaveLength(0)
    }
  })

  it('a model that answers "does not support tools" becomes the plain message (not retried)', async () => {
    const m = mockFetch(() => new Response(JSON.stringify({ error: { message: 'registry.ollama.ai/library/gemma:2b does not support tools', type: 'api_error' } }), { status: 400, headers: { 'content-type': 'application/json' } }))
    const err = await createProvider(resolved('ollama'), null, {}, { fetch: m.fetch, sleep: async () => {} }).chat(REQ).catch((e: Error) => e)
    expect(err).toBeInstanceOf(AiProviderError)
    expect((err as Error).message).toMatch(/^This AI service can’t use Total’s tools/)
    expect((err as Error).message).toContain('does not support tools')
    expect(m.seen).toHaveLength(1)
  })

  it('a server that refuses stream_options is asked again without it (usage then unknown)', async () => {
    const m = mockFetch((_s, n) =>
      n === 1 ? new Response(JSON.stringify({ error: { message: 'Unrecognized request argument supplied: stream_options' } }), { status: 400, headers: { 'content-type': 'application/json' } }) : sse(CHAT_STREAM.slice(0, 2))
    )
    const r = await createProvider(resolved('custom', 'https://llm.example.com/v1'), null, {}, { fetch: m.fetch, sleep: async () => {} }).chat({ ...REQ, tools: [] })
    expect(r.text).toBe('Let me check.')
    expect(m.seen[0]!.body!.stream_options).toEqual({ include_usage: true })
    expect(m.seen[1]!.body!.stream_options).toBeUndefined()
    expect(r.usage.inputTokens).toBe(0)
  })
})

describe('Chat Completions stream details (review of #210)', () => {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null): Record<string, unknown> => ({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })

  it('Gemini: extra_content (thought signature) is kept on the call and sent back next step', async () => {
    const sig = { google: { thought_signature: 'c2lnLTEyMw==' } }
    const m = mockFetch(() => sse([chunk({ tool_calls: [{ index: 0, id: 'g1', type: 'function', function: { name: 'trial_balance', arguments: '{}' }, extra_content: sig }] }, 'tool_calls')]))
    const p = createProvider(resolved('gemini'), KEY, {}, { fetch: m.fetch })
    const r = await p.chat(REQ)
    expect(r.toolCalls).toEqual([{ callId: 'g1', name: 'trial_balance', arguments: '{}', extra: sig }])
    const next = toChatMessages('s', [{ type: 'message', role: 'user', content: 'q' }, { type: 'tool_call', callId: 'g1', name: 'trial_balance', arguments: '{}', extra: sig }, { type: 'tool_result', callId: 'g1', output: '{}' }])
    expect(next[2]).toEqual({ role: 'assistant', content: null, tool_calls: [{ id: 'g1', type: 'function', function: { name: 'trial_balance', arguments: '{}' }, extra_content: sig }] })
  })

  it('a name repeated in every chunk is not doubled; a continuation chunk without index joins the call in progress', async () => {
    const m = mockFetch(() =>
      sse([
        chunk({ tool_calls: [{ index: 0, id: 'a', function: { name: 'trial_balance', arguments: '{"asOn":' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { name: 'trial_balance', arguments: '"2025-07-31"' } }] }),
        chunk({ tool_calls: [{ function: { arguments: '}' } }] }, 'tool_calls')
      ])
    )
    const r = await createProvider(resolved('lmstudio'), null, {}, { fetch: m.fetch }).chat(REQ)
    expect(r.toolCalls).toEqual([{ callId: 'a', name: 'trial_balance', arguments: '{"asOn":"2025-07-31"}' }])
  })

  it('two whole calls streamed without index or id stay two calls', async () => {
    const m = mockFetch(() =>
      sse([
        chunk({ tool_calls: [{ function: { name: 'find_party', arguments: '{"q":"A"}' } }] }),
        chunk({ tool_calls: [{ function: { name: 'trial_balance', arguments: '{}' } }] }, 'tool_calls')
      ])
    )
    const r = await createProvider(resolved('ollama'), null, {}, { fetch: m.fetch }).chat(REQ)
    expect(r.toolCalls.map((c) => [c.name, c.arguments])).toEqual([['find_party', '{"q":"A"}'], ['trial_balance', '{}']])
  })

  it('calls without ids get ids unique across steps; a content filter stop is incomplete', async () => {
    const m = mockFetch(() => sse([chunk({ tool_calls: [{ index: 0, function: { name: 'x', arguments: '{}' } }] }, 'content_filter')]))
    const p = createProvider(resolved('ollama'), null, {}, { fetch: m.fetch })
    const a = await p.chat(REQ)
    const b = await p.chat(REQ)
    expect(a.finish).toBe('incomplete')
    expect(a.toolCalls[0]!.callId).not.toBe(b.toolCalls[0]!.callId)
  })

  it('custom header values are redacted from errors; local models are free', async () => {
    const m = mockFetch(() => new Response(JSON.stringify({ error: { message: 'bad request, got X-Api-Key=gateway-secret-9' } }), { status: 400, headers: { 'content-type': 'application/json' } }))
    const p = createProvider(resolved('custom', 'https://llm.example.com/v1'), null, { 'X-Api-Key': 'gateway-secret-9' }, { fetch: m.fetch, sleep: async () => {} })
    const err = await p.chat({ ...REQ, tools: [] }).catch((e: Error) => e)
    expect((err as Error).message).not.toContain('gateway-secret-9')
    expect(p.free).toBe(false)
    expect(createProvider(resolved('ollama'), null).free).toBe(true)
  })
})

describe('Chat Completions request shape', () => {
  it('system first; an assistant message carries the tool calls that follow it; reasoning dropped', () => {
    expect(toChatMessages('sys', REQ.input)).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'TB total?' },
      { role: 'assistant', content: 'Checking.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'trial_balance', arguments: '{"asOn":"2025-07-31"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"total":"₹1,50,000.00"}' }
    ])
    // A tool call with no assistant text before it opens its own assistant turn.
    expect(toChatMessages('s', [{ type: 'tool_call', callId: 'a', name: 'x', arguments: '{}' }, { type: 'tool_call', callId: 'b', name: 'y', arguments: '{}' }])[1]).toEqual({
      role: 'assistant', content: null, tool_calls: [
        { id: 'a', type: 'function', function: { name: 'x', arguments: '{}' } },
        { id: 'b', type: 'function', function: { name: 'y', arguments: '{}' } }
      ]
    })
  })

  it('photos and PDFs as content parts; tools as functions; json_schema answers; max_tokens', () => {
    const body = buildChatBody({
      ...REQ,
      input: [{ type: 'message', role: 'user', content: 'read', attachments: [{ kind: 'image', mime: 'image/jpeg', base64: '/9j' }, { kind: 'file', mime: 'application/pdf', base64: 'JVB', filename: 'bill.pdf' }] }],
      responseFormat: { name: 'bill', schema: { type: 'object' } },
      maxOutputTokens: 600
    })
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      {
        role: 'user', content: [
          { type: 'text', text: 'read' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j', detail: 'high' } },
          { type: 'file', file: { filename: 'bill.pdf', file_data: 'data:application/pdf;base64,JVB' } }
        ]
      }
    ])
    expect(body).toMatchObject({
      stream: true, stream_options: { include_usage: true }, tool_choice: 'auto', max_tokens: 600,
      response_format: { type: 'json_schema', json_schema: { name: 'bill', schema: { type: 'object' }, strict: true } },
      tools: [{ type: 'function', function: { name: 'trial_balance', description: 'TB', parameters: { type: 'object', properties: {} } } }]
    })
    expect(buildChatBody({ ...REQ, tools: [] }).tools).toBeUndefined()
  })
})
