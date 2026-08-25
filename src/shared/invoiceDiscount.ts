/**
 * Invoice-level discount (roadmap I-203).
 *
 * A line discount is already modelled (`inventory_lines.discount_paise`), and the load-bearing
 * invariant there is that a line's `amount` IS its post-discount taxable value — GST is derived
 * from `amount` alone, so a discount can never change tax by accident. An invoice-level discount
 * has to preserve that same invariant, and there is only one honest way to do it: apportion the
 * whole-bill discount back down onto the lines and let the existing machinery run untouched.
 *
 * That is not a shortcut, it is the law. Section 15(3)(a) of the CGST Act allows a discount to be
 * excluded from the transaction value only where it is "given before or at the time of supply and
 * duly recorded in the invoice". A trailing "less 2%" that sits below the tax total is therefore
 * NOT excludable — tax would still be due on the gross — whereas the same 2% spread across the
 * lines above the tax lines is. Apportioning is what makes the discount legal; carrying it as a
 * separate deduction after tax would quietly overstate the credit the customer can take.
 * (Checked against section 15(3)(a) CGST Act, 2026-08.)
 *
 * Pure integer arithmetic. Money is paise; nothing here may produce a fraction of one.
 */

/** Anything this module refuses, with a message meant to be shown to a person. */
export class InvoiceDiscountError extends Error {}

/**
 * Split `discountPaise` across lines in proportion to their value, exactly.
 *
 * Largest-remainder allocation: give each line the floor of its exact share, then hand the
 * leftover paise out one at a time to the lines with the largest discarded fractions. Rounding
 * each share independently would leave the parts disagreeing with the whole by a few paise, and
 * an invoice whose discount column does not add up to the discount the customer was promised is
 * an invoice that gets argued about.
 *
 * Ties in the remainder are broken by line order, so the same invoice always apportions the same
 * way — a discount that moved a paisa between two lines on re-save would show as an amendment.
 *
 * Zero-value lines receive nothing: a line worth nothing cannot bear a share of a proportional
 * discount, and giving it one would produce a negative taxable value.
 */
export function apportionDiscount(lineAmountsPaise: number[], discountPaise: number): number[] {
  if (!Number.isInteger(discountPaise)) {
    throw new InvoiceDiscountError('Discount must be a whole number of paise')
  }
  if (discountPaise < 0) throw new InvoiceDiscountError('Discount cannot be negative')
  if (lineAmountsPaise.some((a) => !Number.isInteger(a))) {
    throw new InvoiceDiscountError('Line amounts must be whole paise')
  }
  if (lineAmountsPaise.some((a) => a < 0)) {
    throw new InvoiceDiscountError('Line amounts cannot be negative')
  }

  const total = lineAmountsPaise.reduce((s, a) => s + a, 0)
  if (discountPaise === 0) return lineAmountsPaise.map(() => 0)
  if (total === 0) {
    throw new InvoiceDiscountError('Nothing to discount — every line is zero')
  }
  if (discountPaise > total) {
    throw new InvoiceDiscountError('Discount is larger than the value of the invoice')
  }

  const shares = lineAmountsPaise.map((amount, index) => {
    const exact = amount * discountPaise
    return { index, amount, base: Math.floor(exact / total), remainder: exact % total }
  })
  let leftover = discountPaise - shares.reduce((s, x) => s + x.base, 0)

  // Only lines that carry value are eligible for a leftover paisa, for the same reason they get
  // no base share: a zero line cannot absorb a discount.
  const eligible = shares
    .filter((x) => x.amount > 0)
    .sort((a, b) => (b.remainder === a.remainder ? a.index - b.index : b.remainder - a.remainder))

  for (const share of eligible) {
    if (leftover <= 0) break
    share.base += 1
    leftover -= 1
  }

  const out = shares.slice().sort((a, b) => a.index - b.index).map((x) => x.base)
  return out
}

/**
 * A percentage discount as a whole number of paise.
 *
 * Percent is a rate, not money, so it may legitimately be fractional (2.5%); the RESULT never is.
 * Rounded half-up on the paise, which is the convention the rest of the app rounds tax with.
 */
export function discountFromPercent(totalPaise: number, percent: number): number {
  if (percent < 0) throw new InvoiceDiscountError('Discount percentage cannot be negative')
  if (percent > 100) throw new InvoiceDiscountError('Discount cannot exceed 100%')
  return Math.round((totalPaise * percent) / 100)
}

export interface InvoiceDiscountLine {
  /** Value of the line before any invoice-level discount, in paise. */
  amountPaise: number
  /** Discount already recorded on the line itself, in paise. Untouched by the apportionment. */
  lineDiscountPaise: number
}

export interface AppliedInvoiceDiscount {
  /** Per line: the invoice-level share, and what the line's discount becomes once it is folded in. */
  lines: { apportionedPaise: number; totalDiscountPaise: number; amountPaise: number }[]
  /** Sum of the apportioned shares. Equals the requested discount, by construction. */
  discountPaise: number
}

/**
 * Fold an invoice-level discount into the per-line discounts.
 *
 * The apportionment is done on the POST-line-discount value of each line, because that is the
 * amount the customer is actually being billed and therefore the base the "less 2% on the bill"
 * conversation is about. Applying it to the pre-discount value would give a bigger absolute
 * reduction than the number printed on the invoice.
 */
export function applyInvoiceDiscount(
  lines: InvoiceDiscountLine[],
  discountPaise: number
): AppliedInvoiceDiscount {
  const bases = lines.map((l) => l.amountPaise)
  const shares = apportionDiscount(bases, discountPaise)
  return {
    discountPaise: shares.reduce((s, x) => s + x, 0),
    lines: lines.map((l, i) => ({
      apportionedPaise: shares[i]!,
      totalDiscountPaise: l.lineDiscountPaise + shares[i]!,
      amountPaise: l.amountPaise - shares[i]!
    }))
  }
}
