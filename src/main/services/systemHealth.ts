import Database from "better-sqlite3";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statfsSync,
  statSync,
} from "fs";
import { basename, join } from "path";
import type { DB } from "../db/connection";
import { backupStamp, quickCheckOk } from "../db/backup";
import { companyBackupsDir, companyDbPath, companyDir } from "../paths";
import { writeAudit } from "./audit";

export type DiskState = "healthy" | "warning" | "critical";
export interface SystemHealthSummary {
  quickCheck: string;
  databaseBytes: number;
  walBytes: number;
  pageBytes: number;
  reclaimableBytes: number;
  schemaVersion: number;
  journalMode: string;
  freeBytes: number;
  diskState: DiskState;
  riskyImportsAllowed: boolean;
}

function size(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function freeBytesAt(path: string): number {
  const stats = statfsSync(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

export function diskState(
  freeBytes: number,
  databaseBytes: number,
  estimatedWriteBytes = 0,
): DiskState {
  const criticalFloor = Math.max(
    512 * 1024 * 1024,
    databaseBytes * 2,
    estimatedWriteBytes * 3,
  );
  if (freeBytes < criticalFloor) return "critical";
  if (freeBytes < Math.max(2 * 1024 * 1024 * 1024, databaseBytes * 4))
    return "warning";
  return "healthy";
}

export function systemHealth(db: DB, slug: string): SystemHealthSummary {
  const dbPath = companyDbPath(slug);
  const pageSize = Number(db.pragma("page_size", { simple: true }));
  const pageCount = Number(db.pragma("page_count", { simple: true }));
  const freelist = Number(db.pragma("freelist_count", { simple: true }));
  const databaseBytes = size(dbPath);
  const freeBytes = freeBytesAt(companyDir(slug));
  const state = diskState(freeBytes, databaseBytes);
  return {
    quickCheck: String(db.pragma("quick_check", { simple: true })),
    databaseBytes,
    walBytes: size(`${dbPath}-wal`),
    pageBytes: pageSize * pageCount,
    reclaimableBytes: pageSize * freelist,
    schemaVersion:
      (
        db.prepare("SELECT MAX(id) AS version FROM migrations").get() as {
          version: number | null;
        }
      ).version ?? 0,
    journalMode: String(db.pragma("journal_mode", { simple: true })),
    freeBytes,
    diskState: state,
    riskyImportsAllowed: state !== "critical",
  };
}

export function assertImportCapacity(
  slug: string,
  estimatedWriteBytes: number,
): void {
  const path = companyDbPath(slug);
  const free = freeBytesAt(companyDir(slug));
  const state = diskState(free, size(path), estimatedWriteBytes);
  if (state === "critical") {
    throw new Error(
      "Low-disk protection blocked this import. Free at least 2 GB or move Total's data folder, then try again; existing books remain writable.",
    );
  }
}

export function runMaintenance(
  db: DB,
  slug: string,
  mode: "quick" | "optimize" | "full",
  actor: string,
): SystemHealthSummary & { mode: string; detail: string } {
  let detail = "Quick integrity check completed";
  if (mode === "optimize") {
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.pragma("optimize");
    detail = "WAL checkpoint and query planner optimization completed";
  } else if (mode === "full") {
    const result = db.pragma("integrity_check") as Array<{
      integrity_check: string;
    }>;
    detail = result[0]?.integrity_check ?? "No integrity result";
  }
  const after = { ...systemHealth(db, slug), mode, detail };
  writeAudit(db, "database_maintenance", 0, "update", null, {
    actor,
    mode,
    detail,
    diskState: after.diskState,
    databaseBytes: after.databaseBytes,
  });
  return after;
}

export interface RecoveryCopyResult {
  success: boolean;
  detail: string;
  preservedFolder: string;
  recoveredBackup: string | null;
}

/** Preserves byte-for-byte originals, then attempts SQLite's online recovery into a separate copy. */
export async function attemptRecoveryCopy(
  slug: string,
): Promise<RecoveryCopyResult> {
  const sourcePath = companyDbPath(slug);
  const stamp = backupStamp();
  const preservedFolder = join(
    companyDir(slug),
    "recovery",
    `${stamp}-original`,
  );
  mkdirSync(preservedFolder, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = `${sourcePath}${suffix}`;
    if (existsSync(source))
      copyFileSync(source, join(preservedFolder, basename(source)));
  }
  const working = join(
    companyDir(slug),
    "recovery",
    `${stamp}-recovery-working.db`,
  );
  const recoveredBackup = join(
    companyBackupsDir(slug),
    `${stamp}-recovered-copy.db`,
  );
  let source: Database.Database | null = null;
  try {
    source = new Database(sourcePath, { readonly: true, fileMustExist: true });
    await source.backup(working);
    source.close();
    source = null;
    if (!quickCheckOk(working)) {
      return {
        success: false,
        detail:
          "SQLite produced a copy, but its integrity check still failed. The original files were preserved for specialist recovery.",
        preservedFolder,
        recoveredBackup: null,
      };
    }
    renameSync(working, recoveredBackup);
    return {
      success: true,
      detail:
        "A verified recovery copy was added to Backups. The live database was not replaced.",
      preservedFolder,
      recoveredBackup,
    };
  } catch (error) {
    source?.close();
    return {
      success: false,
      detail: `Automatic recovery could not read enough of the database: ${error instanceof Error ? error.message : String(error)}`,
      preservedFolder,
      recoveredBackup: null,
    };
  }
}
