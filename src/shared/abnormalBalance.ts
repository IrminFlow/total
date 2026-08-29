/**
 * A balance sitting on the side its account should not be on.
 *
 * An asset in credit or a liability in debit is usually a mistake, and usually one nobody looks
 * for: a bank account overdrawn in the books but not at the bank, a customer who paid twice, a
 * supplier ledger left in debit by a payment posted against the wrong name. The trial balance
 * shows all of them and none of them stand out, because a number in the credit column is
 * perfectly normal — on the next row.
 *
 * "Usually" is the operative word, so this flags rather than errors. A genuine bank overdraft is
 * an asset ledger in credit and is completely correct; an advance from a customer legitimately
 * puts a debtor in credit until it is adjusted. The point is to make them visible, not to claim
 * they are wrong.
 */

import type { Nature } from './domain'

/** The side each nature normally sits on. Income and expense are flows, not balances, and are
 *  netted into the P&L rather than carried — either side of them is ordinary. */
const NORMAL_SIDE: Record<Nature, 'dr' | 'cr' | null> = {
  asset: 'dr',
  liability: 'cr',
  income: null,
  expense: null
}

/**
 * Is this closing balance on the unusual side for its nature?
 *
 * `balance` is signed dr-positive, matching the convention used throughout the app. Zero is
 * never abnormal.
 */
export function isAbnormalBalance(nature: Nature, balance: number): boolean {
  const normal = NORMAL_SIDE[nature]
  if (normal === null || balance === 0) return false
  return normal === 'dr' ? balance < 0 : balance > 0
}

/** Why a row is flagged, in the words a user would use. Null when it is not flagged. */
export function abnormalReason(nature: Nature, balance: number): string | null {
  if (!isAbnormalBalance(nature, balance)) return null
  return nature === 'asset'
    ? 'An asset in credit — an overdraft, or a payment posted to the wrong side'
    : 'A liability in debit — an overpayment, or a receipt posted to the wrong side'
}
