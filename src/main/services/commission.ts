/**
 * Salesperson commission, on collection rather than on billing (roadmap #380).
 *
 * The party master already carries a salesperson (#156). What was missing was the earning event.
 * Commission paid when the invoice is raised is paid again in working capital when the invoice is
 * never collected, and nobody ever claws the first payment back — so the event here is money
 * actually received.
 *
 * How "collected" is measured matters more than it looks. It is derived from the SAME
 * bill-by-bill allocation the ageing report uses, read at the start and the end of the period:
 * what a bill has been settled by on the closing date, less what it had been settled by on the
 * opening one. Re-implementing the allocation here would eventually let the commission statement
 * and the ageing report disagree about whether a customer has paid, and only one of those two
 * reports gets checked.
 */
import type { DB } from '../db/connection'
import { allocateBills } from '@shared/outstanding'
import {
  commissionStatements,
  type CollectionEvent,
  type CommissionBasis,
  type CommissionRule,
  type CommissionStatement
} from '@shared/commission'
import { addDays } from '@shared/dates'
import { descendantIdsByName } from './masters'
import { openingEvent, partyEventsBatch } from './analysis'
import { IN_BOOKS } from './vouchers'
import { writeAudit } from './audit'

// ---------- who earns what ----------

export interface CommissionScheme {
  id: number
  salesperson: string
  rateBp: number
  basis: CommissionBasis
  fromDate: string
  active: boolean
}

interface SchemeRow {
  id: number; salesperson: string; rate_bp: number; basis: CommissionBasis; from_date: string; active: number
}

const mapScheme = (r: SchemeRow): CommissionScheme => ({
  id: r.id,
  salesperson: r.salesperson,
  rateBp: r.rate_bp,
  basis: r.basis,
  fromDate: r.from_date,
  active: r.active === 1
})

export function listCommissionSchemes(db: DB): CommissionScheme[] {
  return (db.prepare('SELECT * FROM commission_schemes ORDER BY salesperson, from_date DESC').all() as SchemeRow[]).map(mapScheme)
}

export function saveCommissionScheme(
  db: DB,
  input: { salesperson: string; rateBp: number; basis: CommissionBasis; fromDate: string; active?: boolean },
  id?: number
): CommissionScheme {
  if (input.rateBp < 0 || input.rateBp > 10000) throw new Error('A commission rate is between 0% and 100%')
  const args = [input.salesperson.trim(), input.rateBp, input.basis, input.fromDate, input.active === false ? 0 : 1]
  if (id) {
    db.prepare('UPDATE commission_schemes SET salesperson = ?, rate_bp = ?, basis = ?, from_date = ?, active = ? WHERE id = ?')
      .run(...args, id)
  } else {
    id = Number(
      db.prepare('INSERT INTO commission_schemes (salesperson, rate_bp, basis, from_date, active) VALUES (?, ?, ?, ?, ?)')
        .run(...args).lastInsertRowid
    )
  }
  const saved = listCommissionSchemes(db).find((s) => s.id === id)!
  writeAudit(db, 'commission_scheme', id, 'create', null, saved)
  return saved
}

export function deleteCommissionScheme(db: DB, id: number): void {
  db.prepare('DELETE FROM commission_schemes WHERE id = ?').run(id)
}

/**
 * The rate in force for a person on a date.
 *
 * The latest scheme starting on or before the date wins. A rate change is not retrospective: last
 * quarter's collections were earned under last quarter's rate, and recomputing them at the new
 * one is how a salesperson's paid statement stops matching their own.
 */
function ruleFor(schemes: CommissionScheme[], salesperson: string, on: string): CommissionRule | null {
  const mine = schemes
    .filter((s) => s.active && s.salesperson.toLowerCase() === salesperson.toLowerCase() && s.fromDate <= on)
    .sort((a, b) => b.fromDate.localeCompare(a.fromDate))
  const found = mine[0]
  return found ? { rateBp: found.rateBp, basis: found.basis } : null
}

// ---------- what a bill has been settled by, on a date ----------

interface BillState {
  amount: number
  settled: number
  date: string
}

function settledByDate(db: DB, partyIds: number[], openings: Map<number, number>, creditDays: Map<number, number | null>, asOn: string): Map<number, Map<string, BillState>> {
  const events = partyEventsBatch(db, partyIds, asOn, 1)
  const out = new Map<number, Map<string, BillState>>()
  for (const partyId of partyIds) {
    const all = [...openingEvent(asOn, openings.get(partyId) ?? 0, 1), ...(events.get(partyId) ?? [])]
    const { bills, settled } = allocateBills(all, asOn, creditDays.get(partyId) ?? null)
    const map = new Map<string, BillState>()
    for (const b of bills) map.set(b.number, { amount: b.amount, settled: b.amount - b.pending, date: b.date })
    // A bill that closed no longer appears among the open ones, so its full value is settled.
    for (const s of settled) map.set(s.number, { amount: s.amount, settled: s.amount, date: s.date })
    out.set(partyId, map)
  }
  return out
}

/** Taxable value of an invoice: its total less every line that sits on a tax ledger. */
function invoiceTaxable(db: DB, number: string): { total: number; taxable: number } | null {
  const voucher = db
    .prepare(`SELECT v.id FROM vouchers v WHERE v.number = ? COLLATE NOCASE AND ${IN_BOOKS} ORDER BY v.id DESC LIMIT 1`)
    .get(number) as { id: number } | undefined
  if (!voucher) return null
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE 0 END), 0) AS total,
              COALESCE(SUM(CASE WHEN l.tax_type IS NOT NULL THEN vl.amount ELSE 0 END), 0) AS tax
       FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id WHERE vl.voucher_id = ?`
    )
    .get(voucher.id) as { total: number; tax: number }
  return { total: row.total, taxable: Math.max(0, row.total - row.tax) }
}

export interface CommissionReport {
  from: string
  to: string
  statements: CommissionStatement[]
  totalCommissionPaise: number
  totalCollectedPaise: number
  /** Collections against parties whose salesperson is nobody — reported so the gap is visible. */
  unassignedCollectedPaise: number
  /** Salespeople who collected money but have no scheme, so nothing was computed for them. */
  withoutScheme: string[]
}

/**
 * Commission earned in a period.
 *
 * Every row is a bill and the money that came in against it between the two dates. An invoice
 * raised in the period and left unpaid contributes nothing at all — there is no row for it,
 * because there is nothing to pay a commission on yet.
 */
export function commissionReport(db: DB, from: string, to: string): CommissionReport {
  const debtorGroups = descendantIdsByName(db, ['Sundry Debtors'])
  const parties = (
    db.prepare('SELECT id, name, opening_balance, group_id, credit_days, salesperson FROM ledgers').all() as {
      id: number; name: string; opening_balance: number; group_id: number; credit_days: number | null; salesperson: string | null
    }[]
  ).filter((l) => debtorGroups.has(l.group_id))

  const ids = parties.map((p) => p.id)
  const openings = new Map(parties.map((p) => [p.id, p.opening_balance]))
  const creditDays = new Map(parties.map((p) => [p.id, p.credit_days]))
  const before = settledByDate(db, ids, openings, creditDays, addDays(from, -1))
  const after = settledByDate(db, ids, openings, creditDays, to)

  const schemes = listCommissionSchemes(db)
  const events: CollectionEvent[] = []
  let unassigned = 0
  const collectors = new Set<string>()

  for (const party of parties) {
    const start = before.get(party.id) ?? new Map<string, BillState>()
    const end = after.get(party.id) ?? new Map<string, BillState>()
    for (const [number, state] of end) {
      const collected = state.settled - (start.get(number)?.settled ?? 0)
      if (collected <= 0) continue
      if (!party.salesperson) {
        unassigned += collected
        continue
      }
      collectors.add(party.salesperson)
      const invoice = invoiceTaxable(db, number)
      events.push({
        voucherId: 0,
        date: state.date,
        billNumber: number,
        partyName: party.name,
        salesperson: party.salesperson,
        collectedPaise: collected,
        invoiceTotalPaise: invoice?.total ?? state.amount,
        invoiceTaxablePaise: invoice?.taxable ?? state.amount
      })
    }
  }

  const statements = commissionStatements(events, (who) => ruleFor(schemes, who, to))
  const paid = new Set(statements.map((s) => s.salesperson))

  return {
    from,
    to,
    statements,
    totalCommissionPaise: statements.reduce((s, x) => s + x.commissionPaise, 0),
    totalCollectedPaise: events.reduce((s, e) => s + e.collectedPaise, 0),
    unassignedCollectedPaise: unassigned,
    withoutScheme: [...collectors].filter((c) => !paid.has(c)).sort()
  }
}

export interface CommissionDraft {
  date: string
  narration: string
  lines: { ledgerName: string; group: string; drCr: 'dr' | 'cr'; amount: number }[]
  total: number
}

/**
 * The journal for a period's commission — a draft, never posted here.
 *
 * Credited to a payable rather than paid straight out: commission is earned when the money comes
 * in and paid when the business chooses to pay it, and collapsing the two loses the record of
 * what is owed to whom.
 */
export function commissionDraft(db: DB, from: string, to: string): CommissionDraft | null {
  const report = commissionReport(db, from, to)
  if (report.totalCommissionPaise === 0) return null
  return {
    date: to,
    narration: `Salesperson commission on collections, ${from} to ${to}`,
    lines: [
      { ledgerName: 'Commission on Sales', group: 'Indirect Expenses', drCr: 'dr', amount: report.totalCommissionPaise },
      ...report.statements.map((s) => ({
        ledgerName: `Commission Payable — ${s.salesperson}`,
        group: 'Current Liabilities',
        drCr: 'cr' as const,
        amount: s.commissionPaise
      }))
    ],
    total: report.totalCommissionPaise
  }
}
