/**
 * WP 6.5 — group consolidation types. Every amount is integer paise, signed dr-positive (the
 * app's convention): assets / expenses positive, liabilities / incomes negative. The engine
 * (engine.ts) is pure; the main-process service (services/consolidation.ts) reads each member
 * company's books read-only and hands the engine these shapes.
 */
import type { Nature } from '../domain'
import type { ConsolidationSourceId } from './sources'

export type { Nature }
export type MemberRole = 'parent' | 'subsidiary' | 'associate'
export type PairKind = 'receivable_payable' | 'sales_purchase' | 'loan' | 'other'
export type StatementKind = 'tb' | 'pnl' | 'bs'

export const PAIR_KINDS: readonly PairKind[] = ['receivable_payable', 'sales_purchase', 'loan', 'other']
export const MEMBER_ROLES: readonly MemberRole[] = ['parent', 'subsidiary', 'associate']

// ---------------------------------------------------------------- stored definition

export interface ConsolidationGroup {
  id: number
  name: string
  presentationCurrency: string
  /** Paise; a pair whose two sides differ by at most this is "reconciled". */
  icTolerance: number
  /** Default seller margin for unrealised profit in stock (basis points); null = off. */
  unrealisedMarginBp: number | null
  members: ConsolidationMember[]
  mappings: ConsolidationMapping[]
  pairs: IntercompanyPair[]
}

export interface ConsolidationMember {
  id: number
  companySlug: string
  role: MemberRole
  /** 10000 = 100 %. */
  ownershipBp: number
  acquiredOn: string | null
  includeFrom: string | null
  includeTo: string | null
  /** The parent's ledger (in the PARENT member's books) holding the cost of this investment. */
  investmentLedgerId: number | null
  /** Override: the member's total equity at acquisition (credit-positive paise). */
  acquisitionEquity: number | null
}

export interface ConsolidationMapping {
  id: number
  companySlug: string
  /** Exactly one of ledgerId / groupName. */
  ledgerId: number | null
  groupName: string | null
  targetName: string
  targetNature: Nature | null
}

export interface IntercompanyPair {
  id: number
  memberA: string
  ledgerAId: number
  memberB: string
  ledgerBId: number
  kind: PairKind
  /** Seller margin for unrealised profit on this pair (bp); null = the group's. */
  unrealisedMarginBp: number | null
}

// ---------------------------------------------------------------- engine input

export interface MemberLedger {
  id: number
  name: string
  groupName: string
  /** Ancestor groups, root first, ending with groupName. */
  groupPath: string[]
  nature: Nature
  gp: boolean
  /** Under Capital Account (incl. Reserves & Surplus). */
  equity: boolean
}

/** Computed (non-ledger) rows of the member statements; ids < 0 as the reports give them. */
export type ComputedCode = 'opening_stock' | 'closing_stock' | 'tb_stock_opening' | 'pnl_opening' | 'pnl_current' | 'opening_diff'

export interface MemberRow {
  /** The member's ledger id; < 0 for computed rows. */
  ledgerId: number
  name: string
  groupName: string
  nature: Nature
  gp: boolean
  /** Dr-positive paise. */
  amount: number
  equity: boolean
  computed?: ComputedCode
}

export interface MemberFlow {
  ledgerId: number
  amount: number
}

export interface MemberInput {
  slug: string
  name: string
  role: MemberRole
  ownershipBp: number
  /** False when the member is not part of this statement (not a member on the date / no overlap / skipped). */
  included: boolean
  ledgers: MemberLedger[]
  rows: MemberRow[]
  /** Net profit (credit-positive: profit > 0) of the statement's P&L window. */
  periodProfit: number
  /** Total equity on the reporting date, credit-positive (BS basis: capital + reserves + P&L A/c). */
  equityNow: number
  /** Total equity at acquisition, credit-positive; null = unknown. */
  acquisitionEquity: number | null
  /** Closing stock value on the reporting date and trading purchases of the window (for UPS). */
  closingStock: number
  purchases: number
  investmentLedgerId: number | null
}

export interface PairInput {
  id: number
  kind: PairKind
  a: { slug: string; ledgerId: number }
  b: { slug: string; ledgerId: number }
  /** Party-derived P&L flows of the statement window (sales_purchase / loan pairs on party ledgers). */
  flowsA?: MemberFlow[]
  flowsB?: MemberFlow[]
  unrealisedMarginBp: number | null
}

export interface StatementInput {
  kind: StatementKind
  members: MemberInput[]
  pairs: PairInput[]
  mappings: Omit<ConsolidationMapping, 'id'>[]
  icTolerance: number
  unrealisedMarginBp: number | null
}

// ---------------------------------------------------------------- engine output

export type LineSection =
  | 'asset' | 'liability' | 'income' | 'expense'
  | 'opening_stock' | 'trading_expense' | 'trading_income' | 'closing_stock' | 'indirect_expense' | 'indirect_income'
  | 'appropriation'

export interface SourceRef {
  slug: string
  ledgerId: number
  name: string
  groupName: string
  amount: number
}

export interface ConsolLine {
  key: string
  name: string
  nature: Nature
  gp: boolean
  section: LineSection
  /** One cell per statement member (StatementResult.members order). */
  perMember: number[]
  elimination: number
  consolidated: number
  /** Drill-down: every member row that makes up the line. */
  sources: SourceRef[]
  eliminationIds: string[]
  /** A line the engine creates (goodwill, minority interest, unreconciled …). */
  special: boolean
}

export type EliminationRule =
  | 'ic_balance' | 'ic_flow' | 'unrealised_profit' | 'investment' | 'minority_interest' | 'minority_profit' | 'associate'

export interface EliminationPosting {
  lineKey: string
  lineName: string
  /** Member whose books the posting refers to; null for group-only lines. */
  slug: string | null
  ledgerId: number | null
  ledgerName: string | null
  amount: number
}

export interface Elimination {
  id: string
  rule: EliminationRule
  title: string
  detail: string
  source: ConsolidationSourceId
  pairId?: number
  memberSlug?: string
  status?: 'reconciled' | 'unreconciled'
  postings: EliminationPosting[]
}

export interface PairResult {
  pairId: number
  kind: PairKind
  basis: 'balance' | 'flow'
  a: { slug: string; ledgerId: number; ledgerName: string; amount: number }
  b: { slug: string; ledgerId: number; ledgerName: string; amount: number }
  /** a + b (dr-positive): 0 when the two sides agree. */
  difference: number
  status: 'reconciled' | 'unreconciled' | 'skipped'
  note?: string
}

export interface StatementResult {
  kind: StatementKind
  members: { slug: string; name: string; role: MemberRole; ownershipBp: number; included: boolean }[]
  lines: ConsolLine[]
  eliminations: Elimination[]
  pairs: PairResult[]
  totals: { perMember: number[]; elimination: number; consolidated: number }
  /** P&L: consolidated net profit (credit-positive), the minority share and the owners' share. */
  profit?: { perMember: number[]; netProfit: number; minorityInterest: number; ownersProfit: number }
  /** BS: totals by side (assets dr-positive, liabilities credit-positive). */
  balance?: { assets: number; liabilities: number }
  warnings: string[]
}

// ---------------------------------------------------------------- service result

export interface IcReconRow {
  pairId: number
  kind: PairKind
  memberA: string
  memberAName: string
  ledgerAId: number
  ledgerAName: string
  memberB: string
  memberBName: string
  ledgerBId: number
  ledgerBName: string
  /** Balances on the reporting date (dr-positive); null when the pair is not a balance pair. */
  balanceA: number | null
  balanceB: number | null
  difference: number | null
  status: 'reconciled' | 'unreconciled' | 'skipped' | 'n/a'
  /** Inter-company transactions of the period (dr-positive); null when not a flow pair. */
  flowA: number | null
  flowB: number | null
  flowDifference: number | null
  flowStatus: 'reconciled' | 'unreconciled' | 'skipped' | 'n/a'
  /** Ageing of each side's balance (AGEING_BUCKETS), signed. */
  ageingA: number[]
  ageingB: number[]
  note: string | null
}

export interface GroupRunResult {
  group: { id: number; name: string; presentationCurrency: string; icTolerance: number; unrealisedMarginBp: number | null }
  period: { from: string; to: string }
  /** The open company's slug — only its ledger ids can be opened from here. */
  openSlug: string | null
  tb: StatementResult
  pnl: StatementResult
  bs: StatementResult
  recon: IcReconRow[]
  warnings: string[]
  /** Same group for the period one year earlier (consolidated column by line key). */
  prior?: {
    period: { from: string; to: string }
    tb: Record<string, number>
    pnl: Record<string, number>
    bs: Record<string, number>
    netProfit: number
    ownersProfit: number
  }
}

/** A member's chart for the mapping / pair pickers (read from its books, read-only). */
export interface MemberChart {
  slug: string
  name: string
  available: boolean
  warning: string | null
  gstin: string | null
  pan: string | null
  ledgers: { id: number; name: string; groupName: string; nature: Nature; gstin: string | null; pan: string | null }[]
  groups: { name: string; nature: Nature }[]
}
