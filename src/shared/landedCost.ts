/**
 * Landed cost allocation across a purchase (roadmap #117).
 *
 * Freight, insurance, customs duty and clearing charges paid to get goods to the door are part of
 * what those goods cost. Left in an expense ledger they make closing stock too low and gross
 * margin too high — the item looks cheaper than it was, and every pricing decision taken off that
 * number is wrong in the same direction.
 *
 * This module only splits the money. It does not post anything: the expense is already on the
 * purchase voucher as an ordinary ledger line, and what is recorded here is the instruction to
 * carry it into the value of the goods.
 *
 * Pure: no Electron, no DB. Amounts are integer paise, quantities integer thousandths.
 */
import { allocateAdditionalCost } from './valuation'

/**
 * How a cost is shared out.
 *
 * `value` suits anything charged as a percentage of what the goods are worth — insurance, customs
 * duty, an agent's commission. `qty` suits anything charged by how much space or weight moved —
 * freight, handling, palletising. Getting this wrong is not a rounding difference: a light
 * expensive item and a heavy cheap one on the same lorry take opposite shares under the two.
 */
export type LandedCostBasis = 'value' | 'qty'

export const LANDED_COST_BASES: { basis: LandedCostBasis; label: string; hint: string }[] = [
  { basis: 'value', label: 'By value', hint: 'Insurance, duty, commission — anything charged on what the goods are worth' },
  { basis: 'qty', label: 'By quantity', hint: 'Freight, handling — anything charged on how much moved' }
]

export interface LandedCost {
  /** What the charge is called on the bill, e.g. "Freight inward". */
  label: string
  /** Paise. Always positive — a negative landed cost is a credit note, not an allocation. */
  amount: number
  basis: LandedCostBasis
}

/** One item line of the purchase the cost is being spread over. */
export interface CostedLine {
  /** inventory_lines.id, or any caller-side identifier. */
  id: number
  qtyMilli: number
  /** The line's own value before landed costs, in paise. */
  amount: number
}

export interface AllocatedLine extends CostedLine {
  /** This line's share of every landed cost, in paise. */
  extra: number
  /** amount + extra — what the goods actually cost. */
  effectiveAmount: number
  /** effectiveAmount per whole unit, paise. Zero for a zero-quantity line. */
  effectiveRatePaise: number
}

export interface LandedCostAllocation {
  lines: AllocatedLine[]
  /** Total landed cost handed in. */
  total: number
  /**
   * Paise that could not be put anywhere, because there were no item lines to put them on.
   * Reported rather than dropped: money that silently disappears from a reconciliation is the
   * one failure this cannot have.
   */
  unallocated: number
}

/**
 * Spread `costs` across `lines`, exact to the paisa.
 *
 * Each cost is allocated on its own so its basis is honoured and its own total is conserved —
 * pooling them first would average two different bases into one that is neither. Within a cost,
 * `allocateAdditionalCost` does the split with largest-remainder rounding, so the parts sum to
 * the whole and the leftover paise land in a defined place rather than wherever floating point
 * happened to leave them.
 *
 * Lines whose basis totals zero (a free sample, a zero-value line) split the cost equally, which
 * is what `allocateAdditionalCost` already does and the only answer available: with no weights
 * there is nothing to weight by.
 */
export function allocateLandedCosts(lines: CostedLine[], costs: LandedCost[]): LandedCostAllocation {
  const total = costs.reduce((s, c) => s + c.amount, 0)
  if (lines.length === 0) return { lines: [], total, unallocated: total }

  const extras = lines.map(() => 0)
  for (const cost of costs) {
    if (cost.amount === 0) continue
    const bases = lines.map((l) => (cost.basis === 'qty' ? l.qtyMilli : l.amount))
    const shares = allocateAdditionalCost(bases, cost.amount)
    shares.forEach((share, i) => {
      extras[i]! += share
    })
  }

  return {
    lines: lines.map((l, i) => {
      const extra = extras[i]!
      const effectiveAmount = l.amount + extra
      return {
        ...l,
        extra,
        effectiveAmount,
        // Rate is per whole unit and quantity is in thousandths, so the ×1000 is the unit
        // conversion rather than a scaling choice.
        effectiveRatePaise: l.qtyMilli > 0 ? Math.round((effectiveAmount * 1000) / l.qtyMilli) : 0
      }
    }),
    total,
    unallocated: 0
  }
}
