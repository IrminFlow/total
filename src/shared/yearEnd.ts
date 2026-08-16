/**
 * Year-end closing entry math. A closing journal zeroes every income/expense ledger for the FY:
 * income ledgers normally carry a credit balance (net < 0 in the dr-positive convention) and get
 * debited to zero it; expense ledgers normally carry a debit balance (net > 0) and get credited.
 * A ledger that happens to run the other way (a contra-signed income or expense account) still
 * gets whichever line zeroes its actual balance — the rule below is sign-driven, not nature-driven.
 *
 * The caller (src/main/services/yearEnd.ts) appends a Retained Earnings line to balance the
 * journal: its amount is exactly the gap netProfit leaves between the dr and cr sides here.
 */

export interface CloseLedgerRow {
  ledgerId: number
  name: string
  nature: 'income' | 'expense'
  /** Signed dr-positive net movement for the FY, in paise. */
  net: number
}

export interface CloseLine {
  ledgerId: number
  drCr: 'dr' | 'cr'
  amount: number
}

export interface ClosePlan {
  lines: CloseLine[]
  /** Positive = profit, negative = loss, in paise. */
  netProfit: number
}

/**
 * One line per nonzero-net ledger, zeroing its balance: net > 0 (debit balance) emits a credit
 * line of `net`; net < 0 (credit balance) emits a debit line of `abs(net)`. net === 0 is skipped.
 *
 * netProfit is the negative of the sum of all nets. Equivalently: sum(dr lines) - sum(cr lines)
 * emitted here equals netProfit, so appending a line of `abs(netProfit)` on the cr side (profit)
 * or dr side (loss) balances the journal.
 */
export function planClose(rows: CloseLedgerRow[]): ClosePlan {
  const lines: CloseLine[] = []
  let sumNet = 0
  for (const row of rows) {
    sumNet += row.net
    if (row.net > 0) lines.push({ ledgerId: row.ledgerId, drCr: 'cr', amount: row.net })
    else if (row.net < 0) lines.push({ ledgerId: row.ledgerId, drCr: 'dr', amount: -row.net })
  }
  return { lines, netProfit: sumNet === 0 ? 0 : -sumNet }
}
