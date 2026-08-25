/**
 * Schedule III presentation (roadmap #363) and the Form 3CD data pack (roadmap #362).
 *
 * Both are VIEWS over statements that already exist. Neither computes a figure of its own — every
 * rupee here comes from `balanceSheet`, `profitAndLoss`, the asset register, the MSME exposure and
 * the TDS entries, which is what makes it safe to present them as the accounts rather than as a
 * report about the accounts.
 *
 * The statutory reasoning is in src/shared/scheduleIII.ts and src/shared/form3cd.ts. Read those
 * first — in particular the parts about which mappings are judgements rather than facts.
 */

import { writeFileSync } from 'fs'
import { join } from 'path'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import {
  scheduleIIIBalanceSheet,
  scheduleIIIProfitAndLoss,
  type ScheduleIIIBalanceSheet,
  type ScheduleIIIProfitAndLoss
} from '@shared/scheduleIII'
import { CLAUSES, CASH_PAYMENT_LIMIT, LOAN_CASH_LIMIT, extract, limitOn, type ClauseExtract, type Form3cdPack } from '@shared/form3cd'
import { coveredBy43B } from '@shared/msme'
import { fyFromStartYear } from '@shared/dates'
import { formatPaise, plainRupees } from '@shared/money'
import { rowsToCsv } from '@shared/csv'
import { balanceSheet, profitAndLoss, ratios } from './reports'
import { msmeExposure } from './receivables'
import { relatedPartyReport } from './disclosure'
import { tdsSummary } from './tds'
import { depreciationSchedule } from './assets'
import { descendantIdsByName } from './masters'
import { IN_BOOKS } from './vouchers'
import { companyExportsDir } from '../paths'

/**
 * Ledger ids under a set of primary groups.
 *
 * `descendantIdsByName` answers with GROUPS, which is what a report tree needs and NOT what a
 * `voucher_lines.ledger_id IN (...)` needs. Getting that wrong is silent — the query runs, the
 * ids do not match any ledger, and the clause reports nothing at all, which reads exactly like
 * compliance.
 */
function ledgerIdsUnder(db: DB, groupNames: string[]): number[] {
  const groups = descendantIdsByName(db, groupNames)
  if (groups.size === 0) return []
  const placeholders = [...groups].map(() => '?').join(',')
  return (db.prepare(`SELECT id FROM ledgers WHERE group_id IN (${placeholders})`).all(...groups) as { id: number }[]).map(
    (r) => r.id
  )
}

// ---------- Schedule III (roadmap #363) ----------

export interface ScheduleIIIStatements {
  balanceSheet: ScheduleIIIBalanceSheet
  profitAndLoss: ScheduleIIIProfitAndLoss
}

/**
 * The Schedule III face of both statements for a period.
 *
 * The MSME trade-payables split comes from the same classification section 43B(h) uses. It is
 * passed as null when nobody has classified a supplier, because the face has to distinguish "we
 * owe nothing to a micro enterprise" from "we have never asked".
 */
export function scheduleIII(db: DB, booksFrom: string, asOn: string): ScheduleIIIStatements {
  const bs = balanceSheet(db, booksFrom, asOn)
  const pnl = profitAndLoss(db, booksFrom, asOn)

  const anyClassified =
    (db.prepare("SELECT COUNT(*) AS n FROM ledgers WHERE msme_status IS NOT NULL AND msme_status <> 'not_registered'").get() as { n: number })
      .n > 0

  let msmeTradePayables: number | null = null
  if (anyClassified) {
    // Only micro and small are inside the disclosure — the same boundary section 43B(h) draws,
    // and the reason `coveredBy43B` exists rather than a string comparison here.
    const report = msmeExposure(db, asOn)
    msmeTradePayables = report.parties
      .filter((p) => coveredBy43B(p.status))
      .reduce((sum, p) => sum + p.pending, 0)
  }

  return {
    balanceSheet: scheduleIIIBalanceSheet(bs, { msmeTradePayables, profitForPeriod: bs.profitCurrentPeriod }),
    profitAndLoss: scheduleIIIProfitAndLoss(pnl)
  }
}

// ---------- Form 3CD (roadmap #362) ----------

/**
 * Clause 21(d): cash payments above the section 40A(3) limit.
 *
 * "Otherwise than by an account-payee cheque or draft or electronic mode" is not something the
 * books record — a payment voucher against a bank ledger could be any of those. So this lists
 * payments through CASH ledgers only, which is the subset the books can actually identify, and
 * says on the extract that a bank payment by bearer cheque would not appear. Listing every bank
 * payment as suspect would be useless; listing none of the cash ones would be wrong.
 *
 * The limit is per person per day, so payments are grouped by (party, date) before comparison —
 * three ₹4,000 payments to one contractor on one day are one ₹12,000 breach, and testing each
 * payment on its own is the mistake that reports nothing.
 */
function clause21d(db: DB, from: string, to: string): ClauseExtract {
  const cashIds = ledgerIdsUnder(db, ['Cash-in-Hand'])
  if (cashIds.length === 0) {
    return extract('21(d)', ['Date', 'Party', 'Amount'], [], { caveats: ['No cash ledgers in these books.'] })
  }
  const placeholders = cashIds.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT v.date AS date, COALESCE(p.name, 'Unnamed') AS party, SUM(vl.amount) AS amount
       FROM voucher_lines vl
       JOIN vouchers v ON v.id = vl.voucher_id
       LEFT JOIN ledgers p ON p.id = v.party_ledger_id
       WHERE vl.ledger_id IN (${placeholders}) AND vl.dr_cr = 'cr'
         AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       GROUP BY v.date, v.party_ledger_id
       ORDER BY v.date`
    )
    .all(...cashIds, from, to) as { date: string; party: string; amount: number }[]

  const breaches = rows.filter((r) => r.amount > limitOn(CASH_PAYMENT_LIMIT, r.date).limit)
  return extract(
    '21(d)',
    ['Date', 'Party', 'Cash paid', 'Limit'],
    breaches.map((r) => ({
      cells: [r.date, r.party, formatPaise(r.amount), formatPaise(limitOn(CASH_PAYMENT_LIMIT, r.date).limit)]
    })),
    {
      total: ['', 'Total', formatPaise(breaches.reduce((s, r) => s + r.amount, 0)), ''],
      caveats: [
        'Cash ledgers only. A bank payment made by bearer cheque is also within section 40A(3) and the books cannot tell one from an account-payee cheque.',
        'Grouped by party and day, which is how the limit is written. Payments to a party with no ledger of its own are grouped as "Unnamed".',
        `The limit applied is the one in force on each payment's own date: ${limitOn(CASH_PAYMENT_LIMIT, to).note}`
      ]
    }
  )
}

/** Clause 22: interest under section 23 of the MSMED Act — computed by the 43B(h) machinery. */
function clause22(db: DB, to: string): ClauseExtract {
  const report = msmeExposure(db, to)
  const rows = report.parties.filter((p) => coveredBy43B(p.status) && p.interest > 0)
  return extract(
    '22',
    ['Supplier', 'Status', 'Beyond the limit', 'Interest'],
    rows.map((p) => ({ cells: [p.name, p.status, formatPaise(p.disallowed), formatPaise(p.interest)] })),
    {
      total: ['', '', 'Total', formatPaise(rows.reduce((sum, p) => sum + p.interest, 0))],
      caveats: [
        'Interest under section 16 of the MSMED Act is three times the RBI bank rate, compounded monthly. The bank rate used is the one set in Settings; check it against the rate in force.',
        'Only micro and small enterprises are covered. A supplier nobody has classified is not the same as one outside the Act, and is excluded from this figure.'
      ]
    }
  )
}

/** Clause 23: payments to related persons — from the flag the disclosure report already uses. */
function clause23(db: DB, from: string, to: string): ClauseExtract {
  const report = relatedPartyReport(db, from, to)
  return extract(
    '23',
    ['Party', 'Relationship', 'Paid / debited', 'Received / credited'],
    report.rows.map((r) => ({
      cells: [r.name, r.relationship ?? '—', formatPaise(r.debits), formatPaise(r.credits)]
    })),
    {
      total: ['', 'Total', formatPaise(report.totalDebits), formatPaise(report.totalCredits)],
      caveats: [
        'Lists every party flagged as related. Section 40A(2)(b) is a wider definition than the flag — a relative of a director whose ledger nobody flagged will not appear here.',
        'Nothing here is an opinion on whether a payment was excessive, which is the question the clause exists to let the officer ask.'
      ]
    }
  )
}

/**
 * Clauses 31(a) and 31(c): loans and deposits taken or repaid in cash.
 *
 * Same shape as 21(d) and the same honest limit: identified from cash ledgers moving against a
 * loan group, which is what the books can see.
 */
function clause31(db: DB, from: string, to: string, kind: 'accepted' | 'repaid'): ClauseExtract {
  const cashIds = ledgerIdsUnder(db, ['Cash-in-Hand'])
  const loanIds = ledgerIdsUnder(db, ['Loans (Liability)', 'Loans & Advances (Asset)'])
  const clause = kind === 'accepted' ? '31(a)' : '31(c)'
  if (cashIds.length === 0 || loanIds.length === 0) {
    return extract(clause, ['Date', 'Party', 'Amount'], [], { caveats: ['No cash or loan ledgers in these books.'] })
  }
  const cashPh = cashIds.map(() => '?').join(',')
  const loanPh = loanIds.map(() => '?').join(',')
  // Accepted: cash comes in (dr cash) against a loan credit. Repaid: cash goes out (cr cash).
  const cashSide = kind === 'accepted' ? 'dr' : 'cr'
  const rows = db
    .prepare(
      `SELECT v.date AS date, l.name AS party, SUM(cash.amount) AS amount
       FROM voucher_lines cash
       JOIN vouchers v ON v.id = cash.voucher_id
       JOIN voucher_lines other ON other.voucher_id = v.id AND other.id <> cash.id
       JOIN ledgers l ON l.id = other.ledger_id
       WHERE cash.ledger_id IN (${cashPh}) AND cash.dr_cr = ?
         AND other.ledger_id IN (${loanPh})
         AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       GROUP BY v.id
       ORDER BY v.date`
    )
    .all(...cashIds, cashSide, ...loanIds, from, to) as { date: string; party: string; amount: number }[]

  const breaches = rows.filter((r) => r.amount >= limitOn(LOAN_CASH_LIMIT, r.date).limit)
  return extract(
    clause,
    ['Date', 'Party', 'Amount'],
    breaches.map((r) => ({ cells: [r.date, r.party, formatPaise(r.amount)] })),
    {
      total: ['', 'Total', formatPaise(breaches.reduce((s, r) => s + r.amount, 0))],
      caveats: [
        `${limitOn(LOAN_CASH_LIMIT, to).note} The limit is on the aggregate with one person, which the books cannot compute across ledgers with different names for the same person.`,
        'Cash ledgers only — a bank transaction is outside the section unless it was by bearer cheque, which the books do not record.'
      ]
    }
  )
}

/**
 * Clause 26: sums referred to in section 43B.
 *
 * The part these books can genuinely answer is clause (h) — sums payable to a micro or small
 * enterprise beyond the section 15 limit, which are disallowed in the year they were incurred and
 * allowed only in the year they are paid. That is the same machinery roadmap #351 built, run as
 * at the year end, which is when the disallowance crystallises.
 *
 * The statutory-dues half of clause 26 (tax, duty, cess, provident fund, bonus, leave encashment)
 * is NOT derived: it needs a view on which ledger balances are statutory dues and when each was
 * paid, and a guess at that would either invent a disallowance or hide one.
 */
function clause26(db: DB, to: string): ClauseExtract {
  const report = msmeExposure(db, to)
  const rows = report.parties.filter((p) => coveredBy43B(p.status) && p.disallowed > 0)
  return extract(
    '26',
    ['Supplier', 'Status', 'Outstanding', 'Beyond the limit — disallowed'],
    rows.map((p) => ({ cells: [p.name, p.status, formatPaise(p.pending), formatPaise(p.disallowed)] })),
    {
      total: ['', '', formatPaise(report.totalPending), formatPaise(report.totalDisallowed)],
      caveats: [
        'Clause 43B(h) only. The statutory-dues limbs of clause 26 — tax, duty, cess, provident fund, bonus, leave encashment — are not derived from these books.',
        report.unclassifiedParties > 0
          ? `${report.unclassifiedParties} supplier(s) owed ${formatPaise(report.unclassifiedPending)} have no MSME status recorded. An unclassified supplier is not a supplier outside 43B(h); they are excluded from the figure above.`
          : 'Every supplier with a balance has an MSME status on record.',
        `Measured as at ${to}, which is when the disallowance crystallises.`
      ]
    }
  )
}

/**
 * Clause 44: total expenditure split by whether the supplier is registered under GST.
 *
 * Read from the PARTY's GSTIN, which is the only registration fact the books hold. Two honest
 * limits, both stated on the extract: expenditure with no party ledger at all (a direct cash
 * expense booked without a supplier) cannot be attributed either way, and the clause's further
 * split of the registered figure — into exempt supplies, composition suppliers and others —
 * needs facts about the supplier's registration type that a GSTIN alone does not carry.
 */
function clause44(db: DB, from: string, to: string): ClauseExtract {
  const expenseIds = ledgerIdsUnder(db, ['Purchase Accounts', 'Direct Expenses', 'Indirect Expenses'])
  if (expenseIds.length === 0) {
    return extract('44', ['Category', 'Amount'], [], { caveats: ['No expense ledgers in these books.'] })
  }
  const placeholders = expenseIds.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT CASE
                WHEN v.party_ledger_id IS NULL THEN 'none'
                WHEN p.gstin IS NOT NULL AND p.gstin <> '' THEN 'registered'
                ELSE 'unregistered'
              END AS bucket,
              SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END) AS amount
       FROM voucher_lines vl
       JOIN vouchers v ON v.id = vl.voucher_id
       LEFT JOIN ledgers p ON p.id = v.party_ledger_id
       WHERE vl.ledger_id IN (${placeholders}) AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       GROUP BY bucket`
    )
    .all(...expenseIds, from, to) as { bucket: 'registered' | 'unregistered' | 'none'; amount: number }[]

  const of = (bucket: string): number => rows.find((r) => r.bucket === bucket)?.amount ?? 0
  const total = rows.reduce((sum, r) => sum + r.amount, 0)
  if (total === 0) {
    return extract('44', ['Category', 'Amount'], [], { caveats: ['No expenditure in the year.'] })
  }

  return extract(
    '44',
    ['Category', 'Amount'],
    [
      { cells: ['Expenditure with entities registered under GST', formatPaise(of('registered'))] },
      { cells: ['Expenditure with entities not registered under GST', formatPaise(of('unregistered'))] },
      { cells: ['Expenditure with no supplier recorded', formatPaise(of('none'))] }
    ],
    {
      total: ['Total expenditure', formatPaise(total)],
      caveats: [
        'Split on whether the party ledger carries a GSTIN, which is the only registration fact these books hold.',
        'Expenditure booked without a party — a direct cash expense — cannot be attributed either way and is shown on its own line rather than folded into "not registered".',
        'The clause splits the registered figure further, into exempt supplies, supplies from composition dealers and others. That needs facts about each supplier’s registration type which a GSTIN alone does not carry.'
      ]
    }
  )
}

/** Clause 34(a): what was deducted, section by section and quarter by quarter. */
function clause34a(db: DB, fyStartYear: number): ClauseExtract {
  const rows = tdsSummary(db, fyStartYear)
  return extract(
    '34(a)',
    ['Section', 'Quarter', 'Deductees', 'Amount paid', 'Tax deducted'],
    rows.map((r) => ({ cells: [r.sectionCode, r.quarter, String(r.deductees), formatPaise(r.base), formatPaise(r.tds)] })),
    {
      total: ['', '', '', formatPaise(rows.reduce((s, r) => s + r.base, 0)), formatPaise(rows.reduce((s, r) => s + r.tds, 0))],
      caveats: [
        'This is what WAS deducted. The clause also asks what was LIABLE to deduction, which requires a view on every payment in the books and is the auditor’s to form.',
        'Tax actually deposited comes from the challans recorded on the TDS screen; a deduction with no challan against it is the shortfall the clause asks about.'
      ]
    }
  )
}

/** Clause 18: the income-tax depreciation schedule, block by block. */
function clause18(db: DB, fyStartYear: number): ClauseExtract {
  const schedule = depreciationSchedule(db, fyStartYear)
  return extract(
    '18',
    ['Block', 'Rate', 'Opening WDV', 'Additions (full rate)', 'Additions (half rate)', 'Deletions', 'Depreciation', 'Closing WDV'],
    schedule.incomeTax.map((b) => ({
      cells: [
        b.blockName,
        `${b.rate}%`,
        formatPaise(b.openingWdv),
        formatPaise(b.additionsFullRate),
        formatPaise(b.additionsHalfRate),
        formatPaise(b.deletions),
        formatPaise(b.depreciation),
        formatPaise(b.closingWdv)
      ]
    })),
    {
      total: ['Total', '', '', '', '', '', formatPaise(schedule.incomeTaxTotal), ''],
      caveats: [
        'Block-wise, which is how section 32 works and how clause 18 is presented.',
        'Half rate on additions put to use for under 180 days, per the second proviso to section 32(1). An asset with no put-to-use date is treated as used from its purchase date.',
        schedule.unblocked > 0
          ? `${schedule.unblocked} asset(s) have no block assigned and are absent from this schedule entirely.`
          : 'Every asset in the register is assigned to a block.'
      ]
    }
  )
}

/** Clause 40: the accounting ratios, from the report that already computes them. */
function clause40(db: DB, from: string, to: string): ClauseExtract {
  const r = ratios(db, from, to)
  const pct = (n: number | null): string => (n === null ? '—' : `${n.toFixed(2)}%`)
  // Stock to turnover is not on the ratio panel — it is one division of two figures the panel
  // already carries as inputs, and computing it here keeps the panel from growing a field only
  // this clause uses.
  const stockPct = r.inputs.sales === 0 ? null : (r.inputs.stock / r.inputs.sales) * 100
  return extract(
    '40',
    ['Ratio', 'This year'],
    [
      { cells: ['Gross profit to turnover', pct(r.ratios.grossMarginPct)] },
      { cells: ['Net profit to turnover', pct(r.ratios.netMarginPct)] },
      { cells: ['Stock-in-trade to turnover', pct(stockPct)] }
    ],
    {
      caveats: [
        'Clause 40 asks for the preceding year alongside. Where the books do not go back that far the column is absent rather than zero.',
        'Material consumed to finished goods produced is not derived: it needs a manufacturing account these books do not keep separately.'
      ]
    }
  )
}

/**
 * The pack.
 *
 * Clauses that produce nothing are listed in `empty` with the reason, because a blank page is not
 * an answer — "no cash payment breached the limit" and "we could not look" are different findings
 * and the auditor needs to know which one they are holding.
 */
export function form3cdPack(db: DB, fyStartYear: number): Form3cdPack {
  const fy = fyFromStartYear(fyStartYear)
  const from = fy.from
  const to = fy.to

  const candidates: ClauseExtract[] = [
    clause18(db, fyStartYear),
    clause21d(db, from, to),
    clause22(db, to),
    clause23(db, from, to),
    clause26(db, to),
    clause31(db, from, to, 'accepted'),
    clause31(db, from, to, 'repaid'),
    clause34a(db, fyStartYear),
    clause40(db, from, to),
    clause44(db, from, to)
  ]

  const extracts = candidates.filter((e) => e.rows.length > 0)
  const empty = candidates
    .filter((e) => e.rows.length === 0)
    .map((e) => ({
      clause: e.clause,
      title: e.title,
      reason: e.caveats[0] ?? 'Nothing in the books falls under this clause for the year.'
    }))

  // Clauses in the catalogue that this build does not extract at all are said out loud too, so
  // the pack cannot be mistaken for a complete Form 3CD.
  const covered = new Set(candidates.map((e) => e.clause))
  for (const spec of CLAUSES) {
    if (covered.has(spec.clause)) continue
    empty.push({
      clause: spec.clause,
      title: spec.title,
      reason: `Not extracted. ${spec.asks}`
    })
  }

  return { fyStartYear, fyLabel: fy.label, from, to, extracts, empty: empty.sort((a, b) => a.clause.localeCompare(b.clause)) }
}

/** The pack as one CSV per clause, in a single file with clause headings. */
export function exportForm3cdCsv(db: DB, _company: CompanyInfo, slug: string, fyStartYear: number): string {
  const pack = form3cdPack(db, fyStartYear)
  const chunks: string[] = []
  for (const e of pack.extracts) {
    chunks.push(`"Clause ${e.clause} — ${e.title}"`)
    chunks.push(`"${e.authority.replace(/"/g, '""')}"`)
    chunks.push(rowsToCsv(e.columns, e.rows.map((r) => r.cells)).trimEnd())
    if (e.total) chunks.push(rowsToCsv([], [e.total]).trimEnd())
    for (const c of e.caveats) chunks.push(`"Note: ${c.replace(/"/g, '""')}"`)
    chunks.push('')
  }
  if (pack.empty.length > 0) {
    chunks.push('"Clauses with nothing to report, and why"')
    chunks.push(rowsToCsv(['Clause', 'Title', 'Reason'], pack.empty.map((e) => [e.clause, e.title, e.reason])).trimEnd())
  }
  const path = join(companyExportsDir(slug), `form-3cd-${pack.fyLabel}.csv`)
  writeFileSync(path, chunks.join('\n'))
  return path
}

/** Schedule III as a CSV of both faces, for a preparer working in a spreadsheet. */
export function exportScheduleIIICsv(db: DB, _company: CompanyInfo, slug: string, booksFrom: string, asOn: string): string {
  const s = scheduleIII(db, booksFrom, asOn)
  const face = (title: string, lines: { label: string; amount: number; level: number }[]): string[] => [
    `"${title}"`,
    rowsToCsv(['Line', 'Amount'], lines.map((l) => [`${'  '.repeat(l.level)}${l.label}`, plainRupees(l.amount)])).trimEnd(),
    ''
  ]
  const chunks = [
    ...face('Balance Sheet — Equity and Liabilities', s.balanceSheet.equityAndLiabilities),
    ...face('Balance Sheet — Assets', s.balanceSheet.assets),
    ...face('Statement of Profit and Loss', s.profitAndLoss.lines)
  ]
  const path = join(companyExportsDir(slug), `schedule-iii-${asOn}.csv`)
  writeFileSync(path, chunks.join('\n'))
  return path
}
