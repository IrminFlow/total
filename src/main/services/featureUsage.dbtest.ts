// Feature cleanup: a fresh company uses none of the hideable features; one row of a feature's data
// (in the bin or not) makes it used. config:features:get carries the result as `unused`.
import { describe, expect, it } from 'vitest'
import { seededDb } from '../db/testdb'
import type { DB } from '../db/connection'
import { HIDEABLE_FEATURES, type HideableFeature } from '@shared/features'
import { unusedFeatures } from './featureUsage'
import { saveCostCentre } from './costCentres'
import { saveVoucher } from './vouchers'
import { createLedger } from './masters'

const ledgerId = (db: DB, name: string): number => (db.prepare('SELECT id FROM ledgers WHERE name = ?').get(name) as { id: number }).id

const SEED: Record<HideableFeature, (db: DB) => void> = {
  costCentres: (db) => void saveCostCentre(db, { name: 'Mumbai', parentId: null, active: true }),
  cheques: (db) => db.prepare("INSERT INTO cheque_books (bank_ledger_id, name, from_no, to_no) VALUES (?, 'Book 1', 1, 50)").run(ledgerId(db, 'Cash')),
  interest: (db) => db.prepare('UPDATE ledgers SET interest_rate_bp = 1800 WHERE id = ?').run(ledgerId(db, 'Cash')),
  fixedAssets: (db) => db.prepare("INSERT INTO fixed_asset_groups (name, life_months) VALUES ('Lab equipment', 120)").run(),
  tradeCycle: (db) => db.prepare("INSERT INTO trade_doc_types (name, kind) VALUES ('Export order', 'sales_order')").run(),
  payrollStatutory: (db) => db.prepare("INSERT INTO statutory_payments (kind, period, amount_paise, paid_on) VALUES ('pf', '2026-04', 1000, '2026-05-15')").run()
}

describe('unusedFeatures', () => {
  it('a fresh company uses none of them (seeded asset groups, document types and rates do not count)', () => {
    expect(unusedFeatures(seededDb())).toEqual([...HIDEABLE_FEATURES])
  })

  for (const f of HIDEABLE_FEATURES) {
    it(`one row of ${f} data makes ${f} used — and only ${f}`, () => {
      const db = seededDb()
      SEED[f](db)
      expect(unusedFeatures(db)).toEqual(HIDEABLE_FEATURES.filter((x) => x !== f))
    })
  }
})

describe('voucher-column probes (read incrementally)', () => {
  const journal = (db: DB, extra: Record<string, unknown>): void => {
    const vt = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }).id
    const cash = ledgerId(db, 'Cash')
    const capital = (db.prepare("SELECT id FROM groups WHERE name = 'Capital Account'").get() as { id: number }).id
    const other = (db.prepare("SELECT id FROM ledgers WHERE name = 'Owner capital'").get() as { id: number } | undefined)?.id ??
      createLedger(db, { name: 'Owner capital', groupId: capital, openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null } as never).id
    saveVoucher(db, {
      voucherTypeId: vt, date: '2025-05-01', partyLedgerId: null, narration: null, reference: null, instrumentNo: null, instrumentDate: null,
      transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [{ ledgerId: cash, drCr: 'dr', amount: 100, costAllocations: [] }, { ledgerId: other, drCr: 'cr', amount: 100, costAllocations: [] }],
      inventory: [], billRefs: [], tds: null, ...extra
    } as never)
  }

  it('forex is no longer a hideable feature (removed in the 1.0 cleanup): a foreign voucher shows nothing new', () => {
    const db = seededDb()
    journal(db, { currencyCode: 'USD', exchangeRate: 83 })
    expect(unusedFeatures(db)).toEqual([...HIDEABLE_FEATURES])
    expect((HIDEABLE_FEATURES as readonly string[]).includes('forex')).toBe(false)
  })

  it('a post-dated voucher makes cheques used', () => {
    const db = seededDb()
    expect(unusedFeatures(db)).toContain('cheques')
    journal(db, { postDated: true, date: '2099-01-01' })
    expect(unusedFeatures(db)).not.toContain('cheques')
  })
})
