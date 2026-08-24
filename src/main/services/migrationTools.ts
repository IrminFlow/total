import { basename, extname, join } from "path";
import { closeSync, createReadStream, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "fs";
import { createHash, randomUUID } from "crypto";
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
import { assertSafeXlsxContainer } from "./xlsxSafety";

export type MigrationSource = "generic" | "busy" | "zoho_books" | "marg";
const MAX_SPREADSHEET_BYTES = 64 * 1024 * 1024;
const MAX_SPREADSHEET_ROWS = 100_000;
const MAX_SPREADSHEET_COLUMNS = 256;
const MAX_WORKSHEETS = 50;
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

function spreadsheetCellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  if (typeof value !== "object") return String(value);
  if ("result" in value && value.result !== undefined)
    return spreadsheetCellText(value.result as ExcelJS.CellValue);
  if ("richText" in value)
    return value.richText.map((part) => part.text).join("");
  if ("text" in value) return String(value.text);
  if ("error" in value) return String(value.error);
  return String(value);
}

function parseTabSeparated(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const pushCell = (): void => { row.push(cell); cell = ""; };
  const pushRow = (): void => {
    pushCell();
    if (row.some((value) => value.trim() !== "")) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === "\t") pushCell();
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      pushRow();
    } else cell += ch;
  }
  if (cell !== "" || row.length) pushRow();
  return rows;
}

/** Normalize a user-selected CSV, TSV or XLSX worksheet to the importer's reviewed CSV boundary. */
export async function spreadsheetFileToCsv(filePath: string): Promise<{ csvText: string; fileName: string; sheetName: string | null; sourceFormat: "csv" | "tsv" | "xlsx" }> {
  const extension = extname(filePath).toLowerCase();
  const fileName = basename(filePath);
  if (statSync(filePath).size > MAX_SPREADSHEET_BYTES)
    throw new Error("The spreadsheet exceeds the 64 MB import limit");
  if (extension === ".csv")
    return { csvText: readFileSync(filePath, "utf8"), fileName, sheetName: null, sourceFormat: "csv" };
  if (extension === ".tsv" || extension === ".txt") {
    const raw = readFileSync(filePath, "utf8");
    if (extension === ".txt" && !raw.split(/\r?\n/, 1)[0]?.includes("\t"))
      return { csvText: raw, fileName, sheetName: null, sourceFormat: "csv" };
    const rows = parseTabSeparated(raw);
    if (!rows.length) throw new Error("The spreadsheet is empty");
    return { csvText: rowsToCsv(rows[0]!, rows.slice(1)), fileName, sheetName: null, sourceFormat: "tsv" };
  }
  if (extension !== ".xlsx")
    throw new Error("Choose CSV, tab-separated text or an .xlsx workbook. Save legacy .xls files as .xlsx first.");
  const xlsxBuffer = readFileSync(filePath);
  assertSafeXlsxContainer(xlsxBuffer);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(xlsxBuffer as unknown as ExcelJS.Buffer);
  if (workbook.worksheets.length > MAX_WORKSHEETS)
    throw new Error(`The workbook has more than ${MAX_WORKSHEETS} worksheets`);
  const sheet = workbook.worksheets.find((candidate) => candidate.actualRowCount > 0);
  if (!sheet) throw new Error("The workbook has no non-empty worksheet");
  if (sheet.actualRowCount > MAX_SPREADSHEET_ROWS || sheet.actualColumnCount > MAX_SPREADSHEET_COLUMNS)
    throw new Error(`The worksheet exceeds ${MAX_SPREADSHEET_ROWS} rows or ${MAX_SPREADSHEET_COLUMNS} columns`);
  const rows: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = Array.from({ length: Math.max(sheet.actualColumnCount, row.cellCount) }, (_, index) => spreadsheetCellText(row.getCell(index + 1).value));
    if (values.some((value) => value.trim() !== "")) rows.push(values);
  });
  if (!rows.length) throw new Error("The workbook has no importable rows");
  return { csvText: rowsToCsv(rows[0]!, rows.slice(1)), fileName, sheetName: sheet.name, sourceFormat: "xlsx" };
}
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

export const PORTABLE_TABLES = [
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
  "import_batches",
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

const PORTABLE_DATA_NOTICE =
  "Amounts are integer paise; quantities are integer thousandths. Derived balances are not stored.";
const PORTABLE_OMITTED_SECRETS = [
  "user PIN hashes",
  "encrypted provider credentials",
  "live session tokens",
];

function portableContent(pkg: Omit<PortablePackage, "manifest">): string {
  return JSON.stringify({
    schema: pkg.schema,
    schemaVersion: pkg.schemaVersion,
    exportedAt: pkg.exportedAt,
    appDataNotice: pkg.appDataNotice,
    company: pkg.company,
    entities: pkg.entities,
  });
}

export function validatePortablePackage(input: unknown): PortablePackage {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Portable package must be a JSON object");
  const pkg = input as PortablePackage;
  if (pkg.schema !== "total.portable" || pkg.schemaVersion !== 1)
    throw new Error("Unsupported portable package schema");
  if (!pkg.company || typeof pkg.company !== "object")
    throw new Error("Portable package company metadata is missing");
  if (!pkg.entities || typeof pkg.entities !== "object" || Array.isArray(pkg.entities))
    throw new Error("Portable package entities are missing");
  if (!pkg.manifest || typeof pkg.manifest !== "object")
    throw new Error("Portable package manifest is missing");
  const allowed = new Set<string>(PORTABLE_TABLES);
  for (const [table, rows] of Object.entries(pkg.entities)) {
    if (!allowed.has(table)) throw new Error(`Portable package contains unsupported table "${table}"`);
    if (!Array.isArray(rows)) throw new Error(`Portable table "${table}" must be an array`);
    if (pkg.manifest.counts[table] !== rows.length)
      throw new Error(`Portable table "${table}" count does not match its manifest`);
  }
  for (const [table, count] of Object.entries(pkg.manifest.counts)) {
    if (!allowed.has(table) || !Number.isSafeInteger(count) || count < 0)
      throw new Error(`Portable manifest count for "${table}" is invalid`);
    if ((pkg.entities[table] ?? []).length !== count)
      throw new Error(`Portable manifest references missing table "${table}"`);
  }
  const content = portableContent(pkg);
  const expected = createHash("sha256").update(content).digest("hex");
  if (pkg.manifest.sha256 !== expected)
    throw new Error("Portable package content hash does not match the manifest");
  return pkg;
}

export interface PortableRestoreResult {
  company: CompanyInfo;
  counts: Record<string, number>;
  manifestHash: string;
}

/**
 * Reconstructs the portable accounting tables in a migrated destination database. The caller
 * must create the destination company folder and write the returned company metadata. Existing
 * posted books are never overwritten.
 */
export function restorePortablePackage(
  db: DB,
  input: unknown,
  actor: string,
): PortableRestoreResult {
  const pkg = validatePortablePackage(input);
  const existing = db.prepare("SELECT COUNT(*) AS n FROM vouchers").get() as { n: number };
  if (existing.n > 0) throw new Error("Portable restore requires a company with no posted vouchers");
  const run = db.transaction(() => {
    for (const table of [...PORTABLE_TABLES].reverse())
      db.prepare(`DELETE FROM "${table}"`).run();

    for (const table of PORTABLE_TABLES) {
      const rows = pkg.entities[table] ?? [];
      if (!rows.length) continue;
      const columns = new Set(
        (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((row) => row.name),
      );
      for (const raw of rows) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
          throw new Error(`Portable table "${table}" contains a non-object row`);
        const row = raw as Record<string, unknown>;
        const keys = Object.keys(row);
        if (!keys.length || keys.some((key) => !columns.has(key)))
          throw new Error(`Portable table "${table}" contains unknown or empty columns`);
        const quoted = keys.map((key) => `"${key}"`).join(",");
        const values = keys.map(() => "?").join(",");
        db.prepare(`INSERT INTO "${table}" (${quoted}) VALUES (${values})`).run(...keys.map((key) => row[key]));
      }
    }

    const foreignKeyFailure = db.prepare("PRAGMA foreign_key_check").get() as unknown;
    if (foreignKeyFailure) throw new Error("Portable package violates destination foreign keys");
    const unbalanced = db.prepare(`
      SELECT v.id
      FROM vouchers v
      JOIN voucher_lines l ON l.voucher_id=v.id
      GROUP BY v.id
      HAVING SUM(CASE WHEN l.dr_cr='dr' THEN l.amount ELSE -l.amount END)<>0
      LIMIT 1
    `).get() as { id: number } | undefined;
    if (unbalanced) throw new Error(`Portable package contains unbalanced voucher ${unbalanced.id}`);

    const counts: Record<string, number> = {};
    for (const table of PORTABLE_TABLES) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
      const expected = pkg.manifest.counts[table] ?? 0;
      if (row.n !== expected) throw new Error(`Portable restore count differs for "${table}"`);
      counts[table] = row.n;
    }
    return counts;
  });
  const counts = run();
  writeAudit(db, "portable_restore", 0, "import", null, {
    actor,
    manifestHash: pkg.manifest.sha256,
    counts,
  });
  return { company: pkg.company, counts, manifestHash: pkg.manifest.sha256 };
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
    appDataNotice: PORTABLE_DATA_NOTICE,
    company,
    entities,
  };
  const sha256 = createHash("sha256").update(portableContent(base)).digest("hex");
  return {
    ...base,
    manifest: {
      counts,
      sha256,
      omittedSecrets: PORTABLE_OMITTED_SECRETS,
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
  const exportedAt = new Date().toISOString();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(companyExportsDir(slug), `total-portable-v1-${stamp}.json`);
  const temporaryPath = `${path}.${randomUUID()}.partial`;
  mkdirSync(companyExportsDir(slug), { recursive: true });
  const hash = createHash("sha256");
  const counts: Record<string, number> = {};
  let manifestHash = "";
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    const write = (value: string, includeInHash = true): void => {
      writeSync(descriptor!, value, undefined, "utf8");
      if (includeInHash) hash.update(value);
    };
    write(
      `{"schema":"total.portable","schemaVersion":1,"exportedAt":${JSON.stringify(exportedAt)},` +
        `"appDataNotice":${JSON.stringify(PORTABLE_DATA_NOTICE)},"company":${JSON.stringify(company)},"entities":{`,
    );
    let firstTable = true;
    for (const table of PORTABLE_TABLES) {
      const exists = db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
        .get(table);
      if (!exists) continue;
      write(`${firstTable ? "" : ","}${JSON.stringify(table)}:[`);
      firstTable = false;
      let firstRow = true;
      let count = 0;
      for (const row of db.prepare(`SELECT * FROM "${table}" ORDER BY id`).iterate()) {
        write(`${firstRow ? "" : ","}${JSON.stringify(row)}`);
        firstRow = false;
        count++;
      }
      write("]");
      counts[table] = count;
    }
    write("}", false);
    hash.update("}}");
    manifestHash = hash.digest("hex");
    write(
      `,"manifest":${JSON.stringify({
        counts,
        sha256: manifestHash,
        omittedSecrets: PORTABLE_OMITTED_SECRETS,
      })}}`,
      false,
    );
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporaryPath, path);
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    try { unlinkSync(temporaryPath); } catch { /* no partial package remains */ }
    throw error;
  }
  const signed = signExportIfEnabled(slug, path);
  const id = Number(
    db
      .prepare(
        `INSERT INTO portable_export_receipts(schema_version,path,manifest_hash,counts_json,created_by) VALUES(1,?,?,?,?)`,
      )
      .run(
        path,
        manifestHash,
        JSON.stringify(counts),
        actor,
      ).lastInsertRowid,
  );
  writeAudit(db, "portable_export", id, "export", null, {
    path,
    manifestHash,
    counts,
  });
  return {
    path,
    manifestHash,
    counts,
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
    const extension = extname(name).toLowerCase();
    const portableExtension = /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : "";
    const stored = join(destination, `${randomUUID()}${portableExtension}`);
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
