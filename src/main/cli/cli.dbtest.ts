// End-to-end CLI round trip against a real on-disk data root (TOTAL_DATA_DIR temp dir):
// create company -> import masters -> post balanced voucher -> export mirror -> read it back ->
// trial balance ties. Runs under Electron-as-Node (npm run test:db) like every *.dbtest.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setAuditContext } from '../services/audit'
import { setLockDate } from '../services/vouchers'
import type { DB } from '../db/connection'
import {
  cmdCompanies, cmdCreateCompany, cmdExport, cmdImportMasters, cmdNextNumber, cmdPost,
  cmdTrialBalance, openCompany
} from './commands'

let dataDir: string
let prevDataDir: string | undefined
let db: DB
let slug: string

beforeAll(() => {
  prevDataDir = process.env.TOTAL_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), 'total-cli-test-'))
  process.env.TOTAL_DATA_DIR = dataDir
  // Exactly what src/main/cli/main.ts installs: every CLI write audits as 'agent-cli'.
  setAuditContext({ appVersion: 'test-cli', getUserName: () => 'agent-cli' })
})

afterAll(() => {
  db?.close()
  if (prevDataDir === undefined) delete process.env.TOTAL_DATA_DIR
  else process.env.TOTAL_DATA_DIR = prevDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

function ledgerId(name: string): number {
  const row = db.prepare('SELECT id FROM ledgers WHERE name = ?').get(name) as { id: number } | undefined
  if (!row) throw new Error(`ledger ${name} missing`)
  return row.id
}

describe('total-cli command layer', () => {
  it('creates + registers a company and lists it', () => {
    const created = cmdCreateCompany({ name: 'Agent Co', stateCode: '27', booksFrom: 2025 })
    slug = created.slug
    expect(slug).toBe('agent-co')
    expect(existsSync(join(dataDir, 'companies', slug, 'company.db'))).toBe(true)
    const registry = cmdCompanies()
    expect(registry.companies.map((c) => c.slug)).toContain(slug)
    db = openCompany(slug)
  })

  it('imports masters CSV through the same importer service', () => {
    const csv = ['Name,Group,Opening Balance', 'Agent Sales,Sales Accounts,0'].join('\n')
    const result = cmdImportMasters(db, 'ledgers', csv)
    expect(result.errors).toEqual([])
    expect(result.created).toBe(1)
    expect(ledgerId('Agent Sales')).toBeGreaterThan(0)
  })

  it('computes the next voucher number by type name or id', () => {
    const byName = cmdNextNumber(db, 'Receipt', '2025-07-15')
    const byId = cmdNextNumber(db, String(byName.voucherTypeId), '2025-07-15')
    expect(byName).toEqual(byId)
    expect(byName.number).toBe('1')
    expect(() => cmdNextNumber(db, 'No Such Type', '2025-07-15')).toThrow(/Unknown voucher type/)
  })

  it('posts a balanced voucher (audited as agent-cli) and rejects an unbalanced one', () => {
    const { voucherTypeId } = cmdNextNumber(db, 'Receipt', '2025-07-15')
    const balanced = {
      voucherTypeId,
      date: '2025-07-15',
      narration: 'agent cash sale',
      lines: [
        { ledgerId: ledgerId('Cash'), drCr: 'dr', amount: 150000 },
        { ledgerId: ledgerId('Agent Sales'), drCr: 'cr', amount: 150000 }
      ]
    }
    const unbalanced = { ...balanced, lines: [{ ledgerId: ledgerId('Cash'), drCr: 'dr', amount: 150000 }] }
    const results = cmdPost(db, [balanced, unbalanced])
    expect(results[0]).toMatchObject({ index: 0, ok: true, total: 150000 })
    expect(results[1]!.ok).toBe(false)
    expect((results[1] as { error: string }).error.toLowerCase()).toMatch(/differ|balance/)

    const audit = db
      .prepare("SELECT user_name FROM audit_log WHERE entity = 'voucher' ORDER BY id DESC LIMIT 1")
      .get() as { user_name: string }
    expect(audit.user_name).toBe('agent-cli')
  })

  it('enforces the period lock through the same saveVoucher path', () => {
    setLockDate(db, '2025-07-31')
    const { voucherTypeId } = cmdNextNumber(db, 'Receipt', '2025-07-20')
    const [result] = cmdPost(db, {
      voucherTypeId,
      date: '2025-07-20',
      lines: [
        { ledgerId: ledgerId('Cash'), drCr: 'dr', amount: 100 },
        { ledgerId: ledgerId('Agent Sales'), drCr: 'cr', amount: 100 }
      ]
    })
    expect(result!.ok).toBe(false)
    expect((result as { error: string }).error).toContain('locked')
    setLockDate(db, null)
  })

  it('exports mirrors and the round trip ties out', () => {
    const { dir, files } = cmdExport(db, slug, {})
    expect(files).toEqual(
      expect.arrayContaining(['ledgers.csv', 'ledgers.json', 'items.csv', 'vouchers-2025-26.json', 'trial-balance.json', 'outstandings.json', 'meta.json'])
    )

    const ledgers = JSON.parse(readFileSync(join(dir, 'ledgers.json'), 'utf8')) as { name: string; groupName: string }[]
    expect(ledgers.some((l) => l.name === 'Agent Sales' && l.groupName === 'Sales Accounts')).toBe(true)

    const vouchers = JSON.parse(readFileSync(join(dir, 'vouchers-2025-26.json'), 'utf8')) as {
      date: string
      lines: { drCr: string; amount: number }[]
    }[]
    expect(vouchers).toHaveLength(1)
    expect(vouchers[0]!.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)).toBe(150000)

    const tb = JSON.parse(readFileSync(join(dir, 'trial-balance.json'), 'utf8')) as {
      totalDebit: number
      totalCredit: number
    }
    expect(tb.totalDebit).toBe(tb.totalCredit)
    expect(tb.totalDebit).toBe(150000)
    // The file mirrors the live report exactly.
    const live = cmdTrialBalance(db, '2026-03-31')
    expect(live.totalDebit).toBe(150000)

    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as {
      schemaVersion: number
      voucherTypes: { id: number; name: string }[]
    }
    expect(meta.schemaVersion).toBe(1)
    expect(meta.voucherTypes.some((t) => t.name === 'Receipt')).toBe(true)
  })

  it('honors --what/--format filters', () => {
    const { files } = cmdExport(db, slug, { what: 'reports' })
    expect(files).toEqual(expect.arrayContaining(['trial-balance.json', 'outstandings.json', 'meta.json']))
    expect(files).not.toContain('ledgers.csv')

    const csvOnly = cmdExport(db, slug, { what: 'masters', format: 'csv' })
    expect(csvOnly.files).toContain('ledgers.csv')
    expect(csvOnly.files).not.toContain('ledgers.json')
  })
})
