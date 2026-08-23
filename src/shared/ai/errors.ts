/**
 * Provider error mapping.
 *
 * Bring-your-own-key means the user can point Total at anything, so the failure modes are wide:
 * a typo'd endpoint, a key without access to the chosen model, an out-of-credit account, a local
 * Ollama that isn't running, or simply no network. Each of those needs a sentence that tells the
 * user what to do, not an HTTP status.
 *
 * Nothing here ever echoes a header, a request body or a URL query string — endpoints in the
 * wild do carry keys in query strings, so error copy names the HOST and nothing more.
 */

import { endpointHost } from './config'

export type AiErrorKind =
  | 'no-key'
  | 'auth'
  | 'forbidden'
  | 'rate-limit'
  | 'quota'
  | 'timeout'
  | 'offline'
  | 'refused'
  | 'bad-endpoint'
  | 'model-not-found'
  | 'context-overflow'
  | 'cancelled'
  | 'server'
  | 'unknown'

export interface MappedError {
  kind: AiErrorKind
  message: string
  retryable: boolean
}

export interface ProviderErrorShape {
  status?: number
  code?: string
  type?: string
  name?: string
  message?: string
  cause?: { code?: string }
}

export function mapProviderError(
  err: ProviderErrorShape,
  ctx: { baseUrl: string; model: string; timeoutMs?: number }
): MappedError {
  const host = endpointHost(ctx.baseUrl)
  const local = /^(localhost|127\.0\.0\.1|\[::1\])/.test(host)
  const netCode = err.cause?.code ?? err.code

  if (err.name === 'AbortError' || err.code === 'ABORT_ERR') {
    return { kind: 'cancelled', message: '', retryable: false }
  }
  if (netCode === 'ETIMEDOUT' || err.name === 'TimeoutError') {
    const secs = Math.round((ctx.timeoutMs ?? 60000) / 1000)
    return { kind: 'timeout', message: `${host} didn't respond within ${secs}s.`, retryable: true }
  }
  if (netCode === 'ENOTFOUND' || netCode === 'EAI_AGAIN') {
    return {
      kind: 'offline',
      message: `Can't reach ${host}. Total works fully offline — the assistant is the one part that needs a connection.`,
      retryable: true
    }
  }
  if (netCode === 'ECONNREFUSED') {
    return {
      kind: 'refused',
      message: local
        ? `Nothing is listening on ${host}. Is Ollama or LM Studio running?`
        : `${host} refused the connection.`,
      retryable: true
    }
  }

  const status = err.status
  if (status === 401 || err.code === 'invalid_api_key') {
    return { kind: 'auth', message: `${host} rejected your API key. Check it in Settings → AI.`, retryable: false }
  }
  if (status === 403) {
    return {
      kind: 'forbidden',
      message: `Your key doesn't have access to ${ctx.model} on ${host}.`,
      retryable: false
    }
  }
  if (status === 404) {
    return {
      kind: 'model-not-found',
      message: `${ctx.model} isn't available at ${host}. Pick one from the model list in Settings → AI.`,
      retryable: false
    }
  }
  if (status === 429) {
    if (err.code === 'insufficient_quota' || err.type === 'insufficient_quota') {
      return { kind: 'quota', message: `Your account at ${host} is out of credit.`, retryable: false }
    }
    return { kind: 'rate-limit', message: `${host} is rate-limiting you. Try again in a moment.`, retryable: true }
  }
  if (err.code === 'context_length_exceeded' || err.type === 'context_length_exceeded') {
    return {
      kind: 'context-overflow',
      message: 'That question pulled in too much data. Narrow the date range and ask again.',
      retryable: false
    }
  }
  if (status != null && status >= 500) {
    return { kind: 'server', message: `${host} returned an error (${status}). Try again.`, retryable: true }
  }
  if (status != null && status >= 400) {
    return { kind: 'bad-endpoint', message: `${host} rejected the request (${status}).`, retryable: false }
  }
  return { kind: 'unknown', message: `Something went wrong talking to ${host}.`, retryable: true }
}

export const NO_KEY_ERROR: MappedError = {
  kind: 'no-key',
  message: 'Add an API key in Settings → AI before using the assistant.',
  retryable: false
}
