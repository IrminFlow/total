// Test-only helpers for DB-layer tests (*.dbtest.ts). Not itself a test file — no describe/it here.
// Runs only under `npm run test:db` (Electron-as-Node), never under plain-Node vitest.
import Database from 'better-sqlite3'
import type { DB } from './connection'
import { migrate } from './migrate'
import { seedCompany } from './seed'
import type { CompanyInfo, Voucher, VoucherKind } from '@shared/domain'
import { saveVoucher } from '../services/vouchers'
import { createLedger } from '../services/masters'

/** Minimal valid CompanyInfo for seeding test databases. */
export const TEST_INFO: CompanyInfo = {
  name: 'Test Co',
  stateCode: '27',
  gstin: null,
  gstRegistrationType: 'regular',
  address: '',
  booksFrom: 2025,
  email: null,
  phone: null,
  pan: null,
  tan: null
}

/** An in-memory DB with the schema migrated but no seed data. */
export function freshDb(): DB {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

/** An in-memory DB migrated and seeded with the default company setup (groups, voucher types, Cash ledger, ...). */
export function seededDb(): DB {
  const db = freshDb()
  seedCompany(db, TEST_INFO)
  return db
}

/** Ledger id for `name`, creating it under the seeded 'Sales Accounts' group if it doesn't exist yet. */
function ledgerIdByName(db: DB, name: string): number {
  const row = db.prepare('SELECT id FROM ledgers WHERE name = ?').get(name) as { id: number } | undefined
  if (row) return row.id
  const group = db.prepare('SELECT id FROM groups WHERE name = ?').get('Sales Accounts') as { id: number } | undefined
  if (!group) throw new Error("Seeded group 'Sales Accounts' not found — did you call seededDb()?")
  const ledger = createLedger(db, {
    name,
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
    exportType: null
  })
  return ledger.id
}

export interface SimpleVoucherOpts {
  date: string
  amount: number
  kind: VoucherKind
}

/**
 * Post a minimal two-line voucher of `kind` for `amount` paise on `date`, between the seeded
 * 'Cash' ledger and a lazily-created 'Sales Account' ledger. Debit/credit side follows the
 * cash-must-be-debited-on-receipt / credited-on-payment posting rule; any other kind debits Cash.
 */
export function postSimpleVoucher(db: DB, opts: SimpleVoucherOpts): Voucher {
  const vt = db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(opts.kind) as { id: number } | undefined
  if (!vt) throw new Error(`No seeded voucher type for kind '${opts.kind}'`)

  const cashId = ledgerIdByName(db, 'Cash')
  const otherId = ledgerIdByName(db, 'Sales Account')
  const [drId, crId] = opts.kind === 'payment' ? [otherId, cashId] : [cashId, otherId]

  return saveVoucher(db, {
    voucherTypeId: vt.id,
    date: opts.date,
    partyLedgerId: null,
    narration: null,
    reference: null,
    instrumentNo: null,
    instrumentDate: null,
    transporterId: null,
    vehicleNo: null,
    transportDistanceKm: null,
    currencyCode: null,
    exchangeRate: null,
    lines: [
      { ledgerId: drId, drCr: 'dr', amount: opts.amount, costAllocations: [] },
      { ledgerId: crId, drCr: 'cr', amount: opts.amount, costAllocations: [] }
    ],
    inventory: [],
    billRefs: [],
    tds: null
  })
}
