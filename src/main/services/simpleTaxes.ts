// The simple Taxes screen (WP 9.9, plan 2026-10-13 §2.2 Taxes, §3 "GST answer"). `simple:taxes`
// is read-only (one read transaction, nothing stored) over the services the accountant screens
// use — never a second computation (simpleTaxes.dbtest.ts pins each figure):
//   the three figures  dashboard.gst3bFigures → gst.gstr3b() (what the Gateway / Home GST row
//                      sums); the default period is dashGst's (the return the next GSTR-3B files —
//                      a quarterly filer's quarter, the Home tile's rule)
//   awaiting in 2B     simpleHome.gstCredit (the stored GSTR-2B statements, WP 3.4 matcher)
//   due dates          shared/gst/filing.ts (rule 61 / 62 CGST Rules, Notification 83/2020-CT)
//   step 1             assistants.closeChecklist per month of the period (MISSING_BILL_CHECKS)
//   step 2             assistants.gst2bMismatches per month (unresolved rows by category)
//   step 3             the export snapshots gst:exportGstr1 / gst:exportGstr3b write (meta
//                      `gst.exported.<form>.<MMYYYY>`); the exports themselves are unchanged
//   step 5             meta `gstFiled` (shared/simple/taxes.ts says why not assistant_marks);
//                      `simple:taxes:filed` writes it, audited as a company update
//   TDS / TCS          assistants.withholdingFacts + closeChecklist.withholdingUnpaid (FIFO)
import { copyFileSync, mkdirSync } from 'fs'
import { basename, join } from 'path'
import type { DB } from '../db/connection'
import { companyExportsDir } from '../paths'
import type { CompanyInfo } from '@shared/domain'
import { AppError } from '@shared/errors'
import { gstPeriodOf, todayISO } from '@shared/dates'
import { monthRange } from '@shared/dashboard'
import { withholdingUnpaid } from '@shared/closeChecklist'
import { depositDueDate } from '@shared/tdsInterest'
import { tcsDepositDueDate } from '@shared/tcs'
import { cmp08DueDate, gstr1DueDate, gstr3bDueDate, gstr4DueDate, pmt06DueDate } from '@shared/gst/filing'
import {
  GST_FILED_META_KEY, MISSING_BILL_CHECKS, creditParts, gstPeriodChoices, quarterStart, gstPeriodEnd, gstPeriodFor, gstStartsOn, nextCompositionDue, normalizeArn, normalizeGstFiled,
  type GstFiledInput, type GstFiledMeta, type GstFiledPeriod, type GstForm, type GstPeriod, type MissingBillsItem, type SimpleTaxes, type SupplierBillsMonth, type TaxesWithholding
} from '@shared/simple/taxes'
import { getFeatures, getGstProfile } from './config'
import { dashGst, gst3bFigures } from './dashboard'
import { gstCredit, readGstFiled } from './simpleHome'
import { closeChecklist, getStatement, gst2bMismatches, withholdingFacts } from './assistants'
import { listLedgers } from './masters'
import { writeAudit } from './audit'

const META_KEY = GST_FILED_META_KEY
export { readGstFiled }

/** When the GSTR-1 / 3B file for a return month was last prepared (gstAnnual's export snapshot). */
function monthPreparedAt(db: DB, form: GstForm, lastMonth: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(`gst.exported.${form}.${gstPeriodOf(`${lastMonth}-01`)}`) as { value: string } | undefined
  if (!row) return null
  try {
    return (JSON.parse(row.value) as { at?: string }).at ?? null
  } catch {
    return null
  }
}

/** A period's files are prepared once every month of it is (a quarter: its three months, prepared
 *  month by month — the oldest of their times); a month: its own snapshot. */
function preparedAt(db: DB, form: GstForm, period: GstPeriod): string | null {
  const months = period.quarterly ? monthRange(quarterStart(period.period), period.period) : [period.period]
  const times = months.map((m) => monthPreparedAt(db, form, m))
  return times.every((x): x is string => x != null) ? times.sort()[0]! : null
}

/**
 * The quarterly bundle (step 3 for a quarterly filer): the files the full app's month-by-month
 * exports wrote for the quarter's three months, copied — byte for byte — into one folder,
 * `<exports>/<form>-<MMYYYY of the quarter's last month>-quarter/`. The monthly files stay where
 * they are (GSTR-9 keeps its monthly snapshots unchanged). Returns the folder and the copies.
 */
export function bundleQuarterFiles(slug: string, form: GstForm, period: string, files: readonly string[]): { folder: string; files: string[] } {
  const folder = join(companyExportsDir(slug), `${form}-${period}-quarter`)
  mkdirSync(folder, { recursive: true })
  const out = files.map((f) => {
    const dest = join(folder, basename(f))
    copyFileSync(f, dest)
    return dest
  })
  return { folder, files: out }
}

/** TDS / TCS while the feature is on: this month's deductions and what is still unpaid (FIFO). */
function withholdingAnswers(db: DB, today: string): TaxesWithholding[] {
  const features = getFeatures(db)
  const kinds = (['tds', 'tcs'] as const).filter((k) => features[k])
  if (kinds.length === 0) return []
  const facts = withholdingFacts(db, listLedgers(db), today)
  const month = today.slice(0, 7)
  // Only a kind the company actually withholds: switched on AND a tagged payable account exists
  // (WP 8.0's rule — a shop that never deducts sees no TDS answer).
  return kinds.filter((kind) => facts.some((w) => w.kind === kind)).map((kind): TaxesWithholding => {
    const mine = facts.filter((w) => w.kind === kind)
    const unpaid = mine
      .flatMap((w) => withholdingUnpaid(w, today))
      .map((u) => ({ month: u.month, amount: u.unpaid, dueDate: u.dueDate, late: u.late }))
      .sort((a, b) => (a.month ?? '').localeCompare(b.month ?? ''))
    return {
      kind,
      thisMonth: mine.reduce((s, w) => s + w.deducted.filter((d) => d.month === month).reduce((t, d) => t + d.amount, 0), 0),
      thisMonthDue: kind === 'tds' ? depositDueDate(`${month}-15`) : tcsDepositDueDate(`${month}-15`),
      unpaid,
      totalUnpaid: unpaid.reduce((s, u) => s + u.amount, 0),
      lateUnpaid: unpaid.filter((u) => u.late).reduce((s, u) => s + u.amount, 0)
    }
  })
}

/** The period asked for, or the Home tile's (dashGst: the return the next GSTR-3B files). */
function periodOf(db: DB, company: CompanyInfo, filing: 'monthly' | 'quarterly', asked: string | undefined, today: string): GstPeriod {
  if (asked) {
    const p = gstPeriodFor(asked, filing, today)
    if (!p) throw new AppError('simple_taxes_period', 'That period has not started yet.', { field: 'period' })
    return p
  }
  const row = dashGst(db, company, today, gstStartsOn(company.booksBeginDate, company.gstRegistrationSince))!
  const from = row.from ?? `${row.period}-01`
  // The period is named by its last month (a quarter by its third month); the dates are dashGst's own.
  const named = gstPeriodFor(row.period, filing, today)!
  return { ...named, from, to: row.to ?? from, soFar: named.soFar || !!row.soFar }
}

export function simpleTaxes(db: DB, company: CompanyInfo, q: { period?: string }, today: string): SimpleTaxes {
  return db.transaction((): SimpleTaxes => {
    const withholding = withholdingAnswers(db, today)
    if (company.gstRegistrationType === 'unregistered') return { kind: 'unregistered', today, withholding }
    if (company.gstRegistrationType === 'composition') {
      return { kind: 'composition', today, composition: nextCompositionDue(today, cmp08DueDate, gstr4DueDate), withholding }
    }
    const filing = getGstProfile(db).filing
    const period = periodOf(db, company, filing, q.period, today)
    // WP 10.8: no period that ended before the books (or the registration) began.
    const startsOn = gstStartsOn(company.booksBeginDate, company.gstRegistrationSince)
    const choices = gstPeriodChoices(filing, today, undefined, startsOn).map((p) => (p.period === period.period ? period : p))
    if (!choices.some((p) => p.period === period.period)) choices.push(period)
    choices.sort((a, b) => b.period.localeCompare(a.period))

    const f = gst3bFigures(db, company, period.from, period.to, period.period)
    const credit = gstCredit(db, period.from, period.to)
    const months = monthRange(period.from.slice(0, 7), period.to.slice(0, 7))

    // Step 1: the month-end checks that mean a bill may be missing, over the period's months.
    const missing = new Map<MissingBillsItem['key'], number>()
    for (const m of months) {
      for (const c of closeChecklist(db, company, m, today).checks) {
        if (!(MISSING_BILL_CHECKS as readonly string[]).includes(c.key)) continue
        if (c.effective !== 'warn' && c.effective !== 'fail') continue
        const key = c.key as MissingBillsItem['key']
        missing.set(key, Math.max(missing.get(key) ?? 0, Math.max(1, c.count)))
      }
    }

    // Step 2: each month's GSTR-2B statement and its open mismatches.
    const supplierBills: SupplierBillsMonth[] = months.map((m) => {
      const imported = !!getStatement(db, gstPeriodOf(`${m}-01`))
      if (!imported) return { month: m, imported, matched: 0, categories: [] }
      const r = gst2bMismatches(db, m, { today })
      return { month: m, imported, matched: r.matched, categories: r.summary.filter((s) => s.count > 0).map((s) => ({ category: s.category, count: s.count, tax: s.tax })) }
    })

    // WP 10.8 (the beginner study): the running period's GST so far, while an earlier one is shown.
    const runningPeriod = gstPeriodFor(today.slice(0, 7), filing, today)!
    let running: { period: GstPeriod; collected: number; onPurchases: number } | undefined
    if (runningPeriod.period !== period.period) {
      const r = gst3bFigures(db, company, runningPeriod.from, runningPeriod.to, runningPeriod.period)
      if (r.outwardTax !== 0 || r.itc !== 0) running = { period: runningPeriod, collected: r.outwardTax, onPurchases: r.itc }
    }

    const filedAll = readGstFiled(db)
    const filed: GstFiledPeriod = filedAll[period.period] ?? {}
    const due3b = gstr3bDueDate(period.period, filing, company.stateCode)
    return {
      kind: 'regular',
      today,
      filing,
      period,
      periods: choices,
      ...(running ? { running } : {}),
      figures: {
        collected: f.outwardTax,
        reverseCharge: f.rcmTax,
        onPurchases: f.itc,
        awaiting: credit.awaiting,
        checked: credit.checked,
        toPay: f.payable,
        cashOnSales: f.cashOnSales,
        rcmCash: f.rcmCash,
        ...creditParts(f.outwardTax, f.cashOnSales, f.itc)
      },
      due: {
        gstr1: gstr1DueDate(period.period, filing),
        gstr3b: due3b.date,
        gstr3bUnverified: due3b.unverified,
        pmt06: period.quarterly ? months.map(pmt06DueDate).filter((d): d is string => d != null) : []
      },
      missing: MISSING_BILL_CHECKS.filter((k) => missing.has(k)).map((key) => ({ key, count: missing.get(key)! })),
      supplierBills,
      prepared: { gstr1: preparedAt(db, 'gstr1', period), gstr3b: preparedAt(db, 'gstr3b', period) },
      filesMonthly: period.quarterly,
      filed,
      withholding
    }
  })()
}

/**
 * "I've filed": the ARN and the date the user filed a return on (or null to clear it), kept in
 * meta `gstFiled` under the period's last month and audited as a company update (the whole
 * before / after of that return's mark). An unchanged mark writes nothing.
 */
export function setGstFiled(db: DB, company: CompanyInfo, input: GstFiledInput, user: string | null, today = todayISO()): GstFiledPeriod {
  if (company.gstRegistrationType !== 'regular') throw new AppError('gst_filed_not_regular', 'Only a regular GST registration files GSTR-1 and GSTR-3B.')
  const p = gstPeriodFor(input.period, getGstProfile(db).filing, today)
  if (!p) throw new AppError('simple_taxes_period', 'That period has not started yet.', { field: 'period' })
  if (p.soFar) throw new AppError('gst_filed_too_early', 'This period is not over yet, so its return can’t have been filed.', { field: 'date' })
  const all = readGstFiled(db)
  const current = all[p.period]?.[input.form] ?? null
  let next: GstFiledPeriod[GstForm] | null = null
  if (input.arn !== null) {
    const arn = normalizeArn(input.arn)
    if (!arn) throw new AppError('gst_filed_arn', 'Type the acknowledgement number (ARN) the GST portal showed — letters and numbers only.', { field: 'arn' })
    if (!input.date) throw new AppError('gst_filed_date', 'Enter the date you filed it.', { field: 'date' })
    if (input.date > today) throw new AppError('gst_filed_date', 'The filing date can’t be after today.', { field: 'date' })
    if (input.date <= p.to) throw new AppError('gst_filed_date', 'A return is filed after its period ends — check the date.', { field: 'date' })
    if (current && current.arn === arn && current.date === input.date) return all[p.period]!
    next = { arn, date: input.date, by: user, at: new Date().toISOString() }
  } else if (!current) {
    return all[p.period] ?? {}
  }
  const period: GstFiledPeriod = { ...(all[p.period] ?? {}) }
  if (next) period[input.form] = next
  else delete period[input.form]
  const updated: GstFiledMeta = { ...all }
  if (Object.keys(period).length) updated[p.period] = period
  else delete updated[p.period]
  db.transaction(() => {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(META_KEY, JSON.stringify(updated))
    writeAudit(db, 'company', 0, 'update', { gstFiled: { [p.period]: { [input.form]: current } } }, { gstFiled: { [p.period]: { [input.form]: next } } })
  })()
  return period
}
