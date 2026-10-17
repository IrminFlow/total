import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import { checkSender, firstRefusalOf } from './ipcSender'
import { allowedHelpUrl } from '@shared/helpLinks'
import { nextRegistrationFacts } from '@shared/gst/registration'
import { readFileSync, writeFileSync, copyFileSync, rmSync, unlinkSync, mkdtempSync, existsSync, appendFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join, basename } from 'path'
import { decodeTextFile } from '@shared/textFiles'
import { fitFileName, portableFileName } from '@shared/fileNames'
import { EWB_CANCEL_REMARK_MAX, IRN_CANCEL_REMARK_MAX, NIC_CANCEL_REASONS } from '@shared/gst/nicRecord'
import { z } from 'zod'
import { LANGUAGES } from '@shared/i18n'
import { forgetFolderKey, isEncryptedFile, keyForPath, keyOfHandle, openDb, plainCopy, rekeyFile, removeDbFiles, rememberFolderKey } from './db/encryption'
import { DEFAULT_SCRYPT, WrongPassphraseError, newDataKey, unwrapKeyAsync, wrapKeyAsync, type ScryptParams } from './db/keyEnvelope'
import { insecureTestCipherAllowed } from './services/secrets'
import { assertNotThrottled, dropRememberedKey, hasRememberedKey, noteRightPassphrase, noteWrongPassphrase, readEnvelope, readEnvelopes, removeEnvelope, storeRememberedKey, unlockCompanyKey, unlockWithRememberedKey, writeEnvelope } from './services/companyKeys'
import { commitConvertedCopy, convertBackups, convertCompanyFiles, fileConversionPending, markFileConversion, prepareConvertedCopy, removeLeftoverCopies, resumeFileConversion } from './services/dbEncryption'
import { checkBackupIfDue, latestBackupCheck, listBackupChecks, recordBackupCheck, verifyBackupFileAsync } from './services/backupVerify'
import { AUTO_LOCK_CHOICES, IdleClock, getAutoLockMinutes, setAutoLockMinutes } from './services/sessionLock'
import { capabilityAllows, channelCapabilities } from './capabilities'
import { effectiveCapabilities, type Capability, type CapabilityFlags } from '@shared/capabilities'
import type { BackupCheck } from '@shared/backupCheck'
import type { SecurityView } from '@shared/security'
import { redactDashboard, redactDashboardSeries, redactHome } from '@shared/profitRedaction'
import { quietWaitMs } from './quietWait'
import type { DB } from './db/connection'
import { backupCompany, closeCompanyDb, openCompanyDb, stashBackupAttachments } from './db/connection'
import { assertNotNewer } from './db/migrate'
import * as attachments from './services/attachments'
import { embedAttachments, restoreAttachmentFiles, restoreAttachmentFilesAt, type RestoreFilesResult, type StashResult } from './db/attachmentBackup'
import { listBackupsIn, restoreCompanyDb, rollbackRestore, snapshotSync, backupStamp, runWeeklyIntegrityCheckAsync, type BackupInfo } from './db/backup'
import { checkIntegrity, checkIntegrityAsync, QUICK_CHECK_TIMED_OUT } from './db/integrity'
import { stopAllChecks, stopChecks, stopChecksUnder } from './db/checkHost'
import { encryptFile, decryptFile } from './db/crypt'
import { readCompanyInfo, seedCompany, writeCompanyInfo } from './db/seed'
import { readRegistry, removeCompany, touchLastOpened, upsertCompany } from './registry'
import { companyAttachmentsDir, companyBackupAttachmentsDir, companyBackupsDir, companyDbPath, companyDir, companyExportsDir, dataRoot, ensureCompanyTree, slugify } from './paths'
import { log, revealLogs } from './log'
import { checkForUpdatesInteractive, setAutoCheck, updateAction, updatesView } from './updater'
import { UPDATE_ACTIONS, updatesCanSet, type UpdatesCanSet } from '@shared/updates'
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
  tdsChallanFromPaymentSchema, tdsChallanRowsSchema, tcsSuggestSchema, tcsStatutoryAddSchema, tdsChallanInterestSchema, tdsAutoAllocateSchema, tdsForm16aSchema, tdsLedgerSummarySchema
} from '@shared/schemas'
import { todayISO } from '@shared/dates'
import { AppError, structuredOf, type StructuredError } from '@shared/errors'
import { formatPaise } from '@shared/money'
import * as configSvc from './services/config'
import * as masters from './services/masters'
import * as vouchers from './services/vouchers'
import * as undo from './services/undo'
import * as reports from './services/reports'
import * as dashboard from './services/dashboard'
import { homeAsOn, simpleHome, simpleHomeAttention } from './services/simpleHome'
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
import * as tradeLists from './services/tradeLists'
import * as tradeDocs from './services/tradeDocs'
import * as tradeChain from './services/tradeChain'
import * as tradeAnalysis from './services/tradeAnalysis'
import * as tradeClosure from './services/tradeClosure'
import * as priceLevels from './services/priceLevels'
import { quickCreateItem } from './services/quickCreate'
import { quickItemSchema } from '@shared/schemas'
import * as budgets from './services/budgets'
import * as yearEnd from './services/yearEnd'
import * as yearEndRepair from './services/yearEndRepair'
import { registerFixedAssetIpc } from './ipcFixedAssets'
import { registerPayrollStatutoryIpc } from './ipcPayrollStatutory'
import { registerPricingIpc } from './ipcPricing'
import { registerReportsIpc } from './ipcReports'
import { registerConsolidationIpc } from './ipcConsolidation'
import { runDuePacksInBackground } from './packScheduler'
import { registerAiIpc, aiRuns, type AppKeyAuditEntry } from './ai/ipc'
import { registerCaptureIpc, captureOnCompanyOpen, captureOnCompanyClose, resumeCapture } from './ai/capture/ipc'
import { dropPendingAttachments, flushCaptureAttachments } from './ai/capture/consume'
import { registerAssistantsIpc } from './ipcAssistants'
import { registerAskTotalIpc } from './assist/ipc'
import { classify as classifyAsk } from './assist/classify'
import { assistAskSchema, type AssistAnswer } from '@shared/assist'
import { translator } from '@shared/i18n'
import { companyLanguage } from './i18n'
import { settleAskDraft } from './assist/settle'
import { aiMockAllowed } from './ai/env'
import { settleDraftOnSave } from './ai/drafts'
import * as aiStore from './ai/store'
import { listMcpLog } from './mcp/log'
import { mcpConfigSchema, type McpSettingsView } from '@shared/mcp'
import { appSecretStore } from './services/secretStore'
import type { AiEvent } from '@shared/ai'
import { registerReceivablesIpc } from './ipcReceivables'
import { creditOverrideSchema } from '@shared/receivables/schemas'
import { UI_MODES, uiPatchSchema } from '@shared/simple/uiMode'
import { registerPayablesIpc } from './ipcPayables'
import { registerBankingIpc } from './ipcBanking'
import { registerCashFinanceIpc } from './ipcCashFinance'
import { registerWorkspaceIpc } from './ipcWorkspace'
import { registerDataRootIpc } from './ipcDataRoot'
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
import { writeExportPdf, writePdfFile } from './services/pdf'
import { chooseExportPath, hermeticRun, type ExportTargetRequest } from './exportTarget'
import { MASTERS_CHANGED_EVENT, masterEntitiesOf } from './masterEvents'
import { reportHtml } from './services/reportHtml'
import { globalSearch, search } from './services/search'
import { createDemoCompany } from './services/demo'
import { createCompanyFromSetup } from './services/companySetup'
import * as simplePost from './services/simplePost'
import * as simpleHandoff from './services/simpleHandoff'
import * as simpleMoney from './services/simpleMoney'
import * as simplePeople from './services/simplePeople'
import * as simpleSell from './services/simpleSell'
import * as simpleReturns from './services/simpleReturns'
import * as simpleBank from './services/simpleBank'
import * as simpleBuy from './services/simpleBuy'
import * as simpleStock from './services/simpleStock'
import * as simpleReports from './services/simpleReports'
import * as simpleTaxes from './services/simpleTaxes'
import { doingQuerySchema, owedQuerySchema } from '@shared/simple/reports'
import { gstFiledInputSchema, quarterExportMonths, taxesQuerySchema } from '@shared/simple/taxes'
import { simpleIntentSchema } from '@shared/simple/intents'
import { CARRY_FLOWS } from '@shared/simple/carryBack'
import { peopleListSchema, personRemindedSchema, personUpdateSchema, personViewSchema } from '@shared/simple/people'
import { bankAcceptSchema } from '@shared/simple/bank'
import { simpleSetupSchema } from '@shared/simple/setup'
import { simpleOpeningsSchema } from '@shared/simple/openings'
import * as openingsSvc from './services/openings'
import { gstProfilePatchSchema } from '@shared/gst/filing'
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
  auditRetentionSchema, auditExportSchema, auditTrailRequiredSchema, invoicePdfBatchSchema, linksForVoucherSchema, openSourceLinesSchema, tradePendingSchema, tradeNoteListSchema, tradeDocNextNumberSchema,
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
  /** WP 7.2: the file is encrypted (locked with a passphrase). */
  encrypted: boolean
}

let current: OpenCompany | null = null

/** WP 7.2: the passphrase KDF cost — the real one, except in a hermetic test run that already
 *  uses the insecure test cipher (TOTAL_INSECURE_TEST_SECRETS + TOTAL_DATA_DIR, never packaged),
 *  where the cheapest cost the envelope accepts keeps e2e fast. */
function scryptParams(): ScryptParams {
  return insecureTestCipherAllowed(process.env, app.isPackaged) ? { N: 2 ** 14, r: 8, p: 1 } : DEFAULT_SCRYPT
}

/** WP 7.2: the session's idle clock (auto-lock minutes from the open company's meta). */
const idleClock = new IdleClock(null)

/** WP 7.2: wrong passphrases per company slug — 5 in a row lock the prompt for 30 seconds (in
 *  memory: the passphrase cannot be checked against anything inside the locked file). */
// The wrong-passphrase counter is shared with consolidation runs and total-cli (companyKeys.ts).

/** Paths the Tally-import file dialog has actually issued this session. A `filePath` supplied in
 *  a tally:import payload must be one of these — otherwise the renderer could pass any path on
 *  disk and have it read straight into the app (arbitrary file read). The dryRun -> apply wizard
 *  flow still works: dryRun's dialog pick adds the path here, and apply's payload just needs to
 *  echo that same path back. The `xmlText` inline path (used by drivers/tests) is unaffected. */
const dialogIssuedTallyPaths = new Set<string>()

/** The signed-in user for the currently-open company, or null before login / after logout.
 *  Cleared whenever the company itself closes (see closeCurrentCompany). */
let sessionUser: { id: number; name: string; role: Role; capabilities: CapabilityFlags | null } | null = null

/** WP 7.2 follow-up: the screen lock of a business WITHOUT users (⌘L / its idle minutes) — a
 *  privacy screen: every gated channel is refused until `session:unlock`, which asks for the
 *  business's passphrase when the passphrase lock is on and otherwise just resumes. In memory
 *  only (a restart opens unlocked, as a company without users always did). */
let privacyLock: 'manual' | 'idle' | null = null

/** "Remember on this computer" ticked at the passphrase prompt of a business WITH people: the key
 *  is stored only once an OWNER signs in to this open (auth:login); any other sign-in, or closing
 *  the business, drops the request. In memory only — the key itself is the folder's session key. */
let pendingRemember: string | null = null

/** What the lock screen asks for: a PIN (people), the passphrase, or nothing (a privacy screen). */
type LockKind = 'pin' | 'passphrase' | 'privacy'
const lockKindOf = (c: OpenCompany): LockKind => (c.usersExist ? 'pin' : c.encrypted ? 'passphrase' : 'privacy')

function lockPrivacy(reason: 'manual' | 'idle'): void {
  if (!current || current.usersExist || privacyLock) return
  try {
    writeAudit(current.db, 'user', 0, 'logout', null, { lock: reason, noUsers: true })
  } catch (err) {
    log('warn', 'session-lock-audit-failed', { error: err instanceof Error ? err.message : String(err) })
  }
  privacyLock = reason
  const kind = lockKindOf(current)
  for (const w of BrowserWindow.getAllWindows?.() ?? []) if (!w.isDestroyed()) w.webContents.send('total:session:locked', { reason, kind })
}

/** WP 7.2: sign the session out because of a lock (⌘L / idle); audited as the user's logout with
 *  the reason, and every window told so it shows the PIN screen. */
function lockSession(reason: 'manual' | 'idle'): void {
  if (!current || !sessionUser) return
  try {
    writeAudit(current.db, 'user', sessionUser.id, 'logout', null, { lock: reason })
  } catch (err) {
    log('warn', 'session-lock-audit-failed', { error: err instanceof Error ? err.message : String(err) })
  }
  sessionUser = null
  for (const w of BrowserWindow.getAllWindows?.() ?? []) if (!w.isDestroyed()) w.webContents.send('total:session:locked', { reason, kind: 'pin' })
}

/** IPC calls running now, and when the last one started or ended (Date.now()) — the deferred
 *  backup check waits for a quiet moment (see scheduleBackupCheck). */
let ipcInFlight = 0
let lastIpcAt = 0
/** The open's restore check copies, migrates and verifies the whole file on the main thread
 *  (~1–2 s at 100k on a fast machine, far more on a loaded one): it waits until no IPC call has
 *  run for this long, so the screen that just opened (Home) gets its reads answered first. */
export const BACKUP_CHECK_QUIET_MS = 2_000
/** …but never longer than this after the backup, however busy the app is. */
export const BACKUP_CHECK_LATEST_MS = 60_000

/** WP 7.2: the automatic restore check of a backup that was just written — deferred a few
 *  seconds so it never delays the reply that triggered the backup, then (launch to Home) until
 *  the app is quiet — no IPC call for BACKUP_CHECK_QUIET_MS — or BACKUP_CHECK_LATEST_MS have
 *  passed, so Home's reads are not queued behind it; skipped when not due (at most daily for
 *  automatic backups) or when the company was closed meanwhile. What it checks is unchanged. */
export function scheduleBackupCheck(db: DB, dest: string, tag: string): void {
  const scheduledAt = Date.now()
  const later = (ms: number): void => {
    const t = setTimeout(tick, ms)
    t.unref?.()
  }
  const tick = (): void => {
    const wait = quietWaitMs({
      now: Date.now(), scheduledAt, inFlight: ipcInFlight, lastActivityAt: lastIpcAt,
      quietMs: BACKUP_CHECK_QUIET_MS, latestMs: BACKUP_CHECK_LATEST_MS
    })
    if (wait > 0) later(wait)
    else void run()
  }
  const run = async (): Promise<void> => {
    const t0 = performance.now()
    try {
      // The check itself runs in the check worker; main only records the verdict.
      const check = await checkBackupIfDue(db, dest, tag, todayISO(), SYSTEM_AUDIT_USER)
      if (check && !check.ok) log('warn', 'backup-check-failed', { file: check.file, error: check.error })
    } catch (err) {
      log('warn', 'backup-check-error', { error: err instanceof Error ? err.message : String(err) })
    }
    // Wall time of the check (off the main thread where the worker file exists) — the launch trace shows it.
    if (TRACE_IPC) console.log(`[ipc] (timer) backup check ${(performance.now() - t0).toFixed(0)} ms`)
  }
  later(3_000)
}

/** The signed-in user's view of themselves (auth:login / auth:current): role, flags and the
 *  effective capabilities the gate applies. */
function sessionView(u: { id: number; name: string; role: Role; capabilities: CapabilityFlags | null }): { id: number; name: string; role: Role; capabilities: CapabilityFlags | null; can: Record<Capability, boolean> } {
  return { ...u, can: effectiveCapabilities(u.role, u.capabilities) }
}

/** Whether the current session may see profit figures (dashboards / Home leave them out otherwise). */
export function canSeeProfitNow(): boolean {
  if (!current?.usersExist || !sessionUser) return true
  return effectiveCapabilities(sessionUser.role, sessionUser.capabilities).canSeeProfit
}

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
    const d = openDb(dbPath, { readonly: true, fileMustExist: true })
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

/** Whether any company in the data root other than the open one (every company when none is open —
 *  the company-select screen) has active users. ONE helper for every app-wide setting guarded by the
 *  AI-key rule: the shared AI key (ai:key:set) and the update setting (app:updates:set / act). */
function otherCompanyHasUsers(): boolean {
  return readRegistry().companies.some((co) => co.slug !== current?.slug && companyHasUsers(companyDbPath(co.slug)))
}

/** App-level, append-only record of API key changes (WP 5.1) — beside secrets.json, outside
 *  every company (the key is shared by all of them). */
function appendAiKeyAudit(entry: AppKeyAuditEntry): void {
  appendFileSync(join(dataRoot(), 'ai-key-audit.jsonl'), `${JSON.stringify({ ...entry, appVersion: app.getVersion() })}\n`, { mode: 0o600 })
}

export function closeCurrentCompany(opts: { keepKey?: boolean } = {}): void {
  // WP 7.2: a business locked with a passphrase asks for it again on its next open — its key is
  // forgotten with the handle (a restore / a lock change reopens it at once and keeps it).
  if (current && !opts.keepKey) forgetFolderKey(companyDir(current.slug))
  idleClock.setMinutes(null)
  privacyLock = null
  pendingRemember = null
  // Stop the inbox watcher + any pending mirror refresh before the handle closes under them.
  agentBridge.syncInboxWatcher(null)
  // The cached NIC login belongs to this company's identity — never carry it into the next one.
  nic.resetNicSession()
  // In-flight AI answers belong to this company's handle — stop them before it closes.
  aiRuns.cancelAll()
  // WP 5.4: the capture queue runner and the capture-inbox watcher, too.
  captureOnCompanyClose()
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
  // WP 7.2 follow-up: the unlock of a business without users (it refuses one with users).
  'session:unlock',
  'company:list',
  'company:create',
  'company:createDemo',
  'company:delete',
  'company:open',
  'company:current',
  // "Remember on this computer" at the picker: presence of a remembered key, and Forget (which only
  // takes the convenience away — the passphrase still opens the books).
  'company:remembered',
  'company:forgetRemembered',
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

/** WP 7.2: channel → the capability flag that governs it (capabilities.ts), built once. */
let capabilityMap: Map<string, Capability> | null = null
export function channelCapabilityMap(): Map<string, Capability> {
  capabilityMap ??= channelCapabilities(UNGATED_CHANNELS)
  return capabilityMap
}

/** The structured fields of a failed call (WP 8.5): an AppError's own; a Zod failure as
 *  'invalid_input' with one 'zod.<code>' issue per path (the `data` wrapper of `{ id, data }` /
 *  voucher:save payloads stripped); a UNIQUE clash on a name column as 'duplicate_name'. */
export function ipcStructuredError(err: unknown): Partial<StructuredError> {
  const own = structuredOf(err)
  if (own) return own
  if (err instanceof z.ZodError) {
    return {
      code: 'invalid_input',
      issues: err.issues.map((i) => {
        const path = i.path[0] === 'data' ? i.path.slice(1) : i.path
        return { code: `zod.${i.code}`, ...(path.length ? { field: path.join('.') } : {}), message: `${i.path.join('.')}: ${i.message}` }
      })
    }
  }
  const sqlite = err as { code?: unknown; message?: unknown }
  if (sqlite?.code === 'SQLITE_CONSTRAINT_UNIQUE' && typeof sqlite.message === 'string') {
    const column = /UNIQUE constraint failed: \w+\.(\w+)/.exec(sqlite.message)?.[1]
    if (column === 'name') return { code: 'duplicate_name', field: 'name' }
  }
  return {}
}

/** WP 7.1: TOTAL_IPC_TRACE=1 (scratch data dir only) prints each handler's duration to stdout —
 *  scripts/perf-launch.mjs reads it to say where opening a big company goes. Channel names only. */
const TRACE_IPC = process.env.TOTAL_IPC_TRACE === '1' && !!process.env.TOTAL_DATA_DIR

/** to-do §4: after a write that can change masters, every window refetches those cached lists
 *  (masterEvents.ts) — so a screen sees an item created elsewhere without being reopened. */
function notifyMastersChanged(channel: string): void {
  const entities = masterEntitiesOf(channel)
  if (!entities.length) return
  // The write has committed: a window that is going away must never turn it into a failed call
  // (the renderer would show an error for a saved change and a retry would save it twice).
  try {
    for (const w of BrowserWindow.getAllWindows?.() ?? []) if (!w.isDestroyed()) w.webContents.send(MASTERS_CHANGED_EVENT, { entities })
  } catch (err) {
    log('warn', 'masters-changed', { channel, error: err instanceof Error ? err.message : String(err) })
  }
}

function handle(channel: string, fn: Handler, minRole: Role = 'accountant'): void {
  CHANNEL_ROLES.set(channel, minRole)
  ipcMain.handle(`total:${channel}`, async (event, payload: unknown) => {
    // D7: only the app's own renderer (main frame, out/renderer/index.html or the dev server) may
    // call — checked before anything else, the payload included (ipcSender.ts).
    const sender = checkSender(event)
    if (!sender.ok) {
      const seen = firstRefusalOf(event, sender.reason)
      if (seen.first) log('warn', 'ipc-sender-refused', { channel, reason: sender.reason, scheme: seen.scheme, host: seen.host, senderId: seen.senderId })
      return { ok: false, error: 'You do not have permission to do that', code: 'not_permitted' }
    }
    const t0 = TRACE_IPC ? performance.now() : 0
    ipcInFlight++
    lastIpcAt = Date.now()
    try {
      // Role gating is a no-op until a company is open AND that company has at least one user
      // (usersExist is cached on `current` — see OpenCompany — to avoid a COUNT query per call).
      // A brand-new company with zero users is intentionally wide open: that's how the very
      // first (owner) user gets created via users:save without a chicken-and-egg deadlock.
      // WP 7.2: an idle session past its auto-lock minutes is locked here, before the gate — main
      // decides, so a renderer that missed the lock event cannot keep using the session.
      if (current && current.usersExist && sessionUser && idleClock.due()) lockSession('idle')
      if (current && !current.usersExist && !privacyLock && idleClock.due()) lockPrivacy('idle')
      // A business without users whose screen is locked: everything but the ungated channels
      // (the picker, session:unlock) waits for session:unlock.
      if (!UNGATED_CHANNELS.has(channel) && current && !current.usersExist && privacyLock) {
        throw new AppError('session_locked', 'Locked — unlock first')
      }
      if (!UNGATED_CHANNELS.has(channel) && current && current.usersExist) {
        if (!sessionUser) {
          // Distinct from the role-denied case below: the renderer can route this specifically
          // to the lock screen instead of a generic permission toast.
          throw new AppError('session_locked', 'Locked — sign in first')
        }
        // WP 7.2: a channel governed by a capability flag follows the user's flag (none set = the
        // role, exactly as before); every other channel follows the role alone.
        const cap = channelCapabilityMap().get(channel)
        const allowed = cap ? capabilityAllows(sessionUser.role, sessionUser.capabilities, cap, minRole) : roleAllows(sessionUser.role, minRole)
        if (!allowed) {
          throw new AppError('not_permitted', 'You do not have permission to do that')
        }
      }
      const data = await fn(payload)
      notifyMastersChanged(channel)
      if (TRACE_IPC) console.log(`[ipc] ${channel} ${(performance.now() - t0).toFixed(0)} ms`)
      return { ok: true, data }
    } catch (err) {
      if (TRACE_IPC) console.log(`[ipc] ${channel} failed ${(performance.now() - t0).toFixed(0)} ms`)
      const message = err instanceof z.ZodError
        ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
        : err instanceof Error
          ? err.message
          : String(err)
      // Never log payloads — only the channel name and the error message.
      log('error', 'ipc-handler', { channel, error: message })
      // WP 8.5: the structured part (code / field / params / issues) rides next to the message
      // so a screen can show a plain message under the field; `error` is unchanged.
      return { ok: false, error: message, ...ipcStructuredError(err) }
    } finally {
      ipcInFlight--
      lastIpcAt = Date.now()
    }
  })
}

const idSchema = z.object({ id: z.number().int().positive() })
const withIdSchema = <T extends z.ZodTypeAny>(schema: T) => z.object({ id: z.number().int().positive(), data: schema })

/** [lane-Q audit] one-line summary audit row for every file-export handler (task Q1 #90). */
const auditExport = (db: DB, kind: string, detail: Record<string, unknown>): void =>
  writeAudit(db, 'export', 0, 'export', null, { kind, ...detail })

/** to-do §4: the labels PDF, CA pack and e-invoice JSON ask where to save (a native dialog that
 *  starts in `<company>/exports/` with the export's own name); hermetic runs skip it (exportTarget.ts). */
const pickExportPath = (slug: string, req: Omit<ExportTargetRequest, 'exportsDir'>): Promise<string | null> =>
  chooseExportPath(
    { ...req, exportsDir: companyExportsDir(slug) },
    {
      hermetic: () => hermeticRun(process.env, app?.isPackaged ?? null),
      showSaveDialog: (opts) => {
        const win = BrowserWindow.getFocusedWindow?.()
        return win ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts)
      }
    }
  )

export function registerIpc(): void {
  // WP 3.8 user attribution: the signed-in user (id + name). With no session the writer falls back
  // to the OS login ('os:<name>') — only reachable in a company without users, since a company
  // with users refuses every gated channel until someone signs in.
  setAuditContext({ appVersion: app.getVersion(), getUserName: () => sessionUser?.name ?? null, getUserId: () => sessionUser?.id ?? null })

  // WP 7.2: the auto-lock fires on its own too (not only at the next call), so the PIN screen
  // comes back while the app sits idle.
  const idleTimer = setInterval(() => {
    if (current && current.usersExist && sessionUser && idleClock.due()) lockSession('idle')
    if (current && !current.usersExist && !privacyLock && idleClock.due()) lockPrivacy('idle')
  }, 15_000)
  idleTimer.unref?.()

  // ---------- fixed assets (WP 3.6) — channels live in ipcFixedAssets.ts ----------
  registerFixedAssetIpc(handle, () => requireCompany().db)
  // ---------- payroll statutory (WP 3.7) — channels live in ipcPayrollStatutory.ts ----------
  registerPayrollStatutoryIpc(handle, () => requireCompany())
  registerPricingIpc(handle, () => requireCompany())
  // ---------- report builder, comparatives, ratios, scheduled packs (WP 6.1 / 6.2) ----------
  registerReportsIpc(handle, () => requireCompany(), () => sessionUser?.name ?? osAuditUser(), canSeeProfitNow)
  // ---------- group consolidation (WP 6.5) — channels live in ipcConsolidation.ts ----------
  registerConsolidationIpc(handle, () => requireCompany())
  // ---------- AI agent (WP 5.1) — channels live in ai/ipc.ts; events stream on 'total:ai:event' ----------
  registerAiIpc(handle, {
    company: () => requireCompany(),
    session: () => (sessionUser ? { name: sessionUser.name, role: sessionUser.role } : { name: null, role: 'owner' }),
    // A company with users and nobody signed in has no role (the run stops at its next tool call).
    roleNow: () => (sessionUser ? sessionUser.role : current?.usersExist ? null : 'owner'),
    canSeeProfit: canSeeProfitNow,
    secrets: () => appSecretStore(),
    anyCompanyHasUsers: otherCompanyHasUsers,
    appAudit: (entry) => appendAiKeyAudit(entry),
    emit: (e: AiEvent) => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('total:ai:event', e)
    },
    mock: () => aiMockAllowed(process.env, app.isPackaged)
  })
  // ---------- document capture (WP 5.4) — channels live in ai/capture/ipc.ts ----------
  registerCaptureIpc(handle, {
    company: () => requireCompany(),
    session: () => (sessionUser ? { name: sessionUser.name, role: sessionUser.role } : { name: null, role: 'owner' }),
    secrets: () => appSecretStore(),
    mock: () => aiMockAllowed(process.env, app.isPackaged)
  })
  // ---------- assistants (WP 5.5): close checklist, anomalies, GSTR-2B mismatches — ipcAssistants.ts ----------
  registerAssistantsIpc(handle, () => requireCompany(), () => sessionUser?.name ?? osAuditUser())
  // ---------- Ask Total (WP 10.1): deterministic answers + entry drafts, no key — assist/ipc.ts ----------
  // WP 7.2: a profit question from a user who may not see profit gets the redaction note — the
  // deterministic classifier reads the question exactly as assist:ask does (Hinglish included).
  const askTotalHandle = (channel: string, fn: Handler, minRole?: Role): void =>
    handle(channel, channel === 'assist:ask' ? (p) => profitHiddenAnswer(p) ?? fn(p) : fn, minRole)
  const profitHiddenAnswer = (payload: unknown): AssistAnswer | null => {
    if (canSeeProfitNow()) return null
    const q = assistAskSchema.parse(payload)
    const intent = classifyAsk(q.text, homeAsOn(q.today, todayISO()))
    if (intent.kind !== 'figure' || intent.measure !== 'profit') return null
    const t = translator(q.lang ?? companyLanguage(requireCompany().db))
    return { intent: 'figure', answeredBy: 'total', sentences: [t('assist.profitHidden')], figures: [], links: [], understood: true }
  }
  registerAskTotalIpc(askTotalHandle, {
    company: () => requireCompany(),
    roleNow: () => (sessionUser ? sessionUser.role : current?.usersExist ? null : 'owner'),
    userNow: () => sessionUser?.id ?? null
  })
  // ---------- receivables (WP 4.2) — channels live in ipcReceivables.ts ----------
  registerReceivablesIpc(handle, () => requireCompany())
  // ---------- payables (WP 4.3) — channels live in ipcPayables.ts ----------
  registerPayablesIpc(handle, () => requireCompany())
  // ---------- banking depth (WP 4.1) — channels live in ipcBanking.ts ----------
  registerBankingIpc(handle, () => requireCompany())
  // ---------- cash and finance (WP 4.4) — channels live in ipcCashFinance.ts ----------
  registerCashFinanceIpc(handle, () => requireCompany())
  // ---------- bulk edit, attachments, party notes (WP 6.4) — channels live in ipcWorkspace.ts ----------
  registerWorkspaceIpc(handle, () => requireCompany())
  // Settings → "Where Total keeps your books" (app-level, owner where the company has users).
  registerDataRootIpc(handle, {
    closeCompany: async () => {
      closeCurrentCompany()
      // Every background check, not only the company file's: backup checks read files in the folder too.
      await stopAllChecks()
    },
    who: () => sessionUser?.name ?? null
  })
  // ---------- Excel export, import wizard, books workbook (WP 6.3) — ipcDataImport.ts ----------
  registerDataImportIpc(handle, () => requireCompany(), { canChangeCompanyInfo, userName: () => sessionUser?.name ?? null })

  // ---------- company ----------
  handle('company:list', () => readRegistry())

  handle('company:create', (payload) => {
    // WP 8.1: `mode` picks the company's mode; omitted = accountant (the default until the WP 8.3
    // setup wizard), which writes no `ui` meta at all — a missing key means accountant.
    const { mode, ...input } = companyCreateSchema.extend({ mode: z.enum(UI_MODES).optional() }).parse(payload)
    let slug = slugify(input.name)
    let n = 2
    while (existsSync(companyDbPath(slug))) slug = `${slugify(input.name)}-${n++}`
    ensureCompanyTree(slug)
    const db = openCompanyDb(slug)
    const info: CompanyInfo = { ...input }
    seedCompany(db, info)
    writeAudit(db, 'company', 0, 'create', null, info)
    if (mode === 'simple') configSvc.setUi(db, { mode })
    db.close()
    upsertCompany({ slug, name: input.name, stateCode: input.stateCode, gstin: input.gstin, lastOpenedAt: null })
    return { slug }
  })

  // WP 8.3: the plain-language setup wizard — a company from the answers (business type preset,
  // GST, stock, start date) in one transaction; services/companySetup.ts. Default mode simple (D2).
  handle('simple:setup', (payload) => createCompanyFromSetup(simpleSetupSchema.parse(payload), todayISO()))

  // WP 8.7: the plain-language opening setup (services/openings.ts) — what a continuing business
  // had on day one. `get` reads the books' openings; `preview` rehearses the run (rolled back) for
  // the confirm step; `simple:openings` writes it in one transaction once the user confirmed the
  // owner's-money figure; `skip` = "I started fresh" (meta ui.startedFresh).
  handle('simple:openings:get', () => openingsSvc.openingsState(requireCompany().db), 'viewer')
  handle('simple:openings:preview', (payload) => openingsSvc.previewOpenings(requireCompany().db, simpleOpeningsSchema.parse(payload)))
  handle('simple:openings', (payload) => openingsSvc.applyOpenings(requireCompany().db, simpleOpeningsSchema.parse(payload)))
  handle('simple:openings:skip', (payload) => {
    z.object({}).strict().optional().parse(payload)
    return openingsSvc.skipOpenings(requireCompany().db)
  })

  // WP 9.3: the simple Buy screens' reads (services/simpleBuy.ts) — the form's suppliers, cash /
  // bank accounts and their defaults (WP 5.6 memory "Pay from", else the counter's), the purchase
  // list with what is still due on each bill (the Outstandings allocation as on today) and one
  // bill's simple view. Writing goes through simple:post only.
  handle('simple:buy:setup', (payload) => {
    z.object({}).strict().optional().parse(payload)
    return simpleBuy.buySetup(requireCompany().db)
  }, 'viewer')
  handle('simple:purchases', (payload) => {
    const { from, to, today } = z.object({ from: isoDate, to: isoDate, today: isoDate.optional() }).strict().parse(payload)
    return simpleBuy.purchasesList(requireCompany().db, from, to, homeAsOn(today, todayISO()))
  }, 'viewer')
  handle('simple:purchase', (payload) => {
    const { id, today } = z.object({ id: z.number().int().positive(), today: isoDate.optional() }).strict().parse(payload)
    return simpleBuy.purchaseView(requireCompany().db, id, homeAsOn(today, todayISO()))
  }, 'viewer')

  // WP 9.1: the ONE write path of the simple screens (services/simplePost.ts) — an intent mapped to
  // the editors' own form state and saved through saveVoucher in one transaction (idempotent by
  // clientId; the vouchers come back together for the save card's grouped Undo). `preview`
  // rehearses the same run (always rolled back) and says what will be recorded.
  const simpleIntentPayload = z.object({ intent: simpleIntentSchema, today: isoDate.optional() }).strict()
  handle('simple:preview', (payload) => {
    const { intent, today } = simpleIntentPayload.parse(payload)
    const c = requireCompany()
    return simplePost.previewIntent(c.db, c.info, intent, today ?? todayISO())
  }, 'viewer')
  // WP 10.1: `aiDraftId` = the flow was opened from an Ask Total draft — the save consumes it in
  // the same transaction (only an open ask-total draft of the same kind; anything else is ignored).
  const simplePostPayload = simpleIntentPayload.extend({ aiDraftId: z.number().int().positive().optional() }).strict()
  // WP 9.10: "Accountant view" of an unsaved simple form — the editors' own form state for the
  // current answers (the same mapping, rolled back); "Back to simple" — what a voucher / ledger is.
  handle('simple:intentForm', (payload) => {
    const { intent, today } = simpleIntentPayload.parse(payload)
    const c = requireCompany()
    return simplePost.intentForm(c.db, c.info, intent, today ?? todayISO())
  }, 'viewer')
  // WP 9.10 follow-up: "Back to simple" from an unsaved hand-off editor — its changes carried back
  // into the simple form (pure carryBack over simple:post's context, rolled back). The entries and
  // the form are the renderer's own state handed through; carryBack reads only their known fields.
  const handoffEntryPayload = z
    .object({
      role: z.string(),
      kind: z.string(),
      voucherTypeId: z.number().int(),
      amount: z.number().int(),
      form: z.enum(['invoice', 'accounting', 'physical', 'manufacture']),
      state: z.object({ date: isoDate }).passthrough(),
      pending: z.record(z.string(), z.unknown()).optional()
    })
    .strict()
  handle('simple:carryBack', (payload) => {
    const p = z
      .object({
        flow: z.enum(CARRY_FLOWS),
        intent: simpleIntentSchema,
        original: handoffEntryPayload,
        current: handoffEntryPayload,
        base: z.record(z.string(), z.unknown()),
        today: isoDate.optional()
      })
      .strict()
      .parse(payload)
    const c = requireCompany()
    return simpleHandoff.carryBackForm(c.db, c.info, p as unknown as simpleHandoff.CarryBackRequest, p.today ?? todayISO())
  }, 'viewer')
  handle('simple:handoffTarget', (payload) => {
    const q = z.object({ voucherId: z.number().int().positive().optional(), ledgerId: z.number().int().positive().optional() }).strict().parse(payload)
    return simpleHandoff.handoffFacts(requireCompany().db, q)
  }, 'viewer')
  handle('simple:post', (payload) => {
    const { intent, today, aiDraftId } = simplePostPayload.parse(payload)
    const c = requireCompany()
    const out = c.db.transaction(() => {
      const r = simplePost.postIntent(c.db, c.info, intent, today ?? todayISO())
      if (aiDraftId && !r.replayed) settleAskDraft(c.db, aiDraftId, intent.kind, r.voucherIds)
      return r
    })()
    if (!out.replayed && configSvc.getAgentBridgeEnabled(c.db)) agentBridge.scheduleMirrorRefresh(c.db, c.slug)
    return out
  })

  // WP 9.4: the simple Money screens' reads (services/simpleMoney.ts) — the forms' customers,
  // suppliers, cash / bank accounts and their defaults (WP 5.6 memory, else the counter's), a
  // party's open bills (the Outstandings allocation), the money list and one entry's view.
  // Writing goes through simple:post only.
  handle('simple:money:setup', (payload) => {
    const opts = z.object({ customerCredits: z.boolean().optional() }).strict().optional().parse(payload)
    return simpleMoney.moneySetup(requireCompany().db, opts ?? {})
  }, 'viewer')
  handle('simple:money:bills', (payload) => {
    const { partyId, date } = z.object({ partyId: z.number().int().positive(), date: isoDate }).strict().parse(payload)
    return simpleMoney.moneyBills(requireCompany().db, partyId, date)
  }, 'viewer')
  handle('simple:money:list', (payload) => {
    // `today` = the working date the list's range is built on, so "dated ahead" agrees with it.
    const { from, to, today } = z.object({ from: isoDate, to: isoDate, today: isoDate.optional() }).strict().parse(payload)
    return simpleMoney.moneyList(requireCompany().db, from, to, today ?? todayISO())
  }, 'viewer')
  handle('simple:money:entry', (payload) => {
    const { id } = z.object({ id: z.number().int().positive() }).strict().parse(payload)
    return simpleMoney.moneyEntry(requireCompany().db, id)
  }, 'viewer')
  // WP 9.2: the simple Sell screens' reads (services/simpleSell.ts) — the form's customers, cash /
  // bank accounts and their defaults (WP 5.6 memory, else the counter's), the sales list with what
  // is still due on each bill (the Outstandings allocation as on today) and one bill's simple view.
  // Writing goes through simple:post only.
  handle('simple:sell:setup', () => simpleSell.sellSetup(requireCompany().db), 'viewer')
  handle('simple:sales', (payload) => {
    const { from, to, today } = z.object({ from: isoDate, to: isoDate, today: isoDate.optional() }).strict().parse(payload)
    return simpleSell.salesList(requireCompany().db, from, to, homeAsOn(today, todayISO()))
  }, 'viewer')
  handle('simple:sale', (payload) => {
    const { id, today } = z.object({ id: z.number().int().positive(), today: isoDate.optional() }).strict().parse(payload)
    return simpleSell.saleView(requireCompany().db, id, homeAsOn(today, todayISO()))
  }, 'viewer')
  // WP 9.7: the simple Stock screens' reads (services/simpleStock.ts) — the product list (the
  // Stock summary's own valuation pass as on today), one product's view and history, and Made
  // goods' recipes. Counting and making go through simple:post; "Change price" writes the
  // product's row on the default price level (priceLevels.saveRate, audited).
  handle('simple:stock:list', (payload) => {
    const { today } = z.object({ today: isoDate.optional() }).strict().optional().parse(payload) ?? {}
    return simpleStock.stockList(requireCompany().db, homeAsOn(today, todayISO()))
  }, 'viewer')
  handle('simple:stock:product', (payload) => {
    const { id, today } = z.object({ id: z.number().int().positive(), today: isoDate.optional() }).strict().parse(payload)
    return simpleStock.stockProduct(requireCompany().db, id, homeAsOn(today, todayISO()))
  }, 'viewer')
  // A saved stock count reopened, with the difference the valuation engine recorded.
  handle('simple:stock:count', (payload) => {
    const { voucherId } = z.object({ voucherId: z.number().int().positive() }).strict().parse(payload)
    return simpleStock.savedCount(requireCompany().db, voucherId)
  }, 'viewer')
  handle('simple:stock:madeSetup', (payload) => {
    const { date } = z.object({ date: isoDate }).strict().parse(payload)
    return simpleStock.madeGoodsSetup(requireCompany().db, date)
  }, 'viewer')
  handle('simple:stock:setPrice', (payload) => {
    const { itemId, ratePaise, date } = z.object({ itemId: z.number().int().positive(), ratePaise: z.number().int().positive().max(1e13), date: isoDate.optional() }).strict().parse(payload)
    return simpleStock.setSellingPrice(requireCompany().db, itemId, ratePaise, date ?? todayISO())
  })
  // The simple recipe editor: a NEW BOM version through bom.saveBomVersion (the full editor's
  // save and audit row; accountant+, as bom:saveVersion), the labour per unit beside it.
  handle('simple:stock:setRecipe', (payload) => {
    const q = z
      .object({
        itemId: z.number().int().positive(),
        rows: z.array(z.object({ itemId: z.number().int().positive(), qtyMilli: z.number().int().min(0).max(1e12) }).strict()).max(200),
        labourPerUnit: z.number().int().min(0).max(1e13).nullable().optional(),
        date: isoDate.optional()
      })
      .strict()
      .parse(payload)
    return simpleStock.saveRecipe(requireCompany().db, { itemId: q.itemId, rows: q.rows, labourPerUnit: q.labourPerUnit ?? null }, q.date ?? todayISO())
  })

  // WP 9.9: the simple Reports screens (services/simpleReports.ts) — read-only, as on today (a
  // later date asked for is clamped): how the business is doing for a period (the P&L's own
  // totals), cash in the next 30 days (the Cash forecast), who owes whom (Outstandings) and the
  // registers by month.
  handle('simple:reports:doing', (payload) => {
    const q = doingQuerySchema.parse(payload)
    return simpleReports.businessDoing(requireCompany().db, q, homeAsOn(q.today, todayISO()))
  }, 'viewer')
  handle('simple:reports:cash', (payload) => {
    const { today } = z.object({ today: isoDate.optional() }).strict().optional().parse(payload) ?? {}
    const c = requireCompany()
    return simpleReports.cashNext30(c.db, c.info, homeAsOn(today, todayISO()))
  }, 'viewer')
  handle('simple:reports:owed', (payload) => {
    const { side, today } = owedQuerySchema.parse(payload)
    return simpleReports.owedList(requireCompany().db, side, homeAsOn(today, todayISO()))
  }, 'viewer')
  handle('simple:reports:byMonth', (payload) => {
    const { today } = z.object({ today: isoDate.optional() }).strict().optional().parse(payload) ?? {}
    return simpleReports.byMonth(requireCompany().db, homeAsOn(today, todayISO()))
  }, 'viewer')
  // WP 9.9: the simple Taxes screen (services/simpleTaxes.ts) — the GST answer for a period (the
  // Home tile's by default) over gstr3b() / GSTR-2B / the close checklist, TDS / TCS when on;
  // and "I've filed" (meta gstFiled: ARN + date per return, audited as a company update).
  handle('simple:taxes', (payload) => {
    const { period, today } = taxesQuerySchema.parse(payload ?? {})
    const c = requireCompany()
    return simpleTaxes.simpleTaxes(c.db, c.info, { period }, homeAsOn(today, todayISO()))
  }, 'viewer')
  handle('simple:taxes:filed', (payload) => {
    const input = gstFiledInputSchema.parse(payload)
    const c = requireCompany()
    return simpleTaxes.setGstFiled(c.db, c.info, input, sessionUser?.name ?? null, todayISO())
  })

  // WP 9.8: the simple People screens (services/simplePeople.ts) — every figure as on today from
  // the Outstandings allocation (the Outstandings screen's and Home's). Phone / WhatsApp / credit
  // days go through masters.updateLedger (the full app's account write, accountant+); a reminder
  // sent from a person's page is logged in reminder_log like the WP 4.2 letter (accountant+).
  handle('simple:people:list', (payload) => {
    const { today } = peopleListSchema.parse(payload ?? {})
    return simplePeople.peopleList(requireCompany().db, homeAsOn(today, todayISO()))
  }, 'viewer')
  handle('simple:people:person', (payload) => {
    const { id, today } = personViewSchema.parse(payload)
    const c = requireCompany()
    return simplePeople.personView(c.db, c.info, id, homeAsOn(today, todayISO()))
  }, 'viewer')
  handle('simple:people:billsToPay', (payload) => {
    const { today } = peopleListSchema.parse(payload ?? {})
    return simplePeople.billsToPay(requireCompany().db, homeAsOn(today, todayISO()))
  }, 'viewer')
  handle('simple:people:update', (payload) => simplePeople.updatePerson(requireCompany().db, personUpdateSchema.parse(payload)))
  handle('simple:people:reminded', (payload) => {
    const { id, via, tone, today } = personRemindedSchema.parse(payload)
    return simplePeople.personReminded(requireCompany().db, id, via, homeAsOn(today, todayISO()), tone)
  })

  // WP 9.5: the simple return screens' reads (services/simpleReturns.ts) — the recent bills with
  // what is still returnable, and one bill as simple:post maps a return from it (as on the
  // return's date, never past today). Writing goes through simple:post only.
  const returnSide = z.enum(['sale', 'purchase'])
  handle('simple:returns:bills', (payload) => {
    const { side, today, q, all } = z.object({ side: returnSide, today: isoDate.optional(), q: z.string().max(80).optional(), all: z.boolean().optional() }).strict().parse(payload)
    const c = requireCompany()
    return simpleReturns.returnBills(c.db, c.info, side, homeAsOn(today, todayISO()), q, { all })
  }, 'viewer')
  handle('simple:returns:bill', (payload) => {
    const { side, id, asOn } = z.object({ side: returnSide, id: z.number().int().positive(), asOn: isoDate.optional() }).strict().parse(payload)
    const c = requireCompany()
    return simpleReturns.returnBill(c.db, c.info, side, id, homeAsOn(asOn, todayISO()))
  }, 'viewer')
  // WP 9.6: the simple Bank screen (services/simpleBank.ts). Reads: the bank accounts and every
  // account's class; one bank's statement lines with the matcher's / categoriser's suggestion
  // (no model — the screen asks bankImport:categorise for that, only when AI is ready) and the
  // BRS sentence's facts. The write: each accepted line in its own transaction — confirming the
  // matcher's proposal, or a WP 9.1 intent through simple:post's service whose line is then
  // reconciled by bankImport.reconcileSavedDraft. The statement itself comes in through the
  // existing bankImport:pickFile / preview / commit channels.
  handle('simple:bank:setup', () => simpleBank.bankSetup(requireCompany().db), 'viewer')
  handle('simple:bank:lines', (payload) => {
    const { bankLedgerId, today, lang } = z
      .object({ bankLedgerId: z.number().int().positive(), today: isoDate.optional(), lang: z.enum(LANGUAGES).optional() })
      .strict()
      .parse(payload)
    return simpleBank.bankView(requireCompany().db, bankLedgerId, homeAsOn(today, todayISO()), lang)
  }, 'viewer')
  handle('simple:bank:accept', (payload) => {
    const { bankLedgerId, items, today } = bankAcceptSchema.extend({ today: isoDate.optional() }).strict().parse(payload)
    const c = requireCompany()
    const out = simpleBank.acceptLines(c.db, c.info, bankLedgerId, items, today ?? todayISO())
    if (out.done.length && configSvc.getAgentBridgeEnabled(c.db)) agentBridge.scheduleMirrorRefresh(c.db, c.slug)
    return out
  })

  // WP 8.3: `mode` 'simple' = the wizard's "Try with sample data" (D2); omitted = accountant, as before.
  handle('company:createDemo', (payload) =>
    createDemoCompany(z.object({ mode: z.enum(UI_MODES).optional() }).optional().parse(payload)?.mode)
  )

  handle('company:delete', async (payload) => {
    const { slug, confirmName, pin, passphrase } = z
      .object({
        slug: z.string().min(1),
        confirmName: z.string(),
        pin: z.string().regex(/^\d{4,12}$/, 'PIN must be 4-12 digits').optional(),
        passphrase: z.string().max(1024).optional()
      })
      .parse(payload)
    const reg = readRegistry()
    const company = reg.companies.find((c) => c.slug === slug)
    if (!company) throw new Error('Company not found')
    if (confirmName !== company.name) throw new Error('Company name does not match')
    // WP 7.2 review: a business locked with a passphrase cannot be read for its owners' PINs until
    // it is unlocked — without this, locking the books took away the PIN that protects the delete
    // (the unreadable file was treated as "no users"). The passphrase is asked first (throttled
    // like opening); once it opens the file the PIN check below runs as for any business.
    const keyWasKnown = keyForPath(companyDbPath(slug)) !== null
    // (No key file anywhere = nobody can ever read these books again: nothing left to protect.)
    if (readEnvelopes(companyDir(slug), slug, appSecretStore()).length) await unlockFolderIfNeeded(slug, passphrase, { useRemembered: false })
    // The name check above protects nothing by itself — it's readable off the same screen it's
    // typed into. If this company has users, an active owner's PIN is required too.
    try {
      assertDeleteAuthorized(companyDbPath(slug), pin)
    } catch (err) {
      // A refused delete leaves the business as locked as it was.
      if (!keyWasKnown) forgetFolderKey(companyDir(slug))
      throw err
    }
    // [lane-Q audit] durable record in the app log (survives the rmSync) + best-effort tombstone
    // row inside the DB itself.
    auditCompanyDeletion(companyDbPath(slug), slug, sessionUser?.name ?? null)
    log('warn', 'company-deleted', { slug, user: sessionUser?.name ?? null })
    if (current?.slug === slug) closeCurrentCompany()
    forgetFolderKey(companyDir(slug))
    // WP 7.1 review: a background check (the weekly integrity_check, a backup's restore check) may
    // still hold a file in the folder open.
    await stopChecksUnder(companyDir(slug))
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
    const { slug, passphrase, remember } = z
      .object({ slug: z.string().min(1), passphrase: z.string().max(1024).optional(), remember: z.boolean().optional() })
      .parse(payload)
    if (!existsSync(companyDbPath(slug))) throw new Error('Company database not found')
    // WP 7.2: a business locked with a passphrase needs it (its key is unwrapped and remembered
    // for this open); a plaintext one opens exactly as before — no prompt, nothing asked. The
    // business open until now is closed first (its key forgotten).
    closeCurrentCompany()
    const via = await unlockFolderIfNeeded(slug, passphrase)
    const opened = await openCompanyNow(slug)
    // "Remember on this computer" (ticked at the prompt, the passphrase just proved right): stored
    // at once in a business without people (whoever opens it is its owner), else once an owner
    // signs in (auth:login). Never fails the open.
    let rememberResult: 'saved' | 'pending' | 'unavailable' | undefined
    if (remember && via === 'passphrase' && current?.slug === slug) {
      if (!current.usersExist) rememberResult = rememberOpenKey(current, null)
      else {
        pendingRemember = slug
        rememberResult = 'pending'
      }
    }
    return { ...opened, openedWith: via ?? undefined, ...(rememberResult ? { remember: rememberResult } : {}) }
  })

  /** Store the open company's key as remembered on this computer, audited ('security', no key in
   *  the row). 'unavailable' without secure storage. */
  function rememberOpenKey(c: OpenCompany, user: string | null): 'saved' | 'unavailable' {
    const key = keyOfHandle(c.db)
    if (!key) return 'unavailable'
    const had = hasRememberedKey(c.slug, appSecretStore())
    try {
      storeRememberedKey(c.slug, key, appSecretStore())
    } catch (err) {
      log('warn', 'remember-key-unavailable', { slug: c.slug, error: err instanceof Error ? err.message : String(err) })
      return 'unavailable'
    }
    if (!had) writeAudit(c.db, 'security', 0, 'update', { rememberedOnThisComputer: false }, { rememberedOnThisComputer: true }, user ? { user } : {})
    return 'saved'
  }

  /**
   * Throttled passphrase unlock of a company folder (no-op when plaintext or already unlocked).
   * Without a passphrase the key remembered on this computer is tried first (accepted only once it
   * opens the file); a remembered key that no longer does is dropped and `remembered_key_stale`
   * asks for the passphrase. Returns how the folder was unlocked (null = nothing to unlock).
   */
  async function unlockFolderIfNeeded(slug: string, passphrase: string | undefined, opts: { useRemembered?: boolean } = {}): Promise<'passphrase' | 'remembered' | null> {
    const dbPath = companyDbPath(slug)
    if (!isEncryptedFile(dbPath) || keyForPath(dbPath)) return null
    if (!passphrase && opts.useRemembered !== false) {
      const r = unlockWithRememberedKey(slug, dbPath, appSecretStore())
      if (r.key) {
        rememberFolderKey(companyDir(slug), r.key)
        return 'remembered'
      }
      if (r.dropped) {
        log('warn', 'remembered-key-dropped', { slug })
        throw new AppError('remembered_key_stale', 'The passphrase remembered on this computer no longer opens these books, so Total forgot it — type the passphrase', { field: 'passphrase' })
      }
    }
    const key = await unlockCompanyKey({
      slug, dbPath, companyDir: companyDir(slug), passphrase, store: appSecretStore(),
      onWrong: (fails) => log('warn', 'passphrase-wrong', { slug, fails })
    })
    rememberFolderKey(companyDir(slug), key)
    return 'passphrase'
  }

  // "Remember on this computer" from the company picker: which businesses have a remembered key
  // (presence only — never the key), and Forget. Forgetting only takes a convenience away (the
  // passphrase still opens the books), so the picker may do it before anyone signs in; it is
  // audited inside the books when the remembered key still opens them.
  handle('company:remembered', () => readRegistry().companies.map((c) => c.slug).filter((slug) => hasRememberedKey(slug, appSecretStore())))
  handle('company:forgetRemembered', (payload) => {
    const { slug } = z.object({ slug: z.string().min(1) }).strict().parse(payload)
    if (current?.slug === slug) {
      // The open business: Settings → Security's Forget (owner) is the way.
      if (current.usersExist && sessionUser?.role !== 'owner') throw new AppError('not_permitted', 'You do not have permission to do that')
      forgetRememberedOf(current, sessionUser?.name ?? null)
      return null
    }
    const key = readRememberedKeyOf(slug)
    if (!key) return null
    let db: DB | null = null
    try {
      db = openDb(companyDbPath(slug), { key, fileMustExist: true })
      writeAudit(db, 'security', 0, 'update', { rememberedOnThisComputer: true }, { rememberedOnThisComputer: false, from: 'picker' })
    } catch (err) {
      log('warn', 'forget-remembered-audit-failed', { slug, error: err instanceof Error ? err.message : String(err) })
    } finally {
      db?.close()
    }
    dropRememberedKey(slug, appSecretStore())
    return null
  })
  const readRememberedKeyOf = (slug: string): Buffer | null => (hasRememberedKey(slug, appSecretStore()) ? unlockWithRememberedKey(slug, companyDbPath(slug), appSecretStore()).key : null)
  /** Forget the open company's remembered key, audited when there was one. */
  function forgetRememberedOf(c: OpenCompany, user: string | null): void {
    pendingRemember = null
    if (dropRememberedKey(c.slug, appSecretStore())) {
      writeAudit(c.db, 'security', 0, 'update', { rememberedOnThisComputer: true }, { rememberedOnThisComputer: false }, user ? { user } : {})
    }
  }

  /** Open `slug` as the current company (the key, if any, already remembered) and run the
   *  on-open housekeeping — company:open, and the passphrase on / off flows that reopen the file. */
  /** What the last open's file-conversion resume did (convertOpenCompany reports it). */
  let lastFileResume: { converted: number; failed: string[] } | null = null
  async function openCompanyNow(slug: string, opts: { keepKey?: boolean } = {}): Promise<{ slug: string; info: CompanyInfo; integrity: ReturnType<typeof checkIntegrity>; locked: boolean; ui: ReturnType<typeof configSvc.getUi>; encrypted: boolean }> {
    closeCurrentCompany({ keepKey: opts.keepKey ?? true })
    // WP 7.2 review: what an interrupted lock change / restore / export left beside the books
    // (a plaintext copy, when the lock was being taken off) goes before the books open.
    try {
      removeLeftoverCopies(companyDbPath(slug), companyBackupsDir(slug), companyExportsDir(slug))
    } catch (err) {
      log('warn', 'leftover-copies-not-removed', { slug, error: err instanceof Error ? err.message : String(err) })
    }
    const t0 = performance.now()
    const mark = (step: string): void => {
      if (TRACE_IPC) console.log(`[ipc] company:open/${step} ${(performance.now() - t0).toFixed(0)} ms`)
    }
    const db = openCompanyDb(slug)
    mark('db')
    const info = readCompanyInfo(db)
    current = { slug, db, info, usersExist: users.usersExist(db), encrypted: keyOfHandle(db) !== null }
    idleClock.setMinutes(getAutoLockMinutes(db))
    // A lock change interrupted while its files were being converted: finish it toward the books'
    // own form (the key is known now — the books just opened with it).
    lastFileResume = null
    try {
      const resumed = resumeFileConversion(companyDir(slug), keyOfHandle(db))
      lastFileResume = resumed
      if (resumed) log(resumed.failed.length ? 'warn' : 'info', 'security-files-resumed', { slug, converted: resumed.converted, failed: resumed.failed.length })
    } catch (err) {
      log('warn', 'security-files-resume-failed', { slug, error: err instanceof Error ? err.message : String(err) })
    }
    // Online backup needs an open handle, so this runs after open (not before, as it used to).
    // A backup failure here must never fail — or desync — the open itself.
    // WP 7.1: the backup and the integrity check run together — their whole-file quick_checks in
    // worker threads (db/checkHost.ts) — and both finish before the reply, as before.
    const backupDone = backupCompany(db, slug, 'open').then(
      (dest) => {
        mark('backup')
        // WP 7.2: the automatic restore check (at most daily), after this reply.
        scheduleBackupCheck(db, dest, 'open')
      },
      (err: unknown) => log('warn', 'backup-on-open-failed', { slug, error: err instanceof Error ? err.message : String(err) })
    )
    const integrityDone = checkIntegrityAsync(db, companyDbPath(slug)).finally(() => mark('integrity'))
    await backupDone
    const integrity = await integrityDone
    if (!integrity.ok) {
      log('warn', 'integrity', { slug, quickCheck: integrity.quickCheck, unbalanced: integrity.unbalancedVoucherIds })
    } else if (integrity.quickCheck === QUICK_CHECK_TIMED_OUT) {
      // The open went on without the quick_check (OPEN_QUICK_CHECK_TIMEOUT_MS); the weekly
      // integrity_check below still covers the file.
      log('warn', 'integrity-quick-check-timeout', { slug })
    }
    // [lane-Q] scheduled weekly FULL integrity check (task Q3 #99) — the check above is the cheap
    // quick_check; this one is `PRAGMA integrity_check`, throttled to once per 7 days via meta.
    // WP 7.1: it only ever logs, so it runs in a worker thread and the open does not wait for it.
    void runWeeklyIntegrityCheckAsync(db, companyDbPath(slug)).then((weekly) => {
      if (weekly?.ran && !weekly.ok) log('warn', 'integrity-weekly-failed', { slug, detail: weekly.detail })
    })
    // Housekeeping below runs as 'system' in the audit trail — nobody asked for it.
    try {
      const purged = runAsAuditUser(SYSTEM_AUDIT_USER, () => vouchers.purgeOldDeleted(db, 30))
      if (purged > 0) log('info', 'bin-purge', { purged })
    } catch (err) {
      // e.g. an over-age binned voucher still referenced by payroll_runs — housekeeping must
      // never block opening the company.
      log('warn', 'bin-purge-failed', { slug, error: err instanceof Error ? err.message : String(err) })
    }
    mark('purge')
    // WP 6.4: attachments of purged records (and stored files nothing references) go too.
    try {
      const swept = runAsAuditUser(SYSTEM_AUDIT_USER, () => attachments.sweepAttachments(db, companyAttachmentsDir(slug)))
      if (swept.rowsRemoved || swept.filesRemoved) log('info', 'attachments-sweep', { ...swept })
    } catch (err) {
      log('warn', 'attachments-sweep-failed', { slug, error: err instanceof Error ? err.message : String(err) })
    }
    mark('sweep')
    // Post-dated vouchers whose date has arrived flip into the books (audited per voucher).
    // PDCs dated inside a locked period are refused, not silently posted — they stay in the
    // PDC register until the lock is lifted (v0.3 review F3).
    const { matured, blockedByLock, blockedByHold } = runAsAuditUser(SYSTEM_AUDIT_USER, () => vouchers.maturePostDated(db, todayISO()))
    mark('mature')
    if (matured.length > 0) log('info', 'pdc-mature', { count: matured.length, ids: matured })
    if (blockedByLock.length > 0) {
      log('warn', 'pdc-mature-blocked-by-lock', { count: blockedByLock.length, ids: blockedByLock })
    }
    if (blockedByHold?.length) log('warn', 'pdc-mature-blocked-by-hold', { count: blockedByHold.length, ids: blockedByHold })
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
    mark('prune')
    touchLastOpened(slug)
    // Agent bridge (feature flag, default OFF): watch <company>/inbox/ for dropped files.
    if (configSvc.getAgentBridgeEnabled(db)) agentBridge.syncInboxWatcher({ slug, db })
    // WP 5.4: interrupted capture work back to the approved queue; the capture inbox watched.
    try {
      captureOnCompanyOpen({ slug, db, usersExist: current.usersExist })
    } catch (err) {
      log('warn', 'capture-open-failed', { slug, error: err instanceof Error ? err.message : String(err) })
    }
    // WP 6.2: scheduled report packs that came due while the app was closed run once, deferred
    // past this reply and only while the company is unlocked (a company with users waits for the
    // sign-in — auth:login starts the pass then).
    mark('capture')
    void runDuePacksInBackground({ slug, db, info }, { allowed: packsAllowed, current: getUnlockedCompany, canSeeProfit: canSeeProfitNow })
    return { slug, info, integrity, locked: current.usersExist, ui: configSvc.getUi(db), encrypted: current.encrypted }
  }

  handle('company:close', () => {
    closeCurrentCompany()
    return null
  })

  handle('company:current', () =>
    current
      ? {
          slug: current.slug,
          info: current.info,
          locked: (current.usersExist && !sessionUser) || (!current.usersExist && !!privacyLock),
          lockKind: lockKindOf(current),
          ui: configSvc.getUi(current.db),
          encrypted: current.encrypted
        }
      : null
  )

  // ---------- company mode (WP 8.1): meta `ui` — simple / accountant, setup answers, language ----------
  // Read with the open payload too; `ui:get` refreshes it. `ui:mode:set` (plan §6) is owner-only to
  // change (everyone in a company without users), audited as a company update.
  handle('ui:get', () => configSvc.getUi(requireCompany().db), 'viewer')
  handle('ui:mode:set', (payload) => configSvc.setUi(requireCompany().db, uiPatchSchema.parse(payload)), 'owner')

  handle('company:updateInfo', (payload) => {
    const c = requireCompany()
    const before = c.info
    const input = companyCreateSchema.parse(payload)
    // WP 8.0: a changed registration takes effect from the given date (default today) and keeps
    // the type it replaces, so vouchers and returns of the earlier months keep their GST.
    const { gstRegistrationSince, gstPreviousRegistrationType: _prev, ...rest } = input
    const info: CompanyInfo = {
      ...rest,
      ...nextRegistrationFacts(before, input.gstRegistrationType, gstRegistrationSince, todayISO()),
      // WP 8.3: set by setup, not edited here.
      ...(before.booksBeginDate ? { booksBeginDate: before.booksBeginDate } : {})
    }
    writeCompanyInfo(c.db, info)
    c.info = info
    upsertCompany({ slug: c.slug, name: info.name, stateCode: info.stateCode, gstin: info.gstin, lastOpenedAt: new Date().toISOString() })
    writeAudit(c.db, 'company', 0, 'update', before, info)
    return info
  }, 'owner')

  const runManualBackup = async (): Promise<{ path: string; check: BackupCheck | null }> => {
    const c = requireCompany()
    const path = await backupCompany(c.db, c.slug, 'manual', sessionUser?.name ?? osAuditUser())
    // WP 7.2: a backup the user asked for is restore-checked at once (the answer comes back with it).
    let check: BackupCheck | null = null
    try {
      check = await checkBackupIfDue(c.db, path, 'manual', todayISO())
    } catch (err) {
      log('warn', 'backup-check-error', { error: err instanceof Error ? err.message : String(err) })
    }
    return { path, check }
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
  // Guided re-close (0.4.0 closes): compare every live closing journal with today's rule (read
  // only); the owner's repair re-closes the differing years oldest first in one transaction.
  handle('yearEnd:repairPreview', (p) => {
    z.object({}).strict().parse(p ?? {})
    // The repair compares against this preview with the company's booksFrom — the same here.
    const c = requireCompany()
    return yearEndRepair.repairPreview(c.db, c.info.booksFrom)
  }, 'accountant')
  handle('yearEnd:repair', (p) => {
    const input = z
      .object({ fingerprint: z.string().regex(/^[0-9a-f]{64}$/), fyStartYears: z.array(z.number().int().min(1990).max(2100)).min(1).max(100).optional() })
      .strict()
      .parse(p)
    const c = requireCompany()
    return yearEndRepair.repairCloses(c.db, c.info, input)
  }, 'owner')

  // ---------- backups: list/run/restore + encrypted export/import ----------
  handle('backup:list', (): BackupInfo[] => {
    const c = requireCompany()
    return listBackupsIn(companyBackupsDir(c.slug))
  }, 'viewer')

  handle('backup:run', runManualBackup)

  // Gate polish: "Show in Finder" for the simple Backups screen — a backup file of THIS company
  // (by name, the restore's own file schema, so nothing outside its backups folder) or the folder.
  handle('backup:reveal', (payload) => {
    const { file } = z.object({ file: backupFileSchema.optional() }).strict().parse(payload ?? {})
    const dir = companyBackupsDir(requireCompany().slug)
    const path = file ? join(dir, file) : dir
    if (file && existsSync(path)) shell.showItemInFolder(path)
    else void shell.openPath(dir)
    return null
  }, 'viewer')

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
    // WP 7.1 review: no background check may hold the live file open while it is swapped.
    await stopChecks(dbPath)
    // WP 7.2: a business locked with a passphrase keeps its lock — a plaintext backup (one made
    // before the lock, if converting it failed) is restored through an encrypted copy of itself.
    const liveKey = keyOfHandle(c.db)
    let source = backupPath
    let tempSource: string | null = null
    if (liveKey && !isEncryptedFile(backupPath)) {
      tempSource = `${backupPath}.restore-tmp`
      removeDbFiles(tempSource)
      copyFileSync(backupPath, tempSource)
      rekeyFile(tempSource, null, liveKey)
      source = tempSource
    }
    let preRestoreSnapshotPath: string
    try {
      preRestoreSnapshotPath = restoreCompanyDb(c.db, dbPath, source, companyBackupsDir(slug)).preRestoreSnapshotPath
    } finally {
      if (tempSource) removeDbFiles(tempSource)
    }
    // WP 6.4: the pre-restore snapshot's attachments are still in the live store — keep copies,
    // so restoring that snapshot later brings them back too.
    try {
      stashBackupAttachments(slug, preRestoreSnapshotPath)
    } catch (err) {
      log('warn', 'backup-restore-stash-failed', { slug, error: err instanceof Error ? err.message : String(err) })
    }

    closeCurrentCompany({ keepKey: true })
    const reopen = (): OpenCompany => {
      // Migrates if the backup predates the current schema — with no pre-upgrade copy: the file
      // came from a backup that is still in the backups folder (and a pre-restore snapshot was taken).
      const db = openCompanyDb(slug, { preUpgradeCopy: false })
      const info = readCompanyInfo(db)
      return { slug, db, info, usersExist: users.usersExist(db), encrypted: keyOfHandle(db) !== null }
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
    idleClock.setMinutes(getAutoLockMinutes(current.db))
    const integrity = checkIntegrity(current.db)
    if (!integrity.ok) {
      log('warn', 'integrity', { slug, quickCheck: integrity.quickCheck, unbalanced: integrity.unbalancedVoucherIds })
    }
    // WP 3.8: the restored file carries the backup's own audit trail and hash chain. Verify it,
    // then record the restore itself on top of it (the live trail up to the restore survives in
    // the pre-restore snapshot).
    const auditChain = verifyAudit(current.db)
    // WP 6.4: the restored books' attachments, back into the live store from the backups' copies.
    let attachmentFiles: RestoreFilesResult = { restored: 0, present: 0, missing: [], refused: [] }
    try {
      attachmentFiles = restoreAttachmentFiles(current.db, companyAttachmentsDir(slug), companyBackupAttachmentsDir(slug))
    } catch (err) {
      log('warn', 'backup-restore-attachments-failed', { slug, error: err instanceof Error ? err.message : String(err) })
    }
    writeAudit(current.db, 'backup', 0, 'restore', null, {
      file, preRestoreSnapshot: basename(preRestoreSnapshotPath), chainOk: auditChain.ok, chainRows: auditChain.rows,
      chainHeadId: auditChain.headId, chainFirstBreak: auditChain.firstBreak?.rowId ?? null,
      attachmentsRestored: attachmentFiles.restored, attachmentsMissing: attachmentFiles.missing.length, attachmentsRefused: attachmentFiles.refused.length
    }, { user: restoredBy })
    // closeCurrentCompany() above already cleared sessionUser, so this is realistically always
    // `current.usersExist` — spelled out in full to match the other two locked-flag call sites.
    return {
      info: current.info, integrity, locked: current.usersExist && !sessionUser, auditChain,
      attachments: { restored: attachmentFiles.restored, missing: attachmentFiles.missing.length, refused: attachmentFiles.refused.length }
    }
  }, 'owner')

  handle('backup:exportEncrypted', async (payload) => {
    const { passphrase } = z.object({ passphrase: passphraseSchema }).parse(payload)
    const c = requireCompany()
    const tempPath = join(companyExportsDir(c.slug), `.export-tmp-${backupStamp()}.db`)
    // WP 7.2: the snapshot inside is plaintext (a locked business's file is decrypted into it) —
    // the .totalbak is protected by ITS passphrase, and imports anywhere without the company key.
    plainCopy(c.db, tempPath)
    // WP 6.4: the encrypted file carries the attachments (a blob table inside the snapshot).
    let embedded: StashResult
    try {
      embedded = embedAttachments(tempPath, companyAttachmentsDir(c.slug))
    } catch (err) {
      unlinkSync(tempPath)
      throw err
    }
    const destPath = join(companyExportsDir(c.slug), `total-${c.slug}-${backupStamp()}.totalbak`)
    try {
      await encryptFile(tempPath, destPath, passphrase)
    } finally {
      unlinkSync(tempPath)
    }
    auditExport(c.db, 'encrypted_backup', { path: destPath, attachments: embedded.copied, attachmentsMissing: embedded.missing.length })
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
      const check = openDb(tempDbPath, { readonly: true, key: null })
      try {
        const result = check.pragma('quick_check') as Array<{ quick_check: string }>
        if (result[0]?.quick_check !== 'ok') throw new Error('bad')
        info = readCompanyInfo(check)
        // Upgrade guard: a backup from a NEWER Total is refused before it becomes a company.
        assertNotNewer(check)
      } finally {
        check.close()
      }
    } catch (err) {
      if (err instanceof AppError && err.code === 'db_newer_version') throw err
      throw new Error("This file doesn't look like a Total company backup")
    }

    let slug = slugify(info.name)
    let n = 2
    while (existsSync(companyDbPath(slug))) slug = `${slugify(info.name)}-${n++}`
    ensureCompanyTree(slug)
    // WP 6.4: the embedded attachments (hash-checked) into the new company's store.
    let importedFiles: RestoreFilesResult = { restored: 0, present: 0, missing: [], refused: [] }
    try {
      importedFiles = restoreAttachmentFilesAt(tempDbPath, companyAttachmentsDir(slug), null)
    } catch (err) {
      log('warn', 'import-encrypted-attachments-failed', { slug, error: err instanceof Error ? err.message : String(err) })
    }

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
          file: basename(picked.filePaths[0]), encrypted: true, chainOk: chain.ok, chainRows: chain.rows, chainFirstBreak: chain.firstBreak?.rowId ?? null,
          attachmentsRestored: importedFiles.restored, attachmentsMissing: importedFiles.missing.length, attachmentsRefused: importedFiles.refused.length
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
  // WP 2.5b lists: the challan / GRN list screens (documents + live links at query time).
  handle('trade:noteList', (p) => tradeLists.listStockNotes(requireCompany().db, tradeNoteListSchema.parse(p)), 'viewer')
  // ---------- quotations / sales orders / purchase orders (WP 2.5c) ----------
  handle('tradeDocs:list', (p) => tradeDocs.listTradeDocs(requireCompany().db, tradeDocListSchema.parse(p)), 'viewer')
  handle('tradeDocs:get', (p) => tradeDocs.getTradeDoc(requireCompany().db, idSchema.parse(p).id), 'viewer')
  handle('tradeDocs:save', (p) => {
    const { data, id, aiDraftId } = tradeDocSaveSchema.extend({ aiDraftId: z.number().int().positive().optional() }).parse(p)
    const db = requireCompany().db
    // WP 5.3: a document reviewed from an AI draft saves through the normal path; the draft is
    // settled in the same transaction.
    if (!aiDraftId || id) return tradeDocs.saveTradeDoc(db, data, id)
    return db.transaction(() => {
      const saved = tradeDocs.saveTradeDoc(db, data)
      settleDraftOnSave(db, aiDraftId, { tradeDocId: saved.doc.id }, 'tradeDoc')
      return saved
    })()
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
  // WP 8.4: the plain "New product" dialog — item + its selling price on the default level, one transaction.
  handle('master:stockItems:quickCreate', (p) => quickCreateItem(requireCompany().db, quickItemSchema.parse(p)))
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
    const target = await pickExportPath(c.slug, { defaultName: `barcode-labels-${q.date}.pdf`, title: 'Save barcode labels', filters: [{ name: 'PDF', extensions: ['pdf'] }] })
    if (!target) return { path: '', cancelled: true }
    const path = await writePdfFile(target, html, { pageSize: 'A4', margins: 'none' })
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
    const { data, id, aiDraftId } = manufactureSaveSchema.extend({ aiDraftId: z.number().int().positive().optional() }).parse(p)
    const c = requireCompany()
    // WP 5.3: a manufacture reviewed from an AI draft — the draft is settled in the same transaction.
    const saved =
      aiDraftId && !id
        ? c.db.transaction(() => {
            const v = manufacture.saveManufacture(c.db, data)
            settleDraftOnSave(c.db, aiDraftId, v.id, 'manufacture')
            return v
          })()
        : manufacture.saveManufacture(c.db, data, id)
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
    const { id, creditHoldOverride } = idSchema.extend({ creditHoldOverride: creditOverrideSchema.strict().optional() }).strict().parse(p)
    const c = requireCompany()
    // WP 4.2: a post-dated sales invoice maturing to a held party creates credit — owner override only.
    if (creditHoldOverride && c.usersExist && sessionUser?.role !== 'owner') throw new Error('Only an owner can override a credit hold')
    vouchers.maturePdcNow(c.db, id, creditHoldOverride ? { creditHoldOverride } : {})
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
    let saved: ReturnType<typeof vouchers.saveVoucher>
    if (aiDraftId) {
      try {
        saved = c.db.transaction(() => {
          const v = vouchers.saveVoucher(c.db, data, id, saveOpts)
          settleDraftOnSave(c.db, aiDraftId, v.id, 'voucher', { companyDir: companyDir(c.slug) })
          return v
        })()
      } catch (err) {
        dropPendingAttachments()
        throw err
      }
      // WP 5.4: a captured bill's file is attached only once the save has committed.
      flushCaptureAttachments()
    } else saved = vouchers.saveVoucher(c.db, data, id, saveOpts)
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
  // WP 8.5: a voucher undone with others comes back with its whole undo group.
  handle('voucher:restore', (p) => {
    const { id, creditHoldOverride } = idSchema.extend({ creditHoldOverride: creditOverrideSchema.strict().optional() }).strict().parse(p)
    const c = requireCompany()
    // WP 4.2: restoring a sales invoice / challan to a held party creates credit — owner override only.
    if (creditHoldOverride && c.usersExist && sessionUser?.role !== 'owner') throw new Error('Only an owner can override a credit hold')
    return undo.restoreFromBin(c.db, id, creditHoldOverride ? { creditHoldOverride } : {})
  })
  const undoIdsSchema = z.object({ voucherIds: z.array(z.number().int().positive()).min(1).max(undo.UNDO_MAX) })
  handle('voucher:undoSave', (p) => undo.undoSave(requireCompany().db, undoIdsSchema.parse(p).voucherIds))
  handle('voucher:saveSummary', (p) => undo.saveSummary(requireCompany().db, undoIdsSchema.parse(p).voucherIds), 'viewer')
  handle('voucher:purge', (p) => {
    const c = requireCompany()
    vouchers.purgeVoucher(c.db, idSchema.parse(p).id)
    // WP 6.4: the purged voucher's attachments (orphan sweep) — never fails the purge itself.
    try {
      attachments.sweepAttachments(c.db, companyAttachmentsDir(c.slug))
    } catch (err) {
      log('warn', 'attachments-sweep-failed', { slug: c.slug, error: err instanceof Error ? err.message : String(err) })
    }
    return null
  }, 'owner')
  handle('voucher:nextNumber', (p) => {
    const { voucherTypeId, date, excludeId } = z
      .object({ voucherTypeId: z.number().int().positive(), date: z.string(), excludeId: z.number().int().positive().optional() })
      .parse(p)
    return { number: vouchers.nextVoucherNumber(requireCompany().db, voucherTypeId, date, excludeId) }
  })
  handle('voucher:numberExists', (p) => {
    const { voucherTypeId, number, excludeId, date } = z
      .object({
        voucherTypeId: z.number().int().positive(),
        number: z.string().trim().min(1).max(40),
        excludeId: z.number().int().positive().optional(),
        // The voucher's date: a series that restarts each FY only clashes within that FY.
        date: isoDate.optional()
      })
      .parse(p)
    return vouchers.voucherNumberExists(requireCompany().db, voucherTypeId, number, excludeId, date)
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
    // WP 7.2: without canSeeProfit the P&L ledgers, the computed P&L row and the totals go.
    return reports.trialBalanceFor(requireCompany().db, asOn, canSeeProfitNow())
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
    const d = reports.dashboard(requireCompany().db, today, fyFrom)
    return canSeeProfitNow() ? d : redactDashboard(d)
  }, 'viewer')
  handle('report:dashboardSeries', (p) => {
    const { today, from, to } = periodSchema.extend({ today: isoDate }).refine((v) => v.from <= v.to, 'from must be on or before to').parse(p)
    const c = requireCompany()
    // Backup status comes from the backups folder (the service itself never touches files).
    const backups = listBackupsIn(companyBackupsDir(c.slug))
    const d = dashboard.dashboardSeries(c.db, c.info, { today, from, to, backups })
    return canSeeProfitNow() ? d : redactDashboardSeries(d)
  }, 'viewer')
  // Launch to Home: the accountant Gateway's four reads (report:dashboardSeries, report:dashboard,
  // payables:msmeDue, report:dashboardPromised) in ONE round trip and one read transaction — each
  // part exactly its channel's output (same redaction), a failing part fails only its card. The
  // four channels stay for their other callers.
  handle('dashboard:all', (p) => {
    const { today, from, to, parties } = z
      .object({ today: isoDate, from: isoDate, to: isoDate, parties: z.boolean().optional() })
      .strict()
      .refine((v) => v.from <= v.to, 'from must be on or before to')
      .parse(p)
    const c = requireCompany()
    const all = dashboard.dashboardAll(c.db, c.info, { today, from, to, parties, backups: listBackupsIn(companyBackupsDir(c.slug)) })
    if (canSeeProfitNow()) return all
    return {
      ...all,
      series: all.series.ok ? { ok: true as const, data: redactDashboardSeries(all.series.data) } : all.series,
      dashboard: all.dashboard.ok ? { ok: true as const, data: redactDashboard(all.dashboard.data) } : all.dashboard
    }
  }, 'viewer')
  // WP 8.6: the simple Home in one round trip — every figure as on today, from the services the
  // accountant screens use (services/simpleHome.ts). Read-only, any role. The as-on date is
  // clamped to today; the close checklist + anomalies come separately (simple:homeAttention).
  handle('simple:home', (p) => {
    const { today } = z.object({ today: isoDate.optional() }).strict().parse(p ?? {})
    const c = requireCompany()
    const home = { ...simpleHome(c.db, c.info, { today: homeAsOn(today, todayISO()), backups: listBackupsIn(companyBackupsDir(c.slug)) }), backupCheck: latestBackupCheck(c.db) }
    return canSeeProfitNow() ? home : redactHome(home)
  }, 'viewer')
  handle('simple:homeAttention', (p) => {
    const { today } = z.object({ today: isoDate.optional() }).strict().parse(p ?? {})
    const c = requireCompany()
    return simpleHomeAttention(c.db, c.info, homeAsOn(today, todayISO()))
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
  // One month's GSTR-1 export (the full app's month-by-month export, unchanged): the JSON, the
  // summary CSV, the GSTR-9 "as filed" snapshot and one export audit row.
  const exportGstr1Month = (c: OpenCompany, from: string, to: string, period: string): { jsonPath: string; csvPath: string } => {
    const result = gst.gstr1(c.db, c.info, from, to, period)
    const jsonPath = gst.exportReturnJson(c.slug, 'gstr1', period, result.json)
    const csvPath = gst.exportGstr1Csv(c.slug, result)
    // WP 3.4: what was exported is the "as filed" side of the GSTR-9 comparison.
    gstAnnual.recordGstr1Export(c.db, period, result.json)
    auditExport(c.db, 'gstr1', { period, path: jsonPath })
    return { jsonPath, csvPath }
  }
  const exportGstr3bMonth = (c: OpenCompany, from: string, to: string, period: string): { jsonPath: string } => {
    const result = gst.gstr3b(c.db, c.info, from, to, period)
    const jsonPath = gst.exportReturnJson(c.slug, 'gstr3b', period, result.json)
    gstAnnual.recordGstr3bExport(c.db, period, result)
    auditExport(c.db, 'gstr3b', { period, path: jsonPath })
    return { jsonPath }
  }
  // A quarterly filer's export (`quarter: true`, from / to = the whole quarter, period = its last
  // month): the three monthly exports above, exactly as the full app writes them (every month's
  // gate checked before anything is written), then copied into one folder.
  const exportGstQuarter = (c: OpenCompany, form: 'gstr1' | 'gstr3b', from: string, to: string, period: string): { folder: string; files: string[] } => {
    const months = quarterExportMonths(from, to, period)
    if (!months) throw new AppError('invalid_input', 'A quarterly export covers a whole quarter, named by its last month.', { field: 'period' })
    for (const m of months) gst.assertExportable(c.db, c.info, m.from, m.to)
    // One transaction: a failure on a later month (or while copying) leaves no month's GSTR-9
    // snapshot or audit row behind, so the quarter is never half "prepared". Files already written
    // are the monthly exports' own (a re-export rewrites them).
    const bundle = c.db.transaction(() => {
      const files = months.flatMap((m) => {
        if (form === 'gstr3b') return [exportGstr3bMonth(c, m.from, m.to, m.period).jsonPath]
        const r = exportGstr1Month(c, m.from, m.to, m.period)
        return [r.jsonPath, r.csvPath]
      })
      return simpleTaxes.bundleQuarterFiles(c.slug, form, period, files)
    })()
    shell.showItemInFolder(bundle.files[0] ?? bundle.folder)
    return bundle
  }
  const gstExportInput = gstPeriodInput.extend({ quarter: z.literal(true).optional() })
  handle('gst:exportGstr1', (p) => {
    const { from, to, period, quarter } = gstExportInput.parse(p)
    const c = requireCompany()
    if (quarter) return exportGstQuarter(c, 'gstr1', from, to, period)
    // Server-side export gate (G7): blocking validation issues refuse the export outright —
    // the renderer disables the button too, but the gate must hold for any caller.
    gst.assertExportable(c.db, c.info, from, to)
    const { jsonPath, csvPath } = exportGstr1Month(c, from, to, period)
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
  // Trade cycle (WP 2.5b): the invoice editor warns about a sales number the IRP would refuse
  // (NIC DocDtls.No) only while the company e-invoices.
  handle('gst:einvoicing', () => {
    const c = requireCompany()
    return gst.getEinvoicing(c.db, c.info)
  }, 'viewer')
  // To-do §4: what the business profile (gstProfile turnover / exemption) says about e-invoicing
  // today, the switch, the "turn it on" notice and the IRP 30-day window. Read-only.
  handle('gst:einvoiceStatus', () => {
    const c = requireCompany()
    return gst.einvoiceStatus(c.db, c.info, todayISO())
  }, 'viewer')
  // Review follow-up: the explicit e-invoicing switch (meta `einvoicing`), owner-only, audited.
  handle('einvoicing:set', (p) => {
    const input = z.object({ enabled: z.boolean() }).strict().parse(p)
    const c = requireCompany()
    return gst.setEinvoicing(c.db, c.info, input)
  }, 'owner')
  handle('gst:3bManualGet', (p) => {
    const { period } = z.object({ period: z.string().regex(/^\d{6}$/) }).parse(p)
    return configSvc.getGst3bManual(requireCompany().db, period)
  }, 'viewer')
  handle('gst:3bManualSet', (p) => {
    const { period, data } = z.object({ period: z.string().regex(/^\d{6}$/), data: gst3bManualSchema }).parse(p)
    return configSvc.setGst3bManual(requireCompany().db, period, data)
  })
  handle('gst:exportGstr3b', (p) => {
    const { from, to, period, quarter } = gstExportInput.parse(p)
    const c = requireCompany()
    if (quarter) return exportGstQuarter(c, 'gstr3b', from, to, period)
    // Same server-side gate as gst:exportGstr1 — 3B is computed from the same extracted
    // documents, so a period with blocking validation issues must not export either return.
    gst.assertExportable(c.db, c.info, from, to)
    const { jsonPath } = exportGstr3bMonth(c, from, to, period)
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
    const jsonText = decodeTextFile(readFileSync(picked.filePaths[0]))
    return { jsonText, fileName: basename(picked.filePaths[0]) || 'gstr2b.json' }
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
  // Statutory sections a company may lack (s.206C(1C)) and the owner's "add them" (no migration;
  // cited rows in src/shared/tcsSources.ts, audited tdsSection / tdsRate creates).
  handle('tcs:statutory', () => tcsSvc.statutoryTcsSections(requireCompany().db), 'viewer')
  handle('tcs:statutoryAdd', (p) => tcsSvc.addStatutoryTcsSections(requireCompany().db, tcsStatutoryAddSchema.parse(p ?? {}).codes), 'owner')
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
      csv = decodeTextFile(readFileSync(picked.filePaths[0]))
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
    auditExport(c.db, 'brs_pdf', { ledgerId, asOn, path })
    return { path }
  }, 'viewer')

  // ---------- e-documents + invoice printing ----------
  handle('edoc:list', (p) => {
    const { from, to } = periodSchema.parse(p)
    const c = requireCompany()
    return edocs.listSalesInvoices(c.db, from, to, c.info)
  }, 'viewer')
  handle('edoc:exportEInvoice', async (p) => {
    // to-do §4: an optional range inside the period (absent = the whole period, as before).
    const { from, to, period, range } = gstPeriodInput
      .extend({ range: z.object({ from: isoDate, to: isoDate }).optional() })
      .refine((q) => !q.range || (q.range.from <= q.range.to && q.range.from >= q.from && q.range.to <= q.to), {
        message: 'The dates must lie within the period, the first on or before the last',
        path: ['range']
      })
      .parse(p)
    const c = requireCompany()
    const target = await pickExportPath(c.slug, { defaultName: edocs.eInvoiceFileName(period, range), title: 'Save e-invoice JSON', filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (!target) return { path: '', count: 0, cancelled: true }
    const r = edocs.exportEInvoices(c.db, c.info, c.slug, from, to, period, { path: target, range })
    auditExport(c.db, 'einvoice', { period, ...(range ? { range } : {}), path: r.path, count: r.count })
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
      text = decodeTextFile(readFileSync(picked.filePaths[0]))
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
  // WP 8.3: GSTR-1 filing frequency (monthly / quarterly QRMP), meta `gstProfile`.
  handle('gstProfile:get', () => configSvc.getGstProfile(requireCompany().db), 'viewer')
  handle('gstProfile:set', (p) => configSvc.setGstProfile(requireCompany().db, gstProfilePatchSchema.parse(p)), 'owner')
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
    return { csvText: decodeTextFile(readFileSync(picked.filePaths[0])), fileName: picked.filePaths[0].split(/[\\/]/).pop()! }
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
  // WP 7.3: user files are read through decodeTextFile — Windows tools write UTF-8 with a BOM and
  // UTF-16LE (Tally's "Unicode" XML export, Excel "Unicode Text"), which 'utf8' would garble.
  handle('tally:import', async (p) => {
    const { xmlText, filePath, dryRun } = tallyImportSchema.parse(p ?? {})
    const c = requireCompany()
    let xml = xmlText
    let resolvedPath = filePath
    if (xml === undefined && filePath !== undefined) {
      if (!dialogIssuedTallyPaths.has(filePath)) throw new Error('File path must come from the file picker')
      xml = decodeTextFile(readFileSync(filePath))
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
      xml = decodeTextFile(readFileSync(resolvedPath))
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
  handle('export:caPack', async (p) => {
    const { from, to } = periodSchema.parse(p)
    const c = requireCompany()
    // PR #127 review: the pack holds profit-and-loss.csv and balance-sheet.csv — canExport alone
    // must not hand them to a sign-in that may not see profit.
    if (!canSeeProfitNow()) throw new AppError('not_permitted', 'The CA pack includes the profit and loss and the balance sheet, which are not shown to your account')
    const target = await pickExportPath(c.slug, { defaultName: caPack.caPackFolderName(from, to), title: 'Save the CA pack (a folder)', kind: 'folder' })
    if (!target) return { path: '', cancelled: true }
    const r = caPack.exportCaPack(c.db, c.info, c.slug, from, to, target)
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
  // Cancel IRN ([CNL] /eicore/v1.03/Invoice/Cancel): within 24 h of the ack, reasons 1–4, remark ≤ 100.
  handle('nic:cancelIrn', async (p) => {
    const { voucherId, reason, remark } = z.object({
      voucherId: z.number().int().positive(),
      reason: z.enum(NIC_CANCEL_REASONS),
      remark: z.string().trim().min(1).max(IRN_CANCEL_REMARK_MAX)
    }).strict().parse(p)
    const c = requireCompany()
    return nic.cancelIrn(c.db, c.slug, c.info, voucherId, reason, remark)
  }, 'owner')
  // Cancel e-way bill ([CEWB] ewayapi action CANEWB): within 24 h, reasons per [MASTER], remark ≤ 50.
  handle('nic:cancelEwb', async (p) => {
    const { voucherId, reason, remark } = z.object({
      voucherId: z.number().int().positive(),
      reason: z.enum(NIC_CANCEL_REASONS),
      remark: z.string().trim().min(1).max(EWB_CANCEL_REMARK_MAX)
    }).strict().parse(p)
    const c = requireCompany()
    return nic.cancelEwb(c.db, c.slug, c.info, voucherId, reason, remark)
  }, 'owner')
  // Extend e-way bill validity ([EXT] ewayapi action EXTENDVALIDITY): 8 h before / after expiry.
  handle('nic:extendEwb', async (p) => {
    const { voucherId, ...input } = z.object({
      voucherId: z.number().int().positive(),
      // [MASTER] "Reasons for extension of validity" (= EWB_EXTEND_REASONS).
      reasonCode: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(5), z.literal(99)]),
      remarks: z.string().trim().min(1).max(50),
      fromPlace: z.string().trim().min(1).max(50),
      fromStateCode: z.number().int().min(1).max(99),
      fromPincode: z.number().int().min(100000).max(999999),
      remainingDistanceKm: z.number().int().min(1).max(4000),
      transMode: z.enum(['1', '2', '3', '4', '5']), // [MASTER] modes; 5 = in transit (= EWB_EXTEND_MODES)
      vehicleNo: z.string().trim().max(20).optional(),
      transDocNo: z.string().trim().max(15).optional(),
      transDocDate: isoDate.optional(),
      transitType: z.enum(['R', 'W', 'O']).optional(),
      addressLine1: z.string().trim().max(120).optional()
    }).strict().parse(p)
    const c = requireCompany()
    return nic.extendEwb(c.db, c.slug, c.info, voucherId, input)
  }, 'owner')
  // The stored IRP / EWB answers for one voucher (signed invoice + QR, ack, cancel state, e-way
  // history) — read-only, no network.
  handle('nic:record', (p) => {
    const { voucherId } = z.object({ voucherId: z.number().int().positive() }).parse(p)
    return nic.nicRecord(requireCompany().db, voucherId)
  }, 'viewer')
  // "Save JSON": the signed invoice + signed QR as the IRP returned them, to the exports folder.
  handle('nic:signedCopyExport', (p) => {
    const { voucherId } = z.object({ voucherId: z.number().int().positive() }).parse(p)
    const c = requireCompany()
    const rec = nic.nicRecord(c.db, voucherId)
    const json = nic.signedCopyJson(rec)
    const dir = join(companyExportsDir(c.slug), 'einvoice-signed')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, fitFileName(dir, `${portableFileName(rec.number.replace(/[\\/]/g, '-'), { fallback: `voucher-${voucherId}` })}-signed-einvoice.json`))
    writeFileSync(path, JSON.stringify(json, null, 2), 'utf8')
    auditExport(c.db, 'einvoice_signed', { voucherId, path })
    shell.showItemInFolder(path)
    return { path }
  })

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
    idleClock.touch()
    // "Remember on this computer" ticked at this open's passphrase prompt: only an owner keeps it.
    if (pendingRemember === c.slug) {
      pendingRemember = null
      if (result.role === 'owner' && c.encrypted) rememberOpenKey(c, result.name)
    }
    // WP 6.2: due report packs wait for the first sign-in of a locked company.
    void runDuePacksInBackground(c, { allowed: packsAllowed, current: getUnlockedCompany, canSeeProfit: canSeeProfitNow })
    resumeCapture()
    return sessionView(result)
  })
  handle('auth:logout', () => {
    // [lane-Q audit] logout audit row (task Q1 #90) — only meaningful with a live session.
    if (current && sessionUser) writeAudit(current.db, 'user', sessionUser.id, 'logout', null, null)
    sessionUser = null
    return null
  })
  handle('auth:current', () => (sessionUser ? sessionView(sessionUser) : null))

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
    if (bootstrap) {
      sessionUser = { id: saved.id, name: saved.name, role: saved.role, capabilities: saved.capabilities }
      idleClock.touch()
    }
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

  // ---------- WP 7.2 security: screen lock, passphrase lock, backup checks ----------
  // The session lock: ⌘L (session:lock) and the idle auto-lock sign the user out — the PIN screen
  // (auth:login) is the only way back, and the gate above refuses everything else meanwhile.
  handle('session:activity', () => {
    idleClock.touch()
    return null
  }, 'viewer')
  handle('session:lock', () => {
    const c = requireCompany()
    // WP 7.2 follow-up: a business without users locks too — a privacy screen (its passphrase,
    // when the passphrase lock is on, or a plain Unlock) instead of the PIN screen.
    if (!c.usersExist) lockPrivacy('manual')
    else lockSession('manual')
    return { locked: true, kind: lockKindOf(c) }
  }, 'viewer')
  // The unlock of a business WITHOUT users (with users it is auth:login). Ungated; the passphrase
  // (when the business has the passphrase lock on) is throttled like opening; audited as a login.
  handle('session:unlock', async (p) => {
    const { passphrase } = z.object({ passphrase: z.string().max(1024).optional() }).strict().parse(p ?? {})
    const c = requireCompany()
    if (c.usersExist) throw new AppError('unlock_needs_pin', 'This business has people with PINs — sign in with yours', { field: 'pin' })
    if (!privacyLock) return { locked: false }
    if (c.encrypted) {
      if (!passphrase) throw new AppError('passphrase_required', 'Type the passphrase of this business to unlock', { field: 'passphrase' })
      const now = Date.now()
      assertNotThrottled(c.slug, now)
      try {
        await assertPassphrase(c, passphrase, 'passphrase')
      } catch (err) {
        if (!(err instanceof AppError) || err.code !== 'wrong_passphrase') throw err
        log('warn', 'passphrase-wrong', { slug: c.slug, fails: noteWrongPassphrase(c.slug, now) })
        throw err
      }
      noteRightPassphrase(c.slug)
    }
    const reason = privacyLock
    privacyLock = null
    idleClock.touch()
    writeAudit(c.db, 'user', 0, 'login', null, { lock: reason, noUsers: true, passphrase: c.encrypted })
    return { locked: false }
  })

  const securityView = (): SecurityView => {
    const c = requireCompany()
    return {
      encrypted: c.encrypted,
      keyFile: c.encrypted && !!readEnvelope(companyDir(c.slug), c.slug, appSecretStore()),
      usersExist: c.usersExist,
      autoLockMinutes: getAutoLockMinutes(c.db),
      autoLockChoices: [...AUTO_LOCK_CHOICES],
      lastCheck: latestBackupCheck(c.db),
      remembered: c.encrypted && hasRememberedKey(c.slug, appSecretStore()),
      rememberPending: pendingRemember === c.slug
    }
  }
  handle('security:get', () => securityView(), 'viewer')
  // Settings → Security: forget the key remembered on this computer (owner; audited).
  handle('security:remember:forget', () => {
    const c = requireCompany()
    forgetRememberedOf(c, sessionUser?.name ?? null)
    return securityView()
  }, 'owner')
  handle('security:autoLock:set', (p) => {
    const { minutes } = z
      .object({ minutes: z.number().int().refine((m) => (AUTO_LOCK_CHOICES as readonly number[]).includes(m), 'Pick one of the offered minutes').nullable() })
      .strict()
      .parse(p)
    const c = requireCompany()
    setAutoLockMinutes(c.db, minutes)
    idleClock.setMinutes(minutes)
    return securityView()
  }, 'owner')

  const passphrasePair = z.object({ passphrase: passphraseSchema, confirm: z.string().max(1024) }).strict()
  /** Turn the passphrase lock on (`to` = a new key) or off (`to` = null) for the open company:
   *  a normal backup first, then the verified copy (services/dbEncryption.ts) swapped in and the
   *  company reopened, then every backup converted. The signed-in user stays signed in. */
  const convertOpenCompany = async (to: Buffer | null, auditAfter: Record<string, unknown>): Promise<{ backupsConverted: number; backupsFailed: string[]; filesConverted: number; filesFailed: string[] }> => {
    const c = requireCompany()
    const { slug } = c
    const by = sessionUser?.name ?? osAuditUser()
    const keepUser = sessionUser
    const from = keyOfHandle(c.db)
    await backupCompany(c.db, slug, to ? 'pre-encrypt' : 'pre-decrypt', by)
    // WP 7.2 review: no background check (the weekly integrity_check) may hold the live file open
    // while it is swapped — on Windows the rename fails, and its read snapshot keeps the WAL alive.
    await stopChecks(companyDbPath(slug))
    const tmp = prepareConvertedCopy({
      db: c.db,
      dbPath: companyDbPath(slug),
      to,
      asOn: todayISO(),
      audit: { before: { encrypted: !!from }, after: { encrypted: !!to, ...auditAfter }, user: by }
    })
    // The files (attachments, capture): taking the lock off decrypts them now, while the key is in
    // hand. Either way the conversion is marked before the swap, so the reopen (and, after a
    // crash, the next open) finishes it toward the books' form (dbEncryption.resumeFileConversion)
    // — putting the lock on encrypts them there, right after the swap.
    let files = { converted: 0, failed: [] as string[] }
    try {
      if (!to) files = convertCompanyFiles(companyDir(slug), from, null)
      markFileConversion(companyDir(slug), to ? 'encrypted' : 'plain')
    } catch (err) {
      removeDbFiles(tmp)
      throw err
    }
    closeCurrentCompany({ keepKey: true })
    try {
      commitConvertedCopy(tmp, companyDbPath(slug))
    } catch (err) {
      // The original is untouched (the rename is the commit): open it again as it was — the
      // reopen's resume puts the files back in the books' form.
      removeDbFiles(tmp)
      await openCompanyNow(slug, { keepKey: true })
      sessionUser = keepUser
      throw err
    }
    if (to) rememberFolderKey(companyDir(slug), to)
    else forgetFolderKey(companyDir(slug))
    await openCompanyNow(slug, { keepKey: true })
    sessionUser = keepUser
    idleClock.touch()
    if (to) files = lastFileResume ?? convertCompanyFiles(companyDir(slug), null, to)
    if (files.failed.length) log('warn', 'security-files-not-converted', { slug, failed: files.failed.length })
    // The older backups follow the books: none is left plaintext behind a locked business (or
    // encrypted behind an unlocked one, where no key would open it any more).
    // A backup's restore check still copying one of them would hold it open (Windows: the rename fails).
    await stopChecksUnder(companyBackupsDir(slug))
    const conv = convertBackups(companyBackupsDir(slug), from, to)
    if (conv.failed.length) log('warn', 'security-backups-not-converted', { slug, failed: conv.failed.length })
    return { backupsConverted: conv.converted, backupsFailed: conv.failed, filesConverted: files.converted, filesFailed: files.failed }
  }

  /** The passphrase opens the open company's key (passphrase off / change), else wrong_passphrase. */
  const assertPassphrase = async (c: OpenCompany, passphrase: string, field: string): Promise<Buffer> => {
    const envs = readEnvelopes(companyDir(c.slug), c.slug, appSecretStore())
    const key = keyOfHandle(c.db)
    let unwrapped: Buffer | null = null
    for (const env of envs) {
      try {
        unwrapped = await unwrapKeyAsync(env, passphrase)
      } catch {
        unwrapped = null
      }
      if (unwrapped && key && unwrapped.equals(key)) break
    }
    if (!unwrapped || !key || !unwrapped.equals(key)) throw new AppError('wrong_passphrase', 'That passphrase is not right', { field })
    return key
  }

  handle('security:passphrase:on', async (p) => {
    const { passphrase, confirm } = passphrasePair.parse(p)
    if (confirm !== passphrase) throw new AppError('passphrase_mismatch', 'The two passphrases are not the same', { field: 'confirm' })
    const c = requireCompany()
    if (c.encrypted) throw new AppError('security_already_locked', 'This business is already locked with a passphrase')
    // Files review: a key file an earlier lock-off left behind (some backup or file could not be
    // converted and is still encrypted under ITS key) is used again when this passphrase opens it
    // — those leftovers then open as before once the lock is on. While a FILE is still waiting on
    // that key (the `.files-converting` marker), a passphrase that does not open it is refused:
    // a new key would lose the file for good (the user's own attachment, not a backup).
    let key: Buffer | null = null
    const leftover = readEnvelopes(companyDir(c.slug), c.slug, appSecretStore())
    for (const env of leftover) {
      try {
        key = await unwrapKeyAsync(env, passphrase)
        break
      } catch (err) {
        if (!(err instanceof WrongPassphraseError)) throw err
      }
    }
    if (!key && leftover.length && fileConversionPending(companyDir(c.slug))) {
      throw new AppError('security_files_pending', 'Some files are still locked with the passphrase this business had before (taking the lock off could not convert them). Lock it with that passphrase, so they open again', { field: 'passphrase' })
    }
    key ??= newDataKey()
    // A key remembered for an earlier lock of this business can never open the new file.
    dropRememberedKey(c.slug, appSecretStore())
    const env = await wrapKeyAsync(key, passphrase, scryptParams())
    // The key file goes first: from the moment the file is encrypted it must be there.
    const { mirrored } = writeEnvelope(companyDir(c.slug), c.slug, env, appSecretStore())
    try {
      const out = await convertOpenCompany(key, { cipher: 'sqlcipher-4', kdf: `scrypt N=${env.N} r=${env.r} p=${env.p}`, keyCopyInSecureStorage: mirrored })
      return { ...securityView(), ...out, mirrored }
    } catch (err) {
      // Nothing was swapped in (the copy failed its check): the key file goes again.
      // Decided by the FILE, never by `current` (null when the reopen after the swap failed): an
      // encrypted file must never lose its key file.
      if (!isEncryptedFile(companyDbPath(c.slug))) removeEnvelope(companyDir(c.slug), c.slug, appSecretStore())
      throw err
    }
  }, 'owner')

  handle('security:passphrase:off', async (p) => {
    const { passphrase } = z.object({ passphrase: z.string().min(1).max(1024) }).strict().parse(p)
    const c = requireCompany()
    if (!c.encrypted) throw new AppError('security_not_locked', 'This business is not locked with a passphrase')
    await assertPassphrase(c, passphrase, 'passphrase')
    const hadRemembered = hasRememberedKey(c.slug, appSecretStore())
    const out = await convertOpenCompany(null, hadRemembered ? { rememberedOnThisComputer: false } : {})
    // Nothing to remember once the books are plaintext (recorded in the conversion's audit row).
    if (hadRemembered && !isEncryptedFile(companyDbPath(c.slug))) dropRememberedKey(c.slug, appSecretStore())
    // The key goes only once nothing needs it: the books are plaintext AND every backup was
    // converted — a backup left encrypted (it failed to convert) still opens with this passphrase.
    // Files that could not be decrypted keep it too.
    if (!isEncryptedFile(companyDbPath(c.slug)) && out.backupsFailed.length === 0 && out.filesFailed.length === 0) removeEnvelope(companyDir(c.slug), c.slug, appSecretStore())
    else log('warn', 'security-key-kept', { slug: c.slug, backupsFailed: out.backupsFailed.length, filesFailed: out.filesFailed.length })
    return { ...securityView(), ...out }
  }, 'owner')

  handle('security:passphrase:change', async (p) => {
    const { current: old, passphrase, confirm } = z
      .object({ current: z.string().min(1).max(1024), passphrase: passphraseSchema, confirm: z.string().max(1024) })
      .strict()
      .parse(p)
    if (confirm !== passphrase) throw new AppError('passphrase_mismatch', 'The two passphrases are not the same', { field: 'confirm' })
    const c = requireCompany()
    if (!c.encrypted) throw new AppError('security_not_locked', 'This business is not locked with a passphrase')
    const before = readEnvelope(companyDir(c.slug), c.slug, appSecretStore())
    const key = await assertPassphrase(c, old, 'current')
    // Only the wrapping changes: the books and every backup keep the same key.
    const next = await wrapKeyAsync(key, passphrase, scryptParams())
    const { mirrored } = writeEnvelope(companyDir(c.slug), c.slug, next, appSecretStore())
    writeAudit(c.db, 'security', 0, 'update', { passphraseSetAt: before?.createdAt ?? null }, { passphraseSetAt: next.createdAt, keyCopyInSecureStorage: mirrored })
    return securityView()
  }, 'owner')

  // Backup checks: the list (Settings → Backups) and "Check now" on the newest (or a named) backup.
  handle('backup:checks', () => listBackupChecks(requireCompany().db), 'viewer')
  handle('backup:check', async (p) => {
    const { file } = z.object({ file: backupFileSchema.optional() }).strict().parse(p ?? {})
    const c = requireCompany()
    const name = file ?? listBackupsIn(companyBackupsDir(c.slug))[0]?.file
    if (!name) throw new Error('There is no backup to check yet — take one first')
    const path = join(companyBackupsDir(c.slug), name)
    if (!existsSync(path)) throw new Error('Backup file not found')
    const check = await verifyBackupFileAsync(path, { asOn: todayISO(), key: isEncryptedFile(path) ? keyOfHandle(c.db) : null })
    if (!c.db.open) throw new Error('The business was closed before the check finished')
    return recordBackupCheck(c.db, check)
  })

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
  // Update consent: app-level (the setting and the notice belong to the whole app, not a company),
  // so changing it or answering a notice is owner-only wherever the open company has users.
  handle('app:updates:get', () => updatesView(), 'viewer')
  const updatesVerdict = (): UpdatesCanSet => {
    const usersExist = !!current?.usersExist
    return updatesCanSet({
      companyHasUsers: usersExist,
      isOwner: sessionUser?.role === 'owner',
      anyOtherCompanyHasUsers: !usersExist && otherCompanyHasUsers()
    })
  }
  // The AI-key rule: no users here -> refused while another company has users, else only with an explicit confirmation.
  const guardUpdates = (confirmNoUsers: boolean): string | null => {
    const v = updatesVerdict()
    if (v.reason === 'other_company_has_users') throw new AppError('updates_other_company_has_users', 'Another company on this computer has users — open it and sign in as its owner to change the update setting.')
    if (!v.allowed) throw new AppError('updates_owner_only', 'Only the owner can change this.')
    if (v.reason === 'needs_confirmation') {
      if (!confirmNoUsers) throw new AppError('updates_confirm_no_users', 'No company on this computer has users, so anyone using it can change the update setting. Confirm to continue.')
      return 'no sign-ins (confirmed)'
    }
    return null
  }
  handle('app:updates:canSet', (p) => {
    z.object({}).strict().default({}).parse(p ?? {})
    return updatesVerdict()
  }, 'viewer')
  handle('app:updates:set', (p) => {
    const { autoCheck, confirmNoUsers } = z.object({ autoCheck: z.boolean(), confirmNoUsers: z.boolean().default(false) }).strict().parse(p)
    const mode = guardUpdates(confirmNoUsers)
    return setAutoCheck(autoCheck, sessionUser?.name ?? mode)
  }, 'owner')
  handle('app:updates:act', (p) => {
    const { action, confirmNoUsers } = z.object({ action: z.enum(UPDATE_ACTIONS), confirmNoUsers: z.boolean().default(false) }).strict().parse(p)
    const mode = guardUpdates(confirmNoUsers)
    return updateAction(action, sessionUser?.name ?? mode)
  }, 'owner')
  // WP 10.3: a help article's link to the GST portal / CBIC — the allow-list again here, so the
  // renderer can never open anything else through it.
  handle('help:openLink', async (p) => {
    const { url } = z.object({ url: z.string().max(500) }).strict().parse(p)
    // Open the parser's normalised form, never the raw string (the OS URL parser may read odd
    // input — a backslash, spaces — differently from the WHATWG one that checked it).
    const safe = allowedHelpUrl(url)
    if (!safe) throw new Error('Help links open only the GST portal or CBIC')
    await shell.openExternal(safe)
  }, 'viewer')

  // ---------- agent bridge (CSV/JSON mirrors + inbox, lane A) ----------
  handle('agent:exportMirror', (p) => {
    const input = agentExportSchema.parse(p ?? {})
    const c = requireCompany()
    const r = agentBridge.exportMirror(c.db, c.slug, { ...input, canSeeProfit: canSeeProfitNow() })
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

  // ---------- MCP server (WP 5.7): settings, kill switch, log, drafts from agents ----------
  // The server itself runs in the `total-cli mcp` process (src/main/mcp/); the app only reads its
  // log and the drafts it (or the inbox) made, and owns the per-company kill switch.
  handle('agent:mcp:get', (): McpSettingsView => {
    const c = requireCompany()
    return {
      config: configSvc.getMcpConfig(c.db),
      // Where the CLI runs from: the source checkout in development; a packaged app has none.
      repoDir: app.isPackaged ? null : app.getAppPath(),
      dataDir: process.env.TOTAL_DATA_DIR ? dataRoot() : null,
      usersExist: c.usersExist,
      encrypted: c.encrypted
    }
  }, 'viewer')
  handle('agent:mcp:set', (p) => {
    const input = mcpConfigSchema.parse(p)
    return configSvc.setMcpConfig(requireCompany().db, input)
  }, 'owner')
  handle('agent:mcp:log', () => listMcpLog(requireCompany().db), 'viewer')
  handle('agent:drafts', (p) => {
    const { status } = z.object({ status: z.enum(['open', 'consumed', 'discarded']).optional() }).default({}).parse(p ?? {})
    return aiStore.listDrafts(requireCompany().db, status, undefined, ['mcp', 'inbox'])
  }, 'viewer')

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
