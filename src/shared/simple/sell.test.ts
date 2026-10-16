// WP 9.2 — Make a bill, the pure half: live totals are the editor's own calculation (computeInvoice
// / computeGst + rupee round-off) and equal what mapIntent posts for the same answers; GST-inclusive
// prices become the editor's exclusive rate + discount (pricing.ts inclusiveLine); the form's checks
// (walk-in on credit, part payment, the GST rate of "just an amount" for a regular company only);
// the plain preview line; the sales list's status chips.
import { describe, expect, it } from 'vitest'
import { t as translate } from '../i18n'
import { computeInvoice, emptyInvoiceState } from '../voucherEdit'
import { mapIntent, normaliseIntent, type IntentContext, type IntentFacts, type IntentLedger } from './intents'
import { bannedWordsIn } from './bannedWords'
import {
  billTitleKey, emptySellForm, lineRateMissing, offBillByReturns, exclusiveLines, paidChoicesFor, saleIntentFrom, salePreviewLine, saleStatus, sellFormErrors, sellTotals, shownRate, switchBasisRemembering, switchSellBasis,
  type BasisMemo, type SellContext, type SellForm
} from './sell'

const t = (key: Parameters<typeof translate>[0], vars?: Parameters<typeof translate>[1]): string => translate(key, vars, 'en')
const DATE = '2026-10-13'
const REG = { gstRegistrationType: 'regular' as const }

function ctxFor(reg: 'regular' | 'composition' | 'unregistered' = 'regular'): SellContext {
  return {
    invoice: {
      companyStateCode: '27',
      gstRegistrationType: reg,
      items: new Map([
        [1, { gstRate: 18, cessRate: null }],
        [2, { gstRate: 5, cessRate: null }]
      ]),
      ledgers: new Map([
        [10, { stateCode: '27', gstRate: null }],
        [11, { stateCode: '29', gstRate: null }],
        [20, { stateCode: null, gstRate: null }]
      ])
    },
    salesAccountId: 20
  }
}

const form = (patch: Partial<SellForm> = {}): SellForm => ({ ...emptySellForm(DATE, { mode: 'items', ratesIncludeGst: false }), ...patch })
const line = (key: number, itemId: number | null, qtyText: string, rate: number | null, discount: number | null = null) => ({ key, itemId, qtyText, rate, discount })
const DEFAULTS = { cash: 30, upi: 31, card: 31, bank: 31 }

/** The same context mapIntent reads (main builds it from the books). */
function intentCtx(c: SellContext): IntentContext {
  const L = (id: number, name: string, cls: IntentLedger['cls'], stateCode: string | null = null): [number, IntentLedger] => [id, { id, name, cls, stateCode, gstRate: null, creditDays: 15 }]
  return {
    invoice: c.invoice,
    ledgers: new Map([L(10, 'Ramesh', 'debtor', '27'), L(11, 'Kumar', 'debtor', '29'), L(12, 'Cash sale', 'debtor'), L(20, 'Sales', 'income'), L(30, 'Cash', 'cash'), L(31, 'HDFC Bank', 'bank')]),
    items: new Map([[1, { id: 1, name: 'Widget' }], [2, { id: 2, name: 'Rice' }]]),
    types: { sales: { id: 1, name: 'Sales', numbering: 'auto', next: 'S-1' }, receipt: { id: 2, name: 'Receipt', numbering: 'auto', next: 'R-1' } },
    taxLedgers: { output: { cgst: 40, sgst: 41, igst: 42, cess: 43, roundOff: 44 }, input: { cgst: 50, sgst: 51, igst: 52, cess: 53, roundOff: 54 } },
    defaults: { walkInId: 12, cashId: 30, upiId: 31, cardId: 31, bankId: 31, salesId: 20, purchaseId: null, drawingsId: null },
    prices: new Map(),
    openBills: new Map(),
    takenNames: new Map(),
    original: null
  }
}

/** What simple:post would save for these answers (the pure mapping, same as main). */
function posted(f: SellForm, c: SellContext) {
  return mapIntent(normaliseIntent({ clientId: 'test-client-1', ...saleIntentFrom(f, c, DEFAULTS) }, DATE), intentCtx(c))
}

describe('live totals = the editor calculation = what is posted', () => {
  it('review: the rupee round-off is its own figure (down and up), and taxable + tax + rounding = total', () => {
    const c = ctxFor('unregistered')
    // 3 × ₹145.50 + 2.5 × ₹46.30 = ₹552.25 → ₹552.00 (rounded down by 25 paise).
    const down = sellTotals(form({ customerId: 10, lines: [line(1, 1, '3', 14_550), line(2, 2, '2.5', 4_630)] }), c)
    expect(down).toMatchObject({ taxable: 55_225, tax: 0, total: 55_200, rounding: -25 })
    // Just an amount ₹1,499.60 → ₹1,500.00 (up by 40 paise).
    const up = sellTotals(form({ mode: 'amount', amount: 149_960 }), c)
    expect(up).toMatchObject({ taxable: 149_960, total: 150_000, rounding: 40 })
    for (const x of [down, up]) expect(x.taxable + x.tax + x.rounding).toBe(x.total)
  })

  it('review: with prices including GST each line shows its value WITH GST (qty × price − discount)', () => {
    const c = ctxFor()
    const f = form({ customerId: 10, ratesIncludeGst: true, lines: [line(1, 1, '2', 11_800, 1_180), line(2, 2, '1', 10_500)] })
    const tot = sellTotals(f, c)
    expect(tot.lineAmounts).toEqual([22_420, 10_500])
    // The bill is still the editor's figure on the exclusive lines.
    expect(posted(f, c).facts.total).toBe(tot.total)
    // Typed before GST, the same figures are the lines' taxable values.
    expect(sellTotals({ ...f, ratesIncludeGst: false }, c).lineAmounts).toEqual([22_420, 10_500])
  })

  it('two products, prices before GST, intra-state', () => {
    const c = ctxFor()
    const f = form({ customerId: 10, lines: [line(1, 1, '2', 50_000), line(2, 2, '3', 6_000, 1_000)] })
    const tot = sellTotals(f, c)
    const editor = computeInvoice(
      { ...emptyInvoiceState(DATE), partyId: 10, accountId: 20, rows: [{ itemId: 1, qtyText: '2', rate: 50_000, discount: null, godownId: null, batchId: null }, { itemId: 2, qtyText: '3', rate: 6_000, discount: 1_000, godownId: null, batchId: null }] },
      { ...c.invoice, kind: 'sales' }
    )
    expect(tot).toMatchObject({ taxable: editor.gst.taxable, tax: editor.gst.total - editor.gst.taxable, total: editor.rounded, charges: true })
    expect(tot.lineAmounts).toEqual([100_000, 17_000])
    expect(posted(f, c).facts.total).toBe(tot.total)
  })

  it('an inter-state customer gets IGST; the same total either way', () => {
    const c = ctxFor()
    const f = form({ customerId: 11, lines: [line(1, 1, '1', 10_000)] })
    expect(sellTotals(f, c)).toMatchObject({ taxable: 10_000, tax: 1_800, total: 11_800 })
    expect(posted(f, c).entries[0]!.payload.lines.some((l) => l.ledgerId === 42)).toBe(true)
  })

  it('prices with GST: the editor exclusive rate + discount; the bill totals the price', () => {
    const c = ctxFor()
    const f = form({ customerId: 10, ratesIncludeGst: true, lines: [line(1, 1, '2', 118_000)] })
    const { lines } = exclusiveLines(f, c)
    expect(lines[0]!.rate).toBe(100_000)
    expect(sellTotals(f, c).total).toBe(236_000)
    expect(posted(f, c).facts.total).toBe(236_000)
    // A price-list rate (exclusive) shown with GST.
    expect(shownRate(100_000, 1, f, c)).toBe(118_000)
  })

  it('just an amount: computeGst + rupee round-off, with GST typed in or not', () => {
    const c = ctxFor()
    const f = form({ customerId: 10, mode: 'amount', amount: 100_050, gstRate: 18 })
    expect(sellTotals(f, c)).toMatchObject({ taxable: 100_050, tax: 18_010, total: 118_100 })
    expect(posted(f, c).facts.total).toBe(118_100)
    const incl = form({ customerId: 10, mode: 'amount', amount: 118_000, gstRate: 18, ratesIncludeGst: true })
    expect(sellTotals(incl, c)).toMatchObject({ taxable: 100_000, total: 118_000 })
  })

  it('an unregistered or composition business charges no GST (WP 8.0)', () => {
    for (const reg of ['unregistered', 'composition'] as const) {
      const c = ctxFor(reg)
      const f = form({ lines: [line(1, 1, '2', 50_000)], ratesIncludeGst: true })
      expect(sellTotals(f, c)).toMatchObject({ taxable: 100_000, tax: 0, total: 100_000, charges: false })
      expect(saleIntentFrom(form({ mode: 'amount', amount: 5_000 }), c, DEFAULTS)).not.toHaveProperty('amount.gstRate')
    }
  })
})

describe('the sale intent', () => {
  it('walk-in paid by UPI → no customer, the UPI account; quantities as thousandths', () => {
    const c = ctxFor('unregistered')
    const i = saleIntentFrom(form({ paid: 'upi', lines: [line(1, 1, '1.5', 4_000), line(2, 2, '1,000', 100)] }), c, DEFAULTS)
    expect(i).toEqual({ kind: 'sale', date: DATE, payment: { how: 'upi', accountId: 31 }, items: [{ itemId: 1, qty: 1_500, rate: 4_000 }, { itemId: 2, qty: 1_000_000, rate: 100 }] })
  })

  it('on credit / partly paid / a chosen account', () => {
    const c = ctxFor()
    expect(saleIntentFrom(form({ customerId: 10, paid: 'credit', lines: [line(1, 1, '1', 100)] }), c, DEFAULTS).payment).toEqual({ how: 'credit' })
    expect(saleIntentFrom(form({ customerId: 10, paid: 'part', partHow: 'cash', partAmount: 500, lines: [line(1, 1, '1', 10_000)] }), c, DEFAULTS).payment).toEqual({ how: 'cash', amount: 500, accountId: 30 })
    expect(saleIntentFrom(form({ customerId: 10, paid: 'card', accountId: 99, lines: [line(1, 1, '1', 100)] }), c, DEFAULTS).payment).toEqual({ how: 'card', accountId: 99 })
  })

  it('a part-paid credit sale posts a bill + a receipt against it; the rest due by the credit days', () => {
    const c = ctxFor()
    const m = posted(form({ customerId: 10, paid: 'part', partHow: 'upi', partAmount: 50_000, lines: [line(1, 1, '1', 100_000)] }), c)
    expect(m.entries.map((e) => e.kind)).toEqual(['sales', 'receipt'])
    expect(m.facts).toMatchObject({ total: 118_000, paid: 50_000, due: 68_000, how: 'upi', dueDate: '2026-10-28' })
  })
})

describe('the form checks before asking main', () => {
  const c = ctxFor()
  it('a walk-in can’t buy on credit or part-pay', () => {
    expect(paidChoicesFor(true).filter((x) => x.disabled).map((x) => x.value)).toEqual(['credit', 'part'])
    expect(paidChoicesFor(false).every((x) => !x.disabled)).toBe(true)
    expect(sellFormErrors(form({ paid: 'credit', lines: [line(1, 1, '1', 100)] }), c, { regular: true }).payment).toBe('errors.intent.walkInUnpaid')
  })
  it('lines: a product, a quantity and a price on each', () => {
    expect(sellFormErrors(form({ lines: [] }), c, { regular: true }).items).toBe('simple.sell.err.noItems')
    expect(sellFormErrors(form({ lines: [line(1, null, '1', 100)] }), c, { regular: true }).items).toBe('simple.sell.err.pickProduct')
    expect(sellFormErrors(form({ lines: [line(1, 1, 'two', 100)] }), c, { regular: true }).items).toBe('simple.sell.err.qty')
    expect(sellFormErrors(form({ lines: [line(1, 1, '2', null)] }), c, { regular: true }).items).toBe('errors.intent.noPrice')
    expect(sellFormErrors(form({ lines: [line(1, 1, '2', 100)] }), c, { regular: true })).toEqual({})
  })
  it('just an amount: the amount, and the GST rate only for a regular registration', () => {
    expect(sellFormErrors(form({ mode: 'amount' }), c, { regular: true })).toEqual({ amount: 'simple.sell.err.amount', gstRate: 'simple.sell.err.gstRate' })
    expect(sellFormErrors(form({ mode: 'amount', amount: 100 }), ctxFor('unregistered'), { regular: false })).toEqual({})
  })
  it('partly paid: an amount below the bill', () => {
    const base = { customerId: 10, paid: 'part' as const, lines: [line(1, 1, '1', 10_000)] }
    expect(sellFormErrors(form(base), c, { regular: true }).payment).toBe('simple.sell.err.partAmount')
    expect(sellFormErrors(form({ ...base, partAmount: 11_800 }), c, { regular: true }).payment).toBe('simple.sell.err.partTooMuch')
    expect(sellFormErrors(form({ ...base, partAmount: 5_000 }), c, { regular: true }).payment).toBeUndefined()
  })
  it('a customer on credit hold: refused under the customer, ask the owner', () => {
    expect(sellFormErrors(form({ customerId: 10, lines: [line(1, 1, '1', 100)] }), c, { regular: true, onHold: true }).party).toBe('simple.sell.err.onHold')
    expect(t('simple.sell.err.onHold')).toContain('Ask the owner')
  })
})

describe('plain words', () => {
  const facts = (p: Partial<IntentFacts>): IntentFacts => ({
    kind: 'sale', partyName: 'Ramesh', total: 118_000, tax: 18_000, paid: 0, how: null, moneyAccount: null, due: 0, settled: [], advance: 0, fromName: null, toName: null, againstBill: null, offBill: 0, credit: 0, balance: null, noGst: null, side: 'customer', walkIn: false, ...p
  })
  it('the preview line', () => {
    expect(salePreviewLine(facts({ paid: 50_000, how: 'upi', due: 68_000, dueDate: '2026-11-20' }), t)).toBe('Bill ₹1,180.00 to Ramesh. ₹500.00 by UPI now, ₹680.00 due by 20 Nov 2026.')
    expect(salePreviewLine(facts({ due: 118_000, dueDate: '2026-10-13' }), t)).toBe('Bill ₹1,180.00 to Ramesh. ₹1,180.00 due by 13 Oct 2026.')
    // WP 10.8: no days to pay → no due date to tell
    expect(salePreviewLine(facts({ due: 118_000, dueDate: null }), t)).toBe('Bill ₹1,180.00 to Ramesh. ₹1,180.00 due — no due date is set for this customer.')
    expect(salePreviewLine(facts({ paid: 50_000, how: 'upi', due: 68_000, dueDate: null }), t)).toBe('Bill ₹1,180.00 to Ramesh. ₹500.00 by UPI now, ₹680.00 still due (no due date set).')
    expect(salePreviewLine(facts({ walkIn: true, partyName: 'Cash sale', paid: 118_000, how: 'cash' }), t)).toBe('Bill ₹1,180.00 for a cash customer. ₹1,180.00 in cash now.')
    expect(salePreviewLine(facts({ paid: 118_000, how: 'bank' }), t)).toBe('Bill ₹1,180.00 to Ramesh. ₹1,180.00 by bank transfer now.')
  })
  it('print titles per WP 8.0', () => {
    expect(billTitleKey(REG, DATE)).toBe('simple.sell.title.tax')
    expect(billTitleKey({ gstRegistrationType: 'composition' }, DATE)).toBe('simple.sell.title.supply')
    expect(billTitleKey({ gstRegistrationType: 'unregistered' }, DATE)).toBe('simple.sell.title.invoice')
    expect(t('simple.sell.title.supply')).toBe('Bill of supply')
  })
  it('status chips', () => {
    expect(saleStatus(100, 0, 0)).toBe('paid')
    expect(saleStatus(100, 40, 0)).toBe('part')
    expect(saleStatus(100, 100, 0)).toBe('due')
    expect(saleStatus(100, 100, 3)).toBe('overdue')
    // WP 9.5 review: a bill a return cleared with no money paid is not "Paid".
    expect(saleStatus(100, 0, 0, 0)).toBe('returned')
    expect(saleStatus(100, 0, 0, 60)).toBe('paid')
    expect(saleStatus(100, 40, 0, 0)).toBe('due')
    expect(offBillByReturns({ total: 2610, paid: 1000, due: 0, returned: 1770 })).toBe(1610)
    expect(offBillByReturns({ total: 2610, paid: 1000, due: 1610, returned: 0 })).toBe(0)
  })
  it('no banned word in the Sell strings', () => {
    const keys = ['simple.sell.preview.part', 'simple.sell.err.onHold', 'simple.sell.shortStock', 'simple.sales.totals', 'simple.sell.walkInPaysNow'] as const
    for (const k of keys) expect(bannedWordsIn(t(k, { amount: '₹1', name: 'X', paid: '₹1', due: '₹1', date: '1 Nov', how: 'cash', qty: '1', unit: 'Nos', count: 1, total: '₹1' }))).toEqual([])
  })
})

describe('WP 10.8: a product without a GST rate on a GST bill', () => {
  it('is flagged only while the bill charges GST and neither the product nor the account has a rate', () => {
    const base = ctxFor('regular')
    const c: SellContext = { ...base, invoice: { ...base.invoice, items: new Map([...base.invoice.items, [3, { gstRate: null, cessRate: null }]]) } }
    expect(lineRateMissing(3, form(), c)).toBe(true)
    expect(lineRateMissing(1, form(), c)).toBe(false)
    expect(lineRateMissing(3, form(), ctxFor('unregistered'))).toBe(false)
    const rated: SellContext = { ...c, invoice: { ...c.invoice, ledgers: new Map([...c.invoice.ledgers, [20, { stateCode: null, gstRate: 5 }]]) } }
    expect(lineRateMissing(3, form(), rated)).toBe(false)
  })
})

describe('"Prices include GST" switched with prices typed (to-do §4): every line keeps its total', () => {
  const sig = (f: SellForm, c: SellContext) => {
    const x = sellTotals(f, c)
    return [x.taxable, x.tax, x.total, x.rounding]
  }
  it('before GST ↔ with GST, item lines (intra / inter, discounts, part quantities): the same bill', () => {
    const c = ctxFor()
    const rates = [1, 99, 1005, 1055, 12_345, 50_000, 99_999]
    const qtys = ['1', '3', '2.5', '0.333', '100', '7']
    let n = 0
    for (const customerId of [10, 11]) {
      for (const rate of rates) {
        for (const qtyText of qtys) {
          for (const discount of [null, 1, 500]) {
            for (const itemId of [1, 2]) {
              const ex = form({ customerId, lines: [line(1, itemId, qtyText, rate, discount)] })
              const inc = switchSellBasis(ex, c, true)
              expect(inc.ratesIncludeGst).toBe(true)
              expect(sig(inc, c)).toEqual(sig(ex, c))
              const back = switchSellBasis(inc, c, false)
              expect(sig(back, c)).toEqual(sig(ex, c))
              // Typed WITH GST first, then switched to before GST.
              const typedIncl = form({ customerId, ratesIncludeGst: true, lines: [line(1, itemId, qtyText, rate, discount)] })
              expect(sig(switchSellBasis(typedIncl, c, false), c)).toEqual(sig(typedIncl, c))
              n++
            }
          }
        }
      }
    }
    expect(n).toBeGreaterThan(400)
  })

  it('₹100 + 18 % → ₹118 a unit (no discount appears); ₹118 with GST → ₹100 before', () => {
    const c = ctxFor()
    const inc = switchSellBasis(form({ lines: [line(1, 1, '3', 100_00)] }), c, true)
    expect(inc.lines[0]).toMatchObject({ rate: 118_00, discount: null })
    const ex = switchSellBasis(form({ ratesIncludeGst: true, lines: [line(1, 1, '3', 118_00)] }), c, false)
    expect(ex.lines[0]).toMatchObject({ rate: 100_00, discount: null })
  })

  it('"just an amount" converts too; 0 % lines, incomplete lines and a bill without GST keep their numbers', () => {
    const c = ctxFor()
    const amt = form({ mode: 'amount', amount: 1_000_00, gstRate: 18 })
    const a = switchSellBasis(amt, c, true)
    expect(a.amount).toBe(1_180_00)
    expect(sig(a, c)).toEqual(sig(amt, c))
    expect(switchSellBasis(a, c, false).amount).toBe(1_000_00)
    const zero = { ...ctxFor(), invoice: { ...ctxFor().invoice, items: new Map([[1, { gstRate: 0, cessRate: null }]]) } }
    expect(switchSellBasis(form({ lines: [line(1, 1, '2', 500_00)] }), zero, true).lines[0]!.rate).toBe(500_00)
    expect(switchSellBasis(form({ lines: [line(1, 1, '', 500_00)] }), c, true).lines[0]!.rate).toBe(500_00)
    const u = switchSellBasis(form({ lines: [line(1, 1, '2', 500_00)] }), ctxFor('unregistered'), true)
    expect([u.ratesIncludeGst, u.lines[0]!.rate]).toEqual([true, 500_00])
  })
})

describe('review PR #119: switching the basis there and straight back gives the typed prices again', () => {
  it('with GST → before GST → with GST (and the reverse) returns what was typed; the bill never moves', () => {
    const c = ctxFor()
    const sig = (f: SellForm) => { const x = sellTotals(f, c); return [x.taxable, x.tax, x.total] }
    let plainDiffers = 0
    for (const customerId of [10, 11]) for (const rate of [101_00, 200_00, 999_99, 1_234_00, 10_100]) for (const qtyText of ['1', '3', '2.5']) for (const discount of [null, 50_00]) for (const itemId of [1, 2]) for (const incl of [true, false]) {
      const typed = form({ customerId, ratesIncludeGst: incl, lines: [line(1, itemId, qtyText, rate, discount)] })
      const scope = String(customerId)
      const there = switchBasisRemembering(typed, !incl, scope, null, (f) => switchSellBasis(f, c, !incl))
      expect(sig(there.form)).toEqual(sig(typed))
      const back = switchBasisRemembering(there.form, incl, scope, there.memo, (f) => switchSellBasis(f, c, incl))
      expect(back.form.lines[0]).toMatchObject({ rate, discount })
      expect(back.form.ratesIncludeGst).toBe(incl)
      const plain = switchSellBasis(there.form, c, incl).lines[0]!
      if (plain.rate !== rate || (plain.discount ?? null) !== discount) plainDiffers++
    }
    // (Without the memo some of these come back a paisa off with a paisa discount: ₹101 → ₹100.99.)
    expect(plainDiffers).toBeGreaterThan(0)
  })

  it('a price changed after the switch, or a changed date / party, is converted afresh', () => {
    const c = ctxFor()
    const typed = form({ ratesIncludeGst: true, lines: [line(1, 1, '1', 101_00, null)] })
    const there = switchBasisRemembering(typed, false, 'a', null, (f) => switchSellBasis(f, c, false))
    const edited = { ...there.form, lines: [{ ...there.form.lines[0]!, rate: 50_00 }] }
    const back1 = switchBasisRemembering(edited, true, 'a', there.memo, (f) => switchSellBasis(f, c, true))
    expect(back1.form.lines[0]).toEqual(switchSellBasis(edited, c, true).lines[0])
    const back2 = switchBasisRemembering(there.form, true, 'b', there.memo, (f) => switchSellBasis(f, c, true))
    expect(back2.form.lines[0]).toEqual(switchSellBasis(there.form, c, true).lines[0])
    const memo: BasisMemo | null = back2.memo
    expect(memo?.to).toBe(true)
  })
})
