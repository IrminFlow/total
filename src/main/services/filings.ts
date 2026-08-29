import type { DB } from '../db/connection'
import { regScope, type GstScope } from './registrations'
import { primaryRegistrationId } from './registrationId'
import { filingSchedule } from '@shared/compliance'
import { lateCharge } from '@shared/gst/lateFee'
import { periodBounds, periodKey, type Period } from '@shared/period'
import type { FilingLiability, FilingRecord, FilingRow, FilingUpsert } from '@shared/gst/filings'
import { IN_BOOKS } from './vouchers'
import { cmp08, gstr3b } from './gst'
import {
  dropOutwardSnapshot,
  snapshotOutwardFiling,
  type Gstr1SnapshotResult
} from './amendments'
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
function periodsWithEntries(db: DB, company: GstScope, from: string, to: string): Set<string> {
  const rows = db
    .prepare(
       `SELECT DISTINCT substr(v.date, 1, 7) AS month
       FROM vouchers v
       WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS}${regScope(company)}`
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

/**
 * The recorded filings for these periods, for ONE registration (roadmap #108).
 *
 * A registration id of null means "the book has no registrations", which only happens before
 * `ensureRegistrations` has run; it reads every row, which is what a single-GSTIN book saw
 * before this column existed. Otherwise the register is per GSTIN, because filing is: two
 * registrations file two GSTR-3Bs for the same month, with two ARNs and two payments.
 */
function readRecords(db: DB, periods: string[], registrationId: number | null): Map<string, FilingRecord> {
  if (periods.length === 0) return new Map()
  const regFilter = registrationId == null ? '' : ' AND (registration_id = ? OR registration_id IS NULL)'
  const rows = db
    .prepare(
      `SELECT form, period, filed_at AS filedAt, arn, tax_paid AS taxPaid,
              late_fee AS lateFee, interest, notes
       FROM gst_filings
       WHERE period IN (${periods.map(() => '?').join(',')})${regFilter}`
    )
    .all(...periods, ...(registrationId == null ? [] : [registrationId])) as FilingRecord[]
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
  company: GstScope,
  fyStartYear: number,
  today: string
): FilingRow[] {
  const schedule = filingSchedule(
    fyStartYear,
    company.gstRegistrationType,
    company.gstFilingFrequency,
    company.stateCode
  )
  const records = readRecords(
    db,
    [...new Set(schedule.map((d) => d.period))],
    company.registrationId ?? primaryRegistrationId(db)
  )
  const active = periodsWithEntries(db, company, `${fyStartYear}-04-01`, `${fyStartYear + 1}-03-31`)

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
  /** Null except for a filed GSTR-1/IFF; clearing either filing drops its snapshot. */
  snapshot: Gstr1SnapshotResult | null
}

/**
 * Record (or clear) a filing.
 *
 * Late fee and interest are recomputed from the dates on every write rather than accepted from
 * the caller: they are a function of (form, due date, filed date, tax), and storing a
 * hand-supplied figure alongside the inputs that contradict it is how a register starts lying.
 *
 * Marking a GSTR-1 or IFF filed is also the moment its documents are frozen, because that is the
 * only moment the books still hold what was filed. From
 * the next correction onwards the original particulars exist nowhere else, and they are the
 * portal's match key for a Table 9A/9C amendment row. Without this call the whole amendment
 * feature is inert — it would diff today's books against nothing.
 *
 * IDEMPOTENT, first-writer-wins: re-marking a period filed (a corrected ARN, a re-entered date)
 * keeps the ORIGINAL snapshot and writes nothing. Overwriting would make every amendment
 * disappear the moment somebody retyped an ARN. Clearing the filing drops the snapshot, because
 * a return that is not filed has nothing to amend against.
 *
 * IFF is frozen separately under its M1/M2 portal period. Its extraction begins at the quarter
 * start so a missed M1 registered invoice can legitimately be furnished in M2; documents already
 * frozen by M1 are excluded. The quarter's GSTR-1 likewise excludes both IFF sets because GSTN's
 * QRMP guidance says filed IFF records need not be furnished again.
 */
export function recordFiling(db: DB, company: GstScope, input: FilingUpsert): FilingSaveResult {
  // Resolve to the primary rather than leaving NULL: `gst_filings` is UNIQUE on
  // (form, period, registration_id) and SQLite treats NULLs as distinct, so a NULL here would
  // make the upsert insert a second row every time a filing was re-recorded.
  const registrationId = company.registrationId ?? primaryRegistrationId(db)
  const readOne = db.prepare(
    `SELECT form, period, filed_at AS filedAt, arn, tax_paid AS taxPaid, late_fee AS lateFee, interest, notes
     FROM gst_filings WHERE form = ? AND period = ? AND registration_id IS ?`
  )
  const before = readOne.get(input.form, input.period, registrationId) as FilingRecord | undefined

  const charge = input.filedAt
    ? lateCharge({
        form: input.form,
        dueDate: input.dueDate,
        filedDate: input.filedAt,
        taxPaise: input.taxPaid
      })
    : { daysLate: 0, lateFeePaise: 0, interestPaise: 0, totalPaise: 0, feeCapped: false }

  db.prepare(
    `INSERT INTO gst_filings (form, period, due_date, filed_at, arn, tax_paid, late_fee, interest, notes, registration_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (form, period, registration_id) DO UPDATE SET
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
    input.notes,
    registrationId
  )

  const after = readOne.get(input.form, input.period, registrationId) as FilingRecord

  writeAudit(db, 'gst_filing', 0, before ? 'update' : 'create', before ?? null, after)

  let snapshot: Gstr1SnapshotResult | null = null
  if (input.form === 'GSTR-1' || input.form === 'IFF') {
    const ownBounds = filingPeriodBounds(input.period)
    const from = input.form === 'IFF'
      ? filingPeriodBounds(periodKey(ownBounds.from, 'quarter')).from
      : ownBounds.from
    const to = ownBounds.to
    snapshot = input.filedAt
      ? snapshotOutwardFiling(
          db,
          company,
          input.form,
          input.period,
          to,
          from,
          to,
          input.filedAt
        )
      : (dropOutwardSnapshot(db, input.form, input.period, to, registrationId), null)
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
  company: GstScope,
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
