/**
 * Payment allocation suggestions when a receipt does not match one bill.
 *
 * The common case is easy and the app already handles it: a customer pays one invoice, you tick
 * one bill. What costs an hour a week is the other case — ₹1,47,320 arrives against nine open
 * bills and somebody works out by hand which ones it clears.
 *
 * Three answers are offered, in the order a person would try them:
 *   1. an exact match — one bill, or a combination that adds up to the paisa;
 *   2. oldest-first (FIFO), which is what the books do anyway when nobody says otherwise;
 *   3. what is left over, stated as an advance rather than hidden.
 *
 * Nothing here posts anything. It proposes; the human ticks.
 */
import type { OutstandingBill } from './reports'

export type SuggestionKind = 'exact-single' | 'exact-combination' | 'fifo' | 'fifo-partial'

export interface Allocation {
  number: string
  voucherId: number | null
  date: string
  pending: number
  /** Paise applied to this bill by the suggestion. May be less than `pending` (part payment). */
  applied: number
}

export interface AllocationSuggestion {
  kind: SuggestionKind
  /** One line the user reads to decide, e.g. "Clears INV-14 and INV-19 exactly". */
  label: string
  allocations: Allocation[]
  /** Receipt paise left over after the allocations — sits on the account as an advance. */
  leftover: number
  /** True when every allocated bill is fully cleared and nothing is left over. */
  exact: boolean
}

/** Bounds the exact-combination search. Beyond this many open bills the subset space is not worth
 *  exploring — FIFO is the honest answer and the user can tick manually. */
const MAX_COMBINATION_BILLS = 18
const MAX_SOLUTIONS = 3

function alloc(b: OutstandingBill, applied: number): Allocation {
  return { number: b.number, voucherId: b.voucherId, date: b.date, pending: b.pending, applied }
}

function joinNames(names: string[]): string {
  if (names.length === 1) return names[0] as string
  if (names.length === 2) return `${names[0] as string} and ${names[1] as string}`
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] as string}`
}

/**
 * Find subsets of `bills` whose pending amounts sum exactly to `amount`.
 *
 * Depth-first over bills sorted largest-first with two prunings: skip a bill bigger than what
 * remains, and abandon a branch once the bills still available cannot reach the target. That keeps
 * the realistic case (a dozen bills, one answer) in microseconds without a DP table over paise.
 */
function exactSubsets(bills: OutstandingBill[], amount: number): OutstandingBill[][] {
  const sorted = [...bills].sort((a, b) => b.pending - a.pending)
  const suffix: number[] = new Array(sorted.length + 1).fill(0)
  for (let i = sorted.length - 1; i >= 0; i--) suffix[i] = (suffix[i + 1] as number) + (sorted[i] as OutstandingBill).pending

  const found: OutstandingBill[][] = []
  const chosen: OutstandingBill[] = []

  const walk = (i: number, remaining: number): void => {
    if (found.length >= MAX_SOLUTIONS) return
    if (remaining === 0) {
      found.push([...chosen])
      return
    }
    if (i >= sorted.length || remaining < 0 || (suffix[i] as number) < remaining) return
    const bill = sorted[i] as OutstandingBill
    if (bill.pending <= remaining) {
      chosen.push(bill)
      walk(i + 1, remaining - bill.pending)
      chosen.pop()
    }
    walk(i + 1, remaining)
  }

  walk(0, amount)
  // Report in bill order rather than the search's largest-first order — the user reads dates.
  return found.map((set) => bills.filter((b) => set.includes(b)))
}

/** Oldest-first allocation, the same order the FIFO allocator settles bills in. */
export function fifoAllocate(bills: OutstandingBill[], amount: number): { allocations: Allocation[]; leftover: number } {
  const allocations: Allocation[] = []
  let left = amount
  for (const b of [...bills].sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number))) {
    if (left <= 0) break
    const applied = Math.min(left, b.pending)
    if (applied > 0) {
      allocations.push(alloc(b, applied))
      left -= applied
    }
  }
  return { allocations, leftover: left }
}

/**
 * Rank allocation suggestions for a receipt of `amount` against a party's open bills.
 *
 * Returns an empty list for a non-positive amount or no open bills — there is nothing to suggest,
 * and inventing a suggestion there would be noise on the screen at the moment of entry.
 */
export function suggestAllocations(bills: OutstandingBill[], amount: number): AllocationSuggestion[] {
  if (amount <= 0 || bills.length === 0) return []
  const out: AllocationSuggestion[] = []

  const single = bills.find((b) => b.pending === amount)
  if (single) {
    out.push({
      kind: 'exact-single',
      label: `Clears ${single.number} exactly`,
      allocations: [alloc(single, amount)],
      leftover: 0,
      exact: true
    })
  }

  if (bills.length <= MAX_COMBINATION_BILLS) {
    for (const set of exactSubsets(bills, amount)) {
      if (set.length < 2) continue
      out.push({
        kind: 'exact-combination',
        label: `Clears ${joinNames(set.map((b) => b.number))} exactly`,
        allocations: set.map((b) => alloc(b, b.pending)),
        leftover: 0,
        exact: true
      })
      if (out.length >= MAX_SOLUTIONS + 1) break
    }
  }

  const fifo = fifoAllocate(bills, amount)
  if (fifo.allocations.length > 0) {
    const last = fifo.allocations[fifo.allocations.length - 1] as Allocation
    const partial = last.applied < last.pending
    const cleared = fifo.allocations.filter((a) => a.applied === a.pending).length
    const label = partial
      ? `Oldest first — clears ${cleared} bill${cleared === 1 ? '' : 's'}, part-pays ${last.number}`
      : fifo.leftover > 0
        ? `Oldest first — clears ${cleared} bill${cleared === 1 ? '' : 's'}, rest on account`
        : `Oldest first — clears ${cleared} bill${cleared === 1 ? '' : 's'}`
    // Skip FIFO when it is character-for-character the exact answer already offered.
    const duplicate = out.some(
      (s) => s.exact && s.allocations.length === fifo.allocations.length &&
        s.allocations.every((a, i) => a.number === fifo.allocations[i]?.number && a.applied === fifo.allocations[i]?.applied)
    )
    if (!duplicate) {
      out.push({
        kind: partial ? 'fifo-partial' : 'fifo',
        label,
        allocations: fifo.allocations,
        leftover: fifo.leftover,
        exact: fifo.leftover === 0 && !partial
      })
    }
  }

  return out
}
