/**
 * AI agent (Phase 5, WP 5.1) — the types and IPC payload schemas the renderer and main share.
 * Everything that DOES anything (provider, tools, agent loop, privacy) lives in src/main/ai/;
 * this file is only shapes, so the renderer can stay typed without importing main code.
 *
 * Money in tool results is pre-formatted text (formatPaise) — the model quotes it, never
 * computes it (the numbers rule). Costs are integer micro-USD (1 USD = 1,000,000) so no float
 * ever touches a stored figure.
 */
import { z } from 'zod'
import { aiContextSchema, type AiContext } from './aiExplain'

/** Defaults from the revamp plan. NOT verified against the provider's model list — the
 *  Settings "Test connection" lists the models the key can use and flags an id that is missing. */
export const AI_DEFAULT_MODEL = 'gpt-6.1-sol'
export const AI_DEFAULT_FAST_MODEL = 'gpt-6-luna'

/** Price of one model, integer micro-USD per 1,000,000 tokens. null = unknown (cost not estimated). */
export interface AiModelPrice {
  inputPerM: number | null
  cachedInputPerM: number | null
  outputPerM: number | null
}

export interface AiPrivacy {
  /** Replace GSTIN / PAN / IFSC / bank account numbers in everything sent. */
  maskIds: boolean
  /** Replace party (debtor / creditor) names with stable aliases, mapped back locally. */
  pseudonymiseParties: boolean
}

/** Per-company AI settings (company `meta` key 'ai'). The API key is NOT here — it lives in the
 *  secret store (scope 'app'), and only a hint of it ever reaches the renderer. */
export interface AiSettings {
  /** The per-company switch. Off by default; nothing is ever sent while it is off. */
  enabled: boolean
  /** When (ISO) and by whom the data notice was accepted; null = never — AI cannot be turned on. */
  noticeAcceptedAt: string | null
  noticeAcceptedBy: string | null
  /** AI_DATA_NOTICE_VERSION accepted; a newer notice must be accepted again. */
  noticeVersion: number | null
  defaultModel: string
  fastModel: string
  privacy: AiPrivacy
  /** model id → price. Editable in Settings → AI; empty by default (prices are not guessed). */
  prices: Record<string, AiModelPrice>
  /** Max agent steps (model calls) per question. */
  maxSteps: number
}

export const AI_DATA_NOTICE_VERSION = 1

export const aiPriceSchema = z.object({
  inputPerM: z.number().int().min(0).max(1_000_000_000).nullable(),
  cachedInputPerM: z.number().int().min(0).max(1_000_000_000).nullable(),
  outputPerM: z.number().int().min(0).max(1_000_000_000).nullable()
})

export const aiModelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._:\-/]+$/, 'Model ids are letters, digits and . _ : - /')

export const aiSettingsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    defaultModel: aiModelIdSchema.optional(),
    fastModel: aiModelIdSchema.optional(),
    privacy: z.object({ maskIds: z.boolean(), pseudonymiseParties: z.boolean() }).partial().optional(),
    prices: z.record(aiModelIdSchema, aiPriceSchema).optional(),
    maxSteps: z.number().int().min(1).max(20).optional()
  })
  .strict()
export type AiSettingsPatch = z.infer<typeof aiSettingsPatchSchema>

export const aiKeySetSchema = z.object({ key: z.string().trim().min(8).max(400) })

// The screen context (WP 5.2: screen, title, period, parameters, the figure to explain) lives in
// aiExplain.ts with the pure builders that share it between the panel and the prompt.
export { aiContextSchema, type AiContext }

export const aiSendSchema = z.object({
  threadId: z.number().int().positive().optional(),
  text: z.string().trim().min(1).max(8000),
  context: aiContextSchema.optional(),
  /** 'fast' uses the fast model. */
  speed: z.enum(['default', 'fast']).optional()
})
export type AiSendInput = z.infer<typeof aiSendSchema>

/** Regenerate: answer the thread's last question again (its previous answer is replaced). */
export const aiRegenerateSchema = z.object({
  threadId: z.number().int().positive(),
  context: aiContextSchema.optional(),
  speed: z.enum(['default', 'fast']).optional()
})

export const aiThreadRenameSchema = z.object({ id: z.number().int().positive(), title: z.string().trim().min(1).max(80) })
export const aiThreadPinSchema = z.object({ id: z.number().int().positive(), pinned: z.boolean() })

/** Where a figure or a row came from — the panel renders these as links. */
export type AiSource =
  | { kind: 'ledger'; ledgerId: number; label: string }
  | { kind: 'voucher'; voucherId: number; label: string }
  | { kind: 'item'; itemId: number; label: string }
  | { kind: 'screen'; screen: string; label: string; params?: Record<string, string | number> }

/** A money-looking figure in an answer, and whether it appears in this turn's tool results. */
export interface AiFigure {
  text: string
  paise: number
  sourced: boolean
  /** The tool whose result contains it. */
  tool: string | null
  /** Shorthand (₹1.2L) matched a source only within its rounding. */
  approximate?: boolean
  /** WP 5.2: the ledger / voucher / item (else the screen) the figure was found under in that
   *  tool's result — the panel renders the figure as a chip linking there. */
  source?: AiSource
}

export interface AiToolCallDto {
  callId: string
  name: string
  /** As the model sent it (after pseudonyms are mapped back). */
  input: unknown
}

export type AiMessageRole = 'user' | 'assistant' | 'tool'

export interface AiMessageDto {
  id: number
  threadId: number
  role: AiMessageRole
  content: string
  status: 'ok' | 'error' | 'cancelled'
  toolCalls: AiToolCallDto[]
  /** role 'tool': which call this answers. */
  toolCallId: string | null
  toolName: string | null
  toolInput: unknown
  /** role 'tool': the full local result (truncation applies only to what is sent). */
  toolOutput: unknown
  toolOk: boolean | null
  truncated: boolean
  sources: AiSource[]
  figures: AiFigure[]
  model: string | null
  costMicroUsd: number | null
  inputTokens: number | null
  outputTokens: number | null
  draftId: number | null
  createdAt: string
}

export interface AiThreadDto {
  id: number
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
  costMicroUsd: number | null
  running: boolean
  /** WP 5.2: pinned conversations sort first. */
  pinned: boolean
}

export type AiDraftStatus = 'open' | 'consumed' | 'discarded'

/** What draft_voucher stores and the voucher editor pre-fills from. Amounts are paise. */
export interface AiVoucherDraftPayload {
  voucherTypeId: number
  voucherKind: string
  date: string
  partyLedgerId: number | null
  narration: string | null
  reference: string | null
  lines: { ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[]
}

export interface AiDraftDto {
  id: number
  threadId: number | null
  kind: 'voucher'
  summary: string
  payload: AiVoucherDraftPayload
  status: AiDraftStatus
  voucherId: number | null
  /** Made when the user's question did not ask for a draft (possible instruction injected via
   *  narration or imported text) — shown with a warning. */
  unrequested: boolean
  createdAt: string
  consumedAt: string | null
}

export interface AiUsageRow {
  id: number
  at: string
  day: string
  threadId: number | null
  threadTitle: string | null
  model: string
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  costMicroUsd: number | null
  durationMs: number
  ok: boolean
}

export interface AiOutboundRow {
  id: number
  at: string
  threadId: number | null
  model: string
  provider: string
  requestBytes: number
  messageCount: number
  toolsOffered: string[]
  toolResultsSent: string[]
  masked: boolean
  pseudonymised: boolean
  payloadSha256: string
  status: string
  /** WP 5.2: the screen context included in the request (screen, period, parameters, figure). */
  context: AiContext | null
}

export interface AiSettingsView {
  settings: AiSettings
  keyPresent: boolean
  /** e.g. '…a1b2' — never the key. */
  keyHint: string | null
  secureStorageAvailable: boolean
  /** TOTAL_AI_MOCK test provider in use (scratch data dirs only). */
  mock: boolean
  /** Ready to answer: enabled + notice accepted + key (or mock). */
  ready: boolean
  /** Why not ready, in plain words. */
  blocker: string | null
}

export interface AiConnectionResult {
  ok: boolean
  models: string[]
  defaultModelFound: boolean
  fastModelFound: boolean
  error: string | null
}

export interface AiToolInfo {
  name: string
  description: string
  kind: 'read' | 'draft'
  minRole: 'viewer' | 'accountant' | 'owner'
}

/** Streamed over `total:ai:event` (webContents.send) while a question is being answered. */
export type AiEvent =
  | { type: 'run-start'; threadId: number; runId: string; userMessage: AiMessageDto }
  | { type: 'delta'; threadId: number; runId: string; text: string }
  | { type: 'tool-start'; threadId: number; runId: string; callId: string; name: string; input: unknown }
  | { type: 'message'; threadId: number; runId: string; message: AiMessageDto }
  | { type: 'draft'; threadId: number; runId: string; draft: AiDraftDto }
  | { type: 'done'; threadId: number; runId: string }
  | { type: 'error'; threadId: number; runId: string; error: string }
  | { type: 'cancelled'; threadId: number; runId: string }

/** '$0.0123' from micro-USD (4 decimals); null → '—'. Integer maths, no floats. */
export function formatMicroUsd(micro: number | null | undefined): string {
  if (micro == null) return '—'
  const tenThousandths = Math.round(micro / 100)
  const whole = Math.floor(tenThousandths / 10000)
  const frac = String(tenThousandths % 10000).padStart(4, '0')
  return `$${whole}.${frac}`
}

/** "1.25" (USD) → 1250000 micro-USD; '' → null; invalid → undefined. String maths, no floats. */
export function parseUsdToMicro(text: string): number | null | undefined {
  const t = text.trim().replace(/^\$/, '')
  if (t === '') return null
  const m = /^(\d{1,6})(?:\.(\d{1,6}))?$/.exec(t)
  if (!m) return undefined
  return Number(m[1]) * 1_000_000 + Number((m[2] ?? '').padEnd(6, '0'))
}

/** 1250000 → "1.25" (trailing zeros dropped); null → ''. */
export function microToUsdText(micro: number | null | undefined): string {
  if (micro == null) return ''
  const whole = Math.floor(micro / 1_000_000)
  const frac = String(micro % 1_000_000).padStart(6, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : String(whole)
}

export interface AiUsageAggregate {
  key: string
  label: string
  calls: number
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  /** null when no call in the group had a price. */
  costMicroUsd: number | null
  /** Calls without a price (cost unknown). */
  unpriced: number
}

/** Usage rows totalled by day or by conversation (Settings → AI). */
export function aggregateUsage(rows: readonly AiUsageRow[], by: 'day' | 'thread'): AiUsageAggregate[] {
  const groups = new Map<string, AiUsageAggregate>()
  for (const r of rows) {
    const key = by === 'day' ? r.day : String(r.threadId ?? 0)
    const label = by === 'day' ? r.day : (r.threadTitle ?? (r.threadId ? `Conversation ${r.threadId}` : 'Deleted conversation'))
    let g = groups.get(key)
    if (!g) {
      g = { key, label, calls: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, costMicroUsd: null, unpriced: 0 }
      groups.set(key, g)
    }
    g.calls++
    g.inputTokens += r.inputTokens
    g.cachedTokens += r.cachedTokens
    g.outputTokens += r.outputTokens
    if (r.costMicroUsd == null) g.unpriced++
    else g.costMicroUsd = (g.costMicroUsd ?? 0) + r.costMicroUsd
  }
  return [...groups.values()].sort((a, b) => (by === 'day' ? b.key.localeCompare(a.key) : b.calls - a.calls))
}
