// WP 4.2 review: receivables:setHold is owner-only (an accountant is refused, an owner allowed),
// and "show in Finder" only reveals files that resolve inside the company's exports folder.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>>()
const revealed: string[] = []

vi.mock('electron', () => ({
  app: { getVersion: () => '0.8.0-test', getPath: () => tmpdir(), isPackaged: false, on: () => {} },
  ipcMain: { handle: (ch: string, fn: (e: unknown, p: unknown) => Promise<{ ok: boolean }>) => handlers.set(ch.replace(/^total:/, ''), fn) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '', showItemInFolder: (p: string) => revealed.push(p) },
  Notification: class {},
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./updater', () => ({ checkForUpdatesInteractive: async () => null }))

const DATA_DIR = mkdtempSync(join(tmpdir(), 'total-rx-ipc-'))
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

let ipc: typeof import('./ipc')
let rxIpc: typeof import('./ipcReceivables')

beforeAll(async () => {
  ipc = await import('./ipc')
  rxIpc = await import('./ipcReceivables')
  ipc.registerIpc()
})

describe('receivables IPC', () => {
  it('insideExports accepts files under the folder only', () => {
    const root = '/data/companies/acme/exports'
    expect(rxIpc.insideExports(root, `${root}/statements/s.pdf`)).toBe(`${root}/statements/s.pdf`)
    expect(rxIpc.insideExports(root, `${root}/../../x`)).toBeNull()
    expect(rxIpc.insideExports(root, `${root}/statements/../../company.db`)).toBeNull()
    expect(rxIpc.insideExports(root, '/data/companies/acme/exports-other/x.pdf')).toBeNull()
    expect(rxIpc.insideExports(root, root)).toBeNull()
    expect(rxIpc.insideExports(root, '/etc/passwd')).toBeNull()
  })

  it('setHold is owner-only; reveal refuses paths escaping exports', async () => {
    expect(ipc.CHANNEL_ROLES.get('receivables:setHold')).toBe('owner')
    const { slug } = await ok<{ slug: string }>('company:create', {
      name: 'Hold Roles Co', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null
    })
    await ok('company:open', { slug })
    const groups = await ok<{ id: number; name: string }[]>('master:groups:list')
    const debtor = await ok<{ id: number }>('master:ledgers:create', {
      name: 'Held Party', groupId: groups.find((g) => g.name === 'Sundry Debtors')!.id, openingBalance: 0, gstin: null, stateCode: null, address: null,
      taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
    })
    const owner = await ok<{ id: number }>('users:save', { data: { name: 'Owner', pin: '1111', role: 'owner', active: true } })
    const acct = await ok<{ id: number }>('users:save', { data: { name: 'Clerk', pin: '2222', role: 'accountant', active: true } })
    await ok('auth:login', { userId: acct.id, pin: '2222' })
    const denied = await call('receivables:setHold', { ledgerId: debtor.id, hold: true, reason: 'Overdue' })
    expect(denied.ok).toBe(false)
    expect(denied.error).toMatch(/permission/)
    await ok('auth:logout')
    await ok('auth:login', { userId: owner.id, pin: '1111' })
    await ok('receivables:setHold', { ledgerId: debtor.id, hold: true, reason: 'Overdue' })

    const escape = await call('receivables:reveal', { path: join(DATA_DIR, 'companies', slug, 'exports', '..', 'company.db') })
    expect(escape.ok).toBe(false)
    const sibling = await call('receivables:reveal', { path: join(DATA_DIR, 'companies', slug, 'exports-other', 'x.pdf') })
    expect(sibling.ok).toBe(false)
    await ok('receivables:reveal', { path: join(DATA_DIR, 'companies', slug, 'exports', 'statements', 'x.pdf') })
    expect(revealed).toEqual([join(DATA_DIR, 'companies', slug, 'exports', 'statements', 'x.pdf')])
  })
})
