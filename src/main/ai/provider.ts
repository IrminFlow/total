// The one place in the app that talks to an AI provider over the network (WP 5.1). Main process
// only — the renderer has no network (CSP default-src 'self') and never sees the key.
//
// Uses the OpenAI SDK's Responses API (`client.responses.create({ stream: true })`), which the
// SDK version in package.json ships; Chat Completions is not used. Requests go out with
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
import { AiAbortError, AiProviderError, ZERO_USAGE, type AiProvider, type ChatHandlers, type ChatItem, type ChatRequest, type ChatResult, type ChatToolCall, type ChatUsage } from './types'

/** Just the slice of the SDK client this adapter uses — tests inject a fake with the same shape. */
export interface OpenAiLike {
  responses: { create: (body: Record<string, unknown>, opts?: { signal?: AbortSignal; timeout?: number }) => Promise<unknown> }
  models: { list: (opts?: { signal?: AbortSignal; timeout?: number }) => unknown }
}

/** The API endpoint, passed explicitly so OPENAI_BASE_URL / OPENAI_ORG_ID / OPENAI_PROJECT_ID in
 *  the environment are never picked up silently. */
export const OPENAI_BASE_URL = 'https://api.openai.com/v1'

export interface OpenAiProviderOptions {
  apiKey: string
  baseURL?: string
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

/** Remove the key, and anything shaped like an OpenAI key, from text bound for logs or the UI. */
export function redactSecrets(text: string, key?: string | null): string {
  let out = text
  if (key && key.length >= 8) out = out.split(key).join('[redacted key]')
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
  if (s === 401) return 'The provider rejected the API key (401). Check the key in Settings → AI.'
  if (s === 404) return `The provider does not know this model or endpoint (404): ${raw}`
  if (s === 429) return `The provider is rate-limiting this key (429): ${raw}`
  if (err instanceof OpenAI.APIConnectionTimeoutError) return 'The provider did not answer in time.'
  if (err instanceof OpenAI.APIConnectionError) return 'Could not reach the provider (network error).'
  return raw
}

class IdleTimeout extends Error {}

export class OpenAiProvider implements AiProvider {
  readonly name = 'openai'
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
        maxRetries: 0
      }) as unknown as OpenAiLike)
  }

  private fail(err: unknown): never {
    if (err instanceof AiProviderError) throw new AiProviderError(redactSecrets(err.message, this.key), { retryable: err.retryable, status: err.status })
    throw new AiProviderError(redactSecrets(plainMessage(err), this.key), { retryable: isRetryable(err), status: statusOf(err) })
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
    return this.withRetry(req.signal, async (state) => {
      // Our own controller: aborted by the caller's signal OR by the inactivity watchdog.
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
        const stream = (await Promise.race([this.client.responses.create(body, { signal: ctrl.signal, timeout: this.timeoutMs }), idle])) as AsyncIterable<
          Record<string, unknown>
        >
        const it = stream[Symbol.asyncIterator]()
        let text = ''
        const toolCalls: ChatToolCall[] = []
        const reasoning: Record<string, unknown>[] = []
        let usage: ChatUsage = { ...ZERO_USAGE }
        let model = req.model
        let finish: ChatResult['finish'] = 'stop'
        for (;;) {
          arm()
          const next = await Promise.race([it.next(), idle])
          if (next.done) break
          const ev = next.value
          if (req.signal?.aborted) throw new AiAbortError()
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
              const r = ev.response as { usage?: UsageLike; model?: string } | undefined
              usage = usageFrom(r?.usage)
              if (r?.model) model = r.model
              if (ev.type === 'response.incomplete') finish = 'incomplete'
              break
            }
            case 'response.failed': {
              const r = ev.response as { error?: { message?: string; code?: string } } | undefined
              throw new AiProviderError(redactSecrets(r?.error?.message ?? 'The provider reported a failure', this.key), {
                retryable: r?.error?.code === 'server_error'
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
      } catch (err) {
        if (err instanceof IdleTimeout || (ctrl.signal.aborted && !req.signal?.aborted)) {
          // The watchdog fired — a provider failure, not the user's Stop. Retryable only if
          // nothing had streamed yet.
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
