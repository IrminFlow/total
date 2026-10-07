// Price resolution (WP 2.6) — pure. Given everything known about one invoice line (item, qty,
// party, date, the price lists, party-wise rates and discount schemes) decide the rate and the
// discount, say where they came from and explain why. The main process loads the context
// (services/pricing.ts) and the renderer shows the result; nothing here touches a database.
//
// ## Precedence (first tier that yields a rate wins; tiers never stack)
//
//   1. Party-wise rate — a negotiated rate for this party + item (party_item_rates, source
//      'manual'), effective on the date; the latest effective_from wins. Its own discount_bp
//      applies. Then the remembered last selling price (source 'last_sale') when there is no
//      negotiated one.
//   2. The party's price level (ledgers.price_level_id) — the level's row for the item, effective
//      on the date, with the highest quantity slab the line's quantity reaches (min_qty_milli ≤
//      qty); the slab's discount_bp applies.
//   3. A discount scheme — when tiers 1 and 2 found nothing. The base rate comes from tier 4/5
//      (default level slab rate, else MRP, else last purchase) and the scheme's discount REPLACES
//      the default level's slab discount. Of several matching schemes the highest priority wins,
//      then the larger discount on this line, then the lower id.
//   4. The company's default price level — same row rules as tier 2.
//   5. The item's MRP (always tax-inclusive), else the last purchase rate (tax-exclusive).
//
//   Negotiated prices (tiers 1–2) are net prices: schemes are for everyone else.
//   A foreign invoice currency only uses price-list rows in that currency (tiers 2–4); party
//   rates, MRP and purchase rates are ₹ and are skipped.
//
// ## Tax-inclusive prices (levels marked inclusive_of_tax, and MRP)
//
// The invoice stores a tax-EXCLUSIVE rate per unit plus a line discount (both integer paise) and
// computes GST on the taxable value (computeGst: each component rounded half away from zero). To
// make an inclusive line total exactly what the customer was quoted:
//   - target D = round(qty × inclusive unit price) less the discount (bp of that, half away);
//   - taxable T = the largest integer t with computeGst(t).total ≤ D (searched around
//     D × 100 / (100 + GST% + cess%)); when computeGst(T).total = D the line is exact, otherwise
//     the shortfall (`residualPaise`, at most a couple of paise where component rounding skips a
//     value) is left to the invoice's rupee round-off;
//   - rate R = round half away of (inclusive unit × 100 / (100 + GST% + cess%)), raised by a paisa
//     at a time until round(qty × R) ≥ T; the line discount is round(qty × R) − T, i.e. the
//     displayed discount plus a paisa-level rounding adjustment.
// A one-line invoice therefore totals the inclusive price to the paisa before round-off. Several
// lines in one GST-rate bucket share one rounding (computeInvoice taxes the bucket), so a
// multi-line total can differ from Σ inclusive prices by under a paisa per line before round-off.

import { computeGst, type SupplyType } from './gst/calc'
import { formatPaise, roundPaise } from './money'

export type PriceSource =
  | 'party_rate'
  | 'last_price'
  | 'party_level'
  | 'scheme'
  | 'default_level'
  | 'mrp'
  | 'last_purchase'
  | 'none'

export const PRICE_SOURCE_LABELS: Record<PriceSource, string> = {
  party_rate: 'Party rate',
  last_price: 'Last price',
  party_level: 'Party level',
  scheme: 'Scheme',
  default_level: 'Default level',
  mrp: 'MRP',
  last_purchase: 'Last purchase',
  none: 'No price'
}

export interface PriceLevelInfo {
  id: number
  name: string
  inclusiveOfTax: boolean
}

export interface LevelRateRow {
  id?: number
  priceLevelId: number
  ratePaise: number
  effectiveFrom: string
  effectiveTo: string | null
  minQtyMilli: number
  discountBp: number
  currency: string
}

export interface PartyRateRow {
  id?: number
  ratePaise: number
  discountBp: number
  effectiveFrom: string | null
  effectiveTo: string | null
  source: 'manual' | 'last_sale'
  lastSoldAt: string | null
}

export type SchemeKind = 'qty_slab' | 'value_slab' | 'buy_x_get_y' | 'flat'
export type SchemeAppliesTo = 'item' | 'group' | 'all'

export interface SchemeSlab {
  minQtyMilli: number | null
  minValuePaise: number | null
  discountBp: number | null
  freeQtyMilli: number | null
}

export interface DiscountScheme {
  id: number
  name: string
  kind: SchemeKind
  appliesTo: SchemeAppliesTo
  targetId: number | null
  fromDate: string | null
  toDate: string | null
  priority: number
  active: boolean
  slabs: SchemeSlab[]
}

export interface PriceContext {
  date: string
  /** Line quantity in thousandths (0 while the user hasn't typed one — base slabs only). */
  qtyMilli: number
  /** Invoice currency; '' / 'INR' = rupees. */
  currency?: string
  supply: SupplyType
  item: {
    id: number
    /** The item's stock group and its ancestors (for group schemes), nearest first. */
    groupIds: number[]
    gstRate: number | null
    cessRate: number | null
    mrpPaise: number | null
    lastPurchaseRatePaise: number | null
  }
  /** This party's rows for this item (manual and remembered). */
  partyRates: PartyRateRow[]
  partyLevel: PriceLevelInfo | null
  defaultLevel: PriceLevelInfo | null
  /** Price-list rows for this item under any level. */
  levelRates: LevelRateRow[]
  schemes: DiscountScheme[]
}

export interface InclusiveBreakdown {
  /** The quoted tax-inclusive price per unit. */
  unitPaise: number
  /** Inclusive line value after the discount — what the customer pays for the line. */
  targetPaise: number
  taxablePaise: number
  taxPaise: number
  /** targetPaise − (taxable + tax): 0 when exact; left to the invoice round-off otherwise. */
  residualPaise: number
}

export interface PriceResult {
  /** Tax-exclusive rate per unit (paise, invoice currency); null = nothing found. */
  ratePaise: number | null
  /** The tier's discount (basis points of the line's gross). */
  discountBp: number
  /** The line discount to post at ctx.qtyMilli (paise) — bp of gross, free goods, or the
   *  inclusive rounding adjustment. */
  discountPaise: number
  /** Buy-x-get-y: units free on this line (they are in the quantity, priced at zero). */
  freeQtyMilli: number
  source: PriceSource
  /** Short hint for the grid: "Party rate", "Scheme: Diwali 10%", "Level: Wholesale". */
  label: string
  levelId?: number
  schemeId?: number
  inclusive: InclusiveBreakdown | null
  explanation: string[]
}

const rs = (p: number): string => formatPaise(p, { symbol: true })
const pct = (bp: number): string => `${bp / 100}%`
const qty = (m: number): string => String(m / 1000)

/** Half-away rounding of a × bp / 10000 (paise). */
export function bpOf(paise: number, bp: number): number {
  return roundPaise((paise * bp) / 10000)
}

/** Gross line value for qty × rate (same rounding computeInvoice uses). */
export function lineGross(qtyMilli: number, ratePaise: number): number {
  return Math.round((qtyMilli * ratePaise) / 1000)
}

export function effectiveOn(date: string, from: string | null, to: string | null): boolean {
  return (from == null || from <= date) && (to == null || to >= date)
}

/**
 * The largest taxable value whose GST-inclusive total (computeGst, per-component half-away
 * rounding) does not exceed `inclusivePaise`. `exact` = it hits the inclusive value exactly.
 */
export function solveTaxable(
  inclusivePaise: number,
  gstRate: number,
  cessRate: number,
  supply: SupplyType
): { taxablePaise: number; taxPaise: number; exact: boolean } {
  if (inclusivePaise <= 0) return { taxablePaise: 0, taxPaise: 0, exact: inclusivePaise === 0 }
  const guess = Math.floor((inclusivePaise * 100) / (100 + gstRate + cessRate))
  let best = -1
  for (let t = Math.max(0, guess - 4); t <= guess + 4; t++) {
    if (computeGst(t, gstRate, supply, cessRate).total <= inclusivePaise) best = t
  }
  if (best < 0) best = 0
  const total = computeGst(best, gstRate, supply, cessRate).total
  return { taxablePaise: best, taxPaise: total - best, exact: total === inclusivePaise }
}

/**
 * Turn a tax-inclusive unit price into the invoice line's exclusive rate + discount (see the
 * header for the rounding rule). `discountInclusivePaise` is the discount on the inclusive gross.
 */
export function inclusiveLine(
  unitInclusivePaise: number,
  qtyMilli: number,
  discountInclusivePaise: number,
  gstRate: number,
  cessRate: number,
  supply: SupplyType
): { ratePaise: number; discountPaise: number; breakdown: InclusiveBreakdown } {
  const divisor = 100 + gstRate + cessRate
  let rate = roundPaise((unitInclusivePaise * 100) / divisor)
  const target = Math.max(0, lineGross(qtyMilli, unitInclusivePaise) - discountInclusivePaise)
  const solved = solveTaxable(target, gstRate, cessRate, supply)
  if (qtyMilli > 0) {
    // Never let the exclusive gross fall below the taxable value (a negative discount).
    let guard = 0
    while (lineGross(qtyMilli, rate) < solved.taxablePaise && guard++ < 1000) rate++
  }
  const gross = qtyMilli > 0 ? lineGross(qtyMilli, rate) : 0
  return {
    ratePaise: rate,
    discountPaise: qtyMilli > 0 ? gross - solved.taxablePaise : 0,
    breakdown: {
      unitPaise: unitInclusivePaise,
      targetPaise: target,
      taxablePaise: solved.taxablePaise,
      taxPaise: solved.taxPaise,
      residualPaise: target - solved.taxablePaise - solved.taxPaise
    }
  }
}

/** The level row in force: effective on the date, in the currency, the highest slab ≤ qty,
 *  then the latest effective_from. */
export function pickLevelRow(rows: readonly LevelRateRow[], levelId: number, date: string, qtyMilli: number, currency: string): LevelRateRow | null {
  const eligible = rows.filter(
    (r) => r.priceLevelId === levelId && r.currency === currency && effectiveOn(date, r.effectiveFrom, r.effectiveTo) && r.minQtyMilli <= qtyMilli
  )
  eligible.sort((a, b) => b.minQtyMilli - a.minQtyMilli || (a.effectiveFrom < b.effectiveFrom ? 1 : a.effectiveFrom > b.effectiveFrom ? -1 : 0))
  return eligible[0] ?? null
}

function pickPartyRow(rows: readonly PartyRateRow[], source: 'manual' | 'last_sale', date: string): PartyRateRow | null {
  const eligible = rows.filter((r) => r.source === source && effectiveOn(date, r.effectiveFrom, r.effectiveTo))
  eligible.sort((a, b) => ((a.effectiveFrom ?? '') < (b.effectiveFrom ?? '') ? 1 : (a.effectiveFrom ?? '') > (b.effectiveFrom ?? '') ? -1 : 0))
  return eligible[0] ?? null
}

interface Base {
  ratePaise: number
  inclusive: boolean
  discountBp: number
  source: PriceSource
  label: string
  levelId?: number
  note: string
}

/** Scheme applicability (active, dated, target) — slabs are checked separately. */
export function schemeApplies(s: DiscountScheme, itemId: number, groupIds: readonly number[], date: string): boolean {
  if (!s.active || !effectiveOn(date, s.fromDate, s.toDate)) return false
  if (s.appliesTo === 'all') return true
  if (s.appliesTo === 'item') return s.targetId === itemId
  return s.targetId != null && groupIds.includes(s.targetId)
}

export interface SchemeHit {
  scheme: DiscountScheme
  slab: SchemeSlab
  discountBp: number
  freeQtyMilli: number
  /** Discount in the base's own terms (inclusive gross for an inclusive base). */
  discountPaise: number
  why: string
}

/** The slab of a scheme a line reaches, and what it's worth on a base gross. */
export function evaluateScheme(s: DiscountScheme, qtyMilli: number, baseRatePaise: number): SchemeHit | null {
  const gross = lineGross(qtyMilli, baseRatePaise)
  if (s.kind === 'buy_x_get_y') {
    // "Buy X get Y": of every X + Y units on the line, Y are free (the highest slab reached).
    const slabs = s.slabs
      .filter((sl) => sl.minQtyMilli != null && sl.freeQtyMilli != null && sl.minQtyMilli > 0)
      .filter((sl) => qtyMilli >= sl.minQtyMilli! + sl.freeQtyMilli!)
      .sort((a, b) => b.minQtyMilli! - a.minQtyMilli!)
    const sl = slabs[0]
    if (!sl) return null
    const sets = Math.floor(qtyMilli / (sl.minQtyMilli! + sl.freeQtyMilli!))
    const free = sets * sl.freeQtyMilli!
    const discountPaise = lineGross(free, baseRatePaise)
    return {
      scheme: s, slab: sl, discountBp: gross > 0 ? Math.round((discountPaise * 10000) / gross) : 0, freeQtyMilli: free, discountPaise,
      why: `buy ${qty(sl.minQtyMilli!)} get ${qty(sl.freeQtyMilli!)} free: ${qty(free)} free of ${qty(qtyMilli)}`
    }
  }
  const reach = (sl: SchemeSlab): number | null => {
    if (sl.discountBp == null) return null
    if (s.kind === 'value_slab') return sl.minValuePaise != null && gross >= sl.minValuePaise ? sl.minValuePaise : null
    if (s.kind === 'flat') return sl.minQtyMilli ?? 0
    return sl.minQtyMilli != null && qtyMilli >= sl.minQtyMilli ? sl.minQtyMilli : null
  }
  const slabs = s.slabs
    .map((sl) => ({ sl, at: reach(sl) }))
    .filter((x): x is { sl: SchemeSlab; at: number } => x.at != null)
    .sort((a, b) => b.at - a.at)
  const hit = slabs[0]
  if (!hit) return null
  const bp = hit.sl.discountBp!
  const why =
    s.kind === 'value_slab'
      ? `line value ${rs(gross)} ≥ ${rs(hit.sl.minValuePaise!)}: ${pct(bp)} off`
      : s.kind === 'flat'
        ? `${pct(bp)} off`
        : `qty ${qty(qtyMilli)} ≥ ${qty(hit.sl.minQtyMilli!)}: ${pct(bp)} off`
  return { scheme: s, slab: hit.sl, discountBp: bp, freeQtyMilli: 0, discountPaise: bpOf(gross, bp), why }
}

/** Pick the winning scheme among those that apply (priority, then benefit, then id). */
export function bestScheme(schemes: readonly DiscountScheme[], ctx: Pick<PriceContext, 'date' | 'qtyMilli' | 'item'>, baseRatePaise: number): { hit: SchemeHit | null; others: SchemeHit[] } {
  const hits = schemes
    .filter((s) => schemeApplies(s, ctx.item.id, ctx.item.groupIds, ctx.date))
    .map((s) => evaluateScheme(s, ctx.qtyMilli, baseRatePaise))
    .filter((h): h is SchemeHit => h != null)
  hits.sort((a, b) => b.scheme.priority - a.scheme.priority || b.discountPaise - a.discountPaise || a.scheme.id - b.scheme.id)
  return { hit: hits[0] ?? null, others: hits.slice(1) }
}

/** Resolve one line's price. See the header for the precedence and the rounding rule. */
export function resolvePrice(ctx: PriceContext): PriceResult {
  const currency = !ctx.currency || ctx.currency === 'INR' ? 'INR' : ctx.currency
  const inr = currency === 'INR'
  const q = Math.max(0, ctx.qtyMilli)
  const gst = ctx.item.gstRate ?? 0
  const cess = ctx.item.cessRate ?? 0
  const explanation: string[] = []

  const finish = (b: Base, discount: { bp: number; grossDiscountPaise?: number; free?: number; extra?: string[] }, rest: Partial<PriceResult>): PriceResult => {
    explanation.push(b.note)
    if (discount.extra) explanation.push(...discount.extra)
    let rate = b.ratePaise
    let discountPaise: number
    let inclusive: InclusiveBreakdown | null = null
    if (b.inclusive) {
      const discIncl = discount.grossDiscountPaise ?? bpOf(lineGross(q, b.ratePaise), discount.bp)
      const line = inclusiveLine(b.ratePaise, q, discIncl, gst, cess, ctx.supply)
      rate = line.ratePaise
      discountPaise = line.discountPaise
      inclusive = line.breakdown
      explanation.push(
        `Inclusive of ${gst}% GST${cess ? ` + ${cess}% cess` : ''}: ${rs(b.ratePaise)} → taxable rate ${rs(rate)}` +
          (q > 0 ? `; line ${rs(line.breakdown.targetPaise)} = taxable ${rs(line.breakdown.taxablePaise)} + tax ${rs(line.breakdown.taxPaise)}` : '')
      )
      if (q > 0 && line.breakdown.residualPaise !== 0) {
        explanation.push(`${rs(line.breakdown.residualPaise)} can't be reached by GST rounding — left to the invoice round-off`)
      }
    } else {
      discountPaise = discount.grossDiscountPaise ?? bpOf(lineGross(q, rate), discount.bp)
    }
    return {
      ratePaise: rate, discountBp: discount.bp, discountPaise, freeQtyMilli: discount.free ?? 0,
      source: b.source, label: b.label, levelId: b.levelId, inclusive, explanation, ...rest
    }
  }

  // ---- tier 1: party-wise rate, then the remembered last price ----
  if (inr) {
    const manual = pickPartyRow(ctx.partyRates, 'manual', ctx.date)
    if (manual) {
      return finish(
        { ratePaise: manual.ratePaise, inclusive: false, discountBp: manual.discountBp, source: 'party_rate', label: 'Party rate',
          note: `Party-wise rate ${rs(manual.ratePaise)}${manual.discountBp ? ` less ${pct(manual.discountBp)}` : ''}${manual.effectiveFrom ? ` from ${manual.effectiveFrom}` : ''}${manual.effectiveTo ? ` to ${manual.effectiveTo}` : ''}` },
        { bp: manual.discountBp }, {}
      )
    }
    const last = pickPartyRow(ctx.partyRates, 'last_sale', ctx.date)
    if (last) {
      return finish(
        { ratePaise: last.ratePaise, inclusive: false, discountBp: last.discountBp, source: 'last_price', label: 'Last price',
          note: `Last sold to this party at ${rs(last.ratePaise)}${last.discountBp ? ` less ${pct(last.discountBp)}` : ''}${last.lastSoldAt ? ` on ${last.lastSoldAt}` : ''}` },
        { bp: last.discountBp }, {}
      )
    }
    if (ctx.partyRates.length > 0) explanation.push('Party-wise rates exist but none is in force on this date')
  }

  // ---- tier 2: the party's price level ----
  const levelBase = (level: PriceLevelInfo, source: 'party_level' | 'default_level'): Base | null => {
    const row = pickLevelRow(ctx.levelRates, level.id, ctx.date, q, currency)
    if (!row) return null
    const slab = row.minQtyMilli > 0 ? ` (slab from qty ${qty(row.minQtyMilli)})` : ''
    return {
      ratePaise: row.ratePaise, inclusive: level.inclusiveOfTax, discountBp: row.discountBp, source, levelId: level.id,
      label: `Level: ${level.name}`,
      note: `${source === 'party_level' ? "Party's" : 'Default'} level ${level.name}: ${rs(row.ratePaise)}${level.inclusiveOfTax ? ' incl. tax' : ''}${slab}${row.discountBp ? ` less ${pct(row.discountBp)}` : ''}, from ${row.effectiveFrom}${row.effectiveTo ? ` to ${row.effectiveTo}` : ''}`
    }
  }
  if (ctx.partyLevel) {
    const b = levelBase(ctx.partyLevel, 'party_level')
    if (b) return finish(b, { bp: b.discountBp }, {})
    explanation.push(`Party's level ${ctx.partyLevel.name} has no rate for this item on ${ctx.date}`)
  }

  // ---- base for tiers 3–5 ----
  let base: Base | null = null
  if (ctx.defaultLevel) {
    base = levelBase(ctx.defaultLevel, 'default_level')
    if (!base) explanation.push(`Default level ${ctx.defaultLevel.name} has no rate for this item on ${ctx.date}`)
  }
  if (!base && inr && ctx.item.mrpPaise != null && ctx.item.mrpPaise > 0) {
    base = { ratePaise: ctx.item.mrpPaise, inclusive: true, discountBp: 0, source: 'mrp', label: 'MRP', note: `MRP ${rs(ctx.item.mrpPaise)} (inclusive of all taxes)` }
  }
  if (!base && inr && ctx.item.lastPurchaseRatePaise != null && ctx.item.lastPurchaseRatePaise > 0) {
    base = {
      ratePaise: ctx.item.lastPurchaseRatePaise, inclusive: false, discountBp: 0, source: 'last_purchase', label: 'Last purchase',
      note: `Last purchase rate ${rs(ctx.item.lastPurchaseRatePaise)}`
    }
  }
  if (!base) {
    explanation.push('No price list, MRP or purchase rate for this item')
    return { ratePaise: null, discountBp: 0, discountPaise: 0, freeQtyMilli: 0, source: 'none', label: PRICE_SOURCE_LABELS.none, inclusive: null, explanation }
  }

  // ---- tier 3: schemes over the base ----
  const { hit, others } = bestScheme(ctx.schemes, { date: ctx.date, qtyMilli: q, item: ctx.item }, base.ratePaise)
  if (hit) {
    const replaced = base.discountBp ? ` (replaces the level's ${pct(base.discountBp)})` : ''
    const extra = [
      `Scheme ${hit.scheme.name}${hit.scheme.priority ? ` (priority ${hit.scheme.priority})` : ''}: ${hit.why}${replaced}`,
      ...others.map((o) => `Also matched ${o.scheme.name} (priority ${o.scheme.priority}, ${rs(o.discountPaise)}) — not applied`)
    ]
    return finish(
      { ...base, note: `Base: ${base.note}` },
      { bp: hit.discountBp, grossDiscountPaise: hit.discountPaise, free: hit.freeQtyMilli, extra },
      { source: 'scheme', label: `Scheme: ${hit.scheme.name}`, schemeId: hit.scheme.id }
    )
  }
  return finish(base, { bp: base.discountBp }, {})
}
