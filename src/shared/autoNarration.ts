/**
 * A narration written from what the voucher already says.
 *
 * Narration is the field most often left blank and most often wanted later: it is what makes a
 * day book readable a year on, and what an auditor reads before anything else. Asking for it
 * every time is how it ends up blank; writing it from the party and the lines costs nothing and
 * is right often enough to be worth offering.
 *
 * Offered, never imposed. This produces a suggestion the entry screen shows as a placeholder or
 * fills into an untouched field — a narration silently overwritten after someone typed one is a
 * far worse outcome than a blank.
 */

export interface NarrationInput {
  kind: string
  /** Party on the voucher, if any. */
  partyName?: string | null
  /** Stock item names on the voucher, in line order. */
  itemNames?: string[]
  /** Non-party, non-tax ledger names — the "what for" of a payment or a journal. */
  accountNames?: string[]
}

/** The verb each voucher kind takes, and which preposition connects it to the party. */
const PHRASING: Record<string, { verb: string; preposition: string }> = {
  sales: { verb: 'Sold', preposition: 'to' },
  purchase: { verb: 'Purchased', preposition: 'from' },
  receipt: { verb: 'Received', preposition: 'from' },
  payment: { verb: 'Paid', preposition: 'to' },
  credit_note: { verb: 'Credit note', preposition: 'to' },
  debit_note: { verb: 'Debit note', preposition: 'to' },
  contra: { verb: 'Transfer', preposition: 'to' }
}

/** At most this many names before the list becomes "and N more". */
const MAX_NAMES = 3

function joinNames(names: string[]): string {
  const unique = [...new Set(names.filter((n) => n.trim()))]
  if (unique.length === 0) return ''
  if (unique.length <= MAX_NAMES) {
    if (unique.length === 1) return unique[0]!
    return `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`
  }
  const shown = unique.slice(0, MAX_NAMES).join(', ')
  const rest = unique.length - MAX_NAMES
  return `${shown} and ${rest} more`
}

/**
 * A one-line narration, or null when there is nothing worth saying.
 *
 * Null rather than a generic string: "Journal entry" as a narration is worse than a blank,
 * because it looks like someone wrote it and tells the next reader nothing.
 */
export function suggestNarration(input: NarrationInput): string | null {
  const party = input.partyName?.trim() ?? ''
  const items = joinNames(input.itemNames ?? [])
  const accounts = joinNames(input.accountNames ?? [])
  const phrasing = PHRASING[input.kind]

  if (!phrasing) {
    // Journal and the stock vouchers have no natural verb; the accounts are the whole story.
    return accounts ? `Being ${accounts}` : null
  }

  // Items describe a trading voucher; accounts describe a cash one. Whichever the voucher has.
  const subject = items || accounts
  if (!party && !subject) return null

  if (party && subject) return `${phrasing.verb} ${subject} ${phrasing.preposition} ${party}`
  if (party) return `${phrasing.verb} ${phrasing.preposition} ${party}`
  return `${phrasing.verb} ${subject}`
}
