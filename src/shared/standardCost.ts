/**
 * Standard costing and variance against actual (roadmap E #118).
 *
 * A standard cost is what a unit is SUPPOSED to cost. The books record what it actually cost. The
 * gap between them is the only number in a manufacturing account that says anything about how the
 * month went, and it is worth almost nothing as one figure — "we are ₹1,40,000 over" is a fact
 * nobody can act on. Split into its two causes it becomes a decision:
 *
 *   price variance   = (actual rate − standard rate) × actual quantity     — the buyer's number
 *   usage variance   = (actual qty  − standard qty ) × standard rate       — the floor's number
 *
 * The split is not arbitrary: costing them in this order (price at actual quantity, usage at
 * standard rate) is the conventional decomposition, and it matters that the two are computed
 * against different bases, because that is what makes them add up to the total variance exactly
 * rather than leaving a joint variance nobody owns.
 *
 *   total = actual cost − standard cost of the actual output
 *         = (Qa × Ra) − (Qs × Rs)
 *         = price + usage, identically.
 *
 * A standard is dated data, like every rate in this app (see `statutory.ts`). A standard revised
 * in October must not change what September's variance report said in October — a variance report
 * that rewrites itself is one nobody can be held to.
 */

/** Signed BigInt division rounded half away from zero. Same rule as the rest of the app. */
function divRound(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n
  const n = numerator < 0n ? -numerator : numerator
  const d = denominator < 0n ? -denominator : denominator
  const q = (2n * n + d) / (2n * d)
  return negative ? -q : q
}

/** Cost of `qtyMilli` thousandths at `ratePaise` per whole unit, in integer paise. */
export function extendCost(qtyMilli: number, ratePaise: number): number {
  // BigInt because a lakh units at a lakh rupees is 10^16 milli-paise, past a double's integers.
  return Number(divRound(BigInt(qtyMilli) * BigInt(ratePaise), 1000n))
}

export interface StandardCostRow {
  /** ISO date the standard came into force. */
  effectiveFrom: string
  /** Paise per whole unit. */
  standardCost: number
}

/**
 * The standard in force on `date` — the row with the latest `effectiveFrom` on or before it, or
 * null when the item had no standard yet.
 *
 * Deliberately the same shape as every other dated lookup in the engine. The alternative, a single
 * `standard_cost` column on the item, answers "what is the standard" and cannot answer "what was
 * the standard when this was made", which is the only question a variance report asks.
 */
export function standardCostOn(rows: readonly StandardCostRow[], date: string): number | null {
  let best: StandardCostRow | null = null
  for (const row of rows) {
    if (row.effectiveFrom > date) continue
    if (!best || row.effectiveFrom > best.effectiveFrom) best = row
  }
  return best ? best.standardCost : null
}

export interface VarianceInput {
  /** What actually moved, thousandths. */
  actualQtyMilli: number
  /** What it actually cost, integer paise for the whole quantity — not a rate. */
  actualCostPaise: number
  /** The standard rate in force on the date, paise per whole unit. */
  standardRatePaise: number
  /**
   * What the standard says this output SHOULD have consumed, thousandths. For a purchase or a
   * plain issue this is the actual quantity, which makes the usage variance nil by construction —
   * there is no yardstick to be over or under. For a manufacture it is the BOM quantity for the
   * units produced, which is where a usage variance actually comes from.
   */
  standardQtyMilli?: number
}

export interface Variance {
  /** Qa × Ra, from the books. */
  actualCostPaise: number
  /** Qs × Rs — what the output should have cost. */
  standardCostPaise: number
  /** (Ra − Rs) × Qa. Positive = paid more than standard = adverse. */
  priceVariancePaise: number
  /** (Qa − Qs) × Rs. Positive = used more than standard = adverse. */
  usageVariancePaise: number
  /** actual − standard. Equals price + usage, exactly. */
  totalVariancePaise: number
  /** How an accountant says the sign: under standard is favourable. */
  verdict: 'favourable' | 'adverse' | 'on standard'
}

/**
 * Decompose one line's variance.
 *
 * The actual RATE is never taken as an input, only the actual cost and quantity. A rate handed in
 * would already have been rounded by whoever divided, and the rounding would then be multiplied
 * back up by the quantity — so the price variance would disagree with the books by a few paise on
 * every line and by real money over a month. Instead the price variance is computed as
 * `actual cost − (Qa × Rs)`, which is algebraically the same thing and rounds exactly once.
 */
export function varianceOf(input: VarianceInput): Variance {
  const standardQtyMilli = input.standardQtyMilli ?? input.actualQtyMilli
  const actualAtStandard = extendCost(input.actualQtyMilli, input.standardRatePaise)
  const standardCostPaise = extendCost(standardQtyMilli, input.standardRatePaise)
  const priceVariancePaise = input.actualCostPaise - actualAtStandard
  const usageVariancePaise = actualAtStandard - standardCostPaise
  const totalVariancePaise = input.actualCostPaise - standardCostPaise
  return {
    actualCostPaise: input.actualCostPaise,
    standardCostPaise,
    priceVariancePaise,
    usageVariancePaise,
    totalVariancePaise,
    verdict: totalVariancePaise === 0 ? 'on standard' : totalVariancePaise > 0 ? 'adverse' : 'favourable'
  }
}

export interface VarianceLine extends Variance {
  stockItemId: number
  name: string
  actualQtyMilli: number
  standardQtyMilli: number
  standardRatePaise: number
}

export interface VarianceSummary {
  lines: VarianceLine[]
  actualCostPaise: number
  standardCostPaise: number
  priceVariancePaise: number
  usageVariancePaise: number
  totalVariancePaise: number
  /** Items that moved in the period but have no standard on the date — listed, never assumed to
   *  be on standard. A blank in a variance report is a question; a zero is an answer. */
  withoutStandard: { stockItemId: number; name: string; actualCostPaise: number }[]
}

/** Add the lines up. Integer addition, so the total is the sum of what is on screen. */
export function summariseVariance(
  lines: VarianceLine[],
  withoutStandard: VarianceSummary['withoutStandard'] = []
): VarianceSummary {
  const sum = (pick: (l: VarianceLine) => number): number => lines.reduce((t, l) => t + pick(l), 0)
  return {
    lines,
    actualCostPaise: sum((l) => l.actualCostPaise),
    standardCostPaise: sum((l) => l.standardCostPaise),
    priceVariancePaise: sum((l) => l.priceVariancePaise),
    usageVariancePaise: sum((l) => l.usageVariancePaise),
    totalVariancePaise: sum((l) => l.totalVariancePaise),
    withoutStandard
  }
}

/** Percent of standard, in hundredths of a percent, for the "how bad" column. Null when there is
 *  no standard cost to be a percentage of — a division by zero is not 0%. */
export function varianceBp(v: Pick<Variance, 'totalVariancePaise' | 'standardCostPaise'>): number | null {
  if (v.standardCostPaise === 0) return null
  return Number(divRound(BigInt(v.totalVariancePaise) * 10_000n, BigInt(v.standardCostPaise)))
}
