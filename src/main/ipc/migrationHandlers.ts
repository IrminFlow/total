import { dialog, shell } from "electron";
import { readFileSync } from "fs";
import { z } from "zod";
import type { CompanyContext, IpcHandle } from "./types";
import { tallyImportSchema } from "@shared/schemas";
import { backupCompany } from "../db/connection";
import { importTallyXml, dryRunTallyXml } from "../services/tallyImport";
import * as importer from "../services/importers";
import { findImportBatch, importSourceHash } from "../services/importBatches";
import * as migrationTools from "../services/migrationTools";
import * as systemHealthService from "../services/systemHealth";

interface MigrationHandlerContext {
  handle: IpcHandle;
  requireCompany: () => CompanyContext;
  actor: () => string;
}

/** Paths issued by this process's Tally picker. Inline XML remains available to tests and drivers. */
const dialogIssuedTallyPaths = new Set<string>();
const importKindSchema = z.enum(["ledgers", "items", "openings", "generic_journal", "busy", "zoho_books", "marg"]);
const mappingProfileInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  sourceKind: z.enum(["generic", "busy", "zoho_books", "marg"]),
  targetKind: z.enum(["ledgers", "items", "openings", "generic_journal"]),
  fieldMappings: z.record(z.string(), z.string()),
  valueMappings: z.record(z.string(), z.record(z.string(), z.string())),
  dateFormat: z.string().trim().min(1).max(30),
  active: z.boolean(),
});

export function registerMigrationHandlers({ handle, requireCompany, actor }: MigrationHandlerContext): void {
  handle("import:pickCsv", async () => {
    const picked = await dialog.showOpenDialog({
      title: "Choose a spreadsheet",
      filters: [{ name: "Spreadsheet", extensions: ["csv", "tsv", "txt", "xlsx"] }],
      properties: ["openFile"],
    });
    if (picked.canceled || !picked.filePaths[0]) return null;
    return migrationTools.spreadsheetFileToCsv(picked.filePaths[0]);
  });
  handle("import:preview", (payload) => {
    const { kind, csvText } = z.object({ kind: importKindSchema, csvText: z.string() }).parse(payload);
    return importer.previewImport(requireCompany().db, kind, csvText);
  });
  handle("import:apply", async (payload) => {
    const { kind, csvText } = z.object({ kind: importKindSchema, csvText: z.string() }).parse(payload);
    const company = requireCompany();
    systemHealthService.assertImportCapacity(company.slug, Buffer.byteLength(csvText, "utf8"));
    await backupCompany(company.db, company.slug, `pre-import-${kind}`);
    return importer.applyImport(company.db, kind, csvText);
  });
  handle("import:template", (payload) => {
    const { kind } = z.object({ kind: importKindSchema }).parse(payload);
    const company = requireCompany();
    const path = importer.writeTemplateCsv(company.slug, kind);
    shell.showItemInFolder(path);
    return { path };
  });
  handle("import:profiles:list", () => migrationTools.listMappingProfiles(requireCompany().db), "viewer");
  handle("import:profiles:save", (payload) => {
    const { data, id } = z.object({ data: mappingProfileInputSchema, id: z.number().int().positive().optional() }).parse(payload);
    return migrationTools.saveMappingProfile(requireCompany().db, data, actor(), id);
  }, "owner");
  handle("import:profilePreview", (payload) => {
    const { profileId, csvText } = z.object({ profileId: z.number().int().positive(), csvText: z.string() }).parse(payload);
    const profile = migrationTools.listMappingProfiles(requireCompany().db).find((row) => row.id === profileId);
    if (!profile) throw new Error("Mapping profile not found");
    return migrationTools.previewWithProfile(requireCompany().db, csvText, profile);
  });
  handle("import:profileApply", async (payload) => {
    const { profileId, csvText } = z.object({ profileId: z.number().int().positive(), csvText: z.string() }).parse(payload);
    const company = requireCompany();
    const profile = migrationTools.listMappingProfiles(company.db).find((row) => row.id === profileId);
    if (!profile) throw new Error("Mapping profile not found");
    const normalized = migrationTools.applyMappingProfile(csvText, profile);
    systemHealthService.assertImportCapacity(company.slug, Buffer.byteLength(normalized, "utf8"));
    await backupCompany(company.db, company.slug, `pre-import-${profile.sourceKind}`);
    return importer.applyImport(company.db, profile.targetKind, normalized);
  });
  handle("import:errorWorkbook", async (payload) => {
    const { fileName, csvText, kind } = z.object({ fileName: z.string().trim().min(1).max(255), csvText: z.string(), kind: importKindSchema }).parse(payload);
    const company = requireCompany();
    const preview = importer.previewImport(company.db, kind, csvText);
    const path = await migrationTools.writeErrorWorkbook(company.slug, fileName, csvText, preview);
    shell.showItemInFolder(path);
    return { path };
  });
  handle("import:attachments", async (payload) => {
    const { batchId, csvText } = z.object({ batchId: z.number().int().positive(), csvText: z.string() }).parse(payload);
    const picked = await dialog.showOpenDialog({ title: "Choose the folder containing source documents", properties: ["openDirectory"] });
    if (picked.canceled || !picked.filePaths[0]) return null;
    const company = requireCompany();
    systemHealthService.assertImportCapacity(company.slug, Buffer.byteLength(csvText, "utf8"));
    return migrationTools.linkImportAttachments(company.db, company.slug, batchId, picked.filePaths[0], csvText, actor());
  });
  handle("export:portable", () => {
    const company = requireCompany();
    const result = migrationTools.writePortablePackage(company.db, company.info, company.slug, actor());
    shell.showItemInFolder(result.path);
    return result;
  }, "owner");

  handle("tally:import", async (payload) => {
    const { xmlText, filePath, dryRun } = tallyImportSchema.parse(payload ?? {});
    const company = requireCompany();
    let xml = xmlText;
    let resolvedPath = filePath;
    if (xml === undefined && filePath !== undefined) {
      if (!dialogIssuedTallyPaths.has(filePath)) throw new Error("File path must come from the file picker");
      xml = readFileSync(filePath, "utf8");
    }
    if (xml === undefined) {
      const picked = await dialog.showOpenDialog({
        title: "Choose a Tally XML export (Masters and/or Vouchers)",
        filters: [{ name: "Tally XML", extensions: ["xml", "txt"] }],
        properties: ["openFile"],
      });
      if (picked.canceled || !picked.filePaths[0]) return null;
      resolvedPath = picked.filePaths[0];
      dialogIssuedTallyPaths.add(resolvedPath);
      xml = readFileSync(resolvedPath, "utf8");
    }
    if (dryRun) {
      const existing = findImportBatch(company.db, "tally", xml);
      return {
        filePath: resolvedPath ?? null,
        summary: {
          ...dryRunTallyXml(xml),
          sourceHash: importSourceHash(xml),
          alreadyImported: existing ? { id: existing.id, appliedAt: existing.appliedAt } : null,
        },
      };
    }
    systemHealthService.assertImportCapacity(company.slug, Buffer.byteLength(xml, "utf8"));
    const existing = findImportBatch(company.db, "tally", xml);
    if (existing) throw new Error(`This exact Tally file was already imported on ${existing.appliedAt} (batch #${existing.id})`);
    await backupCompany(company.db, company.slug, "pre-tally-import");
    return { filePath: resolvedPath ?? null, summary: importTallyXml(company.db, xml) };
  });
}
