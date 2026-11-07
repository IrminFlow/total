// The one place in the app that talks to an AI provider over the network (WP 5.1). Main process
// only — the renderer has no network (CSP default-src 'self') and never sees the key.
//
// Phase 3a: any OpenAI-compatible endpoint (shared/aiProviders.ts presets — OpenAI, OpenRouter,
// Groq, Gemini's OpenAI endpoint, Ollama / LM Studio on this computer, a custom URL). OpenAI is
// spoken to through the Responses API exactly as before; every other preset through Chat
// Completions (`api: 'chat'`), which every compatible server implements. A request that needs
// something the endpoint was declared unable to do (tools, a JSON-schema answer, a photo, a PDF
// file) is refused here before anything is sent (AiCapabilityError), and a provider error that
// says "not supported" is turned into the same plain message (capabilityRefusal).
//
// The Responses API path (`client.responses.create({ stream: true })`): requests go out with
// `store: false` so the provider is asked not to keep the conversation; reasoning items are
// requested encrypted (`include: ['reasoning.encrypted_content']`) and passed back between the
// steps of one question — dropped automatically if a model refuses that option.
//
// What this layer adds over the SDK:
// - streaming text deltas to a callback, tool calls collected from `response.output_item.done`;
// - usage accounting (input / cached input / output / reasoning tokens);
// - a per-request timeout, an inactivity watchdog (a stream silent for `idleTimeoutMs` is
//   aborted and fails), and our own retry with exponential backoff + jitter (the SDK's own
//   retries are off so a retry never happens after text was already streamed to the user);
// - cancellation through an AbortSignal;
// - an explicit endpoint (OPENAI_* environment variables are never read);
// - error messages with the API key (and anything key-shaped) redacted.
import OpenAI from 'openai'
import { AiCapabilityError, CAPABILITY_MESSAGES, capabilityRefusal, type AiApiStyle, type AiCapabilities, type AiCapabilityNeed, type ResolvedAiProvider } from '@shared/aiProviders'
import { AiAbortError, AiProviderError, ZERO_USAGE, type AiProvider, type ChatHandlers, type ChatItem, type ChatRequest, type ChatResult, type ChatToolCall, type ChatUsage } from './types'

/** Just the slice of the SDK client this adapter uses — tests inject a fake with the same shape. */
export interface OpenAiLike {
  responses: { create: (body: Record<string, unknown>, opts?: { signal?: AbortSignal; timeout?: number }) => Promise<unknown> }
  chat?: { completions: { create: (body: Record<string, unknown>, opts?: { signal?: AbortSignal; timeout?: number }) => Promise<unknown> } }
  models: { list: (opts?: { signal?: AbortSignal; timeout?: number }) => unknown }
}

/** The API endpoint, passed explicitly so OPENAI_BASE_URL / OPENAI_ORG_ID / OPENAI_PROJECT_ID in
 *  the environment are never picked up silently. */
export const OPENAI_BASE_URL = 'https://api.openai.com/v1' // = providerConfig FIXED_ENDPOINTS.openai

export interface OpenAiProviderOptions {
  apiKey: string
  baseURL?: string
  /** 'responses' (OpenAI, the default) or 'chat' (Chat Completions — every other endpoint). */
  api?: AiApiStyle
  /** Logged as the provider of each call (usage rows, outbound log). Default 'openai'. */
  name?: string
  /** What the endpoint can do; a request needing more is refused before it is sent. Default: all. */
  capabilities?: AiCapabilities
  /** Extra headers (a custom endpoint's own); never Authorization. */
  defaultHeaders?: Record<string, string>
  /** Phase 3a: a model on this computer (calls cost nothing). */
  free?: boolean
  /** Injected by tests (mocked HTTP for the real SDK client); never set by the app. */
  fetch?: (url: string, init?: Record<string, unknown>) => Promise<unknown>
  /** Per attempt. */
  timeoutMs?: number
  /** Abort a stream that sends nothing for this long (ms). */
  idleTimeoutMs?: number
  /** Ask for encrypted reasoning items to pass back between steps. */
  includeReasoning?: boolean
  /** Retries after the first attempt (only before any text has streamed). */
  maxRetries?: number
  /** Base backoff; attempt n waits base * 2^n (+ up to 25 % jitter), capped at 8 s. */
  backoffMs?: number
  /** Injected for tests. */
  client?: OpenAiLike
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  random?: () => number
}

/** Remove the key (and any other secret given — custom header values), and anything shaped like
 *  an OpenAI key, from text bound for logs or the UI. */
export function redactSecrets(text: string, key?: string | null, others: readonly string[] = []): string {
  let out = text
  if (key && key.length >= 8) out = out.split(key).join('[redacted key]')
  for (const o of others) if (o && o.length >= 4) out = out.split(o).join('[redacted]')
  return out.replace(/\b(sk|rk|sess)-[A-Za-z0-9_-]{8,}/g, '$1-…[redacted]').replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1[redacted]')
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AiAbortError())
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      reject(new AiAbortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Provider-neutral items → Responses API input items. */
export function toResponsesInput(items: readonly ChatItem[]): Record<string, unknown>[] {
  return items.map((it) => {
    if (it.type === 'message') {
      if (!it.attachments?.length) return { type: 'message', role: it.role, content: it.content }
      // WP 5.4: text first, then the document parts (input_image / input_file as data URLs).
      return {
        type: 'message',
        role: it.role,
        content: [
          { type: 'input_text', text: it.content },
          ...it.attachments.map((a) =>
            a.kind === 'image'
              ? { type: 'input_image', image_url: `data:${a.mime};base64,${a.base64}`, detail: 'high' }
              : { type: 'input_file', filename: a.filename, file_data: `data:${a.mime};base64,${a.base64}` }
          )
        ]
      }
    }
    if (it.type === 'tool_call') return { type: 'function_call', call_id: it.callId, name: it.name, arguments: it.arguments }
    if (it.type === 'reasoning') return it.item
    return { type: 'function_call_output', call_id: it.callId, output: it.output }
  })
}

export function buildResponsesBody(req: ChatRequest, opts: { includeReasoning?: boolean } = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    instructions: req.instructions,
    input: toResponsesInput(req.input),
    stream: true,
    store: false
  }
  if (opts.includeReasoning) body.include = ['reasoning.encrypted_content']
  if (req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false }))
    body.tool_choice = 'auto'
    body.parallel_tool_calls = true
  }
  if (req.responseFormat) {
    body.text = { format: { type: 'json_schema', name: req.responseFormat.name, schema: req.responseFormat.schema, strict: true } }
  }
  if (req.maxOutputTokens) body.max_output_tokens = req.maxOutputTokens
  return body
}

/** Provider-neutral items → Chat Completions messages. Tool calls that follow an assistant
 *  message join it (one assistant turn with `tool_calls`); reasoning items are Responses-only and
 *  dropped. */
export function toChatMessages(instructions: string, items: readonly ChatItem[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [{ role: 'system', content: instructions }]
  let open: { role: 'assistant'; content: string | null; tool_calls?: Record<string, unknown>[] } | null = null
  for (const it of items) {
    if (it.type === 'reasoning') continue
    if (it.type === 'tool_call') {
      if (!open) {
        open = { role: 'assistant', content: null }
        out.push(open)
      }
      ;(open.tool_calls ??= []).push({ id: it.callId, type: 'function', function: { name: it.name, arguments: it.arguments }, ...(it.extra ? { extra_content: it.extra } : {}) })
      continue
    }
    open = null
    if (it.type === 'tool_result') {
      out.push({ role: 'tool', tool_call_id: it.callId, content: it.output })
      continue
    }
    if (it.role === 'assistant') {
      open = { role: 'assistant', content: it.content }
      out.push(open)
      continue
    }
    if (!it.attachments?.length) {
      out.push({ role: 'user', content: it.content })
      continue
    }
    out.push({
      role: 'user',
      content: [
        { type: 'text', text: it.content },
        ...it.attachments.map((a) =>
          a.kind === 'image'
            ? { type: 'image_url', image_url: { url: `data:${a.mime};base64,${a.base64}`, detail: 'high' } }
            : { type: 'file', file: { filename: a.filename, file_data: `data:${a.mime};base64,${a.base64}` } }
        )
      ]
    })
  }
  return out
}

export function buildChatBody(req: ChatRequest, opts: { streamUsage?: boolean } = {}): Record<string, unknown> {
  const body: Record<string, unknown> = { model: req.model, messages: toChatMessages(req.instructions, req.input), stream: true }
  if (opts.streamUsage !== false) body.stream_options = { include_usage: true }
  if (req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
    body.tool_choice = 'auto'
  }
  if (req.responseFormat) body.response_format = { type: 'json_schema', json_schema: { name: req.responseFormat.name, schema: req.responseFormat.schema, strict: true } }
  if (req.maxOutputTokens) body.max_tokens = req.maxOutputTokens
  return body
}

interface ChatUsageLike {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number } | null
  completion_tokens_details?: { reasoning_tokens?: number } | null
}

export function chatUsageFrom(u: ChatUsageLike | null | undefined): ChatUsage {
  if (!u) return { ...ZERO_USAGE }
  return {
    inputTokens: u.prompt_tokens ?? 0,
    cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0
  }
}

function completeJson(text: string): boolean {
  if (!text.trim()) return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/** What a request needs that the endpoint cannot do — the first such need, or null. */
export function unmetNeed(req: ChatRequest, caps: AiCapabilities): AiCapabilityNeed | null {
  if (req.tools.length > 0 && !caps.tools) return 'tools'
  if (req.responseFormat && !caps.structured) return 'structured'
  for (const it of req.input) {
    if (it.type !== 'message' || !it.attachments) continue
    for (const a of it.attachments) {
      if (a.kind === 'image' && !caps.images) return 'images'
      if (a.kind === 'file' && !caps.files) return 'files'
    }
  }
  return null
}

interface UsageLike {
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: { cached_tokens?: number } | null
  output_tokens_details?: { reasoning_tokens?: number } | null
}

export function usageFrom(u: UsageLike | null | undefined): ChatUsage {
  if (!u) return { ...ZERO_USAGE }
  return {
    inputTokens: u.input_tokens ?? 0,
    cachedTokens: u.input_tokens_details?.cached_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0
  }
}

function statusOf(err: unknown): number | null {
  const s = (err as { status?: unknown })?.status
  return typeof s === 'number' ? s : null
}

/** Network failures, timeouts, 408/409/429 and 5xx are worth another try; 4xx (bad key, unknown
 *  model, bad request) are not. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof AiProviderError) return err.retryable
  if (err instanceof OpenAI.APIUserAbortError) return false
  if (err instanceof OpenAI.APIConnectionError) return true
  const s = statusOf(err)
  if (s === null) return false
  return s === 408 || s === 409 || s === 429 || s >= 500
}

function plainMessage(err: unknown): string {
  const s = statusOf(err)
  const raw = err instanceof Error ? err.message : String(err)
  const need = s !== 401 && s !== 429 ? capabilityRefusal(raw) : null
  if (need) return `${CAPABILITY_MESSAGES[need]} (${raw})`
  if (s === 401) return 'The provider rejected the API key (401). Check the key in Settings → AI.'
  if (s === 404) return `The provider does not know this model or endpoint (404): ${raw}`
  if (s === 429) return `The provider is rate-limiting this key (429): ${raw}`
  if (err instanceof OpenAI.APIConnectionTimeoutError) return 'The provider did not answer in time.'
  if (err instanceof OpenAI.APIConnectionError) return 'Could not reach the provider (network error).'
  return raw
}

class IdleTimeout extends Error {}

export class OpenAiProvider implements AiProvider {
  readonly name: string
  readonly api: AiApiStyle
  readonly capabilities: AiCapabilities
  readonly free: boolean
  private readonly headerValues: string[]
  private streamUsage = true
  private readonly client: OpenAiLike
  private readonly key: string
  private readonly timeoutMs: number
  private readonly idleTimeoutMs: number
  private includeReasoning: boolean
  private readonly maxRetries: number
  private readonly backoffMs: number
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly random: () => number

  constructor(opts: OpenAiProviderOptions) {
    this.name = opts.name ?? 'openai'
    this.api = opts.api ?? 'responses'
    this.capabilities = opts.capabilities ?? { tools: true, structured: true, images: true, files: true }
    this.free = !!opts.free
    this.headerValues = Object.values(opts.defaultHeaders ?? {})
    this.key = opts.apiKey
    this.timeoutMs = opts.timeoutMs ?? 90_000
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 60_000
    this.includeReasoning = opts.includeReasoning ?? true
    this.maxRetries = opts.maxRetries ?? 2
    this.backoffMs = opts.backoffMs ?? 600
    this.sleep = opts.sleep ?? abortableSleep
    this.random = opts.random ?? Math.random
    this.client =
      opts.client ??
      (new OpenAI({
        apiKey: opts.apiKey,
        baseURL: opts.baseURL ?? OPENAI_BASE_URL,
        organization: null,
        project: null,
        timeout: this.timeoutMs,
        maxRetries: 0,
        ...(opts.defaultHeaders && Object.keys(opts.defaultHeaders).length ? { defaultHeaders: opts.defaultHeaders } : {}),
        // Never follow a redirect: custom headers (and, same-origin, the key) would go with it.
        fetch: (opts.fetch ?? ((url: string, init?: Record<string, unknown>) => globalThis.fetch(url, { ...(init ?? {}), redirect: 'error' } as RequestInit))) as never
      }) as unknown as OpenAiLike)
  }

  private fail(err: unknown): never {
    if (err instanceof AiCapabilityError) throw err
    if (err instanceof AiProviderError) throw new AiProviderError(redactSecrets(err.message, this.key, this.headerValues), { retryable: err.retryable, status: err.status })
    throw new AiProviderError(redactSecrets(plainMessage(err), this.key, this.headerValues), { retryable: isRetryable(err), status: statusOf(err) })
  }

  private async withRetry<T>(signal: AbortSignal | undefined, attempt: (state: { streamed: boolean }) => Promise<T>): Promise<T> {
    for (let n = 0; ; n++) {
      const state = { streamed: false }
      if (signal?.aborted) throw new AiAbortError()
      try {
        return await attempt(state)
      } catch (err) {
        if (signal?.aborted || err instanceof AiAbortError) throw new AiAbortError()
        if (!(err instanceof AiProviderError) && (err instanceof OpenAI.APIUserAbortError || (err as Error)?.name === 'AbortError')) throw new AiAbortError()
        if (state.streamed || n >= this.maxRetries || !isRetryable(err)) this.fail(err)
        const wait = Math.min(8000, this.backoffMs * 2 ** n) * (1 + this.random() * 0.25)
        await this.sleep(Math.round(wait), signal)
      }
    }
  }

  async chat(req: ChatRequest, handlers: ChatHandlers = {}): Promise<ChatResult> {
    // Nothing is sent for a request the endpoint was declared unable to answer.
    const need = unmetNeed(req, this.capabilities)
    if (need) throw new AiCapabilityError(need)
    if (this.api === 'chat') return this.chatCompletions(req, handlers)
    try {
      return await this.chatOnce(req, handlers)
    } catch (err) {
      // A model without reasoning may refuse `include: ['reasoning.encrypted_content']`: drop the
      // option for this provider and try once more.
      if (this.includeReasoning && err instanceof AiProviderError && err.status === 400 && /reasoning|include/i.test(err.message)) {
        this.includeReasoning = false
        return this.chatOnce(req, handlers)
      }
      throw err
    }
  }

  private chatOnce(req: ChatRequest, handlers: ChatHandlers): Promise<ChatResult> {
    const body = buildResponsesBody(req, { includeReasoning: this.includeReasoning })
    return this.streamWith(req, (signal) => this.client.responses.create(body, { signal, timeout: this.timeoutMs }), async (next, state) => {
      let text = ''
      const toolCalls: ChatToolCall[] = []
      const reasoning: Record<string, unknown>[] = []
      let usage: ChatUsage = { ...ZERO_USAGE }
      let model = req.model
      let finish: ChatResult['finish'] = 'stop'
      for (;;) {
        const r = await next()
        if (r.done) break
        const ev = r.value
        switch (ev.type) {
          case 'response.output_text.delta': {
            const delta = String(ev.delta ?? '')
            if (delta) {
              state.streamed = true
              text += delta
              handlers.onTextDelta?.(delta)
            }
            break
          }
          case 'response.output_item.done': {
            const item = ev.item as { type?: string; call_id?: string; name?: string; arguments?: string } | undefined
            if (item?.type === 'function_call' && item.call_id && item.name) {
              state.streamed = true
              toolCalls.push({ callId: item.call_id, name: item.name, arguments: item.arguments ?? '{}' })
            } else if (item?.type === 'reasoning') {
              reasoning.push(item as Record<string, unknown>)
            }
            break
          }
          case 'response.completed':
          case 'response.incomplete': {
            const resp = ev.response as { usage?: UsageLike; model?: string } | undefined
            usage = usageFrom(resp?.usage)
            if (resp?.model) model = resp.model
            if (ev.type === 'response.incomplete') finish = 'incomplete'
            break
          }
          case 'response.failed': {
            const resp = ev.response as { error?: { message?: string; code?: string } } | undefined
            throw new AiProviderError(redactSecrets(resp?.error?.message ?? 'The provider reported a failure', this.key), {
              retryable: resp?.error?.code === 'server_error'
            })
          }
          case 'error': {
            throw new AiProviderError(redactSecrets(String(ev.message ?? 'Provider stream error'), this.key), {
              retryable: ev.code === 'server_error' || ev.code === 'rate_limit_exceeded'
            })
          }
          default:
            break
        }
      }
      if (toolCalls.length > 0 && finish !== 'incomplete') finish = 'tool_calls'
      return { text, toolCalls, usage, model, finish, reasoning }
    })
  }

  private async chatCompletions(req: ChatRequest, handlers: ChatHandlers): Promise<ChatResult> {
    try {
      return await this.chatCompletionsOnce(req, handlers)
    } catch (err) {
      // Some compatible servers refuse `stream_options` (usage on the last chunk): drop it for
      // this provider and try once more (usage then counts as 0 — the cost meter says "—").
      if (this.streamUsage && err instanceof AiProviderError && err.status === 400 && /stream_options|include_usage/i.test(err.message)) {
        this.streamUsage = false
        return this.chatCompletionsOnce(req, handlers)
      }
      throw err
    }
  }

  private chatCompletionsOnce(req: ChatRequest, handlers: ChatHandlers): Promise<ChatResult> {
    const body = buildChatBody(req, { streamUsage: this.streamUsage })
    const create = this.client.chat?.completions.create
    if (!create) throw new AiProviderError('This client cannot use Chat Completions')
    return this.streamWith(req, (signal) => create.call(this.client.chat!.completions, body, { signal, timeout: this.timeoutMs }), async (next, state) => {
      let text = ''
      const calls = new Map<number, { callId: string; name: string; arguments: string; extra?: Record<string, unknown> }>()
      let last = 0
      const runId = Math.random().toString(36).slice(2, 10)
      let usage: ChatUsage = { ...ZERO_USAGE }
      let model = req.model
      let finish: ChatResult['finish'] = 'stop'
      for (;;) {
        const r = await next()
        if (r.done) break
        const ev = r.value as {
          model?: string
          usage?: ChatUsageLike | null
          error?: { message?: string }
          choices?: {
            delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string }; extra_content?: Record<string, unknown> }[] }
            finish_reason?: string | null
          }[]
        }
        if (ev.error) throw new AiProviderError(redactSecrets(String(ev.error.message ?? 'Provider stream error'), this.key))
        if (ev.model) model = ev.model
        if (ev.usage) usage = chatUsageFrom(ev.usage)
        for (const ch of ev.choices ?? []) {
          const delta = ch.delta?.content ?? ''
          if (delta) {
            state.streamed = true
            text += delta
            handlers.onTextDelta?.(delta)
          }
          for (const tc of ch.delta?.tool_calls ?? []) {
            state.streamed = true
            // A server that leaves `index` off a continuation chunk means the call in progress —
            // unless the chunk names a new function after a call whose arguments are complete.
            const cur = calls.get(last)
            const startsNew = !!tc.id || calls.size === 0 || (!!tc.function?.name && !!cur?.name && completeJson(cur.arguments))
            const i = tc.index ?? (startsNew ? calls.size : last)
            last = i
            const c = calls.get(i) ?? { callId: '', name: '', arguments: '' }
            if (tc.id) c.callId = tc.id
            const nm = tc.function?.name
            // Some servers repeat the whole name in every chunk; others stream it in pieces.
            if (nm) c.name = nm.startsWith(c.name) ? nm : c.name + nm
            if (tc.function?.arguments) c.arguments += tc.function.arguments
            if (tc.extra_content && typeof tc.extra_content === 'object') c.extra = { ...(c.extra ?? {}), ...tc.extra_content }
            calls.set(i, c)
          }
          if (ch.finish_reason === 'length' || ch.finish_reason === 'content_filter') finish = 'incomplete'
        }
      }
      const toolCalls: ChatToolCall[] = [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .filter(([, c]) => c.name)
        .map(([i, c]) => ({ callId: c.callId || `call_${runId}_${i}`, name: c.name, arguments: c.arguments || '{}', ...(c.extra ? { extra: c.extra } : {}) }))
      if (toolCalls.length > 0 && finish !== 'incomplete') finish = 'tool_calls'
      return { text, toolCalls, usage, model, finish, reasoning: [] }
    })
  }

  /** One streamed attempt (with retries before anything streamed): the caller's signal and the
   *  inactivity watchdog both abort it; `consume` reads the events through `next`. */
  private streamWith(
    req: ChatRequest,
    open: (signal: AbortSignal) => Promise<unknown>,
    consume: (next: () => Promise<IteratorResult<Record<string, unknown>>>, state: { streamed: boolean }) => Promise<ChatResult>
  ): Promise<ChatResult> {
    return this.withRetry(req.signal, async (state) => {
      const ctrl = new AbortController()
      const onOuterAbort = (): void => ctrl.abort()
      req.signal?.addEventListener('abort', onOuterAbort, { once: true })
      let timer: ReturnType<typeof setTimeout> | null = null
      let fireIdle: (() => void) | null = null
      const idle = new Promise<never>((_, reject) => {
        fireIdle = () => reject(new IdleTimeout())
      })
      idle.catch(() => {})
      const arm = (): void => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          ctrl.abort()
          fireIdle?.()
        }, this.idleTimeoutMs)
      }
      try {
        arm()
        const stream = (await Promise.race([open(ctrl.signal), idle])) as AsyncIterable<Record<string, unknown>>
        const it = stream[Symbol.asyncIterator]()
        return await consume(async () => {
          arm()
          const r = await Promise.race([it.next(), idle])
          if (req.signal?.aborted) throw new AiAbortError()
          return r
        }, state)
      } catch (err) {
        if (err instanceof IdleTimeout || (ctrl.signal.aborted && !req.signal?.aborted)) {
          throw new AiProviderError(`The provider sent nothing for ${Math.round(this.idleTimeoutMs / 1000)} s — stopped waiting.`, { retryable: !state.streamed })
        }
        throw err
      } finally {
        if (timer) clearTimeout(timer)
        req.signal?.removeEventListener('abort', onOuterAbort)
      }
    })
  }

  async models(signal?: AbortSignal): Promise<string[]> {
    return this.withRetry(signal, async () => {
      const page = this.client.models.list({ signal, timeout: Math.min(this.timeoutMs, 30_000) }) as AsyncIterable<{ id: string }>
      const ids: string[] = []
      for await (const m of page) ids.push(m.id)
      return ids.sort()
    })
  }
}

/** A placeholder bearer for endpoints that take no key (local servers, a custom URL with its own
 *  header): the SDK insists on one; servers that need none ignore it. */
export const NO_KEY = 'not-needed'

/** The client for the chosen preset (shared/aiProviders.ts `resolveAiProvider`). */
export function createProvider(p: ResolvedAiProvider, apiKey: string | null, headers: Record<string, string> = {}, extra: Partial<OpenAiProviderOptions> = {}): OpenAiProvider {
  if (p.needsKey && !apiKey) throw new Error(`No API key for ${p.label} — add one in Settings → AI`)
  if (!p.baseUrl) throw new Error('Type the address of the AI service in Settings → AI')
  return new OpenAiProvider({
    apiKey: apiKey || NO_KEY,
    baseURL: p.baseUrl,
    api: p.api,
    name: p.preset,
    capabilities: p.caps,
    defaultHeaders: headers,
    // Local models can take a while to load the first time, and cost nothing.
    ...(p.local ? { timeoutMs: 300_000, idleTimeoutMs: 180_000, free: true } : {}),
    ...extra
  })
}
