import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { DB } from "../db/connection";
import { companyExportsDir } from "../paths";
import { parseCsv, rowsToCsv } from "@shared/csv";
import {
  GENERIC_JOURNAL_CSV_TEMPLATE,
  ITEM_CSV_TEMPLATE,
  LEDGER_CSV_TEMPLATE,
  OPENING_CSV_TEMPLATE,
  parseGenericJournalCsv,
  parseItemsCsv,
  parseLedgersCsv,
  parseOpeningBalancesCsv,
  type CsvError,
  type GenericJournalCsvRow,
  type ItemCsvRow,
  type LedgerCsvRow,
  type OpeningCsvRow,
} from "@shared/importers";
import { ledgerInputSchema, stockItemInputSchema } from "@shared/schemas";
import * as masters from "./masters";
import { writeAudit } from "./audit";
import {
  assertImportNotApplied,
  findImportBatch,
  importSourceHash,
  recordImportBatch,
} from "./importBatches";
import { saveVoucher } from "./vouchers";

export type ImportKind =
  | "ledgers"
  | "items"
  | "openings"
  | "generic_journal"
  | "busy"
  | "zoho_books"
  | "marg";

export interface ImportPreview {
  /** Parsed rows (each carries `line`, the source CSV line, for correlating with `errors`), capped to the first 200. */
  rows: Record<string, unknown>[];
  total: number;
  willCreate: number;
  willUpdate: number;
  errors: CsvError[];
  reconciliation: ImportReconciliation;
  sourceHash: string;
  alreadyImported: { id: number; appliedAt: string } | null;
}

export interface ImportResult {
  created: number;
  updated: number;
  errors: CsvError[];
  reconciliation: ImportReconciliation;
  sourceHash: string;
  batchId: number;
}

export interface ImportReconciliation {
  sourceRows: number;
  parsedRows: number;
  acceptedRows: number;
  rejectedRows: number;
  sourceAmount: number;
  acceptedAmount: number;
  rejectedAmount: number;
  rowsAccountedFor: boolean;
  amountsAccountedFor: boolean;
}

const PREVIEW_CAP = 200;

function physicalDataRows(csvText: string): number {
  // Count logical records, not physical lines: quoted notes may legitimately span lines.
  return Math.max(0, parseCsv(csvText).length - 1);
}

function reconciliation<Row>(
  csvText: string,
  rows: Row[],
  acceptedRows: Row[],
  amountOf: (row: Row) => number,
): ImportReconciliation {
  const sourceRows = physicalDataRows(csvText);
  const acceptedAmount = acceptedRows.reduce(
    (sum, row) => sum + amountOf(row),
    0,
  );
  const sourceAmount = rows.reduce((sum, row) => sum + amountOf(row), 0);
  const rejectedRows = Math.max(0, sourceRows - acceptedRows.length);
  const rejectedAmount = sourceAmount - acceptedAmount;
  return {
    sourceRows,
    parsedRows: rows.length,
    acceptedRows: acceptedRows.length,
    rejectedRows,
    sourceAmount,
    acceptedAmount,
    rejectedAmount,
    rowsAccountedFor: acceptedRows.length + rejectedRows === sourceRows,
    amountsAccountedFor: acceptedAmount + rejectedAmount === sourceAmount,
  };
}

function decoratePreview(
  db: DB,
  kind: ImportKind,
  csvText: string,
  preview: Omit<ImportPreview, "sourceHash" | "alreadyImported">,
): ImportPreview {
  const existing = findImportBatch(db, kind, csvText);
  return {
    ...preview,
    sourceHash: importSourceHash(csvText),
    alreadyImported: existing
      ? { id: existing.id, appliedAt: existing.appliedAt }
      : null,
  };
}

// ---------- ledgers ----------

function resolveLedgerRows(
  db: DB,
  rows: LedgerCsvRow[],
): {
  ok: { row: LedgerCsvRow; groupId: number; existingId: number | null }[];
  errors: CsvError[];
} {
  const groups = db.prepare("SELECT id, name FROM groups").all() as {
    id: number;
    name: string;
  }[];
  const groupByName = new Map(groups.map((g) => [g.name.toLowerCase(), g.id]));
  const ok: {
    row: LedgerCsvRow;
    groupId: number;
    existingId: number | null;
  }[] = [];
  const errors: CsvError[] = [];
  for (const row of rows) {
    const groupId = groupByName.get(row.group.toLowerCase());
    if (groupId === undefined) {
      errors.push({ line: row.line, message: `Unknown group "${row.group}"` });
      continue;
    }
    const existing = db
      .prepare("SELECT id FROM ledgers WHERE name = ? COLLATE NOCASE")
      .get(row.name) as { id: number } | undefined;
    ok.push({ row, groupId, existingId: existing ? existing.id : null });
  }
  return { ok, errors };
}

export function previewLedgers(db: DB, csvText: string): ImportPreview {
  const { rows, errors: parseErrors } = parseLedgersCsv(csvText);
  const { ok, errors: resolveErrors } = resolveLedgerRows(db, rows);
  return {
    rows: rows
      .slice(0, PREVIEW_CAP)
      .map((r) => ({ ...r }) as Record<string, unknown>),
    total: rows.length,
    willCreate: ok.filter((o) => o.existingId === null).length,
    willUpdate: ok.filter((o) => o.existingId !== null).length,
    errors: [...parseErrors, ...resolveErrors],
    reconciliation: reconciliation(
      csvText,
      rows,
      ok.map((o) => o.row),
      (row) => row.openingBalance,
    ),
    sourceHash: importSourceHash(csvText),
    alreadyImported: null,
  };
}

/** Ledgers CSV only ever carries name/group/opening/gstin/state/pan/creditDays — on an update,
 *  everything else (address, taxType, gstRate, hsn, tdsSectionId, exportType) is preserved from
 *  the existing row rather than clobbered, matching importOpenings' preserve-the-rest behavior. */
export function importLedgers(
  db: DB,
  csvText: string,
): Omit<ImportResult, "sourceHash" | "batchId"> {
  const { rows, errors: parseErrors } = parseLedgersCsv(csvText);
  const { ok, errors: resolveErrors } = resolveLedgerRows(db, rows);
  let created = 0;
  let updated = 0;
  const run = db.transaction(() => {
    for (const { row, groupId, existingId } of ok) {
      const existing =
        existingId !== null ? masters.getLedger(db, existingId) : null;
      const input = ledgerInputSchema.parse({
        name: row.name,
        groupId,
        openingBalance: row.openingBalance,
        gstin: row.gstin,
        stateCode: row.stateCode,
        address: existing?.address ?? null,
        taxType: existing?.taxType ?? null,
        gstRate: existing?.gstRate ?? null,
        hsn: existing?.hsn ?? null,
        tdsSectionId: existing?.tdsSectionId ?? null,
        pan: row.pan ?? existing?.pan ?? null,
        creditDays: row.creditDays ?? existing?.creditDays ?? null,
        exportType: existing?.exportType ?? null,
        rcm: existing?.rcm ?? false,
        itcEligibility: existing?.itcEligibility ?? "eligible",
      });
      if (existingId !== null) {
        masters.updateLedger(db, existingId, input);
        updated++;
      } else {
        masters.createLedger(db, input);
        created++;
      }
    }
  });
  run();
  return {
    created,
    updated,
    errors: [...parseErrors, ...resolveErrors],
    reconciliation: reconciliation(
      csvText,
      rows,
      ok.map((o) => o.row),
      (row) => row.openingBalance,
    ),
  };
}

// ---------- stock items ----------

function resolveItemRows(
  db: DB,
  rows: ItemCsvRow[],
): {
  ok: {
    row: ItemCsvRow;
    unitId: number;
    groupId: number | null;
    existingId: number | null;
  }[];
  errors: CsvError[];
} {
  const units = db.prepare("SELECT id, name FROM units").all() as {
    id: number;
    name: string;
  }[];
  const unitByName = new Map(units.map((u) => [u.name.toLowerCase(), u.id]));
  const groups = db.prepare("SELECT id, name FROM stock_groups").all() as {
    id: number;
    name: string;
  }[];
  const groupByName = new Map(groups.map((g) => [g.name.toLowerCase(), g.id]));
  const ok: {
    row: ItemCsvRow;
    unitId: number;
    groupId: number | null;
    existingId: number | null;
  }[] = [];
  const errors: CsvError[] = [];
  for (const row of rows) {
    const unitId = unitByName.get(row.unit.toLowerCase());
    if (unitId === undefined) {
      errors.push({ line: row.line, message: `Unknown unit "${row.unit}"` });
      continue;
    }
    let groupId: number | null = null;
    if (row.group) {
      const gid = groupByName.get(row.group.toLowerCase());
      if (gid === undefined) {
        errors.push({
          line: row.line,
          message: `Unknown group "${row.group}"`,
        });
        continue;
      }
      groupId = gid;
    }
    const existing = db
      .prepare("SELECT id FROM stock_items WHERE name = ? COLLATE NOCASE")
      .get(row.name) as { id: number } | undefined;
    ok.push({
      row,
      unitId,
      groupId,
      existingId: existing ? existing.id : null,
    });
  }
  return { ok, errors };
}

export function previewItems(db: DB, csvText: string): ImportPreview {
  const { rows, errors: parseErrors } = parseItemsCsv(csvText);
  const { ok, errors: resolveErrors } = resolveItemRows(db, rows);
  return {
    rows: rows
      .slice(0, PREVIEW_CAP)
      .map((r) => ({ ...r }) as Record<string, unknown>),
    total: rows.length,
    willCreate: ok.filter((o) => o.existingId === null).length,
    willUpdate: ok.filter((o) => o.existingId !== null).length,
    errors: [...parseErrors, ...resolveErrors],
    reconciliation: reconciliation(
      csvText,
      rows,
      ok.map((o) => o.row),
      (row) => row.openingValue,
    ),
    sourceHash: importSourceHash(csvText),
    alreadyImported: null,
  };
}

export function importItems(
  db: DB,
  csvText: string,
): Omit<ImportResult, "sourceHash" | "batchId"> {
  const { rows, errors: parseErrors } = parseItemsCsv(csvText);
  const { ok, errors: resolveErrors } = resolveItemRows(db, rows);
  let created = 0;
  let updated = 0;
  const run = db.transaction(() => {
    for (const { row, unitId, groupId, existingId } of ok) {
      // The items CSV never carries cess/barcode/reorder columns — on an update, preserve what
      // the existing item already has instead of clobbering to null (v0.3 #68).
      const existing =
        existingId !== null
          ? (db
              .prepare(
                "SELECT cess_rate AS cessRate, barcode, reorder_level_milli AS reorderLevelMilli FROM stock_items WHERE id = ?",
              )
              .get(existingId) as {
              cessRate: number | null;
              barcode: string | null;
              reorderLevelMilli: number | null;
            })
          : null;
      const input = stockItemInputSchema.parse({
        name: row.name,
        groupId,
        unitId,
        hsn: row.hsn,
        gstRate: row.gstRate,
        cessRate: existing?.cessRate ?? null,
        openingQtyMilli: row.openingQtyMilli,
        openingValue: row.openingValue,
        barcode: existing?.barcode ?? null,
        reorderLevelMilli: existing?.reorderLevelMilli ?? null,
      });
      if (existingId !== null) {
        masters.updateStockItem(db, existingId, input);
        updated++;
      } else {
        masters.createStockItem(db, input);
        created++;
      }
    }
  });
  run();
  return {
    created,
    updated,
    errors: [...parseErrors, ...resolveErrors],
    reconciliation: reconciliation(
      csvText,
      rows,
      ok.map((o) => o.row),
      (row) => row.openingValue,
    ),
  };
}

// ---------- opening balances ----------

function resolveOpeningRows(
  db: DB,
  rows: OpeningCsvRow[],
): { ok: { row: OpeningCsvRow; ledgerId: number }[]; errors: CsvError[] } {
  const ok: { row: OpeningCsvRow; ledgerId: number }[] = [];
  const errors: CsvError[] = [];
  for (const row of rows) {
    const existing = db
      .prepare("SELECT id FROM ledgers WHERE name = ? COLLATE NOCASE")
      .get(row.ledgerName) as { id: number } | undefined;
    if (!existing) {
      errors.push({
        line: row.line,
        message: `Unknown ledger "${row.ledgerName}"`,
      });
      continue;
    }
    ok.push({ row, ledgerId: existing.id });
  }
  return { ok, errors };
}

export function previewOpenings(db: DB, csvText: string): ImportPreview {
  const { rows, errors: parseErrors } = parseOpeningBalancesCsv(csvText);
  const { ok, errors: resolveErrors } = resolveOpeningRows(db, rows);
  return {
    rows: rows
      .slice(0, PREVIEW_CAP)
      .map((r) => ({ ...r }) as Record<string, unknown>),
    total: rows.length,
    willCreate: 0,
    willUpdate: ok.length,
    errors: [...parseErrors, ...resolveErrors],
    reconciliation: reconciliation(
      csvText,
      rows,
      ok.map((o) => o.row),
      (row) => row.opening,
    ),
    sourceHash: importSourceHash(csvText),
    alreadyImported: null,
  };
}

export function importOpenings(
  db: DB,
  csvText: string,
): Omit<ImportResult, "sourceHash" | "batchId"> {
  const { rows, errors: parseErrors } = parseOpeningBalancesCsv(csvText);
  const { ok, errors: resolveErrors } = resolveOpeningRows(db, rows);
  let updated = 0;
  const run = db.transaction(() => {
    for (const { row, ledgerId } of ok) {
      const ledger = masters.getLedger(db, ledgerId)!;
      const input = ledgerInputSchema.parse({
        name: ledger.name,
        groupId: ledger.groupId,
        openingBalance: row.opening,
        gstin: ledger.gstin,
        stateCode: ledger.stateCode,
        address: ledger.address,
        taxType: ledger.taxType,
        gstRate: ledger.gstRate,
        hsn: ledger.hsn,
        tdsSectionId: ledger.tdsSectionId,
        pan: ledger.pan,
        creditDays: ledger.creditDays,
        exportType: ledger.exportType,
        rcm: ledger.rcm,
        itcEligibility: ledger.itcEligibility,
      });
      masters.updateLedger(db, ledgerId, input);
      updated++;
    }
  });
  run();
  return {
    created: 0,
    updated,
    errors: [...parseErrors, ...resolveErrors],
    reconciliation: reconciliation(
      csvText,
      rows,
      ok.map((o) => o.row),
      (row) => row.opening,
    ),
  };
}

// ---------- balanced journal transactions (generic + Busy/Zoho Books/Marg presets) ----------

interface ResolvedJournalGroup {
  key: string;
  rows: GenericJournalCsvRow[];
  voucherTypeId: number;
  ledgerIds: Map<number, number>;
}
function resolveJournalGroups(
  db: DB,
  rows: GenericJournalCsvRow[],
): { ok: ResolvedJournalGroup[]; errors: CsvError[] } {
  const errors: CsvError[] = [];
  const byGroup = new Map<string, GenericJournalCsvRow[]>();
  for (const row of rows)
    byGroup.set(row.group, [...(byGroup.get(row.group) ?? []), row]);
  const ledgers = db.prepare("SELECT id,name FROM ledgers").all() as {
    id: number;
    name: string;
  }[];
  const ledgerByName = new Map(
    ledgers.map((row) => [row.name.toLowerCase(), row.id]),
  );
  const types = db.prepare("SELECT id,name,kind FROM voucher_types").all() as {
    id: number;
    name: string;
    kind: string;
  }[];
  const ok: ResolvedJournalGroup[] = [];
  for (const [key, groupRows] of byGroup) {
    const first = groupRows[0]!;
    if (groupRows.some((row) => row.date !== first.date)) {
      errors.push({
        line: first.line,
        message: `Voucher group "${key}" contains multiple dates`,
      });
      continue;
    }
    const debit = groupRows.reduce((sum, row) => sum + row.debit, 0),
      credit = groupRows.reduce((sum, row) => sum + row.credit, 0);
    if (debit !== credit) {
      errors.push({
        line: first.line,
        message: `Voucher group "${key}" is unbalanced: debit ${debit} paise, credit ${credit} paise`,
      });
      continue;
    }
    const type = types.find(
      (row) =>
        row.name.toLowerCase() === first.voucherType.toLowerCase() ||
        row.kind.toLowerCase() ===
          first.voucherType.toLowerCase().replace(/\s+/g, "_"),
    );
    if (!type) {
      errors.push({
        line: first.line,
        message: `Unknown voucher type "${first.voucherType}"`,
      });
      continue;
    }
    const ledgerIds = new Map<number, number>();
    let bad = false;
    for (const row of groupRows) {
      const ledgerId = ledgerByName.get(row.ledger.toLowerCase());
      if (!ledgerId) {
        errors.push({
          line: row.line,
          message: `Unknown ledger "${row.ledger}"`,
        });
        bad = true;
      } else ledgerIds.set(row.line, ledgerId);
    }
    if (!bad)
      ok.push({ key, rows: groupRows, voucherTypeId: type.id, ledgerIds });
  }
  return { ok, errors };
}

export function previewJournals(db: DB, csvText: string): ImportPreview {
  const parsed = parseGenericJournalCsv(csvText);
  const resolved = resolveJournalGroups(db, parsed.rows);
  const accepted = resolved.ok.flatMap((group) => group.rows);
  return {
    rows: parsed.rows.slice(0, PREVIEW_CAP).map((row) => ({ ...row })),
    total: parsed.rows.length,
    willCreate: resolved.ok.length,
    willUpdate: 0,
    errors: [...parsed.errors, ...resolved.errors],
    reconciliation: reconciliation(
      csvText,
      parsed.rows,
      accepted,
      (row) => row.debit,
    ),
    sourceHash: importSourceHash(csvText),
    alreadyImported: null,
  };
}

export function importJournals(
  db: DB,
  csvText: string,
): Omit<ImportResult, "sourceHash" | "batchId"> {
  const parsed = parseGenericJournalCsv(csvText);
  const resolved = resolveJournalGroups(db, parsed.rows);
  let created = 0;
  for (const group of resolved.ok) {
    const first = group.rows[0]!;
    saveVoucher(db, {
      voucherTypeId: group.voucherTypeId,
      date: first.date,
      number: first.number ?? undefined,
      partyLedgerId: null,
      narration: first.narration,
      reference: first.reference,
      instrumentNo: null,
      instrumentDate: null,
      transporterId: null,
      vehicleNo: null,
      transportDistanceKm: null,
      currencyCode: null,
      exchangeRate: null,
      lines: group.rows.map((row) => ({
        ledgerId: group.ledgerIds.get(row.line)!,
        drCr: row.debit > 0 ? ("dr" as const) : ("cr" as const),
        amount: row.debit || row.credit,
        costAllocations: [],
      })),
      inventory: [],
      billRefs: [],
      tds: null,
    });
    created++;
  }
  const accepted = resolved.ok.flatMap((group) => group.rows);
  return {
    created,
    updated: 0,
    errors: [...parsed.errors, ...resolved.errors],
    reconciliation: reconciliation(
      csvText,
      parsed.rows,
      accepted,
      (row) => row.debit,
    ),
  };
}

// ---------- dispatch + templates ----------

export function previewImport(
  db: DB,
  kind: ImportKind,
  csvText: string,
): ImportPreview {
  const preview =
    kind === "ledgers"
      ? previewLedgers(db, csvText)
      : kind === "items"
        ? previewItems(db, csvText)
        : kind === "openings"
          ? previewOpenings(db, csvText)
          : previewJournals(db, csvText);
  return decoratePreview(db, kind, csvText, preview);
}

export function applyImport(
  db: DB,
  kind: ImportKind,
  csvText: string,
): ImportResult {
  const run = db.transaction((): ImportResult => {
    assertImportNotApplied(db, kind, csvText);
    const result =
      kind === "ledgers"
        ? importLedgers(db, csvText)
        : kind === "items"
          ? importItems(db, csvText)
          : kind === "openings"
            ? importOpenings(db, csvText)
            : importJournals(db, csvText);
    const batch = recordImportBatch(db, kind, csvText, {
      sourceRows: result.reconciliation.sourceRows,
      acceptedRows: result.reconciliation.acceptedRows,
      rejectedRows: result.reconciliation.rejectedRows,
      summary: result,
    });
    writeAudit(db, "import_batch", batch.id, "import", null, {
      kind,
      sourceHash: batch.sourceHash,
      created: result.created,
      updated: result.updated,
      reconciliation: result.reconciliation,
    });
    return { ...result, sourceHash: batch.sourceHash, batchId: batch.id };
  });
  return run();
}

/** Writes exports/template-<kind>.csv (header + one example row) and returns its path. */
export function writeTemplateCsv(slug: string, kind: ImportKind): string {
  const template =
    kind === "ledgers"
      ? LEDGER_CSV_TEMPLATE
      : kind === "items"
        ? ITEM_CSV_TEMPLATE
        : kind === "openings"
          ? OPENING_CSV_TEMPLATE
          : GENERIC_JOURNAL_CSV_TEMPLATE;
  const dir = companyExportsDir(slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `template-${kind}.csv`);
  writeFileSync(path, rowsToCsv(template[0]!, template.slice(1)));
  return path;
}
