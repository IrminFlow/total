/**
 * The approval threshold: when an entry stops being a keystroke and becomes a decision.
 *
 * The owner is rarely the person typing. Roles already say who *may* post; this says which posts
 * the owner wanted to see before they counted. It is deliberately one number, because a small
 * business owner will set one number and no more.
 *
 * Pure on purpose: the rule is three lines and every edge in it is a rule about people, so it is
 * worth being able to state each one in a test name.
 */

export type ApprovalState = 'pending' | 'approved' | 'rejected'

/** Threshold in paise. `null` = the feature is off, which is NOT the same as 0 (see below). */
export type ApprovalThreshold = number | null

export interface ApprovalGateInput {
  /** null = off. 0 = every entry above nothing, i.e. everything with an amount. */
  threshold: ApprovalThreshold
  /** The voucher's total debit in paise, always >= 0. */
  amount: number
  /** The role of the person saving it. */
  actorRole: 'owner' | 'accountant' | 'viewer' | null
  /** Whether the company has any users at all. A book nobody signs into has no second person. */
  hasUsers: boolean
}

/**
 * Does this save have to wait for the owner?
 *
 * Four deliberate answers:
 *
 * - **null threshold is off.** Zero is not. A threshold of 0 means "everything with an amount
 *   waits", which is a real thing an owner might do for a week after finding something wrong,
 *   and treating it as "off" would be the app quietly overruling them. An entry of exactly 0 is
 *   still not held: there is no decision in a nil voucher.
 * - **The owner's own entry never waits**, whatever the amount. Approval is the owner seeing it;
 *   they have.
 * - **No users, no gate.** With nobody signed in there is one person, and holding their entry
 *   for their own approval is a queue with one end.
 * - **Strictly above.** A limit of ₹50,000 permits ₹50,000. Anybody setting a limit means "more
 *   than this", and an entry at exactly the limit landing in the queue is the kind of surprise
 *   that gets the whole feature switched off.
 */
export function needsApproval(input: ApprovalGateInput): boolean {
  if (input.threshold === null) return false
  if (!input.hasUsers) return false
  if (input.actorRole === 'owner') return false
  if (input.amount <= 0) return false
  return input.amount > input.threshold
}

/**
 * Who may decide a pending voucher: the owner, and never the person who entered it.
 *
 * The second condition is the whole point of the queue. An owner who also does data entry can
 * still approve their own — but their own entries never enter the queue in the first place, so
 * the case cannot arise except by someone changing a role mid-flight, and refusing it there is
 * the safe way round.
 */
export function canDecideApproval(input: {
  approverRole: 'owner' | 'accountant' | 'viewer' | null
  approverName: string | null
  enteredBy: string | null
}): boolean {
  if (input.approverRole !== 'owner') return false
  if (input.enteredBy && input.approverName && input.enteredBy === input.approverName) return false
  return true
}

/** Sentence shown on a held voucher, so the person who typed it knows what happened to it. */
export function pendingExplanation(threshold: ApprovalThreshold, formatMoney: (paise: number) => string): string {
  if (threshold === null) return 'Waiting for the owner to approve it.'
  return `Entries above ${formatMoney(threshold)} wait for the owner. This one is not in the books yet.`
}
