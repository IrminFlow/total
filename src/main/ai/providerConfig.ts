// Phase 3a: which AI service the app talks to. One choice for the whole app (the key is app-wide
// too): the preset + base URL + declared capabilities live in <dataRoot>/app-settings.json under
// `aiProvider` (services/appSettings.ts, changes appended to app-settings-audit.jsonl); the key
// and any custom header values live in the secret store (scope 'app'), one key per preset — the
// OpenAI key keeps the name it always had, so an existing user's setup is read exactly as before.
// No `aiProvider` stored = OpenAI through the Responses API at api.openai.com.
import {
  DEFAULT_AI_PROVIDER, presetHeadersSecret, presetKeySecret, readAiProviderSettings, resolveAiProvider, type AiProviderSettings, type AiProviderView, type ResolvedAiProvider
} from '@shared/aiProviders'
import { APP_SCOPE, type SecretStore } from '../services/secrets'
import { keyHint } from './settings'

/** Where the choice is kept. The app uses the app-settings file; dbtests an in-memory one. */
export interface AiProviderSource {
  read(): AiProviderSettings
  write(next: AiProviderSettings, who: string | null): void
}

export function memoryProviderSource(initial: AiProviderSettings = DEFAULT_AI_PROVIDER): AiProviderSource & { value: AiProviderSettings } {
  const src = {
    value: { ...initial },
    read: () => readAiProviderSettings(src.value),
    write: (next: AiProviderSettings) => {
      src.value = { ...next }
    }
  }
  return src
}

/** The hosted services' API addresses (kept out of shared code, so out of the renderer bundle). */
export const FIXED_ENDPOINTS: Record<'openai' | 'openrouter' | 'groq' | 'gemini', string> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai'
}

let source: AiProviderSource = memoryProviderSource()

/** Set once by main/ipc.ts (the app-settings file); tests may set their own. */
export function useAiProviderSource(s: AiProviderSource): void {
  source = s
}

export function aiProviderSource(): AiProviderSource {
  return source
}

export function readPresetKey(store: SecretStore, preset: AiProviderSettings['preset']): string | null {
  try {
    return store.get(APP_SCOPE, presetKeySecret(preset))
  } catch {
    return null
  }
}

/** Stored custom headers of a preset ({} when none / unreadable). Values never leave main. */
export function readPresetHeaders(store: SecretStore, preset: AiProviderSettings['preset']): Record<string, string> {
  try {
    const raw = store.get(APP_SCOPE, presetHeadersSecret(preset))
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'))
  } catch {
    return {}
  }
}

export function writePresetHeaders(store: SecretStore, preset: AiProviderSettings['preset'], headers: Record<string, string>): void {
  if (Object.keys(headers).length === 0) store.delete(APP_SCOPE, presetHeadersSecret(preset))
  else store.set(APP_SCOPE, presetHeadersSecret(preset), JSON.stringify(headers))
}

/** Everything main needs to build the client for the current choice. */
export interface CurrentProvider {
  settings: AiProviderSettings
  resolved: ResolvedAiProvider & { urlProblem: string | null }
  apiKey: string | null
  headers: Record<string, string>
}

export const CUSTOM_ORIGIN_MOVED = 'The address of the AI service changed outside Total — save it again in Settings → AI (its key and extra headers stay with the address they were saved for)'

export function currentProvider(store: SecretStore): CurrentProvider {
  const settings = source.read()
  const resolved = resolveAiProvider(settings, FIXED_ENDPOINTS)
  // A custom service's key and headers go only to the origin they were saved for — app-settings.json
  // is plain text, so an address changed there (not through ai:provider:set) gets neither.
  if (resolved.preset === 'custom' && resolved.baseUrl) {
    const bound = boundCustomOrigin(store)
    let origin: string | null = null
    try {
      origin = new URL(resolved.baseUrl).origin
    } catch {
      origin = null
    }
    if (bound && bound !== origin) return { settings, resolved: { ...resolved, urlProblem: resolved.urlProblem ?? CUSTOM_ORIGIN_MOVED }, apiKey: null, headers: {} }
  }
  return { settings, resolved, apiKey: readPresetKey(store, resolved.preset), headers: readPresetHeaders(store, resolved.preset) }
}

export function providerView(store: SecretStore): AiProviderView {
  const c = currentProvider(store)
  const { urlProblem, ...resolved } = c.resolved
  return {
    ...resolved,
    baseUrlOverride: c.settings.baseUrl,
    headerNames: Object.keys(c.headers).sort(),
    keyPresent: !!c.apiKey,
    keyHint: keyHint(c.apiKey),
    urlProblem
  }
}

const CUSTOM_ORIGIN_SECRET = 'ai_bound_origin:custom'

/** The origin the custom service's key / headers were saved for (null = none recorded). */
export function boundCustomOrigin(store: SecretStore): string | null {
  try {
    return store.get(APP_SCOPE, CUSTOM_ORIGIN_SECRET)
  } catch {
    return null
  }
}

export function bindCustomOrigin(store: SecretStore, baseUrl: string): void {
  if (!baseUrl) return
  try {
    store.set(APP_SCOPE, CUSTOM_ORIGIN_SECRET, new URL(baseUrl).origin)
  } catch {
    /* no secure storage: nothing bound, nothing to protect either */
  }
}
