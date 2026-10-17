// WP 7.2 review — the security gates end to end through the IPC handlers (electron mocked; a
// scratch TOTAL_DATA_DIR), table-driven over EVERY registered channel:
//  - while the screen is locked (⌘L / idle) every gated channel is refused with session_locked;
//  - no capability flag = the role exactly, for every channel and every role;
//  - deleting a business locked with a passphrase asks for the passphrase AND keeps asking for the
//    owner's PIN (locking the books must not take the delete protection away);
//  - taking the lock off keeps the key file while a backup could not be decrypted;
//  - a plaintext copy an interrupted "take the lock off" left beside the books goes on the next open;
//  - a locked business's attachments are stored encrypted and a viewer opens one only by id — no
//    reply hands the renderer a stored path (the decrypted copy goes straight to the OS viewer).
import { TRUSTED_EVENT } from './ipcSender.testutil'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PROFIT_HIDDEN_MESSAGE } from '@shared/profitRedaction'

type Result = { ok: boolean; data?: unknown; error?: string; code?: string; field?: string }
const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<Result>>()
const io = vi.hoisted(() => ({ pick: [] as string[], opened: [] as string[] }))

vi.mock('electron', () => ({
  app: { getVersion: () => '0.12.0-test', getPath: () => tmpdir(), isPackaged: false, on: () => {} },
  ipcMain: { handle: (ch: string, fn: (e: unknown, p: unknown) => Promise<Result>) => handlers.set(ch.replace(/^total:/, ''), fn) },
  dialog: {
    showOpenDialog: async () => {
      const filePaths = io.pick
      io.pick = []
      return { canceled: filePaths.length === 0, filePaths }
    },
    showSaveDialog: async () => ({ canceled: true })
  },
  shell: {
    openPath: async (p: string) => {
      io.opened.push(p)
      return ''
    },
    showItemInFolder: () => {},
    openExternal: async () => {}
  },
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
  return h(TRUSTED_EVENT, payload)
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
      'company:createDemo', 'company:current', 'company:delete', 'company:forgetRemembered', 'company:list', 'company:open', 'company:remembered',
      'log:renderer', 'log:reveal', 'session:unlock'
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

describe('remember on this computer: only an owner keeps it', () => {
  const PASS = 'saffron ledger 404'
  const PIN = { owner: '5150', acct: '6160', viewer: '7170' }
  let slug: string
  let ids: { owner: number; acct: number; viewer: number }
  const remembered = async (): Promise<string[]> => ok<string[]>('company:remembered')

  it('ticked at the prompt of a business with people, it waits for the sign-in; a viewer / accountant sign-in drops it', async () => {
    slug = (await ok<{ slug: string }>('company:create', company('Remember People Co'))).slug
    await ok('company:open', { slug })
    const owner = await ok<{ id: number }>('users:save', { data: { name: 'Owner', role: 'owner', pin: PIN.owner } })
    const acct = await ok<{ id: number }>('users:save', { data: { name: 'Asha', role: 'accountant', pin: PIN.acct } })
    const viewer = await ok<{ id: number }>('users:save', { data: { name: 'Vik', role: 'viewer', pin: PIN.viewer } })
    ids = { owner: owner.id, acct: acct.id, viewer: viewer.id }
    await ok('security:passphrase:on', { passphrase: PASS, confirm: PASS })
    await ok('company:close')
    for (const [who, pin] of [['viewer', PIN.viewer], ['acct', PIN.acct]] as const) {
      expect((await ok<{ remember?: string }>('company:open', { slug, passphrase: PASS, remember: true })).remember).toBe('pending')
      // before anyone signs in, forgetting the open business is the owner's (Settings)
      expect((await call('company:forgetRemembered', { slug })).code).toBe('not_permitted')
      await ok('auth:login', { userId: ids[who], pin })
      expect(await remembered()).not.toContain(slug)
      expect(await ok<{ remembered: boolean; rememberPending: boolean }>('security:get')).toMatchObject({ remembered: false, rememberPending: false })
      expect((await call('security:remember:forget')).code).toBe('not_permitted')
      await ok('company:close')
      expect((await call('company:open', { slug })).code).toBe('passphrase_required')
    }
  })

  it('an owner sign-in keeps it (audited with the owner); viewer / accountant cannot forget it; a locked session is refused', async () => {
    await ok('company:open', { slug, passphrase: PASS, remember: true })
    await ok('auth:login', { userId: ids.owner, pin: PIN.owner })
    expect(await remembered()).toContain(slug)
    expect(await ok<{ remembered: boolean }>('security:get')).toMatchObject({ remembered: true })
    await ok('company:close')
    // the remembered key opens the file; the PIN is still asked
    expect(await ok<{ locked: boolean; openedWith?: string }>('company:open', { slug })).toMatchObject({ locked: true, openedWith: 'remembered' })
    for (const [id, pin] of [[ids.viewer, PIN.viewer], [ids.acct, PIN.acct]] as const) {
      await ok('auth:login', { userId: id, pin })
      expect((await call('security:remember:forget')).code).toBe('not_permitted')
      expect((await call('company:forgetRemembered', { slug })).code).toBe('not_permitted')
      await ok('auth:logout')
    }
    expect(await remembered()).toContain(slug)
    await ok('auth:login', { userId: ids.owner, pin: PIN.owner })
    await ok('session:lock')
    expect((await call('security:remember:forget')).code).toBe('session_locked')
    expect((await call('security:get')).code).toBe('session_locked')
    await ok('auth:login', { userId: ids.owner, pin: PIN.owner })
    expect((await ok<{ remembered: boolean }>('security:remember:forget')).remembered).toBe(false)
  })

  it('deleting a remembered business still asks for its passphrase', async () => {
    await ok('company:close')
    await ok('company:open', { slug, passphrase: PASS, remember: true })
    await ok('auth:login', { userId: ids.owner, pin: PIN.owner })
    await ok('company:close')
    expect(await remembered()).toContain(slug)
    expect((await call('company:delete', { slug, confirmName: 'Remember People Co', pin: PIN.owner })).code).toBe('passphrase_required')
    await ok('company:delete', { slug, confirmName: 'Remember People Co', pin: PIN.owner, passphrase: PASS })
    expect(await remembered()).not.toContain(slug)
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

describe('canSeeProfit: false covers every way to the profit (PR #112 follow-up)', () => {
  const PIN = { owner: '1111', acct: '2222' }
  let ids: { owner: number; acct: number }
  const login = (id: number, pin: string): Promise<unknown> => ok('auth:login', { userId: id, pin })
  const ledgerInput = (name: string, groupId: number): Record<string, unknown> => ({
    name, groupId, openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
  })
  let groupsByName: Map<string, number>

  it('sets up a business with a sale, an expense and an accountant who may not see profit', async () => {
    const { slug } = await ok<{ slug: string }>('company:create', company('Profit Gate Co'))
    await ok('company:open', { slug })
    const owner = await ok<{ id: number }>('users:save', { data: { name: 'Owner', role: 'owner', pin: PIN.owner } })
    const acct = await ok<{ id: number }>('users:save', { data: { name: 'Asha', role: 'accountant', pin: PIN.acct, capabilities: { canSeeProfit: false } } })
    ids = { owner: owner.id, acct: acct.id }
    const groups = await ok<{ id: number; name: string }[]>('master:groups:list')
    groupsByName = new Map(groups.map((g) => [g.name, g.id]))
    const sales = await ok<{ id: number }>('master:ledgers:create', ledgerInput('Counter Sales', groupsByName.get('Sales Accounts')!))
    const rent = await ok<{ id: number }>('master:ledgers:create', ledgerInput('Rent', groupsByName.get('Indirect Expenses')!))
    const cash = (await ok<{ id: number; name: string }[]>('master:ledgers:list')).find((l) => l.name === 'Cash')!
    const types = await ok<{ id: number; kind: string }[]>('master:voucherTypes:list')
    const post = (kind: string, date: string, dr: number, cr: number, amount: number): Promise<unknown> =>
      ok('voucher:save', {
        data: {
          voucherTypeId: types.find((t) => t.kind === kind)!.id, date, partyLedgerId: null, narration: null, reference: null, instrumentNo: null,
          instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
          lines: [{ ledgerId: dr, drCr: 'dr', amount, costAllocations: [] }, { ledgerId: cr, drCr: 'cr', amount, costAllocations: [] }],
          inventory: [], billRefs: [], tds: null
        }
      })
    await post('receipt', '2026-05-10', cash.id, sales.id, 50_000_00)
    await post('payment', '2026-05-11', rent.id, cash.id, 20_000_00)
    // Next year's entry, so the 2026-27 profit becomes the computed "Profit & Loss A/c (opening)".
    await post('receipt', '2027-04-10', cash.id, sales.id, 1_000_00)
  })

  it('trial balance: the owner sees the P&L side; the flagged user gets it redacted (no row, no totals)', async () => {
    await login(ids.owner, PIN.owner)
    const full = await ok<{ rows: { ledgerId: number; ledgerName: string }[]; totalDebit: number; profitHidden?: boolean }>('report:trialBalance', { asOn: '2027-04-30' })
    expect(full.profitHidden).toBeUndefined()
    expect(full.rows.some((r) => r.ledgerId === -5)).toBe(true)
    expect(full.rows.some((r) => r.ledgerName === 'Counter Sales')).toBe(true)
    expect(full.totalDebit).toBeGreaterThan(0)

    await login(ids.acct, PIN.acct)
    const tb = await ok<{ rows: { ledgerId: number; ledgerName: string }[]; totalDebit: number; totalCredit: number; profitHidden?: boolean }>('report:trialBalance', { asOn: '2027-04-30' })
    expect(tb.profitHidden).toBe(true)
    expect(tb.rows.some((r) => r.ledgerId === -5)).toBe(false)
    expect(tb.rows.some((r) => r.ledgerName === 'Counter Sales' || r.ledgerName === 'Rent')).toBe(false)
    expect(tb.rows.some((r) => r.ledgerName === 'Cash')).toBe(true)
    expect([tb.totalDebit, tb.totalCredit]).toEqual([0, 0])
  })

  it('dashboard:all (PR #131): each part is exactly its own channel for the owner and for the flagged user (redacted the same)', async () => {
    const args = { today: '2026-09-01', from: '2026-04-01', to: '2026-09-01' }
    type Section = { ok: boolean; data?: unknown; error?: string }
    const same = async (): Promise<{ series: Section; dashboard: Section }> => {
      const all = await ok<{ series: Section; dashboard: Section; msmeDue: Section | null; promised: Section | null }>('dashboard:all', args)
      expect(all.series).toEqual({ ok: true, data: await ok('report:dashboardSeries', args) })
      expect(all.dashboard).toEqual({ ok: true, data: await ok('report:dashboard', { today: args.today, fyFrom: args.from }) })
      expect(all.msmeDue).toEqual({ ok: true, data: await ok('payables:msmeDue', { asOn: args.today }) })
      expect(all.promised).toEqual({ ok: true, data: await ok('report:dashboardPromised', { today: args.today }) })
      return all
    }
    await login(ids.owner, PIN.owner)
    const owner = await same()
    expect((owner.series.data as { trade: { ok: boolean } }).trade.ok).toBe(true)

    await login(ids.acct, PIN.acct)
    const hidden = await same()
    expect((hidden.series.data as { trade: { ok: boolean; error?: string } }).trade).toEqual({ ok: false, error: PROFIT_HIDDEN_MESSAGE })
    expect((hidden.dashboard.data as { ratios: { grossMarginPct: number | null; netMarginPct: number | null } }).ratios).toMatchObject({ grossMarginPct: null, netMarginPct: null })
  })

  it('report builder: a profit measure or an income + expense model is refused; one side alone runs', async () => {
    const working = { from: '2026-04-01', to: '2027-03-31' }
    const run = (model: Record<string, unknown>): Promise<Result> => call('rb:run', { model, working, today: '2027-04-30' })
    expect((await run({ source: 'accounts', dimensions: [{ key: 'ledger' }], measures: ['profit'] })).code).toBe('not_permitted')
    expect((await run({ source: 'accounts', dimensions: [{ key: 'group', level: 1 }], measures: ['net'] })).code).toBe('not_permitted')
    expect((await run({ source: 'accounts', dimensions: [{ key: 'ledger' }], measures: ['net'], filters: { groupIds: [groupsByName.get('Indirect Expenses')!] } })).ok).toBe(true)
    expect((await run({ source: 'accounts', dimensions: [{ key: 'ledger' }], measures: ['net'], filters: { groupIds: [groupsByName.get('Indirect Expenses')!, groupsByName.get('Sales Accounts')!] } })).code).toBe('not_permitted')
    // the owner runs them all, unchanged
    await login(ids.owner, PIN.owner)
    expect((await run({ source: 'accounts', dimensions: [{ key: 'ledger' }], measures: ['profit'] })).ok).toBe(true)
  })

  it('report packs: profit reports are skipped with a note for the flagged user; the trial balance is redacted', async () => {
    const out = mkdtempSync(join(tmpdir(), 'total-pack-'))
    try {
      const saved = await ok<{ id: number }>('rb:save', { name: 'Profit by ledger', model: { source: 'accounts', dimensions: [{ key: 'ledger' }], measures: ['profit'] } })
      const pack = await ok<{ id: number }>('pack:save', {
        data: {
          name: 'Month end', periodRule: 'fyToDate', frequency: 'monthly', formats: ['csv'], outputDir: out,
          reports: [{ kind: 'builtin', key: 'trialBalance' }, { kind: 'builtin', key: 'profitLoss' }, { kind: 'builtin', key: 'receivables' }, { kind: 'saved', id: saved.id }]
        }
      })
      const ownerRun = await ok<{ status: string; files: string[] }>('pack:runNow', { id: pack.id })
      expect(ownerRun.status).toBe('ok')
      expect(ownerRun.files).toHaveLength(4)

      await login(ids.acct, PIN.acct)
      const r = await ok<{ status: string; files: string[]; error: string | null }>('pack:runNow', { id: pack.id })
      expect(r.status).toBe('partial')
      expect(r.files).toHaveLength(2)
      // the run's own file list (names follow the report titles, #150): the TB is the pack's first report
      expect(r.error).toMatch(/Profit & Loss: skipped — profit figures are not shown/)
      expect(r.error).toMatch(/Saved report #\d+: skipped/)
      const tbCsv = readFileSync(r.files.find((f) => /^01-/.test(f.split(/[\\/]/).pop()!))!, 'utf8')
      expect(tbCsv).not.toMatch(/Counter Sales|Rent/)
      expect(tbCsv).toMatch(/Profit figures are not shown/)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('AI tools refuse with a plain message (or redact the trial balance); owners unaffected', async () => {
    const { createToolRegistry } = await import('./ai/tools')
    const registry = createToolRegistry()
    const c = ipc.getCurrentCompany()!
    const ctx = (canSeeProfit: boolean, screen: Record<string, unknown> | null = null): Record<string, unknown> => ({
      db: c.db, company: c.info, role: 'accountant', userName: 'Asha', threadId: null, messageId: null, today: '2027-04-30',
      period: { from: '2026-04-01', to: '2027-03-31' }, screen, canSeeProfit
    })
    const runTool = (name: string, args: unknown, cx: Record<string, unknown>) => registry.run(name, JSON.stringify(args), cx as never)
    const refused = async (name: string, args: unknown, screen: Record<string, unknown> | null = null): Promise<void> => {
      const r = await runTool(name, args, ctx(false, screen))
      expect(r.ok, name).toBe(false)
      if (!r.ok) expect(r.error, name).toMatch(/Profit figures are not shown/)
      expect((await runTool(name, args, ctx(true, screen))).ok, `${name} allowed`).toBe(true)
    }
    await refused('profit_and_loss', { from: '2026-04-01', to: '2027-03-31' })
    await refused('balance_sheet', { asOn: '2027-03-31' })
    await refused('build_report', { title: 'Profit by ledger', source: 'accounts', dimensions: [{ key: 'ledger' }], measures: ['profit'] })
    await refused('current_screen_data', {}, { screen: 'profit-loss', label: 'Profit & Loss', from: '2026-04-01', to: '2027-03-31' })
    await refused('explain_figure', { groupName: 'Indirect Expenses' }, { screen: 'profit-loss', label: 'Profit & Loss', from: '2026-04-01', to: '2027-03-31' })
    const np = await runTool('explain_figure', { groupName: 'Net profit' }, ctx(false))
    expect(np.ok).toBe(false)
    if (!np.ok) expect(np.error).toMatch(/Profit figures are not shown/)
    const tb = await runTool('trial_balance', { asOn: '2027-04-30' }, ctx(false))
    expect(tb.ok).toBe(true)
    const text = JSON.stringify(tb.ok ? tb.data : null)
    expect(text).not.toMatch(/Counter Sales|Profit & Loss A\/c|totalDebit/)
    expect(text).toMatch(/Profit figures are not shown/)
    // a figure that is not the profit is still explained
    expect((await runTool('explain_figure', { groupName: 'Cash-in-Hand', asOn: '2027-03-31' }, ctx(false))).ok).toBe(true)
  })

  it('Ask Total: a profit question gets the redaction note; other questions answer as before', async () => {
    const hidden = await ok<{ sentences: string[]; figures: unknown[] }>('assist:ask', { text: 'profit this month', lang: 'en' })
    expect(hidden.sentences).toEqual(['Profit is not shown to your sign-in, so I can’t answer that. Ask the owner if you need it.'])
    expect(hidden.figures).toEqual([])
    const hinglish = await ok<{ sentences: string[] }>('assist:ask', { text: 'is mahine kitna munafa hua', lang: 'hinglish' })
    expect(hinglish.sentences[0]).toMatch(/Munafa aapke sign-in ko nahi/)
    const cash = await ok<{ sentences: string[] }>('assist:ask', { text: 'how much cash do I have', lang: 'en' })
    expect(cash.sentences.join(' ')).not.toMatch(/not shown/)
    await login(ids.owner, PIN.owner)
    const owner = await ok<{ sentences: string[] }>('assist:ask', { text: 'profit this month', lang: 'en' })
    expect(owner.sentences.join(' ')).not.toMatch(/not shown/)
  })

  it('the other doors to the profit are shut too: year-end preview, consolidation, the CA pack, the mirror; owners unchanged', async () => {
    await login(ids.acct, PIN.acct)
    const c = ipc.getCurrentCompany()!
    const fy = { from: '2026-04-01', to: '2027-03-31' }
    // the year-end close preview IS the net profit to transfer
    expect((await call('yearend:preview', { fyStartYear: 2026 })).code).toBe('not_permitted')
    // a consolidated P&L / trial balance over this business (every member includes the open one)
    expect((await call('consol:run', { slugs: [c.slug], kind: 'pnl', ...fy })).code).toBe('not_permitted')
    expect((await call('consol:run', { slugs: [c.slug], kind: 'tb', ...fy })).code).toBe('not_permitted')
    expect((await call('consolGroup:run', { groupId: 1, ...fy })).code).toBe('not_permitted')
    // the CA pack writes profit-and-loss.csv / balance-sheet.csv (canExport alone let it through)
    expect((await call('export:caPack', fy)).code).toBe('not_permitted')
    // the agent mirror's trial balance follows the flag like the screen's
    const mirror = await ok<{ dir: string; files: string[] }>('agent:exportMirror', { what: 'reports', format: 'json' })
    const tb = JSON.parse(readFileSync(join(mirror.dir, 'trial-balance.json'), 'utf8')) as { rows: { ledgerName: string }[]; profitHidden?: boolean }
    expect(tb.profitHidden).toBe(true)
    expect(tb.rows.some((r) => r.ledgerName === 'Counter Sales' || r.ledgerName === 'Rent')).toBe(false)

    await login(ids.owner, PIN.owner)
    expect((await ok<{ netProfit: number }>('yearend:preview', { fyStartYear: 2026 })).netProfit).toBe(30_000_00)
    expect((await call('consol:run', { slugs: [c.slug], kind: 'pnl', ...fy })).ok).toBe(true)
    expect((await call('export:caPack', fy)).ok).toBe(true)
    const full = await ok<{ dir: string }>('agent:exportMirror', { what: 'reports', format: 'json' })
    const fullTb = JSON.parse(readFileSync(join(full.dir, 'trial-balance.json'), 'utf8')) as { rows: { ledgerName: string }[]; profitHidden?: boolean }
    expect(fullTb.profitHidden).toBeUndefined()
    expect(fullTb.rows.some((r) => r.ledgerName === 'Counter Sales')).toBe(true)
  })

  it('canPost: false refuses manufacture:save too (it posts a stock journal through saveVoucher)', async () => {
    expect(ipc.channelCapabilityMap().get('manufacture:save')).toBe('canPost')
    await login(ids.owner, PIN.owner)
    const np = await ok<{ id: number }>('users:save', { data: { name: 'Nina', role: 'accountant', pin: '3333', capabilities: { canPost: false } } })
    await login(np.id, '3333')
    // the gate runs before the payload is read: not_permitted, never invalid_input
    expect((await call('manufacture:save', {})).code).toBe('not_permitted')
    expect((await call('voucher:save', {})).code).toBe('not_permitted')
    await login(ids.owner, PIN.owner)
  })
})

describe('canExport: false refuses every export channel (review follow-up)', () => {
  it('an accountant without canExport is refused each EXPORT_CHANNELS channel before its payload is read; the statements folder included', async () => {
    const { slug } = await ok<{ slug: string }>('company:create', company('Export Gate Co'))
    await ok('company:open', { slug })
    const owner = await ok<{ id: number }>('users:save', { data: { name: 'Owner', role: 'owner', pin: '1111' } })
    const acct = await ok<{ id: number }>('users:save', { data: { name: 'Esha', role: 'accountant', pin: '2222', capabilities: { canExport: false } } })
    await ok('auth:login', { userId: acct.id, pin: '2222' })
    // every channel the gate maps to canExport (ipc's own map, not a list kept here), each registered
    const exportChannels = [...ipc.channelCapabilityMap()].filter(([, cap]) => cap === 'canExport').map(([ch]) => ch)
    expect(exportChannels).toEqual(expect.arrayContaining(['receivables:statementsBulk', 'payroll:ecr', 'payroll:esi', 'bulkPay:export']))
    const leaked: string[] = []
    for (const ch of exportChannels) {
      expect(ipc.CHANNEL_ROLES.has(ch), ch).toBe(true)
      if ((await call(ch, undefined)).code !== 'not_permitted') leaked.push(ch)
    }
    expect(leaked).toEqual([])
    const fy = { from: '2026-04-01', to: '2027-03-31' }
    expect((await call('receivables:statementsBulk', fy)).code).toBe('not_permitted')
    // the role alone (no flag) still lets an accountant write them; the owner always
    await ok('auth:login', { userId: owner.id, pin: '1111' })
    expect((await call('receivables:statementsBulk', fy)).ok).toBe(true)
    await ok('users:save', { id: acct.id, data: { name: 'Esha', role: 'accountant', capabilities: { canExport: true } } })
    await ok('auth:login', { userId: acct.id, pin: '2222' })
    expect((await call('receivables:statementsBulk', fy)).ok).toBe(true)
    await ok('auth:login', { userId: owner.id, pin: '1111' })
  })
})

describe('every export-audited channel is gated by canExport unless it is a print (PR #144 review)', () => {
  it('AUDIT_COVERAGE entries auditing an export are in EXPORT_CHANNELS or NOT_EXPORTS (with a reason), never both', async () => {
    const { AUDIT_COVERAGE } = await import('./auditCoverage')
    const map = ipc.channelCapabilityMap()
    const missed: string[] = []
    for (const [ch, cov] of Object.entries(AUDIT_COVERAGE)) {
      if (!('audit' in cov) || !cov.audit.includes('export')) continue
      if (ch in caps.NOT_EXPORTS) {
        expect(caps.EXPORT_CHANNELS.includes(ch), ch).toBe(false)
        continue
      }
      if (map.get(ch) !== 'canExport' && map.get(ch) !== 'canPost') missed.push(ch)
    }
    expect(missed).toEqual([])
    // Source scan, whatever the channel's role (viewer channels are not in AUDIT_COVERAGE, so the loop
    // above can't see them): every handler under src/main that writes a file for the user, or audits
    // an export — directly, or through a helper defined in its own file — and every channel whose NAME
    // says file / print / export must be gated by canExport (or canPost), listed in NOT_EXPORTS, or
    // be one of the reads / inputs below. A new export that skips both the gate and the audit row
    // (the real risk — banking:brsPdf was one) fails here.
    const NOT_FILE_WRITES: Record<string, string> = {
      'capture:addFiles': 'input: bills queued for capture',
      'simple:taxes:filed': 'marks a return filed (meta), writes no file',
      'company:revealExports': 'opens the exports folder',
      'stock:labelsHtml': 'label HTML for the on-screen preview',
      'counter:printHtml': 'bill HTML for the on-screen print',
      'gst:recon2bPickFile': 'input: picks a GSTR-2B file',
      'bank:importCsv': 'input: a bank statement',
      'gstProfile:get': 'GST filing frequency',
      'gstProfile:set': 'GST filing frequency',
      'import:pickCsv': 'input: picks a CSV',
      'bankImport:pickFile': 'input: picks a statement',
      'bankImport:profile': 'a statement column mapping',
      'bankImport:saveProfile': 'a statement column mapping',
      'budget:importCsv': 'input: a budget CSV',
      'pricing:importCsv': 'input: a price list'
    }
    const { readdirSync, readFileSync, statSync } = await import('fs')
    const WRITES = /auditExport\(|writeAudit\([^;]*?'export'|writeExportPdf\(|writeFileSync\(|exportReturnJson\(|runPack\(|pickExportPath\(|chooseExportPath\(/
    const FILE_NAME = /pdf|csv|xlsx|xml|export|json|ecr|esi|print|label|download|file/i
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]))
    const unlisted: string[] = []
    const seen = new Set<string>()
    for (const f of walk(__dirname).filter((p) => p.endsWith('.ts') && !/test\.ts$/.test(p))) {
      const src = readFileSync(f, 'utf8')
      const hits = [...src.matchAll(/^([ \t]*)handle\(\s*'([^']+)'/gm)]
      if (!hits.length) continue
      // a handler's body: its first line up to the next line indented no deeper than `handle(`
      const bodyOf = (m: RegExpMatchArray): string => {
        const lines = src.slice(m.index).split('\n')
        const end = lines.findIndex((l, i) => i > 0 && l.trim() !== '' && l.length - l.trimStart().length <= (m[1] ?? '').length)
        return lines.slice(0, end < 0 ? undefined : end + 1).join('\n')
      }
      // file-local helpers that write a file / an export row (writeExport in ipcPayables.ts …)
      const defs = [...src.matchAll(/^[ \t]*(?:export\s+)?(?:const|(?:async\s+)?function)\s+(\w+)/gm)]
      const helpers = defs
        .filter((d, i) => WRITES.test(src.slice(d.index, Math.min(defs[i + 1]?.index ?? src.length, ...hits.map((h) => h.index ?? 0).filter((x) => x > (d.index ?? 0))))))
        .map((d) => d[1] ?? '')
      const helperRe = helpers.length ? new RegExp(`\\b(?:${helpers.join('|')})\\(`) : null
      for (const m of hits) {
        const ch = m[2] ?? ''
        seen.add(ch)
        const body = bodyOf(m)
        if (!WRITES.test(body) && !helperRe?.test(body) && !FILE_NAME.test(ch)) continue
        if (ch in caps.NOT_EXPORTS || ch in NOT_FILE_WRITES) continue
        if (map.get(ch) !== 'canExport' && map.get(ch) !== 'canPost') unlisted.push(`${ch} (${f.slice(__dirname.length + 1)})`)
      }
    }
    expect(unlisted).toEqual([])
    // the scan really reads the handlers (a regex that silently matches nothing would pass)
    expect(seen.size).toBeGreaterThan(500)
    for (const ch of ['banking:brsPdf', 'payroll:form16Pdf', 'tds:form16aPdf', 'payroll:ecr', 'pack:runNow']) expect(seen.has(ch), ch).toBe(true)
    for (const ch of Object.keys(NOT_FILE_WRITES)) expect(ipc.CHANNEL_ROLES.has(ch), ch).toBe(true)
    for (const ch of Object.keys(caps.NOT_EXPORTS)) expect(ipc.CHANNEL_ROLES.has(ch), ch).toBe(true)
  })
})

describe('the e-invoicing switch is owner-only (review follow-up)', () => {
  it('einvoicing:set refuses an accountant; the owner sets it (audited); gst:einvoicing returns the setting to a viewer', async () => {
    const { slug } = await ok<{ slug: string }>('company:create', { ...company('Einvoice Switch Co'), gstin: '27AAPFU0939F1ZV' })
    await ok('company:open', { slug })
    const owner = await ok<{ id: number }>('users:save', { data: { name: 'Owner', role: 'owner', pin: '1111' } })
    const acct = await ok<{ id: number }>('users:save', { data: { name: 'Asha', role: 'accountant', pin: '2222' } })
    const viewer = await ok<{ id: number }>('users:save', { data: { name: 'Vikram', role: 'viewer', pin: '3333' } })
    await ok('auth:login', { userId: acct.id, pin: '2222' })
    expect((await call('einvoicing:set', { enabled: true })).code).toBe('not_permitted')
    await ok('auth:login', { userId: owner.id, pin: '1111' })
    expect((await call('einvoicing:set', { enabled: true, extra: 1 })).ok).toBe(false) // strict
    expect(await ok('einvoicing:set', { enabled: true })).toEqual({ enabled: true })
    await ok('auth:login', { userId: viewer.id, pin: '3333' })
    expect(await ok('gst:einvoicing')).toEqual({ enabled: true })
    await ok('auth:login', { userId: owner.id, pin: '1111' })
  })
})

describe('the e-invoice business profile (to-do §4)', () => {
  it('gstProfile:set takes the turnover from the owner only (Zod-strict patch, audited); gst:einvoiceStatus answers a viewer', async () => {
    const { slug } = await ok<{ slug: string }>('company:create', { ...company('Einvoice Profile Co'), gstin: '27AAPFU0939F1ZV' })
    await ok('company:open', { slug })
    const owner = await ok<{ id: number }>('users:save', { data: { name: 'Owner', role: 'owner', pin: '1111' } })
    const acct = await ok<{ id: number }>('users:save', { data: { name: 'Asha', role: 'accountant', pin: '2222' } })
    const viewer = await ok<{ id: number }>('users:save', { data: { name: 'Vikram', role: 'viewer', pin: '3333' } })
    const turnover = { years: [{ fy: '2024-25', paise: 6_000_000_000 }], otherGstins: true }
    await ok('auth:login', { userId: acct.id, pin: '2222' })
    expect((await call('gstProfile:set', { turnover })).code).toBe('not_permitted')
    await ok('auth:login', { userId: owner.id, pin: '1111' })
    expect((await call('gstProfile:set', { turnover: { ...turnover, extra: 1 } })).ok).toBe(false) // strict
    expect((await call('gstProfile:set', { turnover: { years: [{ fy: '2024-25', paise: 1.5 }] } })).ok).toBe(false)
    expect(await ok('gstProfile:set', { turnover })).toEqual({ filing: 'monthly', turnover })
    expect(await ok('gstProfile:set', { filing: 'quarterly' })).toEqual({ filing: 'quarterly', turnover })
    await ok('auth:login', { userId: viewer.id, pin: '3333' })
    const status = await ok<{ enabled: boolean; turnOn: { since: string } | null }>('gst:einvoiceStatus')
    expect(status.enabled).toBe(false) // never switched on by the profile
    expect(status.turnOn?.since).toBe('2025-04-01')
    await ok('auth:login', { userId: owner.id, pin: '1111' })
  })
})

describe('consolidation member passphrases (PR #132) leave no trace', () => {
  const PASS = 'member passphrase zq7-unique'
  /** Every file under the data root that holds the passphrase bytes (logs, audit, WAL, JSON …). */
  const filesHolding = (needle: string): string[] => {
    const hits: string[] = []
    const bytes = Buffer.from(needle, 'utf8')
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (readFileSync(p).includes(bytes)) hits.push(p)
      }
    }
    walk(DATA_DIR)
    return hits
  }

  it('a run with memberPassphrases reads the locked member for the run only; wrong / right passphrases are nowhere on disk', async () => {
    const enc = await import('./db/encryption')
    const member = await ok<{ slug: string }>('company:create', company('Locked Member Co'))
    await ok('company:open', { slug: member.slug })
    await ok('security:passphrase:on', { passphrase: PASS, confirm: PASS })
    await ok('company:close')
    const parent = await ok<{ slug: string }>('company:create', company('Group Parent Co'))
    await ok('company:open', { slug: parent.slug })
    const group = await ok<{ id: number }>('consolGroup:save', {
      data: { name: 'Review Group', members: [{ companySlug: parent.slug, role: 'parent' }, { companySlug: member.slug, role: 'subsidiary' }] }
    })
    const fy = { from: '2026-04-01', to: '2027-03-31' }
    type Run = { pnl: { members: { slug: string; included: boolean }[] }; warnings: string[] }
    const included = (r: Run): boolean => r.pnl.members.find((m) => m.slug === member.slug)!.included

    // without a passphrase: skipped as before
    expect(included(await ok<Run>('consolGroup:run', { groupId: group.id, ...fy }))).toBe(false)
    // a wrong one refuses the run naming the member (never echoing the passphrase)
    const wrong = await call('consolGroup:run', { groupId: group.id, ...fy, memberPassphrases: { [member.slug]: `${PASS}-wrong` } })
    expect(wrong).toMatchObject({ ok: false, code: 'wrong_passphrase' })
    expect(wrong.error).toBe('That passphrase is not right — Locked Member Co')
    // an unknown field is refused by the strict payload, without echoing its value
    const strict = await call('consolGroup:run', { groupId: group.id, ...fy, passphrase: PASS })
    expect(strict.ok).toBe(false)
    expect(JSON.stringify(strict)).not.toContain(PASS)
    // the right one reads the member for this run, and the key is not remembered afterwards
    const right = await ok<Run>('consolGroup:run', { groupId: group.id, ...fy, memberPassphrases: { [member.slug]: PASS } })
    expect(included(right)).toBe(true)
    expect(enc.keyForPath(dbFile(member.slug))).toBeNull()
    expect(included(await ok<Run>('consolGroup:run', { groupId: group.id, ...fy }))).toBe(false)

    ipc.closeCurrentCompany() // flush the WAL into the file before reading the disk
    expect(filesHolding(PASS)).toEqual([])
  })
})

describe('attachments of a locked business', () => {
  it('a viewer opens one by id; no attachment reply carries a stored path or the decrypted copy’s location', async () => {
    const PASS = 'review files passphrase'
    const { slug } = await ok<{ slug: string }>('company:create', company('Files Review Co'))
    await ok('company:open', { slug })
    await ok('security:passphrase:on', { passphrase: PASS, confirm: PASS })
    await ok('users:save', { data: { name: 'Owner', role: 'owner', pin: '1212' } })
    const viewer = await ok<{ id: number }>('users:save', { data: { name: 'Vik', role: 'viewer', pin: '3434' } })
    const cash = (await ok<{ id: number; name: string }[]>('master:ledgers:list')).find((l) => l.name === 'Cash')!
    const src = mkdtempSync(join(tmpdir(), 'total-review-att-'))
    const bytes = Buffer.from('%PDF-1.4 the KYC copy')
    writeFileSync(join(src, 'kyc.pdf'), bytes)
    io.pick = [join(src, 'kyc.pdf')]
    const added = await ok<{ added: { id: number; sha256: string }[] }>('attachments:add', { entity: 'ledger', entityId: cash.id })
    const att = added.added[0]!
    const stored = readFileSync(join(dir(slug), 'attachments', att.sha256.slice(0, 2), att.sha256))
    expect(stored.subarray(0, 4).toString('latin1')).toBe('TLF1')
    expect(stored.includes(Buffer.from('KYC'))).toBe(false)

    await ok('auth:logout')
    await ok('auth:login', { userId: viewer.id, pin: '3434' })
    io.opened = []
    const opened = await call('attachments:open', { id: att.id })
    expect(opened).toMatchObject({ ok: true })
    expect(opened.data).toBeNull()
    expect(readFileSync(io.opened[0]!).equals(bytes)).toBe(true)
    const replies = [
      await call('attachments:list', { entity: 'ledger', entityId: cash.id }),
      await call('attachments:counts', { entity: 'ledger' }),
      await call('attachments:config'),
      opened
    ]
    for (const r of replies) {
      const text = JSON.stringify(r)
      expect(text).not.toContain(DATA_DIR)
      expect(text).not.toContain(io.opened[0]!)
      expect(text).not.toMatch(/attachments[\\/]+[0-9a-f]{2}[\\/]/)
    }
    // A viewer cannot add or remove one.
    expect((await call('attachments:add', { entity: 'ledger', entityId: cash.id })).ok).toBe(false)
    expect((await call('attachments:remove', { id: att.id })).ok).toBe(false)
    rmSync(src, { recursive: true, force: true })
  })
})
