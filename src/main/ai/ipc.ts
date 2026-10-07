// IPC channels for the AI agent (WP 5.1). Registered from src/main/ipc.ts with its `handle`
// (role gate + { ok, data | error } envelope); every payload is Zod-parsed here. Streaming goes
// the other way: the agent's AiEvents are pushed with webContents.send('total:ai:event') by the
// `emit` the caller passes in (this file never imports Electron, so dbtests drive it directly).
import { z } from 'zod'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import {
  aiKeySetSchema, aiSendSchema, aiSettingsPatchSchema, type AiConnectionResult, type AiEvent, type AiSettings, type AiSettingsView
} from '@shared/ai'
import type { Role } from '../services/roles'
import type { SecretStore } from '../services/secrets'
import { writeAudit } from '../services/audit'
import { AgentRuns, AI_OFF_MESSAGE, startTurn } from './agent'
import { acceptNotice, clearApiKey, getAiSettings, keyHint, patchAiSettings, readApiKey, setApiKey } from './settings'
import { createToolRegistry } from './tools'
import { MockProvider, demoScript } from './mockProvider'
import { OpenAiProvider, redactSecrets } from './provider'
import { discardDraft } from './drafts'
import * as store from './store'
import type { AiProvider } from './types'

type Handle = (channel: string, fn: (payload: unknown) => unknown, minRole?: Role) => void
interface Company {
  db: DB
  info: CompanyInfo
  slug: string
}

export interface AiIpcDeps {
  company: () => Company
  /** The signed-in user; a company without users acts as its owner. */
  session: () => { name: string | null; role: Role }
  secrets: () => SecretStore
  emit: (e: AiEvent) => void
  /** TOTAL_AI_MOCK in effect (see env.ts). */
  mock: () => boolean
  /** Injected by tests; the default builds the OpenAI provider (or the demo mock). */
  providerFactory?: (opts: { apiKey: string | null; mock: boolean }) => AiProvider
}

/** One registry of in-flight runs for the app (a company close stops them all). */
export const aiRuns = new AgentRuns()

const defaultProviderFactory = ({ apiKey, mock }: { apiKey: string | null; mock: boolean }): AiProvider => {
  if (mock) return new MockProvider(demoScript, { models: ['gpt-6.1-sol', 'gpt-6-luna', 'mock-model'], delayMs: 20, chunk: 6 })
  if (!apiKey) throw new Error('No API key — add one in Settings → AI')
  return new OpenAiProvider({ apiKey })
}

export function settingsView(settings: AiSettings, secrets: SecretStore, mock: boolean): AiSettingsView {
  const key = readApiKey(secrets)
  const keyPresent = !!key
  const blocker = !settings.noticeAcceptedAt
    ? 'Read and accept the data notice first'
    : !settings.enabled
      ? AI_OFF_MESSAGE
      : !keyPresent && !mock
        ? 'Add an API key'
        : null
  return {
    settings,
    keyPresent,
    keyHint: keyHint(key),
    secureStorageAvailable: secrets.available(),
    mock,
    ready: blocker === null,
    blocker
  }
}

export function registerAiIpc(handle: Handle, deps: AiIpcDeps): void {
  const registry = createToolRegistry()
  const db = (): DB => deps.company().db
  const factory = deps.providerFactory ?? defaultProviderFactory
  const view = (): AiSettingsView => settingsView(getAiSettings(db()), deps.secrets(), deps.mock())
  const provider = (): AiProvider => factory({ apiKey: readApiKey(deps.secrets()), mock: deps.mock() })
  const idSchema = z.object({ id: z.number().int().positive() })

  // ---------- settings ----------
  handle('ai:settings:get', () => view(), 'viewer')
  handle('ai:settings:set', (p) => {
    patchAiSettings(db(), aiSettingsPatchSchema.parse(p))
    return view()
  }, 'owner')
  handle('ai:notice:accept', () => {
    acceptNotice(db(), deps.session().name)
    return view()
  }, 'owner')
  handle('ai:key:set', (p) => {
    const { key } = aiKeySetSchema.parse(p)
    setApiKey(db(), deps.secrets(), key)
    return view()
  }, 'owner')
  handle('ai:key:clear', () => {
    clearApiKey(db(), deps.secrets())
    return view()
  }, 'owner')
  handle('ai:testConnection', async (): Promise<AiConnectionResult> => {
    const s = getAiSettings(db())
    try {
      const models = await provider().models()
      return { ok: true, models, defaultModelFound: models.includes(s.defaultModel), fastModelFound: models.includes(s.fastModel), error: null }
    } catch (err) {
      const error = redactSecrets(err instanceof Error ? err.message : String(err), readApiKey(deps.secrets()))
      return { ok: false, models: [], defaultModelFound: false, fastModelFound: false, error }
    }
  }, 'owner')
  handle('ai:tools', () => registry.info(), 'viewer')

  // ---------- conversations ----------
  handle('ai:threads', () => store.listThreads(db(), aiRuns.running()), 'viewer')
  handle('ai:thread', (p) => {
    const { id } = idSchema.parse(p)
    const thread = store.getThread(db(), id)
    if (!thread) throw new Error('Conversation not found')
    return { thread, messages: store.listMessages(db(), id), running: aiRuns.running().has(id) }
  }, 'viewer')
  handle('ai:thread:delete', (p) => {
    const { id } = idSchema.parse(p)
    const thread = store.getThread(db(), id)
    if (!thread) throw new Error('Conversation not found')
    aiRuns.cancel(id)
    const messages = store.listMessages(db(), id).length
    db().transaction(() => {
      store.deleteThread(db(), id)
      writeAudit(db(), 'ai_thread', id, 'delete', { title: thread.title, messages }, null)
    })()
    return null
  }, 'accountant')
  handle('ai:send', (p) => {
    const input = aiSendSchema.parse(p)
    const c = deps.company()
    const v = view()
    if (!v.ready) throw new Error(v.blocker ?? AI_OFF_MESSAGE)
    const turn = startTurn(
      { db: c.db, company: c.info, provider: provider(), registry, settings: v.settings, user: deps.session(), emit: deps.emit, runs: aiRuns },
      input
    )
    return { threadId: turn.threadId, runId: turn.runId, userMessage: turn.userMessage }
  }, 'viewer')
  handle('ai:cancel', (p) => {
    const { threadId } = z.object({ threadId: z.number().int().positive() }).parse(p)
    return { cancelled: aiRuns.cancel(threadId) }
  }, 'viewer')

  // ---------- drafts ----------
  handle('ai:draft:get', (p) => {
    const d = store.getDraft(db(), idSchema.parse(p).id)
    if (!d) throw new Error('AI draft not found')
    return d
  }, 'viewer')
  handle('ai:drafts', (p) => {
    const { status } = z.object({ status: z.enum(['open', 'consumed', 'discarded']).optional() }).default({}).parse(p ?? {})
    return store.listDrafts(db(), status)
  }, 'viewer')
  handle('ai:draft:discard', (p) => discardDraft(db(), idSchema.parse(p).id), 'accountant')

  // ---------- meters and logs ----------
  handle('ai:usage', () => store.listUsage(db()), 'viewer')
  handle('ai:outbound', () => store.listOutbound(db()), 'viewer')
  handle('ai:data:deleteAll', (p) => {
    const { includeLogs } = z.object({ includeLogs: z.boolean().default(false) }).default({}).parse(p ?? {})
    aiRuns.cancelAll()
    const d = db()
    return d.transaction(() => {
      const before = store.deleteAllAiData(d, includeLogs)
      writeAudit(d, 'ai_data', 0, 'delete', { ...before, includeLogs }, null)
      return before
    })()
  }, 'owner')
}
