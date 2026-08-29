import type { DB } from '../db/connection'
import type { SupplierDueQueue, SupplierDueRow } from '@shared/payables'
import { outstandings } from './analysis'
import { descendantIdsByName } from './masters'
import { IN_BOOKS } from './vouchers'

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

function liquidBalance(db: DB, asOn: string): number {
  const groups = [...descendantIdsByName(db, ['Cash-in-Hand', 'Bank Accounts'])]
  if (!groups.length) return 0
  const placeholders = groups.map(() => '?').join(',')
  const row = db.prepare(
    `SELECT COALESCE(SUM(l.opening_balance), 0) + COALESCE(SUM(m.movement), 0) AS balance
     FROM ledgers l LEFT JOIN (
       SELECT vl.ledger_id, SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END) AS movement
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
       WHERE v.date <= ? AND ${IN_BOOKS} GROUP BY vl.ledger_id
     ) m ON m.ledger_id = l.id WHERE l.group_id IN (${placeholders})`
  ).get(asOn, ...groups) as { balance: number }
  return Math.max(0, row.balance)
}

export function supplierDueQueue(db: DB, asOn: string): SupplierDueQueue {
  const sevenDays = addDays(asOn, 7)
  const availableCash = liquidBalance(db, asOn)
  const raw = outstandings(db, 'payable', asOn).map((party) => {
    const overdue = party.bills.filter((bill) => bill.overdueDays > 0)
    const upcoming = party.bills.filter((bill) => !!bill.dueDate && bill.dueDate >= asOn && bill.dueDate <= sevenDays)
    const overdueAmount = overdue.reduce((sum, bill) => sum + bill.pending, 0)
    const dueNext7 = upcoming.reduce((sum, bill) => sum + bill.pending, 0)
    const oldestOverdueDays = overdue.reduce((max, bill) => Math.max(max, bill.overdueDays), 0)
    const dates = party.bills.flatMap((bill) => bill.dueDate ? [bill.dueDate] : [])
    const nextDueDate = dates.sort()[0] ?? null
    const priority: SupplierDueRow['priority'] = oldestOverdueDays > 30 ? 'critical' : overdueAmount > 0 || dueNext7 > 0 ? 'high' : 'normal'
    const reason = oldestOverdueDays ? `${oldestOverdueDays} days past oldest due date` : dueNext7 ? 'Due within 7 days' : nextDueDate ? `Next due ${nextDueDate}` : 'No due date'
    return { ledgerId: party.ledgerId, name: party.name, pending: party.pending, overdueAmount, dueNext7, oldestOverdueDays, nextDueDate, priority, reason, coveredByCash: false, bills: party.bills, score: overdueAmount + dueNext7 + oldestOverdueDays * 10_000 }
  }).sort((a, b) => b.score - a.score || b.pending - a.pending || a.name.localeCompare(b.name))
  let allocated = 0
  const rows: SupplierDueRow[] = raw.map(({ score: _score, ...row }) => {
    allocated += row.pending
    return { ...row, coveredByCash: allocated <= availableCash }
  })
  return {
    asOn, availableCash, rows,
    totalPending: rows.reduce((sum, row) => sum + row.pending, 0),
    overdueAmount: rows.reduce((sum, row) => sum + row.overdueAmount, 0),
    dueNext7: rows.reduce((sum, row) => sum + row.dueNext7, 0)
  }
}
