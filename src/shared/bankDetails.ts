/**
 * A party's bank details: normalising them, deciding when changing them needs a second person,
 * and finding the same account sitting on two different parties.
 *
 * Changing a supplier's account number is the highest-value fraud available in this market. It
 * needs neither access to the bank nor a forged instrument — one field on a master, and every
 * payment after it goes somewhere else, usually noticed a month later when the real supplier
 * asks. Everything here exists to make that one field cost two people.
 */

export interface BankDetails {
  account: string | null
  ifsc: string | null
  holder: string | null
}

/**
 * The comparable form of an account number: digits and letters only, uppercased.
 *
 * Banks, statements and humans all write the same account with spaces, dashes and leading zeros
 * in different places. Comparing what was typed would miss `0012 3456 7890` against
 * `001234567890`, and missing it is exactly the case the duplicate check exists for.
 *
 * Leading zeros are KEPT: they are part of the account number at several Indian banks, and two
 * accounts differing only by one are two accounts.
 */
export function normaliseAccount(account: string | null | undefined): string | null {
  if (!account) return null
  const cleaned = account.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  return cleaned || null
}

export function normaliseIfsc(ifsc: string | null | undefined): string | null {
  if (!ifsc) return null
  const cleaned = ifsc.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  return cleaned || null
}

/** Shape check only. A well-formed IFSC that is wrong still sends money somewhere, so this
 *  rejects a typo, not a mistake. Same rule as the payroll one (schemas.ts). */
export function looksLikeIfsc(ifsc: string): boolean {
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(normaliseIfsc(ifsc) ?? '')
}

/** True when the two sets of details differ in any field that decides where money lands. */
export function bankDetailsChanged(before: BankDetails, after: BankDetails): boolean {
  return (
    normaliseAccount(before.account) !== normaliseAccount(after.account) ||
    normaliseIfsc(before.ifsc) !== normaliseIfsc(after.ifsc) ||
    (before.holder ?? '').trim() !== (after.holder ?? '').trim()
  )
}

export interface TwoPersonInput {
  /** How many active users the company has. */
  activeUsers: number
  /** The role of whoever is making the change; null = no session (an unprotected company). */
  actorRole: 'owner' | 'accountant' | 'viewer' | null
}

/**
 * Does this change have to be parked for someone else to confirm?
 *
 * **Only when a second person exists.** A one-person business — the overwhelming majority of
 * this app's users — cannot satisfy a two-person rule, and a rule that cannot be satisfied is a
 * feature that gets turned off, or worse, a master that never gets corrected. Fewer than two
 * users means the change applies at once.
 *
 * **Including the owner's own change.** This is the deliberate difference from the voucher
 * approval threshold, where an owner's entry never waits. There, the owner is the approver and
 * has by definition seen it. Here the risk is not a careless entry, it is a convincing email;
 * an owner acting on a forged "we have changed our bank" letter is the textbook version of this
 * fraud, and the second pair of eyes is worth more than the owner's convenience. It is one
 * confirmation, not a workflow.
 */
export function bankChangeNeedsSecondPerson(input: TwoPersonInput): boolean {
  if (input.activeUsers < 2) return false
  return input.actorRole === 'owner' || input.actorRole === 'accountant'
}

/** Who may confirm a parked change: anyone who can edit masters, except the person who asked. */
export function canConfirmBankChange(input: {
  approverRole: 'owner' | 'accountant' | 'viewer' | null
  approverName: string | null
  requestedBy: string | null
}): { ok: true } | { ok: false; message: string } {
  if (input.approverRole !== 'owner' && input.approverRole !== 'accountant') {
    return { ok: false, message: 'Only an owner or an accountant can confirm a bank-detail change.' }
  }
  if (!input.approverName) {
    return { ok: false, message: 'Sign in before confirming a bank-detail change.' }
  }
  if (input.requestedBy && input.requestedBy === input.approverName) {
    return {
      ok: false,
      message: 'A bank-detail change has to be confirmed by someone other than the person who asked for it.'
    }
  }
  return { ok: true }
}

export interface PartyBankRow {
  ledgerId: number
  name: string
  account: string | null
  ifsc: string | null
  /** The user has said this account is knowingly shared (a proprietor and their firm). */
  sharedOk: boolean
}

export interface SharedAccountGroup {
  /** Normalised account number the parties have in common. */
  account: string
  parties: { ledgerId: number; name: string; ifsc: string | null }[]
}

/**
 * Parties that bank into the same account.
 *
 * Either a data error, or exactly the fraud the two-person rule guards against — a payee master
 * pointed at an account that already belongs to someone else on the books.
 *
 * A group is suppressed only when EVERY party in it has been marked as knowingly sharing. The
 * legitimate case is real and common: a proprietor and their firm, two firms of one family, a
 * transporter billing under two names. Marking one side would silence the pair; a third party
 * appearing on the same account later is a new fact and must reappear.
 */
export function sharedBankAccounts(rows: PartyBankRow[]): SharedAccountGroup[] {
  const byAccount = new Map<string, PartyBankRow[]>()
  for (const row of rows) {
    const key = normaliseAccount(row.account)
    if (!key) continue
    const list = byAccount.get(key) ?? []
    list.push(row)
    byAccount.set(key, list)
  }
  const groups: SharedAccountGroup[] = []
  for (const [account, list] of byAccount) {
    if (list.length < 2) continue
    if (list.every((r) => r.sharedOk)) continue
    groups.push({
      account,
      parties: list
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((r) => ({ ledgerId: r.ledgerId, name: r.name, ifsc: normaliseIfsc(r.ifsc) }))
    })
  }
  return groups.sort((a, b) => a.account.localeCompare(b.account))
}

/** Show only the tail of an account number in lists — the full number belongs on the master. */
export function maskAccount(account: string | null | undefined): string {
  const n = normaliseAccount(account)
  if (!n) return '—'
  if (n.length <= 4) return n
  return `${'•'.repeat(Math.min(n.length - 4, 8))}${n.slice(-4)}`
}
