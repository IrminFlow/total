// Test-only fixture for the WP 2.6 pricing / counter dbtests: a seeded company with a sales
// ledger, GST output ledgers, a bank account, two debtors and three GST items (one with a
// barcode). Not a test file — no describe/it here, and never imported by app code.
import type { DB } from '../db/connection'
import { seededDb } from '../db/testdb'
import { createLedger, createStockItem } from './masters'

export interface PricingFixture {
  db: DB
  sales: number
  bank: number
  cash: number
  umbrella: number
  krishna: number
  /** 18% GST, barcode 890100000001. */
  pen: number
  /** 12% GST + 12% cess. */
  tea: number
  /** 5% GST, in stock group "Stationery" › "Paper". */
  paper: number
  stationery: number
  paperGroup: number
}

export function pricingFixture(): PricingFixture {
  const db = seededDb()
  const group = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const ledger = (name: string, groupName: string, extra: Record<string, unknown> = {}): number =>
    createLedger(db, {
      name, groupId: group(groupName), openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null,
      gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null, ...extra
    }).id
  const sales = ledger('Sales A/c', 'Sales Accounts')
  ledger('CGST Output', 'Duties & Taxes', { taxType: 'cgst' })
  ledger('SGST Output', 'Duties & Taxes', { taxType: 'sgst' })
  ledger('IGST Output', 'Duties & Taxes', { taxType: 'igst' })
  ledger('Cess Output', 'Duties & Taxes', { taxType: 'cess' })
  const bank = ledger('HDFC Bank', 'Bank Accounts')
  const umbrella = ledger('Umbrella Retail', 'Sundry Debtors', { stateCode: '27' })
  const krishna = ledger('Krishna Enterprises', 'Sundry Debtors', { stateCode: '29' })
  const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
  const unit = (db.prepare('SELECT id FROM units ORDER BY id LIMIT 1').get() as { id: number }).id
  const stationery = Number(db.prepare("INSERT INTO stock_groups (name) VALUES ('Stationery')").run().lastInsertRowid)
  const paperGroup = Number(db.prepare("INSERT INTO stock_groups (name, parent_id) VALUES ('Paper', ?)").run(stationery).lastInsertRowid)
  const item = (name: string, gstRate: number, extra: Record<string, unknown> = {}): number =>
    createStockItem(db, {
      name, groupId: null, unitId: unit, hsn: '4820', gstRate, cessRate: null, openingQtyMilli: 1_000_000, openingValue: 1_000_000,
      barcode: null, reorderLevelMilli: null, ...extra
    }).id
  const pen = item('Gel Pen', 18, { barcode: '890100000001' })
  const tea = item('Tea Pack', 12, { cessRate: 12 })
  const paper = item('A4 Paper', 5, { groupId: paperGroup })
  return { db, sales, bank, cash, umbrella, krishna, pen, tea, paper, stationery, paperGroup }
}

/** Σ debits − Σ credits of a voucher's lines (0 = balanced). */
export function imbalance(db: DB, voucherId: number): number {
  return (
    db.prepare("SELECT COALESCE(SUM(CASE WHEN dr_cr = 'dr' THEN amount ELSE -amount END), 0) AS d FROM voucher_lines WHERE voucher_id = ?").get(voucherId) as { d: number }
  ).d
}
