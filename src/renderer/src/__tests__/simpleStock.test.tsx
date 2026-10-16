// WP 9.7 — the simple Stock screens: the product list (quantity, worth, selling price, a chip when
// running low; "Running low" filters; a row opens the product), the product view (Change price →
// simple:stock:setPrice; history in words), Count your stock (differences in words as you type;
// Save posts ONE stock_count intent and shows the save card without print buttons), Made goods
// (the recipe in plain words, what is short; Enter in the product picker never creates; a refusal
// under "How many"; off while manufacturing is off). No banned word on any of them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CompanyInfo } from '@shared/domain'
import { DEFAULT_FEATURES, type CompanyFeatures } from '@shared/features'
import type { IntentFacts, SimplePostResult } from '@shared/simple/intents'
import type { MadeGoodsSetup, SavedCountView, StockList as StockListData, StockProductView } from '@shared/simple/stock'
import { bannedWordsIn } from '@shared/simple/bannedWords'
import { useNav, useSession } from '../state/stores'
import { useExplain } from '../lib/explain'
import { useDialogs } from '../lib/dialogs'
import { StockList } from '../simple/stock/StockList'
import { StockCount } from '../simple/stock/StockCount'
import { MadeGoods } from '../simple/stock/MadeGoods'
import { SavedCount } from '../simple/stock/SavedCount'

const invoke = vi.fn()
const LIST: StockListData = {
  asOn: '2026-10-13',
  lowCount: 1,
  rows: [
    { itemId: 1, name: 'Flour', unit: 'Kg', qtyMilli: 100_000, value: 400_000, sellingPrice: 5000, reorderLevelMilli: null, level: 'ok', hasRecipe: false },
    { itemId: 2, name: 'Box', unit: 'Nos', qtyMilli: 50_000, value: 50_000, sellingPrice: null, reorderLevelMilli: 60_000, level: 'low', hasRecipe: false },
    { itemId: 3, name: 'Bread', unit: 'Nos', qtyMilli: 0, value: 0, sellingPrice: 4000, reorderLevelMilli: null, level: 'ok', hasRecipe: true }
  ]
}
const PRODUCT: StockProductView = {
  itemId: 1, name: 'Flour', unit: 'Kg', hsn: '1101', gstRate: 0, asOn: '2026-10-13', qtyMilli: 98_000, value: 392_000, unitCost: 4000, sellingPrice: 5000, reorderLevelMilli: null, level: 'ok',
  recipe: null,
  history: { from: '2026-04-01', openingMilli: 100_000, rows: [{ voucherId: 9, date: '2026-10-10', what: 'counted', party: null, inMilli: 0, outMilli: 2000, balanceMilli: 98_000 }] }
}
const FLOUR_ITEM = {
  id: 1, name: 'Flour', groupId: null, unitId: 4, hsn: '1101', gstRate: 0, cessRate: null, openingQtyMilli: 100_000, openingValue: 400_000, barcode: null,
  reorderLevelMilli: null, valuationMethod: 'weighted_avg', trackSerials: false, tcsSectionId: null, mrpPaise: null, standardCostPaise: 3500
}
const MADE: MadeGoodsSetup = {
  date: '2026-10-13',
  products: [{ itemId: 3, name: 'Bread', unit: 'Nos', suggestedPrice: 4000, recipe: { versionId: 7, lines: [{ itemId: 1, name: 'Flour', unit: 'Kg', qtyMilliPerUnit: 500, scrapPctBp: null }, { itemId: 2, name: 'Box', unit: 'Nos', qtyMilliPerUnit: 1000, scrapPctBp: null }] } }]
}
const info: CompanyInfo = { name: 'Mehta Bakery', stateCode: '27', gstin: '27AAACT1234A1Z5', gstRegistrationType: 'regular', address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null }
const FACTS: IntentFacts = {
  kind: 'stock_count', partyName: null, total: 0, tax: 0, paid: 0, how: null, moneyAccount: null, due: 0, settled: [], advance: 0, fromName: null, toName: null, againstBill: null, offBill: 0, credit: 0, balance: null, noGst: null, side: null, walkIn: false
}

let features: CompanyFeatures = { ...DEFAULT_FEATURES }
let previewReply: () => { ok: boolean; data?: unknown; error?: string; code?: string; field?: string; params?: Record<string, unknown> }
const calls = (ch: string): unknown[] => invoke.mock.calls.filter(([c]) => c === ch).map(([, p]) => p)

function renderUi(ui: React.ReactNode): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  features = { ...DEFAULT_FEATURES }
  previewReply = () => ({ ok: true, data: { kind: 'stock_count', sentences: ['Stock count of 1 product.', 'Flour: 2 Kg short — it comes off your stock.'], facts: FACTS, entries: [], warnings: { negativeStock: [], creditLimitExceeded: null } } })
  invoke.mockImplementation(async (channel: string) => {
    switch (channel) {
      case 'config:features:get': return { ok: true, data: features }
      case 'simple:stock:list': return { ok: true, data: LIST }
      case 'simple:stock:product': return { ok: true, data: PRODUCT }
      case 'simple:stock:madeSetup': return { ok: true, data: MADE }
      case 'simple:stock:setPrice': return { ok: true, data: { sellingPrice: 5500 } }
      case 'master:stockItems:list': return { ok: true, data: [FLOUR_ITEM] }
      case 'master:stockItems:update': return { ok: true, data: FLOUR_ITEM }
      case 'simple:preview': return previewReply()
      case 'simple:post':
        return { ok: true, data: { voucherIds: [9], entries: [], replayed: false, summary: { entries: [], parties: [], undo: { undoable: true, reason: null } }, sentences: ['Stock count of 1 product.', 'Your stock is now worth ₹80.00 less.'], facts: FACTS, warnings: { negativeStock: [], creditLimitExceeded: null } } satisfies SimplePostResult }
      case 'voucher:saveSummary': return { ok: true, data: { entries: [{ voucherId: 9, kind: 'physical_stock', number: 'PS-1', amount: 0 }], parties: [], undo: { undoable: true, reason: null } } }
      default: return { ok: true, data: [] }
    }
  })
  window.total = { platform: 'test', invoke }
  act(() => {
    useSession.setState({ info, slug: 'mehta', user: null, ui: { mode: 'simple' }, workingDate: '2026-10-13', from: '2026-04-01', to: '2027-03-31' })
    useNav.setState({ stack: [{ name: 'simple-stock' }] })
    useExplain.setState({ ready: false, handler: null })
    useDialogs.setState({ queue: [] })
  })
})
afterEach(() => {
  cleanup()
  invoke.mockReset()
})

const click = (id: string): void => void fireEvent.click(screen.getByTestId(id))
const text = (id: string): string => screen.getByTestId(id).textContent ?? ''
const typeIn = (id: string, value: string): void => void fireEvent.change(screen.getByTestId(id), { target: { value } })
const visible = (): string => document.body.textContent ?? ''
const lastScreen = (): unknown => useNav.getState().stack.at(-1)

describe('the product list and a product (WP 9.7)', () => {
  it('quantity with its unit, worth, selling price, the running-low chip; the filter; a row opens the product', async () => {
    renderUi(<StockList />)
    await waitFor(() => expect(visible()).toContain('Flour'))
    expect(visible()).toContain('100 Kg')
    expect(visible()).toContain('4,000.00')
    expect(screen.getAllByTestId('stock-level').map((c) => c.dataset.level)).toEqual(['low'])
    expect(visible()).toContain('Running low (1)')
    click('stock-show-low')
    await waitFor(() => expect(visible()).not.toContain('Flour'))
    expect(visible()).toContain('Box')
    click('stock-show-all')
    await waitFor(() => expect(visible()).toContain('Flour'))
    fireEvent.click(screen.getByText('Flour'))
    await waitFor(() => expect(lastScreen()).toEqual({ name: 'simple-stock', itemId: 1 }))
    expect(bannedWordsIn(visible())).toEqual([])
  })

  it('opened filtered (Home’s attention row): only what is running low', async () => {
    renderUi(<StockList filter="low" />)
    await waitFor(() => expect(visible()).toContain('Box'))
    expect(visible()).not.toContain('Flour')
  })

  it('a product: its figures, history in words, Change price → the default price list from today', async () => {
    renderUi(<StockList itemId={1} />)
    await waitFor(() => expect(screen.getByTestId('stock-product-qty').textContent).toBe('98 Kg'))
    expect(text('stock-product-value')).toContain('3,920.00')
    expect(visible()).toContain('Counted')
    expect(visible()).toContain('It runs out')
    click('btn-stock-change-price')
    typeIn('input-stock-price', '55')
    click('btn-stock-price-save')
    await waitFor(() => expect(calls('simple:stock:setPrice')).toEqual([{ itemId: 1, ratePaise: 5500, date: '2026-10-13' }]))
    expect(bannedWordsIn(visible())).toEqual([])
  })
})

describe('Tell me when it runs low (PR #91 to-do)', () => {
  it('saves the reorder level in the product’s unit through the masters item update, the rest of the item as stored', async () => {
    renderUi(<StockList itemId={1} />)
    await waitFor(() => expect(screen.getByTestId('btn-stock-change-low')).toBeTruthy())
    click('btn-stock-change-low')
    typeIn('input-stock-low', '12.5')
    click('btn-stock-low-save')
    await waitFor(() => expect(calls('master:stockItems:update')).toEqual([{ id: 1, data: { ...FLOUR_ITEM, reorderLevelMilli: 12_500 } }]))
    expect(bannedWordsIn(visible())).toEqual([])
  })

  it('blank or 0 = no level (told only when it runs out); unchanged writes nothing; a bad quantity is said under the box', async () => {
    renderUi(<StockList itemId={1} />)
    await waitFor(() => expect(screen.getByTestId('btn-stock-change-low')).toBeTruthy())
    click('btn-stock-change-low')
    typeIn('input-stock-low', 'lots')
    click('btn-stock-low-save')
    await waitFor(() => expect(visible()).toContain('Type a quantity, like 10 or 2.5.'))
    typeIn('input-stock-low', '0')
    click('btn-stock-low-save')
    await waitFor(() => expect(screen.queryByTestId('input-stock-low')).toBeNull())
    expect(calls('master:stockItems:update')).toEqual([])
  })

  it('a viewer sees the level but no way to change it', async () => {
    act(() => useSession.setState({ user: { id: 2, name: 'V', role: 'viewer' } } as never))
    renderUi(<StockList itemId={1} />)
    await waitFor(() => expect(screen.getByTestId('stock-product-reorder')).toBeTruthy())
    expect(screen.queryByTestId('btn-stock-change-low')).toBeNull()
  })
})

describe('History rows open the entry (PR #91 to-do)', () => {
  const HISTORY: StockProductView = {
    ...PRODUCT,
    history: {
      from: '2026-04-01', openingMilli: 100_000, rows: [
        { voucherId: 11, date: '2026-10-01', what: 'sold', party: 'Ramesh', inMilli: 0, outMilli: 5000, balanceMilli: 95_000 },
        { voucherId: 12, date: '2026-10-02', what: 'returnedIn', party: 'Ramesh', inMilli: 1000, outMilli: 0, balanceMilli: 96_000 },
        { voucherId: 14, date: '2026-10-03', what: 'bought', party: 'Shiv Mills', inMilli: 4000, outMilli: 0, balanceMilli: 100_000 },
        { voucherId: 13, date: '2026-10-04', what: 'adjusted', party: null, inMilli: 0, outMilli: 2000, balanceMilli: 98_000 },
        { voucherId: 9, date: '2026-10-10', what: 'counted', party: null, inMilli: 0, outMilli: 2000, balanceMilli: 96_000 }
      ]
    }
  }
  const KINDS: Record<number, { kind: string; originalId: number | null }> = { 11: { kind: 'sales', originalId: null }, 12: { kind: 'credit_note', originalId: 11 }, 13: { kind: 'stock_journal', originalId: null }, 9: { kind: 'physical_stock', originalId: null }, 14: { kind: 'purchase', originalId: null } }

  it('a sale → its bill view, a return → Returns on the original bill, a purchase → its bill view, a stock journal → the full app (simpleTargetFor)', async () => {
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, payload: { voucherId?: number }) => {
      if (channel === 'simple:stock:product') return { ok: true, data: HISTORY }
      if (channel === 'simple:handoffTarget') return { ok: true, data: { voucher: { id: payload.voucherId, ...KINDS[payload.voucherId!] } } }
      return base(channel, payload)
    })
    renderUi(<StockList itemId={1} />)
    const row = async (i: number): Promise<HTMLElement> => {
      await waitFor(() => expect(document.querySelector(`[data-testid="rows-stock-history"] tr:nth-child(${i + 1})`)).toBeTruthy())
      return document.querySelector(`[data-testid="rows-stock-history"] tr:nth-child(${i + 1})`) as HTMLElement
    }
    const opens = async (i: number, target: unknown): Promise<void> => {
      act(() => useNav.setState({ stack: [{ name: 'simple-stock', itemId: 1 }] }))
      fireEvent.click(await row(i))
      await waitFor(() => expect(lastScreen()).toEqual(target))
    }
    await opens(0, { name: 'simple-sales', billId: 11 })
    await opens(1, { name: 'simple-return-sale', billId: 11 })
    await opens(2, { name: 'simple-purchases', billId: 14 })
    await opens(3, { name: 'voucher-entry', voucherId: 13 })
    await opens(4, { name: 'simple-stock-count', voucherId: 9 })
  })
})

describe('A saved count reopened (PR #91 to-do)', () => {
  const SAVED: SavedCountView = {
    voucherId: 9, number: 'PS-1', date: '2026-10-10', narration: null, inBooks: true,
    lines: [
      { lineId: 1, itemId: 1, name: 'Flour', unit: 'Kg', countedMilli: 98_000, beforeMilli: 100_000, valueChange: -8000 },
      { lineId: 2, itemId: 2, name: 'Box', unit: 'Nos', countedMilli: 52_000, beforeMilli: 50_000, valueChange: 2000 },
      { lineId: 3, itemId: 3, name: 'Bread', unit: 'Nos', countedMilli: 0, beforeMilli: 0, valueChange: 0 }
    ]
  }
  it('shows what Total showed before, what was counted and the engine’s difference — never "Matches" for a real difference; Edit opens the full app', async () => {
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, payload: unknown) => (channel === 'simple:stock:count' ? { ok: true, data: SAVED } : base(channel, payload)))
    renderUi(<SavedCount voucherId={9} />)
    await waitFor(() => expect(screen.getByTestId('saved-count-rows')).toBeTruthy())
    expect(calls('simple:stock:count')).toEqual([{ voucherId: 9 }])
    expect(text('saved-count-diff-1')).toBe('2 Kg short — stock worth ₹80.00 less')
    expect(text('saved-count-diff-2')).toBe('2 Nos more than Total showed — stock worth ₹20.00 more')
    expect(text('saved-count-diff-3')).toBe('Matches')
    expect(text('saved-count-row-1')).toContain('Total showed 100 Kg')
    click('btn-saved-count-edit')
    await waitFor(() => expect(lastScreen()).toEqual({ name: 'voucher-entry', voucherId: 9 }))
    expect(bannedWordsIn(visible())).toEqual([])
  })
})

describe('Count your stock (WP 9.7)', () => {
  it('the difference in words as you type; Save posts ONE stock_count; the save card has no print buttons', async () => {
    renderUi(<StockCount />)
    await waitFor(() => expect(screen.getByTestId('input-count-1')).toBeTruthy())
    expect(visible()).toContain('Total shows 100 Kg')
    typeIn('input-count-1', '98')
    expect(text('count-diff-1')).toBe('2 Kg short')
    typeIn('input-count-2', '50')
    expect(text('count-diff-2')).toBe('Matches')
    typeIn('input-count-3', 'lots')
    expect(screen.getByTestId('count-diff-3').dataset.kind).toBe('bad')
    typeIn('input-count-3', '')
    await waitFor(() => expect(visible()).toContain('Flour: 2 Kg short — it comes off your stock.'))
    click('btn-count-save')
    await waitFor(() => expect(screen.getByTestId('save-card')).toBeTruthy())
    const posted = calls('simple:post') as { intent: { kind: string; counts: unknown[]; date: string } }[]
    expect(posted).toHaveLength(1)
    expect(posted[0]!.intent).toMatchObject({ kind: 'stock_count', date: '2026-10-13', counts: [{ itemId: 1, qty: 98_000 }, { itemId: 2, qty: 50_000 }] })
    expect(text('save-card-text')).toBe('Stock count of 1 product. Your stock is now worth ₹80.00 less.')
    expect(screen.queryByTestId('btn-save-card-print')).toBeNull()
    expect(screen.getByTestId('btn-save-card-undo')).toBeTruthy()
    expect(bannedWordsIn(visible())).toEqual([])
  })

  it('nothing counted: the problem under the list, nothing posted', async () => {
    renderUi(<StockCount />)
    await waitFor(() => expect(screen.getByTestId('input-count-1')).toBeTruthy())
    click('btn-count-save')
    await waitFor(() => expect(visible()).toContain('Count at least one product.'))
    expect(calls('simple:post')).toEqual([])
  })
})

describe('Made goods (WP 9.7)', () => {
  it('the recipe in plain words and what each material needs; not enough goes under “How many”', async () => {
    previewReply = () => ({ ok: false, error: 'Not enough Flour', code: 'simple_not_enough_material', field: 'qty', params: { names: 'Flour' } })
    renderUi(<MadeGoods itemId={3} />)
    await waitFor(() => expect(screen.getByTestId('made-recipe')).toBeTruthy())
    expect(text('made-recipe')).toContain('To make 1 Bread you use 0.5 Kg Flour, 1 Nos Box.')
    typeIn('input-made-qty', '300')
    expect(screen.getByTestId('made-need-1').dataset.short).toBe('true')
    await waitFor(() => expect(visible()).toContain('Not enough Flour in stock to make this many.'))
    expect(bannedWordsIn(visible())).toEqual([])
  })

  it('labour asks “already recorded?”; Save posts make_goods with the answers (the price prefilled)', async () => {
    previewReply = () => ({ ok: true, data: { kind: 'make_goods', sentences: ['Made 10 Nos of Bread.'], facts: { ...FACTS, kind: 'make_goods' }, entries: [], warnings: { negativeStock: [], creditLimitExceeded: null } } })
    renderUi(<MadeGoods itemId={3} />)
    await waitFor(() => expect(screen.getByTestId('made-recipe')).toBeTruthy())
    typeIn('input-made-qty', '10')
    typeIn('input-made-labour', '50')
    await waitFor(() => expect(screen.getByTestId('made-labour-question')).toBeTruthy())
    click('btn-made-save')
    await waitFor(() => expect(visible()).toContain('Say whether this labour is already recorded.'))
    expect(calls('simple:post')).toEqual([])
    click('made-labour-no')
    click('btn-made-save')
    await waitFor(() => expect(calls('simple:post')).toHaveLength(1))
    expect((calls('simple:post')[0] as { intent: unknown }).intent).toMatchObject({ kind: 'make_goods', itemId: 3, qty: 10_000, price: 4000, labour: 5000, labourRecorded: false })
  })

  it('Enter in the product picker selects, never creates (there is no create row)', async () => {
    renderUi(<MadeGoods />)
    await waitFor(() => expect(screen.getByTestId('picker-made-product')).toBeTruthy())
    typeIn('picker-made-product', 'Cake')
    fireEvent.keyDown(screen.getByTestId('picker-made-product'), { key: 'Enter' })
    expect(document.querySelector('[data-create="true"]')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('manufacturing off: says so and opens Features', async () => {
    features = { ...DEFAULT_FEATURES, manufacturing: false }
    renderUi(<MadeGoods />)
    await waitFor(() => expect(screen.getByTestId('btn-made-features')).toBeTruthy())
    click('btn-made-features')
    await waitFor(() => expect(lastScreen()).toEqual({ name: 'simple-features' }))
  })
})
