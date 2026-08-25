import { describe, expect, it } from 'vitest'
import { postSimpleVoucher, seededDb } from '../db/testdb'
import { dayBook } from './reports'
import { getVoucher, saveVoucher } from './vouchers'
import { addVoucherComment, listVoucherComments, reverseVoucher, reverseVouchers, reviewVouchers, tagVouchers } from './voucherWorkflow'

describe('linked voucher reversals', () => {
  it('creates an immutable side-flipped voucher and a bidirectional trace', () => {
    const db = seededDb()
    const source = postSimpleVoucher(db, { date: '2026-08-01', amount: 125_000, kind: 'journal' })
    const reversal = reverseVoucher(db, {
      id: source.id,
      date: '2026-08-24',
      reason: 'Duplicate entry posted during import',
      author: 'Asha'
    })

    expect(reversal).toMatchObject({
      reversalOfId: source.id,
      reversalReason: 'Duplicate entry posted during import',
      reversalAuthor: 'Asha'
    })
    expect(reversal.lines.map((line) => line.drCr)).toEqual(source.lines.map((line) => line.drCr === 'dr' ? 'cr' : 'dr'))
    expect(getVoucher(db, source.id)?.reversedById).toBe(reversal.id)

    const balance = db.prepare(
      `SELECT SUM(CASE WHEN dr_cr = 'dr' THEN amount ELSE -amount END) AS amount
       FROM voucher_lines WHERE voucher_id IN (?, ?)`
    ).get(source.id, reversal.id) as { amount: number }
    expect(balance.amount).toBe(0)
    expect(() => saveVoucher(db, {
      voucherTypeId: source.voucherTypeId,
      date: source.date,
      partyLedgerId: null,
      narration: 'rewrite history',
      reference: null,
      instrumentNo: null,
      instrumentDate: null,
      transporterId: null,
      vehicleNo: null,
      transportDistanceKm: null,
      currencyCode: null,
      exchangeRate: null,
      lines: source.lines.map((line) => ({ ledgerId: line.ledgerId, drCr: line.drCr, amount: line.amount, costAllocations: [] })),
      inventory: [], billRefs: [], tds: null
    }, source.id)).toThrow('immutable')
  })

  it('uses a credit note to reverse sales and inverts named bill references', () => {
    const db = seededDb()
    const source = postSimpleVoucher(db, { date: '2026-08-01', amount: 50_000, kind: 'sales' })
    db.prepare('UPDATE vouchers SET party_ledger_id = ? WHERE id = ?').run(source.lines[0]!.ledgerId, source.id)
    db.prepare(
      `INSERT INTO bill_refs (voucher_id, party_ledger_id, kind, name, amount, due_date)
       VALUES (?, ?, 'new', 'INV-TEST', 50000, '2026-08-31')`
    ).run(source.id, source.lines[0]!.ledgerId)

    const reversal = reverseVoucher(db, { id: source.id, date: '2026-08-24', reason: 'Customer invoice cancelled', author: 'Owner' })
    const kind = db.prepare('SELECT kind FROM voucher_types WHERE id = ?').get(reversal.voucherTypeId) as { kind: string }
    expect(kind.kind).toBe('credit_note')
    expect(reversal.billRefs).toEqual([{ kind: 'against', name: 'INV-TEST', amount: 50_000, dueDate: null }])
  })

  it('rolls the entire batch back when any selected voucher is invalid', () => {
    const db = seededDb()
    const source = postSimpleVoucher(db, { date: '2026-08-01', amount: 10_000, kind: 'journal' })
    expect(() => reverseVouchers(db, [source.id, 999_999], '2026-08-24', 'Batch correction', 'Owner')).toThrow('not found')
    expect(getVoucher(db, source.id)?.reversedById).toBeNull()
    expect((db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n).toBe(1)
  })
})

describe('voucher batch metadata', () => {
  it('persists deduplicated tags and auditable review state in the Day Book', () => {
    const db = seededDb()
    const voucher = postSimpleVoucher(db, { date: '2026-08-01', amount: 10_000, kind: 'journal' })
    tagVouchers(db, [voucher.id], ' Needs   GST ', 'Asha')
    tagVouchers(db, [voucher.id], 'needs gst', 'Asha')
    reviewVouchers(db, [voucher.id], 'Kabir')

    expect(dayBook(db, '2026-08-01', '2026-08-31')[0]).toMatchObject({
      tags: ['Needs GST'], reviewedBy: 'Kabir', reversalOfId: null, reversedById: null
    })
    expect((db.prepare('SELECT COUNT(*) AS n FROM voucher_tags').get() as { n: number }).n).toBe(1)
  })

  it('keeps append-only review comments outside voucher narration', () => {
    const db = seededDb()
    const voucher = postSimpleVoucher(db, { date: '2026-08-01', amount: 10_000, kind: 'journal' })
    addVoucherComment(db, voucher.id, '  Confirm the supporting invoice.  ', 'Asha')
    addVoucherComment(db, voucher.id, 'Confirmed by the supplier.', 'Kabir')

    expect(listVoucherComments(db, voucher.id)).toMatchObject([
      { voucherId: voucher.id, body: 'Confirm the supporting invoice.', createdBy: 'Asha' },
      { voucherId: voucher.id, body: 'Confirmed by the supplier.', createdBy: 'Kabir' }
    ])
    expect(getVoucher(db, voucher.id)?.narration ?? '').not.toContain('supporting invoice')
    expect(() => addVoucherComment(db, voucher.id, ' ', 'Asha')).toThrow('between 1 and 2,000')
  })
})
