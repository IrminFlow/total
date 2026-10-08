// WP 5.7 safety tests: the MCP server, driven in-process by the official SDK client over a linked
// in-memory transport (the same Server object `total-cli mcp` connects to stdio).
//   - tools: only read + draft tools are listed, each with a JSON-Schema object input; viewer
//     sees no draft tool and is refused one by name; nothing any tool does writes the books;
//   - drafts: as accountant, draft_voucher makes an ai_drafts row (source 'mcp', origin = client)
//     and an audit row by `mcp:<client>`; the books are unchanged;
//   - privacy: GSTINs masked by default in tool results and resources (amounts untouched), real
//     with masking off, party names aliased with pseudonymisation and mapped back in arguments;
//   - kill switch: refuses requests of a running session and the start of a new one;
//   - identity: roles above viewer need a verified user when the company has users;
//   - resources: company, chart of accounts and mirrors, computed from the DB at read time;
//   - every request lands in mcp_log (sizes + hash, never content).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { DB } from '../db/connection'
import { seededDb, postSimpleVoucher } from '../db/testdb'
import { setAuditContext } from '../services/audit'
import { getMcpConfig, setMcpConfig } from '../services/config'
import { saveUser, deactivateUser } from '../services/users'
import { aiDataCounts, deleteAllAiData, setDefaultDraftOrigin } from '../ai/store'
import { createToolRegistry } from '../ai/tools'
import { MCP_DISABLED_MESSAGE } from '@shared/mcp'
import { createMcpServer, installMcpProcessContext, type McpServerHandle } from './server'
import { resolveMcpIdentity, type McpIdentity } from './session'
import { runMcpStdio } from './stdio'
import { listMcpLog, logMcp, pruneMcpLog } from './log'
import { MCP_RESOURCE_BUDGET } from './resources'

const GSTIN = '27AAPFU0939F1ZV'
const TODAY = '2025-09-30'

let db: DB
let open: { client: Client; handle: McpServerHandle }[] = []

function ledgerId(name: string): number {
  return (db.prepare('SELECT id FROM ledgers WHERE name = ?').get(name) as { id: number }).id
}

/** A digest of everything that makes up the books — must not move across MCP calls. */
function booksDigest(): string {
  const h = createHash('sha256')
  for (const t of ['vouchers', 'voucher_lines', 'inventory_lines', 'bill_refs', 'ledgers', 'groups', 'stock_items', 'voucher_types']) {
    h.update(JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()))
  }
  return h.digest('hex')
}

async function connect(
  identity: Partial<McpIdentity> = {},
  privacy = { maskIds: true, pseudonymiseParties: false },
  clientName = 'Test Client'
): Promise<{ client: Client; handle: McpServerHandle }> {
  const handle = createMcpServer({
    db,
    slug: 'mcp-co',
    identity: { role: 'viewer', userName: null, userId: null, ...identity },
    privacy,
    version: 'test',
    today: () => TODAY
  })
  installMcpProcessContext(handle, 'test')
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  await handle.server.connect(serverT)
  const client = new Client({ name: clientName, version: '1.0.0' })
  await client.connect(clientT)
  const c = { client, handle }
  open.push(c)
  return c
}

type TextContent = { type: 'text'; text: string }
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string; json: unknown }> {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: TextContent[] }
  const text = r.content.map((c) => c.text).join('')
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    /* trimmed */
  }
  return { isError: !!r.isError, text, json }
}

beforeEach(() => {
  db = seededDb()
  const debtors = (db.prepare("SELECT id FROM groups WHERE name = 'Sundry Debtors'").get() as { id: number }).id
  db.prepare('INSERT INTO ledgers (name, group_id, opening_balance, gstin, state_code, hsn) VALUES (?, ?, ?, ?, ?, ?)').run('Acme Traders', debtors, 1234567890, GSTIN, '27', '99831100')
  const v = postSimpleVoucher(db, { date: '2025-05-01', amount: 500000, kind: 'receipt' })
  db.prepare("UPDATE vouchers SET number = '2025-26/00012345', reference = 'INV-20250415' WHERE id = ?").run(v.id)
  setMcpConfig(db, { enabled: true }) // MCP is off by default — every test here turns it on
})

afterEach(async () => {
  for (const c of open) await c.client.close()
  open = []
  setAuditContext({ appVersion: '', getUserName: () => null })
  setDefaultDraftOrigin({ source: 'chat', origin: () => null })
  db.close()
})

describe('MCP tools — the registry under the read/draft rule', () => {
  it('lists read tools only for a viewer, read + draft for an accountant, each with a JSON Schema object input', async () => {
    const registry = createToolRegistry()
    // The registry itself holds nothing but read and draft tools.
    for (const t of registry.available('owner')) expect(['read', 'draft'], t.name).toContain(t.kind)

    const { client: viewer } = await connect()
    const vt = (await viewer.listTools()).tools
    expect(vt.length).toBeGreaterThan(5)
    for (const t of vt) {
      expect(registry.get(t.name)?.kind, t.name).toBe('read')
      expect(t.inputSchema.type).toBe('object')
      expect(t.annotations?.readOnlyHint, t.name).toBe(true)
    }
    expect(vt.map((t) => t.name)).not.toContain('draft_voucher')

    const { client: acct } = await connect({ role: 'accountant' })
    const at = (await acct.listTools()).tools
    const draft = at.find((t) => t.name === 'draft_voucher')!
    expect(draft).toBeDefined()
    expect(draft.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false })
    expect(draft.description).toContain('never posts')
    expect((draft.inputSchema.properties as Record<string, unknown>).lines).toBeDefined()
    // Every registry tool the role allows is exposed — tools added later appear automatically.
    expect(at.map((t) => t.name).sort()).toEqual(registry.available('accountant').map((t) => t.name).sort())
  })

  it('a viewer reads (trial balance, ledgers) and is refused a draft tool; nothing is written to the books', async () => {
    const before = booksDigest()
    const { client } = await connect()
    const tb = await call(client, 'trial_balance', { asOn: TODAY })
    expect(tb.isError).toBe(false)
    expect(tb.text).toContain('₹5,000.00')
    const led = await call(client, 'list_ledgers', { search: 'Acme' })
    expect(led.isError).toBe(false)
    expect(led.text).toContain('Acme Traders')

    const refused = await call(client, 'draft_voucher', {
      kind: 'receipt',
      lines: [
        { ledgerId: ledgerId('Cash'), drCr: 'dr', amount: '100' },
        { ledgerId: ledgerId('Acme Traders'), drCr: 'cr', amount: '100' }
      ]
    })
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/viewer.*may not use draft_voucher.*accountant/)
    expect((db.prepare('SELECT COUNT(*) AS n FROM ai_drafts').get() as { n: number }).n).toBe(0)

    const unknown = await call(client, 'post_voucher', {})
    expect(unknown.isError).toBe(true)

    // Every exposed tool, called with no arguments: errors are fine, writes to the books are not.
    for (const t of (await client.listTools()).tools) await call(client, t.name, {})
    expect(booksDigest()).toBe(before)
  })

  it('an accountant drafts: an ai_drafts row (source mcp, origin = client) and an audit row by mcp:<client>; books unchanged', async () => {
    const before = booksDigest()
    const { client } = await connect({ role: 'accountant' }, undefined, 'Claude Desktop')
    const r = await call(client, 'draft_voucher', {
      kind: 'receipt',
      date: '2025-09-15',
      narration: 'Acme paid on account',
      lines: [
        { ledgerId: ledgerId('Cash'), drCr: 'dr', amount: '2,500' },
        { ledgerId: ledgerId('Acme Traders'), drCr: 'cr', amount: '2,500' }
      ]
    })
    expect(r.isError).toBe(false)
    const out = r.json as { ok: true; result: { draftId: number; status: string } }
    expect(out.result.status).toBe('open')
    const d = db.prepare('SELECT * FROM ai_drafts WHERE id = ?').get(out.result.draftId) as Record<string, unknown>
    expect(d).toMatchObject({ status: 'open', source: 'mcp', origin: 'Claude Desktop', unrequested: 0, thread_id: null, voucher_id: null })
    expect(JSON.parse(d.payload_json as string).lines[0]).toEqual({ ledgerId: ledgerId('Cash'), drCr: 'dr', amount: 250000 })
    const audit = db.prepare("SELECT user_name, action FROM audit_log WHERE entity = 'ai_draft' AND entity_id = ?").all(out.result.draftId)
    expect(audit).toEqual([{ user_name: 'mcp:claude-desktop', action: 'create' }])
    expect(booksDigest()).toBe(before)
    const logged = listMcpLog(db).find((l) => l.method === 'tools/call' && l.target === 'draft_voucher')!
    expect(logged).toMatchObject({ ok: true, draftId: out.result.draftId, role: 'accountant', clientName: 'Claude Desktop' })
  })

  it('a draft that would not post is refused with the reason, and no draft is stored', async () => {
    const { client } = await connect({ role: 'accountant' })
    const r = await call(client, 'draft_voucher', {
      kind: 'journal',
      lines: [
        { ledgerId: ledgerId('Cash'), drCr: 'dr', amount: '100' },
        { ledgerId: ledgerId('Acme Traders'), drCr: 'cr', amount: '90' }
      ]
    })
    expect(r.isError).toBe(true)
    expect((db.prepare('SELECT COUNT(*) AS n FROM ai_drafts').get() as { n: number }).n).toBe(0)
  })
})

describe('MCP privacy — masking default on, pseudonyms optional', () => {
  it('masks GSTINs in tool results and resources by default; amounts stay intact', async () => {
    const { client } = await connect()
    const led = await call(client, 'list_ledgers', { search: 'Acme' })
    expect(led.text).not.toContain(GSTIN)
    expect(led.text).toContain('[GSTIN …1ZV]')
    const csv = await client.readResource({ uri: 'total://mirror/ledgers.csv' })
    const text = (csv.contents[0] as { text: string }).text
    expect(text).not.toContain(GSTIN)
    expect(text).toContain('1234567890') // integer paise are never "masked" as account numbers
    const json = await client.readResource({ uri: 'total://mirror/ledgers.json' })
    expect((json.contents[0] as { text: string }).text).not.toContain(GSTIN)
    const company = await client.readResource({ uri: 'total://company' })
    expect((company.contents[0] as { text: string }).text).not.toMatch(/\b\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/)
    expect(listMcpLog(db).every((l) => l.masked)).toBe(true)
  })

  it('masks by field: HSN, voucher number, FY-prefixed number and invoice reference come back intact', async () => {
    const { client } = await connect()
    const read = async (uri: string): Promise<string> => ((await client.readResource({ uri })).contents[0] as { text: string }).text
    const csv = await read('total://mirror/ledgers.csv')
    expect(csv).toContain('99831100')
    expect(csv).not.toContain('[A/c')
    const ledgersJson = await read('total://mirror/ledgers.json')
    expect(ledgersJson).toContain('"hsn": "99831100"')
    const vouchers = await read('total://mirror/vouchers-2025-26.json')
    expect(vouchers).toContain('"number": "2025-26/00012345"')
    expect(vouchers).toContain('"reference": "INV-20250415"')
    expect(vouchers).not.toContain('[A/c')
    const day = await call(client, 'day_book', { from: '2025-04-01', to: '2026-03-31' })
    expect(day.text).toContain('2025-26/00012345')
    expect(day.text).not.toContain('[A/c')
  })

  it('pseudonymises party names in resources too (and never the codes beside them)', async () => {
    const { client } = await connect({}, { maskIds: true, pseudonymiseParties: true })
    const csv = ((await client.readResource({ uri: 'total://mirror/ledgers.csv' })).contents[0] as { text: string }).text
    expect(csv).not.toContain('Acme Traders')
    expect(csv).toMatch(/Party-\d{4}/)
    expect(csv).toContain('99831100')
    const chart = ((await client.readResource({ uri: 'total://chart-of-accounts' })).contents[0] as { text: string }).text
    expect(chart).not.toContain('Acme Traders')
    expect(chart).toContain('Sundry Debtors')
  })

  it('returns real identifiers with masking off (--no-mask)', async () => {
    const { client } = await connect({}, { maskIds: false, pseudonymiseParties: false })
    expect((await call(client, 'list_ledgers', { search: 'Acme' })).text).toContain(GSTIN)
  })

  it('pseudonymises party names out and maps aliases back in arguments', async () => {
    const { client } = await connect({}, { maskIds: true, pseudonymiseParties: true })
    const led = await call(client, 'list_ledgers', { group: 'Sundry Debtors' })
    expect(led.text).not.toContain('Acme Traders')
    const alias = /Party-\d{4}/.exec(led.text)?.[0]
    expect(alias).toBeDefined()
    // The client searches by the alias it saw; the server maps it back to the real name.
    const found = await call(client, 'list_ledgers', { search: alias })
    expect(found.text).toContain(alias!)
    expect((found.json as { result: { count: number } }).result.count).toBe(1)
  })
})

describe('MCP kill switch and identity', () => {
  it('refuses every request of a running session once MCP is turned off, and refuses to start', async () => {
    const { client } = await connect()
    expect((await client.listTools()).tools.length).toBeGreaterThan(0)
    setMcpConfig(db, { enabled: false })
    await expect(client.listTools()).rejects.toThrow(/MCP access is off/)
    await expect(client.callTool({ name: 'trial_balance', arguments: {} })).rejects.toThrow(/is off/)
    await expect(client.readResource({ uri: 'total://company' })).rejects.toThrow(/is off/)
    const refused = listMcpLog(db).filter((l) => !l.ok && l.error === MCP_DISABLED_MESSAGE)
    expect(refused.length).toBe(3)
    await expect(
      runMcpStdio({ db, slug: 'mcp-co', role: 'viewer', user: null, pin: null, maskIds: true, pseudonymiseParties: false, version: 'test' })
    ).rejects.toThrow(MCP_DISABLED_MESSAGE)
    setMcpConfig(db, { enabled: true })
    expect((await client.listTools()).tools.length).toBeGreaterThan(0)
  })

  it('without users: viewer by default, accountant by explicit flag; with users: a verified PIN for anything above viewer', () => {
    expect(resolveMcpIdentity(db, { role: 'viewer', user: null, pin: null })).toEqual({ role: 'viewer', userName: null, userId: null })
    expect(resolveMcpIdentity(db, { role: 'accountant', user: null, pin: null }).role).toBe('accountant')

    saveUser(db, { name: 'Owner', role: 'owner', pin: '9999' }) // the first user is always the owner
    const asha = saveUser(db, { name: 'Asha', role: 'accountant', pin: '4321' })
    saveUser(db, { name: 'Vik', role: 'viewer', pin: '1111' })
    expect(resolveMcpIdentity(db, { role: 'viewer', user: null, pin: null }).role).toBe('viewer')
    expect(() => resolveMcpIdentity(db, { role: 'accountant', user: null, pin: null })).toThrow(/needs --user/)
    expect(() => resolveMcpIdentity(db, { role: 'accountant', user: 'Asha', pin: null })).toThrow(/TOTAL_MCP_PIN/)
    expect(() => resolveMcpIdentity(db, { role: 'accountant', user: 'Asha', pin: '0000' })).toThrow(/Wrong PIN/)
    expect(db.prepare("SELECT action FROM audit_log WHERE entity = 'user' AND entity_id = ? ORDER BY id DESC LIMIT 1").get(asha.id)).toEqual({ action: 'login_failed' })
    expect(() => resolveMcpIdentity(db, { role: 'accountant', user: 'Vik', pin: '1111' })).toThrow(/Vik is viewer/)
    expect(() => resolveMcpIdentity(db, { role: 'owner', user: 'asha', pin: '4321' })).toThrow(/Asha is accountant/)
    expect(resolveMcpIdentity(db, { role: 'accountant', user: 'asha', pin: '4321' })).toMatchObject({ role: 'accountant', userName: 'Asha', userId: asha.id })
  })

  it('is off by default for a company (the owner turns it on), and the server refuses to start', async () => {
    const fresh = seededDb()
    try {
      expect(getMcpConfig(fresh).enabled).toBe(false)
      await expect(
        runMcpStdio({ db: fresh, slug: 'x', role: 'viewer', user: null, pin: null, maskIds: true, pseudonymiseParties: false, version: 'test' })
      ).rejects.toThrow(MCP_DISABLED_MESSAGE)
    } finally {
      fresh.close()
    }
  })

  it('a PIN-verified draft stamps the user id on its audit row (name stays mcp:<client>)', async () => {
    saveUser(db, { name: 'Owner', role: 'owner', pin: '9999' })
    const asha = saveUser(db, { name: 'Asha', role: 'accountant', pin: '4321' })
    const { client } = await connect(resolveMcpIdentity(db, { role: 'accountant', user: 'Asha', pin: '4321' }))
    const r = await call(client, 'draft_voucher', {
      kind: 'receipt',
      lines: [
        { ledgerId: ledgerId('Cash'), drCr: 'dr', amount: '100' },
        { ledgerId: ledgerId('Acme Traders'), drCr: 'cr', amount: '100' }
      ]
    })
    expect(r.isError).toBe(false)
    const id = (r.json as { result: { draftId: number } }).result.draftId
    expect(db.prepare("SELECT user_name, user_id FROM audit_log WHERE entity = 'ai_draft' AND entity_id = ?").get(id)).toEqual({
      user_name: 'mcp:test-client',
      user_id: asha.id
    })
  })

  it('a PIN change ends a running session', async () => {
    saveUser(db, { name: 'Owner', role: 'owner', pin: '9999' })
    const asha = saveUser(db, { name: 'Asha', role: 'accountant', pin: '4321' })
    const { client } = await connect(resolveMcpIdentity(db, { role: 'accountant', user: 'Asha', pin: '4321' }))
    expect((await client.listTools()).tools.length).toBeGreaterThan(0)
    saveUser(db, { name: 'Asha', role: 'accountant', pin: '5555' }, asha.id)
    await expect(client.listTools()).rejects.toThrow(/PIN has changed/)
  })

  it('a running session stops when its user is deactivated', async () => {
    saveUser(db, { name: 'Owner', role: 'owner', pin: '9999' })
    const asha = saveUser(db, { name: 'Asha', role: 'accountant', pin: '4321' })
    const id = resolveMcpIdentity(db, { role: 'accountant', user: 'Asha', pin: '4321' })
    const { client } = await connect(id)
    expect((await client.listTools()).tools.some((t) => t.name === 'draft_voucher')).toBe(true)
    deactivateUser(db, asha.id)
    await expect(client.listTools()).rejects.toThrow(/no longer an active user/)
  })
})

describe('MCP resources — computed from the books at read time', () => {
  it('lists company, chart of accounts and the mirrors (one vouchers file per FY) and reads them', async () => {
    const { client } = await connect({}, { maskIds: false, pseudonymiseParties: false })
    const uris = (await client.listResources()).resources.map((r) => r.uri)
    expect(uris).toEqual(
      expect.arrayContaining([
        'total://company', 'total://chart-of-accounts', 'total://mirror/ledgers.csv', 'total://mirror/ledgers.json', 'total://mirror/items.csv',
        'total://mirror/trial-balance.json', 'total://mirror/outstandings.json', 'total://mirror/meta.json', 'total://mirror/vouchers-2025-26.json'
      ])
    )
    const chart = JSON.parse(((await client.readResource({ uri: 'total://chart-of-accounts' })).contents[0] as { text: string }).text) as {
      groups: { name: string; ledgers: { name: string }[]; groups: unknown[] }[]
    }
    const flat = JSON.stringify(chart)
    expect(flat).toContain('Sundry Debtors')
    expect(flat).toContain('Acme Traders')

    const vouchers = JSON.parse(((await client.readResource({ uri: 'total://mirror/vouchers-2025-26.json' })).contents[0] as { text: string }).text) as {
      lines: { amount: number }[]
    }[]
    expect(vouchers).toHaveLength(1)
    // Served from the DB at read time: a voucher posted now shows up on the next read.
    postSimpleVoucher(db, { date: '2025-06-01', amount: 700, kind: 'receipt' })
    const again = JSON.parse(((await client.readResource({ uri: 'total://mirror/vouchers-2025-26.json' })).contents[0] as { text: string }).text) as unknown[]
    expect(again).toHaveLength(2)
    const tb = JSON.parse(((await client.readResource({ uri: 'total://mirror/trial-balance.json' })).contents[0] as { text: string }).text) as {
      asOn: string
    }
    expect(tb.asOn).toBe(TODAY)
    await expect(client.readResource({ uri: 'total://mirror/secrets.json' })).rejects.toThrow(/Unknown resource/)
  })

  it('logs every request with its size and hash, never the content', async () => {
    const { client } = await connect()
    await client.listTools()
    await call(client, 'list_ledgers', { search: 'Acme' })
    await client.readResource({ uri: 'total://company' })
    const rows = listMcpLog(db)
    expect(rows.map((r) => r.method)).toEqual(expect.arrayContaining(['initialize', 'tools/list', 'tools/call', 'resources/read']))
    for (const r of rows.filter((x) => x.method !== 'initialize')) {
      expect(r.responseBytes).toBeGreaterThan(0)
      expect(r.responseSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(r.clientName).toBe('Test Client')
    }
    const cols = (db.prepare('PRAGMA table_info(mcp_log)').all() as { name: string }[]).map((c) => c.name)
    expect(cols.some((c) => /content|payload|text|body/.test(c))).toBe(false)
  })
})

describe('MCP log hygiene, budgets and Delete all AI data', () => {
  it('a failing log write never turns a served call into an error', async () => {
    const { client } = await connect()
    db.exec('DROP TABLE mcp_log')
    const r = await call(client, 'list_ledgers', { search: 'Acme' })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('Acme Traders')
  })

  it('masks error text returned and logged', async () => {
    const { client } = await connect()
    const r = await call(client, 'ledger_statement', { ledgerId: 999999, from: '2025-04-01', to: '2026-03-31' })
    expect(r.isError).toBe(true)
    await expect(client.readResource({ uri: `total://mirror/${GSTIN}.json` })).rejects.toThrow(/\[GSTIN …1ZV\]/)
    const logged = listMcpLog(db).find((l) => l.method === 'resources/read')!
    expect(logged.error).not.toContain(GSTIN)
    expect(logged.error).toContain('[GSTIN …1ZV]')
  })

  it('caps a large resource with a note pointing at the dated tools', async () => {
    const vt = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }).id
    const ins = db.prepare("INSERT INTO vouchers (voucher_type_id, date, number, narration) VALUES (?, '2025-06-01', ?, ?)")
    const line = db.prepare('INSERT INTO voucher_lines (voucher_id, ledger_id, dr_cr, amount) VALUES (?, ?, ?, 100)')
    db.transaction(() => {
      for (let i = 0; i < 700; i++) {
        const id = Number(ins.run(vt, `J-${i}`, 'x'.repeat(150)).lastInsertRowid)
        line.run(id, ledgerId('Cash'), 'dr')
        line.run(id, ledgerId('Acme Traders'), 'cr')
      }
    })()
    const { client } = await connect()
    const text = ((await client.readResource({ uri: 'total://mirror/vouchers-2025-26.json' })).contents[0] as { text: string }).text
    expect(text.length).toBeLessThanOrEqual(MCP_RESOURCE_BUDGET)
    const body = JSON.parse(text) as { truncated: boolean; note: string; data: unknown[] }
    expect(body.truncated).toBe(true)
    expect(body.note).toMatch(/day_book/)
  })

  it('prunes mcp_log rows past the retention window', () => {
    const base = { sessionId: 's', clientName: 'c', clientVersion: null, role: 'viewer' as const, userName: null, method: 'tools/list', ok: true, masked: true, pseudonymised: false }
    logMcp(db, base)
    const old = logMcp(db, base)
    db.prepare("UPDATE mcp_log SET at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(old)
    expect(pruneMcpLog(db, 90)).toBe(1)
    expect(listMcpLog(db)).toHaveLength(1)
  })

  it('Delete all AI data counts agent drafts and the MCP log in its audited before-image, and keeps the log', async () => {
    const { client } = await connect({ role: 'accountant' })
    await call(client, 'draft_voucher', {
      kind: 'receipt',
      lines: [
        { ledgerId: ledgerId('Cash'), drCr: 'dr', amount: '100' },
        { ledgerId: ledgerId('Acme Traders'), drCr: 'cr', amount: '100' }
      ]
    })
    const logRows = listMcpLog(db).length
    const before = aiDataCounts(db)
    expect(before).toMatchObject({ agentDrafts: 1, mcpLog: logRows })
    expect(deleteAllAiData(db, true)).toEqual(before)
    expect(aiDataCounts(db)).toMatchObject({ drafts: 0, agentDrafts: 0, mcpLog: logRows })
  })
})
