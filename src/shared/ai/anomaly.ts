/**
 * Anomaly watch: entries unlike anything in this company's history.
 *
 * Not a model. The question "is ₹4,50,000 a strange payment to this supplier?" is answered by
 * looking at what this company has paid that supplier before, and that is arithmetic — arithmetic
 * that must give the same answer twice, be explainable to the person whose entry got flagged, and
 * work with the assistant switched off. The assistant's use of this is to describe the findings,
 * not to produce them.
 *
 * The statistic is a median-absolute-deviation z-score rather than a mean and standard deviation,
 * because the input is small, skewed and full of the very outliers we are looking for. One
 * ₹50,00,000 capital purchase in a history of forty ₹20,000 invoices drags a mean far enough that
 * the next genuine outlier looks ordinary; the median does not move.
 *
 * Everything is a FLAG, never a block. The entries are already posted, the person who posted them
 * had a reason, and a bookkeeping tool that refuses entries because they are unusual is a tool
 * people stop using in exactly the month something unusual happens.
 */

/** One historical amount, as flat as the statistic needs it. */
export interface HistoryEntry {
  voucherId: number
  date: string
  voucherTypeId: number
  /** Null for a voucher with no party (a journal between two nominal accounts). */
  partyLedgerId: number | null
  /** Absolute value of the voucher, in paise. */
  amountPaise: number
}

export type AnomalyReason = 'amount-outlier' | 'first-time-party' | 'possible-duplicate' | 'round-number'

export interface AnomalyFinding {
  voucherId: number
  date: string
  amountPaise: number
  reasons: AnomalyReason[]
  /** 0-1, the highest single reason's confidence. Sorted on, never quoted as a probability. */
  score: number
  /** A sentence naming the comparison that produced the flag. */
  explanation: string
}

/** Minimum comparable history before an outlier claim means anything. */
export const MIN_SAMPLE = 6
/** MAD z-score past which an amount is called unusual. ~3.5 is the conventional cut. */
export const OUTLIER_Z = 3.5

function median(sorted: number[]): number {
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
}

/**
 * Median absolute deviation, scaled to be comparable with a standard deviation.
 *
 * 1.4826 is the constant that makes MAD an unbiased estimator of sigma for normal data. Kept as a
 * named constant because an unexplained 1.4826 in a codebase is a magic number people delete.
 */
const MAD_TO_SIGMA = 1.4826

export function madZScore(values: number[], value: number): number {
  if (values.length < MIN_SAMPLE) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const med = median(sorted)
  const deviations = sorted.map((v) => Math.abs(v - med)).sort((a, b) => a - b)
  const mad = median(deviations)
  // Every historical amount identical: any different value is unusual, an identical one is not.
  if (mad === 0) return value === med ? 0 : OUTLIER_Z + 1
  return Math.abs(value - med) / (mad * MAD_TO_SIGMA)
}

export interface AnomalyOptions {
  /** Anything at or below this is never flagged — a ₹200 outlier is noise, not a finding. */
  floorPaise?: number
  money: (paise: number) => string
}

/**
 * Score candidate entries against the history.
 *
 * Comparison is per (voucher type, party) where there is enough of it, falling back to voucher
 * type alone. A ₹5,00,000 sale is unremarkable in the sales book and remarkable for a party who
 * has never bought more than ₹20,000, and only the narrower comparison sees that.
 */
export function findAnomalies(
  history: HistoryEntry[],
  candidates: HistoryEntry[],
  opts: AnomalyOptions
): AnomalyFinding[] {
  const floor = opts.floorPaise ?? 100_000 // ₹1,000
  const byParty = new Map<string, number[]>()
  const byType = new Map<number, number[]>()
  const partySeen = new Map<number, string>()

  for (const h of history) {
    byType.set(h.voucherTypeId, [...(byType.get(h.voucherTypeId) ?? []), h.amountPaise])
    if (h.partyLedgerId != null) {
      const key = `${h.voucherTypeId}:${h.partyLedgerId}`
      byParty.set(key, [...(byParty.get(key) ?? []), h.amountPaise])
      const first = partySeen.get(h.partyLedgerId)
      if (first == null || h.date < first) partySeen.set(h.partyLedgerId, h.date)
    }
  }

  // Same party, same amount, within a few days: the classic double entry of one invoice.
  const dupeKey = (e: HistoryEntry): string => `${e.partyLedgerId ?? 'none'}:${e.amountPaise}`
  const dupes = new Map<string, HistoryEntry[]>()
  for (const e of [...history, ...candidates]) {
    dupes.set(dupeKey(e), [...(dupes.get(dupeKey(e)) ?? []), e])
  }

  const findings: AnomalyFinding[] = []

  for (const c of candidates) {
    if (c.amountPaise <= floor) continue
    const reasons: AnomalyReason[] = []
    const notes: string[] = []
    let score = 0

    const partyKey = `${c.voucherTypeId}:${c.partyLedgerId}`
    const partyHistory = byParty.get(partyKey) ?? []
    const typeHistory = byType.get(c.voucherTypeId) ?? []
    const sample = partyHistory.length >= MIN_SAMPLE ? partyHistory : typeHistory
    const scope = partyHistory.length >= MIN_SAMPLE ? 'this party' : 'this voucher type'

    const z = madZScore(sample, c.amountPaise)
    if (z >= OUTLIER_Z) {
      reasons.push('amount-outlier')
      const typical = median([...sample].sort((a, b) => a - b))
      notes.push(
        `${opts.money(c.amountPaise)} against a typical ${opts.money(typical)} for ${scope} over ${sample.length} entries`
      )
      score = Math.max(score, Math.min(1, z / (OUTLIER_Z * 2)))
    }

    if (c.partyLedgerId != null && !partySeen.has(c.partyLedgerId)) {
      reasons.push('first-time-party')
      notes.push('the first entry ever for this party')
      score = Math.max(score, 0.5)
    }

    const near = (dupes.get(dupeKey(c)) ?? []).filter(
      (o) => o.voucherId !== c.voucherId && Math.abs(Date.parse(o.date) - Date.parse(c.date)) <= 3 * 86_400_000
    )
    if (near.length > 0) {
      reasons.push('possible-duplicate')
      notes.push(`the same amount to the same party on ${near.map((n) => n.date).join(', ')}`)
      score = Math.max(score, 0.7)
    }

    // A payment of exactly ₹5,00,000 is not suspicious by itself, which is why this only ever
    // joins an existing flag rather than raising one: it is context for a human, not a finding.
    if (reasons.length > 0 && c.amountPaise % 10_000_000 === 0) {
      reasons.push('round-number')
      notes.push('an exact round lakh')
    }

    if (reasons.length === 0) continue
    findings.push({
      voucherId: c.voucherId,
      date: c.date,
      amountPaise: c.amountPaise,
      reasons,
      score,
      explanation: `Flagged because of ${notes.join('; ')}.`
    })
  }

  return findings.sort((a, b) => b.score - a.score || b.amountPaise - a.amountPaise)
}
