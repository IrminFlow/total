/**
 * Bad-debt provisioning helper.
 *
 * A provision is a judgement, not a calculation, so this does not decide anything: it applies a
 * stated policy to the ageing the books already know about, shows the working per bill, and hands
 * the result to the human as a *draft* journal. The percentages are the argument, and they are
 * visible and editable rather than buried in a formula.
 *
 * The default ladder follows what most Indian SMB auditors ask for — nothing is doubtful at six
 * months, half of it is at a year, all of it at two. A business with different experience should
 * change it, which is why it is a parameter.
 */

export interface ProvisionRule {
  /** Bills overdue by more than this many days attract `pct`. */
  afterDays: number
  /** Whole percent, 0-100. */
  pct: number
}

export const DEFAULT_PROVISION_POLICY: ProvisionRule[] = [
  { afterDays: 180, pct: 25 },
  { afterDays: 365, pct: 50 },
  { afterDays: 730, pct: 100 }
]

export function validPolicy(rules: ProvisionRule[]): boolean {
  if (rules.length === 0 || rules.length > 6) return false
  return rules.every(
    (r, i) =>
      Number.isInteger(r.afterDays) &&
      r.afterDays > 0 &&
      Number.isInteger(r.pct) &&
      r.pct >= 0 &&
      r.pct <= 100 &&
      (i === 0 || (r.afterDays > (rules[i - 1] as ProvisionRule).afterDays && r.pct >= (rules[i - 1] as ProvisionRule).pct))
  )
}

/** The highest rule whose threshold the bill has passed. 0 when it has passed none. */
export function provisionPct(overdueDays: number, policy: ProvisionRule[]): number {
  let pct = 0
  for (const rule of policy) if (overdueDays > rule.afterDays) pct = rule.pct
  return pct
}

export interface ProvisionBill {
  number: string
  date: string
  pending: number
  overdueDays: number
}

export interface ProvisionBillLine extends ProvisionBill {
  pct: number
  /** Integer paise, floored — never provide for a paisa the policy does not justify. */
  provision: number
}

export interface ProvisionParty {
  ledgerId: number
  name: string
  pending: number
  provision: number
  bills: ProvisionBillLine[]
}

export interface ProvisionResult {
  parties: ProvisionParty[]
  total: number
  policy: ProvisionRule[]
}

export function computeProvision(
  parties: { ledgerId: number; name: string; bills: ProvisionBill[] }[],
  policy: ProvisionRule[] = DEFAULT_PROVISION_POLICY
): ProvisionResult {
  const rows: ProvisionParty[] = []
  for (const p of parties) {
    const bills: ProvisionBillLine[] = p.bills.map((b) => {
      const pct = provisionPct(b.overdueDays, policy)
      return { ...b, pct, provision: Math.floor((b.pending * pct) / 100) }
    })
    const provision = bills.reduce((s, b) => s + b.provision, 0)
    // Parties with nothing doubtful are dropped: the point of the screen is the shortlist.
    if (provision === 0) continue
    rows.push({
      ledgerId: p.ledgerId,
      name: p.name,
      pending: p.bills.reduce((s, b) => s + b.pending, 0),
      provision,
      bills: bills.filter((b) => b.provision > 0)
    })
  }
  rows.sort((a, b) => b.provision - a.provision)
  return { parties: rows, total: rows.reduce((s, p) => s + p.provision, 0), policy }
}

/** "25% over 180 days, 50% over 365, 100% over 730" — the policy in one line, for the narration. */
export function describePolicy(policy: ProvisionRule[]): string {
  return policy.map((r, i) => (i === 0 ? `${r.pct}% over ${r.afterDays} days` : `${r.pct}% over ${r.afterDays}`)).join(', ')
}
