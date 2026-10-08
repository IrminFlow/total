// Provider-neutral shapes the agent loop speaks (src/main/ai/agent.ts). The OpenAI adapter
// (provider.ts) and the scripted MockProvider (mockProvider.ts) both implement AiProvider, so
// the loop, the tools and every test never see an SDK type.

/** One item of the conversation sent to the model. */
export type ChatItem =
  | { type: 'message'; role: 'user' | 'assistant'; content: string; attachments?: ChatAttachment[] }
  | { type: 'tool_call'; callId: string; name: string; arguments: string }
  | { type: 'tool_result'; callId: string; output: string }
  /** A reasoning item from an earlier step of the same question, passed back verbatim (with its
   *  encrypted content — requests are not stored, so this is how the model keeps its reasoning
   *  between tool calls). */
  | { type: 'reasoning'; item: Record<string, unknown> }

/** WP 5.4: a document sent with a user message — a page image, or the file itself (a PDF without
 *  a usable text layer). Base64, no data-URL prefix. Only document capture sends these. */
export type ChatAttachment =
  | { kind: 'image'; mime: 'image/png' | 'image/jpeg' | 'image/webp'; base64: string }
  | { kind: 'file'; mime: 'application/pdf'; base64: string; filename: string }

export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema of the arguments object. */
  parameters: Record<string, unknown>
}

export interface ChatRequest {
  model: string
  /** The system prompt. */
  instructions: string
  input: ChatItem[]
  tools: ToolSpec[]
  /** Structured output: the final text must be JSON matching this schema. */
  responseFormat?: { name: string; schema: Record<string, unknown> }
  maxOutputTokens?: number
  signal?: AbortSignal
}

export interface ChatUsage {
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  reasoningTokens: number
}

export interface ChatToolCall {
  callId: string
  name: string
  /** JSON text, as the model produced it. */
  arguments: string
}

export interface ChatResult {
  text: string
  toolCalls: ChatToolCall[]
  usage: ChatUsage
  /** The model that actually answered (the provider may resolve an alias). */
  model: string
  finish: 'stop' | 'tool_calls' | 'incomplete'
  /** Reasoning output items (encrypted), to pass back on the next step. */
  reasoning: Record<string, unknown>[]
}

export interface ChatHandlers {
  /** Streamed text as it arrives. */
  onTextDelta?: (text: string) => void
}

export interface AiProvider {
  readonly name: string
  chat(req: ChatRequest, handlers?: ChatHandlers): Promise<ChatResult>
  /** Model ids the key can use. */
  models(signal?: AbortSignal): Promise<string[]>
}

export const ZERO_USAGE: ChatUsage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 }

/** Thrown when the caller's AbortSignal fired (Stop button, company closed). */
export class AiAbortError extends Error {
  constructor() {
    super('Stopped')
    this.name = 'AiAbortError'
  }
}

export class AiProviderError extends Error {
  readonly retryable: boolean
  readonly status: number | null
  constructor(message: string, opts: { retryable?: boolean; status?: number | null } = {}) {
    super(message)
    this.name = 'AiProviderError'
    this.retryable = !!opts.retryable
    this.status = opts.status ?? null
  }
}
