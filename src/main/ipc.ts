import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import { readFileSync, writeFileSync, copyFileSync, rmSync, unlinkSync, mkdtempSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, basename } from 'path'
import { z } from 'zod'
import Database from 'better-sqlite3'
import type { DB } from './db/connection'
import { backupCompany, closeCompanyDb, openCompanyDb } from './db/connection'
import { verifyBackup, listBackupsIn, restoreCompanyDb, restorePreview, rollbackRestore, snapshotSync, backupStamp, runWeeklyIntegrityCheck, type BackupInfo } from './db/backup'
import { checkIntegrity } from './db/integrity'
import { encryptFile, decryptFile } from './db/crypt'
import { readCompanyInfo, seedCompany, writeCompanyInfo } from './db/seed'
import { readRegistry, removeCompany, touchLastOpened, upsertCompany } from './registry'
import { companyBackupsDir, companyDbPath, companyDir, companyExportsDir, dataRoot, dataRootMissing, ensureCompanyTree, slugify } from './paths'
import { claimLock, inspectLock, releaseLock } from './deviceLock'
import { inspectMoveTarget, moveDataRoot } from './dataLocation'
import { configuredDataRoot } from './dataRootConfig'
import { readSecret, writeSecret } from './secrets'
import { syncFolderWarning } from '@shared/syncpath'
import { log, recentLogLines, revealLogs } from './log'
import { checkForUpdatesInteractive } from './updater'
import {
  backupFileSchema, bankRuleInputSchema, batchInputSchema, billsOpenSchema, budgetInputSchema, budgetVarianceSchema, ccStatementSchema,
  chequeConfigSchema, companyCreateSchema, consolidatedRunSchema, costCentreInputSchema, exportCsvSchema, godownInputSchema, groupInputSchema, gst3bManualSchema, gstr2bSchema,
  isoDate, ledgerInputSchema, notifyDeadlinesSchema, passphraseSchema, periodSchema, priceLevelInputSchema, reportScheduleInputSchema, reportViewSaveSchema, exportXlsSchema, priceRateInputSchema, recurringInputSchema, rendererLogSchema, reportPdfSchema, supportSendSchema,
  searchGlobalSchema, stockGroupInputSchema, stockItemInputSchema, stockQuerySchema, tallyImportSchema, tdsExport26qSchema, tdsSectionInputSchema, tdsSuggestSchema,
  tdsSummarySchema, unitInputSchema, voucherInputSchema, voucherTransportSchema, voucherTypeInputSchema
} from '@shared/schemas'
import { addDays, todayISO } from '@shared/dates'
import { aiSettingsSchema } from '@shared/ai/config'
import * as aiConfig from './services/ai/config'
import * as licenseSvc from './services/license'
import { mcpSnippet } from './mcp/snippet'
import { formatPaise } from '@shared/money'
import { ATTACHMENT_EXTENSIONS } from '@shared/attachments'
import * as configSvc from './services/config'
import * as masters from './services/masters'
import * as vouchers from './services/vouchers'
import * as reports from './services/reports'
import * as gst from './services/gst'
import * as filings from './services/filings'
import * as partyNotes from './services/partyNotes'
import * as intel from './services/intel'
import * as analysis from './services/analysis'
import * as receivables from './services/receivables'
import * as attendance from './services/attendance'
import * as assets from './services/assets'
import * as disclosure from './services/disclosure'
import * as counter from './services/counter'
import * as salesDocs from './services/salesDocs'
import * as borrowing from './services/borrowing'
import * as commission from './services/commission'
import * as rawPrint from './services/rawPrint'
import { DEFAULT_MARGINS } from '@shared/drawingPower'
import { escpDebug } from '@shared/escp'
import { ratesForMonth, STATUTORY_HISTORY } from '@shared/statutory'
import { statementHtml } from './services/statementHtml'
import * as banking from './services/banking'
import * as chequeBounce from './services/chequeBounce'
import * as edocs from './services/edocs'
import * as invoice from './services/invoice'
import * as cheque from './services/cheque'
import * as extras from './services/extras'
import * as payroll from './services/payroll'
import * as nic from './services/nic'
import * as tds from './services/tds'
import * as costCentres from './services/costCentres'
import * as cashForecast from './services/cashForecast'
import * as reportViews from './services/reportViews'
import * as reportSchedules from './services/reportSchedules'
import * as stockAnalysis from './services/stockAnalysis'
import * as inventoryTransfer from './services/inventoryTransfer'
import * as inventoryLandedCost from './services/inventoryLandedCost'
import * as inventoryReorder from './services/inventoryReorder'
import * as priceLevels from './services/priceLevels'
import * as budgets from './services/budgets'
import * as recurring from './services/recurring'
import * as voucherTemplates from './services/voucherTemplates'
import * as yearEnd from './services/yearEnd'
import { importTallyXml, dryRunTallyXml, diffTallyXml, importTallyXmlStreaming } from './services/tallyImport'
import { migrationReportBody } from './services/migrationReport'
import * as importer from './services/importers'
import * as agentBridge from './services/agentBridge'
import { agentBridgeConfigSchema, agentExportSchema } from '@shared/schemas'
import * as consolidated from './services/consolidated'
import * as caPack from './services/caPack'
import { writeExportPdf } from './services/pdf'
import { reportHtml } from './services/reportHtml'
import { globalSearch } from './services/search'
import { createDemoCompany } from './services/demo'
import {
  setAuditContext, writeAudit, listAudit, pruneAudit, verifyAuditChain, dailyDigest
} from './services/audit'
import * as users from './services/users'
import { assertDeleteAuthorized, auditCompanyDeletion } from './services/companyDelete'
import { roleAllows, type Role } from './services/roles'
import { capabilityOfChannel, denialMessage, permitsChannel, type Capability } from '@shared/permissions'
import { recoveryGuidance } from '@shared/recovery'
import { lockMessage } from '@shared/deviceLock'
import { duplicateWarning, findDuplicateCompanies } from '@shared/companyIdentity'
import { externalDestinationVerdict, describeExternalSchedule } from '@shared/backupSchedule'
import { externalBackupSchema } from '@shared/schemas'
import * as externalBackup from './services/externalBackup'
import { exportPortable, importPortable } from './services/portable'
import {
  buildSpreadsheet, date as xlsDate, money as xlsMoney, num as xlsNum, text as xlsText
} from '@shared/spreadsheet'
import { PORTABLE_FORMAT } from '@shared/portable'
import * as attachments from './services/attachments'
import * as approvals from './services/approvals'
import * as bankChanges from './services/bankChanges'
import * as support from './services/support'
import {
  AUDITOR_DURATIONS_HOURS, AUDITOR_SESSION_NAME, auditorExpiry, auditorSessionExpired,
  auditorTimeLeftLabel, type AuditorSession
} from '@shared/auditorSession'
import {
  bomInputSchema, currencyInputSchema, employeeInputSchema, nicCredentialsSchema, auditListSchema,
  userInputSchema, authLoginSchema, payHeadInputSchema, employeeHeadsSetSchema, payrollRunIdSchema,
  auditRetentionSchema, invoicePdfBatchSchema
} from '@shared/schemas'
import type { CompanyInfo } from '@shared/domain'
import { featuresSchema } from '@shared/features'
import { invoiceConfigPartialSchema, invoiceConfigSchema } from '@shared/invoiceConfig'
import { PERIODS } from '@shared/period'
import { buildChecklist } from '@shared/onboarding'
import { GITHUB_REPO, SITE_URL } from '@shared/product'

export interface OpenCompany {
  slug: string
  db: DB
  info: CompanyInfo
  /** Cached usersExist(db) — recomputed only on open and after users:save/deactivate, so ordinary
   *  IPC calls (the vast majority) never pay for a COUNT query just to check the role gate. */
  usersExist: boolean
  /** Cached archive flag (roadmap #257), for the same reason: the gate runs on every channel. */
  archived: boolean
}

let current: OpenCompany | null = null

/** Paths the Tally-import file dialog has actually issued this session. A `filePath` supplied in
 *  a tally:import payload must be one of these — otherwise the renderer could pass any path on
 *  disk and have it read straight into the app (arbitrary file read). The dryRun -> apply wizard
 *  flow still works: dryRun's dialog pick adds the path here, and apply's payload just needs to
 *  echo that same path back. The `xmlText` inline path (used by drivers/tests) is unaffected. */
const dialogIssuedTallyPaths = new Set<string>()

/** Same guard for attachments: a `filePath` in a voucher:attachments:add payload must be one the
 *  picker issued this session, or the renderer could have any file on disk copied into the
 *  company folder. The inline `bytesBase64` path (drivers/tests) is unaffected. */
const dialogIssuedAttachmentPaths = new Set<string>()

/** Set by tally:cancel, polled by the running import between chunks. A plain module-level flag
 *  is enough because only one import can be in flight: the wizard's button is disabled while it
 *  runs, and main processes one handler at a time between yields. */
let importCancelled = false

/** The signed-in user for the currently-open company, or null before login / after logout.
 *  Cleared whenever the company itself closes (see closeCurrentCompany). */
let sessionUser: { id: number; name: string; role: Role; denied: Capability[] } | null = null

/**
 * The auditor's session, when one is open (roadmap V #391).
 *
 * In memory only, and never persisted: an auditor session that survived a restart would be a
 * second way into the books that outlives the visit, which is the exact failure it exists to
 * prevent. It rides alongside `sessionUser` — while it is live, `sessionUser` IS the auditor
 * (role 'viewer', so every write channel refuses it by the existing gate) and the expiry below
 * is the only thing this adds.
 */
let auditorSession: AuditorSession | null = null

/** Ends the auditor's session — on expiry, on Sign out, or when the company closes. */
function endAuditorSession(): void {
  auditorSession = null
  if (sessionUser?.name === AUDITOR_SESSION_NAME) sessionUser = null
}

function requireCompany(): OpenCompany {
  if (!current) throw new Error('No company is open')
  return current
}

/** Who is signed in, for the device-lock heartbeat — the second machine is told a name, not a pid. */
export function getSessionUserName(): string | null {
  return sessionUser?.name ?? null
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
    // Drop this machine's claim before the handle goes: another machine watching the folder
    // should see the books free the moment they actually are (roadmap #259).
    releaseLock(current.slug)
    closeCompanyDb(current.db)
    current = null
  }
  sessionUser = null
  auditorSession = null
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
  'support:send',
  'backup:importEncrypted',
  'app:info'
])

/**
 * Channels that still work on archived books.
 *
 * Only the ones that get data OUT, plus the switch itself — an archive you cannot reverse is a
 * trap, and it has to be reversible from inside the state it creates.
 */
const ARCHIVE_EXEMPT_CHANNELS = new Set([
  'company:archive:set',
  'company:close',
  'company:backup',
  'company:revealExports',
  'backup:run',
  'backup:exportEncrypted',
  'backup:external:runNow',
  'export:csv',
  'export:caPack',
  'export:tallyXml',
  'export:portable',
  'log:renderer',
  'log:reveal',
  'log:diagnostics',
  'support:send',
  'auth:login',
  'auth:logout'
])

/**
 * Channels that keep working when the licence has lapsed.
 *
 * The promise is that an expired licence never locks anyone out of their own accounts, so
 * everything that gets data OUT stays available forever: opening a company, backing it up,
 * exporting it, printing it, and of course entering a licence. Only posting new entries stops.
 */
const LICENSE_EXEMPT_CHANNELS = new Set([
  'company:list',
  'company:open',
  'company:close',
  'company:create',
  'backup:list',
  'backup:run',
  'backup:restore',
  'backup:exportEncrypted',
  'backup:importEncrypted',
  'export:csv',
  'export:xls',
  'export:caPack',
  'export:tallyXml',
  'license:get',
  'license:apply',
  'log:renderer',
  'log:reveal',
  'log:diagnostics',
  'support:send',
  'app:info',
  'auth:login',
  'auth:logout',
  'auth:current'
])

/**
 * Cached licence state. `currentState()` reads a file, and this wrapper runs on all 200-odd
 * channels, so re-reading per call would put a stat in the path of every query for no benefit —
 * the state only changes when a key is entered, or at midnight.
 */
let licenseCache: { readOnly: boolean; at: number } | null = null
function licenseReadOnly(): boolean {
  if (licenseCache && Date.now() - licenseCache.at < 60_000) return licenseCache.readOnly
  const readOnly = licenseSvc.isReadOnly()
  licenseCache = { readOnly, at: Date.now() }
  return readOnly
}
export function invalidateLicenseCache(): void {
  licenseCache = null
}

function handle(channel: string, fn: Handler, minRole: Role = 'accountant'): void {
  ipcMain.handle(`total:${channel}`, async (_event, payload: unknown) => {
    try {
      // Role gating is a no-op until a company is open AND that company has at least one user
      // (usersExist is cached on `current` — see OpenCompany — to avoid a COUNT query per call).
      // A brand-new company with zero users is intentionally wide open: that's how the very
      // first (owner) user gets created via users:save without a chicken-and-egg deadlock.
      // An auditor session dies of old age wherever it is noticed, which is here — the one
      // place every channel passes through. Checked before the role gate, so an expired auditor
      // is refused as "signed out" rather than as "not allowed", and the renderer routes them to
      // the lock screen like any other ended session.
      if (auditorSession && auditorSessionExpired(auditorSession, Date.now())) {
        endAuditorSession()
      }
      if (!UNGATED_CHANNELS.has(channel) && current && current.usersExist) {
        if (!sessionUser) {
          // Distinct from the role-denied case below: the renderer can route this specifically
          // to the lock screen instead of a generic permission toast.
          throw new Error('Locked — sign in first')
        }
        if (!roleAllows(sessionUser.role, minRole)) {
          throw new Error('You do not have permission to do that')
        }
        // Per-user denials narrow the role (roadmap #266). Checked here, in the same place the
        // role is, so a channel added tomorrow is covered by its prefix without being annotated.
        if (!permitsChannel(sessionUser.denied, channel)) {
          throw new Error(denialMessage(capabilityOfChannel(channel)!))
        }
      }
      // An archived company is read-only for everyone, including its owner (roadmap #257).
      // Same shape as the licence check below and for the same reason: reading, printing,
      // exporting and backing up must keep working — archived books nobody can get data out of
      // are a hostage rather than a record. Un-archiving is exempt, or it would lock itself in.
      if (minRole !== 'viewer' && current?.archived && !ARCHIVE_EXEMPT_CHANNELS.has(channel)) {
        throw new Error(
          'These books are archived and read-only. Turn that off in Settings → Backups if you need to post to them.'
        )
      }
      // A lapsed licence is exactly "everyone is a viewer": every read channel is declared
      // `viewer`, so gating on minRole alone leaves reading, printing, exporting and backup
      // working without listing them one by one.
      if (minRole !== 'viewer' && !LICENSE_EXEMPT_CHANNELS.has(channel) && licenseReadOnly()) {
        throw new Error(
          'Your licence has lapsed. Your books are still here — you can read, print, export and back up everything. Add a licence in Settings to post new entries.'
        )
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

/** Godown-to-godown transfer (roadmap #112). Quantities are integer thousandths; the value is
 *  never sent from the renderer — the service asks the valuation engine for it. */
const transferInputSchema = z.object({
  date: isoDate,
  fromGodownId: z.number().int().positive(),
  toGodownId: z.number().int().positive(),
  items: z
    .array(z.object({ stockItemId: z.number().int().positive(), qtyMilli: z.number().int() }))
    .max(200),
  narration: z.string().trim().max(1000).nullable().optional(),
  number: z.string().trim().max(40).optional()
})

/** One landed-cost line on a purchase (roadmap #117). */
const landedCostRowSchema = z.object({
  ledgerId: z.number().int().positive(),
  label: z.string().trim().max(60),
  amount: z.number().int().positive(),
  basis: z.enum(['value', 'qty'])
})

/** One attachment to add: a picked path, or the bytes inline (drivers/tests), plus the name to
 *  keep it under. Base64 capped a little above the 10 MB byte limit, since base64 is ~4/3 the
 *  size — the real limit is enforced on the decoded bytes in services/attachments.ts. */
const attachmentAddSchema = z.object({
  voucherId: z.number().int().positive(),
  filePath: z.string().min(1).optional(),
  fileName: z.string().min(1).max(255).optional(),
  bytesBase64: z.string().max(16 * 1024 * 1024).optional(),
  note: z.string().trim().max(200).nullable().optional()
})

/** The auditor session as the renderer sees it: enough to draw the banner, nothing more. */
function auditorStatus(): { active: boolean; expiresAt: string | null; timeLeft: string | null; grantedBy: string | null } {
  if (!auditorSession) return { active: false, expiresAt: null, timeLeft: null, grantedBy: null }
  return {
    active: true,
    expiresAt: auditorSession.expiresAt,
    timeLeft: auditorTimeLeftLabel(auditorSession, Date.now()),
    grantedBy: auditorSession.grantedBy
  }
}

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
    // Who else has these books open, decided BEFORE we take them (roadmap #259). Reported, never
    // refused: a lock file is evidence about another machine, and evidence about another machine
    // is exactly the kind of thing that is sometimes wrong.
    const lockVerdict = inspectLock(slug)
    const db = openCompanyDb(slug)
    const info = readCompanyInfo(db)
    current = { slug, db, info, usersExist: users.usersExist(db), archived: configSvc.getArchive(db).archived }
    claimLock(slug, sessionUser?.name ?? null)
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
      const purged = vouchers.purgeOldDeleted(db, configSvc.getBinPurgeDays(db))
      if (purged > 0) {
        log('info', 'bin-purge', { purged })
        // A purge is the only thing that really deletes a voucher, and with it the rows that
        // remembered its attachments. Their copies would otherwise sit in the folder forever.
        const swept = attachments.sweepOrphanFiles(db, slug)
        if (swept > 0) log('info', 'attachment-sweep', { swept })
      }
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
    // Scheduled reports. There is no daemon in an offline app, so "on a timer" means "the next
    // time the books are opened after the due date" — deliberately fire-and-forget so a slow PDF
    // render (or a folder that has gone away) can never delay opening the company.
    void reportSchedules
      .runDue(db, info, slug, todayISO())
      .then((runs) => {
        for (const r of runs) {
          if (r.error) log('warn', 'report-schedule-failed', { id: r.id, report: r.report, error: r.error })
          else log('info', 'report-schedule-written', { id: r.id, report: r.report, path: r.path })
        }
      })
      .catch((err: unknown) => log('warn', 'report-schedule-run-failed', { slug, error: String(err) }))
    // Agent bridge (feature flag, default OFF): watch <company>/inbox/ for dropped files.
    if (configSvc.getAgentBridgeEnabled(db)) agentBridge.syncInboxWatcher({ slug, db })
    return {
      slug,
      info,
      integrity,
      locked: current.usersExist,
      archived: current.archived,
      openElsewhere: lockMessage(lockVerdict)
    }
  })

  handle('company:close', () => {
    closeCurrentCompany()
    return null
  })

  handle('company:current', () =>
    current
      ? { slug: current.slug, info: current.info, locked: current.usersExist && !sessionUser, archived: current.archived }
      : null
  )

  // ---------- archived books: readable, not writable (roadmap #257) ----------
  handle('company:archive:get', () => configSvc.getArchive(requireCompany().db), 'viewer')
  handle('company:archive:set', (p) => {
    const { archived, note } = z
      .object({ archived: z.boolean(), note: z.string().max(200).nullable().default(null) })
      .parse(p)
    const c = requireCompany()
    const state = configSvc.setArchive(c.db, archived, note, sessionUser?.name ?? null)
    c.archived = state.archived
    return state
  }, 'owner')

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
  // Closing the wrong year is a two-keystroke mistake with a heavy consequence (roadmap #258).
  handle('yearend:reverse', (p) => {
    const { fyStartYear } = fyStartYearSchema.parse(p)
    return yearEnd.reverseClose(requireCompany().db, fyStartYear)
  }, 'owner')

  // ---------- backups: list/run/restore + encrypted export/import ----------
  handle('backup:list', (): BackupInfo[] => {
    const c = requireCompany()
    return listBackupsIn(companyBackupsDir(c.slug))
  }, 'viewer')

  handle('backup:run', runManualBackup)

  handle('config:binPurge:get', () => {
    const c = requireCompany()
    const days = configSvc.getBinPurgeDays(c.db)
    return { days, ...vouchers.binPurgeCandidates(c.db, days) }
  }, 'viewer')
  handle('config:binPurge:set', (p) => {
    const { days } = z.object({ days: z.number().int().min(0).max(3650) }).parse(p)
    return { days: configSvc.setBinPurgeDays(requireCompany().db, days) }
  }, 'owner')

  handle('config:backupKeep:get', () => ({ keep: configSvc.getBackupKeep(requireCompany().db) }), 'viewer')
  handle('config:backupKeep:set', (p) => {
    const { keep } = z.object({ keep: z.number().int().min(5).max(200) }).parse(p)
    return { keep: configSvc.setBackupKeep(requireCompany().db, keep) }
  }, 'owner')

  // ---------- what a restore would change, before it changes it (roadmap #246) ----------
  handle('backup:preview', (payload) => {
    const { file } = z.object({ file: backupFileSchema }).parse(payload)
    const c = requireCompany()
    return restorePreview(c.db, join(companyBackupsDir(c.slug), file), file)
  }, 'viewer')

  /**
   * What to do when the database is damaged (roadmap #248).
   *
   * Built in main because only main can see both the integrity result and the backups folder,
   * and the guidance depends on both: there is no point telling someone to restore a backup when
   * they have none, or to repair a file when one voucher is out of balance.
   */
  handle('backup:recovery', () => {
    const c = requireCompany()
    const integrity = checkIntegrity(c.db)
    const backups = listBackupsIn(companyBackupsDir(c.slug))
    const newest = backups[0]
    return {
      integrity,
      guidance: recoveryGuidance({
        quickCheck: integrity.quickCheck,
        unbalancedVoucherIds: integrity.unbalancedVoucherIds,
        backupsNewestFirst: backups.map((b) => new Date(b.mtime).toISOString().slice(0, 16).replace('T', ' ')),
        newestBackupVerified: newest ? verifyBackup(join(companyBackupsDir(c.slug), newest.file)).balanced : undefined
      })
    }
  }, 'viewer')

  // ---------- the backup that leaves the machine (roadmap #245, #253) ----------
  const externalPassphraseKey = (slug: string): string => `backup.external.${slug}`

  handle('backup:external:get', () => {
    const c = requireCompany()
    const config = configSvc.getExternalBackup(c.db)
    return {
      ...config,
      description: describeExternalSchedule(config),
      // Never the passphrase itself — only whether this machine still has one.
      hasPassphrase: readSecret(externalPassphraseKey(c.slug)) !== null
    }
  }, 'viewer')

  handle('backup:external:choose', async () => {
    const c = requireCompany()
    const picked = await dialog.showOpenDialog({
      title: 'Choose a folder for copies of these books',
      properties: ['openDirectory', 'createDirectory']
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    const dir = picked.filePaths[0]
    const config = configSvc.getExternalBackup(c.db)
    return { dir, verdict: externalDestinationVerdict(dir, dataRoot(), config.encrypt) }
  }, 'owner')

  handle('backup:external:set', (p) => {
    const input = externalBackupSchema.parse(p)
    const c = requireCompany()
    if (input.dir) {
      const verdict = externalDestinationVerdict(input.dir, dataRoot(), input.encrypt)
      if (!verdict.ok) throw new Error(verdict.error)
    }
    // The passphrase goes to the OS keychain, never into `meta` — a passphrase stored in the
    // database would be copied into every backup it exists to protect. Turning encryption off
    // forgets it rather than leaving it lying in the keychain unused.
    if (input.encrypt) {
      if (input.passphrase) writeSecret(externalPassphraseKey(c.slug), input.passphrase)
      if (readSecret(externalPassphraseKey(c.slug)) === null) {
        throw new Error('An encrypted schedule needs a passphrase. Nobody can recover it, so keep it somewhere else.')
      }
    } else {
      writeSecret(externalPassphraseKey(c.slug), null)
    }
    const saved = configSvc.setExternalBackup(c.db, {
      dir: input.dir,
      everyHours: input.everyHours,
      encrypt: input.encrypt,
      keep: input.keep,
      lastRunAt: null,
      lastError: null
    })
    return { ...saved, description: describeExternalSchedule(saved) }
  }, 'owner')

  handle('backup:external:runNow', async () => {
    const c = requireCompany()
    const config = configSvc.getExternalBackup(c.db)
    if (!config.dir) throw new Error('No folder is set for copies of these books')
    const run = await externalBackup.runExternalBackup(
      c.db,
      c.slug,
      config,
      config.encrypt ? readSecret(externalPassphraseKey(c.slug)) : null
    )
    configSvc.stampExternalBackup(c.db, new Date().toISOString(), null)
    auditExport(c.db, 'external_backup', { path: run.path, encrypted: config.encrypt })
    return run
  }, 'owner')

  handle('backup:verify', (payload) => {
    const { file } = z.object({ file: backupFileSchema }).parse(payload)
    const c = requireCompany()
    return verifyBackup(join(companyBackupsDir(c.slug), file))
  }, 'viewer')

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
      return { slug, db, info, usersExist: users.usersExist(db), archived: configSvc.getArchive(db).archived }
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
    const { passphrase, allowDuplicate } = z
      .object({ passphrase: passphraseSchema, allowDuplicate: z.boolean().default(false) })
      .parse(payload)
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

    // The same books arriving twice under two slugs is the most dangerous silent success in the
    // app (roadmap #251): the user works in the copy for a week while their real books sit in the
    // other one, and the two can never be recombined.
    const duplicates = findDuplicateCompanies(readRegistry().companies, { name: info.name, gstin: info.gstin })
    if (duplicates.length > 0 && !allowDuplicate) {
      rmSync(tempDir, { recursive: true, force: true })
      return { needsConfirmation: true, duplicates, warning: duplicateWarning(duplicates) }
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
    return { needsConfirmation: false, slug, name: info.name }
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
  // Bank details on a NEW party are written straight through: there is no previous account to
  // redirect money away from, so the two-person rule (which guards the *change*) has nothing to
  // protect yet. The shared-account exception still sees it immediately.
  handle('master:ledgers:create', (p) => masters.createLedger(requireCompany().db, ledgerInputSchema.parse(p)))
  /**
   * Save a party — with the bank details taken out of the ordinary path.
   *
   * Everything else about the master saves as it always did. The account number, IFSC and holder
   * are routed through the two-person rule (roadmap V #388), which either applies them or parks
   * them for someone else to confirm. The result says which happened, because a change that
   * silently did not take effect would be worse than no rule at all.
   */
  handle('master:ledgers:update', (p) => {
    const { id, data } = withIdSchema(ledgerInputSchema).parse(p)
    const c = requireCompany()
    const wantsBankChange =
      data.bankAccount !== undefined || data.bankIfsc !== undefined || data.bankHolder !== undefined
    const ledger = masters.updateLedger(c.db, id, {
      ...data,
      bankAccount: undefined,
      bankIfsc: undefined,
      bankHolder: undefined
    })
    if (!wantsBankChange) return { ...ledger, bankChange: null as bankChanges.BankChangeRequest | null }
    const outcome = bankChanges.submitBankChange(
      c.db,
      id,
      { account: data.bankAccount ?? null, ifsc: data.bankIfsc ?? null, holder: data.bankHolder ?? null },
      { role: sessionUser?.role ?? null, name: sessionUser?.name ?? null }
    )
    return { ...masters.getLedger(c.db, id)!, bankChange: outcome.request }
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

  handle('stock:nearExpiry', (p) => {
    const { asOn } = z.object({ asOn: isoDate }).parse(p)
    return stockAnalysis.nearExpiry(requireCompany().db, asOn)
  }, 'viewer')

  handle('stock:effectiveTax', (p) => {
    const { stockItemId } = z.object({ stockItemId: z.number().int().positive() }).parse(p)
    return masters.effectiveItemTax(requireCompany().db, stockItemId)
  }, 'viewer')

  handle('stock:find', (p) => {
    const { query } = z.object({ query: z.string().trim().max(120) }).parse(p)
    return masters.findItem(requireCompany().db, query)
  }, 'viewer')
  // ---------- moving stock between godowns (roadmap #112) ----------
  handle('stock:godownStock', (p) => {
    const { asOn, godownId } = z.object({ asOn: isoDate, godownId: z.number().int().positive() }).parse(p)
    return inventoryTransfer.godownAvailability(requireCompany().db, asOn, godownId)
  }, 'viewer')
  handle('stock:previewTransfer', (p) => inventoryTransfer.previewTransfer(requireCompany().db, transferInputSchema.parse(p)), 'viewer')
  handle('stock:saveTransfer', (p) => inventoryTransfer.saveTransfer(requireCompany().db, transferInputSchema.parse(p)), 'accountant')
  handle('stock:transfers', (p) => {
    const { from, to } = periodSchema.parse(p)
    return inventoryTransfer.listTransfers(requireCompany().db, from, to)
  }, 'viewer')

  // ---------- landed cost on a purchase (roadmap #117) ----------
  handle('stock:costablePurchases', (p) => {
    const { from, to } = periodSchema.parse(p)
    return inventoryLandedCost.costablePurchases(requireCompany().db, from, to)
  }, 'viewer')
  handle('stock:landedCosts', (p) => {
    const { voucherId } = z.object({ voucherId: z.number().int().positive() }).parse(p)
    return inventoryLandedCost.landedCostView(requireCompany().db, voucherId)
  }, 'viewer')
  handle('stock:saveLandedCosts', (p) => {
    const { voucherId, costs } = z
      .object({ voucherId: z.number().int().positive(), costs: z.array(landedCostRowSchema).max(20) })
      .parse(p)
    return inventoryLandedCost.saveLandedCosts(requireCompany().db, voucherId, costs)
  }, 'accountant')

  // ---------- reorder alerts (roadmap #121) ----------
  handle('stock:reorderAlerts', (p) => {
    const { asOn } = z.object({ asOn: isoDate }).parse(p)
    const c = requireCompany()
    return inventoryReorder.reorderAlerts(c.db, c.info.name, asOn)
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
    // The approval threshold applies to what a PERSON types, which is only knowable here: the
    // recurring runner, the Tally import and the agent inbox all call saveVoucher without an
    // actor and are therefore never gated (roadmap V #386).
    const saved = vouchers.saveVoucher(c.db, data, id, {
      role: sessionUser?.role ?? null,
      hasUsers: c.usersExist
    })
    // Agent mirror stays fresh while the flag is on — debounced so entry bursts export once.
    if (configSvc.getAgentBridgeEnabled(c.db)) agentBridge.scheduleMirrorRefresh(c.db, c.slug)
    return saved
  })
  handle('voucher:delete', (p) => vouchers.deleteVoucher(requireCompany().db, idSchema.parse(p).id))
  // Bulk edit: narration and cost centre only (#39). Both are annotations on an entry rather
  // than part of what it says, which is why they are the two that can be swept safely.
  handle('voucher:bulkEdit', (p) => {
    const { ids, narration, costCentreId } = z
      .object({
        ids: z.array(z.number().int().positive()).min(1).max(500),
        narration: z.string().max(500).nullable().optional(),
        costCentreId: z.number().int().positive().nullable().optional()
      })
      .parse(p)
    const edit: vouchers.BulkVoucherEdit = {}
    if (narration !== undefined) edit.narration = narration
    if (costCentreId !== undefined) edit.costCentreId = costCentreId
    return vouchers.bulkEditVouchers(requireCompany().db, ids, edit)
  })
  handle('voucher:bin', () => vouchers.listBin(requireCompany().db), 'viewer')
  handle('voucher:restore', (p) => vouchers.restoreVoucher(requireCompany().db, idSchema.parse(p).id))
  handle('voucher:purge', (p) => {
    const c = requireCompany()
    vouchers.purgeVoucher(c.db, idSchema.parse(p).id)
    // The attachment rows went with the voucher (ON DELETE CASCADE); the copies on disk have to
    // be shown the door explicitly.
    attachments.sweepOrphanFiles(c.db, c.slug)
  }, 'owner')
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
  /** Vouchers in books right now — the denominator for "what would a restore cost". */
  /**
   * The getting-started checklist, derived from the books.
   *
   * Every step is computed rather than ticked: a checklist someone can tick without doing the
   * thing is a checklist that lies, and the moment it matters is the moment a new user is
   * deciding whether this application will work for them.
   *
   * Two facts are genuinely preferences rather than book facts — whether the shortcut sheet has
   * been opened, and whether a backup has been verified — so those live in meta.
   */
  handle('app:checklist', () => {
    const c = requireCompany()
    const count = (sql: string): number => (c.db.prepare(sql).get() as { n: number }).n
    return buildChecklist({
      hasCompanyAddress: c.info.address.trim().length > 0,
      hasGstin: !!c.info.gstin,
      gstAnswered: c.info.gstRegistrationType === 'unregistered' ? true : !!c.info.gstin,
      ledgerCount: count('SELECT COUNT(*) AS n FROM ledgers'),
      voucherCount: count(`SELECT COUNT(*) AS n FROM vouchers v WHERE ${vouchers.IN_BOOKS}`),
      hasVerifiedBackup: configSvc.getChecklistFlag(c.db, 'backupVerified'),
      hasSeenShortcuts: configSvc.getChecklistFlag(c.db, 'sawShortcuts')
    })
  }, 'viewer')

  handle('app:checklistDone', (p) => {
    const { step } = z.object({ step: z.enum(['backupVerified', 'sawShortcuts']) }).parse(p)
    configSvc.setChecklistFlag(requireCompany().db, step, true)
    return null
  }, 'viewer')

  handle('voucher:count', () => {
    const c = requireCompany()
    return (c.db.prepare(`SELECT COUNT(*) AS n FROM vouchers v WHERE ${vouchers.IN_BOOKS}`).get() as { n: number }).n
  }, 'viewer')

  handle('voucher:draftFrom', (p) => {
    const { voucherId } = z.object({ voucherId: z.number().int().positive() }).parse(p)
    return vouchers.draftFromVoucher(requireCompany().db, voucherId)
  }, 'viewer')
  handle('voucher:latestOfType', (p) => {
    const { voucherTypeId } = z.object({ voucherTypeId: z.number().int().positive() }).parse(p)
    return { voucherId: vouchers.latestVoucherOfType(requireCompany().db, voucherTypeId) }
  }, 'viewer')
  handle('voucher:duplicates', (p) => {
    const { data, excludeId } = z.object({ data: voucherInputSchema, excludeId: z.number().int().positive().optional() }).parse(p)
    return vouchers.findDuplicates(requireCompany().db, data, excludeId)
  })

  // ---------- reports ----------
  handle('report:dayBook', (p) => {
    const { from, to, includeOutOfBooks, limit, offset } = periodSchema
      .extend({
        includeOutOfBooks: z.boolean().optional(),
        limit: z.number().int().min(1).max(2000).optional(),
        offset: z.number().int().min(0).optional()
      })
      .parse(p)
    const { db } = requireCompany()
    // Paged by default from the screen; the CA pack and Tally export call the service directly
    // and still get every row.
    return {
      rows: reports.dayBook(db, from, to, { includeOutOfBooks, limit, offset }),
      total: reports.dayBookCount(db, from, to, includeOutOfBooks)
    }
  }, 'viewer')
  handle('report:ledger', (p) => {
    const { ledgerId, from, to, groupBy, limit, offset } = periodSchema
      .extend({
        ledgerId: z.number().int().positive(),
        groupBy: z.enum(PERIODS).optional(),
        limit: z.number().int().min(1).max(2000).optional(),
        offset: z.number().int().min(0).optional()
      })
      .parse(p)
    return reports.ledgerStatement(
      requireCompany().db,
      ledgerId,
      from,
      to,
      groupBy,
      limit == null ? undefined : { limit, offset }
    )
  }, 'viewer')
  handle('payroll:transferFile', (p) => {
    const { runId } = z.object({ runId: z.number().int().positive() }).parse(p)
    const c = requireCompany()
    const file = payroll.salaryTransferFile(c.db, runId)
    const path = join(companyExportsDir(c.slug), `salary-transfer-${runId}.csv`)
    writeFileSync(path, file.csv, 'utf8')
    auditExport(c.db, 'csv', { filename: `salary-transfer-${runId}`, path })
    return { path, count: file.count, totalPaise: file.totalPaise, skipped: file.skipped }
  }, 'accountant')

  handle('payroll:trend', (p) => {
    const { months } = z.object({ months: z.number().int().min(1).max(120).optional() }).parse(p ?? {})
    return payroll.payrollTrend(requireCompany().db, months)
  }, 'viewer')

  handle('report:purchaseSuggestions', (p) => {
    const { asOn } = z.object({ asOn: isoDate }).parse(p)
    return reports.purchaseSuggestions(requireCompany().db, asOn)
  }, 'viewer')
  handle('report:dayBookByType', (p) => {
    const { from, to, includeOutOfBooks } = periodSchema
      .extend({ includeOutOfBooks: z.boolean().optional() })
      .parse(p)
    return reports.dayBookByType(requireCompany().db, from, to, includeOutOfBooks)
  }, 'viewer')
  handle('report:trialBalance', (p) => {
    const { asOn, includeZeroBalances } = z
      .object({ asOn: z.string(), includeZeroBalances: z.boolean().optional() })
      .parse(p)
    return reports.trialBalance(requireCompany().db, asOn, includeZeroBalances)
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
    const { from, to, largeVoucherPaise } = z
      .object({
        from: isoDate,
        to: isoDate,
        largeVoucherPaise: z.number().int().min(0).max(1_000_000_000_00).optional()
      })
      .parse(p)
    const c = requireCompany()
    return reports.exceptions(c.db, from, to, c.info, largeVoucherPaise)
  }, 'viewer')

  handle('report:whatChanged', (p) => {
    const { from, to } = periodSchema.parse(p)
    return reports.whatChanged(requireCompany().db, from, to)
  }, 'viewer')
  handle('report:ratios', (p) => {
    const { from, to } = periodSchema.parse(p)
    return reports.ratios(requireCompany().db, from, to)
  }, 'viewer')
  handle('report:itemProfitByPeriod', (p) => {
    const { from, to, groupBy } = z
      .object({ from: isoDate, to: isoDate, groupBy: z.enum(PERIODS) })
      .parse(p)
    return reports.itemProfitabilityByPeriod(requireCompany().db, from, to, groupBy)
  }, 'viewer')
  handle('report:cashForecast', (p) => {
    const { from, to, bucketDays } = z
      .object({ from: isoDate, to: isoDate, bucketDays: z.number().int().min(1).max(31).default(7) })
      .parse(p)
    return cashForecast.cashForecast(requireCompany().db, from, to, bucketDays)
  }, 'viewer')

  // ---------- saved report views (C58) ----------
  handle('view:list', (p) => {
    const { screen } = z.object({ screen: z.string().trim().max(40).optional() }).parse(p ?? {})
    return reportViews.listReportViews(requireCompany().db, screen)
  }, 'viewer')
  handle('view:save', (p) => {
    const { screen, name, state } = reportViewSaveSchema.parse(p)
    return reportViews.saveReportView(requireCompany().db, screen, name, state)
  })
  handle('view:delete', (p) => reportViews.deleteReportView(requireCompany().db, idSchema.parse(p).id))

  // ---------- scheduled reports (C59) ----------
  handle('schedule:list', () => reportSchedules.listSchedules(requireCompany().db), 'viewer')
  handle('schedule:save', (p) => {
    const { id, data } = z
      .object({ id: z.number().int().positive().optional(), data: reportScheduleInputSchema })
      .parse(p)
    return reportSchedules.saveSchedule(requireCompany().db, data, id)
  })
  handle('schedule:delete', (p) => reportSchedules.deleteSchedule(requireCompany().db, idSchema.parse(p).id))
  handle('schedule:run', async (p) => {
    const { id } = idSchema.parse(p)
    const c = requireCompany()
    const schedule = reportSchedules.listSchedules(c.db).find((s) => s.id === id)
    if (!schedule) throw new Error('Schedule not found')
    return reportSchedules.runSchedule(c.db, c.info, c.slug, schedule, todayISO())
  })

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

  handle('gst:gstr9', (p) => {
    const { fyStartYear } = z.object({ fyStartYear: z.number().int().min(1990).max(2100) }).parse(p)
    const c = requireCompany()
    return gst.gstr9(c.db, c.info, fyStartYear)
  }, 'viewer')

  // ---------- composition scheme ----------
  handle('gst:cmp08', (p) => {
    const { from, to, category, interest, lateFee } = periodSchema
      .extend({
        category: z.enum(['trader', 'restaurant', 'service']),
        interest: z.number().int().min(0).optional(),
        lateFee: z.number().int().min(0).optional()
      })
      .parse(p)
    const c = requireCompany()
    return gst.cmp08(c.db, c.info, from, to, category, { interest, lateFee })
  }, 'viewer')

  handle('gst:gstr4', (p) => {
    const { fyStartYear, category } = z
      .object({
        fyStartYear: z.number().int().min(1990).max(2100),
        category: z.enum(['trader', 'restaurant', 'service'])
      })
      .parse(p)
    const c = requireCompany()
    return gst.gstr4(c.db, c.info, fyStartYear, category)
  }, 'viewer')

  // ---------- filing register ----------
  handle('filings:register', (p) => {
    const { fyStartYear } = z.object({ fyStartYear: z.number().int().min(1990).max(2100) }).parse(p)
    const c = requireCompany()
    return filings.filingRegister(c.db, c.info, fyStartYear, todayISO())
  }, 'viewer')

  handle('filings:record', (p) => {
    const input = z
      .object({
        form: z.string().trim().min(1).max(20),
        period: z.string().trim().regex(/^\d{4}-(\d{2}|Q[1-4]|H[12]|FY)$/, 'Not a period key'),
        dueDate: isoDate,
        // Null clears the filing, returning the row to unfiled.
        filedAt: isoDate.nullable(),
        // 15 characters on the portal today, but it has been longer before — accept a range
        // rather than pinning a length that would reject a valid ARN.
        arn: z.string().trim().min(1).max(64).nullable(),
        taxPaid: z.number().int().min(0),
        notes: z.string().trim().max(500).nullable()
      })
      .parse(p)
    return filings.recordFiling(requireCompany().db, input)
  }, 'owner')

  handle('filings:liability', (p) => {
    const { form, period } = z
      .object({
        form: z.string().trim().min(1).max(20),
        period: z.string().trim().regex(/^\d{4}-(\d{2}|Q[1-4]|H[12]|FY)$/, 'Not a period key')
      })
      .parse(p)
    const c = requireCompany()
    return filings.filingLiability(c.db, c.info, form, period)
  }, 'viewer')

  // ---------- analysis ----------
  handle('bank:reconciliationStatus', (p) => {
    const { asOn } = z.object({ asOn: isoDate }).parse(p)
    return banking.reconciliationStatus(requireCompany().db, asOn)
  }, 'viewer')

  handle('party:notes', (p) => {
    const { ledgerId } = z.object({ ledgerId: z.number().int().positive() }).parse(p)
    return partyNotes.listPartyNotes(requireCompany().db, ledgerId)
  }, 'viewer')

  handle('party:addNote', (p) => {
    const input = z
      .object({
        ledgerId: z.number().int().positive(),
        note: z.string().trim().min(1).max(1000),
        promisedDate: isoDate.nullable().optional(),
        promisedAmount: z.number().int().min(0).nullable().optional()
      })
      .parse(p)
    const c = requireCompany()
    // Same attribution the audit log uses, so the note and its audit row agree about who.
    return partyNotes.addPartyNote(c.db, input, sessionUser?.name ?? null)
  }, 'accountant')

  handle('party:closeNote', (p) => {
    const { id } = z.object({ id: z.number().int().positive() }).parse(p)
    return partyNotes.closePartyNote(requireCompany().db, id)
  }, 'accountant')

  handle('party:promises', () => partyNotes.openPromises(requireCompany().db, todayISO()), 'viewer')

  // ---------- the collections desk (roadmap #151, #153-#159, #161, #164, #165) ----------

  handle('recv:interest', (p) => {
    const { side, asOn } = z.object({ side: z.enum(['receivable', 'payable']), asOn: isoDate }).parse(p)
    return receivables.interestDue(requireCompany().db, side, asOn)
  }, 'viewer')

  handle('recv:creditScores', (p) => {
    const { asOn } = z.object({ asOn: isoDate }).parse(p)
    return receivables.creditScores(requireCompany().db, asOn)
  }, 'viewer')

  handle('recv:allocationSuggestions', (p) => {
    const { ledgerId, amount, asOn, side } = z
      .object({
        ledgerId: z.number().int().positive(),
        amount: z.number().int().min(0),
        asOn: isoDate,
        side: z.enum(['receivable', 'payable']).default('receivable')
      })
      .parse(p)
    return receivables.allocationSuggestions(requireCompany().db, ledgerId, amount, asOn, side)
  }, 'viewer')

  handle('recv:ageingBy', (p) => {
    const { side, asOn, dimension, bandCuts } = z
      .object({
        side: z.enum(['receivable', 'payable']),
        asOn: isoDate,
        dimension: z.enum(['salesperson', 'territory', 'party']),
        bandCuts: z.array(z.number().int().positive()).max(6).optional()
      })
      .parse(p)
    const c = requireCompany()
    return receivables.ageingBy(c.db, side, asOn, dimension, bandCuts ?? configSvc.getCollectionsPolicy(c.db).bandCuts)
  }, 'viewer')

  handle('recv:provision', (p) => {
    const { asOn } = z.object({ asOn: isoDate }).parse(p)
    const c = requireCompany()
    const policy = configSvc.getCollectionsPolicy(c.db).provisionPolicy
    return {
      result: receivables.badDebtProvision(c.db, asOn, policy),
      draft: receivables.provisionDraft(c.db, asOn, policy)
    }
  }, 'viewer')

  handle('recv:advances', (p) => {
    const { side, asOn } = z.object({ side: z.enum(['receivable', 'payable']), asOn: isoDate }).parse(p)
    return receivables.advances(requireCompany().db, side, asOn)
  }, 'viewer')

  handle('recv:paymentSchedule', (p) => {
    const { from, to, side } = z
      .object({ from: isoDate, to: isoDate, side: z.enum(['payable', 'receivable']).default('payable') })
      .parse(p)
    return receivables.paymentSchedule(requireCompany().db, from, to, side)
  }, 'viewer')

  handle('recv:reminders', (p) => {
    const { side, asOn, minOverdueDays, includeInterest } = z
      .object({
        side: z.enum(['receivable', 'payable']),
        asOn: isoDate,
        minOverdueDays: z.number().int().min(0).max(365).optional(),
        includeInterest: z.boolean().optional()
      })
      .parse(p)
    const c = requireCompany()
    return receivables.bulkReminders(c.db, c.info.name, side, asOn, { minOverdueDays, includeInterest })
  }, 'viewer')

  handle('recv:statement', (p) => {
    const { ledgerId, from, to } = z
      .object({ ledgerId: z.number().int().positive(), from: isoDate, to: isoDate })
      .parse(p)
    const c = requireCompany()
    return receivables.partyStatement(c.db, ledgerId, from, to, configSvc.getCollectionsPolicy(c.db).bandCuts)
  }, 'viewer')

  handle('recv:statementPdf', async (p) => {
    const { ledgerId, from, to, side } = z
      .object({
        ledgerId: z.number().int().positive(),
        from: isoDate,
        to: isoDate,
        side: z.enum(['receivable', 'payable']).default('receivable')
      })
      .parse(p)
    const c = requireCompany()
    const policy = configSvc.getCollectionsPolicy(c.db)
    const st = receivables.partyStatement(c.db, ledgerId, from, to, policy.bandCuts)
    const html = statementHtml(c.info, st, { side, contact: policy.contact })
    const path = await writeExportPdf(c.slug, `statement-${slugify(st.name)}-${from}-${to}.pdf`, html, {
      pageSize: 'A4',
      pageNumbers: true,
      runningHead: { company: c.info.name, gstin: c.info.gstin, title: `Statement — ${st.name}`, periodLabel: `${from} to ${to}` }
    })
    return { path, name: st.name }
  }, 'viewer')

  // ---------- fixed assets and depreciation (roadmap #366, #367, #368) ----------

  handle('assets:blocks', () => assets.ensureBlocks(requireCompany().db), 'viewer')

  handle('assets:saveBlock', (p) => {
    const { data, id } = z
      .object({
        data: z.object({ name: z.string().trim().min(1).max(80), itRate: z.number().min(0).max(100) }),
        id: z.number().int().positive().optional()
      })
      .parse(p)
    return assets.saveBlock(requireCompany().db, data, id)
  })

  handle('assets:list', (p) => {
    const { includeDisposed } = z.object({ includeDisposed: z.boolean().optional() }).parse(p ?? {})
    return assets.listAssets(requireCompany().db, { includeDisposed })
  }, 'viewer')

  handle('assets:save', (p) => {
    const { data, id } = z
      .object({
        data: z.object({
          name: z.string().trim().min(1).max(120),
          code: z.string().trim().max(32).nullable().optional(),
          blockId: z.number().int().positive().nullable().optional(),
          ledgerId: z.number().int().positive().nullable().optional(),
          purchaseDate: isoDate,
          putToUseDate: isoDate.nullable().optional(),
          cost: z.number().int().positive(),
          residualValue: z.number().int().min(0).optional(),
          usefulLifeMonths: z.number().int().positive().max(1200),
          method: z.enum(['slm', 'wdv']).optional(),
          location: z.string().trim().max(80).nullable().optional(),
          notes: z.string().trim().max(500).nullable().optional()
        }),
        id: z.number().int().positive().optional()
      })
      .parse(p)
    return assets.saveAsset(requireCompany().db, data, id)
  })

  handle('assets:delete', (p) => {
    assets.deleteAsset(requireCompany().db, idSchema.parse(p).id)
    return null
  })

  handle('assets:schedule', (p) => {
    const { fyStartYear } = z.object({ fyStartYear: z.number().int().min(1990).max(2200) }).parse(p)
    const c = requireCompany()
    return {
      schedule: assets.depreciationSchedule(c.db, fyStartYear),
      draft: assets.depreciationDraft(c.db, fyStartYear)
    }
  }, 'viewer')

  handle('assets:postDepreciation', (p) => {
    const { fyStartYear, voucherId } = z
      .object({ fyStartYear: z.number().int().min(1990).max(2200), voucherId: z.number().int().positive().nullable() })
      .parse(p)
    const c = requireCompany()
    assets.ensureAssetLedgers(c.db)
    return { runId: assets.recordDepreciationRun(c.db, fyStartYear, voucherId) }
  })

  handle('assets:disposalDraft', (p) => {
    const { assetId, on, proceeds } = z
      .object({ assetId: z.number().int().positive(), on: isoDate, proceeds: z.number().int().min(0) })
      .parse(p)
    const c = requireCompany()
    assets.ensureAssetLedgers(c.db)
    return assets.disposalDraft(c.db, assetId, on, proceeds)
  }, 'viewer')

  handle('assets:dispose', (p) => {
    const { assetId, on, proceeds, voucherId } = z
      .object({
        assetId: z.number().int().positive(),
        on: isoDate,
        proceeds: z.number().int().min(0),
        voucherId: z.number().int().positive().optional()
      })
      .parse(p)
    return assets.recordDisposal(requireCompany().db, assetId, on, proceeds, voucherId)
  })

  // ---------- counter mode, the drawer and schemes (roadmap #376–#385) ----------

  const cartLineSchema = z.object({
    stockItemId: z.number().int().positive(),
    qtyMilli: z.number().int().positive(),
    ratePaise: z.number().int().min(0).optional(),
    discountPaise: z.number().int().min(0).optional(),
    noScheme: z.boolean().optional()
  })
  const tenderSchema = z.object({
    mode: z.enum(['cash', 'card', 'upi', 'credit']),
    amountPaise: z.number().int().min(0)
  })
  const pricingModeSchema = z.enum(['exclusive', 'inclusive'])

  handle('counter:lookup', (p) => {
    const { query, asOn } = z.object({ query: z.string().trim().min(1).max(80), asOn: isoDate.optional() }).parse(p)
    return counter.lookup(requireCompany().db, query, asOn ?? todayISO())
  }, 'viewer')

  handle('counter:price', (p) => {
    const input = z
      .object({
        lines: z.array(cartLineSchema).max(200),
        date: isoDate.optional(),
        partyLedgerId: z.number().int().positive().nullable().optional(),
        pricingMode: pricingModeSchema.optional()
      })
      .parse(p)
    const c = requireCompany()
    return counter.priceCounterCart(c.db, c.info, input)
  }, 'viewer')

  handle('counter:sale', (p) => {
    const input = z
      .object({
        lines: z.array(cartLineSchema).min(1).max(200),
        tenders: z.array(tenderSchema).min(1).max(6),
        date: isoDate.optional(),
        pricingMode: pricingModeSchema.optional(),
        partyLedgerId: z.number().int().positive().nullable().optional(),
        customerName: z.string().trim().max(80).nullable().optional(),
        customerPhone: z.string().trim().max(20).nullable().optional(),
        narration: z.string().trim().max(500).nullable().optional(),
        returnsVoucherId: z.number().int().positive().nullable().optional(),
        kind: z.enum(['sale', 'return']).optional()
      })
      .parse(p)
    const c = requireCompany()
    return counter.saveCounterSale(c.db, c.info, input)
  })

  handle('counter:session', () => counter.openSession(requireCompany().db), 'viewer')
  handle('counter:sessions', (p) => {
    const { limit } = z.object({ limit: z.number().int().positive().max(500).optional() }).parse(p ?? {})
    return counter.listSessions(requireCompany().db, limit)
  }, 'viewer')

  handle('counter:open', (p) => {
    const input = z
      .object({
        openedOn: isoDate.optional(),
        operator: z.string().trim().max(60).nullable().optional(),
        openingFloatPaise: z.number().int().min(0),
        cashLedgerId: z.number().int().positive().nullable().optional()
      })
      .parse(p)
    return counter.openDrawer(requireCompany().db, input)
  })

  handle('counter:summary', (p) => {
    const { sessionId } = z.object({ sessionId: z.number().int().positive() }).parse(p)
    return counter.sessionSummary(requireCompany().db, sessionId)
  }, 'viewer')

  handle('counter:close', (p) => {
    const { sessionId, countedPaise, notes } = z
      .object({
        sessionId: z.number().int().positive(),
        countedPaise: z.number().int().min(0),
        notes: z.string().trim().max(500).nullable().default(null)
      })
      .parse(p)
    return counter.closeDrawer(requireCompany().db, sessionId, countedPaise, notes)
  })

  handle('counter:movement', (p) => {
    const { sessionId, kind, amountPaise, reason } = z
      .object({
        sessionId: z.number().int().positive(),
        kind: z.enum(['payin', 'payout']),
        amountPaise: z.number().int().positive(),
        reason: z.string().trim().max(200).nullable().default(null)
      })
      .parse(p)
    return counter.recordMovement(requireCompany().db, sessionId, kind, amountPaise, reason)
  })

  handle('counter:sales', (p) => {
    const { sessionId, limit } = z
      .object({ sessionId: z.number().int().positive().optional(), limit: z.number().int().positive().max(1000).optional() })
      .parse(p ?? {})
    return counter.listCounterSales(requireCompany().db, sessionId, limit)
  }, 'viewer')

  handle('counter:findSale', (p) => {
    const { query } = z.object({ query: z.string().trim().min(1).max(60) }).parse(p)
    return counter.findSaleForReturn(requireCompany().db, query)
  }, 'viewer')

  handle('counter:schemes', () => counter.listSchemes(requireCompany().db), 'viewer')

  handle('counter:saveScheme', (p) => {
    const { data, id } = z
      .object({
        data: z.object({
          name: z.string().trim().min(1).max(80),
          stockItemId: z.number().int().positive().nullable().optional(),
          stockGroupId: z.number().int().positive().nullable().optional(),
          kind: z.enum(['percent', 'rate', 'free']),
          minQtyMilli: z.number().int().positive(),
          percentBp: z.number().int().min(0).max(10000).nullable().optional(),
          ratePaise: z.number().int().min(0).nullable().optional(),
          freeQtyMilli: z.number().int().min(0).nullable().optional(),
          fromDate: isoDate,
          toDate: isoDate.nullable().optional(),
          active: z.boolean().optional()
        }),
        id: z.number().int().positive().optional()
      })
      .parse(p)
    return counter.saveScheme(requireCompany().db, data, id)
  })

  handle('counter:deleteScheme', (p) => {
    counter.deleteScheme(requireCompany().db, idSchema.parse(p).id)
    return null
  })

  // ---------- quotation → order → challan → invoice (roadmap #378) ----------

  const stageSchema = z.enum(['quotation', 'order', 'challan'])
  const docLineSchema = z.object({
    stockItemId: z.number().int().positive().nullable().optional(),
    description: z.string().trim().min(1).max(200),
    qtyMilli: z.number().int().positive(),
    ratePaise: z.number().int().min(0),
    discountPaise: z.number().int().min(0).optional(),
    gstRate: z.number().min(0).max(100).nullable().optional(),
    hsn: z.string().trim().max(12).nullable().optional()
  })

  handle('salesdoc:list', (p) => {
    const { stage, status } = z
      .object({ stage: stageSchema.optional(), status: z.enum(['open', 'converted', 'closed', 'lost']).optional() })
      .parse(p ?? {})
    const c = requireCompany()
    return salesDocs.listDocuments(c.db, c.info, { stage, status })
  }, 'viewer')

  handle('salesdoc:get', (p) => {
    const c = requireCompany()
    return salesDocs.getDocument(c.db, idSchema.parse(p).id, c.info)
  }, 'viewer')

  handle('salesdoc:next', (p) => {
    const { stage } = z.object({ stage: stageSchema }).parse(p)
    return { number: salesDocs.nextNumber(requireCompany().db, stage) }
  }, 'viewer')

  handle('salesdoc:save', (p) => {
    const { data, id } = z
      .object({
        data: z.object({
          stage: stageSchema,
          number: z.string().trim().max(40).optional(),
          date: isoDate,
          partyLedgerId: z.number().int().positive().nullable().optional(),
          partyName: z.string().trim().max(120).nullable().optional(),
          validUntil: isoDate.nullable().optional(),
          reference: z.string().trim().max(120).nullable().optional(),
          narration: z.string().trim().max(1000).nullable().optional(),
          terms: z.string().trim().max(2000).nullable().optional(),
          lines: z.array(docLineSchema).min(1).max(200)
        }),
        id: z.number().int().positive().optional()
      })
      .parse(p)
    const c = requireCompany()
    return salesDocs.saveDocument(c.db, c.info, data, id)
  })

  handle('salesdoc:delete', (p) => {
    const c = requireCompany()
    salesDocs.deleteDocument(c.db, idSchema.parse(p).id, c.info)
    return null
  })

  handle('salesdoc:close', (p) => {
    const { id, status, reason } = z
      .object({
        id: z.number().int().positive(),
        status: z.enum(['closed', 'lost']),
        reason: z.string().trim().max(200).nullable().default(null)
      })
      .parse(p)
    const c = requireCompany()
    return salesDocs.closeDocument(c.db, id, c.info, status, reason)
  })

  handle('salesdoc:convert', (p) => {
    const { id, quantities, date, number } = z
      .object({
        id: z.number().int().positive(),
        quantities: z.array(z.object({ lineId: z.number().int().positive(), qtyMilli: z.number().int().min(0) })).max(200).optional(),
        date: isoDate.optional(),
        number: z.string().trim().max(40).optional()
      })
      .parse(p)
    const c = requireCompany()
    return salesDocs.convert(c.db, id, c.info, { quantities, date, number })
  })

  handle('salesdoc:invoiceDraft', (p) => {
    const c = requireCompany()
    return salesDocs.invoiceDraft(c.db, idSchema.parse(p).id, c.info)
  }, 'viewer')

  handle('salesdoc:markInvoiced', (p) => {
    const { id, voucherId } = z.object({ id: z.number().int().positive(), voucherId: z.number().int().positive() }).parse(p)
    const c = requireCompany()
    return salesDocs.markInvoiced(c.db, id, voucherId, c.info)
  })

  handle('salesdoc:pipeline', () => {
    const c = requireCompany()
    return salesDocs.pipeline(c.db, c.info)
  }, 'viewer')

  // ---------- borrowing: loans, deposits, projects, prepayments, the bank's return ----------

  handle('loans:list', () => borrowing.listLoans(requireCompany().db), 'viewer')

  handle('loans:save', (p) => {
    const { data, id } = z
      .object({
        data: z.object({
          name: z.string().trim().min(1).max(120),
          lender: z.string().trim().max(120).nullable().optional(),
          accountNumber: z.string().trim().max(40).nullable().optional(),
          kind: z.enum(['term', 'vehicle', 'machinery', 'working_capital', 'other']).optional(),
          ledgerId: z.number().int().positive().nullable().optional(),
          interestLedgerId: z.number().int().positive().nullable().optional(),
          principalPaise: z.number().int().positive(),
          annualRateBp: z.number().int().min(0).max(10000),
          months: z.number().int().positive().max(600),
          emiPaise: z.number().int().min(0).nullable().optional(),
          disbursedOn: isoDate,
          firstInstalmentDate: isoDate,
          notes: z.string().trim().max(500).nullable().optional()
        }),
        id: z.number().int().positive().optional()
      })
      .parse(p)
    return borrowing.saveLoan(requireCompany().db, data, id)
  })

  handle('loans:delete', (p) => {
    borrowing.deleteLoan(requireCompany().db, idSchema.parse(p).id)
    return null
  })

  handle('loans:view', (p) => {
    const { id, asOn, fyFrom, fyTo } = z
      .object({
        id: z.number().int().positive(),
        asOn: isoDate.optional(),
        fyFrom: isoDate.optional(),
        fyTo: isoDate.optional()
      })
      .parse(p)
    return borrowing.loanView(requireCompany().db, id, asOn ?? todayISO(), fyFrom, fyTo)
  }, 'viewer')

  handle('loans:instalmentDraft', (p) => {
    const { id, instalmentNo } = z.object({ id: z.number().int().positive(), instalmentNo: z.number().int().positive() }).parse(p)
    const c = requireCompany()
    borrowing.ensureLoanLedgers(c.db)
    return borrowing.instalmentDraft(c.db, id, instalmentNo)
  }, 'viewer')

  handle('loans:postInstalment', (p) => {
    const { id, instalmentNo, voucherId } = z
      .object({
        id: z.number().int().positive(),
        instalmentNo: z.number().int().positive(),
        voucherId: z.number().int().positive().nullable().default(null)
      })
      .parse(p)
    return borrowing.recordInstalment(requireCompany().db, id, instalmentNo, voucherId)
  })

  handle('deposits:list', (p) => {
    const { includeReturned } = z.object({ includeReturned: z.boolean().optional() }).parse(p ?? {})
    return borrowing.listDeposits(requireCompany().db, includeReturned)
  }, 'viewer')

  handle('deposits:summary', (p) => {
    const { asOn } = z.object({ asOn: isoDate.optional() }).parse(p ?? {})
    return borrowing.depositSummary(requireCompany().db, asOn ?? todayISO())
  }, 'viewer')

  handle('deposits:save', (p) => {
    const { data, id } = z
      .object({
        data: z.object({
          direction: z.enum(['paid', 'received']),
          counterparty: z.string().trim().min(1).max(120),
          partyLedgerId: z.number().int().positive().nullable().optional(),
          ledgerId: z.number().int().positive().nullable().optional(),
          purpose: z.string().trim().max(200).nullable().optional(),
          amountPaise: z.number().int().positive(),
          paidOn: isoDate,
          refundableOn: isoDate.nullable().optional(),
          interestRateBp: z.number().int().min(0).max(10000).nullable().optional(),
          notes: z.string().trim().max(500).nullable().optional()
        }),
        id: z.number().int().positive().optional()
      })
      .parse(p)
    return borrowing.saveDeposit(requireCompany().db, data, id)
  })

  handle('deposits:return', (p) => {
    const { id, on, amountPaise } = z
      .object({ id: z.number().int().positive(), on: isoDate, amountPaise: z.number().int().min(0) })
      .parse(p)
    return borrowing.returnDeposit(requireCompany().db, id, on, amountPaise)
  })

  handle('deposits:delete', (p) => {
    borrowing.deleteDeposit(requireCompany().db, idSchema.parse(p).id)
    return null
  })

  handle('cwip:list', (p) => {
    const { includeCapitalised } = z.object({ includeCapitalised: z.boolean().optional() }).parse(p ?? {})
    return borrowing.listProjects(requireCompany().db, includeCapitalised ?? true)
  }, 'viewer')

  handle('cwip:save', (p) => {
    const { data, id } = z
      .object({
        data: z.object({
          name: z.string().trim().min(1).max(120),
          startedOn: isoDate,
          ledgerId: z.number().int().positive().nullable().optional(),
          notes: z.string().trim().max(500).nullable().optional()
        }),
        id: z.number().int().positive().optional()
      })
      .parse(p)
    const c = requireCompany()
    borrowing.ensureCwipLedger(c.db)
    return borrowing.saveProject(c.db, data, id)
  })

  handle('cwip:addCost', (p) => {
    const { projectId, data } = z
      .object({
        projectId: z.number().int().positive(),
        data: z.object({
          date: isoDate,
          description: z.string().trim().min(1).max(200),
          amountPaise: z.number().int().positive(),
          voucherId: z.number().int().positive().nullable().optional(),
          supplier: z.string().trim().max(120).nullable().optional()
        })
      })
      .parse(p)
    return borrowing.addCost(requireCompany().db, projectId, data)
  })

  handle('cwip:removeCost', (p) => {
    borrowing.removeCost(requireCompany().db, idSchema.parse(p).id)
    return null
  })

  handle('cwip:capitaliseDraft', (p) => {
    const { id, on, assetLedgerName } = z
      .object({ id: z.number().int().positive(), on: isoDate, assetLedgerName: z.string().trim().min(1).max(120) })
      .parse(p)
    return borrowing.capitalisationDraft(requireCompany().db, id, on, assetLedgerName)
  }, 'viewer')

  handle('cwip:capitalise', (p) => {
    const { id, on, fixedAssetId, voucherId } = z
      .object({
        id: z.number().int().positive(),
        on: isoDate,
        fixedAssetId: z.number().int().positive().nullable().default(null),
        voucherId: z.number().int().positive().nullable().default(null)
      })
      .parse(p)
    return borrowing.recordCapitalisation(requireCompany().db, id, on, fixedAssetId, voucherId)
  })

  handle('prepaid:list', (p) => {
    const { asOn } = z.object({ asOn: isoDate.optional() }).parse(p ?? {})
    return borrowing.listPrepaid(requireCompany().db, asOn ?? todayISO())
  }, 'viewer')

  handle('prepaid:save', (p) => {
    const { data, id } = z
      .object({
        data: z.object({
          kind: z.enum(['prepaid', 'accrued']),
          name: z.string().trim().min(1).max(120),
          amountPaise: z.number().int().positive(),
          periodFrom: isoDate,
          periodTo: isoDate,
          basis: z.enum(['month', 'day']).optional(),
          expenseLedgerId: z.number().int().positive().nullable().optional(),
          balanceLedgerId: z.number().int().positive().nullable().optional(),
          sourceVoucherId: z.number().int().positive().nullable().optional(),
          notes: z.string().trim().max(500).nullable().optional()
        }),
        id: z.number().int().positive().optional()
      })
      .parse(p)
    const c = requireCompany()
    borrowing.ensurePrepaidLedgers(c.db)
    return borrowing.savePrepaid(c.db, data, id)
  })

  handle('prepaid:delete', (p) => {
    borrowing.deletePrepaid(requireCompany().db, idSchema.parse(p).id)
    return null
  })

  handle('prepaid:draft', (p) => {
    const { id, month } = z.object({ id: z.number().int().positive(), month: z.string().regex(/^\d{4}-\d{2}$/) }).parse(p)
    const c = requireCompany()
    borrowing.ensurePrepaidLedgers(c.db)
    return borrowing.prepaidDraft(c.db, id, month)
  }, 'viewer')

  handle('prepaid:post', (p) => {
    const { id, month, voucherId } = z
      .object({
        id: z.number().int().positive(),
        month: z.string().regex(/^\d{4}-\d{2}$/),
        voucherId: z.number().int().positive().nullable().default(null)
      })
      .parse(p)
    return borrowing.recordPrepaidPosting(requireCompany().db, id, month, voucherId)
  })

  const marginsSchema = z.object({
    stockMarginPercent: z.number().min(0).max(100),
    debtorMarginPercent: z.number().min(0).max(100),
    debtorAgeLimitDays: z.number().int().min(1).max(3650),
    sanctionedLimitPaise: z.number().int().min(0)
  })

  handle('bank:stockStatement', (p) => {
    const { asOn, margins, ccLedgerId } = z
      .object({
        asOn: isoDate,
        margins: marginsSchema.optional(),
        ccLedgerId: z.number().int().positive().nullable().optional()
      })
      .parse(p)
    return borrowing.computeStockStatement(requireCompany().db, asOn, margins ?? DEFAULT_MARGINS, ccLedgerId ?? null)
  }, 'viewer')

  handle('bank:fileStatement', (p) => {
    const { asOn, margins, notes, ccLedgerId } = z
      .object({
        asOn: isoDate,
        margins: marginsSchema,
        notes: z.string().trim().max(500).nullable().default(null),
        ccLedgerId: z.number().int().positive().nullable().optional()
      })
      .parse(p)
    return borrowing.fileStockStatement(requireCompany().db, asOn, margins, notes, ccLedgerId ?? null)
  })

  handle('bank:statements', () => borrowing.listFiledStatements(requireCompany().db), 'viewer')

  handle('bank:unfileStatement', (p) => {
    borrowing.unfileStockStatement(requireCompany().db, idSchema.parse(p).id)
    return null
  })

  // ---------- salesperson commission, on collection (roadmap #380) ----------

  handle('commission:report', (p) => {
    const { from, to } = periodSchema.parse(p)
    return commission.commissionReport(requireCompany().db, from, to)
  }, 'viewer')

  handle('commission:draft', (p) => {
    const { from, to } = periodSchema.parse(p)
    return commission.commissionDraft(requireCompany().db, from, to)
  }, 'viewer')

  handle('commission:schemes', () => commission.listCommissionSchemes(requireCompany().db), 'viewer')

  handle('commission:saveScheme', (p) => {
    const { data, id } = z
      .object({
        data: z.object({
          salesperson: z.string().trim().min(1).max(60),
          rateBp: z.number().int().min(0).max(10000),
          basis: z.enum(['gross', 'net_of_tax']),
          fromDate: isoDate,
          active: z.boolean().optional()
        }),
        id: z.number().int().positive().optional()
      })
      .parse(p)
    return commission.saveCommissionScheme(requireCompany().db, data, id)
  })

  handle('commission:deleteScheme', (p) => {
    commission.deleteCommissionScheme(requireCompany().db, idSchema.parse(p).id)
    return null
  })

  // ---------- dot-matrix, printed raw (roadmap #379) ----------

  handle('print:printers', () => rawPrint.listPrinters(), 'viewer')

  const escpOptionsSchema = z.object({
    width: z.union([z.literal(80), z.literal(132)]).optional(),
    formLines: z.number().int().min(1).max(127).optional(),
    perforationSkip: z.number().int().min(1).max(127).optional(),
    condensed: z.boolean().optional(),
    preprintedHeader: z.boolean().optional(),
    copies: z.array(z.string().trim().max(40)).max(4).optional()
  })

  handle('print:escpPreview', (p) => {
    const { voucherId, options } = z
      .object({ voucherId: z.number().int().positive(), options: escpOptionsSchema.optional() })
      .parse(p)
    const c = requireCompany()
    const { bytes, number } = rawPrint.invoiceEscp(c.db, c.info, voucherId, options ?? {})
    // The preview is the byte stream as characters, escape codes shown in angle brackets: the
    // only honest preview of a job whose whole point is that it is not a rendered page.
    return { number, bytes: bytes.length, text: escpDebug(bytes) }
  }, 'viewer')

  handle('print:escp', async (p) => {
    const { voucherId, printer, options } = z
      .object({
        voucherId: z.number().int().positive(),
        printer: z.string().trim().min(1).max(120),
        options: escpOptionsSchema.optional()
      })
      .parse(p)
    const c = requireCompany()
    const { bytes, number } = rawPrint.invoiceEscp(c.db, c.info, voucherId, options ?? {})
    const result = await rawPrint.printRaw(bytes, printer)
    return { ...result, number }
  }, 'viewer')

  handle('print:escpSave', async (p) => {
    const { voucherId, options } = z
      .object({ voucherId: z.number().int().positive(), options: escpOptionsSchema.optional() })
      .parse(p)
    const c = requireCompany()
    const { bytes, number } = rawPrint.invoiceEscp(c.db, c.info, voucherId, options ?? {})
    const path = join(companyExportsDir(c.slug), `invoice-${slugify(number)}.escp`)
    return { ...rawPrint.saveRaw(bytes, path), number }
  }, 'viewer')

  // ---------- disclosure: related parties, the audit trail, LUT, the IRP window ----------

  handle('disclosure:relatedParties', (p) => {
    const { from, to } = periodSchema.parse(p)
    return disclosure.relatedPartyReport(requireCompany().db, from, to)
  }, 'viewer')

  handle('disclosure:auditStatement', (p) => {
    const { from, to } = periodSchema.parse(p)
    const c = requireCompany()
    return disclosure.auditTrailStatement(c.db, from, to, configSvc.getAuditKeepDays(c.db))
  }, 'viewer')

  handle('disclosure:luts', () => disclosure.listLuts(requireCompany().db), 'viewer')

  handle('disclosure:lutStatus', () => disclosure.currentLut(requireCompany().db, todayISO()), 'viewer')

  handle('disclosure:saveLut', (p) => {
    const input = z
      .object({
        arn: z.string().trim().min(1).max(30),
        fyStartYear: z.number().int().min(2017).max(2200),
        filedOn: isoDate
      })
      .parse(p)
    return disclosure.saveLut(requireCompany().db, input)
  })

  handle('disclosure:deleteLut', (p) => {
    const { fyStartYear } = z.object({ fyStartYear: z.number().int().min(2017).max(2200) }).parse(p)
    return disclosure.deleteLut(requireCompany().db, fyStartYear)
  })

  handle('disclosure:eInvoiceWindow', (p) => {
    const { from, to } = periodSchema.parse(p)
    const c = requireCompany()
    return disclosure.eInvoiceBacklog(c.db, from, to, todayISO(), c.info.turnoverBand)
  }, 'viewer')

  handle('recv:msme', (p) => {
    const { asOn } = z.object({ asOn: isoDate }).parse(p)
    return receivables.msmeExposure(requireCompany().db, asOn)
  }, 'viewer')

  handle('recv:creditCheck', (p) => {
    const { ledgerId, addPaise } = z
      .object({ ledgerId: z.number().int().positive(), addPaise: z.number().int().default(0) })
      .parse(p)
    return receivables.creditStatus(requireCompany().db, ledgerId, addPaise)
  }, 'viewer')

  handle('recv:policy', () => configSvc.getCollectionsPolicy(requireCompany().db), 'viewer')

  handle('recv:setPolicy', (p) => {
    const input = z
      .object({
        interestRateBp: z.number().int().min(0).max(6000),
        interestGraceDays: z.number().int().min(0).max(365),
        bandCuts: z.array(z.number().int().positive()).min(1).max(6),
        provisionPolicy: z
          .array(z.object({ afterDays: z.number().int().positive(), pct: z.number().int().min(0).max(100) }))
          .min(1)
          .max(6),
        reminderMinOverdueDays: z.number().int().min(0).max(365),
        contact: z.string().trim().max(120).nullable(),
        /** RBI bank rate for section 16 MSMED interest — three times it, compounded monthly. */
        msmeBankRatePercent: z.number().min(0).max(30)
      })
      .parse(p)
    return configSvc.setCollectionsPolicy(requireCompany().db, input)
  }, 'owner')

  handle('analysis:khata', (p) => {
    const { side, asOn } = z
      .object({ side: z.enum(['receivable', 'payable']), asOn: isoDate })
      .parse(p)
    return analysis.khata(requireCompany().db, side, asOn)
  }, 'viewer')

  handle('analysis:partyShares', (p) => {
    const { kind, from, to } = periodSchema
      .extend({ kind: z.enum(['sales', 'purchase']) })
      .parse(p)
    return analysis.partyShares(requireCompany().db, kind, from, to)
  }, 'viewer')

  handle('analysis:register', (p) => {
    const { kind, from, to, groupBy } = periodSchema
      .extend({ kind: z.enum(['sales', 'purchase']), groupBy: z.enum(PERIODS).optional() })
      .parse(p)
    return analysis.registerByPeriod(requireCompany().db, kind, from, to, groupBy)
  }, 'viewer')
  handle('analysis:outstandings', (p) => {
    const { side, asOn, includeBills } = z
      .object({
        side: z.enum(['receivable', 'payable']),
        asOn: z.string(),
        // The screen asks for a summary and fetches a party's bills on expand; exports ask for
        // everything. At 30k vouchers that is the difference between ~4 MB and a few KB.
        includeBills: z.boolean().default(true)
      })
      .parse(p)
    return analysis.outstandings(requireCompany().db, side, asOn, { includeBills })
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
  // Named voucher templates (#27) — a shape with no schedule; nothing here ever posts.
  handle('vtemplate:list', (p) => {
    const { voucherTypeId } = z.object({ voucherTypeId: z.number().int().positive().optional() }).parse(p ?? {})
    return voucherTemplates.listTemplates(requireCompany().db, voucherTypeId)
  }, 'viewer')
  handle('vtemplate:save', (p) => {
    const { id, data } = z
      .object({
        id: z.number().int().positive().optional(),
        data: z.object({
          name: z.string().trim().min(1).max(80),
          voucherTypeId: z.number().int().positive(),
          voucherJson: z.string().min(2).max(200_000)
        })
      })
      .parse(p)
    return voucherTemplates.saveTemplate(requireCompany().db, data, id)
  })
  handle('vtemplate:delete', (p) => voucherTemplates.deleteTemplate(requireCompany().db, idSchema.parse(p).id))
  handle('vtemplate:use', (p) => {
    const { id, date } = z
      .object({ id: z.number().int().positive(), date: isoDate.optional() })
      .parse(p)
    return voucherTemplates.useTemplate(requireCompany().db, id, date)
  })
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
  // ---------- statement import profiles (#131) ----------
  // Column maps live in one schema shared by the profile CRUD, the inspector and the importer, so
  // the mapping a user previews is byte-for-byte the one that reads their file.
  const profileColumnsSchema = z.object({
    date: z.string().trim().max(120),
    narration: z.string().trim().max(120),
    reference: z.string().trim().max(120).nullable().optional(),
    debit: z.string().trim().max(120).nullable().optional(),
    credit: z.string().trim().max(120).nullable().optional(),
    amount: z.string().trim().max(120).nullable().optional(),
    drCr: z.string().trim().max(120).nullable().optional(),
    balance: z.string().trim().max(120).nullable().optional()
  })
  const adHocProfileSchema = z.object({
    name: z.string().trim().min(1).max(60).optional(),
    dateFormat: z.enum(['dmy', 'mdy', 'ymd']),
    convention: z.enum(['debit_credit', 'signed', 'flagged']),
    debitFlag: z.string().trim().max(10).nullable(),
    columns: profileColumnsSchema
  })
  const profileChoiceSchema = z.object({
    profileId: z.string().trim().max(60).nullable().optional(),
    adHoc: adHocProfileSchema.nullable().optional()
  })

  handle('bankprofile:list', () => banking.listImportProfiles(requireCompany().db), 'viewer')
  handle('bankprofile:save', (p) => {
    const { id, data } = z
      .object({ id: z.number().int().positive().optional(), data: adHocProfileSchema.extend({ name: z.string().trim().min(1).max(60) }) })
      .parse(p)
    return banking.saveImportProfile(requireCompany().db, data, id)
  })
  handle('bankprofile:delete', (p) => {
    banking.deleteImportProfile(requireCompany().db, idSchema.parse(p).id)
    return null
  })

  /** Read a statement CSV from disk when the renderer didn't supply the text itself. */
  const pickStatementCsv = async (csvText: string | undefined): Promise<string | null> => {
    if (csvText !== undefined) return csvText
    const picked = await dialog.showOpenDialog({
      title: 'Choose bank statement CSV',
      filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }],
      properties: ['openFile']
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    return readFileSync(picked.filePaths[0], 'utf8')
  }

  // Look before you import: which profile fits, what it would read, what it would skip. Returns
  // csvText so the renderer can carry the same bytes through mapping → preview → apply.
  handle('bank:inspectStatement', async (p) => {
    const { csvText, profileId, adHoc } = profileChoiceSchema
      .extend({ csvText: z.string().optional() })
      .parse(p)
    const c = requireCompany()
    const csv = await pickStatementCsv(csvText)
    if (csv === null) return null
    return { ...banking.inspectStatement(c.db, csv, { profileId, adHoc }), csvText: csv }
  }, 'viewer')

  handle('bank:importCsv', async (p) => {
    const { ledgerId, csvText, dryRun, profileId, adHoc } = profileChoiceSchema
      .extend({
        ledgerId: z.number().int().positive(),
        csvText: z.string().optional(),
        dryRun: z.boolean().optional()
      })
      .parse(p)
    const c = requireCompany()
    const csv = await pickStatementCsv(csvText)
    if (csv === null) return null
    const profile = banking.resolveProfile(c.db, { profileId, adHoc })
    // csvText rides back on the response (not just the parsed result) so the renderer — which
    // never sees the picked file's contents when the dialog path is used — can hand the exact
    // same text to banking:suggest (or back to an applying import after a dryRun preview).
    return { ...banking.importStatement(c.db, ledgerId, csv, { apply: !dryRun, profile }), csvText: csv }
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
    const { ledgerId, csvText, profileId, adHoc } = profileChoiceSchema
      .extend({ ledgerId: z.number().int().positive(), csvText: z.string() })
      .parse(p)
    const c = requireCompany()
    return banking.suggestVouchers(c.db, ledgerId, csvText, banking.resolveProfile(c.db, { profileId, adHoc }))
  })

  // ---------- narration memory (#133) + bulk accept (#134) ----------
  const learnSchema = z.object({
    description: z.string().trim().min(1).max(500),
    ledgerId: z.number().int().positive(),
    kind: z.enum(['payment', 'receipt'])
  })
  handle('banking:learn', (p) => {
    const { description, ledgerId, kind } = learnSchema.parse(p)
    return { keywords: banking.learnFromMatch(requireCompany().db, description, ledgerId, kind) }
  })
  handle('banking:memory', () => banking.listNarrationMemory(requireCompany().db), 'viewer')
  handle('banking:forget', (p) => {
    const { keyword, ledgerId, kind } = learnSchema
      .omit({ description: true })
      .extend({ keyword: z.string().trim().min(1).max(60) })
      .parse(p)
    banking.forgetNarration(requireCompany().db, keyword, ledgerId, kind)
    return null
  })
  handle('banking:bulkAccept', (p) => {
    const { ledgerId, csvText, minConfidence, apply, profileId, adHoc } = profileChoiceSchema
      .extend({
        ledgerId: z.number().int().positive(),
        csvText: z.string(),
        // A threshold below 50 would accept single-observation guesses, which is the one thing
        // the confidence model exists to prevent.
        minConfidence: z.number().int().min(50).max(100),
        apply: z.boolean().optional()
      })
      .parse(p)
    const c = requireCompany()
    return banking.bulkAcceptSuggestions(c.db, ledgerId, csvText, minConfidence, {
      apply,
      profile: banking.resolveProfile(c.db, { profileId, adHoc })
    })
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
  // the bank's own charges and interest (#135) — 'bank:' prefix, so it inherits the `banking`
  // capability in permissions.ts (the 'banking:' prefix does not, see PREFIX_CAPABILITIES).
  handle('bank:charges:list', () => banking.chargeLedgers(requireCompany().db), 'viewer')
  handle('bank:charges:setup', () => banking.setupChargeLedgers(requireCompany().db))

  // reconciliation freeze (#142)
  handle('bank:reconLock:list', () => banking.listReconLocks(requireCompany().db), 'viewer')
  handle('bank:reconLock:set', (p) => {
    const { ledgerId, date } = z
      .object({ ledgerId: z.number().int().positive(), date: isoDate.nullable() })
      .parse(p)
    banking.setReconLock(requireCompany().db, ledgerId, date)
    return null
  })

  // bounced cheques (#138)
  handle('bank:bounce:list', (p) => {
    const { from, to } = z.object({ from: isoDate.optional(), to: isoDate.optional() }).parse(p ?? {})
    return chequeBounce.listBounces(requireCompany().db, from, to)
  }, 'viewer')
  handle('bank:bounce:byParty', () => chequeBounce.bounceCountByParty(requireCompany().db), 'viewer')
  handle('bank:bounce:create', (p) => {
    const input = z
      .object({
        voucherId: z.number().int().positive(),
        bounceDate: isoDate,
        reason: z.string().trim().max(120).nullable().optional(),
        chargeAmount: z.number().int().min(0).optional(),
        chargeLedgerId: z.number().int().positive().nullable().optional(),
        bankLedgerId: z.number().int().positive().nullable().optional()
      })
      .parse(p)
    return chequeBounce.bounceCheque(requireCompany().db, input)
  })
  handle('bank:bounce:remove', (p) => {
    const { id } = z.object({ id: z.number().int().positive() }).parse(p)
    chequeBounce.unbounce(requireCompany().db, id)
    return null
  })

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
    const path = await writeExportPdf(c.slug, `brs-${slugify(r.ledgerName)}-${asOn}.pdf`, html, {
      pageSize: 'A4',
      pageNumbers: true,
      runningHead: {
        company: c.info.name,
        gstin: c.info.gstin,
        title: 'Bank Reconciliation Statement',
        periodLabel: `${r.ledgerName} · as on ${asOn}`
      }
    })
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
  handle('edoc:previewJson', (p) => {
    const { kind, from, to, voucherId, includeBelowThreshold } = z
      .object({
        kind: z.enum(['einvoice', 'ewb']),
        from: isoDate,
        to: isoDate,
        voucherId: z.number().int().positive().optional(),
        includeBelowThreshold: z.boolean().optional()
      })
      .parse(p)
    const c = requireCompany()
    return edocs.previewJson(c.db, c.info, kind, from, to, { voucherId, includeBelowThreshold })
  }, 'viewer')

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
  handle('bom:detail', (p) => extras.getBomDetail(requireCompany().db, z.object({ itemId: z.number().int().positive() }).parse(p).itemId), 'viewer')
  handle('bom:set', (p) => extras.setBom(requireCompany().db, bomInputSchema.parse(p)))
  handle('bom:items', () => extras.itemsWithBom(requireCompany().db), 'viewer')
  handle(
    'bom:explode',
    (p) => {
      const { itemId, qtyMilli } = z
        .object({ itemId: z.number().int().positive(), qtyMilli: z.number().int().min(0) })
        .parse(p)
      return extras.explodeBomRequirement(requireCompany().db, itemId, qtyMilli)
    },
    'viewer'
  )

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
  // ---------- attendance, advances, settlement (roadmap #168, #169, #170, #172, #178) ----------

  handle('payroll:attendance', (p) => {
    const { month } = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }).parse(p)
    return attendance.attendanceForMonth(requireCompany().db, month)
  }, 'viewer')

  handle('payroll:saveAttendance', (p) => {
    const input = z
      .object({
        employeeId: z.number().int().positive(),
        month: z.string().regex(/^\d{4}-\d{2}$/),
        presentDays: z.number().min(0).max(31),
        paidLeaveDays: z.number().min(0).max(31),
        lopDays: z.number().min(0).max(31),
        note: z.string().trim().max(200).nullable().optional()
      })
      .parse(p)
    return attendance.saveAttendance(requireCompany().db, input)
  })

  handle('payroll:loans', (p) => {
    const { employeeId, openOnly } = z
      .object({ employeeId: z.number().int().positive().optional(), openOnly: z.boolean().optional() })
      .parse(p ?? {})
    return attendance.listLoans(requireCompany().db, { employeeId, openOnly })
  }, 'viewer')

  handle('payroll:createLoan', (p) => {
    const input = z
      .object({
        employeeId: z.number().int().positive(),
        grantedOn: isoDate,
        principal: z.number().int().positive(),
        instalment: z.number().int().positive(),
        note: z.string().trim().max(200).nullable().optional()
      })
      .parse(p)
    return attendance.createLoan(requireCompany().db, input)
  })

  handle('payroll:closeLoan', (p) => {
    const { id } = idSchema.parse(p)
    return attendance.closeLoan(requireCompany().db, id, todayISO())
  })

  handle('payroll:dueRecoveries', (p) => {
    const { month } = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }).parse(p)
    return attendance.dueRecoveries(requireCompany().db, month)
  }, 'viewer')

  handle('payroll:tds', (p) => {
    const { month } = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }).parse(p)
    return [...payroll.tdsForMonth(requireCompany().db, month).values()]
  }, 'viewer')

  handle('payroll:form16', (p) => {
    const { employeeId, fyStartYear } = z
      .object({ employeeId: z.number().int().positive(), fyStartYear: z.number().int().min(2000).max(2100) })
      .parse(p)
    return payroll.form16(requireCompany().db, employeeId, fyStartYear)
  }, 'viewer')

  handle('payroll:form16Pdf', async (p) => {
    const { employeeId, fyStartYear } = z
      .object({ employeeId: z.number().int().positive(), fyStartYear: z.number().int().min(2000).max(2100) })
      .parse(p)
    const c = requireCompany()
    const path = await payroll.form16Pdf(c.db, c.info, c.slug, employeeId, fyStartYear)
    shell.openPath(path)
    return { path }
  }, 'viewer')

  handle('payroll:payslips', async (p) => {
    const { runId } = payrollRunIdSchema.parse(p)
    const c = requireCompany()
    return payroll.payslipsForRun(c.db, c.info, c.slug, runId)
  }, 'viewer')

  handle('payroll:ecrCheck', (p) => payroll.ecrCheck(requireCompany().db, payrollRunIdSchema.parse(p).runId), 'viewer')

  handle('payroll:settlement', (p) => {
    const input = z
      .object({
        employeeId: z.number().int().positive(),
        lastDay: isoDate,
        leaveBalanceDays: z.number().min(0).max(365),
        noticeShortfallDays: z.number().min(0).max(365).optional(),
        finalMonthDays: z.number().min(0).max(31).optional(),
        payBonus: z.boolean().optional(),
        bonusPercent: z.number().min(0).max(20).optional(),
        waiveGratuityMinimum: z.boolean().optional()
      })
      .parse(p)
    return payroll.settlement(requireCompany().db, input)
  }, 'viewer')

  handle('payroll:rates', (p) => {
    const { month } = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }).parse(p)
    return { rates: ratesForMonth(month), history: STATUTORY_HISTORY }
  }, 'viewer')

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
    // It now carries the diff as well: what is in the file is the wrong question, and what this
    // would do to THESE books is the right one (roadmap O #296).
    if (dryRun) {
      return { filePath: resolvedPath ?? null, summary: dryRunTallyXml(xml), diff: diffTallyXml(c.db, xml) }
    }
    await backupCompany(c.db, c.slug, 'pre-tally-import')
    // Progress + cancel (roadmap O #300). The streaming import yields between chunks, which is
    // the only reason the tally:cancel click below can be serviced at all — main is
    // single-threaded, and the old synchronous loop could never have seen it.
    importCancelled = false
    const wc = BrowserWindow.getAllWindows()[0]?.webContents
    const summary = await importTallyXmlStreaming(c.db, xml, {
      onProgress: (progress) => wc?.send('total:import:progress', progress),
      isCancelled: () => importCancelled
    })
    importCancelled = false
    return { filePath: resolvedPath ?? null, summary }
  })

  /**
   * The migration report a CA signs (roadmap O #298).
   *
   * Written as a PDF into the company's exports folder. Every figure on it is read back out of
   * the books and the audit trail here in main — nothing the screen was holding is trusted,
   * because a report whose numbers the caller supplies proves nothing to the person signing it.
   */
  handle('tally:migrationReport', async (p) => {
    const { asOn } = z.object({ asOn: isoDate.optional() }).parse(p ?? {})
    const c = requireCompany()
    const date = asOn ?? todayISO()
    const body = migrationReportBody(c.db, date)
    const html = reportHtml({
      title: 'Migration report',
      company: c.info,
      periodLabel: `as on ${date}`,
      columns: [
        { label: 'Stage', align: 'l' },
        { label: 'What', align: 'l' },
        { label: 'Figure', align: 'r' }
      ],
      rows: body.rows,
      footNote: body.footNote
    })
    const path = await writeExportPdf(c.slug, 'migration-report.pdf', html)
    auditExport(c.db, 'migrationReport', { asOn: date, outOfBalance: body.outOfBalance })
    shell.showItemInFolder(path)
    return { path, outOfBalance: body.outOfBalance }
  }, 'viewer')

  /** Ask the running import to stop. It rolls back: everything or nothing is the only honest
   *  answer to "stop" halfway through somebody's books. */
  handle('tally:cancel', () => {
    importCancelled = true
    return { cancelling: true }
  })

  // ---------- report print/export (task 3.6) ----------
  handle('report:pdf', async (p) => {
    const { title, periodLabel, columns, rows, footNote, filename, landscape } = reportPdfSchema.parse(p)
    const c = requireCompany()
    const html = reportHtml({ title, company: c.info, periodLabel, columns, rows, footNote })
    // A running head and foot on every page: page four of a printed ledger is exactly the page
    // that gets photocopied or emailed on its own, and it used to identify neither the company
    // nor the period it covered.
    const path = await writeExportPdf(c.slug, `${filename}.pdf`, html, {
      pageSize: 'A4',
      landscape,
      pageNumbers: true,
      runningHead: { company: c.info.name, gstin: c.info.gstin, title, periodLabel }
    })
    auditExport(c.db, 'report_pdf', { filename, path })
    return { path }
  }, 'viewer')
  /**
   * The books in a format that is not this app's (roadmap #254).
   *
   * Written into the company's exports folder as plain JSON, documented in docs/export-format.md,
   * and guaranteed to round-trip: `export:portable` then `import:portable` into an empty company
   * gives back an identical document (proved in portable.dbtest.ts, not asserted here).
   */
  handle('export:portable', () => {
    const c = requireCompany()
    const doc = exportPortable(c.db)
    const path = join(companyExportsDir(c.slug), `total-books-${c.slug}-${backupStamp()}.json`)
    writeFileSync(path, JSON.stringify(doc, null, 2), 'utf8')
    auditExport(c.db, 'portable', { path, vouchers: doc.vouchers.length })
    shell.showItemInFolder(path)
    return { path, vouchers: doc.vouchers.length, ledgers: doc.ledgers.length }
  }, 'viewer')

  /**
   * Read one back into a NEW company. Never into the open one: merging two sets of books is a
   * different and much harder job than restoring one, and doing it silently would duplicate every
   * entry that happens to differ by a character.
   *
   * `json` inline is how drivers and tests reach this without a native dialog, exactly as
   * tally:import does.
   */
  handle('import:portable', async (p) => {
    const { json, allowDuplicate } = z
      .object({ json: z.string().max(200_000_000).optional(), allowDuplicate: z.boolean().default(false) })
      .parse(p ?? {})

    let text = json
    if (!text) {
      const picked = await dialog.showOpenDialog({
        title: 'Choose a Total books export',
        filters: [{ name: 'Total books', extensions: ['json'] }],
        properties: ['openFile']
      })
      if (picked.canceled || !picked.filePaths[0]) return null
      text = readFileSync(picked.filePaths[0], 'utf8')
    }

    let doc: { company?: { name?: string; gstin?: string | null }; format?: string }
    try {
      doc = JSON.parse(text) as typeof doc
    } catch {
      throw new Error('That file is not readable as JSON')
    }
    if (doc.format !== PORTABLE_FORMAT) throw new Error('That file is not a Total books export.')
    const name = doc.company?.name
    if (!name) throw new Error('That file does not say which company it is.')

    // Making a second, separate set of somebody's own books is the most dangerous silent success
    // in the app (roadmap #251) — so it is never silent.
    const duplicates = findDuplicateCompanies(readRegistry().companies, { name, gstin: doc.company?.gstin ?? null })
    if (duplicates.length > 0 && !allowDuplicate) {
      return { needsConfirmation: true, duplicates, warning: duplicateWarning(duplicates) }
    }

    let slug = slugify(name)
    let n = 2
    while (existsSync(companyDbPath(slug))) slug = `${slugify(name)}-${n++}`
    ensureCompanyTree(slug)
    const db = openCompanyDb(slug)
    try {
      const parsed = JSON.parse(text) as Parameters<typeof importPortable>[1]
      const company = (parsed as { company: Partial<CompanyInfo> }).company
      // The open format carries what identifies a company and deliberately not its GST filing
      // preferences (see docs/export-format.md) — those are settings, not books. Defaults here,
      // and the importer sets them afterwards if they matter.
      const info: CompanyInfo = companyCreateSchema.parse({
        name,
        stateCode: company.stateCode ?? '27',
        gstin: doc.company?.gstin ?? null,
        gstRegistrationType: doc.company?.gstin ? 'regular' : 'unregistered',
        gstFilingFrequency: 'monthly',
        address: company.address ?? '',
        booksFrom: company.booksFrom ?? new Date().getFullYear(),
        email: null,
        phone: null,
        pan: company.pan ?? null,
        tan: null
      })
      seedCompany(db, info)
      const result = importPortable(db, parsed)
      upsertCompany({ slug, name, stateCode: info.stateCode, gstin: info.gstin, lastOpenedAt: null })
      return { needsConfirmation: false, slug, name, ...result }
    } catch (err) {
      // A half-imported company is worse than none: it looks like books and is not.
      db.close()
      rmSync(companyDir(slug), { recursive: true, force: true })
      throw err
    } finally {
      if (db.open) db.close()
    }
  })

  handle('export:csv', (p) => {
    const { filename, csv } = exportCsvSchema.parse(p)
    const c = requireCompany()
    const path = join(companyExportsDir(c.slug), `${filename}.csv`)
    writeFileSync(path, csv, 'utf8')
    auditExport(c.db, 'csv', { filename, path })
    return { path }
  }, 'viewer')

  /**
   * Spreadsheet export.
   *
   * The renderer sends TYPED cells — money as integer paise, dates as ISO — and the workbook is
   * built here, so an amount reaches Excel as a number it can sum rather than as the string
   * "₹1,234.56". That is the whole reason this channel exists beside export:csv.
   *
   * Written as .xls (SpreadsheetML) rather than .xlsx: see src/shared/spreadsheet.ts for why the
   * honest single-file format beat adding a ZIP dependency to an offline app.
   */
  handle('export:xls', (p) => {
    const { filename, sheets } = exportXlsSchema.parse(p)
    const c = requireCompany()
    const xml = buildSpreadsheet(
      sheets.map((sheet) => ({
        name: sheet.name,
        header: sheet.columns.map((col) => col.label),
        rows: sheet.rows.map((row) => ({
          bold: row.bold,
          cells: row.cells.map((value, i) => {
            const kind = sheet.columns[i]?.kind ?? 'text'
            if (value === null) return xlsText('')
            if (kind === 'money') return typeof value === 'number' ? xlsMoney(value) : xlsText(String(value))
            if (kind === 'number') return typeof value === 'number' ? xlsNum(value) : xlsText(String(value))
            if (kind === 'date') return typeof value === 'string' ? xlsDate(value) : xlsText(String(value))
            return xlsText(String(value))
          })
        }))
      }))
    )
    const path = join(companyExportsDir(c.slug), `${filename}.xls`)
    writeFileSync(path, xml, 'utf8')
    auditExport(c.db, 'xls', { filename, path })
    return { path }
  }, 'viewer')

  // ---------- CA export pack + Tally XML export ----------
  handle('export:caPack', async (p) => {
    const { from, to } = periodSchema.parse(p)
    const c = requireCompany()
    const r = caPack.exportCaPack(c.db, c.info, c.slug, from, to)
    // The CSVs are for a machine; the PDF and the workbook are for the accountant who opens the
    // folder. All three, because the pack is handed to a person who then feeds it to a tool.
    const pdf = await caPack.exportCaPackPdf(c.db, c.info, c.slug, from, to)
    const workbook = caPack.exportCaPackWorkbook(c.db, c.info, c.slug, from, to)
    auditExport(c.db, 'ca_pack', { from, to, path: r.path, pdf: pdf.path, workbook: workbook.path })
    shell.showItemInFolder(r.path)
    return { ...r, pdfPath: pdf.path, workbookPath: workbook.path }
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
  /**
   * Has anybody edited the log? (roadmap #265)
   *
   * Deliberately not cached and not run on a timer: this is the answer to a question somebody is
   * asking right now, and an answer that might be an hour old is not one.
   */
  handle('audit:verifyChain', () => verifyAuditChain(requireCompany().db), 'viewer')

  handle('audit:list', (p) => {
    const { entity, entityId, from, to, page, pageSize } = auditListSchema.parse(p)
    return listAudit(requireCompany().db, { entity, entityId, from, to, page, pageSize })
  }, 'viewer')

  /**
   * The daily digest (roadmap V #390): what changed on a given day, for the owner who was not
   * there. Defaults to yesterday, which is the question actually being asked — "what happened
   * while I was out" — rather than to today, which is still happening.
   */
  handle('audit:digest', (p) => {
    const { date } = z.object({ date: isoDate.optional() }).parse(p ?? {})
    const day = date ?? addDays(todayISO(), -1)
    return dailyDigest(requireCompany().db, day)
  }, 'viewer')

  // ---------- attachments: the scan of the bill (roadmap V #387) ----------
  handle('voucher:attachments:list', (p) => {
    const { id } = idSchema.parse(p)
    const c = requireCompany()
    return attachments.listAttachments(c.db, c.slug, id)
  }, 'viewer')

  /**
   * Attach a file to a voucher.
   *
   * Three ways in, one code path: a path the file dialog just issued, an inline base64 blob (how
   * a driver or a test attaches without native chrome — same trick as tally:import's xmlText),
   * or no payload at all, which opens the picker. As with the Tally import, a bare `filePath`
   * from the renderer is refused unless the dialog issued it this session: otherwise the
   * renderer could name any file on disk and have it copied into the company folder.
   */
  handle('voucher:attachments:add', async (p) => {
    const { voucherId, filePath, fileName, bytesBase64, note } = attachmentAddSchema.parse(p)
    const c = requireCompany()
    let sourcePath = filePath
    let name = fileName
    if (!bytesBase64 && !sourcePath) {
      const picked = await dialog.showOpenDialog({
        title: 'Choose the bill to attach',
        filters: [{ name: 'Bill or scan', extensions: [...ATTACHMENT_EXTENSIONS] }],
        properties: ['openFile']
      })
      if (picked.canceled || !picked.filePaths[0]) return null
      sourcePath = picked.filePaths[0]
      dialogIssuedAttachmentPaths.add(sourcePath)
      name = basename(sourcePath)
    } else if (sourcePath && !dialogIssuedAttachmentPaths.has(sourcePath)) {
      throw new Error('File path must come from the file picker')
    }
    return attachments.addAttachment(c.db, c.slug, {
      voucherId,
      sourcePath,
      bytes: bytesBase64 ? Buffer.from(bytesBase64, 'base64') : undefined,
      fileName: name ?? (sourcePath ? basename(sourcePath) : 'attachment'),
      note
    })
  })

  handle('voucher:attachments:remove', (p) => {
    const { id } = idSchema.parse(p)
    const c = requireCompany()
    attachments.removeAttachment(c.db, c.slug, id)
    return { removed: true }
  })

  // Opening is a read, so a viewer (and an auditor) can see the bill without being able to
  // change anything about it.
  handle('voucher:attachments:open', async (p) => {
    const { id } = idSchema.parse(p)
    const c = requireCompany()
    const row = attachments.getAttachment(c.db, c.slug, id)
    if (!row) throw new Error('Attachment not found')
    if (row.missing) throw new Error(`"${row.fileName}" is no longer in the company folder`)
    const error = await shell.openPath(attachments.attachmentPath(c.slug, row.storedName))
    if (error) throw new Error(error)
    return { opened: true }
  }, 'viewer')

  handle('voucher:attachments:reveal', (p) => {
    const { id } = idSchema.parse(p)
    const c = requireCompany()
    const row = attachments.getAttachment(c.db, c.slug, id)
    if (!row) throw new Error('Attachment not found')
    shell.showItemInFolder(attachments.attachmentPath(c.slug, row.storedName))
    return { revealed: true }
  }, 'viewer')

  /** What the copies are costing, so "copy the file in" stays a decision the user can see. */
  handle('voucher:attachments:footprint', () => attachments.attachmentsFootprint(requireCompany().db), 'viewer')

  // ---------- approvals (roadmap V #386) ----------
  handle('approvals:list', () => {
    const c = requireCompany()
    return {
      threshold: configSvc.getApprovalThreshold(c.db),
      pending: approvals.listPending(c.db),
      decided: approvals.listDecided(c.db)
    }
  }, 'viewer')

  handle('approvals:decide', (p) => {
    const { voucherId, approve, note } = z
      .object({ voucherId: z.number().int().positive(), approve: z.boolean(), note: z.string().trim().max(500).nullable().optional() })
      .parse(p)
    const c = requireCompany()
    return approvals.decide(c.db, { voucherId, approve, note }, {
      role: sessionUser?.role ?? null,
      name: sessionUser?.name ?? null
    })
  }, 'owner')

  handle('config:approvalThreshold:get', () => ({ threshold: configSvc.getApprovalThreshold(requireCompany().db) }), 'viewer')
  handle('config:approvalThreshold:set', (p) => {
    // `null` is off; `0` is "everything waits". Both are real answers, so the schema keeps them
    // apart rather than coercing (see src/shared/approvals.ts).
    const { threshold } = z.object({ threshold: z.number().int().min(0).nullable() }).parse(p)
    return { threshold: configSvc.setApprovalThreshold(requireCompany().db, threshold) }
  }, 'owner')

  // ---------- the two-person rule on bank details (roadmap V #388) ----------
  handle('bankChange:list', () => {
    const c = requireCompany()
    return { pending: bankChanges.listPendingBankChanges(c.db), decided: bankChanges.listDecidedBankChanges(c.db) }
  }, 'viewer')

  handle('bankChange:decide', (p) => {
    const { id, approve, note } = z
      .object({ id: z.number().int().positive(), approve: z.boolean(), note: z.string().trim().max(500).nullable().optional() })
      .parse(p)
    const c = requireCompany()
    return bankChanges.decideBankChange(c.db, id, approve, {
      role: sessionUser?.role ?? null,
      name: sessionUser?.name ?? null
    }, note)
  })

  // ---------- auditor mode (roadmap V #391) ----------
  /**
   * Hand the books to an auditor for a stated number of hours.
   *
   * What happens instead today is that the auditor is given the owner's PIN, which is never
   * withdrawn and makes the audit trail unable to tell the two people apart. This session is a
   * viewer (so every write channel already refuses it), it is stamped as 'Auditor' on everything
   * it touches, and it ends by itself.
   *
   * Only the owner can open one, and doing so signs the owner OUT — the point is to hand the
   * machine over, and leaving the owner's own session live underneath would defeat it.
   */
  handle('auditor:begin', (p) => {
    const { hours } = z.object({ hours: z.number().int().refine((h) => (AUDITOR_DURATIONS_HOURS as readonly number[]).includes(h), 'Not an offered duration') }).parse(p)
    const c = requireCompany()
    const now = Date.now()
    auditorSession = {
      startedAt: new Date(now).toISOString(),
      expiresAt: auditorExpiry(now, hours),
      grantedBy: sessionUser?.name ?? null
    }
    writeAudit(c.db, 'user', 0, 'login', null, { auditorSessionUntil: auditorSession.expiresAt, grantedBy: auditorSession.grantedBy })
    // An auditor is a viewer with nothing additionally denied: the read-only role is the whole
    // restriction, and a per-user denial list would be a second, quieter one that nobody set.
    sessionUser = { id: 0, name: AUDITOR_SESSION_NAME, role: 'viewer', denied: [] }
    return auditorStatus()
  }, 'owner')

  handle('auditor:end', () => {
    if (current && auditorSession) writeAudit(current.db, 'user', 0, 'logout', null, { auditorSession: 'ended' })
    endAuditorSession()
    return auditorStatus()
  }, 'viewer')

  handle('auditor:status', () => auditorStatus(), 'viewer')

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
    if (bootstrap) sessionUser = { id: saved.id, name: saved.name, role: saved.role, denied: saved.denied }
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

  // ---------- AI assistant ----------
  //
  // Everything here is gated on the company's `ai` feature flag IN MAIN, not just in the
  // renderer: a renderer-only gate is a UI affordance, not a boundary. The assistant is off by
  // default, and nothing under services/ai is even imported until a run starts, so a user who
  // never turns it on never loads the SDK into their process.
  const requireAiOn = (): ReturnType<typeof requireCompany> => {
    const c = requireCompany()
    if (!configSvc.getFeatures(c.db).ai) throw new Error('The assistant is off for this company')
    return c
  }

  handle('ai:getConfig', () => {
    const c = getCurrentCompany()
    const featureOn = c ? configSvc.getFeatures(c.db).ai : false
    return aiConfig.readConfigView(featureOn)
  }, 'viewer')

  handle('ai:setConfig', (p) => aiConfig.writeConfigFromSettings(aiSettingsSchema.parse(p)), 'owner')

  handle('ai:testConnection', async () => {
    const { makeClient } = await import('./services/ai/provider')
    const started = Date.now()
    const models = await makeClient().listModels()
    const config = aiConfig.readConfig()
    const warnings: string[] = []
    if (models.length > 0 && !models.includes(config.model)) {
      warnings.push(`${config.model} isn't in this endpoint's model list — check the spelling.`)
    }
    if (!config.visionModel) {
      warnings.push('No vision model set, so reading a bill from a photo stays unavailable.')
    }
    return { ok: true, latencyMs: Date.now() - started, models, warnings }
  }, 'owner')

  handle('ai:chat', async (p) => {
    const { question, screen, history } = z
      .object({
        question: z.string().trim().min(1).max(2000),
        screen: z.string().max(60).optional(),
        history: z
          .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) }))
          .max(16)
          .optional()
      })
      .parse(p)
    const c = requireAiOn()
    const { startRun } = await import('./services/ai/runner')
    const wc = BrowserWindow.getAllWindows()[0]?.webContents
    if (!wc) throw new Error('No window to stream to')
    return {
      runId: startRun({
        db: c.db,
        slug: c.slug,
        info: c.info,
        today: todayISO(),
        question,
        screen,
        history,
        wc
      })
    }
  }, 'viewer')

  handle('ai:cancel', async (p) => {
    const { runId } = z.object({ runId: z.string().min(1).max(80) }).parse(p)
    const { abortRun } = await import('./services/ai/runner')
    return { cancelled: abortRun(runId) }
  }, 'viewer')

  handle('mcp:snippet', (p) => {
    const { client, allowWrites } = z
      .object({
        client: z.enum(['claude-desktop', 'claude-code', 'codex']),
        allowWrites: z.boolean().default(false)
      })
      .parse(p)
    return mcpSnippet(requireCompany().slug, client, allowWrites)
  }, 'owner')

  // ---------- licence ----------
  handle('license:get', () => licenseSvc.currentState(), 'viewer')
  handle('license:apply', (p) => {
    const { token } = z.object({ token: z.string().max(4000) }).parse(p)
    const state = licenseSvc.applyToken(token)
    invalidateLicenseCache()
    return state
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

  /**
   * Send the support message the user just read (roadmap #345).
   *
   * Deliberately takes the report text rather than rebuilding it: what the dialog showed and what
   * leaves the machine have to be the same string, and the only way to guarantee that is to send
   * the one that was on screen.
   */
  handle('support:send', async (p) => {
    const { message, email, log: logText } = supportSendSchema.parse(p)
    return support.sendFeedback({ message, email: email || null, log: logText || null })
  })

  // ---------- where the books live (roadmap #244) ----------
  handle('app:dataRoot:get', () => {
    const root = dataRoot()
    return {
      root,
      isDefault: configuredDataRoot() === null,
      // The chosen folder has gone (a drive unplugged, a folder deleted) and the app has fallen
      // back to the default — which must be said out loud, or the user opens a company picker
      // that is mysteriously empty.
      chosenMissing: dataRootMissing(),
      syncedBy: syncFolderWarning(root),
      // Moving copies every company, so the app has to be holding none of them open.
      companyOpen: current !== null
    }
  }, 'viewer')

  /**
   * Move the whole data folder somewhere the sync client cannot reach it.
   *
   * Copies, verifies every company database in the copy, and only then points the app at it. The
   * original is left exactly where it was: somebody moving their accounts between disks should
   * end up with two copies and a choice, not one copy and a hope.
   */
  handle('app:dataRoot:move', async (p) => {
    const { destination } = z.object({ destination: z.string().max(1000).optional() }).parse(p ?? {})
    let target = destination
    if (!target) {
      const picked = await dialog.showOpenDialog({
        title: 'Choose a folder to keep your books in',
        properties: ['openDirectory', 'createDirectory']
      })
      if (picked.canceled || !picked.filePaths[0]) return null
      target = picked.filePaths[0]
    }
    const from = dataRoot()
    const verdict = inspectMoveTarget(from, target)
    if (!verdict.ok) throw new Error(verdict.error)

    // Copying a database another handle is writing to is precisely how a sync client corrupts
    // one; doing it ourselves would be a poor joke in a feature about not doing that.
    closeCurrentCompany()
    const result = moveDataRoot(from, target)
    log('info', 'data-root-moved', { ...result })
    return { ...result, warning: verdict.warning }
  }, 'owner')

  // ---------- app info + updates ----------
  handle('app:info', () => ({ version: app.getVersion(), platform: process.platform }))
  handle('app:checkUpdates', () => checkForUpdatesInteractive(), 'viewer')

  /**
   * Open a link in the user's browser.
   *
   * Restricted to this product's own site and its GitHub releases. A general "open any URL"
   * channel reachable from the renderer is a way to launch anything the renderer can be talked
   * into asking for, and the renderer renders remote text (release notes, AI answers).
   */
  handle('app:openExternal', async (p) => {
    const { url } = z.object({ url: z.string().url().max(500) }).parse(p)
    const allowed = [SITE_URL, `https://github.com/${GITHUB_REPO}`]
    if (!allowed.some((prefix) => url.startsWith(prefix))) {
      throw new Error('That link is not one this app opens')
    }
    await shell.openExternal(url)
    return null
  }, 'viewer')

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
