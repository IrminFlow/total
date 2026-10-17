// Guided re-close (PR #168 review) through the IPC handlers: the preview is accountant+ and a
// profit channel (an accountant with canSeeProfit: false is refused), the repair is owner-only,
// both payloads are Zod-strict (no voucher id / ledger id / "force" can be smuggled in), and a
// no-op repair writes no audit row.
import { TRUSTED_EVENT } from './ipcSender.testutil'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3-multiple-ciphers'

type Result = { ok: boolean; data?: unknown; error?: string; code?: string }
const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<Result>>()

vi.mock('electron', () => ({
  app: { getVersion: () => '0.12.0-test', getPath: () => tmpdir(), isPackaged: false, on: () => {} },
  ipcMain: { handle: (ch: string, fn: (e: unknown, p: unknown) => Promise<Result>) => handlers.set(ch.replace(/^total:/, ''), fn) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '', showItemInFolder: () => {} },
  Notification: class {},
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./updater', () => ({ checkForUpdatesInteractive: async () => null }))

const DATA_DIR = mkdtempSync(join(tmpdir(), 'total-reclose-ipc-'))
process.env.TOTAL_DATA_DIR = DATA_DIR
process.env.TOTAL_SUPPRESS_SYNC_WARNING = '1'

async function call(channel: string, payload?: unknown): Promise<Result> {
  const h = handlers.get(channel)
  if (!h) throw new Error(`no handler ${channel}`)
  return h(TRUSTED_EVENT, payload)
}
async function ok<T>(channel: string, payload?: unknown): Promise<T> {
  const r = await call(channel, payload)
  if (!r.ok) throw new Error(`${channel}: ${r.error} (${r.code ?? ''})`)
  return r.data as T
}

// WP 7.3: imported at collection, never inside the hook.
const ipcModule = await import('./ipc')
beforeAll(() => {
  ipcModule.registerIpc()
})

describe('yearEnd:repairPreview / yearEnd:repair over IPC', () => {
  it('roles, the profit flag, strict payloads', async () => {
    const { slug } = await ok<{ slug: string }>('company:create', {
      name: 'Reclose Co', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '', booksFrom: 2024, email: null, phone: null, pan: null, tan: null
    })
    await ok('company:open', { slug })
    const PIN = { owner: '1111', acct: '2222', viewer: '3333', blind: '4444' }
    const owner = await ok<{ id: number }>('users:save', { data: { name: 'Owner', role: 'owner', pin: PIN.owner } })
    const acct = await ok<{ id: number }>('users:save', { data: { name: 'Asha', role: 'accountant', pin: PIN.acct } })
    const viewer = await ok<{ id: number }>('users:save', { data: { name: 'Vik', role: 'viewer', pin: PIN.viewer } })
    const blind = await ok<{ id: number }>('users:save', { data: { name: 'Bina', role: 'accountant', pin: PIN.blind, capabilities: { canSeeProfit: false } } })
    const login = (id: number, pin: string): Promise<unknown> => ok('auth:login', { userId: id, pin })

    await login(owner.id, PIN.owner)
    const p = await ok<{ years: unknown[]; fingerprint: string }>('yearEnd:repairPreview', {})
    expect(p.years).toEqual([])
    expect((await call('yearEnd:repairPreview', { fyStartYear: 2024 })).code).toBe('invalid_input')
    expect((await call('yearEnd:repair', { fingerprint: p.fingerprint, voucherId: 1 })).code).toBe('invalid_input')
    expect((await call('yearEnd:repair', { fingerprint: 'abc' })).code).toBe('invalid_input')
    const ro = new Database(join(DATA_DIR, 'companies', slug, 'company.db'), { readonly: true })
    const audit = (): number => (ro.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n
    const before = audit()
    expect(await ok<{ repaired: unknown[] }>('yearEnd:repair', { fingerprint: p.fingerprint })).toMatchObject({ repaired: [] })
    expect(audit()).toBe(before)
    ro.close()

    await login(acct.id, PIN.acct)
    expect((await call('yearEnd:repairPreview', {})).ok).toBe(true)
    expect((await call('yearEnd:repair', { fingerprint: p.fingerprint })).code).toBe('not_permitted')

    await login(viewer.id, PIN.viewer)
    expect((await call('yearEnd:repairPreview', {})).code).toBe('not_permitted')
    expect((await call('yearEnd:repair', { fingerprint: p.fingerprint })).code).toBe('not_permitted')

    await login(blind.id, PIN.blind)
    expect((await call('yearEnd:repairPreview', {})).code).toBe('not_permitted')
    expect((await call('yearEnd:repair', { fingerprint: p.fingerprint })).code).toBe('not_permitted')
  })
})
