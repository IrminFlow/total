import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { seededDb } from "../db/testdb";
import { ensureCompanyTree } from "../paths";
import { applyImport, previewImport } from "./importers";
import {
  applyMappingProfile,
  createPortablePackage,
  listMappingProfiles,
  migrationDryRun,
  previewWithProfile,
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
      "Vch No,Date,Vch Type,Account,Dr,Cr,Narration,Legacy Code",
      "B-1,24/08/2026,Journal,Cash,1000,,Test,X1",
      "B-1,24/08/2026,Journal,Sales Account,,1000,Test,X2",
    ].join("\n");
    const result = previewWithProfile(db, csv, busy);
    expect(result.preview).toMatchObject({ willCreate: 1, errors: [] });
    expect(result.dryRun.unsupportedColumns).toEqual(["Legacy Code"]);
    expect(applyMappingProfile(csv, busy)).toContain("Voucher Group");
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
  it("upgrades legacy portable JSON through the standalone CLI with a transformation report", () => {
    tree();
    const input = join(root!, "legacy.json");
    const output = join(root!, "upgraded.json");
    writeFileSync(input, JSON.stringify({ exported_on: "2025-01-01T00:00:00.000Z", tables: { vouchers: [{ id: 1 }] } }));
    const report = JSON.parse(execFileSync(process.execPath, [join(process.cwd(), "scripts/migrate-portable.mjs"), input, output], { encoding: "utf8" }));
    const upgraded = JSON.parse(readFileSync(output, "utf8"));
    expect(report.transformations).toContain("Renamed tables collection to entities");
    expect(upgraded).toMatchObject({ schema: "total.portable", schemaVersion: 1, entities: { vouchers: [{ id: 1 }] }, manifest: { counts: { vouchers: 1 } } });
  });
});
