import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { GstScope } from './registrations'
import type { StatementNode } from '@shared/reports'
import type { TallyGroup, TallyLedger, TallyUnit, TallyItem, TallyVoucher } from '@shared/tally'
import { buildTallyMastersXml, buildTallyVouchersXml } from '@shared/tallyExport'
import { rowsToCsv } from '@shared/csv'
import { plainRupees } from '@shared/money'
import { fyFromStartYear, gstPeriodOf, todayISO } from '@shared/dates'
import { GST_STATES } from '@shared/gst/states'
import { companyExportsDir } from '../paths'
import { descendantIdsByName, listGroups, listLedgers, listStockItems, listUnits, listVoucherTypes } from './masters'
import { getVoucher, IN_BOOKS } from './vouchers'
import { balanceSheet, dayBook, ledgerStatement, profitAndLoss, trialBalance } from './reports'
import {
  renderBalanceSheet, renderOutstandings, renderProfitAndLoss, renderTrialBalance,
  toPdfColumns, toPdfRows, toWorkbook
} from './reportRender'
import { reportPackHtml } from './reportHtml'
import { writeExportPdf } from './pdf'
import { outstandings } from './analysis'
import { gstr1 } from './gst'

// ---------- neutral Tally masters/vouchers, mapped from our schema ----------

/**
 * Only custom (user-created) groups travel — Tally already ships its own standard chart of
 * accounts, so re-exporting system groups would just create noisy duplicates on import. A
 * custom group whose parent name isn't one Tally already knows will fail to import there; the
 * accountant should create that parent first, or re-point the group under "Primary" (Tally's
 * root group) before importing — see the comment atop tallyExport.ts.
 */
export function tallyMastersOf(db: DB): { groups: TallyGroup[]; ledgers: TallyLedger[]; units: TallyUnit[]; items: TallyItem[] } {
  const allGroups = listGroups(db)
  const groupById = new Map(allGroups.map((g) => [g.id, g]))
  const groups: TallyGroup[] = allGroups
    .filter((g) => !g.isSystem)
    .map((g) => ({
      name: g.name,
      parent: g.parentId !== null ? (groupById.get(g.parentId)?.name ?? 'Primary') : 'Primary'
    }))

  const units: TallyUnit[] = listUnits(db).map((u) => ({ name: u.name, decimals: u.decimals }))

  const unitById = new Map(listUnits(db).map((u) => [u.id, u]))
  const items: TallyItem[] = listStockItems(db).map((it) => ({
    name: it.name,
    unit: unitById.get(it.unitId)?.name ?? '',
    hsn: it.hsn,
    gstRate: it.gstRate,
    openingQtyMilli: it.openingQtyMilli,
    openingValue: it.openingValue
  }))

  const ledgers: TallyLedger[] = listLedgers(db).map((l) => ({
    name: l.name,
    parent: groupById.get(l.groupId)?.name ?? 'Primary',
    opening: l.openingBalance,
    gstin: l.gstin,
    stateName: l.stateCode ? (GST_STATES[l.stateCode] ?? null) : null
  }))

  return { groups, ledgers, units, items }
}

/** In-books vouchers dated within [from, to] (no binned, memorandum, or unmatured post-dated
 *  ones — a migration must carry the books, not marginalia), mapped to the neutral Tally shape. */
export function tallyVouchersOf(db: DB, from: string, to: string): TallyVoucher[] {
  const ledgerName = new Map(listLedgers(db).map((l) => [l.id, l.name]))
  const itemName = new Map(listStockItems(db).map((i) => [i.id, i.name]))
  const vtById = new Map(listVoucherTypes(db).map((vt) => [vt.id, vt]))

  const ids = (
    db
      .prepare(`SELECT id FROM vouchers v WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS} ORDER BY v.date, v.id`)
      .all(from, to) as { id: number }[]
  ).map((r) => r.id)

  return ids.map((id) => {
    const v = getVoucher(db, id)!
    return {
      vchType: vtById.get(v.voucherTypeId)?.name ?? 'Journal',
      date: v.date,
      number: v.number,
      party: v.partyLedgerId !== null ? (ledgerName.get(v.partyLedgerId) ?? null) : null,
      narration: v.narration,
      lines: v.lines.map((l) => ({ ledger: ledgerName.get(l.ledgerId) ?? `#${l.ledgerId}`, drCr: l.drCr, amount: l.amount })),
      inventory: v.inventory.map((i) => ({
        item: itemName.get(i.stockItemId) ?? `#${i.stockItemId}`,
        qtyMilli: i.qtyMilli,
        amount: i.amount
      }))
    }
  })
}

function writeTallyXmlFiles(dir: string, db: DB, from: string, to: string): { mastersPath: string; vouchersPath: string } {
  mkdirSync(dir, { recursive: true })
  const mastersPath = join(dir, 'tally-masters.xml')
  const vouchersPath = join(dir, 'tally-vouchers.xml')
  writeFileSync(mastersPath, buildTallyMastersXml(tallyMastersOf(db)))
  writeFileSync(vouchersPath, buildTallyVouchersXml(tallyVouchersOf(db, from, to)))
  return { mastersPath, vouchersPath }
}

// ---------- CSV builders ----------

function flattenStatement(nodes: StatementNode[], depth = 0): { name: string; amount: number }[] {
  const out: { name: string; amount: number }[] = []
  for (const n of nodes) {
    out.push({ name: `${'  '.repeat(depth)}${n.name}`, amount: n.amount })
    out.push(...flattenStatement(n.children, depth + 1))
  }
  return out
}

function daybookCsv(db: DB, from: string, to: string): string {
  const rows = dayBook(db, from, to)
  return rowsToCsv(
    ['Date', 'Voucher Type', 'Number', 'Account', 'Narration', 'Debit', 'Credit'],
    rows.map((r) => [r.date, r.voucherType, r.number, r.account, r.narration ?? '', plainRupees(r.debit), plainRupees(r.credit)])
  )
}

function trialBalanceCsv(db: DB, to: string): string {
  const tb = trialBalance(db, to)
  const rows = tb.rows.map((r) => [r.ledgerName, r.groupName, plainRupees(r.debit), plainRupees(r.credit)])
  rows.push(['Total', '', plainRupees(tb.totalDebit), plainRupees(tb.totalCredit)])
  return rowsToCsv(['Ledger', 'Group', 'Debit', 'Credit'], rows)
}

function profitAndLossCsv(db: DB, from: string, to: string): string {
  const pnl = profitAndLoss(db, from, to)
  const rows: string[][] = []
  rows.push(['Opening Stock', plainRupees(pnl.openingStock)])
  for (const r of flattenStatement(pnl.tradingIncomes)) rows.push([r.name, plainRupees(r.amount)])
  for (const r of flattenStatement(pnl.tradingExpenses)) rows.push([r.name, plainRupees(-r.amount)])
  rows.push(['Closing Stock', plainRupees(pnl.closingStock)])
  rows.push(['Gross Profit', plainRupees(pnl.grossProfit)])
  for (const r of flattenStatement(pnl.indirectIncomes)) rows.push([r.name, plainRupees(r.amount)])
  for (const r of flattenStatement(pnl.indirectExpenses)) rows.push([r.name, plainRupees(-r.amount)])
  rows.push(['Net Profit', plainRupees(pnl.netProfit)])
  return rowsToCsv(['Particulars', 'Amount'], rows)
}

function balanceSheetCsv(db: DB, booksFrom: string, asOn: string): string {
  const bs = balanceSheet(db, booksFrom, asOn)
  const rows: string[][] = []
  rows.push(['Liabilities', ''])
  for (const r of flattenStatement(bs.liabilities)) rows.push([r.name, plainRupees(r.amount)])
  rows.push(['Total Liabilities', plainRupees(bs.totalLiabilities)])
  rows.push(['Assets', ''])
  for (const r of flattenStatement(bs.assets)) rows.push([r.name, plainRupees(r.amount)])
  rows.push(['Total Assets', plainRupees(bs.totalAssets)])
  return rowsToCsv(['Particulars', 'Amount'], rows)
}

interface RegisterRow { date: string; number: string; party: string; taxable: number; tax: number; total: number }

/** Per-voucher sales/purchase register — same account/side logic as analysis.registerByMonth, at voucher grain. */
function voucherRegister(db: DB, kind: 'sales' | 'purchase', from: string, to: string): RegisterRow[] {
  const accountRoot = kind === 'sales'
    ? ['Sales Accounts', 'Direct Incomes', 'Indirect Incomes']
    : ['Purchase Accounts', 'Direct Expenses', 'Indirect Expenses']
  const accountIds = descendantIdsByName(db, accountRoot)
  const side = kind === 'sales' ? 'cr' : 'dr'

  const vouchers = db
    .prepare(
      `SELECT v.id, v.date, v.number, COALESCE(p.name, '') AS party
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers p ON p.id = v.party_ledger_id
       WHERE vt.kind = ? AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       ORDER BY v.date, v.id`
    )
    .all(kind, from, to) as { id: number; date: string; number: string; party: string }[]

  const lineStmt = db.prepare(
    `SELECT vl.amount, vl.dr_cr AS drCr, l.group_id AS groupId, l.tax_type AS taxType
     FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id WHERE vl.voucher_id = ?`
  )
  const totalStmt = db.prepare("SELECT COALESCE(SUM(amount), 0) AS t FROM voucher_lines WHERE voucher_id = ? AND dr_cr = 'dr'")

  return vouchers.map((v) => {
    const lines = lineStmt.all(v.id) as { amount: number; drCr: 'dr' | 'cr'; groupId: number; taxType: string | null }[]
    let taxable = 0
    let tax = 0
    for (const l of lines) {
      if (l.drCr !== side) continue
      if (accountIds.has(l.groupId)) taxable += l.amount
      if (l.taxType) tax += l.amount
    }
    const total = (totalStmt.get(v.id) as { t: number }).t
    return { date: v.date, number: v.number, party: v.party, taxable, tax, total }
  })
}

function registerCsv(db: DB, kind: 'sales' | 'purchase', from: string, to: string): string {
  const rows = voucherRegister(db, kind, from, to)
  return rowsToCsv(
    ['Date', 'Number', 'Party', 'Taxable', 'Tax', 'Total'],
    rows.map((r) => [r.date, r.number, r.party, plainRupees(r.taxable), plainRupees(r.tax), plainRupees(r.total)])
  )
}

function outstandingsCsv(db: DB, asOn: string): string {
  const rows: string[][] = []
  for (const side of ['receivable', 'payable'] as const) {
    for (const p of outstandings(db, side, asOn)) {
      const [b0, b1, b2, b3] = p.buckets
      rows.push([side, p.name, plainRupees(p.pending), plainRupees(b0), plainRupees(b1), plainRupees(b2), plainRupees(b3)])
    }
  }
  return rowsToCsv(['Side', 'Party', 'Pending', '0-30', '31-60', '61-90', '90+'], rows)
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9 _.-]/g, '_').trim() || 'ledger'
}

/** Ledger-statement CSVs for every ledger with at least one posting in the period. */
function writeLedgerStatements(dir: string, db: DB, from: string, to: string): number {
  mkdirSync(dir, { recursive: true })
  let count = 0
  for (const l of listLedgers(db)) {
    const stmt = ledgerStatement(db, l.id, from, to)
    if (stmt.rows.length === 0) continue
    const rows: string[][] = [['Opening', '', '', '', '', '', '', plainRupees(stmt.opening)]]
    for (const r of stmt.rows) {
      rows.push([r.date, r.voucherType, r.number, r.particulars, r.narration ?? '', plainRupees(r.debit), plainRupees(r.credit), plainRupees(r.running)])
    }
    rows.push(['Closing', '', '', '', '', plainRupees(stmt.totalDebit), plainRupees(stmt.totalCredit), plainRupees(stmt.closing)])
    const csv = rowsToCsv(['Date', 'Voucher Type', 'Number', 'Particulars', 'Narration', 'Debit', 'Credit', 'Balance'], rows)
    writeFileSync(join(dir, `${sanitizeFileName(l.name)}.csv`), csv)
    count++
  }
  return count
}

/** Deductee-wise TDS entries for the period, matching tds.ts#export26qCsv's row shape — joins
 *  tds_entries (voucher_id/section_id/party_ledger_id/pan/base_amount/tds_amount) to the section
 *  code and the voucher's date/number, filtered to [from, to] and IN_BOOKS (books figures only, matching tds.ts). Returns null (no
 *  file written) if there are no entries in the period. */
function tdsCsv(db: DB, from: string, to: string): string | null {
  const rows = db
    .prepare(
      `SELECT l.name AS deductee, te.pan AS pan, ts.code AS section, v.date AS date, v.number AS number,
              te.base_amount AS base, te.tds_amount AS tds
       FROM tds_entries te
       JOIN vouchers v ON v.id = te.voucher_id
       JOIN tds_sections ts ON ts.id = te.section_id
       JOIN ledgers l ON l.id = te.party_ledger_id
       WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       ORDER BY v.date, v.id`
    )
    .all(from, to) as { deductee: string; pan: string | null; section: string; date: string; number: string; base: number; tds: number }[]
  if (rows.length === 0) return null
  const csvRows = rows.map((r) => [r.deductee, r.pan ?? '', r.section, r.date, r.number, plainRupees(r.base), plainRupees(r.tds)])
  return rowsToCsv(['Deductee', 'PAN', 'Section', 'Voucher Date', 'Voucher No', 'Base (Rs)', 'TDS (Rs)'], csvRows)
}

// ---------- entry points ----------

/** Just the two Tally XML files, for a CA who only wants the books re-imported into Tally. */
export function exportTallyXml(db: DB, _company: CompanyInfo, slug: string, from: string, to: string): { path: string } {
  const dir = join(companyExportsDir(slug), `tally-export-${from}_${to}`)
  writeTallyXmlFiles(dir, db, from, to)
  return { path: dir }
}

/** The full CA handover pack: Tally XML + every standard report as CSV, for the period. */
export function exportCaPack(db: DB, company: GstScope, slug: string, from: string, to: string): { path: string } {
  const dir = join(companyExportsDir(slug), `ca-pack-${from}_${to}`)
  mkdirSync(dir, { recursive: true })

  writeTallyXmlFiles(dir, db, from, to)

  writeFileSync(join(dir, 'daybook.csv'), daybookCsv(db, from, to))
  writeFileSync(join(dir, 'trial-balance.csv'), trialBalanceCsv(db, to))
  writeFileSync(join(dir, 'profit-and-loss.csv'), profitAndLossCsv(db, from, to))
  const booksFrom = fyFromStartYear(company.booksFrom).from
  writeFileSync(join(dir, 'balance-sheet.csv'), balanceSheetCsv(db, booksFrom, to))
  writeFileSync(join(dir, 'sales-register.csv'), registerCsv(db, 'sales', from, to))
  writeFileSync(join(dir, 'purchase-register.csv'), registerCsv(db, 'purchase', from, to))
  writeFileSync(join(dir, 'outstandings.csv'), outstandingsCsv(db, to))

  writeLedgerStatements(join(dir, 'ledger-statements'), db, from, to)

  const period = gstPeriodOf(from)
  const g1 = gstr1(db, company, from, to, period)
  writeFileSync(join(dir, `gstr1-${period}.json`), JSON.stringify(g1.json, null, 2))

  const tds = tdsCsv(db, from, to)
  if (tds) writeFileSync(join(dir, 'tds-26q.csv'), tds)

  if (!existsSync(dir)) throw new Error('CA pack export failed')
  return { path: dir }
}

/**
 * The same pack as one PDF: trial balance, P&L, balance sheet, receivables ageing.
 *
 * The CSV folder is what a machine wants. This is what a person wants — an accountant opening
 * the pack should see the four statements without importing seven files first, each starting on
 * its own sheet so any one of them can be printed alone.
 *
 * Written beside the CSVs, never instead of them: whoever wants to re-total a column wants the
 * column, not a picture of it.
 */
export async function exportCaPackPdf(
  db: DB,
  company: CompanyInfo,
  slug: string,
  from: string,
  to: string
): Promise<{ path: string }> {
  const booksFrom = fyFromStartYear(company.booksFrom).from
  const reports = [
    renderTrialBalance(db, to),
    renderProfitAndLoss(db, from, to),
    renderBalanceSheet(db, booksFrom, to),
    renderOutstandings(db, to, 'receivable'),
    renderOutstandings(db, to, 'payable')
  ]

  const html = reportPackHtml({
    title: 'CA pack',
    company,
    periodLabel: `${from} to ${to}`,
    preparedOn: todayISO(),
    sections: reports.map((r) => ({
      title: r.title,
      periodLabel: r.periodLabel,
      columns: toPdfColumns(r),
      rows: toPdfRows(r)
    }))
  })

  const path = await writeExportPdf(slug, `ca-pack-${from}_${to}.pdf`, html, {
    pageSize: 'A4',
    pageNumbers: true,
    runningHead: { company: company.name, gstin: company.gstin, title: 'CA pack', periodLabel: `${from} to ${to}` }
  })
  return { path }
}

/** The same four statements as one spreadsheet workbook, one sheet each. */
export function exportCaPackWorkbook(
  db: DB,
  company: CompanyInfo,
  slug: string,
  from: string,
  to: string
): { path: string } {
  const booksFrom = fyFromStartYear(company.booksFrom).from
  const xml = toWorkbook([
    renderTrialBalance(db, to),
    renderProfitAndLoss(db, from, to),
    renderBalanceSheet(db, booksFrom, to),
    renderOutstandings(db, to, 'receivable'),
    renderOutstandings(db, to, 'payable')
  ])
  const path = join(companyExportsDir(slug), `ca-pack-${from}_${to}.xls`)
  writeFileSync(path, xml, 'utf8')
  return { path }
}
