import { basename, join } from "path";
import { createReadStream, mkdirSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import ExcelJS from "exceljs";
import type { DB } from "../db/connection";
import type { CompanyInfo } from "@shared/domain";
import { parseCsv, rowsToCsv } from "@shared/csv";
import type { ImportKind, ImportPreview } from "./importers";
import { previewImport } from "./importers";
import { companyDir, companyExportsDir } from "../paths";
import { writeAudit } from "./audit";
import { signExportIfEnabled } from "./exportSigning";
import { storeManagedAttachment } from "./attachmentVault";

export type MigrationSource = "generic" | "busy" | "zoho_books" | "marg";
export type ProfileTarget =
  "ledgers" | "items" | "openings" | "generic_journal";
export interface MappingProfile {
  id: number;
  name: string;
  sourceKind: MigrationSource;
  targetKind: ProfileTarget;
  fieldMappings: Record<string, string>;
  valueMappings: Record<string, Record<string, string>>;
  dateFormat: string;
  active: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
type Row = Record<string, unknown>;
const jsonObject = (raw: unknown): Record<string, any> => {
  try {
    const value = JSON.parse(String(raw));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
};
function mapProfile(row: Row): MappingProfile {
  return {
    id: Number(row.id),
    name: String(row.name),
    sourceKind: row.source_kind as MigrationSource,
    targetKind: row.target_kind as ProfileTarget,
    fieldMappings: jsonObject(row.field_mappings_json),
    valueMappings: jsonObject(row.value_mappings_json),
    dateFormat: String(row.date_format),
    active: !!row.active,
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
export function listMappingProfiles(db: DB): MappingProfile[] {
  return (
    db
      .prepare(
        "SELECT * FROM import_mapping_profiles ORDER BY source_kind,name",
      )
      .all() as Row[]
  ).map(mapProfile);
}
export function saveMappingProfile(
  db: DB,
  input: {
    name: string;
    sourceKind: MigrationSource;
    targetKind: ProfileTarget;
    fieldMappings: Record<string, string>;
    valueMappings: Record<string, Record<string, string>>;
    dateFormat: string;
    active: boolean;
  },
  actor: string,
  id?: number,
): MappingProfile {
  const before = id
    ? (listMappingProfiles(db).find((row) => row.id === id) ?? null)
    : null;
  const params = [
    input.name.trim(),
    input.sourceKind,
    input.targetKind,
    JSON.stringify(input.fieldMappings),
    JSON.stringify(input.valueMappings),
    input.dateFormat,
    input.active ? 1 : 0,
  ];
  let profileId = id;
  if (id)
    db.prepare(
      `UPDATE import_mapping_profiles SET name=?,source_kind=?,target_kind=?,field_mappings_json=?,value_mappings_json=?,date_format=?,active=?,updated_at=datetime('now') WHERE id=?`,
    ).run(...params, id);
  else
    profileId = Number(
      db
        .prepare(
          `INSERT INTO import_mapping_profiles(name,source_kind,target_kind,field_mappings_json,value_mappings_json,date_format,active,created_by) VALUES(?,?,?,?,?,?,?,?)`,
        )
        .run(...params, actor).lastInsertRowid,
    );
  const after = listMappingProfiles(db).find((row) => row.id === profileId);
  if (!after) throw new Error("Mapping profile not found");
  writeAudit(
    db,
    "import_mapping_profile",
    after.id,
    id ? "update" : "create",
    before,
    after,
  );
  return after;
}

export function applyMappingProfile(
  csvText: string,
  profile: MappingProfile,
): string {
  const records = parseCsv(csvText);
  if (!records.length) throw new Error("Empty file");
  const sourceHeaders = records[0]!.cells;
  const sourceIndex = new Map(
    sourceHeaders.map((header, index) => [header.trim().toLowerCase(), index]),
  );
  const targets = Object.keys(profile.fieldMappings);
  if (!targets.length) throw new Error("Mapping profile has no field mappings");
  const rows = records.slice(1).map((record) =>
    targets.map((target) => {
      const source = profile.fieldMappings[target]!;
      const index = sourceIndex.get(source.trim().toLowerCase());
      const raw = index === undefined ? "" : (record.cells[index] ?? "");
      const values = profile.valueMappings[target];
      const mapped =
        values?.[raw] ??
        Object.entries(values ?? {}).find(
          ([key]) => key.toLowerCase() === raw.toLowerCase(),
        )?.[1];
      return mapped ?? raw;
    }),
  );
  return rowsToCsv(targets, rows);
}
export function previewWithProfile(
  db: DB,
  csvText: string,
  profile: MappingProfile,
): { normalizedCsv: string; preview: ImportPreview; dryRun: MigrationDryRun } {
  const normalizedCsv = applyMappingProfile(csvText, profile);
  const kind = profile.targetKind as ImportKind;
  const preview = previewImport(db, kind, normalizedCsv);
  return {
    normalizedCsv,
    preview,
    dryRun: migrationDryRun(csvText, profile, preview),
  };
}

export interface MigrationDryRun {
  sourceRows: number;
  acceptedRows: number;
  unsupportedColumns: string[];
  duplicateRisk: "none" | "updates" | "already_imported";
  manualCleanup: string[];
  estimatedVouchers: number;
  profileName: string;
}
export function migrationDryRun(
  csvText: string,
  profile: MappingProfile,
  preview: ImportPreview,
): MigrationDryRun {
  const records = parseCsv(csvText);
  const mapped = new Set(
    Object.values(profile.fieldMappings).map((v) => v.toLowerCase()),
  );
  const unsupportedColumns = (records[0]?.cells ?? []).filter(
    (header) => !mapped.has(header.trim().toLowerCase()),
  );
  const manualCleanup = [
    ...new Set(
      preview.errors.map((error) =>
        error.message.replace(/"[^"]+"/g, "the source value"),
      ),
    ),
  ];
  return {
    sourceRows: preview.reconciliation.sourceRows,
    acceptedRows: preview.reconciliation.acceptedRows,
    unsupportedColumns,
    duplicateRisk: preview.alreadyImported
      ? "already_imported"
      : preview.willUpdate
        ? "updates"
        : "none",
    manualCleanup,
    estimatedVouchers:
      profile.targetKind === "generic_journal" ? preview.willCreate : 0,
    profileName: profile.name,
  };
}

export async function writeErrorWorkbook(
  slug: string,
  fileName: string,
  csvText: string,
  preview: ImportPreview,
): Promise<string> {
  const records = parseCsv(csvText);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Total";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet("Rejected rows", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  const headers = records[0]?.cells ?? [];
  sheet.columns = [
    { header: "Stable source row ID", key: "sourceId", width: 28 },
    { header: "Source line", key: "line", width: 12 },
    { header: "Exact reason", key: "reason", width: 52 },
    ...headers.map((header, index) => ({
      header,
      key: `c${index}`,
      width: Math.max(14, Math.min(32, header.length + 5)),
    })),
  ];
  const byLine = new Map(records.map((record) => [record.line, record.cells]));
  for (const error of preview.errors) {
    const raw = byLine.get(error.line) ?? [];
    const stable = createHash("sha256")
      .update(`${preview.sourceHash}:${error.line}`)
      .digest("hex")
      .slice(0, 20);
    const values: Record<string, unknown> = {
      sourceId: stable,
      line: error.line,
      reason: error.message,
    };
    headers.forEach((_, index) => (values[`c${index}`] = raw[index] ?? ""));
    sheet.addRow(values);
  }
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF25313F" },
  };
  sheet.autoFilter = {
    from: "A1",
    to: sheet.getRow(1).getCell(sheet.columnCount).address,
  };
  const safe = basename(fileName)
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-");
  const path = join(companyExportsDir(slug), `${safe}-errors.xlsx`);
  await workbook.xlsx.writeFile(path);
  return path;
}

const PORTABLE_TABLES = [
  "groups",
  "ledgers",
  "voucher_types",
  "vouchers",
  "voucher_lines",
  "stock_groups",
  "units",
  "stock_items",
  "godowns",
  "inventory_lines",
  "currencies",
  "batches",
  "bill_refs",
  "cost_centres",
  "voucher_line_cost_allocations",
  "employees",
  "payroll_runs",
  "payroll_lines",
  "tds_entries",
  "gst_return_periods",
  "sales_documents",
  "sales_document_lines",
  "purchase_orders",
  "purchase_order_lines",
  "goods_receipts",
  "goods_receipt_lines",
  "import_voucher_attachments",
  "audit_log",
] as const;
export interface PortablePackage {
  schema: "total.portable";
  schemaVersion: 1;
  exportedAt: string;
  appDataNotice: string;
  company: CompanyInfo;
  entities: Record<string, unknown[]>;
  manifest: {
    counts: Record<string, number>;
    sha256: string;
    omittedSecrets: string[];
  };
}
export function createPortablePackage(
  db: DB,
  company: CompanyInfo,
): PortablePackage {
  const entities: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  for (const table of PORTABLE_TABLES) {
    const exists = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
      .get(table);
    if (!exists) continue;
    const rows = db
      .prepare(`SELECT * FROM "${table}" ORDER BY id`)
      .all() as unknown[];
    entities[table] = rows;
    counts[table] = rows.length;
  }
  const base = {
    schema: "total.portable" as const,
    schemaVersion: 1 as const,
    exportedAt: new Date().toISOString(),
    appDataNotice:
      "Amounts are integer paise; quantities are integer thousandths. Derived balances are not stored.",
    company,
    entities,
  };
  const sha256 = createHash("sha256")
    .update(JSON.stringify(base))
    .digest("hex");
  return {
    ...base,
    manifest: {
      counts,
      sha256,
      omittedSecrets: [
        "user PIN hashes",
        "encrypted provider credentials",
        "live session tokens",
      ],
    },
  };
}
export function writePortablePackage(
  db: DB,
  company: CompanyInfo,
  slug: string,
  actor: string,
): {
  path: string;
  manifestHash: string;
  counts: Record<string, number>;
  signaturePath?: string;
} {
  const pkg = createPortablePackage(db, company);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(companyExportsDir(slug), `total-portable-v1-${stamp}.json`);
  mkdirSync(companyExportsDir(slug), { recursive: true });
  writeFileSync(path, JSON.stringify(pkg, null, 2), "utf8");
  const signed = signExportIfEnabled(slug, path);
  const id = Number(
    db
      .prepare(
        `INSERT INTO portable_export_receipts(schema_version,path,manifest_hash,counts_json,created_by) VALUES(1,?,?,?,?)`,
      )
      .run(
        path,
        pkg.manifest.sha256,
        JSON.stringify(pkg.manifest.counts),
        actor,
      ).lastInsertRowid,
  );
  writeAudit(db, "portable_export", id, "export", null, {
    path,
    manifestHash: pkg.manifest.sha256,
    counts: pkg.manifest.counts,
  });
  return {
    path,
    manifestHash: pkg.manifest.sha256,
    counts: pkg.manifest.counts,
    ...(signed ? { signaturePath: signed.signaturePath } : {}),
  };
}

export async function fileSha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
export async function linkImportAttachments(
  db: DB,
  slug: string,
  batchId: number,
  folder: string,
  csvText: string,
  actor: string,
): Promise<{ linked: number; missing: string[] }> {
  const records = parseCsv(csvText);
  const headers = (records[0]?.cells ?? []).map((v) => v.trim().toLowerCase());
  const attachmentIndex = headers.findIndex((v) =>
    [
      "attachment",
      "attachment filename",
      "document file",
      "file name",
    ].includes(v),
  );
  const referenceIndex = headers.findIndex((v) =>
    ["reference", "reference number", "ref no", "invoice number"].includes(v),
  );
  const numberIndex = headers.findIndex((v) =>
    [
      "number",
      "document number",
      "voucher number",
      "vch no",
      "bill no",
    ].includes(v),
  );
  if (attachmentIndex < 0)
    throw new Error("No attachment filename column was found");
  const destination = join(
    companyDir(slug),
    "attachments",
    `import-${batchId}`,
  );
  mkdirSync(destination, { recursive: true });
  let linked = 0;
  const missing: string[] = [];
  for (const record of records.slice(1)) {
    const name = basename(record.cells[attachmentIndex] ?? "");
    if (!name) continue;
    const reference =
      referenceIndex >= 0 ? (record.cells[referenceIndex] ?? "").trim() : "";
    const number =
      numberIndex >= 0 ? (record.cells[numberIndex] ?? "").trim() : "";
    const voucher = db
      .prepare(
        `SELECT id FROM vouchers WHERE (?<>'' AND reference=?) OR (?<>'' AND number=?) ORDER BY id DESC LIMIT 1`,
      )
      .get(reference, reference, number, number) as { id: number } | undefined;
    if (!voucher) {
      missing.push(`${name}: voucher not found`);
      continue;
    }
    const source = join(folder, name);
    const stored = join(destination, name);
    let managedPath: string;
    try {
      managedPath = storeManagedAttachment(db, slug, source, stored);
    } catch {
      missing.push(`${name}: file not found`);
      continue;
    }
    const sha256 = await fileSha256(source);
    db.prepare(
      `INSERT OR IGNORE INTO import_voucher_attachments(import_batch_id,voucher_id,source_filename,stored_path,sha256,linked_by) VALUES(?,?,?,?,?,?)`,
    ).run(batchId, voucher.id, name, managedPath, sha256, actor);
    linked++;
  }
  writeAudit(db, "import_attachment", batchId, "import", null, {
    linked,
    missing,
  });
  return { linked, missing };
}
