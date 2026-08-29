/**
 * "What changed between these two dates."
 *
 * The question an accountant asks when a balance sheet looks wrong is not "what is the balance"
 * but "what moved since the last time I looked". This ranks ledgers by the size of the move
 * rather than by name, because a trial balance already lists them by name and that ordering is
 * exactly what hides a change.
 *
 * Balances are signed dr-positive throughout, so the change is a plain subtraction and a
 * liability growing shows as a negative number — the same convention every other report uses.
 */

export interface ChangeInput {
  ledgerId: number
  ledgerName: string
  groupName: string
  /** Signed dr-positive closing balance as on the earlier date. */
  opening: number
  /** Signed dr-positive closing balance as on the later date. */
  closing: number
  /** Vouchers touching this ledger strictly between the two dates. */
  vouchers: number
}

export interface ChangeRow extends ChangeInput {
  change: number
  /** Percentage move against the opening balance, or null when the opening was zero — a ledger
   *  that started at nothing has not grown by any percentage, it has simply appeared. */
  changePct: number | null
}

export interface ChangeReport {
  from: string
  to: string
  rows: ChangeRow[]
  /** Sum of every change — zero on a balanced set of books, and a useful self-check when not. */
  netChange: number
  /** How many ledgers moved at all. */
  movedCount: number
}

const round2 = (n: number): number => Math.round(n * 100) / 100

export function summariseChanges(from: string, to: string, inputs: ChangeInput[]): ChangeReport {
  const rows: ChangeRow[] = inputs.map((i) => {
    const change = i.closing - i.opening
    return {
      ...i,
      change,
      changePct: i.opening === 0 ? null : round2((change / Math.abs(i.opening)) * 100)
    }
  })
  // Unchanged ledgers are dropped: this report answers "what moved", and a page of zeroes is the
  // trial balance again. A ledger with movement that nets to zero is kept — offsetting entries
  // are exactly the kind of thing worth seeing.
  const moved = rows.filter((r) => r.change !== 0 || r.vouchers > 0)
  moved.sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || a.ledgerName.localeCompare(b.ledgerName))
  return {
    from,
    to,
    rows: moved,
    netChange: moved.reduce((s, r) => s + r.change, 0),
    movedCount: moved.filter((r) => r.change !== 0).length
  }
}
