// To-do §4 — the voucher text index migration (voucher_fts over the vouchers in the books): the
// last migration, no table rebuild, built for vouchers already there (an old file or backup is
// indexed when it is opened and migrated), and kept in step by the triggers through every write
// the app makes — save, edit, bin, restore, purge — so FTS5's own integrity check against its
// content view always passes and a binned voucher vanishes from search.
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { MIGRATIONS } from './migrations'
import { migrate, schemaVersion } from './migrate'
import { freshPartialDb, seededDb, testFileDb, TEST_INFO, postSimpleVoucher } from './testdb'
import { seedCompany } from './seed'
import { snapshotTo } from './backup'
import type { DB } from './connection'
import { deleteVoucher, getVoucher, purgeVoucher, restoreVoucher, saveVoucher } from '../services/vouchers'
import { updateLedger } from '../services/masters'
import { search } from '../services/search'
import { trialBalance } from '../services/reports'

const M = MIGRATIONS.findIndex((sql) => sql.includes('CREATE VIRTUAL TABLE voucher_fts'))

/** FTS5's check of the index against its content (the in-books vouchers view). Throws if off. */
function integrity(db: DB): void {
  db.prepare("INSERT INTO voucher_fts (voucher_fts, rank) VALUES ('integrity-check', 1)").run()
}
const indexed = (db: DB): number[] =>
  (db.prepare("SELECT rowid AS id FROM voucher_fts WHERE voucher_fts MATCH 'narration : \"nar\"' ORDER BY rowid").all() as { id: number }[]).map((r) => r.id)
const found = (db: DB, q: string): number[] => search(db, q, { today: '2026-03-31' }).vouchers!.rows.map((r) => r.id)

function withNarration(db: DB, id: number, narration: string, reference: string | null = null): void {
  const v = getVoucher(db, id)!
  saveVoucher(db, {
    voucherTypeId: v.voucherTypeId, date: v.date, number: v.number, partyLedgerId: v.partyLedgerId, narration, reference,
    instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
    lines: v.lines.map((l) => ({ ledgerId: l.ledgerId, drCr: l.drCr, amount: l.amount, costAllocations: [] })),
    inventory: [], billRefs: [], tds: null
  }, id)
}

describe('voucher text index migration', () => {
  it('was last when added (the NIC e-document columns follow it), an FTS5 table + view + three triggers, no rebuild of vouchers', () => {
    expect(M).toBe(MIGRATIONS.findIndex((sql) => sql.includes('irn_signed_invoice')) - 1)
    expect(MIGRATIONS[M]!.trimStart().startsWith('-- @foreign-keys-off')).toBe(false)
    expect(MIGRATIONS[M]!).not.toMatch(/DROP TABLE|ALTER TABLE/i)
    const db = seededDb()
    const objects = db.prepare("SELECT type, name FROM sqlite_master WHERE name LIKE 'voucher_fts%' AND type IN ('view', 'trigger') ORDER BY name").all()
    expect(objects).toEqual([
      { type: 'trigger', name: 'voucher_fts_delete' },
      { type: 'trigger', name: 'voucher_fts_insert' },
      { type: 'view', name: 'voucher_fts_source' },
      { type: 'trigger', name: 'voucher_fts_update' }
    ])
    expect((db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS on_").get() as { on_: number }).on_).toBe(1)
  })

  it('indexes the vouchers already in the books when an older file is migrated, binned ones left out', () => {
    const db = freshPartialDb(M)
    seedCompany(db, TEST_INFO)
    const ids = [1, 2, 3, 4].map((k) => postSimpleVoucher(db, { date: `2025-0${k + 4}-01`, amount: k * 100_00, kind: 'receipt' }).id)
    ids.forEach((id, k) => db.prepare('UPDATE vouchers SET narration = ? WHERE id = ?').run(`nar ${k} बिल`, id))
    db.prepare("UPDATE vouchers SET deleted_at = '2026-01-01 00:00:00' WHERE id = ?").run(ids[1])
    // The later NIC e-document migration appends (NULL) columns to vouchers — left out of the comparison.
    const LATER = new Set(['irn_signed_invoice', 'irn_signed_qr', 'irn_cancelled_at', 'irn_cancel_reason', 'irn_cancel_remark', 'ewb_date', 'ewb_history'])
    const dump = (): unknown => ['vouchers', 'voucher_lines', 'ledgers', 'audit_log'].map((t) =>
      (db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all() as Record<string, unknown>[]).map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !LATER.has(k)))))
    const before = { rows: dump(), tb: trialBalance(db, '2026-03-31') }
    migrate(db)
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
    expect({ rows: dump(), tb: trialBalance(db, '2026-03-31') }).toEqual(before)
    expect(indexed(db)).toEqual([ids[0], ids[2], ids[3]])
    integrity(db)
    expect(found(db, 'बिल').sort()).toEqual([ids[0], ids[2], ids[3]].sort())
  })

  it('follows save, edit, bin, restore, purge and raw deletes; a binned voucher vanishes from search', () => {
    const db = seededDb()
    const a = postSimpleVoucher(db, { date: '2025-05-01', amount: 500_00, kind: 'receipt' }).id
    const b = postSimpleVoucher(db, { date: '2025-05-02', amount: 600_00, kind: 'receipt' }).id
    withNarration(db, a, 'nar first Bill 4 सामान', 'INV-77')
    withNarration(db, b, 'nar second Café')
    integrity(db)
    expect(indexed(db)).toEqual([a, b])
    expect(found(db, 'bill 4')).toEqual([a])
    expect(found(db, 'inv-7')).toEqual([a])
    expect(found(db, 'café')).toEqual([b])

    withNarration(db, a, 'nar changed rent')
    integrity(db)
    expect(found(db, 'bill 4')).toEqual([])
    expect(found(db, 'rent')).toContain(a)

    deleteVoucher(db, b)
    integrity(db)
    expect(indexed(db)).toEqual([a])
    expect(found(db, 'café')).toEqual([])
    restoreVoucher(db, b)
    integrity(db)
    expect(found(db, 'café')).toEqual([b])

    deleteVoucher(db, b)
    purgeVoucher(db, b)
    integrity(db)
    expect(indexed(db)).toEqual([a])

    db.prepare('DELETE FROM vouchers WHERE id = ?').run(a)
    integrity(db)
    expect(indexed(db)).toEqual([])
  })

  it('a narration edit while binned shows after the restore; FTS query syntax in a term never throws', () => {
    const db = seededDb()
    const a = postSimpleVoucher(db, { date: '2025-05-01', amount: 500_00, kind: 'receipt' }).id
    withNarration(db, a, 'nar zeta')
    deleteVoucher(db, a)
    db.prepare("UPDATE vouchers SET narration = 'nar omega (p) AND NOT * : ^ a:b \"q\"' WHERE id = ?").run(a)
    integrity(db)
    expect(found(db, 'omega')).toEqual([])
    restoreVoucher(db, a)
    integrity(db)
    expect(found(db, 'omega')).toEqual([a])
    expect(found(db, 'zeta')).toEqual([])
    for (const q of ['"', '"""', '(', '((', 'AND', 'NOT', 'NEAR(a b)', '*', '***', ':', 'a:b', 'x:y:z', '^ab', '---', '{c}', '\\"', 'a"b', 'end"', 'NOT *', 'narration:end', '\u0000ab', 'ab\u0000cd', '\uD800abc']) {
      expect(() => found(db, q), JSON.stringify(q)).not.toThrow()
    }
    expect(found(db, '(p) AND')).toEqual([a])
    expect(found(db, 'a:b')).toEqual([a])
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
  })

  it('a party rename needs no index change: the voucher is found by the new name', () => {
    const db = seededDb()
    const v = postSimpleVoucher(db, { date: '2025-05-01', amount: 500_00, kind: 'receipt' })
    const ledgerId = v.lines.find((l) => l.drCr === 'cr')!.ledgerId
    const l = db.prepare('SELECT * FROM ledgers WHERE id = ?').get(ledgerId) as Record<string, unknown>
    updateLedger(db, ledgerId, {
      name: 'Zanzibar Takings', groupId: l.group_id as number, openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null,
      gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
    })
    integrity(db)
    expect(found(db, 'zanzibar')).toEqual([v.id])
  })

  it('a backup copy carries the index; it stays consistent there', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'total-fts-backup-'))
    try {
      const db = testFileDb(join(dir, 'company.db'))
      migrate(db)
      seedCompany(db, TEST_INFO)
      const a = postSimpleVoucher(db, { date: '2025-05-01', amount: 500_00, kind: 'receipt' }).id
      withNarration(db, a, 'nar backup बिल')
      await snapshotTo(db, join(dir, 'copy.db'))
      db.close()
      const copy = testFileDb(join(dir, 'copy.db'), { readonly: true })
      try {
        expect(found(copy, 'बिल')).toEqual([a])
        expect((copy.prepare("SELECT rowid FROM voucher_fts WHERE voucher_fts MATCH '\"backup\"'").all() as unknown[]).length).toBe(1)
      } finally {
        copy.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
