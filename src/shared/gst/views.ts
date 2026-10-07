/**
 * IPC result shapes of the WP 3.4 GST-expansion services (shared so the renderer's typed client
 * can name them; the services in src/main/services/gst*.ts build them).
 */
import type { Gstr3bResult, InwardSummary } from './returns'
import type { Gst3bManualInput, } from '../schemas'
import type { Gstr9Result } from './gstr9'
import type { Itc04Periodicity, Itc04Period, Itc04Result } from './itc04'
import type { Heads, ItcReversalSummary, ProposalLine, Rule37Event, Rule42Result, Rule42TrueUp, Rule43Result } from './itcReversal'
import type { ItcReversalInputs } from './expansionSchemas'

/** GSTR-3B plus what the Circular 170 re-shaping folded in: the s.17(5) credit availed in 4(A)(5)
 *  and reversed in 4(B)(1), the 4(D)(1) reclaim, and the adjustments as entered. */
export interface Gstr3bView extends Gstr3bResult {
  circular170: {
    /** s.17(5) blocked credit (parties marked blocked) — in 4(A)(5) and 4(B)(1). */
    blocked: InwardSummary
    /** 4(D)(1) — reclaimed after a 4(B)(2) reversal; also in 4(A)(5). */
    reclaimed: InwardSummary
    /** The manual adjustments as entered (without the automatic s.17(5) reversal). */
    entered: Gst3bManualInput
  }
}

export interface Gstr9View extends Gstr9Result {
  fyStartYear: number
  from: string
  to: string
  dueDate: string
  /** Aggregate turnover of the year (income-group movement) — for the thresholds below. */
  turnover: number
  /** Notification 15/2025-CT: optional up to ₹2 crore (FY 2024-25 onwards). */
  optional: boolean
  /** Rule 80(3): GSTR-9C above ₹5 crore — out of scope here. */
  gstr9cApplies: boolean
}

export interface Itc04View {
  result: Itc04Result
  periodicity: Itc04Periodicity
  /** Derived from the preceding FY's aggregate turnover (rule 45(3) / Notification 35/2021-CT). */
  derivedPeriodicity: Itc04Periodicity
  precedingTurnover: number
  periods: Itc04Period[]
}

/** The ledger a proposal line posts to: an existing ledger, or one created at post time. */
export interface ProposalLedger {
  ledgerId: number | null
  name: string
  /** Group the ledger is created under when it doesn't exist yet. */
  group: string
}

export interface ProposalView extends ProposalLine {
  ledger: ProposalLedger
}

export interface ItcReversalView {
  period: string
  from: string
  to: string
  inputs: ItcReversalInputs
  rule42: Rule42Result & { T: Heads; T3: Heads }
  turnover: { E: number; F: number; borrowed: boolean }
  rule43: Rule43Result
  rule37: Rule37Event[]
  blocked: { voucherId: number; number: string; date: string; partyName: string | null; partyLedgerId: number | null; tax: Heads }[]
  trueUp: Rule42TrueUp
  summary: ItcReversalSummary
  proposal: ProposalView[]
  /** The journal already posted for the period (still in the books), if any. */
  posted: { voucherId: number; number: string } | null
  /** The period's 3B manual 4(B)/4(D)(1)/5.1 equal these workings. */
  applied: boolean
  /** Tax heads the proposal needs an input ledger for but none exists (created on post). */
  missingTaxLedgers: string[]
}
