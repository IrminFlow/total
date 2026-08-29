import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import { createLedger, findOrCreateLedger } from './masters'
import { deleteVoucher, saveVoucher } from './vouchers'
import { bookEntries, recon26as } from './form26as'
import type { VoucherInputParsed } from '@shared/schemas'

type Db = ReturnType<typeof seededDb>

const OPTS = { amountTolerancePaise: 100, dateWindowDays: 7 }

function debtor(db: Db, name: string, tan: string | null = null): number {
  const group = db.prepare("SELECT id FROM groups WHERE name = 'Sundry Debtors'").get() as { id: number }
  return createLedger(db, {
    name,
    groupId: group.id,
    openingBalance: 0,
    gstin: null,
    stateCode: null,
    address: null,
    taxType: null,
    gstRate: null,
    hsn: null,
    tdsSectionId: null,
    pan: null,
    tan,
    creditDays: null,
    exportType: null
  }).id
}

/**
 * A customer settling an invoice net of the tax they withheld:
 *   Dr Cash (base - tds), Dr TDS Receivable <section> (tds), Cr Customer (base).
 * 'journal' rather than 'receipt' because a receipt must debit cash/bank for the whole debit side.
 */
function receiptWithTds(
  db: Db,
  opts: { date: string; partyLedgerId: number; base: number; tds: number; section?: string; ledgerName?: string }
): number {
  const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }
  const cash = db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }
  const name = opts.ledgerName ?? `TDS Receivable ${opts.section ?? '194J'}`
  const receivable = findOrCreateLedger(db, name, 'Duties & Taxes')
  const input: VoucherInputParsed = {
    voucherTypeId: vt.id,
    date: opts.date,
    number: undefined,
    partyLedgerId: opts.partyLedgerId,
    narration: null,
    reference: null,
    instrumentNo: null,
    instrumentDate: null,
    transporterId: null,
    vehicleNo: null,
    transportDistanceKm: null,
    posOverride: null, gstRegistrationId: null,
    currencyCode: null,
    exchangeRate: null,
    lines: [
      { ledgerId: cash.id, drCr: 'dr', amount: opts.base - opts.tds, costAllocations: [] },
      { ledgerId: receivable, drCr: 'dr', amount: opts.tds, costAllocations: [] },
      { ledgerId: opts.partyLedgerId, drCr: 'cr', amount: opts.base, costAllocations: [] }
    ],
    inventory: [],
    billRefs: [],
    tds: null
  }
  return saveVoucher(db, input).id
}

const HEADER =
  'Name of Deductor,TAN of Deductor,Section,Transaction Date,Amount Paid / Credited,Tax Deducted,TDS Deposited'

/** A TRACES-shaped Part-A export, preamble and all. */
function statement(rows: string[]): string {
  return [
    'Form 26AS',
    'PAN of Assessee: AAACT1234A',
    'Assessment Year: 2026-27',
    '',
    HEADER,
    ...rows
  ].join('\n')
}

describe('form26as service (s.199 / Rule 37BA credit reconciliation)', () => {
  it('a book TDS-receivable entry matches its 26AS row by the party master TAN', () => {
    const db = seededDb()
    const party = debtor(db, 'Bright Media Pvt Ltd', 'MUMB12345A')
    receiptWithTds(db, { date: '2025-05-10', partyLedgerId: party, base: 10000000, tds: 1000000, section: '194J' })

    const books = bookEntries(db, '2025-04-01', '2026-03-31')
    expect(books).toHaveLength(1)
    // Gross is reconstructed from the party's own credit line, not from the cash that arrived.
    expect(books[0]).toMatchObject({
      deductorName: 'Bright Media Pvt Ltd',
      deductorTan: 'MUMB12345A',
      section: '194J',
      amountPaise: 10000000,
      tdsPaise: 1000000
    })

    const r = recon26as(db, {
      text: statement(['Bright Media Pvt Ltd,MUMB12345A,194J,10-May-2025,100000.00,10000.00,10000.00']),
      from: '2025-04-01',
      to: '2026-03-31',
      ...OPTS
    })
    expect(r.problems).toEqual([])
    expect(r.result.buckets.matched.count).toBe(1)
    expect(r.result.creditAtRiskPaise).toBe(0)
    expect(r.result.unrecordedCreditPaise).toBe(0)
    // The pair carries the deductor's durable TAN from the party master.
    expect(r.result.pairs[0]!.statement!.deductorTan).toBe('MUMB12345A')
    expect(r.bookEntries[0]!.deductorTan).toBe('MUMB12345A')
    expect(r.bookEntries[0]!.tanSource).toBe('master')
  })

  it('a book entry with no 26AS row is credit at risk; an unlinked 26AS row is an investigation item', () => {
    const db = seededDb()
    const a = debtor(db, 'Bright Media Pvt Ltd')
    receiptWithTds(db, { date: '2025-05-10', partyLedgerId: a, base: 10000000, tds: 1000000, section: '194J' })

    const r = recon26as(db, {
      text: statement(['Quiet Systems LLP,DELQ98765B,194C,20-Jun-2025,50000.00,1000.00,1000.00']),
      from: '2025-04-01',
      to: '2026-03-31',
      ...OPTS
    })
    expect(r.result.buckets.missingInStatement.count).toBe(1)
    expect(r.result.buckets.missingInBooks.count).toBe(1)
    expect(r.result.buckets.matched.count).toBe(0)
    // The books claim ₹10,000 nobody has reported against this PAN — that is the cash at stake.
    expect(r.result.creditAtRiskPaise).toBe(1000000)
    // And ₹1,000 the department can see that the books have never recorded.
    expect(r.result.unrecordedCreditPaise).toBe(100000)
  })

  it('an empty 26AS is a nil reconciliation, not a crash', () => {
    const db = seededDb()
    const party = debtor(db, 'Bright Media Pvt Ltd')
    receiptWithTds(db, { date: '2025-05-10', partyLedgerId: party, base: 10000000, tds: 1000000, section: '194J' })

    // No table at all — the user pasted the wrong thing, or a blank download.
    const blank = recon26as(db, { text: '   ', from: '2025-04-01', to: '2026-03-31', ...OPTS })
    expect(blank.statementRows).toEqual([])
    expect(blank.problems.join(' ')).toMatch(/No Form 26AS Part I table found/)
    expect(blank.result.buckets.missingInStatement.count).toBe(1)
    expect(blank.result.creditAtRiskPaise).toBe(1000000)

    // A real header with nothing under it — the department has received nothing yet. Same
    // position, but the complaint has to say which of the two it was.
    const headerOnly = recon26as(db, { text: statement([]), from: '2025-04-01', to: '2026-03-31', ...OPTS })
    expect(headerOnly.problems.join(' ')).toMatch(/no data rows below it/)
    expect(headerOnly.result.buckets.missingInStatement.count).toBe(1)
  })

  it('a period with no TDS at all reconciles to nothing on both sides', () => {
    const db = seededDb()
    const party = debtor(db, 'Bright Media Pvt Ltd')
    receiptWithTds(db, { date: '2025-05-10', partyLedgerId: party, base: 10000000, tds: 1000000, section: '194J' })

    // The entry above is in FY2025-26; ask about the year before it.
    const r = recon26as(db, { text: statement([]), from: '2024-04-01', to: '2025-03-31', ...OPTS })
    expect(r.bookEntries).toEqual([])
    expect(r.result.pairs).toEqual([])
    expect(r.result.creditAtRiskPaise).toBe(0)
    expect(r.result.unrecordedCreditPaise).toBe(0)
    for (const b of Object.values(r.result.buckets)) expect(b.count).toBe(0)
  })

  it('a soft-deleted voucher is not a TDS credit', () => {
    const db = seededDb()
    const party = debtor(db, 'Bright Media Pvt Ltd')
    const keep = receiptWithTds(db, { date: '2025-05-10', partyLedgerId: party, base: 10000000, tds: 1000000, section: '194J' })
    const binned = receiptWithTds(db, { date: '2025-06-10', partyLedgerId: party, base: 5000000, tds: 500000, section: '194J' })
    expect(bookEntries(db, '2025-04-01', '2026-03-31')).toHaveLength(2)

    deleteVoucher(db, binned)
    const books = bookEntries(db, '2025-04-01', '2026-03-31')
    expect(books).toHaveLength(1)
    expect(books[0]!.voucherId).toBe(keep)
  })

  it('a short deduction is named as one rather than split into two one-sided findings', () => {
    const db = seededDb()
    const party = debtor(db, 'Bright Media Pvt Ltd')
    receiptWithTds(db, { date: '2025-05-10', partyLedgerId: party, base: 10000000, tds: 1000000, section: '194J' })

    // The deductor filed ₹9,000 against a ₹10,000 claim. Same gross, so pass 4 pairs them.
    const r = recon26as(db, {
      text: statement(['Bright Media Pvt Ltd,MUMB12345A,194J,10-May-2025,100000.00,9000.00,9000.00']),
      from: '2025-04-01',
      to: '2026-03-31',
      ...OPTS
    })
    const pair = r.result.pairs[0]!
    expect(pair.bucket).toBe('amountMismatch')
    expect(pair.tdsDiffPaise).toBe(-100000)
    // Only ₹9,000 was deposited against a ₹10,000 claim: ₹1,000 of credit will not be granted.
    expect(r.result.creditAtRiskPaise).toBe(100000)
  })

  it('tax deducted but not deposited is credit at risk even on a matched pair (s.199)', () => {
    const db = seededDb()
    const party = debtor(db, 'Bright Media Pvt Ltd')
    receiptWithTds(db, { date: '2025-05-10', partyLedgerId: party, base: 10000000, tds: 1000000, section: '194J' })

    const r = recon26as(db, {
      text: statement(['Bright Media Pvt Ltd,MUMB12345A,194J,10-May-2025,100000.00,10000.00,4000.00']),
      from: '2025-04-01',
      to: '2026-03-31',
      ...OPTS
    })
    const pair = r.result.pairs[0]!
    expect(pair.bucket).toBe('matched')
    expect(pair.notes).toContain('26AS shows less tax deposited than deducted')
    expect(r.result.creditAtRiskPaise).toBe(600000)
  })

  it('a "TDS Payable" ledger is the deductor side and never enters the 26AS book set', () => {
    const db = seededDb()
    const party = debtor(db, 'Bright Media Pvt Ltd')
    receiptWithTds(db, {
      date: '2025-05-10',
      partyLedgerId: party,
      base: 10000000,
      tds: 1000000,
      ledgerName: 'TDS Payable 194C'
    })
    expect(bookEntries(db, '2025-04-01', '2026-03-31')).toEqual([])
  })

  it('a credit to TDS receivable is a negative refund/correction, not another claim', () => {
    const db = seededDb()
    const party = debtor(db, 'Bright Media Pvt Ltd', 'MUMB12345A')
    const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }
    const cash = db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }
    const receivable = findOrCreateLedger(db, 'TDS Receivable 194J', 'Duties & Taxes')
    saveVoucher(db, {
      voucherTypeId: vt.id, date: '2025-06-20', partyLedgerId: party,
      narration: 'TDS refund / correction', reference: null, instrumentNo: null, instrumentDate: null,
      transporterId: null, vehicleNo: null, transportDistanceKm: null, posOverride: null,
      gstRegistrationId: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: party, drCr: 'dr', amount: 2000000, costAllocations: [] },
        { ledgerId: receivable, drCr: 'cr', amount: 200000, costAllocations: [] },
        { ledgerId: cash.id, drCr: 'cr', amount: 1800000, costAllocations: [] }
      ], inventory: [], billRefs: [], tds: null
    })
    const books = bookEntries(db, '2025-04-01', '2026-03-31')
    expect(books).toHaveLength(1)
    expect(books[0]).toMatchObject({ amountPaise: -2200000, tdsPaise: -200000, tanSource: 'master' })

    const r = recon26as(db, {
      text: statement(['Bright Media Pvt Ltd,MUMB12345A,194J,20-Jun-2025,(20000.00),(2000.00),(2000.00)']),
      from: '2025-04-01', to: '2026-03-31', ...OPTS
    })
    expect(r.result.buckets.matched.count).toBe(1)
    expect(r.result.creditAtRiskPaise).toBe(0)
  })

  it('a date drift across the window is its own finding — Rule 37BA puts the credit in a year', () => {
    const db = seededDb()
    const party = debtor(db, 'Bright Media Pvt Ltd')
    receiptWithTds(db, { date: '2025-04-02', partyLedgerId: party, base: 10000000, tds: 1000000, section: '194J' })

    const r = recon26as(db, {
      text: statement(['Bright Media Pvt Ltd,MUMB12345A,194J,25-Mar-2025,100000.00,10000.00,10000.00']),
      from: '2025-04-01',
      to: '2026-03-31',
      ...OPTS
    })
    const pair = r.result.pairs[0]!
    expect(pair.bucket).toBe('dateDrift')
    expect(pair.notes.join(' ')).toMatch(/different TDS quarter/)
  })

  it('nothing is persisted — a reconciliation leaves no table behind to go stale', () => {
    const db = seededDb()
    const party = debtor(db, 'Bright Media Pvt Ltd')
    receiptWithTds(db, { date: '2025-05-10', partyLedgerId: party, base: 10000000, tds: 1000000, section: '194J' })
    recon26as(db, {
      text: statement(['Bright Media Pvt Ltd,MUMB12345A,194J,10-May-2025,100000.00,10000.00,10000.00']),
      from: '2025-04-01',
      to: '2026-03-31',
      ...OPTS
    })
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((t) => t.name)
    expect(tables.filter((n) => /26as/i.test(n))).toEqual([])
  })
})
