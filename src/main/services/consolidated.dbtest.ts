import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { CompanyInfo } from '@shared/domain'
import type { DB } from '../db/connection'
import { openCompanyDb } from '../db/connection'
import { MIGRATIONS } from '../db/migrations'
import { seedCompany } from '../db/seed'
import { createLedger, listGroups } from './masters'
import { saveVoucher } from './vouchers'
import { upsertCompany } from '../registry'
import { consolidated } from './consolidated'

// consolidated() derives every path from paths.ts#dataRoot(), which honours
// TOTAL_DATA_DIR — point the whole storage tree at a throwaway temp dir per test so
// nothing here touches a real ~/Documents/total.
let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'total-consol-'))
  process.env.TOTAL_DATA_DIR = dataDir
})

afterEach(() => {
  delete process.env.TOTAL_DATA_DIR
  rmSync(dataDir, { recursive: true, force: true })
})

const FROM = '2025-04-01'
const TO = '2026-03-31'

function makeInfo(name: string): CompanyInfo {
  return {
    name,
    stateCode: '27',
    gstin: null,
    gstRegistrationType: 'unregistered',
  gstFilingFrequency: 'monthly',
    address: '',
    booksFrom: 2025,
    email: null,
    phone: null,
    pan: null,
    tan: null
  }
}

/** Seed a company DB with a Sales ledger, a Rent ledger, and two journal vouchers. */
function makeCompany(slug: string, name: string, salesAmount: number, rentAmount: number): DB {
  const db = openCompanyDb(slug)
  const info = makeInfo(name)
  seedCompany(db, info)
  upsertCompany({ slug, name, stateCode: info.stateCode, gstin: info.gstin, lastOpenedAt: null })

  const groups = listGroups(db)
  const groupId = (n: string): number => groups.find((g) => g.name === n)!.id
  const cashLedger = db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }
  const sales = createLedger(db, {
    name: 'Sales', groupId: groupId('Sales Accounts'), openingBalance: 0,
    gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
    tdsSectionId: null, pan: null, creditDays: null, exportType: null
  })
  const rent = createLedger(db, {
    name: 'Rent', groupId: groupId('Indirect Expenses'), openingBalance: 0,
    gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
    tdsSectionId: null, pan: null, creditDays: null, exportType: null
  })
  const journalType = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }

  saveVoucher(db, {
    voucherTypeId: journalType.id, date: '2025-06-01', partyLedgerId: null, narration: null,
    reference: null, instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
    transportDistanceKm: null, currencyCode: null, exchangeRate: null,
    lines: [
      { ledgerId: cashLedger.id, drCr: 'dr', amount: salesAmount, costAllocations: [] },
      { ledgerId: sales.id, drCr: 'cr', amount: salesAmount, costAllocations: [] }
    ],
    inventory: [], billRefs: [], tds: null
  })
  saveVoucher(db, {
    voucherTypeId: journalType.id, date: '2025-06-15', partyLedgerId: null, narration: null,
    reference: null, instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
    transportDistanceKm: null, currencyCode: null, exchangeRate: null,
    lines: [
      { ledgerId: rent.id, drCr: 'dr', amount: rentAmount, costAllocations: [] },
      { ledgerId: cashLedger.id, drCr: 'cr', amount: rentAmount, costAllocations: [] }
    ],
    inventory: [], billRefs: [], tds: null
  })

  return db
}

describe('consolidated()', () => {
  it('merges trial balances of two companies by ledger name', () => {
    const alpha = makeCompany('alpha', 'Alpha Traders', 100000, 20000)
    const beta = makeCompany('beta', 'Beta Traders', 50000, 5000)
    alpha.close()
    beta.close()

    const result = consolidated(['alpha', 'beta'], 'tb', FROM, TO)

    expect(result.warnings).toEqual([])
    expect(result.columns).toEqual(['Alpha Traders', 'Beta Traders'])

    const byName = new Map(result.rows.map((r) => [r.name, r]))
    expect(byName.get('Cash')).toEqual({ name: 'Cash', group: 'Cash-in-Hand', perCompany: [80000, 45000], total: 125000 })
    expect(byName.get('Rent')).toEqual({ name: 'Rent', group: 'Indirect Expenses', perCompany: [20000, 5000], total: 25000 })
    expect(byName.get('Sales')).toEqual({ name: 'Sales', group: 'Sales Accounts', perCompany: [-100000, -50000], total: -150000 })

    // Trial balance is self-balancing per company, so the whole merged matrix nets to zero too.
    const grandTotal = result.rows.reduce((s, r) => s + r.total, 0)
    expect(grandTotal).toBe(0)
  })

  it('merges P&L trading incomes and indirect expenses across companies', () => {
    const alpha = makeCompany('alpha', 'Alpha Traders', 100000, 20000)
    const beta = makeCompany('beta', 'Beta Traders', 50000, 5000)
    alpha.close()
    beta.close()

    const result = consolidated(['alpha', 'beta'], 'pnl', FROM, TO)

    expect(result.warnings).toEqual([])
    const byName = new Map(result.rows.map((r) => [r.name, r]))
    // flattenPnl reports each leaf's actual account group (same names the trial balance
    // uses), not the section label — "Sales" sits directly under "Sales Accounts".
    expect(byName.get('Sales')).toEqual({ name: 'Sales', group: 'Sales Accounts', perCompany: [-100000, -50000], total: -150000 })
    expect(byName.get('Rent')).toEqual({ name: 'Rent', group: 'Indirect Expenses', perCompany: [20000, 5000], total: 25000 })
  })

  it('leaves a null column and a warning for a company with a stale (unmigrated) schema', () => {
    const alpha = makeCompany('alpha', 'Alpha Traders', 100000, 20000)
    const stale = makeCompany('stale', 'Stale Co', 1000, 100)
    alpha.close()
    // Simulate a DB left behind by an older build: schema is current, but the migrations
    // ledger under-reports it — the exact situation a readonly connection can detect but
    // never fix (it can't run migrations).
    stale.prepare('DELETE FROM migrations WHERE id = (SELECT MAX(id) FROM migrations)').run()
    stale.close()

    const result = consolidated(['alpha', 'stale'], 'tb', FROM, TO)

    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/Stale Co/)
    expect(result.columns).toEqual(['Alpha Traders', 'Stale Co'])

    const cashRow = result.rows.find((r) => r.name === 'Cash')!
    expect(cashRow.perCompany).toEqual([80000, null])
  })

  it('warns and continues when a requested company does not exist on disk', () => {
    const alpha = makeCompany('alpha', 'Alpha Traders', 100000, 20000)
    alpha.close()

    const result = consolidated(['alpha', 'ghost'], 'tb', FROM, TO)

    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/ghost/)
    expect(result.columns).toEqual(['Alpha Traders', 'ghost'])
    const cashRow = result.rows.find((r) => r.name === 'Cash')!
    expect(cashRow.perCompany).toEqual([80000, null])
  })

  it('sanity-checks the migrations guard against the real migration count', () => {
    // Guards against silent drift if MIGRATIONS ever shrinks to 0 by accident.
    expect(MIGRATIONS.length).toBeGreaterThan(0)
  })
})
