import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { DB } from '../db/connection'
import { companyExportsDir } from '../paths'
import { rowsToCsv } from '@shared/csv'
import {
  ITEM_CSV_TEMPLATE, LEDGER_CSV_TEMPLATE, OPENING_CSV_TEMPLATE,
  parseItemsCsv, parseLedgersCsv, parseOpeningBalancesCsv,
  type CsvError, type ItemCsvRow, type LedgerCsvRow, type OpeningCsvRow
} from '@shared/importers'
import { ledgerInputSchema, stockItemInputSchema } from '@shared/schemas'
import * as masters from './masters'

export type ImportKind = 'ledgers' | 'items' | 'openings'

export interface ImportPreview {
  /** Parsed rows (each carries `line`, the source CSV line, for correlating with `errors`), capped to the first 200. */
  rows: Record<string, unknown>[]
  total: number
  willCreate: number
  willUpdate: number
  errors: CsvError[]
}

export interface ImportResult {
  created: number
  updated: number
  errors: CsvError[]
}

const PREVIEW_CAP = 200

// ---------- ledgers ----------

function resolveLedgerRows(
  db: DB,
  rows: LedgerCsvRow[]
): { ok: { row: LedgerCsvRow; groupId: number; existingId: number | null }[]; errors: CsvError[] } {
  const groups = db.prepare('SELECT id, name FROM groups').all() as { id: number; name: string }[]
  const groupByName = new Map(groups.map((g) => [g.name.toLowerCase(), g.id]))
  const ok: { row: LedgerCsvRow; groupId: number; existingId: number | null }[] = []
  const errors: CsvError[] = []
  for (const row of rows) {
    const groupId = groupByName.get(row.group.toLowerCase())
    if (groupId === undefined) {
      errors.push({ line: row.line, message: `Unknown group "${row.group}"` })
      continue
    }
    const existing = db.prepare('SELECT id FROM ledgers WHERE name = ? COLLATE NOCASE').get(row.name) as
      | { id: number }
      | undefined
    ok.push({ row, groupId, existingId: existing ? existing.id : null })
  }
  return { ok, errors }
}

export function previewLedgers(db: DB, csvText: string): ImportPreview {
  const { rows, errors: parseErrors } = parseLedgersCsv(csvText)
  const { ok, errors: resolveErrors } = resolveLedgerRows(db, rows)
  return {
    rows: rows.slice(0, PREVIEW_CAP).map((r) => ({ ...r }) as Record<string, unknown>),
    total: rows.length,
    willCreate: ok.filter((o) => o.existingId === null).length,
    willUpdate: ok.filter((o) => o.existingId !== null).length,
    errors: [...parseErrors, ...resolveErrors]
  }
}

/** Ledgers CSV only ever carries name/group/opening/gstin/state/pan/creditDays — on an update,
 *  everything else (address, taxType, gstRate, hsn, tdsSectionId, exportType) is preserved from
 *  the existing row rather than clobbered, matching importOpenings' preserve-the-rest behavior. */
export function importLedgers(db: DB, csvText: string): ImportResult {
  const { rows, errors: parseErrors } = parseLedgersCsv(csvText)
  const { ok, errors: resolveErrors } = resolveLedgerRows(db, rows)
  let created = 0
  let updated = 0
  const run = db.transaction(() => {
    for (const { row, groupId, existingId } of ok) {
      const existing = existingId !== null ? masters.getLedger(db, existingId) : null
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
        exportType: existing?.exportType ?? null
      })
      if (existingId !== null) {
        masters.updateLedger(db, existingId, input)
        updated++
      } else {
        masters.createLedger(db, input)
        created++
      }
    }
  })
  run()
  return { created, updated, errors: [...parseErrors, ...resolveErrors] }
}

// ---------- stock items ----------

function resolveItemRows(
  db: DB,
  rows: ItemCsvRow[]
): { ok: { row: ItemCsvRow; unitId: number; groupId: number | null; existingId: number | null }[]; errors: CsvError[] } {
  const units = db.prepare('SELECT id, name FROM units').all() as { id: number; name: string }[]
  const unitByName = new Map(units.map((u) => [u.name.toLowerCase(), u.id]))
  const groups = db.prepare('SELECT id, name FROM stock_groups').all() as { id: number; name: string }[]
  const groupByName = new Map(groups.map((g) => [g.name.toLowerCase(), g.id]))
  const ok: { row: ItemCsvRow; unitId: number; groupId: number | null; existingId: number | null }[] = []
  const errors: CsvError[] = []
  for (const row of rows) {
    const unitId = unitByName.get(row.unit.toLowerCase())
    if (unitId === undefined) {
      errors.push({ line: row.line, message: `Unknown unit "${row.unit}"` })
      continue
    }
    let groupId: number | null = null
    if (row.group) {
      const gid = groupByName.get(row.group.toLowerCase())
      if (gid === undefined) {
        errors.push({ line: row.line, message: `Unknown group "${row.group}"` })
        continue
      }
      groupId = gid
    }
    const existing = db.prepare('SELECT id FROM stock_items WHERE name = ? COLLATE NOCASE').get(row.name) as
      | { id: number }
      | undefined
    ok.push({ row, unitId, groupId, existingId: existing ? existing.id : null })
  }
  return { ok, errors }
}

export function previewItems(db: DB, csvText: string): ImportPreview {
  const { rows, errors: parseErrors } = parseItemsCsv(csvText)
  const { ok, errors: resolveErrors } = resolveItemRows(db, rows)
  return {
    rows: rows.slice(0, PREVIEW_CAP).map((r) => ({ ...r }) as Record<string, unknown>),
    total: rows.length,
    willCreate: ok.filter((o) => o.existingId === null).length,
    willUpdate: ok.filter((o) => o.existingId !== null).length,
    errors: [...parseErrors, ...resolveErrors]
  }
}

export function importItems(db: DB, csvText: string): ImportResult {
  const { rows, errors: parseErrors } = parseItemsCsv(csvText)
  const { ok, errors: resolveErrors } = resolveItemRows(db, rows)
  let created = 0
  let updated = 0
  const run = db.transaction(() => {
    for (const { row, unitId, groupId, existingId } of ok) {
      // The items CSV never carries cess/barcode/reorder columns — on an update, preserve what
      // the existing item already has instead of clobbering to null (v0.3 #68).
      const existing =
        existingId !== null
          ? (db
              .prepare('SELECT cess_rate AS cessRate, barcode, reorder_level_milli AS reorderLevelMilli FROM stock_items WHERE id = ?')
              .get(existingId) as { cessRate: number | null; barcode: string | null; reorderLevelMilli: number | null })
          : null
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
        reorderLevelMilli: existing?.reorderLevelMilli ?? null
      })
      if (existingId !== null) {
        masters.updateStockItem(db, existingId, input)
        updated++
      } else {
        masters.createStockItem(db, input)
        created++
      }
    }
  })
  run()
  return { created, updated, errors: [...parseErrors, ...resolveErrors] }
}

// ---------- opening balances ----------

function resolveOpeningRows(
  db: DB,
  rows: OpeningCsvRow[]
): { ok: { row: OpeningCsvRow; ledgerId: number }[]; errors: CsvError[] } {
  const ok: { row: OpeningCsvRow; ledgerId: number }[] = []
  const errors: CsvError[] = []
  for (const row of rows) {
    const existing = db.prepare('SELECT id FROM ledgers WHERE name = ? COLLATE NOCASE').get(row.ledgerName) as
      | { id: number }
      | undefined
    if (!existing) {
      errors.push({ line: row.line, message: `Unknown ledger "${row.ledgerName}"` })
      continue
    }
    ok.push({ row, ledgerId: existing.id })
  }
  return { ok, errors }
}

export function previewOpenings(db: DB, csvText: string): ImportPreview {
  const { rows, errors: parseErrors } = parseOpeningBalancesCsv(csvText)
  const { ok, errors: resolveErrors } = resolveOpeningRows(db, rows)
  return {
    rows: rows.slice(0, PREVIEW_CAP).map((r) => ({ ...r }) as Record<string, unknown>),
    total: rows.length,
    willCreate: 0,
    willUpdate: ok.length,
    errors: [...parseErrors, ...resolveErrors]
  }
}

export function importOpenings(db: DB, csvText: string): ImportResult {
  const { rows, errors: parseErrors } = parseOpeningBalancesCsv(csvText)
  const { ok, errors: resolveErrors } = resolveOpeningRows(db, rows)
  let updated = 0
  const run = db.transaction(() => {
    for (const { row, ledgerId } of ok) {
      const ledger = masters.getLedger(db, ledgerId)!
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
        exportType: ledger.exportType
      })
      masters.updateLedger(db, ledgerId, input)
      updated++
    }
  })
  run()
  return { created: 0, updated, errors: [...parseErrors, ...resolveErrors] }
}

// ---------- dispatch + templates ----------

export function previewImport(db: DB, kind: ImportKind, csvText: string): ImportPreview {
  if (kind === 'ledgers') return previewLedgers(db, csvText)
  if (kind === 'items') return previewItems(db, csvText)
  return previewOpenings(db, csvText)
}

export function applyImport(db: DB, kind: ImportKind, csvText: string): ImportResult {
  if (kind === 'ledgers') return importLedgers(db, csvText)
  if (kind === 'items') return importItems(db, csvText)
  return importOpenings(db, csvText)
}

/** Writes exports/template-<kind>.csv (header + one example row) and returns its path. */
export function writeTemplateCsv(slug: string, kind: ImportKind): string {
  const template = kind === 'ledgers' ? LEDGER_CSV_TEMPLATE : kind === 'items' ? ITEM_CSV_TEMPLATE : OPENING_CSV_TEMPLATE
  const dir = companyExportsDir(slug)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `template-${kind}.csv`)
  writeFileSync(path, rowsToCsv(template[0]!, template.slice(1)))
  return path
}
