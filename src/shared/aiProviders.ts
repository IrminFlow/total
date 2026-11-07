/**
 * AI provider presets (Phase 3a). Which OpenAI-compatible service the assistant talks to — one
 * choice for the whole app (like the key), stored in `<dataRoot>/app-settings.json` under
 * `aiProvider`; the key itself stays in the secret store (scope 'app'), one per preset, and
 * custom headers (some gateways want one) are kept there too — only their NAMES reach the
 * renderer.
 *
 * Pure shapes and rules: the presets, what each endpoint can do (tools, structured answers,
 * photos, PDF files), the base-URL rule (a local preset is localhost only; a custom URL is https,
 * or http only on this computer) and the model pick. src/main/ai/provider.ts turns a resolved
 * provider into a client; nothing here touches the network.
 *
 * No setting stored = OpenAI on api.openai.com through the Responses API, with the key Total has
 * always kept (`openai_api_key`) — exactly what existing users had before presets.
 */
import { z } from 'zod'

export const AI_PRESET_IDS = ['openai', 'openrouter', 'groq', 'gemini', 'ollama', 'lmstudio', 'custom'] as const
export type AiPresetId = (typeof AI_PRESET_IDS)[number]

/** What an endpoint can do. False = Total does not ask it for that and says so in plain words. */
export interface AiCapabilities {
  /** Function calling — Total's tools (reading the books, making drafts). */
  tools: boolean
  /** JSON-schema answers — bill capture and statement categories need them. */
  structured: boolean
  /** Photos of bills (input images). */
  images: boolean
  /** PDF files sent as files (scans without a text layer). */
  files: boolean
}

export const AI_CAPABILITY_KEYS = ['tools', 'structured', 'images', 'files'] as const satisfies readonly (keyof AiCapabilities)[]

/** 'responses' = OpenAI's Responses API; 'chat' = Chat Completions, what every compatible server speaks. */
export type AiApiStyle = 'responses' | 'chat'

export interface AiPreset {
  id: AiPresetId
  label: string
  /** The default address of an EDITABLE preset (a local server's usual port); '' for the others.
   *  The fixed endpoints of hosted services live in main (ai/providerConfig.ts FIXED_ENDPOINTS),
   *  so the renderer bundle never carries an AI service's API address. */
  baseUrl: string
  api: AiApiStyle
  /** Runs on this computer: no key, base URL editable but localhost only. */
  local: boolean
  /** A key is needed to talk to it. */
  needsKey: boolean
  /** The base URL may be changed (local servers on another port, a custom endpoint). */
  editableUrl: boolean
  /** Custom headers may be added (stored in the secret store). */
  headers: boolean
  /** Declared capabilities. Many depend on the MODEL picked — a model that refuses one is caught
   *  by the provider's error and said in plain words (provider.ts capabilityRefusal). */
  caps: AiCapabilities
  /** Where to get a key (shown as text; the renderer has no network). */
  keyPage: string | null
}

export const AI_ALL_CAPABILITIES: AiCapabilities = { tools: true, structured: true, images: true, files: true }

export const AI_PRESETS: Record<AiPresetId, AiPreset> = {
  openai: { id: 'openai', label: 'OpenAI', baseUrl: '', api: 'responses', local: false, needsKey: true, editableUrl: false, headers: false, caps: AI_ALL_CAPABILITIES, keyPage: 'platform.openai.com/api-keys' },
  openrouter: {
    id: 'openrouter', label: 'OpenRouter', baseUrl: '', api: 'chat', local: false, needsKey: true, editableUrl: false, headers: true,
    caps: { tools: true, structured: true, images: true, files: true }, keyPage: 'openrouter.ai/keys'
  },
  groq: {
    id: 'groq', label: 'Groq', baseUrl: '', api: 'chat', local: false, needsKey: true, editableUrl: false, headers: false,
    caps: { tools: true, structured: true, images: true, files: false }, keyPage: 'console.groq.com/keys'
  },
  gemini: {
    id: 'gemini', label: 'Google Gemini', baseUrl: '', api: 'chat', local: false, needsKey: true, editableUrl: false, headers: false,
    caps: { tools: true, structured: true, images: true, files: false }, keyPage: 'aistudio.google.com/apikey'
  },
  ollama: {
    id: 'ollama', label: 'Ollama (on this computer)', baseUrl: 'http://localhost:11434/v1', api: 'chat', local: true, needsKey: false, editableUrl: true, headers: false,
    caps: { tools: true, structured: true, images: true, files: false }, keyPage: null
  },
  lmstudio: {
    id: 'lmstudio', label: 'LM Studio (on this computer)', baseUrl: 'http://localhost:1234/v1', api: 'chat', local: true, needsKey: false, editableUrl: true, headers: false,
    caps: { tools: true, structured: true, images: true, files: false }, keyPage: null
  },
  custom: {
    id: 'custom', label: 'Custom (OpenAI-compatible)', baseUrl: '', api: 'chat', local: false, needsKey: false, editableUrl: true, headers: true,
    caps: { tools: true, structured: true, images: false, files: false }, keyPage: null
  }
}

/** The stored choice (app-settings.json `aiProvider`). */
export interface AiProviderSettings {
  preset: AiPresetId
  /** Only for presets with an editable URL; null = the preset's own. */
  baseUrl: string | null
  /** Custom only: what the endpoint can do, as the user says (null = the preset's defaults). */
  caps: AiCapabilities | null
}

export const DEFAULT_AI_PROVIDER: AiProviderSettings = { preset: 'openai', baseUrl: null, caps: null }

/** What main resolves before building a client. */
export interface ResolvedAiProvider {
  preset: AiPresetId
  label: string
  baseUrl: string
  api: AiApiStyle
  local: boolean
  needsKey: boolean
  caps: AiCapabilities
  keyPage: string | null
}

/** What the renderer sees: the choice, its effect, and header NAMES only (values stay in main). */
export interface AiProviderView extends ResolvedAiProvider {
  /** The stored base URL override (editable presets), null = the preset's own. */
  baseUrlOverride: string | null
  headerNames: string[]
  /** A key is saved for THIS preset. */
  keyPresent: boolean
  keyHint: string | null
  /** The base URL is missing / invalid (custom without one) — in plain words. */
  urlProblem: string | null
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host.toLowerCase())
}

/**
 * The base-URL rule. A local preset (Ollama, LM Studio) must point at THIS computer (localhost,
 * 127.0.0.1, ::1; http or https). A custom endpoint must be https, or http only on this computer
 * (a key never travels in clear text over a network). No credentials or query in the URL.
 * Returns the cleaned URL (no trailing slash) or a plain-words problem.
 */
export type BaseUrlProblem = 'empty' | 'notUrl' | 'scheme' | 'credentials' | 'query' | 'notLocal' | 'notHttps'

/** English words for each problem (main, the accountant screen); simple mode maps the code to t(). */
export function baseUrlProblemText(code: BaseUrlProblem, preset: AiPresetId): string {
  switch (code) {
    case 'empty': return 'Type the address of the AI service (it usually ends in /v1).'
    case 'notUrl': return 'That is not a web address — it starts with http:// or https://.'
    case 'scheme': return 'The address must start with http:// or https://.'
    case 'credentials': return 'Put the key in the key box, not in the address.'
    case 'query': return 'The address cannot carry ? or # parts.'
    case 'notLocal': return `${AI_PRESETS[preset].label} runs on this computer: the address must be localhost or 127.0.0.1.`
    case 'notHttps': return 'Use https:// — plain http:// is allowed only for a server on this computer.'
  }
}

export function checkBaseUrl(preset: AiPresetId, raw: string): { ok: true; url: string; origin: string } | { ok: false; code: BaseUrlProblem; error: string } {
  const p = AI_PRESETS[preset]
  const bad = (code: BaseUrlProblem): { ok: false; code: BaseUrlProblem; error: string } => ({ ok: false, code, error: baseUrlProblemText(code, preset) })
  const text = raw.trim()
  if (!text) return bad('empty')
  let u: URL
  try {
    u = new URL(text)
  } catch {
    return bad('notUrl')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return bad('scheme')
  if (u.username || u.password) return bad('credentials')
  if (u.search || u.hash) return bad('query')
  const loop = isLoopbackHost(u.hostname)
  if (p.local && !loop) return bad('notLocal')
  if (!p.local && u.protocol === 'http:' && !loop) return bad('notHttps')
  const url = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`
  return { ok: true, url, origin: u.origin }
}

/** `fixed` = main's endpoints of the hosted presets (ai/providerConfig.ts); without them a fixed
 *  preset resolves with an empty address (only views built for tests do that). */
export function resolveAiProvider(s: AiProviderSettings, fixed: Partial<Record<AiPresetId, string>> = {}): ResolvedAiProvider & { urlProblem: string | null } {
  const p = AI_PRESETS[s.preset] ?? AI_PRESETS.openai
  let baseUrl = p.editableUrl ? p.baseUrl : (fixed[p.id] ?? '')
  let urlProblem: string | null = null
  if (p.editableUrl && s.baseUrl) {
    const c = checkBaseUrl(p.id, s.baseUrl)
    if (c.ok) baseUrl = c.url
    else urlProblem = c.error
  }
  if (p.editableUrl && !baseUrl && !urlProblem) urlProblem = 'Type the address of the AI service (it usually ends in /v1).'
  const caps = p.id === 'custom' && s.caps ? { ...s.caps } : { ...p.caps }
  return { preset: p.id, label: p.label, baseUrl, api: p.api, local: p.local, needsKey: p.needsKey, caps, keyPage: p.keyPage, urlProblem }
}

/** A stored value → settings; anything unreadable = the default (OpenAI, as before presets). */
export function readAiProviderSettings(raw: unknown): AiProviderSettings {
  const r = aiProviderStoredSchema.safeParse(raw)
  return r.success ? r.data : { ...DEFAULT_AI_PROVIDER }
}

const capsSchema = z.object({ tools: z.boolean(), structured: z.boolean(), images: z.boolean(), files: z.boolean() }).strict()

const aiProviderStoredSchema = z
  .object({ preset: z.enum(AI_PRESET_IDS), baseUrl: z.string().max(300).nullable(), caps: capsSchema.nullable() })
  .strict()

/** Header names: a token (RFC 7230), never one the client sets itself. */
const RESERVED_HEADERS = /^(authorization|content-type|content-length|host|connection|transfer-encoding|accept-encoding|cookie|user-agent)$/i
export const aiHeaderNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, 'Header names are letters, digits and - _ .')
  .refine((n) => !RESERVED_HEADERS.test(n), 'Total sets that header itself')

/** ai:provider:set. `headers` replaces every custom header (a value '' keeps the stored value of
 *  that name — the renderer never has it); absent = keep. Only presets that take headers. */
export const aiProviderSetSchema = z
  .object({
    preset: z.enum(AI_PRESET_IDS),
    baseUrl: z.string().trim().max(300).nullable().optional(),
    caps: capsSchema.nullable().optional(),
    headers: z.array(z.object({ name: aiHeaderNameSchema, value: z.string().max(2000) }).strict()).max(10).optional(),
    confirmNoUsers: z.boolean().default(false)
  })
  .strict()
export type AiProviderSetInput = z.input<typeof aiProviderSetSchema>

/** Secret-store name of a preset's key. OpenAI keeps the name it always had. */
export function presetKeySecret(preset: AiPresetId): string {
  return preset === 'openai' ? 'openai_api_key' : `ai_api_key:${preset}`
}
export function presetHeadersSecret(preset: AiPresetId): string {
  return `ai_headers:${preset}`
}

// ---------- capability refusals, in plain words (main side; the simple screens use t()) ----------

export type AiCapabilityNeed = keyof AiCapabilities

export const CAPABILITY_MESSAGES: Record<AiCapabilityNeed, string> = {
  tools: 'This AI service can’t use Total’s tools, so it can’t read your books or make drafts. Pick another service or model in Settings → AI for that.',
  structured: 'This AI service can’t give the structured answers Total needs to read bills or bank lines. Pick another service or model in Settings → AI.',
  images: 'This AI service can’t read photos. Pick another service or model in Settings → AI, or use a PDF with text in it.',
  files: 'This AI service can’t read PDF files that are scans. Pick another service or model in Settings → AI, or use a PDF with text in it.'
}

/** Thrown (by main) when the chosen provider cannot do what a feature needs. */
export class AiCapabilityError extends Error {
  readonly need: AiCapabilityNeed
  constructor(need: AiCapabilityNeed, message = CAPABILITY_MESSAGES[need]) {
    super(message)
    this.name = 'AiCapabilityError'
    this.need = need
  }
}

/** A provider's error text that means "this endpoint / model can't do X" (Ollama: "… does not
 *  support tools"; OpenAI-compatible servers: "image input is not supported", "response_format …
 *  not supported"). Null = some other failure. */
export function capabilityRefusal(message: string): AiCapabilityNeed | null {
  const m = message.toLowerCase()
  // Only words that say the endpoint / model lacks the ability — never a bare "invalid" (an
  // invalid schema or a broken image is a different failure, said as it is).
  if (!/(not support|unsupported|does not accept|doesn'?t support|only supported|not available for|not enabled)/.test(m)) return null
  if (/\btools?\b|function[_ ]?call/.test(m)) return 'tools'
  if (/image|vision|image_url/.test(m)) return 'images'
  if (/\bfile|pdf|input_file/.test(m)) return 'files'
  if (/response_format|json_schema|structured|json mode/.test(m)) return 'structured'
  return null
}

// ---------- the model pick (moved from simple/aiPlain.ts, re-exported there) ----------

/** Model ids that are not chat models (embeddings, speech, images, moderation …). */
const NOT_CHAT = /(embed|whisper|tts|audio|speech|transcri|dall-?e|image|imagen|veo|moderation|realtime|search|computer-use|instruct|babbage|davinci|codex|guard|rerank|\baqa\b|compound)/i
/** Small / quick variants — good for the fast model, not the default. */
/** Matched on whole segments of the id ("gemini" is not "mini"; "llama-3.1-8b" is small). */
const SMALL = /(^|[-_:/.])(mini|nano|luna|lite|small|fast|haiku|flash|flash-lite|instant|[1-8](\.\d)?b)($|[-_:/.])/i
/** Previews / experiments rank below the stable model of the same version. */
const UNSTABLE = /(preview|exp|experimental|beta|alpha)/i
/** A dated snapshot (…-2025-08-06 / …-0613) — the undated alias is preferred. */
const DATED = /-(\d{4}-\d{2}-\d{2}|\d{4})$/

/** The family's version: gpt-6.1-sol → [6, 1]; o3 → [3]; openai/gpt-5 → [5]; models/gemini-2.5-pro
 *  → [2, 5]; llama-3.3-70b → [3, 3]; qwen2.5:14b → [2, 5]; anything else → []. */
function versionOf(id: string): number[] {
  const bare = id.slice(id.lastIndexOf('/') + 1)
  const m = /^(?:gpt-|o|gemini-|gemma-?|llama-?|qwen|mistral-|mixtral-|deepseek-[a-z]*-?|claude-[a-z]*-?|phi-?)(\d+(?:\.\d+)*)/i.exec(bare)
  return m ? m[1]!.split('.').map(Number) : []
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1)
    if (d !== 0) return d
  }
  return 0
}

/** gemini-2.5-pro → 'gemini', openai/gpt-5 → 'gpt', qwen2.5:14b → 'qwen', o3 → 'o'. */
function familyOf(id: string): string {
  const bare = id.slice(id.lastIndexOf('/') + 1).toLowerCase()
  return /^[a-z]+/.exec(bare)?.[0] ?? bare
}

/** Best first: chat models, undated, stable, the family the list offers most (versions are only
 *  compared within a family — gemma 3 is not "newer" than gemini 2.5), newest version, then by
 *  name (stable). */
export function rankModels(models: readonly string[], small: boolean): string[] {
  const chat = models.filter((m) => !NOT_CHAT.test(m))
  const freq = new Map<string, number>()
  for (const m of chat) freq.set(familyOf(m), (freq.get(familyOf(m)) ?? 0) + 1)
  return chat
    .filter((m) => SMALL.test(m) === small)
    .sort((a, b) => {
      const dated = Number(DATED.test(a)) - Number(DATED.test(b))
      if (dated !== 0) return dated
      const unstable = Number(UNSTABLE.test(a)) - Number(UNSTABLE.test(b))
      if (unstable !== 0) return unstable
      const fa = familyOf(a)
      const fb = familyOf(b)
      if (fa !== fb) {
        const f = (freq.get(fb) ?? 0) - (freq.get(fa) ?? 0)
        return f !== 0 ? f : fa.localeCompare(fb)
      }
      const v = compareVersions(versionOf(b), versionOf(a))
      return v !== 0 ? v : a.localeCompare(b)
    })
}

export interface ModelPick {
  defaultModel: string
  fastModel: string
  /** Either differs from the current settings (the screen saves it). */
  changed: boolean
  /** The default model is one the key's list offers. False = the list had no chat model (or was
   *  empty): the current ids are kept, unverified, and the screen says so — never a guess. */
  found: boolean
}

/**
 * The key check listed `models`: keep the current default / fast model when the key offers it,
 * else pick from the list — the newest undated chat model for the default, the newest small one
 * for the fast model (else the default). An empty list keeps the current ids (nothing to pick from;
 * the user types one).
 */
export function pickModels(models: readonly string[], current: { defaultModel: string; fastModel: string }): ModelPick {
  const keep = { defaultModel: current.defaultModel, fastModel: current.fastModel, changed: false, found: false }
  if (models.length === 0) return keep
  const big = rankModels(models, false)
  const small = rankModels(models, true)
  // Never fall back to any listed id (an embedding or speech model would be "picked").
  const defaultModel = models.includes(current.defaultModel) ? current.defaultModel : (big[0] ?? small[0])
  if (!defaultModel) return keep
  const fastModel = models.includes(current.fastModel) ? current.fastModel : (small[0] ?? defaultModel)
  return { defaultModel, fastModel, changed: defaultModel !== current.defaultModel || fastModel !== current.fastModel, found: true }
}

/** The view of a stored choice without any secret (tests, and a renderer fallback). */
export function providerViewOf(s: AiProviderSettings = DEFAULT_AI_PROVIDER, key: { present: boolean; hint: string | null } = { present: false, hint: null }): AiProviderView {
  const { urlProblem, ...resolved } = resolveAiProvider(s)
  return { ...resolved, baseUrlOverride: s.baseUrl, headerNames: [], keyPresent: key.present, keyHint: key.hint, urlProblem }
}
