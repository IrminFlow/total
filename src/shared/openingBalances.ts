/**
 * Guided opening balances, for a business that is not coming from Tally (roadmap O #289).
 *
 * Most first-time users of an accounting application have never met a trial balance. They know
 * what they have: money in the bank, customers who owe them, suppliers they owe, stock on the
 * shelf, a loan, and whatever the business itself is worth. Asking them for "opening balances,
 * debit positive" gets a blank screen and an abandoned setup.
 *
 * So the screen asks the six questions in that order, in those words, and works out the signs.
 * This module is the part that can be tested: which group each question puts a ledger under,
 * which side it lands on, and whether the whole thing balances.
 */

export interface OpeningCategory {
  id: 'cash' | 'debtors' | 'creditors' | 'loans' | 'capital' | 'other'
  /** The question, as a person would ask it. */
  question: string
  /** The seeded group a ledger created under this question belongs to. */
  group: string
  /** Which side a positive amount lands on. */
  side: 'dr' | 'cr'
  hint: string
}

/**
 * The order matters: it runs from what is easiest to answer to what is hardest, so somebody who
 * gives up half way has still entered the parts that are worth the most (cash and parties).
 */
export const OPENING_CATEGORIES: OpeningCategory[] = [
  {
    id: 'cash',
    question: 'Cash and bank',
    group: 'Bank Accounts',
    side: 'dr',
    hint: 'What is in the till and in each account on the day you start. Take it from the bank statement, not the passbook.'
  },
  {
    id: 'debtors',
    question: 'Customers who owe you',
    group: 'Sundry Debtors',
    side: 'dr',
    hint: 'One line per customer, for what is still unpaid. Bills, not sales for the year.'
  },
  {
    id: 'creditors',
    question: 'Suppliers you owe',
    group: 'Sundry Creditors',
    side: 'cr',
    hint: 'One line per supplier, for what you have not paid yet.'
  },
  {
    id: 'loans',
    question: 'Loans you are repaying',
    group: 'Loans (Liability)',
    side: 'cr',
    hint: 'What is outstanding on each loan, not the amount originally borrowed.'
  },
  {
    id: 'capital',
    question: 'What the owners have put in',
    group: 'Capital Account',
    side: 'cr',
    hint: 'Capital, and anything the business has kept from earlier years.'
  },
  {
    id: 'other',
    question: 'Anything else',
    group: 'Current Assets',
    side: 'dr',
    hint: 'Deposits, advances, equipment — anything the business owns that is not already above.'
  }
]

export interface OpeningRow {
  /** Ledger name as typed. */
  name: string
  categoryId: OpeningCategory['id']
  /** Paise, always entered as a positive number — the category decides the side. */
  amount: number
}

/** Signed paise, dr-positive: what the ledger's `opening_balance` column should hold. */
export function signedOpening(category: OpeningCategory, amount: number): number {
  return category.side === 'dr' ? amount : -amount
}

export interface OpeningTotals {
  debit: number
  credit: number
  /** debit − credit, in paise. Zero means the opening set balances. */
  difference: number
  balanced: boolean
}

/**
 * What the entered rows add up to.
 *
 * The difference is the whole point of the screen. Nobody's first attempt balances, and the
 * useful thing is not to refuse the entry but to show the gap and name the two usual reasons for
 * it — a missing capital figure, or stock not yet counted.
 */
export function openingTotals(rows: OpeningRow[]): OpeningTotals {
  let debit = 0
  let credit = 0
  for (const row of rows) {
    const category = OPENING_CATEGORIES.find((c) => c.id === row.categoryId)
    if (!category || row.amount <= 0) continue
    if (category.side === 'dr') debit += row.amount
    else credit += row.amount
  }
  const difference = debit - credit
  return { debit, credit, difference, balanced: difference === 0 }
}

/**
 * The sentence to show under the totals.
 *
 * Written as advice rather than as an error: an unbalanced opening set is the normal state
 * halfway through entering one, and a red "invalid" on a screen somebody is still typing into is
 * how a setup gets abandoned.
 */
export function openingAdvice(totals: OpeningTotals, formatMoney: (paise: number) => string): string {
  if (totals.debit === 0 && totals.credit === 0) return 'Nothing entered yet.'
  if (totals.balanced) return 'This balances. Your opening trial balance will tie exactly.'
  if (totals.difference > 0) {
    return (
      `${formatMoney(totals.difference)} more on the left than the right. That usually means the owners' capital ` +
      'has not been entered yet — what is left over after what you owe is what the business is worth to you.'
    )
  }
  return (
    `${formatMoney(-totals.difference)} more on the right than the left. That usually means something the business ` +
    'owns is missing — stock on the shelf, a deposit, or equipment.'
  )
}
