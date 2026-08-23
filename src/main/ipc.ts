import { app, dialog, ipcMain, Notification, shell } from 'electron'
import { readFileSync, writeFileSync, copyFileSync, rmSync, unlinkSync, mkdtempSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, basename } from 'path'
import { z } from 'zod'
import Database from 'better-sqlite3'
import type { DB } from './db/connection'
import { backupCompany, closeCompanyDb, openCompanyDb } from './db/connection'
import { listBackupsIn, restoreCompanyDb, rollbackRestore, snapshotSync, backupStamp, runWeeklyIntegrityCheck, type BackupInfo } from './db/backup'
import { checkIntegrity } from './db/integrity'
import { encryptFile, decryptFile } from './db/crypt'
import { readCompanyInfo, seedCompany, writeCompanyInfo } from './db/seed'
import { readRegistry, removeCompany, touchLastOpened, upsertCompany } from './registry'
import { companyBackupsDir, companyDbPath, companyDir, companyExportsDir, ensureCompanyTree, slugify } from './paths'
import { log, recentLogLines, revealLogs } from './log'
import { checkForUpdatesInteractive } from './updater'
import {
  backupFileSchema, bankRuleInputSchema, batchInputSchema, billsOpenSchema, budgetInputSchema, budgetVarianceSchema, ccStatementSchema,
  chequeConfigSchema, companyCreateSchema, consolidatedRunSchema, costCentreInputSchema, exportCsvSchema, godownInputSchema, groupInputSchema, gst3bManualSchema, gstr2bSchema,
  isoDate, ledgerInputSchema, notifyDeadlinesSchema, passphraseSchema, periodSchema, priceLevelInputSchema, priceRateInputSchema, recurringInputSchema, rendererLogSchema, reportPdfSchema,
  searchGlobalSchema, stockGroupInputSchema, stockItemInputSchema, stockQuerySchema, tallyImportSchema, tdsExport26qSchema, tdsSectionInputSchema, tdsSuggestSchema,
  tdsSummarySchema, unitInputSchema, voucherInputSchema, voucherTransportSchema, voucherTypeInputSchema
} from '@shared/schemas'
import { todayISO } from '@shared/dates'
import { formatPaise } from '@shared/money'
import * as configSvc from './services/config'
import * as masters from './services/masters'
import * as vouchers from './services/vouchers'
import * as reports from './services/reports'
import * as gst from './services/gst'
import * as intel from './services/intel'
import * as analysis from './services/analysis'
import * as banking from './services/banking'
import * as edocs from './services/edocs'
import * as invoice from './services/invoice'
import * as cheque from './services/cheque'
import * as extras from './services/extras'
import * as payroll from './services/payroll'
import * as nic from './services/nic'
import * as tds from './services/tds'
import * as costCentres from './services/costCentres'
import * as stockAnalysis from './services/stockAnalysis'
import * as priceLevels from './services/priceLevels'
import * as budgets from './services/budgets'
import * as recurring from './services/recurring'
import * as yearEnd from './services/yearEnd'
import { importTallyXml, dryRunTallyXml } from './services/tallyImport'
import * as importer from './services/importers'
import * as agentBridge from './services/agentBridge'
import { agentBridgeConfigSchema, agentExportSchema } from '@shared/schemas'
import * as consolidated from './services/consolidated'
import * as caPack from './services/caPack'
import { writeExportPdf } from './services/pdf'
import { reportHtml } from './services/reportHtml'
import { globalSearch } from './services/search'
import { createDemoCompany } from './services/demo'
import { setAuditContext, writeAudit, listAudit, pruneAudit } from './services/audit'
import * as users from './services/users'
import { assertDeleteAuthorized, auditCompanyDeletion } from './services/companyDelete'
import { roleAllows, type Role } from './services/roles'
import {
  bomInputSchema, currencyInputSchema, employeeInputSchema, nicCredentialsSchema, auditListSchema,
  userInputSchema, authLoginSchema, payHeadInputSchema, employeeHeadsSetSchema, payrollRunIdSchema,
  auditRetentionSchema, invoicePdfBatchSchema
} from '@shared/schemas'
import type { CompanyInfo } from '@shared/domain'
import { featuresSchema } from '@shared/features'
import { invoiceConfigPartialSchema, invoiceConfigSchema } from '@shared/invoiceConfig'
import { PERIODS } from '@shared/period'

export interface OpenCompany {
  slug: string
  db: DB
  info: CompanyInfo
  /** Cached usersExist(db) — recomputed only on open and after users:save/deactivate, so ordinary
   *  IPC calls (the vast majority) never pay for a COUNT query just to check the role gate. */
  usersExist: boolean
}

let current: OpenCompany | null = null

/** Paths the Tally-import file dialog has actually issued this session. A `filePath` supplied in
 *  a tally:import payload must be one of these — otherwise the renderer could pass any path on
 *  disk and have it read straight into the app (arbitrary file read). The dryRun -> apply wizard
 *  flow still works: dryRun's dialog pick adds the path here, and apply's payload just needs to
 *  echo that same path back. The `xmlText` inline path (used by drivers/tests) is unaffected. */
const dialogIssuedTallyPaths = new Set<string>()

/** The signed-in user for the currently-open company, or null before login / after logout.
 *  Cleared whenever the company itself closes (see closeCurrentCompany). */
let sessionUser: { id: number; name: string; role: Role } | null = null

function requireCompany(): OpenCompany {
  if (!current) throw new Error('No company is open')
  return current
}

/** Accessor for the currently-open company, used by the backup scheduler (backup-scheduler.ts). */
export function getCurrentCompany(): OpenCompany | null {
  return current
}

/** Move a file into place. Copy+delete rather than fs.renameSync, since the source (os.tmpdir())
 *  and destination (~/Documents/total) may be on different filesystems (EXDEV). */
function renameFile(src: string, dest: string): void {
  rmSync(dest, { force: true })
  copyFileSync(src, dest)
  unlinkSync(src)
}

export function closeCurrentCompany(): void {
  // Stop the inbox watcher + any pending mirror refresh before the handle closes under them.
  agentBridge.syncInboxWatcher(null)
  if (current) {
    closeCompanyDb(current.db)
    current = null
  }
  sessionUser = null
}

type Handler = (payload: unknown) => unknown | Promise<unknown>

/** Channels reachable before a company is open, or otherwise never role-gated: the company
 *  picker, the auth flow itself (you have to be able to call auth:login before you're "in"),
 *  logging, and the encrypted-backup import dialog. Everything else is gated by `handle`'s
 *  `minRole` — but only once a company is open AND that company actually has users (see below). */
const UNGATED_CHANNELS = new Set([
  'company:list',
  'company:create',
  'company:createDemo',
  'company:delete',
  'company:open',
  'company:current',
  // Deliberate: a locked session (or one with no session at all) must still be able to back
  // out to the company picker rather than getting stuck behind the gate it can't pass.
  'company:close',
  'auth:users',
  'auth:login',
  'auth:logout',
  'auth:current',
  'log:renderer',
  'log:reveal',
  'log:diagnostics',
  'backup:importEncrypted',
  'app:info'
])

function handle(channel: string, fn: Handler, minRole: Role = 'accountant'): void {
  ipcMain.handle(`total:${channel}`, async (_event, payload: unknown) => {
    try {
      // Role gating is a no-op until a company is open AND that company has at least one user
      // (usersExist is cached on `current` — see OpenCompany — to avoid a COUNT query per call).
      // A brand-new company with zero users is intentionally wide open: that's how the very
      // first (owner) user gets created via users:save without a chicken-and-egg deadlock.
      if (!UNGATED_CHANNELS.has(channel) && current && current.usersExist) {
        if (!sessionUser) {
          // Distinct from the role-denied case below: the renderer can route this specifically
          // to the lock screen instead of a generic permission toast.
          throw new Error('Locked — sign in first')
        }
        if (!roleAllows(sessionUser.role, minRole)) {
          throw new Error('You do not have permission to do that')
        }
      }
      return { ok: true, data: await fn(payload) }
    } catch (err) {
      const message = err instanceof z.ZodError
        ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
        : err instanceof Error
          ? err.message
          : String(err)
      // Never log payloads — only the channel name and the error message.
      log('error', 'ipc-handler', { channel, error: message })
      return { ok: false, error: message }
    }
  })
}

const idSchema = z.object({ id: z.number().int().positive() })
const withIdSchema = <T extends z.ZodTypeAny>(schema: T) => z.object({ id: z.number().int().positive(), data: schema })

/** [lane-Q audit] one-line summary audit row for every file-export handler (task Q1 #90). */
const auditExport = (db: DB, kind: string, detail: Record<string, unknown>): void =>
  writeAudit(db, 'export', 0, 'export', null, { kind, ...detail })

export function registerIpc(): void {
  setAuditContext({ appVersion: app.getVersion(), getUserName: () => sessionUser?.name ?? null })

  // ---------- company ----------
  handle('company:list', () => readRegistry())

  handle('company:create', (payload) => {
    const input = companyCreateSchema.parse(payload)
    let slug = slugify(input.name)
    let n = 2
    while (existsSync(companyDbPath(slug))) slug = `${slugify(input.name)}-${n++}`
    ensureCompanyTree(slug)
    const db = openCompanyDb(slug)
    const info: CompanyInfo = { ...input }
    seedCompany(db, info)
    db.close()
    upsertCompany({ slug, name: input.name, stateCode: input.stateCode, gstin: input.gstin, lastOpenedAt: null })
    return { slug }
  })

  handle('company:createDemo', () => createDemoCompany())

  handle('company:delete', (payload) => {
    const { slug, confirmName, pin } = z
      .object({
        slug: z.string().min(1),
        confirmName: z.string(),
        pin: z.string().regex(/^\d{4,12}$/, 'PIN must be 4-12 digits').optional()
      })
      .parse(payload)
    const reg = readRegistry()
    const company = reg.companies.find((c) => c.slug === slug)
    if (!company) throw new Error('Company not found')
    if (confirmName !== company.name) throw new Error('Company name does not match')
    // The name check above protects nothing by itself — it's readable off the same screen it's
    // typed into. If this company has users, an active owner's PIN is required too.
    assertDeleteAuthorized(companyDbPath(slug), pin)
    // [lane-Q audit] durable record in the app log (survives the rmSync) + best-effort tombstone
    // row inside the DB itself.
    auditCompanyDeletion(companyDbPath(slug), slug, sessionUser?.name ?? null)
    log('warn', 'company-deleted', { slug, user: sessionUser?.name ?? null })
    if (current?.slug === slug) closeCurrentCompany()
    rmSync(companyDir(slug), { recursive: true, force: true })
    removeCompany(slug)
    return null
  })

  handle('company:open', async (payload) => {
    const { slug } = z.object({ slug: z.string().min(1) }).parse(payload)
    if (!existsSync(companyDbPath(slug))) throw new Error('Company database not found')
    closeCurrentCompany()
    const db = openCompanyDb(slug)
    const info = readCompanyInfo(db)
    current = { slug, db, info, usersExist: users.usersExist(db) }
    // Online backup needs an open handle, so this runs after open (not before, as it used to).
    // A backup failure here must never fail — or desync — the open itself.
    try {
      await backupCompany(db, slug, 'open')
    } catch (err) {
      log('warn', 'backup-on-open-failed', { slug, error: err instanceof Error ? err.message : String(err) })
    }
    const integrity = checkIntegrity(db)
    if (!integrity.ok) {
      log('warn', 'integrity', { slug, quickCheck: integrity.quickCheck, unbalanced: integrity.unbalancedVoucherIds })
    }
    // [lane-Q] scheduled weekly FULL integrity check (task Q3 #99) — the check above is the cheap
    // quick_check; this one is `PRAGMA integrity_check`, throttled to once per 7 days via meta.
    const weekly = runWeeklyIntegrityCheck(db)
    if (weekly.ran && !weekly.ok) {
      log('warn', 'integrity-weekly-failed', { slug, detail: weekly.detail })
    }
    try {
      const purged = vouchers.purgeOldDeleted(db, 30)
      if (purged > 0) log('info', 'bin-purge', { purged })
    } catch (err) {
      // e.g. an over-age binned voucher still referenced by payroll_runs — housekeeping must
      // never block opening the company.
      log('warn', 'bin-purge-failed', { slug, error: err instanceof Error ? err.message : String(err) })
    }
    // Post-dated vouchers whose date has arrived flip into the books (audited per voucher).
    // PDCs dated inside a locked period are refused, not silently posted — they stay in the
    // PDC register until the lock is lifted (v0.3 review F3).
    const { matured, blockedByLock } = vouchers.maturePostDated(db, todayISO())
    if (matured.length > 0) log('info', 'pdc-mature', { count: matured.length, ids: matured })
    if (blockedByLock.length > 0) {
      log('warn', 'pdc-mature-blocked-by-lock', { count: blockedByLock.length, ids: blockedByLock })
    }
    // [lane-Q audit] retention: prune audit rows older than the configured window (default: keep
    // forever — getAuditKeepDays returns null and nothing is pruned).
    const auditKeepDays = configSvc.getAuditKeepDays(db)
    if (auditKeepDays !== null) {
      const prunedAudit = pruneAudit(db, auditKeepDays)
      if (prunedAudit > 0) log('info', 'audit-prune', { pruned: prunedAudit, keepDays: auditKeepDays })
    }
    touchLastOpened(slug)
    // Agent bridge (feature flag, default OFF): watch <company>/inbox/ for dropped files.
    if (configSvc.getAgentBridgeEnabled(db)) agentBridge.syncInboxWatcher({ slug, db })
    return { slug, info, integrity, locked: current.usersExist }
  })

  handle('company:close', () => {
    closeCurrentCompany()
    return null
  })

  handle('company:current', () =>
    current
      ? { slug: current.slug, info: current.info, locked: current.usersExist && !sessionUser }
      : null
  )

  handle('company:updateInfo', (payload) => {
    const c = requireCompany()
    const before = c.info
    const input = companyCreateSchema.parse(payload)
    const info: CompanyInfo = { ...input }
    writeCompanyInfo(c.db, info)
    c.info = info
    upsertCompany({ slug: c.slug, name: info.name, stateCode: info.stateCode, gstin: info.gstin, lastOpenedAt: new Date().toISOString() })
    writeAudit(c.db, 'company', 0, 'update', before, info)
    return info
  }, 'owner')

  const runManualBackup = async (): Promise<{ path: string }> => {
    const c = requireCompany()
    return { path: await backupCompany(c.db, c.slug, 'manual') }
  }
  // 'company:backup' is kept as an alias of 'backup:run' for existing callers.
  handle('company:backup', runManualBackup)

  handle('company:revealExports', () => {
    const c = requireCompany()
    shell.openPath(companyExportsDir(c.slug))
    return null
  })

  handle('company:lock:get', () => ({ date: vouchers.getLockDate(requireCompany().db) }), 'viewer')
  handle('company:lock:set', (payload) => {
    const { date } = z.object({ date: isoDate.nullable() }).parse(payload)
    vouchers.setLockDate(requireCompany().db, date)
    return { date }
  }, 'owner')

  // ---------- year-end close ----------
  const fyStartYearSchema = z.object({ fyStartYear: z.number().int().min(1990).max(2100) })
  handle('yearend:preview', (p) => {
    const { fyStartYear } = fyStartYearSchema.parse(p)
    return yearEnd.closePreview(requireCompany().db, fyStartYear)
  }, 'viewer')
  handle('yearend:close', (p) => {
    const { fyStartYear } = fyStartYearSchema.parse(p)
    const c = requireCompany()
    return yearEnd.postClose(c.db, c.info, fyStartYear)
  }, 'owner')

  // ---------- backups: list/run/restore + encrypted export/import ----------
  handle('backup:list', (): BackupInfo[] => {
    const c = requireCompany()
    return listBackupsIn(companyBackupsDir(c.slug))
  }, 'viewer')

  handle('backup:run', runManualBackup)

  handle('backup:restore', async (payload) => {
    const { file } = z.object({ file: backupFileSchema }).parse(payload)
    const c = requireCompany()
    const { slug } = c
    const backupPath = join(companyBackupsDir(slug), file)
    const dbPath = companyDbPath(slug)

    // Validates the chosen backup (quick_check + shape), takes a pre-restore safety snapshot,
    // and atomically swaps it into place. Throws — leaving the live DB completely untouched —
    // if the backup fails validation. `current`/`c.db` are still fully intact at that point,
    // since we haven't closed anything yet.
    const { preRestoreSnapshotPath } = restoreCompanyDb(c.db, dbPath, backupPath, companyBackupsDir(slug))

    closeCurrentCompany()
    const reopen = (): OpenCompany => {
      const db = openCompanyDb(slug) // migrates if the backup predates the current schema
      const info = readCompanyInfo(db)
      return { slug, db, info, usersExist: users.usersExist(db) }
    }

    try {
      current = reopen()
    } catch (err) {
      // The swap already happened on disk, but the result won't open (e.g. a corrupted or
      // incompatible backup that still passed quick_check). Roll back to the pre-restore
      // snapshot so the app is never left with no company open and no path back.
      const message = err instanceof Error ? err.message : String(err)
      log('error', 'backup-restore-reopen-failed', { slug, error: message })
      try {
        rollbackRestore(dbPath, preRestoreSnapshotPath)
        current = reopen()
      } catch (rollbackErr) {
        current = null
        const rollbackMessage = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
        log('error', 'backup-restore-rollback-failed', { slug, error: rollbackMessage })
        // Distinct from the happy-rollback message below — that one is a true statement only
        // when the rollback actually succeeded. Here it didn't: the live DB is not usable and
        // there is no company open, but the pre-restore snapshot this function took before
        // touching anything is still sitting in the backups folder, untouched.
        throw new Error(
          `Restore failed and automatic rollback also failed — this company may be unavailable. ` +
            `A pre-restore snapshot exists in the backups folder (${basename(preRestoreSnapshotPath)}); ` +
            `reopen or restore it manually.`
        )
      }
      throw new Error(`Restore failed and was rolled back to the pre-restore snapshot: ${message}`)
    }

    try {
      touchLastOpened(slug)
    } catch {
      // Best-effort — the restore itself already succeeded regardless of this.
    }
    const integrity = checkIntegrity(current.db)
    if (!integrity.ok) {
      log('warn', 'integrity', { slug, quickCheck: integrity.quickCheck, unbalanced: integrity.unbalancedVoucherIds })
    }
    // closeCurrentCompany() above already cleared sessionUser, so this is realistically always
    // `current.usersExist` — spelled out in full to match the other two locked-flag call sites.
    return { info: current.info, integrity, locked: current.usersExist && !sessionUser }
  }, 'owner')

  handle('backup:exportEncrypted', async (payload) => {
    const { passphrase } = z.object({ passphrase: passphraseSchema }).parse(payload)
    const c = requireCompany()
    const tempPath = join(companyExportsDir(c.slug), `.export-tmp-${backupStamp()}.db`)
    snapshotSync(c.db, tempPath)
    const destPath = join(companyExportsDir(c.slug), `total-${c.slug}-${backupStamp()}.totalbak`)
    try {
      await encryptFile(tempPath, destPath, passphrase)
    } finally {
      unlinkSync(tempPath)
    }
    auditExport(c.db, 'encrypted_backup', { path: destPath })
    shell.showItemInFolder(destPath)
    return { path: destPath }
  }, 'owner')

  // No requireCompany() — importing an encrypted backup works with no company open.
  handle('backup:importEncrypted', async (payload) => {
    const { passphrase } = z.object({ passphrase: passphraseSchema }).parse(payload)
    const picked = await dialog.showOpenDialog({
      title: 'Choose a Total encrypted backup',
      filters: [{ name: 'Total backup', extensions: ['totalbak'] }],
      properties: ['openFile']
    })
    if (picked.canceled || !picked.filePaths[0]) return null

    const tempDir = mkdtempSync(join(tmpdir(), 'total-import-'))
    const tempDbPath = join(tempDir, 'restored.db')
    try {
      await decryptFile(picked.filePaths[0], tempDbPath, passphrase)
    } catch {
      throw new Error('Wrong passphrase or corrupted file')
    }

    let info: CompanyInfo
    try {
      const check = new Database(tempDbPath, { readonly: true })
      try {
        const result = check.pragma('quick_check') as Array<{ quick_check: string }>
        if (result[0]?.quick_check !== 'ok') throw new Error('bad')
        info = readCompanyInfo(check)
      } finally {
        check.close()
      }
    } catch {
      throw new Error("This file doesn't look like a Total company backup")
    }

    let slug = slugify(info.name)
    let n = 2
    while (existsSync(companyDbPath(slug))) slug = `${slugify(info.name)}-${n++}`
    ensureCompanyTree(slug)

    const dbPath = companyDbPath(slug)
    try {
      renameFile(tempDbPath, dbPath)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }

    upsertCompany({ slug, name: info.name, stateCode: info.stateCode, gstin: info.gstin, lastOpenedAt: new Date().toISOString() })
    return { slug, name: info.name }
  })

  // ---------- masters ----------
  handle('master:groups:list', () => masters.listGroups(requireCompany().db), 'viewer')
  handle('master:groups:tree', () => masters.groupTree(requireCompany().db), 'viewer')
  handle('master:groups:create', (p) => masters.createGroup(requireCompany().db, groupInputSchema.parse(p)))
  handle('master:groups:update', (p) => {
    const { id, data } = withIdSchema(groupInputSchema).parse(p)
    return masters.updateGroup(requireCompany().db, id, data)
  })
  handle('master:groups:delete', (p) => masters.deleteGroup(requireCompany().db, idSchema.parse(p).id))

  handle('master:ledgers:list', () => masters.listLedgers(requireCompany().db), 'viewer')
  handle('master:ledgers:create', (p) => masters.createLedger(requireCompany().db, ledgerInputSchema.parse(p)))
  handle('master:ledgers:update', (p) => {
    const { id, data } = withIdSchema(ledgerInputSchema).parse(p)
    return masters.updateLedger(requireCompany().db, id, data)
  })
  handle('master:ledgers:delete', (p) => masters.deleteLedger(requireCompany().db, idSchema.parse(p).id))
  handle('master:ledgerBalances', (p) => {
    const { asOn } = z.object({ asOn: z.string() }).parse(p)
    return masters.ledgerBalances(requireCompany().db, asOn)
  }, 'viewer')

  handle('master:voucherTypes:list', () => masters.listVoucherTypes(requireCompany().db), 'viewer')
  handle('master:voucherTypes:create', (p) => masters.createVoucherType(requireCompany().db, voucherTypeInputSchema.parse(p)))
  handle('master:voucherTypes:update', (p) => {
    const { id, data } = withIdSchema(voucherTypeInputSchema).parse(p)
    return masters.updateVoucherType(requireCompany().db, id, data)
  })

  handle('master:units:list', () => masters.listUnits(requireCompany().db), 'viewer')
  handle('master:units:create', (p) => masters.createUnit(requireCompany().db, unitInputSchema.parse(p)))
  handle('master:stockGroups:list', () => masters.listStockGroups(requireCompany().db), 'viewer')
  handle('master:stockGroups:create', (p) => masters.createStockGroup(requireCompany().db, stockGroupInputSchema.parse(p)))
  handle('master:stockItems:list', () => masters.listStockItems(requireCompany().db), 'viewer')
  handle('master:stockItems:create', (p) => masters.createStockItem(requireCompany().db, stockItemInputSchema.parse(p)))
  handle('master:stockItems:update', (p) => {
    const { id, data } = withIdSchema(stockItemInputSchema).parse(p)
    return masters.updateStockItem(requireCompany().db, id, data)
  })
  handle('master:stockItems:delete', (p) => masters.deleteStockItem(requireCompany().db, idSchema.parse(p).id))
  handle('master:godowns:list', () => masters.listGodowns(requireCompany().db), 'viewer')
  handle('master:godowns:create', (p) => masters.createGodown(requireCompany().db, godownInputSchema.parse(p)))

  // ---------- inventory depth (lane I): godown CRUD, batches, stock analysis ----------
  handle('master:godowns:update', (p) => {
    const { id, data } = withIdSchema(godownInputSchema).parse(p)
    return masters.updateGodown(requireCompany().db, id, data)
  })
  handle('master:godowns:delete', (p) => masters.deleteGodown(requireCompany().db, idSchema.parse(p).id))
  handle('master:batches:list', (p) => {
    const { stockItemId } = z.object({ stockItemId: z.number().int().positive().optional() }).default({}).parse(p ?? {})
    return masters.listBatches(requireCompany().db, stockItemId)
  }, 'viewer')
  handle('master:batches:create', (p) => masters.createBatch(requireCompany().db, batchInputSchema.parse(p)))
  handle('stock:summary', (p) => {
    const { asOn, godownId } = stockQuerySchema.parse(p)
    return stockAnalysis.stockSummary(requireCompany().db, asOn, { godownId })
  }, 'viewer')
  handle('stock:byGodown', (p) => {
    const { asOn } = stockQuerySchema.parse(p)
    return stockAnalysis.stockByGodown(requireCompany().db, asOn)
  }, 'viewer')
  handle('stock:batches', (p) => {
    const { asOn, stockItemId } = z.object({ asOn: isoDate, stockItemId: z.number().int().positive().optional() }).parse(p)
    return stockAnalysis.batchStock(requireCompany().db, asOn, stockItemId)
  }, 'viewer')
  handle('stock:expiry', (p) => {
    const { asOn } = stockQuerySchema.parse(p)
    return stockAnalysis.expiryAgeing(requireCompany().db, asOn)
  }, 'viewer')
  handle('stock:negative', (p) => {
    const { asOn } = stockQuerySchema.parse(p)
    return stockAnalysis.negativeStock(requireCompany().db, asOn)
  }, 'viewer')
  handle('master:priceLevels:list', () => priceLevels.listPriceLevels(requireCompany().db), 'viewer')
  handle('master:priceLevels:create', (p) => priceLevels.savePriceLevel(requireCompany().db, priceLevelInputSchema.parse(p)))
  handle('master:priceLevels:update', (p) => {
    const { id, data } = withIdSchema(priceLevelInputSchema).parse(p)
    return priceLevels.savePriceLevel(requireCompany().db, data, id)
  })
  handle('master:priceLevels:delete', (p) => priceLevels.deletePriceLevel(requireCompany().db, idSchema.parse(p).id))
  handle('priceLevels:rates', (p) => {
    const { priceLevelId } = z.object({ priceLevelId: z.number().int().positive() }).parse(p)
    return priceLevels.listRates(requireCompany().db, priceLevelId)
  }, 'viewer')
  handle('priceLevels:saveRate', (p) => priceLevels.saveRate(requireCompany().db, priceRateInputSchema.parse(p)))
  handle('priceLevels:deleteRate', (p) => priceLevels.deleteRate(requireCompany().db, idSchema.parse(p).id))
  handle('priceLevels:rateFor', (p) => {
    const q = z.object({ priceLevelId: z.number().int().positive(), stockItemId: z.number().int().positive(), date: isoDate }).parse(p)
    return priceLevels.rateFor(requireCompany().db, q.priceLevelId, q.stockItemId, q.date)
  }, 'viewer')
  handle('pdc:list', () => vouchers.pdcRegister(requireCompany().db), 'viewer')
  handle('pdc:mature', (p) => {
    vouchers.maturePdcNow(requireCompany().db, idSchema.parse(p).id)
    return null
  })

  // ---------- search ----------
  handle('search:global', (p) => globalSearch(requireCompany().db, searchGlobalSchema.parse(p).q), 'viewer')

  // ---------- vouchers ----------
  handle('voucher:list', (p) => {
    const { from, to, voucherTypeId } = periodSchema.extend({ voucherTypeId: z.number().int().positive().optional() }).parse(p)
    return vouchers.listVouchers(requireCompany().db, from, to, voucherTypeId)
  }, 'viewer')
  handle('voucher:get', (p) => vouchers.getVoucher(requireCompany().db, idSchema.parse(p).id), 'viewer')
  handle('voucher:save', (p) => {
    const { data, id } = z.object({ data: voucherInputSchema, id: z.number().int().positive().optional() }).parse(p)
    const c = requireCompany()
    const saved = vouchers.saveVoucher(c.db, data, id)
    // Agent mirror stays fresh while the flag is on — debounced so entry bursts export once.
    if (configSvc.getAgentBridgeEnabled(c.db)) agentBridge.scheduleMirrorRefresh(c.db, c.slug)
    return saved
  })
  handle('voucher:delete', (p) => vouchers.deleteVoucher(requireCompany().db, idSchema.parse(p).id))
  handle('voucher:bin', () => vouchers.listBin(requireCompany().db), 'viewer')
  handle('voucher:restore', (p) => vouchers.restoreVoucher(requireCompany().db, idSchema.parse(p).id))
  handle('voucher:purge', (p) => vouchers.purgeVoucher(requireCompany().db, idSchema.parse(p).id), 'owner')
  handle('voucher:nextNumber', (p) => {
    const { voucherTypeId, date, excludeId } = z
      .object({ voucherTypeId: z.number().int().positive(), date: z.string(), excludeId: z.number().int().positive().optional() })
      .parse(p)
    return { number: vouchers.nextVoucherNumber(requireCompany().db, voucherTypeId, date, excludeId) }
  })
  handle('voucher:numberExists', (p) => {
    const { voucherTypeId, number, excludeId } = z
      .object({
        voucherTypeId: z.number().int().positive(),
        number: z.string().trim().min(1).max(40),
        excludeId: z.number().int().positive().optional()
      })
      .parse(p)
    return vouchers.voucherNumberExists(requireCompany().db, voucherTypeId, number, excludeId)
  })
  handle('voucher:duplicates', (p) => {
    const { data, excludeId } = z.object({ data: voucherInputSchema, excludeId: z.number().int().positive().optional() }).parse(p)
    return vouchers.findDuplicates(requireCompany().db, data, excludeId)
  })

  // ---------- reports ----------
  handle('report:dayBook', (p) => {
    const { from, to, includeOutOfBooks } = periodSchema
      .extend({ includeOutOfBooks: z.boolean().optional() })
      .parse(p)
    return reports.dayBook(requireCompany().db, from, to, { includeOutOfBooks })
  }, 'viewer')
  handle('report:ledger', (p) => {
    const { ledgerId, from, to, groupBy } = periodSchema
      .extend({ ledgerId: z.number().int().positive(), groupBy: z.enum(PERIODS).optional() })
      .parse(p)
    return reports.ledgerStatement(requireCompany().db, ledgerId, from, to, groupBy)
  }, 'viewer')
  handle('report:trialBalance', (p) => {
    const { asOn } = z.object({ asOn: z.string() }).parse(p)
    return reports.trialBalance(requireCompany().db, asOn)
  }, 'viewer')
  handle('report:profitLoss', (p) => {
    const { from, to, comparePrior } = periodSchema.extend({ comparePrior: z.boolean().optional() }).parse(p)
    return reports.profitAndLoss(requireCompany().db, from, to, comparePrior ? { comparePrior } : undefined)
  }, 'viewer')
  handle('report:balanceSheet', (p) => {
    const { asOn, comparePrior } = z.object({ asOn: z.string(), comparePrior: z.boolean().optional() }).parse(p)
    const c = requireCompany()
    return reports.balanceSheet(c.db, `${c.info.booksFrom}-04-01`, asOn, comparePrior)
  }, 'viewer')
  handle('report:stockSummary', (p) => {
    const { asOn } = z.object({ asOn: z.string() }).parse(p)
    return reports.stockSummary(requireCompany().db, asOn)
  }, 'viewer')
  handle('report:dashboard', (p) => {
    const { today, fyFrom } = z.object({ today: z.string(), fyFrom: z.string() }).parse(p)
    return reports.dashboard(requireCompany().db, today, fyFrom)
  }, 'viewer')
  handle('report:cashFlow', (p) => {
    const { from, to } = periodSchema.parse(p)
    return reports.cashFlow(requireCompany().db, from, to)
  }, 'viewer')
  handle('report:stockAgeing', (p) => {
    const { asOn } = z.object({ asOn: z.string() }).parse(p)
    return reports.stockAgeing(requireCompany().db, asOn)
  }, 'viewer')
  handle('report:itemProfitability', (p) => {
    const { from, to } = periodSchema.parse(p)
    return reports.itemProfitability(requireCompany().db, from, to)
  }, 'viewer')
  handle('report:exceptions', (p) => {
    const { from, to } = periodSchema.parse(p)
    return reports.exceptions(requireCompany().db, from, to)
  }, 'viewer')

  // ---------- consolidated (multi-company, read-only) ----------
  handle('consol:run', (p) => {
    const { slugs, kind, from, to } = consolidatedRunSchema.parse(p)
    return consolidated.consolidated(slugs, kind, from, to)
  }, 'viewer')

  // ---------- gst ----------
  const gstPeriodInput = periodSchema.extend({ period: z.string().regex(/^\d{6}$/) })
  handle('gst:gstr1', (p) => {
    const { from, to, period } = gstPeriodInput.parse(p)
    const c = requireCompany()
    return gst.gstr1(c.db, c.info, from, to, period)
  }, 'viewer')
  handle('gst:gstr3b', (p) => {
    const { from, to, period } = gstPeriodInput.parse(p)
    const c = requireCompany()
    return gst.gstr3b(c.db, c.info, from, to, period)
  }, 'viewer')
  handle('gst:exportGstr1', (p) => {
    const { from, to, period } = gstPeriodInput.parse(p)
    const c = requireCompany()
    // Server-side export gate (G7): blocking validation issues refuse the export outright —
    // the renderer disables the button too, but the gate must hold for any caller.
    gst.assertExportable(c.db, c.info, from, to)
    const result = gst.gstr1(c.db, c.info, from, to, period)
    const jsonPath = gst.exportReturnJson(c.slug, 'gstr1', period, result.json)
    const csvPath = gst.exportGstr1Csv(c.slug, result)
    auditExport(c.db, 'gstr1', { period, path: jsonPath })
    shell.showItemInFolder(jsonPath)
    return { jsonPath, csvPath }
  })
  // ---------- gst rebuild (lane G): validation panel + 3B manual adjustments ----------
  handle('gst:validate', (p) => {
    const { from, to } = periodSchema.parse(p)
    const c = requireCompany()
    const issues = gst.gstValidate(c.db, c.info, from, to)
    const roundOff = edocs.einvoiceRoundOffIssues(c.db, c.info, from, to)
    return { issues, roundOff }
  }, 'viewer')
  handle('gst:3bManualGet', (p) => {
    const { period } = z.object({ period: z.string().regex(/^\d{6}$/) }).parse(p)
    return configSvc.getGst3bManual(requireCompany().db, period)
  }, 'viewer')
  handle('gst:3bManualSet', (p) => {
    const { period, data } = z.object({ period: z.string().regex(/^\d{6}$/), data: gst3bManualSchema }).parse(p)
    return configSvc.setGst3bManual(requireCompany().db, period, data)
  })
  handle('gst:exportGstr3b', (p) => {
    const { from, to, period } = gstPeriodInput.parse(p)
    const c = requireCompany()
    // Same server-side gate as gst:exportGstr1 — 3B is computed from the same extracted
    // documents, so a period with blocking validation issues must not export either return.
    gst.assertExportable(c.db, c.info, from, to)
    const result = gst.gstr3b(c.db, c.info, from, to, period)
    const jsonPath = gst.exportReturnJson(c.slug, 'gstr3b', period, result.json)
    auditExport(c.db, 'gstr3b', { period, path: jsonPath })
    shell.showItemInFolder(jsonPath)
    return { jsonPath }
  })
  handle('gst:recon2b', (p) => {
    const { jsonText, from, to } = gstr2bSchema.parse(p)
    return gst.recon2b(requireCompany().db, jsonText, from, to)
  }, 'viewer')
  handle('gst:recon2bPickFile', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Choose a GSTR-2B JSON (downloaded from the GST portal)',
      filters: [{ name: 'GSTR-2B JSON', extensions: ['json'] }],
      properties: ['openFile']
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    const jsonText = readFileSync(picked.filePaths[0], 'utf8')
    return { jsonText, fileName: picked.filePaths[0].split('/').pop() ?? 'gstr2b.json' }
  }, 'viewer')

  // ---------- analysis ----------
  handle('analysis:register', (p) => {
    const { kind, from, to, groupBy } = periodSchema
      .extend({ kind: z.enum(['sales', 'purchase']), groupBy: z.enum(PERIODS).optional() })
      .parse(p)
    return analysis.registerByPeriod(requireCompany().db, kind, from, to, groupBy)
  }, 'viewer')
  handle('analysis:outstandings', (p) => {
    const { side, asOn } = z.object({ side: z.enum(['receivable', 'payable']), asOn: z.string() }).parse(p)
    return analysis.outstandings(requireCompany().db, side, asOn)
  }, 'viewer')

  // ---------- outstanding bills (party picker for receipt/payment "settle against") ----------
  handle('bills:open', (p) => {
    const { partyLedgerId, asOn } = billsOpenSchema.parse(p)
    return analysis.openBills(requireCompany().db, partyLedgerId, asOn)
  }, 'viewer')

  // ---------- TDS ----------
  handle('tds:sections', () => tds.listSections(requireCompany().db), 'viewer')
  handle('tds:sectionSave', (p) => tds.saveSection(requireCompany().db, tdsSectionInputSchema.parse(p)), 'owner')
  handle('tds:suggest', (p) => {
    const { partyLedgerId, base, date } = tdsSuggestSchema.parse(p)
    return tds.tdsSuggestion(requireCompany().db, partyLedgerId, base, date)
  })
  handle('tds:summary', (p) => {
    const { fyStartYear } = tdsSummarySchema.parse(p)
    return tds.tdsSummary(requireCompany().db, fyStartYear)
  }, 'viewer')
  handle('tds:export26q', (p) => {
    const { fyStartYear, quarter } = tdsExport26qSchema.parse(p)
    const c = requireCompany()
    const path = tds.export26qCsv(c.db, c.info, c.slug, fyStartYear, quarter as 1 | 2 | 3 | 4)
    auditExport(c.db, 'tds_26q', { fyStartYear, quarter, path })
    shell.showItemInFolder(path)
    return { path }
  })

  // ---------- cost centres ----------
  handle('cc:list', () => costCentres.listCostCentres(requireCompany().db), 'viewer')
  handle('cc:save', (p) => {
    const { id, data } = z.object({ id: z.number().int().positive().optional(), data: costCentreInputSchema }).parse(p)
    return costCentres.saveCostCentre(requireCompany().db, data, id)
  })
  handle('cc:delete', (p) => costCentres.deleteCostCentre(requireCompany().db, idSchema.parse(p).id))
  handle('cc:report', (p) => {
    const { from, to } = periodSchema.parse(p)
    return costCentres.ccReport(requireCompany().db, from, to)
  }, 'viewer')
  handle('cc:statement', (p) => {
    const { ccId, from, to } = ccStatementSchema.parse(p)
    return costCentres.ccStatement(requireCompany().db, ccId, from, to)
  }, 'viewer')

  // ---------- budgets ----------
  handle('budget:list', () => budgets.listBudgets(requireCompany().db), 'viewer')
  handle('budget:save', (p) => {
    const { id, data } = z.object({ id: z.number().int().positive().optional(), data: budgetInputSchema }).parse(p)
    return budgets.saveBudget(requireCompany().db, data, id)
  })
  handle('budget:delete', (p) => budgets.deleteBudget(requireCompany().db, idSchema.parse(p).id))
  handle('budget:variance', (p) => {
    const { budgetId, upToMonth } = budgetVarianceSchema.parse(p)
    return budgets.budgetVarianceReport(requireCompany().db, budgetId, upToMonth)
  }, 'viewer')

  // ---------- recurring vouchers ----------
  handle('recurring:list', () => recurring.listTemplates(requireCompany().db), 'viewer')
  handle('recurring:save', (p) => {
    const { id, data } = z.object({ id: z.number().int().positive().optional(), data: recurringInputSchema }).parse(p)
    return recurring.saveTemplate(requireCompany().db, data, id)
  })
  handle('recurring:delete', (p) => recurring.deleteTemplate(requireCompany().db, idSchema.parse(p).id))
  handle('recurring:due', (p) => {
    const { today } = z.object({ today: isoDate }).parse(p)
    return recurring.due(requireCompany().db, today)
  }, 'viewer')
  handle('recurring:post', (p) => {
    const { id, date } = z.object({ id: z.number().int().positive(), date: isoDate }).parse(p)
    return recurring.postFromTemplate(requireCompany().db, id, date)
  })
  handle('recurring:skip', (p) => recurring.skip(requireCompany().db, idSchema.parse(p).id))

  // ---------- banking ----------
  handle('bank:ledgers', () => banking.bankLedgers(requireCompany().db), 'viewer')
  handle('bank:recon', (p) => {
    const { ledgerId, from, to } = periodSchema.extend({ ledgerId: z.number().int().positive() }).parse(p)
    return banking.bankRecon(requireCompany().db, ledgerId, from, to)
  }, 'viewer')
  handle('bank:setBankDate', (p) => {
    const { lineId, bankDate } = z.object({ lineId: z.number().int().positive(), bankDate: z.string().nullable() }).parse(p)
    banking.setBankDate(requireCompany().db, lineId, bankDate)
    return null
  })
  handle('bank:importCsv', async (p) => {
    const { ledgerId, csvText, dryRun } = z
      .object({ ledgerId: z.number().int().positive(), csvText: z.string().optional(), dryRun: z.boolean().optional() })
      .parse(p)
    const c = requireCompany()
    let csv = csvText
    if (csv === undefined) {
      const picked = await dialog.showOpenDialog({
        title: 'Choose bank statement CSV',
        filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }],
        properties: ['openFile']
      })
      if (picked.canceled || !picked.filePaths[0]) return null
      csv = readFileSync(picked.filePaths[0], 'utf8')
    }
    // csvText rides back on the response (not just the parsed result) so the renderer — which
    // never sees the picked file's contents when the dialog path is used — can hand the exact
    // same text to banking:suggest (or back to an applying import after a dryRun preview).
    return { ...banking.importStatement(c.db, ledgerId, csv, { apply: !dryRun }), csvText: csv }
  })
  handle('bankrule:list', () => banking.listRules(requireCompany().db), 'viewer')
  handle('bankrule:save', (p) => {
    const { id, data } = z.object({ id: z.number().int().positive().optional(), data: bankRuleInputSchema }).parse(p)
    return banking.saveRule(requireCompany().db, data, id)
  })
  handle('bankrule:delete', (p) => {
    banking.deleteRule(requireCompany().db, idSchema.parse(p).id)
    return null
  })
  handle('bankrule:hit', (p) => {
    banking.recordRuleHit(requireCompany().db, idSchema.parse(p).id)
    return null
  })
  handle('banking:suggest', (p) => {
    const { ledgerId, csvText } = z.object({ ledgerId: z.number().int().positive(), csvText: z.string() }).parse(p)
    return banking.suggestVouchers(requireCompany().db, ledgerId, csvText)
  })
  // statement matching v2 — read-only tolerance/many-to-one suggestions (task Y2)
  handle('banking:matchSuggestions', (p) => {
    const { ledgerId, csvText, tolerancePaise } = z
      .object({
        ledgerId: z.number().int().positive(),
        csvText: z.string(),
        tolerancePaise: z.number().int().min(0).max(100_00).optional()
      })
      .parse(p)
    return banking.matchSuggestions(requireCompany().db, ledgerId, csvText, tolerancePaise ?? 100)
  }, 'viewer')
  // bank reconciliation statement (task Y2)
  const brsSchema = z.object({ ledgerId: z.number().int().positive(), asOn: isoDate })
  handle('banking:brs', (p) => {
    const { ledgerId, asOn } = brsSchema.parse(p)
    return banking.brs(requireCompany().db, ledgerId, asOn)
  }, 'viewer')
  handle('banking:brsPdf', async (p) => {
    const { ledgerId, asOn } = brsSchema.parse(p)
    const c = requireCompany()
    const r = banking.brs(c.db, ledgerId, asOn)
    const money = (paise: number): string => formatPaise(paise)
    const item = (i: banking.BrsItem): { cells: string[]; indent?: number } => ({
      cells: [i.date, `${i.voucherType} ${i.number}`, i.instrumentNo ?? '', i.particulars, money(i.amount)],
      indent: 1
    })
    const rows = [
      { cells: ['', 'Balance as per company books', '', '', money(r.bookBalance)], bold: true },
      { cells: ['', 'Less: deposits not yet credited by the bank', '', '', ''], bold: true },
      ...r.uncredited.map(item),
      { cells: ['', 'Total uncredited', '', '', money(r.uncreditedTotal)], rule: true },
      { cells: ['', 'Add: cheques issued but not yet presented', '', '', ''], bold: true },
      ...r.unpresented.map(item),
      { cells: ['', 'Total unpresented', '', '', money(r.unpresentedTotal)], rule: true },
      { cells: ['', 'Balance as per bank statement', '', '', money(r.bankBalance)], bold: true, rule: true }
    ]
    const html = reportHtml({
      title: 'Bank Reconciliation Statement',
      company: c.info,
      periodLabel: `${r.ledgerName} · as on ${asOn}`,
      columns: [
        { label: 'Date', align: 'l', width: 90 },
        { label: 'Voucher', align: 'l', width: 140 },
        { label: 'Instrument', align: 'l', width: 100 },
        { label: 'Particulars', align: 'l' },
        { label: 'Amount', align: 'r', width: 110 }
      ],
      rows
    })
    const path = await writeExportPdf(c.slug, `brs-${slugify(r.ledgerName)}-${asOn}.pdf`, html, { pageSize: 'A4' })
    return { path }
  }, 'viewer')

  // ---------- e-documents + invoice printing ----------
  handle('edoc:list', (p) => {
    const { from, to } = periodSchema.parse(p)
    return edocs.listSalesInvoices(requireCompany().db, from, to)
  }, 'viewer')
  handle('edoc:exportEInvoice', (p) => {
    const { from, to, period } = gstPeriodInput.parse(p)
    const c = requireCompany()
    const r = edocs.exportEInvoices(c.db, c.info, c.slug, from, to, period)
    auditExport(c.db, 'einvoice', { period, path: r.path, count: r.count })
    shell.showItemInFolder(r.path)
    return r
  })
  handle('edoc:exportEwb', (p) => {
    const { from, to, period, voucherIds, includeBelowThreshold } = gstPeriodInput
      .extend({
        voucherIds: z.array(z.number().int().positive()).max(500).optional(),
        includeBelowThreshold: z.boolean().default(false)
      })
      .parse(p)
    const c = requireCompany()
    // Writes the combined bulk file AND one single-bill file per voucher (exports/ewb/<period>/).
    const r = edocs.exportEwb(c.db, c.info, c.slug, from, to, period, { voucherIds, includeBelowThreshold })
    auditExport(c.db, 'ewb', { period, path: r.path, count: r.count })
    shell.showItemInFolder(r.path)
    return r
  })
  handle('edoc:ewbJson', (p) => {
    const { voucherId } = z.object({ voucherId: z.number().int().positive() }).parse(p)
    const c = requireCompany()
    const r = edocs.ewbJsonForVoucher(c.db, c.info, c.slug, voucherId)
    shell.showItemInFolder(r.path)
    return r
  })
  handle('edoc:transportGet', (p) => {
    const { voucherId } = z.object({ voucherId: z.number().int().positive() }).parse(p)
    return edocs.getTransport(requireCompany().db, voucherId)
  }, 'viewer')
  handle('edoc:transportSet', (p) => {
    const { voucherId, data } = z
      .object({ voucherId: z.number().int().positive(), data: voucherTransportSchema })
      .parse(p)
    return edocs.setTransport(requireCompany().db, voucherId, data)
  })
  handle('invoice:pdf', async (p) => {
    const { voucherId } = z.object({ voucherId: z.number().int().positive() }).parse(p)
    const c = requireCompany()
    const path = await invoice.invoicePdf(c.db, c.info, c.slug, voucherId)
    auditExport(c.db, 'invoice_pdf', { voucherId, path })
    shell.openPath(path)
    return { path }
  })
  // ---------- batch invoice printing (lane Q, task Q2 #98) ----------
  handle('invoice:pdfBatch', async (p) => {
    const { voucherIds } = invoicePdfBatchSchema.parse(p)
    const c = requireCompany()
    const r = await invoice.invoicePdfBatch(c.db, c.info, c.slug, voucherIds)
    auditExport(c.db, 'invoice_pdf_batch', { count: r.paths.length, dir: r.dir })
    shell.showItemInFolder(r.paths[0] ?? r.dir)
    return r
  })

  handle('invoice:previewHtml', (p) => {
    const { voucherId, config } = z
      .object({ voucherId: z.number().int().positive().optional(), config: invoiceConfigPartialSchema.optional() })
      .default({})
      .parse(p ?? {})
    const c = requireCompany()
    return invoice.invoicePreviewHtml(c.db, c.info, voucherId, config)
  }, 'viewer')

  // ---------- cheque printing + payment advice (task 2.7) ----------
  const bankLedgerIdSchema = z.object({ bankLedgerId: z.number().int().positive() })
  handle('cheque:config:get', (p) => configSvc.getChequeConfig(requireCompany().db, bankLedgerIdSchema.parse(p).bankLedgerId), 'viewer')
  handle('cheque:config:set', (p) => {
    const { bankLedgerId, config } = z.object({ bankLedgerId: z.number().int().positive(), config: chequeConfigSchema }).parse(p)
    return configSvc.setChequeConfig(requireCompany().db, bankLedgerId, config)
  })
  handle('cheque:pdf', async (p) => {
    const { voucherId, bankLedgerId } = z
      .object({ voucherId: z.number().int().positive(), bankLedgerId: z.number().int().positive() })
      .parse(p)
    const c = requireCompany()
    // chequePdf itself reveals the file in Finder — a cheque is meant to be loaded into the
    // printer tray and checked for alignment, not opened in a PDF viewer.
    const path = await cheque.chequePdf(c.db, c.info, c.slug, voucherId, bankLedgerId)
    return { path }
  })
  handle('cheque:testGrid', async (p) => {
    const { bankLedgerId } = bankLedgerIdSchema.parse(p)
    const c = requireCompany()
    const path = await cheque.testGridPdf(c.db, c.info, c.slug, bankLedgerId)
    shell.openPath(path)
    return { path }
  })
  handle('cheque:advice', async (p) => {
    const { voucherId } = z.object({ voucherId: z.number().int().positive() }).parse(p)
    const c = requireCompany()
    const path = await cheque.paymentAdvicePdf(c.db, c.info, c.slug, voucherId)
    shell.openPath(path)
    return { path }
  })

  // ---------- F11 features + F12 invoice print config ----------
  handle('config:features:get', () => configSvc.getFeatures(requireCompany().db), 'viewer')
  handle('config:features:set', (p) => configSvc.setFeatures(requireCompany().db, featuresSchema.parse(p)), 'owner')
  handle('config:invoice:get', () => configSvc.getInvoiceConfig(requireCompany().db), 'viewer')
  handle('config:invoice:set', (p) => configSvc.setInvoiceConfig(requireCompany().db, invoiceConfigSchema.parse(p)), 'owner')

  // ---------- currencies + BOM ----------
  handle('currency:list', () => extras.listCurrencies(requireCompany().db), 'viewer')
  handle('currency:create', (p) => extras.createCurrency(requireCompany().db, currencyInputSchema.parse(p)))
  handle('currency:delete', (p) => extras.deleteCurrency(requireCompany().db, idSchema.parse(p).id))
  handle('bom:get', (p) => extras.getBom(requireCompany().db, z.object({ itemId: z.number().int().positive() }).parse(p).itemId), 'viewer')
  handle('bom:set', (p) => extras.setBom(requireCompany().db, bomInputSchema.parse(p)))
  handle('bom:items', () => extras.itemsWithBom(requireCompany().db), 'viewer')

  // ---------- payroll ----------
  const daysSchema = z.array(z.object({ employeeId: z.number().int().positive(), payableDays: z.number().min(0).max(31) }))
  const monthSchema = z.string().regex(/^\d{4}-\d{2}$/)
  handle('payroll:employees:list', () => payroll.listEmployees(requireCompany().db), 'viewer')
  handle('payroll:employees:save', (p) => {
    const { data, id } = z.object({ data: employeeInputSchema, id: z.number().int().positive().optional() }).parse(p)
    return payroll.saveEmployee(requireCompany().db, data, id)
  })
  handle('payroll:employees:delete', (p) => payroll.deleteEmployee(requireCompany().db, idSchema.parse(p).id))
  handle('payroll:preview', (p) => {
    const { month, days } = z.object({ month: monthSchema, days: daysSchema }).parse(p)
    return payroll.previewRun(requireCompany().db, month, days)
  })
  handle('payroll:commit', (p) => {
    const { month, days } = z.object({ month: monthSchema, days: daysSchema }).parse(p)
    return payroll.commitRun(requireCompany().db, month, days)
  })
  handle('payroll:runs', () => payroll.listRuns(requireCompany().db), 'viewer')
  handle('payroll:deleteRun', (p) => payroll.deleteRun(requireCompany().db, idSchema.parse(p).id))
  handle('payroll:payslip', async (p) => {
    const { runId, employeeId } = z.object({ runId: z.number().int().positive(), employeeId: z.number().int().positive() }).parse(p)
    const c = requireCompany()
    const path = await payroll.payslipPdf(c.db, c.info, c.slug, runId, employeeId)
    shell.openPath(path)
    return { path }
  })
  // pay heads + per-employee assignments (lane Y, task Y1)
  handle('payroll:heads:list', () => payroll.listPayHeads(requireCompany().db), 'viewer')
  handle('payroll:heads:save', (p) => {
    const { data, id } = z.object({ data: payHeadInputSchema, id: z.number().int().positive().optional() }).parse(p)
    return payroll.savePayHead(requireCompany().db, data, id)
  })
  handle('payroll:heads:delete', (p) => {
    payroll.deletePayHead(requireCompany().db, idSchema.parse(p).id)
    return null
  })
  handle('payroll:employeeHeads:get', (p) => {
    const { employeeId } = z.object({ employeeId: z.number().int().positive() }).parse(p)
    return payroll.getEmployeeHeads(requireCompany().db, employeeId)
  }, 'viewer')
  handle('payroll:employeeHeads:set', (p) => payroll.setEmployeeHeads(requireCompany().db, employeeHeadsSetSchema.parse(p)))
  // statutory exports: PF ECR text, ESI upload CSV, PT summary per state (lane Y, task Y1)
  handle('payroll:ecr', (p) => {
    const { runId } = payrollRunIdSchema.parse(p)
    const c = requireCompany()
    const { filename, text } = payroll.ecrForRun(c.db, runId)
    const path = join(companyExportsDir(c.slug), filename)
    writeFileSync(path, text, 'utf8')
    shell.showItemInFolder(path)
    return { path }
  })
  handle('payroll:esi', (p) => {
    const { runId } = payrollRunIdSchema.parse(p)
    const c = requireCompany()
    const { filename, text } = payroll.esiForRun(c.db, runId)
    const path = join(companyExportsDir(c.slug), filename)
    writeFileSync(path, text, 'utf8')
    shell.showItemInFolder(path)
    return { path }
  })
  handle('payroll:ptSummary', (p) => payroll.ptSummaryForRun(requireCompany().db, payrollRunIdSchema.parse(p).runId), 'viewer')
  handle('payroll:ptCsv', (p) => {
    const { runId } = payrollRunIdSchema.parse(p)
    const c = requireCompany()
    const { filename, text } = payroll.ptCsvForRun(c.db, runId)
    const path = join(companyExportsDir(c.slug), filename)
    writeFileSync(path, text, 'utf8')
    shell.showItemInFolder(path)
    return { path }
  })

  // ---------- CSV master import ----------
  const importKindSchema = z.enum(['ledgers', 'items', 'openings'])
  handle('import:pickCsv', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Choose a CSV file',
      filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }],
      properties: ['openFile']
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    return { csvText: readFileSync(picked.filePaths[0], 'utf8'), fileName: picked.filePaths[0].split(/[\\/]/).pop()! }
  })
  handle('import:preview', (p) => {
    const { kind, csvText } = z.object({ kind: importKindSchema, csvText: z.string() }).parse(p)
    return importer.previewImport(requireCompany().db, kind, csvText)
  })
  handle('import:apply', async (p) => {
    const { kind, csvText } = z.object({ kind: importKindSchema, csvText: z.string() }).parse(p)
    const c = requireCompany()
    await backupCompany(c.db, c.slug, `pre-import-${kind}`)
    return importer.applyImport(c.db, kind, csvText)
  })
  handle('import:template', (p) => {
    const { kind } = z.object({ kind: importKindSchema }).parse(p)
    const c = requireCompany()
    const path = importer.writeTemplateCsv(c.slug, kind)
    shell.showItemInFolder(path)
    return { path }
  })

  // ---------- Tally import ----------
  handle('tally:import', async (p) => {
    const { xmlText, filePath, dryRun } = tallyImportSchema.parse(p ?? {})
    const c = requireCompany()
    let xml = xmlText
    let resolvedPath = filePath
    if (xml === undefined && filePath !== undefined) {
      if (!dialogIssuedTallyPaths.has(filePath)) throw new Error('File path must come from the file picker')
      xml = readFileSync(filePath, 'utf8')
    }
    if (xml === undefined) {
      const picked = await dialog.showOpenDialog({
        title: 'Choose a Tally XML export (Masters and/or Vouchers)',
        filters: [{ name: 'Tally XML', extensions: ['xml', 'txt'] }],
        properties: ['openFile']
      })
      if (picked.canceled || !picked.filePaths[0]) return null
      resolvedPath = picked.filePaths[0]
      dialogIssuedTallyPaths.add(resolvedPath)
      xml = readFileSync(resolvedPath, 'utf8')
    }
    // Dry run is parse-only — zero DB writes, so no backup is taken (nothing to roll back to).
    if (dryRun) return { filePath: resolvedPath ?? null, summary: dryRunTallyXml(xml) }
    await backupCompany(c.db, c.slug, 'pre-tally-import')
    return { filePath: resolvedPath ?? null, summary: importTallyXml(c.db, xml) }
  })

  // ---------- report print/export (task 3.6) ----------
  handle('report:pdf', async (p) => {
    const { title, periodLabel, columns, rows, footNote, filename, landscape } = reportPdfSchema.parse(p)
    const c = requireCompany()
    const html = reportHtml({ title, company: c.info, periodLabel, columns, rows, footNote })
    const path = await writeExportPdf(c.slug, `${filename}.pdf`, html, { pageSize: 'A4', landscape, pageNumbers: true })
    auditExport(c.db, 'report_pdf', { filename, path })
    return { path }
  }, 'viewer')
  handle('export:csv', (p) => {
    const { filename, csv } = exportCsvSchema.parse(p)
    const c = requireCompany()
    const path = join(companyExportsDir(c.slug), `${filename}.csv`)
    writeFileSync(path, csv, 'utf8')
    auditExport(c.db, 'csv', { filename, path })
    return { path }
  }, 'viewer')

  // ---------- CA export pack + Tally XML export ----------
  handle('export:caPack', (p) => {
    const { from, to } = periodSchema.parse(p)
    const c = requireCompany()
    const r = caPack.exportCaPack(c.db, c.info, c.slug, from, to)
    auditExport(c.db, 'ca_pack', { from, to, path: r.path })
    shell.showItemInFolder(r.path)
    return r
  })
  handle('export:tallyXml', (p) => {
    const { from, to } = periodSchema.parse(p)
    const c = requireCompany()
    const r = caPack.exportTallyXml(c.db, c.info, c.slug, from, to)
    auditExport(c.db, 'tally_xml', { from, to, path: r.path })
    shell.showItemInFolder(r.path)
    return r
  })

  // ---------- live filing (NIC APIs) ----------
  handle('nic:get', () => {
    const c = requireCompany()
    const creds = nic.readNicCredentials(c.db, c.slug)
    // Never send live secrets back to the UI in full — password AND clientSecret are the two
    // halves of the NIC auth credential pair (username/password + client_id/client_secret),
    // and nic:get is viewer-gated (v0.3 review F3).
    return {
      ...creds,
      password: creds.password ? '••••••••' : '',
      clientSecret: creds.clientSecret ? '••••••••' : '',
      // 'session' means the OS keychain was unavailable, so the secrets live in memory only and
      // are gone at quit. The Settings panel says so rather than silently losing them.
      secretStorage: nic.nicSecretStorageMode()
    }
  }, 'viewer')
  handle('nic:save', (p) => {
    const c = requireCompany()
    const incoming = nicCredentialsSchema.parse(p)
    const existing = nic.readNicCredentials(c.db, c.slug)
    // Re-saving the mask sentinel means "keep what's stored" — the settings form round-trips
    // nic:get values verbatim when the owner doesn't retype them.
    if (incoming.password === '••••••••') incoming.password = existing.password
    if (incoming.clientSecret === '••••••••') incoming.clientSecret = existing.clientSecret
    nic.writeNicCredentials(c.db, c.slug, incoming)
    nic.resetNicSession()
    return { configured: nic.nicConfigured(c.db, c.slug) }
  }, 'owner')
  handle('nic:status', () => {
    const c = requireCompany()
    return { configured: nic.nicConfigured(c.db, c.slug), secretStorage: nic.nicSecretStorageMode() }
  }, 'viewer')
  handle('nic:generateIrn', async (p) => {
    const { voucherId } = z.object({ voucherId: z.number().int().positive() }).parse(p)
    const c = requireCompany()
    return nic.generateIrn(c.db, c.slug, c.info, voucherId)
  }, 'owner')
  handle('nic:generateEwb', async (p) => {
    const { voucherId } = z.object({ voucherId: z.number().int().positive() }).parse(p)
    const c = requireCompany()
    return nic.generateEwbByIrn(c.db, c.slug, c.info, voucherId)
  }, 'owner')

  // ---------- intelligence ----------
  handle('intel:suggestLedgers', (p) => {
    const { kind, query } = z.object({ kind: z.string(), query: z.string() }).parse(p)
    return intel.suggestLedgers(requireCompany().db, kind, query)
  }, 'viewer')
  handle('intel:anomaly', (p) => {
    const { ledgerId, amount } = z.object({ ledgerId: z.number().int().positive(), amount: z.number().int() }).parse(p)
    return intel.anomalyCheck(requireCompany().db, ledgerId, amount)
  }, 'viewer')

  // ---------- audit ----------
  handle('audit:list', (p) => {
    const { entity, from, to, page } = auditListSchema.parse(p)
    return listAudit(requireCompany().db, { entity, from, to, page })
  }, 'viewer')

  // ---------- audit retention (lane Q, task Q1 #92) ----------
  handle('config:audit:get', () => ({ keepDays: configSvc.getAuditKeepDays(requireCompany().db) }), 'viewer')
  handle('config:audit:set', (p) => {
    const { keepDays } = auditRetentionSchema.parse(p)
    return { keepDays: configSvc.setAuditKeepDays(requireCompany().db, keepDays) }
  }, 'owner')

  // ---------- auth + users ----------
  // auth:* itself is in UNGATED_CHANNELS (see `handle`) — you have to be able to call
  // auth:login before you're "in". users:list/save/deactivate are owner-only, *except* that
  // users:save is reachable with no session at all while the company has zero users: that's
  // how the first (forced-owner) account gets created without a chicken-and-egg deadlock —
  // see the UNGATED_CHANNELS / `current.usersExist` gate in `handle`.
  handle('auth:users', () => users.listLoginNames(requireCompany().db))
  handle('auth:login', (p) => {
    const { userId, pin } = authLoginSchema.parse(p)
    const c = requireCompany()
    const result = users.login(c.db, userId, pin)
    sessionUser = result
    return result
  })
  handle('auth:logout', () => {
    // [lane-Q audit] logout audit row (task Q1 #90) — only meaningful with a live session.
    if (current && sessionUser) writeAudit(current.db, 'user', sessionUser.id, 'logout', null, null)
    sessionUser = null
    return null
  })
  handle('auth:current', () => sessionUser)

  handle('users:list', () => users.listUsers(requireCompany().db), 'owner')
  handle('users:save', (p) => {
    const { data, id } = z.object({ data: userInputSchema, id: z.number().int().positive().optional() }).parse(p)
    const c = requireCompany()
    const bootstrap = id === undefined && !c.usersExist
    const before = id ? users.getUser(c.db, id) : null
    const saved = users.saveUser(c.db, data, id)
    c.usersExist = users.usersExist(c.db)
    // The bootstrap owner (the very first user of a fresh company) is auto-authenticated as
    // themselves — they just proved they're standing at the machine by creating the account,
    // and forcing them to immediately re-enter the PIN they picked a second ago would be theatre.
    if (bootstrap) sessionUser = { id: saved.id, name: saved.name, role: saved.role }
    writeAudit(c.db, 'user', saved.id, id ? 'update' : 'create', before, saved)
    return { ...saved, locked: c.usersExist && !sessionUser }
  }, 'owner')
  handle('users:deactivate', (p) => {
    const { id } = idSchema.parse(p)
    const c = requireCompany()
    const before = users.getUser(c.db, id)
    users.deactivateUser(c.db, id)
    c.usersExist = users.usersExist(c.db)
    writeAudit(c.db, 'user', id, 'update', before, { ...before, active: false })
    return null
  }, 'owner')

  // ---------- logging ----------
  handle('log:renderer', (p) => {
    const { message, stack, componentStack, screen } = rendererLogSchema.parse(p)
    log('error', 'renderer-error', { message, stack, componentStack, screen })
    return null
  })
  handle('log:reveal', () => {
    revealLogs()
    return null
  })
  /**
   * The diagnostics block the support dialog shows the user before they send anything. Built in
   * main because the version, platform and log tail live here — and returned as plain text so
   * the dialog can print it verbatim rather than describing it.
   */
  handle('log:diagnostics', () => {
    const company = getCurrentCompany()
    return {
      version: app.getVersion(),
      platform: `${process.platform} ${process.arch}`,
      electron: process.versions.electron,
      companyOpen: company != null,
      lines: recentLogLines()
    }
  }, 'viewer')

  // ---------- app info + updates ----------
  handle('app:info', () => ({ version: app.getVersion(), platform: process.platform }))
  handle('app:checkUpdates', () => checkForUpdatesInteractive(), 'viewer')

  // ---------- agent bridge (CSV/JSON mirrors + inbox, lane A) ----------
  handle('agent:exportMirror', (p) => {
    const input = agentExportSchema.parse(p ?? {})
    const c = requireCompany()
    return agentBridge.exportMirror(c.db, c.slug, input)
  })
  handle('agent:getConfig', () => ({ enabled: configSvc.getAgentBridgeEnabled(requireCompany().db) }), 'viewer')
  handle('agent:setConfig', (p) => {
    const { enabled } = agentBridgeConfigSchema.parse(p)
    const c = requireCompany()
    configSvc.setAgentBridgeEnabled(c.db, enabled)
    agentBridge.syncInboxWatcher(enabled ? { slug: c.slug, db: c.db } : null)
    return { enabled }
  }, 'owner')

  // ---------- compliance-deadline notifications ----------
  // The renderer computes *which* deadlines to notify about (pure `src/shared/compliance.ts`,
  // driven off the dashboard data it already has) and hands over ready-to-show title/body pairs;
  // this just applies the once-per-day guard and pops native OS notifications.
  handle('app:notifyDeadlines', (p) => {
    const { items } = notifyDeadlinesSchema.parse(p)
    const db = requireCompany().db
    if (configSvc.shouldNotifyDeadlinesToday(db, todayISO())) {
      for (const item of items) {
        new Notification({ title: item.title, body: item.body }).show()
      }
    }
    return null
  }, 'viewer')
}
