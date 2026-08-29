/**
 * The arithmetic behind counter mode (roadmap #376, #377, #381, #382, #384).
 *
 * A counter is not a voucher form. The person typing has a customer in front of them, the price
 * on the shelf label is usually the price the customer pays (tax already inside it), and the
 * whole sale has to end in a tender, a change figure and a printed slip in a few seconds.
 *
 * Everything here is pure integer arithmetic so it can be tested exhaustively — the two places a
 * till goes wrong in practice are the tax back-out on an inclusive price and the change figure,
 * and both are one rounding decision each.
 */
import { computeGst, type GstBreakup, type SupplyType } from './gst/calc'
import { roundPaise, roundToRupee } from './money'

/** How the rate typed at the counter should be read. */
export type PricingMode = 'exclusive' | 'inclusive'

export interface CartLineInput {
  stockItemId: number
  name: string
  code: string | null
  /** Integer thousandths. Includes any free quantity from a scheme — see `scheme.ts`. */
  qtyMilli: number
  /** Per base unit, in paise. Read per `pricingMode`. */
  ratePaise: number
  gstRate: number
  cessRate?: number
  /** Trade/scheme discount on the line, in paise, off the gross. */
  discountPaise?: number
  /**
   * Cost of one base unit, for the below-cost warning (#382). Null when the item has never been
   * bought, which is not the same as a cost of zero — an item with no purchase history cannot be
   * sold below a cost nobody knows.
   */
  costPaise?: number | null
}

export interface CartLine extends CartLineInput {
  /** Gross before discount: qty × rate, at the pricing mode's face value. */
  grossPaise: number
  /** GST-exclusive value of the line after discount — the taxable value on the return. */
  taxablePaise: number
  gst: GstBreakup
  /** What the customer pays for this line, tax included. */
  totalPaise: number
  /** True when the taxable value is under what the stock cost. */
  belowCost: boolean
  /** How far under cost, in paise. Zero unless `belowCost`. */
  belowCostBy: number
}

export interface CartTotals {
  lines: CartLine[]
  /** Sum of line gross, before discounts. */
  grossPaise: number
  discountPaise: number
  gst: GstBreakup
  /** Tax-inclusive total before the round-off line. */
  netPaise: number
  /** Net rounded to the nearest rupee — what is actually asked for. */
  payablePaise: number
  /** payable − net. Positive means the customer pays up; negative, down. */
  roundOffPaise: number
  /** Taxable value grouped by rate, which is how the tax lines are posted. */
  byRate: { gstRate: number; cessRate: number; taxable: number; gst: GstBreakup }[]
  belowCostLines: number
}

/**
 * One line's money.
 *
 * On an inclusive price the tax is backed OUT of the gross rather than added to it (Rule 35):
 * taxable = gross × 100 / (100 + rate), and the tax is the exact residue. Adding tax on top of an
 * MRP and then discounting to reach it is how a shop ends up remitting tax on a number the
 * customer never paid.
 */
export function priceLine(input: CartLineInput, supply: SupplyType, mode: PricingMode): CartLine {
  const cess = input.cessRate ?? 0
  const discount = input.discountPaise ?? 0
  const gross = roundPaise((input.qtyMilli * input.ratePaise) / 1000)
  const afterDiscount = Math.max(0, gross - discount)

  let taxable: number
  let gst: GstBreakup
  if (mode === 'inclusive') {
    // The cess sits inside the price too, so the divisor is rate + cess, not rate alone.
    taxable = roundPaise((afterDiscount * 100) / (100 + input.gstRate + cess))
    gst = computeGst(taxable, input.gstRate, supply, cess)
    // Recomputing tax on the backed-out base can miss the gross by a paisa. The customer pays
    // the shelf price, so the residue goes to the tax rather than the price moving.
    const drift = afterDiscount - gst.total
    if (drift !== 0) gst = absorbDrift(gst, drift, supply)
  } else {
    taxable = afterDiscount
    gst = computeGst(taxable, input.gstRate, supply, cess)
  }

  const cost = input.costPaise == null ? null : roundPaise((input.qtyMilli * input.costPaise) / 1000)
  const belowCostBy = cost != null && taxable < cost ? cost - taxable : 0

  return {
    ...input,
    cessRate: cess,
    discountPaise: discount,
    grossPaise: gross,
    taxablePaise: taxable,
    gst,
    totalPaise: gst.total,
    belowCost: belowCostBy > 0,
    belowCostBy
  }
}

/** Put a paisa of inclusive-price drift on the tax rather than on the price. */
function absorbDrift(gst: GstBreakup, drift: number, supply: SupplyType): GstBreakup {
  if (supply === 'inter') return { ...gst, igst: gst.igst + drift, total: gst.total + drift }
  // Intra-state: SGST takes it, so CGST stays the clean half and the pair still sums to the tax.
  return { ...gst, sgst: gst.sgst + drift, total: gst.total + drift }
}

const ZERO_GST: GstBreakup = { taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, total: 0 }

const addGst = (a: GstBreakup, b: GstBreakup): GstBreakup => ({
  taxable: a.taxable + b.taxable,
  cgst: a.cgst + b.cgst,
  sgst: a.sgst + b.sgst,
  igst: a.igst + b.igst,
  cess: a.cess + b.cess,
  total: a.total + b.total
})

/** Price a whole cart, grouped by tax rate the way the voucher will be posted. */
export function priceCart(inputs: CartLineInput[], supply: SupplyType, mode: PricingMode): CartTotals {
  const lines = inputs.map((l) => priceLine(l, supply, mode))
  const gst = lines.reduce((a, l) => addGst(a, l.gst), ZERO_GST)
  const net = gst.total
  const payable = roundToRupee(net)

  const bands = new Map<string, { gstRate: number; cessRate: number; taxable: number; gst: GstBreakup }>()
  for (const l of lines) {
    const key = `${l.gstRate}|${l.cessRate ?? 0}`
    const band = bands.get(key) ?? { gstRate: l.gstRate, cessRate: l.cessRate ?? 0, taxable: 0, gst: ZERO_GST }
    band.taxable += l.taxablePaise
    band.gst = addGst(band.gst, l.gst)
    bands.set(key, band)
  }

  return {
    lines,
    grossPaise: lines.reduce((s, l) => s + l.grossPaise, 0),
    discountPaise: lines.reduce((s, l) => s + (l.discountPaise ?? 0), 0),
    gst,
    netPaise: net,
    payablePaise: payable,
    roundOffPaise: payable - net,
    byRate: [...bands.values()].sort((a, b) => a.gstRate - b.gstRate),
    belowCostLines: lines.filter((l) => l.belowCost).length
  }
}

// ---------- tender and change (#376) ----------

export type TenderMode = 'cash' | 'card' | 'upi' | 'credit'

export interface Tender {
  mode: TenderMode
  amountPaise: number
}

export interface TenderResult {
  tenderedPaise: number
  /** What the customer gets back. Only cash can give change. */
  changePaise: number
  /** Still owed. Positive means the sale cannot be closed as paid. */
  shortPaise: number
  /** Cash that actually stays in the drawer: cash tendered less change handed back. */
  cashInDrawerPaise: number
  /** Taken on credit — the part that becomes a receivable rather than money. */
  creditPaise: number
}

/**
 * What the tender adds up to.
 *
 * Change comes out of cash only. A customer who overpays by card is refunded to the card, not
 * from the till, and letting the drawer settle a card overpayment is how a drawer goes short by
 * exactly the amount nobody can explain at closing.
 */
export function settleTender(payablePaise: number, tenders: Tender[]): TenderResult {
  const cash = tenders.filter((t) => t.mode === 'cash').reduce((s, t) => s + t.amountPaise, 0)
  const credit = tenders.filter((t) => t.mode === 'credit').reduce((s, t) => s + t.amountPaise, 0)
  const tendered = tenders.reduce((s, t) => s + t.amountPaise, 0)
  const over = tendered - payablePaise
  const change = Math.max(0, Math.min(over, cash))
  return {
    tenderedPaise: tendered,
    changePaise: change,
    shortPaise: Math.max(0, -over),
    cashInDrawerPaise: cash - change,
    creditPaise: credit
  }
}

/** Notes and coins a cashier can hand back, biggest first. Purely a display aid. */
export const CASH_DENOMINATIONS = [50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50, 20, 10]

export function changeBreakdown(changePaise: number): { denomination: number; count: number }[] {
  let left = changePaise
  const out: { denomination: number; count: number }[] = []
  for (const d of CASH_DENOMINATIONS) {
    const count = Math.floor(left / d)
    if (count > 0) {
      out.push({ denomination: d, count })
      left -= count * d
    }
  }
  return out
}

// ---------- the drawer (#377) ----------

export interface DrawerMovements {
  /** Opening float the owner put in. */
  openingFloatPaise: number
  /** Cash that stayed in the drawer from sales. */
  cashSalesPaise: number
  /** Cash handed back on returns at the counter (#384). */
  cashRefundsPaise: number
  /** Cash taken out mid-shift — a bank drop, a payment to a supplier at the door. */
  payoutsPaise: number
  /** Cash put in mid-shift beyond the opening float. */
  payinsPaise: number
}

export interface DrawerReconciliation extends DrawerMovements {
  expectedPaise: number
  countedPaise: number | null
  /** counted − expected. Negative is short, which is the case that matters. */
  variancePaise: number
  status: 'open' | 'balanced' | 'short' | 'over'
}

/**
 * What should be in the drawer, against what was counted.
 *
 * The variance is signed and never absolute: a till that is over is a different problem from a
 * till that is short (usually a sale rung up and not tendered, versus money gone), and collapsing
 * them into a magnitude loses the only fact the owner wants.
 */
export function reconcileDrawer(m: DrawerMovements, countedPaise: number | null): DrawerReconciliation {
  const expected = m.openingFloatPaise + m.cashSalesPaise + m.payinsPaise - m.cashRefundsPaise - m.payoutsPaise
  const variance = countedPaise === null ? 0 : countedPaise - expected
  return {
    ...m,
    expectedPaise: expected,
    countedPaise,
    variancePaise: variance,
    status: countedPaise === null ? 'open' : variance === 0 ? 'balanced' : variance < 0 ? 'short' : 'over'
  }
}

/** Count a drawer from what is physically in it. */
export function countDenominations(counts: { denomination: number; count: number }[]): number {
  return counts.reduce((s, c) => s + c.denomination * c.count, 0)
}
