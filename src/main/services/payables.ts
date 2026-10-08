/**
 * Payables (WP 4.3): payment planning by due date, MSME (MSMED Act 2006) tracking and report, the
 * s.43B(h) figure, MSME Form 1 data, payment runs (planned or batch payment vouchers), supplier
 * statements and supplier reconciliation.
 *
 * Every figure here is computed at query time from the same bill-wise allocation the Outstandings
 * screen uses (analysis.outstandings / openBills over voucher lines + bill_refs) — the planning
 * total is the payables outstanding by construction. Payments are posted through saveVoucher (its
 * validation, TDS checks, lock date and audit row), each inside one transaction per run.
 * The legal rules and their sources live in src/shared/payables/msme.ts + msmeSources.ts.
 */
import type { DB } from '../db/connection'
import type { OutstandingBill } from '@shared/reports'
import { fyFromStartYear, fyOf, todayISO } from '@shared/dates'
import { rowsToCsv } from '@shared/csv'
import { plainRupees } from '@shared/money'
import {
  bankRateOn, daysBetween, disallowance43Bh, formMsme1Period, FORM_MSME1_DAYS, isMsmeCovered, MSME_AGE_BUCKETS, msmeAgeBucket,
  previousFormMsme1Period, s15Deadline, s16Interest, S16_BANK_RATE_MULTIPLE, isValidUdyam,
  type BankRateRow, type MsmeAgeBucket, type MsmeCategory
} from '@shared/payables/msme'
import { daysToPay, earlyDiscount, payByDate, planBucket } from '@shared/payables/planning'
import { parseSupplierStatementCsv, reconcileSupplier, type BookLedgerLine } from '@shared/payables/supplierRecon'
import type {
  MsmeForm1Supplier, MsmeBill43Bh, MsmeBillRow, MsmeDueSummary, MsmeFormRow, MsmeReport, MsmeYearEndWarning, PayablePlanRow, PayablesPlan,
  PaymentRun, PaymentRunLine, PaymentRunPreview, PlanCashLedger, SupplierMsmeFacts, SupplierReconResult, SupplierStatement
} from '@shared/payables/types'
import { bankRateInputSchema, paymentRunSchema, type PaymentRunInput } from '@shared/payables/schemas'
import { outstandings, openBills, partyBillEvents } from './analysis'
import { settlementTimeline } from '@shared/payables/settlements'
import { descendantIdsByName } from './masters'
import { saveVoucher, IN_BOOKS, NOT_DELETED } from './vouchers'
import { ledgerStatement } from './reports'
import { tdsSuggestion } from './tds'
import { getFeatures } from './config'
import { writeAudit } from './audit'

// ---------------------------------------------------------------------------------------------
// Supplier facts
// ---------------------------------------------------------------------------------------------

interface SupplierRow {
  id: number
  name: string
  pan: string | null
  creditDays: number | null
  msme: SupplierMsmeFacts | null
  discount: { bp: number; days: number } | null
  /** ITC on this supplier's bills is blocked (GST is then part of the cost). */
  itcBlocked: boolean
}

interface LedgerTermsRow {
  id: number; name: string; pan: string | null; credit_days: number | null
  msme_registered: number; msme_registered_from: string | null; itc_eligibility: string | null; udyam_no: string | null; msme_category: MsmeCategory | null; agreed_credit_days: number | null
  early_payment_discount_bp: number | null; early_payment_discount_days: number | null
}

/** Every ledger's supplier terms (MSME flags, discount), keyed by id. */
function supplierFacts(db: DB): Map<number, SupplierRow> {
  const rows = db
    .prepare(
      `SELECT id, name, pan, credit_days, msme_registered, msme_registered_from, itc_eligibility, udyam_no, msme_category, agreed_credit_days,
              early_payment_discount_bp, early_payment_discount_days FROM ledgers`
    )
    .all() as LedgerTermsRow[]
  const out = new Map<number, SupplierRow>()
  for (const r of rows) {
    const registered = !!r.msme_registered
    out.set(r.id, {
      id: r.id,
      name: r.name,
      pan: r.pan,
      creditDays: r.credit_days,
      msme: registered || r.msme_category
        ? {
            category: r.msme_category,
            udyamNo: r.udyam_no,
            covered: isMsmeCovered({ registered, category: r.msme_category }),
            registeredFrom: r.msme_registered_from,
            agreedCreditDays: r.agreed_credit_days
          }
        : null,
      itcBlocked: r.itc_eligibility === 'blocked',
      discount: r.early_payment_discount_bp && r.early_payment_discount_bp > 0
        ? { bp: r.early_payment_discount_bp, days: r.early_payment_discount_days ?? 0 }
        : null
    })
  }
  return out
}

/** The supplier's invoice number (vouchers.reference) for each bill voucher. */
function referencesFor(db: DB, voucherIds: (number | null)[]): Map<number, string | null> {
  const ids = [...new Set(voucherIds.filter((v): v is number => v != null))]
  const out = new Map<number, string | null>()
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    const rows = db.prepare(`SELECT id, reference FROM vouchers WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as {
      id: number; reference: string | null
    }[]
    for (const r of rows) out.set(r.id, r.reference)
  }
  return out
}

/** The supplier is a covered (micro / small, registered) s.2(n) supplier for a bill accepted on
 *  `billDate` — bills accepted before the recorded registration date are not covered. */
const coveredOn = (f: SupplierRow | undefined, billDate: string): boolean =>
  !!f?.msme?.covered && (f.msme.registeredFrom == null || billDate >= f.msme.registeredFrom)

const billKey = (ledgerId: number, b: Pick<OutstandingBill, 'voucherId' | 'number'>): string => `${ledgerId}|${b.voucherId ?? 'open'}|${b.number}`

// ---------------------------------------------------------------------------------------------
// Bank rate (s.16) — effective-dated, editable
// ---------------------------------------------------------------------------------------------

export function listBankRates(db: DB): BankRateRow[] {
  return (
    db.prepare('SELECT id, from_date AS fromDate, rate_bp AS rateBp, source FROM msme_bank_rates ORDER BY from_date').all() as BankRateRow[]
  )
}

export function saveBankRate(db: DB, raw: unknown, id?: number): BankRateRow {
  const input = bankRateInputSchema.parse(raw)
  const before = id ? (db.prepare('SELECT id, from_date AS fromDate, rate_bp AS rateBp, source FROM msme_bank_rates WHERE id = ?').get(id) as BankRateRow | undefined) : null
  if (id && !before) throw new Error('Bank rate not found')
  const clash = db.prepare('SELECT id FROM msme_bank_rates WHERE from_date = ? AND id IS NOT ?').get(input.fromDate, id ?? null)
  if (clash) throw new Error(`A bank rate from ${input.fromDate} already exists — edit that one`)
  let rowId = id
  if (id) db.prepare('UPDATE msme_bank_rates SET from_date = ?, rate_bp = ?, source = ? WHERE id = ?').run(input.fromDate, input.rateBp, input.source, id)
  else rowId = Number(db.prepare('INSERT INTO msme_bank_rates (from_date, rate_bp, source) VALUES (?, ?, ?)').run(input.fromDate, input.rateBp, input.source).lastInsertRowid)
  const after: BankRateRow = { id: rowId, ...input }
  writeAudit(db, 'msme_bank_rate', rowId!, id ? 'update' : 'create', before ?? null, after)
  return after
}

export function deleteBankRate(db: DB, id: number): void {
  const before = db.prepare('SELECT id, from_date AS fromDate, rate_bp AS rateBp, source FROM msme_bank_rates WHERE id = ?').get(id) as BankRateRow | undefined
  if (!before) throw new Error('Bank rate not found')
  const n = (db.prepare('SELECT COUNT(*) AS n FROM msme_bank_rates').get() as { n: number }).n
  if (n <= 1) throw new Error('Keep at least one bank rate — s.16 interest needs one')
  db.prepare('DELETE FROM msme_bank_rates WHERE id = ?').run(id)
  writeAudit(db, 'msme_bank_rate', id, 'delete', before, null)
}

// ---------------------------------------------------------------------------------------------
// Cash available
// ---------------------------------------------------------------------------------------------

/** Cash and bank ledgers with their balances as on `asOn` (in books only). */
export function cashPosition(db: DB, asOn: string): { ledgers: PlanCashLedger[]; total: number } {
  const cashIds = descendantIdsByName(db, ['Cash-in-Hand'])
  const bankIds = descendantIdsByName(db, ['Bank Accounts', 'Bank OD A/c'])
  const rows = db
    .prepare(
      `SELECT l.id AS ledgerId, l.name, l.group_id AS groupId, l.opening_balance + COALESCE(m.movement, 0) AS balance
       FROM ledgers l
       LEFT JOIN (
         SELECT vl.ledger_id, SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END) AS movement
         FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
         WHERE v.date <= ? AND ${IN_BOOKS}
         GROUP BY vl.ledger_id
       ) m ON m.ledger_id = l.id
       ORDER BY l.name`
    )
    .all(asOn) as { ledgerId: number; name: string; groupId: number; balance: number }[]
  const ledgers: PlanCashLedger[] = rows
    .filter((r) => cashIds.has(r.groupId) || bankIds.has(r.groupId))
    .map((r) => ({ ledgerId: r.ledgerId, name: r.name, kind: cashIds.has(r.groupId) ? ('cash' as const) : ('bank' as const), balance: r.balance }))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'bank' ? -1 : 1))
  return { ledgers, total: ledgers.reduce((s, l) => s + l.balance, 0) }
}

// ---------------------------------------------------------------------------------------------
// Payment planning
// ---------------------------------------------------------------------------------------------

/**
 * Every open supplier bill as on `asOn` (Outstandings' payables, bill by bill) with its pay-by
 * date — the earlier of its credit-terms due date and, for a micro / small supplier, the s.15
 * deadline — bucketed overdue / this week / next week / later, its early-payment discount and the
 * indicative s.16 interest already running. Totals equal the Outstandings payables total.
 */
export function payablesPlan(db: DB, asOn: string): PayablesPlan {
  const facts = supplierFacts(db)
  const rates = listBankRates(db)
  const parties = outstandings(db, 'payable', asOn)
  const refs = referencesFor(db, parties.flatMap((p) => p.bills.map((b) => b.voucherId)))
  const rows: PayablePlanRow[] = []
  for (const p of parties) {
    const f = facts.get(p.ledgerId)
    for (const b of p.bills) {
      const s15 = coveredOn(f, b.date) ? s15Deadline(b.date, f!.msme!.agreedCreditDays) : null
      const payBy = payByDate(b.date, b.dueDate, s15?.payBy ?? null)
      const interest = s15 && asOn >= s15.interestFrom ? s16Interest(b.pending, s15.interestFrom, asOn, rates).interestPaise : 0
      rows.push({
        key: billKey(p.ledgerId, b),
        ledgerId: p.ledgerId,
        partyName: p.name,
        voucherId: b.voucherId,
        number: b.number,
        supplierRef: b.voucherId != null ? (refs.get(b.voucherId) ?? null) : null,
        date: b.date,
        amount: b.amount,
        pending: b.pending,
        dueDate: b.dueDate,
        msme: f?.msme ?? null,
        s15,
        payBy,
        bucket: planBucket(payBy, asOn),
        daysToPay: daysToPay(payBy, asOn),
        discount: earlyDiscount(b.pending, b.date, f?.discount ?? null, asOn),
        interestIndicative: interest
      })
    }
  }
  rows.sort((a, b) => a.payBy.localeCompare(b.payBy) || a.partyName.localeCompare(b.partyName) || a.date.localeCompare(b.date))
  const totals = { pending: 0, msmeOverdue: 0, discountAvailable: 0, overdue: 0, this_week: 0, next_week: 0, later: 0 } as PayablesPlan['totals']
  for (const r of rows) {
    totals.pending += r.pending
    totals[r.bucket] += r.pending
    if (r.s15 && r.bucket === 'overdue' && r.s15.payBy < asOn) totals.msmeOverdue += r.pending
    if (r.discount?.available) totals.discountAvailable += r.discount.paise
  }
  return { asOn, rows, totals, cash: cashPosition(db, asOn) }
}

/** Dashboard tile (additive): micro / small dues whose s.15 deadline falls this week, and those past it. */
export function msmeDueSummary(db: DB, asOn: string): MsmeDueSummary {
  const plan = payablesPlan(db, asOn)
  const out: MsmeDueSummary = { asOn, dueThisWeek: 0, dueThisWeekBills: 0, overdue: 0, overdueBills: 0 }
  for (const r of plan.rows) {
    if (!r.s15) continue
    const b = planBucket(r.s15.payBy, asOn)
    if (b === 'overdue') {
      out.overdue += r.pending
      out.overdueBills++
    } else if (b === 'this_week') {
      out.dueThisWeek += r.pending
      out.dueThisWeekBills++
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Payment runs — one payment voucher per supplier, bill-wise, TDS on payment, through saveVoucher
// ---------------------------------------------------------------------------------------------

function paymentVoucherTypeId(db: DB, requested?: number): number {
  if (requested) {
    const vt = db.prepare('SELECT id, kind FROM voucher_types WHERE id = ?').get(requested) as { id: number; kind: string } | undefined
    if (!vt || vt.kind !== 'payment') throw new Error('Pick a payment voucher type')
    return vt.id
  }
  const vt = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'payment' ORDER BY is_system DESC, id LIMIT 1").get() as { id: number } | undefined)
  if (!vt) throw new Error('No payment voucher type')
  return vt.id
}

function nextRunNo(db: DB): string {
  const row = db.prepare("SELECT MAX(CAST(substr(run_no, 4) AS INTEGER)) AS n FROM payment_runs WHERE run_no LIKE 'PR-%'").get() as { n: number | null }
  return `PR-${String((row.n ?? 0) + 1).padStart(4, '0')}`
}

/** The voucher's currency when it is not rupees, else null. */
function foreignCurrency(db: DB, voucherId: number): string | null {
  const r = db.prepare('SELECT currency_code AS c FROM vouchers WHERE id = ?').get(voucherId) as { c: string | null } | undefined
  return r?.c && r.c !== 'INR' ? r.c : null
}

/** TDS was deducted on the bill itself (a tds_entries row for this party on the bill's voucher). */
function deductedAtCredit(db: DB, voucherId: number, partyLedgerId: number): boolean {
  return !!db.prepare('SELECT 1 FROM tds_entries WHERE voucher_id = ? AND party_ledger_id = ?').get(voucherId, partyLedgerId)
}

interface PreparedLine extends PaymentRunLine {
  narration: string | null
  instrumentDate: string | null
}

function prepareRun(db: DB, input: ReturnType<typeof paymentRunSchema.parse>, runNo: string): { lines: PreparedLine[]; preview: PaymentRunPreview } {
  const ledgerRows = db.prepare('SELECT id, name, group_id AS groupId FROM ledgers').all() as { id: number; name: string; groupId: number }[]
  const byId = new Map(ledgerRows.map((l) => [l.id, l]))
  const cashBank = descendantIdsByName(db, ['Cash-in-Hand', 'Bank Accounts', 'Bank OD A/c'])
  const tdsOn = input.applyTds && getFeatures(db).tds
  const creditors = descendantIdsByName(db, ['Sundry Creditors'])
  const lines: PreparedLine[] = []
  const seen = new Set<number>()

  for (const item of input.items) {
    const party = byId.get(item.partyLedgerId)
    const bank = byId.get(item.bankLedgerId)
    const errors: string[] = []
    if (!party) errors.push('Supplier ledger not found')
    else if (!creditors.has(party.groupId)) errors.push(`${party.name} is not a supplier (Sundry Creditors)`)
    if (!bank) errors.push('Bank ledger not found')
    else if (!cashBank.has(bank.groupId)) errors.push(`${bank.name} is not a cash or bank ledger`)
    if (item.partyLedgerId === item.bankLedgerId) errors.push('The supplier and the bank are the same ledger')
    // One payment per supplier per run: TDS on payment is worked out from the books before the run,
    // so a second line for the same supplier would deduct again on the same bills.
    if (seen.has(item.partyLedgerId)) errors.push('This supplier is already in the run — one payment per supplier')
    seen.add(item.partyLedgerId)

    // Which bills this payment settles: the ones picked (bill-wise refs settle by NAME — so a name
    // two open bills share is ambiguous and refused), or, with none picked, the oldest open bills
    // first exactly as the Outstandings allocation will; anything beyond them is an advance.
    const open = openBills(db, item.partyLedgerId, input.date)
    const settled: { bill: OutstandingBill; amount: number }[] = []
    for (const b of item.bills) {
      const named = open.filter((o) => o.number === b.name)
      if (named.length === 0) errors.push(`Bill ${b.name} is not open on ${input.date}`)
      else if (named.length > 1) errors.push(`${named.length} open bills are named ${b.name} — settle them from voucher entry`)
      else if (b.amount > named[0]!.pending) errors.push(`Bill ${b.name}: paying ${plainRupees(b.amount)} but only ${plainRupees(named[0]!.pending)} is pending`)
      else settled.push({ bill: named[0]!, amount: b.amount })
    }
    if (new Set(item.bills.map((b) => b.name)).size !== item.bills.length) errors.push('A bill is picked twice')
    // Bills picked must account for the whole payment: a 'new' on-account ref would open a bill
    // (allocateBills treats every 'new' ref as one), so paying on account = picking no bills.
    const billsTotal = item.bills.reduce((s, b) => s + b.amount, 0)
    if (item.bills.length > 0 && billsTotal !== item.amount) {
      errors.push(`The bills picked add up to ${plainRupees(billsTotal)}, not ${plainRupees(item.amount)} — match them, or pick no bills to pay oldest first`)
    }
    if (item.bills.length === 0) {
      let left = item.amount
      for (const o of open) {
        if (left <= 0) break
        const take = Math.min(o.pending, left)
        settled.push({ bill: o, amount: take })
        left -= take
      }
    }
    const advance = Math.max(0, item.amount - settled.reduce((s, x) => s + x.amount, 0))

    // Foreign-currency bills are refused until WP 4.4's forex handling (a run posts in INR only).
    for (const x of settled) {
      const cur = x.bill.voucherId != null ? foreignCurrency(db, x.bill.voucherId) : null
      if (cur) errors.push(`Bill ${x.bill.number} is in ${cur} — pay it from voucher entry`)
    }

    let tds: PaymentRunLine['tds'] = null
    if (tdsOn && party) {
      // WP 3.2's rule on a payment: TDS is due at credit or payment, whichever is earlier — so
      // only the part settling bills NOT deducted when booked, plus any advance, is a TDS event.
      // An opening-balance bill (no voucher) is not one either.
      const candidate =
        settled
          .filter((x) => x.bill.voucherId != null && !deductedAtCredit(db, x.bill.voucherId, item.partyLedgerId))
          .reduce((s, x) => s + x.amount, 0) + advance
      const s = candidate > 0 ? tdsSuggestion(db, item.partyLedgerId, candidate, input.date, { voucherKind: 'payment' }) : null
      if (s && s.tdsPaise > 0 && s.thresholdCrossed && s.basePaise <= candidate) {
        tds = { sectionId: s.sectionId, code: s.code, base: s.basePaise, amount: s.tdsPaise }
        if (s.tdsPaise >= item.amount) errors.push('TDS would exceed the payment')
      }
    }
    lines.push({
      partyLedgerId: item.partyLedgerId,
      partyName: party?.name ?? '?',
      bankLedgerId: item.bankLedgerId,
      bankName: bank?.name ?? '?',
      amount: item.amount,
      tds,
      bankAmount: item.amount - (tds?.amount ?? 0),
      bills: item.bills,
      onAccount: 0,
      instrumentNo: item.instrumentNo,
      errors,
      narration:
        item.narration ??
        `Payment run ${runNo}${item.bills.length > 0 ? ` — bills ${item.bills.map((b) => b.name).join(', ')}` : ''}`.slice(0, 1000),
      instrumentDate: item.instrumentDate
    })
  }

  const cash = cashPosition(db, input.date)
  const banksUsed = [...new Set(lines.map((l) => l.bankLedgerId))]
  const banks = banksUsed.map((bid) => {
    const before = cash.ledgers.find((c) => c.ledgerId === bid)?.balance ?? 0
    const out = lines.filter((l) => l.bankLedgerId === bid).reduce((s, l) => s + l.bankAmount, 0)
    return { ledgerId: bid, name: byId.get(bid)?.name ?? '?', before, after: before - out }
  })
  const preview: PaymentRunPreview = {
    lines: lines.map(({ narration: _n, instrumentDate: _d, ...l }) => l),
    totals: {
      amount: lines.reduce((s, l) => s + l.amount, 0),
      tds: lines.reduce((s, l) => s + (l.tds?.amount ?? 0), 0),
      bank: lines.reduce((s, l) => s + l.bankAmount, 0),
      vouchers: lines.length
    },
    banks,
    ok: lines.every((l) => l.errors.length === 0)
  }
  return { lines, preview }
}

/** What a run would post — per supplier: TDS on payment, net bank, bill allocation, problems. */
export function previewPaymentRun(db: DB, raw: PaymentRunInput): PaymentRunPreview {
  const input = paymentRunSchema.parse(raw)
  return prepareRun(db, input, nextRunNo(db)).preview
}

/**
 * Post a payment run: one payment voucher per item (Dr supplier, Cr bank net of TDS, the TDS
 * payable credit appended by saveVoucher via tds.autoPayable; 'against' bill refs for the bills
 * picked, the rest 'new' on account), all-or-nothing in one transaction, under one run number.
 * Each voucher is audited by saveVoucher; the run itself gets a 'payment_run' audit row.
 */
export function createPaymentRun(db: DB, raw: PaymentRunInput): PaymentRun {
  const input = paymentRunSchema.parse(raw)
  const voucherTypeId = paymentVoucherTypeId(db, input.voucherTypeId)
  return db.transaction(() => {
    // Idempotency: the same submit twice (a double click, a retry after a slow reply) posts once.
    if (input.clientRunId) {
      const done = db.prepare('SELECT id FROM payment_runs WHERE client_run_id = ?').get(input.clientRunId) as { id: number } | undefined
      if (done) return getPaymentRun(db, done.id)!
    }
    const runNo = nextRunNo(db)
    const { lines, preview } = prepareRun(db, input, runNo)
    const problems = lines.flatMap((l) => l.errors.map((e) => `${l.partyName}: ${e}`))
    if (problems.length > 0) throw new Error(problems.join('; '))
    const runId = Number(
      db.prepare('INSERT INTO payment_runs (run_no, kind, date, note, client_run_id) VALUES (?, ?, ?, ?, ?)')
        .run(runNo, input.kind, input.date, input.note, input.clientRunId ?? null).lastInsertRowid
    )
    const link = db.prepare('INSERT INTO payment_run_vouchers (run_id, voucher_id, line_no) VALUES (?, ?, ?)')
    lines.forEach((l, i) => {
      const billRefs = l.bills.map((b) => ({ kind: 'against' as const, name: b.name, amount: b.amount, dueDate: null }))
      const saved = saveVoucher(db, {
        voucherTypeId,
        date: input.date,
        partyLedgerId: l.partyLedgerId,
        narration: l.narration,
        instrumentNo: l.instrumentNo,
        instrumentDate: l.instrumentNo ? (l.instrumentDate ?? input.date) : null,
        lines: [
          { ledgerId: l.partyLedgerId, drCr: 'dr', amount: l.amount, costAllocations: [] },
          { ledgerId: l.bankLedgerId, drCr: 'cr', amount: l.bankAmount, costAllocations: [] }
        ],
        billRefs,
        tds: l.tds ? { sectionId: l.tds.sectionId, baseAmount: l.tds.base, tdsAmount: l.tds.amount, isManual: false, autoPayable: true } : null
      })
      link.run(runId, saved.id, i + 1)
      l.voucherId = saved.id
      l.voucherNumber = saved.number
    })
    const run = getPaymentRun(db, runId)!
    writeAudit(db, 'payment_run', runId, 'create', null, {
      runNo, kind: input.kind, date: input.date, note: input.note, totals: preview.totals,
      vouchers: lines.map((l) => ({ voucherId: l.voucherId, number: l.voucherNumber, party: l.partyName, amount: l.amount, tds: l.tds?.amount ?? 0 }))
    })
    return run
  })()
}

interface RunRow { id: number; run_no: string; kind: 'plan' | 'batch'; date: string; created_at: string; note: string | null }

function runLines(db: DB, runId: number): PaymentRunLine[] {
  const rows = db
    .prepare(
      `SELECT v.id AS voucherId, v.number, v.party_ledger_id AS partyId, v.instrument_no AS instrumentNo
       FROM payment_run_vouchers prv JOIN vouchers v ON v.id = prv.voucher_id
       WHERE prv.run_id = ? AND ${NOT_DELETED} ORDER BY prv.line_no`
    )
    .all(runId) as { voucherId: number; number: string; partyId: number | null; instrumentNo: string | null }[]
  const names = new Map((db.prepare('SELECT id, name FROM ledgers').all() as { id: number; name: string }[]).map((l) => [l.id, l.name]))
  const cashBank = descendantIdsByName(db, ['Cash-in-Hand', 'Bank Accounts', 'Bank OD A/c'])
  const groupOf = new Map((db.prepare('SELECT id, group_id AS g FROM ledgers').all() as { id: number; g: number }[]).map((l) => [l.id, l.g]))
  return rows.map((r) => {
    const vl = db.prepare('SELECT ledger_id AS ledgerId, dr_cr AS drCr, amount FROM voucher_lines WHERE voucher_id = ? ORDER BY line_order').all(r.voucherId) as {
      ledgerId: number; drCr: 'dr' | 'cr'; amount: number
    }[]
    const refs = db.prepare("SELECT kind, name, amount FROM bill_refs WHERE voucher_id = ? ORDER BY id").all(r.voucherId) as { kind: string; name: string; amount: number }[]
    const tdsRow = db.prepare(
      `SELECT te.section_id AS sectionId, s.code, te.base_amount AS base, te.tds_amount AS amount
       FROM tds_entries te JOIN tds_sections s ON s.id = te.section_id WHERE te.voucher_id = ? LIMIT 1`
    ).get(r.voucherId) as { sectionId: number; code: string; base: number; amount: number } | undefined
    const partyId = r.partyId ?? vl.find((l) => l.drCr === 'dr')?.ledgerId ?? 0
    const bankLine = vl.find((l) => l.drCr === 'cr' && cashBank.has(groupOf.get(l.ledgerId) ?? -1))
    return {
      partyLedgerId: partyId,
      partyName: names.get(partyId) ?? '?',
      bankLedgerId: bankLine?.ledgerId ?? 0,
      bankName: bankLine ? (names.get(bankLine.ledgerId) ?? '?') : '?',
      amount: vl.filter((l) => l.ledgerId === partyId && l.drCr === 'dr').reduce((s, l) => s + l.amount, 0),
      tds: tdsRow ?? null,
      bankAmount: bankLine?.amount ?? 0,
      bills: refs.filter((x) => x.kind === 'against').map((x) => ({ name: x.name, amount: x.amount })),
      onAccount: 0,
      instrumentNo: r.instrumentNo,
      voucherId: r.voucherId,
      voucherNumber: r.number,
      errors: []
    }
  })
}

export function getPaymentRun(db: DB, id: number): PaymentRun | null {
  const r = db.prepare('SELECT * FROM payment_runs WHERE id = ?').get(id) as RunRow | undefined
  if (!r) return null
  const lines = runLines(db, id)
  return {
    id: r.id, runNo: r.run_no, kind: r.kind, date: r.date, createdAt: r.created_at, note: r.note,
    vouchers: lines.length, amount: lines.reduce((s, l) => s + l.amount, 0), lines
  }
}

export function listPaymentRuns(db: DB): PaymentRun[] {
  const ids = db.prepare('SELECT id FROM payment_runs ORDER BY id DESC LIMIT 200').all() as { id: number }[]
  return ids.map((r) => getPaymentRun(db, r.id)!).filter(Boolean)
}

/**
 * The run as a plain bank-payment CSV (one row per payment: beneficiary, amount, instrument).
 * HOOK for WP 4.1's bulk payment file export: bank-specific formats (NEFT/RTGS upload layouts)
 * belong there; until it lands this generic file is what the run offers.
 */
export function paymentRunCsv(db: DB, id: number): { csv: string; filename: string } {
  const run = getPaymentRun(db, id)
  if (!run) throw new Error('Payment run not found')
  const pans = new Map((db.prepare('SELECT id, pan FROM ledgers').all() as { id: number; pan: string | null }[]).map((l) => [l.id, l.pan]))
  const header = ['Run', 'Date', 'Voucher', 'Beneficiary', 'PAN', 'Debit bank', 'Amount paid', 'TDS', 'Settled', 'Cheque / UTR', 'Bills']
  const rows = run.lines.map((l) => [
    run.runNo, run.date, l.voucherNumber ?? '', l.partyName, pans.get(l.partyLedgerId) ?? '', l.bankName,
    plainRupees(l.bankAmount), plainRupees(l.tds?.amount ?? 0), plainRupees(l.amount), l.instrumentNo ?? '',
    l.bills.map((b) => b.name).join(' ')
  ])
  return { csv: rowsToCsv(header, rows), filename: `payment-run-${run.runNo}.csv` }
}

// ---------------------------------------------------------------------------------------------
// MSME report
// ---------------------------------------------------------------------------------------------

function coveredSuppliers(db: DB): SupplierRow[] {
  const creditorGroups = descendantIdsByName(db, ['Sundry Creditors'])
  const groupOf = new Map((db.prepare('SELECT id, group_id AS g FROM ledgers').all() as { id: number; g: number }[]).map((l) => [l.id, l.g]))
  return [...supplierFacts(db).values()].filter((s) => s.msme?.covered && creditorGroups.has(groupOf.get(s.id) ?? -1))
}

/** Bills of `ledgerId` open as on `date`, cached per (ledger, date). */
function billsCache(db: DB): (ledgerId: number, date: string) => OutstandingBill[] {
  const cache = new Map<string, OutstandingBill[]>()
  return (ledgerId, date) => {
    const k = `${ledgerId}|${date}`
    let v = cache.get(k)
    if (!v) {
      v = openBills(db, ledgerId, date)
      cache.set(k, v)
    }
    return v
  }
}

/** The share of a bill that is an expense for s.43B(h): the supplier's credit less the GST taken
 *  as input tax credit (tax-tagged debit lines on the bill), unless the supplier's ITC is blocked.
 *  Returns [numerator, denominator] for a pro-rata split of what is unpaid. */
function deductibleShare(db: DB, voucherId: number, partyLedgerId: number, itcBlocked: boolean): [number, number] {
  const rows = db
    .prepare(
      `SELECT vl.ledger_id AS ledgerId, vl.dr_cr AS drCr, vl.amount, l.tax_type AS taxType
       FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id WHERE vl.voucher_id = ?`
    )
    .all(voucherId) as { ledgerId: number; drCr: 'dr' | 'cr'; amount: number; taxType: string | null }[]
  const total = rows.filter((x) => x.ledgerId === partyLedgerId && x.drCr === 'cr').reduce((a, x) => a + x.amount, 0)
  const gst = itcBlocked ? 0 : rows.filter((x) => x.taxType && x.drCr === 'dr').reduce((a, x) => a + x.amount, 0)
  if (total <= 0) return [1, 1]
  return [Math.max(0, total - gst), total]
}

const share = (amount: number, [num, den]: [number, number]): number => (den === 0 ? amount : Math.round((amount * num) / den))

/**
 * s.43B(h) / 2025 Act s.37(2)(g) for a financial year — bill by bill (see disallowance43Bh). Only
 * bills BOOKED IN THE YEAR count (a bill from an earlier year, or an opening balance, was that
 * year's deduction — listed as carried, never added). Only the expense part counts: GST taken as
 * input tax credit is excluded pro rata. Bills accepted before the supplier's recorded
 * registration date are not covered.
 */
function disallowanceForFy(db: DB, suppliers: SupplierRow[], fyStartYear: number, today: string, bills: ReturnType<typeof billsCache>): MsmeReport['disallowance'] {
  const fy = fyFromStartYear(fyStartYear)
  const out: MsmeBill43Bh[] = []
  const carried = { bills: 0, amount: 0 }
  for (const s of suppliers) {
    for (const b of bills(s.id, fy.to)) {
      if (b.voucherId == null || b.date < fy.from) {
        carried.bills++
        carried.amount += b.pending
        continue
      }
      if (!coveredOn(s, b.date)) continue
      const s15 = s15Deadline(b.date, s.msme!.agreedCreditDays)
      let pendingAtPayBy: number | null = null
      if (s15.payBy > fy.to && s15.payBy < today) {
        const at = bills(s.id, s15.payBy).find((x) => billKey(s.id, x) === billKey(s.id, b))
        pendingAtPayBy = at?.pending ?? 0
      }
      const part = deductibleShare(db, b.voucherId, s.id, s.itcBlocked)
      const expensePending = share(b.pending, part)
      const res = disallowance43Bh(
        { pendingAtFyEnd: expensePending, payBy: s15.payBy, pendingAtPayBy: pendingAtPayBy == null ? null : share(pendingAtPayBy, part) },
        fy.to,
        today
      )
      out.push({
        key: billKey(s.id, b), ledgerId: s.id, partyName: s.name, voucherId: b.voucherId, number: b.number, date: b.date,
        payBy: s15.payBy, pendingAtFyEnd: b.pending, gstExcluded: b.pending - expensePending,
        status: res.status, disallowed: res.disallowed, atRisk: res.atRisk
      })
    }
  }
  return {
    fyStartYear, fyEnd: fy.to, bills: out, carriedFromEarlier: carried,
    disallowed: out.reduce((a, b) => a + b.disallowed, 0),
    atRisk: out.reduce((a, b) => a + b.atRisk, 0)
  }
}

export function msmeReport(
  db: DB,
  opts: { asOn: string; fyStartYear?: number; formPeriodDate?: string; today?: string }
): MsmeReport {
  const { asOn } = opts
  const today = opts.today ?? todayISO()
  const rates = listBankRates(db)
  const suppliers = coveredSuppliers(db)
  const bills = billsCache(db)
  const refs = new Map<number, string | null>()

  const rows: MsmeBillRow[] = []
  for (const s of suppliers) {
    const open = bills(s.id, asOn)
    for (const [k, v] of referencesFor(db, open.map((b) => b.voucherId))) refs.set(k, v)
    for (const b of open) {
      if (!coveredOn(s, b.date)) continue
      const s15 = s15Deadline(b.date, s.msme!.agreedCreditDays)
      const { bucket, daysLate } = msmeAgeBucket(s15.payBy, asOn)
      const i = s16Interest(b.pending, s15.interestFrom, asOn, rates)
      rows.push({
        key: billKey(s.id, b), ledgerId: s.id, partyName: s.name, category: s.msme!.category!, udyamNo: s.msme!.udyamNo, pan: s.pan,
        voucherId: b.voucherId, number: b.number, supplierRef: b.voucherId != null ? (refs.get(b.voucherId) ?? null) : null,
        date: b.date, amount: b.amount, pending: b.pending, s15, bucket, daysLate, ageDays: Math.max(0, daysBetween(b.date, asOn)),
        interest: { paise: i.interestPaise, rateBp: i.rateBp, months: i.months, days: i.days }
      })
    }
  }
  rows.sort((a, b) => b.daysLate - a.daysLate || a.partyName.localeCompare(b.partyName))
  const buckets = Object.fromEntries(MSME_AGE_BUCKETS.map((k) => [k, 0])) as Record<MsmeAgeBucket, number>
  for (const r of rows) buckets[r.bucket] += r.pending

  // MSME Form 1: the requested half-year, or the last one that has ended by asOn.
  const current = formMsme1Period(asOn)
  const period = opts.formPeriodDate ? formMsme1Period(opts.formPeriodDate) : asOn >= current.to ? current : previousFormMsme1Period(asOn)
  const formRows: MsmeFormRow[] = []
  for (const s of suppliers) {
    const open = bills(s.id, period.to)
    const formRefs = referencesFor(db, open.map((b) => b.voucherId))
    for (const b of open) {
      if (!coveredOn(s, b.date)) continue
      const days = daysBetween(b.date, period.to)
      if (days <= FORM_MSME1_DAYS) continue
      const s15 = s15Deadline(b.date, s.msme!.agreedCreditDays)
      formRows.push({
        ledgerId: s.id, partyName: s.name, pan: s.pan, udyamNo: s.msme!.udyamNo, category: s.msme!.category!,
        voucherId: b.voucherId, number: b.number, supplierRef: b.voucherId != null ? (formRefs.get(b.voucherId) ?? null) : null,
        date: b.date, amount: b.amount, pending: b.pending, dueFrom: s15.interestFrom, days
      })
    }
  }
  formRows.sort((a, b) => a.partyName.localeCompare(b.partyName) || a.date.localeCompare(b.date))
  const formSuppliers = suppliers.map((s) => form1Supplier(db, s, period.from, period.to, bills)).filter(
    (f) => f.paidWithin45.amount + f.paidAfter45.amount + f.debitNotes.amount + f.outstandingUpTo45 + f.outstandingOver45 > 0
  )

  const gaps: MsmeReport['gaps'] = []
  for (const s of supplierFacts(db).values()) {
    if (!s.msme) continue
    if (!s.msme.category) gaps.push({ ledgerId: s.id, name: s.name, issue: 'Marked MSME but no category (micro / small / medium)' })
    if (!s.msme.udyamNo) gaps.push({ ledgerId: s.id, name: s.name, issue: 'No Udyam registration number' })
    else if (!isValidUdyam(s.msme.udyamNo)) gaps.push({ ledgerId: s.id, name: s.name, issue: `Udyam number ${s.msme.udyamNo} is not UDYAM-XX-00-0000000` })
    if (s.msme.covered && !s.pan) gaps.push({ ledgerId: s.id, name: s.name, issue: 'No PAN (MSME Form 1 asks for the supplier PAN)' })
  }

  const bankRate = bankRateOn(rates, asOn)
  return {
    asOn, rows, buckets,
    totalPending: rows.reduce((s, r) => s + r.pending, 0),
    totalInterest: rows.reduce((s, r) => s + r.interest.paise, 0),
    bankRate,
    s16RateBp: bankRate ? bankRate.rateBp * S16_BANK_RATE_MULTIPLE : null,
    disallowance: disallowanceForFy(db, suppliers, opts.fyStartYear ?? fyOf(asOn).startYear, today, bills),
    form1: {
      period, rows: formRows, total: formRows.reduce((s, r) => s + r.pending, 0), suppliers: formSuppliers,
      mustFile: formSuppliers.some((f) => f.outstandingOver45 > 0)
    },
    gaps
  }
}

/**
 * One supplier's line of the revised MSME Form 1 for a half-year: settlements in the half-year
 * split by whether they came within 45 days of acceptance (the bill date), and what is
 * outstanding at its end, up to / over 45 days old. Settlements come from replaying the
 * Outstandings allocation event by event (settlementTimeline), so a bill and its payment on the
 * same day are both seen; settlements by debit note are counted apart (they are not payments);
 * a bill paid partly in time and partly late counts once, in "after 45 days" (its amounts split).
 */
function form1Supplier(
  db: DB, s: SupplierRow, from: string, to: string, bills: ReturnType<typeof billsCache>
): MsmeForm1Supplier {
  const out: MsmeForm1Supplier = {
    ledgerId: s.id, partyName: s.name, pan: s.pan, udyamNo: s.msme?.udyamNo ?? null,
    paidWithin45: { count: 0, amount: 0 }, paidAfter45: { count: 0, amount: 0 }, debitNotes: { count: 0, amount: 0 },
    outstandingUpTo45: 0, outstandingOver45: 0
  }
  const { events, creditDays } = partyBillEvents(db, s.id, to)
  const timeline = settlementTimeline(events, to, creditDays, from).filter((x) => x.date >= from && x.date <= to && coveredOn(s, x.billDate))
  const kinds = new Map<number, string>()
  const ids = [...new Set(timeline.map((x) => x.byVoucherId).filter((v): v is number => v != null))]
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    for (const row of db
      .prepare(`SELECT v.id, vt.kind FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id WHERE v.id IN (${chunk.map(() => '?').join(',')})`)
      .all(...chunk) as { id: number; kind: string }[]) kinds.set(row.id, row.kind)
  }
  const late = new Set<string>()
  const paid = new Set<string>()
  const dn = new Set<string>()
  for (const x of timeline) {
    if (x.byVoucherId != null && kinds.get(x.byVoucherId) === 'debit_note') {
      out.debitNotes.amount += x.amount
      dn.add(x.billKey)
      continue
    }
    paid.add(x.billKey)
    if (daysBetween(x.billDate, x.date) > FORM_MSME1_DAYS) {
      out.paidAfter45.amount += x.amount
      late.add(x.billKey)
    } else out.paidWithin45.amount += x.amount
  }
  out.paidAfter45.count = late.size
  out.paidWithin45.count = [...paid].filter((k) => !late.has(k)).length
  out.debitNotes.count = dn.size
  for (const b of bills(s.id, to)) {
    if (!coveredOn(s, b.date)) continue
    if (daysBetween(b.date, to) > FORM_MSME1_DAYS) out.outstandingOver45 += b.pending
    else out.outstandingUpTo45 += b.pending
  }
  return out
}

/** MSME Form 1 data as CSV (supplier details + amounts outstanding > 45 days at the half-year end). */
export function msmeForm1Csv(db: DB, opts: { asOn: string; formPeriodDate?: string }): { csv: string; filename: string; rows: number } {
  const r = msmeReport(db, opts)
  // Part 1 — the revised form's per-supplier columns (S.O. 2751(E), 15 Jul 2024).
  const formHeader = [
    'Half-year', 'Name of MSE supplier', 'PAN', 'Paid within 45 days — no.', 'Paid within 45 days — amount',
    'Paid after 45 days — no.', 'Paid after 45 days — amount', 'Outstanding up to 45 days', 'Outstanding more than 45 days', 'Reason for delay'
  ]
  const formRows = r.form1.suppliers.map((f) => [
    r.form1.period.label, f.partyName, f.pan ?? '', String(f.paidWithin45.count), plainRupees(f.paidWithin45.amount),
    String(f.paidAfter45.count), plainRupees(f.paidAfter45.amount), plainRupees(f.outstandingUpTo45), plainRupees(f.outstandingOver45), ''
  ])
  // Part 2 — the bills behind "outstanding more than 45 days" (working detail; not a form column).
  const header = [
    'Half-year', 'Supplier', 'PAN', 'Udyam registration no.', 'Category', 'Invoice no.', 'Our voucher', 'Date of acceptance',
    'Invoice amount', 'Amount due', 'Date from which due', 'Days outstanding', 'Reason for delay'
  ]
  const rows = r.form1.rows.map((x) => [
    r.form1.period.label, x.partyName, x.pan ?? '', x.udyamNo ?? '', x.category, x.supplierRef ?? x.number, x.number, x.date,
    plainRupees(x.amount), plainRupees(x.pending), x.dueFrom, String(x.days), ''
  ])
  const csv = `${rowsToCsv(formHeader, formRows)}\r\n${rowsToCsv(header, rows).replace(/^\uFEFF/, '')}`
  return { csv, filename: `msme-form-1-${r.form1.period.from}-${r.form1.period.to}.csv`, rows: formRows.length }
}

/** Year-end close warning: micro / small dues booked in the year and unpaid past the s.15 period
 *  on its last day — the same bills and the same boundary (payBy ≤ year end) as the s.43B(h)
 *  figure, so the warning and the report always agree. */
export function msmeYearEndWarning(db: DB, fyStartYear: number, today: string = todayISO()): MsmeYearEndWarning {
  const fy = fyFromStartYear(fyStartYear)
  const d = disallowanceForFy(db, coveredSuppliers(db), fyStartYear, today, billsCache(db))
  const late = d.bills.filter((b) => b.payBy <= fy.to)
  return {
    asOn: fy.to,
    overdue: late.reduce((a, b) => a + b.pendingAtFyEnd, 0),
    bills: late.length,
    parties: new Set(late.map((b) => b.ledgerId)).size,
    disallowed: d.disallowed
  }
}

// ---------------------------------------------------------------------------------------------
// Supplier statement and reconciliation
// ---------------------------------------------------------------------------------------------

/** Our ledger of the supplier for a period, in the supplier's terms (positive balance = we owe). */
export function supplierStatement(db: DB, ledgerId: number, from: string, to: string): SupplierStatement {
  const st = ledgerStatement(db, ledgerId, from, to)
  const refs = referencesFor(db, st.rows.map((r) => r.voucherId))
  return {
    ledgerId, name: st.ledgerName, from, to,
    opening: -st.opening,
    closing: -st.closing,
    rows: st.rows.map((r) => ({
      voucherId: r.voucherId, date: r.date, voucherType: r.voucherType, number: r.number,
      supplierRef: refs.get(r.voucherId) ?? null, particulars: r.particulars, narration: r.narration,
      debit: r.debit, credit: r.credit, balance: -r.running
    }))
  }
}

/** Match a supplier's ledger CSV against ours for the period (nothing is written). */
export function supplierRecon(
  db: DB,
  opts: { ledgerId: number; from: string; to: string; csvText: string; amountPaise: number; dateDays: number }
): SupplierReconResult {
  const st = supplierStatement(db, opts.ledgerId, opts.from, opts.to)
  const parsed = parseSupplierStatementCsv(opts.csvText)
  const book: BookLedgerLine[] = st.rows.map((r) => ({
    voucherId: r.voucherId, date: r.date, number: r.number, supplierRef: r.supplierRef, voucherType: r.voucherType, debit: r.debit, credit: r.credit
  }))
  const res = reconcileSupplier(parsed.lines, book, { amountPaise: opts.amountPaise, dateDays: opts.dateDays })
  return {
    ledgerId: opts.ledgerId, name: st.name, from: opts.from, to: opts.to,
    pairs: res.pairs, counts: res.counts,
    supplierBalance: res.supplierBalance, bookBalance: res.bookBalance, difference: res.bookBalance - res.supplierBalance,
    skipped: parsed.skipped, parseError: parsed.error
  }
}
