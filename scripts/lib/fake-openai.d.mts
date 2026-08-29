/**
 * Types for the test-only fake OpenAI server (fake-openai.mjs).
 *
 * The server itself is plain JS so it can be required from the E2E drivers, which run as bare
 * node scripts; this keeps the dbtests that import it fully typechecked.
 */

export interface FakeStep {
  kind: 'text' | 'tool' | 'error' | 'hang'
  text?: string
  calls?: { name: string; args?: Record<string, unknown> }[]
  status?: number
  body?: unknown
  ms?: number
}

export interface FakeRequest {
  url?: string
  method?: string
  body: unknown
  raw: string
}

export interface FakeOpenAi {
  url: string
  port: number
  requests: FakeRequest[]
  /** Every request body serialized — for "this string was never sent" assertions. */
  sentText(): string
  push(step: FakeStep): void
  close(): Promise<void>
}

export function startFakeOpenAi(opts?: { script?: FakeStep[] }): Promise<FakeOpenAi>
