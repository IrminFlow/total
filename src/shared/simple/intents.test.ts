import { describe, expect, it } from 'vitest'
import { translator } from '../i18n'
import { bannedWordsIn } from './bannedWords'
import { en } from '../i18n'
import type { VoucherPayload } from '../voucherEdit'
import {
  allocateToBills, intentSentences, mapIntent, NeedTaxLedgers, normaliseIntent, readAmount, readQty,
  type IntentContext, type IntentLedger, type IntentLedgerClass, type IntentOriginal, type MappedIntent
} from './intents'

const TODAY = '2025-08-14'
const t = translator('en')

const L = {
  cash: 1, bank: 2, upiBank: 3, sales: 4, purchases: 5, rent: 6, capital: 7, drawings: 8,
  ramesh: 10, kumar: 11, walkIn: 12, supplier: 20, outState: 21,
  cgstOut: 30, sgstOut: 31, igstOut: 32, cgstIn: 33, sgstIn: 34, igstIn: 35, roundOff: 36
}
const led = (id: number, name: string, cls: IntentLedgerClass, extra: Partial<IntentLedger> = {}): [number, IntentLedger] => [
  id, { id, name, cls, stateCode: null, gstRate: null, creditDays: null, ...extra }
]

function ctx(over: Partial<IntentContext> & { regular?: boolean } = {}): IntentContext {
  const regular = over.regular ?? true
  const ledgers = new Map<number, IntentLedger>([
    led(L.cash, 'Cash', 'cash'), led(L.bank, 'HDFC Bank', 'bank'), led(L.upiBank, 'UPI Bank', 'bank'),
    led(L.sales, 'Sales', 'income'), led(L.purchases, 'Purchases', 'expense'), led(L.rent, 'Rent', 'expense', { gstRate: 18 }),
    led(L.capital, "Owner's money", 'other'), led(L.drawings, "Owner's drawings", 'other'),
    led(L.ramesh, 'Ramesh', 'debtor', { stateCode: '27', creditDays: 15 }), led(L.kumar, 'Kumar', 'debtor', { stateCode: '29' }),
    led(L.walkIn, 'Cash sale', 'debtor'),
    led(L.supplier, 'Bharat Steel', 'creditor', { stateCode: '27' }), led(L.outState, 'Delhi Traders', 'creditor', { stateCode: '07' }),
    led(L.cgstOut, 'Output CGST', 'tax'), led(L.sgstOut, 'Output SGST', 'tax'), led(L.igstOut, 'Output IGST', 'tax'),
    led(L.cgstIn, 'Input CGST', 'tax'), led(L.sgstIn, 'Input SGST', 'tax'), led(L.igstIn, 'Input IGST', 'tax'), led(L.roundOff, 'Round Off', 'other')
  ])
  return {
    invoice: {
      companyStateCode: '27',
      gstRegistrationType: regular ? 'regular' : 'unregistered',
      items: new Map([[100, { gstRate: 18, cessRate: null }], [101, { gstRate: 5, cessRate: null }]]),
      ledgers: new Map([...ledgers.values()].map((l) => [l.id, { stateCode: l.stateCode, gstRate: l.gstRate }]))
    },
    ledgers,
    items: new Map([[100, { id: 100, name: 'Widget' }], [101, { id: 101, name: 'Rice' }]]),
    types: {
      sales: { id: 1, name: 'Sales', numbering: 'auto', next: 'S-7' },
      purchase: { id: 2, name: 'Purchase', numbering: 'auto', next: 'P-3' },
      receipt: { id: 3, name: 'Receipt', numbering: 'auto', next: 'R-5' },
      payment: { id: 4, name: 'Payment', numbering: 'auto', next: 'PY-2' },
      contra: { id: 5, name: 'Contra', numbering: 'auto', next: 'C-1' },
      credit_note: { id: 6, name: 'Credit Note', numbering: 'auto', next: 'CN-1' },
      debit_note: { id: 7, name: 'Debit Note', numbering: 'auto', next: 'DN-1' }
    },
    taxLedgers: {
      output: { cgst: L.cgstOut, sgst: L.sgstOut, igst: L.igstOut, cess: null, roundOff: L.roundOff },
      input: { cgst: L.cgstIn, sgst: L.sgstIn, igst: L.igstIn, cess: null, roundOff: L.roundOff }
    },
    defaults: { walkInId: L.walkIn, cashId: L.cash, upiId: L.upiBank, cardId: L.bank, bankId: L.bank, salesId: L.sales, purchaseId: L.purchases, drawingsId: L.drawings },
    prices: new Map(),
    openBills: new Map(),
    original: null,
    ...over
  }
}

const map = (raw: Record<string, unknown>, c: IntentContext = ctx()): MappedIntent => mapIntent(normaliseIntent({ clientId: 'client-0001', ...raw }, TODAY), c)
const sums = (p: VoucherPayload): { dr: number; cr: number } => ({
  dr: p.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0),
  cr: p.lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
})
const balanced = (m: MappedIntent): void => {
  for (const e of m.entries) {
    const s = sums(e.payload)
    expect(s.dr, `${e.role} ${e.kind}`).toBe(s.cr)
    expect(s.dr).toBeGreaterThan(0)
  }
}
const codeOf = (fn: () => unknown): { code?: string; field?: string } => {
  try {
    fn()
  } catch (e) {
    return { code: (e as { code?: string }).code, field: (e as { field?: string }).field }
  }
  return {}
}

describe('reading answers', () => {
  it('amounts via parseAmountText or integer paise, quantities in thousandths without floats', () => {
    expect(readAmount('1,180.50', 'amount')).toBe(118_050)
    expect(readAmount('1.5 lakh', 'amount')).toBe(15_000_000)
    expect(readAmount(500, 'amount')).toBe(500)
    expect(readQty('2.5', 'q')).toBe(2500)
    expect(readQty('1,000', 'q')).toBe(1_000_000)
    expect(readQty(1500, 'q')).toBe(1500)
    expect(codeOf(() => readAmount('12.345', 'amount')).code).toBe('simple_bad_amount')
    expect(codeOf(() => readQty('2.5555', 'items.0.qty'))).toEqual({ code: 'simple_bad_qty', field: 'items.0.qty' })
  })
  it('dates: ISO, typed text against the working date, omitted = the working date', () => {
    expect(normaliseIntent({ kind: 'move_money', clientId: 'client-0001', amount: 100, fromId: 1, toId: 2 }, TODAY).date).toBe(TODAY)
    expect(normaliseIntent({ kind: 'move_money', clientId: 'client-0001', date: 'yesterday', amount: 100, fromId: 1, toId: 2 }, TODAY).date).toBe('2025-08-13')
    expect(codeOf(() => normaliseIntent({ kind: 'move_money', clientId: 'client-0001', date: '2025-02-30', amount: 100, fromId: 1, toId: 2 }, TODAY)).code).toBe('simple_bad_date')
  })
  it('a sale needs items or an amount, not both', () => {
    expect(codeOf(() => map({ kind: 'sale', customerId: L.ramesh })).code).toBe('simple_no_lines')
    expect(codeOf(() => map({ kind: 'sale', customerId: L.ramesh, items: [{ itemId: 100, qty: '1', rate: 100 }], amount: { amount: 100 } })).code).toBe('simple_no_lines')
  })
})

describe('sale', () => {
  it('items on credit: an invoice-form sales voucher, GST from the editor calc, one new bill = its number', () => {
    const m = map({ kind: 'sale', customerId: L.ramesh, items: [{ itemId: 100, qty: '2', rate: '500' }] })
    balanced(m)
    expect(m.entries).toHaveLength(1)
    const [bill] = m.entries
    expect(bill!.form).toBe('invoice')
    expect(bill!.kind).toBe('sales')
    expect(bill!.payload.lines.map((l) => [l.ledgerId, l.drCr, l.amount])).toEqual([[L.ramesh, 'dr', 118_000], [L.sales, 'cr', 100_000], [L.cgstOut, 'cr', 9000], [L.sgstOut, 'cr', 9000]])
    expect(bill!.payload.inventory).toMatchObject([{ stockItemId: 100, qtyMilli: 2000, ratePaise: 50_000, amount: 100_000, direction: 'out' }])
    expect(bill!.payload.billRefs).toEqual([{ kind: 'new', name: 'S-7', amount: 118_000, dueDate: '2025-08-29' }])
    expect(m.facts).toMatchObject({ total: 118_000, tax: 18_000, paid: 0, due: 118_000 })
  })

  it('partly paid by UPI: invoice + receipt against that bill, the rest due', () => {
    const m = map({ kind: 'sale', customerId: L.ramesh, items: [{ itemId: 100, qty: '1', rate: '1000' }], payment: { how: 'upi', amount: '500' } })
    balanced(m)
    const [, receipt] = m.entries
    expect(receipt!.kind).toBe('receipt')
    expect(receipt!.form).toBe('accounting')
    expect(receipt!.payload.lines.map((l) => [l.ledgerId, l.drCr, l.amount])).toEqual([[L.upiBank, 'dr', 50_000], [L.ramesh, 'cr', 50_000]])
    expect(receipt!.payload.billRefs).toEqual([{ kind: 'against', name: 'S-7', amount: 50_000, dueDate: null }])
    expect(receipt!.payload.partyLedgerId).toBe(L.ramesh)
    expect(m.facts).toMatchObject({ total: 118_000, paid: 50_000, due: 68_000, how: 'upi' })
    expect(intentSentences(m.facts, t)).toEqual(['Bill ₹1,180.00 to Ramesh.', 'Includes GST ₹180.00.', '₹500.00 received by UPI.', '₹680.00 still due from Ramesh.'])
  })

  it('walk-in: cash in full by default; part payment is refused at the payment question', () => {
    const m = map({ kind: 'sale', items: [{ itemId: 101, qty: '3', rate: '40' }] })
    balanced(m)
    expect(m.entries.map((e) => e.kind)).toEqual(['sales', 'receipt'])
    expect(m.entries[0]!.payload.partyLedgerId).toBe(L.walkIn)
    expect(m.entries[1]!.payload.lines[0]).toMatchObject({ ledgerId: L.cash, drCr: 'dr' })
    expect(codeOf(() => map({ kind: 'sale', items: [{ itemId: 101, qty: '3', rate: '40' }], payment: { how: 'cash', amount: 100 } }))).toEqual({ code: 'simple_walk_in_unpaid', field: 'payment' })
    expect(codeOf(() => map({ kind: 'sale', customerId: L.ramesh, items: [{ itemId: 101, qty: '1', rate: '40' }], payment: { how: 'cash', amount: '999' } }))).toEqual({ code: 'simple_overpaid', field: 'payment.amount' })
  })

  it('inter-state customer: IGST; price from the price list when no rate is typed', () => {
    const m = map({ kind: 'sale', customerId: L.kumar, items: [{ itemId: 100, qty: 1000 }] }, ctx({ prices: new Map([[0, { ratePaise: 10_000, discountPaise: 0 }]]) }))
    expect(m.entries[0]!.payload.lines.map((l) => l.ledgerId)).toEqual([L.kumar, L.sales, L.igstOut])
    expect(codeOf(() => map({ kind: 'sale', customerId: L.kumar, items: [{ itemId: 100, qty: 1000 }] }))).toEqual({ code: 'simple_no_price', field: 'items.0.rate' })
  })

  it('just an amount: an accounting-form sales voucher with the GST heads; unregistered = no tax at all', () => {
    const m = map({ kind: 'sale', customerId: L.ramesh, amount: { amount: '1,000', gstRate: 18 }, payment: { how: 'cash' } })
    balanced(m)
    expect(m.entries[0]!.form).toBe('accounting')
    expect(m.entries[0]!.payload.lines.map((l) => [l.ledgerId, l.amount])).toEqual([[L.ramesh, 118_000], [L.sales, 100_000], [L.cgstOut, 9000], [L.sgstOut, 9000]])
    expect(m.entries[0]!.payload.billRefs).toEqual([{ kind: 'new', name: 'S-7', amount: 118_000, dueDate: '2025-08-29' }])
    const u = map({ kind: 'sale', customerId: L.ramesh, amount: { amount: '1,000', gstRate: 18 } }, ctx({ regular: false }))
    expect(u.entries[0]!.payload.lines.map((l) => [l.ledgerId, l.amount])).toEqual([[L.ramesh, 100_000], [L.sales, 100_000]])
    const ui = map({ kind: 'sale', customerId: L.ramesh, items: [{ itemId: 100, qty: '1', rate: '1000' }] }, ctx({ regular: false }))
    expect(ui.entries[0]!.payload.lines.map((l) => l.ledgerId)).toEqual([L.ramesh, L.sales])
  })

  it('rounds to the rupee with Round Off', () => {
    const m = map({ kind: 'sale', customerId: L.ramesh, amount: { amount: '10.30', gstRate: 5 } })
    balanced(m)
    // 10.30 + 2.5% + 2.5% = 10.82 (0.26 each) → 11; Round Off 0.18 on the sales side.
    expect(m.entries[0]!.payload.lines.at(-1)).toMatchObject({ ledgerId: L.roundOff, drCr: 'cr', amount: 18 })
  })

  it('asks for the tax ledgers it needs when they are not there yet', () => {
    const c = ctx()
    c.taxLedgers.output.cgst = null
    expect(() => map({ kind: 'sale', customerId: L.ramesh, items: [{ itemId: 100, qty: '1', rate: 100 }] }, c)).toThrow(NeedTaxLedgers)
  })

  it('refuses an account of the wrong kind at its question', () => {
    expect(codeOf(() => map({ kind: 'sale', customerId: L.supplier, items: [{ itemId: 100, qty: '1', rate: 100 }] }))).toEqual({ code: 'simple_no_party', field: 'party' })
    expect(codeOf(() => map({ kind: 'sale', customerId: L.ramesh, accountId: L.rent, items: [{ itemId: 100, qty: '1', rate: 100 }] }))).toEqual({ code: 'simple_wrong_account', field: 'account' })
    expect(codeOf(() => map({ kind: 'sale', customerId: L.ramesh, items: [{ itemId: 100, qty: '1', rate: 100 }], payment: { how: 'cash', accountId: L.bank } }))).toEqual({ code: 'simple_wrong_account', field: 'payment' })
  })

  it('a hand-numbered series needs the number', () => {
    const c = ctx()
    c.types.sales = { id: 1, name: 'Sales', numbering: 'manual', next: '' }
    expect(codeOf(() => map({ kind: 'sale', customerId: L.ramesh, items: [{ itemId: 100, qty: '1', rate: 100 }] }, c))).toEqual({ code: 'number_required', field: 'number' })
    expect(map({ kind: 'sale', customerId: L.ramesh, number: 'INV/9', items: [{ itemId: 100, qty: '1', rate: 100 }] }, c).entries[0]!.payload.billRefs[0]!.name).toBe('INV/9')
  })
})

describe('purchase', () => {
  it("items with the supplier's bill number: reference + bill name, input tax, paid now = payment against it", () => {
    const m = map({ kind: 'purchase', supplierId: L.supplier, billNo: 'BS/101', date: '2025-08-10', items: [{ itemId: 100, qty: '10', rate: '100' }], payment: { how: 'bank' } })
    balanced(m)
    const [bill, pay] = m.entries
    expect(bill!.payload).toMatchObject({ date: '2025-08-10', reference: 'BS/101', partyLedgerId: L.supplier })
    expect(bill!.payload.lines.map((l) => [l.ledgerId, l.drCr])).toEqual([[L.supplier, 'cr'], [L.purchases, 'dr'], [L.cgstIn, 'dr'], [L.sgstIn, 'dr']])
    expect(bill!.payload.inventory[0]!.direction).toBe('in')
    expect(bill!.payload.billRefs).toEqual([{ kind: 'new', name: 'BS/101', amount: 118_000, dueDate: '2025-08-10' }])
    expect(pay!.payload.lines.map((l) => [l.ledgerId, l.drCr, l.amount])).toEqual([[L.supplier, 'dr', 118_000], [L.bank, 'cr', 118_000]])
    expect(pay!.payload.billRefs).toEqual([{ kind: 'against', name: 'BS/101', amount: 118_000, dueDate: null }])
  })

  it('an expense bill without GST lines; a company that cannot claim GST books it into the cost', () => {
    const regular = map({ kind: 'purchase', supplierId: L.supplier, amount: { amount: '1000', accountId: L.rent } })
    expect(regular.entries[0]!.payload.lines.map((l) => [l.ledgerId, l.amount])).toEqual([[L.supplier, 118_000], [L.rent, 100_000], [L.cgstIn, 9000], [L.sgstIn, 9000]])
    const noGst = map({ kind: 'purchase', supplierId: L.supplier, gstOnBill: false, amount: { amount: '1000', accountId: L.rent } })
    expect(noGst.entries[0]!.payload.lines.map((l) => [l.ledgerId, l.amount])).toEqual([[L.supplier, 100_000], [L.rent, 100_000]])
    const unreg = map({ kind: 'purchase', supplierId: L.supplier, amount: { amount: '1000', accountId: L.rent } }, ctx({ regular: false }))
    expect(unreg.entries[0]!.payload.lines.map((l) => [l.ledgerId, l.amount])).toEqual([[L.supplier, 118_000], [L.rent, 118_000]])
    const unregItems = map({ kind: 'purchase', supplierId: L.supplier, items: [{ itemId: 100, qty: '3', rate: '100' }] }, ctx({ regular: false }))
    balanced(unregItems)
    // 3 × ₹100 + 18% = ₹354 of cost, as an inclusive rate (rateForCost) and no tax line.
    expect(unregItems.entries[0]!.payload.lines.map((l) => [l.ledgerId, l.amount])).toEqual([[L.supplier, 35_400], [L.purchases, 35_400]])
  })
})

describe('money in / out / move', () => {
  const bills = new Map([[L.ramesh, [
    { name: 'S-1', date: '2025-06-01', pending: 30_000, voucherId: 91 },
    { name: 'S-2', date: '2025-05-01', pending: 50_000, voucherId: 92 },
    { name: 'S-3', date: '2025-07-01', pending: 40_000, voucherId: 93 }
  ]]])

  it('a customer pays: oldest bills first, the extra kept as an advance', () => {
    const m = map({ kind: 'money_in', customerId: L.ramesh, amount: '1,300', into: { how: 'cash' } }, ctx({ openBills: bills }))
    balanced(m)
    expect(m.entries[0]!.kind).toBe('receipt')
    // More than every bill: on account — the Outstandings engine settles them oldest first and
    // holds the rest as an advance (a 'new' bill on a receipt would read as money owed).
    expect(m.entries[0]!.payload.billRefs).toEqual([])
    expect(m.facts.settled).toEqual([{ name: 'S-2', amount: 50_000 }, { name: 'S-1', amount: 30_000 }, { name: 'S-3', amount: 40_000 }])
    expect(intentSentences(m.facts, t)).toContain('₹100.00 kept as an advance.')
    // "For a bill you haven't made yet": the accounting form's advance flag — a new bill.
    const flagged = map({ kind: 'money_in', customerId: L.ramesh, amount: '1,300', into: { how: 'cash' }, advance: true }, ctx({ openBills: bills }))
    expect(flagged.entries[0]!.payload.billRefs.map((r) => [r.kind, r.name, r.amount])).toEqual([['against', 'S-2', 50_000], ['against', 'S-1', 30_000], ['against', 'S-3', 40_000], ['new', 'R-5', 10_000]])
    const part = map({ kind: 'money_in', customerId: L.ramesh, amount: 60_000, into: { how: 'bank' } }, ctx({ openBills: bills }))
    expect(part.entries[0]!.payload.billRefs.map((r) => [r.name, r.amount])).toEqual([['S-2', 50_000], ['S-1', 10_000]])
  })

  it('chosen bills; more than is due is refused at the bills question; no bills = on account unless an advance', () => {
    const m = map({ kind: 'money_in', customerId: L.ramesh, amount: 40_000, into: { how: 'cash' }, bills: [{ name: 'S-3' }] }, ctx({ openBills: bills }))
    expect(m.entries[0]!.payload.billRefs).toEqual([{ kind: 'against', name: 'S-3', amount: 40_000, dueDate: null }])
    expect(codeOf(() => map({ kind: 'money_in', customerId: L.ramesh, amount: 90_000, into: { how: 'cash' }, bills: [{ name: 'S-3', amount: 90_000 }] }, ctx({ openBills: bills })))).toEqual({ code: 'simple_bill_over', field: 'bills.0' })
    expect(codeOf(() => map({ kind: 'money_in', customerId: L.ramesh, amount: 100, into: { how: 'cash' }, bills: [{ name: 'S-9' }] }, ctx({ openBills: bills })))).toEqual({ code: 'simple_bill_unknown', field: 'bills.0' })
    expect(codeOf(() => map({ kind: 'money_in', customerId: L.ramesh, amount: 50_000, into: { how: 'cash' }, bills: [{ name: 'S-3' }] }, ctx({ openBills: bills })))).toEqual({ code: 'simple_bills_short', field: 'bills' })
    expect(map({ kind: 'money_in', customerId: L.kumar, amount: 100, into: { how: 'cash' } }).entries[0]!.payload.billRefs).toEqual([])
    expect(map({ kind: 'money_in', customerId: L.kumar, amount: 100, into: { how: 'cash' }, advance: true }).entries[0]!.payload.billRefs).toEqual([{ kind: 'new', name: 'R-5', amount: 100, dueDate: null }])
  })

  it('owner put money in: a receipt from the capital account; owner took money: drawings', () => {
    const m = map({ kind: 'money_in', sourceId: L.capital, amount: 5000, into: { how: 'bank' } })
    expect(m.entries[0]!.payload.lines.map((l) => [l.ledgerId, l.drCr])).toEqual([[L.bank, 'dr'], [L.capital, 'cr']])
    expect(m.entries[0]!.payload.partyLedgerId).toBeNull()
    const d = map({ kind: 'money_out', drawings: true, amount: 2000, from: { how: 'cash' } })
    expect(d.entries[0]!.kind).toBe('payment')
    expect(d.entries[0]!.payload.lines.map((l) => [l.ledgerId, l.drCr])).toEqual([[L.drawings, 'dr'], [L.cash, 'cr']])
    expect(codeOf(() => map({ kind: 'money_in', sourceId: L.bank, amount: 5000, into: { how: 'cash' } })).code).toBe('simple_wrong_account')
  })

  it('pay a supplier oldest first; pay an expense', () => {
    const m = map({ kind: 'money_out', supplierId: L.supplier, amount: 5000, from: { how: 'bank' } }, ctx({ openBills: new Map([[L.supplier, [{ name: 'BS/1', date: '2025-07-01', pending: 9000, voucherId: 1 }]]]) }))
    expect(m.entries[0]!.payload.lines.map((l) => [l.ledgerId, l.drCr])).toEqual([[L.supplier, 'dr'], [L.bank, 'cr']])
    expect(m.entries[0]!.payload.billRefs).toEqual([{ kind: 'against', name: 'BS/1', amount: 5000, dueDate: null }])
    const e = map({ kind: 'money_out', payeeId: L.rent, amount: 5000, from: { how: 'cash' } })
    balanced(e)
    expect(e.entries[0]!.payload.lines.map((l) => l.ledgerId)).toEqual([L.rent, L.cash])
  })

  it('move money is a contra between two different cash / bank accounts', () => {
    const m = map({ kind: 'move_money', amount: '2,000', fromId: L.cash, toId: L.bank })
    balanced(m)
    expect(m.entries[0]!.kind).toBe('contra')
    expect(m.entries[0]!.payload.lines.map((l) => [l.ledgerId, l.drCr, l.amount])).toEqual([[L.bank, 'dr', 200_000], [L.cash, 'cr', 200_000]])
    expect(codeOf(() => map({ kind: 'move_money', amount: 100, fromId: L.cash, toId: L.cash }))).toEqual({ code: 'simple_same_account', field: 'to' })
    expect(codeOf(() => map({ kind: 'move_money', amount: 100, fromId: L.cash, toId: L.rent }))).toEqual({ code: 'simple_wrong_account', field: 'to' })
    expect(intentSentences(m.facts, t)).toEqual(['₹2,000.00 moved from Cash to HDFC Bank.'])
  })

  it('allocateToBills settles a duplicated bill name once (the oldest)', () => {
    const r = allocateToBills([{ name: 'A', date: '2025-01-01', pending: 100, voucherId: 1 }, { name: 'A', date: '2025-02-01', pending: 100, voucherId: 2 }], 150, null, false, 'R-1')
    expect(allocateToBills([{ name: 'A', date: '2025-01-01', pending: 100, voucherId: 1 }, { name: 'A', date: '2025-02-01', pending: 100, voucherId: 2 }], 150, null, true, 'R-1').refs)
      .toEqual([{ kind: 'against', name: 'A', amount: 100, dueDate: null }, { kind: 'new', name: 'R-1', amount: 50, dueDate: null }])
    expect(r.refs).toEqual([])
    expect(r.settled).toEqual([{ name: 'A', amount: 100 }])
  })
})

describe('returns', () => {
  const original = (over: Partial<IntentOriginal> = {}): IntentOriginal => ({
    voucherId: 500, kind: 'sales', date: '2025-08-01', number: 'S-4', partyId: L.ramesh, accountId: L.sales, billName: 'S-4', pending: 118_000,
    carriesGst: true, rates: [18],
    lines: [{ lineUid: 'u-1', itemId: 100, qtyMilli: 2000, ratePaise: 50_000, discountPaise: 1000, godownId: null, batchId: null, leftMilli: 2000 }],
    ...over
  })

  it('items back against an unpaid bill: a credit note linked as a return, set against the bill; no refund', () => {
    const m = map({ kind: 'return_sale', billId: 500, items: [{ lineUid: 'u-1', qty: '1' }] }, ctx({ original: original() }))
    balanced(m)
    const [note] = m.entries
    expect(note!.kind).toBe('credit_note')
    expect(note!.form).toBe('invoice')
    expect(note!.payload.inventory).toMatchObject([{ stockItemId: 100, qtyMilli: 1000, ratePaise: 50_000, discountPaise: 500, direction: 'in', source: { lineUid: 'u-1', linkType: 'return' } }])
    expect(note!.payload.lines.map((l) => [l.ledgerId, l.drCr])).toEqual([[L.ramesh, 'cr'], [L.sales, 'dr'], [L.cgstOut, 'dr'], [L.sgstOut, 'dr'], [L.roundOff, 'cr']])
    expect(note!.payload.billRefs).toEqual([{ kind: 'against', name: 'S-4', amount: m.facts.total, dueDate: null }])
    expect(codeOf(() => map({ kind: 'return_sale', billId: 500, items: [{ lineUid: 'u-1', qty: '1' }], refund: { how: 'cash' } }, ctx({ original: original() })))).toEqual({ code: 'simple_refund_not_due', field: 'refund' })
    expect(codeOf(() => map({ kind: 'return_sale', billId: 500, items: [{ lineUid: 'u-1', qty: '3' }] }, ctx({ original: original() })))).toEqual({ code: 'simple_return_qty', field: 'items.0.qty' })
  })

  it('a paid bill: the note is its own credit; a refund pays it back against the note', () => {
    const m = map({ kind: 'return_sale', billId: 500, amount: { amount: '100' }, refund: { how: 'cash' } }, ctx({ original: original({ pending: 0 }) }))
    balanced(m)
    const [note, refund] = m.entries
    expect(note!.form).toBe('accounting')
    expect(note!.payload.billRefs).toEqual([{ kind: 'new', name: 'CN-1', amount: 11_800, dueDate: TODAY }])
    expect(refund!.kind).toBe('payment')
    expect(refund!.payload.lines.map((l) => [l.ledgerId, l.drCr, l.amount])).toEqual([[L.ramesh, 'dr', 11_800], [L.cash, 'cr', 11_800]])
    expect(refund!.payload.billRefs).toEqual([{ kind: 'against', name: 'CN-1', amount: 11_800, dueDate: null }])
  })

  it('purchase return: a debit note, goods go out, input tax reverses', () => {
    const o = original({ kind: 'purchase', partyId: L.supplier, accountId: L.purchases, billName: 'BS/101' })
    const m = map({ kind: 'return_purchase', billId: 500, items: [{ lineUid: 'u-1', qty: '2' }] }, ctx({ original: o }))
    balanced(m)
    expect(m.entries[0]!.kind).toBe('debit_note')
    expect(m.entries[0]!.payload.inventory[0]!.direction).toBe('out')
    expect(m.entries[0]!.payload.lines.slice(0, 4).map((l) => [l.ledgerId, l.drCr])).toEqual([[L.supplier, 'dr'], [L.purchases, 'cr'], [L.cgstIn, 'cr'], [L.sgstIn, 'cr']])
    expect(codeOf(() => map({ kind: 'return_sale', billId: 500, items: [{ lineUid: 'u-1', qty: '1' }] }, ctx({ original: o })))).toEqual({ code: 'simple_original_missing', field: 'bill' })
  })
})

describe('plain words', () => {
  it('every simple.intent message is free of accounting words', () => {
    const keys = Object.keys(en).filter((k) => k.startsWith('simple.intent.') || k.startsWith('errors.intent.'))
    expect(keys.length).toBeGreaterThan(20)
    for (const k of keys) expect(bannedWordsIn((en as Record<string, string>)[k]!), k).toEqual([])
  })
})
