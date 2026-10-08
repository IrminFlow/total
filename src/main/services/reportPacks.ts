/**
 * Scheduled report packs (WP 6.2): a named list of reports (built-in statements and saved
 * builder reports) rendered for a period rule into a folder as PDF + CSV, on a daily / weekly /
 * monthly schedule. Runs happen in the main process only when the company is open — on open
 * (missed runs collapse into one, like the backup-on-open job) and hourly while open — or on
 * "Run now". Every run is logged (report_pack_runs) and audited.
 *
 * XLSX is not written yet: the shared workbook writer belongs to WP 6.3, which is not on main.
 *
 * PDF rendering is injected (`renderPdf`) so the scheduler logic runs in DB tests without a
 * BrowserWindow; the IPC layer passes services/pdf.ts#htmlToPdf.
 */
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { StatementNode } from '@shared/reports'
import { formatPaise } from '@shared/money'
import { rowsToCsv } from '@shared/csv'
import { toDisplayDate, todayISO } from '@shared/dates'
import {
  BUILTIN_PACK_REPORTS, nextDueAt, packDue, packInputSchema, type PackInputPayload, type PackReportRef, type PackRun, type ReportPack
} from '@shared/reportBuilder/packs'
import { relativePeriod, type DateRange } from '@shared/reportBuilder/period'
import { flattenResult } from '@shared/reportBuilder/shape'
import { RATIO_CATEGORIES, RATIO_DEFS, formatRatio } from '@shared/ratios'
import { companyExportsDir, slugify } from '../paths'
import { reportHtml, type ReportColumnSpec, type ReportRowSpec } from './reportHtml'
import { balanceSheet, dayBook, profitAndLoss, trialBalance } from './reports'
import { outstandings } from './analysis'
import { ratioReport } from './reportAnalytics'
import { getSavedReport, runReport } from './reportBuilder'
import { SYSTEM_AUDIT_USER, runAsAuditUser, writeAudit } from './audit'
import { writeXlsxFile } from './xlsxFile'
import { displayTableToSheet } from '@shared/xlsx/display'

/** Resolves on the next macrotask (setImmediate), so long pack runs never block the UI's IPC. */
export const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

export type RenderPdf = (html: string, opts: { landscape: boolean }) => Promise<Buffer>

// ---------------------------------------------------------------- CRUD

interface PackRow {
  id: number; name: string; reports_json: string; period_rule: string; frequency: string; formats_json: string
  output_dir: string | null; active: number; last_run_at: string | null; created_at: string
}

function mapPack(r: PackRow): ReportPack {
  const parsed = packInputSchema.parse({
    name: r.name,
    reports: JSON.parse(r.reports_json),
    periodRule: r.period_rule,
    frequency: r.frequency,
    formats: JSON.parse(r.formats_json),
    outputDir: r.output_dir,
    active: !!r.active
  })
  return {
    ...parsed,
    id: r.id,
    lastRunAt: r.last_run_at,
    createdAt: r.created_at,
    nextDue: new Date(nextDueAt(parsed.frequency, r.last_run_at ?? r.created_at)).toISOString().slice(0, 10)
  }
}

export function listPacks(db: DB): ReportPack[] {
  return (db.prepare('SELECT * FROM report_packs ORDER BY name COLLATE NOCASE').all() as PackRow[]).map(mapPack)
}

export function getPack(db: DB, id: number): ReportPack {
  const r = db.prepare('SELECT * FROM report_packs WHERE id = ?').get(id) as PackRow | undefined
  if (!r) throw new Error('Pack not found')
  return mapPack(r)
}

export function savePack(db: DB, payload: PackInputPayload, id?: number): ReportPack {
  const input = packInputSchema.parse(payload)
  const clash = db.prepare('SELECT id FROM report_packs WHERE name = ? COLLATE NOCASE AND id IS NOT ?').get(input.name, id ?? null)
  if (clash) throw new Error(`A pack called “${input.name}” already exists`)
  for (const r of input.reports) {
    if (r.kind === 'saved' && !db.prepare('SELECT 1 FROM saved_reports WHERE id = ?').get(r.id)) throw new Error('A saved report in the pack no longer exists')
  }
  return db.transaction((): ReportPack => {
    const cols = [input.name, JSON.stringify(input.reports), input.periodRule, input.frequency, JSON.stringify(input.formats), input.outputDir, input.active ? 1 : 0]
    if (id) {
      const before = getPack(db, id)
      db.prepare(
        "UPDATE report_packs SET name = ?, reports_json = ?, period_rule = ?, frequency = ?, formats_json = ?, output_dir = ?, active = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(...cols, id)
      const after = getPack(db, id)
      writeAudit(db, 'report_pack', id, 'update', before, after)
      return after
    }
    const res = db
      .prepare('INSERT INTO report_packs (name, reports_json, period_rule, frequency, formats_json, output_dir, active) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(...cols)
    const created = getPack(db, Number(res.lastInsertRowid))
    writeAudit(db, 'report_pack', created.id, 'create', null, created)
    return created
  })()
}

export function deletePack(db: DB, id: number): void {
  const before = getPack(db, id)
  db.prepare('DELETE FROM report_packs WHERE id = ?').run(id)
  writeAudit(db, 'report_pack', id, 'delete', before, null)
}

interface RunRow {
  id: number; pack_id: number; trigger: 'schedule' | 'manual'; started_at: string; finished_at: string | null
  period_from: string; period_to: string; status: PackRun['status']; output_dir: string | null; files_json: string; error: string | null
}

export function listRuns(db: DB, packId?: number, limit = 50): PackRun[] {
  const rows = (packId
    ? db.prepare('SELECT * FROM report_pack_runs WHERE pack_id = ? ORDER BY id DESC LIMIT ?').all(packId, limit)
    : db.prepare('SELECT * FROM report_pack_runs ORDER BY id DESC LIMIT ?').all(limit)) as RunRow[]
  return rows.map((r) => ({
    id: r.id, packId: r.pack_id, trigger: r.trigger, startedAt: r.started_at, finishedAt: r.finished_at,
    periodFrom: r.period_from, periodTo: r.period_to, status: r.status, outputDir: r.output_dir,
    files: JSON.parse(r.files_json) as string[], error: r.error
  }))
}

// ---------------------------------------------------------------- report tables

export interface PackTable {
  title: string
  filename: string
  columns: ReportColumnSpec[]
  rows: ReportRowSpec[]
  landscape: boolean
}

const money = (p: number): string => formatPaise(p, { zeroDash: true })

function flattenNodes(nodes: StatementNode[], depth: number, out: ReportRowSpec[]): void {
  for (const n of nodes) {
    out.push({ cells: [n.name, money(n.amount)], bold: n.kind !== 'ledger', indent: depth })
    if (n.children.length) flattenNodes(n.children, depth + 1, out)
  }
}

function builtinTable(db: DB, info: CompanyInfo, key: keyof typeof BUILTIN_PACK_REPORTS, range: DateRange, today: string): PackTable {
  const title = BUILTIN_PACK_REPORTS[key]
  const base = { title, filename: slugify(title), landscape: false }
  const two: ReportColumnSpec[] = [{ label: 'Particulars', align: 'l' }, { label: 'Amount', align: 'r' }]
  switch (key) {
    case 'trialBalance': {
      const tb = trialBalance(db, range.to)
      return {
        ...base,
        columns: [{ label: 'Ledger', align: 'l' }, { label: 'Group', align: 'l' }, { label: 'Debit', align: 'r' }, { label: 'Credit', align: 'r' }],
        rows: [
          ...tb.rows.map((r) => ({ cells: [r.ledgerName, r.groupName, money(r.debit), money(r.credit)] })),
          { cells: ['Total', '', money(tb.totalDebit), money(tb.totalCredit)], bold: true, rule: true }
        ]
      }
    }
    case 'profitLoss': {
      const p = profitAndLoss(db, range.from, range.to)
      const rows: ReportRowSpec[] = [{ cells: ['Incomes', ''], bold: true }]
      flattenNodes(p.tradingIncomes, 1, rows)
      if (p.closingStock) rows.push({ cells: ['Closing stock', money(p.closingStock)], indent: 1 })
      rows.push({ cells: ['Expenses', ''], bold: true })
      if (p.openingStock) rows.push({ cells: ['Opening stock', money(p.openingStock)], indent: 1 })
      flattenNodes(p.tradingExpenses, 1, rows)
      rows.push({ cells: [p.grossProfit >= 0 ? 'Gross profit' : 'Gross loss', money(Math.abs(p.grossProfit))], bold: true, rule: true })
      rows.push({ cells: ['Indirect incomes', ''], bold: true })
      flattenNodes(p.indirectIncomes, 1, rows)
      rows.push({ cells: ['Indirect expenses', ''], bold: true })
      flattenNodes(p.indirectExpenses, 1, rows)
      rows.push({ cells: [p.netProfit >= 0 ? 'Net profit for the period' : 'Net loss for the period', money(Math.abs(p.netProfit))], bold: true, rule: true })
      return { ...base, columns: two, rows }
    }
    case 'balanceSheet': {
      const b = balanceSheet(db, `${info.booksFrom}-04-01`, range.to)
      const rows: ReportRowSpec[] = [{ cells: ['Liabilities', ''], bold: true }]
      flattenNodes(b.liabilities, 1, rows)
      rows.push({ cells: ['Total liabilities', money(b.totalLiabilities)], bold: true, rule: true })
      rows.push({ cells: ['Assets', ''], bold: true })
      flattenNodes(b.assets, 1, rows)
      rows.push({ cells: ['Total assets', money(b.totalAssets)], bold: true, rule: true })
      return { ...base, columns: two, rows }
    }
    case 'receivables':
    case 'payables': {
      const parties = outstandings(db, key === 'receivables' ? 'receivable' : 'payable', range.to)
      const tot = parties.reduce((s, p) => s + p.pending, 0)
      return {
        ...base,
        landscape: true,
        columns: [
          { label: 'Party', align: 'l' }, { label: '0–30 days', align: 'r' }, { label: '31–60', align: 'r' },
          { label: '61–90', align: 'r' }, { label: '90+', align: 'r' }, { label: 'Pending', align: 'r' }
        ],
        rows: [
          ...parties.map((p) => ({ cells: [p.name, ...p.buckets.map(money), money(p.pending)] })),
          { cells: ['Total', ...[0, 1, 2, 3].map((i) => money(parties.reduce((s, p) => s + p.buckets[i]!, 0))), money(tot)], bold: true, rule: true }
        ]
      }
    }
    case 'gstSummary': {
      // Output and input tax are shown apart and netted — never added together.
      const run = (kinds: string[]) =>
        runReport(db, { source: 'accounts', measures: ['taxable', 'cgst', 'sgst', 'igst', 'cess', 'gst'], filters: { voucherKinds: kinds } }, { working: range, today, range }).totals.map((v) => v ?? 0)
      const out = run(['sales', 'credit_note'])
      const inp = run(['purchase', 'debit_note'])
      const net = out.map((v, i) => v - inp[i]!)
      return {
        ...base,
        landscape: true,
        columns: ['Particulars', 'Taxable value', 'CGST', 'SGST', 'IGST', 'Cess', 'GST total'].map((label, i) => ({ label, align: i === 0 ? 'l' : 'r' })) as ReportColumnSpec[],
        rows: [
          { cells: ['Output tax (sales less credit notes)', ...out.map(money)] },
          { cells: ['Input tax (purchases less debit notes)', ...inp.map(money)] },
          { cells: ['Net tax (output − input)', '', ...net.slice(1).map(money)], bold: true, rule: true }
        ]
      }
    }
    case 'ratios': {
      const r = ratioReport(db, range.from, range.to)
      return {
        ...base,
        landscape: true,
        columns: [{ label: 'Ratio', align: 'l' }, { label: 'Value', align: 'r' }, { label: 'Formula', align: 'l' }],
        rows: RATIO_CATEGORIES.flatMap((c) => [
          { cells: [c.label, '', ''], bold: true },
          ...RATIO_DEFS.filter((d) => d.category === c.id).map((d) => ({ cells: [d.label, formatRatio(r.period.ratios[d.key], d.unit), d.formula], indent: 1 }))
        ])
      }
    }
    case 'dayBook': {
      const rows = dayBook(db, range.from, range.to)
      return {
        ...base,
        landscape: true,
        columns: [
          { label: 'Date', align: 'l' }, { label: 'Type', align: 'l' }, { label: 'No.', align: 'l' }, { label: 'Account', align: 'l' },
          { label: 'Debit', align: 'r' }, { label: 'Credit', align: 'r' }
        ],
        rows: [
          ...rows.map((r) => ({ cells: [toDisplayDate(r.date), r.voucherType, r.number, r.account, money(r.debit), money(r.credit)] })),
          { cells: ['Total', '', '', '', money(rows.reduce((s, r) => s + r.debit, 0)), money(rows.reduce((s, r) => s + r.credit, 0))], bold: true, rule: true }
        ]
      }
    }
  }
}

function tableFromFlat(base: Omit<PackTable, 'columns' | 'rows'>, flat: ReturnType<typeof flattenResult>): PackTable {
  return {
    ...base,
    landscape: base.landscape || flat.header.length > 5,
    columns: flat.header.map((label, i) => ({ label: (label || ' ').slice(0, 60), align: flat.align[i] ?? 'l' })),
    rows: flat.rows.map((cells, i) => ({ cells, ...(i === flat.totalRow ? { bold: true, rule: true } : {}) }))
  }
}

/** The table for one pack entry over `range`. */
export function packTable(db: DB, info: CompanyInfo, ref: PackReportRef, range: DateRange, today: string): PackTable {
  if (ref.kind === 'builtin') return builtinTable(db, info, ref.key, range, today)
  const saved = getSavedReport(db, ref.id)
  if (!saved.model) throw new Error(`“${saved.name}” can’t run: ${saved.problem}`)
  const result = runReport(db, saved.model, { working: range, today, range })
  return tableFromFlat({ title: saved.name, filename: slugify(saved.name), landscape: false }, flattenResult(result, saved.model.pivot))
}

// ---------------------------------------------------------------- running

export interface RunPackOptions {
  trigger: 'schedule' | 'manual'
  now?: Date
  renderPdf: RenderPdf
}

const localToday = (now: Date): string => {
  const d = now
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Render one pack for its period rule into its folder; logs the run and audits it. */
export async function runPack(db: DB, slug: string, info: CompanyInfo, packId: number, opts: RunPackOptions): Promise<PackRun> {
  const pack = getPack(db, packId)
  const now = opts.now ?? new Date()
  const today = opts.now ? localToday(now) : todayISO()
  const range = relativePeriod(pack.periodRule, today)
  const root = pack.outputDir ?? join(companyExportsDir(slug), 'packs')
  const dir = join(root, slugify(pack.name), `${range.from}_${range.to}`)
  const startedAt = now.toISOString()
  const files: string[] = []
  const errors: string[] = []
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    errors.push(`Folder: ${(err as Error).message}`)
  }
  if (errors.length === 0) {
    const periodLabel = `${toDisplayDate(range.from)} to ${toDisplayDate(range.to)}`
    const used = new Set<string>()
    for (const [i, ref] of pack.reports.entries()) {
      // Let the event loop breathe between reports — a pack must never freeze the app.
      await yieldToEventLoop()
      try {
        const t = packTable(db, info, ref, range, today)
        let base = `${String(i + 1).padStart(2, '0')}-${t.filename || 'report'}`
        while (used.has(base)) base += '-x'
        used.add(base)
        if (pack.formats.includes('csv')) {
          const path = join(dir, `${base}.csv`)
          writeFileSync(path, rowsToCsv(t.columns.map((c) => c.label), t.rows.map((r) => r.cells)), 'utf8')
          files.push(path)
        }
        if (pack.formats.includes('xlsx')) {
          const path = join(dir, `${base}.xlsx`)
          writeXlsxFile(path, [displayTableToSheet({ title: t.title, columns: t.columns, rows: t.rows }, [info.name, t.title, periodLabel])])
          files.push(path)
        }
        if (pack.formats.includes('pdf')) {
          const html = reportHtml({ title: t.title, company: info, periodLabel, columns: t.columns, rows: t.rows, footNote: `Report pack “${pack.name}”` })
          const path = join(dir, `${base}.pdf`)
          writeFileSync(path, await opts.renderPdf(html, { landscape: t.landscape }))
          files.push(path)
        }
      } catch (err) {
        errors.push(`${ref.kind === 'builtin' ? BUILTIN_PACK_REPORTS[ref.key] : `Saved report #${ref.id}`}: ${(err as Error).message}`)
      }
    }
  }
  const status: PackRun['status'] = errors.length === 0 ? 'ok' : files.length > 0 ? 'partial' : 'failed'
  const finishedAt = new Date().toISOString()
  const res = db
    .prepare(
      `INSERT INTO report_pack_runs (pack_id, trigger, started_at, finished_at, period_from, period_to, status, output_dir, files_json, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(pack.id, opts.trigger, startedAt, finishedAt, range.from, range.to, status, dir, JSON.stringify(files), errors.length ? errors.join('\n') : null)
  // The schedule moves on even after a failed run — the run log shows the failure, and a failing
  // pack must not retry on every open.
  db.prepare('UPDATE report_packs SET last_run_at = ? WHERE id = ?').run(startedAt, pack.id)
  const audit = (): void => writeAudit(db, 'report_pack', pack.id, 'export', null, {
    pack: pack.name, trigger: opts.trigger, period: range, status, files: files.map((f) => f.split(/[\\/]/).pop())
  })
  if (opts.trigger === 'schedule') runAsAuditUser(SYSTEM_AUDIT_USER, audit)
  else audit()
  return listRuns(db, pack.id, 1).find((r) => r.id === Number(res.lastInsertRowid))!
}

/** Every active pack that is due at `now`, run once each, in name order. */
export async function runDuePacks(db: DB, slug: string, info: CompanyInfo, opts: Omit<RunPackOptions, 'trigger'>): Promise<PackRun[]> {
  const now = opts.now ?? new Date()
  const runs: PackRun[] = []
  for (const pack of listPacks(db)) {
    if (!packDue(pack, now)) continue
    await yieldToEventLoop()
    runs.push(await runPack(db, slug, info, pack.id, { ...opts, trigger: 'schedule', now }))
  }
  return runs
}
