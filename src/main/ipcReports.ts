// IPC channels for the report builder, saved reports, comparatives, ratios and scheduled report
// packs (WP 6.1 / 6.2). Registered from ipc.ts with its `handle` (role gate + { ok, data | error }
// envelope); every payload is Zod-parsed here. Write channels are mapped in auditCoverage.ts.
import { dialog, shell } from 'electron'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import type { DB } from './db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { Role } from './services/roles'
import { isoDate } from '@shared/schemas'
import { modelJsonEnvelope, parseModelJson, reportModelSchema } from '@shared/reportBuilder/model'
import { packInputSchema } from '@shared/reportBuilder/packs'
import { todayISO } from '@shared/dates'
import { companyExportsDir, slugify } from './paths'
import * as rb from './services/reportBuilder'
import * as analytics from './services/reportAnalytics'
import * as packs from './services/reportPacks'
import { writeAudit } from './services/audit'
import { renderPackPdf } from './packScheduler'

type Handle = (channel: string, fn: (payload: unknown) => unknown, minRole?: Role) => void
interface Company { db: DB; info: CompanyInfo; slug: string }

const idSchema = z.object({ id: z.number().int().positive() })
const rangeSchema = z.object({ from: isoDate, to: isoDate }).refine((r) => r.from <= r.to, 'from must be on or before to')

export function registerReportsIpc(handle: Handle, company: () => Company, userName: () => string | null): void {
  const db = (): DB => company().db

  // ---------- report builder ----------
  handle('rb:run', (p) => {
    const q = z.object({ model: z.unknown(), working: rangeSchema, today: isoDate.optional() }).parse(p)
    const model = reportModelSchema.parse(q.model)
    return rb.runReport(db(), model, { working: q.working, today: q.today ?? todayISO() })
  }, 'viewer')
  handle('rb:list', () => rb.listSavedReports(db()), 'viewer')
  handle('rb:get', (p) => rb.getSavedReport(db(), idSchema.parse(p).id), 'viewer')
  handle('rb:users', () =>
    (db().prepare("SELECT DISTINCT user_name AS u FROM audit_log WHERE entity = 'voucher' AND action = 'create' AND user_name IS NOT NULL ORDER BY u").all() as { u: string }[]).map((r) => r.u),
  'viewer')
  handle('rb:save', (p) => {
    const q = z
      .object({ id: z.number().int().positive().optional(), name: z.string().trim().min(1).max(80), model: z.unknown(), pinned: z.boolean().optional() })
      .parse(p)
    return rb.saveReport(db(), { name: q.name, model: reportModelSchema.parse(q.model), pinned: q.pinned }, q.id, userName())
  })
  handle('rb:rename', (p) => {
    const q = z.object({ id: z.number().int().positive(), name: z.string().trim().min(1).max(80) }).parse(p)
    return rb.renameReport(db(), q.id, q.name)
  })
  handle('rb:pin', (p) => {
    const q = z.object({ id: z.number().int().positive(), pinned: z.boolean() }).parse(p)
    return rb.setReportPinned(db(), q.id, q.pinned)
  })
  handle('rb:duplicate', (p) => rb.duplicateReport(db(), idSchema.parse(p).id, userName()))
  handle('rb:delete', (p) => {
    rb.deleteReport(db(), idSchema.parse(p).id)
    return null
  })
  handle('rb:import', (p) => {
    const q = z.object({ json: z.string().min(2).max(200_000), name: z.string().trim().min(1).max(80).optional() }).parse(p)
    const parsed = parseModelJson(q.json)
    if (!parsed.ok) throw new Error(`Can’t import: ${parsed.error}`)
    const name = q.name ?? parsed.name ?? 'Imported report'
    const free = db().prepare('SELECT 1 FROM saved_reports WHERE name = ? COLLATE NOCASE').get(name) ? rb.nextCopyName(db(), name) : name
    return rb.saveReport(db(), { name: free, model: parsed.model, pinned: false }, undefined, userName())
  })
  handle('rb:exportJson', (p) => {
    const c = company()
    const saved = rb.getSavedReport(c.db, idSchema.parse(p).id)
    if (!saved.model) throw new Error(`“${saved.name}” can’t be shared: ${saved.problem}`)
    const json = modelJsonEnvelope(saved.name, saved.model)
    const path = join(companyExportsDir(c.slug), `${slugify(saved.name) || 'report'}.report.json`)
    writeFileSync(path, json, 'utf8')
    writeAudit(c.db, 'export', 0, 'export', null, { kind: 'report_json', report: saved.name, path })
    return { path, json }
  }, 'viewer')

  // ---------- comparatives + ratios ----------
  handle('report:comparative', (p) => {
    const q = z.object({ kind: z.enum(['pnl', 'bs']), from: isoDate, to: isoDate }).parse(p)
    const c = company()
    return q.kind === 'pnl' ? analytics.comparativePnl(c.db, q.from, q.to) : analytics.comparativeBs(c.db, `${c.info.booksFrom}-04-01`, q.from, q.to)
  }, 'viewer')
  handle('report:budgetAmounts', (p) => {
    const q = z.object({ budgetId: z.number().int().positive(), from: isoDate, to: isoDate }).parse(p)
    return analytics.budgetAmounts(db(), q.budgetId, q.from, q.to)
  }, 'viewer')
  handle('report:ratios', (p) => {
    const q = rangeSchema.parse(p)
    return analytics.ratioReport(db(), q.from, q.to)
  }, 'viewer')

  // ---------- scheduled packs ----------
  handle('pack:list', () => packs.listPacks(db()), 'viewer')
  handle('pack:runs', (p) => {
    const q = z.object({ packId: z.number().int().positive().optional() }).default({}).parse(p ?? {})
    return packs.listRuns(db(), q.packId)
  }, 'viewer')
  handle('pack:save', (p) => {
    const q = z.object({ id: z.number().int().positive().optional(), data: packInputSchema }).parse(p)
    return packs.savePack(db(), q.data, q.id)
  })
  handle('pack:delete', (p) => {
    packs.deletePack(db(), idSchema.parse(p).id)
    return null
  })
  handle('pack:runNow', async (p) => {
    const c = company()
    return packs.runPack(c.db, c.slug, c.info, idSchema.parse(p).id, { trigger: 'manual', renderPdf: renderPackPdf })
  })
  handle('pack:chooseFolder', async () => {
    const picked = await dialog.showOpenDialog({ title: 'Folder for the report pack', properties: ['openDirectory', 'createDirectory'] })
    return picked.canceled || !picked.filePaths[0] ? null : picked.filePaths[0]
  })
  handle('pack:reveal', (p) => {
    const { runId } = z.object({ runId: z.number().int().positive() }).parse(p)
    const row = db().prepare('SELECT output_dir AS dir FROM report_pack_runs WHERE id = ?').get(runId) as { dir: string | null } | undefined
    if (!row?.dir) throw new Error('This run wrote no folder')
    void shell.openPath(row.dir)
    return null
  }, 'viewer')
}
