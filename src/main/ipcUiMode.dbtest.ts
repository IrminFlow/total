// WP 8.1: the company mode model (meta `ui`). A missing key means accountant (the open payload
// says so for a company created the 0.10 way); `mode: 'simple'` on create writes it; `ui:mode:set`
// is owner-only, merges, is audited as a company update with the whole before / after (null
// before while the key was missing), and writes nothing when unchanged; the language it stores
// is the one `companyT` reads.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
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

  it('ui:mode:set merges and audits the whole before / after; unchanged writes nothing; language reaches companyT', async () => {
    const { slug } = await ok<{ slug: string }>('company:create', company('Switch Co'))
    await ok('company:open', { slug })
    expect(await ok('ui:mode:set', { mode: 'simple' })).toEqual({ mode: 'simple' })
    expect(await ok('ui:mode:set', { language: 'hi' })).toEqual({ mode: 'simple', language: 'hi' })
    expect(await ok('ui:mode:set', { language: 'hi' })).toEqual({ mode: 'simple', language: 'hi' })
    expect(await ok('ui:mode:set', { mode: 'accountant' })).toEqual({ mode: 'accountant', language: 'hi' })
    expect(uiAudit(slug)).toEqual([
      { action: 'update', before: { ui: null }, after: { ui: { mode: 'simple' } } },
      { action: 'update', before: { ui: { mode: 'simple' } }, after: { ui: { mode: 'simple', language: 'hi' } } },
      { action: 'update', before: { ui: { mode: 'simple', language: 'hi' } }, after: { ui: { mode: 'accountant', language: 'hi' } } }
    ])
    expect(read(slug, (db) => i18n.companyLanguage(db))).toBe('hi')
    // Unknown fields and bad values are refused by Zod.
    expect((await call('ui:mode:set', { mode: 'expert' })).ok).toBe(false)
    expect((await call('ui:mode:set', { theme: 'dark' })).ok).toBe(false)
    // The books never moved: the chain is intact.
    expect(await ok<{ ok: boolean }>('audit:verify')).toMatchObject({ ok: true })
  })

  it('ui:mode:set is owner-only once the company has users (an accountant and a viewer are refused)', async () => {
    expect(ipc.CHANNEL_ROLES.get('ui:mode:set')).toBe('owner')
    expect(ipc.CHANNEL_ROLES.has('ui:set')).toBe(false)
    expect(ipc.CHANNEL_ROLES.get('ui:get')).toBe('viewer')
    const { slug } = await ok<{ slug: string }>('company:create', company('Roles Mode Co'))
    await ok('company:open', { slug })
    const owner = await ok<{ id: number }>('users:save', { data: { name: 'Owner', pin: '1111', role: 'owner', active: true } })
    const acct = await ok<{ id: number }>('users:save', { data: { name: 'Clerk', pin: '2222', role: 'accountant', active: true } })
    const viewer = await ok<{ id: number }>('users:save', { data: { name: 'Looker', pin: '3333', role: 'viewer', active: true } })
    for (const [u, pin] of [[acct.id, '2222'], [viewer.id, '3333']] as const) {
      await ok('auth:login', { userId: u, pin })
      expect(await ok('ui:get')).toEqual({ mode: 'accountant' })
      const denied = await call('ui:mode:set', { mode: 'simple' })
      expect(denied.ok).toBe(false)
      expect(denied.error).toMatch(/permission/)
      await ok('auth:logout')
    }
    expect(uiAudit(slug)).toEqual([])
    await ok('auth:login', { userId: owner.id, pin: '1111' })
    expect(await ok('ui:mode:set', { mode: 'simple' })).toEqual({ mode: 'simple' })
    const rows = read(slug, (db) => db.prepare("SELECT user_name FROM audit_log WHERE entity = 'company' AND after_json LIKE '%\"ui\"%'").all())
    expect(rows).toEqual([{ user_name: 'Owner' }])
  })

  it('a pre-8.1 company: ui:mode:set accountant writes nothing (it already is accountant)', async () => {
    const { slug } = await ok<{ slug: string }>('company:create', company('Old Style Co'))
    await ok('company:open', { slug })
    expect(await ok('ui:mode:set', { mode: 'accountant' })).toEqual({ mode: 'accountant' })
    expect(read(slug, (db) => db.prepare("SELECT value FROM meta WHERE key = 'ui'").get())).toBeUndefined()
    expect(uiAudit(slug)).toEqual([])
    // A real change still writes (before: null — the key was missing).
    await ok('ui:mode:set', { language: 'hinglish' })
    expect(uiAudit(slug)).toEqual([{ action: 'update', before: { ui: null }, after: { ui: { mode: 'accountant', language: 'hinglish' } } }])
  })

  it('malformed ui JSON (or an unknown mode) opens as accountant; a change replaces it', async () => {
    const { slug } = await ok<{ slug: string }>('company:create', company('Broken Meta Co'))
    for (const value of ['{not json', JSON.stringify({ mode: 'expert' }), JSON.stringify('simple')]) {
      await ok('company:close')
      const db = new Database(join(DATA_DIR, 'companies', slug, 'company.db'))
      db.prepare("INSERT INTO meta (key, value) VALUES ('ui', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(value)
      db.close()
      expect((await ok<{ ui: unknown }>('company:open', { slug })).ui).toEqual({ mode: 'accountant' })
    }
    expect(await ok('ui:mode:set', { mode: 'simple' })).toEqual({ mode: 'simple' })
    expect((await ok<{ ui: unknown }>('company:current')).ui).toEqual({ mode: 'simple' })
  })

  it('restoring a pre-8.1 backup brings accountant back; restoring a simple backup brings simple', async () => {
    const { slug } = await ok<{ slug: string }>('company:create', company('Restore Mode Co'))
    await ok('company:open', { slug })
    const plain = basename((await ok<{ path: string }>('backup:run')).path)
    await ok('ui:mode:set', { mode: 'simple' })
    await new Promise((r) => setTimeout(r, 1100)) // backup names carry the second
    const simple = basename((await ok<{ path: string }>('backup:run')).path)
    expect(simple).not.toBe(plain)
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 1100)) // the pre-restore snapshot is named by the second too
    await tick()
    await ok('backup:restore', { file: plain })
    expect((await ok<{ ui: unknown }>('company:current')).ui).toEqual({ mode: 'accountant' })
    expect(read(slug, (db) => db.prepare("SELECT value FROM meta WHERE key = 'ui'").get())).toBeUndefined()
    await tick()
    await ok('backup:restore', { file: simple })
    expect((await ok<{ ui: unknown }>('company:current')).ui).toEqual({ mode: 'simple' })
  })
})

describe('WP 8.3: setup wizard, sample company, GST filing frequency', () => {
  const setup = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: 'Wizard Kirana', stateCode: '27', businessType: 'retail', gst: 'no', gstin: null, filing: null,
    stock: true, startDate: '2026-04-01', fresh: true, ...over
  })

  it('simple:setup creates the company in simple mode with its preset; a bad answer creates nothing', async () => {
    const { slug } = await ok<{ slug: string }>('simple:setup', setup())
    const opened = await ok<{ ui: unknown; info: Record<string, unknown> }>('company:open', { slug })
    expect(opened.ui).toEqual({ mode: 'simple', setup: { businessType: 'retail', gst: 'no', stock: true }, startedFresh: true })
    expect(opened.info).toMatchObject({ gstRegistrationType: 'unregistered', gstin: null })
    expect(await ok('config:features:get')).toMatchObject({ tds: false, payroll: false, inventory: true, manufacturing: false })
    expect(await ok('gstProfile:get')).toEqual({ filing: 'monthly' })
    expect(await ok<{ ok: boolean }>('audit:verify')).toMatchObject({ ok: true })
    const before = (await ok<{ companies: unknown[] }>('company:list')).companies.length
    expect((await call('simple:setup', setup({ name: 'No GSTIN Co', gst: 'regular', filing: 'monthly' }))).ok).toBe(false)
    expect((await call('simple:setup', setup({ name: 'Future Co', startDate: '2999-01-01' }))).ok).toBe(false)
    expect((await ok<{ companies: unknown[] }>('company:list')).companies.length).toBe(before)
  })

  it('gstProfile:set is owner-only, audited, and unchanged writes nothing', async () => {
    expect(ipc.CHANNEL_ROLES.get('gstProfile:set')).toBe('owner')
    const { slug } = await ok<{ slug: string }>('simple:setup', setup({ name: 'Wizard Services', businessType: 'services', gst: 'regular', gstin: '27AAPFU0939F1ZV', filing: 'monthly', stock: false }))
    await ok('company:open', { slug })
    expect(await ok('gstProfile:get')).toEqual({ filing: 'monthly' })
    expect(await ok('gstProfile:set', { filing: 'quarterly' })).toEqual({ filing: 'quarterly' })
    expect(await ok('gstProfile:set', { filing: 'quarterly' })).toEqual({ filing: 'quarterly' })
    expect((await call('gstProfile:set', { filing: 'yearly' })).ok).toBe(false)
    const rows = read(slug, (db) =>
      (db.prepare("SELECT before_json, after_json FROM audit_log WHERE entity = 'company' AND after_json LIKE '%gstProfile%' ORDER BY id").all() as { before_json: string; after_json: string }[])
        .map((r) => [JSON.parse(r.before_json), JSON.parse(r.after_json)])
    )
    expect(rows).toEqual([
      [{ gstProfile: null }, { gstProfile: { filing: 'monthly' } }],
      [{ gstProfile: { filing: 'monthly' } }, { gstProfile: { filing: 'quarterly' } }]
    ])
    expect(read(slug, (db) => db.prepare('SELECT COUNT(*) AS n FROM ledgers WHERE tax_type IS NOT NULL').get())).toEqual({ n: 6 })
  })

  it('the sample company opens in simple mode from the wizard, in accountant mode otherwise', async () => {
    const simple = await ok<{ slug: string }>('company:createDemo', { mode: 'simple' })
    expect((await ok<{ ui: { mode: string } }>('company:open', { slug: simple.slug })).ui.mode).toBe('simple')
    const plain = await ok<{ slug: string }>('company:createDemo')
    expect(read(plain.slug, (db) => db.prepare("SELECT value FROM meta WHERE key = 'ui'").get())).toBeUndefined()
    expect((await call('company:createDemo', { mode: 'expert' })).ok).toBe(false)
  })
})
