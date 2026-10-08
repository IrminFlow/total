// AI settings (WP 5.1). Per company, in the company's `meta` table under 'ai' — the on/off switch,
// the accepted data notice, model ids, privacy options, the price table — so they travel with the
// company and every change lands in its audit trail (entity 'ai_settings'). The API key is the
// exception: it is app-wide, in the secret store (scope 'app', services/secrets.ts), never in a
// company DB or backup, and only a hint ("…a1b2") is ever returned to the renderer.
import type { DB } from '../db/connection'
import {
  AI_DATA_NOTICE_VERSION, AI_DEFAULT_FAST_MODEL, AI_DEFAULT_MODEL, aiSettingsPatchSchema, type AiSettings, type AiSettingsPatch
} from '@shared/ai'
import { APP_SCOPE, type SecretStore } from '../services/secrets'
import { writeAudit } from '../services/audit'

const META_KEY = 'ai'
export const API_KEY_SECRET = 'openai_api_key'

export function defaultAiSettings(): AiSettings {
  return {
    enabled: false,
    noticeAcceptedAt: null,
    noticeAcceptedBy: null,
    noticeVersion: null,
    defaultModel: AI_DEFAULT_MODEL,
    fastModel: AI_DEFAULT_FAST_MODEL,
    privacy: { maskIds: true, pseudonymiseParties: false },
    prices: {},
    maxSteps: 8,
    useMemory: true
  }
}

export function getAiSettings(db: DB): AiSettings {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(META_KEY) as { value: string } | undefined
  const d = defaultAiSettings()
  if (!row) return d
  try {
    const s = JSON.parse(row.value) as Partial<AiSettings>
    return { ...d, ...s, privacy: { ...d.privacy, ...(s.privacy ?? {}) }, prices: { ...(s.prices ?? {}) } }
  } catch {
    return d
  }
}

function writeSettings(db: DB, s: AiSettings): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(META_KEY, JSON.stringify(s))
}

/** Apply a validated patch. Turning AI on needs the data notice accepted first. */
export function patchAiSettings(db: DB, raw: AiSettingsPatch): AiSettings {
  const patch = aiSettingsPatchSchema.parse(raw)
  const before = getAiSettings(db)
  if (patch.enabled && (!before.noticeAcceptedAt || before.noticeVersion !== AI_DATA_NOTICE_VERSION)) {
    throw new Error('Read and accept the data notice before turning the assistant on')
  }
  const after: AiSettings = {
    ...before,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.defaultModel ? { defaultModel: patch.defaultModel } : {}),
    ...(patch.fastModel ? { fastModel: patch.fastModel } : {}),
    ...(patch.maxSteps ? { maxSteps: patch.maxSteps } : {}),
    ...(patch.useMemory !== undefined ? { useMemory: patch.useMemory } : {}),
    privacy: { ...before.privacy, ...(patch.privacy ?? {}) },
    prices: patch.prices ? { ...patch.prices } : before.prices
  }
  db.transaction(() => {
    writeSettings(db, after)
    writeAudit(db, 'ai_settings', 0, 'update', before, after)
  })()
  return after
}

export function acceptNotice(db: DB, userName: string | null): AiSettings {
  const before = getAiSettings(db)
  const after: AiSettings = { ...before, noticeAcceptedAt: new Date().toISOString(), noticeAcceptedBy: userName, noticeVersion: AI_DATA_NOTICE_VERSION }
  db.transaction(() => {
    writeSettings(db, after)
    writeAudit(db, 'ai_settings', 0, 'update', before, after)
  })()
  return after
}

// ---------- the API key (secret store, scope 'app') ----------

export function keyHint(key: string | null): string | null {
  if (!key) return null
  return `…${key.slice(-4)}`
}

export function readApiKey(store: SecretStore): string | null {
  try {
    return store.get(APP_SCOPE, API_KEY_SECRET)
  } catch {
    return null
  }
}

/** Store the key; the company's audit trail records that a key was set (and its hint), never the key. */
export function setApiKey(db: DB | null, store: SecretStore, key: string): { keyHint: string | null } {
  const before = readApiKey(store)
  store.set(APP_SCOPE, API_KEY_SECRET, key)
  if (db) writeAudit(db, 'ai_settings', 0, 'update', { apiKey: before ? keyHint(before) : null }, { apiKey: keyHint(key) })
  return { keyHint: keyHint(key) }
}

export function clearApiKey(db: DB | null, store: SecretStore): void {
  const before = readApiKey(store)
  store.delete(APP_SCOPE, API_KEY_SECRET)
  if (db) writeAudit(db, 'ai_settings', 0, 'update', { apiKey: before ? keyHint(before) : null }, { apiKey: null })
}
