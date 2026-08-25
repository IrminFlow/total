/**
 * The draft a natural-language entry produces — and everything that has to be true about it
 * before a human is shown it.
 *
 * "Book a payment of 12,500 to Sharma Traders for the March rent" is the request this answers.
 * What it does NOT do is post anything: the assistant has no write tool, and there is no path
 * from here to `saveVoucher`. The model proposes; the draft opens in the ordinary voucher screen,
 * pre-filled, with the ordinary validation and the ordinary Save button under the ordinary
 * person's hand. That is the entire safety design, and it is why this module produces a value
 * rather than performing an action.
 *
 * Everything checkable is checked HERE rather than in the model's head:
 *
 *  - Debits equal credits. A model asked to split 12,500 three ways will produce 4,166.66 twice
 *    and 4,166.68 once about as often as it produces something that balances.
 *  - Amounts are integer paise, and any fractional value is refused rather than rounded. A
 *    silently rounded draft is a rounding error someone signs.
 *  - Every ledger is one the model looked up, not one it named. An id it invented is caught
 *    because the caller resolves ids and passes the resolved set in.
 *
 * Issues are returned, never thrown: a draft with problems is still worth showing, with the
 * problems on it, because the human can usually fix in five seconds what the model got wrong.
 */

import { VOUCHER_KINDS, type VoucherKind } from '../domain'
import { isValidISODate } from '../dates'
import { formatPaise } from '../money'

export interface DraftLine {
  ledgerId: number
  /** Carried for display: the draft is reviewed before it is anything else. */
  ledgerName: string
  drCr: 'dr' | 'cr'
  /** Integer paise, like every other amount in this codebase. */
  amountPaise: number
}

export interface VoucherDraftProposal {
  kind: VoucherKind
  date: string
  narration?: string
  partyLedgerId?: number
  lines: DraftLine[]
}

export interface DraftIssue {
  severity: 'blocking' | 'warning'
  message: string
}

export interface DraftReview {
  proposal: VoucherDraftProposal
  totalDebit: number
  totalCredit: number
  balanced: boolean
  issues: DraftIssue[]
  /** True when nothing blocking remains — the "Open in voucher entry" button keys off this. */
  openable: boolean
}

/** Sum both sides. Integer addition only: see the header. */
export function draftTotals(lines: DraftLine[]): { debit: number; credit: number } {
  let debit = 0
  let credit = 0
  for (const line of lines) {
    if (line.drCr === 'dr') debit += line.amountPaise
    else credit += line.amountPaise
  }
  return { debit, credit }
}

export interface DraftContext {
  today: string
  /** Ledger ids that exist, with their names — the model may not invent one. */
  knownLedgers: Map<number, string>
  /** Books locked on or before this date; a draft dated into locked territory is blocked. */
  lockedUpTo?: string | null
}

export function reviewDraft(proposal: VoucherDraftProposal, ctx: DraftContext): DraftReview {
  const issues: DraftIssue[] = []
  const add = (severity: DraftIssue['severity'], message: string): void => {
    issues.push({ severity, message })
  }

  if (!VOUCHER_KINDS.includes(proposal.kind)) {
    add('blocking', `"${proposal.kind}" is not a voucher kind Total knows.`)
  }
  if (!isValidISODate(proposal.date)) {
    add('blocking', `"${proposal.date}" is not a date. Use YYYY-MM-DD.`)
  } else {
    if (proposal.date > ctx.today) {
      // Not blocking: a post-dated cheque entry is legitimate, and the user can see the date.
      add('warning', `Dated ${proposal.date}, which is in the future.`)
    }
    if (ctx.lockedUpTo && proposal.date <= ctx.lockedUpTo) {
      add('blocking', `The books are locked up to ${ctx.lockedUpTo}; this draft is dated ${proposal.date}.`)
    }
  }

  if (proposal.lines.length < 2) {
    add('blocking', 'A voucher needs at least two lines — one debit and one credit.')
  }

  for (const line of proposal.lines) {
    const name = ctx.knownLedgers.get(line.ledgerId)
    if (name == null) {
      add('blocking', `Ledger ${line.ledgerId} does not exist. Ask again naming the ledger exactly.`)
    } else if (name !== line.ledgerName) {
      // The model labelled a real id with someone else's name. The id wins in the draft, but the
      // human is told, because that is a sign it matched the wrong party.
      add('warning', `Ledger ${line.ledgerId} is "${name}", not "${line.ledgerName}".`)
    }
    if (!Number.isInteger(line.amountPaise)) {
      add('blocking', `${line.ledgerName}: ${line.amountPaise} is not a whole number of paise.`)
    }
    if (line.amountPaise <= 0) {
      add('blocking', `${line.ledgerName}: an amount must be positive — use the other side instead of a negative.`)
    }
  }

  if (proposal.partyLedgerId != null && !ctx.knownLedgers.has(proposal.partyLedgerId)) {
    add('blocking', `Party ledger ${proposal.partyLedgerId} does not exist.`)
  }

  const { debit, credit } = draftTotals(proposal.lines)
  const balanced = debit === credit && debit > 0
  if (!balanced && proposal.lines.length >= 2) {
    add(
      'blocking',
      `Debits ${formatPaise(debit)} do not equal credits ${formatPaise(credit)} — out by ${formatPaise(Math.abs(debit - credit))}.`
    )
  }

  return {
    proposal,
    totalDebit: debit,
    totalCredit: credit,
    balanced,
    issues,
    openable: !issues.some((i) => i.severity === 'blocking')
  }
}

/**
 * One line of prose describing the draft, for the answer text and the audit trail.
 *
 * Built here rather than left to the model, so the sentence the user reads is generated from the
 * same object the button opens — the two cannot disagree about the amount.
 */
export function describeDraft(proposal: VoucherDraftProposal): string {
  const { debit } = draftTotals(proposal.lines)
  const dr = proposal.lines.filter((l) => l.drCr === 'dr').map((l) => l.ledgerName)
  const cr = proposal.lines.filter((l) => l.drCr === 'cr').map((l) => l.ledgerName)
  return `${proposal.kind} on ${proposal.date}: ${formatPaise(debit)}, ${dr.join(' + ') || '?'} to ${cr.join(' + ') || '?'}`
}
