import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { todayISO } from '@shared/dates'
import { openCompanyDb } from '../db/connection'
import { companyDbPath } from '../paths'
import { trialBalance } from './reports'
import { createDemoCompany } from './demo'

// createDemoCompany() derives every path from paths.ts#dataRoot(), which honours
// TOTAL_DATA_DIR — point the whole storage tree at a throwaway temp dir per test so
// nothing here touches a real ~/Documents/total.
let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'total-demo-'))
  process.env.TOTAL_DATA_DIR = dataDir
})

afterEach(() => {
  delete process.env.TOTAL_DATA_DIR
  rmSync(dataDir, { recursive: true, force: true })
})

describe('createDemoCompany', () => {
  it('creates a company whose database exists and is registered under a slugified name', () => {
    const { slug } = createDemoCompany()
    expect(slug).toBe('demo-traders')
    expect(existsSync(companyDbPath(slug))).toBe(true)
  })

  it('produces a trial balance that balances', () => {
    const { slug } = createDemoCompany()
    const db = openCompanyDb(slug)
    const tb = trialBalance(db, todayISO())
    expect(tb.totalDebit).toBe(tb.totalCredit)
    expect(tb.totalDebit).toBeGreaterThan(0)
    db.close()
  })

  it('posts around 40 vouchers (14 sales, 8 purchase, 8 receipt, 6 payment, 2 contra, 2 journal)', () => {
    const { slug } = createDemoCompany()
    const db = openCompanyDb(slug)
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM vouchers WHERE deleted_at IS NULL').get() as { n: number }
    expect(n).toBe(40)
    const kinds = db
      .prepare(
        `SELECT vt.kind AS kind, COUNT(*) AS n FROM vouchers v
         JOIN voucher_types vt ON vt.id = v.voucher_type_id
         WHERE v.deleted_at IS NULL GROUP BY vt.kind`
      )
      .all() as { kind: string; n: number }[]
    const byKind = Object.fromEntries(kinds.map((k) => [k.kind, k.n]))
    expect(byKind.sales).toBe(14)
    expect(byKind.purchase).toBe(8)
    expect(byKind.receipt).toBe(8)
    expect(byKind.payment).toBe(6)
    expect(byKind.contra).toBe(2)
    expect(byKind.journal).toBe(2)
    db.close()
  })

  it('dedupes the slug when a demo company already exists', () => {
    const first = createDemoCompany()
    const second = createDemoCompany()
    expect(first.slug).toBe('demo-traders')
    expect(second.slug).toBe('demo-traders-2')
  })

  it('creates distinct industry packs with the relevant ledgers and setup profile', () => {
    const { slug } = createDemoCompany('manufacturer')
    const db = openCompanyDb(slug)
    const ledger = db.prepare("SELECT id FROM ledgers WHERE name = 'Factory Wages'").get()
    expect(ledger).toBeTruthy()
    const profile = JSON.parse(require('fs').readFileSync(join(dataDir, 'companies', slug, 'setup.json'), 'utf8')) as { businessType: string; needsInventory: boolean; needsPayroll: boolean }
    expect(profile).toMatchObject({ businessType: 'manufacturer', needsInventory: true, needsPayroll: true })
    db.close()
  })
})
