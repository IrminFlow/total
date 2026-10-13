// WP 8.1: the company mode model (meta `ui`). A missing key means accountant (the open payload
// says so for a company created the 0.10 way); `mode: 'simple'` on create writes it; `ui:set`
// is owner-only, merges, is audited as a company update with the whole before / after (null
// before while the key was missing), and writes nothing when unchanged; the language it stores
// is the one `companyT` reads.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>>()

vi.mock('electron', () => ({
  app: { getVersion: () => '0.11.0-test', getPath: () => tmpdir(), isPackaged: false, on: () => {} },
  ipcMain: { handle: (ch: string, fn: (e: unknown, p: unknown) => Promise<{ ok: boolean }>) => handlers.set(ch.replace(/^total:/, ''), fn) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '', showItemInFolder: () => {} },
  Notification: class {},
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./updater', () => ({ checkForUpdatesInteractive: async () => null }))

const DATA_DIR = mkdtempSync(join(tmpdir(), 'total-ui-mode-'))
process.env.TOTAL_DATA_DIR = DATA_DIR
process.env.TOTAL_SUPPRESS_SYNC_WARNING = '1'

async function call(channel: string, payload?: unknown): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const h = handlers.get(channel)
  if (!h) throw new Error(`no handler ${channel}`)
  return h({}, payload)
}
async function ok<T>(channel: string, payload?: unknown): Promise<T> {
  const r = await call(channel, payload)
  if (!r.ok) throw new Error(`${channel}: ${r.error}`)
  return r.data as T
}

const company = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name, stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null, ...extra
})

const companyDb = (slug: string): Database.Database => new Database(join(DATA_DIR, 'companies', slug, 'company.db'), { readonly: true })
function read<T>(slug: string, fn: (db: Database.Database) => T): T {
  const db = companyDb(slug)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}
const uiAudit = (slug: string): { action: string; before: unknown; after: unknown }[] =>
  read(slug, (db) =>
    (db.prepare("SELECT action, before_json, after_json FROM audit_log WHERE entity = 'company' ORDER BY id").all() as { action: string; before_json: string | null; after_json: string | null }[])
      .map((r) => ({ action: r.action, before: r.before_json ? JSON.parse(r.before_json) : null, after: r.after_json ? JSON.parse(r.after_json) : null }))
      .filter((r) => (r.after as { ui?: unknown } | null)?.ui !== undefined)
  )

let ipc: typeof import('./ipc')
let i18n: typeof import('./i18n')

beforeAll(async () => {
  ipc = await import('./ipc')
  i18n = await import('./i18n')
  ipc.registerIpc()
})

describe('company mode (meta ui)', () => {
  it('a company created without a mode has no ui key and opens in accountant mode', async () => {
    const { slug } = await ok<{ slug: string }>('company:create', company('Plain Co'))
    expect(read(slug, (db) => db.prepare("SELECT value FROM meta WHERE key = 'ui'").get())).toBeUndefined()
    const opened = await ok<{ ui: unknown }>('company:open', { slug })
    expect(opened.ui).toEqual({ mode: 'accountant' })
    expect((await ok<{ ui: unknown }>('company:current')).ui).toEqual({ mode: 'accountant' })
    expect(await ok('ui:get')).toEqual({ mode: 'accountant' })
    expect(uiAudit(slug)).toEqual([])
    // An explicit accountant on create writes nothing either; a bad mode is refused.
    const explicit = await ok<{ slug: string }>('company:create', company('Explicit Co', { mode: 'accountant' }))
    expect(read(explicit.slug, (db) => db.prepare("SELECT value FROM meta WHERE key = 'ui'").get())).toBeUndefined()
    expect((await call('company:create', company('Bad Co', { mode: 'expert' }))).ok).toBe(false)
  })

  it('mode simple on create writes meta ui, audited; the company info never carries the mode', async () => {
    const { slug } = await ok<{ slug: string }>('company:create', company('Simple Start Co', { mode: 'simple' }))
    const opened = await ok<{ ui: unknown; info: Record<string, unknown> }>('company:open', { slug })
    expect(opened.ui).toEqual({ mode: 'simple' })
    expect(opened.info).not.toHaveProperty('mode')
    expect(uiAudit(slug)).toEqual([{ action: 'update', before: { ui: null }, after: { ui: { mode: 'simple' } } }])
  })

  it('ui:set merges and audits the whole before / after; unchanged writes nothing; language reaches companyT', async () => {
    const { slug } = await ok<{ slug: string }>('company:create', company('Switch Co'))
    await ok('company:open', { slug })
    expect(await ok('ui:set', { mode: 'simple' })).toEqual({ mode: 'simple' })
    expect(await ok('ui:set', { language: 'hi' })).toEqual({ mode: 'simple', language: 'hi' })
    expect(await ok('ui:set', { language: 'hi' })).toEqual({ mode: 'simple', language: 'hi' })
    expect(await ok('ui:set', { mode: 'accountant' })).toEqual({ mode: 'accountant', language: 'hi' })
    expect(uiAudit(slug)).toEqual([
      { action: 'update', before: { ui: null }, after: { ui: { mode: 'simple' } } },
      { action: 'update', before: { ui: { mode: 'simple' } }, after: { ui: { mode: 'simple', language: 'hi' } } },
      { action: 'update', before: { ui: { mode: 'simple', language: 'hi' } }, after: { ui: { mode: 'accountant', language: 'hi' } } }
    ])
    expect(read(slug, (db) => i18n.companyLanguage(db))).toBe('hi')
    // Unknown fields and bad values are refused by Zod.
    expect((await call('ui:set', { mode: 'expert' })).ok).toBe(false)
    expect((await call('ui:set', { theme: 'dark' })).ok).toBe(false)
    // The books never moved: the chain is intact.
    expect(await ok<{ ok: boolean }>('audit:verify')).toMatchObject({ ok: true })
  })

  it('ui:set is owner-only once the company has users (an accountant and a viewer are refused)', async () => {
    expect(ipc.CHANNEL_ROLES.get('ui:set')).toBe('owner')
    expect(ipc.CHANNEL_ROLES.get('ui:get')).toBe('viewer')
    const { slug } = await ok<{ slug: string }>('company:create', company('Roles Mode Co'))
    await ok('company:open', { slug })
    const owner = await ok<{ id: number }>('users:save', { data: { name: 'Owner', pin: '1111', role: 'owner', active: true } })
    const acct = await ok<{ id: number }>('users:save', { data: { name: 'Clerk', pin: '2222', role: 'accountant', active: true } })
    const viewer = await ok<{ id: number }>('users:save', { data: { name: 'Looker', pin: '3333', role: 'viewer', active: true } })
    for (const [u, pin] of [[acct.id, '2222'], [viewer.id, '3333']] as const) {
      await ok('auth:login', { userId: u, pin })
      expect(await ok('ui:get')).toEqual({ mode: 'accountant' })
      const denied = await call('ui:set', { mode: 'simple' })
      expect(denied.ok).toBe(false)
      expect(denied.error).toMatch(/permission/)
      await ok('auth:logout')
    }
    expect(uiAudit(slug)).toEqual([])
    await ok('auth:login', { userId: owner.id, pin: '1111' })
    expect(await ok('ui:set', { mode: 'simple' })).toEqual({ mode: 'simple' })
    const rows = read(slug, (db) => db.prepare("SELECT user_name FROM audit_log WHERE entity = 'company' AND after_json LIKE '%\"ui\"%'").all())
    expect(rows).toEqual([{ user_name: 'Owner' }])
  })
})
