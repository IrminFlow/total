import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { seededDb } from "../db/testdb";
import { backupStamp, listBackupsIn, snapshotSync } from "../db/backup";
import { companyBackupsDir, ensureCompanyTree } from "../paths";
import {
  addBackupDestination,
  applyRotationPolicy,
  backupSpaceForecast,
  createYearEndRestorePoint,
  getRotationPolicy,
  listBackupDestinations,
  recoveryDrillDue,
  replicateBackup,
  runRecoveryDrill,
  setRotationPolicy,
} from "./resilience";

function snapshotAt(
  db: ReturnType<typeof seededDb>,
  dir: string,
  stamp: string,
  tag: string,
): string {
  const path = join(dir, `${stamp}-${tag}.db`);
  snapshotSync(db, path);
  const date = new Date(stamp.replace(/T(\d{2})-(\d{2})-(\d{2})$/, "T$1:$2:$3Z"));
  utimesSync(path, date, date);
  return path;
}

let root: string | null = null;
afterEach(() => {
  delete process.env.TOTAL_DATA_DIR;
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe("resilient backup destinations and drills", () => {
  it("copies only integrity-verified snapshots to a selected folder and records a drill", () => {
    root = mkdtempSync(join(tmpdir(), "total-resilience-"));
    process.env.TOTAL_DATA_DIR = join(root, "data");
    const selected = join(root, "mounted-backups");
    mkdirSync(selected);
    const slug = "recovery-books";
    ensureCompanyTree(slug);
    ensureCompanyTree("unused");
    const db = seededDb();
    const source = join(companyBackupsDir(slug), `${backupStamp()}-manual.db`);
    snapshotSync(db, source);
    const destination = addBackupDestination(db, "External disk", selected, "Owner");
    // The folder chooser creates the selected folder before the service receives it.
    expect(destination.available).toBe(true);
    const [copy] = replicateBackup(db, slug, source);
    expect(copy).toMatchObject({ ok: true, destinationId: destination.id });
    expect(existsSync(copy!.path)).toBe(true);
    const drill = runRecoveryDrill(db, slug, "Owner", destination.id);
    expect(drill).toMatchObject({ integrity: "ok", sourceKind: "destination" });
    expect(recoveryDrillDue(db)).toBe(false);
    expect(listBackupDestinations(db)[0]?.lastSuccessAt).not.toBeNull();
  });

  it("retains daily/weekly/monthly/year-end policy and forecasts disk need", () => {
    root = mkdtempSync(join(tmpdir(), "total-rotation-"));
    process.env.TOTAL_DATA_DIR = root;
    const slug = "rotation-books";
    ensureCompanyTree(slug);
    const db = seededDb();
    const source = join(companyBackupsDir(slug), `${backupStamp()}-manual.db`);
    snapshotSync(db, source);
    const policy = setRotationPolicy(
      db,
      { dailyCount: 10, weeklyCount: 6, monthlyCount: 12, yearEndCount: 7 },
      "Owner",
    );
    expect(policy).toMatchObject({ dailyCount: 10, weeklyCount: 6 });
    expect(getRotationPolicy(db).monthlyCount).toBe(12);
    expect(backupSpaceForecast(db, slug)).toMatchObject({
      projectedRetainedFiles: 35,
    });
  });

  it("retains distinct historic tiers and year ends without pruning explicit safety points", () => {
    root = mkdtempSync(join(tmpdir(), "total-tiered-rotation-"));
    process.env.TOTAL_DATA_DIR = root;
    const slug = "tiered-books";
    ensureCompanyTree(slug);
    const db = seededDb();
    const dir = companyBackupsDir(slug);
    setRotationPolicy(
      db,
      { dailyCount: 1, weeklyCount: 1, monthlyCount: 1, yearEndCount: 2 },
      "Owner",
    );

    snapshotAt(db, dir, "2026-08-20T12-00-00", "auto");
    snapshotAt(db, dir, "2026-08-20T11-00-00", "open");
    snapshotAt(db, dir, "2026-08-05T12-00-00", "scheduled");
    snapshotAt(db, dir, "2026-06-01T12-00-00", "auto");
    snapshotAt(db, dir, "2026-05-01T12-00-00", "auto");
    snapshotAt(db, dir, "2026-04-01T12-00-00", "manual");
    snapshotAt(db, dir, "2026-03-01T12-00-00", "pre-tally-import");
    snapshotAt(db, dir, "2026-02-01T12-00-00", "year-end-pre-close-fy2025-1");
    snapshotAt(db, dir, "2025-02-01T12-00-00", "year-end-pre-close-fy2024-1");
    snapshotAt(db, dir, "2024-02-01T12-00-00", "year-end-pre-close-fy2023-1");

    const removed = applyRotationPolicy(db, slug);
    const retained = new Set(listBackupsIn(dir).map((file) => file.file));

    expect(removed).toEqual(
      expect.arrayContaining([
        "2026-08-20T11-00-00-open.db",
        "2026-05-01T12-00-00-auto.db",
        "2024-02-01T12-00-00-year-end-pre-close-fy2023-1.db",
      ]),
    );
    expect(retained).toEqual(
      new Set([
        "2026-08-20T12-00-00-auto.db",
        "2026-08-05T12-00-00-scheduled.db",
        "2026-06-01T12-00-00-auto.db",
        "2026-04-01T12-00-00-manual.db",
        "2026-03-01T12-00-00-pre-tally-import.db",
        "2026-02-01T12-00-00-year-end-pre-close-fy2025-1.db",
        "2025-02-01T12-00-00-year-end-pre-close-fy2024-1.db",
      ]),
    );
  });

  it("creates recognized year-end points and bounds tiered copies at each destination", () => {
    root = mkdtempSync(join(tmpdir(), "total-replicated-rotation-"));
    process.env.TOTAL_DATA_DIR = root;
    const selected = join(root, "external");
    mkdirSync(selected);
    const slug = "replicated-books";
    ensureCompanyTree(slug);
    const db = seededDb();
    setRotationPolicy(
      db,
      { dailyCount: 1, weeklyCount: 0, monthlyCount: 0, yearEndCount: 1 },
      "Owner",
    );
    addBackupDestination(db, "External disk", selected, "Owner");
    const destinationDir = join(selected, "Total Backups", slug);
    mkdirSync(destinationDir, { recursive: true });
    snapshotAt(db, destinationDir, "2026-08-01T12-00-00", "auto");
    snapshotAt(db, destinationDir, "2026-07-01T12-00-00", "manual");

    const source = createYearEndRestorePoint(db, slug, 2025);
    expect(source).toMatch(/year-end-pre-close-fy2025-/);
    expect(replicateBackup(db, slug, source)[0]).toMatchObject({ ok: true });

    const automatic = snapshotAt(
      db,
      companyBackupsDir(slug),
      "2026-08-20T12-00-00",
      "auto",
    );
    expect(replicateBackup(db, slug, automatic)[0]).toMatchObject({ ok: true });
    const destinationFiles = listBackupsIn(destinationDir);
    expect(destinationFiles.filter((file) => file.tag === "auto")).toHaveLength(1);
    expect(destinationFiles.some((file) => file.tag === "manual")).toBe(true);
    expect(
      destinationFiles.filter((file) => file.tag.startsWith("year-end-pre-close-fy2025-")),
    ).toHaveLength(1);
  });
});
