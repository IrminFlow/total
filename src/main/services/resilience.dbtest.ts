import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { seededDb } from "../db/testdb";
import { backupStamp, snapshotSync } from "../db/backup";
import { companyBackupsDir, ensureCompanyTree } from "../paths";
import {
  addBackupDestination,
  backupSpaceForecast,
  getRotationPolicy,
  listBackupDestinations,
  recoveryDrillDue,
  replicateBackup,
  runRecoveryDrill,
  setRotationPolicy,
} from "./resilience";

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
});
