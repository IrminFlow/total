import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import ExcelJS from "exceljs";
import { freshDb, seededDb } from "../db/testdb";
import { ensureCompanyTree } from "../paths";
import { applyImport, previewImport } from "./importers";
import { importSourceHash } from "./importBatches";
import {
  applyMappingProfile,
  applyImportWithProfile,
  createPortablePackage,
  listMappingProfiles,
  linkImportAttachments,
  migrationDryRun,
  previewWithProfile,
  restorePortablePackage,
  spreadsheetFileToCsv,
  validatePortablePackage,
  writeErrorWorkbook,
  writePortablePackage,
} from "./migrationTools";

let root: string | null = null;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
  delete process.env.TOTAL_DATA_DIR;
});
function tree() {
  root = mkdtempSync(join(tmpdir(), "total-migration-"));
  process.env.TOTAL_DATA_DIR = root;
  ensureCompanyTree("migration-books");
}
function booksDb() {
  const db = seededDb();
  const group = db
    .prepare("SELECT id FROM groups WHERE name='Sales Accounts'")
    .get() as { id: number };
  db.prepare(
    "INSERT INTO ledgers(name,group_id) VALUES('Sales Account',?)",
  ).run(group.id);
  return db;
}
function journalCsv() {
  return [
    "Source ID,Voucher Group,Date,Voucher Type,Ledger,Debit,Credit,Narration,Reference",
    "a,JV-1,24/08/2026,Journal,Cash,1000,,Migration test,MIG-1",
    "b,JV-1,24/08/2026,Journal,Sales Account,,1000,Migration test,MIG-1",
  ].join("\n");
}

function refreshPortableHash(pkg: ReturnType<typeof createPortablePackage>) {
  const content = JSON.stringify({
    schema: pkg.schema,
    schemaVersion: pkg.schemaVersion,
    exportedAt: pkg.exportedAt,
    appDataNotice: pkg.appDataNotice,
    company: pkg.company,
    entities: pkg.entities,
  });
  pkg.manifest.sha256 = createHash("sha256").update(content).digest("hex");
  return pkg;
}

describe("migration workbench", () => {
  it("previews and atomically posts balanced generic journal groups", () => {
    const db = booksDb();
    const preview = previewImport(db, "generic_journal", journalCsv());
    expect(preview).toMatchObject({
      willCreate: 1,
      errors: [],
      reconciliation: { acceptedRows: 2, acceptedAmount: 100000 },
    });
    const result = applyImport(db, "generic_journal", journalCsv());
    expect(result.created).toBe(1);
    expect(
      db
        .prepare("SELECT COUNT(*) n FROM vouchers WHERE reference='MIG-1'")
        .get(),
    ).toEqual({ n: 1 });
    expect(
      db
        .prepare(
          "SELECT SUM(CASE WHEN dr_cr='dr' THEN amount ELSE -amount END) n FROM voucher_lines",
        )
        .get(),
    ).toEqual({ n: 0 });
  });
  it("rejects an entire unbalanced voucher group before writing", () => {
    const db = booksDb();
    const csv = journalCsv().replace(
      ",1000,Migration test,MIG-1",
      ",900,Migration test,MIG-1",
    );
    const preview = previewImport(db, "busy", csv);
    expect(preview.errors[0]?.message).toContain("unbalanced");
    expect(preview.willCreate).toBe(0);
    const result = applyImport(db, "busy", csv);
    expect(result.created).toBe(0);
  });
  it("ships reusable Busy, Zoho and Marg profiles and reports unsupported source fields", () => {
    const db = booksDb();
    const profiles = listMappingProfiles(db);
    expect(new Set(profiles.map((row) => row.sourceKind))).toEqual(
      new Set(["busy", "marg", "zoho_books"]),
    );
    expect(profiles).toHaveLength(10);
    const busy = profiles.find((row) => row.name === "Busy voucher export")!;
    const csv = [
      "Vch No,Date,Vch Type,Account,Dr,Cr,Narration,Ref No,Legacy Code",
      "B-1,24/08/2026,Journal,Cash,1000,,Test,EXT-44,X1",
      "B-1,24/08/2026,Journal,Sales Account,,1000,Test,EXT-44,X2",
    ].join("\n");
    const result = previewWithProfile(db, csv, busy);
    expect(result.preview).toMatchObject({ willCreate: 1, errors: [] });
    expect(result.dryRun.unsupportedColumns).toEqual(["Legacy Code"]);
    const normalized = applyMappingProfile(csv, busy);
    expect(normalized).toContain("Voucher Group");
    expect(normalized).toContain("Number");
    expect(normalized).toContain("Reference");
    const imported = applyImportWithProfile(db, csv, busy);
    expect(imported.sourceHash).toBe(importSourceHash(csv));
    expect(imported.normalizedSourceHash).toBe(importSourceHash(normalized));
    expect(db.prepare("SELECT kind,source_hash AS sourceHash FROM import_batches WHERE id=?").get(imported.batchId)).toEqual({
      kind: "busy",
      sourceHash: importSourceHash(csv),
    });
    expect(db.prepare("SELECT number,reference FROM vouchers WHERE number='B-1'").get()).toEqual({ number: "B-1", reference: "EXT-44" });
  });
  it("keeps repeated source numbers on different dates as separate balanced vouchers", () => {
    const db = booksDb();
    const csv = [
      "Voucher Group,Date,Voucher Type,Number,Ledger,Debit,Credit,Reference",
      "DAY-1,2026-08-01,Journal,1,Cash,1000,,AUG-1",
      "DAY-1,2026-08-01,Journal,1,Sales Account,,1000,AUG-1",
      "DAY-1,2026-08-02,Journal,1,Cash,2500,,AUG-2",
      "DAY-1,2026-08-02,Journal,1,Sales Account,,2500,AUG-2",
    ].join("\n");
    const preview = previewImport(db, "generic_journal", csv);
    expect(preview).toMatchObject({ willCreate: 2, errors: [], reconciliation: { sourceRows: 4, acceptedRows: 4, rejectedRows: 0 } });
    const result = applyImport(db, "generic_journal", csv);
    expect(result.created).toBe(2);
    expect(db.prepare("SELECT date,number,reference FROM vouchers WHERE number='1' ORDER BY date").all()).toEqual([
      { date: "2026-08-01", number: "1", reference: "AUG-1" },
      { date: "2026-08-02", number: "1", reference: "AUG-2" },
    ]);
  });
  it("writes an actionable XLSX error workbook with stable row identity", async () => {
    tree();
    const db = booksDb();
    const csv = "Name,Group,Opening\nGhost,Unknown Group,100";
    const preview = previewImport(db, "ledgers", csv);
    const path = await writeErrorWorkbook(
      "migration-books",
      "busy-ledgers.csv",
      csv,
      preview,
    );
    expect(path).toMatch(/busy-ledgers-errors\.xlsx$/);
    expect(readFileSync(path).subarray(0, 2).toString()).toBe("PK");
  });
  it("links attachments only after one unique active voucher match and counts durable links", async () => {
    tree();
    const db = booksDb();
    const imported = applyImport(db, "generic_journal", journalCsv());
    const original = db.prepare("SELECT * FROM vouchers WHERE reference='MIG-1'").get() as Record<string, unknown>;
    db.prepare(
      `INSERT INTO vouchers(voucher_type_id,date,number,party_ledger_id,narration,reference,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?)`,
    ).run(original.voucher_type_id, original.date, "DUPLICATE", original.party_ledger_id, original.narration, original.reference, original.created_at, original.updated_at);
    const folder = join(root!, "source-documents");
    mkdirSync(folder);
    writeFileSync(join(folder, "invoice.pdf"), "review evidence");
    const attachmentCsv = "Attachment Filename,Reference\ninvoice.pdf,MIG-1";

    const ambiguous = await linkImportAttachments(db, "migration-books", imported.batchId, folder, attachmentCsv, "Owner");
    expect(ambiguous).toMatchObject({ linked: 0, missing: [], warnings: [expect.stringMatching(/multiple active vouchers/i)] });
    expect(db.prepare("SELECT COUNT(*) AS n FROM import_voucher_attachments").get()).toEqual({ n: 0 });

    db.prepare("UPDATE vouchers SET deleted_at=datetime('now') WHERE number='DUPLICATE'").run();
    const linked = await linkImportAttachments(db, "migration-books", imported.batchId, folder, attachmentCsv, "Owner");
    expect(linked).toEqual({ linked: 1, missing: [], warnings: [] });
    const repeated = await linkImportAttachments(db, "migration-books", imported.batchId, folder, attachmentCsv, "Owner");
    expect(repeated).toMatchObject({ linked: 0, missing: [], warnings: [expect.stringMatching(/already linked/i)] });
    expect(db.prepare("SELECT COUNT(*) AS n FROM import_voucher_attachments").get()).toEqual({ n: 1 });
    expect(readdirSync(join(root!, "companies", "migration-books", "attachments", `import-${imported.batchId}`))).toHaveLength(1);
    db.close();
  });
  it("normalizes XLSX and tab-separated workbooks at the reviewed CSV boundary", async () => {
    tree();
    const xlsxPath = join(root!, "busy-vouchers.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Vouchers");
    sheet.addRow(["Vch No", "Date", "Vch Type", "Account", "Dr", "Cr", "Narration"]);
    sheet.addRow(["B-9", new Date(2026, 7, 24), "Journal", "Cash", 1000, "", "Workbook migration"]);
    sheet.addRow(["B-9", new Date(2026, 7, 24), "Journal", "Sales Account", "", 1000, "Workbook migration"]);
    await workbook.xlsx.writeFile(xlsxPath);
    const xlsx = await spreadsheetFileToCsv(xlsxPath);
    expect(xlsx).toMatchObject({ sourceFormat: "xlsx", sheetName: "Vouchers", fileName: "busy-vouchers.xlsx" });
    expect(xlsx.csvText).toContain("2026-08-24");
    const db = booksDb();
    const busy = listMappingProfiles(db).find((row) => row.name === "Busy voucher export")!;
    expect(previewWithProfile(db, xlsx.csvText, busy).preview).toMatchObject({ willCreate: 1, errors: [] });

    const tsvPath = join(root!, "openings.tsv");
    writeFileSync(tsvPath, "Name\tOpening\nCash\t\"1,250.50\"\n");
    const tsv = await spreadsheetFileToCsv(tsvPath);
    expect(tsv).toMatchObject({ sourceFormat: "tsv", sheetName: null });
    expect(tsv.csvText).toContain('"1,250.50"');
  });
  it("rejects oversized and corrupted spreadsheet containers within bounded work", async () => {
    tree();
    const oversized = join(root!, "oversized.xlsx");
    writeFileSync(oversized, "PK");
    truncateSync(oversized, 64 * 1024 * 1024 + 1);
    await expect(spreadsheetFileToCsv(oversized)).rejects.toThrow(/64 MB/);

    const corrupt = join(root!, "corrupt.xlsx");
    let state = 0x51ee;
    for (let sample = 0; sample < 50; sample++) {
      const length = 16 + (sample * 37) % 4096;
      const bytes = Buffer.alloc(length);
      for (let index = 0; index < bytes.length; index++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        bytes[index] = state & 0xff;
      }
      writeFileSync(corrupt, bytes);
      await expect(spreadsheetFileToCsv(corrupt)).rejects.toThrow();
    }
  });
  it("exports a versioned exit package with accounting data and no authentication secrets", () => {
    tree();
    const db = booksDb();
    applyImport(db, "generic_journal", journalCsv());
    const company = {
      name: "Migration Books",
      gstin: null,
      stateCode: "27",
      address: "",
      email: null,
      phone: null,
      pan: null,
      tan: null,
      booksFrom: 2026,
      gstRegistrationType: "unregistered" as const,
    };
    const pkg = createPortablePackage(db, company);
    expect(pkg).toMatchObject({
      schema: "total.portable",
      schemaVersion: 1,
      manifest: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(pkg.entities.voucher_lines).toHaveLength(2);
    expect(pkg.entities.users).toBeUndefined();
    const receipt = writePortablePackage(
      db,
      company,
      "migration-books",
      "Owner",
    );
    expect(
      JSON.parse(readFileSync(receipt.path, "utf8")).manifest.counts.vouchers,
    ).toBe(1);
    expect(
      db.prepare("SELECT COUNT(*) n FROM portable_export_receipts").get(),
    ).toEqual({ n: 1 });
  });
  it("reconstructs a portable package transactionally with exact counts and balanced books", () => {
    const source = booksDb();
    applyImport(source, "generic_journal", journalCsv());
    const company = {
      name: "Round-trip Books",
      gstin: null,
      stateCode: "27",
      address: "",
      email: null,
      phone: null,
      pan: null,
      tan: null,
      booksFrom: 2026,
      gstRegistrationType: "unregistered" as const,
    };
    const pkg = createPortablePackage(source, company);
    const destination = freshDb();
    const result = restorePortablePackage(destination, pkg, "Migration operator");

    expect(result.company).toEqual(company);
    expect(result.manifestHash).toBe(pkg.manifest.sha256);
    expect(result.counts.vouchers).toBe(1);
    expect(result.counts.voucher_lines).toBe(2);
    expect(destination.prepare("SELECT COUNT(*) AS n FROM vouchers").get()).toEqual({ n: 1 });
    expect(destination.prepare("SELECT SUM(CASE WHEN dr_cr='dr' THEN amount ELSE -amount END) AS n FROM voucher_lines").get()).toEqual({ n: 0 });
    expect(destination.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity='portable_restore'").get()).toEqual({ n: 1 });

    const tampered = structuredClone(pkg);
    (tampered.entities.voucher_lines![0] as { amount: number }).amount += 1;
    expect(() => validatePortablePackage(tampered)).toThrow(/content hash/i);
    source.close();
    destination.close();
  });
  it("rejects hostile portable-package mutations before reconstruction", () => {
    const source = booksDb();
    applyImport(source, "generic_journal", journalCsv());
    const pkg = createPortablePackage(source, {
      name: "Fuzz Books", gstin: null, stateCode: "27", address: "", email: null, phone: null,
      pan: null, tan: null, booksFrom: 2026, gstRegistrationType: "unregistered",
    });
    const mutations: unknown[] = [
      null,
      [],
      { ...pkg, schema: "other" },
      { ...pkg, schemaVersion: Number.MAX_SAFE_INTEGER },
      { ...pkg, entities: [] },
      { ...pkg, entities: { ...pkg.entities, "../../books": [] } },
      { ...pkg, entities: { ...pkg.entities, vouchers: "not-an-array" } },
      { ...pkg, manifest: null },
      { ...pkg, manifest: { ...pkg.manifest, counts: { ...pkg.manifest.counts, vouchers: -1 } } },
      { ...pkg, manifest: { ...pkg.manifest, sha256: "0".repeat(64) } },
    ];
    for (const mutation of mutations) expect(() => validatePortablePackage(mutation)).toThrow();
    const destination = freshDb();
    for (const mutation of mutations) expect(() => restorePortablePackage(destination, mutation, "Fuzzer")).toThrow();
    expect(destination.prepare("SELECT COUNT(*) AS n FROM vouchers").get()).toEqual({ n: 0 });
    source.close();
    destination.close();
  });
  it("rejects fractional money and quantity units even with a valid content hash", () => {
    const source = booksDb();
    applyImport(source, "generic_journal", journalCsv());
    const base = createPortablePackage(source, {
      name: "Integer Books", gstin: null, stateCode: "27", address: "", email: null, phone: null,
      pan: null, tan: null, booksFrom: 2026, gstRegistrationType: "unregistered",
    });
    const fractionalMoney = structuredClone(base);
    (fractionalMoney.entities.voucher_lines![0] as { amount: number }).amount += 0.5;
    refreshPortableHash(fractionalMoney);
    expect(() => validatePortablePackage(fractionalMoney)).toThrow(/integer accounting units/i);

    const fractionalQuantity = structuredClone(base);
    fractionalQuantity.entities.inventory_lines = [{ qty_milli: 1.5 }];
    fractionalQuantity.manifest.counts.inventory_lines = 1;
    refreshPortableHash(fractionalQuantity);
    expect(() => validatePortablePackage(fractionalQuantity)).toThrow(/integer accounting units/i);
    source.close();
  });
  it("upgrades legacy portable JSON through the standalone CLI with a transformation report", () => {
    tree();
    const source = booksDb();
    applyImport(source, "generic_journal", journalCsv());
    const current = createPortablePackage(source, {
      name: "Legacy Books", gstin: null, stateCode: "27", address: "", email: null, phone: null,
      pan: null, tan: null, booksFrom: 2026, gstRegistrationType: "unregistered",
    });
    const input = join(root!, "legacy.json");
    const output = join(root!, "upgraded.json");
    writeFileSync(input, JSON.stringify({
      exported_on: current.exportedAt,
      appDataNotice: current.appDataNotice,
      company: current.company,
      tables: current.entities,
    }));
    const report = JSON.parse(execFileSync(process.execPath, [join(process.cwd(), "scripts/migrate-portable.mjs"), input, output], { encoding: "utf8" }));
    const upgraded = JSON.parse(readFileSync(output, "utf8"));
    expect(report.transformations).toContain("Renamed tables collection to entities");
    expect(validatePortablePackage(upgraded)).toMatchObject({ schema: "total.portable", schemaVersion: 1 });
    const destination = freshDb();
    const restored = restorePortablePackage(destination, upgraded, "Migration operator");
    expect(restored.counts).toEqual(current.manifest.counts);
    expect(destination.prepare("SELECT COUNT(*) AS n FROM vouchers").get()).toEqual({ n: 1 });
    expect(destination.prepare("SELECT SUM(CASE WHEN dr_cr='dr' THEN amount ELSE -amount END) AS n FROM voucher_lines").get()).toEqual({ n: 0 });
    source.close();
    destination.close();
  });
});
