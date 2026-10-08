// IPC for WP 6.3 — Excel export of any table, the Books workbook export, and the import wizard
// (load a file → pick a profile + mapping → dry run → apply → undo), Busy XML, remembered
// mapping templates. Registered from ipc.ts with its `handle` (role gate + { ok, data | error }
// envelope); every payload is Zod-parsed here. File parsing lives in services/importFiles.ts.
import { app, dialog, shell } from 'electron'
import { readFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import type { DB } from './db/connection'
import { backupCompany } from './db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { Role } from './services/roles'
import { companyExportsDir } from './paths'
import { exportXlsxSchema } from '@shared/xlsx/schema'
import type { XlsxSheet } from '@shared/xlsx'
import { headerSignature, tableFrom } from '@shared/dataImport/detect'
import { profileById } from '@shared/dataImport/profiles'
import * as dataImport from './services/dataImport'
import { parseImportFile, planSteps, sheetSummary, tableSteps, type LoadedFile } from './services/importFiles'
import { buildBooksWorkbook } from './services/booksExport'
import { writeXlsxFile } from './services/xlsxFile'
import { writeAudit } from './services/audit'
import { readCompanyInfo } from './db/seed'

type Handle = (channel: string, fn: (payload: unknown) => unknown, minRole?: Role) => void
interface Company { db: DB; info: CompanyInfo; slug: string }
/** Session facts the import needs from ipc.ts: may this user change company details (books-from,
 *  owner-only like company:updateInfo), and who is importing (import_batches.created_by). */
interface SessionFacts { canChangeCompanyInfo: () => boolean; userName: () => string | null }

/** Files kept between the wizard's steps (the renderer only holds the token). */
const loaded = new Map<string, { file: LoadedFile; slug: string }>()

/** Drop every loaded file (called when the company closes — files never cross companies). */
export function clearLoadedImports(): void {
  loaded.clear()
}
const KEEP = 4

function remember(f: LoadedFile, slug: string): void {
  loaded.set(f.token, { file: f, slug })
  while (loaded.size > KEEP) loaded.delete(loaded.keys().next().value!)
}

function fileFor(token: string, slug: string): LoadedFile {
  const f = loaded.get(token)
  if (!f || f.slug !== slug) throw new Error('The file is no longer loaded — pick it again')
  return f.file
}

const optionsSchema = z.object({
  duplicate: z.enum(['skip', 'update', 'create']).default('skip'),
  createMissing: z.boolean().default(true),
  openingDifference: z.enum(['block', 'suspense', 'leave']).default('block'),
  dateOrder: z.enum(['dmy', 'mdy', 'ymd']).default('dmy'),
  decimalComma: z.boolean().default(false),
  bankLedgerId: z.number().int().positive().optional(),
  applyBooksFrom: z.boolean().default(true)
})

const loadSchema = z.object({
  fileName: z.string().max(260).optional(),
  csvText: z.string().max(100_000_000).optional(),
  xmlText: z.string().max(200_000_000).optional(),
  xlsxBase64: z.string().max(200_000_000).optional()
})

const tableRunSchema = z.object({
  token: z.string().uuid(),
  sheet: z.string().max(200),
  headerRow: z.number().int().min(0),
  profileId: z.string().max(60),
  mapping: z.record(z.string(), z.number().int().min(0).nullable()),
  options: optionsSchema.default({}),
  saveTemplate: z.object({ name: z.string().trim().min(1).max(80) }).nullable().optional()
})

const planRunSchema = z.object({ token: z.string().uuid(), options: optionsSchema.default({}) })

function planMeta(f: LoadedFile): dataImport.RunMeta {
  return { source: f.kind === 'books' ? 'total-books' : 'busy-xml', profileId: null, fileName: f.fileName }
}

export function registerDataImportIpc(handle: Handle, company: () => Company, session: SessionFacts): void {
  /** Run options from the wizard's + the session's facts. */
  const runOpts = (o: z.infer<typeof optionsSchema>, f: LoadedFile | null): Partial<dataImport.ImportOptions> => ({
    duplicate: o.duplicate, createMissing: o.createMissing, openingDifference: o.openingDifference, bankLedgerId: o.bankLedgerId,
    canSetBooksFrom: session.canChangeCompanyInfo(), userName: session.userName(),
    applyBooksFrom: f?.manifest && o.applyBooksFrom ? Number(f.manifest.booksFrom) || null : null,
    sourceNamespace: f?.manifest ? `${String(f.manifest.company)}|${String(f.manifest.gstin ?? '')}` : null,
    lockDate: f?.manifest && typeof f.manifest.lockDate === 'string' && f.manifest.lockDate ? f.manifest.lockDate : null
  })
  /** The run may have set books-from: keep the cached company info in step (company:updateInfo does the same). */
  const refresh = (c: Company, r: dataImport.ImportRunResult): dataImport.ImportRunResult => {
    if (r.booksFromSet !== null && !r.dryRun) c.info = readCompanyInfo(c.db)
    return r
  }
  // ---------- exports ----------
  handle('export:xlsx', (p) => {
    const { filename, sheets } = exportXlsxSchema.parse(p)
    const c = company()
    const path = join(companyExportsDir(c.slug), `${filename}.xlsx`)
    writeXlsxFile(path, sheets as XlsxSheet[])
    writeAudit(c.db, 'export', 0, 'export', null, { kind: 'xlsx', filename, path, rows: sheets.reduce((s, sh) => s + sh.rows.length, 0) })
    return { path }
  }, 'viewer')

  handle('export:books', (p) => {
    const { asOn, reveal } = z.object({ asOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), reveal: z.boolean().default(true) }).parse(p ?? {})
    const c = company()
    const { sheets, counts } = buildBooksWorkbook(c.db, c.info, app.getVersion(), asOn)
    const path = join(companyExportsDir(c.slug), `books-${c.slug}-${new Date().toISOString().slice(0, 10)}.xlsx`)
    writeXlsxFile(path, sheets)
    writeAudit(c.db, 'export', 0, 'export', null, { kind: 'books_xlsx', path, counts })
    if (reveal) shell.showItemInFolder(path)
    return { path, counts }
  })

  // ---------- wizard: load ----------
  handle('importwiz:load', async (p) => {
    const q = loadSchema.parse(p ?? {})
    const c = company()
    let fileName = q.fileName ?? 'import'
    let bytes: Uint8Array
    if (q.xlsxBase64 !== undefined) bytes = new Uint8Array(Buffer.from(q.xlsxBase64, 'base64'))
    else if (q.csvText !== undefined) bytes = new TextEncoder().encode(q.csvText)
    else if (q.xmlText !== undefined) bytes = new TextEncoder().encode(q.xmlText)
    else {
      const picked = await dialog.showOpenDialog({
        title: 'Choose a file to import',
        filters: [
          { name: 'Spreadsheets and exports', extensions: ['xlsx', 'xlsm', 'csv', 'tsv', 'txt', 'xml', 'dat'] },
          { name: 'All files', extensions: ['*'] }
        ],
        properties: ['openFile']
      })
      if (picked.canceled || !picked.filePaths[0]) return null
      fileName = picked.filePaths[0].split(/[\\/]/).pop()!
      bytes = new Uint8Array(readFileSync(picked.filePaths[0]))
    }
    const f = parseImportFile(fileName, bytes)
    remember(f, c.slug)
    const busy = f.busy
    return {
      token: f.token,
      fileName: f.fileName,
      kind: f.kind,
      manifest: f.manifest,
      busy: busy
        ? { groups: busy.groups.length, ledgers: busy.ledgers.length, units: busy.units.length, godowns: busy.godowns.length, items: busy.items.length, vouchers: busy.vouchers.length, warnings: busy.warnings }
        : null,
      sheets: f.kind === 'table' ? f.sheets.map((s) => sheetSummary(c.db, s)) : f.sheets.map((s) => ({ name: s.name, rowCount: Math.max(0, s.grid.rows.length - 1) }))
    }
  })

  /** Re-read a sheet with another header row (the user corrected the detection). */
  handle('importwiz:sheet', (p) => {
    const q = z.object({ token: z.string().uuid(), sheet: z.string(), headerRow: z.number().int().min(0).optional() }).parse(p)
    const f = fileFor(q.token, company().slug)
    const s = f.sheets.find((x) => x.name === q.sheet)
    if (!s) throw new Error(`Sheet "${q.sheet}" not found`)
    return sheetSummary(company().db, s, q.headerRow)
  }, 'viewer')

  // ---------- wizard: preview (dry run) / run ----------
  const steps = (q: z.infer<typeof tableRunSchema>, c: Company, f: LoadedFile): ReturnType<typeof tableSteps> =>
    tableSteps(f, { sheet: q.sheet, headerRow: q.headerRow, profileId: q.profileId, mapping: q.mapping, dateOrder: q.options.dateOrder, decimalComma: q.options.decimalComma }, c.info.stateCode)

  handle('importwiz:preview', (p) => {
    const q = tableRunSchema.parse(p)
    const c = company()
    const f = fileFor(q.token, c.slug)
    const { steps: plan, profile } = steps(q, c, f)
    return dataImport.runImport(c.db, plan, runOpts(q.options, null), { source: profile.source, profileId: profile.id, fileName: f.fileName }, true)
  })

  handle('importwiz:run', async (p) => {
    const q = tableRunSchema.parse(p)
    const c = company()
    const f = fileFor(q.token, c.slug)
    const { steps: plan, profile } = steps(q, c, f)
    if (q.saveTemplate) {
      const table = tableFrom(f.sheets.find((s) => s.name === q.sheet)!.grid, q.headerRow)
      const byName: Record<string, string | null> = {}
      for (const [k, v] of Object.entries(q.mapping)) byName[k] = v === null ? null : (table.headers[v] ?? null)
      dataImport.saveTemplate(c.db, {
        name: q.saveTemplate.name, profileId: profile.id, target: profile.target, headerSignature: headerSignature(table.headers),
        mapping: byName, options: { duplicate: q.options.duplicate, createMissing: q.options.createMissing, dateOrder: q.options.dateOrder, headerRow: q.headerRow }
      })
    }
    await backupCompany(c.db, c.slug, 'pre-import')
    return dataImport.runImport(c.db, plan, runOpts(q.options, null), { source: profile.source, profileId: profile.id, fileName: f.fileName }, false)
  })

  handle('importwiz:planPreview', (p) => {
    const q = planRunSchema.parse(p)
    const c = company()
    const f = fileFor(q.token, c.slug)
    return dataImport.runImport(c.db, planSteps(f), runOpts(q.options, f), planMeta(f), true)
  })

  handle('importwiz:planRun', async (p) => {
    const q = planRunSchema.parse(p)
    const c = company()
    const f = fileFor(q.token, c.slug)
    await backupCompany(c.db, c.slug, 'pre-import')
    return refresh(c, dataImport.runImport(c.db, planSteps(f), runOpts(q.options, f), planMeta(f), false))
  })

  // ---------- history / undo ----------
  handle('importwiz:batches', () => dataImport.listBatches(company().db), 'viewer')
  handle('importwiz:undo', async (p) => {
    const { batchId } = z.object({ batchId: z.number().int().positive() }).parse(p)
    const c = company()
    await backupCompany(c.db, c.slug, 'pre-import-undo')
    return dataImport.undoImport(c.db, batchId)
  })

  // ---------- templates ----------
  handle('importwiz:templates', (p) => {
    const q = z.object({ profileId: z.string().optional(), headerSignature: z.string().optional() }).parse(p ?? {})
    return dataImport.listTemplates(company().db, q)
  }, 'viewer')
  handle('importwiz:templateSave', (p) => {
    const q = z.object({
      name: z.string().trim().min(1).max(80), profileId: z.string().max(60), headers: z.array(z.string()).max(1000),
      mapping: z.record(z.string(), z.number().int().min(0).nullable()), options: z.record(z.string(), z.unknown()).default({})
    }).parse(p)
    const profile = profileById(q.profileId)
    if (!profile) throw new Error(`Unknown import profile ${q.profileId}`)
    const byName: Record<string, string | null> = {}
    for (const [k, v] of Object.entries(q.mapping)) byName[k] = v === null ? null : (q.headers[v] ?? null)
    return dataImport.saveTemplate(company().db, { name: q.name, profileId: profile.id, target: profile.target, headerSignature: headerSignature(q.headers), mapping: byName, options: q.options })
  })
  handle('importwiz:templateDelete', (p) => {
    dataImport.deleteTemplate(company().db, z.object({ id: z.number().int().positive() }).parse(p).id)
    return null
  })

  /** A blank workbook with the profile's columns — the "download a template" link. */
  handle('importwiz:sample', (p) => {
    const { profileId } = z.object({ profileId: z.string() }).parse(p)
    const profile = profileById(profileId)
    if (!profile) throw new Error(`Unknown import profile ${profileId}`)
    const c = company()
    const path = join(companyExportsDir(c.slug), `import-template-${profile.id.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.xlsx`)
    writeXlsxFile(path, [{ name: profile.label, columns: profile.fields.map((fd) => ({ header: fd.label, kind: 'text' as const, width: Math.max(12, fd.label.length + 2) })), rows: [] }])
    writeAudit(c.db, 'export', 0, 'export', null, { kind: 'import_template', profile: profile.id, path })
    shell.showItemInFolder(path)
    return { path }
  })
}
