import { describe, it, expect } from 'vitest'
import { seededDb, TEST_INFO } from '../db/testdb'
import { createLedger } from './masters'
import { saveVoucher, getLockDate } from './vouchers'
import { closePreview, postClose } from './yearEnd'
import { trialBalance } from './reports'
import { fyOf, todayISO } from '@shared/dates'
import type { VoucherInputParsed } from '@shared/schemas'

function ledgerUnder(db: ReturnType<typeof seededDb>, name: string, groupName: string): number {
  const group = db.prepare('SELECT id FROM groups WHERE name = ?').get(groupName) as { id: number }
  return createLedger(db, {
    name, groupId: group.id, openingBalance: 0, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
  }).id
}

function journal(db: ReturnType<typeof seededDb>, date: string, lines: VoucherInputParsed['lines']): ReturnType<typeof saveVoucher> {
  const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }
  return saveVoucher(db, {
    voucherTypeId: vt.id, date, number: undefined, partyLedgerId: null, narration: null, reference: null,
    instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null,
    currencyCode: null, exchangeRate: null, lines, inventory: [], billRefs: [], tds: null
  })
}

describe('year-end close', () => {
  it('previews correct nets and posts a balanced, locking closing journal', () => {
    const db = seededDb() // TEST_INFO.booksFrom = 2025
    const cashId = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const salesId = ledgerUnder(db, 'Sales Income', 'Direct Incomes')
    const rentId = ledgerUnder(db, 'Rent', 'Direct Expenses')

    // Income: Sales Income credited ₹1,000 (dr Cash / cr Sales Income) — inside FY 2025-26.
    journal(db, '2025-06-01', [
      { ledgerId: cashId, drCr: 'dr', amount: 100000, costAllocations: [] },
      { ledgerId: salesId, drCr: 'cr', amount: 100000, costAllocations: [] }
    ])
    // Expense: Rent debited ₹600 (dr Rent / cr Cash).
    journal(db, '2025-07-01', [
      { ledgerId: rentId, drCr: 'dr', amount: 60000, costAllocations: [] },
      { ledgerId: cashId, drCr: 'cr', amount: 60000, costAllocations: [] }
    ])
    // Outside the FY — must not affect the preview.
    journal(db, '2026-04-05', [
      { ledgerId: cashId, drCr: 'dr', amount: 500000, costAllocations: [] },
      { ledgerId: salesId, drCr: 'cr', amount: 500000, costAllocations: [] }
    ])

    const preview = closePreview(db, 2025)
    expect(preview.alreadyClosed).toBe(false)
    expect(preview.rows).toEqual(
      expect.arrayContaining([
        { ledgerId: salesId, name: 'Sales Income', nature: 'income', net: -100000 },
        { ledgerId: rentId, name: 'Rent', nature: 'expense', net: 60000 }
      ])
    )
    expect(preview.rows).toHaveLength(2) // the FY26-27 sale is out of range
    expect(preview.netProfit).toBe(40000)

    const result = postClose(db, TEST_INFO, 2025)
    expect(result.netProfit).toBe(40000)
    expect(result.lockedUpTo).toBe('2026-03-31')
    expect(getLockDate(db)).toBe('2026-03-31')

    const voucher = db.prepare('SELECT narration, date FROM vouchers WHERE id = ?').get(result.voucherId) as {
      narration: string
      date: string
    }
    expect(voucher.date).toBe('2026-03-31')
    expect(voucher.narration).toContain('[year-end close FY2025]')

    // The closing journal itself balances (dr Sales Income 100000 = cr Rent 60000 + cr Retained Earnings 40000).
    const lines = db
      .prepare('SELECT dr_cr AS drCr, amount FROM voucher_lines WHERE voucher_id = ?')
      .all(result.voucherId) as { drCr: 'dr' | 'cr'; amount: number }[]
    const dr = lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
    const cr = lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
    expect(dr).toBe(cr)

    // As-on 31 Mar 2026: Sales Income and Rent are fully zeroed (dropped from the trial balance,
    // which omits zero-balance ledgers); Retained Earnings carries the ₹400 profit as a credit.
    const tb = trialBalance(db, '2026-03-31')
    expect(tb.rows.find((r) => r.ledgerId === salesId)).toBeUndefined()
    expect(tb.rows.find((r) => r.ledgerId === rentId)).toBeUndefined()
    const retained = tb.rows.find((r) => r.ledgerName === 'Retained Earnings')
    expect(retained).toBeDefined()
    expect(retained!.credit).toBe(40000)
    expect(retained!.debit).toBe(0)

    // Re-closing the same FY is refused.
    expect(() => postClose(db, TEST_INFO, 2025)).toThrow(/already closed/)

    // Saving (or editing) into the now-locked period is refused.
    expect(() =>
      journal(db, '2026-01-15', [
        { ledgerId: cashId, drCr: 'dr', amount: 1000, costAllocations: [] },
        { ledgerId: salesId, drCr: 'cr', amount: 1000, costAllocations: [] }
      ])
    ).toThrow(/locked/i)
  })

  it('a loss year debits Retained Earnings instead of crediting it', () => {
    const db = seededDb()
    const cashId = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const salesId = ledgerUnder(db, 'Sales Income', 'Direct Incomes')
    const rentId = ledgerUnder(db, 'Rent', 'Direct Expenses')

    journal(db, '2025-06-01', [
      { ledgerId: cashId, drCr: 'dr', amount: 60000, costAllocations: [] },
      { ledgerId: salesId, drCr: 'cr', amount: 60000, costAllocations: [] }
    ])
    journal(db, '2025-07-01', [
      { ledgerId: rentId, drCr: 'dr', amount: 100000, costAllocations: [] },
      { ledgerId: cashId, drCr: 'cr', amount: 100000, costAllocations: [] }
    ])

    const preview = closePreview(db, 2025)
    expect(preview.netProfit).toBe(-40000)

    const result = postClose(db, TEST_INFO, 2025)
    expect(result.netProfit).toBe(-40000)

    const tb = trialBalance(db, '2026-03-31')
    const retained = tb.rows.find((r) => r.ledgerName === 'Retained Earnings')
    expect(retained!.debit).toBe(40000)
    expect(retained!.credit).toBe(0)
  })

  it('refuses to close a FY with no income/expense activity', () => {
    const db = seededDb()
    expect(() => postClose(db, TEST_INFO, 2025)).toThrow(/no income or expense activity/i)
  })

  it('refuses to close the running (not-yet-ended) financial year', () => {
    const db = seededDb()
    const currentFy = fyOf(todayISO()) // still in progress by definition — its 31 Mar is in the future
    expect(() => postClose(db, TEST_INFO, currentFy.startYear)).toThrow(/has not ended/i)
  })
})
