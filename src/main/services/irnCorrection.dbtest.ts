// GST correction workflow (to-do: "An IRN doesn't freeze amount / party edits and binning doesn't
// cancel the IRN"): while a voucher's e-invoice IRN is LIVE (stored, no recorded cancel —
// migration "NIC e-document columns"), saveVoucher refuses date / party / amount / tax / item
// changes (irn_frozen) and the bin refuses it (irn_live); a recorded Cancel IRN lifts both. The
// cancelled IRN itself stays on the voucher (and comes back with it from the bin).
import { describe, expect, it } from 'vitest'
import type { DB } from '../db/connection'
import type { VoucherInput } from '@shared/schemas'
import { seededDb } from '../db/testdb'
import { createLedger } from './masters'
import { deleteVoucher, getVoucher, restoreVoucher, saveVoucher } from './vouchers'
import { undoSave } from './undo'
import { mapError } from '@shared/errors'
import { translator } from '@shared/i18n'

const IRN = 'c'.repeat(64)

function books(): { db: DB; sale: () => VoucherInput; id: number; other: number } {
  const db = seededDb()
  const g = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const vt = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'sales' ORDER BY id LIMIT 1").get() as { id: number }).id
  const buyer = createLedger(db, { name: 'Karnataka Buyer', groupId: g('Sundry Debtors'), gstin: '29AAACU1234F1ZM', stateCode: '29' }).id
  const other = createLedger(db, { name: 'Other Buyer', groupId: g('Sundry Debtors'), gstin: '29AAACU1234F2ZL', stateCode: '29' }).id
  const sales = createLedger(db, { name: 'Sales', groupId: g('Sales Accounts') }).id
  const igst = createLedger(db, { name: 'IGST', groupId: g('Duties & Taxes'), taxType: 'igst' }).id
  const unitId = (db.prepare("SELECT id FROM units WHERE symbol = 'Pcs'").get() as { id: number }).id
  const item = Number(db.prepare("INSERT INTO stock_items (name, unit_id, hsn, gst_rate, opening_qty_milli, opening_value) VALUES ('Chair', ?, '9401', 18, 100000, 50000000)").run(unitId).lastInsertRowid)
  const sale = (): VoucherInput => ({
    voucherTypeId: vt, date: '2026-08-15', number: 'INV-1', partyLedgerId: buyer, narration: 'first', reference: null,
    lines: [
      { ledgerId: buyer, drCr: 'dr', amount: 1_180_000, costAllocations: [] },
      { ledgerId: sales, drCr: 'cr', amount: 1_000_000, costAllocations: [] },
      { ledgerId: igst, drCr: 'cr', amount: 180_000, costAllocations: [] }
    ],
    inventory: [{ stockItemId: item, godownId: null, qtyMilli: 2000, ratePaise: 500_000, discountPaise: 0, amount: 1_000_000, direction: 'out' }],
    billRefs: [], tds: null
  })
  const id = saveVoucher(db, sale()).id
  // As generateIrn stores it (nicContract.dbtest.ts proves the live path).
  db.prepare("UPDATE vouchers SET irn = ?, irn_ack_no = '1126', irn_ack_date = '2026-08-15 11:00:00', irn_signed_qr = 'q.r.s' WHERE id = ?").run(IRN, id)
  return { db, sale, id, other }
}

const code = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (e) {
    return (e as { code?: string }).code
  }
  return undefined
}

const cancel = (db: DB, id: number): void => {
  db.prepare("UPDATE vouchers SET irn_cancelled_at = '2026-08-15 13:00:00', irn_cancel_reason = 'data_entry_mistake', irn_cancel_remark = 'wrong rate' WHERE id = ?").run(id)
}

describe('a live IRN freezes the e-invoiced facts', () => {
  it('narration / reference edits go through and keep the IRN', () => {
    const { db, sale, id } = books()
    saveVoucher(db, { ...sale(), narration: 'checked', reference: 'PO-9' }, id)
    expect(getVoucher(db, id)).toMatchObject({ narration: 'checked', reference: 'PO-9', irn: IRN })
  })

  it('refuses a change of amount, tax, party, date, place of supply or items — irn_frozen, no field, nothing written', () => {
    const { db, sale, id, other } = books()
    const s = sale()
    const changes: [string, VoucherInput][] = [
      ['amount + tax', { ...s, lines: [{ ...s.lines[0]!, amount: 1_298_000 }, { ...s.lines[1]!, amount: 1_100_000 }, { ...s.lines[2]!, amount: 198_000 }], inventory: [{ ...s.inventory![0]!, ratePaise: 550_000, amount: 1_100_000 }] }],
      ['tax ledger', { ...s, lines: [s.lines[0]!, { ...s.lines[1]!, amount: 1_180_000 }] }],
      ['party', { ...s, partyLedgerId: other, lines: [{ ...s.lines[0]!, ledgerId: other }, s.lines[1]!, s.lines[2]!] }],
      ['date', { ...s, date: '2026-08-16' }],
      ['place of supply', { ...s, posOverride: '27' }],
      ['item quantity', { ...s, inventory: [{ ...s.inventory![0]!, qtyMilli: 1000, ratePaise: 1_000_000 }] }]
    ]
    const before = JSON.stringify(getVoucher(db, id))
    const audits = (db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n
    for (const [what, input] of changes) {
      let err: { code?: string; field?: string; message?: string } = {}
      try {
        saveVoucher(db, input, id)
      } catch (e) {
        err = e as typeof err
      }
      expect({ what, code: err.code, field: err.field }).toEqual({ what, code: 'irn_frozen', field: undefined })
      expect(err.message).toMatch(/Cancel the IRN first/)
    }
    expect(JSON.stringify(getVoucher(db, id))).toBe(before)
    expect((db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n).toBe(audits)
  })

  it('the bin refuses it (irn_live) — undo too; a cancelled IRN lifts both freeze and bin, and restore brings it back with the cancel', () => {
    const { db, sale, id } = books()
    expect(code(() => deleteVoucher(db, id))).toBe('irn_live')
    expect(code(() => undoSave(db, [id]))).toMatch(/^(irn_live|undo_edited)$/)
    expect(getVoucher(db, id)!.deletedAt).toBeNull()

    cancel(db, id)
    // Edits are allowed again, the number too (the corrected invoice gets a new one) …
    saveVoucher(db, { ...sale(), number: 'INV-1A', date: '2026-08-16', narration: 'corrected' }, id)
    expect(getVoucher(db, id)).toMatchObject({ number: 'INV-1A', date: '2026-08-16', irn: IRN })
    // … and so is the bin; restore keeps the cancelled IRN and its record.
    deleteVoucher(db, id)
    expect(getVoucher(db, id)!.deletedAt).not.toBeNull()
    restoreVoucher(db, id)
    expect(getVoucher(db, id)!.deletedAt).toBeNull()
    expect(db.prepare('SELECT irn, irn_cancelled_at AS at, irn_cancel_reason AS r FROM vouchers WHERE id = ?').get(id))
      .toEqual({ irn: IRN, at: '2026-08-15 13:00:00', r: 'data_entry_mistake' })
  })

  it('a voucher without an IRN is untouched by the rule', () => {
    const { db, sale } = books()
    const id = saveVoucher(db, { ...sale(), number: 'INV-2' }).id
    saveVoucher(db, { ...sale(), number: 'INV-2', date: '2026-08-17' }, id)
    deleteVoucher(db, id)
    expect(getVoucher(db, id)!.deletedAt).not.toBeNull()
  })

  it('both codes have plain messages in en / hi / hinglish, with no field', () => {
    for (const c of ['irn_frozen', 'irn_live'] as const) {
      for (const lang of ['en', 'hi', 'hinglish'] as const) {
        const t = translator(lang)
        const m = mapError({ code: c, message: 'service text' }, { fields: ['date', 'party', 'number'], t, simple: true })
        expect(m.fields).toEqual({})
        expect(m.general ?? '').toMatch(lang === 'hi' ? /ई-इनवॉइस/ : /e-invoice/)
      }
    }
  })
})
