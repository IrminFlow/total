/**
 * TDS eligibility (WP 3.2) — which vouchers SHOULD carry a deduction, the aggregate-threshold
 * walk over every qualifying credit/payment to a party, and the pure line arithmetic of adding a
 * deduction to (or removing it from) a saved voucher. No I/O: main supplies vouchers and ledger
 * facts, this decides.
 *
 * WHEN TDS IS DUE — "at the time of credit of such sum to the account of the payee or at the
 * time of payment thereof ..., whichever is earlier": Income-tax Act 1961 s.194C(1) (same words
 * in ss.194H, 194-I, 194J; https://www.incometaxindia.gov.in/w/section-194c, accessed
 * 2026-10-07); Income-tax Act 2025 s.393(1) (the Table's "time of deduction" — "credit ... or
 * payment, whichever is earlier"; [ACT25-FA26] in migration 020). Modelled as:
 *
 *  - a CREDIT event: a purchase or journal crediting the party (the bill is booked);
 *  - a PAYMENT event: a payment debiting the party. It is a TDS event only for its ADVANCE part
 *    (what is paid beyond what has been credited so far this year) — a payment that settles a
 *    bill already credited is not a second taxable sum. A payment that itself carries a
 *    deduction covers earlier credits that were not deducted at bill time (oldest first); any
 *    excess counts as an advance. Advances counted as events reduce the base of later credits
 *    (the same sum is never counted twice).
 *
 * THRESHOLDS: every event base counts towards the party × section aggregate for the period
 * (FY, or month for 194-I), whether or not TDS was deducted on it — the aggregate tests in
 * ss.194C(5)/194J/194H etc. are on "the aggregate of the amounts credited or paid", not on the
 * deductions booked (this fixes WP 3.1's priorBase, which only summed recorded entries). When
 * an event lifts the aggregate past the aggregate threshold, the earlier below-threshold events
 * of the same period become liable too ("aggregate crossed later") — except for excess-only
 * rows (194Q: only the amount above Rs 50 lakh is liable).
 *
 * BASE: a credit's base is its taxable value — debits to non-tax ledgers (GST shown separately
 * is excluded: CBDT Circular 23/2017, cited in InvoiceEntry since WP 3.1). When the section
 * comes from the debited expense ledger's default, the base is just the debits to ledgers with
 * that default. A payment/advance's base is the amount paid (an advance carries no invoice to
 * separate GST from). Purchase returns (debit notes) do not reduce the aggregate — simplification,
 * listed in the WP 3.2 report.
 */
import type { VoucherKind } from './domain'
import { taxableBase, thresholdPeriod, thresholdStatus, type TdsRateRow } from './tds'

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

export interface TdsLedgerFacts {
  /** Sundry Creditors tree, or flagged for a section — a possible deductee. */
  isDeducteeCandidate: boolean
  /** Party's own TDS section (ledgers.tds_section_id). */
  tdsSectionId: number | null
  /** Deductee type set or readable off the PAN (the expense-default route needs one). */
  deducteeKnown: boolean
  /** Expense ledger default section (ledgers.tds_default_section_id). */
  defaultSectionId: number | null
  /** GST tax ledger (tax_type set). */
  isTax: boolean
  isTdsPayable: boolean
  isCashBank: boolean
}

export interface ClassifyLine {
  ledgerId: number
  drCr: 'dr' | 'cr'
  amount: number
}

export type TdsEventKind = 'credit' | 'payment'

export interface TdsVoucherClass {
  eventKind: TdsEventKind
  partyLedgerId: number
  /** null = a payment to a party with no section of its own (joins the section its credits use). */
  sectionId: number | null
  sectionFrom: 'party' | 'ledger' | 'credits'
  /** Base for TDS, paise (taxable value of a credit; amount paid for a payment). */
  basePaise: number
  /** Gross amount owed/paid to the party before any deduction, paise. */
  grossPaise: number
  /** The expense ledger debited with the most (credits), for display / the suggestion. */
  expenseLedgerId: number | null
}

/** Kinds that can carry a TDS deduction made by us as the payer. */
export const TDS_CREDIT_KINDS: readonly VoucherKind[] = ['purchase', 'journal']
export const TDS_KINDS: readonly VoucherKind[] = ['purchase', 'journal', 'payment']

/**
 * What a voucher means for TDS: a credit to or payment of a deductee, with its base — or null
 * when it carries no TDS event (no deductee, no section, nothing taxable). `sectionOverride`
 * forces a section (the Eligible tab's / banner's section choice).
 */
export function classifyTdsVoucher(
  v: { kind: VoucherKind; partyLedgerId: number | null; lines: readonly ClassifyLine[] },
  facts: (ledgerId: number) => TdsLedgerFacts | null,
  sectionOverride?: number | null
): TdsVoucherClass | null {
  if (!TDS_KINDS.includes(v.kind)) return null
  const side: 'dr' | 'cr' = v.kind === 'payment' ? 'dr' : 'cr'
  const partyOf = (): number | null => {
    const candidates = new Set<number>()
    for (const l of v.lines) {
      if (l.drCr !== side) continue
      const f = facts(l.ledgerId)
      if (f && f.isDeducteeCandidate && !f.isTax && !f.isTdsPayable && !f.isCashBank) candidates.add(l.ledgerId)
    }
    if (v.partyLedgerId != null && candidates.has(v.partyLedgerId)) return v.partyLedgerId
    return candidates.size === 1 ? [...candidates][0]! : null
  }
  const party = partyOf()
  if (party == null) return null
  const pf = facts(party)
  if (!pf) return null
  const partyLines = v.lines.filter((l) => l.drCr === side && l.ledgerId === party)
  const partyAmount = partyLines.reduce((s, l) => s + l.amount, 0)

  if (v.kind === 'payment') {
    if (partyAmount <= 0) return null
    return {
      eventKind: 'payment', partyLedgerId: party, sectionId: sectionOverride ?? pf.tdsSectionId,
      sectionFrom: sectionOverride != null || pf.tdsSectionId != null ? 'party' : 'credits',
      basePaise: partyAmount, grossPaise: partyAmount, expenseLedgerId: null
    }
  }

  const payableCredits = v.lines.filter((l) => l.drCr === 'cr' && facts(l.ledgerId)?.isTdsPayable).reduce((s, l) => s + l.amount, 0)
  const grossPaise = partyAmount + payableCredits
  const debits = v.lines.filter((l) => {
    if (l.drCr !== 'dr' || l.ledgerId === party) return false
    const f = facts(l.ledgerId)
    return !!f && !f.isTax && !f.isTdsPayable && !f.isCashBank
  })
  const largest = (ls: readonly ClassifyLine[]): number | null =>
    ls.length === 0 ? null : [...ls].sort((a, b) => b.amount - a.amount)[0]!.ledgerId
  const byDefault = new Map<number, ClassifyLine[]>()
  for (const l of debits) {
    const s = facts(l.ledgerId)?.defaultSectionId
    if (s != null) byDefault.set(s, [...(byDefault.get(s) ?? []), l])
  }
  const sum = (ls: readonly ClassifyLine[]): number => ls.reduce((s, l) => s + l.amount, 0)

  let sectionId: number | null = null
  let sectionFrom: TdsVoucherClass['sectionFrom'] = 'party'
  let baseLines: ClassifyLine[] = debits
  if (sectionOverride != null) {
    sectionId = sectionOverride
    const own = byDefault.get(sectionOverride)
    if (own && sectionOverride !== pf.tdsSectionId) {
      baseLines = own
      sectionFrom = 'ledger'
    }
  } else if (pf.tdsSectionId != null) {
    sectionId = pf.tdsSectionId
  } else if (pf.deducteeKnown && byDefault.size > 0) {
    const [s, ls] = [...byDefault.entries()].sort((a, b) => sum(b[1]) - sum(a[1]) || a[0] - b[0])[0]!
    sectionId = s
    baseLines = ls
    sectionFrom = 'ledger'
  }
  if (sectionId == null) return null
  const basePaise = sum(baseLines)
  if (basePaise <= 0 || grossPaise <= 0) return null
  return { eventKind: 'credit', partyLedgerId: party, sectionId, sectionFrom, basePaise, grossPaise, expenseLedgerId: largest(baseLines) }
}

/** Candidate sections for a voucher (the banner's / Eligible tab's choice): the party's own,
 *  then each debited ledger's default. */
export function candidateSections(
  v: { kind: VoucherKind; lines: readonly ClassifyLine[] },
  partyLedgerId: number,
  facts: (ledgerId: number) => TdsLedgerFacts | null
): { sectionId: number; from: 'party' | 'ledger' }[] {
  const out: { sectionId: number; from: 'party' | 'ledger' }[] = []
  const own = facts(partyLedgerId)?.tdsSectionId
  if (own != null) out.push({ sectionId: own, from: 'party' })
  for (const l of v.lines) {
    if (l.drCr !== 'dr') continue
    const s = facts(l.ledgerId)?.defaultSectionId
    if (s != null && !out.some((c) => c.sectionId === s)) out.push({ sectionId: s, from: 'ledger' })
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// The aggregate walk
// ---------------------------------------------------------------------------------------------

export interface WalkEvent {
  voucherId: number
  date: string
  kind: TdsEventKind
  basePaise: number
  grossPaise: number
  /** Base of the tds_entry this voucher carries for this party/section, or null. */
  entryBasePaise: number | null
  /** "Not applicable" (tds_exemptions): no event at all. */
  exempt: boolean
}

export type EligibleReason = 'single' | 'aggregate' | 'aggregate_later' | 'none' | 'advance'

export interface WalkResult {
  voucherId: number
  date: string
  kind: TdsEventKind
  /** Base this event adds to the period aggregate. */
  eventBasePaise: number
  /** Aggregate of earlier events in the same threshold period. */
  priorPaise: number
  /** Rate row in force (null = no rate on the date: never eligible). */
  row: TdsRateRow | null
  deducted: boolean
  exempt: boolean
  /** Liable for TDS and not deducted (credit events: after later payment-deductions covered
   *  part of it). 0 = nothing to deduct. */
  eligibleBasePaise: number
  reason: EligibleReason | null
}

/**
 * Walk one party × section's events of a financial year in order (date, then voucher id) and
 * decide which are liable and undeducted. `rowOn(date)` is the rate row in force for this
 * deductee (thresholds and basis come from it).
 */
export function walkTdsEvents(events: readonly WalkEvent[], rowOn: (dateISO: string) => TdsRateRow | null): WalkResult[] {
  const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date) || a.voucherId - b.voucherId)
  const aggregate = new Map<string, number>()
  const results: WalkResult[] = []
  // Undeducted credit events, oldest first, with what is still uncovered.
  const pending: { idx: number; remaining: number }[] = []
  // Below-threshold, undeducted events per period (become liable when the aggregate is crossed).
  const below = new Map<string, number[]>()
  let credited = 0
  let paid = 0
  let advanceBank = 0

  for (const e of sorted) {
    const row = rowOn(e.date)
    const base: WalkResult = {
      voucherId: e.voucherId, date: e.date, kind: e.kind, eventBasePaise: 0, priorPaise: 0, row,
      deducted: e.entryBasePaise != null, exempt: e.exempt, eligibleBasePaise: 0, reason: null
    }
    if (e.kind === 'credit') credited += e.grossPaise
    else paid += e.grossPaise
    if (e.exempt) {
      results.push(base)
      continue
    }
    let eventBase: number
    if (e.kind === 'credit') {
      const consumed = Math.min(advanceBank, e.basePaise)
      advanceBank -= consumed
      eventBase = e.entryBasePaise ?? e.basePaise - consumed
    } else if (e.entryBasePaise != null) {
      // A deduction on payment covers earlier undeducted credits first; the rest is an advance.
      let left = e.entryBasePaise
      for (const p of pending) {
        if (left <= 0) break
        const take = Math.min(p.remaining, left)
        p.remaining -= take
        left -= take
      }
      eventBase = left
      advanceBank += left
    } else {
      eventBase = Math.min(e.grossPaise, Math.max(0, paid - credited))
      advanceBank += eventBase
    }
    const idx = results.length
    const periodKey = row ? thresholdPeriod(row.thresholdBasis, e.date).from : e.date.slice(0, 4)
    const prior = aggregate.get(periodKey) ?? 0
    aggregate.set(periodKey, prior + eventBase)
    const r: WalkResult = { ...base, eventBasePaise: eventBase, priorPaise: prior }
    results.push(r)
    if (!row || eventBase <= 0 || e.entryBasePaise != null) continue

    const status = thresholdStatus(row, e.date, eventBase, prior)
    if (status.crossed) {
      const liable = taxableBase(row, eventBase, prior)
      if (liable > 0) {
        r.eligibleBasePaise = liable
        r.reason = e.kind === 'payment' ? 'advance' : status.reason === 'below' ? null : status.reason
      }
      if (status.reason === 'aggregate' && !row.thresholdExcessOnly && prior <= row.thresholdAnnualPaise) {
        for (const j of below.get(periodKey) ?? []) {
          const earlier = results[j]!
          earlier.eligibleBasePaise = earlier.eventBasePaise
          earlier.reason = 'aggregate_later'
        }
        below.delete(periodKey)
      }
    } else {
      below.set(periodKey, [...(below.get(periodKey) ?? []), idx])
    }
    if (e.kind === 'credit') pending.push({ idx, remaining: eventBase })
  }
  // Coverage by later payment-deductions reduces what a credit still needs.
  for (const p of pending) {
    const r = results[p.idx]!
    if (r.eligibleBasePaise > 0) r.eligibleBasePaise = Math.min(r.eligibleBasePaise, p.remaining)
    if (r.eligibleBasePaise <= 0) {
      r.eligibleBasePaise = 0
      if (r.reason !== null && p.remaining < r.eventBasePaise) r.reason = null
    }
  }
  return results
}

/** Aggregate of the events before `date` (same-date events with a lower voucher id count too),
 *  in the threshold period of `date` — the prior base the rate table's thresholds compare with. */
export function priorAggregate(results: readonly WalkResult[], basis: 'fy' | 'month', dateISO: string, voucherId?: number): number {
  const period = thresholdPeriod(basis, dateISO)
  return results
    .filter((r) => r.date >= period.from && r.date <= period.to)
    .filter((r) => r.date < dateISO || (r.date === dateISO && voucherId != null && r.voucherId < voucherId) || (r.date === dateISO && voucherId == null))
    .filter((r) => r.voucherId !== voucherId)
    .reduce((s, r) => s + r.eventBasePaise, 0)
}

/** Credits up to `dateISO` still liable and undeducted (the payment banner's "deduct now"). */
export function undeductedCreditsBefore(results: readonly WalkResult[], dateISO: string, excludeVoucherId?: number): number {
  return results
    .filter((r) => r.kind === 'credit' && r.date <= dateISO && r.voucherId !== excludeVoucherId)
    .reduce((s, r) => s + r.eligibleBasePaise, 0)
}

// ---------------------------------------------------------------------------------------------
// Line edits: add / remove a deduction on a saved voucher (tds:applyToVoucher / removeFromVoucher)
// ---------------------------------------------------------------------------------------------

export interface EditLine {
  ledgerId: number
  drCr: 'dr' | 'cr'
  amount: number
  costAllocations?: { costCentreId: number; amount: number }[]
}
export interface EditBillRef {
  kind: 'new' | 'against'
  name: string
  amount: number
  dueDate: string | null
}

export type TdsLineEdit<L extends EditLine, B extends EditBillRef> =
  | { ok: true; lines: L[]; billRefs: B[]; targetLedgerId: number }
  | { ok: false; error: string }

/**
 * Which line gives up (or gets back) the deduction — THE RULE PER KIND:
 *  - purchase / journal: the party's credit (the supplier is owed the bill less TDS:
 *    Dr Expense 50,000 / Cr Supplier 49,000 / Cr TDS Payable 1,000);
 *  - payment: the bank / cash credit (the party is settled in full, the bank pays the net:
 *    Dr Supplier 50,000 / Cr Bank 49,000 / Cr TDS Payable 1,000 — WP 3.1's payment exemption).
 * The largest such line when there are several. The payable credit itself is appended LAST
 * (saveVoucher's tds.autoPayable), which is where invoice mode expects it.
 */
export function tdsTargetIndex(
  kind: VoucherKind,
  lines: readonly EditLine[],
  partyLedgerId: number,
  isCashBank: (ledgerId: number) => boolean
): number {
  let best = -1
  lines.forEach((l, i) => {
    if (l.drCr !== 'cr') return
    const hit = kind === 'payment' ? isCashBank(l.ledgerId) : l.ledgerId === partyLedgerId
    if (hit && (best === -1 || l.amount > lines[best]!.amount)) best = i
  })
  return best
}

/** The party's 'new' bill refs total the party credit — move the deduction through the last one
 *  big enough (credit kinds only; a payment's 'against' refs settle the gross). */
function adjustBillRefs<B extends EditBillRef>(refs: readonly B[], partyAmountBefore: number, delta: number): B[] | null {
  const news = refs.map((r, i) => ({ r, i })).filter((x) => x.r.kind === 'new')
  const total = refs.reduce((s, r) => s + r.amount, 0)
  if (news.length === 0 || total !== partyAmountBefore) return [...refs]
  for (let k = news.length - 1; k >= 0; k--) {
    const { r, i } = news[k]!
    if (r.amount + delta > 0) return refs.map((x, j) => (j === i ? { ...x, amount: x.amount + delta } : x))
  }
  return null
}

export function addTdsToLines<L extends EditLine, B extends EditBillRef>(
  kind: VoucherKind,
  lines: readonly L[],
  billRefs: readonly B[],
  opts: { partyLedgerId: number; tdsPaise: number; isCashBank: (ledgerId: number) => boolean }
): TdsLineEdit<L, B> {
  if (!TDS_KINDS.includes(kind)) return { ok: false, error: `A ${kind.replace('_', ' ')} voucher can't carry a TDS deduction` }
  const idx = tdsTargetIndex(kind, lines, opts.partyLedgerId, opts.isCashBank)
  if (idx === -1) {
    return {
      ok: false,
      error: kind === 'payment' ? 'The payment has no bank or cash credit to reduce' : "The voucher doesn't credit the party"
    }
  }
  const target = lines[idx]!
  if (target.amount <= opts.tdsPaise) return { ok: false, error: 'The TDS is not less than the line it comes out of' }
  if ((target.costAllocations ?? []).length > 0) {
    return { ok: false, error: 'The line the TDS comes out of has cost-centre allocations — add the deduction in the voucher editor' }
  }
  const nextLines = lines.map((l, i) => (i === idx ? { ...l, amount: l.amount - opts.tdsPaise } : { ...l }))
  let refs: B[] = [...billRefs]
  if (kind !== 'payment') {
    const adjusted = adjustBillRefs(billRefs, partyAmount(lines, opts.partyLedgerId), -opts.tdsPaise)
    if (!adjusted) return { ok: false, error: "The party's bill references can't absorb the deduction — add it in the voucher editor" }
    refs = adjusted
  }
  return { ok: true, lines: nextLines, billRefs: refs, targetLedgerId: target.ledgerId }
}

/** Remove the deduction: drop the credits to the section's payable ledger(s) and give the amount
 *  back to the same target line the add rule uses. */
export function removeTdsFromLines<L extends EditLine, B extends EditBillRef>(
  kind: VoucherKind,
  lines: readonly L[],
  billRefs: readonly B[],
  opts: { partyLedgerId: number; isPayableLine: (l: L) => boolean; isCashBank: (ledgerId: number) => boolean }
): TdsLineEdit<L, B> & { restoredPaise?: number } {
  const payable = lines.filter((l) => l.drCr === 'cr' && opts.isPayableLine(l))
  if (payable.length === 0) return { ok: false, error: "The voucher's TDS payable credit can't be found — remove the deduction in the voucher editor" }
  const restored = payable.reduce((s, l) => s + l.amount, 0)
  const kept = lines.filter((l) => !(l.drCr === 'cr' && opts.isPayableLine(l)))
  const idx = tdsTargetIndex(kind, kept, opts.partyLedgerId, opts.isCashBank)
  if (idx === -1) return { ok: false, error: kind === 'payment' ? 'The payment has no bank or cash credit to restore' : "The voucher doesn't credit the party" }
  if ((kept[idx]!.costAllocations ?? []).length > 0) {
    return { ok: false, error: 'The line the TDS returns to has cost-centre allocations — remove the deduction in the voucher editor' }
  }
  const before = partyAmount(kept, opts.partyLedgerId)
  const nextLines = kept.map((l, i) => (i === idx ? { ...l, amount: l.amount + restored } : { ...l }))
  let refs: B[] = [...billRefs]
  if (kind !== 'payment') refs = adjustBillRefs(billRefs, before, restored) ?? [...billRefs]
  return { ok: true, lines: nextLines, billRefs: refs, targetLedgerId: kept[idx]!.ledgerId, restoredPaise: restored }
}

const partyAmount = (lines: readonly EditLine[], partyLedgerId: number): number =>
  lines.filter((l) => l.drCr === 'cr' && l.ledgerId === partyLedgerId).reduce((s, l) => s + l.amount, 0)

export const ELIGIBLE_REASON_LABELS: Record<EligibleReason, string> = {
  single: 'Single payment above the limit',
  aggregate: 'Aggregate crossed on this voucher',
  aggregate_later: 'Aggregate crossed later in the year',
  none: 'Section has no threshold',
  advance: 'Advance payment (paid before the bill)'
}
