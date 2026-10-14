// Stock and Made goods (WP 9.7, plan 2026-10-13 §2.2 / §7): the pure half of the simple Stock
// screens — the shapes `simple:stock:*` return, the "running low" rule, the stock count's
// differences in words, the form answers → intents, and the PURE mapping of the two stock intents
// (`stock_count`, `make_goods`) to the accountant editors' own form state:
//
//   stock_count → the Physical Stock editor's PhysicalFormState (voucherEdit/physical.ts) and the
//                 payload its builder posts — counted quantities only (is_absolute lines, rate and
//                 amount 0): the valuation engine prices the difference, exactly as for a count
//                 typed into the editor;
//   make_goods  → the Manufacture screen's ManufactureFormState (voucherEdit/manufacture.ts) with
//                 the recipe's rows (the BOM version in force on the date, one level — what the
//                 screen fills in), and the input manufacture:save receives; the finished goods
//                 enter stock at the engine's cost of what the recipe uses + labour (the derived
//                 rule, saveManufacture's own pricing).
//
// No new posting path, voucher kind or stored balance (plan §0.1). This module imports only TYPES
// from intents.ts (intents.ts calls the mappers below), so there is no runtime cycle. Pure: no DB.
// Quantities are integer thousandths, money integer paise — never a float in a total.

import type { Translate } from '../i18n'
import { AppError } from '../errors/appError'
import type { ErrorCode } from '../errors/codes'
import { formatPaise, formatQtyMilli } from '../money'
import { buildPhysicalPayload, emptyPhysicalState, type PhysicalFormState } from '../voucherEdit/physical'
import { emptyManufactureState, evaluateManufactureForm, padManufactureRows, type ManufactureFormState } from '../voucherEdit/manufacture'
import { qtyText, type VoucherPayload } from '../voucherEdit/payload'
import { buildManufactureVoucher, type ManufactureIssueCode } from '../manufacture'
import { componentQtyMilli, explodeBom, pickBomVersion, type BomVersion } from '../bom'
import { isBelowReorder } from '../stockPlanning'
import type { IntentContext, IntentFacts, IntentVoucherType, MappedIntent, NormalIntent, SimpleIntentInput } from './intents'

const fail = (code: ErrorCode, message: string, field?: string, params?: Record<string, string | number>): never => {
  throw new AppError(code, message, { ...(field ? { field } : {}), ...(params ? { params } : {}) })
}

// ---------------------------------------------------------------- running low

/** How a product's stock stands. */
export type StockLevel = 'ok' | 'low' | 'out'

/**
 * The "running low" rule. A product with a reorder level (the accountant's "warn me below") is
 * LOW strictly below it (stockPlanning.isBelowReorder — the Reorder report's rule) and OUT at
 * zero or less. A product WITHOUT a level gets no invented threshold: it is only OUT — nothing
 * (or less) left of something that has been in stock (an opening, a purchase, a sale); a product
 * never stocked is not "running low". Any figure we picked (5? 10% of last month?) would mean
 * different things for rice in kilos and phones in pieces; zero means the same for both.
 */
export function stockLevel(
  row: { closingQtyMilli: number; openingQtyMilli: number; inwardQtyMilli: number; outwardQtyMilli: number },
  reorderLevelMilli: number | null
): StockLevel {
  const hasLevel = reorderLevelMilli != null && reorderLevelMilli > 0
  const moved = row.openingQtyMilli !== 0 || row.inwardQtyMilli > 0 || row.outwardQtyMilli > 0
  if (row.closingQtyMilli <= 0 && (hasLevel || moved)) return 'out'
  return isBelowReorder(row.closingQtyMilli, reorderLevelMilli) ? 'low' : 'ok'
}

export const needsReorder = (level: StockLevel): boolean => level !== 'ok'

// ---------------------------------------------------------------- IPC shapes

/** One product of the Stock list — quantity and value straight from stockAnalysis.stockSummary
 *  (the accountant Stock summary's own rows), the selling price from resolvePrice. */
export interface StockRow {
  itemId: number
  name: string
  unit: string
  qtyMilli: number
  value: number
  /** What a bill would charge a walk-in customer per unit today (resolvePrice), null = none. */
  sellingPrice: number | null
  reorderLevelMilli: number | null
  level: StockLevel
  /** It has a recipe (a BOM) in force today. */
  hasRecipe: boolean
}

export interface StockList {
  asOn: string
  rows: StockRow[]
  /** Products running low or out (needsReorder) — Home's attention row says this number. */
  lowCount: number
}

export type StockHistoryWhat = 'opening' | 'bought' | 'sold' | 'returnedIn' | 'returnedOut' | 'counted' | 'made' | 'used' | 'sent' | 'received' | 'other'

export interface StockHistoryRow {
  voucherId: number
  date: string
  what: StockHistoryWhat
  /** Customer / supplier, when the entry has one. */
  party: string | null
  inMilli: number
  outMilli: number
  /** On hand after this movement. */
  balanceMilli: number
}

export interface StockRecipe {
  versionId: number
  /** Per ONE unit of the product made (thousandths). */
  lines: { itemId: number; name: string; unit: string; qtyMilliPerUnit: number; scrapPctBp: number | null }[]
}

export interface StockProductView {
  itemId: number
  name: string
  unit: string
  hsn: string | null
  gstRate: number | null
  asOn: string
  qtyMilli: number
  value: number
  /** Value ÷ quantity per unit (paise), null while none is on hand. */
  unitCost: number | null
  sellingPrice: number | null
  reorderLevelMilli: number | null
  level: StockLevel
  recipe: StockRecipe | null
  /** The product's movements this year to `asOn` (stockAnalysis.stockMovements — the Stock
   *  movements screen's register), oldest first, after the year's opening. */
  history: { from: string; openingMilli: number; rows: StockHistoryRow[] }
}

/** The register's voucher kind + direction, in plain words. */
export function historyWhat(kind: string, direction: 'in' | 'out', absolute: boolean): StockHistoryWhat {
  if (absolute) return 'counted'
  switch (kind) {
    case 'sales':
      return 'sold'
    case 'purchase':
      return 'bought'
    case 'credit_note':
      return 'returnedIn'
    case 'debit_note':
      return 'returnedOut'
    case 'physical_stock':
      return 'counted'
    case 'stock_journal':
      return direction === 'in' ? 'made' : 'used'
    case 'delivery_note':
      return direction === 'out' ? 'sent' : 'returnedIn'
    case 'receipt_note':
      return direction === 'in' ? 'received' : 'returnedOut'
    default:
      return 'other'
  }
}

/** Made goods' choices: every product with a recipe in force on the date. */
export interface MadeGoodsSetup {
  date: string
  products: {
    itemId: number
    name: string
    unit: string
    recipe: StockRecipe
    /** The Manufacture screen's "average price" prefill (this year's sales, else the price list). */
    suggestedPrice: number | null
  }[]
}

// ---------------------------------------------------------------- the recipe

/** The recipe's rows for `qtyMilli` of the product on `date`: the BOM version in force (else the
 *  default) exploded ONE level — what the Manufacture screen fills its rows with. null = none. */
export function recipeRows(itemId: number, qtyMilli: number, versions: readonly BomVersion[], date: string): { versionId: number; rows: { componentId: number; qtyMilli: number }[] } | null {
  const v = pickBomVersion(versions, itemId, date)
  if (!v || v.lines.length === 0) return null
  const r = explodeBom(itemId, qtyMilli, versions, date, { levels: 'single', versionId: v.id })
  if (!r.ok || r.rows.length === 0) return null
  return { versionId: v.id, rows: r.rows }
}

/** What the recipe needs for `qtyMilli` (the same rounding as explodeBom). */
export const recipeNeeds = (recipe: StockRecipe, qtyMilli: number): { itemId: number; qtyMilli: number }[] =>
  recipe.lines.map((l) => ({ itemId: l.itemId, qtyMilli: componentQtyMilli(qtyMilli, l.qtyMilliPerUnit, l.scrapPctBp) }))

// ---------------------------------------------------------------- the stock count

/** A count against what Total shows, in words. */
export interface CountDifference { kind: 'same' | 'short' | 'extra'; milli: number }

export function countDifference(beforeMilli: number, countedMilli: number): CountDifference {
  const d = countedMilli - beforeMilli
  return d === 0 ? { kind: 'same', milli: 0 } : d < 0 ? { kind: 'short', milli: -d } : { kind: 'extra', milli: d }
}

/** A typed count → thousandths ("10", "2.5", "1,000", "0"); null = blank or not a quantity. */
export function parseCountText(text: string): number | null {
  const s = text.trim()
  if (s === '') return null
  const m = /^(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d{1,3}))?$/.exec(s)
  if (!m) return null
  const milli = Number(m[1]!.replace(/,/g, '')) * 1000 + Number((m[2] ?? '').padEnd(3, '0'))
  return Number.isSafeInteger(milli) ? milli : null
}

export interface CountForm {
  date: string
  /** Typed counts by product id ('' / missing = not counted, left unchanged). */
  counted: Readonly<Record<number, string>>
}

export type CountField = 'date' | 'counts'

/** Client-side checks: at least one count, every count a quantity. Keys are i18n keys. */
export function countFormErrors(form: CountForm): Partial<Record<CountField, 'simple.stock.count.err.none' | 'simple.stock.count.err.qty'>> {
  const typed = Object.values(form.counted).filter((v) => v.trim() !== '')
  if (typed.length === 0) return { counts: 'simple.stock.count.err.none' }
  if (typed.some((v) => parseCountText(v) == null)) return { counts: 'simple.stock.count.err.qty' }
  return {}
}

/** Rows the user typed a count for, in id order: a bad one is left out (countFormErrors says so). */
export function countedRows(form: CountForm): { itemId: number; qtyMilli: number }[] {
  return Object.entries(form.counted)
    .map(([id, v]) => ({ itemId: Number(id), qtyMilli: parseCountText(v) }))
    .filter((r): r is { itemId: number; qtyMilli: number } => r.qtyMilli != null)
    .sort((a, b) => a.itemId - b.itemId)
}

type WithoutClientId<T> = T extends unknown ? Omit<T, 'clientId'> : never

export function countIntentFrom(form: CountForm): WithoutClientId<Extract<SimpleIntentInput, { kind: 'stock_count' }>> {
  return { kind: 'stock_count', date: form.date, counts: countedRows(form).map((r) => ({ itemId: r.itemId, qty: r.qtyMilli })) }
}

// ---------------------------------------------------------------- Made goods

export interface MakeForm {
  date: string
  itemId: number | null
  qtyText: string
  /** What one sells for, paise (prefilled from the suggestion; null = not given). */
  price: number | null
  /** Labour for this batch, paise (null = none). */
  labour: number | null
  /** "Labour already recorded?" — asked only with labour; null = not answered yet. */
  labourRecorded: boolean | null
}

export const emptyMakeForm = (date: string): MakeForm => ({ date, itemId: null, qtyText: '', price: null, labour: null, labourRecorded: null })

export type MakeField = 'date' | 'item' | 'qty' | 'price' | 'labour' | 'labourRecorded'

export function makeFormErrors(form: MakeForm): Partial<Record<MakeField, 'simple.made.err.item' | 'simple.made.err.qty' | 'simple.made.err.price' | 'simple.made.err.labourRecorded'>> {
  const out: Partial<Record<MakeField, 'simple.made.err.item' | 'simple.made.err.qty' | 'simple.made.err.price' | 'simple.made.err.labourRecorded'>> = {}
  if (form.itemId == null) out.item = 'simple.made.err.item'
  const q = parseCountText(form.qtyText)
  if (q == null || q <= 0) out.qty = 'simple.made.err.qty'
  if (form.price == null) out.price = 'simple.made.err.price'
  if ((form.labour ?? 0) > 0 && form.labourRecorded == null) out.labourRecorded = 'simple.made.err.labourRecorded'
  return out
}

export function makeIntentFrom(form: MakeForm): WithoutClientId<Extract<SimpleIntentInput, { kind: 'make_goods' }>> {
  const labour = form.labour ?? 0
  return {
    kind: 'make_goods',
    date: form.date,
    itemId: form.itemId ?? 0,
    qty: parseCountText(form.qtyText) ?? 0,
    ...(form.price != null ? { price: form.price } : {}),
    ...(labour > 0 ? { labour, labourRecorded: !!form.labourRecorded } : {})
  }
}

// ---------------------------------------------------------------- the mapping (called by intents.ts mapIntent)

function typeFor(ctx: IntentContext, kind: 'physical_stock' | 'stock_journal', number: string | null): { type: IntentVoucherType; number: string } {
  const t = ctx.types[kind]
  if (!t) return fail('simple_no_type', `This company has no ${kind.replace('_', ' ')} entry type`)
  if (t.numbering === 'manual') {
    if (!number) return fail('number_required', `${t.name} is numbered by hand — give its number`, 'number')
    return { type: t, number }
  }
  return { type: t, number: number ?? t.next }
}

const nameOf = (ctx: IntentContext, itemId: number): string => ctx.stock?.get(itemId)?.name ?? ctx.items.get(itemId)?.name ?? ''
const unitOf = (ctx: IntentContext, itemId: number): string => ctx.stock?.get(itemId)?.unit ?? ''

/** stock_count → the Physical Stock editor's form state + its payload (one entry). */
export function mapStockCount(n: Extract<NormalIntent, { kind: 'stock_count' }>, ctx: IntentContext, facts: IntentFacts): MappedIntent {
  const seen = new Set<number>()
  for (const c of n.counts) {
    if (!ctx.items.has(c.itemId)) fail('simple_no_item', 'Pick a product to count', 'counts')
    if (seen.has(c.itemId)) fail('simple_count_twice', `${nameOf(ctx, c.itemId)} is counted twice`, 'counts', { name: nameOf(ctx, c.itemId) })
    seen.add(c.itemId)
  }
  const { type, number } = typeFor(ctx, 'physical_stock', n.number)
  const state: PhysicalFormState = {
    ...emptyPhysicalState(n.date),
    number,
    rows: n.counts.map((c) => ({ itemId: c.itemId, qtyText: qtyText(c.qtyMilli), godownId: null, batchId: null })),
    narration: n.narration
  }
  const built = buildPhysicalPayload(state, { voucherTypeId: type.id, itemName: (id) => nameOf(ctx, id) })
  if (!built.ok) return fail('simple_cannot_build', built.error, 'counts')
  return {
    entries: [{ role: 'count', kind: 'physical_stock', voucherTypeId: type.id, form: 'physical', state, payload: built.payload }],
    facts: {
      ...facts,
      count: {
        lines: n.counts.map((c) => ({
          itemId: c.itemId,
          name: nameOf(ctx, c.itemId),
          unit: unitOf(ctx, c.itemId),
          beforeMilli: ctx.stock?.get(c.itemId)?.qtyMilli ?? 0,
          countedMilli: c.qtyMilli,
          valueChange: null
        }))
      }
    }
  }
}

const MAKE_ISSUE_FIELD: Partial<Record<ManufactureIssueCode, string>> = { no_item: 'item', bad_qty: 'qty', bad_labour: 'labour', bad_sale_rate: 'price', no_raw: 'item' }

/** make_goods → the Manufacture screen's form state (rows from the recipe) + the save input. */
export function mapMakeGoods(n: Extract<NormalIntent, { kind: 'make_goods' }>, ctx: IntentContext, facts: IntentFacts): MappedIntent {
  if (!ctx.items.has(n.itemId)) return fail('simple_no_item', 'Pick what you made', 'item')
  const name = nameOf(ctx, n.itemId)
  const make = ctx.make
  const recipe = make ? recipeRows(n.itemId, n.qtyMilli, make.versions, n.date) : null
  if (!make || !recipe) return fail('simple_no_recipe', `${name} has no list of materials yet`, 'item', { name })
  // The engine's prices for exactly these rows (main priced them with the same recipeRows).
  const priced = recipe.rows.map((r) => make.priced.lines.find((l) => l.itemId === r.componentId && l.qtyMilli === r.qtyMilli))
  if (priced.some((p) => !p)) return fail('simple_cannot_build', 'The materials changed while saving — try again', 'qty')
  const short = recipe.rows.filter((r, i) => priced[i]!.onHandQtyMilli < r.qtyMilli).map((r) => nameOf(ctx, r.componentId))
  if (short.length) return fail('simple_not_enough_material', `Not enough ${short.join(', ')} to make this many`, 'qty', { names: short.join(', ') })
  const price = n.price ?? make.suggestedPrice
  if (price == null) return fail('simple_no_sale_price', `Say what you sell one ${name} for`, 'price', { name })
  const { type, number } = typeFor(ctx, 'stock_journal', n.number)
  const state: ManufactureFormState = {
    ...emptyManufactureState(n.date),
    number,
    narration: n.narration,
    finishedItemId: n.itemId,
    qtyText: qtyText(n.qtyMilli),
    saleRatePaise: price,
    labourPaise: n.labour,
    // "Labour already recorded?" yes = the editor's "Labour already booked" (capitalised only).
    labourPosted: !n.labourRecorded,
    labourCreditLedgerId: null,
    rows: padManufactureRows(recipe.rows.map((r) => ({ itemId: r.componentId, qtyText: qtyText(r.qtyMilli), godownId: null }))),
    bomVersionId: recipe.versionId,
    bomExploded: false
  }
  const materialPaise = priced.reduce((s, p) => s + p!.costPaise, 0)
  // Selling below cost is said in the preview; the user saw it before saving (the editor's
  // "confirm to save at a loss").
  const ev = evaluateManufactureForm(state, { voucherTypeId: type.id, materialPaise, itemName: (id) => nameOf(ctx, id), confirmLoss: true })
  const issue = ev.issues[0]
  if (issue) return fail(issue.code === 'bad_qty' ? 'simple_bad_qty' : 'simple_cannot_build', issue.message, MAKE_ISSUE_FIELD[issue.code] ?? 'qty')
  const postLabour = ev.input.labourPosted && ev.input.labourPaise > 0
  if (postLabour && (make.labour.expenseId == null || make.labour.creditId == null)) return fail('simple_cannot_build', 'The labour accounts are missing', 'labour')
  const payload = buildManufactureVoucher(ev.input, {
    voucherTypeId: type.id,
    rawCosts: priced.map((p) => p!.costPaise),
    finishedName: name,
    labourExpenseLedgerId: postLabour ? make.labour.expenseId : null,
    labourCreditLedgerId: postLabour ? make.labour.creditId : null
  }) as unknown as VoucherPayload
  return {
    entries: [{ role: 'made', kind: 'stock_journal', voucherTypeId: type.id, form: 'manufacture', state, input: ev.input, payload }],
    facts: {
      ...facts,
      total: ev.totals.productionCost,
      made: {
        itemId: n.itemId,
        name,
        unit: unitOf(ctx, n.itemId),
        qtyMilli: n.qtyMilli,
        materials: recipe.rows.map((r, i) => ({ itemId: r.componentId, name: nameOf(ctx, r.componentId), unit: unitOf(ctx, r.componentId), qtyMilli: r.qtyMilli, costPaise: priced[i]!.costPaise })),
        materialPaise,
        labourPaise: n.labour,
        labourRecorded: n.labourRecorded,
        valuePaise: ev.totals.productionCost,
        profitPaise: ev.totals.profit
      }
    }
  }
}

// ---------------------------------------------------------------- plain words

const qty = (milli: number, unit: string): { qty: string; unit: string } => ({ qty: formatQtyMilli(milli), unit })
const money = (p: number): string => formatPaise(p, { symbol: true })

/** What a count / a batch made records, in plain sentences (t() + money.ts; never a model). */
export function stockSentences(f: IntentFacts, t: Translate): string[] {
  const out: string[] = []
  if (f.kind === 'stock_count' && f.count) {
    out.push(t('simple.stock.intent.count', { count: f.count.lines.length }))
    let differ = 0
    for (const l of f.count.lines) {
      const d = countDifference(l.beforeMilli, l.countedMilli)
      if (d.kind === 'same') continue
      differ++
      out.push(t(d.kind === 'short' ? 'simple.stock.intent.short' : 'simple.stock.intent.extra', { name: l.name, ...qty(d.milli, l.unit) }))
    }
    if (differ === 0) out.push(t('simple.stock.intent.allMatch'))
    const known = f.count.lines.filter((l) => l.valueChange != null)
    if (known.length) {
      const change = known.reduce((s, l) => s + l.valueChange!, 0)
      if (change !== 0) out.push(t(change < 0 ? 'simple.stock.intent.worthLess' : 'simple.stock.intent.worthMore', { amount: money(Math.abs(change)) }))
    }
  }
  if (f.kind === 'make_goods' && f.made) {
    const m = f.made
    out.push(t('simple.stock.intent.made', { name: m.name, ...qty(m.qtyMilli, m.unit) }))
    const used = m.materials.map((x) => t('simple.stock.intent.usedItem', { name: x.name, ...qty(x.qtyMilli, x.unit) })).join(', ')
    out.push(t('simple.stock.intent.used', { list: used }))
    out.push(
      m.labourPaise > 0
        ? t('simple.stock.intent.valueWithLabour', { amount: money(m.valuePaise), materials: money(m.materialPaise), labour: money(m.labourPaise) })
        : t('simple.stock.intent.value', { amount: money(m.valuePaise) })
    )
    if (m.labourPaise > 0 && !m.labourRecorded) out.push(t('simple.stock.intent.wagesDue', { amount: money(m.labourPaise) }))
    if (m.profitPaise < 0) out.push(t('simple.stock.intent.belowCost', { name: m.name }))
  }
  return out
}
