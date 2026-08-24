import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { MonthCloseGate, MonthCloseStatus } from '@shared/monthClose'
import { bankLedgers, bankRecon } from './banking'
import { gstValidate } from './gst'
import { exceptions } from './reports'
import { descendantIdsByName } from './masters'
import { getLockDate, IN_BOOKS } from './vouchers'

export interface MonthCloseBackupEvidence {
  file: string
  mtime: number
  tag: string
  valid: boolean
}

function suspenseBalance(db: DB, to: string): number {
  const groupIds = [...descendantIdsByName(db, ['Suspense A/c'])]
  if (groupIds.length === 0) return 0
  const placeholders = groupIds.map(() => '?').join(',')
  const row = db.prepare(
    `SELECT COALESCE(SUM(l.opening_balance), 0) + COALESCE(SUM(m.movement), 0) AS balance
     FROM ledgers l
     LEFT JOIN (
       SELECT vl.ledger_id, SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END) AS movement
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
       WHERE v.date <= ? AND ${IN_BOOKS}
       GROUP BY vl.ledger_id
     ) m ON m.ledger_id = l.id
     WHERE l.group_id IN (${placeholders})`
  ).get(to, ...groupIds) as { balance: number }
  return row.balance
}

export function monthCloseStatus(
  db: DB,
  company: CompanyInfo,
  from: string,
  to: string,
  backup: MonthCloseBackupEvidence | null
): MonthCloseStatus {
  const unreconciledBankLines = bankLedgers(db).reduce((total, ledger) => {
    const recon = bankRecon(db, ledger.id, from, to)
    return total + recon.rows.filter((row) => !row.bankDate || row.bankDate > to).length
  }, 0)
  const gstIssues = gstValidate(db, company, from, to)
  const gstBlocking = gstIssues.filter((issue) => issue.severity === 'blocking').length
  const gstWarnings = gstIssues.length - gstBlocking
  const report = exceptions(db, from, to)
  // "Outside working period" is useful on the general exceptions screen, but every entry in
  // every other month would make a month-close permanently red. Close checks only count issues
  // intrinsic to this period (plus global structural defects such as unbalanced vouchers).
  const bookExceptions = report.sections
    .filter((section) => section.key !== 'outsidePeriod')
    .reduce((total, section) => total + section.count, 0)
  const suspense = suspenseBalance(db, to)
  const lockedThrough = getLockDate(db)
  const locked = !!lockedThrough && lockedThrough >= to

  const gates: MonthCloseGate[] = [
    {
      id: 'bank', status: unreconciledBankLines === 0 ? 'ready' : 'attention', title: 'Bank reconciliation',
      detail: unreconciledBankLines === 0 ? 'All bank entries are reconciled through period end' : `${unreconciledBankLines} bank line${unreconciledBankLines === 1 ? '' : 's'} still need a bank date`,
      count: unreconciledBankLines
    },
    {
      id: 'gst', status: gstBlocking === 0 ? 'ready' : 'attention', title: 'GST readiness',
      detail: gstBlocking === 0 ? (gstWarnings ? `${gstWarnings} advisory warning${gstWarnings === 1 ? '' : 's'}; exports are not blocked` : 'No GST validation issues block export') : `${gstBlocking} blocking issue${gstBlocking === 1 ? '' : 's'} must be fixed`,
      count: gstBlocking
    },
    {
      id: 'books', status: bookExceptions === 0 && suspense === 0 ? 'ready' : 'attention', title: 'Book health',
      detail: bookExceptions === 0 && suspense === 0 ? 'Exception checks are clean and suspense is nil' : `${bookExceptions} exception${bookExceptions === 1 ? '' : 's'}; suspense balance ${Math.abs(suspense)} paise`,
      count: bookExceptions + (suspense === 0 ? 0 : 1)
    },
    {
      id: 'backup', status: backup?.valid ? 'ready' : 'attention', title: 'Verified backup',
      detail: backup?.valid ? `Latest ${backup.tag} backup passed integrity checks` : 'Create a verified backup before locking this month',
      count: backup?.valid ? 0 : 1
    },
    {
      id: 'lock', status: locked ? 'complete' : 'attention', title: 'Period lock',
      detail: locked ? `Books are locked through ${to}` : 'Lock the period after the four preparation gates are clear',
      count: locked ? 0 : 1
    }
  ]
  const prepReady = gates.slice(0, 4).every((gate) => gate.status === 'ready')
  const readyCount = gates.filter((gate) => gate.status !== 'attention').length
  return {
    from, to, readyCount, totalGates: gates.length, canLock: prepReady && !locked, gates,
    metrics: { unreconciledBankLines, gstBlocking, gstWarnings, bookExceptions, suspenseBalance: suspense },
    latestBackup: backup ? { file: backup.file, mtime: backup.mtime, tag: backup.tag } : null,
    lockedThrough
  }
}
