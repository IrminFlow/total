/**
 * WP 4.2 — receivables: statements of account, reminder letters, interest on overdue bills,
 * credit control (holds, exposure), follow-ups / promised dates, collection reports.
 *
 * Nothing here stores a balance. Statements are the ledger statement (reports.ledgerStatement)
 * plus the Outstandings allocation (analysis.partyAllocation); reminders, interest, credit control
 * and the collection reports all read analysis.outstandings at query time. The only rows this
 * module owns are facts that are not derivable: reminder_log (what was sent), interest_charges
 * (which bill-period a debit note charged — so a period is never charged twice), bill_followups
 * (notes and promises) and the credit hold on the ledger (migration 032).
 *
 * Tax rules (GST on interest) — src/shared/receivables/sources.ts.
 */
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { OutstandingBill, OutstandingParty } from '@shared/reports'
import { formatPaise } from '@shared/money'
import { todayISO, toDisplayDate } from '@shared/dates'
import type { SupplyType } from '@shared/gst/calc'
import { pdfOptionsFor } from '@shared/printTemplates'
import { renderDocument, type ReminderDocument, type StatementDocument } from '@shared/print/render'
import {
  parseReceivablesConfig, receivablesConfigSchema, RECEIVABLES_META_KEY, REMINDER_BUCKET_LABELS,
  type ReceivablesConfig, type ReminderBucket, type ReminderChannel
} from '@shared/receivables/config'
import { ageingBuckets, mailtoLink, mergeTemplate, reminderBucketFor, reminderCadence, reminderFields } from '@shared/receivables/reminders'
import { addDaysIso, billInterest, gstOfLines, splitInterestGst, type RateShare } from '@shared/receivables/interest'
import { collectionMonth, monthEndIso, monthsBetween, monthStartIso, partyDso } from '@shared/receivables/collections'
import {
  billKeyOf, stableBillKey, type CollectionReport, type CreditControlRow, type FollowupRow, type InterestChargeRow, type InterestPostResult,
  type InterestRow, type PromisedSummary, type ReminderBulkResult, type ReminderCandidate, type ReminderLogRow, type ReminderResult,
  type StatementData, type StatementPdfResult, type StatementRow, type StatementsBulkResult, type TopOverdueRow
} from '@shared/receivables/types'
import type { FollowupInput } from '@shared/receivables/schemas'
import { followupInputSchema } from '@shared/receivables/schemas'
import { ledgerStatement } from './reports'
import { outstandings, partyAllocation, registerVoucherRows } from './analysis'
import { createLedger, descendantIdsByName, getLedger } from './masters'
import { outwardSupplyClass } from './gst'
import { extractEdocInvoices } from './edocs'
import { resolveTemplate } from './printTemplates'
import { plexFontFaceCss } from './printFonts'
import { htmlToPdf } from './pdf'
import { openSalesOrderValue } from './tradeDocs'
import { IN_BOOKS, NOT_DELETED, saveVoucher } from './vouchers'
import { currentAuditUserName, writeAudit } from './audit'
import { companyExportsDir } from '../paths'

const RENDER_OPTS = { fontFaceCss: plexFontFaceCss }
const rupees = (p: number): string => formatPaise(p, { symbol: true })

// ---------------------------------------------------------------- config

export function getReceivablesConfig(db: DB): ReceivablesConfig {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(RECEIVABLES_META_KEY) as { value: string } | undefined
  let raw: unknown = {}
  try {
    raw = row ? JSON.parse(row.value) : {}
  } catch {
    raw = {}
  }
  return parseReceivablesConfig(raw)
}

export function setReceivablesConfig(db: DB, input: unknown): ReceivablesConfig {
  const before = getReceivablesConfig(db)
  const parsed = receivablesConfigSchema.parse(input)
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(RECEIVABLES_META_KEY, JSON.stringify(parsed))
  writeAudit(db, 'company', 0, 'update', { receivables: before }, { receivables: parsed })
  return parsed
}

// ---------------------------------------------------------------- parties

interface PartyRow {
  id: number; name: string; address: string | null; gstin: string | null; email: string | null; stateCode: string | null
  groupId: number; openingBalance: number; creditLimit: number | null; rateBp: number | null; graceDays: number
  creditDays: number | null; exportType: 'sez_wp' | 'sez_wop' | 'exp_wp' | 'exp_wop' | null
  hold: number; holdReason: string | null; holdAt: string | null
}

const PARTY_SQL = `SELECT id, name, address, gstin, email, state_code AS stateCode, group_id AS groupId, opening_balance AS openingBalance, credit_limit AS creditLimit,
  interest_rate_bp AS rateBp, interest_grace_days AS graceDays, credit_hold AS hold, credit_hold_reason AS holdReason,
  credit_hold_at AS holdAt, credit_days AS creditDays, export_type AS exportType FROM ledgers`

function partyRow(db: DB, id: number): PartyRow {
  const p = db.prepare(`${PARTY_SQL} WHERE id = ?`).get(id) as PartyRow | undefined
  if (!p) throw new Error('Party ledger not found')
  return p
}

function debtorRows(db: DB): PartyRow[] {
  const ids = descendantIdsByName(db, ['Sundry Debtors'])
  return (db.prepare(`${PARTY_SQL} ORDER BY name`).all() as PartyRow[]).filter((p) => ids.has(p.groupId))
}

const safeName = (s: string): string => s.replace(/[^a-zA-Z0-9-_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'party'

// ---------------------------------------------------------------- statements

/** Bill-wise allocation text per voucher from bill_refs ("New ref INV-7 · Agst ref INV-3 ₹500"). */
function allocationText(db: DB, partyId: number, voucherIds: number[]): Map<number, string> {
  const out = new Map<number, string>()
  if (!voucherIds.length) return out
  const rows = db
    .prepare(
      `SELECT voucher_id AS voucherId, kind, name, amount FROM bill_refs WHERE party_ledger_id = ? AND voucher_id IN (${voucherIds.map(() => '?').join(',')}) ORDER BY id`
    )
    .all(partyId, ...voucherIds) as { voucherId: number; kind: 'new' | 'against'; name: string; amount: number }[]
  const by = new Map<number, string[]>()
  for (const r of rows) {
    const list = by.get(r.voucherId) ?? []
    list.push(`${r.kind === 'new' ? 'New ref' : 'Agst ref'} ${r.name} ${rupees(r.amount)}`)
    by.set(r.voucherId, list)
  }
  for (const [id, list] of by) out.set(id, list.join(' · '))
  return out
}

/** The statement of account: the ledger statement for the period (opening, every voucher, closing
 *  — identical figures), each voucher's bill-wise allocation, the open bills and their ageing as on
 *  `to`, the payment request and the bank details of the statement template. */
export function statementData(db: DB, company: CompanyInfo, ledgerId: number, from: string, to: string): StatementData {
  const p = partyRow(db, ledgerId)
  const ls = ledgerStatement(db, ledgerId, from, to)
  const alloc = allocationText(db, ledgerId, [...new Set(ls.rows.map((r) => r.voucherId))])
  const rows: StatementRow[] = ls.rows.map((r) => ({
    voucherId: r.voucherId, date: r.date, voucherType: r.voucherType, number: r.number, particulars: r.particulars,
    narration: r.narration, debit: r.debit, credit: r.credit, running: r.running,
    allocation: alloc.get(r.voucherId) ?? (r.credit > 0 ? 'Against the oldest open bills' : '')
  }))
  const allocation = partyAllocation(db, ledgerId, to)
  const cfg = getReceivablesConfig(db)
  const template = resolveTemplate(db, 'statement')
  const fields = {
    party: p.name, company: company.name, from: toDisplayDate(from), to: toDisplayDate(to),
    closing: `${rupees(Math.abs(ls.closing))}${ls.closing === 0 ? '' : ls.closing > 0 ? ' Dr' : ' Cr'}`
  }
  const subject = mergeTemplate(cfg.statementEmail.subject, fields)
  const body = mergeTemplate(cfg.statementEmail.body, fields)
  return {
    party: { id: p.id, name: p.name, address: p.address, gstin: p.gstin, email: p.email },
    from, to,
    opening: ls.opening, closing: ls.closing, totalDebit: ls.totalDebit, totalCredit: ls.totalCredit,
    rows,
    openBills: allocation.bills,
    buckets: ageingBuckets(allocation.bills),
    unapplied: allocation.unappliedCredit,
    paymentRequest: cfg.paymentRequest,
    bank: template.footer.bankDetails,
    email: { subject, body, mailto: mailtoLink(p.email, subject, body) }
  }
}

export function statementHtml(db: DB, company: CompanyInfo, ledgerId: number, from: string, to: string): { html: string; data: StatementData } {
  const data = statementData(db, company, ledgerId, from, to)
  const doc: StatementDocument = { shape: 'statement', kind: 'statement', company, statement: data }
  return { html: renderDocument(resolveTemplate(db, 'statement'), doc, RENDER_OPTS), data }
}

async function writePdf(dir: string, file: string, html: string, db: DB, kind: 'statement' | 'reminder'): Promise<string> {
  mkdirSync(dir, { recursive: true })
  const pdf = await htmlToPdf(html, pdfOptionsFor(resolveTemplate(db, kind)))
  const path = join(dir, file)
  writeFileSync(path, pdf)
  return path
}

export async function statementPdf(db: DB, company: CompanyInfo, slug: string, ledgerId: number, from: string, to: string, dir?: string): Promise<StatementPdfResult> {
  const { html, data } = statementHtml(db, company, ledgerId, from, to)
  const path = await writePdf(dir ?? join(companyExportsDir(slug), 'statements'), `statement-${safeName(data.party.name)}-${to}.pdf`, html, db, 'statement')
  writeAudit(db, 'export', 0, 'export', null, { kind: 'statement', ledgerId, from, to, path })
  return { path, mailto: data.email.mailto, subject: data.email.subject, body: data.email.body }
}

/** Every debtor with a balance as on `to` (or the given parties) → one PDF each in `dir`
 *  (default exports/statements-<to>/). */
export async function statementsBulk(db: DB, company: CompanyInfo, slug: string, from: string, to: string, opts: { dir?: string; ledgerIds?: number[] } = {}): Promise<StatementsBulkResult> {
  const folder = opts.dir ?? join(companyExportsDir(slug), `statements-${to}`)
  const wanted = opts.ledgerIds ? new Set(opts.ledgerIds) : null
  const files: StatementsBulkResult['files'] = []
  for (const p of debtorRows(db)) {
    if (wanted && !wanted.has(p.id)) continue
    const { html, data } = statementHtml(db, company, p.id, from, to)
    if (!wanted && data.closing === 0) continue
    const path = await writePdf(folder, `statement-${safeName(p.name)}-${to}.pdf`, html, db, 'statement')
    files.push({ ledgerId: p.id, name: p.name, path, closing: data.closing })
  }
  writeAudit(db, 'export', 0, 'export', null, { kind: 'statements', from, to, folder, count: files.length })
  return { folder, files }
}

// ---------------------------------------------------------------- reminders

const overdueOf = (p: OutstandingParty): OutstandingBill[] => p.bills.filter((b) => b.overdueDays > 0 && b.pending > 0)

function lastReminders(db: DB): Map<number, { date: string; bucket: ReminderBucket }> {
  const rows = db
    .prepare(
      `SELECT r.party_ledger_id AS id, r.date, r.bucket FROM reminder_log r
       WHERE r.id = (SELECT r2.id FROM reminder_log r2 WHERE r2.party_ledger_id = r.party_ledger_id ORDER BY r2.date DESC, r2.id DESC LIMIT 1)`
    )
    .all() as { id: number; date: string; bucket: ReminderBucket }[]
  return new Map(rows.map((r) => [r.id, { date: r.date, bucket: r.bucket }]))
}

function candidateOf(p: OutstandingParty, party: PartyRow, cfg: ReceivablesConfig, last: { date: string; bucket: ReminderBucket } | undefined, asOn: string): ReminderCandidate | null {
  const overdue = overdueOf(p)
  if (!overdue.length) return null
  const oldest = [...overdue].sort((a, b) => b.overdueDays - a.overdueDays)[0]!
  const bucket = reminderBucketFor(oldest.overdueDays, cfg)!
  const cadence = reminderCadence(last?.date ?? null, asOn, cfg.minDaysBetweenReminders)
  return {
    ledgerId: p.ledgerId, name: p.name, email: party.email, bucket,
    overdue: overdue.reduce((s, b) => s + b.pending, 0), total: p.pending, billCount: overdue.length,
    oldestBill: oldest.number, oldestBillDate: oldest.date, maxOverdueDays: oldest.overdueDays,
    lastSent: last?.date ?? null, lastBucket: last?.bucket ?? null, allowed: cadence.allowed, nextAllowed: cadence.nextAllowed
  }
}

/** Debtors with overdue bills as on `asOn`, each with its letter (by the oldest bill's days
 *  overdue) and whether the cadence allows another reminder yet. */
export function reminderCandidates(db: DB, asOn: string): ReminderCandidate[] {
  const cfg = getReceivablesConfig(db)
  const last = lastReminders(db)
  const out: ReminderCandidate[] = []
  for (const p of outstandings(db, 'receivable', asOn)) {
    const c = candidateOf(p, partyRow(db, p.ledgerId), cfg, last.get(p.ledgerId), asOn)
    if (c) out.push(c)
  }
  return out.sort((a, b) => b.maxOverdueDays - a.maxOverdueDays || b.overdue - a.overdue)
}

export const REMINDER_CADENCE_PREFIX = 'Reminder cadence:'

/** The letter for one party: subject + body merged, split at a `{bills}` line for the PDF table. */
function reminderLetter(cfg: ReceivablesConfig, company: CompanyInfo, party: PartyRow, p: OutstandingParty, bucket: ReminderBucket, asOn: string) {
  const overdue = overdueOf(p)
  const fields = reminderFields({ company: company.name, party: party.name, asOn, overdue, totalPending: p.pending })
  const tpl = cfg.reminders[bucket]
  const subject = mergeTemplate(tpl.subject, fields)
  const body = mergeTemplate(tpl.body, fields)
  const lines = tpl.body.split('\n')
  const at = lines.findIndex((l) => l.trim() === '{bills}')
  const bodyBefore = at >= 0 ? mergeTemplate(lines.slice(0, at).join('\n'), fields) : body
  const bodyAfter = at >= 0 ? mergeTemplate(lines.slice(at + 1).join('\n'), fields) : ''
  return { subject, body, bodyBefore, bodyAfter, bills: at >= 0 ? overdue : null, overdue: overdue.reduce((s, b) => s + b.pending, 0) }
}

const BUCKET_HEAD: Record<ReminderBucket, string> = { gentle: 'Reminder', firm: 'Second reminder', final: 'Final notice' }

/** Render, save and log one reminder. Refused inside the cadence window unless `force`. */
export async function remind(
  db: DB, company: CompanyInfo, slug: string,
  q: { ledgerId: number; asOn: string; channel: ReminderChannel; force?: boolean }
): Promise<ReminderResult> {
  const cfg = getReceivablesConfig(db)
  const party = partyRow(db, q.ledgerId)
  const p = outstandings(db, 'receivable', q.asOn).find((x) => x.ledgerId === q.ledgerId)
  const cand = p ? candidateOf(p, party, cfg, lastReminders(db).get(q.ledgerId), q.asOn) : null
  if (!p || !cand) throw new Error(`Nothing is overdue for ${party.name} as on ${toDisplayDate(q.asOn)}`)
  if (!cand.allowed && !q.force) {
    throw new Error(`${REMINDER_CADENCE_PREFIX} ${party.name} was reminded on ${toDisplayDate(cand.lastSent!)} — the next reminder is due from ${toDisplayDate(cand.nextAllowed!)}`)
  }
  const letter = reminderLetter(cfg, company, party, p, cand.bucket, q.asOn)
  const doc: ReminderDocument = {
    shape: 'reminder', kind: 'reminder', company,
    reminder: {
      date: q.asOn, bucketLabel: BUCKET_HEAD[cand.bucket], party: { name: party.name, address: party.address, gstin: party.gstin },
      subject: letter.subject, bodyBefore: letter.bodyBefore, bills: letter.bills, bodyAfter: letter.bodyAfter, overdue: letter.overdue
    }
  }
  const html = renderDocument(resolveTemplate(db, 'reminder'), doc, RENDER_OPTS)
  const path = await writePdf(join(companyExportsDir(slug), 'reminders'), `reminder-${cand.bucket}-${safeName(party.name)}-${q.asOn}.pdf`, html, db, 'reminder')
  const row = {
    party_ledger_id: q.ledgerId, bucket: cand.bucket, date: q.asOn, amount_paise: cand.overdue, oldest_bill: cand.oldestBill,
    max_overdue_days: cand.maxOverdueDays, document_path: path, channel: q.channel, user_name: currentAuditUserName()
  }
  const logId = Number(
    db
      .prepare(
        `INSERT INTO reminder_log (party_ledger_id, bucket, date, amount_paise, oldest_bill, max_overdue_days, document_path, channel, user_name)
         VALUES (@party_ledger_id, @bucket, @date, @amount_paise, @oldest_bill, @max_overdue_days, @document_path, @channel, @user_name)`
      )
      .run(row).lastInsertRowid
  )
  writeAudit(db, 'reminder', logId, 'create', null, { ...row, forced: !!q.force && !cand.allowed })
  return {
    logId, ledgerId: q.ledgerId, name: party.name, bucket: cand.bucket, path, subject: letter.subject, body: letter.body,
    mailto: mailtoLink(party.email, letter.subject, letter.body)
  }
}

/** Bulk generation: every candidate (or the given parties) the cadence allows; the rest are
 *  reported as skipped with the reason. */
export async function remindBulk(db: DB, company: CompanyInfo, slug: string, q: { asOn: string; ledgerIds?: number[]; channel: ReminderChannel }): Promise<ReminderBulkResult> {
  const wanted = q.ledgerIds ? new Set(q.ledgerIds) : null
  const sent: ReminderResult[] = []
  const skipped: ReminderBulkResult['skipped'] = []
  for (const c of reminderCandidates(db, q.asOn)) {
    if (wanted && !wanted.has(c.ledgerId)) continue
    if (!c.allowed) {
      skipped.push({ ledgerId: c.ledgerId, name: c.name, reason: `Reminded on ${toDisplayDate(c.lastSent!)}; next from ${toDisplayDate(c.nextAllowed!)}` })
      continue
    }
    sent.push(await remind(db, company, slug, { ledgerId: c.ledgerId, asOn: q.asOn, channel: q.channel }))
  }
  return { sent, skipped }
}

export function reminderLog(db: DB, from: string, to: string, ledgerId?: number): ReminderLogRow[] {
  return db
    .prepare(
      `SELECT r.id, r.party_ledger_id AS ledgerId, l.name AS partyName, r.bucket, r.date, r.amount_paise AS amount, r.oldest_bill AS oldestBill,
              r.max_overdue_days AS days, r.document_path AS documentPath, r.channel, r.user_name AS userName, r.created_at AS createdAt
       FROM reminder_log r JOIN ledgers l ON l.id = r.party_ledger_id
       WHERE r.date BETWEEN ? AND ? ${ledgerId ? 'AND r.party_ledger_id = ?' : ''}
       ORDER BY r.date DESC, r.id DESC`
    )
    .all(from, to, ...(ledgerId ? [ledgerId] : [])) as ReminderLogRow[]
}

// ---------------------------------------------------------------- interest

/** Bills raised BY an interest debit note never accrue interest themselves (no compounding). */
function interestNoteIds(db: DB): Set<number> {
  return new Set(
    (db.prepare(`SELECT DISTINCT ic.debit_note_voucher_id AS id FROM interest_charges ic JOIN vouchers v ON v.id = ic.debit_note_voucher_id WHERE ${NOT_DELETED}`).all() as { id: number }[]).map((r) => r.id)
  )
}

/** The last day already charged per stable bill key, on live debit notes only. */
function chargedTo(db: DB, partyId: number): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT ic.bill_key AS billKey, MAX(ic.period_to) AS upto
       FROM interest_charges ic JOIN vouchers v ON v.id = ic.debit_note_voucher_id
       WHERE ic.party_ledger_id = ? AND ${NOT_DELETED} GROUP BY ic.bill_key`
    )
    .all(partyId) as { billKey: string; upto: string }[]
  return new Map(rows.map((r) => [r.billKey, r.upto]))
}

/** Each voucher's 'new' bill refs for a party, in entry order (stableBillKey's ordinal). */
function newRefsByVoucher(db: DB, partyId: number): Map<number, string[]> {
  const out = new Map<number, string[]>()
  for (const r of db.prepare("SELECT voucher_id AS v, name FROM bill_refs WHERE party_ledger_id = ? AND kind = 'new' ORDER BY id").all(partyId) as { v: number; name: string }[]) {
    const list = out.get(r.v) ?? []
    list.push(r.name)
    out.set(r.v, list)
  }
  return out
}

interface SupplyFacts {
  /** The original supply's (rate, cess) classes by taxable value; [] = no invoice behind the bill. */
  shares: RateShare[]
  pos: string
  invTyp: string
  supply: SupplyType
  zeroTax: boolean
  /** The original invoice's place-of-supply override (carried onto the note). */
  posOverride: string | null
}

/** The GST facts of the supply a bill belongs to: the original invoice's items and its GSTR-1
 *  class (services/gst.ts outwardSupplyClass — SEZ / export, pos override); a bill with no
 *  invoice (opening balance, journal) gets the party's class and no shares. */
function supplyFacts(db: DB, company: CompanyInfo, party: PartyRow, voucherId: number | null): SupplyFacts {
  const head = voucherId == null
    ? undefined
    : (db
        .prepare(`SELECT vt.kind, v.pos_override AS posOverride FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id WHERE v.id = ? AND ${IN_BOOKS}`)
        .get(voucherId) as { kind: string; posOverride: string | null } | undefined)
  const isInvoice = !!head && (head.kind === 'sales' || head.kind === 'debit_note')
  const posOverride = isInvoice ? head!.posOverride : null
  const cls = outwardSupplyClass(company, { partyExportType: party.exportType, partyState: party.stateCode, posOverride })
  let shares: RateShare[] = []
  if (isInvoice) {
    const [inv] = extractEdocInvoices(db, company, '0000-01-01', '9999-12-31', voucherId!)
    const by = new Map<string, RateShare>()
    for (const i of inv?.items ?? []) {
      const k = `${i.rate}|${i.cessRate ?? 0}`
      const s = by.get(k) ?? { rate: i.rate, cessRate: i.cessRate ?? 0, taxablePaise: 0 }
      s.taxablePaise += i.taxablePaise
      by.set(k, s)
    }
    shares = [...by.values()]
  }
  return { shares, pos: cls.pos, invTyp: cls.invTyp, supply: cls.supply, zeroTax: cls.zeroTax, posOverride }
}

function gstApplies(company: CompanyInfo, cfg: ReceivablesConfig, override?: boolean): boolean {
  // sources.ts 'no-gst-unregistered': only a regular registrant charges GST.
  return company.gstRegistrationType === 'regular' && (override ?? cfg.interest.gstOnInterest)
}

const booksBegin = (company: CompanyInfo): string => `${company.booksFrom}-04-01`

/**
 * Interest due per overdue bill of every party with a rate (or one party) as on `asOn`.
 * Bills are identified by stableBillKey; an opening-balance bill runs from its true origin — the
 * books-begin date (+ credit days) — never the current FY start the ageing allocation re-dates it
 * to, so no year's interest is lost and charging continues from the last charged day.
 * Fully paid late bills accrue nothing (interest is on the pending amount only).
 */
export function interestPreview(db: DB, company: CompanyInfo, asOn: string, ledgerId?: number, gstOnInterest?: boolean): InterestRow[] {
  const cfg = getReceivablesConfig(db)
  const charge = gstApplies(company, cfg, gstOnInterest)
  const notes = interestNoteIds(db)
  const parties = new Map(debtorRows(db).filter((p) => (p.rateBp ?? 0) > 0 && (!ledgerId || p.id === ledgerId)).map((p) => [p.id, p]))
  if (!parties.size) return []
  const rows: InterestRow[] = []
  for (const op of outstandings(db, 'receivable', asOn)) {
    const party = parties.get(op.ledgerId)
    if (!party) continue
    const charged = chargedTo(db, party.id)
    const refs = newRefsByVoucher(db, party.id)
    for (const b of op.bills) {
      if (b.pending <= 0 || (b.voucherId != null && notes.has(b.voucherId))) continue
      const billKey = stableBillKey(b.voucherId, b.number, b.voucherId != null ? refs.get(b.voucherId) : [])
      const opening = b.voucherId == null
      const billDate = opening ? booksBegin(company) : b.date
      const dueDate = opening ? (party.creditDays != null ? addDaysIso(billDate, party.creditDays) : null) : b.dueDate
      const upto = charged.get(billKey) ?? null
      const r = billInterest({ billDate, dueDate, pendingPaise: b.pending, rateBp: party.rateBp!, graceDays: party.graceDays, chargedTo: upto }, asOn)
      if (!r.period || r.interestPaise < Math.max(1, cfg.interest.minimumPaise)) continue
      const facts = supplyFacts(db, company, party, b.voucherId)
      let shares = facts.shares
      let warning: string | null = null
      let blocked: string | null = null
      if (charge && shares.length === 0) {
        // sources.ts 'no-invoice-bills'.
        if (cfg.interest.defaultGstRate != null) {
          shares = [{ rate: cfg.interest.defaultGstRate, taxablePaise: 1 }]
          warning = `No invoice behind this bill — GST at the default ${cfg.interest.defaultGstRate}% (Settings → Receivables)`
        } else {
          blocked = 'No invoice behind this bill to take a GST rate from — set a default rate in Settings → Receivables, or turn GST on interest off'
        }
      }
      if (charge && facts.zeroTax) warning = `${facts.invTyp === 'SEWOP' ? 'SEZ' : 'Export'} without payment of tax — no GST on the interest`
      const gst = splitInterestGst(r.interestPaise, charge ? shares : [], facts.supply, charge, facts.zeroTax)
      const gstPaise = gstOfLines(gst)
      rows.push({
        key: `${party.id}:${billKey}`, billKey, billVoucherId: b.voucherId, billRef: b.number, ledgerId: party.id, partyName: party.name,
        billDate, dueDate, graceDays: party.graceDays, rateBp: party.rateBp!, pendingPaise: b.pending, chargedTo: upto,
        from: r.period.from, to: r.period.to, days: r.period.days, interestPaise: r.interestPaise, gst, gstPaise,
        totalPaise: r.interestPaise + gstPaise, supply: facts.supply, pos: facts.pos, invTyp: facts.invTyp, zeroTax: facts.zeroTax,
        notePos: facts.posOverride, warning, blocked
      })
    }
  }
  return rows
}

/** An OUTPUT tax ledger: tagged with the tax type and not named Input*, preferring one named
 *  Output*; with none, "Output CGST" (etc.) is created under Duties & Taxes. */
function outputTaxLedger(db: DB, t: 'cgst' | 'sgst' | 'igst' | 'cess'): number {
  const tagged = db
    .prepare("SELECT id FROM ledgers WHERE tax_type = ? AND lower(name) NOT LIKE '%input%' ORDER BY (lower(name) LIKE '%output%') DESC, id LIMIT 1")
    .get(t) as { id: number } | undefined
  if (tagged) return tagged.id
  const group = db.prepare("SELECT id FROM groups WHERE name = 'Duties & Taxes'").get() as { id: number } | undefined
  if (!group) throw new Error('Group "Duties & Taxes" not found')
  const base = `Output ${t.toUpperCase()}`
  let name = base
  for (let n = 2; db.prepare('SELECT 1 FROM ledgers WHERE name = ?').get(name); n++) name = `${base} ${n}`
  return createLedger(db, { name, groupId: group.id, taxType: t }).id
}

/** The interest income ledger for a (GST rate, cess) class: "<name>" for no GST, "<name> @ 18%"
 *  or "<name> @ 28% + cess 12%" — its gst_rate / cess_rate make the GST returns read the note's
 *  line at that class (gst.ts / edocs.ts); the company's SAC, when set, goes on it as its HSN. */
function interestLedgerFor(db: DB, cfg: ReceivablesConfig, rate: number, cessRate: number): number {
  const name = rate > 0 ? `${cfg.interest.ledgerName} @ ${rate}%${cessRate > 0 ? ` + cess ${cessRate}%` : ''}` : cfg.interest.ledgerName
  const sac = cfg.interest.sac || null
  const found = db.prepare('SELECT id, hsn FROM ledgers WHERE name = ?').get(name) as { id: number; hsn: string | null } | undefined
  if (found) {
    if (sac && !found.hsn) {
      const before = getLedger(db, found.id)
      db.prepare('UPDATE ledgers SET hsn = ? WHERE id = ?').run(sac, found.id)
      writeAudit(db, 'ledger', found.id, 'update', before, getLedger(db, found.id))
    }
    return found.id
  }
  const group = db.prepare("SELECT id FROM groups WHERE name = 'Indirect Incomes'").get() as { id: number } | undefined
  if (!group) throw new Error('Group "Indirect Incomes" not found')
  const id = createLedger(db, { name, groupId: group.id, gstRate: rate > 0 ? rate : null, hsn: sac }).id
  if (cessRate > 0) db.prepare('UPDATE ledgers SET cess_rate = ? WHERE id = ?').run(cessRate, id)
  return id
}

/**
 * Post the interest of one party's chosen bills (all postable ones by default) through
 * saveVoucher — one debit note per place-of-supply group (the original invoices' overrides):
 * Dr party; Cr the interest ledger of each bill's (rate, cess) class, ONE LINE PER BILL PER CLASS
 * (so the GST returns, which tax per line, land on exactly the stored per-bill figures); Cr
 * output CGST + SGST or IGST and cess = the sum of those per-bill figures. The bill-periods are
 * recorded in interest_charges inside the same transaction, so a period is never charged twice.
 */
export function postInterest(
  db: DB, company: CompanyInfo,
  q: { asOn: string; date?: string; ledgerId: number; keys?: string[]; gstOnInterest?: boolean },
  today: string = todayISO()
): InterestPostResult {
  const date = q.date ?? q.asOn
  if (q.asOn > today) throw new Error('Interest can only be charged up to today')
  if (date < q.asOn) throw new Error('The debit note can’t be dated before the as-on date')
  if (date > today) throw new Error('The debit note can’t be dated in the future')
  const cfg = getReceivablesConfig(db)
  const charge = gstApplies(company, cfg, q.gstOnInterest)
  const wanted = q.keys ? new Set(q.keys) : null
  const all = interestPreview(db, company, q.asOn, q.ledgerId, charge).filter((r) => !wanted || wanted.has(r.key) || wanted.has(r.billKey))
  const rows = all.filter((r) => !r.blocked)
  if (!rows.length) throw new Error(all.length ? all[0]!.blocked! : 'No interest to charge for this party as on that date')
  const party = partyRow(db, q.ledgerId)
  const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'debit_note' ORDER BY id LIMIT 1").get() as { id: number } | undefined
  if (!vt) throw new Error('No debit note voucher type')
  const groups = new Map<string, InterestRow[]>()
  for (const r of rows) groups.set(r.notePos ?? '', [...(groups.get(r.notePos ?? '') ?? []), r])

  return db.transaction((): InterestPostResult => {
    const notes: InterestPostResult['notes'] = []
    for (const [pos, group] of groups) {
      const credits: { ledgerId: number; amount: number }[] = []
      const tax = { cgst: 0, sgst: 0, igst: 0, cess: 0 }
      for (const r of group) {
        for (const g of r.gst) {
          credits.push({ ledgerId: interestLedgerFor(db, cfg, g.rate, g.cessRate), amount: g.interestPaise })
          tax.cgst += g.cgst
          tax.sgst += g.sgst
          tax.igst += g.igst
          tax.cess += g.cess
        }
      }
      for (const t of ['cgst', 'sgst', 'igst', 'cess'] as const) if (tax[t] > 0) credits.push({ ledgerId: outputTaxLedger(db, t), amount: tax[t] })
      const interest = group.reduce((s, r) => s + r.interestPaise, 0)
      const gstPaise = group.reduce((s, r) => s + r.gstPaise, 0)
      const desc = group.map((r) => `${r.billRef} ${toDisplayDate(r.from)}–${toDisplayDate(r.to)} ${r.days}d`).join('; ')
      const narration = `Interest @ ${(party.rateBp! / 100).toFixed(2).replace(/\.00$/, '')}% p.a. on overdue bills to ${toDisplayDate(q.asOn)}: ${desc}`.slice(0, 1000)
      const saved = saveVoucher(
        db,
        {
          voucherTypeId: vt.id, date, partyLedgerId: party.id, narration,
          reference: group.length === 1 ? group[0]!.billRef.slice(0, 120) : null,
          posOverride: pos || null,
          lines: [{ ledgerId: party.id, drCr: 'dr', amount: interest + gstPaise }, ...credits.map((c) => ({ ledgerId: c.ledgerId, drCr: 'cr' as const, amount: c.amount }))],
          inventory: [], billRefs: [], tds: null
        },
        undefined,
        {
          withinTransaction: (voucherId) => {
            const ins = db.prepare(
              `INSERT INTO interest_charges (party_ledger_id, bill_voucher_id, bill_ref, bill_key, period_from, period_to, days, principal_paise, rate_bp, interest_paise, gst_paise, debit_note_voucher_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            for (const r of group) ins.run(party.id, r.billVoucherId, r.billRef, r.billKey, r.from, r.to, r.days, r.pendingPaise, r.rateBp, r.interestPaise, r.gstPaise, voucherId)
          }
        }
      )
      writeAudit(db, 'interest_charge', saved.id, 'create', null, {
        debitNote: saved.number, ledgerId: party.id, asOn: q.asOn, gstOnInterest: charge, interestPaise: interest, gstPaise, posOverride: pos || null,
        bills: group.map((r) => ({ bill: r.billRef, billKey: r.billKey, from: r.from, to: r.to, days: r.days, principal: r.pendingPaise, rateBp: r.rateBp, interest: r.interestPaise, gst: r.gstPaise }))
      })
      notes.push({ voucherId: saved.id, number: saved.number, interestPaise: interest, gstPaise })
    }
    return {
      notes, voucherId: notes[0]!.voucherId, number: notes.map((n) => n.number).join(', '),
      interestPaise: notes.reduce((s, n) => s + n.interestPaise, 0), gstPaise: notes.reduce((s, n) => s + n.gstPaise, 0), charges: rows.length
    }
  })()
}

export function interestCharges(db: DB, ledgerId?: number): InterestChargeRow[] {
  return (
    db
      .prepare(
        `SELECT ic.id, ic.party_ledger_id AS ledgerId, l.name AS partyName, ic.bill_voucher_id AS billVoucherId, ic.bill_ref AS billRef,
                ic.period_from AS periodFrom, ic.period_to AS periodTo, ic.days, ic.principal_paise AS principalPaise, ic.rate_bp AS rateBp,
                ic.interest_paise AS interestPaise, ic.gst_paise AS gstPaise, ic.debit_note_voucher_id AS debitNoteVoucherId,
                v.number AS debitNoteNumber, v.deleted_at IS NOT NULL AS binned
         FROM interest_charges ic JOIN ledgers l ON l.id = ic.party_ledger_id JOIN vouchers v ON v.id = ic.debit_note_voucher_id
         ${ledgerId ? 'WHERE ic.party_ledger_id = ?' : ''} ORDER BY ic.period_to DESC, ic.id DESC`
      )
      .all(...(ledgerId ? [ledgerId] : [])) as (Omit<InterestChargeRow, 'binned'> & { binned: number })[]
  ).map((r) => ({ ...r, binned: !!r.binned }))
}

// ---------------------------------------------------------------- credit control

export function setCreditHold(db: DB, ledgerId: number, hold: boolean, reason: string): { hold: boolean; reason: string | null; at: string | null } {
  const before = partyRow(db, ledgerId)
  const at = hold ? new Date().toISOString() : null
  const r = hold ? reason.trim() : null
  db.prepare('UPDATE ledgers SET credit_hold = ?, credit_hold_reason = ?, credit_hold_at = ? WHERE id = ?').run(hold ? 1 : 0, r, at, ledgerId)
  writeAudit(db, 'credit_hold', ledgerId, 'update',
    { ledger: before.name, hold: !!before.hold, reason: before.holdReason, at: before.holdAt },
    { ledger: before.name, hold, reason: r, at })
  return { hold, reason: r, at }
}

function balancesAsOn(db: DB, asOn: string): Map<number, number> {
  const rows = db
    .prepare(
      `SELECT vl.ledger_id AS id, SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END) AS m
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id WHERE v.date <= ? AND ${IN_BOOKS} GROUP BY vl.ledger_id`
    )
    .all(asOn) as { id: number; m: number }[]
  return new Map(rows.map((r) => [r.id, r.m]))
}

interface LatestPromise { date: string; amount: number | null }

/** The latest follow-up carrying a promise, per bill key. */
function latestPromises(db: DB): Map<string, LatestPromise & { ledgerId: number; id: number }> {
  const rows = db
    .prepare(
      `SELECT id, party_ledger_id AS ledgerId, bill_voucher_id AS billVoucherId, bill_ref AS billRef, promised_date AS date, promised_amount AS amount
       FROM bill_followups WHERE promised_date IS NOT NULL ORDER BY date, id`
    )
    .all() as { id: number; ledgerId: number; billVoucherId: number | null; billRef: string; date: string; amount: number | null }[]
  const out = new Map<string, LatestPromise & { ledgerId: number; id: number }>()
  for (const r of rows) out.set(`${r.ledgerId}#${billKeyOf(r)}`, { date: r.date, amount: r.amount, ledgerId: r.ledgerId, id: r.id })
  return out
}

/** Debtors by exposure: balance, overdue, open sales orders, limit utilisation, trailing 90-day
 *  DSO, hold status, the next promised payment and the last reminder. */
export function creditControl(db: DB, asOn: string): CreditControlRow[] {
  const bal = balancesAsOn(db, asOn)
  const os = new Map(outstandings(db, 'receivable', asOn).map((p) => [p.ledgerId, p]))
  const windowFrom = addDaysIso(asOn, -89)
  const sales = new Map<number, number>()
  for (const r of registerVoucherRows(db, 'sales', windowFrom, asOn)) if (r.partyLedgerId != null) sales.set(r.partyLedgerId, (sales.get(r.partyLedgerId) ?? 0) + r.total)
  const promises = latestPromises(db)
  const last = lastReminders(db)
  const rows: CreditControlRow[] = []
  for (const p of debtorRows(db)) {
    const outstanding = (bal.get(p.id) ?? 0) + p.openingBalance
    const party = os.get(p.id)
    if (outstanding === 0 && !party && !p.hold && p.creditLimit == null) continue
    const overdueBills = party ? overdueOf(party) : []
    const openOrders = openSalesOrderValue(db, p.id)
    const exposure = Math.max(0, outstanding) + openOrders
    // Next promise on a still-open bill: the earliest on/after asOn, else the latest broken one.
    const open = new Set((party?.bills ?? []).map((b) => `${p.id}#${billKeyOf({ billVoucherId: b.voucherId, billRef: b.number })}`))
    const mine = [...promises.entries()].filter(([k]) => open.has(k)).map(([, v]) => v)
    const next = mine.filter((x) => x.date >= asOn).sort((a, b) => a.date.localeCompare(b.date))[0] ?? mine.sort((a, b) => b.date.localeCompare(a.date))[0]
    rows.push({
      ledgerId: p.id, name: p.name, outstanding, overdue: overdueBills.reduce((s, b) => s + b.pending, 0), openOrders, exposure,
      creditLimit: p.creditLimit, utilisation: p.creditLimit ? Math.round((exposure / p.creditLimit) * 10_000) / 10_000 : null,
      dso: partyDso(Math.max(0, outstanding), sales.get(p.id) ?? 0, 90),
      maxOverdueDays: overdueBills.reduce((m, b) => Math.max(m, b.overdueDays), 0),
      hold: !!p.hold, holdReason: p.holdReason, holdAt: p.holdAt,
      promisedDate: next?.date ?? null, promisedAmount: next?.amount ?? null, lastReminder: last.get(p.id)?.date ?? null
    })
  }
  return rows.sort((a, b) => b.exposure - a.exposure)
}

// ---------------------------------------------------------------- follow-ups

const FOLLOWUP_SQL = `SELECT f.id, f.party_ledger_id AS ledgerId, l.name AS partyName, f.bill_voucher_id AS billVoucherId, f.bill_ref AS billRef,
  f.date, f.note, f.promised_date AS promisedDate, f.promised_amount AS promisedAmount, f.user_name AS userName, f.created_at AS createdAt
  FROM bill_followups f JOIN ledgers l ON l.id = f.party_ledger_id`

export function addFollowup(db: DB, raw: FollowupInput): FollowupRow {
  const f = followupInputSchema.parse(raw)
  partyRow(db, f.ledgerId)
  const id = Number(
    db
      .prepare('INSERT INTO bill_followups (party_ledger_id, bill_voucher_id, bill_ref, date, note, promised_date, promised_amount, user_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(f.ledgerId, f.billVoucherId, f.billRef, f.date, f.note, f.promisedDate, f.promisedAmount, currentAuditUserName()).lastInsertRowid
  )
  const row = db.prepare(`${FOLLOWUP_SQL} WHERE f.id = ?`).get(id) as FollowupRow
  writeAudit(db, 'bill_followup', id, 'create', null, row)
  return row
}

export function deleteFollowup(db: DB, id: number): void {
  const before = db.prepare(`${FOLLOWUP_SQL} WHERE f.id = ?`).get(id) as FollowupRow | undefined
  if (!before) throw new Error('Follow-up not found')
  db.prepare('DELETE FROM bill_followups WHERE id = ?').run(id)
  writeAudit(db, 'bill_followup', id, 'delete', before, null)
}

export function listFollowups(db: DB, ledgerId?: number): FollowupRow[] {
  return db.prepare(`${FOLLOWUP_SQL} ${ledgerId ? 'WHERE f.party_ledger_id = ?' : ''} ORDER BY f.date DESC, f.id DESC`).all(...(ledgerId ? [ledgerId] : [])) as FollowupRow[]
}

/** Monday..Sunday of the week containing `date`. */
export function weekOf(date: string): { from: string; to: string } {
  const dow = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7 // 0 = Monday
  const from = addDaysIso(date, -dow)
  return { from, to: addDaysIso(from, 6) }
}

/** Promises falling due this week (Mon–Sun) on bills still open as on `today`, latest promise per
 *  bill; `overdueCount` = promises dated before today whose bill is still open (broken). */
export function promisedThisWeek(db: DB, today: string): PromisedSummary {
  const week = weekOf(today)
  const pending = new Map<string, number>()
  for (const p of outstandings(db, 'receivable', today)) {
    for (const b of p.bills) if (b.pending > 0) pending.set(`${p.ledgerId}#${billKeyOf({ billVoucherId: b.voucherId, billRef: b.number })}`, b.pending)
  }
  const latest = latestPromises(db)
  const ids: { id: number; stillPending: number }[] = []
  let overdueCount = 0
  for (const [k, v] of latest) {
    const still = pending.get(k)
    if (still === undefined) continue
    if (v.date >= week.from && v.date <= week.to) ids.push({ id: v.id, stillPending: still })
    else if (v.date < today) overdueCount++
  }
  const stmt = db.prepare(`${FOLLOWUP_SQL} WHERE f.id = ?`)
  const rows = ids.map(({ id, stillPending }) => ({ ...(stmt.get(id) as FollowupRow), stillPending })).sort((a, b) => (a.promisedDate ?? '').localeCompare(b.promisedDate ?? ''))
  return {
    weekFrom: week.from, weekTo: week.to, count: rows.length,
    amount: rows.reduce((s, r) => s + Math.min(r.promisedAmount ?? r.stillPending, r.stillPending), 0),
    overdueCount, rows
  }
}

// ---------------------------------------------------------------- collection reports

/** Net credit sales per month on debtors: sales + debit notes − credit notes (party-line totals). */
function salesByMonth(db: DB, from: string, to: string): Map<string, number> {
  const debtors = descendantIdsByName(db, ['Sundry Debtors'])
  const rows = db
    .prepare(
      `SELECT substr(v.date, 1, 7) AS month, vt.kind, l.group_id AS groupId, vl.dr_cr AS drCr, vl.amount
       FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id JOIN voucher_lines vl ON vl.voucher_id = v.id
       JOIN ledgers l ON l.id = vl.ledger_id
       WHERE vt.kind IN ('sales', 'debit_note', 'credit_note') AND v.date BETWEEN ? AND ? AND vl.ledger_id = v.party_ledger_id AND ${IN_BOOKS}`
    )
    .all(from, to) as { month: string; kind: string; groupId: number; drCr: 'dr' | 'cr'; amount: number }[]
  const out = new Map<string, number>()
  for (const r of rows) {
    if (!debtors.has(r.groupId)) continue
    out.set(r.month, (out.get(r.month) ?? 0) + (r.drCr === 'dr' ? r.amount : -r.amount))
  }
  return out
}

function receivablesAt(db: DB, asOn: string): { total: number; notDue: number; buckets: [number, number, number, number] } {
  const parties = outstandings(db, 'receivable', asOn)
  const bills = parties.flatMap((p) => p.bills)
  return {
    total: bills.reduce((s, b) => s + b.pending, 0),
    notDue: bills.filter((b) => b.overdueDays === 0).reduce((s, b) => s + b.pending, 0),
    buckets: ageingBuckets(bills)
  }
}

/** Month by month: DSO, collection efficiency (received ÷ due) and the ageing at month end. */
export function collectionReport(db: DB, from: string, to: string): CollectionReport {
  const months = monthsBetween(from, to)
  const sales = salesByMonth(db, monthStartIso(months[0] ?? from.slice(0, 7)), to)
  let opening = receivablesAt(db, addDaysIso(monthStartIso(months[0] ?? from.slice(0, 7)), -1)).total
  const out: CollectionReport['months'] = []
  for (const m of months) {
    const end = monthEndIso(m) > to ? to : monthEndIso(m)
    const at = receivablesAt(db, end)
    out.push({ ...collectionMonth({ month: m, opening, sales: sales.get(m) ?? 0, closing: at.total, closingNotDue: at.notDue, days: Number(end.slice(8, 10)) }), buckets: at.buckets })
    opening = at.total
  }
  return { months: out }
}

export function topOverdue(db: DB, asOn: string, limit: number): TopOverdueRow[] {
  const lastReceipt = new Map(
    (
      db
        .prepare(
          `SELECT vl.ledger_id AS id, MAX(v.date) AS d FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id JOIN voucher_types vt ON vt.id = v.voucher_type_id
           WHERE vt.kind = 'receipt' AND vl.dr_cr = 'cr' AND v.date <= ? AND ${IN_BOOKS} GROUP BY vl.ledger_id`
        )
        .all(asOn) as { id: number; d: string }[]
    ).map((r) => [r.id, r.d])
  )
  const cc = new Map(creditControl(db, asOn).map((r) => [r.ledgerId, r]))
  return outstandings(db, 'receivable', asOn)
    .map((p): TopOverdueRow | null => {
      const od = overdueOf(p)
      if (!od.length) return null
      const oldest = [...od].sort((a, b) => b.overdueDays - a.overdueDays)[0]!
      return {
        ledgerId: p.ledgerId, name: p.name, overdue: od.reduce((s, b) => s + b.pending, 0), total: p.pending, maxOverdueDays: oldest.overdueDays,
        oldestBill: oldest.number, billCount: od.length, lastReceiptDate: lastReceipt.get(p.ledgerId) ?? null,
        promisedDate: cc.get(p.ledgerId)?.promisedDate ?? null, hold: cc.get(p.ledgerId)?.hold ?? false
      }
    })
    .filter((r): r is TopOverdueRow => r !== null)
    .sort((a, b) => b.overdue - a.overdue)
    .slice(0, limit)
}
