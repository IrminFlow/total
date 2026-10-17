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
  /** Signed dr-positive balance to close for the FY, in paise: the FY's net movement, plus the
   *  ledger's stored opening balance when the FY is the books' first (WP 1.3). */
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

// ---------------------------------------------------------------------------------------------
// Guided re-close (upgrade notes 0.4.0 → 0.5.0). A close posted by 0.4.0 netted the FY's
// MOVEMENTS only: in the books' first FY the income / expense ledgers' stored opening balances
// were never carried to Retained Earnings, so the trial balance shows them for ever after as the
// computed "Profit & Loss A/c (opening)" row (and a close built on a group whose nature migration
// 018 later repaired missed — or wrongly zeroed — that group's ledgers). The repair compares each
// live closing journal with the journal today's rule (reports.pnlLedgerAmounts — ledger profit
// only; stock profit stays a balance-sheet line) would post, per ledger.
// ---------------------------------------------------------------------------------------------

/** One ledger of a closing journal, as stored vs as today's rule would post it (dr-positive nets). */
export interface CloseRepairDiff {
  ledgerId: number | null
  name: string
  /** True for the transfer ledger (Retained Earnings or what the old journal used). */
  transfer: boolean
  stored: number
  expected: number
}

export interface CloseRepairYear {
  fyStartYear: number
  label: string
  voucherId: number
  voucherNumber: string
  date: string
  /** Dr-positive profit / loss of this FY still sitting in income / expense ledgers after the
   *  stored close — the part of the "Profit & Loss A/c (opening)" row this year leaves behind
   *  (negative = profit left, positive = loss left). */
  residual: number
  needsRepair: boolean
  /** Why this year can't be repaired by the tool (it is then left alone). */
  blocked: string | null
  /** Only the ledgers whose stored line differs from the corrected one. */
  diffs: CloseRepairDiff[]
  /** The corrected journal's lines (what Repair posts), with names for the screen. */
  corrected: { ledgerId: number | null; name: string; drCr: 'dr' | 'cr'; amount: number }[]
  /** Net profit (positive) / loss the corrected journal carries — the FY's P&L net profit. */
  netProfit: number
}

export interface CloseRepairPreview {
  years: CloseRepairYear[]
  /** Changes when anything a repair would post changes — Repair must send the one it was shown. */
  fingerprint: string
  lockDate: string | null
}

/** Ledger nets of the stored journal vs the expected ones; every ledger that differs. Pure. */
export function diffCloseNets(
  stored: Map<number, number>,
  expected: Map<number, number>
): { ledgerId: number; stored: number; expected: number }[] {
  const ids = new Set<number>([...stored.keys(), ...expected.keys()])
  const out: { ledgerId: number; stored: number; expected: number }[] = []
  for (const id of ids) {
    const s = stored.get(id) ?? 0
    const e = expected.get(id) ?? 0
    if (s !== e) out.push({ ledgerId: id, stored: s, expected: e })
  }
  return out.sort((a, b) => a.ledgerId - b.ledgerId)
}

/** Expected dr-positive nets of a correct closing journal: each income / expense ledger's FY
 *  amount reversed, the sum on the transfer ledger. Pure (mirrors planClose + postClose). */
export function expectedCloseNets(rows: CloseLedgerRow[], transferLedgerId: number): Map<number, number> {
  const out = new Map<number, number>()
  let sum = 0
  for (const r of rows) {
    if (r.net === 0) continue
    out.set(r.ledgerId, (out.get(r.ledgerId) ?? 0) - r.net)
    sum += r.net
  }
  if (sum !== 0) out.set(transferLedgerId, (out.get(transferLedgerId) ?? 0) + sum)
  return out
}
