/**
 * Is this company already here? (roadmap #251)
 *
 * Importing a backup used to create a company unconditionally, and if the name collided it became
 * "acme-2". That is the single most dangerous silent success in the app: the user believes they
 * have restored their books, works in the copy for a week, and their real books are the other one
 * — with the entries they have been making split across two files that can never be recombined.
 *
 * A GSTIN is the strongest identity a business has, so a match there is decisive; a name match is
 * only a suspicion, because "Sharma Traders" is a name two people can both have.
 */

export interface CompanyIdentity {
  slug: string
  name: string
  gstin: string | null
}

export type DuplicateReason = 'gstin' | 'name'

export interface DuplicateMatch {
  slug: string
  name: string
  reason: DuplicateReason
}

const normalise = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * Companies already on this machine that look like `candidate`, strongest match first.
 * An empty list means the import is unambiguously new.
 */
export function findDuplicateCompanies(existing: CompanyIdentity[], candidate: { name: string; gstin: string | null }): DuplicateMatch[] {
  const gstin = candidate.gstin?.trim().toUpperCase() || null
  const name = normalise(candidate.name)
  const matches: DuplicateMatch[] = []
  for (const company of existing) {
    if (gstin && company.gstin && company.gstin.trim().toUpperCase() === gstin) {
      matches.push({ slug: company.slug, name: company.name, reason: 'gstin' })
    } else if (normalise(company.name) === name) {
      matches.push({ slug: company.slug, name: company.name, reason: 'name' })
    }
  }
  return matches.sort((a, b) => (a.reason === b.reason ? 0 : a.reason === 'gstin' ? -1 : 1))
}

/** What to put in front of the person about to make a second copy of their own books. */
export function duplicateWarning(matches: DuplicateMatch[]): string | null {
  if (matches.length === 0) return null
  const first = matches[0]!
  return first.reason === 'gstin'
    ? `“${first.name}” on this machine has the same GSTIN. Importing makes a SECOND, separate set of books — entries made in one will never appear in the other. Restore into the existing company instead unless you specifically want a copy.`
    : `A company called “${first.name}” is already on this machine. Importing makes a second, separate set of books rather than updating it.`
}
