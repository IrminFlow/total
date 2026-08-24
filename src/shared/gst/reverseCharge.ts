/**
 * Notified supplies where the recipient pays the tax.
 *
 * The books already carry a per-party `rcm` flag, which works when a supplier's every invoice is
 * reverse charge -- a goods transport agency, say. It does not help with the far more common
 * mistake: an ordinary registered vendor billing you for one notified service, on which you owe
 * the tax whatever that vendor's other invoices look like. Legal fees, security guards, a hired
 * cab, a sponsorship. The flag is on the wrong object for those; the obligation attaches to the
 * *supply*, not to the supplier.
 *
 * So this matches on the SAC of what was billed. It is advisory by design: it says "this looks
 * like a notified supply" next to the entry, and never silently changes a posting. Reverse charge
 * moves real money and gets audited, and an engine that quietly flipped a voucher's tax treatment
 * on a code prefix would be worse than one that says nothing.
 *
 * Section 9(3) categories with their notified SACs. Section 9(4) -- purchases from unregistered
 * suppliers -- is a separate rule handled by the caller, since it depends on the supplier's
 * registration rather than on what was supplied.
 *
 * These change by notification. Each entry carries the reason so a user can check the one that
 * fired rather than trusting the list wholesale.
 */

export interface RcmCategory {
  id: string
  label: string
  /** SAC prefixes that fall in this category. Matched longest-first. */
  sacPrefixes: string[]
  /** Why the recipient pays, in the words a user can look up. */
  reason: string
}

/**
 * Notified categories, most specific prefix first within each.
 *
 * Deliberately not exhaustive: the list covers the services a small business actually buys.
 * Tobacco leaves, silk yarn and lottery distribution are notified too and are left out rather
 * than half-modelled -- a business that deals in those needs the party flag, and an incomplete
 * list that looks complete is worse than a short one that admits it.
 */
export const RCM_CATEGORIES: RcmCategory[] = [
  {
    id: 'gta',
    label: 'Goods transport agency',
    sacPrefixes: ['9965', '9967'],
    reason: 'Road transport of goods by a GTA — the recipient pays, unless the GTA has opted to pay forward charge'
  },
  {
    id: 'legal',
    label: 'Legal services',
    sacPrefixes: ['998211', '998212', '998213', '998214', '998215', '998216'],
    reason: 'Legal services by an advocate or firm of advocates to a business entity'
  },
  {
    id: 'security',
    label: 'Security services',
    sacPrefixes: ['998521', '99852'],
    reason: 'Supply of security personnel by a non-body-corporate to a registered person'
  },
  {
    id: 'rent-a-cab',
    label: 'Renting of a motor vehicle',
    sacPrefixes: ['996601', '9966'],
    reason: 'Renting of a passenger vehicle with the cost of fuel included, by a non-body-corporate'
  },
  {
    id: 'sponsorship',
    label: 'Sponsorship',
    sacPrefixes: ['998397'],
    reason: 'Sponsorship services provided to a body corporate or partnership firm'
  },
  {
    id: 'director',
    label: 'Director’s remuneration',
    sacPrefixes: ['999293'],
    reason: 'Services by a director to the company, other than as an employee'
  },
  {
    id: 'insurance-agent',
    label: 'Insurance agent',
    sacPrefixes: ['997136', '9971'],
    reason: 'Services by an insurance agent to a person carrying on insurance business'
  },
  {
    id: 'recovery-agent',
    label: 'Recovery agent',
    sacPrefixes: ['999799'],
    reason: 'Services by a recovery agent to a bank or financial institution'
  }
]

export interface RcmMatch {
  category: RcmCategory
  /** The prefix that matched, so the UI can show why. */
  matchedPrefix: string
}

/**
 * Which notified category, if any, this SAC falls in.
 *
 * Longest prefix wins. That matters: 9971 is insurance-agent territory in general, but a specific
 * six-digit code under it should win over a four-digit rule from another category, and matching
 * shortest-first would let a broad prefix shadow a precise one.
 */
export function rcmCategoryForSac(sac: string | null | undefined): RcmMatch | null {
  const code = (sac ?? '').trim()
  if (!code) return null

  let best: RcmMatch | null = null
  for (const category of RCM_CATEGORIES) {
    for (const prefix of category.sacPrefixes) {
      if (!code.startsWith(prefix)) continue
      if (best === null || prefix.length > best.matchedPrefix.length) {
        best = { category, matchedPrefix: prefix }
      }
    }
  }
  return best
}

export interface RcmAdviceInput {
  /** SAC/HSN on the line or its ledger. */
  sac: string | null | undefined
  /** Whether the party ledger is already flagged for reverse charge. */
  partyFlagged: boolean
  /** The supplier's GSTIN, or null if unregistered. */
  partyGstin: string | null
}

export type RcmAdvice =
  /** Nothing to say. */
  | { kind: 'none' }
  /** A notified supply, and the party flag is already set — the posting will be right. */
  | { kind: 'confirmed'; match: RcmMatch }
  /** A notified supply on a party that is not flagged: the tax is probably the recipient's. */
  | { kind: 'suggest'; match: RcmMatch }

/**
 * Advice for one purchase line.
 *
 * Only ever advice. Returns 'confirmed' when the flag already agrees, so the UI can reassure
 * rather than nag, and 'suggest' when it does not — which is the case worth surfacing.
 *
 * An unregistered supplier is left alone here: that is section 9(4), a different rule with a
 * different (and much narrower, post-2019) scope, and folding it in would attach a 9(3) reason to
 * a 9(4) situation.
 */
export function rcmAdvice(input: RcmAdviceInput): RcmAdvice {
  const match = rcmCategoryForSac(input.sac)
  if (!match) return { kind: 'none' }
  return input.partyFlagged ? { kind: 'confirmed', match } : { kind: 'suggest', match }
}
