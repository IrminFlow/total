// WP 9.5 — the pure half of the return screens: the live total IS what mapIntent posts (the same
// rows through computeInvoice / computeGst), the split between the bill and the party's credit,
// the form's checks, and the intent (a refund only for the part that is a credit).
import { describe, expect, it } from 'vitest'
import { translator } from '../i18n'
import { bannedWordsIn } from './bannedWords'
import { mapIntent, normaliseIntent, type IntentContext, type IntentFacts, type IntentLedger, type IntentLedgerClass, type IntentOriginal } from './intents'
import {
  emptyReturnForm, returnAsks, returnFormErrors, returnIntentFrom, returnPreviewLines, returnQtyOf, returnSplit, returnTotals,
  type ReturnBill, type ReturnContext, type ReturnForm
} from './returns'

const TODAY = '2025-08-14'
const t = translator('en')
const L = { cash: 1, bank: 2, sales: 4, purchases: 5, ramesh: 10, kumar: 11, walkIn: 12, supplier: 20, cgstO: 30, sgstO: 31, igstO: 32, cgstI: 33, sgstI: 34, igstI: 35, round: 36 }
const led = (id: number, name: string, cls: IntentLedgerClass, extra: Partial<IntentLedger> = {}): [number, IntentLedger] => [id, { id, name, cls, stateCode: null, gstRate: null, creditDays: null, ...extra }]

function intentCtx(reg: 'regular' | 'composition' | 'unregistered', original: IntentOriginal): IntentContext {
  const ledgers = new Map<number, IntentLedger>([
    led(L.cash, 'Cash', 'cash'), led(L.bank, 'HDFC Bank', 'bank'), led(L.sales, 'Sales', 'income'), led(L.purchases, 'Purchases', 'expense'),
    led(L.ramesh, 'Ramesh', 'debtor', { stateCode: '27' }), led(L.kumar, 'Kumar', 'debtor', { stateCode: '29' }), led(L.walkIn, 'Cash sale', 'debtor'),
    led(L.supplier, 'Bharat Steel', 'creditor', { stateCode: '27' }),
    led(L.cgstO, 'Output CGST', 'tax'), led(L.sgstO, 'Output SGST', 'tax'), led(L.igstO, 'Output IGST', 'tax'),
    led(L.cgstI, 'Input CGST', 'tax'), led(L.sgstI, 'Input SGST', 'tax'), led(L.igstI, 'Input IGST', 'tax'), led(L.round, 'Round Off', 'other')
  ])
  return {
    invoice: {
      companyStateCode: '27',
      gstRegistrationType: reg,
      ...(reg !== 'regular' ? { gstRegistrationSince: '2025-08-10', gstPreviousRegistrationType: 'regular' as const } : {}),
      items: new Map([[100, { gstRate: 18, cessRate: null }], [101, { gstRate: 5, cessRate: null }]]),
      ledgers: new Map([...ledgers.values()].map((l) => [l.id, { stateCode: l.stateCode, gstRate: l.gstRate }]))
    },
    ledgers,
    items: new Map([[100, { id: 100, name: 'Widget' }], [101, { id: 101, name: 'Rice' }]]),
    types: {
      credit_note: { id: 6, name: 'Credit Note', numbering: 'auto', next: 'CN-1' },
      debit_note: { id: 7, name: 'Debit Note', numbering: 'auto', next: 'DN-1' },
      payment: { id: 4, name: 'Payment', numbering: 'auto', next: 'PY-2' },
      receipt: { id: 3, name: 'Receipt', numbering: 'auto', next: 'R-5' }
    },
    taxLedgers: {
      output: { cgst: L.cgstO, sgst: L.sgstO, igst: L.igstO, cess: null, roundOff: L.round },
      input: { cgst: L.cgstI, sgst: L.sgstI, igst: L.igstI, cess: null, roundOff: L.round }
    },
    defaults: { walkInId: L.walkIn, cashId: L.cash, upiId: L.bank, cardId: L.bank, bankId: L.bank, salesId: L.sales, purchaseId: L.purchases, drawingsId: null },
    prices: new Map(),
    openBills: new Map(),
    original,
    takenNames: new Map()
  }
}

const LINES = [
  { lineUid: 'u-1', itemId: 100, qtyMilli: 3000, ratePaise: 33_333, discountPaise: 1_000, godownId: null, batchId: null, leftMilli: 3000 },
  { lineUid: 'u-2', itemId: 101, qtyMilli: 7000, ratePaise: 4_999, discountPaise: 0, godownId: null, batchId: null, leftMilli: 5000 }
]
const original = (over: Partial<IntentOriginal> = {}): IntentOriginal => ({
  voucherId: 500, kind: 'sales', date: '2025-08-01', number: 'S-4', partyId: L.ramesh, accountId: L.sales, billName: 'S-4', pending: 20_000,
  carriesGst: true, rates: [18, 5], lines: LINES, noteReference: 'S-4', amountLeft: null, ...over
})
/** The screen's view of the same bill (simple:returns:bill). */
const billOf = (o: IntentOriginal, extra: Partial<ReturnBill> = {}): ReturnBill => ({
  voucherId: o.voucherId, side: o.kind === 'sales' ? 'sale' : 'purchase', number: o.number, billNo: null, date: o.date, partyId: o.partyId,
  partyName: 'Ramesh', partyStateCode: o.partyId === L.kumar ? '29' : '27', walkIn: false, total: 0, tax: 0, billName: o.billName, pending: o.pending,
  carriesGst: o.carriesGst, rates: o.rates, accountId: o.accountId, mode: o.lines.length ? 'items' : 'amount',
  lines: o.lines.map((l) => ({ ...l, name: 'X', unit: 'Nos', amount: 0 })), amountTaxable: 100_000, amountLeft: o.amountLeft ?? null, earlier: [], ...extra
})
const rctx = (c: IntentContext): ReturnContext => ({ invoice: c.invoice })
const DEFAULTS = { cash: L.cash, upi: L.bank, card: L.bank, bank: L.bank }
const form = (patch: Partial<ReturnForm>): ReturnForm => ({ ...emptyReturnForm(TODAY), ...patch })
const posted = (c: IntentContext, f: ReturnForm, b: ReturnBill) => mapIntent(normaliseIntent({ clientId: 'returns-0001', ...returnIntentFrom(f, b, rctx(c), DEFAULTS) }, TODAY), c)

describe('the live total is what simple:post saves', () => {
  const cases: [string, 'regular' | 'composition' | 'unregistered', Partial<IntentOriginal>, Partial<ReturnForm>][] = [
    ['two lines, pro-rata discount, intra-state', 'regular', {}, { qty: { 'u-1': '2', 'u-2': '1.5' } }],
    ['one line, inter-state', 'regular', { partyId: L.kumar }, { qty: { 'u-1': '1' } }],
    ['a purchase', 'regular', { kind: 'purchase', partyId: L.supplier, accountId: L.purchases }, { qty: { 'u-2': '5' } }],
    ['note dated after the business left GST: the bill’s GST stays (s.34)', 'unregistered', {}, { qty: { 'u-1': '3' } }],
    ['composition now, regular bill', 'composition', {}, { qty: { 'u-2': '2' } }],
    ['just an amount at the bill’s one rate', 'regular', { lines: [], rates: [12] }, { amount: 33_333 }],
    ['just an amount, several rates: the rate asked', 'regular', { lines: [], rates: [5, 18] }, { amount: 50_050, gstRate: 18 }],
    ['just an amount, a bill without GST', 'regular', { lines: [], rates: [0], carriesGst: false }, { amount: 10_000 }]
  ]
  for (const [name, reg, over, patch] of cases) {
    it(name, () => {
      const o = original(over)
      const c = intentCtx(reg, o)
      const b = billOf(o)
      const f = form(patch)
      const live = returnTotals(f, b, rctx(c))
      const m = posted(c, f, b)
      expect(live.total).toBe(m.facts.total)
      expect(live.tax).toBe(m.facts.tax)
      expect(live.total).toBeGreaterThan(0)
      // The split the screen says = how mapIntent settled it.
      expect(returnSplit(live.total, o.pending)).toEqual({ offBill: m.facts.offBill, credit: m.facts.credit })
    })
  }

  it('line values: each line before GST, null when nothing is coming back', () => {
    const o = original()
    const live = returnTotals(form({ qty: { 'u-1': '2' } }), billOf(o), rctx(intentCtx('regular', o)))
    // 2 × 333.33 = 666.66 less 2/3 of the ₹10 discount (6.67) = 659.99.
    expect(live.lineAmounts).toEqual({ 'u-1': 65_999, 'u-2': null })
  })

  it('a stale GST rate is never used when the bill has one rate (and never sent)', () => {
    const o = original({ lines: [], rates: [12] })
    const c = intentCtx('regular', o)
    const f = form({ amount: 10_000, gstRate: 28 })
    expect(returnTotals(f, billOf(o), rctx(c)).tax).toBe(1_200)
    expect(returnIntentFrom(f, billOf(o), rctx(c), DEFAULTS)).toMatchObject({ amount: { amount: 10_000 } })
    expect('gstRate' in (returnIntentFrom(f, billOf(o), rctx(c), DEFAULTS) as { amount: object }).amount).toBe(false)
  })
})

describe('what is asked', () => {
  it('the GST rate only for an amount on a bill with several (or unknown) rates; an item bill whose rates changed is blocked', () => {
    const c = (o: IntentOriginal) => rctx(intentCtx('regular', o))
    const f = form({})
    expect(returnAsks(f, billOf(original({ lines: [], rates: [12] })), c(original()))).toEqual({ rate: false, blocked: false })
    expect(returnAsks(f, billOf(original({ lines: [], rates: [5, 12] })), c(original()))).toEqual({ rate: true, blocked: false })
    expect(returnAsks(f, billOf(original({ lines: [], rates: null })), c(original()))).toEqual({ rate: true, blocked: false })
    expect(returnAsks(f, billOf(original({ rates: null })), c(original()))).toEqual({ rate: false, blocked: true })
    // An unregistered business returning a bill that carried no GST: nothing to ask.
    expect(returnAsks(f, billOf(original({ lines: [], rates: [0], carriesGst: false })), rctx(intentCtx('unregistered', original())))).toEqual({ rate: false, blocked: false })
  })

  it('the refund is sent only for the part that is a credit', () => {
    const o = original({ pending: 200_000 })
    const c = intentCtx('regular', o)
    const f = form({ qty: { 'u-1': '1' }, settle: 'refund', how: 'upi' })
    expect('refund' in returnIntentFrom(f, billOf(o), rctx(c), DEFAULTS)).toBe(false)
    const paid = original({ pending: 0 })
    expect(returnIntentFrom(f, billOf(paid), rctx(intentCtx('regular', paid)), DEFAULTS)).toMatchObject({ refund: { how: 'upi', accountId: L.bank } })
    expect(posted(intentCtx('regular', paid), f, billOf(paid)).entries.map((e) => e.role)).toEqual(['note', 'refund'])
    expect('refund' in returnIntentFrom({ ...f, settle: 'credit' }, billOf(paid), rctx(intentCtx('regular', paid)), DEFAULTS)).toBe(false)
  })

  it('returnSplit: what is pending comes off the bill first', () => {
    expect(returnSplit(1000, 0)).toEqual({ offBill: 0, credit: 1000 })
    expect(returnSplit(1000, 300)).toEqual({ offBill: 300, credit: 700 })
    expect(returnSplit(1000, 5000)).toEqual({ offBill: 1000, credit: 0 })
    expect(returnSplit(1000, -50)).toEqual({ offBill: 0, credit: 1000 })
  })
})

describe('the form’s checks', () => {
  const o = original()
  const c = rctx(intentCtx('regular', o))
  it('items: nothing ticked, not a number, more than is left', () => {
    expect(returnFormErrors(form({}), billOf(o), c)).toEqual({ items: 'simple.returns.err.nothing' })
    expect(returnFormErrors(form({ qty: { 'u-1': 'two' } }), billOf(o), c)).toEqual({ items: 'simple.returns.err.qty' })
    expect(returnFormErrors(form({ qty: { 'u-2': '6' } }), billOf(o), c)).toEqual({ items: 'simple.returns.err.tooMany' })
    expect(returnFormErrors(form({ qty: { 'u-2': '5', 'u-1': '0' } }), billOf(o), c)).toEqual({})
    expect(returnFormErrors(form({ qty: { 'u-1': '1' } }), billOf(original({ rates: null })), c)).toEqual({ items: 'simple.returns.err.ratesChanged' })
  })
  it('a return dated before its bill is refused at the date — by the form and by mapReturn (review fix)', () => {
    expect(returnFormErrors(form({ date: '2025-07-31', qty: { 'u-1': '1' } }), billOf(o), c)).toEqual({ date: 'simple.returns.err.beforeBill' })
    expect(() => mapIntent(normaliseIntent({ clientId: 'returns-0002', kind: 'return_sale', date: '2025-07-31', billId: 500, items: [{ lineUid: 'u-1', qty: '1' }] }, TODAY), intentCtx('regular', o))).toThrow(
      expect.objectContaining({ code: 'simple_return_before_bill', field: 'date', params: { date: '2025-08-01' } })
    )
    // The bill's own day is fine.
    expect(() => mapIntent(normaliseIntent({ clientId: 'returns-0003', kind: 'return_sale', date: '2025-08-01', billId: 500, items: [{ lineUid: 'u-1', qty: '1' }] }, TODAY), intentCtx('regular', o))).not.toThrow()
  })
  it('amounts: none, more than is left, the rate when asked; a refund needs an account', () => {
    const a = original({ lines: [], rates: [5, 18], amountLeft: 40_000 })
    const ac = rctx(intentCtx('regular', a))
    expect(returnFormErrors(form({}), billOf(a), ac)).toEqual({ amount: 'simple.returns.err.amount', gstRate: 'simple.returns.err.gstRate' })
    expect(returnFormErrors(form({ amount: 40_001, gstRate: 5 }), billOf(a), ac)).toEqual({ amount: 'simple.returns.err.amountTooMuch' })
    expect(returnFormErrors(form({ amount: 40_000, gstRate: 5 }), billOf(a), ac)).toEqual({})
    const paid = billOf(a, { pending: 0 })
    expect(returnFormErrors(form({ amount: 100, gstRate: 5, settle: 'refund' }), paid, ac, { refundAccount: false })).toEqual({ refund: 'simple.returns.err.noAccount' })
  })
  it('quantities: blank / 0 = nothing, "2.5", Indian grouping; floats never', () => {
    expect([returnQtyOf(''), returnQtyOf('0'), returnQtyOf('0.0'), returnQtyOf('2.5'), returnQtyOf('1,000'), returnQtyOf('1.2345'), returnQtyOf('-1')]).toEqual([0, 0, 0, 2500, 1_000_000, null, null])
  })
})

describe('the plain words', () => {
  const facts: IntentFacts = {
    kind: 'return_sale', partyName: 'Cash sale', total: 59_000, tax: 9_000, paid: 59_000, how: 'upi', moneyAccount: 'HDFC Bank', due: 0, settled: [], advance: 0,
    fromName: null, toName: null, againstBill: null, offBill: 0, credit: 59_000, walkIn: false, balance: 0, noGst: null, side: 'customer'
  }
  it('a walk-in is "a cash customer" and gets no balance sentence; a named customer is told where they stand', () => {
    expect(returnPreviewLines(facts, t, { walkIn: true })).toEqual(['Sale return ₹590.00 from a cash customer.', 'Includes GST ₹90.00.', '₹590.00 paid back by UPI.'])
    const kept = returnPreviewLines({ ...facts, partyName: 'Ramesh', paid: 0, how: null, balance: -59_000 }, t, { walkIn: false })
    expect(kept).toEqual(['Sale return ₹590.00 from Ramesh.', 'Includes GST ₹90.00.', 'Ramesh keeps ₹590.00 to use on a later bill.'])
    for (const s of [...kept, ...returnPreviewLines(facts, t, { walkIn: true })]) expect(bannedWordsIn(s)).toEqual([])
  })
})
