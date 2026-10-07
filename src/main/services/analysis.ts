import type { DB } from '../db/connection'
import type { OutstandingBill, OutstandingParty, RegisterMonthRow } from '@shared/reports'
import { allocateBills, type BillEvent, type BillRef } from '@shared/outstanding'
import { fyOf } from '@shared/dates'
import { descendantIdsByName } from './masters'
import { IN_BOOKS } from './vouchers'

/** Account roots whose lines make up a register's taxable value — the Registers screen's
 *  definition, shared with the dashboard's net-of-notes trade series below. */
export const REGISTER_ROOTS: Record<'sales' | 'purchase', string[]> = {
  sales: ['Sales Accounts', 'Direct Incomes', 'Indirect Incomes'],
  purchase: ['Purchase Accounts', 'Direct Expenses', 'Indirect Expenses']
}

/** One in-books sales/purchase voucher as the register counts it. */
export interface RegisterVoucherRow {
  voucherId: number
  date: string
  /** 'YYYY-MM' */
  month: string
  partyLedgerId: number | null
  /** `side` lines (sales: Cr, purchase: Dr) on the register's account roots — excludes tax. */
  taxable: number
  /** `side` lines on tax ledgers. */
  tax: number
  /** All Dr lines — the invoice total. */
  total: number
}

/** The register at voucher grain — the single definition both registerByMonth and the dashboard
 *  aggregate. Soft-deleted, optional and unmatured post-dated vouchers are out (IN_BOOKS). */
export function registerVoucherRows(db: DB, kind: 'sales' | 'purchase', from: string, to: string): RegisterVoucherRow[] {
  const accountIds = descendantIdsByName(db, REGISTER_ROOTS[kind])
  const side = kind === 'sales' ? 'cr' : 'dr'

  const rows = db
    .prepare(
      `SELECT v.date AS date, substr(v.date, 1, 7) AS month, v.id AS voucherId, v.party_ledger_id AS partyLedgerId,
              vl.amount, l.group_id AS groupId, l.tax_type AS taxType, vl.dr_cr AS drCr
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN voucher_lines vl ON vl.voucher_id = v.id
       JOIN ledgers l ON l.id = vl.ledger_id
       WHERE vt.kind = ? AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}`
    )
    .all(kind, from, to) as {
      date: string; month: string; voucherId: number; partyLedgerId: number | null; amount: number
      groupId: number; taxType: string | null; drCr: string
    }[]

  const byVoucher = new Map<number, RegisterVoucherRow>()
  for (const r of rows) {
    let v = byVoucher.get(r.voucherId)
    if (!v) {
      v = { voucherId: r.voucherId, date: r.date, month: r.month, partyLedgerId: r.partyLedgerId, taxable: 0, tax: 0, total: 0 }
      byVoucher.set(r.voucherId, v)
    }
    if (r.drCr === side && accountIds.has(r.groupId)) v.taxable += r.amount
    if (r.drCr === side && r.taxType) v.tax += r.amount
    if (r.drCr === 'dr') v.total += r.amount
  }
  return [...byVoucher.values()]
}

/** Monthly sales/purchase register: voucher count, taxable, tax and invoice totals per month. */
export function registerByMonth(db: DB, kind: 'sales' | 'purchase', from: string, to: string): RegisterMonthRow[] {
  const months = new Map<string, RegisterMonthRow>()
  for (const v of registerVoucherRows(db, kind, from, to)) {
    const m = months.get(v.month) ?? { month: v.month, vouchers: 0, taxable: 0, tax: 0, total: 0 }
    m.vouchers++
    m.taxable += v.taxable
    m.tax += v.tax
    m.total += v.total
    months.set(v.month, m)
  }
  return [...months.values()].sort((a, b) => a.month.localeCompare(b.month))
}

/** One in-books credit/debit note's effect on the registers' taxable values: signed amounts on
 *  the sales roots (Cr − Dr: a sales return is negative, an outward debit note positive) and on
 *  the purchase roots (Dr − Cr: a purchase return is negative). Tax ledgers are not on those
 *  roots, so tax never counts — same as the registers' taxable column. */
export interface NoteVoucherRow {
  voucherId: number
  date: string
  month: string
  partyLedgerId: number | null
  sales: number
  purchases: number
}

export function noteVoucherRows(db: DB, from: string, to: string): NoteVoucherRow[] {
  const salesIds = descendantIdsByName(db, REGISTER_ROOTS.sales)
  const purchaseIds = descendantIdsByName(db, REGISTER_ROOTS.purchase)
  const rows = db
    .prepare(
      `SELECT v.date AS date, substr(v.date, 1, 7) AS month, v.id AS voucherId, v.party_ledger_id AS partyLedgerId,
              vl.amount, l.group_id AS groupId, vl.dr_cr AS drCr
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN voucher_lines vl ON vl.voucher_id = v.id
       JOIN ledgers l ON l.id = vl.ledger_id
       WHERE vt.kind IN ('credit_note', 'debit_note') AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}`
    )
    .all(from, to) as { date: string; month: string; voucherId: number; partyLedgerId: number | null; amount: number; groupId: number; drCr: string }[]
  const byVoucher = new Map<number, NoteVoucherRow>()
  for (const r of rows) {
    let v = byVoucher.get(r.voucherId)
    if (!v) {
      v = { voucherId: r.voucherId, date: r.date, month: r.month, partyLedgerId: r.partyLedgerId, sales: 0, purchases: 0 }
      byVoucher.set(r.voucherId, v)
    }
    if (salesIds.has(r.groupId)) v.sales += r.drCr === 'cr' ? r.amount : -r.amount
    if (purchaseIds.has(r.groupId)) v.purchases += r.drCr === 'dr' ? r.amount : -r.amount
  }
  return [...byVoucher.values()]
}

/** Net trade at voucher grain: the sales and purchase registers' taxable value plus the
 *  credit/debit-note adjustments above. The dashboard aggregates it by month and by party. */
export interface NetTradeRow {
  date: string
  month: string
  partyLedgerId: number | null
  sales: number
  purchases: number
}

export function netTradeRows(db: DB, from: string, to: string): NetTradeRow[] {
  const rows: NetTradeRow[] = []
  for (const r of registerVoucherRows(db, 'sales', from, to)) rows.push({ date: r.date, month: r.month, partyLedgerId: r.partyLedgerId, sales: r.taxable, purchases: 0 })
  for (const r of registerVoucherRows(db, 'purchase', from, to)) rows.push({ date: r.date, month: r.month, partyLedgerId: r.partyLedgerId, sales: 0, purchases: r.taxable })
  for (const r of noteVoucherRows(db, from, to)) rows.push({ date: r.date, month: r.month, partyLedgerId: r.partyLedgerId, sales: r.sales, purchases: r.purchases })
  return rows
}

/** Every party's movements + bill_refs, expressed as pure `BillEvent`s for `allocateBills` —
 *  two batched queries for the whole party set instead of two queries per party (the old N+1). */
function partyEventsBatch(db: DB, partyIds: number[], asOn: string, sign: number): Map<number, BillEvent[]> {
  const result = new Map<number, BillEvent[]>()
  if (partyIds.length === 0) return result
  const placeholders = partyIds.map(() => '?').join(',')

  const movements = db
    .prepare(
      `SELECT vl.ledger_id AS partyId, v.id AS voucherId, v.date, v.number,
              SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END) AS net
       FROM voucher_lines vl CROSS JOIN vouchers v ON v.id = vl.voucher_id
       WHERE vl.ledger_id IN (${placeholders}) AND v.date <= ? AND ${IN_BOOKS}
       GROUP BY vl.ledger_id, v.id ORDER BY vl.ledger_id, v.date, v.id`
      // CROSS JOIN pins voucher_lines as the outer loop (SQLite never reorders it): drive the
      // party-ledger index, then look each voucher up by id. Left to itself the planner scanned
      // every voucher and probed the line index once per (voucher, party) pair — ~7 s for 1,000
      // parties on 50k vouchers (WP 1.10b dashboard perf fixture); now tens of ms.
    )
    .all(...partyIds, asOn) as { partyId: number; voucherId: number; date: string; number: string; net: number }[]

  const refRows = db
    .prepare(
      `SELECT br.party_ledger_id AS partyId, br.voucher_id AS voucherId, br.kind, br.name, br.amount, br.due_date AS dueDate
       FROM bill_refs br CROSS JOIN vouchers v ON v.id = br.voucher_id
       WHERE br.party_ledger_id IN (${placeholders}) AND v.date <= ? AND ${IN_BOOKS}
       ORDER BY br.id`
    )
    .all(...partyIds, asOn) as {
      partyId: number; voucherId: number; kind: 'new' | 'against'; name: string; amount: number; dueDate: string | null
    }[]
  const refsByVoucher = new Map<string, BillRef[]>()
  for (const r of refRows) {
    const key = `${r.partyId}|${r.voucherId}`
    const list = refsByVoucher.get(key) ?? []
    list.push({ kind: r.kind, name: r.name, amount: r.amount, dueDate: r.dueDate })
    refsByVoucher.set(key, list)
  }

  for (const m of movements) {
    const list = result.get(m.partyId) ?? []
    list.push({
      voucherId: m.voucherId,
      date: m.date,
      number: m.number,
      amount: sign * m.net,
      refs: refsByVoucher.get(`${m.partyId}|${m.voucherId}`) ?? []
    })
    result.set(m.partyId, list)
  }
  return result
}

/** Opening-balance event, normalized to the same sign convention as `partyEvents`. Kept as a
 *  separate first event (never carries refs) — matches the pre-refactor behavior exactly. */
function openingEvent(asOn: string, openingBalance: number, sign: number): BillEvent[] {
  if (openingBalance === 0) return []
  // v0.3 #62: the FY start of asOn — `${asOn.year}-04-01` was wrong for Jan–Mar dates (it
  // produced a date in asOn's FUTURE, zeroing the opening bill's age).
  return [{ voucherId: null, date: fyOf(asOn).from, number: 'Opening', amount: sign * openingBalance, refs: [] }]
}

/**
 * Party-wise outstandings: invoices/bill-refs open bills, receipts/notes/against-refs settle
 * them (named exactly when a ref says so, oldest-first otherwise). `side` picks debtors or
 * creditors. Buckets are keyed on days overdue from the due date (or the bill date, when no due
 * date is known) — see shared/outstanding.ts's `allocateBills`.
 */
export function outstandings(db: DB, side: 'receivable' | 'payable', asOn: string): OutstandingParty[] {
  const groupIds = descendantIdsByName(db, [side === 'receivable' ? 'Sundry Debtors' : 'Sundry Creditors'])
  const parties = (
    db.prepare('SELECT id, name, opening_balance, group_id, credit_days FROM ledgers').all() as {
      id: number; name: string; opening_balance: number; group_id: number; credit_days: number | null
    }[]
  ).filter((l) => groupIds.has(l.group_id))

  const sign = side === 'receivable' ? 1 : -1
  const result: OutstandingParty[] = []

  const eventsByParty = partyEventsBatch(db, parties.map((p) => p.id), asOn, sign)
  for (const party of parties) {
    const events = [...openingEvent(asOn, party.opening_balance, sign), ...(eventsByParty.get(party.id) ?? [])]
    const { bills, warnings } = allocateBills(events, asOn, party.credit_days)
    if (bills.length === 0 && warnings.length === 0) continue

    const buckets: [number, number, number, number] = [0, 0, 0, 0]
    for (const bill of bills) {
      const b = bill.overdueDays <= 30 ? 0 : bill.overdueDays <= 60 ? 1 : bill.overdueDays <= 90 ? 2 : 3
      buckets[b] += bill.pending
    }
    result.push({
      ledgerId: party.id,
      name: party.name,
      pending: bills.reduce((s, b) => s + b.pending, 0),
      buckets,
      bills,
      ...(warnings.length > 0 ? { warnings } : {})
    })
  }
  return result.sort((a, b) => b.pending - a.pending)
}

/** Open bills for a single party as of `asOn` — feeds the receipt/payment "settle against" picker. */
export function openBills(db: DB, partyLedgerId: number, asOn: string): OutstandingBill[] {
  const ledger = db.prepare('SELECT group_id, opening_balance, credit_days FROM ledgers WHERE id = ?').get(partyLedgerId) as
    | { group_id: number; opening_balance: number; credit_days: number | null }
    | undefined
  if (!ledger) return []
  const debtorIds = descendantIdsByName(db, ['Sundry Debtors'])
  const sign = debtorIds.has(ledger.group_id) ? 1 : -1
  const eventsByParty = partyEventsBatch(db, [partyLedgerId], asOn, sign)
  const events = [...openingEvent(asOn, ledger.opening_balance, sign), ...(eventsByParty.get(partyLedgerId) ?? [])]
  return allocateBills(events, asOn, ledger.credit_days).bills
}
