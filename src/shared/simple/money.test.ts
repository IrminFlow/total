// WP 9.4 — the pure half of the simple Money screens: bill ticks = intents.ts allocateToBills
// (what simple:post runs), the forms' answers → money_in / money_out / purchase / move_money
// intents (each normalises), the checks under their questions, the purchase field remap; every
// message key is in the catalogue and banned-word free.
import { describe, expect, it } from 'vitest'
import { en } from '../i18n'
import { computeGst } from '../gst/calc'
import { roundToRupee } from '../money'
import { bannedWordsIn } from './bannedWords'
import { normaliseIntent } from './intents'
import {
  billAllocation, defaultTicks, emptyMoneyInForm, emptyMoneyOutForm, emptyMoveForm, moneyInErrors, moneyInIntentFrom, moneyOutErrors,
  linkedBillName, MONEY_OUT_EXPENSE_KEYS, moneyOutFieldOf, moneyOutIntentFrom, moveErrors, moveIntentFrom, purchaseFromMoneyOut, ticksToBills, type MoneyOpenBill
} from './money'
import { categoriesFor } from './accountKinds'

const TODAY = '2025-08-14'
const bill = (name: string, date: string, pending: number): MoneyOpenBill => ({ name, date, pending, voucherId: null, dueDate: null, overdueDays: 0 })
const OPEN = [bill('S-2', '2025-07-10', 60_000), bill('S-1', '2025-07-01', 100_000)]
const DEFAULTS = { cash: 1, upi: 2, card: 2, bank: 3 }
const REGULAR = { gstRegistrationType: 'regular' as const }
const UNREG = { gstRegistrationType: 'unregistered' as const }
const outCtx = (facts: { gstRegistrationType: 'regular' | 'unregistered' } = REGULAR) => ({
  facts, companyStateCode: '27', supplierState: (id: number) => (id === 21 ? '07' : '27'), drawingsId: 8
})
const parse = (i: object) => normaliseIntent({ clientId: 'client-0001', ...i }, TODAY)

describe('bill ticks (the allocation simple:post runs)', () => {
  it('review: "Record a payment" pre-ticks the bill by its entry, its open name may differ from its number', () => {
    const open = [{ ...bill('7', '2025-04-02', 10_000), voucherId: 3 }, { ...bill('7/25-26', '2025-07-02', 20_000), voucherId: 9 }]
    expect(linkedBillName(open, '7', 9)).toBe('7/25-26')
    expect(linkedBillName(open, '7', 3)).toBe('7')
    // Paid off since (no open bill of that entry): none — the form goes oldest first.
    expect(linkedBillName(open, '7', 44)).toBeNull()
    // Without an entry id, by name.
    expect(linkedBillName(open, '7', null)).toBe('7')
    expect(linkedBillName(open, 'X', null)).toBeNull()
  })

  it('untouched: oldest first up to the amount — one and a half bills', () => {
    expect(billAllocation(OPEN, 130_000, null, false)).toEqual({ settled: [{ name: 'S-1', amount: 100_000 }, { name: 'S-2', amount: 30_000 }], advance: 0, short: false })
    expect(defaultTicks(OPEN, 130_000)).toEqual(['S-1', 'S-2'])
    expect(defaultTicks(OPEN, null)).toEqual([])
  })
  it('more than the bills: the rest is an advance (with or without the answer)', () => {
    expect(billAllocation(OPEN, 200_000, null, false)).toMatchObject({ advance: 40_000, short: false })
    expect(billAllocation(OPEN, 200_000, null, true)).toMatchObject({ advance: 40_000, short: false })
  })
  it('ticked: those bills oldest first, the last one only as far as the amount goes; short without the advance answer', () => {
    expect(ticksToBills(OPEN, 80_000, ['S-2', 'S-1'])).toEqual([{ name: 'S-1', amount: 80_000 }])
    expect(ticksToBills(OPEN, 130_000, ['S-2'])).toEqual([{ name: 'S-2', amount: 60_000 }])
    expect(ticksToBills(OPEN, 130_000, null)).toBeNull()
    expect(billAllocation(OPEN, 130_000, ['S-2'], false)).toEqual({ settled: [{ name: 'S-2', amount: 60_000 }], advance: 0, short: true })
    expect(billAllocation(OPEN, 130_000, ['S-2'], true)).toEqual({ settled: [{ name: 'S-2', amount: 60_000 }], advance: 70_000, short: false })
    expect(billAllocation(OPEN, 50_000, [], true)).toEqual({ settled: [], advance: 50_000, short: false })
  })
})

describe('Money in → money_in', () => {
  it('a customer, untouched: no bills named (oldest first in main), into the default for the way', () => {
    const f = { ...emptyMoneyInForm(TODAY, { customerId: 10 }), amount: 130_000, how: 'upi' as const }
    const i = moneyInIntentFrom(f, OPEN, DEFAULTS, { ownerId: 7 })
    expect(i).toEqual({ kind: 'money_in', date: TODAY, amount: 130_000, into: { how: 'upi', accountId: 2 }, customerId: 10 })
    expect(parse(i)).toMatchObject({ kind: 'money_in', customerId: 10, bills: null })
  })
  it('a customer, ticked + the advance answer; a picked account wins', () => {
    const f = { ...emptyMoneyInForm(TODAY, { customerId: 10, bill: 'S-2' }), amount: 70_000, advance: true, accountId: 9, reference: 'UTR 77' }
    expect(moneyInIntentFrom(f, OPEN, DEFAULTS, { ownerId: 7 })).toMatchObject({ into: { how: 'cash', accountId: 9, reference: 'UTR 77' }, bills: [{ name: 'S-2', amount: 60_000 }], advance: true })
  })
  it('opened from a bank statement line (WP 9.6): that bank, its reference and description, the line\'s date', () => {
    const f = { ...emptyMoneyInForm('2025-08-12', { customerId: 10, amount: 400_000, bankId: 31, reference: 'N1', note: 'NEFT-RAMESH' }) }
    expect(f).toMatchObject({ date: '2025-08-12', how: 'bank', accountId: 31, reference: 'N1', note: 'NEFT-RAMESH', amount: 400_000 })
    expect(moneyInIntentFrom(f, OPEN, DEFAULTS, { ownerId: 7 })).toMatchObject({ date: '2025-08-12', amount: 400_000, into: { how: 'bank', accountId: 31, reference: 'N1' }, customerId: 10 })
    expect(emptyMoneyOutForm('2025-08-12', { supplierId: 20, bankId: 31 })).toMatchObject({ how: 'bank', accountId: 31, reference: '', note: '' })
    // Not from a bank line: unchanged (cash, the default account).
    expect(emptyMoneyInForm(TODAY, { customerId: 10 })).toMatchObject({ how: 'cash', accountId: null })
  })
  it('the owner (their capital account), a loan, a supplier refund', () => {
    const base = { ...emptyMoneyInForm(TODAY), amount: 500_000 }
    expect(moneyInIntentFrom({ ...base, who: 'owner' }, [], DEFAULTS, { ownerId: 7 })).toMatchObject({ sourceId: 7 })
    expect(moneyInIntentFrom({ ...base, who: 'loan', sourceId: 40 }, [], DEFAULTS, { ownerId: 7 })).toMatchObject({ sourceId: 40 })
    const refund = moneyInIntentFrom({ ...base, who: 'refund', supplierId: 20 }, [], DEFAULTS, { ownerId: 7 })
    expect(refund).toMatchObject({ supplierId: 20 })
    expect(refund).not.toHaveProperty('customerId')
    expect(parse(refund)).toMatchObject({ supplierId: 20, sourceId: null, customerId: null })
  })
  it('checks: who, amount, the account, ticked bills short of the amount', () => {
    expect(moneyInErrors(emptyMoneyInForm(TODAY), OPEN, DEFAULTS, { ownerId: null })).toEqual({ party: 'simple.money.err.pickCustomer', amount: 'simple.money.err.amount' })
    expect(moneyInErrors({ ...emptyMoneyInForm(TODAY, { customerId: 10, bill: 'S-2' }), amount: 70_000 }, OPEN, DEFAULTS, { ownerId: null })).toEqual({ bills: 'simple.money.err.ticksShort' })
    expect(moneyInErrors({ ...emptyMoneyInForm(TODAY, { customerId: 10 }), amount: 1, how: 'bank' }, OPEN, { ...DEFAULTS, bank: null }, { ownerId: null })).toEqual({ into: 'simple.money.err.noBank' })
    // The owner's account is added on Save when there is none — not an error.
    expect(moneyInErrors({ ...emptyMoneyInForm(TODAY), who: 'owner', amount: 1 }, [], DEFAULTS, { ownerId: null })).toEqual({})
    expect(moneyInErrors({ ...emptyMoneyInForm(TODAY), who: 'loan', amount: 1 }, [], DEFAULTS, { ownerId: null })).toEqual({ party: 'simple.money.err.pickLoan' })
  })
})

describe('Money out → money_out / purchase', () => {
  it('a supplier (ticks), an expense, drawings, salary', () => {
    const base = { ...emptyMoneyOutForm(TODAY), amount: 40_000 }
    expect(moneyOutIntentFrom({ ...base, supplierId: 20 }, [], DEFAULTS, outCtx())).toEqual({ kind: 'money_out', date: TODAY, amount: 40_000, from: { how: 'cash', accountId: 1 }, supplierId: 20 })
    expect(moneyOutIntentFrom({ ...base, who: 'expense', payeeId: 6, gstBill: false }, [], DEFAULTS, outCtx())).toMatchObject({ kind: 'money_out', payeeId: 6 })
    expect(moneyOutIntentFrom({ ...base, who: 'owner' }, [], DEFAULTS, outCtx())).toMatchObject({ kind: 'money_out', drawings: true })
    expect(moneyOutIntentFrom({ ...base, who: 'salary', payeeId: 50 }, [], DEFAULTS, outCtx())).toMatchObject({ kind: 'money_out', payeeId: 50 })
  })
  it('an expense with a GST bill (regular): ONE purchase intent paid now; its value before GST makes the typed total back', () => {
    const f = { ...emptyMoneyOutForm(TODAY), who: 'expense' as const, payeeId: 6, amount: 118_000, gstBill: true, billSupplierId: 20, billNo: 'INV-9', gstRate: 18, how: 'bank' as const }
    const i = moneyOutIntentFrom(f, [], DEFAULTS, outCtx())
    expect(i).toEqual({ kind: 'purchase', date: TODAY, supplierId: 20, billNo: 'INV-9', amount: { amount: 100_000, accountId: 6, gstRate: 18, billTotal: 118_000 }, payment: { how: 'bank', accountId: 3 } })
    expect(roundToRupee(computeGst(100_000, 18, 'intra').total)).toBe(118_000)
    // Inter-state supplier: IGST — same taxable here.
    expect(moneyOutIntentFrom({ ...f, billSupplierId: 21 }, [], DEFAULTS, outCtx())).toMatchObject({ amount: { amount: 100_000 } })
    expect(parse(i)).toMatchObject({ kind: 'purchase', supplierId: 20, billNo: 'INV-9', gstOnBill: true, payment: { how: 'bank', accountId: 3, amount: null } })
    // Unregistered: never a purchase — the question isn't asked.
    expect(moneyOutIntentFrom(f, [], DEFAULTS, outCtx(UNREG))).toMatchObject({ kind: 'money_out', payeeId: 6 })
  })
  it('review: a bill total that is not a round rupee is sent as printed (the payment is what left the cash, never rounded)', () => {
    const f = { ...emptyMoneyOutForm(TODAY), who: 'expense' as const, payeeId: 6, amount: 100_050, gstBill: true, billSupplierId: 20, billNo: 'INV-10', gstRate: 18 }
    const i = moneyOutIntentFrom(f, [], DEFAULTS, outCtx()) as { amount: { amount: number; billTotal: number } }
    expect(i.amount.billTotal).toBe(100_050)
    // Its value + GST come within a rupee of the printed total (the rest is the bill's round off).
    expect(Math.abs(computeGst(i.amount.amount, 18, 'intra').total - 100_050)).toBeLessThan(100)
    expect(parse(i)).toMatchObject({ amount: { billTotal: 100_050 } })
  })

  it('checks: the GST bill question and its fields only for a regular registration', () => {
    const f = { ...emptyMoneyOutForm(TODAY), who: 'expense' as const, payeeId: 6, amount: 100 }
    expect(moneyOutErrors(f, [], DEFAULTS, outCtx())).toEqual({ gstBill: 'simple.money.err.gstBill' })
    expect(moneyOutErrors({ ...f, gstBill: true }, [], DEFAULTS, outCtx())).toEqual({ billSupplier: 'simple.money.err.billSupplier', billNo: 'simple.money.err.billNo', gstRate: 'simple.money.err.gstRate' })
    expect(moneyOutErrors(f, [], DEFAULTS, outCtx(UNREG))).toEqual({})
    expect(moneyOutErrors({ ...emptyMoneyOutForm(TODAY), amount: 100 }, [], DEFAULTS, outCtx())).toEqual({ party: 'simple.money.err.pickSupplier' })
    expect(moneyOutErrors({ ...emptyMoneyOutForm(TODAY), who: 'owner', amount: 100 }, [], DEFAULTS, outCtx())).toEqual({})
  })
  it('a refusal on the purchase lands on the Money out question it came from', () => {
    expect(moneyOutFieldOf('party', true)).toBe('billSupplier')
    expect(moneyOutFieldOf('account', true)).toBe('party')
    expect(moneyOutFieldOf('payment', true)).toBe('from')
    expect(moneyOutFieldOf('billNo', true)).toBe('billNo')
    expect(moneyOutFieldOf('party', false)).toBe('party')
  })
})

describe('Move money → move_money', () => {
  it('from, to, amount; the same account twice is refused under To', () => {
    const f = { ...emptyMoveForm(TODAY), fromId: 1, toId: 3, amount: 200_000, note: 'Deposit' }
    expect(moveIntentFrom(f)).toEqual({ kind: 'move_money', date: TODAY, amount: 200_000, fromId: 1, toId: 3, narration: 'Deposit' })
    expect(moveErrors(f)).toEqual({})
    expect(moveErrors({ ...f, toId: 1 })).toEqual({ to: 'errors.intent.sameAccount' })
    expect(moveErrors(emptyMoveForm(TODAY))).toEqual({ from: 'simple.money.err.moveFrom', to: 'simple.money.err.moveTo', amount: 'simple.money.err.amount' })
  })
})

describe('words', () => {
  it('every simple.money key is plain (no banned word) and the error keys exist', () => {
    const keys = Object.keys(en).filter((k) => k.startsWith('simple.money.'))
    expect(keys.length).toBeGreaterThan(100)
    for (const k of keys) expect(bannedWordsIn(en[k as keyof typeof en]), k).toEqual([])
  })
})

describe('Money out’s expense tiles (goods bought are a purchase)', () => {
  it('drop Purchases, Raw material purchases and Discount given; Record a purchase keeps every one', () => {
    for (const k of ['purchases', 'raw_material', 'discount_given'] as const) {
      expect(MONEY_OUT_EXPENSE_KEYS).not.toContain(k)
      expect(categoriesFor('expense')).toContain(k)
    }
    expect(MONEY_OUT_EXPENSE_KEYS).toEqual(categoriesFor('expense').filter((k) => !['purchases', 'raw_material', 'discount_given'].includes(k)))
  })
  it('“Record a purchase instead” carries the supplier (the GST bill’s first), the amount, how and the date', () => {
    const f = { ...emptyMoneyOutForm(TODAY), who: 'expense' as const, amount: 50_000, how: 'bank' as const, supplierId: 7, billSupplierId: 9, note: ' tea ' }
    expect(purchaseFromMoneyOut(f)).toEqual({ screen: 'simple-buy', party: 9, amount: 50_000, how: 'bank', date: TODAY, note: 'tea' })
    expect(purchaseFromMoneyOut(emptyMoneyOutForm(TODAY))).toEqual({ screen: 'simple-buy', how: 'cash', date: TODAY })
  })
})
