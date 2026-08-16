import type { DB } from '../db/connection'
import type { CostCentre } from '@shared/domain'
import type { CostCentreInput } from '@shared/schemas'
import { writeAudit } from './audit'
// IN_BOOKS, not NOT_DELETED: cost-centre figures must tie to the P&L for the same period, which
// excludes optional (memorandum) and unmatured post-dated vouchers.
import { IN_BOOKS } from './vouchers'

interface CcRow { id: number; name: string; parent_id: number | null; active: number }
const mapCc = (r: CcRow): CostCentre => ({ id: r.id, name: r.name, parentId: r.parent_id, active: !!r.active })

export function listCostCentres(db: DB): CostCentre[] {
  return (db.prepare('SELECT * FROM cost_centres ORDER BY name').all() as CcRow[]).map(mapCc)
}

export function saveCostCentre(db: DB, input: CostCentreInput, id?: number): CostCentre {
  if (id) {
    const existing = db.prepare('SELECT * FROM cost_centres WHERE id = ?').get(id) as CcRow | undefined
    if (!existing) throw new Error('Cost centre not found')
    db.prepare('UPDATE cost_centres SET name = ?, parent_id = ?, active = ? WHERE id = ?')
      .run(input.name, input.parentId, input.active ? 1 : 0, id)
    const updated = mapCc(db.prepare('SELECT * FROM cost_centres WHERE id = ?').get(id) as CcRow)
    writeAudit(db, 'costCentre', id, 'update', mapCc(existing), updated)
    return updated
  }
  const res = db
    .prepare('INSERT INTO cost_centres (name, parent_id, active) VALUES (?, ?, ?)')
    .run(input.name, input.parentId, input.active ? 1 : 0)
  const created = mapCc(db.prepare('SELECT * FROM cost_centres WHERE id = ?').get(res.lastInsertRowid) as CcRow)
  writeAudit(db, 'costCentre', created.id, 'create', null, created)
  return created
}

/** Refuses to delete a cost centre with any posted allocations — deactivate it instead (saveCostCentre with active: false). */
export function deleteCostCentre(db: DB, id: number): void {
  const existing = db.prepare('SELECT * FROM cost_centres WHERE id = ?').get(id) as CcRow | undefined
  if (!existing) throw new Error('Cost centre not found')
  const used = db.prepare('SELECT COUNT(*) AS n FROM voucher_line_cost_allocations WHERE cost_centre_id = ?').get(id) as { n: number }
  if (used.n > 0) throw new Error('Cost centre has posted allocations; deactivate it instead of deleting it')
  db.prepare('DELETE FROM cost_centres WHERE id = ?').run(id)
  writeAudit(db, 'costCentre', id, 'delete', mapCc(existing), null)
}

export interface CcReportRow {
  costCentreId: number
  name: string
  income: number
  expense: number
  net: number
}

/** P&L by cost centre for a period: income = credit lines under income groups, expense = debit lines under expense groups. */
export function ccReport(db: DB, from: string, to: string): CcReportRow[] {
  const rows = db
    .prepare(
      `SELECT cc.id AS costCentreId, cc.name AS name, g.nature AS nature, vl.dr_cr AS drCr, vlca.amount AS amount
       FROM voucher_line_cost_allocations vlca
       JOIN voucher_lines vl ON vl.id = vlca.voucher_line_id
       JOIN vouchers v ON v.id = vl.voucher_id
       JOIN ledgers l ON l.id = vl.ledger_id
       JOIN groups g ON g.id = l.group_id
       JOIN cost_centres cc ON cc.id = vlca.cost_centre_id
       WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS}`
    )
    .all(from, to) as { costCentreId: number; name: string; nature: string; drCr: 'dr' | 'cr'; amount: number }[]

  const map = new Map<number, CcReportRow>()
  for (const r of rows) {
    const row = map.get(r.costCentreId) ?? { costCentreId: r.costCentreId, name: r.name, income: 0, expense: 0, net: 0 }
    // Net rather than drop the reversal direction: a credit note or journal credit against an
    // expense-natured ledger (or a debit against income) reduces that side instead of vanishing.
    if (r.nature === 'expense') row.expense += r.drCr === 'dr' ? r.amount : -r.amount
    if (r.nature === 'income') row.income += r.drCr === 'cr' ? r.amount : -r.amount
    map.set(r.costCentreId, row)
  }
  const result = [...map.values()]
  for (const row of result) row.net = row.income - row.expense
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

export interface CcStatementRow {
  date: string
  voucherId: number
  number: string
  ledgerName: string
  drCr: 'dr' | 'cr'
  amount: number
}

/** Drill-down of every allocation posted to one cost centre in a period. */
export function ccStatement(db: DB, ccId: number, from: string, to: string): CcStatementRow[] {
  return db
    .prepare(
      `SELECT v.date AS date, v.id AS voucherId, v.number AS number, l.name AS ledgerName, vl.dr_cr AS drCr, vlca.amount AS amount
       FROM voucher_line_cost_allocations vlca
       JOIN voucher_lines vl ON vl.id = vlca.voucher_line_id
       JOIN vouchers v ON v.id = vl.voucher_id
       JOIN ledgers l ON l.id = vl.ledger_id
       WHERE vlca.cost_centre_id = ? AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       ORDER BY v.date, v.id`
    )
    .all(ccId, from, to) as CcStatementRow[]
}
