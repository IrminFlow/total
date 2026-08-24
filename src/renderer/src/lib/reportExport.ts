import { rowsToCsv } from '@shared/csv'
import { formatPaise } from '@shared/money'
import type { StatementNode } from '@shared/reports'
import { api, type ReportColumn, type ReportPdfInput, type ReportRow, type XlsExportSheet } from './client'
import type { ToastState } from '../state/stores'

/** Slugifies a screen title into the `[a-z0-9-_]+` filename the report:pdf/export:csv IPC
 *  channels require (see exportFilename in @shared/schemas). */
export function slugFilename(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'report'
}

/** Prints a report to PDF via the shared A4 template (report:pdf) and drops it in the company's
 *  exports folder. Every cell must already be display-formatted (money via formatPaise, dates via
 *  toDisplayDate, ...) — the main-process template only lays the strings out and escapes them. */
export async function printReport(
  opts: { title: string; periodLabel: string; columns: ReportColumn[]; rows: ReportRow[]; footNote?: string; filename?: string },
  toast: ToastState
): Promise<void> {
  if (opts.rows.length > 5000) {
    toast.push('error', 'Too many rows for a PDF — narrow the period and try again')
    return
  }
  const input: ReportPdfInput = {
    title: opts.title,
    periodLabel: opts.periodLabel,
    columns: opts.columns,
    rows: opts.rows,
    footNote: opts.footNote,
    filename: opts.filename ?? slugFilename(opts.title)
  }
  try {
    const r = await api.exportReport.pdf(input)
    toast.push('success', `Saved to exports — ${r.path}`)
  } catch (err) {
    toast.push('error', (err as Error).message)
  }
}

/** Builds a CSV client-side (rowsToCsv) and hands it to export:csv to write into the company's
 *  exports folder — no per-report main-process code needed for the CSV side. */
export async function csvReport(header: string[], rows: string[][], filename: string, toast: ToastState): Promise<void> {
  const csv = rowsToCsv(header, rows)
  try {
    const r = await api.exportReport.csv(slugFilename(filename), csv)
    toast.push('success', `Saved to exports — ${r.path}`)
  } catch (err) {
    toast.push('error', (err as Error).message)
  }
}

/** Flattens a StatementTree (P&L / Balance Sheet groups) into the flat cells/indent/bold rows the
 *  report:pdf template and CSV export expect. Non-leaf nodes (groups) render bold; depth becomes
 *  the row's indent so the printed tree matches the on-screen StatementTree. */
export function flattenNodes(nodes: StatementNode[], depth = 0): ReportRow[] {
  const out: ReportRow[] = []
  for (const n of nodes) {
    out.push({
      cells: [n.name, formatPaise(n.amount, { zeroDash: true })],
      bold: n.kind !== 'ledger',
      indent: depth
    })
    if (n.children.length) out.push(...flattenNodes(n.children, depth + 1))
  }
  return out
}

/**
 * Spreadsheet export.
 *
 * Unlike the PDF and CSV helpers, this one is NOT given display strings: money crosses as integer
 * paise and dates as ISO, and main turns them into real spreadsheet numbers and dates. A column
 * of "₹1,23,456.00" is text to Excel, and text does not add up — which is the only reason to
 * offer a spreadsheet beside the CSV at all.
 *
 * Written as .xls (SpreadsheetML), a single XML file Excel opens natively. See
 * src/shared/spreadsheet.ts for why that beat adding a ZIP dependency for real XLSX.
 */
export async function xlsReport(
  filename: string,
  sheets: XlsExportSheet[],
  toast: ToastState
): Promise<void> {
  try {
    const r = await api.exportReport.xls(slugFilename(filename), sheets)
    toast.push('success', `Saved to exports — ${r.path}`)
  } catch (err) {
    toast.push('error', (err as Error).message)
  }
}
