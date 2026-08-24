import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { filingSchedule } from '@shared/compliance'
import { lateCharge } from '@shared/gst/lateFee'
import { periodBounds, type Period } from '@shared/period'
import type { FilingRecord, FilingRow, FilingUpsert } from '@shared/gst/filings'
import { writeAudit } from './audit'

/**
 * The filing register: what a year owes, and what was actually filed.
 *
 * The schedule half is computed (`filingSchedule`) so it can never disagree with the compliance
 * calendar. The record half is stored, because filing is an act performed on the portal and the
 * books cannot infer it. Joining them is what turns a list of due dates into "August GSTR-3B is
 * eleven days overdue".
 */

/** The period granularity a period key implies, for turning it back into dates. */
function periodKindOf(key: string): Period {
  const marker = key.slice(5)
  if (marker === 'FY') return 'year'
  if (marker.startsWith('Q')) return 'quarter'
  if (marker.startsWith('H')) return 'half'
  return 'month'
}

/** ISO date bounds of a filing's period, so the UI can drill into the books behind it. */
export function filingPeriodBounds(period: string): { from: string; to: string } {
  return periodBounds(period, periodKindOf(period))
}

function readRecords(db: DB, periods: string[]): Map<string, FilingRecord> {
  if (periods.length === 0) return new Map()
  const rows = db
    .prepare(
      `SELECT form, period, filed_at AS filedAt, arn, tax_paid AS taxPaid,
              late_fee AS lateFee, interest, notes
       FROM gst_filings
       WHERE period IN (${periods.map(() => '?').join(',')})`
    )
    .all(...periods) as FilingRecord[]
  return new Map(rows.map((r) => [`${r.form}/${r.period}`, r]))
}

/**
 * Every GST obligation for a financial year, joined to whatever has been recorded against it.
 *
 * An obligation whose period has not ended yet is 'upcoming' even once its (notional) due date
 * passes -- there is nothing to file for a month still running, and calling it overdue would be
 * a false alarm every single month.
 */
export function filingRegister(
  db: DB,
  company: CompanyInfo,
  fyStartYear: number,
  today: string
): FilingRow[] {
  const schedule = filingSchedule(
    fyStartYear,
    company.gstRegistrationType,
    company.gstFilingFrequency,
    company.stateCode
  )
  const records = readRecords(db, [...new Set(schedule.map((d) => d.period))])

  return schedule.map((d) => {
    const record = records.get(`${d.form}/${d.period}`) ?? null
    const periodEnd = filingPeriodBounds(d.period).to
    const filed = !!record?.filedAt

    const status: FilingRow['status'] = filed
      ? 'filed'
      : today <= periodEnd
        ? 'upcoming'
        : today <= d.date
          ? 'due'
          : 'overdue'

    // Filed: what it actually cost. Unfiled: what it costs if filed today -- which is the number
    // that makes a deadline concrete. Nothing accrues before the due date either way.
    const charge = lateCharge({
      form: d.form,
      dueDate: d.date,
      filedDate: record?.filedAt ?? today,
      taxPaise: record?.taxPaid ?? 0
    })

    return { ...d, record, status, charge, projected: !filed }
  })
}

/**
 * Record (or clear) a filing.
 *
 * Late fee and interest are recomputed from the dates on every write rather than accepted from
 * the caller: they are a function of (form, due date, filed date, tax), and storing a
 * hand-supplied figure alongside the inputs that contradict it is how a register starts lying.
 */
export function recordFiling(db: DB, input: FilingUpsert): FilingRecord {
  const before = db
    .prepare('SELECT form, period, filed_at AS filedAt, arn, tax_paid AS taxPaid, late_fee AS lateFee, interest, notes FROM gst_filings WHERE form = ? AND period = ?')
    .get(input.form, input.period) as FilingRecord | undefined

  const charge = input.filedAt
    ? lateCharge({
        form: input.form,
        dueDate: input.dueDate,
        filedDate: input.filedAt,
        taxPaise: input.taxPaid
      })
    : { daysLate: 0, lateFeePaise: 0, interestPaise: 0, totalPaise: 0, feeCapped: false }

  db.prepare(
    `INSERT INTO gst_filings (form, period, due_date, filed_at, arn, tax_paid, late_fee, interest, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (form, period) DO UPDATE SET
       due_date = excluded.due_date,
       filed_at = excluded.filed_at,
       arn = excluded.arn,
       tax_paid = excluded.tax_paid,
       late_fee = excluded.late_fee,
       interest = excluded.interest,
       notes = excluded.notes`
  ).run(
    input.form,
    input.period,
    input.dueDate,
    input.filedAt,
    input.arn,
    input.taxPaid,
    charge.lateFeePaise,
    charge.interestPaise,
    input.notes
  )

  const after = db
    .prepare('SELECT form, period, filed_at AS filedAt, arn, tax_paid AS taxPaid, late_fee AS lateFee, interest, notes FROM gst_filings WHERE form = ? AND period = ?')
    .get(input.form, input.period) as FilingRecord

  writeAudit(db, 'gst_filing', 0, before ? 'update' : 'create', before ?? null, after)
  return after
}
