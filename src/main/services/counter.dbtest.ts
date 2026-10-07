// WP 2.6 — counter billing posts a normal sales invoice (+ a receipt against its bill) through
// saveVoucher: balanced, correct GST and round-off, split payments, change, walk-in rules, held
// bills, the day-end summary and the thermal receipt print.
import { describe, it, expect } from 'vitest'
import { imbalance, pricingFixture } from './pricingFixture.testutil'
import {
  counterAccounts, counterCheckout, counterDayEnd, counterQuote, discardHeldBill, getCounterConfig, holdBill, listHeldBills,
  recallHeldBill, setCounterConfig, WALK_IN_NAME
} from './counter'
import { deleteVoucher, getVoucher } from './vouchers'
import { documentHtml, getTemplate } from './printTemplates'
import { listPartyRates, setPricingConfig } from './pricing'
import { TEST_INFO } from '../db/testdb'
import { openBills } from './analysis'

const DATE = '2025-10-07'
const ledgerName = (db: ReturnType<typeof pricingFixture>['db'], id: number): string => (db.prepare('SELECT name FROM ledgers WHERE id = ?').get(id) as { name: string }).name

describe('counter checkout', () => {
  it('a walk-in sale with cash + UPI: balanced invoice with GST and round-off, a receipt against its bill, change', () => {
    const { db, pen, tea, bank, cash, sales } = pricingFixture()
    // 3 pens @ ₹10.99 (18%) + 1 tea @ ₹47.50 less ₹2.50 (12% + 12% cess).
    const lines = [
      { itemId: pen, qtyMilli: 3000, ratePaise: 1099, discountPaise: 0 },
      { itemId: tea, qtyMilli: 1000, ratePaise: 4750, discountPaise: 250 }
    ]
    const quote = counterQuote(db, TEST_INFO, { date: DATE, lines })
    // pens 32.97 → CGST/SGST 2.97 each (9% of 32.97 = 2.9673); tea 45.00 → 2.70 + 2.70, cess 5.40.
    expect(quote).toMatchObject({ taxable: 7797, cgst: 297 + 270, sgst: 297 + 270, igst: 0, cess: 540, supply: 'intra' })
    expect(quote.total).toBe(9500) // 94.71 → ₹95
    expect(quote.roundOff).toBe(29)

    const r = counterCheckout(db, TEST_INFO, {
      date: DATE, lines,
      payments: [{ mode: 'cash', amountPaise: 5000 }, { mode: 'upi', amountPaise: 4500 }],
      tenderedPaise: 10000
    })
    expect(r).toMatchObject({ totalPaise: 9500, paidPaise: 9500, balancePaise: 0, changePaise: 5000 })
    const inv = getVoucher(db, r.invoiceId)!
    expect(imbalance(db, inv.id)).toBe(0)
    expect(inv.inventory.map((l) => [l.stockItemId, l.qtyMilli, l.ratePaise, l.discountPaise, l.amount])).toEqual([
      [pen, 3000, 1099, 0, 3297],
      [tea, 1000, 4750, 250, 4500]
    ])
    const walkIn = inv.partyLedgerId!
    expect(ledgerName(db, walkIn)).toBe(WALK_IN_NAME)
    const byLedger = Object.fromEntries(inv.lines.map((l) => [ledgerName(db, l.ledgerId), `${l.drCr} ${l.amount}`]))
    expect(byLedger).toMatchObject({ [WALK_IN_NAME]: 'dr 9500', 'Sales A/c': 'cr 7797', 'CGST Output': 'cr 567', 'SGST Output': 'cr 567', 'Cess Output': 'cr 540', 'Round Off': 'cr 29' })
    expect(inv.lines.find((l) => l.ledgerId === sales)?.amount).toBe(7797)
    expect(inv.billRefs).toEqual([{ kind: 'new', name: inv.number, amount: 9500, dueDate: DATE }])

    const rc = getVoucher(db, r.receiptId!)!
    expect(imbalance(db, rc.id)).toBe(0)
    expect(rc.lines.map((l) => [l.ledgerId, l.drCr, l.amount])).toEqual([
      [cash, 'dr', 5000],
      [bank, 'dr', 4500],
      [walkIn, 'cr', 9500]
    ])
    expect(rc.billRefs).toEqual([{ kind: 'against', name: inv.number, amount: 9500, dueDate: null }])
    // The walk-in party owes nothing: the receipt settled the bill.
    expect(openBills(db, walkIn, DATE).filter((b) => b.pending !== 0)).toEqual([])
    expect(db.prepare('SELECT receipt_voucher_id AS r, tendered_paise AS t, change_paise AS c FROM counter_sales WHERE invoice_voucher_id = ?').get(inv.id)).toEqual({ r: rc.id, t: 10000, c: 5000 })
  })

  it('a named party may leave a balance on account; inter-state posts IGST; card and UPI share the bank', () => {
    const { db, krishna, pen, bank } = pricingFixture()
    const r = counterCheckout(db, TEST_INFO, {
      date: DATE, partyLedgerId: krishna, lines: [{ itemId: pen, qtyMilli: 10_000, ratePaise: 1000 }],
      payments: [{ mode: 'card', amountPaise: 5000 }, { mode: 'upi', amountPaise: 2000 }]
    })
    expect(r).toMatchObject({ totalPaise: 11800, paidPaise: 7000, balancePaise: 4800, changePaise: 0 })
    const inv = getVoucher(db, r.invoiceId)!
    expect(inv.lines.some((l) => ledgerName(db, l.ledgerId) === 'IGST Output' && l.amount === 1800)).toBe(true)
    const rc = getVoucher(db, r.receiptId!)!
    expect(rc.lines.map((l) => [l.ledgerId, l.drCr, l.amount])).toEqual([[bank, 'dr', 7000], [krishna, 'cr', 7000]])
    expect(openBills(db, krishna, DATE).find((b) => b.number === inv.number)?.pending).toBe(4800)
  })

  it('an unpaid named sale posts the invoice alone; refusals leave the books untouched', () => {
    const { db, umbrella, pen } = pricingFixture()
    const count = (): number => (db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n
    const r = counterCheckout(db, TEST_INFO, { date: DATE, partyLedgerId: umbrella, lines: [{ itemId: pen, qtyMilli: 1000, ratePaise: 1000 }] })
    expect(r.receiptId).toBeNull()
    expect(count()).toBe(1)
    expect(() => counterCheckout(db, TEST_INFO, { date: DATE, lines: [{ itemId: pen, qtyMilli: 1000, ratePaise: 1000 }], payments: [{ mode: 'cash', amountPaise: 1000 }] })).toThrow(/paid in full/)
    expect(() => counterCheckout(db, TEST_INFO, { date: DATE, lines: [{ itemId: pen, qtyMilli: 1000, ratePaise: 1000 }], payments: [{ mode: 'cash', amountPaise: 1300 }] })).toThrow(/exceed/)
    expect(() => counterCheckout(db, TEST_INFO, { date: DATE, lines: [{ itemId: pen, qtyMilli: 1000, ratePaise: 1000 }], payments: [{ mode: 'cash', amountPaise: 1200 }], tenderedPaise: 1000 })).toThrow(/tendered/)
    expect(count()).toBe(1)
  })

  it('remembers the named party\'s prices (when on) but never the walk-in\'s', () => {
    const { db, umbrella, pen } = pricingFixture()
    setPricingConfig(db, { autoApply: true, rememberLastPrice: true })
    counterCheckout(db, TEST_INFO, { date: DATE, lines: [{ itemId: pen, qtyMilli: 1000, ratePaise: 1000 }], payments: [{ mode: 'cash', amountPaise: 1200 }] })
    expect(listPartyRates(db)).toHaveLength(0)
    counterCheckout(db, TEST_INFO, { date: DATE, partyLedgerId: umbrella, lines: [{ itemId: pen, qtyMilli: 1000, ratePaise: 1040 }] })
    expect(listPartyRates(db, umbrella)).toMatchObject([{ source: 'last_sale', ratePaise: 1040 }])
  })

  it('config: accounts default sensibly and follow the options', () => {
    const { db, bank, cash } = pricingFixture()
    expect(getCounterConfig(db).templateId).toBe('receipt-80mm')
    const acc = counterAccounts(db)
    expect(acc).toMatchObject({ cashLedgerId: cash, upiLedgerId: bank, cardLedgerId: bank, walkInLedgerId: null })
    const other = Number(db.prepare("INSERT INTO ledgers (name, group_id) VALUES ('ICICI Card', (SELECT id FROM groups WHERE name = 'Bank Accounts'))").run().lastInsertRowid)
    setCounterConfig(db, { ...getCounterConfig(db), cardLedgerId: other })
    expect(counterAccounts(db).cardLedgerId).toBe(other)
  })
})

describe('held bills', () => {
  it('hold → list → recall (leaves the list) → discard', () => {
    const { db, pen, tea } = pricingFixture()
    const a = holdBill(db, { label: 'Mr Rao', lines: [{ itemId: pen, qtyMilli: 2000, ratePaise: 1000, rateSource: 'manual' }] })
    const b = holdBill(db, { lines: [{ itemId: tea, qtyMilli: 1000, ratePaise: 4750, discountPaise: 100 }] })
    expect(listHeldBills(db).map((x) => x.label)).toEqual(['Mr Rao', 'Bill 2'])
    const back = recallHeldBill(db, a.id)
    expect(back.lines).toEqual([{ itemId: pen, qtyMilli: 2000, ratePaise: 1000, discountPaise: 0, rateSource: 'manual' }])
    expect(listHeldBills(db).map((x) => x.id)).toEqual([b.id])
    expect(() => recallHeldBill(db, a.id)).toThrow(/no longer on hold/)
    discardHeldBill(db, b.id)
    expect(listHeldBills(db)).toEqual([])
  })
})

describe('day end and print', () => {
  it('sales by payment mode and items for the day; a binned bill drops out', () => {
    const { db, pen, tea, umbrella } = pricingFixture()
    counterCheckout(db, TEST_INFO, { date: DATE, lines: [{ itemId: pen, qtyMilli: 2000, ratePaise: 1000 }], payments: [{ mode: 'cash', amountPaise: 2400 }], tenderedPaise: 3000 })
    counterCheckout(db, TEST_INFO, { date: DATE, lines: [{ itemId: tea, qtyMilli: 1000, ratePaise: 5000 }], payments: [{ mode: 'upi', amountPaise: 6200 }] })
    const third = counterCheckout(db, TEST_INFO, { date: DATE, partyLedgerId: umbrella, lines: [{ itemId: pen, qtyMilli: 1000, ratePaise: 1000 }] })
    counterCheckout(db, TEST_INFO, { date: '2025-10-08', lines: [{ itemId: pen, qtyMilli: 1000, ratePaise: 1000 }], payments: [{ mode: 'cash', amountPaise: 1200 }] })
    const d = counterDayEnd(db, DATE)
    expect(d.bills).toBe(3)
    expect(d.totalPaise).toBe(2400 + 6200 + 1200)
    expect(d.byMode.map((m) => [m.mode, m.amountPaise])).toEqual([['cash', 2400], ['upi', 6200]])
    expect(d.onAccountPaise).toBe(1200)
    expect(d.changePaise).toBe(600)
    expect(d.items.map((i) => [i.name, i.qtyMilli, i.amountPaise])).toEqual([['Gel Pen', 3000, 3000], ['Tea Pack', 1000, 5000]])
    deleteVoucher(db, third.invoiceId)
    expect(counterDayEnd(db, DATE).bills).toBe(2)
  })

  it('the thermal receipt prints the items, totals and payments; A4 still prints the invoice', () => {
    const { db, pen } = pricingFixture()
    const r = counterCheckout(db, TEST_INFO, {
      date: DATE, lines: [{ itemId: pen, qtyMilli: 2000, ratePaise: 1000 }],
      payments: [{ mode: 'cash', amountPaise: 1400 }, { mode: 'card', amountPaise: 1000 }], tenderedPaise: 2000
    })
    const { html, template, itemCount } = documentHtml(db, TEST_INFO, r.invoiceId, getTemplate(db, 'receipt-80mm'))
    expect(template.page.size).toBe('Roll80')
    expect(itemCount).toBe(1)
    expect(html).toContain('Gel Pen')
    expect(html).toContain('2 NOS × 10.00')
    expect(html).toContain('TOTAL')
    expect(html).toContain('24.00')
    expect(html).toContain('Paid · Cash')
    expect(html).toContain('Paid · HDFC Bank')
    expect(html).toMatch(/Change<\/td><td class="r num">6\.00/)
    const a4 = documentHtml(db, TEST_INFO, r.invoiceId, getTemplate(db, 'classic')).html
    expect(a4).toContain('TAX INVOICE')
    expect(a4).not.toContain('Paid · Cash')
  })
})
