import { describe, it, expect } from 'vitest'
import { cmp08, gstr4 } from './gst'
import { seededDb, TEST_INFO } from '../db/testdb'
import { createLedger } from './masters'
import { saveVoucher } from './vouchers'
import type { CompanyInfo, DrCr } from '@shared/domain'

/**
 * The composition scheme against a real book.
 *
 * The engine maths lives in `src/shared/gst/composition.ts` and is unit-tested there. What can
 * only be tested here is that turnover is read out of actual vouchers -- a composition invoice
 * carries no tax lines, so the extraction has to take the line value, and getting that wrong
 * would silently under-report every filing.
 */
const COMPOSITION: CompanyInfo = { ...TEST_INFO, gstRegistrationType: 'composition', booksFrom: 2026 }

function setup() {
  const db = seededDb()
  const groupId = (name: string): number =>
    (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const vtId = (kind: string): number =>
    (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
  const L = (input: Parameters<typeof createLedger>[1]): number => createLedger(db, input).id

  const buyer = L({ name: 'Walk-in Buyer', groupId: groupId('Sundry Debtors'), stateCode: '27' })
  // No gstRate on the sales ledger: a composition dealer charges no tax, which is the point.
  const sales = L({ name: 'Sales', groupId: groupId('Sales Accounts'), hsn: '9983' })
  const purchases = L({ name: 'Purchases 18', groupId: groupId('Purchase Accounts'), gstRate: 18 })
  const rcmVendor = L({ name: 'RCM Vendor', groupId: groupId('Sundry Creditors'), stateCode: '27', rcm: true })

  const post = (kind: string, date: string, partyId: number, lines: { ledgerId: number; drCr: DrCr; amount: number }[]) =>
    saveVoucher(db, {
      voucherTypeId: vtId(kind), date, partyLedgerId: partyId, posOverride: null,
      lines: lines.map((l) => ({ ...l, costAllocations: [] })),
      inventory: [], billRefs: [], tds: null
    })

  /** A tax-free sale, the only kind a composition dealer issues. */
  const sell = (date: string, amount: number) =>
    post('sales', date, buyer, [
      { ledgerId: buyer, drCr: 'dr', amount },
      { ledgerId: sales, drCr: 'cr', amount }
    ])

  return { db, buyer, sales, purchases, rcmVendor, post, sell }
}

describe('composition scheme — CMP-08 from the books', () => {
  it('reads turnover off tax-free invoices and taxes it at the category rate', () => {
    const s = setup()
    s.sell('2026-04-10', 500000) // Rs 5,000
    s.sell('2026-05-20', 300000) // Rs 3,000
    s.sell('2026-06-30', 200000) // Rs 2,000 — the last day of Q1 must be inside it

    // Rs 10,000 turnover. A trader pays 1%: Rs 100, split 50/50.
    const trader = cmp08(s.db, COMPOSITION, '2026-04-01', '2026-06-30', 'trader')
    expect(trader.outwardTurnover).toBe(1000000)
    expect(trader.ratePercent).toBe(1)
    expect(trader.cgst).toBe(5000)
    expect(trader.sgst).toBe(5000)
    expect(trader.totalPayable).toBe(10000)

    // The same books as a restaurant: 5% of Rs 10,000 is Rs 500.
    const restaurant = cmp08(s.db, COMPOSITION, '2026-04-01', '2026-06-30', 'restaurant')
    expect(restaurant.cgst + restaurant.sgst).toBe(50000)
  })

  it('excludes sales outside the quarter', () => {
    const s = setup()
    s.sell('2026-03-31', 999900) // previous FY
    s.sell('2026-07-01', 888800) // Q2
    s.sell('2026-04-01', 100000) // the only Q1 sale
    const q1 = cmp08(s.db, COMPOSITION, '2026-04-01', '2026-06-30', 'trader')
    expect(q1.outwardTurnover).toBe(100000)
  })

  it('adds reverse-charge tax at the normal rate, on top of turnover tax and not inside it', () => {
    const s = setup()
    s.sell('2026-04-10', 1000000) // Rs 10,000 turnover -> Rs 100 at 1%
    // An RCM purchase books no tax lines; tax comes off the purchase ledger's 18% rate.
    s.post('purchase', '2026-04-15', s.rcmVendor, [
      { ledgerId: s.purchases, drCr: 'dr', amount: 2000000 },
      { ledgerId: s.rcmVendor, drCr: 'cr', amount: 2000000 }
    ])

    const c = cmp08(s.db, COMPOSITION, '2026-04-01', '2026-06-30', 'trader')
    // Turnover tax is untouched by the purchase: the reverse charge is a separate liability.
    expect(c.cgst + c.sgst).toBe(10000)
    // 18% of Rs 20,000 = Rs 3,600.
    expect(c.reverseChargeTax).toBe(360000)
    expect(c.totalPayable).toBe(370000)
  })

  it('passes interest and late fee straight through to the total', () => {
    const s = setup()
    s.sell('2026-04-10', 1000000)
    const c = cmp08(s.db, COMPOSITION, '2026-04-01', '2026-06-30', 'trader', { interest: 4500, lateFee: 20000 })
    expect(c.interest).toBe(4500)
    expect(c.lateFee).toBe(20000)
    expect(c.totalPayable).toBe(10000 + 4500 + 20000)
  })

  it('ignores a soft-deleted invoice', () => {
    const s = setup()
    const id = s.sell('2026-04-10', 1000000).id
    s.db.prepare("UPDATE vouchers SET deleted_at = '2026-04-11T00:00:00Z' WHERE id = ?").run(id)
    expect(cmp08(s.db, COMPOSITION, '2026-04-01', '2026-06-30', 'trader').outwardTurnover).toBe(0)
  })
})

describe('composition scheme — GSTR-4 for the year', () => {
  it('totals the quarters it is made of, and each quarter agrees with its own CMP-08', () => {
    const s = setup()
    s.sell('2026-05-01', 1000000) // Q1
    s.sell('2026-08-01', 2000000) // Q2
    s.sell('2026-11-01', 3000000) // Q3
    s.sell('2027-02-01', 4000000) // Q4

    const annual = gstr4(s.db, COMPOSITION, 2026, 'trader', '2027-03-31')
    expect(annual.financialYear).toBe('2026-27')
    expect(annual.missingQuarters).toEqual([])
    expect(annual.quarters.map((q) => q.quarter)).toEqual(['Q1', 'Q2', 'Q3', 'Q4'])
    expect(annual.totalTurnover).toBe(10000000) // Rs 1,00,000
    expect(annual.totalCgst + annual.totalSgst).toBe(100000) // 1% of it

    // The annual return must not be able to disagree with the quarters it presents.
    const q2 = cmp08(s.db, COMPOSITION, '2026-07-01', '2026-09-30', 'trader')
    expect(annual.quarters[1]!.cmp08).toEqual(q2)
    expect(annual.totalTurnover).toBe(annual.quarters.reduce((t, q) => t + q.cmp08.outwardTurnover, 0))
    expect(annual.totalPayable).toBe(annual.quarters.reduce((t, q) => t + q.cmp08.totalPayable, 0))
  })

  it('leaves out quarters that have not started rather than showing them as nil', () => {
    // Mid-August 2026: only Q1 is over and Q2 is running. An annual return that showed Q3 and
    // Q4 as zero would read as three filed nil quarters.
    const s = setup()
    s.sell('2026-05-01', 1000000)
    const annual = gstr4(s.db, COMPOSITION, 2026, 'trader', '2026-08-15')
    expect(annual.quarters.map((q) => q.quarter)).toEqual(['Q1', 'Q2'])
    expect(annual.missingQuarters).toEqual(['Q3', 'Q4'])
    expect(annual.totalTurnover).toBe(1000000)
  })

  it('reports a started-but-empty quarter as nil, which is a real filing', () => {
    // Nothing sold in Q2 is not the same as Q2 not having happened: CMP-08 is still due, nil.
    const s = setup()
    s.sell('2026-05-01', 1000000)
    const annual = gstr4(s.db, COMPOSITION, 2026, 'trader', '2026-12-01')
    expect(annual.quarters.map((q) => q.quarter)).toEqual(['Q1', 'Q2', 'Q3'])
    expect(annual.missingQuarters).toEqual(['Q4'])
    expect(annual.quarters[1]!.cmp08.totalPayable).toBe(0)
  })
})
