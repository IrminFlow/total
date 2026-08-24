import { describe, it, expect } from 'vitest'
import { partyShares } from './analysis'
import { seededDb } from '../db/testdb'
import { createLedger } from './masters'
import { saveVoucher } from './vouchers'
import type { DrCr } from '@shared/domain'

/**
 * Who the period's business actually came from.
 *
 * The concentration maths is pure and tested in concentration.test.ts. What can only be tested
 * here is the extraction: that a credit note nets against the sale it corrects, that the ranking
 * is by net rather than gross, and that the shares sum to the whole.
 */
function books() {
  const db = seededDb()
  const groupId = (name: string): number =>
    (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const vtId = (kind: string): number =>
    (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
  const L = (name: string, group: string): number =>
    createLedger(db, { name, groupId: groupId(group), stateCode: '27' }).id

  const sales = L('Sales', 'Sales Accounts')
  const purchases = L('Purchases', 'Purchase Accounts')

  const post = (kind: string, date: string, party: number, lines: { ledgerId: number; drCr: DrCr; amount: number }[]) =>
    saveVoucher(db, {
      voucherTypeId: vtId(kind), date, partyLedgerId: party, posOverride: null,
      lines: lines.map((l) => ({ ...l, costAllocations: [] })),
      inventory: [], billRefs: [], tds: null
    })

  const sell = (party: number, date: string, amount: number) =>
    post('sales', date, party, [
      { ledgerId: party, drCr: 'dr', amount },
      { ledgerId: sales, drCr: 'cr', amount }
    ])

  /** A credit note reverses a sale: the party is credited. */
  const creditNote = (party: number, date: string, amount: number) =>
    post('credit_note', date, party, [
      { ledgerId: sales, drCr: 'dr', amount },
      { ledgerId: party, drCr: 'cr', amount }
    ])

  const buy = (party: number, date: string, amount: number) =>
    post('purchase', date, party, [
      { ledgerId: purchases, drCr: 'dr', amount },
      { ledgerId: party, drCr: 'cr', amount }
    ])

  return { db, L, sell, creditNote, buy }
}

const FROM = '2026-04-01'
const TO = '2027-03-31'

describe('partyShares', () => {
  it('ranks parties by value, largest first, with shares that sum to the whole', () => {
    const b = books()
    const big = b.L('Big Customer', 'Sundry Debtors')
    const small = b.L('Small Customer', 'Sundry Debtors')
    b.sell(small, '2026-05-01', 100000)
    b.sell(big, '2026-05-02', 300000)

    const r = partyShares(b.db, 'sales', FROM, TO)
    expect(r.rows.map((x) => x.name)).toEqual(['Big Customer', 'Small Customer'])
    expect(r.total).toBe(400000)
    expect(r.rows[0]!.share).toBeCloseTo(0.75)
    expect(r.rows[1]!.share).toBeCloseTo(0.25)
    // The cumulative column is the point of the table: how many names to half the turnover.
    expect(r.rows[1]!.cumulativeShare).toBeCloseTo(1)
  })

  it('nets a credit note against the sale it corrects', () => {
    // Ranking by gross would put the wrong name at the top of a report whose whole purpose is to
    // name the right one.
    const b = books()
    const returned = b.L('Returns A Lot', 'Sundry Debtors')
    const steady = b.L('Steady Buyer', 'Sundry Debtors')
    b.sell(returned, '2026-05-01', 1000000)
    b.creditNote(returned, '2026-05-10', 800000)
    b.sell(steady, '2026-05-02', 500000)

    const r = partyShares(b.db, 'sales', FROM, TO)
    expect(r.rows.map((x) => [x.name, x.amount])).toEqual([
      ['Steady Buyer', 500000],
      ['Returns A Lot', 200000]
    ])
    // Two documents on the party who was credited, one on the other.
    expect(r.rows.find((x) => x.name === 'Returns A Lot')!.documents).toBe(2)
  })

  it('counts a party who returned more than they bought as no share at all', () => {
    // Letting a net-negative party offset a real one would understate exactly the exposure this
    // report exists to surface.
    const b = books()
    const net = b.L('Net Negative', 'Sundry Debtors')
    const real = b.L('Real Customer', 'Sundry Debtors')
    b.sell(net, '2026-05-01', 100000)
    b.creditNote(net, '2026-05-05', 300000)
    b.sell(real, '2026-05-02', 400000)

    const r = partyShares(b.db, 'sales', FROM, TO)
    expect(r.total).toBe(400000)
    expect(r.rows.find((x) => x.name === 'Real Customer')!.share).toBeCloseTo(1)
    expect(r.rows.find((x) => x.name === 'Net Negative')!.share).toBe(0)
    expect(r.concentration.partyCount).toBe(1)
  })

  it('warns when one customer is most of the book', () => {
    const b = books()
    const whale = b.L('Whale', 'Sundry Debtors')
    for (let i = 0; i < 4; i++) b.sell(b.L(`Minnow ${i}`, 'Sundry Debtors'), '2026-05-01', 100000)
    b.sell(whale, '2026-05-01', 900000)

    const r = partyShares(b.db, 'sales', FROM, TO)
    expect(r.concentration.level).toBe('concentrated')
    expect(r.concentration.warning).toMatch(/largest party/)
  })

  it('says nothing about a diversified book', () => {
    const b = books()
    for (let i = 0; i < 12; i++) b.sell(b.L(`Customer ${i}`, 'Sundry Debtors'), '2026-05-01', 100000)
    const r = partyShares(b.db, 'sales', FROM, TO)
    expect(r.concentration.level).toBe('diversified')
    expect(r.concentration.warning).toBeNull()
  })

  it('reads the purchase side from suppliers, not customers', () => {
    const b = books()
    const customer = b.L('A Customer', 'Sundry Debtors')
    const supplier = b.L('A Supplier', 'Sundry Creditors')
    b.sell(customer, '2026-05-01', 100000)
    b.buy(supplier, '2026-05-02', 700000)

    const sales = partyShares(b.db, 'sales', FROM, TO)
    const purchases = partyShares(b.db, 'purchase', FROM, TO)
    expect(sales.rows.map((x) => x.name)).toEqual(['A Customer'])
    expect(purchases.rows.map((x) => x.name)).toEqual(['A Supplier'])
    expect(purchases.total).toBe(700000)
  })

  it('excludes vouchers outside the period', () => {
    const b = books()
    const p = b.L('Customer', 'Sundry Debtors')
    b.sell(p, '2026-03-31', 900000) // previous FY
    b.sell(p, '2026-05-01', 100000)
    expect(partyShares(b.db, 'sales', FROM, TO).total).toBe(100000)
  })

  it('excludes a soft-deleted voucher', () => {
    const b = books()
    const p = b.L('Customer', 'Sundry Debtors')
    const v = b.sell(p, '2026-05-01', 100000)
    b.db.prepare("UPDATE vouchers SET deleted_at = '2026-06-01T00:00:00Z' WHERE id = ?").run(v.id)
    expect(partyShares(b.db, 'sales', FROM, TO).rows).toEqual([])
  })

  it('answers empty for a period with no party vouchers', () => {
    const b = books()
    const r = partyShares(b.db, 'sales', FROM, TO)
    expect(r.rows).toEqual([])
    expect(r.total).toBe(0)
    expect(r.concentration.warning).toBeNull()
  })
})
