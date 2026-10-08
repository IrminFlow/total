/**
 * Import wizard file handling (WP 6.3) without Electron: bytes → a LoadedFile (XLSX sheets, a
 * CSV/TSV table, a Books workbook or a Busy XML export), a sheet's header detection + profile
 * guesses, and the plan steps a run applies. ipcDataImport.ts keeps LoadedFiles between the
 * wizard's steps; dbtests call these directly.
 */
import { randomUUID } from 'crypto'
import type { DB } from '../db/connection'
import { cellText, looksLikeZip } from '@shared/xlsx'
import { parseCsv } from '@shared/csv'
import { applyMapping, autoMap, detectHeaderRow, headerSignature, tableFrom, type ColumnMapping, type Grid } from '@shared/dataImport/detect'
import { PROFILES, profileById, rankProfiles, type ImportProfile } from '@shared/dataImport/profiles'
import { booksPlan, readManifest, MANIFEST_SHEET, type BooksManifest } from '@shared/dataImport/books'
import { isBusyXml, parseBusyXml, type BusyXmlImport } from '@shared/dataImport/busy'
import type { RowError } from '@shared/dataImport/targets'
import { normalizeDecimalComma, type DateOrder } from '@shared/dataImport/values'
import { listTemplates, type PlanStep } from './dataImport'
import { readXlsxBytes } from './xlsxFile'

export interface LoadedFile {
  token: string
  fileName: string
  kind: 'table' | 'books' | 'busyXml'
  sheets: { name: string; grid: Grid }[]
  manifest: BooksManifest | null
  busy: BusyXmlImport | null
}

/** CSV or TSV text → one grid. A tab-separated first line with no commas reads as TSV. */
export function textGrid(text: string): Grid {
  const clean = text.replace(/^﻿/, '')
  const first = clean.split(/\r?\n/, 1)[0] ?? ''
  if (first.includes('\t') && !first.includes(',')) {
    return { rows: clean.split(/\r?\n/).map((l, i) => ({ line: i + 1, cells: l.split('\t') })).filter((r) => r.cells.some((c) => c.trim())) }
  }
  return { rows: parseCsv(clean).map((r) => ({ line: r.line, cells: r.cells })) }
}

export function parseImportFile(fileName: string, bytes: Uint8Array): LoadedFile {
  const token = randomUUID()
  if (looksLikeZip(bytes)) {
    const wb = readXlsxBytes(bytes)
    const sheets = wb.sheets.map((s) => ({ name: s.name, grid: { rows: s.rows.map((r) => ({ line: r.r, cells: r.cells.map(cellText) })) } }))
    const manifest = readManifest(sheets.find((s) => s.name === MANIFEST_SHEET)?.grid)
    return { token, fileName, kind: manifest ? 'books' : 'table', sheets, manifest, busy: null }
  }
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf) throw new Error('This is an Excel 97–2003 (.xls) file — save it as .xlsx or CSV first')
  const text = new TextDecoder('utf-8').decode(bytes)
  if (isBusyXml(text)) return { token, fileName, kind: 'busyXml', sheets: [], manifest: null, busy: parseBusyXml(text) }
  if (/<ENVELOPE[\s>]/i.test(text.slice(0, 4000))) throw new Error('This is a Tally XML export — use System → Import from Tally')
  return { token, fileName, kind: 'table', sheets: [{ name: fileName.replace(/\.[^.]+$/, '') || 'Sheet1', grid: textGrid(text) }], manifest: null, busy: null }
}

const ALL_FIELD_LISTS = PROFILES.map((p) => p.fields)

export function sheetSummary(db: DB, s: { name: string; grid: Grid }, headerRowOverride?: number) {
  const headerRow = headerRowOverride ?? detectHeaderRow(s.grid, ALL_FIELD_LISTS)
  const table = tableFrom(s.grid, headerRow)
  return {
    name: s.name,
    rowCount: table.rows.length,
    headerRow,
    headerLine: s.grid.rows[headerRow]?.line ?? 1,
    headers: table.headers,
    sample: table.rows.slice(0, 8).map((r) => r.cells),
    guesses: rankProfiles(table.headers).slice(0, 5),
    templates: listTemplates(db, { headerSignature: headerSignature(table.headers) })
  }
}

export interface TableRunQuery {
  sheet: string
  headerRow: number
  profileId: string
  mapping: ColumnMapping
  dateOrder: DateOrder
  /** Numbers in the file use a decimal comma ("1.234,56"): numeric cells are converted first. */
  decimalComma?: boolean
}

export function tableSteps(f: LoadedFile, q: TableRunQuery, companyStateCode: string): { steps: PlanStep[]; profile: ImportProfile } {
  const sheet = f.sheets.find((s) => s.name === q.sheet)
  if (!sheet) throw new Error(`Sheet "${q.sheet}" not found`)
  const profile = profileById(q.profileId)
  if (!profile) throw new Error(`Unknown import profile ${q.profileId}`)
  const missing = profile.fields.filter((fd) => fd.required && (q.mapping[fd.key] === null || q.mapping[fd.key] === undefined))
  if (missing.length) throw new Error(`Map the required column${missing.length > 1 ? 's' : ''}: ${missing.map((m) => m.label).join(', ')}`)
  const table = tableFrom(sheet.grid, q.headerRow)
  let records = applyMapping(table, q.mapping)
  if (q.decimalComma) records = records.map((r) => ({ ...r, values: Object.fromEntries(Object.entries(r.values).map(([k, v]) => [k, normalizeDecimalComma(v)])) }))
  const { result, errors } = profile.transform(records, { dateOrder: q.dateOrder, companyStateCode })
  return { steps: [{ rows: result, errors, sheet: sheet.name }], profile }
}

export function planSteps(f: LoadedFile): PlanStep[] {
  if (f.kind === 'books') {
    const { steps } = booksPlan(new Map(f.sheets.map((s) => [s.name, s.grid])), { dateOrder: 'ymd' })
    return steps.map((s) => ({ rows: s.rows, errors: s.errors, sheet: s.sheet }))
  }
  if (f.kind === 'busyXml' && f.busy) {
    const b = f.busy
    const warn: RowError[] = b.warnings.map((w) => ({ line: 0, message: w }))
    return [
      { rows: { target: 'groups', rows: b.groups }, sheet: 'Account groups' },
      { rows: { target: 'units', rows: b.units }, sheet: 'Units' },
      { rows: { target: 'godowns', rows: b.godowns }, sheet: 'Material centres' },
      { rows: { target: 'ledgers', rows: b.ledgers }, sheet: 'Accounts' },
      { rows: { target: 'items', rows: b.items }, sheet: 'Items' },
      { rows: { target: 'vouchers', rows: b.vouchers }, errors: warn, sheet: 'Vouchers' }
    ]
  }
  throw new Error('This file is a single table — map its columns instead')
}

/** Test/driver convenience: the auto-detected header row, best profile and its auto mapping. */
export function autoPlan(db: DB, f: LoadedFile, companyStateCode: string, opts: { sheet?: string; profileId?: string; dateOrder?: DateOrder } = {}): { steps: PlanStep[]; profile: ImportProfile } {
  const sheet = opts.sheet ? f.sheets.find((s) => s.name === opts.sheet)! : f.sheets[0]!
  const summary = sheetSummary(db, sheet)
  const profileId = opts.profileId ?? summary.guesses[0]!.profileId
  const profile = profileById(profileId)!
  const table = tableFrom(sheet.grid, summary.headerRow)
  return tableSteps(f, { sheet: sheet.name, headerRow: summary.headerRow, profileId, mapping: autoMap(table.headers, profile.fields), dateOrder: opts.dateOrder ?? 'dmy' }, companyStateCode)
}
