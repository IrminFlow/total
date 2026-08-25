/**
 * The scratchpad ledger (roadmap B #46): somewhere to put an entry you cannot classify yet.
 *
 * The situation is ordinary and daily. A payment goes out and nobody knows what it was for until
 * the bill arrives; ₹3,400 lands in the bank from a name nobody recognises; the accountant is
 * keying a month of vouchers and hits one they need to ask about. Today the choices are all bad:
 * guess a ledger (the guess is invisible afterwards and lands in someone's P&L), leave the voucher
 * unsaved (it is then not in the books at all, and the bank does not reconcile), or keep a note on
 * paper (which is where it stays).
 *
 * So: a real ledger, under **Suspense A/c**, and a list of what is sitting in it.
 *
 * Three decisions worth defending.
 *
 * **It is a ledger, not a flag on a voucher.** The entry has to be IN the books — the trial
 * balance must balance with it in, the bank must reconcile with it in, and the amount has to show
 * up somewhere a person will trip over. A flag would leave the money invisible; a suspense balance
 * is a number an accountant is trained to want at zero.
 *
 * **It is Suspense A/c, not a new group.** Suspense is where unclassified amounts have gone since
 * long before this app, every accountant reads it that way without being told, and Schedule III
 * presentation already knows what to do with it.
 *
 * **Classifying is an EDIT of the existing line, not a second voucher.** A transfer journal out of
 * suspense would leave the original entry pointing at Suspense forever, so the day book would show
 * a payment to Suspense and a separate journal, and nobody reading the ledger a year later can see
 * that the payment was for printing. Moving the line rewrites what it always should have said, and
 * the audit log records the move — which is exactly what an audit trail is for.
 */

/** The ledger's name. One constant, so no two call sites can create two of them. */
export const SCRATCHPAD_LEDGER_NAME = 'Scratchpad (unclassified)'

/** The group it is created under. Suspense A/c is a system group in the seeded chart. */
export const SCRATCHPAD_GROUP_NAME = 'Suspense A/c'

/** Shown wherever the ledger is offered, so nobody mistakes it for a real expense head. */
export const SCRATCHPAD_HINT =
  'Park an entry here when you do not yet know where it belongs. It stays in the books and on this list until you classify it.'

export interface ReclassifyCheckInput {
  /** The books-locked-up-to date, or null. */
  lockDate: string | null
  voucherDate: string
  /** True when the voucher is in the bin. */
  isDeleted: boolean
  /** The ledger the line is being moved TO. */
  targetLedgerId: number
  /** The scratchpad ledger's own id. */
  scratchpadLedgerId: number
  /** True when the line being moved is not currently on the scratchpad ledger. */
  notOnScratchpad?: boolean
}

/**
 * Everything that must be true before a scratchpad line may be moved to a real ledger, or the
 * first reason it is not.
 *
 * The locked-period check is the one that matters. Classifying rewrites a posted voucher, and a
 * posted voucher inside a signed-off period is exactly what the lock exists to hold still — a
 * suspense balance that was reported at 31 March has to stay reported. The answer for a locked
 * period is a journal in the open one, which the user can still write; it is not this button.
 */
export function checkReclassify(input: ReclassifyCheckInput): string | null {
  if (input.isDeleted) return 'That voucher is in the bin — restore it first'
  if (input.notOnScratchpad) return 'That line is not on the scratchpad any more'
  if (input.targetLedgerId === input.scratchpadLedgerId) {
    return 'Classifying means moving it OFF the scratchpad'
  }
  if (input.lockDate && input.voucherDate <= input.lockDate) {
    return `Books are locked up to ${input.lockDate} — classify this with a journal in the open period instead`
  }
  return null
}

/** The audit note a reclassification leaves, so the day book says what happened and why. */
export function reclassifyNote(fromLedger: string, toLedger: string): string {
  return `Classified from ${fromLedger} to ${toLedger}`
}
