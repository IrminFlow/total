// IPC channels for the AI agent (WP 5.1). Registered from src/main/ipc.ts with its `handle`
// (role gate + { ok, data | error } envelope); every payload is Zod-parsed here. Streaming goes
// the other way: the agent's AiEvents are pushed with webContents.send('total:ai:event') by the
// `emit` the caller passes in (this file never imports Electron, so dbtests drive it directly).
//
// The API key is app-wide, so a per-company role is not enough to guard it (a company with no
// users makes everyone its "owner"). keyChangeRule() below:
//   - in a company WITH users: its signed-in owner may set / clear the key (handle enforces owner);
//   - in a company WITHOUT users: refused while any other company on this computer has users
//     ("sign in as an owner there"); when no company has users at all, allowed only with an
//     explicit `confirmNoUsers` ("anyone using this computer can change it") — the UI asks.
// Every key change is audited twice: in the open company's audit_log (as before) and in the
// app-level, append-only <dataRoot>/ai-key-audit.jsonl (appAudit), which no company owns.
import { z } from 'zod'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import {
  aiKeySetSchema, aiMemoryCreateSchema, aiMemoryDerivedSchema, aiMemoryStatusSchema, aiMemoryUpdateSchema, aiRegenerateSchema, aiSendSchema, aiSettingsPatchSchema, aiThreadPinSchema, aiThreadRenameSchema, type AiConnectionResult, type AiEvent, type AiSettings, type AiSettingsView
} from '@shared/ai'
import { roleAllows, type Role } from '../services/roles'
import type { SecretStore } from '../services/secrets'
import { writeAudit } from '../services/audit'
import { AgentRuns, AI_OFF_MESSAGE, settingsBlocker, startTurn } from './agent'
import { acceptNotice, clearApiKey, getAiSettings, keyHint, patchAiSettings, readApiKey, setApiKey } from './settings'
import { createToolRegistry } from './tools'
import { MockProvider, demoScript } from './mockProvider'
import { OpenAiProvider, redactSecrets } from './provider'
import { discardDraft } from './drafts'
import { createMemory, deleteMemory, forgetAllMemory, getMemory, memoryList, resolveDerived, setMemoryStatus, updateMemory } from './memory'
import { todayISO } from '@shared/dates'
import * as store from './store'
import type { AiProvider } from './types'

type Handle = (channel: string, fn: (payload: unknown) => unknown, minRole?: Role) => void
interface Company {
  db: DB
  info: CompanyInfo
  slug: string
  usersExist: boolean
}

export interface AppKeyAuditEntry {
  at: string
  action: 'set' | 'clear'
  keyHint: string | null
  company: string
  user: string | null
  mode: 'owner' | 'no-users-confirmed'
}

export interface AiIpcDeps {
  company: () => Company
  /** The signed-in user's name and role; a company without users acts as its owner. */
  session: () => { name: string | null; role: Role }
  /** The role right now, or null when signed out (re-checked at every tool call). */
  roleNow: () => Role | null
  secrets: () => SecretStore
  emit: (e: AiEvent) => void
  /** TOTAL_AI_MOCK in effect (see env.ts). */
  mock: () => boolean
  /** Whether any company on this computer has users (the key guard). */
  anyCompanyHasUsers: () => boolean
  /** App-level key audit (append-only, outside every company). */
  appAudit: (entry: AppKeyAuditEntry) => void
  /** Today (local ISO date) — injected by tests; derived memory looks back a year from it. */
  today?: () => string
  /** Injected by tests; the default builds the OpenAI provider (or the demo mock). */
  providerFactory?: (opts: { apiKey: string | null; mock: boolean }) => AiProvider
}

/** One registry of in-flight runs for the app, keyed by company + thread (a company close stops them all). */
export const aiRuns = new AgentRuns()

const defaultProviderFactory = ({ apiKey, mock }: { apiKey: string | null; mock: boolean }): AiProvider => {
  if (mock) return new MockProvider(demoScript, { models: ['gpt-6.1-sol', 'gpt-6-luna', 'mock-model'], delayMs: 20, chunk: 6 })
  if (!apiKey) throw new Error('No API key — add one in Settings → AI')
  return new OpenAiProvider({ apiKey })
}

export function settingsView(settings: AiSettings, secrets: SecretStore, mock: boolean): AiSettingsView {
  const key = readApiKey(secrets)
  const keyPresent = !!key
  const blocker = settingsBlocker(settings) ?? (!keyPresent && !mock ? 'Add an API key' : null)
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

export const KEY_OTHER_COMPANY_HAS_USERS =
  'The API key is shared by every company on this computer. Another company here has users — open it and sign in as its owner to change the key.'
export const KEY_CONFIRM_NO_USERS =
  'No company on this computer has users, so anyone using it can change the shared API key. Confirm to continue.'

/** Who may change the app-wide key — see the header comment. Pure; tested. */
export function keyChangeRule(o: { companyHasUsers: boolean; anyCompanyHasUsers: boolean; confirmNoUsers: boolean }): {
  ok: boolean
  mode?: AppKeyAuditEntry['mode']
  error?: string
} {
  if (o.companyHasUsers) return { ok: true, mode: 'owner' }
  if (o.anyCompanyHasUsers) return { ok: false, error: KEY_OTHER_COMPANY_HAS_USERS }
  if (!o.confirmNoUsers) return { ok: false, error: KEY_CONFIRM_NO_USERS }
  return { ok: true, mode: 'no-users-confirmed' }
}

/** Who may change a thread: the user who started it, or an accountant / owner. Pure; tested. */
export function threadAccessAllowed(session: { name: string | null; role: Role }, owner: string | null): boolean {
  if (roleAllows(session.role, 'accountant')) return true
  return session.name !== null && owner !== null && session.name === owner
}

export function registerAiIpc(handle: Handle, deps: AiIpcDeps): void {
  const registry = createToolRegistry()
  const db = (): DB => deps.company().db
  const scope = (): string => deps.company().slug
  const factory = deps.providerFactory ?? defaultProviderFactory
  const today = deps.today ?? todayISO
  const view = (): AiSettingsView => settingsView(getAiSettings(db()), deps.secrets(), deps.mock())
  const provider = (): AiProvider => factory({ apiKey: readApiKey(deps.secrets()), mock: deps.mock() })
  const idSchema = z.object({ id: z.number().int().positive() })
  const guardKey = (confirmNoUsers: boolean): AppKeyAuditEntry['mode'] => {
    const c = deps.company()
    const rule = keyChangeRule({ companyHasUsers: c.usersExist, anyCompanyHasUsers: !c.usersExist && deps.anyCompanyHasUsers(), confirmNoUsers })
    if (!rule.ok) throw new Error(rule.error)
    return rule.mode!
  }

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
    const { key, confirmNoUsers } = aiKeySetSchema.extend({ confirmNoUsers: z.boolean().default(false) }).parse(p)
    const mode = guardKey(confirmNoUsers)
    setApiKey(db(), deps.secrets(), key)
    deps.appAudit({ at: new Date().toISOString(), action: 'set', keyHint: keyHint(key), company: scope(), user: deps.session().name, mode })
    return view()
  }, 'owner')
  handle('ai:key:clear', (p) => {
    const { confirmNoUsers } = z.object({ confirmNoUsers: z.boolean().default(false) }).default({}).parse(p ?? {})
    const mode = guardKey(confirmNoUsers)
    clearApiKey(db(), deps.secrets())
    deps.appAudit({ at: new Date().toISOString(), action: 'clear', keyHint: null, company: scope(), user: deps.session().name, mode })
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
  handle('ai:threads', () => store.listThreads(db(), aiRuns.running(scope())), 'viewer')
  handle('ai:thread', (p) => {
    const { id } = idSchema.parse(p)
    const thread = store.getThread(db(), id)
    if (!thread) throw new Error('Conversation not found')
    return { thread, messages: store.listMessages(db(), id).map(store.toDto), running: aiRuns.running(scope()).has(id) }
  }, 'viewer')
  handle('ai:thread:delete', (p) => {
    const { id } = idSchema.parse(p)
    const thread = store.getThread(db(), id)
    if (!thread) throw new Error('Conversation not found')
    aiRuns.cancel(id, scope())
    const messages = store.listMessages(db(), id).length
    db().transaction(() => {
      store.deleteThread(db(), id)
      writeAudit(db(), 'ai_thread', id, 'delete', { title: thread.title, messages }, null)
    })()
    return null
  }, 'accountant')
  const ask = (input: Parameters<typeof startTurn>[1]): { threadId: number; runId: string; userMessage: ReturnType<typeof startTurn>['userMessage'] } => {
    const c = deps.company()
    const v = view()
    if (!v.ready) throw new Error(v.blocker ?? AI_OFF_MESSAGE)
    const turn = startTurn(
      {
        db: c.db, company: c.info, provider: provider(), registry, settings: v.settings, user: deps.session(), roleNow: deps.roleNow,
        emit: deps.emit, runs: aiRuns, scope: c.slug
      },
      input
    )
    return { threadId: turn.threadId, runId: turn.runId, userMessage: turn.userMessage }
  }
  handle('ai:send', (p) => ask(aiSendSchema.parse(p)), 'viewer')
  // Threads are shared in a company: changing one (regenerate / rename / pin) takes the user who
  // started it, or an accountant or owner.
  const assertThreadAccess = (id: number): void => {
    if (!store.threadExists(db(), id)) throw new Error('Conversation not found')
    const s = deps.session()
    if (threadAccessAllowed(s, store.threadOwner(db(), id))) return
    throw new Error('Only the user who started this conversation, or an accountant or owner, can change it')
  }
  // WP 5.2: answer the thread's last question again (the previous answer's messages are removed;
  // its usage rows and any draft it made stay).
  handle('ai:regenerate', (p) => {
    const { threadId, context, speed } = aiRegenerateSchema.parse(p)
    assertThreadAccess(threadId)
    // The stored question's own context wins (agent.ts); `context` only covers older messages.
    return ask({ threadId, text: '', regenerate: true, context, speed })
  }, 'viewer')
  handle('ai:thread:rename', (p) => {
    const { id, title } = aiThreadRenameSchema.parse(p)
    assertThreadAccess(id)
    const thread = store.getThread(db(), id)
    if (!thread) throw new Error('Conversation not found')
    db().transaction(() => {
      store.renameThread(db(), id, title)
      writeAudit(db(), 'ai_thread', id, 'update', { title: thread.title }, { title: store.getThread(db(), id)!.title })
    })()
    return store.listThreads(db(), aiRuns.running(scope())).find((t) => t.id === id) ?? null
  }, 'viewer')
  handle('ai:thread:pin', (p) => {
    const { id, pinned } = aiThreadPinSchema.parse(p)
    assertThreadAccess(id)
    store.setThreadPinned(db(), id, pinned)
    return store.listThreads(db(), aiRuns.running(scope())).find((t) => t.id === id) ?? null
  }, 'viewer')
  handle('ai:cancel', (p) => {
    const { threadId } = z.object({ threadId: z.number().int().positive() }).parse(p)
    return { cancelled: aiRuns.cancel(threadId, scope()) }
  }, 'viewer')

  // ---------- drafts ----------
  handle('ai:draft:get', (p) => {
    const d = store.getDraft(db(), idSchema.parse(p).id)
    if (!d) throw new Error('AI draft not found')
    return d
  }, 'viewer')
  handle('ai:drafts', (p) => {
    const { status, threadId } = z
      .object({ status: z.enum(['open', 'consumed', 'discarded']).optional(), threadId: z.number().int().positive().optional() })
      .default({})
      .parse(p ?? {})
    return store.listDrafts(db(), status, threadId)
  }, 'viewer')
  handle('ai:draft:discard', (p) => discardDraft(db(), idSchema.parse(p).id), 'accountant')

  // ---------- memory (WP 5.6) ----------
  // Viewing is open to every role (it is what the assistant is told); changing it takes an
  // accountant (the role that may draft), forgetting everything an owner. Every write is audited
  // (entity 'ai_memory'); the assistant itself can only propose, through the `remember` tool.
  handle('ai:memory:list', () => memoryList(db(), today()), 'viewer')
  handle('ai:memory:create', (p) => createMemory(db(), aiMemoryCreateSchema.parse(p), { source: 'user', status: 'active', createdBy: deps.session().name }), 'accountant')
  handle('ai:memory:update', (p) => updateMemory(db(), aiMemoryUpdateSchema.parse(p)), 'accountant')
  handle('ai:memory:setStatus', (p) => {
    const { id, status } = aiMemoryStatusSchema.parse(p)
    return setMemoryStatus(db(), id, status)
  }, 'accountant')
  handle('ai:memory:delete', (p) => {
    const { id } = idSchema.parse(p)
    if (!getMemory(db(), id)) throw new Error('Memory not found')
    deleteMemory(db(), id)
    return null
  }, 'accountant')
  handle('ai:memory:resolveDerived', (p) => {
    const { key, accept } = aiMemoryDerivedSchema.parse(p)
    return resolveDerived(db(), key, accept, today(), deps.session().name)
  }, 'accountant')
  handle('ai:memory:forgetAll', () => forgetAllMemory(db()), 'owner')

  // ---------- meters and logs ----------
  handle('ai:usage', () => store.listUsage(db()), 'viewer')
  handle('ai:outbound', () => store.listOutbound(db()), 'viewer')
  // Deletes conversations, drafts, memory and aliases. It cannot (and must not) remove the audit
  // trail's rows about AI settings and drafts: audit_log is append-only (MCA rule 3(1)).
  handle('ai:data:deleteAll', (p) => {
    const { includeLogs } = z.object({ includeLogs: z.boolean().default(false) }).default({}).parse(p ?? {})
    for (const t of aiRuns.running(scope())) aiRuns.cancel(t, scope())
    const d = db()
    return d.transaction(() => {
      const before = store.deleteAllAiData(d, includeLogs)
      writeAudit(d, 'ai_data', 0, 'delete', { ...before, includeLogs }, null)
      return before
    })()
  }, 'owner')
}
