/**
 * Column auto-detect for the import wizard (WP 6.3): which row is the header, which column feeds
 * which field, and which profile (target × source) the file most likely is. Pure.
 */
import type { FieldDef, MappedRecord } from './targets'

export interface RawTable {
  /** Header cells (already chosen header row). */
  headers: string[]
  /** Data rows under the header: source line + cell texts. */
  rows: { line: number; cells: string[] }[]
}

export interface Grid {
  rows: { line: number; cells: string[] }[]
}

/** Field key → column index, or null for "not mapped". */
export type ColumnMapping = Record<string, number | null>

/** "Op. Bal. (Dr/Cr)" → "opbaldrcr"; "GST Identification Number (GSTIN)" → "gstidentificationnumbergstin". */
export function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9%]/g, '')
}

function aliasSet(field: FieldDef): Set<string> {
  return new Set([field.label, field.key, ...(field.aliases ?? [])].map(normalizeHeader))
}

/** Auto-map headers to fields: exact alias match first; each column feeds at most one field. */
export function autoMap(headers: string[], fields: FieldDef[]): ColumnMapping {
  const norm = headers.map(normalizeHeader)
  const used = new Set<number>()
  const mapping: ColumnMapping = {}
  // Exact matches (label first, then aliases) in field order — required fields first.
  const ordered = [...fields].sort((a, b) => Number(!!b.required) - Number(!!a.required))
  for (const f of ordered) {
    const names = [normalizeHeader(f.label), ...[...aliasSet(f)]]
    let idx = -1
    for (const n of names) {
      idx = norm.findIndex((h, i) => !used.has(i) && h === n)
      if (idx >= 0) break
    }
    mapping[f.key] = idx >= 0 ? idx : null
    if (idx >= 0) used.add(idx)
  }
  return mapping
}

/** How well a header row fits a field list: matched fields (required count double). */
export function scoreHeaders(headers: string[], fields: FieldDef[]): { score: number; requiredMissing: string[] } {
  const m = autoMap(headers, fields)
  let score = 0
  const requiredMissing: string[] = []
  for (const f of fields) {
    if (m[f.key] !== null && m[f.key] !== undefined) score += f.required ? 2 : 1
    else if (f.required) requiredMissing.push(f.label)
  }
  return { score, requiredMissing }
}

/** Pick the header row among the first rows: the one matching the most known header names
 *  (Busy/Tally exports put the company name and period above the table). Falls back to the first
 *  non-empty row. Returns the index into grid.rows. */
export function detectHeaderRow(grid: Grid, fieldLists: FieldDef[][], lookahead = 15): number {
  let best = -1
  let bestScore = 0
  const n = Math.min(grid.rows.length, lookahead)
  for (let i = 0; i < n; i++) {
    const cells = grid.rows[i]!.cells
    if (cells.filter((c) => c.trim()).length < 2) continue
    const score = Math.max(0, ...fieldLists.map((fl) => scoreHeaders(cells, fl).score))
    if (score > bestScore) {
      bestScore = score
      best = i
    }
  }
  if (best >= 0) return best
  const firstNonEmpty = grid.rows.findIndex((r) => r.cells.some((c) => c.trim()))
  return Math.max(0, firstNonEmpty)
}

/** The table under header row `headerIndex`. */
export function tableFrom(grid: Grid, headerIndex: number): RawTable {
  const header = grid.rows[headerIndex]?.cells ?? []
  // Header cells may be blank in the middle; keep positions, name blanks "Column X".
  const headers = header.map((h, i) => h.trim() || `Column ${i + 1}`)
  const rows = grid.rows.slice(headerIndex + 1)
  const width = Math.max(headers.length, ...rows.slice(0, 200).map((r) => r.cells.length))
  while (headers.length < width) headers.push(`Column ${headers.length + 1}`)
  return { headers, rows }
}

/** Apply a mapping: each row's cell texts by field key. */
export function applyMapping(table: RawTable, mapping: ColumnMapping, constants: Record<string, string> = {}): MappedRecord[] {
  const entries = Object.entries(mapping).filter((e): e is [string, number] => e[1] !== null && e[1] !== undefined)
  return table.rows.map((r) => {
    const values: Record<string, string> = { ...constants }
    for (const [key, col] of entries) values[key] = (r.cells[col] ?? '').trim()
    return { line: r.line, values }
  })
}

/** Mapping stored by header NAME (templates survive column re-ordering); resolved per file. */
export function mappingByName(table: RawTable, mapping: ColumnMapping): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const [k, v] of Object.entries(mapping)) out[k] = v === null || v === undefined ? null : (table.headers[v] ?? null)
  return out
}

export function mappingFromNames(headers: string[], byName: Record<string, string | null>): ColumnMapping {
  const norm = headers.map(normalizeHeader)
  const out: ColumnMapping = {}
  for (const [k, name] of Object.entries(byName)) {
    if (!name) {
      out[k] = null
      continue
    }
    const i = norm.indexOf(normalizeHeader(name))
    out[k] = i >= 0 ? i : null
  }
  return out
}

/** A stable signature of a header row, for remembering templates ("this file layout again"). */
export function headerSignature(headers: string[]): string {
  return headers.map(normalizeHeader).filter(Boolean).sort().join('|')
}
