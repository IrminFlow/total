/**
 * The three things an auditor asks for that the books could not previously answer about
 * themselves: who the related parties are, whether the audit trail is what the rules require,
 * and whether the exporter had a valid undertaking on file.
 *
 * All read-only. Nothing here posts, and nothing here is advice.
 */
import type { DB } from '../db/connection'
import { lutStatus, type Lut, type LutStatus } from '@shared/gst/lut'
import { reportingBacklog, type WindowReport, type WindowRow } from '@shared/gst/eInvoiceWindow'
import type { TurnoverBand } from '@shared/gst/turnover'
import { IN_BOOKS } from './vouchers'
import { writeAudit } from './audit'

// ---------- related-party transactions (roadmap #364) ----------

export interface RelatedPartyTxn {
  voucherId: number
  date: string
  number: string
  kind: string
  /** Signed, dr-positive, from the party's own ledger line. */
  amount: number
}

export interface RelatedPartyRow {
  ledgerId: number
  name: string
  relationship: string | null
  /** Closing balance with the party at the period end, dr-positive. */
  closingBalance: number
  /** Total debited to the party in the period — money out, or sales to them. */
  debits: number
  /** Total credited — money in, or purchases from them. */
  credits: number
  transactions: RelatedPartyTxn[]
}

export interface RelatedPartyReport {
  from: string
  to: string
  rows: RelatedPartyRow[]
  totalDebits: number
  totalCredits: number
  /** Flagged parties with no transactions in the period — a nil disclosure is still a disclosure. */
  dormant: number
}

/**
 * Every transaction with a party somebody has flagged as related.
 *
 * Parties with no movement in the period are counted rather than dropped: the schedule discloses
 * relationships, and "a director's company, nothing transacted this year" is a line an auditor
 * expects to see rather than an absence they have to notice.
 */
export function relatedPartyReport(db: DB, from: string, to: string): RelatedPartyReport {
  const parties = db
    .prepare('SELECT id, name, relationship FROM ledgers WHERE related_party = 1 ORDER BY name')
    .all() as { id: number; name: string; relationship: string | null }[]
  if (parties.length === 0) {
    return { from, to, rows: [], totalDebits: 0, totalCredits: 0, dormant: 0 }
  }

  const ids = parties.map((p) => p.id)
  const placeholders = ids.map(() => '?').join(',')

  const txns = db
    .prepare(
      `SELECT vl.ledger_id AS ledgerId, v.id AS voucherId, v.date, v.number, vt.kind,
              SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END) AS amount
       FROM voucher_lines vl
       JOIN vouchers v ON v.id = vl.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE vl.ledger_id IN (${placeholders}) AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       GROUP BY vl.ledger_id, v.id
       ORDER BY v.date, v.id`
    )
    .all(...ids, from, to) as (RelatedPartyTxn & { ledgerId: number })[]

  const closing = new Map(
    (
      db
        .prepare(
          `SELECT l.id, l.opening_balance + COALESCE((
             SELECT SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END)
             FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
             WHERE vl.ledger_id = l.id AND v.date <= ? AND ${IN_BOOKS}
           ), 0) AS balance
           FROM ledgers l WHERE l.id IN (${placeholders})`
        )
        .all(to, ...ids) as { id: number; balance: number }[]
    ).map((r) => [r.id, r.balance])
  )

  const byParty = new Map<number, RelatedPartyTxn[]>()
  for (const t of txns) {
    byParty.set(t.ledgerId, [...(byParty.get(t.ledgerId) ?? []), t])
  }

  const rows: RelatedPartyRow[] = parties.map((p) => {
    const list = byParty.get(p.id) ?? []
    return {
      ledgerId: p.id,
      name: p.name,
      relationship: p.relationship,
      closingBalance: closing.get(p.id) ?? 0,
      debits: list.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0),
      credits: list.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0),
      transactions: list
    }
  })

  return {
    from,
    to,
    rows,
    totalDebits: rows.reduce((s, r) => s + r.debits, 0),
    totalCredits: rows.reduce((s, r) => s + r.credits, 0),
    dormant: rows.filter((r) => r.transactions.length === 0).length
  }
}

// ---------- the audit trail, about itself (roadmap #365) ----------

export interface AuditTrailStatement {
  from: string
  to: string
  /** Audit rows recorded in the period. */
  entries: number
  /** Earliest and latest entry in the whole log, so coverage is visible rather than claimed. */
  firstEntry: string | null
  lastEntry: string | null
  /** Distinct entity kinds the log covers. */
  entities: { entity: string; entries: number }[]
  /** Distinct users who made changes, so an unattributed change is visible. */
  users: { userName: string; entries: number }[]
  /**
   * Whether anything can switch the log off. Constant `false` by construction: there is no
   * setting, no flag and no code path that skips writeAudit — which is the assertion the rule
   * actually asks for.
   */
  canBeDisabled: boolean
  /**
   * Retention setting, if one is in force. Stated because a log pruned to 90 days does not cover
   * a financial year, and an auditor should see that rather than discover it.
   */
  retentionDays: number | null
  /** True when retention would have removed entries from inside the period being reported. */
  retentionAffectsPeriod: boolean
}

/**
 * What the audit log can say about itself.
 *
 * The log has been recording faithfully all along and could say none of this — an auditor asking
 * "does your software maintain an audit trail that cannot be disabled, and for what period" had
 * to be answered by a person rather than by the software.
 *
 * Everything here is measured from the log, not asserted about it. The one exception is
 * `canBeDisabled`, which is false by construction and says so.
 */
export function auditTrailStatement(db: DB, from: string, to: string, retentionDays: number | null): AuditTrailStatement {
  const period = db
    .prepare('SELECT COUNT(*) AS n FROM audit_log WHERE substr(at, 1, 10) BETWEEN ? AND ?')
    .get(from, to) as { n: number }

  const bounds = db.prepare('SELECT MIN(at) AS first, MAX(at) AS last FROM audit_log').get() as {
    first: string | null
    last: string | null
  }

  const entities = db
    .prepare(
      `SELECT entity, COUNT(*) AS entries FROM audit_log
       WHERE substr(at, 1, 10) BETWEEN ? AND ? GROUP BY entity ORDER BY entries DESC`
    )
    .all(from, to) as { entity: string; entries: number }[]

  const users = db
    .prepare(
      `SELECT COALESCE(user_name, '(not signed in)') AS userName, COUNT(*) AS entries FROM audit_log
       WHERE substr(at, 1, 10) BETWEEN ? AND ? GROUP BY userName ORDER BY entries DESC`
    )
    .all(from, to) as { userName: string; entries: number }[]

  // Retention prunes by age from today, so it bites the period only if the period starts further
  // back than the retention window reaches.
  const retentionAffectsPeriod =
    retentionDays !== null &&
    Date.parse(`${from}T00:00:00Z`) < Date.now() - retentionDays * 86_400_000

  return {
    from,
    to,
    entries: period.n,
    firstEntry: bounds.first,
    lastEntry: bounds.last,
    entities,
    users,
    canBeDisabled: false,
    retentionDays,
    retentionAffectsPeriod
  }
}

// ---------- LUT (roadmap #357) ----------

export function listLuts(db: DB): Lut[] {
  return db
    .prepare('SELECT arn, fy_start_year AS fyStartYear, filed_on AS filedOn FROM luts ORDER BY fy_start_year DESC')
    .all() as Lut[]
}

export function currentLut(db: DB, today: string): LutStatus {
  return lutStatus(listLuts(db), today)
}

export function saveLut(db: DB, input: Lut): Lut[] {
  const before = listLuts(db).find((l) => l.fyStartYear === input.fyStartYear) ?? null
  db.prepare(
    `INSERT INTO luts (arn, fy_start_year, filed_on) VALUES (?, ?, ?)
     ON CONFLICT(fy_start_year) DO UPDATE SET arn = excluded.arn, filed_on = excluded.filed_on`
  ).run(input.arn, input.fyStartYear, input.filedOn)
  writeAudit(db, 'lut', input.fyStartYear, before ? 'update' : 'create', before, input)
  return listLuts(db)
}

export function deleteLut(db: DB, fyStartYear: number): Lut[] {
  const before = listLuts(db).find((l) => l.fyStartYear === fyStartYear) ?? null
  db.prepare('DELETE FROM luts WHERE fy_start_year = ?').run(fyStartYear)
  writeAudit(db, 'lut', fyStartYear, 'delete', before, null)
  return listLuts(db)
}

// ---------- the e-invoice reporting window (roadmap #354) ----------

/**
 * Sales invoices against their 30-day IRP deadline.
 *
 * Only sales-side documents can carry an IRN, so only they are counted. The turnover band drives
 * whether the window applies at all, but the backlog is computed either way — a business about to
 * cross the threshold should be able to see what it is walking into.
 */
export function eInvoiceBacklog(db: DB, from: string, to: string, today: string, band: TurnoverBand | null): WindowReport {
  const rows = db
    .prepare(
      `SELECT v.id AS voucherId, v.number, v.date,
              COALESCE(l.name, '(no party)') AS party,
              COALESCE((SELECT SUM(vl.amount) FROM voucher_lines vl
                        WHERE vl.voucher_id = v.id AND vl.dr_cr = 'dr'), 0) AS value,
              (SELECT e.irn FROM edocs e WHERE e.voucher_id = v.id AND e.irn IS NOT NULL LIMIT 1) AS irn
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers l ON l.id = v.party_ledger_id
       WHERE vt.kind IN ('sales', 'credit_note') AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       ORDER BY v.date`
    )
    .all(from, to) as WindowRow[]
  return reportingBacklog(rows, today, band)
}
