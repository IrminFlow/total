// Update consent IPC: app-level setting, Zod-strict, owner-only (role map), nothing in any company DB.
import { TRUSTED_EVENT } from './ipcSender.testutil'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<{ ok: boolean; data?: any; error?: string }>>()

vi.mock('electron', () => ({
  app: { getVersion: () => '0.12.0-test', getPath: () => tmpdir(), isPackaged: false, on: () => {} },
  ipcMain: { handle: (ch: string, fn: (e: unknown, p: unknown) => Promise<{ ok: boolean }>) => handlers.set(ch.replace(/^total:/, ''), fn) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '', showItemInFolder: () => {}, openExternal: async () => {} },
  Notification: class {},
  BrowserWindow: class { static getAllWindows(): never[] { return [] } },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('electron-updater', () => ({ default: { autoUpdater: {} } }))

const root = mkdtempSync(join(tmpdir(), 'total-ipc-updates-'))
process.env.TOTAL_DATA_DIR = root
process.env.TOTAL_SUPPRESS_SYNC_WARNING = '1'

const call = (ch: string, payload?: unknown) => handlers.get(ch)!(TRUSTED_EVENT, payload)
let ipc: typeof import('./ipc')

beforeAll(async () => {
  ipc = await import('./ipc')
  ipc.registerIpc()
})

describe('app:updates:*', () => {
  it('reads defaults (automatic check on, nothing skipped, no notice)', async () => {
    const r = await call('app:updates:get')
    expect(r.ok).toBe(true)
    expect(r.data).toMatchObject({ settings: { autoCheck: true, skippedVersion: null }, notice: null })
  })

  it('turns the check off and on, stored in the app-level file', async () => {
    const off = await call('app:updates:set', { autoCheck: false, confirmNoUsers: true })
    expect(off.data.settings.autoCheck).toBe(false)
    expect(JSON.parse(readFileSync(join(root, 'app-settings.json'), 'utf8')).updates.autoCheck).toBe(false)
    expect((await call('app:updates:get')).data.settings.autoCheck).toBe(false)
    expect((await call('app:updates:set', { autoCheck: true, confirmNoUsers: true })).data.settings.autoCheck).toBe(true)
  })

  it('parses payloads strictly', async () => {
    expect((await call('app:updates:set', { autoCheck: 'no', confirmNoUsers: true })).ok).toBe(false)
    expect((await call('app:updates:set', { autoCheck: true, confirmNoUsers: true, extra: 1 })).ok).toBe(false)
    expect((await call('app:updates:act', { action: 'format-disk', confirmNoUsers: true })).ok).toBe(false)
    expect((await call('app:updates:act', { action: 'skip', confirmNoUsers: true })).ok).toBe(true)
  })

  it('writes are owner-only; reading is open', () => {
    expect(ipc.CHANNEL_ROLES.get('app:updates:set')).toBe('owner')
    expect(ipc.CHANNEL_ROLES.get('app:updates:act')).toBe('owner')
    expect(ipc.CHANNEL_ROLES.get('app:updates:get')).toBe('viewer')
  })

  it('the AI-key rule: owner / accountant / no users with another company that has users / confirmation', async () => {
    const co = (name: string): Record<string, unknown> => ({
      name, stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null
    })
    const ok = async <T>(ch: string, p?: unknown): Promise<T> => {
      const r = await call(ch, p)
      if (!r.ok) throw new Error(`${ch}: ${r.error}`)
      return r.data as T
    }
    const audit = (): string[] => readFileSync(join(root, 'app-settings-audit.jsonl'), 'utf8').trim().split('\n')
    expect(ipc.CHANNEL_ROLES.get('app:updates:canSet')).toBe('viewer')
    // No company open (the notice on the company-select screen), no company anywhere: the data-root rule.
    expect(await ok('app:updates:canSet')).toEqual({ allowed: true, reason: 'needs_confirmation' })
    expect((await call('app:updates:act', { action: 'skip' })).ok).toBe(false)

    const plain = await ok<{ slug: string }>('company:create', co('No Users Co'))
    const team = await ok<{ slug: string }>('company:create', co('Team Co'))

    // Nobody has users anywhere: allowed, but only with the explicit confirmation.
    await ok('company:open', { slug: plain.slug })
    expect(await ok('app:updates:canSet')).toEqual({ allowed: true, reason: 'needs_confirmation' })
    const before = audit().length
    const unconfirmed = await call('app:updates:set', { autoCheck: false })
    expect(unconfirmed.ok).toBe(false)
    expect(unconfirmed.error).toMatch(/Confirm to continue/)
    expect((await call('app:updates:act', { action: 'skip' })).ok).toBe(false)
    expect(audit().length).toBe(before)
    expect((await call('app:updates:set', { autoCheck: false, confirmNoUsers: true })).ok).toBe(true)
    expect(audit().length).toBe(before + 1)
    expect(JSON.parse(audit().at(-1)!).user).toBe('no sign-ins (confirmed)')

    // A company with users: owner only (no confirmation involved).
    await ok('company:open', { slug: team.slug })
    const owner = await ok<{ id: number }>('users:save', { data: { name: 'Owner', pin: '1111', role: 'owner', active: true } })
    const clerk = await ok<{ id: number }>('users:save', { data: { name: 'Clerk', pin: '2222', role: 'accountant', active: true } })
    await ok('auth:login', { userId: owner.id, pin: '1111' })
    expect(await ok('app:updates:canSet')).toEqual({ allowed: true, reason: 'ok' })
    expect((await call('app:updates:set', { autoCheck: true })).ok).toBe(true)
    expect(JSON.parse(audit().at(-1)!).user).toBe('Owner')
    await ok('auth:login', { userId: clerk.id, pin: '2222' })
    expect(await ok('app:updates:canSet')).toEqual({ allowed: false, reason: 'owner_only' })
    const asClerk = await call('app:updates:set', { autoCheck: false, confirmNoUsers: true })
    expect(asClerk.ok).toBe(false)
    expect((await call('app:updates:act', { action: 'skip', confirmNoUsers: true })).ok).toBe(false)
    const n = audit().length

    // The user-less company while another one has users: refused even with the confirmation, and names no company.
    await ok('company:open', { slug: plain.slug })
    const verdict = await ok<Record<string, unknown>>('app:updates:canSet')
    expect(verdict).toEqual({ allowed: false, reason: 'other_company_has_users' })
    expect(JSON.stringify(verdict)).not.toMatch(/team/i)
    for (const r of [await call('app:updates:set', { autoCheck: false, confirmNoUsers: true }), await call('app:updates:act', { action: 'skip', confirmNoUsers: true })]) {
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/Another company on this computer has users/)
    }
    expect(audit().length).toBe(n)
    expect((await call('app:updates:canSet', { extra: 1 })).ok).toBe(false)

    // Back on the company-select screen (no company open): every company counts, so Team Co's users refuse it.
    await ok('company:close')
    expect(await ok('app:updates:canSet')).toEqual({ allowed: false, reason: 'other_company_has_users' })
    const closed = await call('app:updates:act', { action: 'skip', confirmNoUsers: true })
    expect(closed.ok).toBe(false)
    expect(closed.error).toMatch(/Another company on this computer has users/)
    expect(audit().length).toBe(n)
  })
})
