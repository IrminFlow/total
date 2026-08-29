/**
 * What an order still owes (roadmap #188), and the three-way match behind a receipt note (#189).
 *
 * An order is not a document, it is a BALANCE: what was ordered, what has arrived, what is still
 * owed, and what arrived that nobody asked for. The failure this file exists to prevent is an
 * order that reports itself as either "open" or "closed" and nothing in between — a purchase desk
 * chasing a supplier for 100 units when 70 are already in the godown is the same bug as one that
 * never chases at all.
 *
 * Everything here is quantity arithmetic in integer thousandths (`qtyMilli`). No money: a
 * fulfilment shortfall is a quantity, and the rupee consequence of it is the invoice's business,
 * not this file's.
 */

/** Ordered vs delivered on one line. */
export interface FulfilmentInput {
  orderedMilli: number
  fulfilledMilli: number
}

/**
 * - `none` — nothing has arrived yet.
 * - `partial` — some arrived, some is still owed. The state that matters, and the one a
 *   two-valued open/closed flag cannot express.
 * - `complete` — exactly what was ordered arrived.
 * - `over` — more arrived than was ordered, and nothing is outstanding.
 */
export type FulfilmentState = 'none' | 'partial' | 'complete' | 'over'

export interface Fulfilment {
  orderedMilli: number
  fulfilledMilli: number
  /** What a further receipt would still take. Never negative. */
  pendingMilli: number
  /** What arrived beyond the order. Never negative. */
  overMilli: number
  state: FulfilmentState
}

export function lineFulfilment(orderedMilli: number, fulfilledMilli: number): Fulfilment {
  const ordered = Math.max(0, Math.trunc(orderedMilli))
  const fulfilled = Math.max(0, Math.trunc(fulfilledMilli))
  const pending = Math.max(0, ordered - fulfilled)
  const over = Math.max(0, fulfilled - ordered)
  return {
    orderedMilli: ordered,
    fulfilledMilli: fulfilled,
    pendingMilli: pending,
    overMilli: over,
    state: fulfilled === 0 ? (ordered === 0 ? 'complete' : 'none') : pending > 0 ? 'partial' : over > 0 ? 'over' : 'complete'
  }
}

/**
 * The whole document's balance.
 *
 * Pending and over are summed per LINE and never netted against each other: an order for ten
 * bolts and ten nuts that arrives as twenty bolts is not fulfilled, and a total that cancelled
 * the shortfall against the excess would say it was. That is the entire reason this is not
 * `SUM(qty) - SUM(received)`.
 */
export function documentFulfilment(lines: FulfilmentInput[]): Fulfilment {
  const parts = lines.map((l) => lineFulfilment(l.orderedMilli, l.fulfilledMilli))
  const ordered = parts.reduce((s, p) => s + p.orderedMilli, 0)
  const fulfilled = parts.reduce((s, p) => s + p.fulfilledMilli, 0)
  const pending = parts.reduce((s, p) => s + p.pendingMilli, 0)
  const over = parts.reduce((s, p) => s + p.overMilli, 0)
  return {
    orderedMilli: ordered,
    fulfilledMilli: fulfilled,
    pendingMilli: pending,
    overMilli: over,
    // Pending wins over `over` when a document is both: something still has to be chased, and
    // that is the action the state is read for.
    state: fulfilled === 0 ? (ordered === 0 ? 'complete' : 'none') : pending > 0 ? 'partial' : over > 0 ? 'over' : 'complete'
  }
}

export const FULFILMENT_LABEL: Record<FulfilmentState, string> = {
  none: 'Nothing received',
  partial: 'Part received',
  complete: 'Fully received',
  over: 'Over-received'
}

// ---------- the three-way match ----------

/**
 * One item, seen from all three documents at once.
 *
 * `key` is whatever identifies the same goods across the three — the stock item id where there is
 * one, the description where there is not. Matching by description is weak and deliberately so:
 * the alternative is silently dropping a line that the supplier described differently, and a line
 * that disappears from a match report is the one failure mode worse than a line that mismatches.
 */
export interface MatchLine {
  key: string
  description: string
  orderedMilli: number
  receivedMilli: number
  invoicedMilli: number
}

export type MatchStatus =
  | 'matched'
  | 'over_invoiced'
  | 'not_ordered'
  | 'over_received'
  | 'short_received'
  | 'under_invoiced'

export interface MatchRow extends MatchLine {
  /** received − ordered. Negative is a short delivery, positive an over-delivery. */
  receiptVarianceMilli: number
  /** invoiced − received. Positive is the one that costs money: a bill for goods that never came. */
  invoiceVarianceMilli: number
  status: MatchStatus
}

export interface MatchResult {
  rows: MatchRow[]
  /** Every line agreed on all three counts. */
  clean: boolean
  /** Rows whose status is not `matched`, worst first. */
  exceptions: MatchRow[]
}

/**
 * Severity order, worst first.
 *
 * `over_invoiced` leads because it is the only one that takes money out of the business for
 * nothing. `not_ordered` next: goods arrived that no order authorised, which is a control failure
 * whether or not the invoice agrees with them.
 */
const SEVERITY: MatchStatus[] = [
  'over_invoiced',
  'not_ordered',
  'over_received',
  'short_received',
  'under_invoiced',
  'matched'
]

function statusFor(l: MatchLine): MatchStatus {
  if (l.invoicedMilli > l.receivedMilli) return 'over_invoiced'
  if (l.orderedMilli === 0) return 'not_ordered'
  if (l.receivedMilli > l.orderedMilli) return 'over_received'
  if (l.receivedMilli < l.orderedMilli) return 'short_received'
  if (l.invoicedMilli > 0 && l.invoicedMilli < l.receivedMilli) return 'under_invoiced'
  return 'matched'
}

export function threeWayMatch(lines: MatchLine[]): MatchResult {
  const rows: MatchRow[] = lines.map((l) => ({
    ...l,
    receiptVarianceMilli: l.receivedMilli - l.orderedMilli,
    invoiceVarianceMilli: l.invoicedMilli - l.receivedMilli,
    status: statusFor(l)
  }))
  const exceptions = rows
    .filter((r) => r.status !== 'matched')
    .sort((a, b) => SEVERITY.indexOf(a.status) - SEVERITY.indexOf(b.status))
  return { rows, clean: exceptions.length === 0, exceptions }
}

export const MATCH_LABEL: Record<MatchStatus, string> = {
  matched: 'Agrees',
  over_invoiced: 'Billed for more than arrived',
  not_ordered: 'Arrived with no order behind it',
  over_received: 'More arrived than was ordered',
  short_received: 'Less arrived than was ordered',
  under_invoiced: 'Billed for less than arrived'
}
