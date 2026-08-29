/**
 * AI assistant configuration — pure schema and defaults, shared by main and the renderer.
 *
 * Bring-your-own-key only. The user supplies an endpoint and a key for any OpenAI-compatible
 * service (OpenAI, OpenRouter, Groq, Together) or a local one (Ollama, LM Studio). Total runs no
 * proxy, has no accounts and no billing, so "fully offline, no cloud, no account" stays true for
 * anyone who never turns this on.
 */

import { z } from 'zod'
import { EGRESS_MODES } from './endpoint'

/** How the API key is being held. `session` means the OS keychain was unavailable. */
export type KeyStorage = 'keychain' | 'session'

/**
 * What leaves the machine.
 *
 * `full` sends ledger and party names, which is what makes "how much does Sharma Traders owe
 * me?" answerable at all. `names-redacted` substitutes codes for a user sending a client's books
 * to a third-party endpoint, at a real cost to answer quality. GSTIN, PAN, bank account numbers
 * and payroll data are never sent under either setting — that is not a toggle.
 */
export const aiConfigSchema = z.object({
  version: z.literal(1).default(1),
  baseUrl: z.string().trim().max(300).default('https://api.openai.com/v1'),
  model: z.string().trim().max(120).default('gpt-4o-mini'),
  /** Vision is a separate model on purpose — never assume the chat model can see. */
  visionModel: z.string().trim().max(120).default(''),
  temperature: z.number().min(0).max(2).default(0.1),
  maxTokens: z.number().int().min(256).max(32000).default(4000),
  maxToolIterations: z.number().int().min(1).max(12).default(6),
  requestTimeoutMs: z.number().int().min(2000).max(180000).default(60000),
  egress: z.enum(EGRESS_MODES).default('full'),
  /** Per-session spend cap in paise. 0 disables the assistant as surely as the feature flag. */
  sessionCapPaise: z.number().int().min(0).max(1_000_000).default(10_000),
  dailyCapPaise: z.number().int().min(0).max(5_000_000).default(50_000),
  /** Host the user last consented to. Changing the endpoint re-arms the consent prompt. */
  consentedHost: z.string().trim().max(200).default('')
})

export type AiConfig = z.infer<typeof aiConfigSchema>

export const DEFAULT_AI_CONFIG: AiConfig = aiConfigSchema.parse({})



/**
 * What `ai:getConfig` returns. A DIFFERENT type from AiConfig on purpose: it carries the mask
 * rather than a key, and has no field that could ever hold one, so a later refactor cannot widen
 * the renderer's view into the real thing by accident.
 */
export interface AiConfigView extends AiConfig {
  /** Either '' (unset) or KEY_MASK. Never the real key. */
  apiKey: string
  keyStorage: KeyStorage
  /** True when a key is stored and the feature flag is on for this company. */
  ready: boolean
}

/** Settings-form payload: the config plus whatever the user typed into the key box. */
export const aiSettingsSchema = aiConfigSchema.extend({
  apiKey: z.string().max(400).default('')
})
export type AiSettings = z.infer<typeof aiSettingsSchema>

/** Merge persisted JSON (possibly older or corrupt) over the defaults. Never throws. */
export function mergeAiConfig(partial: unknown): AiConfig {
  const obj = partial && typeof partial === 'object' ? (partial as Record<string, unknown>) : {}
  const parsed = aiConfigSchema.safeParse({ ...DEFAULT_AI_CONFIG, ...obj })
  return parsed.success ? parsed.data : { ...DEFAULT_AI_CONFIG }
}

export { EGRESS_MODES, KEY_MASK, endpointHost, isInsecureEndpoint, isLocalEndpoint } from './endpoint'
export type { EgressMode } from './endpoint'
