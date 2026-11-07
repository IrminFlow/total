/**
 * App-level settings — one small JSON file beside total.json under the data root
 * (`app-settings.json`), outside every company DB and every backup. Holds the update
 * preferences and (Phase 3a) the AI service. Changes are appended to `app-settings-audit.jsonl` (append-only, like
 * `ai-key-audit.jsonl`). Pure Node (fs/path): the root is injected, so it is unit-testable.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DEFAULT_UPDATE_SETTINGS, type UpdateSettings } from '@shared/updates'
import { DEFAULT_AI_PROVIDER, readAiProviderSettings, type AiProviderSettings } from '@shared/aiProviders'

const FILE = 'app-settings.json'
const AUDIT = 'app-settings-audit.jsonl'

/** Missing / unreadable / malformed file = the defaults (automatic check ON, nothing skipped).
 *  `onCorrupt` hears about a file that exists but cannot be read (a missing file is normal). */
export function readUpdateSettings(root: string, onCorrupt?: (error: string) => void): UpdateSettings {
  try {
    const raw = JSON.parse(readFileSync(join(root, FILE), 'utf8')) as { updates?: Partial<UpdateSettings> } | null
    const u = (raw && typeof raw === 'object' ? raw.updates : null) ?? {}
    return {
      autoCheck: typeof u.autoCheck === 'boolean' ? u.autoCheck : DEFAULT_UPDATE_SETTINGS.autoCheck,
      skippedVersion: typeof u.skippedVersion === 'string' && u.skippedVersion ? u.skippedVersion : null
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') onCorrupt?.(String(err))
    return { ...DEFAULT_UPDATE_SETTINGS }
  }
}

/** Merge a patch into the stored settings (atomic write) and audit what changed. */
export function writeUpdateSettings(
  root: string,
  patch: Partial<UpdateSettings>,
  who: string | null,
  appVersion: string,
  onCorrupt?: (error: string) => void
): UpdateSettings {
  const before = readUpdateSettings(root, onCorrupt)
  const after: UpdateSettings = { ...before, ...patch }
  if (after.autoCheck === before.autoCheck && after.skippedVersion === before.skippedVersion) return before
  mkdirSync(root, { recursive: true })
  let rest: Record<string, unknown> = {}
  try {
    if (existsSync(join(root, FILE))) {
      const parsed = JSON.parse(readFileSync(join(root, FILE), 'utf8')) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) rest = parsed as Record<string, unknown>
    }
  } catch {
    rest = {}
  }
  const tmp = join(root, `${FILE}.tmp`)
  writeFileSync(tmp, JSON.stringify({ ...rest, updates: after }, null, 2), { mode: 0o600 })
  renameSync(tmp, join(root, FILE))
  appendFileSync(join(root, AUDIT), `${JSON.stringify({ at: new Date().toISOString(), user: who, setting: 'updates', before, after, appVersion })}\n`, { mode: 0o600 })
  return after
}

// ---------- the AI service (Phase 3a) — `aiProvider` in the same file ----------

/** Missing / unreadable = OpenAI as before presets (shared/aiProviders.ts readAiProviderSettings). */
export function readAiProviderSetting(root: string): AiProviderSettings {
  try {
    const raw = JSON.parse(readFileSync(join(root, FILE), 'utf8')) as { aiProvider?: unknown } | null
    return readAiProviderSettings(raw && typeof raw === 'object' ? raw.aiProvider : undefined)
  } catch {
    return { ...DEFAULT_AI_PROVIDER }
  }
}

/** Store the choice (atomic write, other keys kept) and append the change to the audit file. */
export function writeAiProviderSetting(root: string, next: AiProviderSettings, who: string | null, appVersion: string): void {
  const before = readAiProviderSetting(root)
  mkdirSync(root, { recursive: true })
  let rest: Record<string, unknown> = {}
  try {
    if (existsSync(join(root, FILE))) {
      const parsed = JSON.parse(readFileSync(join(root, FILE), 'utf8')) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) rest = parsed as Record<string, unknown>
    }
  } catch {
    rest = {}
  }
  const tmp = join(root, `${FILE}.tmp`)
  writeFileSync(tmp, JSON.stringify({ ...rest, aiProvider: next }, null, 2), { mode: 0o600 })
  renameSync(tmp, join(root, FILE))
  appendFileSync(join(root, AUDIT), `${JSON.stringify({ at: new Date().toISOString(), user: who, setting: 'aiProvider', before, after: next, appVersion })}\n`, { mode: 0o600 })
}
