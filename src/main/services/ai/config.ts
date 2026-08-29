/**
 * AI configuration persistence.
 *
 * The API key is machine-level, not per company, and never goes in the company database. A
 * company DB is copied into every backup, snapshot, CA pack and restore, and is opened read-only
 * by other companies' processes — see ../../secrets for the full argument. A key is also a
 * per-user thing: three accountants sharing one restored company file should not share one
 * billed key.
 *
 * Everything else (endpoint, model, caps) lives beside it in the same machine-level file, so
 * moving a company between machines never carries someone else's endpoint either.
 */

import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import {
  DEFAULT_AI_CONFIG,
  KEY_MASK,
  mergeAiConfig,
  type AiConfig,
  type AiConfigView,
  type AiSettings
} from '@shared/ai/config'
import { dataRoot } from '../../paths'
import { readSecret, storageMode, writeSecret } from '../../secrets'

const KEY_SECRET = 'ai:apiKey'

/**
 * A file beside the AI config, at machine level.
 *
 * Exported so the spend ledger lands in the same place by construction rather than by two copies
 * of this fallback chain — which matters because the fallback is what keeps driver and CI runs
 * (TOTAL_DATA_DIR) out of the real userData directory.
 */
export function machineFile(name: string): string {
  if (process.env.TOTAL_DATA_DIR) return join(dataRoot(), name)
  try {
    return join(app.getPath('userData'), name)
  } catch {
    return join(dataRoot(), name)
  }
}

function configPath(): string {
  return machineFile('ai.json')
}

export function readConfig(): AiConfig {
  const path = configPath()
  if (!existsSync(path)) return { ...DEFAULT_AI_CONFIG }
  try {
    return mergeAiConfig(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return { ...DEFAULT_AI_CONFIG }
  }
}

function writeConfigFile(config: AiConfig): void {
  const path = configPath()
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8')
  renameSync(tmp, path)
}

export function hasKey(): boolean {
  return !!readSecret(KEY_SECRET)
}

/** The key itself. Only ever called inside main, only by the provider. */
export function apiKey(): string | null {
  return readSecret(KEY_SECRET)
}

/**
 * What the renderer is allowed to see. The key is replaced by a mask, and the return type has no
 * field that could hold one — see AiConfigView.
 */
export function readConfigView(featureOn: boolean): AiConfigView {
  const config = readConfig()
  const stored = hasKey()
  return {
    ...config,
    apiKey: stored ? KEY_MASK : '',
    keyStorage: storageMode(),
    ready: stored && featureOn
  }
}

/**
 * Save settings. A key equal to the mask means "keep what's stored" — the settings form round-
 * trips the masked value when the user edits something else without retyping their key. Same
 * sentinel contract as the NIC credentials form.
 */
export function writeConfigFromSettings(settings: AiSettings): AiConfigView {
  const { apiKey: incomingKey, ...config } = settings
  writeConfigFile(mergeAiConfig(config))
  if (incomingKey !== KEY_MASK) {
    writeSecret(KEY_SECRET, incomingKey.trim() || null)
  }
  return readConfigView(true)
}

export function clearKey(): void {
  writeSecret(KEY_SECRET, null)
}
