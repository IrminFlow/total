// TDS in voucher entry (WP 3.1): the deduction as both entry modes hold it, and the pure
// line arithmetic of "Apply TDS" in accounting mode. Invoice mode's builder (invoice.ts) does
// its own line layout from the same state.

/** An applied TDS deduction in an entry form. */
export interface TdsDeductionState {
  sectionId: number
  baseAmount: number
  tdsAmount: number
  /** Typed rather than taken from the rate table (saveVoucher skips the rate x base check). */
  isManual: boolean
  /** The section's tagged payable ledger, when it exists. */
  payableLedgerId: number | null
  /** The payable credit is NOT in the form's lines — its ledger doesn't exist yet, and
   *  saveVoucher creates it and appends the credit (tds.autoPayable). */
  pending: boolean
}

export interface TdsApplyRow {
  drCr: 'dr' | 'cr'
  ledgerId: number | null
  amount: number | null
}

/**
 * Apply (or re-apply) a deduction to accounting-mode rows: the target row (the vendor's own
 * credit in the journal shape, or the bank/cash credit in the payment shape — chosen by the
 * caller) gives up `tdsAmount`, and the payable ledger is credited by it. Re-applying adjusts
 * the existing payable credit (or the pending one) by the difference instead of adding another.
 * With no payable ledger yet the credit stays pending (not in the rows). Returns new rows; the
 * caller keeps its own trailing blank row (the payable row is inserted before it).
 */
export function applyTdsToAccountingRows<R extends TdsApplyRow>(
  rows: readonly R[],
  opts: {
    targetIdx: number
    tdsAmount: number
    payableLedgerId: number | null
    previous: TdsDeductionState | null
    makeRow: (ledgerId: number, amount: number) => R
    /** 'reduce' (TDS: the target gives up the deduction) or 'increase' (TCS on a receipt, WP 3.3:
     *  the bank / cash debit grows by the TCS collected on top of the consideration). */
    direction?: 'reduce' | 'increase'
  }
): R[] {
  const next = rows.map((r) => ({ ...r }))
  const { targetIdx, tdsAmount, payableLedgerId, previous } = opts
  const sign = opts.direction === 'increase' ? -1 : 1
  if (targetIdx < 0 || targetIdx >= next.length) return next
  const reduceTarget = (by: number): void => {
    next[targetIdx] = { ...next[targetIdx]!, amount: (next[targetIdx]!.amount ?? 0) - sign * by }
  }
  const insertPayable = (ledgerId: number, amount: number): R[] => {
    const insertAt = next.length > 0 && next[next.length - 1]!.ledgerId == null ? next.length - 1 : next.length
    return [...next.slice(0, insertAt), opts.makeRow(ledgerId, amount), ...next.slice(insertAt)]
  }

  if (previous && !previous.pending && previous.payableLedgerId != null) {
    const existingIdx = next.findIndex((r) => r.drCr === 'cr' && r.ledgerId === previous.payableLedgerId)
    if (existingIdx !== -1) {
      const delta = tdsAmount - (next[existingIdx]!.amount ?? 0)
      next[existingIdx] = { ...next[existingIdx]!, amount: tdsAmount }
      reduceTarget(delta)
      return next
    }
  }
  if (previous && previous.pending) {
    reduceTarget(tdsAmount - previous.tdsAmount)
    // The ledger appeared since (e.g. created from another window): materialise the credit.
    return payableLedgerId != null ? insertPayable(payableLedgerId, tdsAmount) : next
  }
  reduceTarget(tdsAmount)
  return payableLedgerId != null ? insertPayable(payableLedgerId, tdsAmount) : next
}

/** How much of the target row a prior Apply already carved out (it equals the current payable
 *  credit — in the rows, or pending). */
export function appliedTdsAmount(rows: readonly TdsApplyRow[], tds: TdsDeductionState | null): number {
  if (!tds) return 0
  if (tds.pending) return tds.tdsAmount
  if (tds.payableLedgerId == null) return 0
  return rows.find((r) => r.drCr === 'cr' && r.ledgerId === tds.payableLedgerId)?.amount ?? 0
}

/** Rebuild the form-side deduction of a saved voucher: the payable credit is the credit row on a
 *  ledger tagged for the section, else (legacy, untagged) the non-party credit of exactly the
 *  deducted amount. */
export function tdsStateFromSaved(
  tds: { sectionId: number; baseAmount: number; tdsAmount: number; isManual?: boolean },
  rows: readonly TdsApplyRow[],
  partyLedgerId: number | null,
  payableSectionOf: (ledgerId: number) => number | null | undefined
): TdsDeductionState {
  const tagged = rows.find((r) => r.drCr === 'cr' && r.ledgerId != null && payableSectionOf(r.ledgerId) === tds.sectionId)
  const byAmount = rows.find((r) => r.drCr === 'cr' && r.ledgerId != null && r.ledgerId !== partyLedgerId && r.amount === tds.tdsAmount)
  return {
    sectionId: tds.sectionId,
    baseAmount: tds.baseAmount,
    tdsAmount: tds.tdsAmount,
    isManual: !!tds.isManual,
    payableLedgerId: (tagged ?? byAmount)?.ledgerId ?? null,
    pending: false
  }
}
