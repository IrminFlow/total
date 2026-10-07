// WP 1.10c — the print-template IPC channels end to end through registerIpc(): Zod parsing of
// payloads, { ok, data | error } envelopes, role gating (viewer reads, accountant+ edits), and the
// old config:invoice:* channels mapping onto the Classic template. Electron is mocked — only
// ipcMain.handle registrations and the bits of app/shell the touched handlers use.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>>()

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test', getPath: () => tmpdir(), isPackaged: false, on: () => {} },
  ipcMain: { handle: (ch: string, fn: (e: unknown, p: unknown) => Promise<{ ok: boolean }>) => handlers.set(ch.replace(/^total:/, ''), fn) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '', showItemInFolder: () => {} },
  Notification: class {},
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./updater', () => ({ checkForUpdatesInteractive: async () => null }))

process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-print-ipc-'))
process.env.TOTAL_SUPPRESS_SYNC_WARNING = '1'

async function call<T = unknown>(channel: string, payload?: unknown): Promise<{ ok: boolean; data?: T; error?: string }> {
  const h = handlers.get(channel)
  if (!h) throw new Error(`no handler ${channel}`)
  return (await h({}, payload)) as { ok: boolean; data?: T; error?: string }
}
async function ok<T = unknown>(channel: string, payload?: unknown): Promise<T> {
  const r = await call<T>(channel, payload)
  if (!r.ok) throw new Error(`${channel}: ${r.error}`)
  return r.data as T
}

beforeAll(async () => {
  const { registerIpc } = await import('./ipc')
  registerIpc()
  const { slug } = await ok<{ slug: string }>('company:create', {
    name: 'IPC Print Co', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: 'Pune',
    booksFrom: 2026, email: null, phone: null, pan: null, tan: null
  })
  await ok('company:open', { slug })
})

describe('print template IPC', () => {
  it('lists, previews, saves and defaults (open company, no users yet = ungated)', async () => {
    const list = await ok<{ templates: { id: string }[]; defaults: Record<string, string> }>('template:list')
    expect(list.templates.map((t) => t.id)).toEqual(['classic', 'compact', 'modern'])
    const modern = await ok<Record<string, unknown>>('template:get', { id: 'modern' })
    const { html } = await ok<{ html: string }>('template:previewHtml', { template: modern })
    expect(html).toContain('INV-SAMPLE-1')
    const copy = await ok<{ id: string; name: string }>('template:duplicate', { id: 'modern' })
    await ok('template:save', { template: { ...(await ok<Record<string, unknown>>('template:get', { id: copy.id })), name: 'Shop' } })
    const after = await ok<{ defaults: Record<string, string> }>('template:setDefault', { kind: 'sales', id: copy.id })
    expect(after.defaults.sales).toBe(copy.id)
    const imported = await ok<{ id: string; builtIn: boolean }>('template:import', {
      jsonText: JSON.stringify({ format: 'total-print-template', version: 1, template: modern })
    })
    expect(imported.builtIn).toBe(false)
  })

  it('rejects malformed payloads with a readable Zod error', async () => {
    const bad = await call('template:save', { template: { id: 'x', name: 'X', typography: { accent: 'blue' } } })
    expect(bad.ok).toBe(false)
    expect(bad.error).toMatch(/typography\.accent/)
    expect((await call('template:setDefault', { kind: 'nope', id: 'classic' })).ok).toBe(false)
    expect((await call('template:delete', { id: 'classic' })).error).toMatch(/Built-in/)
  })

  it('old config:invoice:* channels read and write the Classic template', async () => {
    const cfg = await ok<Record<string, unknown>>('config:invoice:get')
    expect(cfg.title).toBe('TAX INVOICE')
    await ok('config:invoice:set', { ...cfg, title: 'INVOICE' })
    const classic = await ok<{ header: { titles: { sales: string } } }>('template:get', { id: 'classic' })
    expect(classic.header.titles.sales).toBe('INVOICE')
  })

  it('viewer may read and preview; only accountant+ may edit', async () => {
    const owner = await ok<{ id: number }>('users:save', { data: { name: 'Olive', role: 'owner', pin: '1111' } })
    const viewer = await ok<{ id: number }>('users:save', { data: { name: 'Vik', role: 'viewer', pin: '2222' } })
    const acct = await ok<{ id: number }>('users:save', { data: { name: 'Asha', role: 'accountant', pin: '3333' } })
    expect(owner.id).toBeGreaterThan(0)

    await ok('auth:logout')
    await ok('auth:login', { userId: viewer.id, pin: '2222' })
    const classic = await ok<Record<string, unknown>>('template:get', { id: 'classic' })
    expect((await call('template:list')).ok).toBe(true)
    expect((await call('template:previewHtml', { template: classic })).ok).toBe(true)
    for (const [ch, p] of [
      ['template:save', { template: classic }],
      ['template:duplicate', { id: 'classic' }],
      ['template:reset', { id: 'classic' }],
      ['template:setDefault', { kind: 'sales', id: 'classic' }],
      ['template:import', { jsonText: '{}' }]
    ] as const) {
      const r = await call(ch, p)
      expect(r.ok, ch).toBe(false)
      expect(r.error, ch).toMatch(/permission/)
    }

    await ok('auth:logout')
    await ok('auth:login', { userId: acct.id, pin: '3333' })
    expect((await call('template:save', { template: classic })).ok).toBe(true)
    expect((await call('template:reset', { id: 'classic' })).ok).toBe(true)
  })
})
