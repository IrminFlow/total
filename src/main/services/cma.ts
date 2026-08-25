/**
 * CMA data for a working-capital application (roadmap #371).
 *
 * The pack itself — six forms, the ratio sheet, and which cell came from where — is pure
 * arithmetic in `@shared/cma`. This file does the two things that need a database:
 *
 *   1. Reads the AUDITED columns out of the books, once per financial year the books cover.
 *   2. Stores the estimate and projection columns the user typed, and nothing else. The audited
 *      columns are never written down. They are recomputed every time the pack is opened, because
 *      the books are what the bank's own verification will be run against; a stored copy would be
 *      free to drift, and the pack would be the half that was wrong.
 *
 * Where the working-capital figures come from is deliberate: `workingCapitalBasis` in
 * borrowing.ts, the same function the monthly stock statement and the drawing-power computation
 * use. It is the same borrower and the same stock. Two modules deriving "book debts" separately
 * is two answers to a question the bank asks once.
 */
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { fyFromStartYear } from '@shared/dates'
import {
  buildCmaPack,
  zeroBookFigures,
  classifyExpenseLedger,
  classifyIncomeLedger,
  isCmaLineKey,
  facilityTotals,
  CMA_COLUMN_KEYS,
  type CmaBookFigures,
  type CmaColumnKey,
  type CmaColumnSpec,
  type CmaFacility,
  type CmaPack,
  type CmaTypedValues
} from '@shared/cma'
import { listGroups } from './masters'
import { stockValue } from './reports'
import { workingCapitalBasis } from './borrowing'
import { loanView, listLoans } from './borrowing'
import { IN_BOOKS } from './vouchers'
import { writeAudit } from './audit'

// ---------- the pack row ----------

export interface CmaPackRow {
  id: number
  name: string
  /** FY start year of the current-year ESTIMATE column. The rest count out from it. */
  estimateFyStartYear: number
  notes: string | null
  createdAt: string
  updatedAt: string
}

export function listCmaPacks(db: DB): CmaPackRow[] {
  return db
    .prepare(
      `SELECT id, name, estimate_fy_start_year AS estimateFyStartYear, notes,
              created_at AS createdAt, updated_at AS updatedAt
       FROM cma_packs ORDER BY estimate_fy_start_year DESC, id DESC`
    )
    .all() as CmaPackRow[]
}

export function getCmaPack(db: DB, id: number): CmaPackRow | null {
  return (
    (db
      .prepare(
        `SELECT id, name, estimate_fy_start_year AS estimateFyStartYear, notes,
                created_at AS createdAt, updated_at AS updatedAt FROM cma_packs WHERE id = ?`
      )
      .get(id) as CmaPackRow | undefined) ?? null
  )
}

export interface CmaPackInputRow {
  name: string
  estimateFyStartYear: number
  notes: string | null
}

export function saveCmaPack(db: DB, input: CmaPackInputRow, id?: number): CmaPackRow {
  if (id) {
    db.prepare(
      `UPDATE cma_packs SET name = ?, estimate_fy_start_year = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(input.name, input.estimateFyStartYear, input.notes, id)
    writeAudit(db, 'cma_pack', id, 'update', null, input)
    return getCmaPack(db, id)!
  }
  const newId = Number(
    db
      .prepare('INSERT INTO cma_packs (name, estimate_fy_start_year, notes) VALUES (?, ?, ?)')
      .run(input.name, input.estimateFyStartYear, input.notes).lastInsertRowid
  )
  writeAudit(db, 'cma_pack', newId, 'create', null, input)
  return getCmaPack(db, newId)!
}

export function deleteCmaPack(db: DB, id: number): void {
  db.prepare('DELETE FROM cma_packs WHERE id = ?').run(id)
  writeAudit(db, 'cma_pack', id, 'delete', null, null)
}

// ---------- the typed cells ----------

/**
 * Store one typed figure, or clear it.
 *
 * Clearing is not the same as storing zero, and the difference is the whole point of the third
 * column state. A cleared cell has no row, so a column with nothing in it renders blank; a cell
 * storing zero renders "—" as an asserted nil. A banker can tell the two apart and so must the app.
 */
export function setCmaInput(db: DB, packId: number, columnKey: CmaColumnKey, lineKey: string, value: number | null): void {
  if (!isCmaLineKey(lineKey)) throw new Error(`Unknown CMA line "${lineKey}"`)
  if (value === null) {
    db.prepare('DELETE FROM cma_inputs WHERE pack_id = ? AND column_key = ? AND line_key = ?').run(packId, columnKey, lineKey)
    return
  }
  db.prepare(
    `INSERT INTO cma_inputs (pack_id, column_key, line_key, value) VALUES (?, ?, ?, ?)
     ON CONFLICT (pack_id, column_key, line_key) DO UPDATE SET value = excluded.value`
  ).run(packId, columnKey, lineKey, Math.round(value))
  db.prepare(`UPDATE cma_packs SET updated_at = datetime('now') WHERE id = ?`).run(packId)
}

function typedValues(db: DB, packId: number): CmaTypedValues {
  const rows = db
    .prepare('SELECT column_key AS columnKey, line_key AS lineKey, value FROM cma_inputs WHERE pack_id = ?')
    .all(packId) as { columnKey: CmaColumnKey; lineKey: string; value: number }[]
  const out: CmaTypedValues = {}
  for (const r of rows) {
    const col = (out[r.columnKey] ??= {})
    col[r.lineKey] = r.value
  }
  return out
}

/**
 * Copy one column's figures into another as a starting point for typing.
 *
 * This is not the app inventing a projection. It is the user saying "start from last year", the
 * copy lands as TYPED cells that they own and must go through, and the column is marked as their
 * claim exactly as if they had keyed every figure. Without it the honest path — five columns of
 * forty lines each — is tedious enough that people go back to the spreadsheet.
 */
export function prefillCmaColumn(db: DB, packId: number, fromKey: CmaColumnKey, toKey: CmaColumnKey, company: CompanyInfo): number {
  const pack = getCmaPack(db, packId)
  if (!pack) throw new Error('No such CMA pack')
  if (fromKey === toKey) throw new Error('Cannot prefill a column from itself')
  const built = buildCmaPackFor(db, pack, company)
  const fromIndex = built.columns.findIndex((c) => c.key === fromKey)
  if (fromIndex < 0 || built.columns[fromIndex]!.state === 'empty') {
    throw new Error('That column has no figures to copy')
  }
  let copied = 0
  const write = db.transaction(() => {
    for (const form of built.forms) {
      for (const line of form.lines) {
        if (!line.editable) continue
        const cell = line.cells[fromIndex]!
        if (cell.value === null) continue
        setCmaInput(db, packId, toKey, line.key, cell.value)
        copied++
      }
    }
  })
  write()
  return copied
}

// ---------- Form I, the facilities ----------

export interface CmaFacilityInput {
  facility: string
  existingLimitPaise: number
  proposedLimitPaise: number
  /** Ignored when `ledgerId` is set — the books answer instead. */
  outstandingPaise: number | null
  ledgerId: number | null
  security: string | null
  notes: string | null
  seq: number
}

interface FacilityRow {
  id: number
  seq: number
  facility: string
  existingLimit: number
  proposedLimit: number
  outstanding: number | null
  ledgerId: number | null
  ledgerName: string | null
  security: string | null
  notes: string | null
}

/**
 * A facility pointed at a ledger reports what the ledger says, not what someone typed months ago.
 * An overdraft is a credit balance, so it is negated to read as an amount owed.
 */
function facilityOutstanding(db: DB, ledgerId: number, asOn: string): number {
  const row = db
    .prepare(
      `SELECT l.opening_balance
            + COALESCE((SELECT SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END)
                        FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
                        WHERE vl.ledger_id = l.id AND v.date <= ? AND ${IN_BOOKS}), 0) AS balance
       FROM ledgers l WHERE l.id = ?`
    )
    .get(asOn, ledgerId) as { balance: number } | undefined
  return Math.max(0, -(row?.balance ?? 0))
}

export function listCmaFacilities(db: DB, packId: number, asOn: string): CmaFacility[] {
  const rows = db
    .prepare(
      `SELECT f.id, f.seq, f.facility, f.existing_limit AS existingLimit, f.proposed_limit AS proposedLimit,
              f.outstanding, f.ledger_id AS ledgerId, l.name AS ledgerName, f.security, f.notes
       FROM cma_facilities f LEFT JOIN ledgers l ON l.id = f.ledger_id
       WHERE f.pack_id = ? ORDER BY f.seq, f.id`
    )
    .all(packId) as FacilityRow[]
  return rows.map((r) => ({
    id: r.id,
    seq: r.seq,
    facility: r.facility,
    existingLimitPaise: r.existingLimit,
    outstandingPaise: r.ledgerId ? facilityOutstanding(db, r.ledgerId, asOn) : r.outstanding,
    outstandingFromBooks: r.ledgerId !== null,
    proposedLimitPaise: r.proposedLimit,
    security: r.security,
    ledgerId: r.ledgerId,
    ledgerName: r.ledgerName,
    notes: r.notes
  }))
}

export function saveCmaFacility(db: DB, packId: number, input: CmaFacilityInput, id?: number): number {
  if (id) {
    db.prepare(
      `UPDATE cma_facilities SET seq = ?, facility = ?, existing_limit = ?, proposed_limit = ?,
              outstanding = ?, ledger_id = ?, security = ?, notes = ? WHERE id = ? AND pack_id = ?`
    ).run(
      input.seq, input.facility, input.existingLimitPaise, input.proposedLimitPaise,
      input.ledgerId ? null : input.outstandingPaise, input.ledgerId, input.security, input.notes, id, packId
    )
    return id
  }
  return Number(
    db
      .prepare(
        `INSERT INTO cma_facilities (pack_id, seq, facility, existing_limit, proposed_limit, outstanding, ledger_id, security, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        packId, input.seq, input.facility, input.existingLimitPaise, input.proposedLimitPaise,
        input.ledgerId ? null : input.outstandingPaise, input.ledgerId, input.security, input.notes
      ).lastInsertRowid
  )
}

export function deleteCmaFacility(db: DB, id: number): void {
  db.prepare('DELETE FROM cma_facilities WHERE id = ?').run(id)
}

// ---------- reading a financial year out of the books ----------

interface LedgerLite {
  id: number
  name: string
  groupId: number
  openingBalance: number
}

/** Root group each group hangs under, by group id. A CMA bucket is decided at the root. */
function topGroupNames(db: DB): Map<number, string> {
  const groups = listGroups(db)
  const byId = new Map(groups.map((g) => [g.id, g]))
  const out = new Map<number, string>()
  for (const g of groups) {
    let node = g
    // Depth guard: a cycle in the group tree would otherwise hang the whole report, and a report
    // that hangs is indistinguishable from an app that crashed.
    for (let i = 0; i < 32 && node.parentId !== null; i++) {
      const parent = byId.get(node.parentId)
      if (!parent) break
      node = parent
    }
    out.set(g.id, node.name)
  }
  return out
}

function groupIdsUnder(db: DB, names: string[]): Set<number> {
  const groups = listGroups(db)
  const roots = groups.filter((g) => names.includes(g.name)).map((g) => g.id)
  const out = new Set<number>(roots)
  let grew = true
  while (grew) {
    grew = false
    for (const g of groups) {
      if (g.parentId !== null && out.has(g.parentId) && !out.has(g.id)) {
        out.add(g.id)
        grew = true
      }
    }
  }
  return out
}

function ledgersLite(db: DB): LedgerLite[] {
  return db
    .prepare('SELECT id, name, group_id AS groupId, opening_balance AS openingBalance FROM ledgers')
    .all() as LedgerLite[]
}

/** Signed dr-positive movement per ledger over a period. */
function movements(db: DB, from: string, to: string): Map<number, number> {
  const rows = db
    .prepare(
      `SELECT vl.ledger_id AS id, SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END) AS amt
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
       WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS} GROUP BY vl.ledger_id`
    )
    .all(from, to) as { id: number; amt: number }[]
  return new Map(rows.map((r) => [r.id, r.amt]))
}

/** Signed dr-positive closing balance per ledger, opening included. */
function closingBalances(db: DB, ledgers: LedgerLite[], asOn: string): Map<number, number> {
  const rows = db
    .prepare(
      `SELECT vl.ledger_id AS id, SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END) AS amt
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
       WHERE v.date <= ? AND ${IN_BOOKS} GROUP BY vl.ledger_id`
    )
    .all(asOn) as { id: number; amt: number }[]
  const moved = new Map(rows.map((r) => [r.id, r.amt]))
  return new Map(ledgers.map((l) => [l.id, l.openingBalance + (moved.get(l.id) ?? 0)]))
}

/** Sales to parties flagged SEZ or export on the ledger master, over a period. */
function exportSales(db: DB, from: string, to: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(t.total), 0) AS total
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN ledgers p ON p.id = v.party_ledger_id
       JOIN (SELECT voucher_id, SUM(amount) AS total FROM voucher_lines WHERE dr_cr = 'dr' GROUP BY voucher_id) t
         ON t.voucher_id = v.id
       WHERE vt.kind = 'sales' AND p.export_type IS NOT NULL
         AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}`
    )
    .get(from, to) as { total: number }
  return row.total
}

/**
 * Term-loan interest and principal falling due inside a year, off the loan register (#370).
 *
 * DSCR without this is a ratio nobody can compute from a trial balance, which is exactly why a CA
 * charges for the pack. The register already holds the amortisation schedule; asking it is free.
 * Working-capital facilities are excluded — a cash-credit limit has no instalment to service.
 */
function termLoanService(db: DB, from: string, to: string): { interest: number; instalments: number } {
  let interest = 0
  let instalments = 0
  for (const loan of listLoans(db)) {
    if (loan.kind === 'working_capital') continue
    const view = loanView(db, loan.id, to, from, to)
    for (const row of view.schedule.rows) {
      if (row.dueDate < from || row.dueDate > to) continue
      interest += row.interestPaise
      instalments += row.principalPaise
    }
  }
  return { interest, instalments }
}

/**
 * Instalments of term loans falling due in the TWELVE MONTHS AFTER the balance sheet date. Form
 * III puts them in current liabilities: money the business must find inside the year is working
 * capital's problem whatever the loan agreement calls it.
 */
function currentPortionOfTermLoans(db: DB, asOn: string): number {
  const next = `${Number(asOn.slice(0, 4)) + 1}${asOn.slice(4)}`
  let total = 0
  for (const loan of listLoans(db)) {
    if (loan.kind === 'working_capital') continue
    const view = loanView(db, loan.id, asOn, asOn, next)
    for (const row of view.schedule.rows) {
      if (row.dueDate > asOn && row.dueDate <= next) total += row.principalPaise
    }
  }
  return total
}

/** Six months, which is Form III's own cut-off for a receivable that has gone stale. */
const CMA_RECEIVABLE_LIMIT_DAYS = 182

export function cmaBookFigures(db: DB, from: string, to: string): CmaBookFigures {
  const f = zeroBookFigures()
  const ledgers = ledgersLite(db)
  const tops = topGroupNames(db)
  const move = movements(db, from, to)
  const closing = closingBalances(db, ledgers, to)

  // --- Form II, the flows ---
  for (const l of ledgers) {
    const top = tops.get(l.groupId) ?? ''
    const amount = move.get(l.id) ?? 0
    if (amount === 0) continue
    if (top === 'Sales Accounts' || top === 'Direct Incomes' || top === 'Indirect Incomes') {
      // Income is credit-natured: flip so revenue reads positive.
      f[classifyIncomeLedger(top)] += -amount
    } else if (top === 'Purchase Accounts' || top === 'Direct Expenses' || top === 'Indirect Expenses') {
      f[classifyExpenseLedger(top, l.name)] += amount
    }
  }
  f.exportSales = exportSales(db, from, to)

  // Drawings: debits to the capital account across the year. Reserves are excluded — a transfer
  // to reserves is not money leaving the business.
  const capitalIds = groupIdsUnder(db, ['Capital Account'])
  const reserveIds = groupIdsUnder(db, ['Reserves & Surplus'])
  for (const l of ledgers) {
    if (!capitalIds.has(l.groupId) || reserveIds.has(l.groupId)) continue
    f.drawings += Math.max(0, move.get(l.id) ?? 0)
  }

  const dayBefore = new Date(Date.parse(from) - 86_400_000).toISOString().slice(0, 10)
  f.openingStock = stockValue(db, dayBefore)
  f.closingStock = stockValue(db, to)

  // --- Form III, the position ---
  const basis = workingCapitalBasis(db, to, CMA_RECEIVABLE_LIMIT_DAYS)
  f.inventory = basis.stockPaise
  f.receivablesWithinSixMonths = basis.withinLimitPaise
  f.receivablesOverSixMonths = basis.beyondLimitPaise
  f.sundryCreditors = basis.creditorsPaise
  f.bankBorrowingShortTerm = basis.utilisedPaise

  const sumOf = (names: string[], sign: 1 | -1, onlyPositive = false): number => {
    const ids = groupIdsUnder(db, names)
    let total = 0
    for (const l of ledgers) {
      if (!ids.has(l.groupId)) continue
      const bal = sign * (closing.get(l.id) ?? 0)
      total += onlyPositive ? Math.max(0, bal) : bal
    }
    return total
  }

  f.statutoryDues = sumOf(['Duties & Taxes'], -1)
  f.provisions = sumOf(['Provisions'], -1)
  f.currentInstalmentsOfTermLoans = currentPortionOfTermLoans(db, to)

  // Everything under Current Liabilities that is not already on a line of its own. Bank OD lives
  // under Loans (Liability), so it is added back rather than subtracted here.
  const allCurrentLiabilities = sumOf(['Current Liabilities'], -1)
  f.otherCurrentLiabilities = Math.max(
    0,
    allCurrentLiabilities - f.sundryCreditors - f.statutoryDues - f.provisions
  )

  // Term liabilities: what is borrowed long, less the slice already shown as current. The OD is
  // short-term borrowing and is on its own line, so it comes out too.
  const borrowings = sumOf(['Loans (Liability)'], -1)
  f.termLiabilities = Math.max(0, borrowings - f.bankBorrowingShortTerm - f.currentInstalmentsOfTermLoans)
  f.otherNonCurrentLiabilities = sumOf(['Branch / Divisions'], -1)

  f.capital = sumOf(['Capital Account'], -1) - sumOf(['Reserves & Surplus'], -1)
  // The year's own profit belongs to the owners the moment it is earned, so it is part of net
  // worth on the same date. Form III's net worth would otherwise be short by the year's earnings.
  const yearProfit =
    f.netSales + f.otherOperatingIncome + f.otherIncome + f.closingStock - f.openingStock -
    f.rawMaterials - f.directWages - f.powerAndFuel - f.otherManufacturingExpenses - f.depreciation -
    f.sellingExpenses - f.administrativeExpenses - f.otherIndirectExpenses - f.interest - f.taxProvision
  f.reserves = sumOf(['Reserves & Surplus'], -1) + yearProfit

  f.cashAndBank = sumOf(['Cash-in-Hand', 'Bank Accounts'], 1, true)
  f.advancesAndDeposits = sumOf(['Loans & Advances (Asset)', 'Deposits (Asset)'], 1)
  const allCurrentAssets = sumOf(['Current Assets'], 1)
  f.otherCurrentAssets = Math.max(
    0,
    allCurrentAssets - f.cashAndBank - basis.totalDebtorsPaise - f.advancesAndDeposits - stockLedgerValue(db, ledgers, closing)
  )

  f.netFixedAssets = sumOf(['Fixed Assets'], 1)
  f.investments = sumOf(['Investments'], 1)
  f.otherNonCurrentAssets = 0
  f.intangibleAssets = sumOf(['Misc. Expenses (ASSET)'], 1)

  const service = termLoanService(db, from, to)
  f.termLoanInterest = service.interest
  f.termLoanInstalments = service.instalments

  return f
}

/** Stock sitting in a Stock-in-Hand LEDGER rather than in the item register, so it is not
 *  counted twice against `inventory` (which comes from the item register). */
function stockLedgerValue(db: DB, ledgers: LedgerLite[], closing: Map<number, number>): number {
  const ids = groupIdsUnder(db, ['Stock-in-Hand'])
  let total = 0
  for (const l of ledgers) if (ids.has(l.groupId)) total += closing.get(l.id) ?? 0
  return total
}

// ---------- assembling the pack ----------

/**
 * Whether the books actually cover a financial year.
 *
 * A pack that prints zeros for a year the business did not have is the failure this guards
 * against: it looks complete, it is submitted, and it is refused. A company two years old has one
 * audited year and the second column has to say so, so the user can key it off their printed
 * accounts or explain its absence in the covering letter.
 *
 * "Covered" means the books OPENED on or before the year started — a year the books joined
 * halfway through is a partial year, and a partial year presented as audited is worse than a
 * blank one.
 */
function booksCover(company: CompanyInfo, fyStartYear: number): boolean {
  return company.booksFrom <= fyStartYear
}

export function cmaColumnSpecs(company: CompanyInfo, estimateFyStartYear: number): CmaColumnSpec[] {
  const offsets: Record<CmaColumnKey, number> = { a2: -2, a1: -1, e: 0, p1: 1, p2: 2 }
  return CMA_COLUMN_KEYS.map((key) => {
    const startYear = estimateFyStartYear + offsets[key]
    const fy = fyFromStartYear(startYear)
    return {
      key,
      fyStartYear: startYear,
      from: fy.from,
      to: fy.to,
      // Only the audited columns ever read from the books; the flag is meaningless elsewhere.
      booksCover: offsets[key] < 0 && booksCover(company, startYear)
    }
  })
}

function buildCmaPackFor(db: DB, pack: CmaPackRow, company: CompanyInfo): CmaPack {
  const specs = cmaColumnSpecs(company, pack.estimateFyStartYear)
  const books: Partial<Record<CmaColumnKey, CmaBookFigures>> = {}
  for (const spec of specs) {
    if (spec.booksCover) books[spec.key] = cmaBookFigures(db, spec.from, spec.to)
  }
  return buildCmaPack({ specs, books, typed: typedValues(db, pack.id) })
}

export interface CmaPackView extends CmaPack {
  pack: CmaPackRow
  facilities: CmaFacility[]
  facilityTotals: ReturnType<typeof facilityTotals>
  /** Human warnings the user has to read before sending the pack to a bank. */
  warnings: string[]
}

export function cmaPackView(db: DB, packId: number, company: CompanyInfo): CmaPackView {
  const pack = getCmaPack(db, packId)
  if (!pack) throw new Error('No such CMA pack')
  const built = buildCmaPackFor(db, pack, company)
  // Form I's outstandings are read as at the estimate year's close, which is the date the
  // application is made on.
  const asOn = fyFromStartYear(pack.estimateFyStartYear).to
  const facilities = listCmaFacilities(db, packId, asOn)

  const warnings: string[] = []
  for (const col of built.columns) {
    if (col.source === 'audited' && !col.booksCover) {
      warnings.push(
        `${col.label} is an audited year the books do not cover — the figures have to be keyed from that year's accounts, or the bank will read the column as nil.`
      )
    } else if (col.state === 'empty') {
      warnings.push(`${col.label} has no figures yet.`)
    }
  }

  return {
    ...built,
    pack,
    facilities,
    facilityTotals: facilityTotals(facilities),
    warnings
  }
}
