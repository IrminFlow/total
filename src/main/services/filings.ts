import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { filingSchedule } from '@shared/compliance'
import { lateCharge } from '@shared/gst/lateFee'
import { periodBounds, periodKey, type Period } from '@shared/period'
import type { FilingLiability, FilingRecord, FilingRow, FilingUpsert } from '@shared/gst/filings'
import { IN_BOOKS } from './vouchers'
import { cmp08, gstr3b } from './gst'
import { dropGstr1Snapshot, snapshotGstr1, type Gstr1SnapshotResult } from './amendments'
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

/**
 * Which of these periods have any entry at all, in one query rather than one per row.
 *
 * Counts vouchers in books (not the bin) by the period key their date falls in. Quarters and
 * years are answered by summing the months they contain, so one month's activity is enough to
 * make its quarter non-nil -- which is the right reading: a quarterly return covering one busy
 * month is not a nil return.
 */
function periodsWithEntries(db: DB, from: string, to: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT substr(v.date, 1, 7) AS month
       FROM vouchers v
       WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS}`
    )
    .all(from, to) as { month: string }[]

  const out = new Set<string>()
  for (const { month } of rows) {
    const iso = `${month}-01`
    out.add(month)
    out.add(periodKey(iso, 'quarter'))
    out.add(periodKey(iso, 'half'))
    out.add(periodKey(iso, 'year'))
  }
  return out
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
  const active = periodsWithEntries(db, `${fyStartYear}-04-01`, `${fyStartYear + 1}-03-31`)

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

    return { ...d, record, status, charge, projected: !filed, hasEntries: active.has(d.period) }
  })
}

/** What a filing write did, including the GSTR-1 snapshot it took (or deliberately kept). */
export interface FilingSaveResult extends FilingRecord {
  /** Null for every form but GSTR-1, and for a GSTR-1 whose filing was cleared. */
  snapshot: Gstr1SnapshotResult | null
}

/**
 * Record (or clear) a filing.
 *
 * Late fee and interest are recomputed from the dates on every write rather than accepted from
 * the caller: they are a function of (form, due date, filed date, tax), and storing a
 * hand-supplied figure alongside the inputs that contradict it is how a register starts lying.
 *
 * Marking a GSTR-1 filed is also the moment the return's documents are frozen
 * (`snapshotGstr1`), because that is the only moment the books still hold what was filed. From
 * the next correction onwards the original particulars exist nowhere else, and they are the
 * portal's match key for a Table 9A/9C amendment row. Without this call the whole amendment
 * feature is inert — it would diff today's books against nothing.
 *
 * IDEMPOTENT, first-writer-wins: re-marking a period filed (a corrected ARN, a re-entered date)
 * keeps the ORIGINAL snapshot and writes nothing. Overwriting would make every amendment
 * disappear the moment somebody retyped an ARN. Clearing the filing drops the snapshot, because
 * a return that is not filed has nothing to amend against.
 *
 * // VERIFY: only GSTR-1 is snapshotted. IFF (the optional QRMP facility that pushes B2B
 * invoices to buyers in months 1 and 2 of a quarter) also puts documents on the portal, but the
 * quarterly GSTR-1 that follows restates them, and snapshotting both would key two snapshots to
 * the same portal tax period. Amendments to IFF-pushed invoices are handled through the
 * quarter's GSTR-1 snapshot.
 */
export function recordFiling(db: DB, company: CompanyInfo, input: FilingUpsert): FilingSaveResult {
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

  let snapshot: Gstr1SnapshotResult | null = null
  if (input.form === 'GSTR-1') {
    const { from, to } = filingPeriodBounds(input.period)
    snapshot = input.filedAt
      ? snapshotGstr1(db, company, to, from, to, input.filedAt)
      : (dropGstr1Snapshot(db, to), null)
  }

  return { ...after, snapshot }
}

/**
 * What the books say is payable for one filing period.
 *
 * Run on demand for a single row rather than for the whole year: this calls the real return
 * builder, and twelve of those to draw a table would be twelve extractions for a number nobody
 * has looked at yet. The one row a filer opens is the one row worth computing.
 *
 * GSTR-1 and IFF carry no payment, so they answer null rather than zero -- "nothing is payable"
 * and "this form does not take a payment" are different facts, and prefilling zero into a tax
 * field would quietly assert the first.
 */
export function filingLiability(
  db: DB,
  company: CompanyInfo,
  form: string,
  period: string
): FilingLiability {
  const { from, to } = filingPeriodBounds(period)

  if (form === 'CMP-08' || form === 'GSTR-4') {
    // The composition category lives with the filer, not the books; 'trader' is the common case
    // and the register's own field stays editable, so this is a starting figure and not a claim.
    const c = cmp08(db, company, from, to, 'trader')
    return { form, period, taxPayable: c.totalPayable, source: 'CMP-08' }
  }

  if (form === 'GSTR-3B' || form === 'PMT-06') {
    // PMT-06 is the challan for a QRMP month; the liability behind it is the same 3B computation
    // over that month, which is exactly what a filer is trying to work out when they open it.
    const r = gstr3b(db, company, from, to, period.replace('-', ''))
    const net = r.netPayable
    const rcm = r.rcmPayable
    const total =
      net.igst + net.cgst + net.sgst + net.cess + rcm.igst + rcm.cgst + rcm.sgst + rcm.cess
    return { form, period, taxPayable: total, source: 'GSTR-3B' }
  }

  return { form, period, taxPayable: null, source: null }
}
