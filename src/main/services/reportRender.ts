/**
 * One report, rendered once, exported three ways.
 *
 * Before this, every export path formatted its own cells: the screen built PDF rows, the CA pack
 * built CSV strings, and a scheduled run would have had to build a third. Three copies of "which
 * columns does a trial balance have" is three chances for them to disagree, and the one that
 * disagrees quietly is the one that gets emailed to an accountant.
 *
 * So a report is produced ONCE as typed cells — money stays integer paise, dates stay ISO — and
 * the three converters at the bottom turn that into a PDF row set, a CSV, or a spreadsheet.
 * Formatting happens at exactly one boundary per format.
 *
 * These renderers never take a page: an export covers the whole period or it is a lie. The Day
 * Book screen is paged at the IPC boundary, but `dayBook` without a limit returns every row and
 * that is what this asks for.
 */

import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { StatementNode } from '@shared/reports'
import { rowsToCsv } from '@shared/csv'
import { formatPaise, plainRupees } from '@shared/money'
import { toDisplayDate } from '@shared/dates'
import { buildSpreadsheet, date as xlsDate, money as xlsMoney, num as xlsNum, text as xlsText, type XlsCell, type XlsSheet } from '@shared/spreadsheet'
import type { ReportColumnSpec, ReportRowSpec } from './reportHtml'
import { balanceSheet, dayBook, profitAndLoss, trialBalance } from './reports'
import { outstandings } from './analysis'

export type CellKind = 'text' | 'money' | 'date' | 'number'

export interface RenderColumn {
  label: string
  align: 'l' | 'r' | 'c'
  kind: CellKind
}

export interface RenderRow {
  /** One value per column. Money is integer paise; a date is ISO; null renders as a dash. */
  cells: (string | number | null)[]
  bold?: boolean
  indent?: number
}

export interface RenderedReport {
  title: string
  periodLabel: string
  columns: RenderColumn[]
  rows: RenderRow[]
  footNote?: string
}

// ---------- the reports ----------

const MONEY = (label: string): RenderColumn => ({ label, align: 'r', kind: 'money' })
const TEXT = (label: string): RenderColumn => ({ label, align: 'l', kind: 'text' })

export function renderTrialBalance(db: DB, asOn: string): RenderedReport {
  const tb = trialBalance(db, asOn)
  return {
    title: 'Trial balance',
    periodLabel: `as on ${toDisplayDate(asOn)}`,
    columns: [TEXT('Ledger'), TEXT('Group'), MONEY('Debit'), MONEY('Credit')],
    rows: [
      ...tb.rows.map((r) => ({ cells: [r.ledgerName, r.groupName, r.debit, r.credit] })),
      { cells: ['Total', '', tb.totalDebit, tb.totalCredit], bold: true }
    ]
  }
}

/** A StatementTree flattened depth-first, groups bold, depth carried as the row indent. */
function statementRows(nodes: StatementNode[], depth = 0): RenderRow[] {
  const out: RenderRow[] = []
  for (const n of nodes) {
    out.push({ cells: [n.name, n.amount], bold: n.kind !== 'ledger', indent: depth })
    if (n.children.length) out.push(...statementRows(n.children, depth + 1))
  }
  return out
}

export function renderProfitAndLoss(db: DB, from: string, to: string): RenderedReport {
  const pnl = profitAndLoss(db, from, to)
  return {
    title: 'Profit & Loss',
    periodLabel: `${toDisplayDate(from)} to ${toDisplayDate(to)}`,
    columns: [TEXT('Particulars'), MONEY('Amount')],
    rows: [
      { cells: ['Opening stock', pnl.openingStock] },
      ...statementRows(pnl.tradingExpenses),
      ...statementRows(pnl.tradingIncomes),
      { cells: ['Closing stock', pnl.closingStock] },
      { cells: ['Gross profit', pnl.grossProfit], bold: true },
      ...statementRows(pnl.indirectExpenses),
      ...statementRows(pnl.indirectIncomes),
      { cells: ['Net profit', pnl.netProfit], bold: true }
    ]
  }
}

export function renderBalanceSheet(db: DB, booksFrom: string, asOn: string): RenderedReport {
  const bs = balanceSheet(db, booksFrom, asOn)
  return {
    title: 'Balance sheet',
    periodLabel: `as on ${toDisplayDate(asOn)}`,
    columns: [TEXT('Particulars'), MONEY('Amount')],
    rows: [
      { cells: ['Liabilities', null], bold: true },
      ...statementRows(bs.liabilities, 1),
      { cells: ['Total liabilities', bs.totalLiabilities], bold: true },
      { cells: ['Assets', null], bold: true },
      ...statementRows(bs.assets, 1),
      { cells: ['Total assets', bs.totalAssets], bold: true }
    ]
  }
}

export function renderDayBook(db: DB, from: string, to: string): RenderedReport {
  const rows = dayBook(db, from, to)
  return {
    title: 'Day book',
    periodLabel: `${toDisplayDate(from)} to ${toDisplayDate(to)}`,
    columns: [
      { label: 'Date', align: 'l', kind: 'date' },
      TEXT('Type'),
      TEXT('Number'),
      TEXT('Account'),
      TEXT('Narration'),
      MONEY('Debit'),
      MONEY('Credit')
    ],
    rows: [
      ...rows.map((r) => ({
        cells: [r.date, r.voucherType, r.number, r.account, r.narration ?? '', r.debit, r.credit]
      })),
      {
        cells: [
          null,
          'Total',
          '',
          '',
          '',
          rows.reduce((s, r) => s + r.debit, 0),
          rows.reduce((s, r) => s + r.credit, 0)
        ],
        bold: true
      }
    ]
  }
}

export function renderOutstandings(db: DB, asOn: string, side: 'receivable' | 'payable' = 'receivable'): RenderedReport {
  const parties = outstandings(db, side, asOn, { includeBills: false })
  return {
    title: side === 'receivable' ? 'Outstanding receivables' : 'Outstanding payables',
    periodLabel: `as on ${toDisplayDate(asOn)}`,
    columns: [
      TEXT('Party'),
      { label: 'Bills', align: 'r', kind: 'number' },
      MONEY('0-30'),
      MONEY('31-60'),
      MONEY('61-90'),
      MONEY('90+'),
      MONEY('Total')
    ],
    rows: [
      ...parties.map((p) => ({
        cells: [p.name, p.billCount, p.buckets[0], p.buckets[1], p.buckets[2], p.buckets[3], p.pending]
      })),
      {
        cells: [
          'Total',
          parties.reduce((s, p) => s + p.billCount, 0),
          parties.reduce((s, p) => s + p.buckets[0], 0),
          parties.reduce((s, p) => s + p.buckets[1], 0),
          parties.reduce((s, p) => s + p.buckets[2], 0),
          parties.reduce((s, p) => s + p.buckets[3], 0),
          parties.reduce((s, p) => s + p.pending, 0)
        ],
        bold: true
      }
    ]
  }
}

// ---------- the three converters ----------

function displayCell(value: string | number | null, kind: CellKind): string {
  if (value === null) return ''
  if (kind === 'money') return typeof value === 'number' ? formatPaise(value, { zeroDash: true }) : String(value)
  if (kind === 'date') return typeof value === 'string' ? toDisplayDate(value) : String(value)
  return String(value)
}

export function toPdfColumns(report: RenderedReport): ReportColumnSpec[] {
  return report.columns.map((c) => ({ label: c.label, align: c.align }))
}

export function toPdfRows(report: RenderedReport): ReportRowSpec[] {
  return report.rows.map((r) => ({
    cells: r.cells.map((v, i) => displayCell(v, report.columns[i]?.kind ?? 'text')),
    bold: r.bold,
    indent: r.indent
  }))
}

/**
 * CSV. Money goes out as a plain ungrouped decimal, never as "₹1,234.56": a grouped figure with a
 * symbol is text to every spreadsheet that opens it, and a column of text does not add up.
 */
export function toCsv(report: RenderedReport): string {
  const rows = report.rows.map((r) =>
    r.cells.map((v, i) => {
      const kind = report.columns[i]?.kind ?? 'text'
      if (v === null) return ''
      if (kind === 'money') return typeof v === 'number' ? plainRupees(v) : String(v)
      return String(v)
    })
  )
  return rowsToCsv(
    report.columns.map((c) => c.label),
    rows
  )
}

export function toXlsSheet(report: RenderedReport): XlsSheet {
  return {
    name: report.title,
    header: report.columns.map((c) => c.label),
    rows: report.rows.map((r) => ({
      bold: r.bold,
      cells: r.cells.map((v, i): XlsCell => {
        const kind = report.columns[i]?.kind ?? 'text'
        if (v === null) return xlsText('')
        if (kind === 'money') return typeof v === 'number' ? xlsMoney(v) : xlsText(String(v))
        if (kind === 'number') return typeof v === 'number' ? xlsNum(v) : xlsText(String(v))
        if (kind === 'date') return typeof v === 'string' ? xlsDate(v) : xlsText(String(v))
        // Indentation is spaces in a spreadsheet: Excel's own indent attribute is per-style, and
        // a style per depth is more machinery than a tree of six levels deserves.
        return xlsText(i === 0 && r.indent ? '   '.repeat(r.indent) + String(v) : String(v))
      })
    }))
  }
}

/** Several reports as one workbook — what a CA pack in spreadsheet form is. */
export function toWorkbook(reports: RenderedReport[]): string {
  return buildSpreadsheet(reports.map(toXlsSheet))
}

/** The five reports a schedule or a pack can ask for, by the key the schema uses. */
export function renderScheduledReport(
  db: DB,
  report: string,
  period: { from: string; to: string },
  booksFrom: string,
  _company?: CompanyInfo
): RenderedReport {
  switch (report) {
    case 'trialBalance':
      return renderTrialBalance(db, period.to)
    case 'profitLoss':
      return renderProfitAndLoss(db, period.from, period.to)
    case 'balanceSheet':
      return renderBalanceSheet(db, booksFrom, period.to)
    case 'dayBook':
      return renderDayBook(db, period.from, period.to)
    case 'outstandings':
      return renderOutstandings(db, period.to)
    default:
      throw new Error(`Unknown report: ${report}`)
  }
}
