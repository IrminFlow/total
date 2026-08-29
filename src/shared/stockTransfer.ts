/**
 * Moving stock between godowns (roadmap #112).
 *
 * A transfer is not a purchase and not a sale: the same quantity leaves one godown and arrives in
 * another, nothing is bought, nothing is sold, and no money moves. Modelled as a stock journal
 * carrying an out line and an in line per item — same item, same quantity, same value — so
 * per-godown stock changes and company-wide stock does not.
 *
 * The value on both lines is handed in by the caller as `costPaise`: the book cost of taking that
 * quantity out, asked of the valuation engine. Deriving it from a rate here instead would let the
 * pair drift by the rounding difference between the two lines, and a voucher that quietly creates
 * or destroys a rupee of stock value is worse than one that refuses to save.
 *
 * Pure: no Electron, no DB. Quantities are integer thousandths, values integer paise.
 */

export interface TransferItem {
  stockItemId: number
  /** Integer thousandths. Must be positive and within what the source godown holds. */
  qtyMilli: number
}

/** What the books know about one item being moved, as of the transfer date. */
export interface TransferItemFacts {
  name: string
  unitSymbol: string
  decimals: number
  /** Closing quantity in the SOURCE godown. */
  availableQtyMilli: number
  /** Book cost, in paise, of moving exactly the requested quantity out. */
  costPaise: number
}

export interface TransferPlanInput {
  fromGodownId: number
  toGodownId: number
  items: TransferItem[]
}

/** One inventory line of the resulting stock journal, shaped for `inventoryLineSchema`. */
export interface PlannedTransferLine {
  stockItemId: number
  godownId: number
  qtyMilli: number
  ratePaise: number
  amount: number
  direction: 'in' | 'out'
}

export interface TransferPlan {
  /** Out then in, per item, in the order the items were given. Empty when `errors` is not. */
  lines: PlannedTransferLine[]
  /** Total value on the move — informational; it leaves and arrives, so the books are unchanged. */
  totalValue: number
  /** Every problem found, not just the first: a form that reports one error per attempt is a form
   *  people fight three times before it saves. */
  errors: string[]
}

const fmtQty = (qtyMilli: number, decimals: number, unitSymbol: string): string =>
  `${(qtyMilli / 1000).toFixed(decimals)} ${unitSymbol}`

/**
 * Turn a requested move into the inventory lines that record it, or into the reasons it cannot
 * happen. The guard that matters is the last one: a godown cannot send out more than it holds,
 * because unlike company-wide negative stock (which is usually a missing purchase entry someone
 * will key in later) a negative godown is always a mistake about where things physically are.
 */
export function planTransfer(
  input: TransferPlanInput,
  facts: Map<number, TransferItemFacts>
): TransferPlan {
  const errors: string[] = []
  if (input.fromGodownId === input.toGodownId) errors.push('Stock has to move to a different godown')
  if (input.items.length === 0) errors.push('Nothing to move — add at least one item')

  const seen = new Set<number>()
  const lines: PlannedTransferLine[] = []
  let totalValue = 0

  for (const item of input.items) {
    const f = facts.get(item.stockItemId)
    if (!f) {
      errors.push(`Item ${item.stockItemId} does not exist`)
      continue
    }
    if (seen.has(item.stockItemId)) {
      // Two rows for one item would each be checked against the full available quantity and
      // together overdraw the godown. Ask for one row rather than silently summing them.
      errors.push(`${f.name} is on the transfer twice — put the whole quantity on one line`)
      continue
    }
    seen.add(item.stockItemId)

    if (item.qtyMilli <= 0) {
      errors.push(`${f.name}: quantity to move must be more than zero`)
      continue
    }
    if (item.qtyMilli > f.availableQtyMilli) {
      errors.push(
        `${f.name}: only ${fmtQty(Math.max(0, f.availableQtyMilli), f.decimals, f.unitSymbol)} in the source godown, ` +
          `cannot move ${fmtQty(item.qtyMilli, f.decimals, f.unitSymbol)}`
      )
      continue
    }

    // Rate is display only; `amount` is the engine's cost, so the two lines cancel to the paisa.
    const ratePaise = Math.round((f.costPaise * 1000) / item.qtyMilli)
    lines.push({
      stockItemId: item.stockItemId,
      godownId: input.fromGodownId,
      qtyMilli: item.qtyMilli,
      ratePaise,
      amount: f.costPaise,
      direction: 'out'
    })
    lines.push({
      stockItemId: item.stockItemId,
      godownId: input.toGodownId,
      qtyMilli: item.qtyMilli,
      ratePaise,
      amount: f.costPaise,
      direction: 'in'
    })
    totalValue += f.costPaise
  }

  return { lines: errors.length > 0 ? [] : lines, totalValue: errors.length > 0 ? 0 : totalValue, errors }
}
