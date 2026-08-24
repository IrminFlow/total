import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statfsSync,
  unlinkSync,
} from "fs";
import { basename, join, resolve } from "path";
import type { DB } from "../db/connection";
import { companyBackupsDir } from "../paths";
import {
  backupStamp,
  inspectBackup,
  listBackupsIn,
  quickCheckOk,
  snapshotSync,
} from "../db/backup";
import type {
  BackupDestination,
  BackupRotationPolicy,
  BackupSpaceForecast,
  RecoveryDrill,
} from "@shared/resilience";
import { writeAudit } from "./audit";

function destinationKind(path: string): BackupDestination["kind"] {
  if (
    path.startsWith("/Volumes/") ||
    path.startsWith("/Network/") ||
    path.startsWith("\\\\") ||
    /(?:Dropbox|OneDrive|Google Drive|CloudStorage)/i.test(path)
  )
    return "network_or_mounted_cloud";
  if (/^(?:[D-Z]:\\|\/media\/|\/mnt\/)/i.test(path)) return "external";
  return "local";
}

function health(path: string): Pick<
  BackupDestination,
  "kind" | "available" | "writable" | "freeBytes" | "warning"
> {
  const kind = destinationKind(path);
  if (!existsSync(path))
    return {
      kind,
      available: false,
      writable: false,
      freeBytes: null,
      warning: "Destination is not currently mounted or available",
    };
  let writable = false;
  try {
    accessSync(path, constants.W_OK);
    writable = true;
  } catch {
    // Reported below.
  }
  let freeBytes: number | null = null;
  try {
    const stats = statfsSync(path);
    freeBytes = Number(stats.bavail) * Number(stats.bsize);
  } catch {
    // Some mounted providers do not expose filesystem statistics.
  }
  const warning = !writable
    ? "Destination is read-only"
    : freeBytes !== null && freeBytes < 500 * 1024 * 1024
      ? "Less than 500 MB is available"
      : kind === "network_or_mounted_cloud"
        ? "Keep this destination mounted until each copy is verified"
        : null;
  return { kind, available: true, writable, freeBytes, warning };
}

function destinationOf(row: Record<string, unknown>): BackupDestination {
  const path = String(row.path);
  return {
    id: Number(row.id),
    name: String(row.name),
    path,
    active: !!row.active,
    ...health(path),
    lastSuccessAt: row.lastSuccessAt == null ? null : String(row.lastSuccessAt),
    lastError: row.lastError == null ? null : String(row.lastError),
    createdBy: String(row.createdBy),
    createdAt: String(row.createdAt),
  };
}

export function listBackupDestinations(db: DB): BackupDestination[] {
  return (
    db
      .prepare(
        `SELECT id,name,path,active,last_success_at AS lastSuccessAt,last_error AS lastError,
                created_by AS createdBy,created_at AS createdAt
         FROM backup_destinations ORDER BY id`,
      )
      .all() as Record<string, unknown>[]
  ).map(destinationOf);
}

export function addBackupDestination(
  db: DB,
  name: string,
  path: string,
  actor: string,
): BackupDestination {
  const absolute = resolve(path);
  const state = health(absolute);
  if (!state.available || !state.writable)
    throw new Error(state.warning ?? "Backup destination is unavailable");
  const result = db
    .prepare(
      `INSERT INTO backup_destinations(name,path,created_by) VALUES(?,?,?)`,
    )
    .run(name.trim(), absolute, actor);
  const created = listBackupDestinations(db).find(
    (row) => row.id === Number(result.lastInsertRowid),
  )!;
  writeAudit(db, "backup_destination", created.id, "create", null, created);
  return created;
}

export function setBackupDestinationActive(
  db: DB,
  id: number,
  active: boolean,
): BackupDestination {
  const before = listBackupDestinations(db).find((row) => row.id === id);
  if (!before) throw new Error("Backup destination not found");
  if (active) {
    const state = health(before.path);
    if (!state.available || !state.writable)
      throw new Error(state.warning ?? "Backup destination is unavailable");
  }
  db.prepare(
    "UPDATE backup_destinations SET active=?,updated_at=datetime('now') WHERE id=?",
  ).run(active ? 1 : 0, id);
  const after = listBackupDestinations(db).find((row) => row.id === id)!;
  writeAudit(db, "backup_destination", id, "update", before, after);
  return after;
}

function destinationCompanyDir(destination: BackupDestination, slug: string): string {
  return join(destination.path, "Total Backups", slug);
}

const TIERED_BACKUP_TAGS = new Set(["auto", "scheduled", "open"]);
const YEAR_END_TAG = /^year-end-pre-close-fy(\d{4})(?:-|$)/;

function rotateBackupDirectory(
  dir: string,
  policy: BackupRotationPolicy,
): string[] {
  const files = listBackupsIn(dir);
  const keep = new Set<string>();
  const buckets = {
    daily: new Set<string>(),
    weekly: new Set<string>(),
    monthly: new Set<string>(),
    yearEnd: new Set<string>(),
  };
  const coveredWeeks = new Set<string>();
  const coveredMonths = new Set<string>();

  for (const file of files) {
    const yearEnd = YEAR_END_TAG.exec(file.tag);
    if (yearEnd) {
      const financialYear = yearEnd[1]!;
      if (
        buckets.yearEnd.size < policy.yearEndCount &&
        !buckets.yearEnd.has(financialYear)
      ) {
        buckets.yearEnd.add(financialYear);
        keep.add(file.file);
      }
      continue;
    }

    if (!TIERED_BACKUP_TAGS.has(file.tag)) {
      // Manual, pre-import, pre-upgrade, pre-restore and quit snapshots are explicit safety
      // points. A background retention pass must never silently remove them.
      keep.add(file.file);
      continue;
    }

    const date = new Date(file.mtime);
    const daily = date.toISOString().slice(0, 10);
    const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const week = `${date.getUTCFullYear()}-${Math.floor((date.getTime() - start.getTime()) / (7 * 86_400_000))}`;
    const monthly = daily.slice(0, 7);
    if (buckets.daily.size < policy.dailyCount && !buckets.daily.has(daily)) {
      buckets.daily.add(daily);
      coveredWeeks.add(week);
      coveredMonths.add(monthly);
      keep.add(file.file);
      continue;
    }
    if (buckets.weekly.size < policy.weeklyCount && !coveredWeeks.has(week)) {
      buckets.weekly.add(week);
      coveredWeeks.add(week);
      coveredMonths.add(monthly);
      keep.add(file.file);
      continue;
    }
    if (
      buckets.monthly.size < policy.monthlyCount &&
      !coveredMonths.has(monthly)
    ) {
      buckets.monthly.add(monthly);
      coveredMonths.add(monthly);
      keep.add(file.file);
    }
  }

  const removed: string[] = [];
  for (const file of files) {
    const managed = TIERED_BACKUP_TAGS.has(file.tag) || YEAR_END_TAG.test(file.tag);
    if (managed && !keep.has(file.file)) {
      unlinkSync(join(dir, file.file));
      removed.push(file.file);
    }
  }
  return removed;
}

/** A verified restore point immediately before posting and locking a financial-year close. */
export function createYearEndRestorePoint(
  db: DB,
  slug: string,
  fyStartYear: number,
): string {
  const dest = join(
    companyBackupsDir(slug),
    `${backupStamp()}-year-end-pre-close-fy${fyStartYear}-${Date.now()}.db`,
  );
  snapshotSync(db, dest);
  if (!quickCheckOk(dest)) {
    unlinkSync(dest);
    throw new Error(
      "Year-end restore-point verification failed — the books were not closed",
    );
  }
  return dest;
}

export function replicateBackup(
  db: DB,
  slug: string,
  sourcePath: string,
): { destinationId: number; path: string; ok: boolean; error: string | null }[] {
  const results = [];
  for (const destination of listBackupDestinations(db).filter((row) => row.active)) {
    const state = health(destination.path);
    if (!state.available || !state.writable) {
      const error = state.warning ?? "Destination unavailable";
      db.prepare(
        "UPDATE backup_destinations SET last_error=?,updated_at=datetime('now') WHERE id=?",
      ).run(error, destination.id);
      results.push({ destinationId: destination.id, path: destination.path, ok: false, error });
      continue;
    }
    const dir = destinationCompanyDir(destination, slug);
    mkdirSync(dir, { recursive: true });
    const finalPath = join(dir, basename(sourcePath));
    const tempPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      copyFileSync(sourcePath, tempPath);
      if (!quickCheckOk(tempPath)) throw new Error("Copied backup failed integrity verification");
      renameSync(tempPath, finalPath);
      // Destination folders obey the same tiered policy as the company-local folder. Explicit
      // safety points remain untouched, while unattended replication cannot grow without bound.
      rotateBackupDirectory(dir, getRotationPolicy(db));
      db.prepare(
        `UPDATE backup_destinations SET last_success_at=datetime('now'),last_error=NULL,updated_at=datetime('now') WHERE id=?`,
      ).run(destination.id);
      results.push({ destinationId: destination.id, path: finalPath, ok: true, error: null });
    } catch (error) {
      if (existsSync(tempPath)) unlinkSync(tempPath);
      const message = error instanceof Error ? error.message.slice(0, 500) : "Backup copy failed";
      db.prepare(
        "UPDATE backup_destinations SET last_error=?,updated_at=datetime('now') WHERE id=?",
      ).run(message, destination.id);
      results.push({ destinationId: destination.id, path: finalPath, ok: false, error: message });
    }
  }
  return results;
}

function drillOf(row: Record<string, unknown>): RecoveryDrill {
  return {
    id: Number(row.id),
    backupFile: String(row.backupFile),
    sourceKind: row.sourceKind as RecoveryDrill["sourceKind"],
    sourcePath: String(row.sourcePath),
    integrity: row.integrity as RecoveryDrill["integrity"],
    detail: String(row.detail),
    companyName: row.companyName == null ? null : String(row.companyName),
    schemaVersion: row.schemaVersion == null ? null : Number(row.schemaVersion),
    voucherCount: row.voucherCount == null ? null : Number(row.voucherCount),
    verifiedBy: String(row.verifiedBy),
    verifiedAt: String(row.verifiedAt),
  };
}

export function listRecoveryDrills(db: DB): RecoveryDrill[] {
  return (
    db
      .prepare(
        `SELECT id,backup_file AS backupFile,source_kind AS sourceKind,source_path AS sourcePath,
                integrity,detail,company_name AS companyName,schema_version AS schemaVersion,
                voucher_count AS voucherCount,verified_by AS verifiedBy,verified_at AS verifiedAt
         FROM backup_recovery_drills ORDER BY id DESC LIMIT 100`,
      )
      .all() as Record<string, unknown>[]
  ).map(drillOf);
}

export function recoveryDrillDue(db: DB, now = new Date()): boolean {
  const latest = listRecoveryDrills(db)[0];
  return !latest || now.getTime() - Date.parse(latest.verifiedAt) > 90 * 86_400_000;
}

export function runRecoveryDrill(
  db: DB,
  slug: string,
  actor: string,
  destinationId?: number | null,
): RecoveryDrill {
  let sourceKind: RecoveryDrill["sourceKind"] = "company";
  let sourcePath = companyBackupsDir(slug);
  if (destinationId != null) {
    const destination = listBackupDestinations(db).find((row) => row.id === destinationId);
    if (!destination) throw new Error("Backup destination not found");
    sourceKind = "destination";
    sourcePath = destinationCompanyDir(destination, slug);
  }
  const files = listBackupsIn(sourcePath);
  if (!files[0]) throw new Error("No backup is available for a recovery drill");
  const path = join(sourcePath, files[0].file);
  const preview = inspectBackup(path);
  const result = db.prepare(
    `INSERT INTO backup_recovery_drills
     (backup_file,source_kind,source_path,integrity,detail,company_name,schema_version,voucher_count,verified_by)
     VALUES(?,?,?,?,?,?,?,?,?)`,
  ).run(
    files[0].file,
    sourceKind,
    sourcePath,
    preview.integrity,
    preview.detail,
    preview.company?.name ?? null,
    preview.schemaVersion,
    preview.voucherCount,
    actor,
  );
  const drill = listRecoveryDrills(db).find(
    (row) => row.id === Number(result.lastInsertRowid),
  )!;
  writeAudit(db, "recovery_drill", drill.id, "create", null, drill);
  return drill;
}

export function getRotationPolicy(db: DB): BackupRotationPolicy {
  const row = db.prepare(
    `SELECT daily_count AS dailyCount,weekly_count AS weeklyCount,monthly_count AS monthlyCount,
            year_end_count AS yearEndCount,updated_by AS updatedBy,updated_at AS updatedAt
     FROM backup_rotation_policy WHERE id=1`,
  ).get() as Record<string, unknown>;
  return {
    dailyCount: Number(row.dailyCount),
    weeklyCount: Number(row.weeklyCount),
    monthlyCount: Number(row.monthlyCount),
    yearEndCount: Number(row.yearEndCount),
    updatedBy: String(row.updatedBy),
    updatedAt: String(row.updatedAt),
  };
}

export function setRotationPolicy(
  db: DB,
  input: Omit<BackupRotationPolicy, "updatedBy" | "updatedAt">,
  actor: string,
): BackupRotationPolicy {
  const before = getRotationPolicy(db);
  const inRange =
    Number.isInteger(input.dailyCount) && input.dailyCount >= 1 && input.dailyCount <= 365 &&
    Number.isInteger(input.weeklyCount) && input.weeklyCount >= 0 && input.weeklyCount <= 104 &&
    Number.isInteger(input.monthlyCount) && input.monthlyCount >= 0 && input.monthlyCount <= 120 &&
    Number.isInteger(input.yearEndCount) && input.yearEndCount >= 0 && input.yearEndCount <= 25;
  if (!inRange) throw new Error("Backup retention counts are outside safe limits");
  db.prepare(
    `UPDATE backup_rotation_policy SET daily_count=?,weekly_count=?,monthly_count=?,year_end_count=?,
       updated_by=?,updated_at=datetime('now') WHERE id=1`,
  ).run(input.dailyCount, input.weeklyCount, input.monthlyCount, input.yearEndCount, actor);
  const after = getRotationPolicy(db);
  writeAudit(db, "backup_rotation", 1, "update", before, after);
  return after;
}

export function backupSpaceForecast(
  db: DB,
  slug: string,
  destinationId?: number | null,
): BackupSpaceForecast {
  const files = listBackupsIn(companyBackupsDir(slug));
  const currentBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  const averageBytes = files.length ? Math.round(currentBytes / files.length) : 0;
  const policy = getRotationPolicy(db);
  const projectedRetainedFiles =
    policy.dailyCount + policy.weeklyCount + policy.monthlyCount + policy.yearEndCount;
  const projectedBytes = averageBytes * projectedRetainedFiles;
  const destination = destinationId == null
    ? null
    : listBackupDestinations(db).find((row) => row.id === destinationId) ?? null;
  const destinationFreeBytes = destination?.freeBytes ?? null;
  return {
    currentBytes,
    averageBytes,
    projectedRetainedFiles,
    projectedBytes,
    destinationFreeBytes,
    fitsDestination:
      destinationFreeBytes == null ? null : projectedBytes <= destinationFreeBytes,
  };
}

export function applyRotationPolicy(db: DB, slug: string): string[] {
  return rotateBackupDirectory(companyBackupsDir(slug), getRotationPolicy(db));
}
