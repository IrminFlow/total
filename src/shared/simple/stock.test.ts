// WP 9.7 — the stock intents' pure mapping and the Stock screens' rules: a count maps to the
// Physical Stock editor's form (counted quantities, rate / amount 0 — the engine prices the
// difference), Made goods to the Manufacture screen's form with the recipe's rows and a balanced
// stock journal (finished value = materials + labour), refusals on their fields; the "running
// low" rule; count differences in words; the form answers → intents.
import { describe, expect, it } from 'vitest'
import { translator } from '../i18n'
import type { BomVersion } from '../bom'
import { bannedWordsIn } from './bannedWords'
import { intentSentences, mapIntent, normaliseIntent, readCount, type IntentContext, type MappedIntent } from './intents'
import {
  countDifference, countFormErrors, countIntentFrom, makeFormErrors, makeIntentFrom, parseCountText, recipeNeeds, recipeRows, stockLevel, emptyMakeForm
} from './stock'

const TODAY = '2025-08-14'
const t = translator('en')
const FLOUR = 100
const BOX = 101
const BREAD = 102
const LABOUR = 50
const WAGES = 51

const versions: BomVersion[] = [
  { id: 7, itemId: BREAD, name: 'v1', effectiveFrom: null, effectiveTo: null, isDefault: true, lines: [{ componentId: FLOUR, qtyMilliPerUnit: 500, scrapPctBp: null }, { componentId: BOX, qtyMilliPerUnit: 1000, scrapPctBp: null }] }
]

function ctx(over: Partial<IntentContext> = {}): IntentContext {
  return {
    invoice: { companyStateCode: '27', gstRegistrationType: 'regular', items: new Map(), ledgers: new Map() },
    ledgers: new Map(),
    items: new Map([[FLOUR, { id: FLOUR, name: 'Flour' }], [BOX, { id: BOX, name: 'Box' }], [BREAD, { id: BREAD, name: 'Bread' }]]),
    types: {
      physical_stock: { id: 8, name: 'Physical Stock', numbering: 'auto', next: 'PS-1' },
      stock_journal: { id: 9, name: 'Stock Journal', numbering: 'auto', next: 'SJ-4' }
    },
    taxLedgers: { output: { cgst: null, sgst: null, igst: null, cess: null, roundOff: null }, input: { cgst: null, sgst: null, igst: null, cess: null, roundOff: null } },
    defaults: { walkInId: null, cashId: null, upiId: null, cardId: null, bankId: null, salesId: null, purchaseId: null, drawingsId: null },
    prices: new Map(),
    openBills: new Map(),
    original: null,
    takenNames: new Map(),
    stock: new Map([
      [FLOUR, { name: 'Flour', unit: 'Kg', qtyMilli: 100_000, value: 400_000 }],
      [BOX, { name: 'Box', unit: 'Nos', qtyMilli: 50_000, value: 50_000 }],
      [BREAD, { name: 'Bread', unit: 'Nos', qtyMilli: 0, value: 0 }]
    ]),
    ...over
  }
}

/** Made goods' context: what main loads (costPreview of the recipe's rows at ₹40 / kg, ₹10 / box). */
function makeCtx(qtyMilli: number, over: Partial<NonNullable<IntentContext['make']>> = {}): IntentContext {
  const rows = recipeRows(BREAD, qtyMilli, versions, TODAY)!.rows
  const unit = new Map([[FLOUR, 4000], [BOX, 1000]])
  const onHand = new Map([[FLOUR, 100_000], [BOX, 50_000]])
  const lines = rows.map((r) => ({ itemId: r.componentId, qtyMilli: r.qtyMilli, costPaise: (unit.get(r.componentId)! * r.qtyMilli) / 1000, onHandQtyMilli: onHand.get(r.componentId)! }))
  return ctx({
    make: { versions, suggestedPrice: 5000, priced: { lines, totalPaise: lines.reduce((s, l) => s + l.costPaise, 0) }, labour: { expenseId: LABOUR, creditId: WAGES }, ...over }
  })
}

const map = (raw: Record<string, unknown>, c: IntentContext): MappedIntent => mapIntent(normaliseIntent({ clientId: 'client-0001', ...raw }, TODAY), c)
const codeOf = (fn: () => unknown): { code?: string; field?: string } => {
  try {
    fn()
    return {}
  } catch (err) {
    return { code: (err as { code?: string }).code, field: (err as { field?: string }).field }
  }
}
const balanced = (m: MappedIntent): void => {
  for (const e of m.entries) {
    const dr = e.payload.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
    const cr = e.payload.lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
    expect(dr, e.kind).toBe(cr)
  }
}

describe('stock_count → the Physical Stock editor’s form', () => {
  it('counted quantities only (is_absolute, rate and amount 0), one entry, balanced', () => {
    const m = map({ kind: 'stock_count', date: '2025-08-10', counts: [{ itemId: FLOUR, qty: '98' }, { itemId: BOX, qty: 0 }] }, ctx())
    expect(m.entries).toHaveLength(1)
    const e = m.entries[0]!
    expect(e).toMatchObject({ role: 'count', kind: 'physical_stock', form: 'physical', voucherTypeId: 8 })
    expect(e.state).toMatchObject({ date: '2025-08-10', number: 'PS-1', rows: [{ itemId: FLOUR, qtyText: '98' }, { itemId: BOX, qtyText: '0' }] })
    expect(e.payload.lines).toEqual([])
    expect(e.payload.inventory.map((l) => [l.stockItemId, l.qtyMilli, l.ratePaise, l.amount, l.isAbsolute])).toEqual([[FLOUR, 98_000, 0, 0, true], [BOX, 0, 0, 0, true]])
    balanced(m)
    expect(m.facts.count!.lines.map((l) => [l.name, l.beforeMilli, l.countedMilli])).toEqual([['Flour', 100_000, 98_000], ['Box', 50_000, 0]])
  })

  it('refused: a product counted twice (counts), an unknown product (counts), a bad number (counts.N.qty)', () => {
    expect(codeOf(() => map({ kind: 'stock_count', counts: [{ itemId: FLOUR, qty: 1 }, { itemId: FLOUR, qty: 2 }] }, ctx()))).toEqual({ code: 'simple_count_twice', field: 'counts' })
    expect(codeOf(() => map({ kind: 'stock_count', counts: [{ itemId: 999, qty: 1 }] }, ctx()))).toEqual({ code: 'simple_no_item', field: 'counts' })
    expect(codeOf(() => map({ kind: 'stock_count', counts: [{ itemId: FLOUR, qty: 'lots' }] }, ctx()))).toEqual({ code: 'simple_bad_qty', field: 'counts.0.qty' })
  })

  it('a count may be zero; readCount reads typed text like readQty', () => {
    expect(readCount('0', 'q')).toBe(0)
    expect(readCount('0.000', 'q')).toBe(0)
    expect(readCount('2.5', 'q')).toBe(2500)
    expect(readCount('1,000', 'q')).toBe(1_000_000)
  })

  it('sentences: shortages and extras in words, banned-word free', () => {
    const m = map({ kind: 'stock_count', counts: [{ itemId: FLOUR, qty: '98' }, { itemId: BOX, qty: '52' }] }, ctx())
    const facts = { ...m.facts, count: { lines: m.facts.count!.lines.map((l) => ({ ...l, valueChange: l.itemId === FLOUR ? -8000 : 2000 })) } }
    const s = intentSentences(facts, t)
    expect(s).toEqual([
      'Stock count of 2 products.',
      'Flour: 2 Kg short — it comes off your stock.',
      'Box: 2 Nos more than Total showed — it is added to your stock.',
      'Your stock is now worth ₹60.00 less.'
    ])
    expect(s.flatMap((x) => bannedWordsIn(x))).toEqual([])
    const same = map({ kind: 'stock_count', counts: [{ itemId: FLOUR, qty: '100' }] }, ctx())
    expect(intentSentences(same.facts, t)).toEqual(['Stock count of 1 product.', 'Everything you counted matches what Total showed.'])
  })
})

describe('make_goods → the Manufacture screen’s form', () => {
  it('the recipe’s rows, labour still to pay: a balanced stock journal, finished value = materials + labour', () => {
    const m = map({ kind: 'make_goods', date: TODAY, itemId: BREAD, qty: '10', labour: 5000 }, makeCtx(10_000))
    const e = m.entries[0]!
    expect(e).toMatchObject({ role: 'made', kind: 'stock_journal', form: 'manufacture', voucherTypeId: 9 })
    if (e.form !== 'manufacture') throw new Error('form')
    expect(e.state).toMatchObject({ finishedItemId: BREAD, qtyText: '10', saleRatePaise: 5000, labourPaise: 5000, labourPosted: true, bomVersionId: 7, bomExploded: false })
    expect(e.input.raw).toEqual([{ stockItemId: FLOUR, qtyMilli: 5000 }, { stockItemId: BOX, qtyMilli: 10_000 }])
    expect(e.input).toMatchObject({ profitPaise: 50_000 - 35_000, confirmLoss: true })
    expect(e.payload.inventory.map((l) => [l.stockItemId, l.direction, l.qtyMilli, l.amount])).toEqual([[FLOUR, 'out', 5000, 20_000], [BOX, 'out', 10_000, 10_000], [BREAD, 'in', 10_000, 35_000]])
    expect(e.payload.lines.map((l) => [l.ledgerId, l.drCr, l.amount])).toEqual([[LABOUR, 'dr', 5000], [WAGES, 'cr', 5000]])
    balanced(m)
    expect(m.facts.made).toMatchObject({ materialPaise: 30_000, labourPaise: 5000, valuePaise: 35_000, profitPaise: 15_000 })
    const s = intentSentences(m.facts, t)
    expect(s).toEqual([
      'Made 10 Nos of Bread.',
      'Used 5 Kg Flour, 10 Nos Box from your stock.',
      'They go into stock worth ₹350.00: materials ₹300.00 + labour ₹50.00.',
      'The labour of ₹50.00 is noted as wages you still have to pay.'
    ])
    expect(s.flatMap((x) => bannedWordsIn(x))).toEqual([])
  })

  it('labour already recorded: no lines (capitalised only); the price given wins over the suggestion; selling below cost is said', () => {
    const m = map({ kind: 'make_goods', itemId: BREAD, qty: 10_000, labour: 5000, labourRecorded: true, price: 1000 }, makeCtx(10_000))
    const e = m.entries[0]!
    if (e.form !== 'manufacture') throw new Error('form')
    expect(e.state.labourPosted).toBe(false)
    expect(e.payload.lines).toEqual([])
    expect(e.payload.inventory.at(-1)!.amount).toBe(35_000)
    expect(e.state.saleRatePaise).toBe(1000)
    expect(intentSentences(m.facts, t).at(-1)).toBe('You sell Bread for less than it costs to make.')
  })

  it('refused on its questions: not enough material → qty; no recipe → item; no price at all → price', () => {
    expect(codeOf(() => map({ kind: 'make_goods', itemId: BREAD, qty: '300' }, makeCtx(300_000)))).toEqual({ code: 'simple_not_enough_material', field: 'qty' })
    expect(codeOf(() => map({ kind: 'make_goods', itemId: FLOUR, qty: '1' }, makeCtx(1000)))).toEqual({ code: 'simple_no_recipe', field: 'item' })
    expect(codeOf(() => map({ kind: 'make_goods', itemId: BREAD, qty: '1' }, makeCtx(1000, { suggestedPrice: null })))).toEqual({ code: 'simple_no_sale_price', field: 'price' })
    // The prices main loaded are for other rows (the recipe changed meanwhile): never guessed.
    expect(codeOf(() => map({ kind: 'make_goods', itemId: BREAD, qty: '2' }, makeCtx(1000)))).toEqual({ code: 'simple_cannot_build', field: 'qty' })
  })
})

describe('the Stock screens’ rules', () => {
  const row = (closing: number, extra: Partial<{ openingQtyMilli: number; inwardQtyMilli: number; outwardQtyMilli: number }> = {}) => ({
    closingQtyMilli: closing, openingQtyMilli: 0, inwardQtyMilli: 0, outwardQtyMilli: 0, ...extra
  })
  it('running low: below the level (strictly); out at zero; without a level only out — and never for a product never stocked', () => {
    expect(stockLevel(row(5000, { inwardQtyMilli: 9000 }), 6000)).toBe('low')
    expect(stockLevel(row(6000, { inwardQtyMilli: 9000 }), 6000)).toBe('ok')
    expect(stockLevel(row(0, { inwardQtyMilli: 9000 }), 6000)).toBe('out')
    expect(stockLevel(row(0), 6000)).toBe('out')
    expect(stockLevel(row(1000, { inwardQtyMilli: 1000 }), null)).toBe('ok')
    expect(stockLevel(row(0, { outwardQtyMilli: 1000, openingQtyMilli: 1000 }), null)).toBe('out')
    expect(stockLevel(row(-1000, { outwardQtyMilli: 1000 }), null)).toBe('out')
    expect(stockLevel(row(0), null)).toBe('ok')
  })

  it('count differences in words; typed counts; the form → intent (blank = not counted)', () => {
    expect(countDifference(10_000, 8000)).toEqual({ kind: 'short', milli: 2000 })
    expect(countDifference(10_000, 12_500)).toEqual({ kind: 'extra', milli: 2500 })
    expect(countDifference(10_000, 10_000)).toEqual({ kind: 'same', milli: 0 })
    expect(parseCountText(' 2.5 ')).toBe(2500)
    expect(parseCountText('0')).toBe(0)
    expect(parseCountText('2.5555')).toBeNull()
    expect(parseCountText('-1')).toBeNull()
    expect(parseCountText('')).toBeNull()
    const form = { date: TODAY, counted: { [BOX]: '52', [FLOUR]: '98', [BREAD]: '' } }
    expect(countIntentFrom(form)).toEqual({ kind: 'stock_count', date: TODAY, counts: [{ itemId: FLOUR, qty: 98_000 }, { itemId: BOX, qty: 52_000 }] })
    expect(countFormErrors(form)).toEqual({})
    expect(countFormErrors({ date: TODAY, counted: { [FLOUR]: '' } })).toEqual({ counts: 'simple.stock.count.err.none' })
    expect(countFormErrors({ date: TODAY, counted: { [FLOUR]: 'ten' } })).toEqual({ counts: 'simple.stock.count.err.qty' })
  })

  it('Made goods: the form → intent; its checks; the recipe’s needs scale like the explosion', () => {
    const f = { ...emptyMakeForm(TODAY), itemId: BREAD, qtyText: '10', price: 5000, labour: 5000, labourRecorded: null }
    expect(makeFormErrors(f)).toEqual({ labourRecorded: 'simple.made.err.labourRecorded' })
    expect(makeIntentFrom({ ...f, labourRecorded: true })).toEqual({ kind: 'make_goods', date: TODAY, itemId: BREAD, qty: 10_000, price: 5000, labour: 5000, labourRecorded: true })
    expect(makeIntentFrom({ ...f, labour: null })).toEqual({ kind: 'make_goods', date: TODAY, itemId: BREAD, qty: 10_000, price: 5000 })
    expect(makeFormErrors(emptyMakeForm(TODAY))).toEqual({ item: 'simple.made.err.item', qty: 'simple.made.err.qty', price: 'simple.made.err.price' })
    const recipe = { versionId: 7, lines: [{ itemId: FLOUR, name: 'Flour', unit: 'Kg', qtyMilliPerUnit: 500, scrapPctBp: null }, { itemId: BOX, name: 'Box', unit: 'Nos', qtyMilliPerUnit: 1000, scrapPctBp: null }] }
    expect(recipeNeeds(recipe, 3000)).toEqual(recipeRows(BREAD, 3000, versions, TODAY)!.rows.map((r) => ({ itemId: r.componentId, qtyMilli: r.qtyMilli })))
  })
})
