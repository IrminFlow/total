import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { CompanyInfo } from '@shared/domain'
import { parseTallyExport } from '@shared/tally'
import { openCompanyDb } from '../db/connection'
import { seedCompany } from '../db/seed'
import { exportCaPack, exportTallyXml } from './caPack'

// exportCaPack/exportTallyXml derive every path from paths.ts#dataRoot(), which honours
// TOTAL_DATA_DIR — point the whole storage tree at a throwaway temp dir per test so nothing
// here touches a real ~/Documents/total (see consolidated.dbtest.ts for the same pattern).
let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'total-capack-'))
  process.env.TOTAL_DATA_DIR = dataDir
})

afterEach(() => {
  delete process.env.TOTAL_DATA_DIR
  rmSync(dataDir, { recursive: true, force: true })
})

function freshCompany(): { db: ReturnType<typeof openCompanyDb>; slug: string; info: CompanyInfo } {
  const slug = `dbtest-${Math.random().toString(36).slice(2)}`
  const db = openCompanyDb(slug)
  const info: CompanyInfo = {
    name: 'CA Pack Test Co',
    stateCode: '27',
    gstin: '27AAAAA0000A1Z5',
    gstRegistrationType: 'regular',
    address: 'Mumbai, Maharashtra',
    booksFrom: 2026,
    email: null,
    phone: null,
    pan: null,
    tan: null
  }
  seedCompany(db, info)
  return { db, slug, info }
}

function groupId(db: ReturnType<typeof freshCompany>['db'], name: string): number {
  return (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
}

function voucherTypeId(db: ReturnType<typeof freshCompany>['db'], name: string): number {
  return (db.prepare('SELECT id FROM voucher_types WHERE name = ?').get(name) as { id: number }).id
}

function seedLedgersAndVouchers(db: ReturnType<typeof freshCompany>['db']): void {
  const insertLedger = db.prepare(
    `INSERT INTO ledgers (name, group_id, opening_balance, gstin, state_code, tax_type, is_system)
     VALUES (?, ?, 0, ?, ?, ?, 0)`
  )
  const abc = insertLedger.run('ABC Traders', groupId(db, 'Sundry Debtors'), '27ABCPT1234F1Z5', '27', null).lastInsertRowid as number
  const sales = insertLedger.run('Sales', groupId(db, 'Sales Accounts'), null, null, null).lastInsertRowid as number
  const cgst = insertLedger.run('Output CGST', groupId(db, 'Duties & Taxes'), null, null, 'cgst').lastInsertRowid as number
  const sgst = insertLedger.run('Output SGST', groupId(db, 'Duties & Taxes'), null, null, 'sgst').lastInsertRowid as number
  const rent = insertLedger.run('Rent', groupId(db, 'Indirect Expenses'), null, null, null).lastInsertRowid as number
  const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id

  const insertVoucher = db.prepare(
    `INSERT INTO vouchers (voucher_type_id, date, number, party_ledger_id, narration)
     VALUES (?, ?, ?, ?, ?)`
  )
  const insertLine = db.prepare('INSERT INTO voucher_lines (voucher_id, ledger_id, dr_cr, amount, line_order) VALUES (?, ?, ?, ?, ?)')

  const v1 = insertVoucher.run(voucherTypeId(db, 'Sales'), '2026-07-10', '1', abc, 'July supply').lastInsertRowid as number
  insertLine.run(v1, abc, 'dr', 118_000, 0)
  insertLine.run(v1, sales, 'cr', 100_000, 1)
  insertLine.run(v1, cgst, 'cr', 9_000, 2)
  insertLine.run(v1, sgst, 'cr', 9_000, 3)

  const v2 = insertVoucher.run(voucherTypeId(db, 'Payment'), '2026-07-15', '1', null, 'Office rent').lastInsertRowid as number
  insertLine.run(v2, rent, 'dr', 25_000, 0)
  insertLine.run(v2, cash, 'cr', 25_000, 1)
}

describe('caPack.exportCaPack', () => {
  it('writes the full CA handover pack for the period', () => {
    const { db, slug, info } = freshCompany()
    seedLedgersAndVouchers(db)

    const { path: dir } = exportCaPack(db, info, slug, '2026-07-01', '2026-07-31')

    expect(existsSync(dir)).toBe(true)
    for (const f of [
      'tally-masters.xml',
      'tally-vouchers.xml',
      'daybook.csv',
      'trial-balance.csv',
      'profit-and-loss.csv',
      'balance-sheet.csv',
      'sales-register.csv',
      'purchase-register.csv',
      'outstandings.csv',
      'gstr1-072026.json'
    ]) {
      expect(existsSync(join(dir, f)), f).toBe(true)
    }

    // Trial balance: contains the party ledger and is balanced (dr 1430.00 = cr 1430.00 total).
    const tb = readFileSync(join(dir, 'trial-balance.csv'), 'utf8')
    expect(tb).toContain('ABC Traders')
    expect(tb).toContain('Total,,1430.00,1430.00')

    // Ledger statements: one CSV per ledger with activity in the period (all six here).
    const ledgerFiles = readdirSync(join(dir, 'ledger-statements')).sort()
    expect(ledgerFiles).toEqual(['ABC Traders.csv', 'Cash.csv', 'Output CGST.csv', 'Output SGST.csv', 'Rent.csv', 'Sales.csv'])

    // Round-trip: the generated vouchers XML parses back to the same voucher count.
    const vouchersXml = readFileSync(join(dir, 'tally-vouchers.xml'), 'utf8')
    const parsed = parseTallyExport(vouchersXml)
    expect(parsed.vouchers).toHaveLength(2)
    expect(parsed.vouchers.map((v) => v.number).sort()).toEqual(['1', '1'])
    const sales = parsed.vouchers.find((v) => v.vchType === 'Sales')!
    expect(sales.lines).toEqual(
      expect.arrayContaining([
        { ledger: 'ABC Traders', drCr: 'dr', amount: 118_000 },
        { ledger: 'Sales', drCr: 'cr', amount: 100_000 }
      ])
    )

    db.close()
  })

  it('omits tds-26q.csv when there are no TDS entries for the period', () => {
    const { db, slug, info } = freshCompany()
    seedLedgersAndVouchers(db)
    const { path: dir } = exportCaPack(db, info, slug, '2026-07-01', '2026-07-31')
    expect(existsSync(join(dir, 'tds-26q.csv'))).toBe(false)
    db.close()
  })

  it('includes tds-26q.csv, joined to the section code and voucher, when tds_entries has rows in the period', () => {
    const { db, slug, info } = freshCompany()
    seedLedgersAndVouchers(db)

    // '194C' is seeded by the migrations themselves — reuse it rather than inserting a duplicate
    // (code is UNIQUE).
    const section = (db.prepare("SELECT id FROM tds_sections WHERE code = '194C'").get() as { id: number }).id
    const abc = (db.prepare("SELECT id FROM ledgers WHERE name = 'ABC Traders'").get() as { id: number }).id
    const voucherId = (db.prepare("SELECT id FROM vouchers WHERE number = '1' AND date = '2026-07-10'").get() as { id: number }).id
    db.prepare(
      'INSERT INTO tds_entries (voucher_id, section_id, party_ledger_id, pan, base_amount, tds_amount) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(voucherId, section, abc, 'ABCPT1234F', 100_000, 1_000)

    const { path: dir } = exportCaPack(db, info, slug, '2026-07-01', '2026-07-31')
    expect(existsSync(join(dir, 'tds-26q.csv'))).toBe(true)
    const csv = readFileSync(join(dir, 'tds-26q.csv'), 'utf8')
    expect(csv).toContain('ABC Traders')
    expect(csv).toContain('194C')
    expect(csv).toContain('1000.00')

    db.close()
  })
})

describe('caPack.exportTallyXml', () => {
  it('writes only the two Tally XML files', () => {
    const { db, slug, info } = freshCompany()
    seedLedgersAndVouchers(db)

    const { path: dir } = exportTallyXml(db, info, slug, '2026-07-01', '2026-07-31')

    expect(readdirSync(dir).sort()).toEqual(['tally-masters.xml', 'tally-vouchers.xml'])
    const parsed = parseTallyExport(readFileSync(join(dir, 'tally-vouchers.xml'), 'utf8'))
    expect(parsed.vouchers).toHaveLength(2)

    db.close()
  })
})
