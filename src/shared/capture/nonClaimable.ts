// WP 8.0 — a bill captured by a company that can't claim GST (composition / unregistered on the
// bill's date): the GST the supplier charged is part of each line's cost (never an input-tax
// line). Pure integer paise; the model never computes it.

export interface NonClaimableLine {
  /** The line's taxable value (net of its discount). */
  taxable: number
  /** The rate the bill charges on the line, basis points (null = not printed). */
  rateBp: number | null
  /** The line's tax as printed (CGST + SGST + IGST + cess), when the bill prints it per line. */
  printedTax: number | null
}

/** Each line's cost = taxable + its tax. The tax is the line's printed tax, else taxable × rate
 *  (half-up). When the bill prints a total tax, the rounding difference against the lines goes to
 *  the line with the largest tax, so the costs add up to taxable + the printed tax exactly. */
export function nonClaimableCosts(lines: readonly NonClaimableLine[], printedTotalTax: number | null): { cost: number; tax: number }[] {
  const tax = lines.map((l) => l.printedTax ?? (l.rateBp ? Math.floor((l.taxable * l.rateBp * 2 + 10_000) / 20_000) : 0))
  if (printedTotalTax != null && printedTotalTax > 0 && lines.length > 0) {
    const diff = printedTotalTax - tax.reduce((s, t) => s + t, 0)
    // Only a rounding difference is spread (≤ ₹1 a line); a larger one is the banner's to report.
    if (diff !== 0 && Math.abs(diff) <= 100 * lines.length) {
      let at = 0
      for (let i = 1; i < tax.length; i++) if (tax[i]! > tax[at]!) at = i
      tax[at] = tax[at]! + diff
    }
  }
  return lines.map((l, i) => ({ tax: tax[i]!, cost: l.taxable + tax[i]! }))
}

/** A quantity × rate (− discount) that comes to exactly `cost`: rate rounded UP to the paisa, the
 *  remainder as a discount (always < one unit's paisa × qty). qtyMilli > 0. */
export function rateForCost(cost: number, qtyMilli: number): { ratePaise: number; discountPaise: number } {
  const ratePaise = Math.ceil((cost * 1000) / qtyMilli)
  const gross = Math.round((qtyMilli * ratePaise) / 1000)
  return { ratePaise, discountPaise: gross - cost }
}
