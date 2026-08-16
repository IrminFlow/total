import type { DB } from '../db/connection'
import type { OutstandingBill, OutstandingParty, RegisterMonthRow } from '@shared/reports'
import { allocateBills, type BillEvent, type BillRef } from '@shared/outstanding'
import { descendantIdsByName } from './masters'
import { NOT_DELETED } from './vouchers'

/** Monthly sales/purchase register: voucher count, taxable, tax and invoice totals per month. */
export function registerByMonth(db: DB, kind: 'sales' | 'purchase', from: string, to: string): RegisterMonthRow[] {
  const accountRoot = kind === 'sales' ? ['Sales Accounts', 'Direct Incomes', 'Indirect Incomes'] : ['Purchase Accounts', 'Direct Expenses', 'Indirect Expenses']
  const accountIds = descendantIdsByName(db, accountRoot)
  const side = kind === 'sales' ? 'cr' : 'dr'

  const rows = db
    .prepare(
      `SELECT substr(v.date, 1, 7) AS month, v.id AS voucherId, vl.amount, l.group_id AS groupId, l.tax_type AS taxType, vl.dr_cr AS drCr
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN voucher_lines vl ON vl.voucher_id = v.id
       JOIN ledgers l ON l.id = vl.ledger_id
       WHERE vt.kind = ? AND v.date BETWEEN ? AND ? AND ${NOT_DELETED}`
    )
    .all(kind, from, to) as { month: string; voucherId: number; amount: number; groupId: number; taxType: string | null; drCr: string }[]

  const months = new Map<string, RegisterMonthRow & { seen: Set<number> }>()
  for (const r of rows) {
    const m = months.get(r.month) ?? { month: r.month, vouchers: 0, taxable: 0, tax: 0, total: 0, seen: new Set<number>() }
    if (!m.seen.has(r.voucherId)) {
      m.seen.add(r.voucherId)
      m.vouchers++
    }
    if (r.drCr === side && accountIds.has(r.groupId)) m.taxable += r.amount
    if (r.drCr === side && r.taxType) m.tax += r.amount
    if (r.drCr === 'dr') m.total += r.amount
    months.set(r.month, m)
  }
  return [...months.values()]
    .map(({ seen: _seen, ...rest }) => rest)
    .sort((a, b) => a.month.localeCompare(b.month))
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
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
       WHERE vl.ledger_id IN (${placeholders}) AND v.date <= ? AND ${NOT_DELETED}
       GROUP BY vl.ledger_id, v.id ORDER BY vl.ledger_id, v.date, v.id`
    )
    .all(...partyIds, asOn) as { partyId: number; voucherId: number; date: string; number: string; net: number }[]

  const refRows = db
    .prepare(
      `SELECT br.party_ledger_id AS partyId, br.voucher_id AS voucherId, br.kind, br.name, br.amount, br.due_date AS dueDate
       FROM bill_refs br JOIN vouchers v ON v.id = br.voucher_id
       WHERE br.party_ledger_id IN (${placeholders}) AND v.date <= ? AND ${NOT_DELETED}
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
  return [{ voucherId: null, date: `${asOn.slice(0, 4)}-04-01`, number: 'Opening', amount: sign * openingBalance, refs: [] }]
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
    const { bills } = allocateBills(events, asOn, party.credit_days)
    if (bills.length === 0) continue

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
      bills
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
