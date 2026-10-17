// PR #174: ai:key:canSet gives the verdict ai:key:set enforces — checked on two REAL companies in
// one data folder (no stubbed deps): one without users, one with an owner and an accountant.
import { TRUSTED_EVENT } from '../ipcSender.testutil'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

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
vi.mock('../updater', () => ({ checkForUpdatesInteractive: async () => null }))

process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-key-canset-'))
process.env.TOTAL_SUPPRESS_SYNC_WARNING = '1'

async function call(channel: string, payload?: unknown): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const h = handlers.get(channel)
  if (!h) throw new Error(`no handler ${channel}`)
  return h(TRUSTED_EVENT, payload)
}
async function ok<T>(channel: string, payload?: unknown): Promise<T> {
  const r = await call(channel, payload)
  if (!r.ok) throw new Error(`${channel}: ${r.error}`)
  return r.data as T
}
const company = (name: string): Record<string, unknown> => ({
  name, stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null
})
const KEY = 'sk-test-0123456789abcdefWXYZ'

// Imported at collection (WP 7.3), never inside the hook.
const ipc = await import('../ipc')

beforeAll(() => {
  ipc.registerIpc()
})

describe('ai:key:canSet on real companies', () => {
  it('answers what ai:key:set enforces, and names no other company', async () => {
    const plain = await ok<{ slug: string }>('company:create', company('No Users Co'))
    const team = await ok<{ slug: string }>('company:create', company('Team Co'))

    // Nobody has users anywhere yet: allowed after the shared-key confirmation.
    await ok('company:open', { slug: plain.slug })
    expect(await ok('ai:key:canSet')).toEqual({ allowed: true, reason: 'needs_confirmation' })

    await ok('company:open', { slug: team.slug })
    const owner = await ok<{ id: number }>('users:save', { data: { name: 'Owner', pin: '1111', role: 'owner', active: true } })
    const clerk = await ok<{ id: number }>('users:save', { data: { name: 'Clerk', pin: '2222', role: 'accountant', active: true } })
    await ok('auth:login', { userId: owner.id, pin: '1111' })
    expect(await ok('ai:key:canSet')).toEqual({ allowed: true, reason: 'ok' })
    await ok('auth:login', { userId: clerk.id, pin: '2222' })
    expect(await ok('ai:key:canSet')).toEqual({ allowed: false, reason: 'owner_only' })
    const asClerk = await call('ai:key:set', { key: KEY })
    expect(asClerk.ok).toBe(false)
    expect((await call('ai:key:clear', { confirmNoUsers: true })).ok).toBe(false)

    // The user-less company: another company here has users — refused even with the confirmation.
    await ok('company:open', { slug: plain.slug })
    const verdict = await ok<Record<string, unknown>>('ai:key:canSet')
    expect(verdict).toEqual({ allowed: false, reason: 'other_company_has_users' })
    expect(JSON.stringify(verdict)).not.toMatch(/team/i)
    const fromPlain = await call('ai:key:set', { key: KEY, confirmNoUsers: true })
    expect(fromPlain.ok).toBe(false)
    expect(fromPlain.error).toMatch(/Another company here has users/)
    expect((await call('ai:key:canSet', { extra: 1 })).ok).toBe(false)
  })
})
