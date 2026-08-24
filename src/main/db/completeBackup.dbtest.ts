import { afterEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ id: "device-a" }));

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) =>
      Buffer.from(`${platform.id}:${value}`, "utf8"),
    decryptString: (value: Buffer) => {
      const prefix = `${platform.id}:`;
      const encoded = value.toString("utf8");
      if (!encoded.startsWith(prefix))
        throw new Error("Key belongs to a different operating-system profile");
      return encoded.slice(prefix.length);
    },
  },
}));

import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { migrate } from "./migrate";
import { seedCompany } from "./seed";
import { postSimpleVoucher, TEST_INFO } from "./testdb";
import {
  createCompleteBackup,
  inspectCompleteBackup,
  restoreCompleteBackup,
} from "./completeBackup";
import {
  readManagedAttachment,
  removeManagedAttachment,
  setAttachmentEncryption,
  storeManagedAttachment,
} from "../services/attachmentVault";
import { companyDir, ensureCompanyTree } from "../paths";
import { submitReimbursement } from "../services/workforce";

const PASSPHRASE = "a correct horse battery staple";
let roots: string[] = [];

function temporaryRoot(name: string): string {
  const root = mkdtempSync(join(tmpdir(), name));
  roots.push(root);
  return root;
}

function createCompany(root: string, slug: string): Database.Database {
  process.env.TOTAL_DATA_DIR = root;
  ensureCompanyTree(slug);
  const db = new Database(join(companyDir(slug), "company.db"));
  db.pragma("journal_mode = WAL");
  migrate(db);
  seedCompany(db, TEST_INFO);
  return db;
}

afterEach(() => {
  delete process.env.TOTAL_DATA_DIR;
  platform.id = "device-a";
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe("complete company backup", () => {
  it("round-trips SQLite, encrypted attachments and durable sidecars on a clean machine", async () => {
    const sourceRoot = temporaryRoot("total-complete-source-");
    const slug = "portable-books";
    const db = createCompany(sourceRoot, slug);
    const voucher = postSimpleVoucher(db, {
      date: "2025-04-10",
      amount: 12_345,
      kind: "receipt",
    });

    setAttachmentEncryption(db, slug, true, "Owner");
    const attachmentDirectory = join(companyDir(slug), "attachments", "vouchers", "1");
    mkdirSync(attachmentDirectory, { recursive: true });
    const sourceDocument = join(sourceRoot, "invoice.txt");
    writeFileSync(sourceDocument, "invoice evidence from device A");
    const storedPath = storeManagedAttachment(
      db,
      slug,
      sourceDocument,
      join(attachmentDirectory, "invoice.txt"),
    );
    expect(storedPath).toMatch(/\.totalatt$/);
    db.prepare(
      `INSERT INTO voucher_attachments(voucher_id,original_name,stored_path,kind,size_bytes,added_by)
       VALUES(?,?,?,?,?,?)`,
    ).run(voucher.id, "invoice.txt", storedPath, "invoice", 30, "Owner");
    const employeeId = Number(
      db.prepare("INSERT INTO employees(name,basic,hra,special) VALUES('Asha',0,0,0)").run()
        .lastInsertRowid,
    );
    const reimbursementSource = join(sourceRoot, "taxi-receipt.pdf");
    writeFileSync(reimbursementSource, "payroll evidence from device A");
    const reimbursement = submitReimbursement(
      db,
      {
        employeeId,
        claimDate: "2025-04-09",
        category: "Travel",
        amount: 1_250_00,
        taxable: false,
        description: "Customer visit",
        attachmentPath: reimbursementSource,
      },
      slug,
    );
    expect(reimbursement.attachmentPath).toMatch(
      /attachments[/\\]payroll[/\\]reimbursements[/\\].+\.pdf\.totalatt$/,
    );
    // Simulate a claim created by an older build, which retained only the external absolute path.
    // Backup must adopt it into the managed vault before taking the SQLite snapshot.
    removeManagedAttachment(slug, reimbursement.attachmentPath!);
    db.prepare("UPDATE employee_reimbursements SET attachment_path=? WHERE id=?").run(
      reimbursementSource,
      reimbursement.id,
    );
    writeFileSync(join(companyDir(slug), "setup.json"), '{"workflow":"retail"}\n');
    mkdirSync(join(companyDir(slug), "proposals"), { recursive: true });
    writeFileSync(
      join(companyDir(slug), "proposals", "pending.json"),
      '{"status":"pending"}\n',
    );

    const packagePath = join(sourceRoot, "portable.totalcomplete");
    const created = await createCompleteBackup({
      db,
      companySlug: slug,
      companyDirectory: companyDir(slug),
      destinationPath: packagePath,
      passphrase: PASSPHRASE,
      now: new Date("2026-08-24T10:00:00.000Z"),
    });
    expect(created.manifest.entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([
        "database/company.db",
        "company/attachments/vouchers/1/invoice.txt.totalatt",
        expect.stringMatching(
          /^company\/attachments\/payroll\/reimbursements\/.+\.pdf\.totalatt$/,
        ),
        "company/setup.json",
        "company/proposals/pending.json",
      ]),
    );
    expect(created.manifest.vaultKey).not.toBeNull();
    expect(
      (
        db.prepare("SELECT attachment_path AS path FROM employee_reimbursements WHERE id=?").get(
          reimbursement.id,
        ) as { path: string }
      ).path,
    ).toMatch(/attachments[/\\]payroll[/\\]reimbursements[/\\].+\.pdf\.totalatt$/);
    expect(readFileSync(packagePath).subarray(0, 8).toString("ascii")).toBe(
      "TOTALBK1",
    );
    db.close();

    const inspected = await inspectCompleteBackup(packagePath, PASSPHRASE);
    expect(inspected).toMatchObject({
      format: "complete",
      encrypted: true,
      database: { valid: true, integrity: "ok", voucherCount: 1 },
    });

    // Simulate a genuinely clean profile: safeStorage from device B cannot open device A's DB
    // envelope. Restore must use the portable key and then bind it to device B.
    const targetRoot = temporaryRoot("total-complete-target-");
    platform.id = "device-b";
    process.env.TOTAL_DATA_DIR = targetRoot;
    const targetDirectory = companyDir(slug);
    const restored = await restoreCompleteBackup({
      sourcePath: packagePath,
      passphrase: PASSPHRASE,
      targetCompanyDirectory: targetDirectory,
      targetCompanySlug: slug,
    });
    expect(restored).toMatchObject({
      format: "complete",
      attachmentsRestored: 2,
      preRestoreBackupPath: null,
    });

    const restoredDb = new Database(join(targetDirectory, "company.db"));
    expect(
      (
        restoredDb.prepare("SELECT COUNT(*) AS count FROM vouchers").get() as {
          count: number;
        }
      ).count,
    ).toBe(1);
    const keyMeta = (
      restoredDb
        .prepare("SELECT value FROM meta WHERE key='attachments.encryption.key'")
        .get() as { value: string }
    ).value;
    const protectedKey = JSON.parse(keyMeta) as { encrypted: string };
    expect(Buffer.from(protectedKey.encrypted, "base64").toString()).toMatch(
      /^device-b:/,
    );
    const restoredAttachment = join(
      targetDirectory,
      "attachments",
      "vouchers",
      "1",
      "invoice.txt.totalatt",
    );
    expect(
      readManagedAttachment(restoredDb, slug, restoredAttachment).toString(),
    ).toBe("invoice evidence from device A");
    const restoredReimbursementPath = (
      restoredDb
        .prepare("SELECT attachment_path AS path FROM employee_reimbursements WHERE id=?")
        .get(reimbursement.id) as { path: string }
    ).path;
    expect(restoredReimbursementPath).toContain(
      join(targetDirectory, "attachments", "payroll", "reimbursements"),
    );
    expect(
      readManagedAttachment(restoredDb, slug, restoredReimbursementPath).toString(),
    ).toBe("payroll evidence from device A");
    expect(
      (
        restoredDb
          .prepare("SELECT stored_path AS path FROM voucher_attachments")
          .get() as { path: string }
      ).path,
    ).toBe(restoredAttachment);
    restoredDb.close();
    expect(readFileSync(join(targetDirectory, "setup.json"), "utf8")).toContain(
      "retail",
    );
    expect(
      existsSync(join(targetDirectory, "proposals", "pending.json")),
    ).toBe(true);
  });

  it("rejects a corrupted encrypted package before touching an existing company", async () => {
    const sourceRoot = temporaryRoot("total-complete-corrupt-source-");
    const sourceDb = createCompany(sourceRoot, "source");
    const packagePath = join(sourceRoot, "source.totalcomplete");
    await createCompleteBackup({
      db: sourceDb,
      companySlug: "source",
      companyDirectory: companyDir("source"),
      destinationPath: packagePath,
      passphrase: PASSPHRASE,
    });
    sourceDb.close();
    const corrupted = readFileSync(packagePath);
    corrupted[Math.floor(corrupted.length / 2)]! ^= 0xff;
    writeFileSync(packagePath, corrupted);

    const targetRoot = temporaryRoot("total-complete-corrupt-target-");
    const targetDb = createCompany(targetRoot, "target");
    postSimpleVoucher(targetDb, {
      date: "2025-04-11",
      amount: 99_999,
      kind: "receipt",
    });
    const targetPath = join(companyDir("target"), "company.db");
    const beforeCount = (
      targetDb.prepare("SELECT COUNT(*) AS count FROM vouchers").get() as {
        count: number;
      }
    ).count;
    const tempBefore = new Set(
      readdirSync(tmpdir()).filter((name) => name.startsWith("total-complete-backup-read-")),
    );

    await expect(
      restoreCompleteBackup({
        sourcePath: packagePath,
        passphrase: PASSPHRASE,
        targetCompanyDirectory: companyDir("target"),
        targetCompanySlug: "target",
        liveDb: targetDb,
      }),
    ).rejects.toThrow("Wrong passphrase or corrupted file");
    const leaked = readdirSync(tmpdir()).filter(
      (name) => name.startsWith("total-complete-backup-read-") && !tempBefore.has(name),
    );
    expect(leaked).toEqual([]);
    expect(targetDb.open).toBe(true);
    expect(
      (
        targetDb.prepare("SELECT COUNT(*) AS count FROM vouchers").get() as {
          count: number;
        }
      ).count,
    ).toBe(beforeCount);
    expect(existsSync(targetPath)).toBe(true);
    targetDb.close();
  });

  it("replaces complete sidecar generations and keeps a restorable pre-restore package", async () => {
    const sourceRoot = temporaryRoot("total-complete-replace-source-");
    const slug = "replace-books";
    const sourceDb = createCompany(sourceRoot, slug);
    postSimpleVoucher(sourceDb, {
      date: "2025-05-01",
      amount: 50_000,
      kind: "receipt",
    });
    mkdirSync(join(companyDir(slug), "attachments"), { recursive: true });
    writeFileSync(join(companyDir(slug), "attachments", "new.txt"), "new generation");
    const packagePath = join(sourceRoot, "source.totalcomplete");
    await createCompleteBackup({
      db: sourceDb,
      companySlug: slug,
      companyDirectory: companyDir(slug),
      destinationPath: packagePath,
      passphrase: PASSPHRASE,
    });
    sourceDb.close();

    const targetRoot = temporaryRoot("total-complete-replace-target-");
    const liveDb = createCompany(targetRoot, slug);
    postSimpleVoucher(liveDb, {
      date: "2025-05-02",
      amount: 60_000,
      kind: "receipt",
    });
    postSimpleVoucher(liveDb, {
      date: "2025-05-03",
      amount: 70_000,
      kind: "receipt",
    });
    mkdirSync(join(companyDir(slug), "attachments"), { recursive: true });
    writeFileSync(join(companyDir(slug), "attachments", "old.txt"), "old generation");

    const result = await restoreCompleteBackup({
      sourcePath: packagePath,
      passphrase: PASSPHRASE,
      targetCompanyDirectory: companyDir(slug),
      targetCompanySlug: slug,
      liveDb,
      now: new Date("2026-08-24T12:00:00.000Z"),
    });
    expect(result.preRestoreBackupPath).toMatch(/pre-restore\.totalcomplete$/);
    expect(existsSync(result.preRestoreBackupPath!)).toBe(true);
    expect(existsSync(join(companyDir(slug), "attachments", "old.txt"))).toBe(false);
    expect(readFileSync(join(companyDir(slug), "attachments", "new.txt"), "utf8")).toBe(
      "new generation",
    );
    const installed = new Database(join(companyDir(slug), "company.db"));
    expect(
      (installed.prepare("SELECT COUNT(*) AS count FROM vouchers").get() as { count: number })
        .count,
    ).toBe(1);
    installed.close();

    const safety = await inspectCompleteBackup(result.preRestoreBackupPath!, PASSPHRASE);
    expect(safety).toMatchObject({
      format: "complete",
      database: { valid: true, voucherCount: 2 },
    });
    expect(
      safety.manifest?.entries.some(
        (entry) => entry.path === "company/attachments/old.txt",
      ),
    ).toBe(true);
  });

  it("accepts a legacy DB-only backup without deleting existing sidecars", async () => {
    const backupRoot = temporaryRoot("total-legacy-source-");
    const legacyDb = createCompany(backupRoot, "legacy");
    postSimpleVoucher(legacyDb, {
      date: "2025-04-12",
      amount: 42_000,
      kind: "receipt",
    });
    legacyDb.pragma("wal_checkpoint(TRUNCATE)");
    legacyDb.close();
    const legacyPath = join(companyDir("legacy"), "company.db");

    const targetRoot = temporaryRoot("total-legacy-target-");
    const liveDb = createCompany(targetRoot, "target");
    const retainedAttachment = join(
      companyDir("target"),
      "attachments",
      "retained.txt",
    );
    mkdirSync(join(companyDir("target"), "attachments"), { recursive: true });
    writeFileSync(retainedAttachment, "existing sidecar");

    const result = await restoreCompleteBackup({
      sourcePath: legacyPath,
      targetCompanyDirectory: companyDir("target"),
      targetCompanySlug: "target",
      liveDb,
      now: new Date("2026-08-24T10:00:00.000Z"),
    });
    expect(result.format).toBe("legacy-db");
    expect(result.preRestoreBackupPath).toMatch(/pre-restore-legacy\.db$/);
    expect(existsSync(result.preRestoreBackupPath!)).toBe(true);
    expect(readFileSync(retainedAttachment, "utf8")).toBe("existing sidecar");
    const restoredDb = new Database(join(companyDir("target"), "company.db"));
    expect(
      (
        restoredDb.prepare("SELECT COUNT(*) AS count FROM vouchers").get() as {
          count: number;
        }
      ).count,
    ).toBe(1);
    restoredDb.close();
  });
});
