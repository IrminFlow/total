/**
 * What the business owes and what it has parked: loans, deposits, projects under construction,
 * prepayments, and the return the bank asks for every month.
 *
 * Roadmap #369 (capital work in progress), #370 (the loan register), #372 (the stock statement),
 * #373 (drawing power), #374 (prepaid and accrued), #375 (the deposit register).
 *
 * Every one of these is a register plus a DRAFT journal. Nothing here posts: the arithmetic is
 * mechanical, but which month a journal belongs in and whether it belongs at all is a judgement,
 * and a book that grows entries nobody typed is a book nobody trusts.
 */
import type { DB } from '../db/connection'
import { amortise, outstandingOn, type LoanSchedule } from '@shared/loan'
import { amortiseOverMonths, type AmortisationRow } from '@shared/prepaid'
import { drawingPower, DEFAULT_MARGINS, type DrawingPowerMargins, type DrawingPowerResult } from '@shared/drawingPower'
import { todayISO } from '@shared/dates'
import { descendantIdsByName, findOrCreateLedger } from './masters'
import { outstandings } from './analysis'
import { stockValue } from './reports'
import { IN_BOOKS } from './vouchers'
import { writeAudit } from './audit'

export interface JournalDraftLine {
  ledgerName: string
  group: string
  drCr: 'dr' | 'cr'
  amount: number
}

export interface JournalDraft {
  date: string
  narration: string
  lines: JournalDraftLine[]
  total: number
}

// ---------- loans (#370) ----------

export type LoanKind = 'term' | 'vehicle' | 'machinery' | 'working_capital' | 'other'

export interface Loan {
  id: number
  name: string
  lender: string | null
  accountNumber: string | null
  kind: LoanKind
  ledgerId: number | null
  interestLedgerId: number | null
  principalPaise: number
  annualRateBp: number
  months: number
  emiPaise: number | null
  disbursedOn: string
  firstInstalmentDate: string
  notes: string | null
  closedOn: string | null
}

interface LoanRow {
  id: number; name: string; lender: string | null; account_number: string | null; kind: LoanKind
  ledger_id: number | null; interest_ledger_id: number | null; principal: number; annual_rate_bp: number
  months: number; emi: number | null; disbursed_on: string; first_instalment_date: string
  notes: string | null; closed_on: string | null
}

const mapLoan = (r: LoanRow): Loan => ({
  id: r.id,
  name: r.name,
  lender: r.lender,
  accountNumber: r.account_number,
  kind: r.kind,
  ledgerId: r.ledger_id,
  interestLedgerId: r.interest_ledger_id,
  principalPaise: r.principal,
  annualRateBp: r.annual_rate_bp,
  months: r.months,
  emiPaise: r.emi,
  disbursedOn: r.disbursed_on,
  firstInstalmentDate: r.first_instalment_date,
  notes: r.notes,
  closedOn: r.closed_on
})

export function listLoans(db: DB): Loan[] {
  return (db.prepare('SELECT * FROM loans ORDER BY closed_on IS NOT NULL, first_instalment_date').all() as LoanRow[]).map(mapLoan)
}

export function getLoan(db: DB, id: number): Loan | null {
  const row = db.prepare('SELECT * FROM loans WHERE id = ?').get(id) as LoanRow | undefined
  return row ? mapLoan(row) : null
}

export interface LoanInput {
  name: string
  lender?: string | null
  accountNumber?: string | null
  kind?: LoanKind
  ledgerId?: number | null
  interestLedgerId?: number | null
  principalPaise: number
  annualRateBp: number
  months: number
  emiPaise?: number | null
  disbursedOn: string
  firstInstalmentDate: string
  notes?: string | null
}

export function saveLoan(db: DB, input: LoanInput, id?: number): Loan {
  // Validate by building the schedule: a rate and an instalment that never amortise are refused
  // here rather than at the first month's posting, which is six weeks too late to notice.
  amortise({
    principalPaise: input.principalPaise,
    annualRateBp: input.annualRateBp,
    months: input.months,
    emiPaise: input.emiPaise ?? null,
    firstInstalmentDate: input.firstInstalmentDate
  })
  const before = id ? getLoan(db, id) : null
  const args = [
    input.name, input.lender ?? null, input.accountNumber ?? null, input.kind ?? 'term',
    input.ledgerId ?? null, input.interestLedgerId ?? null, input.principalPaise, input.annualRateBp,
    input.months, input.emiPaise ?? null, input.disbursedOn, input.firstInstalmentDate, input.notes ?? null
  ]
  if (id) {
    db.prepare(
      `UPDATE loans SET name = ?, lender = ?, account_number = ?, kind = ?, ledger_id = ?, interest_ledger_id = ?,
       principal = ?, annual_rate_bp = ?, months = ?, emi = ?, disbursed_on = ?, first_instalment_date = ?, notes = ?
       WHERE id = ?`
    ).run(...args, id)
  } else {
    id = Number(
      db.prepare(
        `INSERT INTO loans (name, lender, account_number, kind, ledger_id, interest_ledger_id, principal,
          annual_rate_bp, months, emi, disbursed_on, first_instalment_date, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(...args).lastInsertRowid
    )
  }
  const saved = getLoan(db, id)!
  writeAudit(db, 'loan', id, before ? 'update' : 'create', before, saved)
  return saved
}

export function deleteLoan(db: DB, id: number): void {
  const before = getLoan(db, id)
  if (!before) throw new Error('No such loan')
  const posted = db.prepare('SELECT COUNT(*) AS n FROM loan_postings WHERE loan_id = ?').get(id) as { n: number }
  if (posted.n > 0) throw new Error('Instalments have been posted against this loan — close it instead of deleting it')
  db.prepare('DELETE FROM loans WHERE id = ?').run(id)
  writeAudit(db, 'loan', id, 'delete', before, null)
}

export interface LoanPosting {
  instalmentNo: number
  voucherId: number | null
  postedOn: string
  interestPaise: number
  principalPaise: number
}

export interface LoanView {
  loan: Loan
  schedule: LoanSchedule
  postings: LoanPosting[]
  /** What is still owed on `asOn`, per the schedule. */
  outstandingPaise: number
  /** Instalments due on or before `asOn` that nobody has posted. */
  unposted: LoanSchedule['rows']
  /** Interest that will be charged in the current financial year, for the P&L estimate. */
  interestThisYearPaise: number
}

export function loanView(db: DB, id: number, asOn = todayISO(), fyFrom?: string, fyTo?: string): LoanView {
  const loan = getLoan(db, id)
  if (!loan) throw new Error('No such loan')
  const schedule = amortise({
    principalPaise: loan.principalPaise,
    annualRateBp: loan.annualRateBp,
    months: loan.months,
    emiPaise: loan.emiPaise,
    firstInstalmentDate: loan.firstInstalmentDate
  })
  const postings = db
    .prepare(
      `SELECT instalment_no AS instalmentNo, voucher_id AS voucherId, posted_on AS postedOn,
              interest AS interestPaise, principal AS principalPaise
       FROM loan_postings WHERE loan_id = ? ORDER BY instalment_no`
    )
    .all(id) as LoanPosting[]
  const posted = new Set(postings.map((p) => p.instalmentNo))

  return {
    loan,
    schedule,
    postings,
    outstandingPaise: outstandingOn(schedule, loan.principalPaise, asOn),
    unposted: schedule.rows.filter((r) => r.dueDate <= asOn && !posted.has(r.n)),
    interestThisYearPaise:
      fyFrom && fyTo
        ? schedule.rows.filter((r) => r.dueDate >= fyFrom && r.dueDate <= fyTo).reduce((s, r) => s + r.interestPaise, 0)
        : 0
  }
}

/**
 * The journal for one instalment — a draft, never posted here.
 *
 * Three lines, and the reason the whole feature exists: the loan account is debited with the
 * PRINCIPAL only, interest goes to the P&L, and the bank is credited with the whole instalment.
 * Booking the EMI to the loan account, which is what almost every small business does, leaves the
 * loan balance wrong and the profit overstated by the interest for as long as the loan runs.
 */
export function instalmentDraft(db: DB, loanId: number, instalmentNo: number): JournalDraft {
  const view = loanView(db, loanId)
  const row = view.schedule.rows.find((r) => r.n === instalmentNo)
  if (!row) throw new Error(`This loan has no instalment ${instalmentNo}`)
  if (view.postings.some((p) => p.instalmentNo === instalmentNo)) {
    throw new Error(`Instalment ${instalmentNo} has already been posted`)
  }
  const loanLedger = db.prepare('SELECT name FROM ledgers WHERE id = ?').get(view.loan.ledgerId ?? -1) as { name: string } | undefined
  const interestLedger = db.prepare('SELECT name FROM ledgers WHERE id = ?').get(view.loan.interestLedgerId ?? -1) as { name: string } | undefined

  return {
    date: row.dueDate,
    narration: `EMI ${instalmentNo} of ${view.schedule.rows.length} — ${view.loan.name}`,
    lines: [
      { ledgerName: loanLedger?.name ?? view.loan.name, group: 'Secured Loans', drCr: 'dr', amount: row.principalPaise },
      { ledgerName: interestLedger?.name ?? 'Interest on Loans', group: 'Indirect Expenses', drCr: 'dr', amount: row.interestPaise },
      { ledgerName: 'Bank', group: 'Bank Accounts', drCr: 'cr', amount: row.emiPaise }
    ],
    total: row.emiPaise
  }
}

/** Record that an instalment's journal was saved, so the month is not booked twice. */
export function recordInstalment(db: DB, loanId: number, instalmentNo: number, voucherId: number | null): LoanPosting {
  const view = loanView(db, loanId)
  const row = view.schedule.rows.find((r) => r.n === instalmentNo)
  if (!row) throw new Error(`This loan has no instalment ${instalmentNo}`)
  const existing = db.prepare('SELECT 1 FROM loan_postings WHERE loan_id = ? AND instalment_no = ?').get(loanId, instalmentNo)
  if (existing) throw new Error(`Instalment ${instalmentNo} has already been posted`)
  db.prepare(
    `INSERT INTO loan_postings (loan_id, instalment_no, voucher_id, posted_on, interest, principal)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(loanId, instalmentNo, voucherId, row.dueDate, row.interestPaise, row.principalPaise)
  writeAudit(db, 'loan', loanId, 'update', null, { instalmentNo, voucherId })
  return {
    instalmentNo,
    voucherId,
    postedOn: row.dueDate,
    interestPaise: row.interestPaise,
    principalPaise: row.principalPaise
  }
}

/** Ensure the ledgers a loan draft names exist, so saving it does not fail. */
export function ensureLoanLedgers(db: DB): void {
  findOrCreateLedger(db, 'Interest on Loans', 'Indirect Expenses')
}

// ---------- deposits (#375) ----------

export interface Deposit {
  id: number
  direction: 'paid' | 'received'
  counterparty: string
  partyLedgerId: number | null
  ledgerId: number | null
  purpose: string | null
  amountPaise: number
  paidOn: string
  refundableOn: string | null
  interestRateBp: number | null
  returnedOn: string | null
  returnedAmountPaise: number | null
  notes: string | null
}

interface DepositRow {
  id: number; direction: 'paid' | 'received'; counterparty: string; party_ledger_id: number | null
  ledger_id: number | null; purpose: string | null; amount: number; paid_on: string
  refundable_on: string | null; interest_rate_bp: number | null; returned_on: string | null
  returned_amount: number | null; notes: string | null
}

const mapDeposit = (r: DepositRow): Deposit => ({
  id: r.id,
  direction: r.direction,
  counterparty: r.counterparty,
  partyLedgerId: r.party_ledger_id,
  ledgerId: r.ledger_id,
  purpose: r.purpose,
  amountPaise: r.amount,
  paidOn: r.paid_on,
  refundableOn: r.refundable_on,
  interestRateBp: r.interest_rate_bp,
  returnedOn: r.returned_on,
  returnedAmountPaise: r.returned_amount,
  notes: r.notes
})

export function listDeposits(db: DB, includeReturned = false): Deposit[] {
  const rows = db
    .prepare(`SELECT * FROM deposits ${includeReturned ? '' : 'WHERE returned_on IS NULL'} ORDER BY paid_on DESC`)
    .all() as DepositRow[]
  return rows.map(mapDeposit)
}

export interface DepositInput {
  direction: 'paid' | 'received'
  counterparty: string
  partyLedgerId?: number | null
  ledgerId?: number | null
  purpose?: string | null
  amountPaise: number
  paidOn: string
  refundableOn?: string | null
  interestRateBp?: number | null
  notes?: string | null
}

export function saveDeposit(db: DB, input: DepositInput, id?: number): Deposit {
  if (input.amountPaise <= 0) throw new Error('A deposit needs an amount')
  const args = [
    input.direction, input.counterparty, input.partyLedgerId ?? null, input.ledgerId ?? null,
    input.purpose ?? null, input.amountPaise, input.paidOn, input.refundableOn ?? null,
    input.interestRateBp ?? null, input.notes ?? null
  ]
  if (id) {
    db.prepare(
      `UPDATE deposits SET direction = ?, counterparty = ?, party_ledger_id = ?, ledger_id = ?, purpose = ?,
       amount = ?, paid_on = ?, refundable_on = ?, interest_rate_bp = ?, notes = ? WHERE id = ?`
    ).run(...args, id)
  } else {
    id = Number(
      db.prepare(
        `INSERT INTO deposits (direction, counterparty, party_ledger_id, ledger_id, purpose, amount,
          paid_on, refundable_on, interest_rate_bp, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(...args).lastInsertRowid
    )
  }
  const saved = listDeposits(db, true).find((d) => d.id === id)!
  writeAudit(db, 'deposit', id, 'create', null, saved)
  return saved
}

export function returnDeposit(db: DB, id: number, on: string, amountPaise: number): Deposit {
  const before = listDeposits(db, true).find((d) => d.id === id)
  if (!before) throw new Error('No such deposit')
  if (before.returnedOn) throw new Error(`That deposit came back on ${before.returnedOn}`)
  db.prepare('UPDATE deposits SET returned_on = ?, returned_amount = ? WHERE id = ?').run(on, amountPaise, id)
  const after = listDeposits(db, true).find((d) => d.id === id)!
  writeAudit(db, 'deposit', id, 'update', before, after)
  return after
}

export function deleteDeposit(db: DB, id: number): void {
  db.prepare('DELETE FROM deposits WHERE id = ?').run(id)
  writeAudit(db, 'deposit', id, 'delete', null, null)
}

export interface DepositSummary {
  paidPaise: number
  receivedPaise: number
  /** Deposits whose refund date has passed and which are still out — the point of the register. */
  overdue: Deposit[]
  /** Out for more than three years with no stated refund date, which is how they get forgotten. */
  stale: Deposit[]
}

export function depositSummary(db: DB, asOn = todayISO()): DepositSummary {
  const open = listDeposits(db, false)
  const threeYearsAgo = `${Number(asOn.slice(0, 4)) - 3}${asOn.slice(4)}`
  return {
    paidPaise: open.filter((d) => d.direction === 'paid').reduce((s, d) => s + d.amountPaise, 0),
    receivedPaise: open.filter((d) => d.direction === 'received').reduce((s, d) => s + d.amountPaise, 0),
    overdue: open.filter((d) => d.refundableOn !== null && d.refundableOn < asOn),
    stale: open.filter((d) => d.refundableOn === null && d.paidOn < threeYearsAgo)
  }
}

// ---------- capital work in progress (#369) ----------

export interface CwipCost {
  id: number
  date: string
  description: string
  amountPaise: number
  voucherId: number | null
  supplier: string | null
}

export interface CwipProject {
  id: number
  name: string
  startedOn: string
  ledgerId: number | null
  notes: string | null
  capitalisedOn: string | null
  fixedAssetId: number | null
  capitalisationVoucherId: number | null
  costs: CwipCost[]
  totalPaise: number
}

export function listProjects(db: DB, includeCapitalised = true): CwipProject[] {
  const rows = db
    .prepare(
      `SELECT id, name, started_on AS startedOn, ledger_id AS ledgerId, notes,
              capitalised_on AS capitalisedOn, fixed_asset_id AS fixedAssetId,
              capitalisation_voucher_id AS capitalisationVoucherId
       FROM cwip_projects ${includeCapitalised ? '' : 'WHERE capitalised_on IS NULL'} ORDER BY started_on DESC, id DESC`
    )
    .all() as Omit<CwipProject, 'costs' | 'totalPaise'>[]
  return rows.map((p) => {
    const costs = db
      .prepare(
        `SELECT id, date, description, amount AS amountPaise, voucher_id AS voucherId, supplier
         FROM cwip_costs WHERE project_id = ? ORDER BY date, id`
      )
      .all(p.id) as CwipCost[]
    return { ...p, costs, totalPaise: costs.reduce((s, c) => s + c.amountPaise, 0) }
  })
}

export function saveProject(
  db: DB,
  input: { name: string; startedOn: string; ledgerId?: number | null; notes?: string | null },
  id?: number
): CwipProject {
  if (id) {
    db.prepare('UPDATE cwip_projects SET name = ?, started_on = ?, ledger_id = ?, notes = ? WHERE id = ?')
      .run(input.name, input.startedOn, input.ledgerId ?? null, input.notes ?? null, id)
  } else {
    id = Number(
      db.prepare('INSERT INTO cwip_projects (name, started_on, ledger_id, notes) VALUES (?, ?, ?, ?)')
        .run(input.name, input.startedOn, input.ledgerId ?? null, input.notes ?? null).lastInsertRowid
    )
  }
  const saved = listProjects(db).find((p) => p.id === id)!
  writeAudit(db, 'cwip_project', id, 'create', null, { name: saved.name })
  return saved
}

export function addCost(
  db: DB,
  projectId: number,
  input: { date: string; description: string; amountPaise: number; voucherId?: number | null; supplier?: string | null }
): CwipProject {
  const project = listProjects(db).find((p) => p.id === projectId)
  if (!project) throw new Error('No such project')
  // Once capitalised the cost of the asset is fixed: a bill that arrives later is either a
  // separate asset or a repair, and quietly changing a depreciated cost is worse than either.
  if (project.capitalisedOn) throw new Error(`${project.name} was capitalised on ${project.capitalisedOn} — its cost is settled`)
  if (input.amountPaise <= 0) throw new Error('A cost needs an amount')
  db.prepare('INSERT INTO cwip_costs (project_id, date, description, amount, voucher_id, supplier) VALUES (?, ?, ?, ?, ?, ?)')
    .run(projectId, input.date, input.description, input.amountPaise, input.voucherId ?? null, input.supplier ?? null)
  return listProjects(db).find((p) => p.id === projectId)!
}

export function removeCost(db: DB, costId: number): void {
  db.prepare('DELETE FROM cwip_costs WHERE id = ?').run(costId)
}

export interface CapitalisationDraft {
  project: CwipProject
  date: string
  narration: string
  lines: JournalDraftLine[]
  total: number
}

/**
 * Turning accumulated costs into an asset.
 *
 * The journal moves the whole accumulated balance out of capital work in progress and into the
 * asset ledger on one date — which is also the date depreciation starts, because that is the day
 * the thing was ready for use. Leaving the costs in CWIP is how a building depreciates for the
 * first time three years after it was occupied.
 */
export function capitalisationDraft(db: DB, projectId: number, on: string, assetLedgerName: string): CapitalisationDraft {
  const project = listProjects(db).find((p) => p.id === projectId)
  if (!project) throw new Error('No such project')
  if (project.capitalisedOn) throw new Error(`${project.name} was already capitalised on ${project.capitalisedOn}`)
  if (project.totalPaise <= 0) throw new Error('Nothing has been spent on this project yet')
  const cwipLedger = db.prepare('SELECT name FROM ledgers WHERE id = ?').get(project.ledgerId ?? -1) as { name: string } | undefined

  return {
    project,
    date: on,
    narration: `Capitalising ${project.name} on ${on}`,
    lines: [
      { ledgerName: assetLedgerName, group: 'Fixed Assets', drCr: 'dr', amount: project.totalPaise },
      { ledgerName: cwipLedger?.name ?? 'Capital Work in Progress', group: 'Fixed Assets', drCr: 'cr', amount: project.totalPaise }
    ],
    total: project.totalPaise
  }
}

/** Record that a project became an asset. The asset itself is created in the register. */
export function recordCapitalisation(
  db: DB,
  projectId: number,
  on: string,
  fixedAssetId: number | null,
  voucherId: number | null
): CwipProject {
  const before = listProjects(db).find((p) => p.id === projectId)
  if (!before) throw new Error('No such project')
  if (before.capitalisedOn) throw new Error(`${before.name} was already capitalised on ${before.capitalisedOn}`)
  db.prepare('UPDATE cwip_projects SET capitalised_on = ?, fixed_asset_id = ?, capitalisation_voucher_id = ? WHERE id = ?')
    .run(on, fixedAssetId, voucherId, projectId)
  const after = listProjects(db).find((p) => p.id === projectId)!
  writeAudit(db, 'cwip_project', projectId, 'update', before, after)
  return after
}

export function ensureCwipLedger(db: DB): number {
  return findOrCreateLedger(db, 'Capital Work in Progress', 'Fixed Assets')
}

// ---------- prepaid and accrued (#374) ----------

export interface PrepaidSchedule {
  id: number
  kind: 'prepaid' | 'accrued'
  name: string
  amountPaise: number
  periodFrom: string
  periodTo: string
  basis: 'month' | 'day'
  expenseLedgerId: number | null
  balanceLedgerId: number | null
  sourceVoucherId: number | null
  notes: string | null
  rows: AmortisationRow[]
  postedMonths: string[]
  /** Months whose charge is due but not yet posted, on `asOn`. */
  duePaise: number
  unexpiredPaise: number
}

interface PrepaidRow {
  id: number; kind: 'prepaid' | 'accrued'; name: string; amount: number; period_from: string
  period_to: string; basis: 'month' | 'day'; expense_ledger_id: number | null
  balance_ledger_id: number | null; source_voucher_id: number | null; notes: string | null
}

function hydratePrepaid(db: DB, r: PrepaidRow, asOn: string): PrepaidSchedule {
  const rows = amortiseOverMonths({ amountPaise: r.amount, from: r.period_from, to: r.period_to, basis: r.basis })
  const posted = (db.prepare('SELECT month FROM prepaid_postings WHERE schedule_id = ?').all(r.id) as { month: string }[]).map((x) => x.month)
  const postedSet = new Set(posted)
  const due = rows.filter((row) => row.to <= asOn && !postedSet.has(row.month)).reduce((s, row) => s + row.amountPaise, 0)
  const expired = rows.filter((row) => row.to <= asOn).reduce((s, row) => s + row.amountPaise, 0)
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    amountPaise: r.amount,
    periodFrom: r.period_from,
    periodTo: r.period_to,
    basis: r.basis,
    expenseLedgerId: r.expense_ledger_id,
    balanceLedgerId: r.balance_ledger_id,
    sourceVoucherId: r.source_voucher_id,
    notes: r.notes,
    rows,
    postedMonths: posted,
    duePaise: due,
    unexpiredPaise: r.amount - expired
  }
}

export function listPrepaid(db: DB, asOn = todayISO()): PrepaidSchedule[] {
  return (db.prepare('SELECT * FROM prepaid_schedules ORDER BY period_from DESC, id DESC').all() as PrepaidRow[])
    .map((r) => hydratePrepaid(db, r, asOn))
}

export interface PrepaidInput {
  kind: 'prepaid' | 'accrued'
  name: string
  amountPaise: number
  periodFrom: string
  periodTo: string
  basis?: 'month' | 'day'
  expenseLedgerId?: number | null
  balanceLedgerId?: number | null
  sourceVoucherId?: number | null
  notes?: string | null
}

export function savePrepaid(db: DB, input: PrepaidInput, id?: number): PrepaidSchedule {
  // Building the schedule validates the period and the amount in one step.
  amortiseOverMonths({ amountPaise: input.amountPaise, from: input.periodFrom, to: input.periodTo, basis: input.basis ?? 'month' })
  const args = [
    input.kind, input.name, input.amountPaise, input.periodFrom, input.periodTo, input.basis ?? 'month',
    input.expenseLedgerId ?? null, input.balanceLedgerId ?? null, input.sourceVoucherId ?? null, input.notes ?? null
  ]
  if (id) {
    const posted = db.prepare('SELECT COUNT(*) AS n FROM prepaid_postings WHERE schedule_id = ?').get(id) as { n: number }
    // Changing the amount after part of it has been charged would leave the earlier months
    // charged on one basis and the later ones on another, and nothing to say so.
    if (posted.n > 0) throw new Error('Part of this schedule has already been posted — it cannot be re-cut')
    db.prepare(
      `UPDATE prepaid_schedules SET kind = ?, name = ?, amount = ?, period_from = ?, period_to = ?, basis = ?,
       expense_ledger_id = ?, balance_ledger_id = ?, source_voucher_id = ?, notes = ? WHERE id = ?`
    ).run(...args, id)
  } else {
    id = Number(
      db.prepare(
        `INSERT INTO prepaid_schedules (kind, name, amount, period_from, period_to, basis,
          expense_ledger_id, balance_ledger_id, source_voucher_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(...args).lastInsertRowid
    )
  }
  const saved = listPrepaid(db).find((s) => s.id === id)!
  writeAudit(db, 'prepaid_schedule', id, 'create', null, { name: saved.name, amount: saved.amountPaise })
  return saved
}

export function deletePrepaid(db: DB, id: number): void {
  const posted = db.prepare('SELECT COUNT(*) AS n FROM prepaid_postings WHERE schedule_id = ?').get(id) as { n: number }
  if (posted.n > 0) throw new Error('Part of this schedule has already been posted')
  db.prepare('DELETE FROM prepaid_schedules WHERE id = ?').run(id)
}

/**
 * The month's journal for one schedule — a draft.
 *
 * A prepayment charges the expense and releases the asset; an accrual charges the expense and
 * raises a liability. Same two lines, opposite balance-sheet side, which is why one table carries
 * both.
 */
export function prepaidDraft(db: DB, scheduleId: number, month: string): JournalDraft {
  const schedule = listPrepaid(db).find((s) => s.id === scheduleId)
  if (!schedule) throw new Error('No such schedule')
  const row = schedule.rows.find((r) => r.month === month)
  if (!row) throw new Error(`${schedule.name} covers nothing in ${month}`)
  if (schedule.postedMonths.includes(month)) throw new Error(`${month} has already been posted for ${schedule.name}`)

  const expense = db.prepare('SELECT name FROM ledgers WHERE id = ?').get(schedule.expenseLedgerId ?? -1) as { name: string } | undefined
  const balance = db.prepare('SELECT name FROM ledgers WHERE id = ?').get(schedule.balanceLedgerId ?? -1) as { name: string } | undefined
  const balanceName = balance?.name ?? (schedule.kind === 'prepaid' ? 'Prepaid Expenses' : 'Expenses Payable')

  return {
    date: row.to,
    narration: `${schedule.name} — ${month} (${schedule.kind === 'prepaid' ? 'released from prepaid' : 'accrued'})`,
    lines: [
      { ledgerName: expense?.name ?? schedule.name, group: 'Indirect Expenses', drCr: 'dr', amount: row.amountPaise },
      {
        ledgerName: balanceName,
        group: schedule.kind === 'prepaid' ? 'Current Assets' : 'Current Liabilities',
        drCr: 'cr',
        amount: row.amountPaise
      }
    ],
    total: row.amountPaise
  }
}

export function recordPrepaidPosting(db: DB, scheduleId: number, month: string, voucherId: number | null): PrepaidSchedule {
  const schedule = listPrepaid(db).find((s) => s.id === scheduleId)
  if (!schedule) throw new Error('No such schedule')
  const row = schedule.rows.find((r) => r.month === month)
  if (!row) throw new Error(`${schedule.name} covers nothing in ${month}`)
  if (schedule.postedMonths.includes(month)) throw new Error(`${month} has already been posted for ${schedule.name}`)
  db.prepare('INSERT INTO prepaid_postings (schedule_id, month, amount, voucher_id, posted_on) VALUES (?, ?, ?, ?, ?)')
    .run(scheduleId, month, row.amountPaise, voucherId, row.to)
  return listPrepaid(db).find((s) => s.id === scheduleId)!
}

export function ensurePrepaidLedgers(db: DB): void {
  findOrCreateLedger(db, 'Prepaid Expenses', 'Current Assets')
  findOrCreateLedger(db, 'Expenses Payable', 'Current Liabilities')
}

// ---------- the monthly stock statement, and drawing power (#372, #373) ----------

export interface StockStatement extends DrawingPowerResult {
  id: number | null
  filedOn: string | null
  notes: string | null
  margins: DrawingPowerMargins
  /** Debtors past the age limit, listed so the borrower can see what was excluded. */
  excludedParties: { name: string; pending: number }[]
}

/** What the cash-credit account is drawn to on a date. A credit balance, reported positive. */
function ccUtilised(db: DB, asOn: string, ccLedgerId: number | null): number {
  const ids = ccLedgerId ? [ccLedgerId] : [...descendantIdsByName(db, ['Bank OD A/c'])]
  if (ids.length === 0) return 0
  const placeholders = ccLedgerId ? 'l.id = ?' : `l.group_id IN (${ids.map(() => '?').join(',')})`
  const args = ccLedgerId ? [ccLedgerId] : ids
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(l.opening_balance), 0)
            + COALESCE((SELECT SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END)
                        FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
                        WHERE vl.ledger_id IN (SELECT id FROM ledgers l2 WHERE ${placeholders.replace(/l\./g, 'l2.')})
                          AND v.date <= ? AND ${IN_BOOKS}), 0) AS balance
       FROM ledgers l WHERE ${placeholders}`
    )
    .get(...args, asOn, ...args) as { balance: number }
  // Dr-positive: an overdraft is a credit balance, so the utilised figure is the negative of it.
  return Math.max(0, -row.balance)
}

/**
 * The one classification of this borrower's working capital.
 *
 * The monthly stock statement (#372), the drawing-power computation (#373) and the CMA pack
 * (#371) all describe the same stock, the same book debts and the same creditors to the same
 * bank. They publish different cut-offs — drawing power excludes debts past the bank's limit,
 * usually 90 days; Form III of the CMA splits receivables at six months, which is the CMA's own
 * convention — but they must not disagree about what the figures ARE.
 *
 * So the cut-off is a parameter and everything else is computed once, here. Two callers deriving
 * "book debts" separately is two answers to a question the bank asks once, and the borrower is
 * the one who has to explain the difference.
 */
export interface WorkingCapitalBasis {
  asOn: string
  stockPaise: number
  /** Book debts at or within `ageLimitDays` of the invoice date. */
  withinLimitPaise: number
  /** Book debts beyond it. */
  beyondLimitPaise: number
  totalDebtorsPaise: number
  creditorsPaise: number
  /** Cash-credit / overdraft actually drawn, reported positive. */
  utilisedPaise: number
  /** Parties with debt beyond the limit, largest first — what was excluded and by whom. */
  beyondLimitParties: { name: string; pending: number }[]
}

export function workingCapitalBasis(
  db: DB,
  asOn: string,
  ageLimitDays: number,
  ccLedgerId: number | null = null
): WorkingCapitalBasis {
  const debtors = outstandings(db, 'receivable', asOn, { includeBills: true })
  const creditors = outstandings(db, 'payable', asOn, { includeBills: false })

  let within = 0
  let beyond = 0
  const beyondLimitParties: { name: string; pending: number }[] = []
  for (const p of debtors) {
    let old = 0
    for (const bill of p.bills) {
      // Age, not overdue days: a bank's cut-off runs from the invoice, not from the due date.
      if (bill.ageDays > ageLimitDays) old += bill.pending
      else within += bill.pending
    }
    if (old > 0) {
      beyond += old
      beyondLimitParties.push({ name: p.name, pending: old })
    }
  }

  return {
    asOn,
    stockPaise: stockValue(db, asOn),
    withinLimitPaise: within,
    beyondLimitPaise: beyond,
    totalDebtorsPaise: within + beyond,
    creditorsPaise: creditors.reduce((s, c) => s + c.pending, 0),
    utilisedPaise: ccUtilised(db, asOn, ccLedgerId),
    beyondLimitParties: beyondLimitParties.sort((a, b) => b.pending - a.pending)
  }
}

export function computeStockStatement(
  db: DB,
  asOn: string,
  margins: DrawingPowerMargins = DEFAULT_MARGINS,
  ccLedgerId: number | null = null
): StockStatement {
  const basis = workingCapitalBasis(db, asOn, margins.debtorAgeLimitDays, ccLedgerId)

  const input = {
    asOn,
    stockPaise: basis.stockPaise,
    eligibleDebtorsPaise: basis.withinLimitPaise,
    ineligibleDebtorsPaise: basis.beyondLimitPaise,
    creditorsPaise: basis.creditorsPaise,
    utilisedPaise: basis.utilisedPaise
  }

  const filed = db.prepare('SELECT id, filed_on AS filedOn, notes FROM stock_statements WHERE as_on = ?').get(asOn) as
    | { id: number; filedOn: string | null; notes: string | null }
    | undefined

  return {
    ...drawingPower(input, margins),
    id: filed?.id ?? null,
    filedOn: filed?.filedOn ?? null,
    notes: filed?.notes ?? null,
    margins,
    excludedParties: basis.beyondLimitParties
  }
}

/**
 * File the statement — store it exactly as sent.
 *
 * The margins are copied on to the row rather than read back from a setting, because this is a
 * filed document: what was sent to the bank in June must still read as it read in June, even
 * after somebody back-dates a purchase invoice into that month or the branch changes a margin.
 */
export function fileStockStatement(
  db: DB,
  asOn: string,
  margins: DrawingPowerMargins,
  notes: string | null,
  ccLedgerId: number | null = null
): StockStatement {
  const computed = computeStockStatement(db, asOn, margins, ccLedgerId)
  const existing = db.prepare('SELECT id FROM stock_statements WHERE as_on = ?').get(asOn) as { id: number } | undefined
  if (existing) throw new Error(`A statement as at ${asOn} has already been filed`)
  const id = Number(
    db
      .prepare(
        `INSERT INTO stock_statements (as_on, stock, eligible_debtors, ineligible_debtors, creditors, utilised,
          stock_margin_percent, debtor_margin_percent, debtor_age_limit_days, sanctioned_limit, drawing_power,
          filed_on, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        asOn, computed.stockPaise, computed.eligibleDebtorsPaise, computed.ineligibleDebtorsPaise,
        computed.creditorsPaise, computed.utilisedPaise, margins.stockMarginPercent,
        margins.debtorMarginPercent, margins.debtorAgeLimitDays, margins.sanctionedLimitPaise,
        computed.drawingPowerPaise, todayISO(), notes
      ).lastInsertRowid
  )
  writeAudit(db, 'stock_statement', id, 'create', null, { asOn, drawingPower: computed.drawingPowerPaise })
  return { ...computed, id, filedOn: todayISO(), notes }
}

export interface FiledStatement {
  id: number
  asOn: string
  stockPaise: number
  eligibleDebtorsPaise: number
  creditorsPaise: number
  drawingPowerPaise: number
  utilisedPaise: number
  filedOn: string | null
}

export function listFiledStatements(db: DB): FiledStatement[] {
  return db
    .prepare(
      `SELECT id, as_on AS asOn, stock AS stockPaise, eligible_debtors AS eligibleDebtorsPaise,
              creditors AS creditorsPaise, drawing_power AS drawingPowerPaise, utilised AS utilisedPaise,
              filed_on AS filedOn
       FROM stock_statements ORDER BY as_on DESC`
    )
    .all() as FiledStatement[]
}

export function unfileStockStatement(db: DB, id: number): void {
  db.prepare('DELETE FROM stock_statements WHERE id = ?').run(id)
  writeAudit(db, 'stock_statement', id, 'delete', null, null)
}
