// Migration 027 (WP 3.3): TCS over the TDS tables. Staged at the schema version just before it
// with raw SQL: existing TDS sections / certificates / challans become kind 'tds', "not
// applicable" marks survive the tds_exemptions rebuild (now keyed by voucher + kind), and the
// TCS sections arrive with cited rows.
import { describe, it, expect } from 'vitest'
import { migrate } from './migrate'
import { MIGRATIONS } from './migrations'
import { freshPartialDb, TEST_INFO } from './testdb'
import { seedCompany } from './seed'

const M027 = MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE tds_exemptions_027'))

describe('migration 027 — TCS', () => {
  it('is appended after the TDS migrations it builds on', () => {
    expect(M027).toBeGreaterThan(MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE IF NOT EXISTS tds_exemptions')))
  })

  it('tags existing rows as TDS, keeps the "not applicable" marks, adds the TCS master', () => {
    const db = freshPartialDb(M027)
    seedCompany(db, { ...TEST_INFO, booksFrom: 2024 })
    const vt = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'purchase'").get() as { id: number }).id
    const v = Number(db.prepare("INSERT INTO vouchers (voucher_type_id, date, number) VALUES (?, '2025-05-01', 'P-1')").run(vt).lastInsertRowid)
    db.prepare("INSERT INTO tds_exemptions (voucher_id, reason) VALUES (?, 'Goods, not a contract')").run(v)
    const party = Number(db.prepare("INSERT INTO ledgers (name, group_id, opening_balance, is_system) VALUES ('X', 1, 0, 0)").run().lastInsertRowid)
    db.prepare("INSERT INTO tds_certificates (ledger_id, section_id, certificate_no, rate_bp, valid_from, valid_to) VALUES (?, NULL, 'C1', 100, '2025-04-01', '2026-03-31')").run(party)
    db.prepare("INSERT INTO tds_challans (date, bsr_code, challan_no, amount_paise, quarter, fy_start_year) VALUES ('2025-06-07', '0510002', '1', 100, 1, 2025)").run()
    const tdsCount = (db.prepare('SELECT COUNT(*) AS n FROM tds_sections').get() as { n: number }).n

    migrate(db, MIGRATIONS.slice(0, M027 + 1)) // through 027 only — 029 seeds section 192 (WP 3.7)

    expect(db.prepare('SELECT voucher_id, kind, reason FROM tds_exemptions').all()).toEqual([{ voucher_id: v, kind: 'tds', reason: 'Goods, not a contract' }])
    // The same voucher can now carry a TCS mark too, independently.
    db.prepare("INSERT INTO tds_exemptions (voucher_id, kind, reason) VALUES (?, 'tcs', 'n/a')").run(v)
    expect((db.prepare('SELECT kind FROM tds_certificates').get() as { kind: string }).kind).toBe('tds')
    expect((db.prepare('SELECT kind FROM tds_challans').get() as { kind: string }).kind).toBe('tds')
    expect((db.prepare("SELECT COUNT(*) AS n FROM tds_sections WHERE kind = 'tds'").get() as { n: number }).n).toBe(tdsCount)
    const tcs = db.prepare("SELECT code, legacy_code, new_reference FROM tds_sections WHERE kind = 'tcs' ORDER BY code").all() as { code: string }[]
    expect(tcs).toHaveLength(10)
    const uncited = db.prepare(
      `SELECT COUNT(*) AS n FROM tds_section_rates r JOIN tds_sections s ON s.id = r.section_id
       WHERE s.kind = 'tcs' AND (r.source IS NULL OR r.source NOT LIKE '%accessed 2026-10-07%' OR r.base_includes_gst <> 1)`
    ).get() as { n: number }
    expect(uncited.n).toBe(0)
    // TDS rows keep GST out of the base.
    expect((db.prepare("SELECT COUNT(*) AS n FROM tds_section_rates r JOIN tds_sections s ON s.id = r.section_id WHERE s.kind = 'tds' AND r.base_includes_gst = 1").get() as { n: number }).n).toBe(0)
    for (const col of ['tcs_section_id', 'tcs_payable_section_id', 'tcs_default_section_id']) {
      expect((db.prepare('PRAGMA table_info(ledgers)').all() as { name: string }[]).some((c) => c.name === col)).toBe(true)
    }
    expect((db.prepare('PRAGMA table_info(stock_items)').all() as { name: string }[]).some((c) => c.name === 'tcs_section_id')).toBe(true)
  })
})
