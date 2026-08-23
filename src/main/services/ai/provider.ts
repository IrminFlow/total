/**
 * The ONLY file in the repo that imports the OpenAI SDK.
 *
 * Exactly one module may import the SDK, and ai-boundaries.test.ts enforces it. Everything else
 * takes the `ChatClient` interface below, which keeps the SDK swappable, keeps the tool and
 * prompt logic testable without a network, and means a future provider change touches one file.
 *
 * All AI networking lives in main because the renderer physically cannot reach an endpoint: its
 * CSP is `default-src 'self'` (src/renderer/index.html). That is a backstop, not the design —
 * the design is that the key never leaves this process.
 */

import OpenAI from 'openai'
import { isInsecureEndpoint, type AiConfig } from '@shared/ai/config'
import { mapProviderError, NO_KEY_ERROR, type MappedError } from '@shared/ai/errors'
import { apiKey, readConfig } from './config'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
}

export interface ChatToolDef {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface ChatChunk {
  text?: string
  toolCalls?: { id: string; name: string; arguments: string }[]
  finish?: 'stop' | 'length' | 'tool_calls'
  usage?: { promptTokens: number; completionTokens: number }
}

export interface ChatClient {
  stream(req: {
    messages: ChatMessage[]
    tools?: ChatToolDef[]
    signal?: AbortSignal
  }): AsyncIterable<ChatChunk>
  listModels(signal?: AbortSignal): Promise<string[]>
}

export class AiError extends Error {
  constructor(readonly mapped: MappedError) {
    super(mapped.message)
    this.name = 'AiError'
  }
}

function client(config: AiConfig, key: string): OpenAI {
  return new OpenAI({
    apiKey: key,
    baseURL: config.baseUrl,
    timeout: config.requestTimeoutMs,
    // One retry only: a rate-limited request retried aggressively costs the user money and
    // delays the visible error. The mapped error tells them whether to try again.
    maxRetries: 1
  })
}

/**
 * Build a client for the current configuration.
 *
 * A local endpoint may legitimately need no key (Ollama ignores it), so an empty key is only
 * fatal for a remote one. Plaintext http to anywhere but this machine is refused outright.
 */
export function makeClient(): ChatClient {
  const config = readConfig()
  const key = apiKey() ?? ''
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(config.baseUrl)
  if (!key && !local) throw new AiError(NO_KEY_ERROR)
  if (isInsecureEndpoint(config.baseUrl)) {
    throw new AiError({
      kind: 'bad-endpoint',
      message: 'That endpoint is plain http. Use https, or an address on this machine.',
      retryable: false
    })
  }

  const openai = client(config, key || 'not-needed')
  const ctx = { baseUrl: config.baseUrl, model: config.model, timeoutMs: config.requestTimeoutMs }

  return {
    async *stream({ messages, tools, signal }) {
      try {
        const stream = await openai.chat.completions.create(
          {
            model: config.model,
            temperature: config.temperature,
            max_tokens: config.maxTokens,
            messages: messages as never,
            ...(tools?.length ? { tools: tools as never, tool_choice: 'auto' as const } : {}),
            stream: true,
            stream_options: { include_usage: true }
          },
          { signal }
        )

        // Tool calls arrive in fragments across chunks (name in one, arguments split over
        // several), keyed by index. Accumulate and emit once the model stops.
        const pending = new Map<number, { id: string; name: string; arguments: string }>()

        for await (const chunk of stream) {
          const choice = chunk.choices?.[0]
          const delta = choice?.delta

          if (delta?.content) yield { text: delta.content }

          for (const call of delta?.tool_calls ?? []) {
            const slot = pending.get(call.index) ?? { id: '', name: '', arguments: '' }
            if (call.id) slot.id = call.id
            if (call.function?.name) slot.name = call.function.name
            if (call.function?.arguments) slot.arguments += call.function.arguments
            pending.set(call.index, slot)
          }

          if (chunk.usage) {
            yield {
              usage: {
                promptTokens: chunk.usage.prompt_tokens ?? 0,
                completionTokens: chunk.usage.completion_tokens ?? 0
              }
            }
          }

          if (choice?.finish_reason) {
            if (choice.finish_reason === 'tool_calls' && pending.size > 0) {
              yield { toolCalls: [...pending.values()], finish: 'tool_calls' }
            } else {
              yield { finish: choice.finish_reason === 'length' ? 'length' : 'stop' }
            }
          }
        }
      } catch (err) {
        throw new AiError(mapProviderError(err as never, ctx))
      }
    },

    async listModels(signal) {
      try {
        const res = await openai.models.list({ signal })
        return res.data.map((m) => m.id).sort()
      } catch (err) {
        throw new AiError(mapProviderError(err as never, ctx))
      }
    }
  }
}
