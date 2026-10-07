// Three-way match (WP 2.5d, design §6.3) — pure. PO ↔ GRN ↔ purchase bill, line by line, through
// the line links: a bill line drawn from a GRN line (itself drawn from a PO line), or straight
// from a PO line. The service (tradeReports.threeWayMatch) loads the lines; this decides which are
// exceptions.
//
// Exceptions:
//  - rate_variance       a bill line's amount differs from the agreed one — the PO line's (else the
//                        GRN line's) value for the billed quantity — by more than BOTH tolerances:
//                        a share of the expected amount (basis points) and a flat amount (paise).
//  - qty_unbilled        a GRN line that has been billed in part: received − billed is more than the
//                        quantity tolerance (a share of the received quantity). A GRN with nothing
//                        billed yet is simply pending (Pending GRNs), not an exception.
//  - bill_without_grn    a bill line drawn straight from a PO line: billed with no receipt recorded.
//  - grn_without_po      a purchase GRN line drawn from no PO line (optional flag).
//  - unmatched_bill_line a bill line drawn from nothing (optional flag; off by default because most
//                        bills in a company without orders look like this).
// Capacity (I1) means a bill can never take more than the GRN line holds, so over-billing is not
// an exception here — the save refuses it.

export type MatchException = 'rate_variance' | 'qty_unbilled' | 'bill_without_grn' | 'grn_without_po' | 'unmatched_bill_line'

export const MATCH_EXCEPTIONS: readonly MatchException[] = [
  'rate_variance', 'qty_unbilled', 'bill_without_grn', 'grn_without_po', 'unmatched_bill_line'
]

export const MATCH_EXCEPTION_LABELS: Record<MatchException, string> = {
  rate_variance: 'Rate / amount differs',
  qty_unbilled: 'Received, billed in part',
  bill_without_grn: 'Billed without a GRN',
  grn_without_po: 'GRN without a PO',
  unmatched_bill_line: 'Bill line with no PO / GRN'
}

export interface MatchTolerances {
  /** Rate tolerance as basis points of the expected amount (100 = 1 %). */
  rateTolBp: number
  /** Flat amount tolerance in paise (rounding). */
  amountTolPaise: number
  /** Quantity tolerance as basis points of the received quantity. */
  qtyTolBp: number
  flagGrnWithoutPo: boolean
  flagUnmatchedBills: boolean
}

export const DEFAULT_MATCH_TOLERANCES: MatchTolerances = {
  rateTolBp: 0, amountTolPaise: 100, qtyTolBp: 0, flagGrnWithoutPo: true, flagUnmatchedBills: false
}

export type MatchStage = 'po' | 'grn' | 'bill'

export interface MatchLineRef {
  voucherId: number | null
  tradeDocId: number | null
  number: string
  date: string
  lineUid: string
  qtyMilli: number
  ratePaise: number
  amount: number
}

export interface MatchInputLine extends MatchLineRef {
  stage: MatchStage
  partyLedgerId: number | null
  partyName: string | null
  stockItemId: number
  itemName: string
  decimals: number
  /** The line this one is drawn from (fulfil link), null = none. */
  sourceUid: string | null
  /** Only anchor lines (dated in the report period) raise exceptions; the rest are references. */
  anchor: boolean
}

export interface MatchRow {
  key: string
  exception: MatchException
  partyLedgerId: number | null
  partyName: string | null
  stockItemId: number
  itemName: string
  decimals: number
  po: MatchLineRef | null
  grn: MatchLineRef | null
  bill: MatchLineRef | null
  /** The line the exception is about (bill line, else GRN line) — its date sorts the report. */
  date: string
  /** Expected (agreed) amount for the billed quantity; null when there is nothing to compare. */
  expectedPaise: number | null
  /** What the bill (or the unbilled share of the GRN) says. */
  actualPaise: number
  /** actual − expected for a variance; the value concerned otherwise. */
  diffPaise: number
  /** Quantity concerned (unbilled qty, or the billed qty without a GRN). */
  diffQtyMilli: number
  /** diff ÷ expected in basis points (rate variance only). */
  diffBp: number | null
}

const ref = (l: MatchInputLine): MatchLineRef => ({
  voucherId: l.voucherId, tradeDocId: l.tradeDocId, number: l.number, date: l.date, lineUid: l.lineUid,
  qtyMilli: l.qtyMilli, ratePaise: l.ratePaise, amount: l.amount
})

/** The source line's value for `qtyMilli` of it (pro rata of its stored amount). */
export function expectedAmount(source: { qtyMilli: number; amount: number }, qtyMilli: number): number {
  if (source.qtyMilli <= 0) return 0
  return qtyMilli === source.qtyMilli ? source.amount : Math.round((source.amount * qtyMilli) / source.qtyMilli)
}

/** Beyond tolerance: more than both the share and the flat amount. */
export function beyondTolerance(diff: number, expected: number, tol: Pick<MatchTolerances, 'rateTolBp' | 'amountTolPaise'>): boolean {
  const d = Math.abs(diff)
  if (d === 0) return false
  return d > tol.amountTolPaise && d * 10_000 > tol.rateTolBp * Math.abs(expected)
}

export function threeWayMatch(lines: readonly MatchInputLine[], tol: MatchTolerances = DEFAULT_MATCH_TOLERANCES): MatchRow[] {
  const byUid = new Map(lines.map((l) => [l.lineUid, l]))
  const billedByGrn = new Map<string, number>()
  for (const l of lines) {
    if (l.stage !== 'bill' || !l.sourceUid) continue
    const src = byUid.get(l.sourceUid)
    if (src?.stage === 'grn') billedByGrn.set(src.lineUid, (billedByGrn.get(src.lineUid) ?? 0) + l.qtyMilli)
  }
  const out: MatchRow[] = []
  const base = (l: MatchInputLine) => ({
    partyLedgerId: l.partyLedgerId, partyName: l.partyName, stockItemId: l.stockItemId, itemName: l.itemName, decimals: l.decimals, date: l.date
  })
  for (const l of lines) {
    if (!l.anchor) continue
    if (l.stage === 'bill') {
      const src = l.sourceUid ? byUid.get(l.sourceUid) ?? null : null
      if (!src) {
        if (tol.flagUnmatchedBills && !l.sourceUid) {
          out.push({
            key: `${l.lineUid}:unmatched`, exception: 'unmatched_bill_line', ...base(l), po: null, grn: null, bill: ref(l),
            expectedPaise: null, actualPaise: l.amount, diffPaise: l.amount, diffQtyMilli: l.qtyMilli, diffBp: null
          })
        }
        continue
      }
      const grn = src.stage === 'grn' ? src : null
      const po = src.stage === 'po' ? src : grn?.sourceUid ? (byUid.get(grn.sourceUid) ?? null) : null
      const poLine = po?.stage === 'po' ? po : null
      if (!grn && poLine) {
        out.push({
          key: `${l.lineUid}:nogrn`, exception: 'bill_without_grn', ...base(l), po: ref(poLine), grn: null, bill: ref(l),
          expectedPaise: null, actualPaise: l.amount, diffPaise: l.amount, diffQtyMilli: l.qtyMilli, diffBp: null
        })
      }
      // The agreed price is the order's; without an order, the GRN's.
      const agreed = poLine ?? grn
      if (agreed) {
        const expected = expectedAmount(agreed, l.qtyMilli)
        const diff = l.amount - expected
        if (beyondTolerance(diff, expected, tol)) {
          out.push({
            key: `${l.lineUid}:rate`, exception: 'rate_variance', ...base(l), po: poLine ? ref(poLine) : null, grn: grn ? ref(grn) : null,
            bill: ref(l), expectedPaise: expected, actualPaise: l.amount, diffPaise: diff, diffQtyMilli: 0,
            diffBp: expected !== 0 ? Math.round((diff * 10_000) / expected) : null
          })
        }
      }
    } else if (l.stage === 'grn') {
      const po = l.sourceUid ? byUid.get(l.sourceUid) ?? null : null
      const poLine = po?.stage === 'po' ? po : null
      if (!poLine && tol.flagGrnWithoutPo) {
        out.push({
          key: `${l.lineUid}:nopo`, exception: 'grn_without_po', ...base(l), po: null, grn: ref(l), bill: null,
          expectedPaise: null, actualPaise: l.amount, diffPaise: l.amount, diffQtyMilli: l.qtyMilli, diffBp: null
        })
      }
      const billed = billedByGrn.get(l.lineUid) ?? 0
      const unbilled = l.qtyMilli - billed
      if (billed > 0 && unbilled > 0 && unbilled * 10_000 > tol.qtyTolBp * l.qtyMilli) {
        const value = expectedAmount(l, unbilled)
        out.push({
          key: `${l.lineUid}:unbilled`, exception: 'qty_unbilled', ...base(l), po: poLine ? ref(poLine) : null, grn: ref(l), bill: null,
          expectedPaise: null, actualPaise: value, diffPaise: value, diffQtyMilli: unbilled, diffBp: null
        })
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key))
}
