// WP 3.8 — the audit-coverage registry check. Every IPC channel that can change anything must be
// mapped in auditCoverage.ts (registry test), every writeAudit entity must be in the shared
// vocabulary (source scan), and a sample of write channels driven end to end through
// registerIpc() must really write a row of a mapped entity, attributed to the right user, with
// the hash chain intact. Electron is mocked (only what the touched handlers use).
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>>()

vi.mock('electron', () => ({
  app: { getVersion: () => '0.7.0-test', getPath: () => tmpdir(), isPackaged: false, on: () => {} },
  ipcMain: { handle: (ch: string, fn: (e: unknown, p: unknown) => Promise<{ ok: boolean }>) => handlers.set(ch.replace(/^total:/, ''), fn) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '', showItemInFolder: () => {} },
  Notification: class {},
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./updater', () => ({ checkForUpdatesInteractive: async () => null }))

const DATA_DIR = mkdtempSync(join(tmpdir(), 'total-audit-coverage-'))
process.env.TOTAL_DATA_DIR = DATA_DIR
process.env.TOTAL_SUPPRESS_SYNC_WARNING = '1'

async function call<T = unknown>(channel: string, payload?: unknown): Promise<{ ok: boolean; data?: T; error?: string }> {
  const h = handlers.get(channel)
  if (!h) throw new Error(`no handler ${channel}`)
  return (await h({}, payload)) as { ok: boolean; data?: T; error?: string }
}
async function ok<T = unknown>(channel: string, payload?: unknown): Promise<T> {
  const res = await call<T>(channel, payload)
  if (!res.ok) throw new Error(`${channel}: ${res.error}`)
  return res.data as T
}

let ipc: typeof import('./ipc')
let coverage: typeof import('./auditCoverage')
let entities: readonly string[]
let slug = ''

beforeAll(async () => {
  ipc = await import('./ipc')
  coverage = await import('./auditCoverage')
  entities = (await import('@shared/auditEntities')).AUDIT_ENTITIES
  ipc.registerIpc()
})

describe('audit coverage registry', () => {
  it('maps every write channel (non-viewer role, or ungated) to the entities it logs', () => {
    const missing: string[] = []
    for (const [channel, role] of ipc.CHANNEL_ROLES) {
      const writes = role !== 'viewer' || ipc.UNGATED_CHANNEL_NAMES.has(channel)
      if (writes && !(channel in coverage.AUDIT_COVERAGE)) missing.push(`${channel} (${role})`)
    }
    expect(missing, 'add these channels to src/main/auditCoverage.ts with the audit entities they write (or `read` + why)').toEqual([])
  })

  it('has no stale entries and only known entities', () => {
    const stale = Object.keys(coverage.AUDIT_COVERAGE).filter((c) => !ipc.CHANNEL_ROLES.has(c))
    expect(stale).toEqual([])
    const unknown = Object.entries(coverage.AUDIT_COVERAGE).flatMap(([c, cov]) =>
      'audit' in cov ? cov.audit.filter((e) => !entities.includes(e)).map((e) => `${c}: ${e}`) : []
    )
    expect(unknown).toEqual([])
  })

  it('every writeAudit call site in src/main uses an entity from AUDIT_ENTITIES', () => {
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (p.endsWith('.ts') && !/\.(db)?test\.ts$/.test(p) && !p.endsWith('.testutil.ts')) files.push(p)
      }
    }
    walk(join(__dirname))
    const found = new Set<string>()
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      // writeAudit(db, 'entity', … — and the `kind === 'tcs' ? 'a' : 'b'` form.
      for (const m of src.matchAll(/writeAudit\(\s*[\w.()]+,\s*([^,]+),/g)) {
        for (const lit of m[1]!.matchAll(/'([A-Za-z_]+)'/g)) if (lit[1] !== 'tcs') found.add(lit[1]!)
      }
    }
    // raw-SQL inserts in migrations
    const migrations = readFileSync(join(__dirname, 'db', 'migrations.ts'), 'utf8')
    for (const m of migrations.matchAll(/INSERT INTO audit_log[^;]*?VALUES\s*\(\s*'([A-Za-z_]+)'/g)) found.add(m[1]!)
    expect(found.size).toBeGreaterThan(40)
    expect([...found].filter((e) => !entities.includes(e))).toEqual([])
  })
})

interface AuditDbRow { id: number; entity: string; action: string; user_name: string | null; user_id: number | null }

describe('write channels really write their mapped entities (driven through IPC)', () => {
  const companyDb = (): Database.Database => new Database(join(DATA_DIR, 'companies', slug, 'company.db'), { readonly: true })
  const rowsAfter = (afterId: number): AuditDbRow[] => {
    const db = companyDb()
    try {
      return db.prepare('SELECT id, entity, action, user_name, user_id FROM audit_log WHERE id > ? ORDER BY id').all(afterId) as AuditDbRow[]
    } finally {
      db.close()
    }
  }
  const maxId = (): number => {
    const db = companyDb()
    try {
      return (db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM audit_log').get() as { m: number }).m
    } finally {
      db.close()
    }
  }
  async function expectLogged(channel: string, payload?: unknown): Promise<AuditDbRow[]> {
    const before = maxId()
    const data = await ok(channel, payload)
    const rows = rowsAfter(before)
    const cov = coverage.AUDIT_COVERAGE[channel]!
    expect('audit' in cov, `${channel} is mapped as read-only`).toBe(true)
    const mapped = (cov as { audit: readonly string[] }).audit
    expect(rows.some((r) => mapped.includes(r.entity)), `${channel} wrote ${JSON.stringify(rows.map((r) => r.entity))}, mapped ${mapped.join('/')}`).toBe(true)
    return Object.assign(rows, { data })
  }

  it('company:create writes the company row (first row of the chain)', async () => {
    const created = await ok<{ slug: string }>('company:create', {
      name: 'Audit Coverage Co', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: 'Pune',
      booksFrom: 2025, email: null, phone: null, pan: null, tan: null
    })
    slug = created.slug
    const db = companyDb()
    try {
      const rows = db.prepare("SELECT entity, action FROM audit_log WHERE entity IN ('company', 'migration') ORDER BY id").all()
      expect(rows).toContainEqual({ entity: 'company', action: 'create' })
      expect(rows).toContainEqual({ entity: 'migration', action: 'update' })
    } finally {
      db.close()
    }
    await ok('company:open', { slug })
  })

  it('masters, vouchers, bin, settings, imports, backups and exports all log — as the OS user while the company has no users', async () => {
    const groups = await ok<{ id: number; name: string }[]>('master:groups:list')
    const gid = (n: string): number => groups.find((g) => g.name === n)!.id
    const g = await expectLogged('master:groups:create', { name: 'Coverage Expenses', parentId: gid('Indirect Expenses') })
    const groupId = (g as unknown as { data: { id: number } }).data.id
    await expectLogged('master:groups:update', { id: groupId, data: { name: 'Coverage Expenses 2', parentId: gid('Indirect Expenses') } })
    const led = await expectLogged('master:ledgers:create', { name: 'Coverage Rent', groupId })
    const rentId = (led as unknown as { data: { id: number } }).data.id
    await expectLogged('master:units:create', { name: 'Coverage cartons', symbol: 'ctn', decimals: 0, uqc: 'CTN' })

    const ledgers = await ok<{ id: number; name: string }[]>('master:ledgers:list')
    const cash = ledgers.find((l) => l.name === 'Cash')!.id
    const types = await ok<{ id: number; kind: string }[]>('master:voucherTypes:list')
    const payment = types.find((t) => t.kind === 'payment')!.id
    const voucher = {
      voucherTypeId: payment, date: '2025-05-10', partyLedgerId: null, narration: 'rent', reference: null, instrumentNo: null,
      instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: rentId, drCr: 'dr', amount: 500000, costAllocations: [] },
        { ledgerId: cash, drCr: 'cr', amount: 500000, costAllocations: [] }
      ],
      inventory: [], billRefs: [], tds: null
    }
    const saved = await expectLogged('voucher:save', { data: voucher })
    const vid = (saved as unknown as { data: { id: number } }).data.id
    await expectLogged('voucher:save', { id: vid, data: { ...voucher, lines: voucher.lines.map((l) => ({ ...l, amount: 600000 })) } })
    await expectLogged('voucher:delete', { id: vid })
    const restored = await expectLogged('voucher:restore', { id: vid })
    expect(restored.at(-1)!.action).toBe('restore')
    await expectLogged('voucher:delete', { id: vid })
    const purged = await expectLogged('voucher:purge', { id: vid })
    expect(purged.at(-1)!.action).toBe('purge')
    // The bin's permanent delete leaves the voucher's whole history in the trail.
    const history = (await ok<{ rows: { action: string }[] }>('audit:list', { voucherId: vid, page: 0 })).rows.map((r) => r.action)
    expect(history).toEqual(['purge', 'delete', 'restore', 'delete', 'update', 'create'])

    await expectLogged('company:lock:set', { date: '2025-04-01' })
    await expectLogged('config:features:set', await ok('config:features:get'))
    await expectLogged('import:apply', { kind: 'ledgers', csvText: 'Name,Group,Opening Balance\nImported Party,Sundry Debtors,0\n' })
    await expectLogged('backup:run')
    await expectLogged('audit:exportCsv', { from: '2025-01-01', to: '2030-12-31' })
    await expectLogged('config:audit:required', { required: false })
    await expectLogged('config:audit:required', { required: true })

    // No users yet: attributed to the OS login (not null, not 'system').
    const db = companyDb()
    try {
      const users = db.prepare("SELECT DISTINCT user_name AS u FROM audit_log WHERE entity IN ('group', 'ledger', 'voucher')").all() as { u: string }[]
      expect(users.map((u) => u.u)).toEqual([expect.stringMatching(/^os:.+/)])
      const backup = db.prepare("SELECT user_name AS u FROM audit_log WHERE entity = 'backup' AND action = 'backup' ORDER BY id").all() as { u: string }[]
      // open-time backup is 'system'; the manual one (backup:run) is the person.
      expect(backup[0]!.u).toBe('system')
      expect(backup.at(-1)!.u).toMatch(/^os:/)
    } finally {
      db.close()
    }
  })

  it('after the first user exists, rows carry that user (name + id); the chain verifies end to end', async () => {
    const owner = await ok<{ id: number; name: string }>('users:save', { data: { name: 'Priya', role: 'owner', pin: '4242' } })
    const groups = await ok<{ id: number; name: string }[]>('master:groups:list')
    const rows = await expectLogged('master:groups:create', { name: 'Signed-in group', parentId: groups.find((g) => g.name === 'Indirect Expenses')!.id })
    expect(rows.at(-1)).toMatchObject({ user_name: 'Priya', user_id: owner.id })

    const v = await ok<{ ok: boolean; rows: number; headId: number }>('audit:verify')
    expect(v.ok).toBe(true)
    expect(v.headId).toBe(maxId())

    // There is no channel that edits or deletes audit entries.
    expect([...ipc.CHANNEL_ROLES.keys()].filter((c) => /^audit:/.test(c)).sort()).toEqual(['audit:exportCsv', 'audit:exportPdf', 'audit:list', 'audit:verify'])
  })
})
