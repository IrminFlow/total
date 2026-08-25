/**
 * Input Service Distributor, against the books (roadmap #355).
 *
 * The engine is in `src/shared/gst/isd.ts` and every statutory citation — and every unverified
 * one — lives there. This is the half that has to talk to the database: which registration is the
 * ISD, what it received, what each recipient's turnover was in the relevant period, and what was
 * distributed to whom in which month.
 *
 * NOTHING HERE POSTS. Distribution moves credit between two of one business's own electronic
 * credit ledgers on the portal. It creates no revenue and no expense, the recipient's ITC arrives
 * in its GSTR-3B Table 4(A)(4), and the trial balance does not move. `isd.dbtest.ts` asserts it.
 *
 * The turnover that fixes the ratio is computed from these books, scoped to each recipient
 * registration — and offered as an OVERRIDE, because rule 39 wants turnover in the State, which
 * includes exempt supplies and any part of the relevant period before these books begin. A figure
 * the app computed and a figure the statute wants are not always the same number, and pretending
 * otherwise is how a distribution ends up in the wrong ratio.
 */

import type { DB } from '../db/connection'
import type { ItcPart } from '@shared/gst/returns'
import {
  buildDistribution,
  buildGstr6,
  isdInvoiceNumber,
  gstr6DueDate,
  relevantPeriodFor,
  type CreditHeads,
  type DistributionResult,
  type Gstr6Working,
  type IsdAttribution,
  type IsdCredit,
  type IsdEligibility,
  type IsdInvoice,
  type IsdRecipient,
  type RelevantPeriod
} from '@shared/gst/isd'
import { fyOf, toDisplayDate } from '@shared/dates'
import { ensureRegistrations, type GstScope } from './registrations'
import { descendantIdsByName } from './masters'
import { IN_BOOKS } from './vouchers'
import { writeAudit } from './audit'

const INCOME_GROUPS = ['Sales Accounts', 'Direct Incomes', 'Indirect Incomes']

/** The registration marked as the ISD, if any. Section 24(viii) makes it a separate registration. */
export function isdRegistration(db: DB): { id: number; gstin: string | null; stateCode: string; tradeName: string; address: string | null } | null {
  const row = db
    .prepare(
      `SELECT id, gstin, state_code AS stateCode, trade_name AS tradeName, address
       FROM gst_registrations WHERE is_isd = 1 AND surrendered_on IS NULL ORDER BY id LIMIT 1`
    )
    .get() as { id: number; gstin: string | null; stateCode: string; tradeName: string; address: string | null } | undefined
  return row ?? null
}

/** Mark (or unmark) a registration as the Input Service Distributor. */
export function setIsdRegistration(db: DB, id: number | null): void {
  const before = isdRegistration(db)
  const run = db.transaction(() => {
    // Exactly one ISD. A second one would give a common invoice two homes and the distribution two
    // possible ratios, which is not a state the rules contemplate or the screen could explain.
    db.prepare('UPDATE gst_registrations SET is_isd = 0').run()
    if (id != null) db.prepare('UPDATE gst_registrations SET is_isd = 1 WHERE id = ?').run(id)
  })
  run()
  writeAudit(db, 'isdRegistration', id ?? 0, 'update', { isd: before?.id ?? null }, { isd: id })
}

// ---------- turnover, the ratio's only input ----------

/**
 * Turnover of one registration over a date range, from these books.
 *
 * The same income-group movement `turnover()` in gst.ts computes for the GSTR-1 header, scoped to
 * one registration. That scope is the whole point: rule 39 apportions on the recipient's turnover
 * IN THE STATE, and a company-level figure would give every recipient the same share.
 */
export function registrationTurnover(db: DB, registrationId: number, from: string, to: string): number {
  const incomeIds = [...descendantIdsByName(db, INCOME_GROUPS)]
  if (!incomeIds.length) return 0
  const placeholders = incomeIds.map(() => '?').join(',')
  const regs = ensureRegistrations(db)
  const anchorId = regs.length ? Math.min(...regs.map((r) => r.id)) : registrationId
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE
                WHEN vl.dr_cr = 'cr' THEN vl.amount
                ELSE -vl.amount
              END), 0) AS t
       FROM voucher_lines vl
       JOIN vouchers v ON v.id = vl.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN ledgers l ON l.id = vl.ledger_id
       WHERE l.group_id IN (${placeholders})
         AND vt.kind IN ('sales', 'credit_note', 'debit_note')
         AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
         AND COALESCE(v.gst_registration_id, ${anchorId}) = ?`
    )
    .get(...incomeIds, from, to, registrationId) as { t: number }
  return Math.max(0, row.t)
}

/** Turnover overrides the user typed, keyed by registration id. Stored per distribution month. */
export type TurnoverOverrides = Record<string, number>

/**
 * Every registration the ISD can distribute to, with the turnover that fixes its share.
 *
 * The ISD registration itself is excluded. Section 20 distributes to the recipients of the credit,
 * and an ISD registration makes no outward supplies of its own — it exists to receive invoices and
 * pass credit on. A surrendered registration is excluded too: it files no more returns and has
 * nowhere to put the credit.
 */
export function isdRecipients(
  db: DB,
  opts: { month: string; period: RelevantPeriod; overrides?: TurnoverOverrides }
): (IsdRecipient & { address: string | null })[] {
  const isd = isdRegistration(db)
  const regs = ensureRegistrations(db)
  return regs
    .filter((r) => r.id !== isd?.id && !r.surrenderedOn)
    .map((r) => {
      const override = opts.overrides?.[String(r.id)]
      return {
        registrationId: r.id,
        gstin: r.gstin,
        stateCode: r.stateCode,
        tradeName: r.tradeName,
        address: r.address,
        turnoverPaise: override ?? registrationTurnover(db, r.id, opts.period.from, opts.period.to),
        turnoverDeclared: override !== undefined
      }
    })
}

/**
 * Which period's turnover rule 39 wants for a distribution in `month`.
 *
 * The preceding financial year, unless a recipient had no turnover in it — then the last quarter.
 * The test is run against the books, and it is deliberately "had turnover" rather than "existed":
 * a registration with nil turnover last year is exactly the case the fallback limb is written for.
 */
export function relevantPeriod(db: DB, month: string): RelevantPeriod {
  const isd = isdRegistration(db)
  const regs = ensureRegistrations(db).filter((r) => r.id !== isd?.id && !r.surrenderedOn)
  const candidate = relevantPeriodFor(month, true)
  const everyone = regs.every((r) => registrationTurnover(db, r.id, candidate.from, candidate.to) > 0)
  return relevantPeriodFor(month, regs.length > 0 && everyone)
}

// ---------- credits received centrally ----------

interface CreditRow {
  id: number
  doc_date: string
  supplier_name: string
  supplier_gstin: string | null
  invoice_number: string
  description: string | null
  taxable: number
  igst: number
  cgst: number
  sgst: number
  cess: number
  eligibility: IsdEligibility
  attribution: IsdAttribution
  reverse_charge: number
  distributed_month: string | null
}

function mapCredit(db: DB, r: CreditRow): IsdCredit & { distributedMonth: string | null } {
  const recipients = (
    db
      .prepare('SELECT registration_id AS id FROM isd_credit_recipients WHERE isd_credit_id = ? ORDER BY registration_id')
      .all(r.id) as { id: number }[]
  ).map((x) => x.id)
  return {
    id: r.id,
    date: r.doc_date,
    supplierName: r.supplier_name,
    supplierGstin: r.supplier_gstin,
    invoiceNumber: r.invoice_number,
    description: r.description,
    taxable: r.taxable,
    heads: { igst: r.igst, cgst: r.cgst, sgst: r.sgst, cess: r.cess },
    eligibility: r.eligibility,
    attribution: r.attribution,
    recipientRegistrationIds: recipients,
    reverseCharge: !!r.reverse_charge,
    distributedMonth: r.distributed_month
  }
}

export interface IsdCreditInput {
  id?: number | null
  date: string
  supplierName: string
  supplierGstin: string | null
  invoiceNumber: string
  description: string | null
  taxable: number
  igst: number
  cgst: number
  sgst: number
  cess: number
  eligibility: IsdEligibility
  attribution: IsdAttribution
  recipientRegistrationIds: number[]
  reverseCharge: boolean
}

export function listIsdCredits(db: DB, from: string, to: string): (IsdCredit & { distributedMonth: string | null })[] {
  const isd = isdRegistration(db)
  if (!isd) return []
  return (
    db
      .prepare('SELECT * FROM isd_credits WHERE registration_id = ? AND doc_date BETWEEN ? AND ? ORDER BY doc_date, id')
      .all(isd.id, from, to) as CreditRow[]
  ).map((r) => mapCredit(db, r))
}

/**
 * Record an invoice received centrally.
 *
 * A credit that has already been distributed cannot be edited. The ISD invoices raised off it are
 * out in the world and in a filed GSTR-6; changing the amount underneath them would leave two
 * documents that disagree, and the portal holds the one this app cannot reach. Withdraw the
 * month's distribution first.
 */
export function saveIsdCredit(db: DB, input: IsdCreditInput): IsdCredit & { distributedMonth: string | null } {
  const isd = isdRegistration(db)
  if (!isd) throw new Error('No registration is marked as the Input Service Distributor')
  if (input.attribution !== 'all' && input.recipientRegistrationIds.length === 0) {
    throw new Error('Credit attributable to specific registrations must name at least one')
  }
  if (input.attribution === 'one' && input.recipientRegistrationIds.length !== 1) {
    throw new Error('Credit attributable to one registration must name exactly one')
  }

  const before = input.id
    ? ((db.prepare('SELECT * FROM isd_credits WHERE id = ?').get(input.id) as CreditRow | undefined) ?? null)
    : null
  if (input.id && !before) throw new Error('Credit not found')
  if (before?.distributed_month) {
    throw new Error(
      `This credit was distributed in ${before.distributed_month}. Withdraw that distribution before editing it.`
    )
  }

  const run = db.transaction((): number => {
    let id: number
    if (before) {
      db.prepare(
        `UPDATE isd_credits SET doc_date = ?, supplier_name = ?, supplier_gstin = ?, invoice_number = ?,
           description = ?, taxable = ?, igst = ?, cgst = ?, sgst = ?, cess = ?, eligibility = ?,
           attribution = ?, reverse_charge = ? WHERE id = ?`
      ).run(
        input.date, input.supplierName.trim(), input.supplierGstin?.trim().toUpperCase() || null,
        input.invoiceNumber.trim(), input.description?.trim() || null, input.taxable,
        input.igst, input.cgst, input.sgst, input.cess, input.eligibility, input.attribution,
        input.reverseCharge ? 1 : 0, before.id
      )
      id = before.id
    } else {
      const res = db
        .prepare(
          `INSERT INTO isd_credits
            (registration_id, doc_date, supplier_name, supplier_gstin, invoice_number, description,
             taxable, igst, cgst, sgst, cess, eligibility, attribution, reverse_charge)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          isd.id, input.date, input.supplierName.trim(), input.supplierGstin?.trim().toUpperCase() || null,
          input.invoiceNumber.trim(), input.description?.trim() || null, input.taxable,
          input.igst, input.cgst, input.sgst, input.cess, input.eligibility, input.attribution,
          input.reverseCharge ? 1 : 0
        )
      id = Number(res.lastInsertRowid)
    }
    db.prepare('DELETE FROM isd_credit_recipients WHERE isd_credit_id = ?').run(id)
    const link = db.prepare('INSERT INTO isd_credit_recipients (isd_credit_id, registration_id) VALUES (?, ?)')
    if (input.attribution !== 'all') for (const rid of input.recipientRegistrationIds) link.run(id, rid)
    return id
  })

  const id = run()
  const saved = mapCredit(db, db.prepare('SELECT * FROM isd_credits WHERE id = ?').get(id) as CreditRow)
  writeAudit(db, 'isdCredit', id, before ? 'update' : 'create', before ? mapCredit(db, before) : null, saved)
  return saved
}

export function deleteIsdCredit(db: DB, id: number): void {
  const row = db.prepare('SELECT * FROM isd_credits WHERE id = ?').get(id) as CreditRow | undefined
  if (!row) throw new Error('Credit not found')
  if (row.distributed_month) {
    throw new Error(`This credit was distributed in ${row.distributed_month}. Withdraw that distribution first.`)
  }
  const before = mapCredit(db, row)
  db.prepare('DELETE FROM isd_credits WHERE id = ?').run(id)
  writeAudit(db, 'isdCredit', id, 'delete', before, null)
}

// ---------- the monthly distribution ----------

interface InvoiceRow {
  id: number
  number: string
  doc_date: string
  month: string
  isd_registration_id: number
  recipient_registration_id: number
  eligible_igst: number
  eligible_cgst: number
  eligible_sgst: number
  eligible_cess: number
  ineligible_igst: number
  ineligible_cgst: number
  ineligible_sgst: number
  ineligible_cess: number
  turnover_paise: number
  total_turnover_paise: number
  doc_json: string
  issued_at: string
}

export interface IsdInvoiceRecord {
  id: number
  number: string
  date: string
  month: string
  recipientRegistrationId: number
  recipientGstin: string | null
  recipientStateCode: string
  eligible: CreditHeads
  ineligible: CreditHeads
  total: number
  turnoverPaise: number
  totalTurnoverPaise: number
  issuedAt: string
  warnings: string[]
}

function mapInvoice(r: InvoiceRow): IsdInvoiceRecord {
  let warnings: string[] = []
  let recipientGstin: string | null = null
  let recipientStateCode = ''
  try {
    const doc = JSON.parse(r.doc_json) as IsdInvoice
    warnings = doc.warnings ?? []
    recipientGstin = doc.recipient.gstin
    recipientStateCode = doc.recipient.stateCode
  } catch {
    // Same reasoning as the branch-transfer register: the row is the document's existence, and the
    // JSON is its detail. Losing the detail must not lose the fact that credit was distributed.
  }
  const eligible = { igst: r.eligible_igst, cgst: r.eligible_cgst, sgst: r.eligible_sgst, cess: r.eligible_cess }
  const ineligible = {
    igst: r.ineligible_igst, cgst: r.ineligible_cgst, sgst: r.ineligible_sgst, cess: r.ineligible_cess
  }
  return {
    id: r.id,
    number: r.number,
    date: r.doc_date,
    month: r.month,
    recipientRegistrationId: r.recipient_registration_id,
    recipientGstin,
    recipientStateCode,
    eligible,
    ineligible,
    total:
      eligible.igst + eligible.cgst + eligible.sgst + eligible.cess +
      ineligible.igst + ineligible.cgst + ineligible.sgst + ineligible.cess,
    turnoverPaise: r.turnover_paise,
    totalTurnoverPaise: r.total_turnover_paise,
    issuedAt: r.issued_at,
    warnings
  }
}

/** The last day of a 'YYYY-MM'. The distribution is dated on it, and the credits are read to it. */
function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, '0')}` }
}

export interface IsdDesk {
  month: string
  dueDate: string
  isd: { id: number; gstin: string | null; stateCode: string; tradeName: string } | null
  period: RelevantPeriod
  recipients: IsdRecipient[]
  /** Credits received in the month, distributed or not. */
  credits: (IsdCredit & { distributedMonth: string | null })[]
  /** The proposed distribution, recomputed every time until the month is issued. */
  preview: DistributionResult | null
  /** Documents already issued for the month. */
  issued: IsdInvoiceRecord[]
  /** Set when the mechanism cannot run at all, with the reason. */
  blocked: string | null
  /** False on a single-registration book: nothing to distribute to, and the tab says so. */
  multiRegistration: boolean
}

/**
 * The month's ISD desk: what came in, who it goes to in what ratio, and what has been issued.
 *
 * The preview is recomputed from the credits and the turnovers every time it is asked for, and it
 * stops being the answer the moment the month is issued — from then on the ISSUED documents are
 * the answer, because they are what the recipients hold and what GSTR-6 reported.
 */
export function isdDesk(db: DB, month: string, overrides?: TurnoverOverrides): IsdDesk {
  const regs = ensureRegistrations(db)
  const isd = isdRegistration(db)
  const period = relevantPeriod(db, month)
  const bounds = monthBounds(month)

  if (regs.length <= 1) {
    return {
      month, dueDate: gstr6DueDate(month), isd: null, period,
      recipients: [], credits: [], preview: null, issued: [],
      blocked: 'This company has one GST registration. An ISD distributes credit to other registrations on the same PAN; with one there is nothing to distribute to.',
      multiRegistration: false
    }
  }

  const recipients = isdRecipients(db, { month, period, overrides })
  const credits = isd ? listIsdCredits(db, bounds.from, bounds.to) : []
  const issued = (
    db.prepare('SELECT * FROM isd_invoices WHERE month = ? ORDER BY id').all(month) as InvoiceRow[]
  ).map(mapInvoice)

  const blocked = !isd
    ? 'No registration is marked as the Input Service Distributor. Mark one — section 24(viii) requires an ISD to be registered as one, separately.'
    : recipients.length === 0
      ? 'There are no other live registrations to distribute credit to.'
      : null

  const undistributed = credits.filter((c) => !c.distributedMonth)
  const preview =
    blocked || issued.length > 0 || undistributed.length === 0
      ? null
      : buildDistribution({
          month,
          date: bounds.to,
          fyLabel: fyOf(bounds.to).label,
          isd: { registrationId: isd!.id, gstin: isd!.gstin, stateCode: isd!.stateCode, tradeName: isd!.tradeName, address: isd!.address },
          recipients,
          credits: undistributed,
          period,
          numberFor: (i) => isdInvoiceNumber(fyOf(bounds.to).label, i + 1)
        })

  return {
    month,
    dueDate: gstr6DueDate(month),
    isd: isd ? { id: isd.id, gstin: isd.gstin, stateCode: isd.stateCode, tradeName: isd.tradeName } : null,
    period,
    recipients,
    credits,
    preview,
    issued,
    blocked,
    multiRegistration: true
  }
}

/**
 * The next serial in the ISD invoice series for a financial year.
 *
 * One series for the ISD registration — there is only ever one ISD — read from the highest serial
 * actually issued rather than from a counter, for the same reason as everywhere else: the document
 * is the fact, and a counter is a second fact that can disagree with it.
 */
export function nextIsdInvoiceNumber(db: DB, date: string): string {
  const fy = fyOf(date)
  const prefix = `ISD/${fy.label}/`
  const rows = db.prepare('SELECT number FROM isd_invoices WHERE number LIKE ?').all(`${prefix}%`) as {
    number: string
  }[]
  const highest = rows.reduce((max, r) => {
    const n = Number(r.number.slice(prefix.length))
    return Number.isFinite(n) && n > max ? n : max
  }, 0)
  return isdInvoiceNumber(fy.label, highest + 1)
}

export interface DistributeMonthResult {
  month: string
  invoices: IsdInvoiceRecord[]
  gstr6: Gstr6Working
}

/**
 * Distribute the month.
 *
 * One transaction: the ISD invoices, and the stamp on each credit saying which month consumed it.
 * A half-distributed month — three recipients paid, a serial spent, and the credits still looking
 * undistributed — is not a state anybody can explain to an auditor or unpick by hand.
 *
 * Refuses to run twice for a month. Distribution is monthly and a recipient gets one document for
 * it; a second run would be a second document for credit already passed on.
 */
export function distributeMonth(
  db: DB,
  month: string,
  opts: { overrides?: TurnoverOverrides; by?: string | null } = {}
): DistributeMonthResult {
  const desk = isdDesk(db, month, opts.overrides)
  if (desk.blocked) throw new Error(desk.blocked)
  if (desk.issued.length > 0) {
    throw new Error(`${month} has already been distributed. Withdraw it first if it has to be redone.`)
  }
  const undistributed = desk.credits.filter((c) => !c.distributedMonth)
  if (undistributed.length === 0) throw new Error(`No undistributed credit was received in ${month}.`)

  const bounds = monthBounds(month)
  const isd = desk.isd!
  const start = Number(nextIsdInvoiceNumber(db, bounds.to).split('/').pop())
  const fyLabel = fyOf(bounds.to).label

  const result = buildDistribution({
    month,
    date: bounds.to,
    fyLabel,
    isd: {
      registrationId: isd.id,
      gstin: isd.gstin,
      stateCode: isd.stateCode,
      tradeName: isd.tradeName,
      address: isdRegistration(db)?.address ?? null
    },
    recipients: isdRecipients(db, { month, period: desk.period, overrides: opts.overrides }),
    credits: undistributed,
    period: desk.period,
    // Serials from a running counter for the batch: asking the table once per document would give
    // every document in the batch the same number, because nothing has been written yet.
    numberFor: (i) => isdInvoiceNumber(fyLabel, start + i)
  })

  const run = db.transaction((): IsdInvoiceRecord[] => {
    const out: IsdInvoiceRecord[] = []
    const insert = db.prepare(
      `INSERT INTO isd_invoices
        (number, doc_date, month, isd_registration_id, recipient_registration_id,
         eligible_igst, eligible_cgst, eligible_sgst, eligible_cess,
         ineligible_igst, ineligible_cgst, ineligible_sgst, ineligible_cess,
         turnover_paise, total_turnover_paise, doc_json, issued_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const inv of result.invoices) {
      const res = insert.run(
        inv.number, inv.date, inv.month, isd.id, inv.recipient.registrationId,
        inv.eligible.igst, inv.eligible.cgst, inv.eligible.sgst, inv.eligible.cess,
        inv.ineligible.igst, inv.ineligible.cgst, inv.ineligible.sgst, inv.ineligible.cess,
        inv.ratio.turnoverPaise, inv.ratio.totalTurnoverPaise, JSON.stringify(inv), opts.by ?? null
      )
      const id = Number(res.lastInsertRowid)
      const record = mapInvoice(db.prepare('SELECT * FROM isd_invoices WHERE id = ?').get(id) as InvoiceRow)
      writeAudit(db, 'isdInvoice', id, 'create', null, record)
      out.push(record)
    }
    const stamp = db.prepare('UPDATE isd_credits SET distributed_month = ? WHERE id = ?')
    for (const c of undistributed) stamp.run(month, c.id)
    return out
  })

  const invoices = run()
  return { month, invoices, gstr6: buildGstr6(result, { isdGstin: isd.gstin, credits: undistributed }) }
}

/**
 * Withdraw a month's distribution.
 *
 * Deletes the documents and unstamps the credits, so the month can be run again. Narrow on purpose
 * — a serial that has left the building should not be reused — but the alternative is a user stuck
 * with a distribution computed on a turnover they have since corrected, and no way back.
 */
export function withdrawDistribution(db: DB, month: string): void {
  const rows = db.prepare('SELECT * FROM isd_invoices WHERE month = ?').all(month) as InvoiceRow[]
  if (rows.length === 0) throw new Error(`${month} has not been distributed.`)
  const run = db.transaction(() => {
    for (const r of rows) writeAudit(db, 'isdInvoice', r.id, 'delete', mapInvoice(r), null)
    db.prepare('DELETE FROM isd_invoices WHERE month = ?').run(month)
    db.prepare('UPDATE isd_credits SET distributed_month = NULL WHERE distributed_month = ?').run(month)
  })
  run()
}

/** GSTR-6 for a month that has been distributed. Data, not a portal file — see the engine. */
export function gstr6(db: DB, month: string): Gstr6Working {
  const isd = isdRegistration(db)
  const rows = db.prepare('SELECT * FROM isd_invoices WHERE month = ? ORDER BY id').all(month) as InvoiceRow[]
  const credits = (
    db.prepare('SELECT * FROM isd_credits WHERE distributed_month = ? ORDER BY doc_date, id').all(month) as CreditRow[]
  ).map((r) => mapCredit(db, r))

  const invoices: IsdInvoice[] = []
  for (const r of rows) {
    try {
      invoices.push(JSON.parse(r.doc_json) as IsdInvoice)
    } catch {
      // Skip a document whose JSON is unreadable rather than reporting a return short of a row
      // without saying so — `undistributed` in the working will show the gap.
    }
  }
  const period = relevantPeriod(db, month)
  const result: DistributionResult = {
    month,
    period,
    invoices,
    received: {
      eligible: sumHeads(credits.filter((c) => c.eligibility === 'eligible').map((c) => c.heads)),
      ineligible: sumHeads(credits.filter((c) => c.eligibility === 'ineligible').map((c) => c.heads))
    },
    distributed: {
      eligible: sumHeads(invoices.map((i) => i.eligible)),
      ineligible: sumHeads(invoices.map((i) => i.ineligible))
    },
    warnings: invoices[0]?.warnings ?? []
  }
  return buildGstr6(result, { isdGstin: isd?.gstin ?? null, credits })
}

function sumHeads(parts: CreditHeads[]): CreditHeads {
  return parts.reduce(
    (t, p) => ({ igst: t.igst + p.igst, cgst: t.cgst + p.cgst, sgst: t.sgst + p.sgst, cess: t.cess + p.cess }),
    { igst: 0, cgst: 0, sgst: 0, cess: 0 }
  )
}

// ---------- how a distribution reaches the recipient's return ----------

/**
 * Credit distributed TO a registration in a period — GSTR-3B Table 4(A)(4), "Inward supplies from ISD".
 *
 * The 3B JSON has always carried an `ISD` row and always carried it as zero, because nothing in the
 * books could fill it. This fills it, from the documents actually issued rather than from a
 * recomputation, so the recipient's 4(A)(4) is exactly what the ISD's GSTR-6 distributed to it.
 *
 * Only ELIGIBLE credit. Ineligible credit is distributed and reported by the ISD, but it is not
 * credit the recipient may avail, and putting it in 4(A) would overstate the ITC availed by the
 * amount the rules exist to keep out of it.
 */
export function isdInwardItc(db: DB, scope: GstScope, from: string, to: string): ItcPart {
  const regId = scope.registrationId
  const zero: ItcPart = { igst: 0, cgst: 0, sgst: 0, cess: 0 }
  if (regId == null) return zero
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(eligible_igst), 0) AS igst, COALESCE(SUM(eligible_cgst), 0) AS cgst,
              COALESCE(SUM(eligible_sgst), 0) AS sgst, COALESCE(SUM(eligible_cess), 0) AS cess
       FROM isd_invoices WHERE doc_date BETWEEN ? AND ? AND recipient_registration_id = ?`
    )
    .get(from, to, regId) as ItcPart
  return row ?? zero
}
