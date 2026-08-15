import { describe, it, expect } from 'vitest'
import { seededDb, postSimpleVoucher } from '../db/testdb'
import { getVoucher, saveVoucher } from './vouchers'
import { createLedger } from './masters'

describe('saveVoucher / getVoucher round-trip', () => {
  it('persists lines in order with the right amounts, and getVoucher reads them back deeply', () => {
    const db = seededDb()
    const saved = postSimpleVoucher(db, { date: '2025-04-10', amount: 150000, kind: 'receipt' })

    const fetched = getVoucher(db, saved.id)
    expect(fetched).not.toBeNull()
    expect(fetched!.date).toBe('2025-04-10')
    expect(fetched!.lines).toHaveLength(2)

    // Order preserved (dr Cash first, cr Sales Account second, per postSimpleVoucher).
    expect(fetched!.lines[0]).toMatchObject({ drCr: 'dr', amount: 150000 })
    expect(fetched!.lines[1]).toMatchObject({ drCr: 'cr', amount: 150000 })

    const cashLedger = db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }
    expect(fetched!.lines[0]!.ledgerId).toBe(cashLedger.id)
  })

  it('update replaces the line set rather than appending to it', () => {
    const db = seededDb()
    const voucherTypeId = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }).id
    const cashId = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const otherLedger = createLedger(db, {
      name: 'Consultancy Income',
      groupId: (db.prepare("SELECT id FROM groups WHERE name = 'Direct Incomes'").get() as { id: number }).id,
      openingBalance: 0,
      gstin: null,
      stateCode: null,
      address: null,
      taxType: null,
      gstRate: null,
      hsn: null
    })

    const created = saveVoucher(db, {
      voucherTypeId,
      date: '2025-05-01',
      partyLedgerId: null,
      narration: 'first cut',
      reference: null,
      instrumentNo: null,
      instrumentDate: null,
      transporterId: null,
      vehicleNo: null,
      transportDistanceKm: null,
      currencyCode: null,
      exchangeRate: null,
      lines: [
        { ledgerId: cashId, drCr: 'dr', amount: 10000, costAllocations: [] },
        { ledgerId: otherLedger.id, drCr: 'cr', amount: 10000, costAllocations: [] }
      ],
      inventory: [],
      billRefs: [],
      tds: null
    })

    const updated = saveVoucher(
      db,
      {
        voucherTypeId,
        date: '2025-05-01',
        partyLedgerId: null,
        narration: 'corrected amount',
        reference: null,
        instrumentNo: null,
        instrumentDate: null,
        transporterId: null,
        vehicleNo: null,
        transportDistanceKm: null,
        currencyCode: null,
        exchangeRate: null,
        lines: [
          { ledgerId: cashId, drCr: 'dr', amount: 25000, costAllocations: [] },
          { ledgerId: otherLedger.id, drCr: 'cr', amount: 25000, costAllocations: [] }
        ],
        inventory: [],
        billRefs: [],
        tds: null
      },
      created.id
    )

    expect(updated.id).toBe(created.id)
    expect(updated.lines).toHaveLength(2)
    expect(updated.lines.map((l) => l.amount)).toEqual([25000, 25000])
    expect(updated.narration).toBe('corrected amount')

    const lineCount = db.prepare('SELECT COUNT(*) AS n FROM voucher_lines WHERE voucher_id = ?').get(created.id) as {
      n: number
    }
    expect(lineCount.n).toBe(2)
  })

  it('writes a create row and an update row to audit_log', () => {
    const db = seededDb()
    const saved = postSimpleVoucher(db, { date: '2025-06-01', amount: 5000, kind: 'receipt' })
    saveVoucher(
      db,
      {
        voucherTypeId: saved.voucherTypeId,
        date: saved.date,
        partyLedgerId: null,
        narration: 'edited',
        reference: null,
        instrumentNo: null,
        instrumentDate: null,
        transporterId: null,
        vehicleNo: null,
        transportDistanceKm: null,
        currencyCode: null,
        exchangeRate: null,
        lines: saved.lines.map((l) => ({ ledgerId: l.ledgerId, drCr: l.drCr, amount: l.amount, costAllocations: [] })),
        inventory: [],
        billRefs: [],
        tds: null
      },
      saved.id
    )

    const rows = db
      .prepare("SELECT action FROM audit_log WHERE entity = 'voucher' AND entity_id = ? ORDER BY id")
      .all(saved.id) as { action: string }[]
    expect(rows.map((r) => r.action)).toEqual(['create', 'update'])
  })
})
