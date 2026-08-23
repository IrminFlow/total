import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { migrate } from '../db/migrate'
import { seedCompany } from '../db/seed'
import { TEST_INFO } from '../db/testdb'
import { openForMcp } from './companyDb'
import { buildServer } from './server'
import { setAgentBridgeEnabled } from '../services/config'
import { createLedger } from '../services/masters'
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js'

/**
 * The MCP surface, driven through the server's own request handlers.
 *
 * The point of these tests is the two write gates and the read-only guarantee — the parts that
 * decide whether handing an agent access to the books is safe.
 */

let scratch: string

/** A company on disk, registered the way the app registers one. */
function makeCompany(slug = 'mcp-co'): void {
  const dir = join(scratch, 'companies', slug)
  mkdirSync(dir, { recursive: true })
  const db = new Database(join(dir, 'company.db'))
  migrate(db)
  seedCompany(db, TEST_INFO)
  db.close()
  writeFileSync(
    join(scratch, 'total.json'),
    JSON.stringify({ version: 1, companies: [{ slug, name: TEST_INFO.name, createdAt: '2025-01-01' }], lastOpened: slug })
  )
}

/** Invoke a handler the way the transport would. The SDK wraps handlers, so results are async. */
async function call<T>(
  server: ReturnType<typeof buildServer>,
  schema: { method: string },
  params: unknown
): Promise<T> {
  const handler = (
    server as unknown as { _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<T>> }
  )._requestHandlers.get(schema.method)
  if (!handler) throw new Error(`no handler for ${schema.method}`)
  return handler({ method: schema.method, params }, { signal: new AbortController().signal })
}

const method = (schema: { shape: { method: { value: string } } }): { method: string } => ({
  method: schema.shape.method.value
})

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'total-mcp-'))
  process.env.TOTAL_DATA_DIR = scratch
  makeCompany()
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
  delete process.env.TOTAL_DATA_DIR
})

describe('MCP company open', () => {
  it('refuses a company that is not in the registry', () => {
    expect(() => openForMcp('ghost', false)).toThrow(/No company "ghost"/)
  })

  it('read-only mode is enforced by SQLite, not by convention', () => {
    const company = openForMcp('mcp-co', false)
    expect(company.writable).toBe(false)
    // The guarantee that matters: a bug in a tool still cannot write.
    expect(() => company.db.prepare("INSERT INTO meta (key, value) VALUES ('x', 'y')").run()).toThrow(/readonly/i)
    company.db.close()
  })

  it('refuses a database whose schema is older than this build', () => {
    const dbPath = join(scratch, 'companies', 'mcp-co', 'company.db')
    const db = new Database(dbPath)
    db.prepare('DELETE FROM migrations WHERE id = (SELECT MAX(id) FROM migrations)').run()
    db.close()
    // Silently answering from a stale schema would return wrong numbers, so it fails instead.
    expect(() => openForMcp('mcp-co', false)).toThrow(/schema is at version/)
  })
})

describe('MCP tools', () => {
  it('exposes the read tools, and no write tool without --allow-writes', async () => {
    const company = openForMcp('mcp-co', false)
    const server = buildServer(company)
    const { tools } = await call<{ tools: { name: string }[] }>(server, method(ListToolsRequestSchema), {})
    const names = tools.map((t) => t.name)
    expect(names).toContain('trial_balance')
    expect(names).toContain('outstandings')
    expect(names).not.toContain('post_voucher')
    company.db.close()
  })

  it('answers a read tool with the same envelope the assistant gets', async () => {
    const company = openForMcp('mcp-co', false)
    const server = buildServer(company)
    const res = await call<{ content: { text: string }[] }>(server, method(CallToolRequestSchema), {
      name: 'trial_balance',
      arguments: {}
    })
    const parsed = JSON.parse(res.content[0]!.text) as { ok: boolean; rows: unknown[]; totalRows: number }
    expect(parsed.ok).toBe(true)
    expect(Array.isArray(parsed.rows)).toBe(true)
    company.db.close()
  })

  it('advertises post_voucher with --allow-writes but still refuses until agent access is on', async () => {
    const company = openForMcp('mcp-co', true)
    const server = buildServer(company)

    const { tools } = await call<{ tools: { name: string }[] }>(server, method(ListToolsRequestSchema), {})
    expect(tools.map((t) => t.name)).toContain('post_voucher')

    // Second gate: the switch the owner can see and revoke in the app.
    const refused = await call<{ isError?: boolean; content: { text: string }[] }>(server, method(CallToolRequestSchema), {
      name: 'post_voucher',
      arguments: { date: '2025-04-01', voucherTypeId: 1, lines: [] }
    })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]!.text).toMatch(/Agent access/i)
    company.db.close()
  })

  it('posts through the same validation as the voucher screen once both gates are open', async () => {
    const company = openForMcp('mcp-co', true)
    setAgentBridgeEnabled(company.db, true)
    const server = buildServer(company)

    const cash = company.db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }
    // A bare seeded company has only Cash, so create the credit side. Any second ledger will do:
    // the point is a balanced pair, not which accounts they are.
    const group = company.db.prepare("SELECT id FROM groups WHERE name = 'Sales Accounts'").get() as { id: number }
    const other = createLedger(company.db, {
      name: 'Sales A/c',
      groupId: group.id,
      openingBalance: 0,
      gstin: null,
      stateCode: null,
      address: null,
      taxType: null,
      gstRate: null,
      hsn: null,
      tdsSectionId: null,
      pan: null,
      creditDays: null,
      creditLimit: null
    })
    const typeId = (company.db.prepare("SELECT id FROM voucher_types WHERE kind = 'receipt'").get() as { id: number }).id

    // Unbalanced input must be rejected by the shared schema, not by anything MCP-specific.
    await expect(
      call(server, method(CallToolRequestSchema), {
        name: 'post_voucher',
        arguments: {
          date: '2025-04-01',
          voucherTypeId: typeId,
          lines: [{ ledgerId: cash.id, drCr: 'dr', amount: 5000 }]
        }
      })
    ).rejects.toThrow()

    const res = await call<{ content: { text: string }[] }>(server, method(CallToolRequestSchema), {
      name: 'post_voucher',
      arguments: {
        date: '2025-04-01',
        voucherTypeId: typeId,
        lines: [
          { ledgerId: cash.id, drCr: 'dr', amount: 5000 },
          { ledgerId: other.id, drCr: 'cr', amount: 5000 }
        ]
      }
    })
    const posted = JSON.parse(res.content[0]!.text) as { ok: boolean; voucherId: number }
    expect(posted.ok).toBe(true)

    // Audited under its own pseudo-user, so the log says which surface the entry came through.
    const audit = company.db
      .prepare("SELECT user_name FROM audit_log WHERE entity = 'voucher' ORDER BY id DESC LIMIT 1")
      .get() as { user_name: string }
    expect(audit.user_name).toBe('agent-mcp')
    company.db.close()
  })
})

describe('MCP resources', () => {
  it('offers the company, its ledgers and the voucher contract without spending a tool call', async () => {
    const company = openForMcp('mcp-co', false)
    const server = buildServer(company)
    const { resources } = await call<{ resources: { uri: string }[] }>(server, method(ListResourcesRequestSchema), {})
    expect(resources.map((r) => r.uri)).toEqual([
      'total://company/mcp-co/meta',
      'total://company/mcp-co/ledgers',
      'total://voucher-schema'
    ])

    const meta = await call<{ contents: { text: string }[] }>(server, method(ReadResourceRequestSchema), {
      uri: 'total://company/mcp-co/meta'
    })
    const parsed = JSON.parse(meta.contents[0]!.text) as { name: string; units: string; writable: boolean }
    expect(parsed.name).toBe(TEST_INFO.name)
    expect(parsed.writable).toBe(false)
    // The units line is the thing an agent most needs and most often gets wrong.
    expect(parsed.units).toMatch(/integer paise/)
    company.db.close()
  })
})
