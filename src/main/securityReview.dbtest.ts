// WP 7.2 review — the security gates end to end through the IPC handlers (electron mocked; a
// scratch TOTAL_DATA_DIR), table-driven over EVERY registered channel:
//  - while the screen is locked (⌘L / idle) every gated channel is refused with session_locked;
//  - no capability flag = the role exactly, for every channel and every role;
//  - deleting a business locked with a passphrase asks for the passphrase AND keeps asking for the
//    owner's PIN (locking the books must not take the delete protection away);
//  - taking the lock off keeps the key file while a backup could not be decrypted;
//  - a plaintext copy an interrupted "take the lock off" left beside the books goes on the next open.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

type Result = { ok: boolean; data?: unknown; error?: string; code?: string; field?: string }
const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<Result>>()

vi.mock('electron', () => ({
  app: { getVersion: () => '0.12.0-test', getPath: () => tmpdir(), isPackaged: false, on: () => {} },
  ipcMain: { handle: (ch: string, fn: (e: unknown, p: unknown) => Promise<Result>) => handlers.set(ch.replace(/^total:/, ''), fn) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
  shell: { openPath: async () => '', showItemInFolder: () => {}, openExternal: async () => {} },
  Notification: class {},
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./updater', () => ({ checkForUpdatesInteractive: async () => null }))

const DATA_DIR = mkdtempSync(join(tmpdir(), 'total-security-review-'))
process.env.TOTAL_DATA_DIR = DATA_DIR
process.env.TOTAL_SUPPRESS_SYNC_WARNING = '1'
process.env.TOTAL_INSECURE_TEST_SECRETS = '1'

async function call(channel: string, payload?: unknown): Promise<Result> {
  const h = handlers.get(channel)
  if (!h) throw new Error(`no handler ${channel}`)
  return h({}, payload)
}
async function ok<T>(channel: string, payload?: unknown): Promise<T> {
  const r = await call(channel, payload)
  if (!r.ok) throw new Error(`${channel}: ${r.error} (${r.code ?? ''})`)
  return r.data as T
}
const company = (name: string): Record<string, unknown> => ({
  name, stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null
})
const dir = (slug: string): string => join(DATA_DIR, 'companies', slug)
const dbFile = (slug: string): string => join(dir(slug), 'company.db')
const PLAIN = 'SQLite format 3'
const header = (path: string): string => readFileSync(path).subarray(0, 15).toString('latin1')

let ipc: typeof import('./ipc')
let caps: typeof import('./capabilities')
let roles: typeof import('./services/roles')

beforeAll(async () => {
  ipc = await import('./ipc')
  caps = await import('./capabilities')
  roles = await import('./services/roles')
  ipc.registerIpc()
}, 120_000)

afterAll(() => {
  ipc.closeCurrentCompany()
  rmSync(DATA_DIR, { recursive: true, force: true })
})

describe('the session lock gates every channel', () => {
  it('after ⌘L every registered gated channel answers session_locked (the gate runs before the payload is read)', async () => {
    const { slug } = await ok<{ slug: string }>('company:create', company('Gate Co'))
    await ok('company:open', { slug })
    await ok('users:save', { data: { name: 'Owner', role: 'owner', pin: '1111' } })
    await ok('session:lock')
    const refused: string[] = []
    const leaked: string[] = []
    for (const ch of [...ipc.CHANNEL_ROLES.keys()].sort()) {
      if (ipc.UNGATED_CHANNEL_NAMES.has(ch)) continue
      const r = await call(ch, undefined)
      if (r.code === 'session_locked') refused.push(ch)
      else leaked.push(ch)
    }
    expect(leaked).toEqual([])
    // the families the review was asked about are all among them
    for (const prefix of ['app:', 'assist:', 'help:', 'simple:', 'security:', 'backup:', 'ai:', 'voucher:']) {
      expect(refused.some((c) => c.startsWith(prefix)), prefix).toBe(true)
    }
    expect(refused.length).toBeGreaterThan(300)
    // the ungated ones are exactly the picker / PIN screen / logs list
    expect([...ipc.UNGATED_CHANNEL_NAMES].sort()).toEqual([
      'app:info', 'auth:current', 'auth:login', 'auth:logout', 'auth:users', 'backup:importEncrypted', 'company:close', 'company:create',
      'company:createDemo', 'company:current', 'company:delete', 'company:list', 'company:open', 'log:renderer', 'log:reveal'
    ])
    await ok('auth:login', { userId: 1, pin: '1111' })
    expect((await call('security:get')).ok).toBe(true)
  })
})

describe('capability flags: no flag = the role, for every channel', () => {
  it('every governed channel × every role gives exactly the role gate without flags (and owners are never restricted)', () => {
    const map = ipc.channelCapabilityMap()
    let checked = 0
    for (const [ch, minRole] of ipc.CHANNEL_ROLES) {
      const cap = map.get(ch)
      if (!cap) continue
      for (const role of ['viewer', 'accountant', 'owner'] as const) {
        for (const flags of [null, undefined, {}]) {
          expect(caps.capabilityAllows(role, flags, cap, minRole), `${ch} ${role}`).toBe(roles.roleAllows(role, minRole))
        }
        if (role === 'owner') {
          expect(caps.capabilityAllows('owner', { [cap]: false }, cap, minRole)).toBe(true)
        }
        checked++
      }
    }
    expect(checked).toBeGreaterThan(100)
    // a granted flag never opens an owner-only channel, except canManageAi (the owner's AI settings)
    for (const [ch, minRole] of ipc.CHANNEL_ROLES) {
      const cap = map.get(ch)
      if (!cap || cap === 'canManageAi' || minRole !== 'owner') continue
      expect(caps.capabilityAllows('viewer', { [cap]: true }, cap, minRole), ch).toBe(false)
    }
  })
})

describe('deleting a business locked with a passphrase', () => {
  const PASS = 'monsoon ledger 77'
  it('asks for the passphrase, then (it has users) for the owner PIN; a refused delete leaves it locked', async () => {
    const { slug } = await ok<{ slug: string }>('company:create', company('Delete Me Co'))
    await ok('company:open', { slug })
    await ok('users:save', { data: { name: 'Owner', role: 'owner', pin: '4321' } })
    await ok('security:passphrase:on', { passphrase: PASS, confirm: PASS })
    await ok('company:close')
    const name = 'Delete Me Co'
    expect((await call('company:delete', { slug, confirmName: name })).code).toBe('passphrase_required')
    expect((await call('company:delete', { slug, confirmName: name, passphrase: 'wrong one here' })).code).toBe('wrong_passphrase')
    const noPin = await call('company:delete', { slug, confirmName: name, passphrase: PASS })
    expect(noPin.ok).toBe(false)
    expect(noPin.error).toMatch(/owner PIN is required/)
    expect(existsSync(dbFile(slug))).toBe(true)
    // the refused delete did not leave the books unlocked
    expect((await call('company:open', { slug })).code).toBe('passphrase_required')
    await ok('company:delete', { slug, confirmName: name, passphrase: PASS, pin: '4321' })
    expect(existsSync(dir(slug))).toBe(false)
  })

  it('a locked business WITHOUT users needs only its passphrase', async () => {
    const { slug } = await ok<{ slug: string }>('company:create', company('Solo Lock Co'))
    await ok('company:open', { slug })
    await ok('security:passphrase:on', { passphrase: PASS, confirm: PASS })
    await ok('company:close')
    expect((await call('company:delete', { slug, confirmName: 'Solo Lock Co' })).code).toBe('passphrase_required')
    await ok('company:delete', { slug, confirmName: 'Solo Lock Co', passphrase: PASS })
    expect(existsSync(dir(slug))).toBe(false)
  })
})

describe('taking the lock off', () => {
  const PASS = 'harvest time 2026'
  it('keeps the key file while a backup could not be decrypted (that backup still opens with the passphrase)', async () => {
    const { slug } = await ok<{ slug: string }>('company:create', company('Keep Key Co'))
    await ok('company:open', { slug })
    await ok('security:passphrase:on', { passphrase: PASS, confirm: PASS })
    const run = await ok<{ path: string }>('backup:run')
    const bad = join(dir(slug), 'backups', '2020-01-01T00-00-00-manual.db')
    copyFileSync(run.path, bad)
    const bytes = readFileSync(bad)
    bytes.fill(0x41, 0, 64)
    writeFileSync(bad, bytes)
    const off = await ok<{ encrypted: boolean; backupsFailed: string[] }>('security:passphrase:off', { passphrase: PASS })
    expect(off.encrypted).toBe(false)
    expect(off.backupsFailed).toEqual(['2020-01-01T00-00-00-manual.db'])
    expect(header(dbFile(slug))).toBe(PLAIN)
    expect(existsSync(join(dir(slug), 'company.key.json'))).toBe(true)
    // every other backup is plaintext again
    for (const f of readdirSync(join(dir(slug), 'backups')).filter((x) => x.endsWith('.db') && !x.startsWith('2020'))) expect(header(join(dir(slug), 'backups', f))).toBe(PLAIN)
    // the plaintext business opens with no prompt despite the key file
    await ok('company:close')
    expect((await ok<{ encrypted: boolean }>('company:open', { slug })).encrypted).toBe(false)
  })

  it('a plaintext copy an interrupted "take the lock off" left beside the books is removed on the next open', async () => {
    const { slug } = await ok<{ slug: string }>('company:create', company('Leftover Co'))
    await ok('company:open', { slug })
    await ok('security:passphrase:on', { passphrase: PASS, confirm: PASS })
    await ok('company:close')
    // what a crash between "copy written" and "rename" leaves: a plaintext copy of the books
    copyFileSync(join(DATA_DIR, 'companies', 'keep-key-co', 'company.db'), `${dbFile(slug)}.converting`)
    expect(header(`${dbFile(slug)}.converting`)).toBe(PLAIN)
    await ok('company:open', { slug, passphrase: PASS })
    expect(existsSync(`${dbFile(slug)}.converting`)).toBe(false)
    expect(header(dbFile(slug))).not.toBe(PLAIN)
  })
})
