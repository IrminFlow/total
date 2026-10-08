// Small helpers shared by the WP 4.4 services (loans, forex, forecast).
import type { DB } from '../db/connection'
import type { VoucherKind } from '@shared/domain'
import { fyFromStartYear, fyOf } from '@shared/dates'
import { cashBankGroupIds, descendantIdsByName } from './masters'
import { getLockDate, NOT_DELETED } from './vouchers'

/** The system voucher type of a kind (Payment, Receipt, Journal …). */
export function systemVoucherTypeId(db: DB, kind: VoucherKind): number {
  const row = (db.prepare('SELECT id FROM voucher_types WHERE kind = ? AND is_system = 1 ORDER BY id LIMIT 1').get(kind) ??
    db.prepare('SELECT id FROM voucher_types WHERE kind = ? ORDER BY id LIMIT 1').get(kind)) as { id: number } | undefined
  if (!row) throw new Error(`No ${kind} voucher type`)
  return row.id
}

export function fyIsClosed(db: DB, fyStartYear: number): boolean {
  const fy = fyFromStartYear(fyStartYear)
  return !!db
    .prepare(`SELECT 1 FROM vouchers v WHERE ${NOT_DELETED} AND v.is_year_end_close = 1 AND v.date BETWEEN ? AND ? LIMIT 1`)
    .get(fy.from, fy.to)
}

/** Why a posting dated `date` would be refused (lock date / closed year), or null. */
export function postingBlock(db: DB, date: string): string | null {
  const lock = getLockDate(db)
  if (lock && date <= lock) return `Books are locked up to ${lock}`
  const fy = fyOf(date)
  if (fyIsClosed(db, fy.startYear)) return `FY ${fy.label} is closed — bin its closing journal to reopen the year`
  return null
}

export interface LedgerInfo {
  id: number
  name: string
  groupId: number
  nature: 'asset' | 'liability' | 'income' | 'expense'
}

export function ledgerInfo(db: DB, id: number): LedgerInfo | null {
  return (db
    .prepare('SELECT l.id, l.name, l.group_id AS groupId, g.nature FROM ledgers l JOIN groups g ON g.id = l.group_id WHERE l.id = ?')
    .get(id) as LedgerInfo | undefined) ?? null
}

export function isCashOrBankLedger(db: DB, id: number): boolean {
  const l = ledgerInfo(db, id)
  return !!l && cashBankGroupIds(db).has(l.groupId)
}

export function groupIdsByName(db: DB, names: string[]): Set<number> {
  return descendantIdsByName(db, names)
}

export const addDays = (date: string, delta: number): string => {
  const dt = new Date(date + 'T00:00:00Z')
  dt.setUTCDate(dt.getUTCDate() + delta)
  return dt.toISOString().slice(0, 10)
}
