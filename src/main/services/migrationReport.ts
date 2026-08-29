import type { DB } from '../db/connection'
import { buildMigrationReport, type MigrationRun } from '@shared/migrationReport'
import { formatPaise } from '@shared/money'
import { IN_BOOKS } from './vouchers'
import { trialBalance } from './reports'

/**
 * The facts behind the migration report (roadmap O #298).
 *
 * Every number here is read back out of the database — the import runs out of the audit trail,
 * the totals out of the vouchers. Nothing is passed in from the screen that ran the import, on
 * purpose: a report whose figures the caller can dictate proves nothing to the person signing it.
 */
export function migrationReportData(db: DB, asOn: string): {
  runs: MigrationRun[]
  totalDebit: number
  totalCredit: number
  vouchersInBooks: number
  ledgerCount: number
  asOn: string
} {
  const rows = db
    .prepare(
      `SELECT at, user_name AS userName, app_version AS appVersion, after_json AS afterJson
       FROM audit_log WHERE entity = 'tally_import' AND action = 'import' ORDER BY id`
    )
    .all() as { at: string; userName: string | null; appVersion: string | null; afterJson: string | null }[]

  const runs: MigrationRun[] = rows.map((row) => {
    const counts = safeCounts(row.afterJson)
    return {
      at: row.at,
      userName: row.userName,
      appVersion: row.appVersion,
      groups: counts.groups,
      ledgers: counts.ledgers,
      units: counts.units,
      items: counts.items,
      vouchers: counts.vouchers,
      skipped: counts.skipped,
      // Older audit rows (written before re-import safety existed) have no duplicates field.
      // Zero is the honest reading: nothing was recognised as a duplicate, because nothing could be.
      duplicates: counts.duplicates,
      warnings: counts.warnings
    }
  })

  const tb = trialBalance(db, asOn)
  const vouchers = db
    .prepare(`SELECT COUNT(*) AS n FROM vouchers v WHERE ${IN_BOOKS} AND v.date <= ?`)
    .get(asOn) as { n: number }
  const ledgers = db.prepare('SELECT COUNT(*) AS n FROM ledgers').get() as { n: number }

  return {
    runs,
    totalDebit: tb.totalDebit,
    totalCredit: tb.totalCredit,
    vouchersInBooks: vouchers.n,
    ledgerCount: ledgers.n,
    asOn
  }
}

function safeCounts(json: string | null): Record<'groups' | 'ledgers' | 'units' | 'items' | 'vouchers' | 'skipped' | 'duplicates' | 'warnings', number> {
  const empty = { groups: 0, ledgers: 0, units: 0, items: 0, vouchers: 0, skipped: 0, duplicates: 0, warnings: 0 }
  if (!json) return empty
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>
    const num = (key: keyof typeof empty): number => (typeof parsed[key] === 'number' ? (parsed[key] as number) : 0)
    return {
      groups: num('groups'), ledgers: num('ledgers'), units: num('units'), items: num('items'),
      vouchers: num('vouchers'), skipped: num('skipped'), duplicates: num('duplicates'), warnings: num('warnings')
    }
  } catch {
    return empty
  }
}

/** Rows + footnote for the PDF, shaped by the pure builder. */
export function migrationReportBody(db: DB, asOn: string): ReturnType<typeof buildMigrationReport> {
  return buildMigrationReport(migrationReportData(db, asOn), formatPaise)
}
