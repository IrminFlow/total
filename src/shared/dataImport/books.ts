/**
 * The Books workbook (WP 6.3): the whole company as one .xlsx — a sheet per entity plus a
 * Manifest — written by services/booksExport.ts and read back by the import wizard as a
 * multi-step plan. Importable sheets use the canonical target field labels (targets.ts) as
 * headers, so the generic profiles map them without help; "(info)" sheets (GST, Stock) are
 * computed figures for people, never imported.
 */
import type { XlsxKind } from '../xlsx/writer'
import { autoMap, applyMapping, tableFrom, type Grid } from './detect'
import { parseTarget, TARGETS, type RowError, type TargetId, type TargetRows } from './targets'
import type { DateOrder } from './values'

export const BOOKS_FORMAT = 'total-books'
/** Bump when a sheet's columns change meaning; the importer refuses newer versions. */
export const BOOKS_SCHEMA_VERSION = 1
export const MANIFEST_SHEET = 'Manifest'

export interface BooksSheetDef {
  sheet: string
  target: TargetId
  columns: { field: string; kind: XlsxKind; decimals?: number }[]
}

const c = (field: string, kind: XlsxKind = 'text', decimals?: number): BooksSheetDef['columns'][number] => ({ field, kind, ...(decimals !== undefined ? { decimals } : {}) })

/** Importable sheets, in dependency order (the import runs them top to bottom). */
export const BOOKS_SHEETS: BooksSheetDef[] = [
  { sheet: 'Groups', target: 'groups', columns: [c('name'), c('parent')] },
  { sheet: 'Units', target: 'units', columns: [c('name'), c('symbol'), c('decimals', 'integer'), c('uqc')] },
  { sheet: 'Stock Groups', target: 'stockGroups', columns: [c('name'), c('parent')] },
  { sheet: 'Godowns', target: 'godowns', columns: [c('name'), c('address')] },
  {
    sheet: 'Ledgers', target: 'ledgers',
    columns: [c('name'), c('group'), c('opening', 'money'), c('gstin'), c('state'), c('pan'), c('creditDays', 'integer'), c('creditLimit', 'money'), c('address'), c('taxType'), c('gstRate', 'percent'), c('hsn')]
  },
  {
    sheet: 'Stock Items', target: 'items',
    columns: [c('name'), c('group'), c('unit'), c('hsn'), c('gstRate', 'percent'), c('cessRate', 'percent'), c('openingQty', 'qty', 3), c('openingValue', 'money'), c('mrp', 'money'), c('barcode'), c('reorderLevel', 'qty', 3)]
  },
  { sheet: 'Batches', target: 'batches', columns: [c('item'), c('name'), c('mfgDate', 'date'), c('expiryDate', 'date')] },
  { sheet: 'Price Lists', target: 'priceLists', columns: [c('level'), c('item'), c('rate', 'money'), c('from', 'date'), c('minQty', 'qty', 3)] },
  { sheet: 'Voucher Types', target: 'voucherTypes', columns: [c('name'), c('kind'), c('prefix')] },
  {
    sheet: 'Vouchers', target: 'vouchers',
    columns: [
      c('key'), c('type'), c('date', 'date'), c('number'), c('party'), c('narration'), c('reference'), c('ledger'), c('drCr'), c('amount', 'money'),
      c('item'), c('godown'), c('batch'), c('qty', 'qty', 3), c('rate', 'money'), c('itemAmount', 'money'), c('direction'),
      c('billRef'), c('billKind'), c('billAmount', 'money'), c('dueDate', 'date'),
      c('tdsSection'), c('tdsBase', 'money'), c('tdsAmount', 'money'), c('tcsSection'), c('tcsBase', 'money'), c('tcsAmount', 'money'),
      c('placeOfSupply'), c('currency'), c('exchangeRate', 'number'), c('optional'), c('postDated')
    ]
  },
  {
    sheet: 'Orders', target: 'tradeDocs',
    columns: [c('key'), c('kind'), c('series'), c('date', 'date'), c('number'), c('party'), c('dueDate', 'date'), c('validUntil', 'date'), c('reference'), c('narration'), c('item'), c('godown'), c('qty', 'qty', 3), c('rate', 'money'), c('discount', 'money'), c('amount', 'money'), c('lineDueDate', 'date')]
  }
]

/** The header a books column carries — the target field's label. */
export function booksHeader(def: BooksSheetDef, field: string): string {
  const f = TARGETS[def.target].fields.find((x) => x.key === field)
  if (!f) throw new Error(`Books sheet ${def.sheet}: unknown field ${field}`)
  return f.label
}

export interface BooksManifest {
  format: string
  schemaVersion: number
  company: string
  [key: string]: string | number
}

/** Reads the Manifest sheet's Key | Value rows. Null when the workbook is not a Total export. */
export function readManifest(grid: Grid | undefined): BooksManifest | null {
  if (!grid) return null
  const kv: Record<string, string> = {}
  for (const r of grid.rows) {
    const k = (r.cells[0] ?? '').trim()
    if (k) kv[k] = (r.cells[1] ?? '').trim()
  }
  if (kv.format !== BOOKS_FORMAT) return null
  return { ...kv, format: kv.format, schemaVersion: Number(kv.schemaVersion) || 0, company: kv.company ?? '' }
}

export interface BooksStep {
  sheet: string
  target: TargetId
  rows: TargetRows
  errors: RowError[]
}

/** A books workbook → one parsed step per importable sheet present (in import order). */
export function booksPlan(sheets: Map<string, Grid>, opts: { dateOrder?: DateOrder } = {}): { manifest: BooksManifest; steps: BooksStep[] } {
  const manifest = readManifest(sheets.get(MANIFEST_SHEET))
  if (!manifest) throw new Error('Not a Total books workbook (no Manifest sheet)')
  if (manifest.schemaVersion > BOOKS_SCHEMA_VERSION) {
    throw new Error(`This workbook was written by a newer Total (books format ${manifest.schemaVersion}); update Total to import it`)
  }
  const steps: BooksStep[] = []
  for (const def of BOOKS_SHEETS) {
    const grid = sheets.get(def.sheet)
    if (!grid || grid.rows.length === 0) continue
    const table = tableFrom(grid, 0)
    const mapping = autoMap(table.headers, TARGETS[def.target].fields)
    const { result, errors } = parseTarget(def.target, applyMapping(table, mapping), { dateOrder: opts.dateOrder ?? 'ymd' })
    steps.push({ sheet: def.sheet, target: def.target, rows: result, errors })
  }
  return { manifest, steps }
}
