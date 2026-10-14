// Test helper (no production code imports it): a company whose ledger-line outward documents cover
// every class the posted-tax rate rule (shared/gst/postedRate.ts) must leave alone — rated ledgers,
// an explicit 0 % ledger, cess ledgers, SEZ / export with and without payment, reverse charge, no
// tax posted — beside the rate-less + posted-tax documents it changes. gstPostedRateParity.dbtest
// pins the extractors' output on it against a fixture generated from origin/main's gst.ts / edocs.ts.
import type { DB } from '../db/connection'
import type { DrCr } from '@shared/domain'
import { seededDb } from '../db/testdb'
import { createLedger } from './masters'
import { saveVoucher } from './vouchers'

export const CORPUS_FROM = '2025-04-01'
export const CORPUS_TO = '2026-03-31'

export interface Corpus {
  db: DB
  /** Vouchers the rule is meant to change (a rate-less sales line + net CGST / SGST / IGST posted). */
  changed: Set<number>
}

export function buildParityCorpus(): Corpus {
  const db = seededDb()
  const g = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const vt = (kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ? ORDER BY id').get(kind) as { id: number }).id
  const L = (i: Parameters<typeof createLedger>[1]): number => createLedger(db, i).id
  const debtors = g('Sundry Debtors')
  const b2b = L({ name: 'B2B 27', groupId: debtors, gstin: '27AAPFU0939F1ZV', stateCode: '27' })
  const b2c = L({ name: 'B2C 27', groupId: debtors, stateCode: '27' })
  const inter = L({ name: 'B2B 29', groupId: debtors, gstin: '29AABCF9012G1ZQ', stateCode: '29' })
  const expWop = L({ name: 'Export WOP', groupId: debtors, stateCode: '96', exportType: 'exp_wop' })
  const expWp = L({ name: 'Export WP', groupId: debtors, stateCode: '96', exportType: 'exp_wp' })
  const sezWp = L({ name: 'SEZ WP', groupId: debtors, gstin: '27AABCS1429B1ZU', stateCode: '27', exportType: 'sez_wp' })
  const sezWop = L({ name: 'SEZ WOP', groupId: debtors, gstin: '27AABCS1429B1ZU', stateCode: '27', exportType: 'sez_wop' })
  const rcm = L({ name: 'RCM buyer', groupId: debtors, gstin: '27AAPFU0939F1ZV', stateCode: '27', rcm: true })
  const sales = g('Sales Accounts')
  const bare = L({ name: 'Sales bare', groupId: sales, hsn: '9983' })
  const bareNoHsn = L({ name: 'Sales bare no HSN', groupId: sales })
  const s18 = L({ name: 'Sales 18', groupId: sales, hsn: '9983', gstRate: 18 })
  const s12 = L({ name: 'Sales 12', groupId: sales, hsn: '9983', gstRate: 12 })
  const s0 = L({ name: 'Sales exempt', groupId: sales, hsn: '9983', gstRate: 0 })
  const s28c = L({ name: 'Sales 28 + cess', groupId: sales, hsn: '2202', gstRate: 28 })
  db.prepare('UPDATE ledgers SET cess_rate = 12 WHERE id = ?').run(s28c)
  const freight = L({ name: 'Freight charged', groupId: g('Indirect Incomes') })
  const roundOff = L({ name: 'Round Off', groupId: g('Indirect Expenses') })
  const duties = g('Duties & Taxes')
  const cgst = L({ name: 'CGST', groupId: duties, taxType: 'cgst' })
  const sgst = L({ name: 'SGST', groupId: duties, taxType: 'sgst' })
  const igst = L({ name: 'IGST', groupId: duties, taxType: 'igst' })
  const cess = L({ name: 'Cess', groupId: duties, taxType: 'cess' })
  const purchases = L({ name: 'Purchases', groupId: g('Purchase Accounts'), gstRate: 18 })
  const vendor = L({ name: 'Vendor', groupId: g('Sundry Creditors'), stateCode: '27', gstin: '27AABCG3456H1ZN' })

  const changed = new Set<number>()
  type Ln = [number, DrCr, number]
  const post = (kind: string, date: string, party: number, lines: Ln[], opts: { pos?: string; changes?: boolean } = {}): void => {
    const v = saveVoucher(db, {
      voucherTypeId: vt(kind), date, partyLedgerId: party, posOverride: opts.pos ?? null,
      lines: lines.map(([ledgerId, drCr, amount]) => ({ ledgerId, drCr, amount, costAllocations: [] })),
      inventory: [], billRefs: [], tds: null
    })
    if (opts.changes) changed.add(v.id)
  }
  const d1 = '2025-07-05'
  const d2 = '2026-02-10'
  // ---- unchanged classes ----
  post('sales', d1, b2b, [[b2b, 'dr', 118000], [s18, 'cr', 100000], [cgst, 'cr', 9000], [sgst, 'cr', 9000]])
  post('sales', d1, inter, [[inter, 'dr', 112000], [s12, 'cr', 100000], [igst, 'cr', 12000]])
  post('sales', d1, b2c, [[b2c, 'dr', 5000], [bare, 'cr', 5000]]) // rate-less, no tax: nil
  post('sales', d1, b2c, [[b2c, 'dr', 7000], [bareNoHsn, 'cr', 7000]])
  post('sales', d1, b2b, [[b2b, 'dr', 100000], [s0, 'cr', 100000]]) // explicit exempt
  // explicit 0 % beside a rated line, posted tax ₹2 over the rated line's: the exempt line stays exempt
  post('sales', d1, b2b, [[b2b, 'dr', 218200], [s18, 'cr', 100000], [s0, 'cr', 100000], [cgst, 'cr', 9100], [sgst, 'cr', 9100]])
  // explicit 0 % ledger WITH tax posted: reported as main did (val_mismatch blocks)
  post('sales', d1, b2c, [[b2c, 'dr', 118000], [s0, 'cr', 100000], [cgst, 'cr', 9000], [sgst, 'cr', 9000]])
  post('sales', d1, b2b, [[b2b, 'dr', 140000], [s28c, 'cr', 100000], [cgst, 'cr', 14000], [sgst, 'cr', 14000], [cess, 'cr', 12000]])
  post('sales', d1, expWop, [[expWop, 'dr', 100000], [bare, 'cr', 100000]])
  post('sales', d1, expWop, [[expWop, 'dr', 100000], [s18, 'cr', 100000]])
  post('sales', d1, sezWop, [[sezWop, 'dr', 100000], [s18, 'cr', 100000]])
  post('sales', d1, expWp, [[expWp, 'dr', 118000], [s18, 'cr', 100000], [igst, 'cr', 18000]])
  post('sales', d1, sezWp, [[sezWp, 'dr', 118000], [s18, 'cr', 100000], [igst, 'cr', 18000]])
  post('sales', d1, rcm, [[rcm, 'dr', 100000], [bare, 'cr', 100000]]) // reverse charge: no tax posted
  post('sales', d1, b2b, [[b2b, 'dr', 118000], [s18, 'cr', 100000], [cgst, 'cr', 9000], [sgst, 'cr', 9000]], { pos: '29' })
  // rated + rate-less freight, the rated line explains all the tax: freight stays nil
  post('sales', d1, b2b, [[b2b, 'dr', 123000], [s18, 'cr', 100000], [freight, 'cr', 5000], [cgst, 'cr', 9000], [sgst, 'cr', 9000]])
  post('credit_note', d1, b2b, [[b2b, 'cr', 11800], [s18, 'dr', 10000], [cgst, 'dr', 900], [sgst, 'dr', 900]])
  post('credit_note', d1, b2b, [[b2b, 'cr', 5000], [bare, 'dr', 5000]])
  post('debit_note', d1, b2b, [[b2b, 'dr', 11800], [s18, 'cr', 10000], [cgst, 'cr', 900], [sgst, 'cr', 900]])
  post('purchase', d1, vendor, [[purchases, 'dr', 100000], [cgst, 'dr', 9000], [sgst, 'dr', 9000], [vendor, 'cr', 118000]])
  post('debit_note', d1, vendor, [[vendor, 'dr', 11800], [purchases, 'cr', 10000], [cgst, 'cr', 900], [sgst, 'cr', 900]])
  // ---- changed: rate-less + posted tax ----
  post('sales', d1, b2b, [[b2b, 'dr', 118000], [bare, 'cr', 100000], [cgst, 'cr', 9000], [sgst, 'cr', 9000]], { changes: true })
  post('sales', d1, inter, [[inter, 'dr', 128000], [bare, 'cr', 100000], [igst, 'cr', 28000]], { changes: true })
  post('sales', d2, b2c, [[b2c, 'dr', 105000], [bareNoHsn, 'cr', 100000], [cgst, 'cr', 2500], [sgst, 'cr', 2500]], { changes: true })
  post('sales', d1, b2b, [[b2b, 'dr', 223000], [s18, 'cr', 100000], [bare, 'cr', 100000], [cgst, 'cr', 11500], [sgst, 'cr', 11500]], { changes: true })
  post('sales', d2, b2b, [[b2b, 'dr', 145700], [bare, 'cr', 123456], [cgst, 'cr', 11100], [sgst, 'cr', 11100], [roundOff, 'cr', 44]], { changes: true })
  post('sales', d1, expWp, [[expWp, 'dr', 118000], [bare, 'cr', 100000], [igst, 'cr', 18000]], { changes: true })
  post('credit_note', d2, b2b, [[b2b, 'cr', 11200], [bare, 'dr', 10000], [cgst, 'dr', 600], [sgst, 'dr', 600]], { changes: true })
  post('debit_note', d1, b2b, [[b2b, 'dr', 11800], [bare, 'cr', 10000], [cgst, 'cr', 900], [sgst, 'cr', 900]], { changes: true })
  post('sales', d1, b2b, [[b2b, 'dr', 140000], [bare, 'cr', 100000], [cgst, 'cr', 14000], [sgst, 'cr', 14000], [cess, 'cr', 12000]], { changes: true })
  return { db, changed }
}
