// WP 2.5a numbering: nextSeriesNumber is the old nextVoucherNumber body (identical output), and
// order / quotation series number the same way; the voucher_kinds list; series CRUD.
import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import { nextSeriesNumber } from './numbering'
import { nextVoucherNumber } from './vouchers'
import { listTradeDocTypes, listVoucherKinds, nextTradeDocNumber, saveTradeDocType } from './tradeDocTypes'
import { tradeDocTypeSaveSchema, openSourceLinesSchema } from '@shared/schemas'
import { VOUCHER_KINDS } from '@shared/domain'
import { createVoucherType } from './masters'

describe('nextSeriesNumber', () => {
  it('is exactly nextVoucherNumber for voucher series (prefix, suffix, pad, FY restart, binned rows)', () => {
    const db = seededDb()
    const cases = [
      { name: 'A', prefix: 'INV-', suffix: '/25-26', padWidth: 3, restartFy: true },
      { name: 'B', prefix: '', suffix: '', padWidth: 0, restartFy: false },
      { name: 'C', prefix: 'X', suffix: '', padWidth: 5, restartFy: true }
    ]
    for (const c of cases) {
      const vt = createVoucherType(db, { ...c, kind: 'journal', numbering: 'auto' })
      const ins = db.prepare("INSERT INTO vouchers (voucher_type_id, date, number, deleted_at) VALUES (?, ?, ?, ?)")
      ins.run(vt.id, '2025-05-01', `${c.prefix}007${c.suffix}`, null)
      ins.run(vt.id, '2025-06-01', `${c.prefix}12${c.suffix}`, '2025-06-02') // binned: still counts
      ins.run(vt.id, '2024-06-01', `${c.prefix}99${c.suffix}`, null) // last FY
      ins.run(vt.id, '2025-07-01', 'junk', null)
      for (const date of ['2025-08-01', '2024-08-01', '2026-04-02']) {
        const want = nextVoucherNumber(db, vt.id, date)
        expect(nextSeriesNumber(db, { table: 'vouchers', typeColumn: 'voucher_type_id', type: { id: vt.id, ...c }, date })).toBe(want)
      }
    }
    expect(nextVoucherNumber(db, createVoucherType(db, { ...cases[0]!, name: 'D', kind: 'journal', numbering: 'auto' }).id, '2025-05-01')).toBe('INV-001/25-26')
  })
})

describe('order / quotation series', () => {
  it('seeds three, numbers per FY by prefix, binned documents still count', () => {
    const db = seededDb()
    const types = listTradeDocTypes(db)
    expect(types.map((t) => [t.name, t.kind, t.prefix, t.isSystem])).toEqual([
      ['Quotation', 'quotation', 'QT-', true], ['Sales Order', 'sales_order', 'SO-', true], ['Purchase Order', 'purchase_order', 'PO-', true]
    ])
    const so = types[1]!
    expect(nextTradeDocNumber(db, so.id, '2025-05-01')).toBe('SO-1')
    const party = (db.prepare('SELECT id FROM ledgers LIMIT 1').get() as { id: number }).id
    db.prepare("INSERT INTO trade_docs (doc_type_id, number, date, party_ledger_id, deleted_at) VALUES (?, 'SO-4', '2025-05-01', ?, '2025-05-02')").run(so.id, party)
    expect(nextTradeDocNumber(db, so.id, '2025-05-09')).toBe('SO-5')
    expect(nextTradeDocNumber(db, so.id, '2026-04-09')).toBe('SO-1')
  })

  it('saves series knobs; system series keep name and kind; a used series keeps its kind', () => {
    const db = seededDb()
    const qt = listTradeDocTypes(db)[0]!
    const altered = saveTradeDocType(db, tradeDocTypeSaveSchema.parse({ id: qt.id, data: { name: 'Renamed', kind: 'sales_order', prefix: 'Q/', padWidth: 4 } }).data, qt.id)
    expect(altered).toMatchObject({ name: 'Quotation', kind: 'quotation', prefix: 'Q/', padWidth: 4, restartFy: true })
    expect(nextTradeDocNumber(db, qt.id, '2025-05-01')).toBe('Q/0001')
    const own = saveTradeDocType(db, tradeDocTypeSaveSchema.parse({ data: { name: 'Export Orders', kind: 'sales_order', prefix: 'EXP-' } }).data)
    expect(own).toMatchObject({ name: 'Export Orders', kind: 'sales_order', isSystem: false })
    expect(saveTradeDocType(db, { ...own, kind: 'purchase_order', restartFy: false }, own.id)).toMatchObject({ kind: 'purchase_order', restartFy: false })
    const party = (db.prepare('SELECT id FROM ledgers LIMIT 1').get() as { id: number }).id
    db.prepare("INSERT INTO trade_docs (doc_type_id, number, date, party_ledger_id) VALUES (?, 'EXP-1', '2025-05-01', ?)").run(own.id, party)
    expect(saveTradeDocType(db, { ...own, kind: 'quotation' }, own.id).kind).toBe('purchase_order')
    expect(() => saveTradeDocType(db, { ...own, name: 'Quotation' })).toThrow(/UNIQUE/)
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'tradeDocType'").get()).toEqual({ n: 4 })
    expect(() => tradeDocTypeSaveSchema.parse({ data: { name: 'X', kind: 'delivery_note' } })).toThrow()
  })
})

describe('voucher kinds', () => {
  it('lists the lookup table in VOUCHER_KINDS order with the stock-only flag', () => {
    const rows = listVoucherKinds(seededDb())
    expect(rows.map((r) => r.kind)).toEqual([...VOUCHER_KINDS])
    expect(rows.filter((r) => r.stockOnly).map((r) => r.kind)).toEqual(['stock_journal', 'physical_stock', 'delivery_note', 'receipt_note'])
  })

  it('links IPC payloads are Zod-validated', () => {
    expect(openSourceLinesSchema.parse({ partyLedgerId: 3, targetKind: 'sales' })).toEqual({ partyLedgerId: 3, targetKind: 'sales', linkType: 'fulfil' })
    expect(openSourceLinesSchema.parse({ partyLedgerId: 3, targetKind: 'sales_order', linkType: 'fulfil' }).targetKind).toBe('sales_order')
    expect(() => openSourceLinesSchema.parse({ partyLedgerId: 3, targetKind: 'bogus' })).toThrow()
    expect(() => openSourceLinesSchema.parse({ partyLedgerId: 0, targetKind: 'sales' })).toThrow()
  })
})
