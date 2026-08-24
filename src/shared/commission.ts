/**
 * Salesperson commission, computed on collection (roadmap #380).
 *
 * Commission paid on billing is how a business pays twice for one sale: once to the salesperson
 * in the month the invoice was raised, and again — in working capital — when the invoice is never
 * collected. Recovering it afterwards is a conversation nobody has, so it is not recovered.
 *
 * So the earning event here is the RECEIPT, not the invoice. A bill earns commission in
 * proportion to what has been received against it, which means a part-paid bill earns part of the
 * commission and a bad debt earns none, with no adjusting entry anywhere.
 */

export type CommissionBasis = 'gross' | 'net_of_tax'

export interface CommissionRule {
  /** Basis points on the collected amount. 250 = 2.5%. */
  rateBp: number
  /**
   * Whether the rate applies to the whole receipt or to the tax-exclusive value.
   *
   * Net of tax is the honest default for a GST business: the tax collected is the government's
   * money passing through, and paying a percentage of it is paying commission on a remittance.
   */
  basis: CommissionBasis
}

export interface CollectionEvent {
  /** The receipt voucher. */
  voucherId: number
  date: string
  /** The bill the money was allocated against. */
  billNumber: string
  partyName: string
  salesperson: string
  /** Money received and allocated to this bill, in paise. */
  collectedPaise: number
  /** The invoice's total, in paise — the denominator for the tax-exclusive proportion. */
  invoiceTotalPaise: number
  /** The invoice's taxable value, in paise. */
  invoiceTaxablePaise: number
}

export interface CommissionRow extends CollectionEvent {
  /** The amount the rate was applied to. */
  basePaise: number
  commissionPaise: number
}

export interface CommissionStatement {
  salesperson: string
  rows: CommissionRow[]
  collectedPaise: number
  basePaise: number
  commissionPaise: number
}

/**
 * The tax-exclusive share of a part collection.
 *
 * A customer who pays half a bill has paid half the goods and half the tax — there is no rule
 * that says the first rupees received are the tax. So the base is pro-rated by the invoice's own
 * taxable-to-total ratio rather than by subtracting the whole tax from the receipt, which would
 * make a small part-payment earn no commission at all and a large one earn too much.
 */
export function commissionBase(event: CollectionEvent, basis: CommissionBasis): number {
  if (basis === 'gross') return event.collectedPaise
  if (event.invoiceTotalPaise <= 0) return event.collectedPaise
  return Math.round((event.collectedPaise * event.invoiceTaxablePaise) / event.invoiceTotalPaise)
}

export function commissionOn(event: CollectionEvent, rule: CommissionRule): CommissionRow {
  const base = commissionBase(event, rule.basis)
  return {
    ...event,
    basePaise: base,
    commissionPaise: Math.round((base * rule.rateBp) / 10000)
  }
}

/** Group a period's collections into one statement per salesperson. */
export function commissionStatements(
  events: CollectionEvent[],
  ruleFor: (salesperson: string) => CommissionRule | null
): CommissionStatement[] {
  const byPerson = new Map<string, CommissionRow[]>()
  for (const e of events) {
    const rule = ruleFor(e.salesperson)
    // No rate means no scheme for this person, which is not the same as a zero rate. Their
    // collections are simply not a commission statement, so they get no row at all.
    if (!rule || rule.rateBp <= 0) continue
    const list = byPerson.get(e.salesperson) ?? []
    list.push(commissionOn(e, rule))
    byPerson.set(e.salesperson, list)
  }
  return [...byPerson.entries()]
    .map(([salesperson, rows]) => ({
      salesperson,
      rows: rows.sort((a, b) => a.date.localeCompare(b.date) || a.billNumber.localeCompare(b.billNumber)),
      collectedPaise: rows.reduce((s, r) => s + r.collectedPaise, 0),
      basePaise: rows.reduce((s, r) => s + r.basePaise, 0),
      commissionPaise: rows.reduce((s, r) => s + r.commissionPaise, 0)
    }))
    .sort((a, b) => b.commissionPaise - a.commissionPaise)
}
