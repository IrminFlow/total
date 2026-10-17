// WP 9.10 follow-up — carryBack: the unsaved hand-off editor's changes back into the simple form.
//
// The two laws, over every simple form shape the hand-off carries:
//   1. a form handed to the editor and straight back is the same form (prices typed with GST
//      included): carryBack(intentForm(xIntentFrom(form))) = form;
//   2. a form carried back from ANY editor state that came from a simple form maps to exactly that
//      editor state again: intentForm(xIntentFrom(carryBack(editor))) = editor — checked from a
//      hand-off that opened with OTHER answers, so every field is read back from the editor alone.
// Property-style: seeded random forms per shape. Plus the fields with no simple counterpart
// (`dropped`) and the entries the simple form can't hold at all (refused → the flow opens as before).
import { describe, expect, it } from 'vitest'
import type { AccountingFormState, InvoiceFormState } from '../voucherEdit'
import { mapIntent, normaliseIntent, type IntentContext, type IntentLedger, type IntentLedgerClass, type IntentOriginal, type MappedIntent } from './intents'
import { sanitiseHandoffEntry, type HandoffEntry } from './handoff'
import { billOnly, carryBack, type CarryContext, type CarryFlow, type CarryForms, type CarryResult } from './carryBack'
import { emptySellForm, exclusiveLines, saleIntentFrom, type SellContext, type SellForm } from './sell'
import { buyIntentLines, emptyBuyForm, purchaseIntentFrom, type BuyContext, type BuyForm } from './buy'
import { emptyMoneyInForm, emptyMoneyOutForm, emptyMoveForm, moneyInIntentFrom, moneyOutIntentFrom, moveIntentFrom, type MoneyInForm, type MoneyOpenBill, type MoneyOutForm, type MoveForm } from './money'
import { emptyReturnForm, returnIntentFrom, type ReturnBill, type ReturnForm } from './returns'

const TODAY = '2025-08-14'
const L = {
  cash: 1, bank: 2, upiBank: 3, sales: 4, purchases: 5, rent: 6, capital: 7, drawings: 8, otherIncome: 9,
  ramesh: 10, kumar: 11, walkIn: 12, supplier: 20, outState: 21,
  cgstOut: 30, sgstOut: 31, igstOut: 32, cgstIn: 33, sgstIn: 34, igstIn: 35, roundOff: 36
}
const led = (id: number, name: string, cls: IntentLedgerClass, extra: Partial<IntentLedger> = {}): [number, IntentLedger] => [
  id, { id, name, cls, stateCode: null, gstRate: null, creditDays: null, ...extra }
]

function ictx(over: Partial<IntentContext> & { regular?: boolean } = {}): IntentContext {
  const { regular = true, ...rest } = over
  const ledgers = new Map<number, IntentLedger>([
    led(L.cash, 'Cash', 'cash'), led(L.bank, 'HDFC Bank', 'bank'), led(L.upiBank, 'UPI Bank', 'bank'),
    led(L.sales, 'Sales', 'income'), led(L.purchases, 'Purchases', 'expense'), led(L.rent, 'Rent', 'expense', { gstRate: 18 }),
    led(L.capital, "Owner's money", 'other'), led(L.drawings, "Owner's drawings", 'other'), led(L.otherIncome, 'Interest received', 'income'),
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
      items: new Map([[100, { gstRate: 18, cessRate: null }], [101, { gstRate: 5, cessRate: null }], [102, { gstRate: 12, cessRate: null }]]),
      ledgers: new Map([...ledgers.values()].map((l) => [l.id, { stateCode: l.stateCode, gstRate: l.gstRate }]))
    },
    ledgers,
    items: new Map([[100, { id: 100, name: 'Widget' }], [101, { id: 101, name: 'Rice' }], [102, { id: 102, name: 'Soap' }]]),
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
    takenNames: new Map(),
    ...rest
  }
}

const RAMESH_BILLS: MoneyOpenBill[] = [
  { name: 'S-1', date: '2025-07-01', pending: 50_000, voucherId: 51, dueDate: null, overdueDays: 0 },
  { name: 'S-2', date: '2025-07-20', pending: 30_000, voucherId: 52, dueDate: null, overdueDays: 0 },
  { name: 'S-3', date: '2025-08-01', pending: 20_000, voucherId: 53, dueDate: null, overdueDays: 0 }
]
const SUPPLIER_BILLS: MoneyOpenBill[] = [
  { name: 'B-9', date: '2025-07-05', pending: 40_000, voucherId: 61, dueDate: null, overdueDays: 0 },
  { name: 'B-10', date: '2025-07-25', pending: 15_000, voucherId: 62, dueDate: null, overdueDays: 0 }
]

const ORIGINAL_ITEMS: IntentOriginal = {
  voucherId: 70, kind: 'sales', date: '2025-08-01', number: 'S-4', partyId: L.ramesh, accountId: L.sales, billName: 'S-4', pending: 50_000, carriesGst: true, rates: [18, 5],
  lines: [
    { lineUid: 'u1', itemId: 100, qtyMilli: 5000, ratePaise: 10_000, discountPaise: 2500, godownId: null, batchId: null, leftMilli: 5000 },
    { lineUid: 'u2', itemId: 101, qtyMilli: 10_000, ratePaise: 4000, discountPaise: 0, godownId: null, batchId: null, leftMilli: 8000 }
  ]
}
const ORIGINAL_AMOUNT: IntentOriginal = {
  voucherId: 71, kind: 'purchase', date: '2025-08-02', number: 'P-1', partyId: L.supplier, accountId: L.purchases, billName: 'INV-77', pending: 0, carriesGst: true, rates: [18],
  lines: [], noteReference: 'INV-77', amountLeft: 80_000
}

const openBills = (c: IntentContext): IntentContext['openBills'] => (c.openBills.size ? c.openBills : new Map([[L.ramesh, RAMESH_BILLS], [L.supplier, SUPPLIER_BILLS]]))

function cctx(c: IntentContext): CarryContext {
  return {
    invoice: c.invoice,
    ledgers: c.ledgers,
    taxLedgers: c.taxLedgers,
    walkInId: L.walkIn,
    defaults: { salesId: c.defaults.salesId, purchaseId: c.defaults.purchaseId, drawingsId: c.defaults.drawingsId },
    openBills: openBills(c) as CarryContext['openBills'],
    original: c.original
  }
}

const sellCtx = (c: IntentContext): SellContext => ({ invoice: c.invoice, salesAccountId: L.sales })
const buyCtx = (c: IntentContext): BuyContext => ({ invoice: c.invoice, purchaseAccountId: L.purchases })
const DEFAULTS = { cash: L.cash, upi: L.upiBank, card: L.bank, bank: L.bank }

/** simple:intentForm in miniature: mapIntent, then the hand-off's sanitising (the number blanked). */
function handoff(intent: Record<string, unknown>, c: IntentContext): HandoffEntry {
  const m: MappedIntent = mapIntent(normaliseIntent({ clientId: 'client-0001', ...intent }, TODAY), { ...c, openBills: openBills(c) })
  const e = m.entries[0]!
  const entry = { role: e.role, kind: e.kind, voucherTypeId: e.voucherTypeId, form: e.form, state: e.state, amount: 0 } as HandoffEntry
  return sanitiseHandoffEntry(entry, () => true, () => null).entry
}

type IntentOf<F extends CarryFlow> = (form: CarryForms[F], c: IntentContext) => Record<string, unknown>
const INTENT: { [F in CarryFlow]: IntentOf<F> } = {
  'simple-sell': (f, c) => saleIntentFrom(f, sellCtx(c), DEFAULTS),
  'simple-buy': (f, c) => purchaseIntentFrom(f, buyCtx(c), DEFAULTS),
  'simple-money-in': (f) => moneyInIntentFrom(f, RAMESH_BILLS, DEFAULTS, { ownerId: L.capital }),
  'simple-money-out': (f, c) =>
    moneyOutIntentFrom(f, SUPPLIER_BILLS, DEFAULTS, { facts: c.invoice, companyStateCode: '27', supplierState: (id) => c.ledgers.get(id)?.stateCode ?? null, drawingsId: L.drawings }),
  'simple-move-money': (f) => moveIntentFrom(f),
  'simple-return-sale': (f, c) => returnIntentFrom(f, returnBill(c.original!), { invoice: c.invoice }, DEFAULTS),
  'simple-return-purchase': (f, c) => returnIntentFrom(f, returnBill(c.original!), { invoice: c.invoice }, DEFAULTS)
}

function returnBill(o: IntentOriginal): ReturnBill {
  return {
    voucherId: o.voucherId, side: o.kind === 'sales' ? 'sale' : 'purchase', date: o.date, number: o.number, partyId: o.partyId, partyName: 'x', walkIn: false, total: 0, tax: 0,
    billName: o.billName, pending: o.pending, carriesGst: o.carriesGst, rates: o.rates, accountId: o.accountId, mode: o.lines.length ? 'items' : 'amount',
    lines: o.lines.map((l) => ({ ...l, name: 'x', unit: 'Nos', amount: 0 })), amountTaxable: 100_000, amountLeft: o.amountLeft ?? null, earlier: [], billNo: null, partyStateCode: '27'
  } as ReturnBill
}

/** The editor state an entry maps to, its number aside (the editor numbers a new entry itself). */
const stateOf = (e: HandoffEntry): unknown => ({ ...e.state, number: '' })

function carry<F extends CarryFlow>(flow: F, base: CarryForms[F], original: HandoffEntry, current: HandoffEntry, c: IntentContext): CarryResult<F> {
  // remap = the hand-off the carried form itself makes (main: simple:intentForm's mapping).
  return carryBack({ flow, base, original, current }, cctx(c), { remap: (f) => handoff(billOnly(INTENT[flow](f, c)), c) })
}

/** Both laws for one form: straight back = the same form; from another hand-off = the editor again. */
function laws<F extends CarryFlow>(flow: F, form: CarryForms[F], other: CarryForms[F], c: IntentContext, same: (a: CarryForms[F], b: CarryForms[F]) => void): CarryForms[F] {
  const E = handoff(INTENT[flow](form, c), c)
  // Law 1: handed over and straight back.
  const back = carry(flow, form, E, E, c)
  expect(back).toEqual({ ok: true, form, dropped: [] })
  // Law 2: the editor state read back over a hand-off that opened with other answers.
  const E0 = handoff(INTENT[flow](other, c), c)
  const r = carry(flow, other, E0, E, c)
  if (!r.ok) throw new Error(`refused: ${r.reason}`)
  expect(r.dropped).toEqual([])
  expect(stateOf(handoff(billOnly(INTENT[flow](r.form, c)), c))).toEqual(stateOf(E))
  same(r.form, form)
  return r.form
}

// ---------------------------------------------------------------- seeded random forms

function prng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}
const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
const paise = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo))

let key = 0
function sellForm(r: () => number, incl: boolean, mode: 'items' | 'amount'): SellForm {
  const f = emptySellForm(pick(r, ['2025-08-01', '2025-08-10', TODAY]), { mode, ratesIncludeGst: incl })
  const customerId = pick(r, [L.ramesh, L.kumar, null])
  const lines = Array.from({ length: 1 + Math.floor(r() * 3) }, () => ({
    key: ++key, itemId: pick(r, [100, 101, 102]), qtyText: pick(r, ['1', '2', '2.5', '12', '0.75']), rate: paise(r, 100, 500_000), discount: r() < 0.3 ? paise(r, 1, 50) : null, auto: false
  }))
  return {
    ...f, customerId, lines: mode === 'items' ? lines : [], amount: mode === 'amount' ? paise(r, 1000, 9_000_000) : null, gstRate: mode === 'amount' ? pick(r, [0, 5, 12, 18, 28]) : null,
    paid: customerId == null ? 'cash' : 'credit', note: r() < 0.5 ? 'Diwali order' : ''
  }
}

function buyForm(r: () => number, incl: boolean, mode: 'items' | 'amount' | 'expense', regular: boolean): BuyForm {
  const f = emptyBuyForm(pick(r, ['2025-08-01', TODAY]), { mode, ratesIncludeGst: incl })
  const lines = Array.from({ length: 1 + Math.floor(r() * 3) }, () => ({
    key: ++key, itemId: pick(r, [100, 101, 102]), qtyText: pick(r, ['1', '3', '4.5']), rate: paise(r, 100, 300_000), discount: r() < 0.3 ? paise(r, 1, 50) : null
  }))
  return {
    ...f, supplierId: pick(r, [L.supplier, L.outState]), billNo: pick(r, ['', 'INV-12', 'A/77']), lines: mode === 'items' ? lines : [],
    amount: mode !== 'items' ? paise(r, 1000, 5_000_000) : null, categoryId: mode === 'expense' ? L.rent : null,
    gstRate: mode !== 'items' && regular ? pick(r, [5, 12, 18]) : mode !== 'items' ? pick(r, [5, 18]) : null, gstOnBill: true, note: r() < 0.5 ? 'Monthly stock' : ''
  }
}

const sellSame = (c: IntentContext) => (a: SellForm, b: SellForm): void => {
  expect([a.date, a.customerId, a.mode, a.note]).toEqual([b.date, b.customerId, b.mode, b.note])
  // Modulo the basis (a with-GST price that can't come back exactly is shown before GST): the
  // same lines as the editor holds them.
  expect(exclusiveLines(a, sellCtx(c)).lines).toEqual(exclusiveLines(b, sellCtx(c)).lines)
}
const buySame = (c: IntentContext) => (a: BuyForm, b: BuyForm): void => {
  expect([a.date, a.supplierId, a.mode, a.note]).toEqual([b.date, b.supplierId, b.mode, b.note])
  if (a.mode === 'items' && a.ratesIncludeGst === b.ratesIncludeGst) expect(buyIntentLines(a, buyCtx(c)).lines).toEqual(buyIntentLines(b, buyCtx(c)).lines)
}

// ---------------------------------------------------------------- the laws

describe('carryBack — Make a bill', () => {
  const c = ictx()
  const other = (incl: boolean, mode: 'items' | 'amount'): SellForm => ({
    ...emptySellForm('2025-07-30', { mode, ratesIncludeGst: incl }), customerId: L.kumar, paid: 'credit', note: 'other',
    lines: mode === 'items' ? [{ key: 9999, itemId: 101, qtyText: '9', rate: 777, discount: null, auto: false }] : [],
    amount: mode === 'amount' ? 12_345 : null, gstRate: mode === 'amount' ? 12 : null
  })
  it('random product bills, prices before and with GST: both laws', () => {
    const r = prng(42)
    for (let i = 0; i < 60; i++) {
      const incl = i % 2 === 0
      laws('simple-sell', sellForm(r, incl, 'items'), other(incl, 'items'), c, sellSame(c))
    }
  })
  it('random "just an amount" bills: both laws', () => {
    const r = prng(7)
    for (let i = 0; i < 60; i++) {
      const incl = i % 2 === 0
      laws('simple-sell', sellForm(r, incl, 'amount'), other(incl, 'amount'), c, (a, b) => {
        expect([a.date, a.customerId, a.mode, a.note, a.gstRate]).toEqual([b.date, b.customerId, b.mode, b.note, b.gstRate])
      })
    }
  })
  it('prices typed WITH GST come back as typed when the editor holds the same line', () => {
    const form: SellForm = {
      ...emptySellForm(TODAY, { mode: 'items', ratesIncludeGst: true }), customerId: L.ramesh, paid: 'credit',
      lines: [{ key: 1, itemId: 100, qtyText: '2', rate: 118_000, discount: null, auto: false }, { key: 2, itemId: 101, qtyText: '3', rate: 10_500, discount: 500, auto: false }]
    }
    const back = laws('simple-sell', form, other(true, 'items'), c, sellSame(c))
    expect(back.ratesIncludeGst).toBe(true)
    expect(back.lines.map((l) => [l.itemId, l.qtyText, l.rate, l.discount])).toEqual([[100, '2', 118_000, null], [101, '3', 10_500, 500]])
  })
  it('a changed line keeps the other lines as typed and carries the payment answers of the simple form', () => {
    const form: SellForm = {
      ...emptySellForm(TODAY, { mode: 'items', ratesIncludeGst: true }), customerId: L.ramesh, paid: 'part', partHow: 'upi', partAmount: 50_000, note: 'n',
      lines: [{ key: 1, itemId: 100, qtyText: '2', rate: 118_000, discount: null, auto: true }, { key: 2, itemId: 101, qtyText: '3', rate: 10_500, discount: null, auto: false }]
    }
    const E = handoff(INTENT['simple-sell'](form, c), c)
    const s = E.state as InvoiceFormState
    const edited = { ...E, state: { ...s, narration: 'Edited in the full app', rows: [s.rows[0]!, { ...s.rows[1]!, qtyText: '4' }] } } as HandoffEntry
    const r = carry('simple-sell', form, E, edited, c)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.form.lines[0]).toEqual(form.lines[0]) // untouched: as typed, still priced from the list
    expect(r.form.lines[1]).toMatchObject({ itemId: 101, qtyText: '4', rate: 10_500, auto: false })
    expect(r.form).toMatchObject({ note: 'Edited in the full app', paid: 'part', partHow: 'upi', partAmount: 50_000, ratesIncludeGst: true })
  })
  it('the walk-in stays the walk-in (created on save, or the counter’s own)', () => {
    const form: SellForm = { ...emptySellForm(TODAY, { mode: 'items', ratesIncludeGst: false }), lines: [{ key: 1, itemId: 101, qtyText: '1', rate: 4000, discount: null }] }
    const E = handoff(INTENT['simple-sell'](form, c), c)
    expect((E.state as InvoiceFormState).partyId).toBe(L.walkIn)
    const pending = { ...E, state: { ...(E.state as InvoiceFormState), partyId: null, narration: 'x' }, pending: { party: { name: 'Cash sale', create: { kind: 'walkIn' as const } } } } as HandoffEntry
    const r = carry('simple-sell', form, E, pending, c)
    expect(r.ok && r.form.customerId).toBe(null)
  })
})

describe('carryBack — Record a purchase', () => {
  it('random product bills of a regular company, before / with GST: both laws', () => {
    const c = ictx()
    const r = prng(99)
    const other = (incl: boolean): BuyForm => ({ ...emptyBuyForm('2025-07-30', { mode: 'items', ratesIncludeGst: incl }), supplierId: L.outState, billNo: 'Z-1', lines: [{ key: 9998, itemId: 102, qtyText: '7', rate: 999, discount: null }] })
    for (let i = 0; i < 40; i++) {
      const incl = i % 2 === 0
      laws('simple-buy', buyForm(r, incl, 'items', true), other(incl), c, buySame(c))
    }
  })
  it('a company that can’t claim GST: prices with GST (the cost) and before GST (folded) both come back', () => {
    const c = ictx({ regular: false })
    const r = prng(5)
    const other = (incl: boolean): BuyForm => ({ ...emptyBuyForm('2025-07-30', { mode: 'items', ratesIncludeGst: incl }), supplierId: L.outState, lines: [{ key: 9997, itemId: 102, qtyText: '7', rate: 999, discount: null }] })
    for (let i = 0; i < 30; i++) {
      const incl = i % 2 === 0
      laws('simple-buy', buyForm(r, incl, 'items', false), other(incl), c, (a, b) => expect([a.date, a.supplierId, a.note]).toEqual([b.date, b.supplierId, b.note]))
    }
  })
  it('random amount and expense bills: both laws', () => {
    const c = ictx()
    const r = prng(11)
    for (let i = 0; i < 40; i++) {
      const mode = i % 2 === 0 ? 'amount' : 'expense'
      const incl = i % 4 < 2
      const other: BuyForm = { ...emptyBuyForm('2025-07-30', { mode, ratesIncludeGst: incl }), supplierId: L.outState, amount: 4321, gstRate: 5, categoryId: mode === 'expense' ? L.rent : null }
      laws('simple-buy', buyForm(r, incl, mode, true), other, c, (a, b) => expect([a.date, a.supplierId, a.mode, a.categoryId, a.note]).toEqual([b.date, b.supplierId, b.mode, b.categoryId, b.note]))
    }
  })
  it('the supplier’s bill number typed in the editor becomes the bill number', () => {
    const c = ictx()
    const form: BuyForm = { ...emptyBuyForm(TODAY, { mode: 'items', ratesIncludeGst: false }), supplierId: L.supplier, billNo: 'INV-1', lines: [{ key: 1, itemId: 100, qtyText: '1', rate: 1000, discount: null }] }
    const E = handoff(INTENT['simple-buy'](form, c), c)
    const r = carry('simple-buy', form, E, { ...E, state: { ...(E.state as InvoiceFormState), billName: 'INV-1A' } } as HandoffEntry, c)
    expect(r.ok && r.form.billNo).toBe('INV-1A')
  })
})

describe('carryBack — Money in / out / move', () => {
  const c = ictx()
  it('money in from a customer: ticks, oldest first, advances, other money in — both laws', () => {
    const forms: MoneyInForm[] = [
      { ...emptyMoneyInForm(TODAY), customerId: L.ramesh, amount: 60_000 },
      { ...emptyMoneyInForm(TODAY), customerId: L.ramesh, amount: 30_000, ticks: ['S-2'], how: 'upi', accountId: L.upiBank, reference: 'UTR9' },
      { ...emptyMoneyInForm(TODAY), customerId: L.ramesh, amount: 150_000, advance: true, note: 'Advance for Diwali' },
      { ...emptyMoneyInForm('2025-08-10'), customerId: L.ramesh, amount: 25_000, ticks: ['S-3', 'S-2'], how: 'bank', accountId: L.bank },
      { ...emptyMoneyInForm(TODAY), who: 'income', sourceId: L.otherIncome, amount: 999 }
    ]
    const other: MoneyInForm = { ...emptyMoneyInForm('2025-08-01'), customerId: L.ramesh, amount: 5_000, ticks: ['S-1'] }
    const who = (f: MoneyInForm): unknown => [f.who, f.date, f.amount, f.who === 'customer' ? f.customerId : f.sourceId, f.note]
    for (const f of forms) laws('simple-money-in', f, other, c, (a, b) => expect(who(a)).toEqual(who(b)))
  })
  it('money out: supplier bills, an expense, the owner — both laws', () => {
    const forms: MoneyOutForm[] = [
      { ...emptyMoneyOutForm(TODAY), supplierId: L.supplier, amount: 45_000 },
      { ...emptyMoneyOutForm(TODAY), supplierId: L.supplier, amount: 15_000, ticks: ['B-10'], how: 'bank', accountId: L.bank },
      { ...emptyMoneyOutForm(TODAY), who: 'expense', payeeId: L.rent, amount: 1_200_000, gstBill: false, note: 'Rent August' },
      { ...emptyMoneyOutForm(TODAY), who: 'owner', amount: 500_000 }
    ]
    const other: MoneyOutForm = { ...emptyMoneyOutForm('2025-08-01'), supplierId: L.supplier, amount: 1_000 }
    for (const f of forms) laws('simple-money-out', f, other, c, (a, b) => expect([a.date, a.amount, a.who, a.note]).toEqual([b.date, b.amount, b.who, b.note]))
  })
  it('money out of an expense with a GST bill (the purchase the hand-off opened): both laws', () => {
    const form: MoneyOutForm = { ...emptyMoneyOutForm(TODAY), who: 'expense', payeeId: L.rent, amount: 1_180_000, gstBill: true, billSupplierId: L.supplier, billNo: 'R-8', gstRate: 18 }
    const other: MoneyOutForm = { ...form, amount: 10_500, gstRate: 5, billNo: 'R-1' }
    laws('simple-money-out', form, other, c, (a, b) => expect([a.amount, a.gstRate, a.billNo, a.billSupplierId]).toEqual([b.amount, b.gstRate, b.billNo, b.billSupplierId]))
  })
  it('move money: both laws', () => {
    const form: MoveForm = { ...emptyMoveForm(TODAY), amount: 2_000_000, fromId: L.cash, toId: L.bank, reference: 'DEP-1', note: 'Deposit' }
    laws('simple-move-money', form, { ...emptyMoveForm('2025-08-01'), amount: 1, fromId: L.bank, toId: L.cash }, c, (a, b) => expect(a).toEqual(b))
  })
  it('a payment split between bills the ticks can’t give is carried with the ticks and named', () => {
    const form: MoneyInForm = { ...emptyMoneyInForm(TODAY), customerId: L.ramesh, amount: 30_000 }
    const E = handoff(INTENT['simple-money-in'](form, c), c)
    const s = E.state as AccountingFormState
    const split = { ...E, state: { ...s, billRefs: [{ kind: 'against', name: 'S-1', amount: 10_000, dueDate: null }, { kind: 'against', name: 'S-2', amount: 20_000, dueDate: null }] } } as HandoffEntry
    const r = carry('simple-money-in', form, E, split, c)
    expect(r).toMatchObject({ ok: true, dropped: ['billSplit'], form: { ticks: ['S-1', 'S-2'] } })
  })
  it('another bank in the editor: the account comes back, UPI stays UPI', () => {
    const form: MoneyInForm = { ...emptyMoneyInForm(TODAY), customerId: L.ramesh, amount: 30_000, how: 'upi', accountId: null }
    const E = handoff(INTENT['simple-money-in'](form, c), c)
    const s = E.state as AccountingFormState
    const r = carry('simple-money-in', form, E, { ...E, state: { ...s, rows: [{ ...s.rows[0]!, ledgerId: L.bank }, s.rows[1]!] } } as HandoffEntry, c)
    expect(r.ok && [r.form.how, r.form.accountId]).toEqual(['upi', L.bank])
  })
})

describe('carryBack — Returns', () => {
  it('a return of products: quantities per bill line and the reason — both laws', () => {
    const c = ictx({ original: ORIGINAL_ITEMS })
    const form: ReturnForm = { ...emptyReturnForm(TODAY), qty: { u1: '2', u2: '1.5' }, reason: 'Damaged' }
    laws('simple-return-sale', form, { ...emptyReturnForm('2025-08-05'), qty: { u1: '1' } }, c, (a, b) => expect([a.qty, a.reason, a.date]).toEqual([b.qty, b.reason, b.date]))
  })
  it('a return of an amount from a purchase bill — both laws', () => {
    const c = ictx({ original: ORIGINAL_AMOUNT })
    const form: ReturnForm = { ...emptyReturnForm(TODAY), amount: 25_000, reason: 'Short supply', settle: 'credit' }
    laws('simple-return-purchase', form, { ...emptyReturnForm('2025-08-05'), amount: 100 }, c, (a, b) => expect([a.amount, a.reason]).toEqual([b.amount, b.reason]))
  })
  it('a return line at another price than the bill’s can’t be held by the simple form', () => {
    const c = ictx({ original: ORIGINAL_ITEMS })
    const form: ReturnForm = { ...emptyReturnForm(TODAY), qty: { u1: '2' } }
    const E = handoff(INTENT['simple-return-sale'](form, c), c)
    const s = E.state as InvoiceFormState
    expect(carry('simple-return-sale', form, E, { ...E, state: { ...s, rows: [{ ...s.rows[0]!, rate: 9_000 }] } } as HandoffEntry, c)).toEqual({ ok: false, reason: 'price' })
  })
})

describe('carryBack — what has no place in the simple form', () => {
  const c = ictx()
  const form: SellForm = { ...emptySellForm(TODAY, { mode: 'items', ratesIncludeGst: false }), customerId: L.ramesh, paid: 'credit', lines: [{ key: 1, itemId: 100, qtyText: '1', rate: 1000, discount: null }] }
  it('an invoice: number, transport, place of supply, TCS, due date, storage place — named, the rest carried', () => {
    const E = handoff(INTENT['simple-sell'](form, c), c)
    const s = E.state as InvoiceFormState
    const edited = {
      ...E,
      state: {
        ...s, number: 'S-99', vehicleNo: 'MH12AB1234', posOverride: '29', billDueDate: '2025-12-31', narration: 'kept',
        tcs: { sectionId: 1, baseAmount: 1180, tdsAmount: 1, isManual: false, pending: false }, rows: [{ ...s.rows[0]!, godownId: 3 }]
      }
    } as HandoffEntry
    const r = carry('simple-sell', form, E, edited, c)
    expect(r).toMatchObject({ ok: true, dropped: ['number', 'tcs', 'transport', 'placeOfSupply', 'dueDate', 'godowns'], form: { note: 'kept' } })
  })
  it('an accounting entry: TDS, cost centres and an extra line — named, the payment carried', () => {
    const f: MoneyOutForm = { ...emptyMoneyOutForm(TODAY), who: 'expense', payeeId: L.rent, amount: 100_000, gstBill: false }
    const E = handoff(INTENT['simple-money-out'](f, c), c)
    const s = E.state as AccountingFormState
    const edited = {
      ...E,
      state: {
        ...s,
        tds: { sectionId: 2, baseAmount: 100_000, tdsAmount: 10_000 },
        rows: [{ ...s.rows[0]!, costAllocations: [{ costCentreId: 1, amount: 100_000 }] }, s.rows[1]!, { drCr: 'dr', ledgerId: L.purchases, amount: 500, costAllocations: [] }]
      }
    } as HandoffEntry
    const r = carry('simple-money-out', f, E, edited, c)
    expect(r).toMatchObject({ ok: true, dropped: ['extraLines', 'tds', 'costCentres'], form: { who: 'expense', payeeId: L.rent, amount: 100_000 } })
  })
  it('refused: a sale whose debit is not a customer, GST that fits no rate', () => {
    const amount: SellForm = { ...emptySellForm(TODAY, { mode: 'amount', ratesIncludeGst: false }), customerId: L.ramesh, paid: 'credit', amount: 100_000, gstRate: 18 }
    const E = handoff(INTENT['simple-sell'](amount, c), c)
    const s = E.state as AccountingFormState
    expect(carry('simple-sell', amount, E, { ...E, state: { ...s, rows: s.rows.map((r) => (r.ledgerId === L.ramesh ? { ...r, ledgerId: L.rent } : r)) } } as HandoffEntry, c)).toEqual({ ok: false, reason: 'party' })
    expect(carry('simple-sell', amount, E, { ...E, state: { ...s, rows: s.rows.map((r) => (r.ledgerId === L.cgstOut ? { ...r, amount: 1234 } : r)) } } as HandoffEntry, c)).toEqual({ ok: false, reason: 'gst' })
  })
  it('refused: the editor is not the form the hand-off opened', () => {
    const E = handoff(INTENT['simple-sell'](form, c), c)
    const acc = handoff(INTENT['simple-sell']({ ...form, mode: 'amount', lines: [], amount: 1000, gstRate: 18 }, c), c)
    expect(carry('simple-sell', form, E, acc, c)).toEqual({ ok: false, reason: 'form' })
  })
})
