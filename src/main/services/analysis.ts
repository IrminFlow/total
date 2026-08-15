import type { DB } from '../db/connection'
import type { OutstandingBill, OutstandingParty, RegisterMonthRow } from '@shared/reports'
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

/**
 * Party-wise outstandings with FIFO allocation: invoices open the bill,
 * receipts/notes settle the oldest bills first. `side` picks debtors or creditors.
 */
export function outstandings(db: DB, side: 'receivable' | 'payable', asOn: string): OutstandingParty[] {
  const groupIds = descendantIdsByName(db, [side === 'receivable' ? 'Sundry Debtors' : 'Sundry Creditors'])
  const parties = (db.prepare('SELECT id, name, opening_balance FROM ledgers').all() as { id: number; name: string; opening_balance: number }[])
    .filter((l) => {
      const row = db.prepare('SELECT group_id FROM ledgers WHERE id = ?').get(l.id) as { group_id: number }
      return groupIds.has(row.group_id)
    })

  const sign = side === 'receivable' ? 1 : -1
  const result: OutstandingParty[] = []

  const ageOf = (date: string): number =>
    Math.max(0, Math.round((Date.parse(asOn) - Date.parse(date)) / 86_400_000))

  for (const party of parties) {
    const movements = db
      .prepare(
        `SELECT v.id AS voucherId, v.date, v.number,
                SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END) AS net
         FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
         WHERE vl.ledger_id = ? AND v.date <= ? AND ${NOT_DELETED}
         GROUP BY v.id ORDER BY v.date, v.id`
      )
      .all(party.id, asOn) as { voucherId: number; date: string; number: string; net: number }[]

    // FIFO queue of open bills (amounts normalised so positive = outstanding on this side).
    const open: OutstandingBill[] = []
    let credit = 0 // settlements waiting for a bill (advances)
    const settle = (amount: number): void => {
      let remaining = amount
      while (remaining > 0 && open.length) {
        const bill = open[0]!
        const take = Math.min(bill.pending, remaining)
        bill.pending -= take
        remaining -= take
        if (bill.pending === 0) open.shift()
      }
      credit += remaining
    }
    const addBill = (bill: OutstandingBill): void => {
      // Apply any advance sitting on the account first.
      const take = Math.min(credit, bill.amount)
      credit -= take
      bill.pending = bill.amount - take
      if (bill.pending > 0) open.push(bill)
    }

    if (party.opening_balance !== 0) {
      const normalized = sign * party.opening_balance
      if (normalized > 0) addBill({ voucherId: null, number: 'Opening', date: `${asOn.slice(0, 4)}-04-01`, amount: normalized, pending: normalized, ageDays: 0 })
      else settle(-normalized)
    }
    for (const m of movements) {
      const normalized = sign * m.net
      if (normalized > 0) addBill({ voucherId: m.voucherId, number: m.number, date: m.date, amount: normalized, pending: normalized, ageDays: 0 })
      else if (normalized < 0) settle(-normalized)
    }

    if (open.length === 0) continue
    const buckets: [number, number, number, number] = [0, 0, 0, 0]
    for (const bill of open) {
      bill.ageDays = ageOf(bill.date)
      const b = bill.ageDays <= 30 ? 0 : bill.ageDays <= 60 ? 1 : bill.ageDays <= 90 ? 2 : 3
      buckets[b] += bill.pending
    }
    result.push({
      ledgerId: party.id,
      name: party.name,
      pending: open.reduce((s, b) => s + b.pending, 0),
      buckets,
      bills: open
    })
  }
  return result.sort((a, b) => b.pending - a.pending)
}
