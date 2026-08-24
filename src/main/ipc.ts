import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Notification,
  safeStorage,
  shell,
} from "electron";
import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  rmSync,
  unlinkSync,
  mkdtempSync,
  existsSync,
  mkdirSync,
  statSync,
  readdirSync,
  statfsSync,
} from "fs";
import { tmpdir } from "os";
import { join, basename, extname } from "path";
import { randomUUID } from "crypto";
import { z } from "zod";
import Database from "better-sqlite3";
import type { DB } from "./db/connection";
import { atomicWriteFile } from "./atomicFile";
import { backupCompany, closeCompanyDb, openCompanyDb } from "./db/connection";
import {
  inspectBackup,
  listBackupsIn,
  restoreCompanyDb,
  rollbackRestore,
  snapshotSync,
  backupStamp,
  runWeeklyIntegrityCheck,
  type BackupInfo,
} from "./db/backup";
import { checkIntegrity } from "./db/integrity";
import { encryptFile, decryptFile } from "./db/crypt";
import { readCompanyInfo, seedCompany, writeCompanyInfo } from "./db/seed";
import {
  readRegistry,
  removeCompany,
  touchLastOpened,
  upsertCompany,
} from "./registry";
import {
  companyBackupsDir,
  companyDbPath,
  companyDir,
  companyExportsDir,
  ensureCompanyTree,
  ensureDataTree,
  dataRoot,
  slugify,
} from "./paths";
import { log, logsDir, revealLogs } from "./log";
import { checkForUpdatesInteractive } from "./updater";
import {
  backupFileSchema,
  bankRuleInputSchema,
  batchInputSchema,
  billsOpenSchema,
  budgetInputSchema,
  budgetVarianceSchema,
  ccStatementSchema,
  chequeConfigSchema,
  companyCreateSchema,
  consolidatedRunSchema,
  costCentreInputSchema,
  exportCsvSchema,
  godownInputSchema,
  groupInputSchema,
  gst3bManualSchema,
  gstr2bSchema,
  isoDate,
  ledgerInputSchema,
  notifyDeadlinesSchema,
  passphraseSchema,
  periodSchema,
  priceLevelInputSchema,
  priceRateInputSchema,
  recurringInputSchema,
  rendererLogSchema,
  reportPdfSchema,
  searchGlobalSchema,
  stockGroupInputSchema,
  stockItemInputSchema,
  stockQuerySchema,
  tdsExport26qSchema,
  tdsSectionInputSchema,
  tdsSuggestSchema,
  tdsSummarySchema,
  unitInputSchema,
  voucherInputSchema,
  voucherTransportSchema,
  voucherTypeInputSchema,
} from "@shared/schemas";
import {
  bomVersionSchema,
  demandOverrideSchema,
  inventoryActionSchema,
  inventoryPlanningSchema,
  landedCostSchema,
  manufacturingOrderSchema,
  serialAssignmentSchema,
  stockCountCreateSchema,
  stockCountLineSchema,
  stockReservationSchema,
  stockTransferSchema,
} from "@shared/schemas";
import { todayISO } from "@shared/dates";
import type { ExportFormat } from "@shared/internalControls";
import { formatPaise } from "@shared/money";
import * as configSvc from "./services/config";
import * as masters from "./services/masters";
import * as vouchers from "./services/vouchers";
import * as voucherWorkflow from "./services/voucherWorkflow";
import * as reports from "./services/reports";
import * as gst from "./services/gst";
import * as intel from "./services/intel";
import * as analysis from "./services/analysis";
import * as banking from "./services/banking";
import * as edocs from "./services/edocs";
import * as invoice from "./services/invoice";
import * as cheque from "./services/cheque";
import * as extras from "./services/extras";
import * as payroll from "./services/payroll";
import * as payrollOperations from "./services/payrollOperations";
import * as workforce from "./services/workforce";
import * as workforceOperations from "./services/workforceOperations";
import * as nic from "./services/nic";
import * as tds from "./services/tds";
import * as costCentres from "./services/costCentres";
import * as stockAnalysis from "./services/stockAnalysis";
import * as inventoryOperations from "./services/inventoryOperations";
import * as inventoryTraceability from "./services/inventoryTraceability";
import { exportBarcodeLabels } from "./services/barcodeLabels";
import * as priceLevels from "./services/priceLevels";
import * as budgets from "./services/budgets";
import * as recurring from "./services/recurring";
import * as yearEnd from "./services/yearEnd";
import * as agentBridge from "./services/agentBridge";
import * as mcpAccess from "./services/mcpAccess";
import * as ai from "./services/ai";
import * as approvals from "./services/approvals";
import * as permissions from "./services/permissions";
import * as monthClose from "./services/monthClose";
import * as collections from "./services/collections";
import * as payables from "./services/payables";
import * as paymentRuns from "./services/paymentRuns";
import * as taskService from "./services/tasks";
import * as voucherDraftService from "./services/voucherDrafts";
import * as entryTemplateService from "./services/entryTemplates";
import * as salesDocumentService from "./services/salesDocuments";
import * as salesRecurringService from "./services/salesRecurring";
import * as discountAuthorityService from "./services/discountAuthority";
import * as customerOperations from "./services/customerOperations";
import * as internalControls from "./services/internalControls";
import * as procurementService from "./services/procurement";
import * as vendorService from "./services/vendors";
import { normalizeBankStatement } from "./services/bankStatementFormats";
import * as treasuryService from "./services/treasury";
import * as bankFeedService from "./services/bankFeeds";
import * as complianceOps from "./services/complianceOps";
import * as managementInsights from "./services/managementInsights";
import * as integrations from "./services/integrations";
import * as partnerAdapters from "./services/partnerAdapters";
import * as resilience from "./services/resilience";
import * as attachmentVault from "./services/attachmentVault";
import * as privacyControls from "./services/privacyControls";
import * as exportSigning from "./services/exportSigning";
import { backgroundWork } from "./services/workloadGovernor";
import * as systemHealthService from "./services/systemHealth";
import { writePerformanceProfilerPack } from "./services/performanceProfiler";
import * as supportCases from "./services/supportCases";
import * as crashReports from "./services/crashReports";
import * as onboarding from "./services/onboarding";
import * as voucherAccelerators from "./services/voucherAccelerators";
import {
  ecommerceOrderSchema,
  settlementInputSchema,
  shipmentInputSchema,
} from "@shared/integrationAdapters";
import { agentBridgeConfigSchema, agentExportSchema } from "@shared/schemas";
import { registerAiHandlers } from "./ipc/aiHandlers";
import { registerMigrationHandlers } from "./ipc/migrationHandlers";
import * as consolidated from "./services/consolidated";
import * as caPack from "./services/caPack";
import { htmlToPdf, writeExportPdf } from "./services/pdf";
import { reportHtml } from "./services/reportHtml";
import { globalSearch } from "./services/search";
import { createDemoCompany } from "./services/demo";
import {
  setAuditContext,
  writeAudit,
  listAudit,
  pruneAudit,
  verifyAuditChain,
} from "./services/audit";
import * as users from "./services/users";
import {
  assertDeleteAuthorized,
  auditCompanyDeletion,
} from "./services/companyDelete";
import type { Role } from "./services/roles";
import {
  bomInputSchema,
  currencyInputSchema,
  employeeInputSchema,
  nicCredentialsSchema,
  auditListSchema,
  userInputSchema,
  authLoginSchema,
  payHeadInputSchema,
  employeeHeadsSetSchema,
  payrollRunIdSchema,
  auditRetentionSchema,
  invoicePdfBatchSchema,
} from "@shared/schemas";
import type { CompanyInfo } from "@shared/domain";
import { featuresSchema } from "@shared/features";
import {
  invoiceConfigPartialSchema,
  invoiceConfigSchema,
} from "@shared/invoiceConfig";

export interface OpenCompany {
  slug: string;
  db: DB;
  info: CompanyInfo;
  /** Cached usersExist(db) — recomputed only on open and after users:save/deactivate, so ordinary
   *  IPC calls (the vast majority) never pay for a COUNT query just to check the role gate. */
  usersExist: boolean;
}

let current: OpenCompany | null = null;

/** The signed-in user for the currently-open company, or null before login / after logout.
 *  Cleared whenever the company itself closes (see closeCurrentCompany). */
let sessionUser: { id: number; name: string; role: Role } | null = null;
let sessionToken: string | null = null;
let sensitiveClipboardTimer: NodeJS.Timeout | null = null;

function requireCompany(): OpenCompany {
  if (!current) throw new Error("No company is open");
  return current;
}

/** Accessor for the currently-open company, used by the backup scheduler (backup-scheduler.ts). */
export function getCurrentCompany(): OpenCompany | null {
  return current;
}

/** Move a file into place. Copy+delete rather than fs.renameSync, since the source (os.tmpdir())
 *  and destination (~/Documents/total) may be on different filesystems (EXDEV). */
function renameFile(src: string, dest: string): void {
  rmSync(dest, { force: true });
  copyFileSync(src, dest);
  unlinkSync(src);
}

export function closeCurrentCompany(): void {
  // Stop the inbox watcher + any pending mirror refresh before the handle closes under them.
  agentBridge.syncInboxWatcher(null);
  if (current) {
    if (sessionToken)
      internalControls.closeSession(current.db, sessionToken, "locked");
    closeCompanyDb(current.db);
    current = null;
  }
  sessionUser = null;
  sessionToken = null;
}

type Handler = (payload: unknown) => unknown | Promise<unknown>;

/** Channels reachable before a company is open, or otherwise never role-gated: the company
 *  picker, the auth flow itself (you have to be able to call auth:login before you're "in"),
 *  logging, and the encrypted-backup import dialog. Everything else is gated by `handle`'s
 *  `minRole` — but only once a company is open AND that company actually has users (see below). */
const UNGATED_CHANNELS = new Set([
  "company:list",
  "company:create",
  "company:createDemo",
  "company:delete",
  "company:open",
  "company:current",
  // Deliberate: a locked session (or one with no session at all) must still be able to back
  // out to the company picker rather than getting stuck behind the gate it can't pass.
  "company:close",
  "auth:users",
  "auth:login",
  "auth:logout",
  "auth:current",
  "log:renderer",
  "log:reveal",
  "backup:importEncrypted",
  "app:info",
  "support:diagnostics",
  "support:captureScreenshot",
  "support:case:create",
  "support:case:list",
  "support:bundleOffline",
  "support:submit",
]);

function permissionActionFor(
  channel: string,
  payload: unknown,
  minRole: Role,
): permissions.PermissionAction {
  if (channel === "approval:list") return "view";
  if (
    channel.startsWith("approval:approve") ||
    channel.startsWith("approval:reject")
  )
    return "approve";
  if (channel.startsWith("backup:") || channel === "company:backup")
    return "backup";
  if (
    channel.startsWith("export:") ||
    channel === "report:pdf" ||
    channel.endsWith(":pdf") ||
    channel.endsWith(":csv")
  )
    return "export";
  if (
    channel.startsWith("config:") ||
    channel.startsWith("users:") ||
    channel.endsWith(":setConfig") ||
    channel === "company:updateInfo" ||
    channel.startsWith("company:lock:")
  )
    return "settings";
  if (minRole === "viewer") return "view";
  if (minRole === "owner") return "settings";
  const hasId =
    !!payload &&
    typeof payload === "object" &&
    "id" in payload &&
    typeof (payload as { id?: unknown }).id === "number";
  if (
    hasId ||
    /:(update|delete|remove|restore|purge|set|deactivate|mature|commit|resolve)$/.test(
      channel,
    ) ||
    channel.endsWith("Resolve")
  )
    return "edit";
  return "create";
}

function exportFormatFor(channel: string): ExportFormat {
  if (channel === "agent:exportMirror") return "json_mirror";
  if (channel === "export:caPack" || channel === "export:tallyXml")
    return "full_data";
  if (
    channel === "report:pdf" ||
    channel.endsWith(":pdf") ||
    channel.includes("Pdf")
  )
    return "pdf";
  return "spreadsheet";
}

function enforceDepartmentBoundaries(
  db: DB,
  role: Role,
  payload: unknown,
): void {
  if (role === "owner" || payload == null || typeof payload !== "object")
    return;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const kind =
        key === "costCentreId"
          ? "cost_centre"
          : key === "godownId"
            ? "godown"
            : key === "voucherTypeId"
              ? "voucher_type"
              : null;
      if (
        kind &&
        typeof child === "number" &&
        !internalControls.boundaryAllows(db, role, kind, child)
      )
        throw new Error(
          `Your role is outside the allowed ${kind.replace("_", " ")} scope`,
        );
      visit(child);
    }
  };
  visit(payload);
}

function handle(
  channel: string,
  fn: Handler,
  minRole: Role = "accountant",
): void {
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
          throw new Error("Locked — sign in first");
        }
        const action = permissionActionFor(channel, payload, minRole);
        if (
          !permissions.permissionAllows(current.db, sessionUser.role, action)
        ) {
          throw new Error("You do not have permission to do that");
        }
        if (
          action === "export" &&
          !internalControls.exportAllowed(
            current.db,
            sessionUser.role,
            exportFormatFor(channel),
          )
        ) {
          throw new Error(
            "Your role is not allowed to create this export format",
          );
        }
        enforceDepartmentBoundaries(current.db, sessionUser.role, payload);
        if (sessionToken)
          internalControls.touchSession(current.db, sessionToken);
      }
      const backgroundKind =
        channel === "ai:documents:capture"
          ? "document"
          : channel.startsWith("export:") ||
              channel === "report:pdf" ||
              channel === "backup:exportEncrypted" ||
              channel.endsWith(":pdf") ||
              channel.endsWith(":csv")
            ? "export"
            : null;
      const requestId =
        payload &&
        typeof payload === "object" &&
        "__totalRequestId" in payload &&
        typeof (payload as { __totalRequestId?: unknown }).__totalRequestId ===
          "string"
          ? (payload as { __totalRequestId: string }).__totalRequestId
          : randomUUID();
      const data = backgroundKind
        ? await backgroundWork.run(backgroundKind, requestId, () => fn(payload))
        : await fn(payload);
      return { ok: true, data };
    } catch (err) {
      const message =
        err instanceof z.ZodError
          ? err.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ")
          : err instanceof Error
            ? err.message
            : String(err);
      // Never log payloads — only the channel name and the error message.
      log("error", "ipc-handler", { channel, error: message });
      return { ok: false, error: message };
    }
  });
}

const idSchema = z.object({ id: z.number().int().positive() });
const withIdSchema = <T extends z.ZodTypeAny>(schema: T) =>
  z.object({ id: z.number().int().positive(), data: schema });

/** [lane-Q audit] one-line summary audit row for every file-export handler (task Q1 #90). */
const auditExport = (
  db: DB,
  kind: string,
  detail: Record<string, unknown>,
): void => writeAudit(db, "export", 0, "export", null, { kind, ...detail });

export function registerIpc(): void {
  setAuditContext({
    appVersion: app.getVersion(),
    getUserName: () => sessionUser?.name ?? null,
  });

  handle(
    "request:cancel",
    (p) => {
      const { requestId } = z.object({ requestId: z.string().uuid() }).parse(p);
      return { cancelled: backgroundWork.cancel(requestId) };
    },
    "viewer",
  );

  // ---------- company ----------
  handle("company:list", () => readRegistry());

  handle("onboarding:preflight", () => {
    ensureDataTree();
    const disk = statfsSync(dataRoot());
    const freeBytes = Number(disk.bavail) * Number(disk.bsize);
    const clockYear = new Date().getUTCFullYear();
    return {
      writable: true,
      freeBytes,
      diskReady: freeBytes >= 2 * 1024 ** 3,
      clockReady: clockYear >= 2020 && clockYear <= 2100,
      secureCredentials: process.env.TOTAL_SUPPRESS_SYNC_WARNING === "1" ? true : safeStorage.isEncryptionAvailable(),
      automaticBackups: true,
      dataPath: "~/Documents/total",
    };
  });

  handle("company:create", (payload) => {
    const parsed = companyCreateSchema.extend({
      onboarding: z.object({
        businessType: z.enum(["retailer", "wholesaler", "service", "manufacturer", "freelancer", "professional"]),
        priorSoftware: z.enum(["tally", "busy", "marg", "zoho", "excel", "first-time"]),
        needsInventory: z.boolean(),
        needsPayroll: z.boolean(),
      }).optional(),
    }).parse(payload);
    const { onboarding: onboardingInput, ...input } = parsed;
    let slug = slugify(input.name);
    let n = 2;
    while (existsSync(companyDbPath(slug)))
      slug = `${slugify(input.name)}-${n++}`;
    ensureCompanyTree(slug);
    const db = openCompanyDb(slug);
    const info: CompanyInfo = { ...input };
    seedCompany(db, info);
    const profile = onboarding.defaultOnboardingProfile(onboardingInput);
    onboarding.applyBusinessTemplate(db, profile.businessType);
    configSvc.setFeatures(db, { ...configSvc.getFeatures(db), inventory: profile.needsInventory, payroll: profile.needsPayroll });
    onboarding.writeOnboardingProfile(join(companyDir(slug), "setup.json"), profile);
    db.close();
    upsertCompany({
      slug,
      name: input.name,
      stateCode: input.stateCode,
      gstin: input.gstin,
      lastOpenedAt: null,
    });
    return { slug };
  });

  handle("onboarding:status", () => {
    const c = requireCompany();
    const file = join(companyDir(c.slug), "setup.json");
    const profile = onboarding.readOnboardingProfile(file);
    const status = onboarding.onboardingStatus(c.db, profile, listBackupsIn(companyBackupsDir(c.slug)).length);
    onboarding.writeOnboardingProfile(file, status.profile);
    return status;
  }, "viewer");

  handle("onboarding:update", (payload) => {
    const changes = z.object({
      businessType: z.enum(["retailer", "wholesaler", "service", "manufacturer", "freelancer", "professional"]).optional(),
      priorSoftware: z.enum(["tally", "busy", "marg", "zoho", "excel", "first-time"]).optional(),
      needsInventory: z.boolean().optional(),
      needsPayroll: z.boolean().optional(),
    }).parse(payload);
    const c = requireCompany();
    const file = join(companyDir(c.slug), "setup.json");
    const profile = { ...onboarding.readOnboardingProfile(file), ...changes };
    onboarding.applyBusinessTemplate(c.db, profile.businessType);
    configSvc.setFeatures(c.db, { ...configSvc.getFeatures(c.db), inventory: profile.needsInventory, payroll: profile.needsPayroll });
    onboarding.writeOnboardingProfile(file, profile);
    return onboarding.onboardingStatus(c.db, profile, listBackupsIn(companyBackupsDir(c.slug)).length);
  });

  handle("onboarding:handoff:export", () => {
    const c = requireCompany();
    const profile = onboarding.readOnboardingProfile(join(companyDir(c.slug), "setup.json"));
    const path = join(companyExportsDir(c.slug), "accountant-setup-handoff.json");
    const payload = { schema: 1, generatedAt: new Date().toISOString(), company: c.info, onboarding: profile,
      questions: ["Confirm opening balances", "Confirm tax registrations", "Confirm bank ledgers", "Confirm inventory and payroll scope"] };
    atomicWriteFile(path, `${JSON.stringify(payload, null, 2)}\n`, 0o600);
    shell.showItemInFolder(path);
    return { path };
  });

  handle("onboarding:handoff:import", async () => {
    const c = requireCompany();
    const picked = await dialog.showOpenDialog({ properties: ["openFile"], filters: [{ name: "Total setup handoff", extensions: ["json"] }] });
    if (picked.canceled || !picked.filePaths[0]) return null;
    const file = picked.filePaths[0];
    if (statSync(file).size > 256 * 1024) throw new Error("Setup handoff exceeds 256 KB");
    const parsed = z.object({ schema: z.literal(1), onboarding: z.object({
      businessType: z.enum(["retailer", "wholesaler", "service", "manufacturer", "freelancer", "professional"]),
      priorSoftware: z.enum(["tally", "busy", "marg", "zoho", "excel", "first-time"]),
      needsInventory: z.boolean(), needsPayroll: z.boolean(),
    }) }).parse(JSON.parse(readFileSync(file, "utf8")));
    const currentProfile = onboarding.readOnboardingProfile(join(companyDir(c.slug), "setup.json"));
    const profile = { ...currentProfile, ...parsed.onboarding };
    onboarding.applyBusinessTemplate(c.db, profile.businessType);
    onboarding.writeOnboardingProfile(join(companyDir(c.slug), "setup.json"), profile);
    return onboarding.onboardingStatus(c.db, profile, listBackupsIn(companyBackupsDir(c.slug)).length);
  });

  handle("company:createDemo", (payload) => {
    const businessType = z.enum(["retailer", "wholesaler", "service", "manufacturer", "freelancer", "professional"]).default("retailer").parse(payload);
    return createDemoCompany(businessType);
  });

  handle("company:delete", (payload) => {
    const { slug, confirmName, pin } = z
      .object({
        slug: z.string().min(1),
        confirmName: z.string(),
        pin: z
          .string()
          .regex(/^\d{4,12}$/, "PIN must be 4-12 digits")
          .optional(),
      })
      .parse(payload);
    const reg = readRegistry();
    const company = reg.companies.find((c) => c.slug === slug);
    if (!company) throw new Error("Company not found");
    if (confirmName !== company.name)
      throw new Error("Company name does not match");
    // The name check above protects nothing by itself — it's readable off the same screen it's
    // typed into. If this company has users, an active owner's PIN is required too.
    assertDeleteAuthorized(companyDbPath(slug), pin);
    // [lane-Q audit] durable record in the app log (survives the rmSync) + best-effort tombstone
    // row inside the DB itself.
    auditCompanyDeletion(companyDbPath(slug), slug, sessionUser?.name ?? null);
    log("warn", "company-deleted", { slug, user: sessionUser?.name ?? null });
    if (current?.slug === slug) closeCurrentCompany();
    rmSync(companyDir(slug), { recursive: true, force: true });
    removeCompany(slug);
    return null;
  });

  handle("company:open", async (payload) => {
    const { slug } = z.object({ slug: z.string().min(1) }).parse(payload);
    if (!existsSync(companyDbPath(slug)))
      throw new Error("Company database not found");
    closeCurrentCompany();
    const db = openCompanyDb(slug);
    const info = readCompanyInfo(db);
    current = { slug, db, info, usersExist: users.usersExist(db) };
    // Online backup needs an open handle, so this runs after open (not before, as it used to).
    // A backup failure here must never fail — or desync — the open itself.
    try {
      await backupCompany(db, slug, "open");
    } catch (err) {
      log("warn", "backup-on-open-failed", {
        slug,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const integrity = checkIntegrity(db);
    if (!integrity.ok) {
      log("warn", "integrity", {
        slug,
        quickCheck: integrity.quickCheck,
        unbalanced: integrity.unbalancedVoucherIds,
      });
    }
    // [lane-Q] scheduled weekly FULL integrity check (task Q3 #99) — the check above is the cheap
    // quick_check; this one is `PRAGMA integrity_check`, throttled to once per 7 days via meta.
    const weekly = runWeeklyIntegrityCheck(db);
    if (weekly.ran && !weekly.ok) {
      log("warn", "integrity-weekly-failed", { slug, detail: weekly.detail });
    }
    try {
      const purged = vouchers.purgeOldDeleted(db, 30);
      if (purged > 0) log("info", "bin-purge", { purged });
    } catch (err) {
      // e.g. an over-age binned voucher still referenced by payroll_runs — housekeeping must
      // never block opening the company.
      log("warn", "bin-purge-failed", {
        slug,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Post-dated vouchers whose date has arrived flip into the books (audited per voucher).
    // PDCs dated inside a locked period are refused, not silently posted — they stay in the
    // PDC register until the lock is lifted (v0.3 review F3).
    const { matured, blockedByLock } = vouchers.maturePostDated(db, todayISO());
    if (matured.length > 0)
      log("info", "pdc-mature", { count: matured.length, ids: matured });
    if (blockedByLock.length > 0) {
      log("warn", "pdc-mature-blocked-by-lock", {
        count: blockedByLock.length,
        ids: blockedByLock,
      });
    }
    // [lane-Q audit] retention: prune audit rows older than the configured window (default: keep
    // forever — getAuditKeepDays returns null and nothing is pruned).
    const auditKeepDays = configSvc.getAuditKeepDays(db);
    if (auditKeepDays !== null) {
      const prunedAudit = pruneAudit(db, auditKeepDays);
      if (prunedAudit > 0)
        log("info", "audit-prune", {
          pruned: prunedAudit,
          keepDays: auditKeepDays,
        });
    }
    touchLastOpened(slug);
    // Agent bridge (feature flag, default OFF): watch <company>/inbox/ for dropped files.
    if (configSvc.getAgentBridgeEnabled(db))
      agentBridge.syncInboxWatcher({ slug, db });
    return { slug, info, integrity, locked: current.usersExist };
  });

  handle("company:close", () => {
    closeCurrentCompany();
    return null;
  });

  handle("company:current", () =>
    current
      ? {
          slug: current.slug,
          info: current.info,
          locked: current.usersExist && !sessionUser,
        }
      : null,
  );

  handle(
    "company:updateInfo",
    (payload) => {
      const c = requireCompany();
      const before = c.info;
      const input = companyCreateSchema.parse(payload);
      const info: CompanyInfo = { ...input };
      writeCompanyInfo(c.db, info);
      c.info = info;
      upsertCompany({
        slug: c.slug,
        name: info.name,
        stateCode: info.stateCode,
        gstin: info.gstin,
        lastOpenedAt: new Date().toISOString(),
      });
      writeAudit(c.db, "company", 0, "update", before, info);
      return info;
    },
    "owner",
  );

  const runManualBackup = async (): Promise<{
    path: string;
    copies: ReturnType<typeof resilience.replicateBackup>;
  }> => {
    const c = requireCompany();
    const path = await backupCompany(c.db, c.slug, "manual");
    return { path, copies: resilience.replicateBackup(c.db, c.slug, path) };
  };
  // 'company:backup' is kept as an alias of 'backup:run' for existing callers.
  handle("company:backup", runManualBackup);

  handle("company:revealExports", () => {
    const c = requireCompany();
    shell.openPath(companyExportsDir(c.slug));
    return null;
  });

  handle(
    "company:lock:get",
    () => ({ date: vouchers.getLockDate(requireCompany().db) }),
    "viewer",
  );
  handle(
    "company:lock:set",
    (payload) => {
      const { date, exceptionId } = z
        .object({
          date: isoDate.nullable(),
          exceptionId: z.number().int().positive().optional(),
        })
        .parse(payload);
      const db = requireCompany().db;
      if (date === null && vouchers.getLockDate(db) !== null)
        internalControls.usePolicyException(
          db,
          exceptionId ?? 0,
          "period_lock",
          sessionUser?.name ?? "Local user",
        );
      vouchers.setLockDate(db, date);
      return { date };
    },
    "owner",
  );

  handle(
    "monthClose:status",
    (payload) => {
      const { from, to } = periodSchema.parse(payload);
      const c = requireCompany();
      const latest = listBackupsIn(companyBackupsDir(c.slug))[0];
      const evidence = latest
        ? {
            ...latest,
            valid: inspectBackup(join(companyBackupsDir(c.slug), latest.file))
              .valid,
          }
        : null;
      return monthClose.monthCloseStatus(c.db, c.info, from, to, evidence);
    },
    "viewer",
  );

  // ---------- year-end close ----------
  const fyStartYearSchema = z.object({
    fyStartYear: z.number().int().min(1990).max(2100),
  });
  handle(
    "yearend:preview",
    (p) => {
      const { fyStartYear } = fyStartYearSchema.parse(p);
      return yearEnd.closePreview(requireCompany().db, fyStartYear);
    },
    "viewer",
  );
  handle(
    "yearend:close",
    (p) => {
      const { fyStartYear } = fyStartYearSchema.parse(p);
      const c = requireCompany();
      return yearEnd.postClose(c.db, c.info, fyStartYear);
    },
    "owner",
  );

  // ---------- backups: list/run/restore + encrypted export/import ----------
  handle(
    "backup:list",
    (): BackupInfo[] => {
      const c = requireCompany();
      return listBackupsIn(companyBackupsDir(c.slug));
    },
    "viewer",
  );

  handle("backup:run", runManualBackup);
  handle(
    "backup:destinations:list",
    () => resilience.listBackupDestinations(requireCompany().db),
    "viewer",
  );
  handle(
    "backup:destinations:add",
    async (p) => {
      const { name } = z
        .object({ name: z.string().trim().min(2).max(80) })
        .parse(p);
      const picked = await dialog.showOpenDialog({
        title: "Choose a backup destination",
        properties: ["openDirectory", "createDirectory"],
      });
      if (picked.canceled || !picked.filePaths[0]) return null;
      return resilience.addBackupDestination(
        requireCompany().db,
        name,
        picked.filePaths[0],
        sessionUser?.name ?? "Local owner",
      );
    },
    "owner",
  );
  handle(
    "backup:destinations:setActive",
    (p) => {
      const { id, active } = z
        .object({ id: z.number().int().positive(), active: z.boolean() })
        .parse(p);
      return resilience.setBackupDestinationActive(
        requireCompany().db,
        id,
        active,
      );
    },
    "owner",
  );
  handle(
    "backup:drills:list",
    () => ({
      due: resilience.recoveryDrillDue(requireCompany().db),
      rows: resilience.listRecoveryDrills(requireCompany().db),
    }),
    "viewer",
  );
  handle(
    "backup:drills:run",
    (p) => {
      const { destinationId } = z
        .object({
          destinationId: z.number().int().positive().nullable().optional(),
        })
        .parse(p ?? {});
      const company = requireCompany();
      return resilience.runRecoveryDrill(
        company.db,
        company.slug,
        sessionUser?.name ?? "Local owner",
        destinationId,
      );
    },
    "owner",
  );
  handle(
    "backup:rotation:get",
    () => ({
      policy: resilience.getRotationPolicy(requireCompany().db),
      forecast: resilience.backupSpaceForecast(
        requireCompany().db,
        requireCompany().slug,
      ),
    }),
    "viewer",
  );
  handle(
    "backup:rotation:set",
    (p) => {
      const input = z
        .object({
          dailyCount: z.number().int().min(1).max(365),
          weeklyCount: z.number().int().min(0).max(104),
          monthlyCount: z.number().int().min(0).max(120),
          yearEndCount: z.number().int().min(0).max(25),
        })
        .parse(p);
      const company = requireCompany();
      const policy = resilience.setRotationPolicy(
        company.db,
        input,
        sessionUser?.name ?? "Local owner",
      );
      return {
        policy,
        forecast: resilience.backupSpaceForecast(company.db, company.slug),
      };
    },
    "owner",
  );

  handle(
    "backup:preview",
    (payload) => {
      const { file } = z.object({ file: backupFileSchema }).parse(payload);
      const c = requireCompany();
      return inspectBackup(join(companyBackupsDir(c.slug), file));
    },
    "owner",
  );

  handle(
    "backup:restore",
    async (payload) => {
      const { file } = z.object({ file: backupFileSchema }).parse(payload);
      const c = requireCompany();
      const { slug } = c;
      const backupPath = join(companyBackupsDir(slug), file);
      const dbPath = companyDbPath(slug);

      // Validates the chosen backup (quick_check + shape), takes a pre-restore safety snapshot,
      // and atomically swaps it into place. Throws — leaving the live DB completely untouched —
      // if the backup fails validation. `current`/`c.db` are still fully intact at that point,
      // since we haven't closed anything yet.
      const { preRestoreSnapshotPath } = restoreCompanyDb(
        c.db,
        dbPath,
        backupPath,
        companyBackupsDir(slug),
      );

      closeCurrentCompany();
      const reopen = (): OpenCompany => {
        const db = openCompanyDb(slug); // migrates if the backup predates the current schema
        const info = readCompanyInfo(db);
        return { slug, db, info, usersExist: users.usersExist(db) };
      };

      try {
        current = reopen();
      } catch (err) {
        // The swap already happened on disk, but the result won't open (e.g. a corrupted or
        // incompatible backup that still passed quick_check). Roll back to the pre-restore
        // snapshot so the app is never left with no company open and no path back.
        const message = err instanceof Error ? err.message : String(err);
        log("error", "backup-restore-reopen-failed", { slug, error: message });
        try {
          rollbackRestore(dbPath, preRestoreSnapshotPath);
          current = reopen();
        } catch (rollbackErr) {
          current = null;
          const rollbackMessage =
            rollbackErr instanceof Error
              ? rollbackErr.message
              : String(rollbackErr);
          log("error", "backup-restore-rollback-failed", {
            slug,
            error: rollbackMessage,
          });
          // Distinct from the happy-rollback message below — that one is a true statement only
          // when the rollback actually succeeded. Here it didn't: the live DB is not usable and
          // there is no company open, but the pre-restore snapshot this function took before
          // touching anything is still sitting in the backups folder, untouched.
          throw new Error(
            `Restore failed and automatic rollback also failed — this company may be unavailable. ` +
              `A pre-restore snapshot exists in the backups folder (${basename(preRestoreSnapshotPath)}); ` +
              `reopen or restore it manually.`,
          );
        }
        throw new Error(
          `Restore failed and was rolled back to the pre-restore snapshot: ${message}`,
        );
      }

      try {
        touchLastOpened(slug);
      } catch {
        // Best-effort — the restore itself already succeeded regardless of this.
      }
      const integrity = checkIntegrity(current.db);
      if (!integrity.ok) {
        log("warn", "integrity", {
          slug,
          quickCheck: integrity.quickCheck,
          unbalanced: integrity.unbalancedVoucherIds,
        });
      }
      // closeCurrentCompany() above already cleared sessionUser, so this is realistically always
      // `current.usersExist` — spelled out in full to match the other two locked-flag call sites.
      return {
        info: current.info,
        integrity,
        locked: current.usersExist && !sessionUser,
      };
    },
    "owner",
  );

  handle(
    "backup:exportEncrypted",
    async (payload) => {
      const { passphrase } = z
        .object({ passphrase: passphraseSchema })
        .parse(payload);
      const c = requireCompany();
      const tempPath = join(
        companyExportsDir(c.slug),
        `.export-tmp-${backupStamp()}.db`,
      );
      snapshotSync(c.db, tempPath);
      const destPath = join(
        companyExportsDir(c.slug),
        `total-${c.slug}-${backupStamp()}.totalbak`,
      );
      try {
        await encryptFile(tempPath, destPath, passphrase);
      } finally {
        unlinkSync(tempPath);
      }
      auditExport(c.db, "encrypted_backup", { path: destPath });
      shell.showItemInFolder(destPath);
      return { path: destPath };
    },
    "owner",
  );

  // No requireCompany() — importing an encrypted backup works with no company open.
  handle("backup:importEncrypted", async (payload) => {
    const { passphrase } = z
      .object({ passphrase: passphraseSchema })
      .parse(payload);
    const picked = await dialog.showOpenDialog({
      title: "Choose a Total encrypted backup",
      filters: [{ name: "Total backup", extensions: ["totalbak"] }],
      properties: ["openFile"],
    });
    if (picked.canceled || !picked.filePaths[0]) return null;

    const tempDir = mkdtempSync(join(tmpdir(), "total-import-"));
    const tempDbPath = join(tempDir, "restored.db");
    try {
      await decryptFile(picked.filePaths[0], tempDbPath, passphrase);
    } catch {
      throw new Error("Wrong passphrase or corrupted file");
    }

    let info: CompanyInfo;
    try {
      const check = new Database(tempDbPath, { readonly: true });
      try {
        const result = check.pragma("quick_check") as Array<{
          quick_check: string;
        }>;
        if (result[0]?.quick_check !== "ok") throw new Error("bad");
        info = readCompanyInfo(check);
      } finally {
        check.close();
      }
    } catch {
      throw new Error("This file doesn't look like a Total company backup");
    }

    let slug = slugify(info.name);
    let n = 2;
    while (existsSync(companyDbPath(slug)))
      slug = `${slugify(info.name)}-${n++}`;
    ensureCompanyTree(slug);

    const dbPath = companyDbPath(slug);
    try {
      renameFile(tempDbPath, dbPath);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }

    upsertCompany({
      slug,
      name: info.name,
      stateCode: info.stateCode,
      gstin: info.gstin,
      lastOpenedAt: new Date().toISOString(),
    });
    return { slug, name: info.name };
  });

  // ---------- masters ----------
  handle(
    "master:groups:list",
    () => masters.listGroups(requireCompany().db),
    "viewer",
  );
  handle(
    "master:groups:tree",
    () => masters.groupTree(requireCompany().db),
    "viewer",
  );
  handle("master:groups:create", (p) =>
    masters.createGroup(requireCompany().db, groupInputSchema.parse(p)),
  );
  handle("master:groups:update", (p) => {
    const { id, data } = withIdSchema(groupInputSchema).parse(p);
    return masters.updateGroup(requireCompany().db, id, data);
  });
  handle("master:groups:delete", (p) =>
    masters.deleteGroup(requireCompany().db, idSchema.parse(p).id),
  );

  handle(
    "master:ledgers:list",
    () => {
      const rows = masters.listLedgers(requireCompany().db);
      if (sessionUser?.role !== "viewer") return rows;
      return rows.map((row) => ({
        ...row,
        gstin: row.gstin ? `••••••${row.gstin.slice(-4)}` : null,
        pan: row.pan ? `••••••${row.pan.slice(-4)}` : null,
        address: row.address ? "Restricted" : null,
      }));
    },
    "viewer",
  );
  handle("master:ledgers:create", (p) =>
    masters.createLedger(requireCompany().db, ledgerInputSchema.parse(p)),
  );
  handle("master:ledgers:update", (p) => {
    const { id, data } = withIdSchema(ledgerInputSchema).parse(p);
    return masters.updateLedger(requireCompany().db, id, data);
  });
  handle("master:ledgers:delete", (p) =>
    masters.deleteLedger(requireCompany().db, idSchema.parse(p).id),
  );
  handle(
    "master:ledgerBalances",
    (p) => {
      const { asOn } = z.object({ asOn: z.string() }).parse(p);
      return masters.ledgerBalances(requireCompany().db, asOn);
    },
    "viewer",
  );

  handle(
    "master:voucherTypes:list",
    () => masters.listVoucherTypes(requireCompany().db),
    "viewer",
  );
  handle("master:voucherTypes:create", (p) =>
    masters.createVoucherType(
      requireCompany().db,
      voucherTypeInputSchema.parse(p),
    ),
  );
  handle("master:voucherTypes:update", (p) => {
    const { id, data } = withIdSchema(voucherTypeInputSchema).parse(p);
    return masters.updateVoucherType(requireCompany().db, id, data);
  });

  handle(
    "master:units:list",
    () => masters.listUnits(requireCompany().db),
    "viewer",
  );
  handle("master:units:create", (p) =>
    masters.createUnit(requireCompany().db, unitInputSchema.parse(p)),
  );
  handle(
    "master:stockGroups:list",
    () => masters.listStockGroups(requireCompany().db),
    "viewer",
  );
  handle("master:stockGroups:create", (p) =>
    masters.createStockGroup(
      requireCompany().db,
      stockGroupInputSchema.parse(p),
    ),
  );
  handle(
    "master:stockItems:list",
    () => masters.listStockItems(requireCompany().db),
    "viewer",
  );
  handle("master:stockItems:create", (p) =>
    masters.createStockItem(requireCompany().db, stockItemInputSchema.parse(p)),
  );
  handle("master:stockItems:update", (p) => {
    const { id, data } = withIdSchema(stockItemInputSchema).parse(p);
    return masters.updateStockItem(requireCompany().db, id, data);
  });
  handle("master:stockItems:delete", (p) =>
    masters.deleteStockItem(requireCompany().db, idSchema.parse(p).id),
  );
  handle(
    "master:godowns:list",
    () => masters.listGodowns(requireCompany().db),
    "viewer",
  );
  handle("master:godowns:create", (p) =>
    masters.createGodown(requireCompany().db, godownInputSchema.parse(p)),
  );

  // ---------- inventory depth (lane I): godown CRUD, batches, stock analysis ----------
  handle("master:godowns:update", (p) => {
    const { id, data } = withIdSchema(godownInputSchema).parse(p);
    return masters.updateGodown(requireCompany().db, id, data);
  });
  handle("master:godowns:delete", (p) =>
    masters.deleteGodown(requireCompany().db, idSchema.parse(p).id),
  );
  handle(
    "master:batches:list",
    (p) => {
      const { stockItemId } = z
        .object({ stockItemId: z.number().int().positive().optional() })
        .default({})
        .parse(p ?? {});
      return masters.listBatches(requireCompany().db, stockItemId);
    },
    "viewer",
  );
  handle("master:batches:create", (p) =>
    masters.createBatch(requireCompany().db, batchInputSchema.parse(p)),
  );
  handle(
    "stock:summary",
    (p) => {
      const { asOn, godownId } = stockQuerySchema.parse(p);
      return stockAnalysis.stockSummary(requireCompany().db, asOn, {
        godownId,
      });
    },
    "viewer",
  );
  handle(
    "stock:byGodown",
    (p) => {
      const { asOn } = stockQuerySchema.parse(p);
      return stockAnalysis.stockByGodown(requireCompany().db, asOn);
    },
    "viewer",
  );
  handle(
    "stock:batches",
    (p) => {
      const { asOn, stockItemId } = z
        .object({
          asOn: isoDate,
          stockItemId: z.number().int().positive().optional(),
        })
        .parse(p);
      return stockAnalysis.batchStock(requireCompany().db, asOn, stockItemId);
    },
    "viewer",
  );
  handle(
    "stock:expiry",
    (p) => {
      const { asOn } = stockQuerySchema.parse(p);
      return stockAnalysis.expiryAgeing(requireCompany().db, asOn);
    },
    "viewer",
  );
  handle(
    "stock:negative",
    (p) => {
      const { asOn } = stockQuerySchema.parse(p);
      return stockAnalysis.negativeStock(requireCompany().db, asOn);
    },
    "viewer",
  );
  handle(
    "stock:trail",
    (p) => {
      const { asOn, stockItemId } = z
        .object({ asOn: isoDate, stockItemId: z.number().int().positive() })
        .parse(p);
      return stockAnalysis.stockMovementTrail(
        requireCompany().db,
        stockItemId,
        asOn,
      );
    },
    "viewer",
  );
  handle(
    "stock:reconcile",
    (p) => {
      const { asOn } = z.object({ asOn: isoDate }).parse(p);
      return stockAnalysis.stockValuationReconciliation(
        requireCompany().db,
        asOn,
      );
    },
    "viewer",
  );
  handle(
    "inventory:planner",
    (p) =>
      inventoryOperations.planningDashboard(
        requireCompany().db,
        z.object({ asOn: isoDate }).parse(p).asOn,
      ),
    "viewer",
  );
  handle("inventory:planning:save", (p) =>
    inventoryOperations.savePlanningPolicy(
      requireCompany().db,
      inventoryPlanningSchema.parse(p),
      sessionUser?.name ?? "Owner",
    ),
  );
  handle(
    "inventory:forecast:list",
    () => inventoryOperations.listDemandOverrides(requireCompany().db),
    "viewer",
  );
  handle("inventory:forecast:save", (p) =>
    inventoryOperations.saveDemandOverride(
      requireCompany().db,
      demandOverrideSchema.parse(p),
      sessionUser?.name ?? "Owner",
    ),
  );
  handle(
    "inventory:actions:list",
    () => inventoryOperations.listActions(requireCompany().db),
    "viewer",
  );
  handle("inventory:actions:create", (p) =>
    inventoryOperations.createAction(
      requireCompany().db,
      inventoryActionSchema.parse(p),
      sessionUser?.name ?? "Owner",
    ),
  );
  handle("inventory:actions:status", (p) => {
    const q = z
      .object({
        id: z.number().int().positive(),
        status: z.enum(["open", "done", "dismissed"]),
      })
      .parse(p);
    return inventoryOperations.setActionStatus(
      requireCompany().db,
      q.id,
      q.status,
    );
  });
  handle(
    "inventory:reservations:list",
    () => inventoryOperations.listReservations(requireCompany().db),
    "viewer",
  );
  handle("inventory:reservations:create", (p) =>
    inventoryOperations.createReservation(
      requireCompany().db,
      stockReservationSchema.parse(p),
      sessionUser?.name ?? "Owner",
    ),
  );
  handle("inventory:reservations:status", (p) => {
    const q = z
      .object({
        id: z.number().int().positive(),
        status: z.enum(["fulfilled", "released", "expired"]),
      })
      .parse(p);
    return inventoryOperations.setReservationStatus(
      requireCompany().db,
      q.id,
      q.status,
    );
  });
  handle(
    "inventory:counts:list",
    () => inventoryOperations.listCountSessions(requireCompany().db),
    "viewer",
  );
  handle("inventory:counts:create", (p) =>
    inventoryOperations.createCountSession(
      requireCompany().db,
      stockCountCreateSchema.parse(p),
      sessionUser?.name ?? "Owner",
    ),
  );
  handle("inventory:counts:line", (p) =>
    inventoryOperations.saveCountLine(
      requireCompany().db,
      stockCountLineSchema.parse(p),
      sessionUser?.name ?? "Owner",
    ),
  );
  handle("inventory:counts:status", (p) => {
    const q = z
      .object({
        id: z.number().int().positive(),
        status: z.enum(["review", "posted", "cancelled"]),
      })
      .parse(p);
    return inventoryOperations.setCountStatus(
      requireCompany().db,
      q.id,
      q.status,
      sessionUser?.name ?? "Owner",
    );
  });
  handle(
    "inventory:serials:list",
    (p) =>
      inventoryTraceability.listSerials(
        requireCompany().db,
        z
          .object({ stockItemId: z.number().int().positive().optional() })
          .default({})
          .parse(p ?? {}).stockItemId,
      ),
    "viewer",
  );
  handle("inventory:serials:assign", (p) =>
    inventoryTraceability.assignSerials(
      requireCompany().db,
      serialAssignmentSchema.parse(p),
      sessionUser?.name ?? "Owner",
    ),
  );
  handle(
    "inventory:transfers:list",
    () => inventoryTraceability.listTransfers(requireCompany().db),
    "viewer",
  );
  handle("inventory:transfers:create", (p) =>
    inventoryTraceability.createTransfer(
      requireCompany().db,
      stockTransferSchema.parse(p),
      sessionUser?.name ?? "Owner",
    ),
  );
  handle("inventory:transfers:status", (p) => {
    const q = z
      .object({
        id: z.number().int().positive(),
        status: z.enum(["dispatched", "received", "cancelled"]),
      })
      .parse(p);
    return inventoryTraceability.setTransferStatus(
      requireCompany().db,
      q.id,
      q.status,
      sessionUser?.name ?? "Owner",
    );
  });
  handle(
    "inventory:bomVersions:list",
    (p) =>
      inventoryTraceability.listBomVersions(
        requireCompany().db,
        z
          .object({ itemId: z.number().int().positive().optional() })
          .default({})
          .parse(p ?? {}).itemId,
      ),
    "viewer",
  );
  handle("inventory:bomVersions:create", (p) =>
    inventoryTraceability.createBomVersion(
      requireCompany().db,
      bomVersionSchema.parse(p),
      sessionUser?.name ?? "Owner",
    ),
  );
  handle("inventory:bomVersions:activate", (p) =>
    inventoryTraceability.activateBomVersion(
      requireCompany().db,
      idSchema.parse(p).id,
      sessionUser?.name ?? "Owner",
    ),
  );
  handle(
    "inventory:manufacturing:list",
    () => inventoryTraceability.listManufacturingOrders(requireCompany().db),
    "viewer",
  );
  handle("inventory:manufacturing:create", (p) =>
    inventoryTraceability.createManufacturingOrder(
      requireCompany().db,
      manufacturingOrderSchema.parse(p),
      sessionUser?.name ?? "Owner",
    ),
  );
  handle("inventory:manufacturing:status", (p) => {
    const q = z
      .object({
        id: z.number().int().positive(),
        status: z.enum(["released", "completed", "cancelled"]),
      })
      .parse(p);
    return inventoryTraceability.setManufacturingStatus(
      requireCompany().db,
      q.id,
      q.status,
      sessionUser?.name ?? "Owner",
    );
  });
  handle(
    "inventory:landedCosts:list",
    () => inventoryTraceability.listLandedCosts(requireCompany().db),
    "viewer",
  );
  handle("inventory:landedCosts:add", (p) =>
    inventoryTraceability.addLandedCost(
      requireCompany().db,
      landedCostSchema.parse(p),
      sessionUser?.name ?? "Owner",
    ),
  );
  handle(
    "inventory:barcodeLabels:pdf",
    async (p) => {
      const input = z
        .object({
          items: z
            .array(
              z.object({
                stockItemId: z.number().int().positive(),
                copies: z.number().int().min(1).max(500),
              }),
            )
            .min(1)
            .max(500),
        })
        .parse(p);
      const c = requireCompany();
      const path = await exportBarcodeLabels(
        c.db,
        c.slug,
        c.info.name,
        input.items,
      );
      auditExport(c.db, "barcode_labels", {
        path,
        labelCount: input.items.reduce((sum, row) => sum + row.copies, 0),
      });
      return { path };
    },
    "viewer",
  );
  handle(
    "master:priceLevels:list",
    () => priceLevels.listPriceLevels(requireCompany().db),
    "viewer",
  );
  handle("master:priceLevels:create", (p) =>
    priceLevels.savePriceLevel(
      requireCompany().db,
      priceLevelInputSchema.parse(p),
    ),
  );
  handle("master:priceLevels:update", (p) => {
    const { id, data } = withIdSchema(priceLevelInputSchema).parse(p);
    return priceLevels.savePriceLevel(requireCompany().db, data, id);
  });
  handle("master:priceLevels:delete", (p) =>
    priceLevels.deletePriceLevel(requireCompany().db, idSchema.parse(p).id),
  );
  handle(
    "priceLevels:rates",
    (p) => {
      const { priceLevelId } = z
        .object({ priceLevelId: z.number().int().positive() })
        .parse(p);
      return priceLevels.listRates(requireCompany().db, priceLevelId);
    },
    "viewer",
  );
  handle("priceLevels:saveRate", (p) =>
    priceLevels.saveRate(requireCompany().db, priceRateInputSchema.parse(p)),
  );
  handle("priceLevels:deleteRate", (p) =>
    priceLevels.deleteRate(requireCompany().db, idSchema.parse(p).id),
  );
  handle(
    "priceLevels:rateFor",
    (p) => {
      const q = z
        .object({
          priceLevelId: z.number().int().positive(),
          stockItemId: z.number().int().positive(),
          date: isoDate,
        })
        .parse(p);
      return priceLevels.rateFor(
        requireCompany().db,
        q.priceLevelId,
        q.stockItemId,
        q.date,
      );
    },
    "viewer",
  );
  handle("pdc:list", () => vouchers.pdcRegister(requireCompany().db), "viewer");
  handle("pdc:mature", (p) => {
    vouchers.maturePdcNow(requireCompany().db, idSchema.parse(p).id);
    return null;
  });

  // ---------- search ----------
  handle(
    "search:global",
    (p) => globalSearch(requireCompany().db, searchGlobalSchema.parse(p).q),
    "viewer",
  );

  // ---------- vouchers ----------
  handle(
    "voucher:list",
    (p) => {
      const { from, to, voucherTypeId } = periodSchema
        .extend({ voucherTypeId: z.number().int().positive().optional() })
        .parse(p);
      return vouchers.listVouchers(
        requireCompany().db,
        from,
        to,
        voucherTypeId,
      );
    },
    "viewer",
  );
  handle(
    "voucher:get",
    (p) => vouchers.getVoucher(requireCompany().db, idSchema.parse(p).id),
    "viewer",
  );
  handle("voucher:save", (p) => {
    const matchSchema = z.object({
      goodsReceiptId: z.number().int().positive(),
      lines: z
        .array(
          z.object({
            stockItemId: z.number().int().positive(),
            qtyMilli: z.number().int().positive(),
            ratePaise: z.number().int().nonnegative(),
            amount: z.number().int().nonnegative(),
            gstRate: z.number().min(0).max(100),
          }),
        )
        .min(1)
        .max(200),
    });
    const { data, id, draftId, procurementMatch, procurementClaimKey, creditOverrideReason } = z
      .object({
        data: voucherInputSchema,
        id: z.number().int().positive().optional(),
        draftId: z.number().int().positive().optional(),
        procurementMatch: matchSchema.optional(),
        procurementClaimKey: z.string().trim().max(120).optional(),
        creditOverrideReason: z.string().trim().min(3).max(500).optional(),
      })
      .parse(p);
    const c = requireCompany();
    const voucherKind = c.db
      .prepare("SELECT kind FROM voucher_types WHERE id=?")
      .get(data.voucherTypeId) as { kind: string } | undefined;
    if (voucherKind?.kind === "sales") {
      discountAuthorityService.assertDiscountAuthority(c.db, {
        role: sessionUser?.role ?? "owner",
        actorName: sessionUser?.name ?? "Local user",
        customerLedgerId: data.partyLedgerId ?? null,
        contextKind: "sales_invoice",
        lines: data.inventory.map((line) => ({
          stockItemId: line.stockItemId,
          requestedDiscountBps: discountAuthorityService.invoiceDiscountBps(
            line.qtyMilli,
            line.ratePaise,
            line.discountPaise ?? 0,
          ),
        })),
      });
    }
    const workDraft = draftId
      ? voucherDraftService.getVoucherDraft(c.db, draftId)
      : null;
    if (draftId && !workDraft) throw new Error("Voucher draft was not found");
    const result = c.db.transaction(() => {
      if (
        c.usersExist &&
        sessionUser &&
        approvals.requiresApproval(c.db, data)
      ) {
        if (procurementMatch || procurementClaimKey)
          throw new Error(
            "An owner must post a procurement-linked invoice directly; approval handoff is not available for linked invoices yet",
          );
        const approvalResult = {
          approvalRequired: true as const,
          request: approvals.createApprovalRequest(c.db, data, sessionUser, id),
        };
        if (draftId) voucherDraftService.deleteVoucherDraft(c.db, draftId);
        return approvalResult;
      }
      const saved = vouchers.saveVoucher(c.db, data, id, { creditOverrideReason });
      if (creditOverrideReason) writeAudit(c.db, 'voucher', saved.id, 'update', null, { creditLimitOverride: creditOverrideReason, actor: sessionUser?.name ?? 'Local user' });
      if (procurementMatch)
        procurementService.recordInvoiceMatch(
          c.db,
          saved.id,
          procurementMatch,
          sessionUser?.name ?? "Local user",
        );
      if (procurementClaimKey)
        procurementService.recordDebitNoteLink(
          c.db,
          saved.id,
          procurementClaimKey,
          sessionUser?.name ?? "Local user",
        );
      if (workDraft?.payload.salesReturnLinks) {
        const links = z
          .array(
            z.object({
              invoiceVoucherId: z.number().int().positive(),
              invoiceInventoryLineId: z.number().int().positive(),
              qtyMilli: z.number().int().positive(),
            }),
          )
          .min(1)
          .max(200)
          .parse(workDraft.payload.salesReturnLinks);
        customerOperations.recordSalesReturn(
          c.db,
          saved.id,
          links,
          sessionUser?.name ?? "Local user",
        );
      }
      if (draftId) voucherDraftService.deleteVoucherDraft(c.db, draftId);
      return { ...saved, approvalRequired: false as const };
    })();
    // Agent mirror stays fresh while the flag is on — debounced so entry bursts export once.
    if (configSvc.getAgentBridgeEnabled(c.db))
      agentBridge.scheduleMirrorRefresh(c.db, c.slug);
    return result;
  });
  handle("voucher:delete", (p) =>
    vouchers.deleteVoucher(requireCompany().db, idSchema.parse(p).id),
  );
  const voucherIdsSchema = z.array(z.number().int().positive()).min(1).max(500);
  handle("voucher:batchTag", (p) => {
    const { ids, tag } = z
      .object({
        ids: voucherIdsSchema,
        tag: z.string().trim().min(1).max(30),
      })
      .parse(p);
    voucherWorkflow.tagVouchers(
      requireCompany().db,
      ids,
      tag,
      sessionUser?.name ?? "Local user",
    );
    return null;
  });
  handle("voucher:batchReview", (p) => {
    const { ids } = z.object({ ids: voucherIdsSchema }).parse(p);
    voucherWorkflow.reviewVouchers(
      requireCompany().db,
      ids,
      sessionUser?.name ?? "Local user",
    );
    return null;
  });
  handle(
    "voucher:comments",
    (p) =>
      voucherWorkflow.listVoucherComments(
        requireCompany().db,
        idSchema.parse(p).id,
      ),
    "viewer",
  );
  handle("voucher:commentAdd", (p) => {
    const { id, body } = z
      .object({
        id: z.number().int().positive(),
        body: z.string().trim().min(1).max(2000),
      })
      .parse(p);
    return voucherWorkflow.addVoucherComment(
      requireCompany().db,
      id,
      body,
      sessionUser?.name ?? "Local user",
    );
  });
  handle(
    "voucher:smartDefaults",
    (p) => {
      const { partyLedgerId, kind } = z.object({ partyLedgerId: z.number().int().positive(), kind: z.string().trim().min(1).max(30) }).parse(p);
      return voucherAccelerators.smartLedgerDefaults(requireCompany().db, partyLedgerId, kind);
    },
    "viewer",
  );
  handle("voucher:creditExposure", (p) => { const { partyLedgerId, proposedDebit } = z.object({ partyLedgerId: z.number().int().positive(), proposedDebit: z.number().int().positive() }).parse(p); return voucherAccelerators.creditExposure(requireCompany().db, partyLedgerId, proposedDebit) }, "viewer");
  handle("voucher:clipboardLines", () => ({ text: clipboard.readText().slice(0, 256 * 1024) }), "accountant");
  handle(
    "voucher:attachments",
    (p) => voucherAccelerators.listAttachments(requireCompany().db, idSchema.parse(p).id),
    "viewer",
  );
  handle("voucher:attachmentAdd", async (p) => {
    const { id, kind } = z.object({ id: z.number().int().positive(), kind: z.enum(["invoice", "receipt", "email", "delivery", "other"]) }).parse(p);
    const picked = await dialog.showOpenDialog({
      title: "Attach voucher evidence",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Documents", extensions: ["pdf", "png", "jpg", "jpeg", "webp", "csv", "xlsx", "eml", "txt"] }],
    });
    if (picked.canceled) return [];
    if (picked.filePaths.length > 20) throw new Error("Attach at most 20 files at a time");
    const c = requireCompany();
    const attachmentDir = join(companyDir(c.slug), "attachments", "vouchers", String(id));
    mkdirSync(attachmentDir, { recursive: true });
    return picked.filePaths.map((sourcePath) => {
      const source = statSync(sourcePath);
      if (!source.isFile() || source.size > 25 * 1024 * 1024) throw new Error(`${basename(sourcePath)} must be a file no larger than 25 MB`);
      const destination = join(attachmentDir, `${randomUUID()}${extname(sourcePath).toLowerCase()}`);
      const storedPath = attachmentVault.storeManagedAttachment(c.db, c.slug, sourcePath, destination);
      return voucherAccelerators.addAttachment(c.db, { voucherId: id, originalName: basename(sourcePath), storedPath, kind, sizeBytes: source.size, actor: sessionUser?.name ?? "Local user" });
    });
  });
  handle("voucher:attachmentOpen", async (p) => {
    const { id } = z.object({ id: z.number().int().positive() }).parse(p);
    const c = requireCompany();
    const attachment = c.db.prepare("SELECT stored_path AS storedPath,original_name AS originalName FROM voucher_attachments WHERE id=?").get(id) as { storedPath: string; originalName: string } | undefined;
    if (!attachment) throw new Error("Attachment was not found");
    let openPath = attachment.storedPath;
    if (openPath.endsWith(".totalatt")) {
      const tempDir = mkdtempSync(join(tmpdir(), "total-voucher-attachment-"));
      openPath = join(tempDir, basename(attachment.originalName));
      writeFileSync(openPath, attachmentVault.readManagedAttachment(c.db, c.slug, attachment.storedPath), { mode: 0o600 });
    }
    const error = await shell.openPath(openPath);
    if (error) throw new Error(error);
    return null;
  }, "viewer");
  const voucherDraftInput = z.object({
    voucherTypeId: z.number().int().positive(),
    mode: z.enum(["accounting", "invoice", "manufacture", "physical_stock"]),
    title: z.string().trim().min(1).max(120),
    payloadVersion: z.number().int().positive().max(100),
    payload: z.record(z.string(), z.unknown()),
  });
  handle(
    "voucherDraft:list",
    () => voucherDraftService.listVoucherDrafts(requireCompany().db),
    "viewer",
  );
  handle(
    "voucherDraft:get",
    (p) =>
      voucherDraftService.getVoucherDraft(
        requireCompany().db,
        idSchema.parse(p).id,
      ),
    "viewer",
  );
  handle("voucherDraft:save", (p) => {
    const { id, data } = z
      .object({
        id: z.number().int().positive().optional(),
        data: voucherDraftInput,
      })
      .parse(p);
    return voucherDraftService.saveVoucherDraft(
      requireCompany().db,
      data,
      sessionUser?.name ?? "Local user",
      id,
    );
  });
  handle("voucherDraft:delete", (p) =>
    voucherDraftService.deleteVoucherDraft(
      requireCompany().db,
      idSchema.parse(p).id,
    ),
  );
  const salesDocumentKindSchema = z.enum([
    "quotation",
    "order",
    "challan",
    "proforma",
  ]);
  const salesDocumentStatusSchema = z.enum([
    "draft",
    "sent",
    "accepted",
    "rejected",
    "confirmed",
    "part_fulfilled",
    "fulfilled",
    "cancelled",
    "approved",
    "returned",
    "converted",
    "expired",
  ]);
  const salesDocumentLineSchema = z.object({
    stockItemId: z.number().int().positive().nullable(),
    description: z.string().trim().min(1).max(500),
    qtyMilli: z.number().int().positive(),
    rate: z.number().int().nonnegative(),
    discountBps: z.number().int().min(0).max(10000),
    gstRate: z.number().min(0).max(100),
    optional: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  });
  const salesDocumentInputSchema = z.object({
    kind: salesDocumentKindSchema,
    seriesId: z.number().int().positive(),
    partyLedgerId: z.number().int().positive(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    validUntil: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    purpose: z.string().max(500).nullable(),
    gstRegistrationId: z.number().int().positive().nullable(),
    terms: z.array(z.string().trim().min(1).max(500)).max(30),
    customFields: z.record(z.string(), z.string().max(500)),
    lines: z.array(salesDocumentLineSchema).min(1).max(200),
  });
  handle(
    "salesDocument:seriesList",
    (p) => {
      const { kind } = z
        .object({ kind: salesDocumentKindSchema.optional() })
        .parse(p ?? {});
      return salesDocumentService.listSalesDocumentSeries(
        requireCompany().db,
        kind,
      );
    },
    "viewer",
  );
  handle(
    "salesDocument:seriesSave",
    (p) => {
      const { id, data } = z
        .object({
          id: z.number().int().positive().optional(),
          data: z.object({
            kind: salesDocumentKindSchema,
            name: z.string().trim().min(1).max(80),
            prefix: z.string().max(24),
            suffix: z.string().max(24),
            padWidth: z.number().int().min(0).max(12),
            restartFy: z.boolean(),
            active: z.boolean(),
          }),
        })
        .parse(p);
      return salesDocumentService.saveSalesDocumentSeries(
        requireCompany().db,
        data,
        id,
      );
    },
    "owner",
  );
  handle(
    "salesDocument:numberPreview",
    (p) => {
      const { seriesId, date } = z
        .object({
          seriesId: z.number().int().positive(),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        })
        .parse(p);
      return salesDocumentService.previewSalesDocumentNumber(
        requireCompany().db,
        seriesId,
        date,
      );
    },
    "viewer",
  );
  handle(
    "salesDocument:list",
    (p) => {
      const { kind, status } = z
        .object({
          kind: salesDocumentKindSchema.optional(),
          status: salesDocumentStatusSchema.optional(),
        })
        .parse(p ?? {});
      return salesDocumentService.listSalesDocuments(
        requireCompany().db,
        kind,
        status,
      );
    },
    "viewer",
  );
  handle(
    "salesDocument:get",
    (p) =>
      salesDocumentService.getSalesDocument(
        requireCompany().db,
        idSchema.parse(p).id,
      ),
    "viewer",
  );
  handle("salesDocument:create", (p) =>
    salesDocumentService.createSalesDocument(
      requireCompany().db,
      salesDocumentInputSchema.parse(p),
      sessionUser?.name ?? "Local user",
      null,
      sessionUser?.role ?? "owner",
    ),
  );
  handle("salesDocument:revise", (p) => {
    const { id, data, reason } = z
      .object({
        id: z.number().int().positive(),
        data: salesDocumentInputSchema,
        reason: z.string().trim().min(1).max(500),
      })
      .parse(p);
    return salesDocumentService.reviseSalesDocument(
      requireCompany().db,
      id,
      data,
      reason,
      sessionUser?.name ?? "Local user",
      sessionUser?.role ?? "owner",
    );
  });
  handle("salesDocument:setStatus", (p) => {
    const { id, status } = z
      .object({
        id: z.number().int().positive(),
        status: salesDocumentStatusSchema,
      })
      .parse(p);
    return salesDocumentService.setSalesDocumentStatus(
      requireCompany().db,
      id,
      status,
      sessionUser?.name ?? "Local user",
    );
  });
  handle("salesDocument:convert", (p) => {
    const input = z
      .object({
        sourceDocumentId: z.number().int().positive(),
        targetKind: z.union([salesDocumentKindSchema, z.literal("invoice")]),
        targetSeriesId: z.number().int().positive().optional(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        lines: z
          .array(
            z.object({
              sourceLineId: z.number().int().positive(),
              qtyMilli: z.number().int().positive(),
            }),
          )
          .min(1)
          .max(200),
      })
      .parse(p);
    return salesDocumentService.convertSalesDocument(
      requireCompany().db,
      input,
      sessionUser?.name ?? "Local user",
    );
  });
  const recurringSalesLineSchema = z.object({
    stockItemId: z.number().int().positive(),
    description: z.string().trim().min(1).max(500),
    qtyMilli: z.number().int().positive(),
    rateMode: z.enum(["fixed", "price_list"]),
    fixedRate: z.number().int().nonnegative().nullable(),
    discountBps: z.number().int().min(0).max(10000),
  });
  const recurringSalesScheduleSchema = z.object({
    name: z.string().trim().min(1).max(120),
    partyLedgerId: z.number().int().positive(),
    voucherTypeId: z.number().int().positive(),
    cadence: z.enum(["monthly", "quarterly", "yearly"]),
    nextDue: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    dueDays: z.number().int().min(0).max(365),
    lines: z.array(recurringSalesLineSchema).min(1).max(200),
    narration: z.string().max(500).nullable(),
    active: z.boolean(),
  });
  handle(
    "salesRecurring:list",
    () =>
      salesRecurringService.listSalesRecurringSchedules(requireCompany().db),
    "viewer",
  );
  handle("salesRecurring:save", (p) => {
    const { id, data } = z
      .object({
        id: z.number().int().positive().optional(),
        data: recurringSalesScheduleSchema,
      })
      .parse(p);
    return salesRecurringService.saveSalesRecurringSchedule(
      requireCompany().db,
      data,
      sessionUser?.name ?? "Local user",
      id,
    );
  });
  handle(
    "salesRecurring:preview",
    (p) =>
      salesRecurringService.previewSalesRecurringBatch(
        requireCompany().db,
        z.object({ asOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(p)
          .asOn,
      ),
    "viewer",
  );
  handle("salesRecurring:generate", (p) => {
    const { asOn, scheduleIds } = z
      .object({
        asOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        scheduleIds: z.array(z.number().int().positive()).max(500),
      })
      .parse(p);
    return salesRecurringService.generateSalesRecurringBatch(
      requireCompany().db,
      asOn,
      scheduleIds,
      sessionUser?.name ?? "Local user",
    );
  });
  const discountPolicySchema = z.object({
    name: z.string().trim().min(1).max(120),
    scopeKind: z.enum(["global", "role", "item", "customer"]),
    role: z.enum(["owner", "accountant", "viewer"]).nullable(),
    stockItemId: z.number().int().positive().nullable(),
    customerLedgerId: z.number().int().positive().nullable(),
    maxDiscountBps: z.number().int().min(0).max(10000),
    active: z.boolean(),
  });
  handle(
    "salesDiscount:list",
    () => discountAuthorityService.listDiscountPolicies(requireCompany().db),
    "viewer",
  );
  handle(
    "salesDiscount:save",
    (p) => {
      const { id, data } = z
        .object({
          id: z.number().int().positive().optional(),
          data: discountPolicySchema,
        })
        .parse(p);
      return discountAuthorityService.saveDiscountPolicy(
        requireCompany().db,
        data,
        sessionUser?.name ?? "Local user",
        id,
      );
    },
    "owner",
  );
  handle(
    "customerOps:returnCandidates",
    (p) => {
      const { partyLedgerId } = z
        .object({ partyLedgerId: z.number().int().positive().optional() })
        .parse(p ?? {});
      return customerOperations.salesReturnCandidates(
        requireCompany().db,
        partyLedgerId,
      );
    },
    "viewer",
  );
  handle("customerOps:returnDraft", (p) => {
    const input = z
      .object({
        invoiceVoucherId: z.number().int().positive(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        reason: z.string().trim().min(1).max(500),
        lines: z
          .array(
            z.object({
              invoiceInventoryLineId: z.number().int().positive(),
              qtyMilli: z.number().int().positive(),
            }),
          )
          .min(1)
          .max(200),
      })
      .parse(p);
    return customerOperations.createSalesReturnDraft(
      requireCompany().db,
      input,
      sessionUser?.name ?? "Local user",
    );
  });
  handle(
    "customerOps:warranties",
    () => customerOperations.warrantyRegister(requireCompany().db),
    "viewer",
  );
  handle("customerOps:warrantyOpen", (p) => {
    const { serialId, openedDate, issue } = z
      .object({
        serialId: z.number().int().positive(),
        openedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        issue: z.string().trim().min(1).max(1000),
      })
      .parse(p);
    return customerOperations.openWarrantyClaim(
      requireCompany().db,
      serialId,
      openedDate,
      issue,
      sessionUser?.name ?? "Local user",
    );
  });
  handle("customerOps:warrantyResolve", (p) => {
    const { id, status, outcome, serviceCost, resolvedDate } = z
      .object({
        id: z.number().int().positive(),
        status: z.enum(["in_service", "resolved", "rejected"]),
        outcome: z.string().max(1000).nullable(),
        serviceCost: z.number().int().nonnegative(),
        resolvedDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable(),
      })
      .parse(p);
    return customerOperations.resolveWarrantyClaim(
      requireCompany().db,
      id,
      status,
      outcome,
      serviceCost,
      resolvedDate,
    );
  });
  handle(
    "customerOps:customFields",
    () => customerOperations.listCustomFields(requireCompany().db),
    "viewer",
  );
  handle(
    "customerOps:customFieldSave",
    (p) => {
      const input = z
        .object({
          fieldKey: z.string(),
          label: z.string().trim().min(1).max(80),
          documentKind: salesDocumentKindSchema.nullable(),
          dataType: z.enum(["text", "number", "date", "choice"]),
          required: z.boolean(),
          options: z.array(z.string().trim().min(1).max(80)).max(50),
          active: z.boolean(),
        })
        .parse(p);
      return customerOperations.saveCustomField(
        requireCompany().db,
        input,
        sessionUser?.name ?? "Local user",
      );
    },
    "owner",
  );
  handle(
    "customerOps:territorySave",
    (p) => {
      const { name, parentId } = z
        .object({
          name: z.string().trim().min(1).max(100),
          parentId: z.number().int().positive().nullable(),
        })
        .parse(p);
      return customerOperations.saveTerritory(
        requireCompany().db,
        name,
        parentId,
      );
    },
    "owner",
  );
  handle(
    "customerOps:customerAssign",
    (p) => {
      const {
        customerLedgerId,
        territoryId,
        salesperson,
        effectiveFrom,
        effectiveTo,
      } = z
        .object({
          customerLedgerId: z.number().int().positive(),
          territoryId: z.number().int().positive(),
          salesperson: z.string().trim().min(1).max(100),
          effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          effectiveTo: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .nullable(),
        })
        .parse(p);
      return customerOperations.assignCustomer(
        requireCompany().db,
        customerLedgerId,
        territoryId,
        salesperson,
        effectiveFrom,
        effectiveTo,
      );
    },
    "owner",
  );
  handle(
    "customerOps:territorySales",
    (p) => {
      const { from, to } = periodSchema.parse(p);
      return customerOperations.territorySales(requireCompany().db, from, to);
    },
    "viewer",
  );
  handle(
    "customerOps:subscriptions",
    () => customerOperations.listSubscriptions(requireCompany().db),
    "viewer",
  );
  handle("customerOps:subscriptionCreate", (p) => {
    const input = z
      .object({
        recurringScheduleId: z.number().int().positive(),
        planName: z.string().trim().min(1).max(120),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable(),
        escalationBps: z.number().int().min(0).max(10000),
        nextEscalationDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable(),
        note: z.string().max(1000).nullable(),
      })
      .parse(p);
    return customerOperations.createSubscription(
      requireCompany().db,
      input,
      sessionUser?.name ?? "Local user",
    );
  });
  handle("customerOps:subscriptionStatus", (p) => {
    const { id, status } = z
      .object({
        id: z.number().int().positive(),
        status: z.enum([
          "draft",
          "active",
          "paused",
          "renewal_due",
          "ended",
          "cancelled",
        ]),
      })
      .parse(p);
    return customerOperations.setSubscriptionStatus(
      requireCompany().db,
      id,
      status,
    );
  });
  handle("customerOps:portalBundle", async (p) => {
    const { customerLedgerId, from, to } = z
      .object({
        customerLedgerId: z.number().int().positive(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .parse(p);
    const c = requireCompany();
    return customerOperations.customerPortalBundle(
      c.db,
      c.info,
      c.slug,
      customerLedgerId,
      from,
      to,
      sessionUser?.name ?? "Local user",
    );
  });
  handle(
    "entryTemplate:list",
    () => entryTemplateService.listEntryTemplates(requireCompany().db),
    "viewer",
  );
  handle("entryTemplate:save", (p) => {
    const data = voucherDraftInput
      .extend({ name: z.string().trim().min(1).max(120) })
      .parse(p);
    return entryTemplateService.saveEntryTemplate(
      requireCompany().db,
      data,
      sessionUser?.name ?? "Local user",
    );
  });
  handle("entryTemplate:instantiate", (p) =>
    entryTemplateService.instantiateEntryTemplate(
      requireCompany().db,
      idSchema.parse(p).id,
      sessionUser?.name ?? "Local user",
    ),
  );
  handle("entryTemplate:delete", (p) =>
    entryTemplateService.deleteEntryTemplate(
      requireCompany().db,
      idSchema.parse(p).id,
    ),
  );
  const requisitionInput = z.object({
    date: isoDate,
    neededBy: isoDate.nullable(),
    department: z.string().trim().max(120).nullable(),
    note: z.string().trim().max(1000).nullable(),
    lines: z
      .array(
        z.object({
          stockItemId: z.number().int().positive(),
          qtyMilli: z.number().int().positive(),
          note: z.string().trim().max(300).nullable(),
        }),
      )
      .min(1)
      .max(200),
  });
  const purchaseOrderInput = z.object({
    date: isoDate,
    expectedDate: isoDate.nullable(),
    supplierLedgerId: z.number().int().positive(),
    requisitionId: z.number().int().positive().nullable(),
    note: z.string().trim().max(1000).nullable(),
    lines: z
      .array(
        z.object({
          stockItemId: z.number().int().positive(),
          qtyMilli: z.number().int().positive(),
          ratePaise: z.number().int().nonnegative(),
          gstRate: z.number().min(0).max(100),
        }),
      )
      .min(1)
      .max(200),
  });
  const goodsReceiptInput = z.object({
    purchaseOrderId: z.number().int().positive(),
    date: isoDate,
    note: z.string().trim().max(1000).nullable(),
    lines: z
      .array(
        z.object({
          purchaseOrderLineId: z.number().int().positive(),
          qtyReceivedMilli: z.number().int().positive(),
          qtyAcceptedMilli: z.number().int().nonnegative(),
          qtyRejectedMilli: z.number().int().nonnegative(),
        }),
      )
      .min(1)
      .max(200),
  });
  const invoiceMatchInput = z.object({
    goodsReceiptId: z.number().int().positive(),
    lines: z
      .array(
        z.object({
          stockItemId: z.number().int().positive(),
          qtyMilli: z.number().int().positive(),
          ratePaise: z.number().int().nonnegative(),
          amount: z.number().int().nonnegative(),
          gstRate: z.number().min(0).max(100),
        }),
      )
      .min(1)
      .max(200),
  });
  handle(
    "procurement:requisitions",
    () => procurementService.listRequisitions(requireCompany().db),
    "viewer",
  );
  handle("procurement:requisitionCreate", (p) =>
    procurementService.createRequisition(
      requireCompany().db,
      requisitionInput.parse(p),
      sessionUser?.name ?? "Local user",
    ),
  );
  handle("procurement:requisitionStatus", (p) => {
    const q = z
      .object({
        id: z.number().int().positive(),
        status: z.enum(["submitted", "approved", "rejected", "cancelled"]),
        note: z.string().trim().max(1000).nullable().optional(),
      })
      .parse(p);
    const c = requireCompany();
    if (
      c.usersExist &&
      (q.status === "approved" || q.status === "rejected") &&
      sessionUser?.role !== "owner"
    )
      throw new Error("Only an owner can approve or reject requisitions");
    return procurementService.setRequisitionStatus(
      c.db,
      q.id,
      q.status,
      sessionUser?.name ?? "Local user",
      q.note,
    );
  });
  handle(
    "procurement:orders",
    () => procurementService.listPurchaseOrders(requireCompany().db),
    "viewer",
  );
  handle("procurement:orderCreate", (p) =>
    procurementService.createPurchaseOrder(
      requireCompany().db,
      purchaseOrderInput.parse(p),
      sessionUser?.name ?? "Local user",
    ),
  );
  handle("procurement:orderStatus", (p) => {
    const q = z
      .object({
        id: z.number().int().positive(),
        status: z.enum(["issued", "closed", "cancelled"]),
      })
      .parse(p);
    return procurementService.setPurchaseOrderStatus(
      requireCompany().db,
      q.id,
      q.status,
      sessionUser?.name ?? "Local user",
    );
  });
  handle(
    "procurement:receipts",
    () => procurementService.listGoodsReceipts(requireCompany().db),
    "viewer",
  );
  handle("procurement:receiptCreate", (p) =>
    procurementService.createGoodsReceipt(
      requireCompany().db,
      goodsReceiptInput.parse(p),
      sessionUser?.name ?? "Local user",
    ),
  );
  handle(
    "procurement:invoiceCandidates",
    (p) => {
      const q = z
        .object({ supplierLedgerId: z.number().int().positive().optional() })
        .parse(p ?? {});
      return procurementService.listInvoiceMatchCandidates(
        requireCompany().db,
        q.supplierLedgerId,
      );
    },
    "viewer",
  );
  handle(
    "procurement:invoiceMatchPreview",
    (p) =>
      procurementService.previewInvoiceMatch(
        requireCompany().db,
        invoiceMatchInput.parse(p),
      ),
    "viewer",
  );
  handle(
    "procurement:priceHistory",
    (p) => {
      const q = z
        .object({
          stockItemIds: z.array(z.number().int().positive()).min(1).max(100),
          supplierLedgerId: z.number().int().positive().optional(),
        })
        .parse(p);
      return procurementService.supplierPriceHistory(
        requireCompany().db,
        q.stockItemIds,
        q.supplierLedgerId,
      );
    },
    "viewer",
  );
  handle(
    "procurement:supplierComparison",
    (p) =>
      procurementService.compareSuppliers(
        requireCompany().db,
        z.object({ stockItemId: z.number().int().positive() }).parse(p)
          .stockItemId,
      ),
    "viewer",
  );
  handle(
    "procurement:debitNoteClaims",
    () => procurementService.listDebitNoteClaims(requireCompany().db),
    "viewer",
  );
  handle("procurement:debitNoteDraft", (p) =>
    procurementService.createDebitNoteDraft(
      requireCompany().db,
      z.object({ sourceKey: z.string().trim().min(3).max(120) }).parse(p)
        .sourceKey,
      sessionUser?.name ?? "Local user",
    ),
  );
  handle(
    "procurement:supplierConcentration",
    (p) => {
      const q = periodSchema.parse(p);
      return procurementService.supplierConcentration(
        requireCompany().db,
        q.from,
        q.to,
      );
    },
    "viewer",
  );
  handle(
    "procurement:reorderSuggestions",
    (p) =>
      procurementService.reorderSuggestions(
        requireCompany().db,
        z.object({ asOn: isoDate }).parse(p).asOn,
      ),
    "viewer",
  );
  handle(
    "procurement:reorderCreateOrders",
    (p) => {
      const q = z
        .object({
          asOn: isoDate,
          stockItemIds: z.array(z.number().int().positive()).min(1).max(200),
        })
        .parse(p);
      return procurementService.createReorderPurchaseOrders(
        requireCompany().db,
        q.asOn,
        q.stockItemIds,
        sessionUser?.name ?? "Local user",
      );
    },
    "owner",
  );
  const vendorInput = z.object({
    ledgerId: z.number().int().positive(),
    contactName: z.string().trim().max(120).nullable(),
    email: z.string().trim().max(160).nullable(),
    phone: z.string().trim().max(30).nullable(),
    bankName: z.string().trim().max(120).nullable(),
    bankAccount: z.string().trim().max(40).nullable(),
    ifsc: z.string().trim().max(11).nullable(),
    udyamNumber: z.string().trim().max(24).nullable(),
  });
  handle(
    "procurement:vendors",
    () =>
      vendorService.listVendorProfiles(
        requireCompany().db,
        sessionUser?.role === "viewer",
      ),
    "viewer",
  );
  handle("procurement:vendorSave", (p) =>
    vendorService.saveVendorProfile(
      requireCompany().db,
      vendorInput.parse(p),
      sessionUser?.name ?? "Local user",
    ),
  );
  handle(
    "procurement:vendorStatus",
    (p) => {
      const q = z
        .object({
          ledgerId: z.number().int().positive(),
          status: z.enum(["verified", "blocked", "draft"]),
          note: z.string().trim().max(500).nullable().optional(),
        })
        .parse(p);
      return vendorService.setVendorStatus(
        requireCompany().db,
        q.ledgerId,
        q.status,
        sessionUser?.name ?? "Local user",
        q.note,
      );
    },
    "owner",
  );
  handle("voucher:batchReverse", (p) => {
    const { ids, date, reason } = z
      .object({
        ids: voucherIdsSchema,
        date: isoDate,
        reason: z.string().trim().min(5).max(500),
      })
      .parse(p);
    const c = requireCompany();
    const reversed = voucherWorkflow.reverseVouchers(
      c.db,
      ids,
      date,
      reason,
      sessionUser?.name ?? "Local user",
    );
    if (configSvc.getAgentBridgeEnabled(c.db))
      agentBridge.scheduleMirrorRefresh(c.db, c.slug);
    return reversed;
  });
  handle("voucher:bin", () => vouchers.listBin(requireCompany().db), "viewer");
  handle("voucher:restore", (p) =>
    vouchers.restoreVoucher(requireCompany().db, idSchema.parse(p).id),
  );
  handle(
    "voucher:purge",
    (p) => vouchers.purgeVoucher(requireCompany().db, idSchema.parse(p).id),
    "owner",
  );
  handle("voucher:nextNumber", (p) => {
    const { voucherTypeId, date, excludeId } = z
      .object({
        voucherTypeId: z.number().int().positive(),
        date: z.string(),
        excludeId: z.number().int().positive().optional(),
      })
      .parse(p);
    return {
      number: vouchers.nextVoucherNumber(
        requireCompany().db,
        voucherTypeId,
        date,
        excludeId,
      ),
    };
  });
  handle("voucher:numberExists", (p) => {
    const { voucherTypeId, number, excludeId } = z
      .object({
        voucherTypeId: z.number().int().positive(),
        number: z.string().trim().min(1).max(40),
        excludeId: z.number().int().positive().optional(),
      })
      .parse(p);
    return vouchers.voucherNumberExists(
      requireCompany().db,
      voucherTypeId,
      number,
      excludeId,
    );
  });
  handle("voucher:duplicates", (p) => {
    const { data, excludeId } = z
      .object({
        data: voucherInputSchema,
        excludeId: z.number().int().positive().optional(),
      })
      .parse(p);
    return vouchers.findDuplicates(requireCompany().db, data, excludeId);
  });
  handle("voucher:suspicious", (p) => {
    const data = voucherInputSchema.parse(p);
    return vouchers.findSuspiciousEntry(requireCompany().db, data);
  });

  // ---------- maker-checker ----------
  const approvalPolicySchema = z.object({
    enabled: z.boolean(),
    thresholdPaise: z.number().int().nonnegative().nullable(),
    voucherTypeIds: z.array(z.number().int().positive()).max(100),
    expenseEnabled: z.boolean().default(false),
    expenseThresholdPaise: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .default(null),
  });
  handle(
    "approval:policy:get",
    () => approvals.getApprovalPolicy(requireCompany().db),
    "viewer",
  );
  handle(
    "approval:policy:set",
    (p) =>
      approvals.setApprovalPolicy(
        requireCompany().db,
        approvalPolicySchema.parse(p),
      ),
    "owner",
  );
  const permissionRowSchema = z
    .object({
      view: z.boolean(),
      create: z.boolean(),
      edit: z.boolean(),
      approve: z.boolean(),
      export: z.boolean(),
      backup: z.boolean(),
      settings: z.boolean(),
    })
    .strict();
  const permissionMatrixSchema = z
    .object({
      owner: permissionRowSchema,
      accountant: permissionRowSchema,
      viewer: permissionRowSchema,
    })
    .strict();
  handle(
    "permissions:get",
    () => permissions.getPermissionMatrix(requireCompany().db),
    "viewer",
  );
  handle(
    "permissions:set",
    (p) =>
      permissions.setPermissionMatrix(
        requireCompany().db,
        permissionMatrixSchema.parse(p),
      ),
    "owner",
  );
  handle(
    "approval:list",
    (p) => {
      const { status } = z
        .object({
          status: z
            .enum(["pending", "approved", "rejected"])
            .default("pending"),
        })
        .parse(p ?? {});
      return approvals.listApprovalRequests(requireCompany().db, status);
    },
    "accountant",
  );
  handle(
    "approval:approve",
    (p) => {
      const { id, note } = z
        .object({
          id: z.number().int().positive(),
          note: z.string().trim().max(500).nullable().default(null),
        })
        .parse(p);
      if (!sessionUser) throw new Error("Locked — sign in first");
      return approvals.approveRequest(
        requireCompany().db,
        id,
        sessionUser,
        note,
      );
    },
    "owner",
  );
  handle(
    "approval:reject",
    (p) => {
      const { id, note } = z
        .object({
          id: z.number().int().positive(),
          note: z.string().trim().min(3).max(500),
        })
        .parse(p);
      if (!sessionUser) throw new Error("Locked — sign in first");
      approvals.rejectRequest(requireCompany().db, id, sessionUser, note);
      return null;
    },
    "owner",
  );

  // ---------- review, sign-off and internal controls ----------
  const reviewStatusSchema = z.enum([
    "open",
    "answered",
    "resolved",
    "cancelled",
  ]);
  handle(
    "controls:review:list",
    (p) => {
      const { status } = z
        .object({ status: reviewStatusSchema.optional() })
        .parse(p ?? {});
      return internalControls.listReviewQuestions(requireCompany().db, status);
    },
    "viewer",
  );
  handle("controls:review:create", (p) => {
    const input = z
      .object({
        voucherId: z.number().int().positive(),
        question: z.string().trim().min(3).max(2000),
        assignedToUserId: z.number().int().positive().nullable(),
        dueDate: isoDate.nullable(),
        priority: z.enum(["normal", "high", "urgent"]),
      })
      .parse(p);
    return internalControls.createReviewQuestion(
      requireCompany().db,
      input,
      sessionUser?.name ?? "Local user",
    );
  });
  handle("controls:review:answer", (p) => {
    const { id, answer } = z
      .object({
        id: z.number().int().positive(),
        answer: z.string().trim().min(2).max(4000),
      })
      .parse(p);
    return internalControls.answerReviewQuestion(
      requireCompany().db,
      id,
      answer,
      sessionUser?.name ?? "Local user",
    );
  });
  handle("controls:review:resolve", (p) => {
    const { id } = idSchema.parse(p);
    return internalControls.resolveReviewQuestion(
      requireCompany().db,
      id,
      sessionUser?.name ?? "Local user",
    );
  });

  handle(
    "controls:signoff:get",
    (p) => {
      const { from, to } = periodSchema.parse(p);
      return internalControls.getPeriodSignoff(requireCompany().db, from, to);
    },
    "viewer",
  );
  handle("controls:signoff:prepare", (p) => {
    const input = periodSchema
      .extend({
        outstandingIssues: z.array(z.string().trim().min(1).max(500)).max(100),
        evidence: z.array(z.string().trim().min(1).max(1000)).max(100),
      })
      .parse(p);
    return internalControls.preparePeriodSignoff(
      requireCompany().db,
      input,
      sessionUser?.name ?? "Local user",
    );
  });
  handle(
    "controls:signoff:review",
    (p) => {
      const { from, to, note } = periodSchema
        .extend({ note: z.string().trim().max(1000).default("") })
        .parse(p);
      return internalControls.reviewPeriodSignoff(
        requireCompany().db,
        from,
        to,
        note,
        sessionUser?.name ?? "Local user",
      );
    },
    "owner",
  );
  handle(
    "controls:signoff:reopen",
    (p) => {
      const { from, to, reason } = periodSchema
        .extend({ reason: z.string().trim().min(5).max(1000) })
        .parse(p);
      return internalControls.reopenPeriodSignoff(
        requireCompany().db,
        from,
        to,
        reason,
        sessionUser?.name ?? "Local user",
      );
    },
    "owner",
  );

  const exportPermissionRow = z
    .object({
      pdf: z.boolean(),
      spreadsheet: z.boolean(),
      json_mirror: z.boolean(),
      full_data: z.boolean(),
    })
    .strict();
  const exportPermissionMatrix = z
    .object({
      owner: exportPermissionRow,
      accountant: exportPermissionRow,
      viewer: exportPermissionRow,
    })
    .strict();
  handle(
    "controls:exports:get",
    () => internalControls.getExportPermissions(requireCompany().db),
    "viewer",
  );
  handle(
    "controls:exports:set",
    (p) =>
      internalControls.setExportPermissions(
        requireCompany().db,
        exportPermissionMatrix.parse(p),
      ),
    "owner",
  );
  handle(
    "controls:sessions:list",
    () => internalControls.listSessions(requireCompany().db),
    "owner",
  );

  const policyExceptionStatus = z.enum([
    "pending",
    "approved",
    "rejected",
    "used",
    "cancelled",
  ]);
  handle(
    "controls:exceptions:list",
    (p) => {
      const { status } = z
        .object({ status: policyExceptionStatus.optional() })
        .parse(p ?? {});
      return internalControls.listPolicyExceptions(requireCompany().db, status);
    },
    "accountant",
  );
  handle("controls:exceptions:request", (p) => {
    const input = z
      .object({
        policyKind: z.enum([
          "period_lock",
          "credit_limit",
          "validation_warning",
          "negative_stock",
          "other",
        ]),
        entityType: z.string().trim().min(1).max(80),
        entityId: z.number().int().positive().nullable(),
        reason: z.string().trim().min(5).max(1000),
      })
      .parse(p);
    return internalControls.requestPolicyException(
      requireCompany().db,
      input,
      sessionUser?.name ?? "Local user",
    );
  });
  handle(
    "controls:exceptions:decide",
    (p) => {
      const { id, approved, note } = z
        .object({
          id: z.number().int().positive(),
          approved: z.boolean(),
          note: z.string().trim().max(1000).default(""),
        })
        .parse(p);
      return internalControls.decidePolicyException(
        requireCompany().db,
        id,
        approved,
        note,
        sessionUser?.name ?? "Local user",
      );
    },
    "owner",
  );

  handle(
    "controls:boundaries:list",
    () => internalControls.listBoundaries(requireCompany().db),
    "viewer",
  );
  handle(
    "controls:boundaries:set",
    (p) => {
      const input = z
        .object({
          role: z.enum(["accountant", "viewer"]),
          dimensionKind: z.enum(["cost_centre", "godown", "voucher_type"]),
          dimensionId: z.number().int().positive(),
          allowed: z.boolean(),
        })
        .parse(p);
      return internalControls.setBoundary(
        requireCompany().db,
        input,
        sessionUser?.name ?? "Local user",
      );
    },
    "owner",
  );
  handle(
    "controls:retention:list",
    () => internalControls.listRetentionPolicies(requireCompany().db),
    "owner",
  );
  handle(
    "controls:retention:set",
    (p) => {
      const input = z
        .object({
          evidenceKind: z.enum([
            "attachments",
            "review_questions",
            "signoffs",
            "review_bundles",
            "audit",
          ]),
          keepDays: z.number().int().min(30).max(36500).nullable(),
          warnDays: z.number().int().min(1).max(365),
          purgeRequiresApproval: z.boolean(),
        })
        .parse(p);
      return internalControls.setRetentionPolicy(
        requireCompany().db,
        input,
        sessionUser?.name ?? "Local user",
      );
    },
    "owner",
  );
  handle(
    "controls:report",
    (p) => {
      const { from, to } = periodSchema.parse(p);
      return internalControls.controlReport(requireCompany().db, from, to);
    },
    "viewer",
  );
  handle("export:reviewBundle", async (p) => {
    const { from, to, passphrase } = periodSchema
      .extend({ passphrase: z.string().min(8).max(200) })
      .parse(p);
    const c = requireCompany();
    return internalControls.exportReviewBundle(
      c.db,
      c.slug,
      from,
      to,
      passphrase,
      sessionUser?.name ?? "Local user",
    );
  });

  // ---------- reports ----------
  const reportRequest = <T>(
    payload: unknown,
    task: () => T | Promise<T>,
  ): Promise<T> => {
    const requestId =
      z
        .object({ __totalRequestId: z.string().uuid().optional() })
        .passthrough()
        .parse(payload ?? {}).__totalRequestId ?? randomUUID();
    return backgroundWork.run("report", requestId, task);
  };
  handle(
    "report:dayBook",
    (p) =>
      reportRequest(p, () => {
        const { from, to, includeOutOfBooks } = periodSchema
          .extend({ includeOutOfBooks: z.boolean().optional() })
          .parse(p);
        return reports.dayBook(requireCompany().db, from, to, {
          includeOutOfBooks,
        });
      }),
    "viewer",
  );
  handle(
    "report:ledger",
    (p) =>
      reportRequest(p, () => {
        const { ledgerId, from, to, groupBy } = periodSchema
          .extend({
            ledgerId: z.number().int().positive(),
            groupBy: z.enum(["month"]).optional(),
          })
          .parse(p);
        return reports.ledgerStatement(
          requireCompany().db,
          ledgerId,
          from,
          to,
          groupBy,
        );
      }),
    "viewer",
  );
  handle(
    "report:trialBalance",
    (p) =>
      reportRequest(p, () => {
        const { asOn } = z.object({ asOn: z.string() }).parse(p);
        return reports.trialBalance(requireCompany().db, asOn);
      }),
    "viewer",
  );
  handle(
    "report:profitLoss",
    (p) =>
      reportRequest(p, () => {
        const { from, to, comparePrior } = periodSchema
          .extend({ comparePrior: z.boolean().optional() })
          .parse(p);
        return reports.profitAndLoss(
          requireCompany().db,
          from,
          to,
          comparePrior ? { comparePrior } : undefined,
        );
      }),
    "viewer",
  );
  handle(
    "report:balanceSheet",
    (p) =>
      reportRequest(p, () => {
        const { asOn, comparePrior } = z
          .object({ asOn: z.string(), comparePrior: z.boolean().optional() })
          .parse(p);
        const c = requireCompany();
        return reports.balanceSheet(
          c.db,
          `${c.info.booksFrom}-04-01`,
          asOn,
          comparePrior,
        );
      }),
    "viewer",
  );
  handle(
    "report:stockSummary",
    (p) =>
      reportRequest(p, () => {
        const { asOn } = z.object({ asOn: z.string() }).parse(p);
        return reports.stockSummary(requireCompany().db, asOn);
      }),
    "viewer",
  );
  handle(
    "report:dashboard",
    (p) =>
      reportRequest(p, () => {
        const { today, fyFrom } = z
          .object({ today: z.string(), fyFrom: z.string() })
          .parse(p);
        return reports.dashboard(requireCompany().db, today, fyFrom);
      }),
    "viewer",
  );
  handle(
    "report:cashFlow",
    (p) =>
      reportRequest(p, () => {
        const { from, to } = periodSchema.parse(p);
        return reports.cashFlow(requireCompany().db, from, to);
      }),
    "viewer",
  );
  handle(
    "report:stockAgeing",
    (p) =>
      reportRequest(p, () => {
        const { asOn } = z.object({ asOn: z.string() }).parse(p);
        return reports.stockAgeing(requireCompany().db, asOn);
      }),
    "viewer",
  );
  handle("report:itemProfitability", (p) =>
    reportRequest(p, () => {
      const { from, to } = periodSchema.parse(p);
      return reports.itemProfitability(requireCompany().db, from, to);
    }),
  );
  handle(
    "report:exceptions",
    (p) =>
      reportRequest(p, () => {
        const { from, to } = periodSchema.parse(p);
        return reports.exceptions(requireCompany().db, from, to);
      }),
    "viewer",
  );

  // ---------- consolidated (multi-company, read-only) ----------
  handle(
    "consol:run",
    (p) => {
      const { slugs, kind, from, to, translationRates, eliminations } =
        consolidatedRunSchema.parse(p);
      return consolidated.consolidated(slugs, kind, from, to, {
        translationRates,
        eliminations,
      });
    },
    "viewer",
  );

  // ---------- gst ----------
  const gstPeriodInput = periodSchema.extend({
    period: z.string().regex(/^\d{6}$/),
    registrationId: z.number().int().positive().nullable().optional(),
  });
  const gstReturnInput = gstPeriodInput.extend({
    type: z.enum(["gstr1", "gstr3b"]),
  });
  handle(
    "gst:gstr1",
    (p) => {
      const { from, to, period, registrationId } = gstPeriodInput.parse(p);
      const c = requireCompany();
      const info = complianceOps.companyForGstRegistration(
        c.db,
        c.info,
        registrationId,
      );
      return gst.gstr1(c.db, info, from, to, period, registrationId);
    },
    "viewer",
  );
  handle(
    "gst:gstr3b",
    (p) => {
      const { from, to, period, registrationId } = gstPeriodInput.parse(p);
      const c = requireCompany();
      const info = complianceOps.companyForGstRegistration(
        c.db,
        c.info,
        registrationId,
      );
      return gst.gstr3b(c.db, info, from, to, period, registrationId);
    },
    "viewer",
  );
  handle("gst:exportGstr1", (p) => {
    const { from, to, period, registrationId } = gstPeriodInput.parse(p);
    const c = requireCompany();
    const info = complianceOps.companyForGstRegistration(
      c.db,
      c.info,
      registrationId,
    );
    // Server-side export gate (G7): blocking validation issues refuse the export outright —
    // the renderer disables the button too, but the gate must hold for any caller.
    gst.assertExportable(c.db, info, from, to, registrationId);
    const result = gst.gstr1(c.db, info, from, to, period, registrationId);
    const jsonPath = gst.exportReturnJson(
      c.slug,
      "gstr1",
      period,
      result.json,
      registrationId ? info.gstin : null,
    );
    const csvPath = gst.exportGstr1Csv(c.slug, result);
    gst.freezeGstReturn(c.db, info, "gstr1", from, to, period, registrationId);
    auditExport(c.db, "gstr1", {
      period,
      registrationId: registrationId ?? null,
      path: jsonPath,
    });
    shell.showItemInFolder(jsonPath);
    return { jsonPath, csvPath };
  });
  // ---------- gst rebuild (lane G): validation panel + 3B manual adjustments ----------
  handle(
    "gst:validate",
    (p) => {
      const { from, to, registrationId } = periodSchema
        .extend({
          registrationId: z.number().int().positive().nullable().optional(),
        })
        .parse(p);
      const c = requireCompany();
      const info = complianceOps.companyForGstRegistration(
        c.db,
        c.info,
        registrationId,
      );
      const issues = gst.gstValidate(c.db, info, from, to, registrationId);
      const roundOff = edocs.einvoiceRoundOffIssues(c.db, c.info, from, to);
      return { issues, roundOff };
    },
    "viewer",
  );
  handle(
    "gst:returnStatus",
    (p) => {
      const { type, from, to, period, registrationId } =
        gstReturnInput.parse(p);
      const c = requireCompany();
      const info = complianceOps.companyForGstRegistration(
        c.db,
        c.info,
        registrationId,
      );
      return gst.gstReturnStatus(
        c.db,
        info,
        type,
        from,
        to,
        period,
        registrationId,
      );
    },
    "viewer",
  );
  handle("gst:returnFreeze", (p) => {
    const { type, from, to, period, registrationId } = gstReturnInput.parse(p);
    const c = requireCompany();
    const info = complianceOps.companyForGstRegistration(
      c.db,
      c.info,
      registrationId,
    );
    return gst.freezeGstReturn(
      c.db,
      info,
      type,
      from,
      to,
      period,
      registrationId,
    );
  });
  handle("gst:returnAcknowledge", (p) => {
    const {
      type,
      from,
      to,
      period,
      registrationId,
      arn,
      filedAt,
      submittedJson,
    } = gstReturnInput
      .extend({
        arn: z
          .string()
          .trim()
          .min(8)
          .max(40)
          .regex(/^[A-Za-z0-9/-]+$/),
        filedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        submittedJson: z.string().max(5_000_000).nullable(),
      })
      .parse(p);
    const c = requireCompany();
    const info = complianceOps.companyForGstRegistration(
      c.db,
      c.info,
      registrationId,
    );
    return gst.acknowledgeGstReturn(
      c.db,
      info,
      type,
      from,
      to,
      period,
      { arn, filedAt, submittedJson },
      registrationId,
    );
  });
  handle(
    "gst:3bManualGet",
    (p) => {
      const { period, registrationId } = z
        .object({
          period: z.string().regex(/^\d{6}$/),
          registrationId: z.number().int().positive().nullable().optional(),
        })
        .parse(p);
      return configSvc.getGst3bManual(
        requireCompany().db,
        period,
        registrationId,
      );
    },
    "viewer",
  );
  handle("gst:3bManualSet", (p) => {
    const { period, data, registrationId } = z
      .object({
        period: z.string().regex(/^\d{6}$/),
        registrationId: z.number().int().positive().nullable().optional(),
        data: gst3bManualSchema,
      })
      .parse(p);
    return configSvc.setGst3bManual(
      requireCompany().db,
      period,
      data,
      registrationId,
    );
  });
  handle("gst:exportGstr3b", (p) => {
    const { from, to, period, registrationId } = gstPeriodInput.parse(p);
    const c = requireCompany();
    const info = complianceOps.companyForGstRegistration(
      c.db,
      c.info,
      registrationId,
    );
    // Same server-side gate as gst:exportGstr1 — 3B is computed from the same extracted
    // documents, so a period with blocking validation issues must not export either return.
    gst.assertExportable(c.db, info, from, to, registrationId);
    const result = gst.gstr3b(c.db, info, from, to, period, registrationId);
    const jsonPath = gst.exportReturnJson(
      c.slug,
      "gstr3b",
      period,
      result.json,
      registrationId ? info.gstin : null,
    );
    gst.freezeGstReturn(c.db, info, "gstr3b", from, to, period, registrationId);
    auditExport(c.db, "gstr3b", {
      period,
      registrationId: registrationId ?? null,
      path: jsonPath,
    });
    shell.showItemInFolder(jsonPath);
    return { jsonPath };
  });
  handle(
    "gst:recon2b",
    (p) => {
      const { jsonText, from, to } = gstr2bSchema.parse(p);
      return gst.recon2b(requireCompany().db, jsonText, from, to);
    },
    "viewer",
  );
  handle("gst:recon2bSave", (p) => {
    const { jsonText, fileName, from, to, period } = gstr2bSchema
      .extend({
        fileName: z.string().trim().max(255).nullable().optional(),
        period: z.string().regex(/^\d{6}$/),
      })
      .parse(p);
    return complianceOps.saveGst2bImport(
      requireCompany().db,
      { jsonText, fileName, from, to, period },
      sessionUser?.name ?? "Local user",
    );
  });
  handle(
    "gst:recon2bImports",
    (p) => {
      const { period } = z
        .object({
          period: z
            .string()
            .regex(/^\d{6}$/)
            .optional(),
        })
        .parse(p ?? {});
      return complianceOps.listGst2bImports(requireCompany().db, period);
    },
    "viewer",
  );
  handle(
    "gst:itcActions",
    (p) => {
      const { period } = z
        .object({
          period: z
            .string()
            .regex(/^\d{6}$/)
            .optional(),
        })
        .parse(p ?? {});
      return complianceOps.listItcActions(requireCompany().db, period);
    },
    "viewer",
  );
  handle("gst:itcActionUpdate", (p) => {
    const parsed = z
      .object({
        id: z.number().int().positive(),
        classification: z.enum([
          "missing",
          "mismatched",
          "blocked",
          "reversed",
          "follow_up",
        ]),
        status: z.enum(["open", "waiting_supplier", "resolved", "dismissed"]),
        owner: z.string().trim().max(80).nullable(),
        dueDate: isoDate.nullable(),
        note: z.string().trim().max(2000).nullable(),
      })
      .parse(p);
    return complianceOps.updateItcAction(
      requireCompany().db,
      parsed.id,
      parsed,
      sessionUser?.name ?? "Local user",
    );
  });
  handle(
    "gst:registrations",
    () => complianceOps.listGstRegistrations(requireCompany().db),
    "viewer",
  );
  handle(
    "gst:registrationSave",
    (p) => {
      const data = z
        .object({
          id: z.number().int().positive().optional(),
          gstin: z.string().trim().min(15).max(15),
          legalName: z.string().trim().min(1).max(160),
          stateCode: z.string().regex(/^\d{2}$/),
          address: z.string().trim().min(1).max(1000),
          registrationType: z.enum(["regular", "composition"]),
          isPrimary: z.boolean(),
          active: z.boolean(),
          invoicePrefix: z.string().trim().max(16),
        })
        .parse(p);
      return complianceOps.saveGstRegistration(
        requireCompany().db,
        data,
        sessionUser?.name ?? "Local user",
      );
    },
    "owner",
  );
  handle(
    "gst:registrationSeries",
    (p) => {
      const { registrationId } = z
        .object({ registrationId: z.number().int().positive().optional() })
        .parse(p ?? {});
      return complianceOps.listGstRegistrationSeries(
        requireCompany().db,
        registrationId,
      );
    },
    "viewer",
  );
  handle(
    "gst:registrationSeriesSave",
    (p) => {
      const data = z
        .object({
          registrationId: z.number().int().positive(),
          voucherTypeId: z.number().int().positive(),
          prefix: z.string().trim().max(24),
          suffix: z.string().trim().max(24),
          padWidth: z.number().int().min(0).max(8),
          restartFy: z.boolean(),
        })
        .parse(p);
      return complianceOps.saveGstRegistrationSeries(
        requireCompany().db,
        data,
        sessionUser?.name ?? "Local user",
      );
    },
    "owner",
  );
  handle(
    "gst:luts",
    (p) => {
      const { registrationId } = z
        .object({ registrationId: z.number().int().positive().optional() })
        .parse(p ?? {});
      return complianceOps.listLutAuthorizations(
        requireCompany().db,
        registrationId,
      );
    },
    "viewer",
  );
  handle(
    "gst:lutSave",
    (p) => {
      const data = z
        .object({
          registrationId: z.number().int().positive(),
          fyStartYear: z.number().int().min(2000).max(2200),
          arn: z.string().trim().min(1).max(80),
          filedDate: isoDate,
          validFrom: isoDate,
          validTo: isoDate,
          note: z.string().trim().max(2000).nullable(),
        })
        .parse(p);
      return complianceOps.saveLutAuthorization(
        requireCompany().db,
        data,
        sessionUser?.name ?? "Local user",
      );
    },
    "owner",
  );
  handle(
    "gst:taxPacks",
    () => complianceOps.listTaxContentPacks(requireCompany().db),
    "viewer",
  );
  handle(
    "gst:taxPackInstall",
    (p) => {
      const data = z
        .object({
          packKey: z.string().trim().min(1).max(80),
          version: z.string().trim().min(1).max(40),
          effectiveFrom: isoDate,
          effectiveTo: isoDate.nullable().optional(),
          title: z.string().trim().min(1).max(160),
          content: z.record(z.string(), z.unknown()),
          sourceUrl: z.string().url().max(1000).nullable().optional(),
        })
        .parse(p);
      return complianceOps.installTaxContentPack(
        requireCompany().db,
        data,
        sessionUser?.name ?? "Local user",
      );
    },
    "owner",
  );
  handle("gst:noticePack", (p) => {
    const { from, to } = periodSchema.parse(p);
    const c = requireCompany();
    const result = complianceOps.exportNoticeEvidencePack(
      c.db,
      c.info,
      c.slug,
      from,
      to,
      sessionUser?.name ?? "Local user",
    );
    shell.showItemInFolder(result.manifestPath);
    return result;
  });
  handle(
    "gst:recon2bPickFile",
    async () => {
      const picked = await dialog.showOpenDialog({
        title: "Choose a GSTR-2B JSON (downloaded from the GST portal)",
        filters: [{ name: "GSTR-2B JSON", extensions: ["json"] }],
        properties: ["openFile"],
      });
      if (picked.canceled || !picked.filePaths[0]) return null;
      const jsonText = readFileSync(picked.filePaths[0], "utf8");
      return {
        jsonText,
        fileName: picked.filePaths[0].split("/").pop() ?? "gstr2b.json",
      };
    },
    "viewer",
  );

  // ---------- analysis ----------
  handle(
    "analysis:register",
    (p) => {
      const { kind, from, to, granularity } = periodSchema
        .extend({
          kind: z.enum(["sales", "purchase"]),
          granularity: z.enum(["month", "quarter"]).default("month"),
        })
        .parse(p);
      return analysis.registerByPeriod(
        requireCompany().db,
        kind,
        from,
        to,
        granularity,
      );
    },
    "viewer",
  );
  handle(
    "analysis:outstandings",
    (p) => {
      const { side, asOn } = z
        .object({ side: z.enum(["receivable", "payable"]), asOn: z.string() })
        .parse(p);
      return analysis.outstandings(requireCompany().db, side, asOn);
    },
    "viewer",
  );

  // ---------- management insight workspace ----------
  handle(
    "management:variance",
    (p) => {
      const data = z
        .object({
          currentFrom: isoDate,
          currentTo: isoDate,
          comparisonFrom: isoDate,
          comparisonTo: isoDate,
        })
        .parse(p);
      return managementInsights.varianceExplanation(
        requireCompany().db,
        data.currentFrom,
        data.currentTo,
        data.comparisonFrom,
        data.comparisonTo,
      );
    },
    "viewer",
  );
  handle(
    "management:scenarios",
    () => managementInsights.listManagementScenarios(requireCompany().db),
    "viewer",
  );
  const managementScenarioSchema = z.object({
    name: z.string().trim().min(1).max(120),
    salesGrowthPct: z.number().min(-100).max(1000),
    grossMarginPct: z.number().min(-1000).max(1000).nullable(),
    expenseChangePct: z.number().min(-100).max(1000),
    collectionDaysChange: z.number().int().min(-3650).max(3650),
    paymentDaysChange: z.number().int().min(-3650).max(3650),
    note: z.string().trim().max(2000).nullable(),
  });
  handle("management:scenarioSave", (p) => {
    const { id, data } = z
      .object({
        id: z.number().int().positive().optional(),
        data: managementScenarioSchema,
      })
      .parse(p);
    return managementInsights.saveManagementScenario(
      requireCompany().db,
      data,
      sessionUser?.name ?? "Local user",
      id,
    );
  });
  handle(
    "management:scenarioDelete",
    (p) => {
      const { id } = idSchema.parse(p);
      managementInsights.deleteManagementScenario(requireCompany().db, id);
      return null;
    },
    "owner",
  );
  handle(
    "management:scenarioProjection",
    (p) => {
      const { from, to, data } = z
        .object({ from: isoDate, to: isoDate, data: managementScenarioSchema })
        .parse(p);
      return managementInsights.scenarioProjection(
        requireCompany().db,
        from,
        to,
        data,
      );
    },
    "viewer",
  );
  handle(
    "management:annotations",
    (p) => {
      const { reportKey, from, to } = z
        .object({
          reportKey: z.string().trim().min(1).max(100),
          from: isoDate,
          to: isoDate,
        })
        .parse(p);
      return managementInsights.listReportAnnotations(
        requireCompany().db,
        reportKey,
        from,
        to,
      );
    },
    "viewer",
  );
  handle("management:annotationSave", (p) => {
    const data = z
      .object({
        reportKey: z.string().trim().min(1).max(100),
        rowKey: z.string().trim().max(200),
        from: isoDate,
        to: isoDate,
        note: z.string().trim().min(1).max(4000),
        includeInExport: z.boolean(),
      })
      .parse(p);
    return managementInsights.saveReportAnnotation(
      requireCompany().db,
      data,
      sessionUser?.name ?? "Local user",
    );
  });
  handle(
    "management:scheduleMappings",
    () => managementInsights.listScheduleIiiMappings(requireCompany().db),
    "viewer",
  );
  handle(
    "management:scheduleMappingSave",
    (p) => {
      const data = z
        .object({
          groupId: z.number().int().positive(),
          side: z.enum(["equity_liability", "asset", "income", "expense"]),
          section: z.string().trim().min(1).max(160),
          noteCode: z.string().trim().max(40).nullable(),
          sortOrder: z.number().int().min(0).max(10000),
        })
        .parse(p);
      return managementInsights.saveScheduleIiiMapping(
        requireCompany().db,
        data,
        sessionUser?.name ?? "Local user",
      );
    },
    "owner",
  );
  handle(
    "management:scheduleStatement",
    (p) => {
      const { asOn, priorAsOn } = z
        .object({ asOn: isoDate, priorAsOn: isoDate })
        .parse(p);
      return managementInsights.scheduleIiiStatement(
        requireCompany().db,
        asOn,
        priorAsOn,
      );
    },
    "viewer",
  );

  handle(
    "collections:queue",
    (p) => {
      const { asOn } = z.object({ asOn: isoDate }).parse(p);
      return collections.collectionQueue(requireCompany().db, asOn);
    },
    "viewer",
  );
  handle(
    "collections:promises",
    (p) => {
      const { ledgerId } = z
        .object({ ledgerId: z.number().int().positive().optional() })
        .parse(p ?? {});
      return collections.listPromises(requireCompany().db, ledgerId);
    },
    "viewer",
  );
  handle("collections:promiseSave", (p) => {
    const input = z
      .object({
        ledgerId: z.number().int().positive(),
        amount: z.number().int().positive(),
        promisedDate: isoDate,
        owner: z.string().trim().min(1).max(100),
        note: z.string().trim().max(500).nullable(),
      })
      .parse(p);
    return collections.savePromise(requireCompany().db, input);
  });
  handle("collections:promiseResolve", (p) => {
    const { id, status, outcomeNote } = z
      .object({
        id: z.number().int().positive(),
        status: z.enum(["kept", "broken", "cancelled"]),
        outcomeNote: z.string().trim().max(500).nullable(),
      })
      .parse(p);
    return collections.resolvePromise(
      requireCompany().db,
      id,
      status,
      outcomeNote,
    );
  });
  handle("collections:workspace", (p) => { const { ledgerId, asOn } = z.object({ ledgerId: z.number().int().positive(), asOn: isoDate }).parse(p); return collections.customerWorkspace(requireCompany().db, ledgerId, asOn) }, "viewer");
  const collectionSettingsSchema = z.object({ owner: z.string().trim().max(100), reminderDays: z.array(z.number().int().min(1).max(365)).min(1).max(12), earlyDiscountBps: z.number().int().min(0).max(5000), earlyDays: z.number().int().min(0).max(365) });
  handle("collections:settingsSave", (p) => { const { ledgerId, settings } = z.object({ ledgerId: z.number().int().positive(), settings: collectionSettingsSchema }).parse(p); return collections.saveCustomerSettings(requireCompany().db, ledgerId, settings, sessionUser?.name ?? "Local user") });
  handle("collections:disputeOpen", (p) => { const input = z.object({ ledgerId: z.number().int().positive(), voucherId: z.number().int().positive(), reason: z.string().trim().min(1).max(500), owner: z.string().trim().min(1).max(100) }).parse(p); collections.openDispute(requireCompany().db, input.ledgerId, input.voucherId, input.reason, input.owner); return null });
  handle("collections:disputeResolve", (p) => { const { id, resolution } = z.object({ id: z.number().int().positive(), resolution: z.string().trim().min(1).max(500) }).parse(p); collections.resolveDispute(requireCompany().db, id, resolution); return null });
  handle("collections:noteAdd", (p) => { const { ledgerId, body } = z.object({ ledgerId: z.number().int().positive(), body: z.string().trim().min(1).max(2000) }).parse(p); collections.addCollectionNote(requireCompany().db, ledgerId, body, sessionUser?.name ?? "Local user"); return null });
  handle("collections:reminderDraft", (p) => { const input = z.object({ ledgerId: z.number().int().positive(), voucherId: z.number().int().positive().nullable(), channel: z.enum(["email", "whatsapp", "phone"]), body: z.string().trim().min(1).max(5000), dueDate: isoDate }).parse(p); collections.draftReminder(requireCompany().db, input.ledgerId, input.voucherId, input.channel, input.body, input.dueDate, sessionUser?.name ?? "Local user"); return null });
  handle("collections:receiptSuggestions", (p) => { const input = z.object({ amount: z.number().int().positive(), date: isoDate, reference: z.string().trim().max(200), payer: z.string().trim().max(200) }).parse(p); return collections.receiptSuggestions(requireCompany().db, input) }, "viewer");
  handle("collections:ownerWorkload", (p) => { const { asOn } = z.object({ asOn: isoDate }).parse(p); return collections.ownerWorkload(requireCompany().db, asOn) }, "viewer");
  handle(
    "payables:queue",
    (p) => {
      const { asOn } = z.object({ asOn: isoDate }).parse(p);
      return payables.supplierDueQueue(requireCompany().db, asOn);
    },
    "viewer",
  );
  handle(
    "payables:advances",
    (p) =>
      analysis.supplierAdvances(
        requireCompany().db,
        z.object({ asOn: isoDate }).parse(p).asOn,
      ),
    "viewer",
  );
  const paymentRunBillSchema = z.object({
    partyLedgerId: z.number().int().positive(),
    billNumber: z.string().trim().min(1).max(120),
    billDate: isoDate,
    amount: z.number().int().positive(),
  });
  const paymentRunDraftSchema = z.object({
    bankLedgerId: z.number().int().positive(),
    date: isoDate,
    note: z.string().trim().max(500).nullable().default(null),
    bills: z.array(paymentRunBillSchema).min(1).max(500),
  });
  handle(
    "paymentRun:accounts",
    (p) => {
      const { asOn } = z.object({ asOn: isoDate }).parse(p);
      return paymentRuns.paymentAccounts(requireCompany().db, asOn);
    },
    "viewer",
  );
  handle(
    "paymentRun:preview",
    (p) => {
      const input = paymentRunDraftSchema.parse(p);
      return paymentRuns.previewPaymentRun(
        requireCompany().db,
        input.bankLedgerId,
        input.date,
        input.bills,
      );
    },
    "viewer",
  );
  handle(
    "paymentRun:list",
    () => paymentRuns.listPaymentRuns(requireCompany().db),
    "viewer",
  );
  handle("paymentRun:create", (p) =>
    paymentRuns.createPaymentRun(
      requireCompany().db,
      paymentRunDraftSchema.parse(p),
      sessionUser?.name ?? "Local user",
    ),
  );
  handle(
    "paymentRun:post",
    (p) =>
      paymentRuns.postPaymentRun(
        requireCompany().db,
        idSchema.parse(p).id,
        sessionUser?.name ?? "Local user",
      ),
    "owner",
  );
  handle("paymentRun:cancel", (p) =>
    paymentRuns.cancelPaymentRun(
      requireCompany().db,
      idSchema.parse(p).id,
      sessionUser?.name ?? "Local user",
    ),
  );
  const paymentFileSchema = z.object({
    id: z.number().int().positive(),
    format: z.enum(["generic_neft", "hdfc_bulk", "icici_bulk"]),
  });
  handle(
    "paymentRun:filePreview",
    (p) => {
      const input = paymentFileSchema.parse(p);
      return paymentRuns.paymentFilePreview(
        requireCompany().db,
        input.id,
        input.format,
      );
    },
    "viewer",
  );
  handle("paymentRun:fileExport", (p) => {
    const input = paymentFileSchema.parse(p);
    const c = requireCompany();
    const result = paymentRuns.paymentFileCsv(c.db, input.id, input.format);
    const path = join(companyExportsDir(c.slug), result.filename);
    writeFileSync(path, result.csv, "utf8");
    writeAudit(c.db, "export", input.id, "export", null, {
      kind: "payment_file",
      format: input.format,
      rows: result.preview.rows.length,
      totalAmount: result.preview.totalAmount,
    });
    shell.showItemInFolder(path);
    return {
      path,
      rows: result.preview.rows.length,
      totalAmount: result.preview.totalAmount,
    };
  });
  const taskInputSchema = z.object({
    title: z.string().trim().min(1).max(160),
    note: z.string().trim().max(2000).nullable().default(null),
    dueDate: isoDate.nullable().default(null),
    priority: z.enum(["low", "normal", "high"]).default("normal"),
    assignedTo: z.string().trim().max(80).nullable().default(null),
    linkType: z
      .enum(["none", "voucher", "ledger", "screen", "gst_return"])
      .default("none"),
    linkKey: z.string().trim().max(120).nullable().default(null),
  });
  handle(
    "task:list",
    (p) => {
      const { status } = z
        .object({ status: z.enum(["open", "done", "cancelled"]).optional() })
        .parse(p ?? {});
      return taskService.listTasks(requireCompany().db, status);
    },
    "viewer",
  );
  handle("task:save", (p) => {
    const { id, data } = z
      .object({
        id: z.number().int().positive().optional(),
        data: taskInputSchema,
      })
      .parse(p);
    return taskService.saveTask(
      requireCompany().db,
      data,
      sessionUser?.name ?? "Local user",
      id,
    );
  });
  handle("task:complete", (p) =>
    taskService.setTaskStatus(
      requireCompany().db,
      idSchema.parse(p).id,
      "done",
      sessionUser?.name ?? "Local user",
    ),
  );
  handle("task:cancel", (p) =>
    taskService.setTaskStatus(
      requireCompany().db,
      idSchema.parse(p).id,
      "cancelled",
      sessionUser?.name ?? "Local user",
    ),
  );

  // ---------- outstanding bills (party picker for receipt/payment "settle against") ----------
  handle(
    "bills:open",
    (p) => {
      const { partyLedgerId, asOn } = billsOpenSchema.parse(p);
      return analysis.openBills(requireCompany().db, partyLedgerId, asOn);
    },
    "viewer",
  );

  // ---------- TDS ----------
  handle("tds:sections", () => tds.listSections(requireCompany().db), "viewer");
  handle(
    "tds:sectionSave",
    (p) => tds.saveSection(requireCompany().db, tdsSectionInputSchema.parse(p)),
    "owner",
  );
  handle("tds:suggest", (p) => {
    const { partyLedgerId, base, date } = tdsSuggestSchema.parse(p);
    return tds.tdsSuggestion(requireCompany().db, partyLedgerId, base, date);
  });
  handle(
    "tds:summary",
    (p) => {
      const { fyStartYear } = tdsSummarySchema.parse(p);
      return tds.tdsSummary(requireCompany().db, fyStartYear);
    },
    "viewer",
  );
  handle("tds:export26q", (p) => {
    const { fyStartYear, quarter } = tdsExport26qSchema.parse(p);
    const c = requireCompany();
    const path = tds.export26qCsv(
      c.db,
      c.info,
      c.slug,
      fyStartYear,
      quarter as 1 | 2 | 3 | 4,
    );
    auditExport(c.db, "tds_26q", { fyStartYear, quarter, path });
    shell.showItemInFolder(path);
    return { path };
  });
  handle(
    "tds:workspace",
    (p) => {
      const { fyStartYear, quarter } = tdsExport26qSchema.parse(p);
      return complianceOps.tdsWorkspace(
        requireCompany().db,
        fyStartYear,
        quarter as 1 | 2 | 3 | 4,
      );
    },
    "viewer",
  );
  handle("tds:challanAdd", (p) => {
    const data = z
      .object({
        fyStartYear: z.number().int().min(2000).max(2200),
        quarter: z.number().int().min(1).max(4),
        bsrCode: z.string().regex(/^\d{7}$/),
        challanSerial: z.string().regex(/^\d{1,8}$/),
        depositDate: isoDate,
        amount: z.number().int().positive(),
        note: z.string().trim().max(1000).nullable(),
      })
      .parse(p);
    return complianceOps.addTdsChallan(
      requireCompany().db,
      data,
      sessionUser?.name ?? "Local user",
    );
  });
  handle("tds:returnStatusSet", (p) => {
    const data = z
      .object({
        fyStartYear: z.number().int().min(2000).max(2200),
        quarter: z.number().int().min(1).max(4),
        status: z.enum(["draft", "prepared", "filed", "revised"]),
        token: z.string().trim().max(80).nullable(),
        filedAt: isoDate.nullable(),
        note: z.string().trim().max(1000).nullable(),
      })
      .parse(p);
    return complianceOps.setTdsReturnStatus(
      requireCompany().db,
      data.fyStartYear,
      data.quarter as 1 | 2 | 3 | 4,
      data.status,
      data.token,
      data.filedAt,
      data.note,
      sessionUser?.name ?? "Local user",
    );
  });

  handle(
    "compliance:list",
    (p) => {
      const data = z
        .object({ from: isoDate.optional(), to: isoDate.optional() })
        .parse(p ?? {});
      return complianceOps.listComplianceObligations(
        requireCompany().db,
        data.from,
        data.to,
      );
    },
    "viewer",
  );
  handle("compliance:sync", (p) => {
    const { today } = z.object({ today: isoDate }).parse(p);
    const c = requireCompany();
    return complianceOps.syncComplianceCalendar(
      c.db,
      c.info,
      today,
      configSvc.getFeatures(c.db).payroll,
      sessionUser?.name ?? "Local user",
    );
  });
  handle("compliance:save", (p) => {
    const data = z
      .object({
        id: z.number().int().positive().optional(),
        title: z.string().trim().min(1).max(180),
        dueDate: isoDate,
        kind: z.enum([
          "gst",
          "tds",
          "pf",
          "esi",
          "advance-tax",
          "state",
          "custom",
        ]),
        status: z.enum([
          "open",
          "in_progress",
          "filed",
          "paid",
          "not_applicable",
        ]),
        owner: z.string().trim().max(80).nullable().optional(),
        note: z.string().trim().max(1000).nullable().optional(),
      })
      .parse(p);
    return complianceOps.saveComplianceObligation(
      requireCompany().db,
      data,
      sessionUser?.name ?? "Local user",
    );
  });

  // ---------- cost centres ----------
  handle(
    "cc:list",
    () => costCentres.listCostCentres(requireCompany().db),
    "viewer",
  );
  handle("cc:save", (p) => {
    const { id, data } = z
      .object({
        id: z.number().int().positive().optional(),
        data: costCentreInputSchema,
      })
      .parse(p);
    return costCentres.saveCostCentre(requireCompany().db, data, id);
  });
  handle("cc:delete", (p) =>
    costCentres.deleteCostCentre(requireCompany().db, idSchema.parse(p).id),
  );
  handle(
    "cc:report",
    (p) => {
      const { from, to } = periodSchema.parse(p);
      return costCentres.ccReport(requireCompany().db, from, to);
    },
    "viewer",
  );
  handle(
    "cc:statement",
    (p) => {
      const { ccId, from, to } = ccStatementSchema.parse(p);
      return costCentres.ccStatement(requireCompany().db, ccId, from, to);
    },
    "viewer",
  );

  // ---------- budgets ----------
  handle(
    "budget:list",
    () => budgets.listBudgets(requireCompany().db),
    "viewer",
  );
  handle("budget:save", (p) => {
    const { id, data } = z
      .object({
        id: z.number().int().positive().optional(),
        data: budgetInputSchema,
      })
      .parse(p);
    return budgets.saveBudget(requireCompany().db, data, id);
  });
  handle("budget:delete", (p) =>
    budgets.deleteBudget(requireCompany().db, idSchema.parse(p).id),
  );
  handle(
    "budget:variance",
    (p) => {
      const { budgetId, upToMonth } = budgetVarianceSchema.parse(p);
      return budgets.budgetVarianceReport(
        requireCompany().db,
        budgetId,
        upToMonth,
      );
    },
    "viewer",
  );

  // ---------- recurring vouchers ----------
  handle(
    "recurring:list",
    () => recurring.listTemplates(requireCompany().db),
    "viewer",
  );
  handle("recurring:save", (p) => {
    const { id, data } = z
      .object({
        id: z.number().int().positive().optional(),
        data: recurringInputSchema,
      })
      .parse(p);
    return recurring.saveTemplate(requireCompany().db, data, id);
  });
  handle("recurring:delete", (p) =>
    recurring.deleteTemplate(requireCompany().db, idSchema.parse(p).id),
  );
  handle(
    "recurring:due",
    (p) => {
      const { today } = z.object({ today: isoDate }).parse(p);
      return recurring.due(requireCompany().db, today);
    },
    "viewer",
  );
  handle("recurring:post", (p) => {
    const { id, date } = z
      .object({ id: z.number().int().positive(), date: isoDate })
      .parse(p);
    return recurring.postFromTemplate(requireCompany().db, id, date);
  });
  handle("recurring:skip", (p) =>
    recurring.skip(requireCompany().db, idSchema.parse(p).id),
  );

  // ---------- banking ----------
  handle(
    "bank:ledgers",
    () => banking.bankLedgers(requireCompany().db),
    "viewer",
  );
  handle(
    "bank:recon",
    (p) => {
      const { ledgerId, from, to } = periodSchema
        .extend({ ledgerId: z.number().int().positive() })
        .parse(p);
      return banking.bankRecon(requireCompany().db, ledgerId, from, to);
    },
    "viewer",
  );
  handle("bank:setBankDate", (p) => {
    const { lineId, bankDate } = z
      .object({
        lineId: z.number().int().positive(),
        bankDate: z.string().nullable(),
      })
      .parse(p);
    banking.setBankDate(requireCompany().db, lineId, bankDate);
    return null;
  });
  handle(
    "bank:workspace",
    (p) => {
      const { ledgerId } = z
        .object({ ledgerId: z.number().int().positive() })
        .parse(p);
      return banking.reconciliationWorkspace(requireCompany().db, ledgerId);
    },
    "viewer",
  );
  handle("bank:classifyRow", (p) => {
    const { id, status, note } = z
      .object({
        id: z.number().int().positive(),
        status: z.enum(["bank_only", "ignored", "timing_difference"]),
        note: z.string().trim().max(500).nullable().optional(),
      })
      .parse(p);
    banking.classifyStatementRow(
      requireCompany().db,
      id,
      status,
      note ?? null,
      sessionUser?.name ?? "Local user",
    );
    return null;
  });
  handle(
    "bank:transferSuggestions",
    () => banking.transferSuggestions(requireCompany().db),
    "viewer",
  );
  handle("bank:postTransfer", (p) => {
    const { withdrawalRowId, depositRowId } = z
      .object({
        withdrawalRowId: z.number().int().positive(),
        depositRowId: z.number().int().positive(),
      })
      .parse(p);
    return banking.postTransfer(
      requireCompany().db,
      withdrawalRowId,
      depositRowId,
      sessionUser?.name ?? "Local user",
    );
  });
  handle(
    "bank:chargeSuggestions",
    () => banking.chargeExtractionSuggestions(requireCompany().db),
    "viewer",
  );
  handle("bank:postChargeExtraction", (p) => {
    const input = z
      .object({
        statementRowId: z.number().int().positive(),
        settlementLineId: z.number().int().positive(),
        feeLedgerId: z.number().int().positive(),
        taxLedgerId: z.number().int().positive().nullable(),
        feeAmount: z.number().int().positive(),
        taxAmount: z.number().int().min(0),
      })
      .parse(p);
    return banking.postChargeExtraction(
      requireCompany().db,
      input,
      sessionUser?.name ?? "Local user",
    );
  });
  handle(
    "bank:cheques",
    (p) =>
      banking.chequeLifecycle(
        requireCompany().db,
        z.object({ asOn: isoDate }).parse(p).asOn,
      ),
    "viewer",
  );
  handle("bank:chequeStatus", (p) => {
    const input = z
      .object({
        voucherId: z.number().int().positive(),
        status: z.enum([
          "issued",
          "deposited",
          "cleared",
          "bounced",
          "cancelled",
        ]),
        statusDate: isoDate,
        note: z.string().trim().max(500).nullable().optional(),
      })
      .parse(p);
    banking.updateChequeStatus(
      requireCompany().db,
      input.voucherId,
      input.status,
      input.statusDate,
      input.note ?? null,
      sessionUser?.name ?? "Local user",
    );
    return null;
  });
  const denominationSchema = z.object({
    denominationPaise: z.number().int().positive(),
    count: z.number().int().min(0).max(1_000_000),
  });
  handle(
    "bank:cashLedgers",
    () => banking.cashLedgers(requireCompany().db),
    "viewer",
  );
  handle(
    "bank:cashCounts",
    () => banking.listCashCounts(requireCompany().db),
    "viewer",
  );
  handle(
    "bank:cashCountPreview",
    (p) => {
      const input = z
        .object({
          ledgerId: z.number().int().positive(),
          date: isoDate,
          lines: z.array(denominationSchema).max(30),
        })
        .parse(p);
      return banking.cashCountPreview(
        requireCompany().db,
        input.ledgerId,
        input.date,
        input.lines,
      );
    },
    "viewer",
  );
  handle("bank:cashCountSave", (p) => {
    const input = z
      .object({
        ledgerId: z.number().int().positive(),
        date: isoDate,
        lines: z.array(denominationSchema).max(30),
        note: z.string().trim().max(500).nullable().optional(),
      })
      .parse(p);
    return banking.saveCashCount(
      requireCompany().db,
      input.ledgerId,
      input.date,
      input.lines,
      input.note ?? null,
      sessionUser?.name ?? "Local user",
    );
  });
  handle(
    "bank:cashCountPost",
    (p) => {
      const input = z
        .object({
          id: z.number().int().positive(),
          adjustmentLedgerId: z.number().int().positive().nullable(),
        })
        .parse(p);
      return banking.postCashCount(
        requireCompany().db,
        input.id,
        input.adjustmentLedgerId,
        sessionUser?.name ?? "Local user",
      );
    },
    "owner",
  );
  const liquidityEvent = z.object({
    date: isoDate,
    label: z.string().trim().min(1).max(120),
    direction: z.enum(["inflow", "outflow"]),
    amount: z.number().int().positive(),
    kind: z.enum(["purchase", "loan", "tax", "other"]),
  });
  const liquidityScenario = z.object({
    name: z.string().trim().min(1).max(80),
    collectionDelayDays: z.number().int().min(0).max(180),
    collectionRealizationBp: z.number().int().min(0).max(10000),
    paymentDelayDays: z.number().int().min(0).max(180),
    events: z.array(liquidityEvent).max(100),
  });
  handle(
    "treasury:position",
    (p) =>
      treasuryService.dailyPosition(
        requireCompany().db,
        z.object({ asOn: isoDate }).parse(p).asOn,
      ),
    "viewer",
  );
  handle(
    "treasury:forecast",
    (p) => {
      const input = z
        .object({
          asOn: isoDate,
          scenarioId: z.number().int().positive().nullable().optional(),
        })
        .parse(p);
      return treasuryService.forecast(
        requireCompany().db,
        input.asOn,
        input.scenarioId,
      );
    },
    "viewer",
  );
  handle(
    "treasury:scenarios",
    () => treasuryService.listScenarios(requireCompany().db),
    "viewer",
  );
  handle("treasury:scenarioSave", (p) => {
    const input = z
      .object({
        id: z.number().int().positive().optional(),
        data: liquidityScenario,
      })
      .parse(p);
    return treasuryService.saveScenario(
      requireCompany().db,
      input.data,
      sessionUser?.name ?? "Local user",
      input.id,
    );
  });
  handle("treasury:scenarioDelete", (p) => {
    treasuryService.deleteScenario(requireCompany().db, idSchema.parse(p).id);
    return null;
  });
  handle(
    "treasury:alertSettings",
    () => treasuryService.getAlertSettings(requireCompany().db),
    "viewer",
  );
  handle(
    "treasury:alertSettingsSet",
    (p) => {
      const settings = z
        .object({
          minimumLiquidity: z.number().int(),
          idleCashThreshold: z.number().int().min(0),
          sustainedWeeks: z.number().int().min(1).max(13),
        })
        .parse(p);
      return treasuryService.setAlertSettings(requireCompany().db, settings);
    },
    "owner",
  );
  handle(
    "treasury:alerts",
    (p) => {
      const input = z
        .object({
          asOn: isoDate,
          scenarioId: z.number().int().positive().nullable().optional(),
        })
        .parse(p);
      return treasuryService.liquidityAlerts(
        requireCompany().db,
        input.asOn,
        input.scenarioId,
      );
    },
    "viewer",
  );
  handle(
    "bankFeed:list",
    () => bankFeedService.listConnections(requireCompany().db),
    "viewer",
  );
  handle(
    "bankFeed:save",
    (p) => {
      const input = z
        .object({
          id: z.number().int().positive().optional(),
          bankLedgerId: z.number().int().positive(),
          displayName: z.string().trim().min(1).max(80),
          endpoint: z.string().url().max(2048),
          consentExpiresAt: z.string().datetime(),
          accessToken: z.string().trim().min(8).max(4096).optional(),
        })
        .parse(p);
      return bankFeedService.saveConnection(
        requireCompany().db,
        input,
        sessionUser?.name ?? "Local user",
        input.id,
      );
    },
    "owner",
  );
  handle(
    "bankFeed:status",
    (p) => {
      const input = z
        .object({
          id: z.number().int().positive(),
          status: z.enum(["connected", "paused", "revoked"]),
        })
        .parse(p);
      return bankFeedService.setConnectionStatus(
        requireCompany().db,
        input.id,
        input.status,
      );
    },
    "owner",
  );
  handle("bankFeed:sync", async (p) =>
    bankFeedService.syncConnection(
      requireCompany().db,
      idSchema.parse(p).id,
      sessionUser?.name ?? "Local user",
    ),
  );
  handle("bank:importCsv", async (p) => {
    const {
      ledgerId,
      csvText,
      dryRun,
      format: requestedFormat,
      fileName: requestedFileName,
    } = z
      .object({
        ledgerId: z.number().int().positive(),
        csvText: z.string().optional(),
        dryRun: z.boolean().optional(),
        format: z.enum(["csv", "xlsx", "ofx", "qif", "mt940"]).optional(),
        fileName: z.string().trim().max(255).nullable().optional(),
      })
      .parse(p);
    const c = requireCompany();
    let csv = csvText;
    let fileName = requestedFileName ?? undefined;
    let format = requestedFormat ?? "csv";
    if (csv === undefined) {
      const picked = await dialog.showOpenDialog({
        title: "Choose bank statement",
        filters: [
          {
            name: "Bank statements",
            extensions: [
              "csv",
              "txt",
              "xlsx",
              "ofx",
              "qif",
              "sta",
              "mt940",
              "940",
            ],
          },
          { name: "All files", extensions: ["*"] },
        ],
        properties: ["openFile"],
      });
      if (picked.canceled || !picked.filePaths[0]) return null;
      fileName = basename(picked.filePaths[0]);
      const normalized = await normalizeBankStatement(
        fileName,
        readFileSync(picked.filePaths[0]),
      );
      csv = normalized.csvText;
      format = normalized.format;
    }
    // csvText rides back on the response (not just the parsed result) so the renderer — which
    // never sees the picked file's contents when the dialog path is used — can hand the exact
    // same text to banking:suggest (or back to an applying import after a dryRun preview).
    return {
      ...banking.importStatement(c.db, ledgerId, csv, {
        apply: !dryRun,
        actor: sessionUser?.name ?? "Local user",
        fileName,
        format,
      }),
      csvText: csv,
      format,
      fileName: fileName ?? null,
    };
  });
  handle(
    "bankrule:list",
    () => banking.listRules(requireCompany().db),
    "viewer",
  );
  handle("bankrule:save", (p) => {
    const { id, data } = z
      .object({
        id: z.number().int().positive().optional(),
        data: bankRuleInputSchema,
      })
      .parse(p);
    return banking.saveRule(requireCompany().db, data, id);
  });
  handle("bankrule:delete", (p) => {
    banking.deleteRule(requireCompany().db, idSchema.parse(p).id);
    return null;
  });
  handle("bankrule:hit", (p) => {
    banking.recordRuleHit(requireCompany().db, idSchema.parse(p).id);
    return null;
  });
  handle("bankrule:reject", (p) =>
    banking.rejectRuleSuggestion(requireCompany().db, idSchema.parse(p).id),
  );
  handle("bankrule:rollback", (p) =>
    banking.rollbackRule(requireCompany().db, idSchema.parse(p).id),
  );
  handle("banking:suggest", (p) => {
    const { ledgerId, csvText } = z
      .object({ ledgerId: z.number().int().positive(), csvText: z.string() })
      .parse(p);
    return banking.suggestVouchers(requireCompany().db, ledgerId, csvText);
  });
  // statement matching v2 — read-only tolerance/many-to-one suggestions (task Y2)
  handle(
    "banking:matchSuggestions",
    (p) => {
      const { ledgerId, csvText, tolerancePaise } = z
        .object({
          ledgerId: z.number().int().positive(),
          csvText: z.string(),
          tolerancePaise: z.number().int().min(0).max(100_00).optional(),
        })
        .parse(p);
      return banking.matchSuggestions(
        requireCompany().db,
        ledgerId,
        csvText,
        tolerancePaise ?? 100,
      );
    },
    "viewer",
  );
  // bank reconciliation statement (task Y2)
  const brsSchema = z.object({
    ledgerId: z.number().int().positive(),
    asOn: isoDate,
  });
  handle(
    "banking:brs",
    (p) => {
      const { ledgerId, asOn } = brsSchema.parse(p);
      return banking.brs(requireCompany().db, ledgerId, asOn);
    },
    "viewer",
  );
  handle(
    "banking:brsPdf",
    async (p) => {
      const { ledgerId, asOn } = brsSchema.parse(p);
      const c = requireCompany();
      const r = banking.brs(c.db, ledgerId, asOn);
      const money = (paise: number): string => formatPaise(paise);
      const item = (
        i: banking.BrsItem,
      ): { cells: string[]; indent?: number } => ({
        cells: [
          i.date,
          `${i.voucherType} ${i.number}`,
          i.instrumentNo ?? "",
          i.particulars,
          money(i.amount),
        ],
        indent: 1,
      });
      const rows = [
        {
          cells: [
            "",
            "Balance as per company books",
            "",
            "",
            money(r.bookBalance),
          ],
          bold: true,
        },
        {
          cells: [
            "",
            "Less: deposits not yet credited by the bank",
            "",
            "",
            "",
          ],
          bold: true,
        },
        ...r.uncredited.map(item),
        {
          cells: ["", "Total uncredited", "", "", money(r.uncreditedTotal)],
          rule: true,
        },
        {
          cells: ["", "Add: cheques issued but not yet presented", "", "", ""],
          bold: true,
        },
        ...r.unpresented.map(item),
        {
          cells: ["", "Total unpresented", "", "", money(r.unpresentedTotal)],
          rule: true,
        },
        {
          cells: [
            "",
            "Balance as per bank statement",
            "",
            "",
            money(r.bankBalance),
          ],
          bold: true,
          rule: true,
        },
      ];
      const html = reportHtml({
        title: "Bank Reconciliation Statement",
        company: c.info,
        periodLabel: `${r.ledgerName} · as on ${asOn}`,
        columns: [
          { label: "Date", align: "l", width: 90 },
          { label: "Voucher", align: "l", width: 140 },
          { label: "Instrument", align: "l", width: 100 },
          { label: "Particulars", align: "l" },
          { label: "Amount", align: "r", width: 110 },
        ],
        rows,
        provenance: {
          period: `${r.ledgerName} · as on ${asOn}`,
          accountingBasis: "Accrual basis · posted vouchers",
          dataFreshness: "Live local books at export time",
          generatedAt: new Date().toISOString(),
        },
      });
      const path = await writeExportPdf(
        c.slug,
        `brs-${slugify(r.ledgerName)}-${asOn}.pdf`,
        html,
        { pageSize: "A4" },
      );
      return { path };
    },
    "viewer",
  );

  // ---------- e-documents + invoice printing ----------
  handle(
    "edoc:list",
    (p) => {
      const { from, to } = periodSchema.parse(p);
      return edocs.listSalesInvoices(requireCompany().db, from, to);
    },
    "viewer",
  );
  handle(
    "edoc:events",
    (p) => {
      const { voucherId } = z
        .object({ voucherId: z.number().int().positive().optional() })
        .parse(p ?? {});
      return complianceOps.edocEvents(requireCompany().db, voucherId);
    },
    "viewer",
  );
  handle("edoc:eventAdd", (p) => {
    const data = z
      .object({
        voucherId: z.number().int().positive(),
        kind: z.enum(["einvoice", "eway"]),
        status: z.enum([
          "pending",
          "generated",
          "failed",
          "cancelled",
          "extended",
          "vehicle_updated",
          "expired",
        ]),
        requestKey: z.string().trim().max(120).nullable(),
        documentNo: z.string().trim().max(120).nullable(),
        validUntil: isoDate.nullable(),
        vehicleNo: z.string().trim().max(30).nullable(),
        reason: z.string().trim().max(1000).nullable(),
      })
      .parse(p);
    return complianceOps.addEdocEvent(
      requireCompany().db,
      data,
      sessionUser?.name ?? "Local user",
    );
  });
  handle("edoc:exportEInvoice", (p) => {
    const { from, to, period } = gstPeriodInput.parse(p);
    const c = requireCompany();
    const r = edocs.exportEInvoices(c.db, c.info, c.slug, from, to, period);
    auditExport(c.db, "einvoice", { period, path: r.path, count: r.count });
    shell.showItemInFolder(r.path);
    return r;
  });
  handle("edoc:exportEwb", (p) => {
    const { from, to, period, voucherIds, includeBelowThreshold } =
      gstPeriodInput
        .extend({
          voucherIds: z.array(z.number().int().positive()).max(500).optional(),
          includeBelowThreshold: z.boolean().default(false),
        })
        .parse(p);
    const c = requireCompany();
    // Writes the combined bulk file AND one single-bill file per voucher (exports/ewb/<period>/).
    const r = edocs.exportEwb(c.db, c.info, c.slug, from, to, period, {
      voucherIds,
      includeBelowThreshold,
    });
    auditExport(c.db, "ewb", { period, path: r.path, count: r.count });
    shell.showItemInFolder(r.path);
    return r;
  });
  handle("edoc:ewbJson", (p) => {
    const { voucherId } = z
      .object({ voucherId: z.number().int().positive() })
      .parse(p);
    const c = requireCompany();
    const r = edocs.ewbJsonForVoucher(c.db, c.info, c.slug, voucherId);
    shell.showItemInFolder(r.path);
    return r;
  });
  handle(
    "edoc:transportGet",
    (p) => {
      const { voucherId } = z
        .object({ voucherId: z.number().int().positive() })
        .parse(p);
      return edocs.getTransport(requireCompany().db, voucherId);
    },
    "viewer",
  );
  handle("edoc:transportSet", (p) => {
    const { voucherId, data } = z
      .object({
        voucherId: z.number().int().positive(),
        data: voucherTransportSchema,
      })
      .parse(p);
    return edocs.setTransport(requireCompany().db, voucherId, data);
  });
  handle("invoice:pdf", async (p) => {
    const { voucherId } = z
      .object({ voucherId: z.number().int().positive() })
      .parse(p);
    const c = requireCompany();
    const path = await invoice.invoicePdf(c.db, c.info, c.slug, voucherId);
    auditExport(c.db, "invoice_pdf", { voucherId, path });
    shell.openPath(path);
    return { path };
  });
  // ---------- batch invoice printing (lane Q, task Q2 #98) ----------
  handle("invoice:pdfBatch", async (p) => {
    const { voucherIds } = invoicePdfBatchSchema.parse(p);
    const c = requireCompany();
    const r = await invoice.invoicePdfBatch(c.db, c.info, c.slug, voucherIds);
    auditExport(c.db, "invoice_pdf_batch", {
      count: r.paths.length,
      dir: r.dir,
    });
    shell.showItemInFolder(r.paths[0] ?? r.dir);
    return r;
  });

  handle(
    "invoice:previewHtml",
    (p) => {
      const { voucherId, config } = z
        .object({
          voucherId: z.number().int().positive().optional(),
          config: invoiceConfigPartialSchema.optional(),
        })
        .default({})
        .parse(p ?? {});
      const c = requireCompany();
      return invoice.invoicePreviewHtml(c.db, c.info, voucherId, config);
    },
    "viewer",
  );

  // ---------- cheque printing + payment advice (task 2.7) ----------
  const bankLedgerIdSchema = z.object({
    bankLedgerId: z.number().int().positive(),
  });
  handle(
    "cheque:config:get",
    (p) =>
      configSvc.getChequeConfig(
        requireCompany().db,
        bankLedgerIdSchema.parse(p).bankLedgerId,
      ),
    "viewer",
  );
  handle("cheque:config:set", (p) => {
    const { bankLedgerId, config } = z
      .object({
        bankLedgerId: z.number().int().positive(),
        config: chequeConfigSchema,
      })
      .parse(p);
    return configSvc.setChequeConfig(requireCompany().db, bankLedgerId, config);
  });
  handle("cheque:pdf", async (p) => {
    const { voucherId, bankLedgerId } = z
      .object({
        voucherId: z.number().int().positive(),
        bankLedgerId: z.number().int().positive(),
      })
      .parse(p);
    const c = requireCompany();
    // chequePdf itself reveals the file in Finder — a cheque is meant to be loaded into the
    // printer tray and checked for alignment, not opened in a PDF viewer.
    const path = await cheque.chequePdf(
      c.db,
      c.info,
      c.slug,
      voucherId,
      bankLedgerId,
    );
    return { path };
  });
  handle("cheque:testGrid", async (p) => {
    const { bankLedgerId } = bankLedgerIdSchema.parse(p);
    const c = requireCompany();
    const path = await cheque.testGridPdf(c.db, c.info, c.slug, bankLedgerId);
    shell.openPath(path);
    return { path };
  });
  handle("cheque:advice", async (p) => {
    const { voucherId } = z
      .object({ voucherId: z.number().int().positive() })
      .parse(p);
    const c = requireCompany();
    const path = await cheque.paymentAdvicePdf(c.db, c.info, c.slug, voucherId);
    shell.openPath(path);
    return { path };
  });

  // ---------- F11 features + F12 invoice print config ----------
  handle(
    "config:features:get",
    () => configSvc.getFeatures(requireCompany().db),
    "viewer",
  );
  handle(
    "config:features:set",
    (p) => configSvc.setFeatures(requireCompany().db, featuresSchema.parse(p)),
    "owner",
  );
  handle(
    "config:invoice:get",
    () => configSvc.getInvoiceConfig(requireCompany().db),
    "viewer",
  );
  handle(
    "config:invoice:set",
    (p) =>
      configSvc.setInvoiceConfig(
        requireCompany().db,
        invoiceConfigSchema.parse(p),
      ),
    "owner",
  );

  // ---------- currencies + BOM ----------
  handle(
    "currency:list",
    () => extras.listCurrencies(requireCompany().db),
    "viewer",
  );
  handle("currency:create", (p) =>
    extras.createCurrency(requireCompany().db, currencyInputSchema.parse(p)),
  );
  handle("currency:delete", (p) =>
    extras.deleteCurrency(requireCompany().db, idSchema.parse(p).id),
  );
  handle(
    "bom:get",
    (p) =>
      extras.getBom(
        requireCompany().db,
        z.object({ itemId: z.number().int().positive() }).parse(p).itemId,
      ),
    "viewer",
  );
  handle("bom:set", (p) =>
    extras.setBom(requireCompany().db, bomInputSchema.parse(p)),
  );
  handle("bom:items", () => extras.itemsWithBom(requireCompany().db), "viewer");

  // ---------- payroll ----------
  const daysSchema = z.array(
    z.object({
      employeeId: z.number().int().positive(),
      payableDays: z.number().min(0).max(31),
    }),
  );
  const monthSchema = z.string().regex(/^\d{4}-\d{2}$/);
  handle(
    "payroll:employees:list",
    () => {
      const rows = payroll.listEmployees(requireCompany().db);
      if (sessionUser?.role !== "viewer") return rows;
      return rows.map((row) => ({
        ...row,
        pan: row.pan ? `••••••${row.pan.slice(-4)}` : null,
        uan: row.uan ? `••••••${row.uan.slice(-4)}` : null,
        esicNo: row.esicNo ? `••••••${row.esicNo.slice(-4)}` : null,
        basic: 0,
        hra: 0,
        special: 0,
        sensitiveMasked: true,
      }));
    },
    "viewer",
  );
  handle("payroll:employees:save", (p) => {
    const { data, id } = z
      .object({
        data: employeeInputSchema,
        id: z.number().int().positive().optional(),
      })
      .parse(p);
    return payroll.saveEmployee(requireCompany().db, data, id);
  });
  handle("payroll:employees:delete", (p) =>
    payroll.deleteEmployee(requireCompany().db, idSchema.parse(p).id),
  );
  handle("payroll:preview", (p) => {
    const { month, days } = z
      .object({ month: monthSchema, days: daysSchema })
      .parse(p);
    return payroll.previewRun(requireCompany().db, month, days);
  });
  handle(
    "payroll:preflight",
    (p) => {
      const { month, days } = z
        .object({ month: monthSchema, days: daysSchema })
        .parse(p);
      return payrollOperations.payrollPreflight(
        requireCompany().db,
        month,
        days,
      );
    },
    "viewer",
  );
  handle("payroll:commit", (p) => {
    const { month, days } = z
      .object({ month: monthSchema, days: daysSchema })
      .parse(p);
    const preflight = payrollOperations.payrollPreflight(
      requireCompany().db,
      month,
      days,
    );
    if (!preflight.canPost)
      throw new Error(
        `Payroll preflight has ${preflight.issues.filter((issue) => issue.severity === "error").length} blocking issue(s)`,
      );
    return payroll.commitRun(requireCompany().db, month, days);
  });
  handle("payroll:runs", () => payroll.listRuns(requireCompany().db), "viewer");
  handle("payroll:deleteRun", (p) =>
    payroll.deleteRun(requireCompany().db, idSchema.parse(p).id),
  );
  handle(
    "payroll:tieOut",
    (p) =>
      payrollOperations.payrollTieOut(
        requireCompany().db,
        idSchema.parse(p).id,
      ),
    "viewer",
  );
  handle(
    "payroll:lockRun",
    (p) =>
      payrollOperations.lockPayrollRun(
        requireCompany().db,
        idSchema.parse(p).id,
        sessionUser?.name ?? "Owner",
      ),
    "owner",
  );
  const attendanceInputSchema = z.object({
    employeeId: z.number().int().positive(),
    month: monthSchema,
    payableDays: z.number().min(0).max(31),
    presentDays: z.number().min(0).max(31),
    leaveDays: z.number().min(0).max(31),
    unpaidDays: z.number().min(0).max(31),
    overtimeMinutes: z.number().int().nonnegative(),
    status: z.enum(["review", "approved", "exception"]),
    note: z.string().max(500).nullable().optional(),
  });
  handle(
    "payroll:attendance:list",
    (p) =>
      workforce.listAttendance(
        requireCompany().db,
        z.object({ month: monthSchema }).parse(p).month,
      ),
    "viewer",
  );
  handle(
    "payroll:attendance:summary",
    (p) =>
      workforce.attendanceSummary(
        requireCompany().db,
        z.object({ month: monthSchema }).parse(p).month,
      ),
    "viewer",
  );
  handle("payroll:attendance:save", (p) =>
    workforce.saveAttendance(
      requireCompany().db,
      attendanceInputSchema.parse(p),
      sessionUser?.name ?? "Owner",
    ),
  );
  handle(
    "payroll:attendance:previewImport",
    (p) => {
      const data = z
        .object({
          month: monthSchema,
          sourceName: z.string().min(1).max(200),
          csvText: z.string().min(1).max(10_000_000),
        })
        .parse(p);
      return workforce.previewAttendanceImport(
        requireCompany().db,
        data.month,
        data.sourceName,
        data.csvText,
      );
    },
    "viewer",
  );
  handle("payroll:attendance:applyImport", (p) => {
    const data = z
      .object({
        month: monthSchema,
        sourceName: z.string().min(1).max(200),
        csvText: z.string().min(1).max(10_000_000),
      })
      .parse(p);
    return workforce.applyAttendanceImport(
      requireCompany().db,
      data.month,
      data.sourceName,
      data.csvText,
      sessionUser?.name ?? "Owner",
    );
  });
  handle("payroll:attendance:approveMonth", (p) =>
    workforce.approveAttendanceMonth(
      requireCompany().db,
      z.object({ month: monthSchema }).parse(p).month,
      sessionUser?.name ?? "Owner",
    ),
  );
  const leaveTypeSchema = z.object({
    name: z.string().trim().min(1).max(80),
    annualAccrualMilli: z.number().int().nonnegative(),
    carryForwardLimitMilli: z.number().int().nonnegative().nullable(),
    encashable: z.boolean(),
    paid: z.boolean(),
    active: z.boolean(),
  });
  handle(
    "payroll:leaveTypes:list",
    () => workforce.listLeaveTypes(requireCompany().db),
    "viewer",
  );
  handle("payroll:leaveTypes:save", (p) => {
    const { data, id } = z
      .object({
        data: leaveTypeSchema,
        id: z.number().int().positive().optional(),
      })
      .parse(p);
    return workforce.saveLeaveType(requireCompany().db, data, id);
  });
  handle(
    "payroll:leave:transactions",
    (p) =>
      workforce.listLeaveTransactions(
        requireCompany().db,
        z
          .object({ employeeId: z.number().int().positive().optional() })
          .parse(p).employeeId,
      ),
    "viewer",
  );
  handle(
    "payroll:leave:balances",
    (p) =>
      workforce.leaveBalances(
        requireCompany().db,
        z.object({ asOn: isoDate }).parse(p).asOn,
      ),
    "viewer",
  );
  handle("payroll:leave:record", (p) =>
    workforce.recordLeave(
      requireCompany().db,
      z
        .object({
          employeeId: z.number().int().positive(),
          leaveTypeId: z.number().int().positive(),
          date: isoDate,
          qtyMilli: z
            .number()
            .int()
            .refine((value) => value !== 0),
          kind: z.enum([
            "accrual",
            "taken",
            "carry_forward",
            "encashment",
            "adjustment",
          ]),
          status: z.enum(["requested", "approved", "rejected"]),
          note: z.string().max(500).nullable().optional(),
        })
        .parse(p),
      sessionUser?.name ?? "Owner",
    ),
  );
  const revisionHeadSchema = z.object({
    name: z.string().trim().min(1).max(80),
    kind: z.enum(["earning", "deduction"]),
    calc: z.enum(["flat", "percent_of_basic"]),
    value: z.number().int().nonnegative(),
  });
  handle(
    "payroll:salaryRevisions:list",
    (p) =>
      workforce.listSalaryRevisions(
        requireCompany().db,
        z
          .object({ employeeId: z.number().int().positive().optional() })
          .parse(p).employeeId,
      ),
    "viewer",
  );
  handle("payroll:salaryRevisions:save", (p) =>
    workforce.saveSalaryRevision(
      requireCompany().db,
      z
        .object({
          employeeId: z.number().int().positive(),
          effectiveFrom: isoDate,
          heads: z.array(revisionHeadSchema).min(1).max(50),
          reason: z.string().trim().min(1).max(500),
          status: z.enum(["draft", "approved"]),
        })
        .parse(p),
      sessionUser?.name ?? "Owner",
    ),
  );
  handle(
    "payroll:loans:list",
    (p) =>
      workforce.listEmployeeLoans(
        requireCompany().db,
        z
          .object({ employeeId: z.number().int().positive().optional() })
          .parse(p).employeeId,
      ),
    "viewer",
  );
  handle("payroll:loans:create", (p) =>
    workforce.createEmployeeLoan(
      requireCompany().db,
      z
        .object({
          employeeId: z.number().int().positive(),
          disbursedDate: isoDate,
          principal: z.number().int().positive(),
          annualInterestBps: z.number().int().nonnegative(),
          installmentAmount: z.number().int().positive(),
          firstDeductionMonth: monthSchema,
          note: z.string().max(500).nullable().optional(),
        })
        .parse(p),
      sessionUser?.name ?? "Owner",
    ),
  );
  handle("payroll:loans:setInstallment", (p) => {
    const { installmentId, status } = z
      .object({
        installmentId: z.number().int().positive(),
        status: z.enum(["scheduled", "paused", "waived"]),
      })
      .parse(p);
    return workforce.setLoanInstallmentStatus(
      requireCompany().db,
      installmentId,
      status,
      sessionUser?.name ?? "Owner",
    );
  });
  handle(
    "payroll:reimbursements:list",
    (p) =>
      workforce.listReimbursements(
        requireCompany().db,
        z
          .object({
            status: z
              .enum(["submitted", "approved", "rejected", "paid"])
              .optional(),
          })
          .parse(p).status,
      ),
    "viewer",
  );
  handle("payroll:reimbursements:submit", (p) =>
    workforce.submitReimbursement(
      requireCompany().db,
      z
        .object({
          employeeId: z.number().int().positive(),
          claimDate: isoDate,
          category: z.string().trim().min(1).max(100),
          amount: z.number().int().positive(),
          taxable: z.boolean(),
          description: z.string().trim().min(1).max(500),
          attachmentPath: z.string().max(1000).nullable().optional(),
        })
        .parse(p),
    ),
  );
  handle("payroll:reimbursements:decide", (p) => {
    const { id, decision } = z
      .object({
        id: z.number().int().positive(),
        decision: z.enum(["approved", "rejected"]),
      })
      .parse(p);
    return workforce.decideReimbursement(
      requireCompany().db,
      id,
      decision,
      sessionUser?.name ?? "Owner",
    );
  });
  handle("payroll:reimbursements:pay", (p) => {
    const { id, date, bankLedgerId } = z
      .object({
        id: z.number().int().positive(),
        date: isoDate,
        bankLedgerId: z.number().int().positive(),
      })
      .parse(p);
    return workforce.payReimbursement(
      requireCompany().db,
      id,
      { date, bankLedgerId },
      sessionUser?.name ?? "Owner",
    );
  });
  handle(
    "payroll:contractors:list",
    () => workforce.listContractors(requireCompany().db),
    "viewer",
  );
  handle("payroll:contractors:save", (p) => {
    const { data, id } = z
      .object({
        data: z.object({
          name: z.string().trim().min(1).max(150),
          pan: z.string().max(20).nullable().optional(),
          bankAccount: z.string().max(50).nullable().optional(),
          bankIfsc: z.string().max(20).nullable().optional(),
          tdsSectionId: z.number().int().positive().nullable().optional(),
          active: z.boolean(),
        }),
        id: z.number().int().positive().optional(),
      })
      .parse(p);
    return workforce.saveContractor(requireCompany().db, data, id);
  });
  handle(
    "payroll:contractors:payments",
    () => workforce.listContractorPayments(requireCompany().db),
    "viewer",
  );
  handle("payroll:contractors:postPayment", (p) =>
    workforce.postContractorPayment(
      requireCompany().db,
      z
        .object({
          contractorId: z.number().int().positive(),
          periodFrom: isoDate,
          periodTo: isoDate,
          gross: z.number().int().positive(),
          bankLedgerId: z.number().int().positive(),
          date: isoDate,
          note: z.string().max(500).nullable().optional(),
        })
        .parse(p),
      sessionUser?.name ?? "Owner",
    ),
  );
  handle(
    "payroll:settlements:list",
    () => workforce.listFinalSettlements(requireCompany().db),
    "viewer",
  );
  handle(
    "payroll:settlements:preview",
    (p) => {
      const { employeeId, lastWorkingDate } = z
        .object({
          employeeId: z.number().int().positive(),
          lastWorkingDate: isoDate,
        })
        .parse(p);
      return workforce.previewFinalSettlement(
        requireCompany().db,
        employeeId,
        lastWorkingDate,
      );
    },
    "viewer",
  );
  handle("payroll:settlements:create", (p) =>
    workforce.createFinalSettlement(
      requireCompany().db,
      z
        .object({
          employeeId: z.number().int().positive(),
          lastWorkingDate: isoDate,
          salaryDue: z.number().int().nonnegative(),
          noticePay: z.number().int().nonnegative(),
          leaveEncashment: z.number().int().nonnegative(),
          gratuity: z.number().int().nonnegative(),
          recovery: z.number().int().nonnegative(),
          advanceRecovery: z.number().int().nonnegative(),
          note: z.string().max(500).nullable().optional(),
        })
        .parse(p),
      sessionUser?.name ?? "Owner",
    ),
  );
  handle(
    "payroll:settlements:post",
    (p) => {
      const { id, date, bankLedgerId } = z
        .object({
          id: z.number().int().positive(),
          date: isoDate,
          bankLedgerId: z.number().int().positive(),
        })
        .parse(p);
      return workforce.postFinalSettlement(
        requireCompany().db,
        id,
        { date, bankLedgerId },
        sessionUser?.name ?? "Owner",
      );
    },
    "owner",
  );
  const statutoryKindSchema = z.enum(["pf", "esi", "pt", "tds"]);
  handle(
    "payroll:statutory:workspace",
    (p) =>
      workforceOperations.statutoryWorkspace(
        requireCompany().db,
        z.object({ month: monthSchema }).parse(p).month,
      ),
    "viewer",
  );
  handle("payroll:statutory:save", (p) =>
    workforceOperations.saveStatutoryChallan(
      requireCompany().db,
      z
        .object({
          month: monthSchema,
          kind: statutoryKindSchema,
          amount: z.number().int().nonnegative(),
          paidDate: isoDate.nullable().optional(),
          reference: z.string().max(100).nullable().optional(),
          status: z.enum(["due", "paid", "filed"]),
          filedReference: z.string().max(200).nullable().optional(),
        })
        .parse(p),
      sessionUser?.name ?? "Owner",
    ),
  );
  const shiftRuleSchema = z.object({
    name: z.string().trim().min(1).max(100),
    workMinutes: z.number().int().positive().max(1440),
    weeklyOffDay: z.number().int().min(0).max(6),
    overtimeAfterMinutes: z.number().int().nonnegative().max(1440),
    overtimeRateBps: z.number().int().nonnegative().max(100000),
    active: z.boolean(),
  });
  handle(
    "payroll:shifts:list",
    () => workforceOperations.listShiftRules(requireCompany().db),
    "viewer",
  );
  handle("payroll:shifts:save", (p) => {
    const { data, id } = z
      .object({
        data: shiftRuleSchema,
        id: z.number().int().positive().optional(),
      })
      .parse(p);
    return workforceOperations.saveShiftRule(requireCompany().db, data, id);
  });
  handle(
    "payroll:shifts:assignments",
    () => workforceOperations.listShiftAssignments(requireCompany().db),
    "viewer",
  );
  handle("payroll:shifts:assign", (p) =>
    workforceOperations.assignShift(
      requireCompany().db,
      z
        .object({
          employeeId: z.number().int().positive(),
          shiftRuleId: z.number().int().positive(),
          effectiveFrom: isoDate,
          effectiveTo: isoDate.nullable().optional(),
        })
        .parse(p),
    ),
  );
  handle(
    "payroll:holidays:list",
    (p) => {
      const { from, to } = z.object({ from: isoDate, to: isoDate }).parse(p);
      return workforceOperations.listHolidays(requireCompany().db, from, to);
    },
    "viewer",
  );
  handle("payroll:holidays:save", (p) =>
    workforceOperations.saveHoliday(
      requireCompany().db,
      z
        .object({
          date: isoDate,
          name: z.string().trim().min(1).max(100),
          department: z.string().max(100).optional(),
        })
        .parse(p),
    ),
  );
  handle(
    "payroll:departmentAnalysis",
    (p) => {
      const { fromMonth, toMonth } = z
        .object({ fromMonth: monthSchema, toMonth: monthSchema })
        .parse(p);
      return workforceOperations.departmentPayrollAnalysis(
        requireCompany().db,
        fromMonth,
        toMonth,
      );
    },
    "viewer",
  );
  const provisioningSchema = z.object({
    kind: z.enum(["joiners", "leavers"]),
    sourceName: z.string().min(1).max(200),
    csvText: z.string().min(1).max(10_000_000),
  });
  handle(
    "payroll:provisioning:preview",
    (p) => {
      const data = provisioningSchema.parse(p);
      return workforceOperations.previewProvisioning(
        requireCompany().db,
        data.kind,
        data.sourceName,
        data.csvText,
      );
    },
    "viewer",
  );
  handle("payroll:provisioning:apply", (p) => {
    const data = provisioningSchema.parse(p);
    return workforceOperations.applyProvisioning(
      requireCompany().db,
      data.kind,
      data.sourceName,
      data.csvText,
      sessionUser?.name ?? "Owner",
    );
  });
  handle("payroll:payslip", async (p) => {
    const { runId, employeeId } = z
      .object({
        runId: z.number().int().positive(),
        employeeId: z.number().int().positive(),
      })
      .parse(p);
    const c = requireCompany();
    const path = await payroll.payslipPdf(
      c.db,
      c.info,
      c.slug,
      runId,
      employeeId,
    );
    shell.openPath(path);
    return { path };
  });
  handle("payroll:payslipPack", async (p) => {
    const c = requireCompany();
    const result = await payroll.payslipDeliveryPack(
      c.db,
      c.info,
      c.slug,
      payrollRunIdSchema.parse(p).runId,
    );
    await shell.openPath(result.folder);
    return result;
  });
  // pay heads + per-employee assignments (lane Y, task Y1)
  handle(
    "payroll:heads:list",
    () => payroll.listPayHeads(requireCompany().db),
    "viewer",
  );
  handle("payroll:heads:save", (p) => {
    const { data, id } = z
      .object({
        data: payHeadInputSchema,
        id: z.number().int().positive().optional(),
      })
      .parse(p);
    return payroll.savePayHead(requireCompany().db, data, id);
  });
  handle("payroll:heads:delete", (p) => {
    payroll.deletePayHead(requireCompany().db, idSchema.parse(p).id);
    return null;
  });
  handle(
    "payroll:employeeHeads:get",
    (p) => {
      const { employeeId } = z
        .object({ employeeId: z.number().int().positive() })
        .parse(p);
      return payroll.getEmployeeHeads(requireCompany().db, employeeId);
    },
    "viewer",
  );
  handle("payroll:employeeHeads:set", (p) =>
    payroll.setEmployeeHeads(
      requireCompany().db,
      employeeHeadsSetSchema.parse(p),
    ),
  );
  // statutory exports: PF ECR text, ESI upload CSV, PT summary per state (lane Y, task Y1)
  handle("payroll:ecr", (p) => {
    const { runId } = payrollRunIdSchema.parse(p);
    const c = requireCompany();
    const { filename, text } = payroll.ecrForRun(c.db, runId);
    const path = join(companyExportsDir(c.slug), filename);
    writeFileSync(path, text, "utf8");
    shell.showItemInFolder(path);
    return { path };
  });
  handle("payroll:esi", (p) => {
    const { runId } = payrollRunIdSchema.parse(p);
    const c = requireCompany();
    const { filename, text } = payroll.esiForRun(c.db, runId);
    const path = join(companyExportsDir(c.slug), filename);
    writeFileSync(path, text, "utf8");
    shell.showItemInFolder(path);
    return { path };
  });
  handle(
    "payroll:ptSummary",
    (p) =>
      payroll.ptSummaryForRun(
        requireCompany().db,
        payrollRunIdSchema.parse(p).runId,
      ),
    "viewer",
  );
  handle("payroll:ptCsv", (p) => {
    const { runId } = payrollRunIdSchema.parse(p);
    const c = requireCompany();
    const { filename, text } = payroll.ptCsvForRun(c.db, runId);
    const path = join(companyExportsDir(c.slug), filename);
    writeFileSync(path, text, "utf8");
    shell.showItemInFolder(path);
    return { path };
  });

  registerMigrationHandlers({
    handle,
    requireCompany,
    actor: () => sessionUser?.name ?? "Local user",
  });

  // ---------- database health, low-disk protection and recovery copies ----------
  handle(
    "system:health",
    () => {
      const company = requireCompany();
      return {
        ...systemHealthService.systemHealth(company.db, company.slug),
        workload: backgroundWork.snapshot(),
      };
    },
    "viewer",
  );
  handle(
    "system:maintenance:run",
    (p) => {
      const { mode } = z
        .object({ mode: z.enum(["quick", "optimize", "full"]) })
        .parse(p);
      const company = requireCompany();
      return backgroundWork.run("maintenance", randomUUID(), () =>
        systemHealthService.runMaintenance(
          company.db,
          company.slug,
          mode,
          sessionUser?.name ?? "Local owner",
        ),
      );
    },
    "owner",
  );
  handle(
    "system:recovery:attempt",
    () => {
      const company = requireCompany();
      return backgroundWork.run("maintenance", randomUUID(), () =>
        systemHealthService.attemptRecoveryCopy(company.slug),
      );
    },
    "owner",
  );
  handle(
    "system:profiler:export",
    () => {
      const company = requireCompany();
      return backgroundWork.run("export", randomUUID(), () => {
        const result = writePerformanceProfilerPack(
          company.db,
          company.slug,
          app.getVersion(),
          sessionUser?.name ?? "Local owner",
        );
        shell.showItemInFolder(result.path);
        return result;
      });
    },
    "owner",
  );

  // ---------- report print/export (task 3.6) ----------
  handle(
    "report:pdf",
    async (p) => {
      const {
        title,
        periodLabel,
        columns,
        rows,
        footNote,
        provenance,
        filename,
        landscape,
      } = reportPdfSchema.parse(p);
      const c = requireCompany();
      const html = reportHtml({
        title,
        company: c.info,
        periodLabel,
        columns,
        rows,
        footNote,
        provenance,
      });
      const path = await writeExportPdf(c.slug, `${filename}.pdf`, html, {
        pageSize: "A4",
        landscape,
        pageNumbers: true,
      });
      auditExport(c.db, "report_pdf", { filename, path });
      return { path };
    },
    "viewer",
  );
  handle(
    "export:csv",
    (p) => {
      const { filename, csv, provenance } = exportCsvSchema.parse(p);
      const c = requireCompany();
      const path = join(companyExportsDir(c.slug), `${filename}.csv`);
      const metadataPath = join(
        companyExportsDir(c.slug),
        `${filename}.meta.json`,
      );
      writeFileSync(path, csv, "utf8");
      writeFileSync(
        metadataPath,
        JSON.stringify(
          {
            schemaVersion: 1,
            report: filename,
            company: c.info.name,
            ...provenance,
          },
          null,
          2,
        ),
        "utf8",
      );
      auditExport(c.db, "csv", { filename, path, metadataPath });
      return { path, metadataPath };
    },
    "viewer",
  );

  // ---------- CA export pack + Tally XML export ----------
  handle("export:caPack", async (p) => {
    const { from, to } = periodSchema.parse(p);
    const c = requireCompany();
    const r = caPack.exportCaPack(c.db, c.info, c.slug, from, to);
    const indexPath = join(r.path, "index.html");
    const pdfPath = join(r.path, "report-index.pdf");
    writeFileSync(
      pdfPath,
      await htmlToPdf(readFileSync(indexPath, "utf8"), {
        pageSize: "A4",
        pageNumbers: true,
      }),
    );
    auditExport(c.db, "ca_pack", { from, to, path: r.path });
    shell.showItemInFolder(r.path);
    return r;
  });
  handle("export:tallyXml", (p) => {
    const { from, to } = periodSchema.parse(p);
    const c = requireCompany();
    const r = caPack.exportTallyXml(c.db, c.info, c.slug, from, to);
    auditExport(c.db, "tally_xml", { from, to, path: r.path });
    shell.showItemInFolder(r.path);
    return r;
  });

  // ---------- live filing (NIC APIs) ----------
  handle(
    "nic:get",
    () => {
      const creds = nic.readNicCredentials(requireCompany().db);
      // Never send live secrets back to the UI in full — password AND clientSecret are the two
      // halves of the NIC auth credential pair (username/password + client_id/client_secret),
      // and nic:get is viewer-gated (v0.3 review F3).
      return {
        ...creds,
        password: creds.password ? "••••••••" : "",
        clientSecret: creds.clientSecret ? "••••••••" : "",
      };
    },
    "viewer",
  );
  handle(
    "nic:save",
    (p) => {
      const c = requireCompany();
      const incoming = nicCredentialsSchema.parse(p);
      const existing = nic.readNicCredentials(c.db);
      // Re-saving the mask sentinel means "keep what's stored" — the settings form round-trips
      // nic:get values verbatim when the owner doesn't retype them.
      if (incoming.password === "••••••••")
        incoming.password = existing.password;
      if (incoming.clientSecret === "••••••••")
        incoming.clientSecret = existing.clientSecret;
      nic.writeNicCredentials(c.db, incoming);
      nic.resetNicSession();
      return { configured: nic.nicConfigured(c.db) };
    },
    "owner",
  );
  handle(
    "nic:status",
    () => ({ configured: nic.nicConfigured(requireCompany().db) }),
    "viewer",
  );
  handle(
    "nic:generateIrn",
    async (p) => {
      const { voucherId } = z
        .object({ voucherId: z.number().int().positive() })
        .parse(p);
      const c = requireCompany();
      try {
        const result = await nic.generateIrn(c.db, c.info, voucherId);
        complianceOps.addEdocEvent(
          c.db,
          {
            voucherId,
            kind: "einvoice",
            status: "generated",
            requestKey: `irn:${voucherId}:${result.ackNo}`,
            documentNo: result.irn,
            validUntil: null,
            vehicleNo: null,
            reason: null,
            response: result,
          },
          sessionUser?.name ?? "Local user",
        );
        return result;
      } catch (error) {
        complianceOps.addEdocEvent(
          c.db,
          {
            voucherId,
            kind: "einvoice",
            status: "failed",
            requestKey: `irn:${voucherId}:failed:${Date.now()}`,
            documentNo: null,
            validUntil: null,
            vehicleNo: null,
            reason: error instanceof Error ? error.message : String(error),
          },
          sessionUser?.name ?? "Local user",
        );
        throw error;
      }
    },
    "owner",
  );
  handle(
    "nic:generateEwb",
    async (p) => {
      const { voucherId } = z
        .object({ voucherId: z.number().int().positive() })
        .parse(p);
      const c = requireCompany();
      try {
        const result = await nic.generateEwbByIrn(c.db, c.info, voucherId);
        complianceOps.addEdocEvent(
          c.db,
          {
            voucherId,
            kind: "eway",
            status: "generated",
            requestKey: `eway:${voucherId}:${result.ewbNo}`,
            documentNo: result.ewbNo,
            validUntil: result.validUpto,
            vehicleNo: null,
            reason: null,
            response: result,
          },
          sessionUser?.name ?? "Local user",
        );
        return result;
      } catch (error) {
        complianceOps.addEdocEvent(
          c.db,
          {
            voucherId,
            kind: "eway",
            status: "failed",
            requestKey: `eway:${voucherId}:failed:${Date.now()}`,
            documentNo: null,
            validUntil: null,
            vehicleNo: null,
            reason: error instanceof Error ? error.message : String(error),
          },
          sessionUser?.name ?? "Local user",
        );
        throw error;
      }
    },
    "owner",
  );

  // ---------- intelligence ----------
  handle(
    "intel:suggestLedgers",
    (p) => {
      const { kind, query } = z
        .object({ kind: z.string(), query: z.string() })
        .parse(p);
      return intel.suggestLedgers(requireCompany().db, kind, query);
    },
    "viewer",
  );
  handle(
    "intel:anomaly",
    (p) => {
      const { ledgerId, amount } = z
        .object({
          ledgerId: z.number().int().positive(),
          amount: z.number().int(),
        })
        .parse(p);
      return intel.anomalyCheck(requireCompany().db, ledgerId, amount);
    },
    "viewer",
  );

  // ---------- audit ----------
  handle(
    "audit:list",
    (p) => {
      const { entity, from, to, page } = auditListSchema.parse(p);
      return listAudit(requireCompany().db, { entity, from, to, page });
    },
    "viewer",
  );
  handle("audit:verify", () => verifyAuditChain(requireCompany().db), "viewer");

  // ---------- audit retention (lane Q, task Q1 #92) ----------
  handle(
    "config:audit:get",
    () => ({ keepDays: configSvc.getAuditKeepDays(requireCompany().db) }),
    "viewer",
  );
  handle(
    "config:audit:set",
    (p) => {
      const { keepDays } = auditRetentionSchema.parse(p);
      return {
        keepDays: configSvc.setAuditKeepDays(requireCompany().db, keepDays),
      };
    },
    "owner",
  );

  // ---------- auth + users ----------
  // auth:* itself is in UNGATED_CHANNELS (see `handle`) — you have to be able to call
  // auth:login before you're "in". users:list/save/deactivate are owner-only, *except* that
  // users:save is reachable with no session at all while the company has zero users: that's
  // how the first (forced-owner) account gets created without a chicken-and-egg deadlock —
  // see the UNGATED_CHANNELS / `current.usersExist` gate in `handle`.
  handle("auth:users", () => users.listLoginNames(requireCompany().db));
  handle("auth:login", (p) => {
    const { userId, pin } = authLoginSchema.parse(p);
    const c = requireCompany();
    const result = users.login(c.db, userId, pin);
    if (sessionToken)
      internalControls.closeSession(c.db, sessionToken, "locked");
    sessionUser = result;
    sessionToken = randomUUID();
    internalControls.openSession(c.db, result.id, sessionToken);
    return result;
  });
  handle("auth:logout", () => {
    // [lane-Q audit] logout audit row (task Q1 #90) — only meaningful with a live session.
    if (current && sessionUser) {
      writeAudit(current.db, "user", sessionUser.id, "logout", null, null);
      if (sessionToken)
        internalControls.closeSession(current.db, sessionToken, "signed_out");
    }
    sessionUser = null;
    sessionToken = null;
    return null;
  });
  handle("auth:current", () => sessionUser);

  handle("users:list", () => users.listUsers(requireCompany().db), "owner");
  handle(
    "users:save",
    (p) => {
      const { data, id } = z
        .object({
          data: userInputSchema,
          id: z.number().int().positive().optional(),
        })
        .parse(p);
      const c = requireCompany();
      const bootstrap = id === undefined && !c.usersExist;
      const before = id ? users.getUser(c.db, id) : null;
      const saved = users.saveUser(c.db, data, id);
      c.usersExist = users.usersExist(c.db);
      // The bootstrap owner (the very first user of a fresh company) is auto-authenticated as
      // themselves — they just proved they're standing at the machine by creating the account,
      // and forcing them to immediately re-enter the PIN they picked a second ago would be theatre.
      if (bootstrap) {
        sessionUser = { id: saved.id, name: saved.name, role: saved.role };
        sessionToken = randomUUID();
        internalControls.openSession(c.db, saved.id, sessionToken);
      }
      writeAudit(
        c.db,
        "user",
        saved.id,
        id ? "update" : "create",
        before,
        saved,
      );
      return { ...saved, locked: c.usersExist && !sessionUser };
    },
    "owner",
  );
  handle(
    "users:deactivate",
    (p) => {
      const { id } = idSchema.parse(p);
      const c = requireCompany();
      const before = users.getUser(c.db, id);
      users.deactivateUser(c.db, id);
      c.usersExist = users.usersExist(c.db);
      writeAudit(c.db, "user", id, "update", before, {
        ...before,
        active: false,
      });
      return null;
    },
    "owner",
  );

  // ---------- logging ----------
  handle("log:renderer", (p) => {
    const { message, stack, componentStack, screen } =
      rendererLogSchema.parse(p);
    log("error", "renderer-error", { message, stack, componentStack, screen });
    return null;
  });
  handle("log:reveal", () => {
    revealLogs();
    return null;
  });

  // ---------- app info + updates ----------
  handle("app:info", () => ({
    version: app.getVersion(),
    platform: process.platform,
  }));
  handle("app:checkUpdates", () => checkForUpdatesInteractive(), "viewer");
  const safeSupportDiagnostics = (): {
    version: string;
    platform: NodeJS.Platform;
    arch: string;
  } => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  });
  const supportCasePath = (): string => join(dataRoot(), "support-cases.json");
  const supportConsentSchema = z.object({
    message: z.boolean(),
    diagnostics: z.boolean(),
    logs: z.boolean(),
    companyMetadata: z.boolean(),
    focusContext: z.boolean(),
    screenshot: z.boolean(),
  });
  const supportFocusSchema = z
    .object({
      tag: z.string().trim().min(1).max(40),
      role: z.string().trim().max(80).nullable(),
      name: z.string().trim().max(160),
      testId: z.string().trim().max(120).nullable(),
      screen: z.string().trim().max(120).nullable(),
    })
    .nullable()
    .default(null);
  const supportPayloadSchema = z.object({
    caseId: z.string().regex(/^TOT-\d{8}-[A-F0-9]{6}$/),
    category: z.enum(["question", "bug", "idea", "accessibility"]),
    email: z.string().trim().email().max(200).or(z.literal("")),
    message: z.string().trim().min(10).max(5000),
    includeMessage: z.boolean(),
    includeDiagnostics: z.boolean().default(true),
    includeLogs: z.boolean().default(false),
    includeCompanyMetadata: z.boolean().default(false),
    focusContext: supportFocusSchema,
    screenshotDataUrl: z
      .string()
      .max(700_000)
      .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/)
      .nullable()
      .default(null),
  });
  const safeSupportContext = (): {
    logs: { ts: string; level: string; event: string; version: string }[];
    company: {
      name: string;
      stateCode: string;
      gstRegistrationType: string;
      schemaVersion: number;
      voucherCount: number;
      enabledFeatures: string[];
    } | null;
  } => {
    const rows: { ts: string; level: string; event: string; version: string }[] = [];
    try {
      const files = readdirSync(logsDir())
        .filter((name) => /^total-\d{4}-\d{2}-\d{2}\.log$/.test(name))
        .sort()
        .slice(-3);
      for (const file of files) {
        const lines = readFileSync(join(logsDir(), file), "utf8")
          .split("\n")
          .filter(Boolean)
          .slice(-50);
        for (const line of lines) {
          try {
            const item = JSON.parse(line) as Record<string, unknown>;
            if (
              typeof item.ts === "string" &&
              typeof item.level === "string" &&
              typeof item.event === "string"
            )
              rows.push({
                ts: item.ts.slice(0, 30),
                level: item.level.slice(0, 12),
                event: item.event.slice(0, 80),
                version: typeof item.v === "string" ? item.v.slice(0, 30) : "",
              });
          } catch {
            // Malformed lines are excluded rather than forwarded raw.
          }
        }
      }
    } catch {
      // Logs are optional; an absent/unreadable directory produces an empty preview.
    }
    const c = current;
    const features = c ? configSvc.getFeatures(c.db) : null;
    return {
      logs: rows.slice(-50),
      company: c
        ? {
            name: c.info.name,
            stateCode: c.info.stateCode,
            gstRegistrationType: c.info.gstRegistrationType,
            schemaVersion: Number(c.db.pragma("user_version", { simple: true })),
            voucherCount: Number(
              (
                c.db
                  .prepare("SELECT COUNT(*) AS count FROM vouchers WHERE deleted_at IS NULL")
                  .get() as { count: number }
              ).count,
            ),
            enabledFeatures: Object.entries(features ?? {})
              .filter(([, enabled]) => enabled)
              .map(([name]) => name)
              .sort(),
          }
        : null,
    };
  };
  const assertSupportBookContextAllowed = (input: {
    includeLogs: boolean;
    includeCompanyMetadata: boolean;
  }): void => {
    if (
      current?.usersExist &&
      !sessionUser &&
      (input.includeLogs || input.includeCompanyMetadata)
    )
      throw new Error(
        "Sign in before attaching activity logs or company metadata.",
      );
  };
  handle("support:diagnostics", () => safeSupportDiagnostics());
  handle("crash:list", () => crashReports.listCrashEnvelopes(), "viewer");
  handle("crash:record", (p) => {
    const input = z
      .object({
        message: z.string().min(1).max(2_000),
        stack: z.string().max(20_000).optional(),
        screen: z.string().max(80).optional(),
      })
      .parse(p);
    const diagnostics = safeSupportDiagnostics();
    return crashReports.writeCrashEnvelope({
      kind: "renderer",
      appVersion: diagnostics.version,
      platform: diagnostics.platform,
      arch: diagnostics.arch,
      screen: input.screen ?? null,
      message: input.message,
      stack: input.stack,
    });
  }, "viewer");
  handle("crash:submit", async (p) => {
    const { id } = z
      .object({ id: z.string().regex(/^CR-\d{8}-[A-F0-9]{6}$/) })
      .parse(p);
    const envelope = crashReports
      .listCrashEnvelopes()
      .find((candidate) => candidate.id === id);
    if (!envelope) throw new Error("Crash envelope not found");
    const supportCase = supportCases.createSupportCase(supportCasePath(), {
      category: "bug",
      consent: {
        message: true,
        diagnostics: true,
        logs: false,
        companyMetadata: false,
        focusContext: false,
        screenshot: false,
      },
    });
    supportCases.updateSupportCase(supportCasePath(), supportCase.id, {
      status: "sending",
    });
    try {
      const response = await fetch("https://devjindal.tech/api/support", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": `Total/${app.getVersion()}`,
        },
        body: JSON.stringify({
          caseId: supportCase.id,
          category: "bug",
          email: "",
          message: `Opt-in crash envelope ${envelope.id}`,
          source: "app",
          diagnostics: safeSupportDiagnostics(),
          crashEnvelope: envelope,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error("Support service unavailable");
      supportCases.updateSupportCase(supportCasePath(), supportCase.id, {
        status: "submitted",
      });
      return { ok: true, caseId: supportCase.id };
    } catch {
      supportCases.updateSupportCase(supportCasePath(), supportCase.id, {
        status: "failed",
        lastError: "Crash delivery failed",
      });
      throw new Error(
        `Crash envelope ${envelope.id} remains safely stored on this device.`,
      );
    }
  }, "viewer");
  handle("support:case:list", () => supportCases.readSupportCases(supportCasePath()));
  handle("support:case:create", (p) => {
    const input = z
      .object({
        category: z.enum(["question", "bug", "idea", "accessibility"]),
        consent: supportConsentSchema,
      })
      .parse(p);
    return supportCases.createSupportCase(supportCasePath(), input);
  });
  handle("support:contextPreview", () => safeSupportContext(), "viewer");
  handle("support:captureScreenshot", async () => {
    const win =
      BrowserWindow.getFocusedWindow() ??
      BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed() && candidate.isVisible(),
      );
    if (!win || win.isDestroyed())
      throw new Error("The app window is not available");
    const captured = await win.webContents.capturePage();
    const size = captured.getSize();
    const image =
      size.width > 960
        ? captured.resize({ width: 960, quality: "good" })
        : captured;
    const dataUrl = `data:image/jpeg;base64,${image.toJPEG(55).toString("base64")}`;
    if (dataUrl.length > 700_000)
      throw new Error("The screenshot is too large to attach");
    return {
      dataUrl,
      width: image.getSize().width,
      height: image.getSize().height,
    };
  });
  handle("support:submit", async (p) => {
    const input = supportPayloadSchema.parse(p);
    if (!input.includeMessage)
      throw new Error("Confirm message consent before sending");
    assertSupportBookContextAllowed(input);
    supportCases.updateSupportCase(supportCasePath(), input.caseId, {
      status: "sending",
      lastError: null,
    });
    const context = safeSupportContext();
    try {
      const response = await fetch("https://devjindal.tech/api/support", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": `Total/${app.getVersion()}`,
        },
        body: JSON.stringify({
          caseId: input.caseId,
          category: input.category,
          email: input.email,
          message: input.message,
          source: "app",
          diagnostics: input.includeDiagnostics ? safeSupportDiagnostics() : null,
          logs: input.includeLogs ? context.logs : null,
          companyMetadata: input.includeCompanyMetadata ? context.company : null,
          focusContext: input.focusContext,
          screenshotDataUrl: input.screenshotDataUrl,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error("Support service unavailable");
      const record = supportCases.updateSupportCase(
        supportCasePath(),
        input.caseId,
        { status: "submitted", lastError: null },
      );
      log("info", "support-case-submitted", { caseId: input.caseId });
      return { ok: true, caseId: input.caseId, status: record.status };
    } catch {
      supportCases.updateSupportCase(supportCasePath(), input.caseId, {
        status: "failed",
        lastError: "Network delivery failed",
      });
      throw new Error(
        "Support could not be reached. Save an encrypted offline bundle or use email.",
      );
    }
  });
  handle("support:bundleOffline", async (p) => {
    const input = supportPayloadSchema
      .extend({ passphrase: passphraseSchema })
      .parse(p);
    if (!input.includeMessage)
      throw new Error("Confirm message consent before saving the bundle");
    assertSupportBookContextAllowed(input);
    const context = safeSupportContext();
    const consent = {
      message: input.includeMessage,
      diagnostics: input.includeDiagnostics,
      logs: input.includeLogs,
      companyMetadata: input.includeCompanyMetadata,
      focusContext: input.focusContext !== null,
      screenshot: input.screenshotDataUrl !== null,
    };
    const entries: supportCases.ZipEntry[] = [
      {
        name: "case.json",
        data: Buffer.from(
          JSON.stringify(
            {
              caseId: input.caseId,
              category: input.category,
              email: input.email,
              createdAt: new Date().toISOString(),
              consent,
            },
            null,
            2,
          ),
        ),
      },
    ];
    if (input.includeMessage)
      entries.push({ name: "message.txt", data: Buffer.from(input.message) });
    if (input.includeDiagnostics)
      entries.push({
        name: "diagnostics.json",
        data: Buffer.from(JSON.stringify(safeSupportDiagnostics(), null, 2)),
      });
    if (input.includeLogs)
      entries.push({
        name: "logs.json",
        data: Buffer.from(JSON.stringify(context.logs, null, 2)),
      });
    if (input.includeCompanyMetadata && context.company)
      entries.push({
        name: "company.json",
        data: Buffer.from(JSON.stringify(context.company, null, 2)),
      });
    if (input.focusContext)
      entries.push({
        name: "focus.json",
        data: Buffer.from(JSON.stringify(input.focusContext, null, 2)),
      });
    if (input.screenshotDataUrl)
      entries.push({
        name: "screenshot.jpg",
        data: Buffer.from(input.screenshotDataUrl.split(",")[1]!, "base64"),
      });

    const target = await dialog.showSaveDialog({
      title: "Save encrypted support bundle",
      defaultPath: `Total-support-${input.caseId}.zip.enc`,
      filters: [{ name: "Encrypted support bundle", extensions: ["enc"] }],
    });
    if (target.canceled || !target.filePath) return null;
    const temporary = mkdtempSync(join(tmpdir(), "total-support-bundle-"));
    const zipPath = join(temporary, `${input.caseId}.zip`);
    try {
      writeFileSync(zipPath, supportCases.createStoredZip(entries), { mode: 0o600 });
      await encryptFile(zipPath, target.filePath, input.passphrase);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
    const record = supportCases.updateSupportCase(
      supportCasePath(),
      input.caseId,
      { status: "saved_offline", lastError: null },
    );
    log("info", "support-bundle-saved", { caseId: input.caseId });
    return { path: target.filePath, caseId: input.caseId, status: record.status };
  });

  // ---------- community + opt-in aggregate product signals ----------
  const feedbackActionSchema = z.discriminatedUnion("action", [
    z.object({
      action: z.literal("submit"),
      title: z.string().trim().min(5).max(120),
      detail: z.string().trim().min(10).max(2000),
      email: z.string().trim().email().max(200).or(z.literal("")),
    }),
    z.object({
      action: z.enum(["vote", "follow"]),
      ideaId: z.string().trim().regex(/^[A-Za-z0-9_-]{3,80}$/),
    }),
  ]);
  handle("community:feedback:list", async () => {
    const response = await fetch("https://devjindal.tech/api/feedback", {
      headers: { "user-agent": `Total/${app.getVersion()}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("The feedback board is unavailable offline");
    const parsed = z
      .object({
        ideas: z
          .array(
            z.object({
              id: z.string().max(80),
              title: z.string().max(120),
              detail: z.string().max(1000),
              status: z.enum(["considering", "planned", "building", "released"]),
              votes: z.number().int().min(0),
              releaseVersion: z.string().max(30).nullable().default(null),
            }),
          )
          .max(100),
      })
      .parse(await response.json());
    return parsed.ideas;
  }, "viewer");
  handle("community:feedback:action", async (p) => {
    const input = feedbackActionSchema.parse(p);
    const response = await fetch("https://devjindal.tech/api/feedback", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": `Total/${app.getVersion()}`,
      },
      body: JSON.stringify({ ...input, source: "app" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("The feedback board could not be updated");
    return z
      .object({ ok: z.literal(true), ideaId: z.string().max(80) })
      .parse(await response.json());
  }, "viewer");
  handle("community:cohort:submit", async (p) => {
    const payload = z
      .object({
        schema: z.literal(1),
        installationId: z.string().regex(/^[a-z0-9]{8,40}$/),
        activatedMonth: z.string().regex(/^\d{4}-\d{2}$/),
        appVersion: z.string().max(30),
        platform: z.string().max(30),
        events: z
          .array(
            z.object({
              name: z.enum([
                "company_created",
                "first_voucher_posted",
                "first_backup_verified",
                "first_register_opened",
                "week_1_return",
                "month_1_return",
              ]),
              count: z.number().int().min(1).max(10_000),
              firstAt: z.string().datetime(),
              lastAt: z.string().datetime(),
            }),
          )
          .max(6),
      })
      .strict()
      .parse(p);
    const response = await fetch("https://devjindal.tech/api/cohort", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": `Total/${app.getVersion()}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("Product insights could not be sent");
    return { ok: true };
  }, "viewer");

  // ---------- agent bridge (CSV/JSON mirrors + inbox, lane A) ----------
  handle("agent:exportMirror", (p) => {
    const input = agentExportSchema.parse(p ?? {});
    const c = requireCompany();
    return agentBridge.exportMirror(c.db, c.slug, input);
  });
  handle(
    "agent:getConfig",
    () => ({ enabled: configSvc.getAgentBridgeEnabled(requireCompany().db) }),
    "viewer",
  );
  handle(
    "agent:setConfig",
    (p) => {
      const { enabled } = agentBridgeConfigSchema.parse(p);
      const c = requireCompany();
      configSvc.setAgentBridgeEnabled(c.db, enabled);
      agentBridge.syncInboxWatcher(enabled ? { slug: c.slug, db: c.db } : null);
      return { enabled };
    },
    "owner",
  );
  handle(
    "agent:listProposals",
    () => agentBridge.listProposals(requireCompany().slug),
    "viewer",
  );
  handle(
    "agent:approveProposal",
    (p) => {
      const { file } = z.object({ file: z.string().min(1).max(240) }).parse(p);
      const c = requireCompany();
      return agentBridge.approveProposal(c.db, c.slug, file);
    },
    "accountant",
  );
  handle(
    "agent:discardProposal",
    (p) => {
      const { file } = z.object({ file: z.string().min(1).max(240) }).parse(p);
      agentBridge.discardProposal(requireCompany().slug, file);
      return null;
    },
    "accountant",
  );

  // MCP access is separate from the broad drop-folder switch: tokens are one-company,
  // expiry-bound and scope-bound; plaintext is returned exactly once when issued.
  handle(
    "mcp:tokens:list",
    () => mcpAccess.listTokens(requireCompany().slug),
    "owner",
  );
  handle(
    "mcp:tokens:issue",
    (p) => {
      const input = z
        .object({
          name: z.string().trim().min(1).max(80),
          scopes: z
            .array(
              z.enum([
                "companies:list",
                "mirror:read",
                "attachment:read",
                "proposal:create",
                "mirror:refresh",
              ]),
            )
            .min(1)
            .max(5),
          expiresAt: z.string().datetime(),
        })
        .refine((value) => Date.parse(value.expiresAt) > Date.now(), {
          message: "Token expiry must be in the future",
          path: ["expiresAt"],
        })
        .refine(
          (value) =>
            Date.parse(value.expiresAt) <= Date.now() + 366 * 86_400_000,
          {
            message: "Token expiry cannot exceed one year",
            path: ["expiresAt"],
          },
        )
        .parse(p);
      const company = requireCompany();
      return mcpAccess.issueToken(
        company.db,
        company.slug,
        input,
        sessionUser?.name ?? "Local owner",
      );
    },
    "owner",
  );
  handle(
    "mcp:tokens:revoke",
    (p) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(p);
      const company = requireCompany();
      return mcpAccess.revokeToken(
        company.db,
        company.slug,
        id,
        sessionUser?.name ?? "Local owner",
      );
    },
    "owner",
  );
  handle(
    "mcp:audit:list",
    (p) => {
      const { limit } = z
        .object({ limit: z.number().int().min(1).max(1000).default(200) })
        .parse(p ?? {});
      return mcpAccess.listAudit(requireCompany().slug, limit);
    },
    "owner",
  );
  handle(
    "mcp:mirror:status",
    () => mcpAccess.mirrorStatus(requireCompany().slug),
    "viewer",
  );
  handle(
    "mcp:refresh:list",
    () => mcpAccess.listRefreshRequests(requireCompany().slug),
    "owner",
  );
  handle(
    "mcp:refresh:decide",
    (p) => {
      const { id, approved } = z
        .object({ id: z.string().uuid(), approved: z.boolean() })
        .parse(p);
      const company = requireCompany();
      return mcpAccess.decideRefreshRequest(
        company.db,
        company.slug,
        id,
        approved,
        sessionUser?.name ?? "Local owner",
      );
    },
    "owner",
  );

  // ---------- declarative integrations and visible local automation ----------
  handle(
    "integrations:plugins:list",
    () => integrations.listPlugins(requireCompany().db),
    "viewer",
  );
  handle(
    "integrations:plugins:install",
    async () => {
      const picked = await dialog.showOpenDialog({
        title: "Install a Total integration manifest",
        filters: [{ name: "Total plugin manifest", extensions: ["json"] }],
        properties: ["openFile"],
      });
      if (picked.canceled || !picked.filePaths[0]) return null;
      if (statSync(picked.filePaths[0]).size > 256 * 1024)
        throw new Error("Plugin manifest exceeds the 256 KB limit");
      return integrations.installPlugin(
        requireCompany().db,
        readFileSync(picked.filePaths[0], "utf8"),
        sessionUser?.name ?? "Local owner",
        app.getVersion(),
      );
    },
    "owner",
  );
  handle(
    "integrations:plugins:setEnabled",
    (p) => {
      const { id, enabled } = z
        .object({
          id: z.string().regex(/^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$/),
          enabled: z.boolean(),
        })
        .parse(p);
      return integrations.setPluginEnabled(
        requireCompany().db,
        id,
        enabled,
        sessionUser?.name ?? "Local owner",
      );
    },
    "owner",
  );
  handle(
    "integrations:imports:preview",
    (p) => {
      const input = z
        .object({
          pluginId: z.string().max(100),
          importerId: z.string().max(50),
          source: z.string().max(10 * 1024 * 1024),
        })
        .parse(p);
      return integrations.previewPartnerImport(
        requireCompany().db,
        input.pluginId,
        input.importerId,
        input.source,
        sessionUser?.name ?? "Local user",
      );
    },
    "accountant",
  );
  handle(
    "integrations:reports:run",
    (p) => {
      const input = z
        .object({
          pluginId: z.string().max(100),
          reportId: z.string().max(50),
          from: isoDate,
          to: isoDate,
        })
        .refine((value) => value.from <= value.to, {
          message: "From date must not be after to date",
        })
        .parse(p);
      return integrations.runExtensionReport(
        requireCompany().db,
        input.pluginId,
        input.reportId,
        input.from,
        input.to,
      );
    },
    "viewer",
  );
  handle(
    "integrations:webhooks:endpoints",
    () => integrations.listWebhookEndpoints(requireCompany().db),
    "owner",
  );
  handle(
    "integrations:webhooks:save",
    (p) => {
      const input = z
        .object({
          name: z.string().trim().min(2).max(80),
          endpoint: z.string().url().max(500),
          eventTypes: z.array(z.string().max(80)).min(1).max(20),
          secret: z.string().min(16).max(200),
        })
        .parse(p);
      return integrations.saveWebhookEndpoint(
        requireCompany().db,
        input,
        sessionUser?.name ?? "Local owner",
      );
    },
    "owner",
  );
  handle(
    "integrations:webhooks:setActive",
    (p) => {
      const { id, active } = z
        .object({ id: z.number().int().positive(), active: z.boolean() })
        .parse(p);
      return integrations.setWebhookEndpointActive(
        requireCompany().db,
        id,
        active,
      );
    },
    "owner",
  );
  handle(
    "integrations:webhooks:outbox",
    (p) => {
      const { limit } = z
        .object({ limit: z.number().int().min(1).max(1000).default(200) })
        .parse(p ?? {});
      return integrations.listWebhookOutbox(requireCompany().db, limit);
    },
    "owner",
  );
  handle(
    "integrations:webhooks:test",
    (p) => {
      const { eventType, payload } = z
        .object({
          eventType: z.string().regex(/^[a-z][a-z0-9_.-]{1,79}$/),
          payload: z.unknown(),
        })
        .parse(p);
      return integrations.enqueueWebhookEvent(
        requireCompany().db,
        eventType,
        payload,
      );
    },
    "owner",
  );
  handle(
    "integrations:webhooks:deliver",
    (p) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(p);
      return integrations.deliverWebhookEvent(requireCompany().db, id);
    },
    "owner",
  );
  handle(
    "integrations:automation:schedules",
    () => integrations.listAutomationSchedules(requireCompany().db),
    "viewer",
  );
  handle(
    "integrations:automation:save",
    (p) => {
      const input = z
        .object({
          name: z.string().trim().min(2).max(80),
          taskKind: z.enum(["backup", "mirror", "report_pack"]),
          cadence: z.enum(["daily", "weekly", "monthly"]),
          localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
          dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
          dayOfMonth: z.number().int().min(1).max(28).nullable().optional(),
          config: z.record(z.string(), z.unknown()).optional(),
        })
        .parse(p);
      return integrations.saveAutomationSchedule(
        requireCompany().db,
        input,
        sessionUser?.name ?? "Local owner",
      );
    },
    "owner",
  );
  handle(
    "integrations:automation:setEnabled",
    (p) => {
      const { id, enabled } = z
        .object({ id: z.number().int().positive(), enabled: z.boolean() })
        .parse(p);
      return integrations.setAutomationEnabled(
        requireCompany().db,
        id,
        enabled,
      );
    },
    "owner",
  );
  handle(
    "integrations:automation:runs",
    (p) => {
      const { limit } = z
        .object({ limit: z.number().int().min(1).max(500).default(100) })
        .parse(p ?? {});
      return integrations.listAutomationRuns(requireCompany().db, limit);
    },
    "viewer",
  );
  handle(
    "integrations:automation:run",
    (p) => {
      const { id } = idSchema.parse(p);
      const company = requireCompany();
      return integrations.runAutomation(
        company.db,
        company.info,
        company.slug,
        id,
      );
    },
    "owner",
  );
  handle(
    "integrations:adapters:settlements:list",
    () => partnerAdapters.listSettlementReviews(requireCompany().db),
    "viewer",
  );
  handle(
    "integrations:adapters:settlements:review",
    (p) =>
      partnerAdapters.retainSettlementReview(
        requireCompany().db,
        settlementInputSchema.parse(p),
        sessionUser?.name ?? "Local user",
      ),
    "accountant",
  );
  handle(
    "integrations:adapters:ecommerce:list",
    () => partnerAdapters.listEcommerceReviews(requireCompany().db),
    "viewer",
  );
  handle(
    "integrations:adapters:ecommerce:review",
    (p) =>
      partnerAdapters.retainEcommerceReview(
        requireCompany().db,
        ecommerceOrderSchema.parse(p),
        sessionUser?.name ?? "Local user",
      ),
    "accountant",
  );
  handle(
    "export:logisticsAdapter",
    (p) => {
      const input = z
        .object({
          format: z.enum(["generic", "delhivery", "shiprocket"]),
          shipments: z.array(shipmentInputSchema).min(1).max(10_000),
        })
        .parse(p);
      const company = requireCompany();
      return partnerAdapters.exportLogisticsBatch(
        company.db,
        company.slug,
        input.format,
        input.shipments,
        sessionUser?.name ?? "Local user",
      );
    },
    "accountant",
  );
  handle(
    "privacy:summary",
    () => {
      const company = requireCompany();
      const aiConfig = ai.getConfig();
      return {
        clipboardClearSeconds: privacyControls.clipboardClearSeconds(
          company.db,
        ),
        attachmentEncryption: attachmentVault.attachmentEncryptionEnabled(
          company.db,
        ),
        exportSigning: exportSigning.signingStatus(),
        network: {
          ai: {
            enabled: aiConfig.enabled,
            provider: aiConfig.provider,
            endpoint: aiConfig.baseUrl ?? "https://api.openai.com",
          },
          bankFeeds: bankFeedService.listConnections(company.db).map((row) => ({
            name: row.displayName,
            endpoint: row.endpoint,
            status: row.status,
            consentExpiresAt: row.consentExpiresAt,
          })),
          webhooks: integrations
            .listWebhookEndpoints(company.db)
            .map((row) => ({
              name: row.name,
              endpoint: row.endpoint,
              active: row.active,
              eventTypes: row.eventTypes,
            })),
          mcpTokens: mcpAccess
            .listTokens(company.slug)
            .filter(
              (row) => !row.revokedAt && Date.parse(row.expiresAt) > Date.now(),
            ).length,
          dropFolderEnabled: configSvc.getAgentBridgeEnabled(company.db),
        },
        retention: internalControls.listRetentionPolicies(company.db),
        diagnostics: {
          version: app.getVersion(),
          platform: process.platform,
          arch: process.arch,
        },
      };
    },
    "viewer",
  );
  handle(
    "privacy:clipboard:set",
    (p) => {
      const { seconds } = z
        .object({ seconds: z.number().int().min(0).max(600) })
        .parse(p);
      return {
        seconds: privacyControls.setClipboardClearSeconds(
          requireCompany().db,
          seconds,
        ),
      };
    },
    "owner",
  );
  handle(
    "privacy:attachments:setEncryption",
    (p) => {
      const { enabled } = z.object({ enabled: z.boolean() }).parse(p);
      const company = requireCompany();
      return attachmentVault.setAttachmentEncryption(
        company.db,
        company.slug,
        enabled,
        sessionUser?.name ?? "Local owner",
      );
    },
    "owner",
  );
  handle(
    "privacy:signing:initialize",
    () => exportSigning.initializeSigningIdentity(),
    "owner",
  );
  handle(
    "privacy:clipboard:copySensitive",
    (p) => {
      const { text } = z.object({ text: z.string().max(100_000) }).parse(p);
      clipboard.writeText(text);
      if (sensitiveClipboardTimer) clearTimeout(sensitiveClipboardTimer);
      const seconds = privacyControls.clipboardClearSeconds(
        requireCompany().db,
      );
      if (seconds > 0) {
        sensitiveClipboardTimer = setTimeout(() => {
          if (clipboard.readText() === text) clipboard.clear();
          sensitiveClipboardTimer = null;
        }, seconds * 1000);
        sensitiveClipboardTimer.unref?.();
      }
      return { clearsAfterSeconds: seconds };
    },
    "viewer",
  );

  // Domain handlers keep the shared permission/error boundary while owning their schemas.
  registerAiHandlers({
    handle,
    requireCompany,
    actor: () => sessionUser?.name ?? "Local user",
  });

  // ---------- compliance-deadline notifications ----------
  // The renderer computes *which* deadlines to notify about (pure `src/shared/compliance.ts`,
  // driven off the dashboard data it already has) and hands over ready-to-show title/body pairs;
  // this just applies the once-per-day guard and pops native OS notifications.
  handle(
    "app:notifyDeadlines",
    (p) => {
      const { items } = notifyDeadlinesSchema.parse(p);
      const db = requireCompany().db;
      if (configSvc.shouldNotifyDeadlinesToday(db, todayISO())) {
        for (const item of items) {
          new Notification({ title: item.title, body: item.body }).show();
        }
      }
      return null;
    },
    "viewer",
  );
}
