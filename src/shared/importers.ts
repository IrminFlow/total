/**
 * Pure CSV master-import parsers. Header-sniffs common Tally/Excel column names, tolerates
 * quoted commas and multi-line quoted fields via the full-text `parseCsv`, and never throws on
 * a bad row — bad rows are collected as `errors` (1-indexed source line number + message) while
 * good rows survive in `rows`.
 *
 * No Electron, no DB: the main-process service (`src/main/services/importers.ts`) resolves
 * group/unit names to ids and does the actual upsert.
 */
import { parseCsv, type CsvRecord } from './csv'
import { parseRupees } from './money'
import { GST_STATES } from './gst/states'
import { validateGstin } from './gst/validate'

export interface CsvError {
  line: number
  message: string
}

export interface CsvParseResult<T> {
  rows: T[]
  errors: CsvError[]
}

export interface LedgerCsvRow {
  line: number
  name: string
  group: string
  /** Signed paise: positive = Dr, negative = Cr — matches Ledger.openingBalance. */
  openingBalance: number
  gstin: string | null
  stateCode: string | null
  pan: string | null
  creditDays: number | null
}

export interface ItemCsvRow {
  line: number
  name: string
  group: string | null
  unit: string
  hsn: string | null
  gstRate: number | null
  openingQtyMilli: number
  openingValue: number
}

export interface OpeningCsvRow {
  line: number
  ledgerName: string
  /** Signed paise: positive = Dr, negative = Cr. */
  opening: number
}

// ---------- header sniffing ----------

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** First record's column-name -> index map, matched against normalized aliases. */
function buildHeaderIndex(headerCells: string[], aliases: Record<string, string[]>): Record<string, number> {
  const headers = headerCells.map(normalizeHeader)
  const index: Record<string, number> = {}
  for (const [field, names] of Object.entries(aliases)) {
    const normNames = names.map(normalizeHeader)
    const i = headers.findIndex((h) => normNames.includes(h))
    if (i >= 0) index[field] = i
  }
  return index
}

function cellAt(cells: string[], i: number | undefined): string {
  return i === undefined ? '' : (cells[i] ?? '').trim()
}

/** Records with the source line each starts on — full-text parse (v0.3 #67), so quoted fields
 *  may span physical lines; blank lines yield no record. */
function csvRecords(csvText: string): CsvRecord[] {
  return parseCsv(csvText)
}

// ---------- shared value parsers ----------

/** "1,234.50 Cr" -> -123450; "500 Dr" -> 50000; "500" -> 50000; "" -> 0; invalid -> null. */
function parseSignedRupees(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return 0
  const m = trimmed.match(/^([-\d,.\s₹]+?)\s*(cr|dr)?$/i)
  if (!m) return null
  const numPart = m[1]!.trim()
  const suffix = m[2]?.toLowerCase()
  const parsed = parseRupees(numPart)
  if (parsed === null) return null
  if (suffix === 'cr') return -Math.abs(parsed)
  if (suffix === 'dr') return Math.abs(parsed)
  return parsed
}

/** Unsigned rupees -> paise; "" -> 0; negative or invalid -> null. */
function parsePlainRupees(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return 0
  const parsed = parseRupees(trimmed)
  if (parsed === null || parsed < 0) return null
  return parsed
}

/** Decimal quantity -> integer thousandths; "" -> 0; negative or invalid -> null. */
function parseQtyMilli(raw: string): number | null {
  const trimmed = raw.trim().replace(/,/g, '')
  if (trimmed === '') return 0
  if (!/^\d*\.?\d+$/.test(trimmed)) return null
  const n = Number(trimmed)
  if (!Number.isFinite(n)) return null
  return Math.round(n * 1000)
}

/** "18%" / "18" -> 18; "" -> null; out-of-range or invalid -> undefined (signals error). */
function parsePercent(raw: string, max: number): number | null | undefined {
  const trimmed = raw.trim().replace(/%$/, '').trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  if (!Number.isFinite(n) || n < 0 || n > max) return undefined
  return n
}

function resolveStateCode(raw: string): string | null {
  const trimmed = raw.trim()
  const codeMatch = trimmed.match(/^\d{2}$/)
  if (codeMatch && trimmed in GST_STATES) return trimmed
  const byName = Object.entries(GST_STATES).find(([, name]) => name.toLowerCase() === trimmed.toLowerCase())
  return byName ? byName[0]! : null
}

// ---------- ledgers ----------

const LEDGER_ALIASES: Record<string, string[]> = {
  name: ['name', 'ledger name', 'ledger', 'account name', 'account'],
  group: ['group', 'under', 'group name', 'parent'],
  opening: ['opening', 'opening balance', 'opening bal'],
  gstin: ['gstin', 'gst no', 'gst number'],
  state: ['state', 'state code'],
  pan: ['pan', 'pan no', 'pan number'],
  creditDays: ['credit days', 'credit period', 'credit period days']
}

export function parseLedgersCsv(csvText: string): CsvParseResult<LedgerCsvRow> {
  const records = csvRecords(csvText)
  const rows: LedgerCsvRow[] = []
  const errors: CsvError[] = []
  if (records.length === 0) return { rows, errors: [{ line: 1, message: 'Empty file' }] }

  const [headerLineNo, headerCells] = [records[0]!.line, records[0]!.cells]
  const idx = buildHeaderIndex(headerCells, LEDGER_ALIASES)
  if (idx.name === undefined) return { rows, errors: [{ line: headerLineNo, message: 'Missing required column: Name' }] }
  if (idx.group === undefined) return { rows, errors: [{ line: headerLineNo, message: 'Missing required column: Group (or Under)' }] }

  for (const { line: lineNo, cells } of records.slice(1)) {
    const name = cellAt(cells, idx.name)
    if (!name) {
      errors.push({ line: lineNo, message: 'Missing name' })
      continue
    }
    const group = cellAt(cells, idx.group)
    if (!group) {
      errors.push({ line: lineNo, message: 'Missing group' })
      continue
    }
    const openingRaw = cellAt(cells, idx.opening)
    const openingBalance = parseSignedRupees(openingRaw)
    if (openingBalance === null) {
      errors.push({ line: lineNo, message: `Invalid opening balance "${openingRaw}"` })
      continue
    }
    const gstinRaw = cellAt(cells, idx.gstin)
    let gstin: string | null = null
    if (gstinRaw) {
      const check = validateGstin(gstinRaw)
      if (!check.valid) {
        errors.push({ line: lineNo, message: `Invalid GSTIN "${gstinRaw}"` })
        continue
      }
      gstin = gstinRaw.trim().toUpperCase()
    }
    const stateRaw = cellAt(cells, idx.state)
    let stateCode: string | null = null
    if (stateRaw) {
      const resolved = resolveStateCode(stateRaw)
      if (!resolved) {
        errors.push({ line: lineNo, message: `Unknown state "${stateRaw}"` })
        continue
      }
      stateCode = resolved
    }
    const panRaw = cellAt(cells, idx.pan)
    const pan = panRaw ? panRaw.toUpperCase() : null
    const creditDaysRaw = cellAt(cells, idx.creditDays)
    let creditDays: number | null = null
    if (creditDaysRaw) {
      const n = Number(creditDaysRaw)
      if (!Number.isFinite(n) || n < 0) {
        errors.push({ line: lineNo, message: `Invalid credit days "${creditDaysRaw}"` })
        continue
      }
      creditDays = Math.round(n)
    }
    rows.push({ line: lineNo, name, group, openingBalance, gstin, stateCode, pan, creditDays })
  }
  return { rows, errors }
}

// ---------- stock items ----------

const ITEM_ALIASES: Record<string, string[]> = {
  name: ['name', 'item name', 'stock item', 'item'],
  group: ['group', 'stock group'],
  unit: ['unit', 'uom', 'units'],
  hsn: ['hsn', 'hsn code', 'hsn/sac'],
  gstRate: ['gst rate', 'gst%', 'gst rate %', 'tax rate'],
  openingQty: ['opening qty', 'qty', 'opening quantity', 'quantity'],
  openingValue: ['opening value', 'value'],
  openingRate: ['opening rate', 'rate per unit', 'unit rate']
}

export function parseItemsCsv(csvText: string): CsvParseResult<ItemCsvRow> {
  const records = csvRecords(csvText)
  const rows: ItemCsvRow[] = []
  const errors: CsvError[] = []
  if (records.length === 0) return { rows, errors: [{ line: 1, message: 'Empty file' }] }

  const [headerLineNo, headerCells] = [records[0]!.line, records[0]!.cells]
  const idx = buildHeaderIndex(headerCells, ITEM_ALIASES)
  if (idx.name === undefined) return { rows, errors: [{ line: headerLineNo, message: 'Missing required column: Name' }] }
  if (idx.unit === undefined) return { rows, errors: [{ line: headerLineNo, message: 'Missing required column: Unit' }] }

  for (const { line: lineNo, cells } of records.slice(1)) {
    const name = cellAt(cells, idx.name)
    if (!name) {
      errors.push({ line: lineNo, message: 'Missing name' })
      continue
    }
    const unit = cellAt(cells, idx.unit)
    if (!unit) {
      errors.push({ line: lineNo, message: 'Missing unit' })
      continue
    }
    const groupRaw = cellAt(cells, idx.group)
    const group = groupRaw || null
    const hsnRaw = cellAt(cells, idx.hsn)
    const hsn = hsnRaw || null
    const gstRateRaw = cellAt(cells, idx.gstRate)
    const gstRate = parsePercent(gstRateRaw, 100)
    if (gstRate === undefined) {
      errors.push({ line: lineNo, message: `Invalid GST rate "${gstRateRaw}"` })
      continue
    }
    const qtyRaw = cellAt(cells, idx.openingQty)
    const openingQtyMilli = parseQtyMilli(qtyRaw)
    if (openingQtyMilli === null) {
      errors.push({ line: lineNo, message: `Invalid opening quantity "${qtyRaw}"` })
      continue
    }
    const valueRaw = cellAt(cells, idx.openingValue)
    let openingValue: number
    if (valueRaw) {
      const parsed = parsePlainRupees(valueRaw)
      if (parsed === null) {
        errors.push({ line: lineNo, message: `Invalid opening value "${valueRaw}"` })
        continue
      }
      openingValue = parsed
    } else {
      const rateRaw = cellAt(cells, idx.openingRate)
      if (rateRaw) {
        const ratePaise = parsePlainRupees(rateRaw)
        if (ratePaise === null) {
          errors.push({ line: lineNo, message: `Invalid opening rate "${rateRaw}"` })
          continue
        }
        openingValue = Math.round((openingQtyMilli * ratePaise) / 1000)
      } else {
        openingValue = 0
      }
    }
    rows.push({ line: lineNo, name, group, unit, hsn, gstRate, openingQtyMilli, openingValue })
  }
  return { rows, errors }
}

// ---------- opening balances ----------

const OPENING_ALIASES: Record<string, string[]> = {
  ledgerName: ['ledger', 'ledger name', 'name', 'account', 'account name'],
  opening: ['opening', 'opening balance', 'balance', 'amount']
}

export function parseOpeningBalancesCsv(csvText: string): CsvParseResult<OpeningCsvRow> {
  const records = csvRecords(csvText)
  const rows: OpeningCsvRow[] = []
  const errors: CsvError[] = []
  if (records.length === 0) return { rows, errors: [{ line: 1, message: 'Empty file' }] }

  const [headerLineNo, headerCells] = [records[0]!.line, records[0]!.cells]
  const idx = buildHeaderIndex(headerCells, OPENING_ALIASES)
  if (idx.ledgerName === undefined) return { rows, errors: [{ line: headerLineNo, message: 'Missing required column: Ledger' }] }
  if (idx.opening === undefined) return { rows, errors: [{ line: headerLineNo, message: 'Missing required column: Opening' }] }

  for (const { line: lineNo, cells } of records.slice(1)) {
    const ledgerName = cellAt(cells, idx.ledgerName)
    if (!ledgerName) {
      errors.push({ line: lineNo, message: 'Missing ledger name' })
      continue
    }
    const openingRaw = cellAt(cells, idx.opening)
    const opening = parseSignedRupees(openingRaw)
    if (opening === null) {
      errors.push({ line: lineNo, message: `Invalid opening balance "${openingRaw}"` })
      continue
    }
    rows.push({ line: lineNo, ledgerName, opening })
  }
  return { rows, errors }
}

// ---------- CSV templates (header + one example row) ----------

export const LEDGER_CSV_TEMPLATE: string[][] = [
  ['Name', 'Group', 'Opening Balance', 'GSTIN', 'State', 'PAN', 'Credit Days'],
  ['Acme Traders', 'Sundry Debtors', '15,000.00 Dr', '27AAPFU0939F1ZV', 'Maharashtra', 'AAAAA0000A', '30']
]

export const ITEM_CSV_TEMPLATE: string[][] = [
  ['Name', 'Group', 'Unit', 'HSN', 'GST Rate', 'Opening Qty', 'Opening Value'],
  ['Widget A', 'Finished Goods', 'Nos', '8471', '18', '100', '25000.00']
]

export const OPENING_CSV_TEMPLATE: string[][] = [
  ['Ledger', 'Opening Balance'],
  ['Acme Traders', '15,000.00 Dr']
]
