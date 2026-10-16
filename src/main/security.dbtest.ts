// WP 7.2 security, end to end through the IPC handlers (electron mocked; a scratch TOTAL_DATA_DIR):
//  - an existing plaintext company (a file made by the previous schema) opens unchanged — no prompt;
//  - the passphrase lock: the verified copy swapped in, the audit row inside the encrypted books,
//    every backup converted, the key file beside the books, no passphrase / raw key stored;
//    reopening needs the passphrase (wrong ones refused and throttled); change; off again;
//  - backups of a locked business are encrypted; the restore check (pass, and a damaged backup fails);
//  - capability flags: defaults = the roles, flags grant / take away, enforced in main, audited;
//  - the session lock: ⌘L and the idle auto-lock gate every channel until the PIN.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3-multiple-ciphers'
import { testFileDb } from './db/testdb'

type Result = { ok: boolean; data?: unknown; error?: string; code?: string; field?: string }
const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<Result>>()
const sent: { channel: string; payload: unknown }[] = []

vi.mock('electron', () => ({
  app: { getVersion: () => '0.12.0-test', getPath: () => tmpdir(), isPackaged: false, on: () => {} },
  ipcMain: { handle: (ch: string, fn: (e: unknown, p: unknown) => Promise<Result>) => handlers.set(ch.replace(/^total:/, ''), fn) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '', showItemInFolder: () => {}, openExternal: async () => {} },
  Notification: class {},
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } }] },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./updater', () => ({ checkForUpdatesInteractive: async () => null }))

const DATA_DIR = mkdtempSync(join(tmpdir(), 'total-security-'))
process.env.TOTAL_DATA_DIR = DATA_DIR
process.env.TOTAL_SUPPRESS_SYNC_WARNING = '1'
// The hermetic-test KDF cost (and the insecure test cipher for the secret store's second copy).
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
const header = (path: string): string => readFileSync(path).subarray(0, 15).toString('latin1')
const PLAIN = 'SQLite format 3'

let ipc: typeof import('./ipc')
let enc: typeof import('./db/encryption')
let migrations: typeof import('./db/migrations')
let seed: typeof import('./db/seed')
let migrate: typeof import('./db/migrate')

beforeAll(async () => {
  ipc = await import('./ipc')
  enc = await import('./db/encryption')
  migrations = await import('./db/migrations')
  seed = await import('./db/seed')
  migrate = await import('./db/migrate')
  ipc.registerIpc()
}, 120_000)

afterAll(() => {
  ipc.closeCurrentCompany()
  rmSync(DATA_DIR, { recursive: true, force: true })
})

/** A two-line receipt between Cash and a sales ledger (created on first use). */
async function postReceipt(amount: number): Promise<Result> {
  const ledgers = await ok<{ id: number; name: string; groupId: number }[]>('master:ledgers:list')
  const groups = await ok<{ id: number; name: string }[]>('master:groups:list')
  const cash = ledgers.find((l) => l.name === 'Cash')!
  let other = ledgers.find((l) => l.name === 'Counter Sales')
  if (!other) {
    other = await ok('master:ledgers:create', {
      name: 'Counter Sales', groupId: groups.find((g) => g.name === 'Sales Accounts')!.id, openingBalance: 0, gstin: null, stateCode: null, address: null,
      taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
    })
  }
  const types = await ok<{ id: number; kind: string }[]>('master:voucherTypes:list')
  return call('voucher:save', {
    data: {
      voucherTypeId: types.find((t) => t.kind === 'receipt')!.id, date: '2026-04-10', partyLedgerId: null, narration: null, reference: null, instrumentNo: null,
      instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: cash.id, drCr: 'dr', amount, costAllocations: [] },
        { ledgerId: other!.id, drCr: 'cr', amount, costAllocations: [] }
      ],
      inventory: [], billRefs: [], tds: null
    }
  })
}

/** Audit rows of an entity with their `after` parsed. */
async function auditRows(entity: string): Promise<{ action: string; after: Record<string, unknown> | null }[]> {
  const r = await ok<{ rows: { action: string; afterJson: string | null }[] }>('audit:list', { entity, pageSize: 500 })
  return r.rows.map((x) => ({ action: x.action, after: x.afterJson ? (JSON.parse(x.afterJson) as Record<string, unknown>) : null }))
}

const tbTotals = async (): Promise<{ d: number; c: number; n: number }> => {
  const tb = await ok<{ totalDebit: number; totalCredit: number; rows: unknown[] }>('report:trialBalance', { asOn: '2027-03-31' })
  return { d: tb.totalDebit, c: tb.totalCredit, n: tb.rows.length }
}

describe('upgrade: an existing plaintext company opens unchanged', () => {
  it('a file made by the previous schema (no WP 7.2 migration) opens with no prompt, migrates, stays plaintext', async () => {
    const slug = 'old-books'
    const { mkdirSync } = await import('fs')
    mkdirSync(join(dir(slug), 'backups'), { recursive: true })
    const d = testFileDb(dbFile(slug))
    d.pragma('journal_mode = WAL')
    migrate.migrate(d, migrations.MIGRATIONS.slice(0, -1))
    seed.seedCompany(d, company('Old Books') as never)
    d.close()
    const opened = await ok<{ encrypted: boolean; locked: boolean }>('company:open', { slug })
    expect(opened.encrypted).toBe(false)
    expect(opened.locked).toBe(false)
    expect(header(dbFile(slug))).toBe(PLAIN)
    expect(existsSync(join(dir(slug), 'company.key.json'))).toBe(false)
    const sec = await ok<{ encrypted: boolean; autoLockMinutes: number | null }>('security:get')
    expect(sec).toMatchObject({ encrypted: false, autoLockMinutes: null })
    const users = await ok<{ capabilities: unknown }[]>('users:list')
    expect(users).toEqual([])
    await ok('company:close')
  })
})

describe('the passphrase lock', () => {
  let slug: string
  const PASS = 'mango season 2026'

  it('turns on: verified copy swapped in, books intact, audit row inside, backups converted, nothing secret stored', async () => {
    slug = (await ok<{ slug: string }>('company:create', company('Locked Traders'))).slug
    await ok('company:open', { slug })
    expect((await postReceipt(150_000)).ok).toBe(true)
    await ok('backup:run')
    const before = await tbTotals()
    const plainBackups = readdirSync(join(dir(slug), 'backups')).filter((f) => f.endsWith('.db'))
    expect(plainBackups.length).toBeGreaterThan(0)

    expect((await call('security:passphrase:on', { passphrase: PASS, confirm: 'something else' })).code).toBe('passphrase_mismatch')
    expect((await call('security:passphrase:on', { passphrase: 'short', confirm: 'short' })).ok).toBe(false)
    const on = await ok<{ encrypted: boolean; backupsConverted: number; backupsFailed: string[] }>('security:passphrase:on', { passphrase: PASS, confirm: PASS })
    expect(on.encrypted).toBe(true)
    expect(on.backupsFailed).toEqual([])
    // the manual + the pre-encrypt one at least (review: the reopen's own "open" backup, already
    // encrypted, replaces a plaintext "open" backup of the same second instead of failing on it)
    expect(on.backupsConverted).toBeGreaterThanOrEqual(2)

    expect(header(dbFile(slug))).not.toBe(PLAIN)
    expect(await tbTotals()).toEqual(before)
    for (const f of readdirSync(join(dir(slug), 'backups')).filter((x) => x.endsWith('.db'))) expect(header(join(dir(slug), 'backups', f))).not.toBe(PLAIN)
    expect(existsSync(`${dbFile(slug)}.converting`)).toBe(false)
    // Nothing on disk holds the passphrase or the raw key.
    const keyFile = readFileSync(join(dir(slug), 'company.key.json'), 'utf8')
    expect(keyFile).not.toContain(PASS)
    const secrets = existsSync(join(DATA_DIR, 'secrets.json')) ? readFileSync(join(DATA_DIR, 'secrets.json'), 'utf8') : ''
    expect(secrets).not.toContain(PASS)
    // The plain driver without a key cannot read the books.
    const plain = new Database(dbFile(slug), { readonly: true })
    try {
      expect(() => plain.prepare('SELECT COUNT(*) FROM vouchers').get()).toThrow(/not a database/)
    } finally {
      plain.close() // Windows can't remove a file a handle still holds
    }
    // The change is in the encrypted books' own trail, chained.
    const audit = { rows: await auditRows('security') }
    expect(audit.rows.some((r) => r.after?.encrypted === true)).toBe(true)
    const verify = await ok<{ ok: boolean }>('audit:verify')
    expect(verify.ok).toBe(true)
    expect((await call('security:passphrase:on', { passphrase: PASS, confirm: PASS })).code).toBe('security_already_locked')
  })

  it('reopening needs the passphrase; wrong ones are refused and throttled; the right one opens the same books', async () => {
    const before = await tbTotals()
    await ok('company:close')
    const none = await call('company:open', { slug })
    expect(none).toMatchObject({ ok: false, code: 'passphrase_required', field: 'passphrase' })
    expect((await call('company:open', { slug, passphrase: 'not it at all' })).code).toBe('wrong_passphrase')
    // A locked member is skipped by readers that are not the open company.
    expect(() => enc.openDb(dbFile(slug), { readonly: true })).toThrow(/locked with a passphrase/)
    const opened = await ok<{ encrypted: boolean }>('company:open', { slug, passphrase: PASS })
    expect(opened.encrypted).toBe(true)
    expect(await tbTotals()).toEqual(before)
    expect((await postReceipt(20_000)).ok).toBe(true)
  })

  it('throttles after five wrong passphrases', async () => {
    await ok('company:close')
    for (let i = 0; i < 5; i++) expect((await call('company:open', { slug, passphrase: `wrong ${i} attempt` })).code).toBe('wrong_passphrase')
    expect((await call('company:open', { slug, passphrase: PASS })).code).toBe('passphrase_throttled')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000)
    try {
      await ok('company:open', { slug, passphrase: PASS })
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('backups of a locked business are encrypted and pass the restore check; a damaged one fails it', async () => {
    const run = await ok<{ path: string; check: { ok: boolean; encrypted: boolean } }>('backup:run')
    expect(header(run.path)).not.toBe(PLAIN)
    expect(run.check).toMatchObject({ ok: true, encrypted: true })
    // A damaged copy (bytes overwritten in the middle).
    const bad = join(dir(slug), 'backups', '2020-01-01T00-00-00-manual.db')
    copyFileSync(run.path, bad)
    const bytes = readFileSync(bad)
    bytes.fill(0x41, 4096, Math.min(bytes.length, 4096 * 6))
    writeFileSync(bad, bytes)
    const failed = await ok<{ ok: boolean; error: string | null }>('backup:check', { file: '2020-01-01T00-00-00-manual.db' })
    expect(failed.ok).toBe(false)
    expect(failed.error).toBeTruthy()
    const checks = await ok<{ ok: boolean }[]>('backup:checks')
    expect(checks[0]!.ok).toBe(false)
    expect((await ok<{ lastCheck: { ok: boolean } }>('security:get')).lastCheck.ok).toBe(false)
    rmSync(bad)
  })

  it('a backup of the locked business restores (the lock stays)', async () => {
    const list = await ok<{ file: string; tag: string }[]>('backup:list')
    const manual = list.find((b) => b.tag === 'manual')!
    const restored = await ok<{ auditChain: { ok: boolean } }>('backup:restore', { file: manual.file })
    expect(restored.auditChain.ok).toBe(true)
    expect((await ok<{ encrypted: boolean }>('company:current')).encrypted).toBe(true)
    expect(header(dbFile(slug))).not.toBe(PLAIN)
  })

  it('the passphrase changes (same key: the books and backups are not re-encrypted)', async () => {
    const backupBytes = readdirSync(join(dir(slug), 'backups')).filter((f) => f.endsWith('.db')).map((f) => readFileSync(join(dir(slug), 'backups', f)).subarray(0, 64).toString('hex'))
    expect((await call('security:passphrase:change', { current: 'wrong passphrase', passphrase: 'new passphrase 1', confirm: 'new passphrase 1' })).code).toBe('wrong_passphrase')
    await ok('security:passphrase:change', { current: PASS, passphrase: 'new passphrase 1', confirm: 'new passphrase 1' })
    expect(readdirSync(join(dir(slug), 'backups')).filter((f) => f.endsWith('.db')).map((f) => readFileSync(join(dir(slug), 'backups', f)).subarray(0, 64).toString('hex'))).toEqual(backupBytes)
    await ok('company:close')
    expect((await call('company:open', { slug, passphrase: PASS })).code).toBe('wrong_passphrase')
    await ok('company:open', { slug, passphrase: 'new passphrase 1' })
  })

  it('turns off again: plaintext books and backups, the key file gone, audited', async () => {
    const before = await tbTotals()
    expect((await call('security:passphrase:off', { passphrase: PASS })).code).toBe('wrong_passphrase')
    const off = await ok<{ encrypted: boolean; backupsFailed: string[] }>('security:passphrase:off', { passphrase: 'new passphrase 1' })
    expect(off).toMatchObject({ encrypted: false, backupsFailed: [] })
    expect(header(dbFile(slug))).toBe(PLAIN)
    for (const f of readdirSync(join(dir(slug), 'backups')).filter((x) => x.endsWith('.db'))) expect(header(join(dir(slug), 'backups', f))).toBe(PLAIN)
    expect(existsSync(join(dir(slug), 'company.key.json'))).toBe(false)
    expect(await tbTotals()).toEqual(before)
    await ok('company:close')
    expect((await ok<{ encrypted: boolean }>('company:open', { slug })).encrypted).toBe(false)
    const audit = { rows: await auditRows('security') }
    expect(audit.rows.some((r) => r.after?.encrypted === false)).toBe(true)
    expect((await ok<{ ok: boolean }>('audit:verify')).ok).toBe(true)
  })
})

describe('capability flags (finer-grained roles)', () => {
  let ids: { owner: number; acct: number; viewer: number }
  const PIN = { owner: '1111', acct: '2222', viewer: '3333' }
  const login = (id: number, pin: string): Promise<unknown> => ok('auth:login', { userId: id, pin })

  it('defaults = today: an accountant posts, a viewer does not; flags are owner-only and audited', async () => {
    const { slug } = await ok<{ slug: string }>('company:create', company('Roles Co'))
    await ok('company:open', { slug })
    const owner = await ok<{ id: number }>('users:save', { data: { name: 'Owner', role: 'owner', pin: PIN.owner } })
    const acct = await ok<{ id: number; capabilities: unknown }>('users:save', { data: { name: 'Asha', role: 'accountant', pin: PIN.acct } })
    const viewer = await ok<{ id: number }>('users:save', { data: { name: 'Vikram', role: 'viewer', pin: PIN.viewer } })
    ids = { owner: owner.id, acct: acct.id, viewer: viewer.id }
    expect(acct.capabilities).toBeNull()

    await login(ids.acct, PIN.acct)
    expect((await postReceipt(10_000)).ok).toBe(true)
    expect((await call('export:csv', { filename: 'tb', csv: 'a,b' })).ok).toBe(true)
    expect((await call('report:profitLoss', { from: '2026-04-01', to: '2027-03-31' })).ok).toBe(true)
    // Only an owner sets flags.
    expect((await call('users:save', { id: ids.viewer, data: { name: 'Vikram', role: 'viewer', capabilities: { canPost: true } } })).code).toBe('not_permitted')

    await login(ids.viewer, PIN.viewer)
    expect((await postReceipt(10_000)).code).toBe('not_permitted')
    expect((await call('report:profitLoss', { from: '2026-04-01', to: '2027-03-31' })).ok).toBe(true)
    const me = await ok<{ can: Record<string, boolean> }>('auth:current')
    expect(me.can).toEqual({ canPost: false, canSeeProfit: true, canExport: true, canManageAi: false })
  })

  it('a granted flag lets a viewer post; a removed one stops an accountant; profit / export flags; owners unaffected', async () => {
    await login(ids.owner, PIN.owner)
    const v = await ok<{ capabilities: unknown }>('users:save', { id: ids.viewer, data: { name: 'Vikram', role: 'viewer', capabilities: { canPost: true, canSeeProfit: false } } })
    expect(v.capabilities).toEqual({ canPost: true, canSeeProfit: false })
    await ok('users:save', { id: ids.acct, data: { name: 'Asha', role: 'accountant', capabilities: { canPost: false, canExport: false } } })
    const audit = { rows: await auditRows('user') }
    expect(audit.rows.some((r) => JSON.stringify(r.after).includes('"canSeeProfit":false'))).toBe(true)

    await login(ids.viewer, PIN.viewer)
    expect((await postReceipt(5_000)).ok).toBe(true)
    // ...but a granted flag never opens an owner-only channel.
    expect((await call('company:lock:set', { date: null })).code).toBe('not_permitted')
    expect((await call('report:profitLoss', { from: '2026-04-01', to: '2027-03-31' })).code).toBe('not_permitted')
    const home = await ok<{ profitHidden?: boolean; profit: { year: { netProfit: number } } }>('simple:home', {})
    expect(home.profitHidden).toBe(true)
    expect(home.profit.year.netProfit).toBe(0)
    const series = await ok<{ trade: { ok: boolean } }>('report:dashboardSeries', { today: '2026-09-01', from: '2026-04-01', to: '2026-09-01' })
    expect(series.trade.ok).toBe(false)

    await login(ids.acct, PIN.acct)
    expect((await postReceipt(5_000)).code).toBe('not_permitted')
    expect((await call('export:csv', { filename: 'tb', csv: 'a,b' })).code).toBe('not_permitted')
    expect((await call('report:trialBalance', { asOn: '2027-03-31' })).ok).toBe(true)

    // Flags on an owner are never stored.
    await login(ids.owner, PIN.owner)
    const o = await ok<{ capabilities: unknown }>('users:save', { id: ids.owner, data: { name: 'Owner', role: 'owner', capabilities: { canPost: false } } })
    expect(o.capabilities).toBeNull()
    expect((await postReceipt(1_000)).ok).toBe(true)
    // Back to the role's default: nothing stored.
    const back = await ok<{ capabilities: unknown }>('users:save', { id: ids.acct, data: { name: 'Asha', role: 'accountant', capabilities: { canPost: true, canExport: true } } })
    expect(back.capabilities).toBeNull()
  })

  it('every channel a flag governs exists (the map cannot drift from the handlers)', () => {
    const map = ipc.channelCapabilityMap()
    for (const ch of map.keys()) expect(ipc.CHANNEL_ROLES.has(ch), ch).toBe(true)
    expect(map.get('voucher:save')).toBe('canPost')
    expect(map.get('simple:post')).toBe('canPost')
    expect(map.get('export:books')).toBe('canExport')
    expect(map.get('report:profitLoss')).toBe('canSeeProfit')
    expect(map.get('ai:settings:set')).toBe('canManageAi')
  })

  describe('the session lock', () => {
    it('⌘L signs the user out: every channel but the PIN screen is refused (main enforces), audited', async () => {
      sent.length = 0
      await login(ids.acct, PIN.acct)
      await ok('session:lock')
      expect(sent.some((s) => s.channel === 'total:session:locked')).toBe(true)
      for (const [ch, p] of [['report:trialBalance', { asOn: '2027-03-31' }], ['master:ledgers:list', undefined], ['security:get', undefined], ['session:activity', undefined]] as const) {
        expect((await call(ch, p)).code, ch).toBe('session_locked')
      }
      expect((await ok<{ locked: boolean }>('company:current')).locked).toBe(true)
      expect((await call('auth:users')).ok).toBe(true)
      await login(ids.acct, PIN.acct)
      expect((await call('report:trialBalance', { asOn: '2027-03-31' })).ok).toBe(true)
      await login(ids.owner, PIN.owner)
      const audit = { rows: await auditRows('user') }
      expect(audit.rows.some((r) => r.action === 'logout' && r.after?.lock === 'manual')).toBe(true)
    })

    it('auto-lock after the set idle minutes (owner-only setting, audited); activity keeps it open', async () => {
      await login(ids.acct, PIN.acct)
      expect((await call('security:autoLock:set', { minutes: 5 })).code).toBe('not_permitted')
      await login(ids.owner, PIN.owner)
      expect((await call('security:autoLock:set', { minutes: 7 })).ok).toBe(false)
      await ok('security:autoLock:set', { minutes: 5 })
      const t0 = Date.now()
      const now = vi.spyOn(Date, 'now')
      try {
        now.mockReturnValue(t0 + 4 * 60_000)
        await ok('session:activity')
        now.mockReturnValue(t0 + 8 * 60_000)
        expect((await call('report:trialBalance', { asOn: '2027-03-31' })).ok).toBe(true) // 4 min since the activity
        now.mockReturnValue(t0 + 9 * 60_000 + 1)
        expect((await call('report:trialBalance', { asOn: '2027-03-31' })).code).toBe('session_locked')
      } finally {
        vi.restoreAllMocks()
      }
      await login(ids.owner, PIN.owner)
      const audit = { rows: await auditRows('user') }
      expect(audit.rows.some((r) => r.action === 'logout' && r.after?.lock === 'idle')).toBe(true)
      await ok('security:autoLock:set', { minutes: null })
      expect((await ok<{ autoLockMinutes: number | null }>('security:get')).autoLockMinutes).toBeNull()
    })

    it('a business without users locks too — a privacy screen: everything waits for session:unlock, audited', async () => {
      const { slug } = await ok<{ slug: string }>('company:create', company('No People Co'))
      await ok('company:open', { slug })
      sent.length = 0
      expect(await ok('session:lock')).toEqual({ locked: true, kind: 'privacy' })
      expect(sent.find((x) => x.channel === 'total:session:locked')?.payload).toEqual({ reason: 'manual', kind: 'privacy' })
      for (const [ch, p] of [['report:trialBalance', { asOn: '2027-03-31' }], ['master:ledgers:list', undefined], ['users:save', { data: { name: 'Sneaky', role: 'owner', pin: '9999' } }]] as const) {
        expect((await call(ch, p)).code, ch).toBe('session_locked')
      }
      const cur = await ok<{ locked: boolean; lockKind: string }>('company:current')
      expect(cur).toMatchObject({ locked: true, lockKind: 'privacy' })
      // anyone can unlock it (it says so) — no passphrase needed or asked
      expect(await ok('session:unlock', {})).toEqual({ locked: false })
      expect((await call('report:trialBalance', { asOn: '2027-03-31' })).ok).toBe(true)
      expect((await ok<{ locked: boolean }>('company:current')).locked).toBe(false)
      // unlocking an unlocked business changes nothing
      expect(await ok('session:unlock')).toEqual({ locked: false })
      const rows = await auditRows('user')
      expect(rows.some((r) => r.action === 'logout' && r.after?.lock === 'manual' && r.after?.noUsers === true)).toBe(true)
      expect(rows.some((r) => r.action === 'login' && r.after?.lock === 'manual' && r.after?.noUsers === true)).toBe(true)
      // a strict payload
      await ok('session:lock')
      expect((await call('session:unlock', { pin: '1' })).code).toBe('invalid_input')
      await ok('session:unlock', {})
    })

    it('without users the auto-lock works too; activity keeps it open', async () => {
      await ok('security:autoLock:set', { minutes: 5 })
      const t0 = Date.now()
      const now = vi.spyOn(Date, 'now')
      try {
        now.mockReturnValue(t0 + 4 * 60_000)
        await ok('session:activity')
        now.mockReturnValue(t0 + 8 * 60_000)
        expect((await call('master:ledgers:list')).ok).toBe(true)
        now.mockReturnValue(t0 + 9 * 60_000 + 1)
        expect((await call('master:ledgers:list')).code).toBe('session_locked')
        expect((await ok<{ lockKind: string; locked: boolean }>('company:current')).locked).toBe(true)
        await ok('session:unlock', {})
      } finally {
        vi.restoreAllMocks()
      }
      expect((await auditRows('user')).some((r) => r.action === 'logout' && r.after?.lock === 'idle' && r.after?.noUsers === true)).toBe(true)
      await ok('security:autoLock:set', { minutes: null })
    })

    it('without users but with the passphrase lock on, unlocking asks for the passphrase (throttled like opening)', async () => {
      const PASS = 'quiet rain 4411'
      await ok('security:passphrase:on', { passphrase: PASS, confirm: PASS })
      expect(await ok('session:lock')).toEqual({ locked: true, kind: 'passphrase' })
      expect((await call('session:unlock', {})).code).toBe('passphrase_required')
      for (let i = 0; i < 4; i++) expect((await call('session:unlock', { passphrase: 'not it at all' })).code).toBe('wrong_passphrase')
      expect((await call('session:unlock', { passphrase: 'not it at all' })).code).toBe('wrong_passphrase')
      // five wrong in a row: even the right one waits 30 seconds
      expect((await call('session:unlock', { passphrase: PASS })).code).toBe('passphrase_throttled')
      expect((await call('master:ledgers:list')).code).toBe('session_locked')
      const t0 = Date.now()
      const now = vi.spyOn(Date, 'now')
      try {
        now.mockReturnValue(t0 + 31_000)
        expect(await ok('session:unlock', { passphrase: PASS })).toEqual({ locked: false })
      } finally {
        vi.restoreAllMocks()
      }
      expect((await call('master:ledgers:list')).ok).toBe(true)
    })

    it('a business WITH users unlocks only through the PIN screen', async () => {
      await ok('company:open', { slug: 'roles-co' })
      await login(ids.owner, PIN.owner)
      expect((await call('session:unlock', {})).code).toBe('unlock_needs_pin')
    })
  })
})
