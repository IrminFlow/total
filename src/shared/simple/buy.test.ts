// WP 9.3 — Record a purchase, the pure half: live totals are the editor's own calculation
// (computeInvoice / computeGst + rupee round-off) and equal what mapIntent posts for the same
// answers — a claimed bill (prices before / with GST, intra- / inter-state), a bill without GST,
// a business that can't claim GST (with GST typed in = the cost; before GST = folded in); the
// purchase intent; the form's checks; the plain preview line; the purchase list's status.
import { describe, expect, it } from 'vitest'
import { t as translate } from '../i18n'
import { computeInvoice, emptyInvoiceState } from '../voucherEdit'
import { mapIntent, normaliseIntent, type IntentContext, type IntentFacts, type IntentLedger } from './intents'
import { bannedWordsIn } from './bannedWords'
import {
  buyFormErrors, buyGst, buyIntentLines, buyLineRateMissing, buyTotals, emptyBuyForm, purchaseIntentFrom, purchasePreviewLine, purchaseStatus,
  type BuyContext, type BuyForm
} from './buy'

const t = (key: Parameters<typeof translate>[0], vars?: Parameters<typeof translate>[1]): string => translate(key, vars, 'en')
const DATE = '2026-10-13'

// Ledgers: 10 Bharat Steel (supplier, MH), 11 Karnataka Mills (supplier, KA), 20 Purchases,
// 21 Rent (expense, 18 %), 22 Electricity (expense, no rate), 30 Cash, 31 HDFC Bank.
function ctxFor(reg: 'regular' | 'composition' | 'unregistered' = 'regular'): BuyContext {
  return {
    invoice: {
      companyStateCode: '27',
      gstRegistrationType: reg,
      items: new Map([
        [1, { gstRate: 18, cessRate: null }],
        [2, { gstRate: 5, cessRate: null }],
        [3, { gstRate: null, cessRate: null }]
      ]),
      ledgers: new Map([
        [10, { stateCode: '27', gstRate: null }],
        [11, { stateCode: '29', gstRate: null }],
        [20, { stateCode: null, gstRate: null }],
        [21, { stateCode: null, gstRate: 18 }],
        [22, { stateCode: null, gstRate: null }]
      ])
    },
    purchaseAccountId: 20
  }
}

const form = (patch: Partial<BuyForm> = {}): BuyForm => ({ ...emptyBuyForm(DATE, { mode: 'items', ratesIncludeGst: false }), supplierId: 10, ...patch })
const line = (key: number, itemId: number | null, qtyText: string, rate: number | null, discount: number | null = null) => ({ key, itemId, qtyText, rate, discount })
const DEFAULTS = { cash: 30, upi: 31, card: 31, bank: 31 }

/** The same context mapIntent reads (main builds it from the books). */
function intentCtx(c: BuyContext): IntentContext {
  const L = (id: number, name: string, cls: IntentLedger['cls'], stateCode: string | null = null, gstRate: number | null = null): [number, IntentLedger] => [id, { id, name, cls, stateCode, gstRate, creditDays: 30 }]
  return {
    invoice: c.invoice,
    ledgers: new Map([
      L(10, 'Bharat Steel', 'creditor', '27'), L(11, 'Karnataka Mills', 'creditor', '29'), L(20, 'Purchases', 'expense'), L(21, 'Rent', 'expense', null, 18),
      L(22, 'Electricity', 'expense'), L(30, 'Cash', 'cash'), L(31, 'HDFC Bank', 'bank')
    ]),
    items: new Map([[1, { id: 1, name: 'Widget' }], [2, { id: 2, name: 'Rice' }], [3, { id: 3, name: 'Sugar' }]]),
    types: { purchase: { id: 1, name: 'Purchase', numbering: 'auto', next: 'P-1' }, payment: { id: 2, name: 'Payment', numbering: 'auto', next: 'PY-1' } },
    taxLedgers: { output: { cgst: 40, sgst: 41, igst: 42, cess: 43, roundOff: 44 }, input: { cgst: 50, sgst: 51, igst: 52, cess: 53, roundOff: 54 } },
    defaults: { walkInId: null, cashId: 30, upiId: 31, cardId: 31, bankId: 31, salesId: null, purchaseId: 20, drawingsId: null },
    prices: new Map(),
    openBills: new Map(),
    takenNames: new Map(),
    original: null
  }
}

/** What simple:post would save for these answers (the pure mapping, same as main). */
function posted(f: BuyForm, c: BuyContext) {
  return mapIntent(normaliseIntent({ clientId: 'test-client-1', ...purchaseIntentFrom(f, c, DEFAULTS) }, DATE), intentCtx(c))
}
const linesOf = (m: ReturnType<typeof posted>, i = 0) => m.entries[i]!.payload.lines.map((l) => [l.ledgerId, l.drCr, l.amount])

describe('live totals = the editor calculation = what is posted', () => {
  it('a claimed bill, products, prices before GST, intra-state: input CGST + SGST', () => {
    const c = ctxFor()
    const f = form({ lines: [line(1, 1, '10', 10_000), line(2, 2, '3', 6_000, 1_000)] })
    const tot = buyTotals(f, c)
    const editor = computeInvoice(
      { ...emptyInvoiceState(DATE), partyId: 10, accountId: 20, rows: [{ itemId: 1, qtyText: '10', rate: 10_000, discount: null, godownId: null, batchId: null }, { itemId: 2, qtyText: '3', rate: 6_000, discount: 1_000, godownId: null, batchId: null }] },
      { ...c.invoice, kind: 'purchase' }
    )
    expect(tot).toMatchObject({ taxable: editor.gst.taxable, tax: editor.gst.total - editor.gst.taxable, total: editor.rounded, gst: 'claim', folded: 0 })
    expect(tot.lineAmounts).toEqual([100_000, 17_000])
    const m = posted(f, c)
    expect(m.facts.total).toBe(tot.total)
    expect(m.entries[0]!.payload.lines.filter((l) => l.ledgerId === 50 || l.ledgerId === 51).every((l) => l.drCr === 'dr')).toBe(true)
  })

  it('an inter-state supplier: IGST; prices with GST become the editor exclusive rate', () => {
    const c = ctxFor()
    const f = form({ supplierId: 11, ratesIncludeGst: true, lines: [line(1, 1, '2', 11_800)] })
    expect(buyIntentLines(f, c).lines[0]).toMatchObject({ rate: 10_000 })
    expect(buyTotals(f, c)).toMatchObject({ taxable: 20_000, tax: 3_600, total: 23_600 })
    const m = posted(f, c)
    expect(m.facts.total).toBe(23_600)
    expect(linesOf(m)).toContainEqual([52, 'dr', 3_600])
  })

  it('an expense with GST: computeGst at the picked rate (or the account’s) + rupee round-off', () => {
    const c = ctxFor()
    const f = form({ mode: 'expense', categoryId: 22, amount: 100_050, gstRate: 18 })
    // ₹1,180.60 → ₹1,181.00: the round-off is its own figure (the form's "Rounded off" line).
    expect(buyTotals(f, c)).toMatchObject({ taxable: 100_050, tax: 18_010, total: 118_100, rounding: 40 })
    expect(posted(f, c).facts.total).toBe(118_100)
    // Rent carries 18 % itself: nothing to pick.
    const rent = form({ mode: 'expense', categoryId: 21, amount: 118_000, ratesIncludeGst: true })
    expect(buyFormErrors(rent, c)).toEqual({})
    expect(buyTotals(rent, c)).toMatchObject({ taxable: 100_000, tax: 18_000, total: 118_000 })
    expect(linesOf(posted(rent, c))).toEqual([[10, 'cr', 118_000], [21, 'dr', 100_000], [50, 'dr', 9_000], [51, 'dr', 9_000]])
  })

  it('a regular company, no GST on the bill: just an amount, no tax lines', () => {
    const c = ctxFor()
    const f = form({ mode: 'amount', amount: 50_000, gstOnBill: false })
    expect(buyGst(f, c)).toBe('none')
    expect(buyTotals(f, c)).toMatchObject({ tax: 0, total: 50_000 })
    const m = posted(f, c)
    expect(linesOf(m)).toEqual([[10, 'cr', 50_000], [20, 'dr', 50_000]])
    // Products can't be held without their GST: refused before main, and by main.
    const items = form({ gstOnBill: false, lines: [line(1, 1, '1', 10_000)] })
    expect(buyFormErrors(items, c).gstOnBill).toBe('errors.intent.itemsNoGst')
    expect(() => posted(items, c)).toThrow(expect.objectContaining({ code: 'simple_items_no_gst', field: 'gstOnBill' }))
    // Review fix: nil-rated products (no GST on the product, none on the account) post no tax
    // either way — a bill without GST may list them.
    const nil = form({ gstOnBill: false, lines: [line(1, 3, '4', 2_500)] })
    expect(buyFormErrors(nil, c)).toEqual({})
    expect(buyTotals(nil, c)).toMatchObject({ tax: 0, total: 10_000 })
    const pm = posted(nil, c)
    expect(pm.facts).toMatchObject({ total: 10_000, tax: 0 })
    expect(linesOf(pm)).toEqual([[10, 'cr', 10_000], [20, 'dr', 10_000]])
    // …but one taxed product among them is still refused.
    const mixed = form({ gstOnBill: false, lines: [line(1, 3, '4', 2_500), line(2, 2, '1', 1_000)] })
    expect(buyFormErrors(mixed, c).gstOnBill).toBe('errors.intent.itemsNoGst')
    expect(() => posted(mixed, c)).toThrow(expect.objectContaining({ code: 'simple_items_no_gst' }))
  })

  it('a business that can’t claim GST: typed with GST = the cost; before GST = folded in (WP 8.0)', () => {
    for (const reg of ['unregistered', 'composition'] as const) {
      const c = ctxFor(reg)
      // With GST (what was paid): the price is the cost, nothing added.
      const paid = form({ ratesIncludeGst: true, lines: [line(1, 2, '10', 10_500)] })
      expect(buyGst(paid, c)).toBe('paid')
      expect(buyTotals(paid, c)).toMatchObject({ tax: 0, folded: 0, total: 105_000 })
      expect(purchaseIntentFrom(paid, c, DEFAULTS).gstOnBill).toBe(false)
      expect(posted(paid, c).facts.total).toBe(105_000)
      // Before GST, the product at 5 %: 10 × ₹100 + 5 % = ₹1,050 of cost, no tax line.
      const before = form({ ratesIncludeGst: false, lines: [line(1, 2, '10', 10_000)] })
      expect(buyGst(before, c)).toBe('fold')
      const tot = buyTotals(before, c)
      expect(tot).toMatchObject({ tax: 0, folded: 5_000, total: 105_000, lineAmounts: [105_000] })
      const m = posted(before, c)
      expect(m.facts.total).toBe(tot.total)
      expect(m.entries[0]!.payload.lines.some((l) => [50, 51, 52].includes(l.ledgerId))).toBe(false)
      // An expense before GST at a picked rate: folded too.
      const exp = form({ mode: 'expense', categoryId: 22, amount: 100_000, gstRate: 18 })
      expect(buyTotals(exp, c)).toMatchObject({ folded: 18_000, total: 118_000 })
      expect(linesOf(posted(exp, c))).toEqual([[10, 'cr', 118_000], [22, 'dr', 118_000]])
    }
  })
})

describe('the purchase intent', () => {
  it('the supplier, their bill number, the bill date; quantities as thousandths', () => {
    const c = ctxFor()
    const i = purchaseIntentFrom(form({ billNo: ' INV-204 ', note: 'Steel', lines: [line(1, 1, '1.5', 4_000), line(2, 3, '1,000', 100)] }), c, DEFAULTS)
    expect(i).toEqual({
      kind: 'purchase', date: DATE, supplierId: 10, billNo: 'INV-204', narration: 'Steel', gstOnBill: true, payment: { how: 'credit' },
      items: [{ itemId: 1, qty: 1_500, rate: 4_000 }, { itemId: 3, qty: 1_000_000, rate: 100 }]
    })
  })

  it('paid now / partly / a chosen account; an expense names its account', () => {
    const c = ctxFor()
    expect(purchaseIntentFrom(form({ paid: 'bank', lines: [line(1, 1, '1', 100)] }), c, DEFAULTS).payment).toEqual({ how: 'bank', accountId: 31 })
    expect(purchaseIntentFrom(form({ paid: 'part', partHow: 'cash', partAmount: 500, lines: [line(1, 1, '1', 10_000)] }), c, DEFAULTS).payment).toEqual({ how: 'cash', amount: 500, accountId: 30 })
    expect(purchaseIntentFrom(form({ paid: 'upi', accountId: 99, lines: [line(1, 1, '1', 100)] }), c, DEFAULTS).payment).toEqual({ how: 'upi', accountId: 99 })
    expect(purchaseIntentFrom(form({ mode: 'expense', categoryId: 22, amount: 5_000, gstRate: 0 }), c, DEFAULTS).amount).toEqual({ amount: 5_000, accountId: 22, gstRate: 0 })
    expect(purchaseIntentFrom(form({ mode: 'amount', amount: 5_000, gstOnBill: false }), c, DEFAULTS).amount).toEqual({ amount: 5_000, accountId: 20 })
  })

  it('part paid: the bill + a payment against it; the rest due by the credit days', () => {
    const c = ctxFor()
    const m = posted(form({ billNo: 'BS/9', paid: 'part', partHow: 'upi', partAmount: 50_000, lines: [line(1, 1, '1', 100_000)] }), c)
    expect(m.entries.map((e) => e.kind)).toEqual(['purchase', 'payment'])
    expect(m.entries[1]!.payload.billRefs).toEqual([{ kind: 'against', name: 'BS/9', amount: 50_000, dueDate: null }])
    expect(m.facts).toMatchObject({ total: 118_000, paid: 50_000, due: 68_000, how: 'upi', dueDate: '2026-11-12' })
  })
})

describe('the form checks before asking main', () => {
  const c = ctxFor()
  it('a supplier is needed', () => {
    expect(buyFormErrors(form({ supplierId: null, lines: [line(1, 1, '1', 100)] }), c).party).toBe('simple.buy.err.supplier')
  })
  it('lines: a product, a quantity and a price on each', () => {
    expect(buyFormErrors(form({ lines: [] }), c).items).toBe('simple.buy.err.noItems')
    expect(buyFormErrors(form({ lines: [line(1, null, '1', 100)] }), c).items).toBe('simple.buy.err.pickProduct')
    expect(buyFormErrors(form({ lines: [line(1, 1, 'two', 100)] }), c).items).toBe('simple.buy.err.qty')
    expect(buyFormErrors(form({ lines: [line(1, 1, '2', null)] }), c).items).toBe('simple.buy.err.price')
    expect(buyFormErrors(form({ lines: [line(1, 1, '2', 100)] }), c)).toEqual({})
  })
  it('an expense: the category and the amount; the GST rate only when claimed and the account has none', () => {
    expect(buyFormErrors(form({ mode: 'expense' }), c)).toEqual({ account: 'simple.buy.err.category', amount: 'simple.buy.err.amount', gstRate: 'simple.buy.err.gstRate' })
    expect(buyFormErrors(form({ mode: 'expense', categoryId: 21, amount: 100 }), c)).toEqual({})
    expect(buyFormErrors(form({ mode: 'expense', categoryId: 22, amount: 100 }), ctxFor('unregistered'))).toEqual({})
  })
  it('partly paid: an amount below the bill', () => {
    const base = { paid: 'part' as const, lines: [line(1, 1, '1', 10_000)] }
    expect(buyFormErrors(form(base), c).payment).toBe('simple.buy.err.partAmount')
    expect(buyFormErrors(form({ ...base, partAmount: 11_800 }), c).payment).toBe('simple.buy.err.partTooMuch')
    expect(buyFormErrors(form({ ...base, partAmount: 5_000 }), c).payment).toBeUndefined()
  })
})

describe('plain words', () => {
  const facts = (p: Partial<IntentFacts>): IntentFacts => ({
    kind: 'purchase', partyName: 'Bharat Steel', total: 118_000, tax: 18_000, paid: 0, how: null, moneyAccount: null, due: 0, settled: [], advance: 0, fromName: null, toName: null, againstBill: null, offBill: 0, credit: 0, balance: null, noGst: null, side: 'supplier', walkIn: false, ...p
  })
  it('the preview line', () => {
    expect(purchasePreviewLine(facts({ paid: 50_000, how: 'upi', due: 68_000, dueDate: '2026-11-20' }), t)).toBe('Bill ₹1,180.00 from Bharat Steel. ₹500.00 paid by UPI now, ₹680.00 still to pay by 20 Nov 2026.')
    expect(purchasePreviewLine(facts({ due: 118_000, dueDate: '2026-10-13' }), t)).toBe('Bill ₹1,180.00 from Bharat Steel. ₹1,180.00 to pay by 13 Oct 2026.')
    expect(purchasePreviewLine(facts({ due: 118_000, dueDate: null }), t)).toBe('Bill ₹1,180.00 from Bharat Steel. ₹1,180.00 to pay — no due date is set for this supplier.')
    expect(purchasePreviewLine(facts({ paid: 118_000, how: 'cash' }), t)).toBe('Bill ₹1,180.00 from Bharat Steel. ₹1,180.00 paid in cash now.')
    expect(purchasePreviewLine(facts({ paid: 118_000, how: 'bank' }), t)).toBe('Bill ₹1,180.00 from Bharat Steel. ₹1,180.00 paid by bank transfer now.')
  })
  it('status chips', () => {
    expect(purchaseStatus(100, 0, 0)).toBe('paid')
    expect(purchaseStatus(100, 40, 0)).toBe('part')
    expect(purchaseStatus(100, 100, 0)).toBe('due')
    expect(purchaseStatus(100, 100, 3)).toBe('overdue')
    // WP 9.5 review: a bill a return cleared with nothing paid is not "Paid".
    expect(purchaseStatus(100, 0, 0, 0)).toBe('returned')
    expect(purchaseStatus(100, 0, 0, 60)).toBe('paid')
  })
  it('no banned word in the Buy strings', () => {
    const keys = ['simple.buy.preview.part', 'simple.buy.cantClaim', 'simple.buy.gstQuestionWhat', 'simple.buy.notYetHint', 'errors.intent.itemsNoGst', 'errors.intent.duplicateBill'] as const
    for (const k of keys) expect(bannedWordsIn(t(k, { amount: '₹1', name: 'X', paid: '₹1', due: '₹1', date: '1 Nov', how: 'cash', number: 'P-1' }))).toEqual([])
  })
})

describe('WP 10.8: a product without a GST rate on a claimed GST bill', () => {
  it('is flagged only when the bill claims GST and neither the product nor the account has a rate', () => {
    expect(buyLineRateMissing(3, form({ gstOnBill: true }), ctxFor('regular'))).toBe(true)
    expect(buyLineRateMissing(1, form({ gstOnBill: true }), ctxFor('regular'))).toBe(false)
    expect(buyLineRateMissing(3, form({ gstOnBill: false }), ctxFor('regular'))).toBe(false)
    expect(buyLineRateMissing(3, form(), ctxFor('unregistered'))).toBe(false)
  })
})
