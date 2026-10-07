// Migration 020 (WP 3.1): TDS core — payable-ledger tags (backfilled), effective-dated cited
// rates, deductee types, certificates, challans. Run on a fixture built at the schema version
// just before 020, staged with raw SQL (the services track the latest schema).
import { describe, it, expect } from 'vitest'
import { migrate } from './migrate'
import { MIGRATIONS } from './migrations'
import { freshPartialDb, TEST_INFO } from './testdb'
import { seedCompany } from './seed'
import type { DB } from './connection'
import { getVoucher, saveVoucher } from '../services/vouchers'
import { listRates, listSections } from '../services/tds'
import { voucherToPayload } from '@shared/voucherEdit'

/** Index of migration 020 in MIGRATIONS — the last one this WP appends. */
const M020 = MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE tds_section_rates'))
const BEFORE = M020 // number of migrations applied before 020

const gid = (db: DB, name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
const sid = (db: DB, code: string): number => (db.prepare('SELECT id FROM tds_sections WHERE code = ?').get(code) as { id: number }).id
const ledger = (db: DB, name: string, group: string, pan: string | null = null): number =>
  Number(db.prepare('INSERT INTO ledgers (name, group_id, opening_balance, is_system, pan) VALUES (?, ?, 0, 0, ?)').run(name, gid(db, group), pan).lastInsertRowid)

let seq = 0
/** A pre-020 TDS journal: Dr expense base / Cr party base − tds / Cr payable tds, + its entry. */
function legacyTds(db: DB, date: string, partyId: number, payableId: number, expenseId: number, code: string, base: number, tds: number): number {
  const vt = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }).id
  const v = Number(
    db.prepare('INSERT INTO vouchers (voucher_type_id, date, number, party_ledger_id) VALUES (?, ?, ?, ?)').run(vt, date, `L-${++seq}`, partyId)
      .lastInsertRowid
  )
  const line = db.prepare('INSERT INTO voucher_lines (voucher_id, ledger_id, dr_cr, amount, line_order) VALUES (?, ?, ?, ?, ?)')
  line.run(v, expenseId, 'dr', base, 0)
  line.run(v, partyId, 'cr', base - tds, 1)
  line.run(v, payableId, 'cr', tds, 2)
  db.prepare('INSERT INTO tds_entries (voucher_id, section_id, party_ledger_id, pan, base_amount, tds_amount) VALUES (?, ?, ?, ?, ?, ?)')
    .run(v, sid(db, code), partyId, 'ABCCE1234F', base, tds)
  return v
}

function fixture() {
  const db = freshPartialDb(BEFORE)
  seedCompany(db, { ...TEST_INFO, booksFrom: 2024 })
  const vendor = ledger(db, 'Vendor', 'Sundry Creditors', 'ABCCE1234F')
  const expense = ledger(db, 'Work', 'Indirect Expenses')
  const byName = ledger(db, 'tds payable 194c', 'Duties & Taxes') // case differs: NOCASE match
  const handNamed = ledger(db, 'TDS on Rent', 'Duties & Taxes')
  const ambiguous = ledger(db, 'TDS Misc', 'Duties & Taxes')
  const notDt = ledger(db, 'Suspense TDS', 'Current Liabilities')
  legacyTds(db, '2024-06-01', vendor, byName, expense, '194C', 5000000, 100000)
  const rentV = legacyTds(db, '2024-07-01', vendor, handNamed, expense, '194I', 6000000, 600000)
  legacyTds(db, '2024-08-01', vendor, ambiguous, expense, '194H', 2000000, 40000)
  legacyTds(db, '2024-08-02', vendor, ambiguous, expense, '194J', 3000000, 300000)
  legacyTds(db, '2024-09-01', vendor, notDt, expense, '194A', 1000000, 100000)
  // The user had edited 194H's rate, and added a section of their own.
  db.prepare("UPDATE tds_sections SET rate = 3 WHERE code = '194H'").run()
  db.prepare("INSERT INTO tds_sections (code, description, rate, threshold_single, threshold_annual) VALUES ('194Z', 'Custom', 4, 0, 100)").run()
  return { db, vendor, byName, handNamed, ambiguous, notDt, rentV }
}

const tag = (db: DB, id: number): number | null =>
  (db.prepare('SELECT tds_payable_section_id AS s FROM ledgers WHERE id = ?').get(id) as { s: number | null }).s

describe('migration 020', () => {
  it('is appended after the existing migrations and starts from a fixture without the new tables', () => {
    expect(M020).toBe(MIGRATIONS.length - 1)
    const db = freshPartialDb(BEFORE)
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name)
    expect(tables).not.toContain('tds_section_rates')
  })

  it('backfills payable tags by name and (unambiguously) from legacy entries; legacy entries become manual', () => {
    const f = fixture()
    migrate(f.db)
    const db = f.db
    expect(tag(db, f.byName)).toBe(sid(db, '194C'))
    expect(tag(db, f.handNamed)).toBe(sid(db, '194I'))
    expect(tag(db, f.ambiguous)).toBeNull() // credited for two sections
    expect(tag(db, f.notDt)).toBeNull() // not under Duties & Taxes
    const entries = db.prepare('SELECT is_manual, rate_bp_at, deductee_type_at, certificate_id FROM tds_entries').all() as Record<string, unknown>[]
    expect(entries).toHaveLength(5)
    for (const e of entries) expect(e).toEqual({ is_manual: 1, rate_bp_at: null, deductee_type_at: null, certificate_id: null })
    const audit = db.prepare("SELECT after_json FROM audit_log WHERE entity = 'migration' AND entity_id = 20").get() as { after_json: string }
    const trace = JSON.parse(audit.after_json)
    expect(trace.payableTaggedByName).toEqual([{ ledgerId: f.byName, sectionId: sid(db, '194C') }])
    expect(trace.payableTaggedByEntry).toEqual([{ ledgerId: f.handNamed, sectionId: sid(db, '194I') }])
    expect(trace.legacyEntriesMarkedManual).toBe(5)
  })

  it('carries the pre-020 figures up to 31 Mar 2025 (user edits kept) and seeds cited rows from FY 2025-26', () => {
    const f = fixture()
    migrate(f.db)
    const db = f.db
    const rates = (code: string) => listRates(db, sid(db, code))
    expect(rates('194H')[0]).toMatchObject({ effectiveFrom: '1961-04-01', effectiveTo: '2025-03-31', rateBp: 300, source: expect.stringMatching(/not re-verified/) })
    expect(rates('194Z')).toMatchObject([{ effectiveTo: null, rateBp: 400, thresholdAnnualPaise: 100 }])
    const c = rates('194C')
    expect(c.filter((r) => r.effectiveFrom === '2025-04-01').map((r) => [r.deducteeType, r.rateBp, r.effectiveTo, r.returnCode])).toEqual([
      ['any', 200, '2026-03-31', '94C'],
      ['individual_huf', 100, '2026-03-31', '94C']
    ])
    expect(c.filter((r) => r.effectiveFrom === '2026-04-01').map((r) => [r.deducteeType, r.returnCode])).toEqual([
      ['any', '1024'],
      ['individual_huf', '1023']
    ])
    for (const r of c.filter((x) => x.effectiveFrom >= '2025-04-01')) {
      expect(r).toMatchObject({ thresholdSinglePaise: 3000000, thresholdAnnualPaise: 10000000, noPanRateBp: 2000 })
      expect(r.source).toMatch(/accessed 2026-10-07/)
    }
    expect(rates('194I').find((r) => r.effectiveFrom === '2025-04-01')).toMatchObject({ rateBp: 1000, thresholdAnnualPaise: 5000000, thresholdBasis: 'month' })
    expect(rates('194J').find((r) => r.effectiveFrom === '2025-04-01')).toMatchObject({ rateBp: 1000, thresholdAnnualPaise: 5000000 })
    expect(rates('194J(A)').find((r) => r.effectiveFrom === '2025-04-01')).toMatchObject({ rateBp: 200, thresholdAnnualPaise: 5000000 })
    expect(rates('194H').find((r) => r.effectiveFrom === '2025-04-01')).toMatchObject({ rateBp: 200, thresholdAnnualPaise: 2000000 })
    expect(rates('194A').find((r) => r.effectiveFrom === '2025-04-01')).toMatchObject({ rateBp: 1000, thresholdAnnualPaise: 1000000 })
    expect(rates('194Q').find((r) => r.effectiveFrom === '2026-04-01')).toMatchObject({
      rateBp: 10, thresholdAnnualPaise: 500000000, thresholdExcessOnly: true, noPanRateBp: 500
    })
    // Legacy mirror columns follow the open-ended 'any' row.
    const sections = new Map(listSections(db).map((s) => [s.code, s]))
    expect(sections.get('194J')).toMatchObject({ rate: 10, thresholdSingle: 0, thresholdAnnual: 5000000, legacyCode: '194J(b)', newReference: '393(1) Sl. 6(iii) D(b)' })
    expect(sections.get('194H')!.rate).toBe(2)
    expect(sections.get('194Z')).toMatchObject({ rate: 4, legacyCode: '194Z', newReference: null })
  })

  it('a legacy TDS voucher opens and re-saves unchanged (manual entry, tagged payable credit)', () => {
    const f = fixture()
    migrate(f.db)
    const v = getVoucher(f.db, f.rentV)!
    expect(v.tds).toMatchObject({ isManual: true, tdsAmount: 600000 })
    const again = saveVoucher(f.db, voucherToPayload(v), v.id)
    expect(again.tds!.entryId).toBe(v.tds!.entryId)
    expect(again.lines.map((l) => [l.ledgerId, l.drCr, l.amount])).toEqual(v.lines.map((l) => [l.ledgerId, l.drCr, l.amount]))
  })
})
