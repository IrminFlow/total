/**
 * The collections desk: everything that happens between "we raised the bill" and "the money came".
 *
 * All of it is built on the same FIFO allocation the Outstandings report uses — interest, credit
 * scores, provisioning and the payment schedule all read `allocateBills`, so none of them can ever
 * disagree with the ageing report about what is open. Nothing in this file posts a voucher: the
 * bad-debt helper returns a *draft* the human saves, and the reminders return text the human sends.
 */
import type { DB } from '../db/connection'
import type { OutstandingBill } from '@shared/reports'
import {
  allocateBills,
  buildReminder,
  toneFor,
  type ReminderTone,
  type SettledBillRecord
} from '@shared/outstanding'
import { bandLabels, bucketByBand, DEFAULT_BAND_CUTS, normaliseBandCuts } from '@shared/ageing'
import { creditScore, type CreditScore } from '@shared/creditScore'
import { describeTerms, interestOnBills, type InterestResult, type InterestTerms } from '@shared/interest'
import { suggestAllocations, type AllocationSuggestion } from '@shared/allocationSuggest'
import { computeProvision, DEFAULT_PROVISION_POLICY, describePolicy, type ProvisionResult, type ProvisionRule } from '@shared/badDebt'
import { msmeReport, type MsmeReport, type MsmeStatus } from '@shared/msme'
import { cashBankGroupIds, descendantIdsByName } from './masters'
import { openingEvent, partyEventsBatch } from './analysis'
import { IN_BOOKS } from './vouchers'
import { getCollectionsPolicy, getFeatures } from './config'

interface PartyRow {
  id: number
  name: string
  opening_balance: number
  group_id: number
  credit_days: number | null
  credit_limit: number | null
  interest_rate_bp: number | null
  interest_grace_days: number | null
  msme_status: MsmeStatus | null
  udyam_number: string | null
  salesperson: string | null
  territory: string | null
  phone: string | null
  email: string | null
}

const PARTY_COLUMNS =
  'id, name, opening_balance, group_id, credit_days, credit_limit, interest_rate_bp, interest_grace_days, ' +
  'msme_status, udyam_number, salesperson, territory, phone, email'

function partyRows(db: DB, side: 'receivable' | 'payable', ids?: number[]): PartyRow[] {
  const groupIds = descendantIdsByName(db, [side === 'receivable' ? 'Sundry Debtors' : 'Sundry Creditors'])
  const rows = db.prepare(`SELECT ${PARTY_COLUMNS} FROM ledgers`).all() as PartyRow[]
  const wanted = ids ? new Set(ids) : null
  return rows.filter((l) => groupIds.has(l.group_id) && (wanted === null || wanted.has(l.id)))
}

/** Every party's allocation in one pass — the shared spine under every function below. */
function allocateAll(
  db: DB,
  side: 'receivable' | 'payable',
  asOn: string,
  ids?: number[]
): { party: PartyRow; bills: OutstandingBill[]; settled: SettledBillRecord[]; unappliedCredit: number }[] {
  const parties = partyRows(db, side, ids)
  if (parties.length === 0) return []
  const sign = side === 'receivable' ? 1 : -1
  const events = partyEventsBatch(db, parties.map((p) => p.id), asOn, sign)
  return parties.map((party) => {
    const list = [...openingEvent(asOn, party.opening_balance, sign), ...(events.get(party.id) ?? [])]
    const { bills, settled, unappliedCredit } = allocateBills(list, asOn, party.credit_days)
    return { party, bills, settled, unappliedCredit }
  })
}

/** A party's own terms, falling back to the company default and finally to charging nothing. */
export function termsFor(db: DB, party: { interest_rate_bp: number | null; interest_grace_days: number | null }): InterestTerms {
  const policy = getCollectionsPolicy(db)
  return {
    rateBp: party.interest_rate_bp ?? policy.interestRateBp,
    graceDays: party.interest_grace_days ?? policy.interestGraceDays
  }
}

// ---------- interest on overdue bills (#153) ----------

export interface PartyInterest {
  ledgerId: number
  name: string
  pending: number
  terms: InterestTerms
  termsLabel: string
  interest: InterestResult
}

/**
 * Interest due from every party with an overdue bill and a rate to charge.
 *
 * Parties on a zero rate are dropped rather than listed at ₹0: a business that charges interest
 * charges it to some customers, and the screen's job is the shortlist of conversations to have.
 */
export function interestDue(db: DB, side: 'receivable' | 'payable', asOn: string): PartyInterest[] {
  const out: PartyInterest[] = []
  for (const { party, bills } of allocateAll(db, side, asOn)) {
    const terms = termsFor(db, party)
    if (terms.rateBp <= 0 || bills.length === 0) continue
    const interest = interestOnBills(bills, terms)
    if (interest.total === 0) continue
    out.push({
      ledgerId: party.id,
      name: party.name,
      pending: bills.reduce((s, b) => s + b.pending, 0),
      terms,
      termsLabel: describeTerms(terms),
      interest
    })
  }
  return out.sort((a, b) => b.interest.total - a.interest.total)
}

// ---------- credit scoring (#159) ----------

export interface PartyCreditScore {
  ledgerId: number
  name: string
  score: CreditScore | null
  creditLimit: number | null
  pending: number
}

export function creditScores(db: DB, asOn: string, ids?: number[]): PartyCreditScore[] {
  return allocateAll(db, 'receivable', asOn, ids)
    .map(({ party, bills, settled }) => ({
      ledgerId: party.id,
      name: party.name,
      creditLimit: party.credit_limit,
      pending: bills.reduce((s, b) => s + b.pending, 0),
      score: creditScore(
        settled.map((s) => ({ amount: s.amount, daysLate: s.daysLate })),
        bills.map((b) => ({ amount: b.pending, overdueDays: b.overdueDays }))
      )
    }))
    // A party with no history and nothing open is not on the collections desk at all.
    .filter((r) => r.score !== null || r.pending > 0)
    .sort((a, b) => (a.score?.score ?? 101) - (b.score?.score ?? 101))
}

// ---------- allocation suggestions (#158) ----------

export function allocationSuggestions(
  db: DB,
  partyLedgerId: number,
  amount: number,
  asOn: string,
  side: 'receivable' | 'payable' = 'receivable'
): AllocationSuggestion[] {
  const row = allocateAll(db, side, asOn, [partyLedgerId])[0]
  if (!row) return []
  return suggestAllocations(row.bills, amount)
}

// ---------- ageing by salesperson or territory (#156) ----------

export type AgeingDimension = 'salesperson' | 'territory' | 'party'

export interface AgeingGroupRow {
  key: string
  pending: number
  billCount: number
  partyCount: number
  buckets: number[]
  worstOverdueDays: number
}

export interface AgeingByResult {
  dimension: AgeingDimension
  bandLabels: string[]
  rows: AgeingGroupRow[]
  total: number
  totals: number[]
}

const UNASSIGNED = 'Unassigned'

/**
 * Ageing grouped by whoever owns the relationship.
 *
 * "Unassigned" is a real row, not a hidden bucket: on most books it will start out as all of the
 * money, and seeing that is the nudge to fill the field in.
 */
export function ageingBy(
  db: DB,
  side: 'receivable' | 'payable',
  asOn: string,
  dimension: AgeingDimension,
  bandCuts: number[] = DEFAULT_BAND_CUTS
): AgeingByResult {
  const cuts = normaliseBandCuts(bandCuts)
  const groups = new Map<string, { bills: OutstandingBill[]; parties: Set<number> }>()
  for (const { party, bills } of allocateAll(db, side, asOn)) {
    if (bills.length === 0) continue
    const key =
      dimension === 'party' ? party.name : ((dimension === 'salesperson' ? party.salesperson : party.territory) || UNASSIGNED)
    const entry = groups.get(key) ?? { bills: [], parties: new Set<number>() }
    entry.bills.push(...bills)
    entry.parties.add(party.id)
    groups.set(key, entry)
  }

  const rows: AgeingGroupRow[] = [...groups.entries()]
    .map(([key, g]) => ({
      key,
      pending: g.bills.reduce((s, b) => s + b.pending, 0),
      billCount: g.bills.length,
      partyCount: g.parties.size,
      buckets: bucketByBand(g.bills, cuts),
      worstOverdueDays: g.bills.reduce((m, b) => Math.max(m, b.overdueDays), 0)
    }))
    .sort((a, b) => b.pending - a.pending)

  const totals = new Array<number>(cuts.length + 1).fill(0)
  for (const r of rows) r.buckets.forEach((v, i) => (totals[i] = (totals[i] as number) + v))
  return {
    dimension,
    bandLabels: bandLabels(cuts),
    rows,
    total: rows.reduce((s, r) => s + r.pending, 0),
    totals
  }
}

// ---------- bad-debt provisioning (#157) ----------

export function badDebtProvision(db: DB, asOn: string, policy: ProvisionRule[] = DEFAULT_PROVISION_POLICY): ProvisionResult {
  return computeProvision(
    allocateAll(db, 'receivable', asOn).map(({ party, bills }) => ({
      ledgerId: party.id,
      name: party.name,
      bills: bills.map((b) => ({ number: b.number, date: b.date, pending: b.pending, overdueDays: b.overdueDays }))
    })),
    policy
  )
}

export interface ProvisionDraft {
  date: string
  narration: string
  lines: { ledgerName: string; drCr: 'dr' | 'cr'; amount: number }[]
  total: number
  /** Ledgers the draft names that do not exist yet — the UI offers to create them. */
  missingLedgers: string[]
}

export const BAD_DEBT_EXPENSE_LEDGER = 'Provision for Doubtful Debts'
export const BAD_DEBT_RESERVE_LEDGER = 'Reserve for Doubtful Debts'

/**
 * A journal the human can look at before posting.
 *
 * One expense debit and one reserve credit, never a credit to the party itself: a provision is an
 * estimate against the receivable, not a write-off of it, and touching the party ledger would tell
 * the khata the customer no longer owes the money. They still do.
 */
export function provisionDraft(
  db: DB,
  asOn: string,
  policy: ProvisionRule[] = DEFAULT_PROVISION_POLICY
): ProvisionDraft | null {
  const result = badDebtProvision(db, asOn, policy)
  if (result.total === 0) return null
  const names = [BAD_DEBT_EXPENSE_LEDGER, BAD_DEBT_RESERVE_LEDGER]
  const existing = new Set(
    (db.prepare(`SELECT name FROM ledgers WHERE name IN (${names.map(() => '?').join(',')})`).all(...names) as {
      name: string
    }[]).map((r) => r.name)
  )
  return {
    date: asOn,
    narration: `Provision for doubtful debts as on ${asOn} (${describePolicy(policy)})`,
    lines: [
      { ledgerName: BAD_DEBT_EXPENSE_LEDGER, drCr: 'dr', amount: result.total },
      { ledgerName: BAD_DEBT_RESERVE_LEDGER, drCr: 'cr', amount: result.total }
    ],
    total: result.total,
    missingLedgers: names.filter((n) => !existing.has(n))
  }
}

// ---------- advances (#164) ----------

export interface AdvanceRow {
  ledgerId: number
  name: string
  /** Paise received (or paid) beyond what any open bill absorbs. */
  unapplied: number
  openBills: number
  lastReceiptDate: string | null
}

/**
 * Money on the account that no bill has claimed.
 *
 * This is the number that makes a customer angry: they paid an advance, the next invoice went out
 * showing the full amount, and nobody netted it off. The allocator already computes it as a
 * by-product of FIFO; it just had nowhere to appear.
 */
export function advances(db: DB, side: 'receivable' | 'payable', asOn: string): AdvanceRow[] {
  const rows = allocateAll(db, side, asOn).filter((r) => r.unappliedCredit > 0)
  if (rows.length === 0) return []
  const settleKind = side === 'receivable' ? 'receipt' : 'payment'
  const ids = rows.map((r) => r.party.id)
  const last = new Map(
    (
      db
        .prepare(
          `SELECT v.party_ledger_id AS ledgerId, MAX(v.date) AS date
           FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
           WHERE vt.kind = ? AND v.date <= ? AND ${IN_BOOKS} AND v.party_ledger_id IN (${ids.map(() => '?').join(',')})
           GROUP BY v.party_ledger_id`
        )
        .all(settleKind, asOn, ...ids) as { ledgerId: number; date: string }[]
    ).map((r) => [r.ledgerId, r.date])
  )
  return rows
    .map((r) => ({
      ledgerId: r.party.id,
      name: r.party.name,
      unapplied: r.unappliedCredit,
      openBills: r.bills.length,
      lastReceiptDate: last.get(r.party.id) ?? null
    }))
    .sort((a, b) => b.unapplied - a.unapplied)
}

// ---------- vendor payment schedule (#165) ----------

export interface ScheduleBill {
  ledgerId: number
  party: string
  number: string
  date: string
  dueDate: string | null
  pending: number
  overdueDays: number
}

export interface ScheduleDay {
  date: string
  bills: ScheduleBill[]
  due: number
  /** Cumulative outflow up to and including this date, starting from today's overdue pile. */
  cumulative: number
  /** Funds left after paying everything up to here. Negative is the point of the report. */
  balanceAfter: number
}

export interface PaymentSchedule {
  from: string
  to: string
  /** Cash + bank on hand as on `from`. */
  funds: number
  /** Bills already past due, payable immediately — shown before the calendar starts. */
  overdue: ScheduleBill[]
  overdueTotal: number
  days: ScheduleDay[]
  total: number
  /** First date the running balance goes negative, or null if it never does. */
  shortfallDate: string | null
}

function cashAndBankBalance(db: DB, asOn: string): number {
  // The same group set every other cash view uses (seed.ts's CASH_BANK_GROUPS, including the OD
  // account) — a payment run that quietly ignored the overdraft would be the wrong answer.
  const groupIds = [...cashBankGroupIds(db)]
  if (groupIds.length === 0) return 0
  const placeholders = groupIds.map(() => '?').join(',')
  const { bal } = db
    .prepare(
      `SELECT COALESCE(SUM(l.opening_balance), 0) + COALESCE((
         SELECT SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END)
         FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
         JOIN ledgers l2 ON l2.id = vl.ledger_id
         WHERE l2.group_id IN (${placeholders}) AND v.date <= ? AND ${IN_BOOKS}
       ), 0) AS bal
       FROM ledgers l WHERE l.group_id IN (${placeholders})`
    )
    .get(...groupIds, asOn, ...groupIds) as { bal: number }
  return bal
}

/**
 * What has to go out, and when, and whether there is enough to cover it.
 *
 * A payment run is only half a plan without the cash line: the useful output is not "₹4.2 lakh is
 * due this month" but "you run out on the 14th". Bills already overdue are pulled out of the
 * calendar and stacked at the front, because they are due now, not on the date printed on them.
 */
export function paymentSchedule(db: DB, from: string, to: string, side: 'payable' | 'receivable' = 'payable'): PaymentSchedule {
  const funds = cashAndBankBalance(db, from)
  const overdue: ScheduleBill[] = []
  const byDate = new Map<string, ScheduleBill[]>()

  for (const { party, bills } of allocateAll(db, side, from)) {
    for (const b of bills) {
      const row: ScheduleBill = {
        ledgerId: party.id,
        party: party.name,
        number: b.number,
        date: b.date,
        dueDate: b.dueDate,
        pending: b.pending,
        overdueDays: b.overdueDays
      }
      const due = b.dueDate ?? b.date
      if (due <= from) overdue.push(row)
      else if (due <= to) {
        const list = byDate.get(due) ?? []
        list.push(row)
        byDate.set(due, list)
      }
      // Bills due after `to` are genuinely out of the window and are not counted — the total
      // says "in this window", and quietly including later bills would make it say nothing.
    }
  }

  overdue.sort((a, b) => b.overdueDays - a.overdueDays || b.pending - a.pending)
  const overdueTotal = overdue.reduce((s, b) => s + b.pending, 0)

  let cumulative = overdueTotal
  let shortfallDate: string | null = funds - overdueTotal < 0 ? from : null
  const days: ScheduleDay[] = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, bills]) => {
      const due = bills.reduce((s, b) => s + b.pending, 0)
      cumulative += due
      const balanceAfter = funds - cumulative
      if (shortfallDate === null && balanceAfter < 0) shortfallDate = date
      return { date, bills: bills.sort((a, b) => b.pending - a.pending), due, cumulative, balanceAfter }
    })

  return { from, to, funds, overdue, overdueTotal, days, total: cumulative, shortfallDate }
}

// ---------- bulk reminders (#161) ----------

export interface BulkReminderRow {
  ledgerId: number
  name: string
  pending: number
  worstOverdueDays: number
  tone: ReminderTone
  phone: string | null
  email: string | null
  subject: string
  body: string
  mailto: string
  whatsapp: string | null
  /** Interest stated on the letter, if the party has terms. */
  interest: number
}

/**
 * A reminder per overdue party, ready to send.
 *
 * Every message is generated and shown before anything is opened — a bulk send that fires without
 * a preview is how the wrong tone reaches your biggest customer. The app opens links; it does not
 * send mail, so the user is always the last step.
 */
export function bulkReminders(
  db: DB,
  companyName: string,
  side: 'receivable' | 'payable',
  asOn: string,
  opts: { minOverdueDays?: number; bandCuts?: number[]; includeInterest?: boolean; contact?: string | null } = {}
): BulkReminderRow[] {
  const policy = getCollectionsPolicy(db)
  const minOverdue = opts.minOverdueDays ?? policy.reminderMinOverdueDays
  const out: BulkReminderRow[] = []
  for (const { party, bills } of allocateAll(db, side, asOn)) {
    const overdue = bills.filter((b) => b.overdueDays >= minOverdue)
    if (overdue.length === 0) continue
    const worst = overdue.reduce((m, b) => Math.max(m, b.overdueDays), 0)
    const terms = termsFor(db, party)
    const interest =
      opts.includeInterest !== false && terms.rateBp > 0 ? interestOnBills(overdue, terms).total : 0
    const tone = toneFor(worst)
    const reminder = buildReminder(
      { name: companyName },
      { name: party.name, email: party.email, phone: party.phone },
      overdue,
      {
        tone,
        bandCuts: opts.bandCuts ?? policy.bandCuts,
        contact: opts.contact ?? policy.contact,
        ...(interest > 0 ? { interest: { total: interest, terms: describeTerms(terms) } } : {})
      }
    )
    out.push({
      ledgerId: party.id,
      name: party.name,
      pending: overdue.reduce((s, b) => s + b.pending, 0),
      worstOverdueDays: worst,
      tone,
      phone: party.phone,
      email: party.email,
      interest,
      ...reminder
    })
  }
  return out.sort((a, b) => b.worstOverdueDays - a.worstOverdueDays || b.pending - a.pending)
}

// ---------- party statement (#155) ----------

export interface StatementLine {
  date: string
  number: string
  particulars: string
  debit: number | null
  credit: number | null
  balance: number
  voucherId: number | null
}

export interface PartyStatement {
  ledgerId: number
  name: string
  address: string | null
  gstin: string | null
  phone: string | null
  email: string | null
  from: string
  to: string
  openingBalance: number
  lines: StatementLine[]
  closingBalance: number
  openBills: OutstandingBill[]
  bandLabels: string[]
  buckets: number[]
  interest: InterestResult | null
  termsLabel: string | null
}

/**
 * A statement of account: the running ledger over a period, plus the ageing of what is still open.
 *
 * Both halves matter and they answer different questions. The running ledger is what the party's
 * own books should agree with line for line; the ageing is the argument for paying now. Sending
 * only the first is how a statement gets filed and forgotten.
 */
export function partyStatement(
  db: DB,
  ledgerId: number,
  from: string,
  to: string,
  bandCuts: number[] = DEFAULT_BAND_CUTS
): PartyStatement {
  const party = db
    .prepare(`SELECT ${PARTY_COLUMNS}, address, gstin FROM ledgers WHERE id = ?`)
    .get(ledgerId) as (PartyRow & { address: string | null; gstin: string | null }) | undefined
  if (!party) throw new Error('Party not found')

  const { opening } = db
    .prepare(
      `SELECT ? + COALESCE((
         SELECT SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END)
         FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
         WHERE vl.ledger_id = ? AND v.date < ? AND ${IN_BOOKS}
       ), 0) AS opening`
    )
    .get(party.opening_balance, ledgerId, from) as { opening: number }

  const rows = db
    .prepare(
      `SELECT v.id AS voucherId, v.date, v.number, vt.name AS typeName, v.narration,
              SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE 0 END) AS debit,
              SUM(CASE WHEN vl.dr_cr = 'cr' THEN vl.amount ELSE 0 END) AS credit
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE vl.ledger_id = ? AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       GROUP BY v.id ORDER BY v.date, v.id`
    )
    .all(ledgerId, from, to) as {
      voucherId: number; date: string; number: string; typeName: string; narration: string | null
      debit: number; credit: number
    }[]

  let balance = opening
  const lines: StatementLine[] = rows.map((r) => {
    balance += r.debit - r.credit
    return {
      date: r.date,
      number: r.number,
      particulars: r.narration?.trim() ? `${r.typeName} — ${r.narration.trim()}` : r.typeName,
      debit: r.debit > 0 ? r.debit : null,
      credit: r.credit > 0 ? r.credit : null,
      balance,
      voucherId: r.voucherId
    }
  })

  // Which side of the books this party sits on decides which sign means "they owe us".
  const debtorGroups = descendantIdsByName(db, ['Sundry Debtors'])
  const side: 'receivable' | 'payable' = debtorGroups.has(party.group_id) ? 'receivable' : 'payable'
  const allocation = allocateAll(db, side, to, [ledgerId])[0]
  const openBills = allocation?.bills ?? []
  const terms = termsFor(db, party)
  const cuts = normaliseBandCuts(bandCuts)

  return {
    ledgerId,
    name: party.name,
    address: party.address,
    gstin: party.gstin,
    phone: party.phone,
    email: party.email,
    from,
    to,
    openingBalance: opening,
    lines,
    closingBalance: balance,
    openBills,
    bandLabels: bandLabels(cuts),
    buckets: bucketByBand(openBills, cuts),
    interest: terms.rateBp > 0 ? interestOnBills(openBills, terms) : null,
    termsLabel: terms.rateBp > 0 ? describeTerms(terms) : null
  }
}


// ---------- credit-limit check at entry (#154) ----------

export interface CreditStatus {
  ledgerId: number
  name: string
  creditLimit: number | null
  /** Party's dr-positive outstanding in the books right now. */
  outstanding: number
  /** Outstanding plus the voucher being entered. */
  after: number
  /** Fraction of the limit `after` uses; null when there is no limit. Can exceed 1. */
  used: number | null
  exceeds: boolean
  /** True when F11 enforceCreditLimit is on — the save will be refused, not merely flagged. */
  enforced: boolean
  /** Headroom left before the limit; negative once it is breached. Null with no limit. */
  headroom: number | null
}

/**
 * Where a party stands against their limit, including the voucher currently on screen.
 *
 * `saveVoucher` already refuses a breach under F11, but a refusal at save is the wrong moment:
 * the invoice is typed, the customer is waiting, and the only options left are to abandon it or
 * turn the setting off. Asking the same question while the party is picked turns enforcement into
 * something the user can act on — take a part payment, or raise the limit deliberately.
 *
 * Reads the same numbers saveVoucher does (opening balance + posted lines, in-books only), so the
 * banner on the screen and the block at save can never disagree.
 */
export function creditStatus(db: DB, ledgerId: number, addPaise = 0): CreditStatus | null {
  const party = db
    .prepare('SELECT id, name, opening_balance, credit_limit FROM ledgers WHERE id = ?')
    .get(ledgerId) as { id: number; name: string; opening_balance: number; credit_limit: number | null } | undefined
  if (!party) return null
  const { bal } = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END), 0) AS bal
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
       WHERE vl.ledger_id = ? AND ${IN_BOOKS}`
    )
    .get(ledgerId) as { bal: number }
  const outstanding = party.opening_balance + bal
  const after = outstanding + addPaise
  const limit = party.credit_limit
  return {
    ledgerId: party.id,
    name: party.name,
    creditLimit: limit,
    outstanding,
    after,
    used: limit !== null && limit > 0 ? after / limit : null,
    exceeds: limit !== null && after > limit,
    enforced: getFeatures(db).enforceCreditLimit,
    headroom: limit === null ? null : limit - after
  }
}


// ---------- section 43B(h): what a late payment to a small supplier costs (roadmap #351) ----------

/**
 * The MSME disallowance report.
 *
 * Built on the same FIFO allocation everything else here uses, so what it calls unpaid is exactly
 * what the payables ageing calls unpaid. The only thing it needs that the books cannot infer is
 * each supplier's MSME status, which is a fact about the supplier rather than about the invoice.
 *
 * Run as at 31 March, this is the number that changes the tax computation. Run in January, it is
 * still a list of cheques somebody can write.
 */
export function msmeExposure(db: DB, asOn: string): MsmeReport {
  const policy = getCollectionsPolicy(db)
  return msmeReport(
    allocateAll(db, 'payable', asOn).map(({ party, bills }) => ({
      ledgerId: party.id,
      name: party.name,
      status: party.msme_status,
      udyamNumber: party.udyam_number,
      creditDays: party.credit_days,
      bills: bills.map((b) => ({ number: b.number, date: b.date, pending: b.pending, creditDays: party.credit_days }))
    })),
    asOn,
    policy.msmeBankRatePercent
  )
}
