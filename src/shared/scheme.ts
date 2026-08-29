/**
 * Quantity-break and scheme discounts (roadmap #383).
 *
 * Three shapes cover almost every scheme a distributor or a shop actually runs:
 *
 *   percent  — buy ten, take 5% off
 *   rate     — buy a case, the rate drops to the case rate
 *   free     — buy ten, get one free
 *
 * The "free" one is the interesting case. A free good still leaves the shop, so it still has to
 * leave stock: billing ten and giving away eleven makes the stock ledger wrong by one unit every
 * time. So a free scheme raises the BILLED quantity to include the free units and discounts their
 * value away. The customer pays for ten, the books move eleven, and the GST is on what was
 * charged — which is what section 15 asks for.
 */

export type SchemeKind = 'percent' | 'rate' | 'free'

export interface Scheme {
  id: number
  /** Applies to this item; null when it applies to a whole stock group. */
  stockItemId: number | null
  stockGroupId: number | null
  kind: SchemeKind
  /** The slab starts here. 10 pieces = 10_000. */
  minQtyMilli: number
  /** Basis points off the gross, for `percent`. 500 = 5%. */
  percentBp: number | null
  /** Flat rate per base unit, for `rate`. */
  ratePaise: number | null
  /** Units given free per `minQtyMilli` bought, for `free`. */
  freeQtyMilli: number | null
  fromDate: string
  /** Inclusive. Null = runs until somebody stops it. */
  toDate: string | null
  active: boolean
}

export interface SchemeApplication {
  schemeId: number
  kind: SchemeKind
  label: string
  /** Quantity that goes on the invoice line — includes free units. */
  billedQtyMilli: number
  /** Free units inside `billedQtyMilli`. */
  freeQtyMilli: number
  /** Rate per base unit after the scheme. Unchanged except for a `rate` scheme. */
  ratePaise: number
  /** Discount in paise off the gross of `billedQtyMilli × ratePaise`. */
  discountPaise: number
  /** What the line would have cost without the scheme, for the "you saved" line. */
  savedPaise: number
}

const roundP = (v: number): number => Math.sign(v) * Math.round(Math.abs(v))

/** Is this scheme live on `on`, and does it reach this item? */
export function schemeApplies(s: Scheme, on: string, stockItemId: number, stockGroupId: number | null): boolean {
  if (!s.active) return false
  if (s.fromDate > on) return false
  if (s.toDate !== null && s.toDate < on) return false
  if (s.stockItemId !== null) return s.stockItemId === stockItemId
  if (s.stockGroupId !== null) return stockGroupId !== null && s.stockGroupId === stockGroupId
  return false
}

/**
 * Best scheme for a quantity, or null.
 *
 * "Best" is measured in money off, not in slab height: a shop running both a 5% slab at ten units
 * and a case rate at twelve should not lose the customer the better of the two because one has a
 * higher threshold. Ties go to the item-specific scheme over the group one — a scheme written for
 * one item is the more deliberate instruction.
 */
export function applyScheme(
  qtyMilli: number,
  baseRatePaise: number,
  schemes: Scheme[],
  ctx: { on: string; stockItemId: number; stockGroupId: number | null }
): SchemeApplication | null {
  const candidates = schemes
    .filter((s) => schemeApplies(s, ctx.on, ctx.stockItemId, ctx.stockGroupId))
    .filter((s) => s.minQtyMilli > 0 && qtyMilli >= s.minQtyMilli)
    .map((s) => evaluate(s, qtyMilli, baseRatePaise))
    .filter((a): a is SchemeApplication => a !== null && a.savedPaise > 0)

  if (candidates.length === 0) return null
  const bySpecificity = new Map(schemes.map((s) => [s.id, s.stockItemId !== null]))
  return candidates.sort((a, b) => {
    if (b.savedPaise !== a.savedPaise) return b.savedPaise - a.savedPaise
    return Number(bySpecificity.get(b.schemeId) ?? false) - Number(bySpecificity.get(a.schemeId) ?? false)
  })[0]!
}

function evaluate(s: Scheme, qtyMilli: number, baseRatePaise: number): SchemeApplication | null {
  const grossAtBase = roundP((qtyMilli * baseRatePaise) / 1000)

  if (s.kind === 'percent') {
    if (s.percentBp == null || s.percentBp <= 0) return null
    const discount = roundP((grossAtBase * s.percentBp) / 10000)
    return {
      schemeId: s.id,
      kind: 'percent',
      label: `${s.percentBp / 100}% off ${s.minQtyMilli / 1000}+`,
      billedQtyMilli: qtyMilli,
      freeQtyMilli: 0,
      ratePaise: baseRatePaise,
      discountPaise: discount,
      savedPaise: discount
    }
  }

  if (s.kind === 'rate') {
    if (s.ratePaise == null || s.ratePaise >= baseRatePaise) return null
    const grossAtScheme = roundP((qtyMilli * s.ratePaise) / 1000)
    return {
      schemeId: s.id,
      kind: 'rate',
      label: `slab rate at ${s.minQtyMilli / 1000}+`,
      billedQtyMilli: qtyMilli,
      freeQtyMilli: 0,
      ratePaise: s.ratePaise,
      discountPaise: 0,
      savedPaise: grossAtBase - grossAtScheme
    }
  }

  // free: whole multiples only. Buying fifteen on a "ten gets one" earns one, not one and a half —
  // a shop cannot hand over half a bottle, and rounding up gives away stock nobody authorised.
  if (s.freeQtyMilli == null || s.freeQtyMilli <= 0) return null
  const sets = Math.floor(qtyMilli / s.minQtyMilli)
  const free = sets * s.freeQtyMilli
  if (free === 0) return null
  const discount = roundP((free * baseRatePaise) / 1000)
  return {
    schemeId: s.id,
    kind: 'free',
    label: `${s.minQtyMilli / 1000} + ${s.freeQtyMilli / 1000} free`,
    billedQtyMilli: qtyMilli + free,
    freeQtyMilli: free,
    ratePaise: baseRatePaise,
    discountPaise: discount,
    savedPaise: discount
  }
}
