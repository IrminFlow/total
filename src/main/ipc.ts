import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import { readFileSync, writeFileSync, copyFileSync, rmSync, unlinkSync, mkdtempSync, existsSync, appendFileSync } from 'fs'
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
import { companyBackupsDir, companyDbPath, companyDir, companyExportsDir, dataRoot, ensureCompanyTree, slugify } from './paths'
import { log, revealLogs } from './log'
import { checkForUpdatesInteractive } from './updater'
import {
  backupFileSchema, bankRuleInputSchema, batchInputSchema, billsOpenSchema, budgetInputSchema, budgetVarianceSchema, ccStatementSchema,
  chequeConfigSchema, companyCreateSchema, consolidatedRunSchema, costCentreInputSchema, exportCsvSchema, godownInputSchema, groupInputSchema, gst3bManualSchema, gstr2bSchema,
  isoDate, ledgerInputSchema, notifyDeadlinesSchema, passphraseSchema, periodSchema, priceLevelInputSchema, priceRateInputSchema, rendererLogSchema, reportPdfSchema,
  searchGlobalSchema, searchQuerySchema, stockGroupInputSchema, stockItemInputSchema, stockQuerySchema, stockCostAsOfSchema,
  stockRegisterSchema, stockReorderSchema, stockExpiryReportSchema, stockLabelsSchema, serialsListSchema, serialsAvailableSchema, tallyImportSchema, tdsExport26qSchema, tdsEnsurePayableSchema, tdsSectionInputSchema, tdsSuggestSchema,
  tdsSummarySchema, unitInputSchema, voucherInputSchema, voucherTransportSchema, voucherTypeInputSchema,
  tdsRateInputSchema, tdsRatesQuerySchema, tdsCertificateInputSchema, tdsCertificatesQuerySchema, tdsChallanInputSchema,
  tdsChallansQuerySchema, tdsAllocateSchema, tdsUnallocateSchema, tdsUnallocatedSchema,
  tdsEligibleSchema, tdsDeductedSchema, tdsApplySchema, tdsApplyManySchema, tdsVoucherSchema, tdsExemptSchema, tdsQuarterSchema,
  tdsChallanFromPaymentSchema, tdsChallanRowsSchema, tcsSuggestSchema, tdsChallanInterestSchema, tdsAutoAllocateSchema, tdsForm16aSchema, tdsLedgerSummarySchema
} from '@shared/schemas'
import { todayISO } from '@shared/dates'
import { formatPaise } from '@shared/money'
import * as configSvc from './services/config'
import * as masters from './services/masters'
import * as vouchers from './services/vouchers'
import * as reports from './services/reports'
import * as dashboard from './services/dashboard'
import * as gst from './services/gst'
import * as gstAnnual from './services/gstAnnual'
import * as gstIms from './services/gstIms'
import * as gstRcm from './services/gstRcm'
import * as gstItcRev from './services/gstItcReversal'
import {
  fyStartSchema, imsSetSchema, itc04QuerySchema, itcReversalInputsSchema, itcReversalQuerySchema, recon2bTolerancesSchema,
  selfInvoiceGenerateSchema, selfInvoiceSeriesSchema
} from '@shared/gst/expansionSchemas'
import { recon2bOptionsFrom } from '@shared/gst/recon2b'
import * as intel from './services/intel'
import * as analysis from './services/analysis'
import * as banking from './services/banking'
import * as edocs from './services/edocs'
import * as invoice from './services/invoice'
import * as printTemplates from './services/printTemplates'
import * as cheque from './services/cheque'
import * as extras from './services/extras'
import * as payroll from './services/payroll'
import * as nic from './services/nic'
import * as tds from './services/tds'
import * as tdsWb from './services/tdsWorkbench'
import * as tcsSvc from './services/tcs'
import * as tcsWb from './services/tcsWorkbench'
import { renderForm16aHtml } from '@shared/print/form16a'
import { plexFontFaceCss } from './services/printFonts'
import * as costCentres from './services/costCentres'
import * as stockAnalysis from './services/stockAnalysis'
import * as manufacture from './services/manufacture'
import * as manufactureReports from './services/manufactureReports'
import * as bomSvc from './services/bom'
import * as jobWork from './services/jobWork'
import * as serials from './services/serials'
import * as tradeLinks from './services/tradeLinks'
import * as tradeDocTypes from './services/tradeDocTypes'
import * as tradeReports from './services/tradeReports'
import * as tradeDocs from './services/tradeDocs'
import * as tradeChain from './services/tradeChain'
import * as tradeAnalysis from './services/tradeAnalysis'
import * as tradeClosure from './services/tradeClosure'
import * as priceLevels from './services/priceLevels'
import * as budgets from './services/budgets'
import * as yearEnd from './services/yearEnd'
import { registerFixedAssetIpc } from './ipcFixedAssets'
import { registerPayrollStatutoryIpc } from './ipcPayrollStatutory'
import { registerPricingIpc } from './ipcPricing'
import { registerReportsIpc } from './ipcReports'
import { registerConsolidationIpc } from './ipcConsolidation'
import { runDuePacksInBackground } from './packScheduler'
import { registerAiIpc, aiRuns, type AppKeyAuditEntry } from './ai/ipc'
import { aiMockAllowed } from './ai/env'
import { settleDraftOnSave } from './ai/drafts'
import { appSecretStore } from './services/secretStore'
import type { AiEvent } from '@shared/ai'
import { registerReceivablesIpc } from './ipcReceivables'
import { creditOverrideSchema } from '@shared/receivables/schemas'
import { registerPayablesIpc } from './ipcPayables'
import { registerBankingIpc } from './ipcBanking'
import { registerCashFinanceIpc } from './ipcCashFinance'
import { registerDataImportIpc, clearLoadedImports } from './ipcDataImport'
import { rememberSalePrices } from './services/pricing'
import { importTallyXml, dryRunTallyXml } from './services/tallyImport'
import * as importer from './services/importers'
import * as agentBridge from './services/agentBridge'
import { agentBridgeConfigSchema, agentExportSchema } from '@shared/schemas'
import {
  manufactureCostPreviewSchema, manufactureRegisterSchema, manufactureSaveSchema, stockMovementsSchema,
  bomVersionInputSchema, bomExplodeSchema, manufactureReportSchema, jobWorkChallanSaveSchema, jobWorkPendingSchema
} from '@shared/schemas'
import * as consolidated from './services/consolidated'
import * as caPack from './services/caPack'
import { writeExportPdf } from './services/pdf'
import { reportHtml } from './services/reportHtml'
import { globalSearch, search } from './services/search'
import { createDemoCompany } from './services/demo'
import {
  setAuditContext, writeAudit, listAudit, pruneAudit, verifyAudit, editLogExport, runAsAuditUser, osAuditUser, SYSTEM_AUDIT_USER
} from './services/audit'
import { rowsToCsv } from '@shared/csv'
import * as users from './services/users'
import { assertDeleteAuthorized, auditCompanyDeletion } from './services/companyDelete'
import { roleAllows, type Role } from './services/roles'
import {
  bomInputSchema, currencyInputSchema, employeeInputSchema, nicCredentialsSchema, auditListSchema,
  userInputSchema, authLoginSchema, payHeadInputSchema, employeeHeadsSetSchema, payrollRunIdSchema,
  auditRetentionSchema, auditExportSchema, auditTrailRequiredSchema, invoicePdfBatchSchema, linksForVoucherSchema, openSourceLinesSchema, tradePendingSchema, tradeDocNextNumberSchema,
  tradeDocTypeSaveSchema, tradeDocListSchema, tradeDocSaveSchema, tradeDocActionSchema, tradeDocConvertSchema, pendingOrdersSchema,
  quotationPipelineSchema, openOrderValueSchema, tradeChainSchema, threeWayMatchSchema, itemDemandSchema, orderBookSchema,
  leadTimeSchema, returnsRegisterSchema, returnsRateSchema, asOnSchema, staleDocumentsSchema, noteActionSchema, noteClosureSchema,
  closeStaleQuotationsSchema
} from '@shared/schemas'
import type { CompanyInfo } from '@shared/domain'
import { featuresSchema } from '@shared/features'
import { invoiceConfigPartialSchema, invoiceConfigSchema } from '@shared/invoiceConfig'
import { printDocKindSchema, printTemplateSchema } from '@shared/printTemplates'

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

/** company:updateInfo is owner-only; in a company without users everyone may. */
function canChangeCompanyInfo(): boolean {
  return !current?.usersExist || sessionUser?.role === 'owner'
}

function requireCompany(): OpenCompany {
  if (!current) throw new Error('No company is open')
  return current
}

/** Accessor for the currently-open company, used by the backup scheduler (backup-scheduler.ts). */
export function getCurrentCompany(): OpenCompany | null {
  return current
}

/** Whether background work on the open company (scheduled report packs) may run: never while the
 *  company is locked — it has users and nobody has signed in. */
function packsAllowed(): boolean {
  return !!current && (!current.usersExist || !!sessionUser)
}

/** The open company when it is unlocked, else null (the pack scheduler's view). */
export function getUnlockedCompany(): OpenCompany | null {
  return packsAllowed() ? current : null
}

/** Move a file into place. Copy+delete rather than fs.renameSync, since the source (os.tmpdir())
 *  and destination (~/Documents/total) may be on different filesystems (EXDEV). */
function renameFile(src: string, dest: string): void {
  rmSync(dest, { force: true })
  copyFileSync(src, dest)
  unlinkSync(src)
}

/** Whether a company file (not the open one) has active users — read-only peek for the AI key guard. */
function companyHasUsers(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false
  try {
    const d = new Database(dbPath, { readonly: true, fileMustExist: true })
    try {
      return ((d.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1').get() as { n: number }).n ?? 0) > 0
    } finally {
      d.close()
    }
  } catch {
    // Unreadable (encrypted, older schema): assume users exist — the safe answer for the guard.
    return true
  }
}

/** App-level, append-only record of API key changes (WP 5.1) — beside secrets.json, outside
 *  every company (the key is shared by all of them). */
function appendAiKeyAudit(entry: AppKeyAuditEntry): void {
  appendFileSync(join(dataRoot(), 'ai-key-audit.jsonl'), `${JSON.stringify({ ...entry, appVersion: app.getVersion() })}\n`, { mode: 0o600 })
}

export function closeCurrentCompany(): void {
  // Stop the inbox watcher + any pending mirror refresh before the handle closes under them.
  agentBridge.syncInboxWatcher(null)
  // The cached NIC login belongs to this company's identity — never carry it into the next one.
  nic.resetNicSession()
  // In-flight AI answers belong to this company's handle — stop them before it closes.
  aiRuns.cancelAll()
  // WP 6.3: a file loaded into the import wizard never carries over to another company.
  clearLoadedImports()
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
  'backup:importEncrypted',
  'app:info'
])

/** Every registered channel and its minimum role — read by the audit-coverage registry dbtest
 *  (auditCoverage.dbtest.ts) so a new write channel cannot ship without an audit mapping. */
export const CHANNEL_ROLES = new Map<string, Role>()

/** The ungated channels (exported for the same registry test — several of them write). */
export const UNGATED_CHANNEL_NAMES: ReadonlySet<string> = UNGATED_CHANNELS

function handle(channel: string, fn: Handler, minRole: Role = 'accountant'): void {
  CHANNEL_ROLES.set(channel, minRole)
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
  // WP 3.8 user attribution: the signed-in user (id + name). With no session the writer falls back
  // to the OS login ('os:<name>') — only reachable in a company without users, since a company
  // with users refuses every gated channel until someone signs in.
  setAuditContext({ appVersion: app.getVersion(), getUserName: () => sessionUser?.name ?? null, getUserId: () => sessionUser?.id ?? null })

  // ---------- fixed assets (WP 3.6) — channels live in ipcFixedAssets.ts ----------
  registerFixedAssetIpc(handle, () => requireCompany().db)
  // ---------- payroll statutory (WP 3.7) — channels live in ipcPayrollStatutory.ts ----------
  registerPayrollStatutoryIpc(handle, () => requireCompany())
  registerPricingIpc(handle, () => requireCompany())
  // ---------- report builder, comparatives, ratios, scheduled packs (WP 6.1 / 6.2) ----------
  registerReportsIpc(handle, () => requireCompany(), () => sessionUser?.name ?? osAuditUser())
  // ---------- group consolidation (WP 6.5) — channels live in ipcConsolidation.ts ----------
  registerConsolidationIpc(handle, () => requireCompany())
  // ---------- AI agent (WP 5.1) — channels live in ai/ipc.ts; events stream on 'total:ai:event' ----------
  registerAiIpc(handle, {
    company: () => requireCompany(),
    session: () => (sessionUser ? { name: sessionUser.name, role: sessionUser.role } : { name: null, role: 'owner' }),
    // A company with users and nobody signed in has no role (the run stops at its next tool call).
    roleNow: () => (sessionUser ? sessionUser.role : current?.usersExist ? null : 'owner'),
    secrets: () => appSecretStore(),
    anyCompanyHasUsers: () => readRegistry().companies.some((co) => co.slug !== current?.slug && companyHasUsers(companyDbPath(co.slug))),
    appAudit: (entry) => appendAiKeyAudit(entry),
    emit: (e: AiEvent) => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('total:ai:event', e)
    },
    mock: () => aiMockAllowed(process.env, app.isPackaged)
  })
  // ---------- receivables (WP 4.2) — channels live in ipcReceivables.ts ----------
  registerReceivablesIpc(handle, () => requireCompany())
  // ---------- payables (WP 4.3) — channels live in ipcPayables.ts ----------
  registerPayablesIpc(handle, () => requireCompany())
  // ---------- banking depth (WP 4.1) — channels live in ipcBanking.ts ----------
  registerBankingIpc(handle, () => requireCompany())
  // ---------- cash and finance (WP 4.4) — channels live in ipcCashFinance.ts ----------
  registerCashFinanceIpc(handle, () => requireCompany())
  // ---------- Excel export, import wizard, books workbook (WP 6.3) — ipcDataImport.ts ----------
  registerDataImportIpc(handle, () => requireCompany(), { canChangeCompanyInfo, userName: () => sessionUser?.name ?? null })

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
    writeAudit(db, 'company', 0, 'create', null, info)
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
    // Secrets live outside the company folder; drop them so a future company reusing this slug
    // starts clean. Best-effort — a secret-store failure must not fail a completed delete.
    try {
      nic.deleteNicSecrets(slug)
    } catch (err) {
      log('warn', 'company-delete-secrets-failed', { slug, error: err instanceof Error ? err.message : String(err) })
    }
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
    // Housekeeping below runs as 'system' in the audit trail — nobody asked for it.
    try {
      const purged = runAsAuditUser(SYSTEM_AUDIT_USER, () => vouchers.purgeOldDeleted(db, 30))
      if (purged > 0) log('info', 'bin-purge', { purged })
    } catch (err) {
      // e.g. an over-age binned voucher still referenced by payroll_runs — housekeeping must
      // never block opening the company.
      log('warn', 'bin-purge-failed', { slug, error: err instanceof Error ? err.message : String(err) })
    }
    // Post-dated vouchers whose date has arrived flip into the books (audited per voucher).
    // PDCs dated inside a locked period are refused, not silently posted — they stay in the
    // PDC register until the lock is lifted (v0.3 review F3).
    const { matured, blockedByLock } = runAsAuditUser(SYSTEM_AUDIT_USER, () => vouchers.maturePostDated(db, todayISO()))
    if (matured.length > 0) log('info', 'pdc-mature', { count: matured.length, ids: matured })
    if (blockedByLock.length > 0) {
      log('warn', 'pdc-mature-blocked-by-lock', { count: blockedByLock.length, ids: blockedByLock })
    }
    // [lane-Q audit, WP 3.8] retention: only when the company is NOT flagged audit-trail-required
    // (default: required → never pruned) and a window is set; never inside the s.128(5) floor.
    // pruneAudit logs its own 'prune' row as 'system'.
    const auditKeepDays = configSvc.getAuditKeepDays(db)
    if (auditKeepDays !== null) {
      try {
        const prunedAudit = pruneAudit(db, auditKeepDays)
        if (prunedAudit > 0) log('info', 'audit-prune', { pruned: prunedAudit, keepDays: auditKeepDays })
      } catch (err) {
        log('warn', 'audit-prune-failed', { slug, error: err instanceof Error ? err.message : String(err) })
      }
    }
    touchLastOpened(slug)
    // Agent bridge (feature flag, default OFF): watch <company>/inbox/ for dropped files.
    if (configSvc.getAgentBridgeEnabled(db)) agentBridge.syncInboxWatcher({ slug, db })
    // WP 6.2: scheduled report packs that came due while the app was closed run once, deferred
    // past this reply and only while the company is unlocked (a company with users waits for the
    // sign-in — auth:login starts the pass then).
    void runDuePacksInBackground({ slug, db, info }, { allowed: packsAllowed, current: getUnlockedCompany })
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
    return { path: await backupCompany(c.db, c.slug, 'manual', sessionUser?.name ?? osAuditUser()) }
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
    // closeCurrentCompany() below clears the session — remember who asked for the restore.
    const restoredBy = sessionUser?.name ?? osAuditUser()
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
    // WP 3.8: the restored file carries the backup's own audit trail and hash chain. Verify it,
    // then record the restore itself on top of it (the live trail up to the restore survives in
    // the pre-restore snapshot).
    const auditChain = verifyAudit(current.db)
    writeAudit(current.db, 'backup', 0, 'restore', null, {
      file, preRestoreSnapshot: basename(preRestoreSnapshotPath), chainOk: auditChain.ok, chainRows: auditChain.rows,
      chainHeadId: auditChain.headId, chainFirstBreak: auditChain.firstBreak?.rowId ?? null
    }, { user: restoredBy })
    // closeCurrentCompany() above already cleared sessionUser, so this is realistically always
    // `current.usersExist` — spelled out in full to match the other two locked-flag call sites.
    return { info: current.info, integrity, locked: current.usersExist && !sessionUser, auditChain }
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
    // WP 3.8: record the import in the imported company's own trail (opening migrates it first).
    try {
      const imported = openCompanyDb(slug)
      try {
        const chain = verifyAudit(imported)
        writeAudit(imported, 'backup', 0, 'restore', null, {
          file: basename(picked.filePaths[0]), encrypted: true, chainOk: chain.ok, chainRows: chain.rows, chainFirstBreak: chain.firstBreak?.rowId ?? null
        }, { user: osAuditUser() })
      } finally {
        closeCompanyDb(imported)
      }
    } catch (err) {
      log('warn', 'import-encrypted-audit-failed', { slug, error: err instanceof Error ? err.message : String(err) })
    }
    return { slug, name: info.name }
  })

  // ---------- masters ----------
  handle('master:groups:list', () => masters.listGroups(requireCompany().db), 'viewer')
  handle('master:groups:tree', () => masters.groupTree(requireCompany().db), 'viewer')
  handle('master:chartOfAccounts', (p) => {
    const { asOn } = z.object({ asOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(p)
    return reports.chartOfAccounts(requireCompany().db, asOn)
  }, 'viewer')
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

  // ---------- trade cycle (WP 2.5a): kinds, order / quotation numbering series, line links ----------
  handle('voucherKinds:list', () => tradeDocTypes.listVoucherKinds(requireCompany().db), 'viewer')
  handle('tradeDocTypes:list', () => tradeDocTypes.listTradeDocTypes(requireCompany().db), 'viewer')
  handle('tradeDocTypes:save', (p) => {
    const { id, data } = tradeDocTypeSaveSchema.parse(p)
    return tradeDocTypes.saveTradeDocType(requireCompany().db, data, id)
  })
  handle('tradeDocs:nextNumber', (p) => {
    const { docTypeId, date } = tradeDocNextNumberSchema.parse(p)
    return tradeDocTypes.nextTradeDocNumber(requireCompany().db, docTypeId, date)
  }, 'viewer')
  handle('links:forVoucher', (p) => tradeLinks.linksForVoucher(requireCompany().db, linksForVoucherSchema.parse(p).voucherId), 'viewer')
  handle('links:openSourceLines', (p) => tradeLinks.openSourceLines(requireCompany().db, openSourceLinesSchema.parse(p)), 'viewer')
  handle('trade:pending', (p) => {
    const { stage, asOn } = tradePendingSchema.parse(p)
    return tradeReports.pendingStockNotes(requireCompany().db, stage, asOn)
  }, 'viewer')
  // ---------- quotations / sales orders / purchase orders (WP 2.5c) ----------
  handle('tradeDocs:list', (p) => tradeDocs.listTradeDocs(requireCompany().db, tradeDocListSchema.parse(p)), 'viewer')
  handle('tradeDocs:get', (p) => tradeDocs.getTradeDoc(requireCompany().db, idSchema.parse(p).id), 'viewer')
  handle('tradeDocs:save', (p) => {
    const { data, id } = tradeDocSaveSchema.parse(p)
    return tradeDocs.saveTradeDoc(requireCompany().db, data, id)
  })
  handle('tradeDocs:delete', (p) => tradeDocs.deleteTradeDoc(requireCompany().db, tradeDocActionSchema.parse(p).id))
  handle('tradeDocs:restore', (p) => tradeDocs.restoreTradeDoc(requireCompany().db, tradeDocActionSchema.parse(p).id))
  handle('tradeDocs:cancel', (p) => {
    const { id, reason } = tradeDocActionSchema.parse(p)
    return tradeDocs.cancelTradeDoc(requireCompany().db, id, reason)
  })
  handle('tradeDocs:close', (p) => {
    const { id, reason } = tradeDocActionSchema.parse(p)
    return tradeDocs.closeTradeDoc(requireCompany().db, id, reason)
  })
  handle('tradeDocs:reopen', (p) => {
    const { id, reason } = tradeDocActionSchema.parse(p)
    return tradeDocs.reopenTradeDoc(requireCompany().db, id, reason)
  })
  handle('tradeDocs:convert', (p) => {
    const { id, to } = tradeDocConvertSchema.parse(p)
    return tradeDocs.convertTradeDoc(requireCompany().db, id, to)
  })
  handle('tradeDocs:duplicate', (p) => tradeDocs.duplicateTradeDoc(requireCompany().db, idSchema.parse(p).id))
  handle('tradeDocs:pdf', async (p) => {
    const { id } = idSchema.parse(p)
    const c = requireCompany()
    const path = await printTemplates.tradeDocPdf(c.db, c.info, c.slug, id)
    auditExport(c.db, 'trade_doc_pdf', { tradeDocId: id, path })
    shell.openPath(path)
    return { path }
  })
  handle('tradeDocs:previewHtml', (p) => {
    const { id } = idSchema.parse(p)
    const c = requireCompany()
    return { html: printTemplates.tradeDocHtml(c.db, c.info, id).html }
  }, 'viewer')
  handle('trade:pendingOrders', (p) => {
    const { kind, asOn } = pendingOrdersSchema.parse(p)
    return tradeReports.pendingOrders(requireCompany().db, kind, asOn)
  }, 'viewer')
  handle('trade:quotationPipeline', (p) => {
    const { from, to, asOn } = quotationPipelineSchema.parse(p)
    return tradeReports.quotationPipeline(requireCompany().db, from, to, asOn)
  }, 'viewer')
  handle('trade:openSalesOrderValue', (p) => tradeDocs.openSalesOrderValue(requireCompany().db, openOrderValueSchema.parse(p).partyLedgerId), 'viewer')

  // ---------- trade cycle (WP 2.5d): linked documents, reports, returns, closure ----------
  handle('trade:chain', (p) => tradeChain.tradeChain(requireCompany().db, tradeChainSchema.parse(p)), 'viewer')
  handle('trade:threeWayMatch', (p) => {
    const { from, to, ...tolerances } = threeWayMatchSchema.parse(p)
    return tradeAnalysis.threeWayMatchReport(requireCompany().db, { from, to, tolerances })
  }, 'viewer')
  handle('trade:itemDemand', (p) => {
    const { asOn, onlyOpen } = itemDemandSchema.parse(p)
    return tradeAnalysis.itemDemand(requireCompany().db, asOn, { onlyOpen })
  }, 'viewer')
  handle('trade:orderBook', (p) => tradeAnalysis.orderBook(requireCompany().db, orderBookSchema.parse(p)), 'viewer')
  handle('trade:leadTime', (p) => tradeAnalysis.leadTime(requireCompany().db, leadTimeSchema.parse(p)), 'viewer')
  handle('trade:returnsRegister', (p) => tradeAnalysis.returnsRegister(requireCompany().db, returnsRegisterSchema.parse(p)), 'viewer')
  handle('trade:returnsRate', (p) => tradeAnalysis.returnsRate(requireCompany().db, returnsRateSchema.parse(p)), 'viewer')
  handle('trade:unbilledGoods', (p) => tradeAnalysis.unbilledGoods(requireCompany().db, asOnSchema.parse(p).asOn), 'viewer')
  handle('trade:staleDocuments', (p) => {
    const { asOn, ...opts } = staleDocumentsSchema.parse(p)
    return tradeAnalysis.staleDocuments(requireCompany().db, asOn, opts)
  }, 'viewer')
  handle('trade:noteClosure', (p) => tradeClosure.noteClosure(requireCompany().db, noteClosureSchema.parse(p).voucherId), 'viewer')
  handle('trade:closeVoucher', (p) => {
    const { voucherId, reason } = noteActionSchema.parse(p)
    return tradeClosure.closeStockNote(requireCompany().db, voucherId, reason)
  })
  handle('trade:reopenVoucher', (p) => {
    const { voucherId, reason } = noteActionSchema.parse(p)
    return tradeClosure.reopenStockNote(requireCompany().db, voucherId, reason)
  })
  handle('trade:closeStaleQuotations', (p) => tradeClosure.closeStaleQuotations(requireCompany().db, closeStaleQuotationsSchema.parse(p)))

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
  handle('stock:costAsOf', (p) => stockAnalysis.costAsOf(requireCompany().db, stockCostAsOfSchema.parse(p)), 'viewer')
  // ---------- stock visibility (WP 2.3) ----------
  handle('stock:register', (p) => {
    const q = stockRegisterSchema.parse(p)
    return stockAnalysis.stockMovements(requireCompany().db, q.itemId, q.from, q.to, q.godownId)
  }, 'viewer')
  handle('stock:reorder', (p) => {
    const q = stockReorderSchema.parse(p)
    return stockAnalysis.reorderPlan(requireCompany().db, q.from, q.to, { onlyBelow: q.onlyBelow })
  }, 'viewer')
  handle('stock:expiryReport', (p) => {
    const q = stockExpiryReportSchema.parse(p)
    return stockAnalysis.expiryReport(requireCompany().db, q.asOn, q.withinDays)
  }, 'viewer')
  handle('stock:labelsHtml', (p) => {
    const c = requireCompany()
    return { html: stockAnalysis.labelsHtml(c.db, { ...stockLabelsSchema.parse(p), caption: c.info.name }) }
  }, 'viewer')
  handle('stock:labelsPdf', async (p) => {
    const q = stockLabelsSchema.parse(p)
    const c = requireCompany()
    const html = stockAnalysis.labelsHtml(c.db, { ...q, caption: c.info.name })
    const path = await writeExportPdf(c.slug, `barcode-labels-${q.date}.pdf`, html, { pageSize: 'A4', margins: 'none' })
    auditExport(c.db, 'barcode_labels', { items: q.items.length, path })
    shell.openPath(path)
    return { path }
  }, 'viewer')
  handle('serials:list', (p) => serials.listSerials(requireCompany().db, serialsListSchema.parse(p ?? {})), 'viewer')
  handle('serials:available', (p) => {
    const q = serialsAvailableSchema.parse(p)
    return serials.availableSerials(requireCompany().db, q.stockItemId, q.voucherId)
  }, 'viewer')
  handle('stock:movements', (p) => {
    const { stockItemId, from, to } = stockMovementsSchema.parse(p)
    return stockAnalysis.itemMovements(requireCompany().db, stockItemId, from, to)
  }, 'viewer')

  // ---------- manufacture voucher (WP 2.2) ----------
  handle('manufacture:get', (p) => manufacture.getManufacture(requireCompany().db, idSchema.parse(p).id), 'viewer')
  handle('manufacture:costPreview', (p) => manufacture.costPreview(requireCompany().db, manufactureCostPreviewSchema.parse(p)), 'viewer')
  handle('manufacture:register', (p) => {
    const { from, to, itemId } = manufactureReportSchema.parse(p)
    return manufacture.manufactureRegister(requireCompany().db, from, to, itemId)
  }, 'viewer')
  // WP 2.4 manufacturing reports
  handle('manufacture:production', (p) => {
    const { from, to } = manufactureRegisterSchema.parse(p)
    return manufactureReports.productionRegisterReport(requireCompany().db, from, to)
  }, 'viewer')
  handle('manufacture:costSheet', (p) => {
    const { from, to, itemId } = manufactureReportSchema.extend({ itemId: z.number().int().positive() }).parse(p)
    return manufactureReports.costSheetReport(requireCompany().db, itemId, from, to)
  }, 'viewer')
  handle('manufacture:margin', (p) => {
    const { from, to } = manufactureRegisterSchema.parse(p)
    return manufactureReports.marginReport(requireCompany().db, from, to)
  }, 'viewer')
  handle('manufacture:variance', (p) => {
    const { from, to, itemId } = manufactureReportSchema.parse(p)
    return manufactureReports.materialVarianceReport(requireCompany().db, from, to, itemId)
  }, 'viewer')
  // WP 2.4 job work
  handle('jobWork:get', (p) => jobWork.getJobWorkChallan(requireCompany().db, idSchema.parse(p).id), 'viewer')
  handle('jobWork:saveChallan', (p) => {
    const { id, ...rest } = jobWorkChallanSaveSchema.parse(p)
    const c = requireCompany()
    const saved = jobWork.saveJobWorkChallan(c.db, rest, id)
    if (configSvc.getAgentBridgeEnabled(c.db)) agentBridge.scheduleMirrorRefresh(c.db, c.slug)
    return saved
  })
  handle('jobWork:sendChallans', (p) => jobWork.sendChallans(requireCompany().db, idSchema.parse(p).id), 'viewer')
  handle('jobWork:pending', (p) => {
    const { asOn, pendingDays } = jobWorkPendingSchema.parse(p)
    return jobWork.materialAtJobWorkers(requireCompany().db, asOn, pendingDays)
  }, 'viewer')
  handle('jobWork:itc04', (p) => {
    const { from, to } = manufactureRegisterSchema.parse(p)
    return jobWork.itc04Data(requireCompany().db, from, to)
  }, 'viewer')
  handle('manufacture:save', (p) => {
    const { data, id } = manufactureSaveSchema.parse(p)
    const c = requireCompany()
    const saved = manufacture.saveManufacture(c.db, data, id)
    if (configSvc.getAgentBridgeEnabled(c.db)) agentBridge.scheduleMirrorRefresh(c.db, c.slug)
    return saved
  })
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
  handle('search:query', (p) => {
    const { q, ...opts } = searchQuerySchema.parse(p)
    return search(requireCompany().db, q, opts)
  }, 'viewer')

  // ---------- vouchers ----------
  handle('voucher:list', (p) => {
    const { from, to, voucherTypeId } = periodSchema.extend({ voucherTypeId: z.number().int().positive().optional() }).parse(p)
    return vouchers.listVouchers(requireCompany().db, from, to, voucherTypeId)
  }, 'viewer')
  handle('voucher:get', (p) => vouchers.getVoucher(requireCompany().db, idSchema.parse(p).id), 'viewer')
  handle('voucher:save', (p) => {
    const { data, id, aiDraftId, creditHoldOverride } = z
      .object({
        data: voucherInputSchema,
        id: z.number().int().positive().optional(),
        aiDraftId: z.number().int().positive().optional(),
        creditHoldOverride: creditOverrideSchema.optional()
      })
      .parse(p)
    const c = requireCompany()
    // WP 4.2: only an owner may override a credit hold (any user in a company without users).
    if (creditHoldOverride && c.usersExist && sessionUser?.role !== 'owner') throw new Error('Only an owner can override a credit hold')
    const saveOpts = creditHoldOverride ? { creditHoldOverride } : {}
    // WP 5.1: a voucher reviewed from an AI draft saves through the normal path; the draft is
    // settled in the same transaction (consumed when still open; otherwise the save goes ahead
    // and the audit trail records that the draft was no longer open).
    const saved = aiDraftId
      ? c.db.transaction(() => {
          const v = vouchers.saveVoucher(c.db, data, id, saveOpts)
          settleDraftOnSave(c.db, aiDraftId, v.id)
          return v
        })()
      : vouchers.saveVoucher(c.db, data, id, saveOpts)
    // WP 2.6 "remember last price" (Options toggle; a no-op unless on and this is a sale). Never
    // fails the save it follows.
    try {
      rememberSalePrices(c.db, saved.id)
    } catch (err) {
      log('warn', 'pricing.rememberSalePrices.failed', { error: (err as Error).message })
    }
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
      .extend({ ledgerId: z.number().int().positive(), groupBy: z.enum(['month']).optional() })
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
  handle('report:dashboard', (p) => {
    const { today, fyFrom } = z.object({ today: z.string(), fyFrom: z.string() }).parse(p)
    return reports.dashboard(requireCompany().db, today, fyFrom)
  }, 'viewer')
  handle('report:dashboardSeries', (p) => {
    const { today, from, to } = periodSchema.extend({ today: isoDate }).refine((v) => v.from <= v.to, 'from must be on or before to').parse(p)
    const c = requireCompany()
    // Backup status comes from the backups folder (the service itself never touches files).
    const backups = listBackupsIn(companyBackupsDir(c.slug))
    return dashboard.dashboardSeries(c.db, c.info, { today, from, to, backups })
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
    // WP 3.4: what was exported is the "as filed" side of the GSTR-9 comparison.
    gstAnnual.recordGstr1Export(c.db, period, result.json)
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
    gstAnnual.recordGstr3bExport(c.db, period, result)
    auditExport(c.db, 'gstr3b', { period, path: jsonPath })
    shell.showItemInFolder(jsonPath)
    return { jsonPath }
  })
  handle('gst:recon2b', (p) => {
    const { jsonText, from, to } = gstr2bSchema.parse(p)
    const db = requireCompany().db
    return gst.recon2b(db, jsonText, from, to, recon2bOptionsFrom(gstIms.getRecon2bTolerances(db)))
  }, 'viewer')

  // ---------- GST expansion (WP 3.4): 2B tolerances + IMS, GSTR-9, ITC-04, RCM self-invoices, ITC reversal ----------
  handle('gst:recon2bTolerancesGet', () => gstIms.getRecon2bTolerances(requireCompany().db), 'viewer')
  handle('gst:recon2bTolerancesSet', (p) => gstIms.setRecon2bTolerances(requireCompany().db, recon2bTolerancesSchema.parse(p)))
  handle('gst:imsList', (p) => {
    const { period } = z.object({ period: z.string().regex(/^\d{6}$/) }).parse(p)
    return gstIms.listImsActions(requireCompany().db, period)
  }, 'viewer')
  handle('gst:imsSet', (p) => {
    const { period, decisions } = imsSetSchema.parse(p)
    return gstIms.setImsActions(requireCompany().db, period, decisions)
  })
  handle('gst:imsExport', (p) => {
    const { period } = z.object({ period: z.string().regex(/^\d{6}$/) }).parse(p)
    const c = requireCompany()
    const r = gstIms.exportImsActions(c.db, c.slug, c.info.gstin ?? '', period)
    auditExport(c.db, 'ims_actions', { period, path: r.jsonPath, count: r.count })
    shell.showItemInFolder(r.jsonPath)
    return r
  }, 'viewer')
  handle('gst:gstr9', (p) => {
    const { fyStartYear } = fyStartSchema.parse(p)
    const c = requireCompany()
    return gstAnnual.gstr9(c.db, c.info, fyStartYear)
  }, 'viewer')
  handle('gst:exportGstr9', (p) => {
    const { fyStartYear } = fyStartSchema.parse(p)
    const c = requireCompany()
    const r = gstAnnual.exportGstr9(c.db, c.info, c.slug, fyStartYear)
    auditExport(c.db, 'gstr9', { fyStartYear, path: r.jsonPath })
    shell.showItemInFolder(r.jsonPath)
    return r
  }, 'viewer')
  handle('gst:itc04', (p) => {
    const q = itc04QuerySchema.parse(p)
    const c = requireCompany()
    return gstAnnual.itc04(c.db, c.info, q)
  }, 'viewer')
  handle('gst:exportItc04', (p) => {
    const q = itc04QuerySchema.parse(p)
    const c = requireCompany()
    const r = gstAnnual.exportItc04(c.db, c.info, c.slug, q)
    auditExport(c.db, 'itc04', { ...q, path: r.jsonPath })
    shell.showItemInFolder(r.jsonPath)
    return r
  }, 'viewer')
  handle('gst:selfInvoices', (p) => {
    const { from, to } = periodSchema.parse(p)
    const c = requireCompany()
    return gstRcm.listSelfInvoices(c.db, c.info, from, to, todayISO())
  }, 'viewer')
  handle('gst:selfInvoiceGenerate', (p) => {
    const { voucherId, date } = selfInvoiceGenerateSchema.parse(p)
    return gstRcm.generateSelfInvoice(requireCompany().db, voucherId, date)
  })
  handle('gst:selfInvoicePdf', async (p) => {
    const { voucherId } = z.object({ voucherId: z.number().int().positive() }).parse(p)
    const c = requireCompany()
    const path = await gstRcm.selfInvoicePdf(c.db, c.info, c.slug, voucherId)
    auditExport(c.db, 'self_invoice_pdf', { voucherId, path })
    shell.openPath(path)
    return { path }
  }, 'viewer')
  handle('gst:selfInvoiceSeriesGet', () => gstRcm.getSelfInvoiceSeries(requireCompany().db), 'viewer')
  handle('gst:selfInvoiceSeriesSet', (p) => gstRcm.setSelfInvoiceSeries(requireCompany().db, selfInvoiceSeriesSchema.parse(p)))
  handle('gst:itcReversal', (p) => {
    const { from, to, period, inputs } = itcReversalQuerySchema.parse(p)
    const c = requireCompany()
    return gstItcRev.itcReversal(c.db, c.info, from, to, period, inputs)
  }, 'viewer')
  handle('gst:itcReversalInputsSet', (p) => {
    const { period, inputs } = z.object({ period: z.string().regex(/^\d{6}$/), inputs: itcReversalInputsSchema }).parse(p)
    return gstItcRev.setItcReversalInputs(requireCompany().db, period, inputs)
  })
  handle('gst:itcReversalApply', (p) => {
    const { from, to, period } = itcReversalQuerySchema.parse(p)
    const c = requireCompany()
    return gstItcRev.applyItcReversalTo3b(c.db, c.info, from, to, period)
  })
  handle('gst:itcReversalPost', (p) => {
    const { from, to, period } = itcReversalQuerySchema.parse(p)
    const c = requireCompany()
    return gstItcRev.postItcReversal(c.db, c.info, from, to, period)
  })
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
    const { kind, from, to } = periodSchema.extend({ kind: z.enum(['sales', 'purchase']) }).parse(p)
    return analysis.registerByMonth(requireCompany().db, kind, from, to)
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
    const { partyLedgerId, base, date, expenseLedgerId, excludeVoucherId, sectionId, voucherKind } = tdsSuggestSchema.parse(p)
    // Read-only (runs as the user types) — never creates the payable ledger.
    return tds.tdsSuggestion(requireCompany().db, partyLedgerId, base, date, { expenseLedgerId, excludeVoucherId, sectionId, voucherKind })
  })
  // Effective-dated rate table — section master data, owner-edited like tds:sectionSave.
  handle('tds:rates', (p) => tds.listRates(requireCompany().db, tdsRatesQuerySchema.parse(p ?? {}).sectionId), 'viewer')
  handle('tds:rateSave', (p) => tds.saveRate(requireCompany().db, tdsRateInputSchema.parse(p)), 'owner')
  handle('tds:rateDelete', (p) => tds.deleteRate(requireCompany().db, idSchema.parse(p).id), 'owner')
  // Lower-deduction certificates are party data (like the PAN on the ledger): accountant+.
  handle('tds:certificates', (p) => tds.listCertificates(requireCompany().db, tdsCertificatesQuerySchema.parse(p ?? {}).ledgerId), 'viewer')
  handle('tds:certificateSave', (p) => tds.saveCertificate(requireCompany().db, tdsCertificateInputSchema.parse(p)))
  handle('tds:certificateDelete', (p) => tds.deleteCertificate(requireCompany().db, idSchema.parse(p).id))
  // Challans + allocation: accountant+ edits, viewer reads.
  handle('tds:challans', (p) => {
    const { fyStartYear, quarter } = tdsChallansQuerySchema.parse(p)
    return tds.listChallans(requireCompany().db, fyStartYear, quarter)
  }, 'viewer')
  handle('tds:challanSave', (p) => tds.saveChallan(requireCompany().db, tdsChallanInputSchema.parse(p)))
  handle('tds:challanDelete', (p) => tds.deleteChallan(requireCompany().db, idSchema.parse(p).id))
  handle('tds:allocate', (p) => {
    const { challanId, entryIds } = tdsAllocateSchema.parse(p)
    return tds.allocateEntries(requireCompany().db, challanId, entryIds)
  })
  handle('tds:unallocate', (p) => tds.unallocateEntries(requireCompany().db, tdsUnallocateSchema.parse(p).entryIds))
  handle('tds:unallocated', (p) => {
    const { fyStartYear, quarter } = tdsUnallocatedSchema.parse(p)
    return tds.unallocatedEntries(requireCompany().db, fyStartYear, quarter as 1 | 2 | 3 | 4 | undefined)
  }, 'viewer')
  // Thin wrapper kept for callers that want the tagged payable ledger up front; entry screens
  // no longer call it — saveVoucher creates the ledger inside the save (tds.autoPayable).
  handle('tds:ensurePayable', (p) => {
    const { sectionId } = tdsEnsurePayableSchema.parse(p)
    return { ledgerId: tds.ensureTdsPayableLedger(requireCompany().db, sectionId) }
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

  // ---------- TDS screen (WP 3.2): reads for viewers, voucher edits / challans accountant+ ----------
  handle('tds:eligible', (p) => {
    const { from, to, includeExempt } = tdsEligibleSchema.parse(p)
    return tdsWb.tdsEligible(requireCompany().db, from, to, { includeExempt })
  }, 'viewer')
  handle('tds:deducted', (p) => {
    const { from, to } = tdsDeductedSchema.parse(p)
    return tdsWb.tdsDeducted(requireCompany().db, from, to)
  }, 'viewer')
  handle('tds:ledgerSummary', (p) => {
    const { fyStartYear, quarter } = tdsLedgerSummarySchema.parse(p)
    return tdsWb.tdsLedgerSummary(requireCompany().db, fyStartYear, quarter as 0 | 1 | 2 | 3 | 4)
  }, 'viewer')
  handle('tds:applyToVoucher', (p) => tdsWb.applyTdsToVoucher(requireCompany().db, tdsApplySchema.parse(p)))
  // Bulk Move to TDS: each voucher on its own (one refusal doesn't undo the others).
  handle('tds:applyMany', (p) => {
    const { voucherIds } = tdsApplyManySchema.parse(p)
    const db = requireCompany().db
    return voucherIds.map((voucherId) => {
      try {
        tdsWb.applyTdsToVoucher(db, { voucherId })
        return { voucherId, ok: true as const }
      } catch (err) {
        return { voucherId, ok: false as const, error: (err as Error).message }
      }
    })
  })
  handle('tds:removeFromVoucher', (p) => tdsWb.removeTdsFromVoucher(requireCompany().db, tdsVoucherSchema.parse(p).voucherId))
  handle('tds:exempt', (p) => {
    const { voucherId, reason } = tdsExemptSchema.parse(p)
    tdsWb.exemptVoucher(requireCompany().db, voucherId, reason)
    return null
  })
  handle('tds:unexempt', (p) => {
    tdsWb.unexemptVoucher(requireCompany().db, tdsVoucherSchema.parse(p).voucherId)
    return null
  })
  handle('tds:exemption', (p) => ({ reason: tdsWb.exemptionOf(requireCompany().db, tdsVoucherSchema.parse(p).voucherId) }), 'viewer')
  handle('tds:paymentCandidates', (p) => tdsWb.tdsPaymentCandidates(requireCompany().db, tdsSummarySchema.parse(p).fyStartYear), 'viewer')
  handle('tds:challanRows', (p) => {
    const { fyStartYear, quarter, rateBp } = tdsChallanRowsSchema.parse(p)
    return tdsWb.challanRows(requireCompany().db, fyStartYear, quarter, rateBp)
  }, 'viewer')
  handle('tds:challanFromPayment', (p) => {
    const input = tdsChallanFromPaymentSchema.parse(p)
    return tdsWb.challanFromPayment(requireCompany().db, {
      ...input, quarter: (input.quarter ?? null) as 1 | 2 | 3 | 4 | null
    })
  })
  handle('tds:autoAllocate', (p) => ({ entryIds: tdsWb.autoAllocate(requireCompany().db, tdsAutoAllocateSchema.parse(p).challanId) }))
  handle('tds:challanInterest', (p) => {
    const { challanId, rateBp } = tdsChallanInterestSchema.parse(p)
    return tdsWb.challanInterest(requireCompany().db, challanId, rateBp)
  }, 'viewer')
  handle('tds:form26q', (p) => {
    const { fyStartYear, quarter } = tdsQuarterSchema.parse(p)
    return tdsWb.form26qData(requireCompany().db, fyStartYear, quarter as 1 | 2 | 3 | 4)
  }, 'viewer')
  handle('tds:form16a', (p) => {
    const { fyStartYear, quarter, partyLedgerId } = tdsForm16aSchema.parse(p)
    const c = requireCompany()
    return tdsWb.form16aData(c.db, c.info, fyStartYear, quarter as 1 | 2 | 3 | 4, partyLedgerId)
  }, 'viewer')
  handle('tds:form16aPdf', async (p) => {
    const { fyStartYear, quarter, partyLedgerId } = tdsForm16aSchema.parse(p)
    const c = requireCompany()
    const data = tdsWb.form16aData(c.db, c.info, fyStartYear, quarter as 1 | 2 | 3 | 4, partyLedgerId)
    const html = renderForm16aHtml(data, plexFontFaceCss)
    const who = partyLedgerId != null && data.parties[0] ? `-${slugify(data.parties[0].partyName)}` : ''
    const path = await writeExportPdf(c.slug, `form16a-data-${fyStartYear}-Q${quarter}${who}.pdf`, html, { pageSize: 'A4' })
    auditExport(c.db, 'tds_form16a', { fyStartYear, quarter, partyLedgerId: partyLedgerId ?? null, path })
    shell.showItemInFolder(path)
    return { path }
  }, 'viewer')

  // ---------- TCS (WP 3.3) ----------
  // The same section / rate / certificate / challan / entry machinery as TDS, kind 'tcs' (shared
  // tables, migration 027); the TCS-only parts (suggestion, Eligible, Move to TCS, 27EQ / 27D)
  // live in services/tcs.ts and tcsWorkbench.ts.
  handle('tcs:sections', () => tds.listSections(requireCompany().db, 'tcs'), 'viewer')
  handle('tcs:sectionSave', (p) => tds.saveSection(requireCompany().db, tdsSectionInputSchema.parse(p), 'tcs'), 'owner')
  handle('tcs:suggest', (p) => tcsSvc.tcsSuggestion(requireCompany().db, tcsSuggestSchema.parse(p)), 'viewer')
  handle('tcs:rates', (p) => tds.listRates(requireCompany().db, tdsRatesQuerySchema.parse(p ?? {}).sectionId, 'tcs'), 'viewer')
  handle('tcs:rateSave', (p) => tds.saveRate(requireCompany().db, tdsRateInputSchema.parse(p)), 'owner')
  handle('tcs:rateDelete', (p) => tds.deleteRate(requireCompany().db, idSchema.parse(p).id), 'owner')
  handle('tcs:certificates', (p) => tds.listCertificates(requireCompany().db, tdsCertificatesQuerySchema.parse(p ?? {}).ledgerId, 'tcs'), 'viewer')
  handle('tcs:certificateSave', (p) => tds.saveCertificate(requireCompany().db, tdsCertificateInputSchema.parse(p), 'tcs'))
  handle('tcs:certificateDelete', (p) => tds.deleteCertificate(requireCompany().db, idSchema.parse(p).id))
  handle('tcs:challanSave', (p) => tds.saveChallan(requireCompany().db, tdsChallanInputSchema.parse(p), 'tcs'))
  handle('tcs:challanDelete', (p) => tds.deleteChallan(requireCompany().db, idSchema.parse(p).id))
  handle('tcs:allocate', (p) => {
    const { challanId, entryIds } = tdsAllocateSchema.parse(p)
    return tds.allocateEntries(requireCompany().db, challanId, entryIds)
  })
  handle('tcs:unallocate', (p) => tds.unallocateEntries(requireCompany().db, tdsUnallocateSchema.parse(p).entryIds))
  handle('tcs:unallocated', (p) => {
    const { fyStartYear, quarter } = tdsUnallocatedSchema.parse(p)
    return tds.unallocatedEntries(requireCompany().db, fyStartYear, quarter as 1 | 2 | 3 | 4 | undefined, 'tcs')
  }, 'viewer')
  handle('tcs:eligible', (p) => {
    const { from, to, includeExempt } = tdsEligibleSchema.parse(p)
    return tcsWb.tcsEligible(requireCompany().db, from, to, { includeExempt })
  }, 'viewer')
  handle('tcs:deducted', (p) => {
    const { from, to } = tdsDeductedSchema.parse(p)
    return tdsWb.tdsDeducted(requireCompany().db, from, to, 'tcs')
  }, 'viewer')
  handle('tcs:ledgerSummary', (p) => {
    const { fyStartYear, quarter } = tdsLedgerSummarySchema.parse(p)
    return tdsWb.tdsLedgerSummary(requireCompany().db, fyStartYear, quarter as 0 | 1 | 2 | 3 | 4, 'tcs')
  }, 'viewer')
  handle('tcs:applyToVoucher', (p) => tcsWb.applyTcsToVoucher(requireCompany().db, tdsApplySchema.parse(p)))
  handle('tcs:applyMany', (p) => {
    const { voucherIds } = tdsApplyManySchema.parse(p)
    const db = requireCompany().db
    return voucherIds.map((voucherId) => {
      try {
        tcsWb.applyTcsToVoucher(db, { voucherId })
        return { voucherId, ok: true as const }
      } catch (err) {
        return { voucherId, ok: false as const, error: (err as Error).message }
      }
    })
  })
  handle('tcs:removeFromVoucher', (p) => tcsWb.removeTcsFromVoucher(requireCompany().db, tdsVoucherSchema.parse(p).voucherId))
  handle('tcs:exempt', (p) => {
    const { voucherId, reason } = tdsExemptSchema.parse(p)
    tdsWb.exemptVoucher(requireCompany().db, voucherId, reason, 'tcs')
    return null
  })
  handle('tcs:unexempt', (p) => {
    tdsWb.unexemptVoucher(requireCompany().db, tdsVoucherSchema.parse(p).voucherId, 'tcs')
    return null
  })
  handle('tcs:exemption', (p) => ({ reason: tdsWb.exemptionOf(requireCompany().db, tdsVoucherSchema.parse(p).voucherId, 'tcs') }), 'viewer')
  handle('tcs:paymentCandidates', (p) => tdsWb.tdsPaymentCandidates(requireCompany().db, tdsSummarySchema.parse(p).fyStartYear, 'tcs'), 'viewer')
  handle('tcs:challanRows', (p) => {
    const { fyStartYear, quarter, rateBp } = tdsChallanRowsSchema.parse(p)
    return tdsWb.challanRows(requireCompany().db, fyStartYear, quarter, rateBp, 'tcs')
  }, 'viewer')
  handle('tcs:challanFromPayment', (p) => {
    const input = tdsChallanFromPaymentSchema.parse(p)
    return tdsWb.challanFromPayment(requireCompany().db, { ...input, quarter: (input.quarter ?? null) as 1 | 2 | 3 | 4 | null }, 'tcs')
  })
  handle('tcs:autoAllocate', (p) => ({ entryIds: tdsWb.autoAllocate(requireCompany().db, tdsAutoAllocateSchema.parse(p).challanId) }))
  handle('tcs:challanInterest', (p) => {
    const { challanId, rateBp } = tdsChallanInterestSchema.parse(p)
    return tdsWb.challanInterest(requireCompany().db, challanId, rateBp)
  }, 'viewer')
  handle('tcs:form27eq', (p) => {
    const { fyStartYear, quarter } = tdsQuarterSchema.parse(p)
    return tcsWb.form27eqData(requireCompany().db, fyStartYear, quarter as 1 | 2 | 3 | 4)
  }, 'viewer')
  handle('tcs:export27eq', (p) => {
    const { fyStartYear, quarter } = tdsQuarterSchema.parse(p)
    const c = requireCompany()
    const path = tcsWb.export27eqCsv(c.db, c.slug, fyStartYear, quarter as 1 | 2 | 3 | 4)
    auditExport(c.db, 'tcs_27eq', { fyStartYear, quarter, path })
    shell.showItemInFolder(path)
    return { path }
  }, 'viewer')
  handle('tcs:form27d', (p) => {
    const { fyStartYear, quarter, partyLedgerId } = tdsForm16aSchema.parse(p)
    const c = requireCompany()
    return tcsWb.form27dData(c.db, c.info, fyStartYear, quarter as 1 | 2 | 3 | 4, partyLedgerId)
  }, 'viewer')
  handle('tcs:form27dPdf', async (p) => {
    const { fyStartYear, quarter, partyLedgerId } = tdsForm16aSchema.parse(p)
    const c = requireCompany()
    const data = tcsWb.form27dData(c.db, c.info, fyStartYear, quarter as 1 | 2 | 3 | 4, partyLedgerId)
    const html = renderForm16aHtml(data, plexFontFaceCss, 'tcs')
    const who = partyLedgerId != null && data.parties[0] ? `-${slugify(data.parties[0].partyName)}` : ''
    const path = await writeExportPdf(c.slug, `form27d-data-${fyStartYear}-Q${quarter}${who}.pdf`, html, { pageSize: 'A4' })
    auditExport(c.db, 'tcs_form27d', { fyStartYear, quarter, partyLedgerId: partyLedgerId ?? null, path })
    shell.showItemInFolder(path)
    return { path }
  }, 'viewer')

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
    const c = requireCompany()
    return edocs.listSalesInvoices(c.db, from, to, c.info)
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
    auditExport(c.db, 'ewb_json', { voucherId, path: r.path })
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

  // ---------- print templates (WP 1.10c) ----------
  // Read/preview: viewer+. Edit (save/duplicate/delete/reset/defaults/import): accountant+.
  const templateIdSchema = z.object({ id: z.string().min(1).max(60) })
  handle('template:list', () => printTemplates.listTemplates(requireCompany().db), 'viewer')
  handle('template:get', (p) => printTemplates.getTemplate(requireCompany().db, templateIdSchema.parse(p).id), 'viewer')
  handle('template:save', (p) => {
    const { template } = z.object({ template: printTemplateSchema }).parse(p)
    return printTemplates.saveTemplate(requireCompany().db, template)
  })
  handle('template:duplicate', (p) => printTemplates.duplicateTemplate(requireCompany().db, templateIdSchema.parse(p).id))
  handle('template:delete', (p) => {
    printTemplates.deleteTemplate(requireCompany().db, templateIdSchema.parse(p).id)
    return { ok: true }
  })
  handle('template:reset', (p) => printTemplates.resetTemplate(requireCompany().db, templateIdSchema.parse(p).id))
  handle('template:setDefault', (p) => {
    const { kind, id } = z.object({ kind: printDocKindSchema, id: z.string().min(1).max(60) }).parse(p)
    return printTemplates.setDefaultTemplate(requireCompany().db, kind, id)
  })
  handle('template:previewHtml', (p) => {
    const { template, voucherId, kind } = z
      .object({ template: printTemplateSchema, voucherId: z.number().int().positive().optional(), kind: printDocKindSchema.optional() })
      .parse(p)
    const c = requireCompany()
    return printTemplates.templatePreviewHtml(c.db, c.info, template, { voucherId, kind })
  }, 'viewer')
  handle('template:testPdf', async (p) => {
    const { template, kind } = z.object({ template: printTemplateSchema, kind: printDocKindSchema.optional() }).parse(p)
    const c = requireCompany()
    const path = await printTemplates.templateTestPdf(c.db, c.info, c.slug, template, kind)
    auditExport(c.db, 'print_test_pdf', { templateId: template.id, path })
    shell.openPath(path)
    return { path }
  })
  handle('template:export', (p) => {
    const { id } = templateIdSchema.parse(p)
    const c = requireCompany()
    const path = printTemplates.exportTemplate(c.db, c.slug, id)
    auditExport(c.db, 'print_template', { templateId: id, path })
    shell.showItemInFolder(path)
    return { path }
  }, 'viewer')
  // `jsonText` inline lets drivers/tests import without the native file dialog.
  handle('template:import', async (p) => {
    const { jsonText } = z.object({ jsonText: z.string().max(2_000_000).optional() }).default({}).parse(p ?? {})
    let text = jsonText
    if (text === undefined) {
      const picked = await dialog.showOpenDialog({
        title: 'Choose a Total print template (.json)',
        filters: [{ name: 'Print template', extensions: ['json'] }],
        properties: ['openFile']
      })
      if (picked.canceled || !picked.filePaths[0]) return null
      text = readFileSync(picked.filePaths[0], 'utf8')
    }
    return printTemplates.importTemplate(requireCompany().db, text)
  })

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
    auditExport(c.db, 'cheque_pdf', { voucherId, bankLedgerId, path })
    return { path }
  })
  handle('cheque:testGrid', async (p) => {
    const { bankLedgerId } = bankLedgerIdSchema.parse(p)
    const c = requireCompany()
    const path = await cheque.testGridPdf(c.db, c.info, c.slug, bankLedgerId)
    auditExport(c.db, 'cheque_test_grid', { bankLedgerId, path })
    shell.openPath(path)
    return { path }
  })
  handle('cheque:advice', async (p) => {
    const { voucherId } = z.object({ voucherId: z.number().int().positive() }).parse(p)
    const c = requireCompany()
    const path = await cheque.paymentAdvicePdf(c.db, c.info, c.slug, voucherId)
    auditExport(c.db, 'payment_advice', { voucherId, path })
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
  // WP 2.4: BOM versions + explosion
  handle('bom:versions', (p) => bomSvc.listBomVersions(requireCompany().db, z.object({ itemId: z.number().int().positive().optional() }).parse(p ?? {}).itemId), 'viewer')
  handle('bom:saveVersion', (p) => bomSvc.saveBomVersion(requireCompany().db, bomVersionInputSchema.parse(p)))
  handle('bom:deleteVersion', (p) => bomSvc.deleteBomVersion(requireCompany().db, idSchema.parse(p).id))
  handle('bom:explode', (p) => bomSvc.explode(requireCompany().db, bomExplodeSchema.parse(p)), 'viewer')

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
    auditExport(c.db, 'payslip', { runId, employeeId, path })
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
    auditExport(c.db, 'payroll_ecr', { runId, path })
    shell.showItemInFolder(path)
    return { path }
  })
  handle('payroll:esi', (p) => {
    const { runId } = payrollRunIdSchema.parse(p)
    const c = requireCompany()
    const { filename, text } = payroll.esiForRun(c.db, runId)
    const path = join(companyExportsDir(c.slug), filename)
    writeFileSync(path, text, 'utf8')
    auditExport(c.db, 'payroll_esi', { runId, path })
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
    auditExport(c.db, 'payroll_pt_csv', { runId, path })
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
    auditExport(c.db, 'import_template', { importKind: kind, path })
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
    // WP 6.3: the import may set booksFrom (owner only — the company:updateInfo rule); keep the
    // cached company info in step with what it wrote.
    const summary = importTallyXml(c.db, xml, { canSetBooksFrom: canChangeCompanyInfo() })
    if (summary.booksFromSet !== null) c.info = readCompanyInfo(c.db)
    return { filePath: resolvedPath ?? null, summary }
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
    // Secrets come from the encrypted secret store (services/secretStore.ts), not the company DB;
    // a first read also migrates any legacy plaintext copy out of `meta`.
    const creds = nic.readNicCredentials(c.db, c.slug)
    // Never send live secrets back to the UI in full — password AND clientSecret are the two
    // halves of the NIC auth credential pair (username/password + client_id/client_secret),
    // and nic:get is viewer-gated (v0.3 review F3).
    return nic.maskNicCredentials(creds)
  }, 'viewer')
  handle('nic:save', (p) => {
    const c = requireCompany()
    const incoming = nicCredentialsSchema.parse(p)
    const existing = nic.readNicCredentials(c.db, c.slug)
    // Re-saving the mask sentinel means "keep what's stored" — the settings form round-trips
    // nic:get values verbatim when the owner doesn't retype them.
    if (incoming.password === nic.NIC_SECRET_MASK) incoming.password = existing.password
    if (incoming.clientSecret === nic.NIC_SECRET_MASK) incoming.clientSecret = existing.clientSecret
    nic.writeNicCredentials(c.db, c.slug, incoming)
    nic.resetNicSession()
  // WP 6.3: a file loaded into the import wizard never carries over to another company.
  clearLoadedImports()
    return { configured: nic.nicConfigured(c.db, c.slug) }
  }, 'owner')
  handle('nic:status', () => {
    const c = requireCompany()
    return { configured: nic.nicConfigured(c.db, c.slug) }
  }, 'viewer')
  // Settings → NIC "Connection test" (WP 3.5): the auth handshake only — files nothing and
  // writes nothing to the books; the outcome (or the mapped NIC error) goes back to the UI.
  handle('nic:testConnection', async () => {
    const c = requireCompany()
    return nic.testNicConnection(c.db, c.slug, c.info)
  }, 'owner')
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
  // WP 3.8: the edit log is read-only from the UI — there is no channel that edits or deletes an
  // audit entry, and none that turns the trail off (only the owner-only retention settings below).
  handle('audit:list', (p) => listAudit(requireCompany().db, auditListSchema.parse(p)), 'viewer')
  handle('audit:verify', () => verifyAudit(requireCompany().db), 'viewer')
  const editLogFilename = (q: { from?: string; to?: string }): string => `edit-log-${q.from ?? 'start'}_${q.to ?? todayISO()}`
  handle('audit:exportCsv', (p) => {
    const q = auditExportSchema.parse(p)
    const c = requireCompany()
    const r = editLogExport(c.db, c.info, q)
    const csv = rowsToCsv(['Edit log (audit trail)'], [...r.header.map((h) => [h]), [], r.columns, ...r.rows])
    const path = join(companyExportsDir(c.slug), `${editLogFilename(q)}.csv`)
    writeFileSync(path, csv, 'utf8')
    auditExport(c.db, 'edit_log_csv', { ...q, rows: r.rows.length, chainOk: r.verification.ok, path })
    shell.showItemInFolder(path)
    return { path, rows: r.rows.length, verification: r.verification }
  }, 'viewer')
  handle('audit:exportPdf', async (p) => {
    const q = auditExportSchema.parse(p)
    const c = requireCompany()
    const r = editLogExport(c.db, c.info, q, { diffMaxLen: 600 })
    const html = reportHtml({
      title: 'Edit log (audit trail)',
      company: c.info,
      periodLabel: r.header[1]!.replace(/^Period: /, ''),
      headerLines: r.header.slice(2, -1),
      columns: [
        { label: '#', align: 'r', width: 36 }, { label: 'Date/time', align: 'l', width: 118 }, { label: 'User', align: 'l', width: 76 },
        { label: 'Entity', align: 'l', width: 86 }, { label: 'Id / number', align: 'l', width: 86 }, { label: 'Action', align: 'l', width: 56 },
        { label: 'Field-level changes', align: 'l' }, { label: 'Version', align: 'l', width: 50 }, { label: 'Hash', align: 'l', width: 66 }
      ],
      rows: r.rows.map((cells) => ({ cells })),
      footNote: r.header[r.header.length - 1]
    })
    const path = await writeExportPdf(c.slug, `${editLogFilename(q)}.pdf`, html, { pageSize: 'A4', landscape: true, pageNumbers: true })
    auditExport(c.db, 'edit_log_pdf', { ...q, rows: r.rows.length, chainOk: r.verification.ok, path })
    shell.openPath(path)
    return { path, rows: r.rows.length, verification: r.verification }
  }, 'viewer')

  // ---------- audit retention (lane Q, task Q1 #92; WP 3.8: owner-only, rule 3(1) default) ----------
  handle('config:audit:get', () => configSvc.getAuditSettings(requireCompany().db), 'viewer')
  handle('config:audit:set', (p) => {
    const { keepDays } = auditRetentionSchema.parse(p)
    const db = requireCompany().db
    configSvc.setAuditKeepDays(db, keepDays)
    return configSvc.getAuditSettings(db)
  }, 'owner')
  handle('config:audit:required', (p) => {
    const { required } = auditTrailRequiredSchema.parse(p)
    const db = requireCompany().db
    // Turning the flag back on clears any retention window, so "required" always means "never pruned".
    if (required && configSvc.getAuditKeepDays(db) !== null) configSvc.setAuditKeepDays(db, null)
    configSvc.setAuditTrailRequired(db, required)
    return configSvc.getAuditSettings(db)
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
    // WP 6.2: due report packs wait for the first sign-in of a locked company.
    void runDuePacksInBackground(c, { allowed: packsAllowed, current: getUnlockedCompany })
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

  // ---------- app info + updates ----------
  handle('app:info', () => ({ version: app.getVersion(), platform: process.platform }))
  handle('app:checkUpdates', () => checkForUpdatesInteractive(), 'viewer')

  // ---------- agent bridge (CSV/JSON mirrors + inbox, lane A) ----------
  handle('agent:exportMirror', (p) => {
    const input = agentExportSchema.parse(p ?? {})
    const c = requireCompany()
    const r = agentBridge.exportMirror(c.db, c.slug, input)
    auditExport(c.db, 'agent_mirror', { dir: r.dir, files: r.files.length })
    return r
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
