/**
 * Reports written to a folder on a timer.
 *
 * There is no daemon. The app is offline and only runs when someone opens it, so a schedule is a
 * standing instruction that is honoured on the next company open — `runDue` is called from the
 * open path, and the screen says so in as many words. Pretending otherwise would mean a user
 * believing a monthly trial balance was landing in a synced folder while the laptop was shut.
 *
 * A missed run is not replayed. `next_run` rolls forward from the day the run actually happens,
 * so three weeks away produces one current report rather than twenty-one stale ones — and the
 * period each report covers is resolved against the run date, not against the date it was due.
 */

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import {
  dueSchedules,
  nextRunAfter,
  scheduleFilename,
  schedulePeriod,
  SCHEDULE_REPORT_LABELS,
  type ScheduleFormat,
  type ScheduleFrequency,
  type SchedulePeriodKind,
  type ScheduleReport
} from '@shared/reportSchedule'
import { fyFromStartYear } from '@shared/dates'
import { buildSpreadsheet } from '@shared/spreadsheet'
import { companyExportsDir } from '../paths'
import { writeAudit } from './audit'
import { renderScheduledReport, toCsv, toPdfColumns, toPdfRows, toXlsSheet } from './reportRender'
import { reportHtml, needsLandscape } from './reportHtml'
import { writeExportPdf } from './pdf'

export interface ReportScheduleInput {
  report: ScheduleReport
  periodKind: SchedulePeriodKind
  format: ScheduleFormat
  frequency: ScheduleFrequency
  /** Absolute path, or null for the company's own exports folder. */
  folder: string | null
  nextRun: string
  active: boolean
}

export interface ReportSchedule extends ReportScheduleInput {
  id: number
  label: string
  lastRun: string | null
  lastPath: string | null
  lastError: string | null
}

interface ScheduleRow {
  id: number
  report: string
  period_kind: string
  format: string
  frequency: string
  folder: string | null
  next_run: string
  last_run: string | null
  last_path: string | null
  last_error: string | null
  active: number
}

function mapRow(r: ScheduleRow): ReportSchedule {
  return {
    id: r.id,
    report: r.report as ScheduleReport,
    periodKind: r.period_kind as SchedulePeriodKind,
    format: r.format as ScheduleFormat,
    frequency: r.frequency as ScheduleFrequency,
    folder: r.folder,
    nextRun: r.next_run,
    lastRun: r.last_run,
    lastPath: r.last_path,
    lastError: r.last_error,
    active: !!r.active,
    label: SCHEDULE_REPORT_LABELS[r.report as ScheduleReport] ?? r.report
  }
}

export function listSchedules(db: DB): ReportSchedule[] {
  return (db.prepare('SELECT * FROM report_schedules ORDER BY next_run, id').all() as ScheduleRow[]).map(mapRow)
}

export function saveSchedule(db: DB, input: ReportScheduleInput, id?: number): ReportSchedule {
  if (id) {
    const existing = db.prepare('SELECT * FROM report_schedules WHERE id = ?').get(id) as ScheduleRow | undefined
    if (!existing) throw new Error('Schedule not found')
    db.prepare(
      `UPDATE report_schedules
       SET report = ?, period_kind = ?, format = ?, frequency = ?, folder = ?, next_run = ?, active = ?
       WHERE id = ?`
    ).run(input.report, input.periodKind, input.format, input.frequency, input.folder, input.nextRun, input.active ? 1 : 0, id)
    const updated = mapRow(db.prepare('SELECT * FROM report_schedules WHERE id = ?').get(id) as ScheduleRow)
    writeAudit(db, 'report_schedule', id, 'update', mapRow(existing), updated)
    return updated
  }
  const res = db
    .prepare(
      `INSERT INTO report_schedules (report, period_kind, format, frequency, folder, next_run, active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(input.report, input.periodKind, input.format, input.frequency, input.folder, input.nextRun, input.active ? 1 : 0)
  const created = mapRow(db.prepare('SELECT * FROM report_schedules WHERE id = ?').get(res.lastInsertRowid) as ScheduleRow)
  writeAudit(db, 'report_schedule', created.id, 'create', null, created)
  return created
}

export function deleteSchedule(db: DB, id: number): void {
  const existing = db.prepare('SELECT * FROM report_schedules WHERE id = ?').get(id) as ScheduleRow | undefined
  if (!existing) throw new Error('Schedule not found')
  db.prepare('DELETE FROM report_schedules WHERE id = ?').run(id)
  writeAudit(db, 'report_schedule', id, 'delete', mapRow(existing), null)
}

function targetDir(slug: string, folder: string | null): string {
  const dir = folder ?? companyExportsDir(slug)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export interface ScheduleRunResult {
  id: number
  report: string
  period: { from: string; to: string }
  path: string | null
  error: string | null
}

/**
 * Run one schedule now, whether or not it is due — the "Run now" button, and the body of the
 * catch-up loop. PDF rendering is asynchronous (it drives a hidden BrowserWindow), so the whole
 * thing is; CSV and the spreadsheet are written synchronously inside it.
 */
export async function runSchedule(
  db: DB,
  company: CompanyInfo,
  slug: string,
  schedule: ReportSchedule,
  runDate: string
): Promise<ScheduleRunResult> {
  const period = schedulePeriod(schedule.periodKind, runDate)
  const booksFrom = fyFromStartYear(company.booksFrom).from
  const base = scheduleFilename(schedule.report, period)

  try {
    const rendered = renderScheduledReport(db, schedule.report, period, booksFrom, company)
    let path: string
    if (schedule.format === 'pdf') {
      const html = reportHtml({
        title: rendered.title,
        company,
        periodLabel: rendered.periodLabel,
        columns: toPdfColumns(rendered),
        rows: toPdfRows(rendered),
        footNote: rendered.footNote
      })
      // Written into the company's exports folder by writeExportPdf, then copied out if the
      // schedule points somewhere else — the PDF writer owns its own destination.
      path = await writeExportPdf(slug, `${base}.pdf`, html, {
        pageSize: 'A4',
        landscape: needsLandscape(rendered.columns.length),
        pageNumbers: true,
        runningHead: { company: company.name, gstin: company.gstin, title: rendered.title, periodLabel: rendered.periodLabel }
      })
      if (schedule.folder) {
        const dest = join(targetDir(slug, schedule.folder), `${base}.pdf`)
        copyFileSync(path, dest)
        path = dest
      }
    } else {
      const dir = targetDir(slug, schedule.folder)
      const ext = schedule.format === 'xls' ? 'xls' : 'csv'
      path = join(dir, `${base}.${ext}`)
      // The BOM is not decoration: Excel on Windows reads a CSV without one as the local
      // codepage, and a party called "Śrī Traders" arrives as mojibake.
      const body = schedule.format === 'xls' ? buildSpreadsheet([toXlsSheet(rendered)]) : '﻿' + toCsv(rendered)
      writeFileSync(path, body, 'utf8')
    }

    db.prepare('UPDATE report_schedules SET last_run = ?, last_path = ?, last_error = NULL, next_run = ? WHERE id = ?').run(
      runDate,
      path,
      nextRunAfter(schedule.frequency, runDate),
      schedule.id
    )
    return { id: schedule.id, report: schedule.report, period, path, error: null }
  } catch (err) {
    const message = (err as Error).message
    // The schedule still moves on. A schedule that retries a broken report on every open would
    // block the open path forever, and the error is recorded where the user can read it.
    db.prepare('UPDATE report_schedules SET last_run = ?, last_error = ?, next_run = ? WHERE id = ?').run(
      runDate,
      message,
      nextRunAfter(schedule.frequency, runDate),
      schedule.id
    )
    return { id: schedule.id, report: schedule.report, period, path: null, error: message }
  }
}

/** Every schedule that has come due, run once each. Called on company open. */
export async function runDue(db: DB, company: CompanyInfo, slug: string, today: string): Promise<ScheduleRunResult[]> {
  const results: ScheduleRunResult[] = []
  for (const schedule of dueSchedules(listSchedules(db), today)) {
    results.push(await runSchedule(db, company, slug, schedule, today))
  }
  return results
}
