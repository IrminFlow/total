// Moving the data folder (Settings → "Where Total keeps your books"): the copy, its check, the
// pointer, the note in the old folder — and a failed copy (or pointer) leaves everything as it was.
// The secret store (hermetic test cipher) and a passphrase-locked business still open from the copy.
import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const base = mkdtempSync(join(tmpdir(), 'total-datadir-'))
const docs = join(base, 'Documents')
const userData = join(base, 'userData')
const rootA = join(docs, 'total')
mkdirSync(rootA, { recursive: true })
mkdirSync(userData, { recursive: true })
let nextPick = ''
const relaunch = vi.fn()
const exit = vi.fn()

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.12.0-test',
    getPath: (name: string) => (name === 'documents' ? docs : name === 'userData' ? userData : tmpdir()),
    isPackaged: false,
    on: () => {},
    relaunch: () => relaunch(),
    exit: (code: number) => exit(code)
  },
  ipcMain: { handle: (ch: string, fn: (e: unknown, p: unknown) => Promise<{ ok: boolean }>) => handlers.set(ch.replace(/^total:/, ''), fn) },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [nextPick] }) },
  shell: { openPath: async () => '', showItemInFolder: () => {}, openExternal: async () => {} },
  Notification: class {},
  BrowserWindow: class { static getAllWindows(): never[] { return [] } static getFocusedWindow(): null { return null } },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('electron-updater', () => ({ default: { autoUpdater: {} } }))

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<{ ok: boolean; data?: any; error?: string; code?: string }>>()
process.env.TOTAL_DATA_DIR = rootA
process.env.TOTAL_SUPPRESS_SYNC_WARNING = '1'
process.env.TOTAL_INSECURE_TEST_SECRETS = '1'

// WP 7.3: the IPC import at collection, never inside a hook.
const ipc = await import('../ipc')
const { appSecretStore } = await import('./secretStore')
const { createSecretStore, insecureTestCipher } = await import('./secrets')
const { readEnvelopes, unlockKey } = await import('./companyKeys')
const { openDb } = await import('../db/encryption')
const move = await import('./dataRootMove')
const { dataRootChoice } = await import('../paths')
ipc.registerIpc()
const call = (ch: string, payload?: unknown) => handlers.get(ch)!({}, payload)

const PASS = 'a long enough passphrase'

describe('data folder move (IPC, hermetic)', () => {
  it('refuses while TOTAL_DATA_DIR sets the folder', async () => {
    expect((await call('app:dataRoot:get')).data).toMatchObject({ path: rootA, source: 'env' })
    const r = await call('app:dataRoot:pick')
    expect(r).toMatchObject({ ok: false, code: 'data_folder_env' })
  })

  it('copies a locked business, its backups and secrets.json, checks them, writes the pointer, relaunches', async () => {
    const created = await call('company:create', { name: 'Move Traders', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null })
    expect(created.ok, created.error).toBe(true)
    const slug = created.data.slug as string
    expect((await call('company:open', { slug })).ok).toBe(true)
    const backup = await call('backup:run')
    expect(backup.ok, backup.error).toBe(true)
    const on = await call('security:passphrase:on', { passphrase: PASS, confirm: PASS })
    expect(on.ok, on.error).toBe(true)
    appSecretStore().set('app', 'aiKey', 'sk-test-123')
    writeFileSync(join(rootA, 'app-settings.json'), JSON.stringify({ updates: { autoCheck: false, skippedVersion: null } }))
    const ledgersBefore = (() => {
      const key = keyOf(rootA, slug, appSecretStore())
      return key.then((k) => {
        const db = openDb(join(rootA, 'companies', slug, 'company.db'), { key: k })
        try {
          return (db.prepare('SELECT COUNT(*) AS n FROM ledgers').get() as { n: number }).n
        } finally {
          db.close()
        }
      })
    })()
    const before = await ledgersBefore
    expect(before).toBeGreaterThan(0)

    // From here on the folder is not set by the environment: Documents/total is the default.
    delete process.env.TOTAL_DATA_DIR
    expect(dataRootChoice()).toMatchObject({ path: rootA, source: 'default' })

    const rootB = join(base, 'Elsewhere', 'Total books')
    nextPick = rootB
    const picked = await call('app:dataRoot:pick')
    expect(picked.ok, picked.error).toBe(true)
    expect(picked.data).toMatchObject({ path: rootB, ok: true, kind: 'new' })
    expect(picked.data.bytes).toBeGreaterThan(0)

    // The payload must name the folder the picker returned.
    expect((await call('app:dataRoot:move', { path: join(base, 'other') })).code).toBe('data_folder_not_picked')
    expect((await call('app:dataRoot:move', { path: rootB, extra: 1 })).ok).toBe(false)

    const moved = await call('app:dataRoot:move', { path: rootB })
    expect(moved.ok, moved.error).toBe(true)
    expect(moved.data).toMatchObject({ path: rootB, copied: true, relaunching: true })
    expect((await call('company:current')).data).toBeNull() // closed before the copy

    // The pointer names the new folder; the old folder is untouched and carries the note.
    expect(JSON.parse(readFileSync(join(userData, 'data-root.json'), 'utf8'))).toEqual({ path: rootB })
    expect(existsSync(join(rootA, 'companies', slug, 'company.db'))).toBe(true)
    expect(readFileSync(join(rootA, move.MOVED_NOTE), 'utf8')).toContain(rootB)
    expect(existsSync(join(rootB, move.MOVED_NOTE))).toBe(false)
    const auditB = readFileSync(join(rootB, 'app-settings-audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(auditB.at(-1)).toMatchObject({ setting: 'dataRoot', before: rootA, after: rootB, copied: true })
    expect(readdirSync(join(rootB, 'companies', slug, 'backups')).some((f) => f.endsWith('.db'))).toBe(true)
    expect(JSON.parse(readFileSync(join(rootB, 'app-settings.json'), 'utf8')).updates.autoCheck).toBe(false)

    // secrets.json decrypts from the new folder (safeStorage keys don't depend on the path) …
    const storeB = createSecretStore({ filePath: () => join(rootB, 'secrets.json'), cipher: insecureTestCipher() })
    expect(storeB.get('app', 'aiKey')).toBe('sk-test-123')
    // … and the locked business opens there with its passphrase, every row intact.
    const db = openDb(join(rootB, 'companies', slug, 'company.db'), { key: await keyOf(rootB, slug, storeB) })
    try {
      expect((db.prepare('SELECT COUNT(*) AS n FROM ledgers').get() as { n: number }).n).toBe(before)
      expect((db.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check).toBe('ok')
    } finally {
      db.close()
    }

    await new Promise((r) => setTimeout(r, 1700))
    expect(relaunch).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('owner-only to pick and move; reading is open', () => {
    expect(ipc.CHANNEL_ROLES.get('app:dataRoot:get')).toBe('viewer')
    expect(ipc.CHANNEL_ROLES.get('app:dataRoot:pick')).toBe('owner')
    expect(ipc.CHANNEL_ROLES.get('app:dataRoot:move')).toBe('owner')
  })
})

async function keyOf(root: string, slug: string, store: ReturnType<typeof appSecretStore>): Promise<Buffer> {
  const dir = join(root, 'companies', slug)
  const envelopes = readEnvelopes(dir, slug, store)
  expect(envelopes.length).toBeGreaterThan(0)
  return unlockKey(join(dir, 'company.db'), envelopes, PASS)
}

function makeRoot(name: string): string {
  const r = join(base, name)
  mkdirSync(join(r, 'companies', 'acme', 'backups'), { recursive: true })
  writeFileSync(join(r, 'total.json'), JSON.stringify({ companies: [{ slug: 'acme' }] }))
  writeFileSync(join(r, 'companies', 'acme', 'company.db'), Buffer.alloc(64 * 1024, 7))
  writeFileSync(join(r, 'companies', 'acme', 'backups', 'b1.db'), Buffer.alloc(8 * 1024, 3))
  writeFileSync(join(r, 'secrets.json'), '{"version":1,"secrets":{}}')
  return r
}

describe('moveDataRoot (service)', () => {
  const pointer = join(base, 'ud2', 'data-root.json')
  const opts = (from: string, to: string, deps: Parameters<typeof move.moveDataRoot>[0]['deps'] = {}) =>
    ({ from, to, pointerFile: pointer, defaultRoot: join(base, 'default-total'), who: 'Owner', appVersion: 't', deps })

  it('a copy that fails half-way removes what it made and writes no pointer', () => {
    const from = makeRoot('fail-from')
    const to = join(base, 'fail-to')
    let n = 0
    const copyFile = (a: string, b: string): void => {
      if (++n === 3) throw new Error('EIO: disk ejected')
      writeFileSync(b, readFileSync(a))
    }
    expect(() => move.moveDataRoot(opts(from, to, { copyFile }))).toThrow(expect.objectContaining({ code: 'data_folder_copy_failed' }))
    expect(existsSync(to)).toBe(false)
    expect(existsSync(pointer)).toBe(false)
    expect(existsSync(join(from, move.MOVED_NOTE))).toBe(false)
  })

  it('a copy whose bytes differ is caught by the check and rolled back (an existing empty target stays)', () => {
    const from = makeRoot('verify-from')
    const to = join(base, 'verify-to')
    mkdirSync(to)
    writeFileSync(join(to, '.DS_Store'), 'x')
    const copyFile = (a: string, b: string): void => {
      const buf = readFileSync(a)
      if (a.endsWith('company.db')) buf[100] = 0 // same size, different bytes
      writeFileSync(b, buf)
    }
    expect(() => move.moveDataRoot(opts(from, to, { copyFile }))).toThrow(expect.objectContaining({ code: 'data_folder_copy_failed' }))
    expect(readdirSync(to)).toEqual(['.DS_Store'])
    expect(existsSync(pointer)).toBe(false)
  })

  it('a pointer that cannot be written rolls the copy back', () => {
    const from = makeRoot('ptr-from')
    const to = join(base, 'ptr-to')
    const writePointer = (): void => {
      throw new Error('EACCES')
    }
    expect(() => move.moveDataRoot(opts(from, to, { writePointer }))).toThrow(expect.objectContaining({ code: 'data_folder_pointer_failed' }))
    expect(existsSync(to)).toBe(false)
    expect(existsSync(join(from, move.MOVED_NOTE))).toBe(false)
  })

  it('refuses a folder with other files, the same folder, one inside or around it, no space', () => {
    const from = makeRoot('refuse-from')
    const busy = join(base, 'busy')
    mkdirSync(busy)
    writeFileSync(join(busy, 'holiday.jpg'), 'x')
    expect(move.inspectTarget(busy, from)).toMatchObject({ ok: false, problem: 'not_empty' })
    expect(move.inspectTarget(from, from)).toMatchObject({ ok: false, problem: 'same' })
    expect(move.inspectTarget(join(from, 'companies', 'x'), from)).toMatchObject({ ok: false, problem: 'inside_current' })
    expect(move.inspectTarget(base, from)).toMatchObject({ ok: false, problem: 'contains_current' })
    expect(move.inspectTarget(join(base, 'roomy'), from, { freeBytes: () => 10 })).toMatchObject({ ok: false, problem: 'no_space' })
    expect(() => move.moveDataRoot(opts(from, busy))).toThrow(expect.objectContaining({ code: 'data_folder_not_empty' }))
  })

  it('a folder that already holds Total books is switched to, nothing copied over it', () => {
    const from = makeRoot('switch-from')
    const to = makeRoot('switch-to')
    writeFileSync(join(to, 'companies', 'acme', 'company.db'), 'theirs')
    const r = move.moveDataRoot(opts(from, to))
    expect(r).toMatchObject({ kind: 'total', copied: null })
    expect(readFileSync(join(to, 'companies', 'acme', 'company.db'), 'utf8')).toBe('theirs')
    expect(JSON.parse(readFileSync(pointer, 'utf8'))).toEqual({ path: to })
    expect(existsSync(join(from, move.MOVED_NOTE))).toBe(false)
  })

  it('moving back to the default folder removes the pointer', () => {
    const from = makeRoot('back-from')
    const def = join(base, 'default-total')
    writeFileSync(pointer, JSON.stringify({ path: from }))
    const r = move.moveDataRoot(opts(from, def))
    expect(r.kind).toBe('new')
    expect(existsSync(pointer)).toBe(false)
    expect(readFileSync(join(def, 'companies', 'acme', 'backups', 'b1.db')).length).toBe(8 * 1024)
  })
})
