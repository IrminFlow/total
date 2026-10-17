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
    const off = await call('app:updates:set', { autoCheck: false })
    expect(off.data.settings.autoCheck).toBe(false)
    expect(JSON.parse(readFileSync(join(root, 'app-settings.json'), 'utf8')).updates.autoCheck).toBe(false)
    expect((await call('app:updates:get')).data.settings.autoCheck).toBe(false)
    expect((await call('app:updates:set', { autoCheck: true })).data.settings.autoCheck).toBe(true)
  })

  it('parses payloads strictly', async () => {
    expect((await call('app:updates:set', { autoCheck: 'no' })).ok).toBe(false)
    expect((await call('app:updates:set', { autoCheck: true, extra: 1 })).ok).toBe(false)
    expect((await call('app:updates:act', { action: 'format-disk' })).ok).toBe(false)
    expect((await call('app:updates:act', { action: 'skip' })).ok).toBe(true)
  })

  it('writes are owner-only; reading is open', () => {
    expect(ipc.CHANNEL_ROLES.get('app:updates:set')).toBe('owner')
    expect(ipc.CHANNEL_ROLES.get('app:updates:act')).toBe('owner')
    expect(ipc.CHANNEL_ROLES.get('app:updates:get')).toBe('viewer')
  })
})
