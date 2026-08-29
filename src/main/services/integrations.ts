import { createHash, createHmac, randomUUID } from "crypto";
import { safeStorage } from "electron";
import type { DB } from "../db/connection";
import { backupCompany } from "../db/connection";
import type { CompanyInfo } from "@shared/domain";
import {
  INTEGRATION_CONTRACT_VERSION,
  pluginManifestSchema,
  type AutomationRun,
  type AutomationSchedule,
  type AutomationTaskKind,
  type ExtensionReportResult,
  type InstalledPlugin,
  type PluginManifest,
  type WebhookEndpointSummary,
  type WebhookOutboxEvent,
} from "@shared/integrations";
import { parseCsv } from "@shared/csv";
import { dayBook, trialBalance } from "./reports";
import { outstandings, registerByPeriod } from "./analysis";
import { exportMirror } from "./agentBridge";
import { exportCaPack } from "./caPack";
import { writeAudit } from "./audit";
import { applyRotationPolicy, replicateBackup } from "./resilience";

const APP_VERSION_FALLBACK = "5.0.0";
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const MAX_IMPORT_ROWS = 50_000;
const MAX_WEBHOOK_BYTES = 256 * 1024;

function appVersionParts(value: string): number[] {
  return value
    .split(".")
    .slice(0, 3)
    .map((part) => Number(part.replace(/\D.*$/, "")) || 0);
}

function compareVersion(left: string, right: string): number {
  const a = appVersionParts(left);
  const b = appVersionParts(right);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0))
      return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

export function manifestCompatibility(
  manifest: PluginManifest,
  appVersion = APP_VERSION_FALLBACK,
): { compatible: boolean; reason: string | null } {
  if (manifest.compatibility.contractVersion !== INTEGRATION_CONTRACT_VERSION)
    return { compatible: false, reason: "Unsupported integration contract" };
  if (compareVersion(appVersion, manifest.compatibility.minAppVersion) < 0)
    return {
      compatible: false,
      reason: `Requires Total ${manifest.compatibility.minAppVersion} or newer`,
    };
  if (
    manifest.compatibility.maxAppVersion &&
    compareVersion(appVersion, manifest.compatibility.maxAppVersion) > 0
  )
    return {
      compatible: false,
      reason: `Supports Total only through ${manifest.compatibility.maxAppVersion}`,
    };
  return { compatible: true, reason: null };
}

export function parsePluginManifest(input: string | unknown): PluginManifest {
  const raw = typeof input === "string" ? input : JSON.stringify(input);
  if (Buffer.byteLength(raw) > MAX_MANIFEST_BYTES)
    throw new Error("Plugin manifest exceeds the 256 KB limit");
  return pluginManifestSchema.parse(
    typeof input === "string" ? JSON.parse(input) : input,
  );
}

function publicPlugin(row: Record<string, unknown>): InstalledPlugin {
  const manifest = pluginManifestSchema.parse(
    JSON.parse(String(row.manifestJson)),
  );
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    publisher: manifest.publisher,
    enabled: !!row.enabled,
    compatible: !!row.compatible,
    permissions: manifest.permissions,
    screens: manifest.screens.length,
    importers: manifest.importers.length,
    reports: manifest.reports.length,
    exports: manifest.exports.length,
    installedBy: String(row.installedBy),
    installedAt: String(row.installedAt),
    updatedAt: String(row.updatedAt),
  };
}

export function listPlugins(db: DB): InstalledPlugin[] {
  return (
    db
      .prepare(
        `SELECT manifest_json AS manifestJson,enabled,compatible,installed_by AS installedBy,
                installed_at AS installedAt,updated_at AS updatedAt
         FROM integration_plugins ORDER BY installed_at DESC,id`,
      )
      .all() as Record<string, unknown>[]
  ).map(publicPlugin);
}

export function installPlugin(
  db: DB,
  source: string | unknown,
  actor: string,
  appVersion = APP_VERSION_FALLBACK,
): InstalledPlugin {
  const manifest = parsePluginManifest(source);
  const compatibility = manifestCompatibility(manifest, appVersion);
  const before = listPlugins(db).find((row) => row.id === manifest.id) ?? null;
  db.prepare(
    `INSERT INTO integration_plugins(id,manifest_json,enabled,compatible,installed_by)
     VALUES(?,?,0,?,?)
     ON CONFLICT(id) DO UPDATE SET manifest_json=excluded.manifest_json,
       compatible=excluded.compatible,enabled=CASE WHEN excluded.compatible=1 THEN integration_plugins.enabled ELSE 0 END,
       installed_by=excluded.installed_by,updated_at=datetime('now')`,
  ).run(
    manifest.id,
    JSON.stringify(manifest),
    compatibility.compatible ? 1 : 0,
    actor,
  );
  const after = listPlugins(db).find((row) => row.id === manifest.id)!;
  writeAudit(db, "integration_plugin", 0, before ? "update" : "create", before, {
    ...after,
    compatibilityReason: compatibility.reason,
  });
  return after;
}

export function setPluginEnabled(
  db: DB,
  id: string,
  enabled: boolean,
  actor: string,
): InstalledPlugin {
  const before = listPlugins(db).find((row) => row.id === id);
  if (!before) throw new Error("Plugin is not installed");
  if (enabled && !before.compatible)
    throw new Error("This plugin is incompatible with this version of Total");
  db.prepare(
    "UPDATE integration_plugins SET enabled=?,updated_at=datetime('now') WHERE id=?",
  ).run(enabled ? 1 : 0, id);
  const after = listPlugins(db).find((row) => row.id === id)!;
  writeAudit(db, "integration_plugin", 0, "update", before, {
    ...after,
    changedBy: actor,
  });
  return after;
}

function manifestFor(db: DB, id: string, mustBeEnabled = true): PluginManifest {
  const row = db
    .prepare(
      "SELECT manifest_json AS manifestJson,enabled,compatible FROM integration_plugins WHERE id=?",
    )
    .get(id) as
    | { manifestJson: string; enabled: number; compatible: number }
    | undefined;
  if (!row) throw new Error("Plugin is not installed");
  if (mustBeEnabled && (!row.enabled || !row.compatible))
    throw new Error("Plugin is not enabled and compatible");
  return pluginManifestSchema.parse(JSON.parse(row.manifestJson));
}

function atPath(row: unknown, path: string): unknown {
  let value = row;
  for (const part of path.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    value = (value as Record<string, unknown>)[part];
  }
  return value ?? null;
}

function recordsOf(input: string, kind: "json" | "csv"): unknown[] {
  if (Buffer.byteLength(input) > MAX_IMPORT_BYTES)
    throw new Error("Partner import exceeds the 10 MB limit");
  if (kind === "json") {
    const parsed = JSON.parse(input) as unknown;
    const rows = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" &&
          Array.isArray((parsed as { records?: unknown }).records)
        ? (parsed as { records: unknown[] }).records
        : null;
    if (!rows) throw new Error("JSON import must be an array or { records: [] }");
    if (rows.length > MAX_IMPORT_ROWS)
      throw new Error("Partner import exceeds 50,000 rows");
    return rows;
  }
  const table = parseCsv(input);
  if (table.length <= 1) return [];
  if (table.length - 1 > MAX_IMPORT_ROWS)
    throw new Error("Partner import exceeds 50,000 rows");
  const headers = table[0]!.cells;
  return table.slice(1).map(({ cells }) =>
    Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])),
  );
}

export interface PartnerImportPreview {
  pluginId: string;
  importerId: string;
  recordKind: string;
  sourceHash: string;
  sourceRows: number;
  acceptedRows: number;
  rejectedRows: number;
  rows: Record<string, unknown>[];
  errors: { row: number; message: string }[];
}

export function previewPartnerImport(
  db: DB,
  pluginId: string,
  importerId: string,
  source: string,
  actor: string,
): PartnerImportPreview {
  const manifest = manifestFor(db, pluginId);
  if (!manifest.permissions.includes("imports:preview"))
    throw new Error("Plugin does not have imports:preview permission");
  const importer = manifest.importers.find((row) => row.id === importerId);
  if (!importer) throw new Error("Importer is not declared by this plugin");
  const records = recordsOf(source, importer.input);
  const errors: { row: number; message: string }[] = [];
  const rows = records.flatMap((record, index) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      errors.push({ row: index + 1, message: "Expected an object record" });
      return [];
    }
    const mapped = Object.fromEntries(
      Object.entries(importer.fieldMap).map(([target, path]) => [
        target,
        atPath(record, path),
      ]),
    );
    if (Object.values(mapped).every((value) => value == null || value === "")) {
      errors.push({ row: index + 1, message: "Mapped record is empty" });
      return [];
    }
    return [mapped];
  });
  const result: PartnerImportPreview = {
    pluginId,
    importerId,
    recordKind: importer.recordKind,
    sourceHash: createHash("sha256").update(source).digest("hex"),
    sourceRows: records.length,
    acceptedRows: rows.length,
    rejectedRows: errors.length,
    rows: rows.slice(0, 200),
    errors: errors.slice(0, 200),
  };
  db.prepare(
    `INSERT INTO integration_import_runs
     (plugin_id,importer_id,source_hash,source_rows,accepted_rows,rejected_rows,status,result_json,created_by)
     VALUES(?,?,?,?,?,?,'previewed',?,?)`,
  ).run(
    pluginId,
    importerId,
    result.sourceHash,
    result.sourceRows,
    result.acceptedRows,
    result.rejectedRows,
    JSON.stringify({ rows: result.rows, errors: result.errors }),
    actor,
  );
  return result;
}

export function runExtensionReport(
  db: DB,
  pluginId: string,
  reportId: string,
  from: string,
  to: string,
): ExtensionReportResult {
  const manifest = manifestFor(db, pluginId);
  if (!manifest.permissions.includes("reports:read"))
    throw new Error("Plugin does not have reports:read permission");
  const report = manifest.reports.find((row) => row.id === reportId);
  if (!report) throw new Error("Report is not declared by this plugin");
  let rows: ExtensionReportResult["rows"] = [];
  const totals: Record<string, number> = {};
  if (report.primitive === "trial_balance") {
    const value = trialBalance(db, to);
    rows = value.rows.map((row) => ({
      ...row,
      drilldown: {
        screen: "ledger" as const,
        params: { ledgerId: row.ledgerId, from, to },
      },
    }));
    Object.assign(totals, { debit: value.totalDebit, credit: value.totalCredit });
  } else if (report.primitive === "day_book") {
    rows = dayBook(db, from, to).map((row) => ({
      ...row,
      drilldown: {
        screen: "voucher" as const,
        params: { voucherId: row.voucherId },
      },
    }));
    totals.debit = rows.reduce((sum, row) => sum + Number(row.debit ?? 0), 0);
    totals.credit = rows.reduce((sum, row) => sum + Number(row.credit ?? 0), 0);
  } else if (
    report.primitive === "sales_register" ||
    report.primitive === "purchase_register"
  ) {
    const kind = report.primitive === "sales_register" ? "sales" : "purchase";
    rows = registerByPeriod(db, kind, from, to, "month").map((row) => ({
      ...row,
      drilldown: {
        screen: `${kind}-register` as "sales-register" | "purchase-register",
        params: { from: row.from, to: row.to },
      },
    }));
    for (const key of ["vouchers", "taxable", "tax", "total"])
      totals[key] = rows.reduce((sum, row) => sum + Number(row[key] ?? 0), 0);
  } else {
    const side = report.primitive === "receivables" ? "receivable" : "payable";
    rows = outstandings(db, side, to).map((row) => ({
      ...row,
      drilldown: {
        screen: "ledger" as const,
        params: { ledgerId: row.ledgerId, from, to },
      },
    }));
    totals.pending = rows.reduce((sum, row) => sum + Number(row.pending ?? 0), 0);
  }
  return {
    contractVersion: 1,
    pluginId,
    reportId,
    primitive: report.primitive,
    generatedAt: new Date().toISOString(),
    provenance: { from, to, basis: "posted voucher lines" },
    rows,
    totals,
  };
}

function validateWebhookEndpoint(value: string): string {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
    throw new Error("Webhook URL must use HTTPS, except for localhost");
  if (url.username || url.password || url.hash)
    throw new Error("Webhook URL must not contain credentials or a fragment");
  return url.toString();
}

function encryptSecret(secret: string): string {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error("Secure credential storage is unavailable on this computer");
  return safeStorage.encryptString(secret).toString("base64");
}

function decryptSecret(encrypted: string): string {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error("Secure credential storage is unavailable");
  return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
}

function publicEndpoint(row: Record<string, unknown>): WebhookEndpointSummary {
  return {
    id: Number(row.id),
    name: String(row.name),
    endpoint: String(row.endpoint),
    eventTypes: JSON.parse(String(row.eventTypesJson)) as string[],
    active: !!row.active,
    hasSecret: !!row.encryptedSecret,
    lastError: row.lastError == null ? null : String(row.lastError),
    createdBy: String(row.createdBy),
    createdAt: String(row.createdAt),
  };
}

export function listWebhookEndpoints(db: DB): WebhookEndpointSummary[] {
  return (
    db
      .prepare(
        `SELECT id,name,endpoint,event_types_json AS eventTypesJson,encrypted_secret AS encryptedSecret,
                active,last_error AS lastError,created_by AS createdBy,created_at AS createdAt
         FROM webhook_endpoints ORDER BY id DESC`,
      )
      .all() as Record<string, unknown>[]
  ).map(publicEndpoint);
}

export function saveWebhookEndpoint(
  db: DB,
  input: {
    name: string;
    endpoint: string;
    eventTypes: string[];
    secret: string;
  },
  actor: string,
): WebhookEndpointSummary {
  const eventTypes = [...new Set(input.eventTypes.map((value) => value.trim()))];
  if (
    eventTypes.length === 0 ||
    eventTypes.length > 20 ||
    eventTypes.some((value) => !/^[a-z][a-z0-9_.-]{1,79}$/.test(value))
  )
    throw new Error("Choose 1–20 valid event types");
  if (input.secret.length < 16 || input.secret.length > 200)
    throw new Error("Webhook signing secret must be 16–200 characters");
  const result = db
    .prepare(
      `INSERT INTO webhook_endpoints(name,endpoint,event_types_json,encrypted_secret,created_by)
       VALUES(?,?,?,?,?)`,
    )
    .run(
      input.name.trim(),
      validateWebhookEndpoint(input.endpoint),
      JSON.stringify(eventTypes),
      encryptSecret(input.secret),
      actor,
    );
  const created = listWebhookEndpoints(db).find(
    (row) => row.id === Number(result.lastInsertRowid),
  )!;
  writeAudit(db, "webhook_endpoint", created.id, "create", null, created);
  return created;
}

export function setWebhookEndpointActive(
  db: DB,
  id: number,
  active: boolean,
): WebhookEndpointSummary {
  const before = listWebhookEndpoints(db).find((row) => row.id === id);
  if (!before) throw new Error("Webhook endpoint not found");
  db.prepare(
    "UPDATE webhook_endpoints SET active=?,updated_at=datetime('now') WHERE id=?",
  ).run(active ? 1 : 0, id);
  const after = listWebhookEndpoints(db).find((row) => row.id === id)!;
  writeAudit(db, "webhook_endpoint", id, "update", before, after);
  return after;
}

function outboxEvent(row: Record<string, unknown>): WebhookOutboxEvent {
  return {
    id: String(row.id),
    endpointId: Number(row.endpointId),
    endpointName: String(row.endpointName),
    eventType: String(row.eventType),
    payload: JSON.parse(String(row.payloadJson)),
    payloadHash: String(row.payloadHash),
    state: row.state as WebhookOutboxEvent["state"],
    attempts: Number(row.attempts),
    nextAttemptAt: String(row.nextAttemptAt),
    lastError: row.lastError == null ? null : String(row.lastError),
    createdAt: String(row.createdAt),
    deliveredAt: row.deliveredAt == null ? null : String(row.deliveredAt),
  };
}

export function listWebhookOutbox(db: DB, limit = 200): WebhookOutboxEvent[] {
  return (
    db
      .prepare(
        `SELECT wo.id,wo.endpoint_id AS endpointId,we.name AS endpointName,wo.event_type AS eventType,
                wo.payload_json AS payloadJson,wo.payload_hash AS payloadHash,wo.state,wo.attempts,
                wo.next_attempt_at AS nextAttemptAt,wo.last_error AS lastError,wo.created_at AS createdAt,
                wo.delivered_at AS deliveredAt
         FROM webhook_outbox wo JOIN webhook_endpoints we ON we.id=wo.endpoint_id
         ORDER BY wo.created_at DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(1000, limit))) as Record<string, unknown>[]
  ).map(outboxEvent);
}

export function enqueueWebhookEvent(
  db: DB,
  eventType: string,
  payload: unknown,
): WebhookOutboxEvent[] {
  if (!/^[a-z][a-z0-9_.-]{1,79}$/.test(eventType))
    throw new Error("Invalid webhook event type");
  const payloadJson = JSON.stringify(payload);
  if (Buffer.byteLength(payloadJson) > MAX_WEBHOOK_BYTES)
    throw new Error("Webhook payload exceeds the 256 KB limit");
  const hash = createHash("sha256").update(payloadJson).digest("hex");
  const endpoints = db
    .prepare(
      `SELECT id,event_types_json AS eventTypesJson FROM webhook_endpoints WHERE active=1`,
    )
    .all() as { id: number; eventTypesJson: string }[];
  const ids: string[] = [];
  const insert = db.prepare(
    `INSERT INTO webhook_outbox(id,endpoint_id,event_type,payload_json,payload_hash)
     VALUES(?,?,?,?,?)`,
  );
  db.transaction(() => {
    for (const endpoint of endpoints) {
      const types = JSON.parse(endpoint.eventTypesJson) as string[];
      if (!types.includes(eventType) && !types.includes("*")) continue;
      const id = randomUUID();
      insert.run(id, endpoint.id, eventType, payloadJson, hash);
      ids.push(id);
    }
  })();
  const all = listWebhookOutbox(db, Math.max(200, ids.length));
  return all.filter((row) => ids.includes(row.id));
}

export async function deliverWebhookEvent(
  db: DB,
  id: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<WebhookOutboxEvent> {
  const row = db
    .prepare(
      `SELECT wo.id,wo.endpoint_id AS endpointId,wo.payload_json AS payloadJson,wo.event_type AS eventType,
              wo.attempts,we.endpoint,we.encrypted_secret AS encryptedSecret,we.active
       FROM webhook_outbox wo JOIN webhook_endpoints we ON we.id=wo.endpoint_id WHERE wo.id=?`,
    )
    .get(id) as
    | {
        id: string;
        endpointId: number;
        payloadJson: string;
        eventType: string;
        attempts: number;
        endpoint: string;
        encryptedSecret: string;
        active: number;
      }
    | undefined;
  if (!row) throw new Error("Webhook event not found");
  if (!row.active) throw new Error("Webhook endpoint is paused");
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", decryptSecret(row.encryptedSecret))
    .update(`${timestamp}.${row.payloadJson}`)
    .digest("hex");
  try {
    const response = await fetchImpl(row.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Total-Webhook/1",
        "x-total-event": row.eventType,
        "x-total-delivery": row.id,
        "x-total-signature": `t=${timestamp},v1=${signature}`,
      },
      body: row.payloadJson,
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Receiver returned HTTP ${response.status}`);
    db.prepare(
      `UPDATE webhook_outbox SET state='delivered',attempts=attempts+1,delivered_at=datetime('now'),last_error=NULL WHERE id=?`,
    ).run(id);
    db.prepare(
      "UPDATE webhook_endpoints SET last_error=NULL,updated_at=datetime('now') WHERE id=?",
    ).run(row.endpointId);
  } catch (error) {
    const attempts = row.attempts + 1;
    const dead = attempts >= 8;
    const delayMinutes = Math.min(24 * 60, 2 ** Math.min(attempts, 10));
    const next = new Date(Date.now() + delayMinutes * 60_000).toISOString();
    const message = error instanceof Error ? error.message.slice(0, 500) : "Delivery failed";
    db.prepare(
      `UPDATE webhook_outbox SET state=?,attempts=?,next_attempt_at=?,last_error=? WHERE id=?`,
    ).run(dead ? "dead" : "retry", attempts, next, message, id);
    db.prepare(
      "UPDATE webhook_endpoints SET last_error=?,updated_at=datetime('now') WHERE id=?",
    ).run(message, row.endpointId);
  }
  return listWebhookOutbox(db, 1000).find((event) => event.id === id)!;
}

export async function deliverDueWebhooks(db: DB): Promise<WebhookOutboxEvent[]> {
  const due = listWebhookOutbox(db, 1000).filter(
    (event) =>
      (event.state === "pending" || event.state === "retry") &&
      Date.parse(event.nextAttemptAt) <= Date.now(),
  );
  const delivered: WebhookOutboxEvent[] = [];
  for (const event of due.slice(0, 10))
    delivered.push(await deliverWebhookEvent(db, event.id));
  return delivered;
}

function nextOccurrence(
  cadence: AutomationSchedule["cadence"],
  localTime: string,
  dayOfWeek: number | null,
  dayOfMonth: number | null,
  after = new Date(),
): string {
  const [hour = 0, minute = 0] = localTime.split(":").map(Number);
  const next = new Date(after);
  next.setSeconds(0, 0);
  next.setHours(hour, minute, 0, 0);
  if (cadence === "daily") {
    if (next <= after) next.setDate(next.getDate() + 1);
  } else if (cadence === "weekly") {
    const wanted = dayOfWeek ?? 1;
    let add = (wanted - next.getDay() + 7) % 7;
    if (add === 0 && next <= after) add = 7;
    next.setDate(next.getDate() + add);
  } else {
    const wanted = dayOfMonth ?? 1;
    next.setDate(wanted);
    if (next <= after) {
      next.setMonth(next.getMonth() + 1, 1);
      next.setDate(wanted);
    }
  }
  return next.toISOString();
}

function scheduleOf(row: Record<string, unknown>): AutomationSchedule {
  return {
    id: Number(row.id),
    name: String(row.name),
    taskKind: row.taskKind as AutomationTaskKind,
    cadence: row.cadence as AutomationSchedule["cadence"],
    localTime: String(row.localTime),
    dayOfWeek: row.dayOfWeek == null ? null : Number(row.dayOfWeek),
    dayOfMonth: row.dayOfMonth == null ? null : Number(row.dayOfMonth),
    enabled: !!row.enabled,
    config: JSON.parse(String(row.configJson)),
    nextRunAt: String(row.nextRunAt),
    lastRunAt: row.lastRunAt == null ? null : String(row.lastRunAt),
    createdBy: String(row.createdBy),
    createdAt: String(row.createdAt),
  };
}

export function listAutomationSchedules(db: DB): AutomationSchedule[] {
  return (
    db
      .prepare(
        `SELECT id,name,task_kind AS taskKind,cadence,local_time AS localTime,day_of_week AS dayOfWeek,
                day_of_month AS dayOfMonth,enabled,config_json AS configJson,next_run_at AS nextRunAt,
                last_run_at AS lastRunAt,created_by AS createdBy,created_at AS createdAt
         FROM automation_schedules ORDER BY id DESC`,
      )
      .all() as Record<string, unknown>[]
  ).map(scheduleOf);
}

export function saveAutomationSchedule(
  db: DB,
  input: {
    name: string;
    taskKind: AutomationTaskKind;
    cadence: AutomationSchedule["cadence"];
    localTime: string;
    dayOfWeek?: number | null;
    dayOfMonth?: number | null;
    config?: Record<string, unknown>;
  },
  actor: string,
): AutomationSchedule {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.localTime))
    throw new Error("Automation time must be HH:mm");
  if (input.cadence === "weekly" && (input.dayOfWeek == null || input.dayOfWeek < 0 || input.dayOfWeek > 6))
    throw new Error("Weekly automation needs a weekday");
  if (input.cadence === "monthly" && (input.dayOfMonth == null || input.dayOfMonth < 1 || input.dayOfMonth > 28))
    throw new Error("Monthly automation needs a day from 1 to 28");
  const configJson = JSON.stringify(input.config ?? {});
  if (Buffer.byteLength(configJson) > 16 * 1024)
    throw new Error("Automation configuration exceeds 16 KB");
  const nextRunAt = nextOccurrence(
    input.cadence,
    input.localTime,
    input.dayOfWeek ?? null,
    input.dayOfMonth ?? null,
  );
  const result = db.prepare(
    `INSERT INTO automation_schedules
     (name,task_kind,cadence,local_time,day_of_week,day_of_month,config_json,next_run_at,created_by)
     VALUES(?,?,?,?,?,?,?,?,?)`,
  ).run(
    input.name.trim(),
    input.taskKind,
    input.cadence,
    input.localTime,
    input.cadence === "weekly" ? input.dayOfWeek : null,
    input.cadence === "monthly" ? input.dayOfMonth : null,
    configJson,
    nextRunAt,
    actor,
  );
  const created = listAutomationSchedules(db).find(
    (row) => row.id === Number(result.lastInsertRowid),
  )!;
  writeAudit(db, "automation_schedule", created.id, "create", null, created);
  return created;
}

export function setAutomationEnabled(
  db: DB,
  id: number,
  enabled: boolean,
): AutomationSchedule {
  const before = listAutomationSchedules(db).find((row) => row.id === id);
  if (!before) throw new Error("Automation schedule not found");
  db.prepare(
    `UPDATE automation_schedules SET enabled=?,next_run_at=?,updated_at=datetime('now') WHERE id=?`,
  ).run(
    enabled ? 1 : 0,
    nextOccurrence(
      before.cadence,
      before.localTime,
      before.dayOfWeek,
      before.dayOfMonth,
    ),
    id,
  );
  const after = listAutomationSchedules(db).find((row) => row.id === id)!;
  writeAudit(db, "automation_schedule", id, "update", before, after);
  return after;
}

function runOf(row: Record<string, unknown>): AutomationRun {
  return {
    id: Number(row.id),
    scheduleId: Number(row.scheduleId),
    taskKind: row.taskKind as AutomationTaskKind,
    status: row.status as AutomationRun["status"],
    startedAt: String(row.startedAt),
    finishedAt: row.finishedAt == null ? null : String(row.finishedAt),
    output: row.outputJson == null ? null : JSON.parse(String(row.outputJson)),
    error: row.error == null ? null : String(row.error),
  };
}

export function listAutomationRuns(db: DB, limit = 100): AutomationRun[] {
  return (
    db
      .prepare(
        `SELECT id,schedule_id AS scheduleId,task_kind AS taskKind,status,started_at AS startedAt,
                finished_at AS finishedAt,output_json AS outputJson,error
         FROM automation_runs ORDER BY id DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(500, limit))) as Record<string, unknown>[]
  ).map(runOf);
}

export async function runAutomation(
  db: DB,
  company: CompanyInfo,
  slug: string,
  scheduleId: number,
): Promise<AutomationRun> {
  const schedule = listAutomationSchedules(db).find((row) => row.id === scheduleId);
  if (!schedule) throw new Error("Automation schedule not found");
  const result = db.prepare(
    "INSERT INTO automation_runs(schedule_id,task_kind,status) VALUES(?,?,'running')",
  ).run(schedule.id, schedule.taskKind);
  const runId = Number(result.lastInsertRowid);
  db.prepare(
    `UPDATE automation_schedules SET last_run_at=datetime('now'),next_run_at=?,updated_at=datetime('now') WHERE id=?`,
  ).run(
    nextOccurrence(
      schedule.cadence,
      schedule.localTime,
      schedule.dayOfWeek,
      schedule.dayOfMonth,
      new Date(Date.now() + 1000),
    ),
    schedule.id,
  );
  try {
    let output: Record<string, unknown>;
    if (schedule.taskKind === "backup") {
      const path = await backupCompany(db, slug, "scheduled");
      output = { path, copies: replicateBackup(db, slug, path) };
      applyRotationPolicy(db, slug);
    } else if (schedule.taskKind === "mirror") {
      output = { ...exportMirror(db, slug) };
    } else {
      const from =
        typeof schedule.config.from === "string"
          ? schedule.config.from
          : `${company.booksFrom}-04-01`;
      const to =
        typeof schedule.config.to === "string"
          ? schedule.config.to
          : new Date().toISOString().slice(0, 10);
      output = exportCaPack(db, company, slug, from, to);
    }
    db.prepare(
      `UPDATE automation_runs SET status='succeeded',finished_at=datetime('now'),output_json=? WHERE id=?`,
    ).run(JSON.stringify(output), runId);
  } catch (error) {
    db.prepare(
      `UPDATE automation_runs SET status='failed',finished_at=datetime('now'),error=? WHERE id=?`,
    ).run(error instanceof Error ? error.message.slice(0, 1000) : "Automation failed", runId);
  }
  return listAutomationRuns(db, 500).find((row) => row.id === runId)!;
}

export async function runDueAutomations(
  db: DB,
  company: CompanyInfo,
  slug: string,
): Promise<AutomationRun[]> {
  const due = listAutomationSchedules(db).filter(
    (row) => row.enabled && Date.parse(row.nextRunAt) <= Date.now(),
  );
  const runs: AutomationRun[] = [];
  for (const schedule of due.slice(0, 10))
    runs.push(await runAutomation(db, company, slug, schedule.id));
  return runs;
}
