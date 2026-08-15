import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import { createLedger } from './masters'
import { saveVoucher, getVoucher } from './vouchers'
import { outstandings, openBills } from './analysis'
import type { VoucherInputParsed } from '@shared/schemas'

function debtorLedger(db: ReturnType<typeof seededDb>, name: string, creditDays: number | null = null) {
  const group = db.prepare("SELECT id FROM groups WHERE name = 'Sundry Debtors'").get() as { id: number }
  return createLedger(db, {
    name, groupId: group.id, openingBalance: 0, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays, exportType: null
  })
}

function salesLedgerId(db: ReturnType<typeof seededDb>): number {
  const existing = db.prepare("SELECT id FROM ledgers WHERE name = 'Sales Account'").get() as { id: number } | undefined
  if (existing) return existing.id
  const group = db.prepare("SELECT id FROM groups WHERE name = 'Sales Accounts'").get() as { id: number }
  return createLedger(db, {
    name: 'Sales Account', groupId: group.id, openingBalance: 0, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
  }).id
}

function salesVoucher(
  db: ReturnType<typeof seededDb>,
  opts: { date: string; number: string; partyLedgerId: number; amount: number; billRefs?: VoucherInputParsed['billRefs'] }
) {
  const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'sales'").get() as { id: number }
  return saveVoucher(db, {
    voucherTypeId: vt.id, date: opts.date, number: opts.number, partyLedgerId: opts.partyLedgerId,
    narration: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null,
    vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
    lines: [
      { ledgerId: opts.partyLedgerId, drCr: 'dr', amount: opts.amount, costAllocations: [] },
      { ledgerId: salesLedgerId(db), drCr: 'cr', amount: opts.amount, costAllocations: [] }
    ],
    inventory: [], billRefs: opts.billRefs ?? [], tds: null
  })
}

function receiptVoucher(
  db: ReturnType<typeof seededDb>,
  opts: { date: string; number: string; partyLedgerId: number; amount: number; billRefs?: VoucherInputParsed['billRefs'] }
) {
  const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'receipt'").get() as { id: number }
  const cash = db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }
  return saveVoucher(db, {
    voucherTypeId: vt.id, date: opts.date, number: opts.number, partyLedgerId: opts.partyLedgerId,
    narration: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null,
    vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
    lines: [
      { ledgerId: cash.id, drCr: 'dr', amount: opts.amount, costAllocations: [] },
      { ledgerId: opts.partyLedgerId, drCr: 'cr', amount: opts.amount, costAllocations: [] }
    ],
    inventory: [], billRefs: opts.billRefs ?? [], tds: null
  })
}

describe('bill refs — saveVoucher persistence + getVoucher round-trip', () => {
  it('persists billRefs and reads them back in order', () => {
    const db = seededDb()
    const party = debtorLedger(db, 'Umbrella Retail')
    const saved = salesVoucher(db, {
      date: '2025-05-01', number: 'SV-1', partyLedgerId: party.id, amount: 10000,
      billRefs: [{ kind: 'new', name: 'SV-1', amount: 10000, dueDate: '2025-05-31' }]
    })
    const fetched = getVoucher(db, saved.id)!
    expect(fetched.billRefs).toEqual([{ kind: 'new', name: 'SV-1', amount: 10000, dueDate: '2025-05-31' }])
  })

  it('replaces billRefs on update rather than appending', () => {
    const db = seededDb()
    const party = debtorLedger(db, 'Umbrella Retail')
    const saved = salesVoucher(db, {
      date: '2025-05-01', number: 'SV-1', partyLedgerId: party.id, amount: 10000,
      billRefs: [{ kind: 'new', name: 'SV-1', amount: 10000, dueDate: null }]
    })
    const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'sales'").get() as { id: number }
    saveVoucher(
      db,
      {
        voucherTypeId: vt.id, date: '2025-05-01', number: 'SV-1', partyLedgerId: party.id, narration: null,
        reference: null, instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
        transportDistanceKm: null, currencyCode: null, exchangeRate: null,
        lines: [
          { ledgerId: party.id, drCr: 'dr', amount: 10000, costAllocations: [] },
          { ledgerId: salesLedgerId(db), drCr: 'cr', amount: 10000, costAllocations: [] }
        ],
        inventory: [], billRefs: [{ kind: 'new', name: 'SV-1-renamed', amount: 10000, dueDate: '2025-06-15' }], tds: null
      },
      saved.id
    )
    const fetched = getVoucher(db, saved.id)!
    expect(fetched.billRefs).toEqual([{ kind: 'new', name: 'SV-1-renamed', amount: 10000, dueDate: '2025-06-15' }])
  })
})

describe('outstandings — named against-settlement + due-date buckets', () => {
  it('a named against-ref settles the exact bill it names', () => {
    const db = seededDb()
    const party = debtorLedger(db, 'Umbrella Retail')
    salesVoucher(db, {
      date: '2025-05-01', number: 'SV-1', partyLedgerId: party.id, amount: 10000,
      billRefs: [{ kind: 'new', name: 'SV-1', amount: 10000, dueDate: null }]
    })
    receiptVoucher(db, {
      date: '2025-05-20', number: 'RCPT-1', partyLedgerId: party.id, amount: 10000,
      billRefs: [{ kind: 'against', name: 'SV-1', amount: 10000, dueDate: null }]
    })
    const parties = outstandings(db, 'receivable', '2025-06-01')
    expect(parties.find((p) => p.ledgerId === party.id)).toBeUndefined()
  })

  it('buckets on days overdue from the due date (credit_days-derived) rather than bill age', () => {
    const db = seededDb()
    const party = debtorLedger(db, 'Umbrella Retail', 30) // credit_days = 30
    salesVoucher(db, {
      date: '2025-05-01', number: 'SV-1', partyLedgerId: party.id, amount: 10000,
      billRefs: [{ kind: 'new', name: 'SV-1', amount: 10000, dueDate: null }]
    })
    // asOn is only 5 days after the bill date, but the bill is due 2025-05-31 (30 credit days) —
    // by 2025-07-01 it's 31 days PAST due, landing in the 31-60 bucket, not the 0-30 "age" bucket
    // a bill-date-only bucketing would have produced.
    const parties = outstandings(db, 'receivable', '2025-07-01')
    const p = parties.find((pp) => pp.ledgerId === party.id)!
    expect(p.bills[0]!.dueDate).toBe('2025-05-31')
    expect(p.bills[0]!.overdueDays).toBe(31)
    expect(p.buckets).toEqual([0, 10000, 0, 0])
  })
})

describe('outstandings — refless legacy behavior is unchanged by the allocateBills refactor', () => {
  it('FIFO-settles oldest bills first, leaving the newest bill open for the remainder', () => {
    const db = seededDb()
    const party = debtorLedger(db, 'Umbrella Retail')
    salesVoucher(db, { date: '2025-05-01', number: 'SV-1', partyLedgerId: party.id, amount: 10000 })
    salesVoucher(db, { date: '2025-05-10', number: 'SV-2', partyLedgerId: party.id, amount: 5000 })
    receiptVoucher(db, { date: '2025-05-15', number: 'RCPT-1', partyLedgerId: party.id, amount: 12000 })

    const parties = outstandings(db, 'receivable', '2025-06-01')
    const p = parties.find((pp) => pp.ledgerId === party.id)!
    expect(p.bills).toHaveLength(1)
    expect(p.bills[0]).toMatchObject({ number: 'SV-2', amount: 5000, pending: 3000 })
    expect(p.pending).toBe(3000)
  })
})

describe('openBills', () => {
  it('returns the same open-bill set as outstandings(), scoped to one party', () => {
    const db = seededDb()
    const party = debtorLedger(db, 'Umbrella Retail')
    salesVoucher(db, { date: '2025-05-01', number: 'SV-1', partyLedgerId: party.id, amount: 10000 })
    salesVoucher(db, { date: '2025-05-10', number: 'SV-2', partyLedgerId: party.id, amount: 5000 })
    receiptVoucher(db, { date: '2025-05-15', number: 'RCPT-1', partyLedgerId: party.id, amount: 12000 })

    const bills = openBills(db, party.id, '2025-06-01')
    expect(bills).toHaveLength(1)
    expect(bills[0]).toMatchObject({ number: 'SV-2', pending: 3000 })
  })

  it('returns an empty array for an unknown ledger id', () => {
    const db = seededDb()
    expect(openBills(db, 999999, '2025-06-01')).toEqual([])
  })
})
