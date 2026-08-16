import { describe, it, expect } from 'vitest'
import { seededDb, postSimpleVoucher } from '../db/testdb'
import { deleteVoucher, getVoucher, nextVoucherNumber, saveVoucher } from './vouchers'
import { createLedger, createVoucherType } from './masters'

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
      hsn: null,
      tdsSectionId: null,
      pan: null,
      creditDays: null,
      exportType: null
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

describe('nextVoucherNumber — suffix/pad/restart (task 2.12)', () => {
  function postJournal(db: ReturnType<typeof seededDb>, voucherTypeId: number, date: string, number?: string) {
    const cashId = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const incomeGroupId = (db.prepare("SELECT id FROM groups WHERE name = 'Direct Incomes'").get() as { id: number }).id
    const otherId = createLedger(db, {
      name: `Other ${Math.random()}`,
      groupId: incomeGroupId,
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
    }).id
    return saveVoucher(db, {
      voucherTypeId,
      date,
      number,
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
        { ledgerId: cashId, drCr: 'dr', amount: 10000, costAllocations: [] },
        { ledgerId: otherId, drCr: 'cr', amount: 10000, costAllocations: [] }
      ],
      inventory: [],
      billRefs: [],
      tds: null
    })
  }

  it('applies prefix + zero-padded sequence + suffix, e.g. INV-001/24-25', () => {
    const db = seededDb()
    const vt = createVoucherType(db, {
      name: 'Tax Invoice', kind: 'journal', numbering: 'auto', prefix: 'INV-', suffix: '/24-25', padWidth: 3, restartFy: true
    })
    expect(nextVoucherNumber(db, vt.id, '2024-06-15')).toBe('INV-001/24-25')
    const v1 = postJournal(db, vt.id, '2024-06-15')
    expect(v1.number).toBe('INV-001/24-25')
    expect(nextVoucherNumber(db, vt.id, '2024-07-01')).toBe('INV-002/24-25')
  })

  it('restartFy true (the default) resets the sequence to 1 in a new financial year', () => {
    const db = seededDb()
    const vt = createVoucherType(db, {
      name: 'FY Reset', kind: 'journal', numbering: 'auto', prefix: '', suffix: '', padWidth: 0, restartFy: true
    })
    const v1 = postJournal(db, vt.id, '2024-06-15')
    expect(v1.number).toBe('1')
    const v2 = postJournal(db, vt.id, '2024-07-01')
    expect(v2.number).toBe('2')
    // 2025-04-15 is the next financial year (FY2025-26) — the scan window resets.
    expect(nextVoucherNumber(db, vt.id, '2025-04-15')).toBe('1')
  })

  it('restartFy false keeps one running sequence across financial years', () => {
    const db = seededDb()
    const vt = createVoucherType(db, {
      name: 'No Reset', kind: 'journal', numbering: 'auto', prefix: '', suffix: '', padWidth: 0, restartFy: false
    })
    const v1 = postJournal(db, vt.id, '2024-06-15')
    expect(v1.number).toBe('1')
    // Crossing into FY2025-26 does NOT reset — it continues from the running max.
    const v2 = postJournal(db, vt.id, '2025-04-15')
    expect(v2.number).toBe('2')
    expect(nextVoucherNumber(db, vt.id, '2026-04-01')).toBe('3')
  })

  it('a deleted (binned) voucher still counts toward the next number — it is never reissued', () => {
    const db = seededDb()
    const vt = createVoucherType(db, {
      name: 'Bin Aware', kind: 'journal', numbering: 'auto', prefix: '', suffix: '', padWidth: 0, restartFy: true
    })
    const v1 = postJournal(db, vt.id, '2024-06-15')
    expect(v1.number).toBe('1')
    deleteVoucher(db, v1.id)
    // Number 1 is now sitting on a binned voucher — the next auto number must skip past it.
    expect(nextVoucherNumber(db, vt.id, '2024-07-01')).toBe('2')
    const v2 = postJournal(db, vt.id, '2024-07-01')
    expect(v2.number).toBe('2')
  })
})
