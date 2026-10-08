/**
 * Shaping a computed report (pure): running balances across date buckets, comparative merge and
 * variance, sorting, top-N (with an "All others" row), totals, pivoting one dimension into
 * columns, and flattening any of it into header + string rows for CSV / PDF. Shared by the main
 * process (scheduled packs) and the builder screen, so a report reads the same on screen and in a
 * pack.
 *
 * A cell is `number | null`: null means "no figure" — a comparison with no counterpart, or a
 * voucher count that cannot be added across rows (a voucher touches several ledgers, so summing
 * per-ledger counts would count it more than once; those totals come from the database instead).
 */
import { formatPaise, formatQtyMilli, plainMilli, plainRupees } from '../money'
import { toDisplayDate } from '../dates'
import {
  isPeriodDimension, type Cell, type DimValue, type DimensionKey, type ReportModel, type ReportResult, type ResultColumnMeasure, type ResultRow
} from './model'
import { periodKeysBetween, periodLabel, shiftPeriodKey } from './period'

/** Stable identity of a row's dimension cells. */
export const rowKey = (keys: DimValue[]): string => keys.map((k) => (k.id === null ? `∅${k.label}` : String(k.id))).join('\u0001')

/** Dimensions with exactly one value per voucher: voucher counts add up across them. */
const VOUCHER_LEVEL: readonly string[] = ['party', 'voucherType', 'voucher', 'month', 'quarter', 'fy', 'day', 'user']

/** Whether per-row voucher counts can be summed across rows that differ in `dims`. */
export const countAdditive = (dims: readonly string[]): boolean => dims.every((d) => VOUCHER_LEVEL.includes(d))

const add = (a: Cell, b: Cell): Cell => (a === null || b === null ? null : a + b)

// ---------------------------------------------------------------- running balance

/**
 * Turns per-bucket balance MOVEMENTS (opening facts land in the first bucket, financial-year
 * resets in the bucket of 1 April) into the balance at the end of each bucket: rows are grouped by
 * their non-date dimensions, every bucket of [from, to] is filled in, and the balance measure is
 * accumulated in date order. Other measures stay per-bucket (0 in filled-in buckets).
 */
export function accumulateBalance(rows: ResultRow[], dimKeys: string[], measureKeys: string[], from: string, to: string): ResultRow[] {
  const bi = measureKeys.indexOf('balance')
  const pi = dimKeys.findIndex((k) => isPeriodDimension(k as DimensionKey))
  if (bi < 0 || pi < 0) return rows
  const dim = dimKeys[pi] as DimensionKey
  const buckets = periodKeysBetween(from, to, dim)
  const groups = new Map<string, { sample: DimValue[]; byBucket: Map<string, ResultRow> }>()
  for (const r of rows) {
    const other = r.keys.filter((_, i) => i !== pi)
    const gk = rowKey(other)
    const g = groups.get(gk) ?? { sample: r.keys, byBucket: new Map() }
    g.byBucket.set(String(r.keys[pi]!.id), r)
    groups.set(gk, g)
  }
  const out: ResultRow[] = []
  for (const g of groups.values()) {
    let running = 0
    for (const b of buckets) {
      const r = g.byBucket.get(b)
      running += r ? (r.values[bi] ?? 0) : 0
      const keys = g.sample.map((k, i) => (i === pi ? { id: b, label: periodLabel(b, dim) } : k))
      const values: Cell[] = r ? [...r.values] : measureKeys.map(() => 0)
      values[bi] = running
      out.push({ keys, values })
    }
  }
  return out
}

// ---------------------------------------------------------------- comparatives

/** Variance of a figure against its comparative: absolute (paise / units) and percent of the
 *  comparative's magnitude (one decimal; null when the comparative is zero or missing). */
export function variance(current: Cell, compare: Cell): { abs: number | null; pct: number | null } {
  if (compare === null || current === null) return { abs: null, pct: null }
  const abs = current - compare
  if (compare === 0) return { abs, pct: null }
  return { abs, pct: Math.round((abs * 1000) / Math.abs(compare)) / 10 }
}

/** How the comparative's date buckets map onto the current ones. `shift`: the same calendar
 *  bucket N months later (previous year, whole-month previous periods). `ordinal`: the k-th bucket
 *  of the comparative range ↔ the k-th of the current range (a previous period of the same length
 *  in days that does not start on a month boundary). */
export type BucketAlignment = { kind: 'shift'; months: number } | { kind: 'ordinal'; current: string[]; prior: string[] }

/**
 * Lines up a comparative run with the current one by dimension keys, re-keying the comparative's
 * date buckets first. A current row with no counterpart gets NO comparative (null — shown as "—"),
 * never a made-up zero; a row only in the comparative is kept (current figures 0), so a party that
 * dropped away still shows.
 */
export function mergeComparative(current: ResultRow[], prior: ResultRow[], dimKeys: string[], align: BucketAlignment | null): ResultRow[] {
  const pi = dimKeys.findIndex((k) => isPeriodDimension(k as DimensionKey))
  const ordinal = align?.kind === 'ordinal' ? new Map(align.prior.map((k, i) => [k, align.current[i] ?? null])) : null
  const rekey = (r: ResultRow): ResultRow | null => {
    if (pi < 0 || !align) return r
    const dim = dimKeys[pi] as DimensionKey
    const from = String(r.keys[pi]!.id)
    const id = align.kind === 'shift' ? shiftPeriodKey(from, dim, align.months) : (ordinal!.get(from) ?? null)
    if (id === null) return null
    return { ...r, keys: r.keys.map((k, i) => (i === pi ? { id, label: periodLabel(id, dim) } : k)) }
  }
  const byKey = new Map<string, ResultRow>()
  for (const p of prior) {
    const rk = rekey(p)
    if (rk) byKey.set(rowKey(rk.keys), rk)
  }
  const out: ResultRow[] = current.map((r) => {
    const k = rowKey(r.keys)
    const p = byKey.get(k)
    byKey.delete(k)
    return { ...r, compare: p ? [...p.values] : r.values.map(() => null) }
  })
  for (const p of byKey.values()) out.push({ keys: p.keys, values: p.values.map(() => 0), compare: [...p.values] })
  return out
}

// ---------------------------------------------------------------- sort / top-N / totals

function compareKeys(a: DimValue[], b: DimValue[]): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    // Nulls ('(no party)', '(opening)', …) after real values.
    if ((x.id === null) !== (y.id === null)) return x.id === null ? 1 : -1
    const c = typeof x.id === 'string' && typeof y.id === 'string' && /^\d{4}/.test(x.id) ? x.id.localeCompare(y.id) : x.label.localeCompare(y.label, undefined, { numeric: true, sensitivity: 'base' })
    if (c !== 0) return c
  }
  return 0
}

/** Sort by the dimensions (date buckets chronologically, names alphabetically) or by a measure.
 *  Ties fall back to the dimension order, so the result is deterministic. */
export function sortRows(rows: ResultRow[], model: Pick<ReportModel, 'sort' | 'measures'>): ResultRow[] {
  const mi = model.sort.by === 'dimension' ? -1 : model.measures.indexOf(model.sort.by)
  const dir = model.sort.dir === 'desc' ? -1 : 1
  return [...rows].sort((a, b) => {
    if (mi >= 0) {
      const d = ((a.values[mi] ?? 0) - (b.values[mi] ?? 0)) * dir
      if (d !== 0) return d
    }
    return compareKeys(a.keys, b.keys) * (mi >= 0 ? 1 : dir)
  })
}

/** The dimension top-N keeps whole: the pivot, else a date dimension next to other dimensions. */
export function topNSpreadIndex(dimKeys: string[], pivot: string | null): number {
  if (pivot) return dimKeys.indexOf(pivot)
  return dimKeys.length > 1 ? dimKeys.findIndex((k) => isPeriodDimension(k as DimensionKey)) : -1
}

/**
 * Orders rows and keeps the top N, adding up the rest into "All others" rows so totals still tie.
 * With a pivot (or a date dimension beside others) top-N ranks the ROW entities — the combinations
 * of the other dimensions — by their total over every column / bucket, keeps all columns of the
 * kept entities, and gives "All others" one row per column / bucket.
 */
export function applyTopN(rows: ResultRow[], model: Pick<ReportModel, 'sort' | 'measures' | 'topN' | 'pivot'>, dimKeys: string[]): ResultRow[] {
  const measureKeys = model.measures
  const g = topNSpreadIndex(dimKeys, model.pivot)
  const others = (dropped: ResultRow[], keysFor: (sample: DimValue[]) => DimValue[], varying: string[]): ResultRow => ({
    keys: keysFor(dropped[0]!.keys),
    values: measureKeys.map((k, mi) =>
      k === 'count' && !countAdditive(varying) ? null : dropped.reduce<Cell>((s, r) => add(s, r.values[mi] ?? null), 0)
    ),
    ...(dropped.some((r) => r.compare)
      ? { compare: measureKeys.map((k, mi) => (k === 'count' && !countAdditive(varying) ? null : dropped.reduce<Cell>((s, r) => (r.compare?.[mi] === null || r.compare?.[mi] === undefined ? s : add(s, r.compare[mi]!)), 0))) }
      : {})
  })
  if (g < 0) {
    const sorted = sortRows(rows, model)
    if (!model.topN || sorted.length <= model.topN) return sorted
    const dropped = sorted.slice(model.topN)
    return [...sorted.slice(0, model.topN), others(dropped, (s) => s.map((_, i) => ({ id: null, label: i === 0 ? `All others (${dropped.length})` : '' })), dimKeys)]
  }
  // Rank entities (the keys without the spread dimension).
  const mi = model.sort.by === 'dimension' ? -1 : measureKeys.indexOf(model.sort.by)
  const dir = model.sort.dir === 'desc' ? -1 : 1
  const entities = new Map<string, { keys: DimValue[]; rows: ResultRow[]; score: number; last: string }>()
  for (const r of rows) {
    const keys = r.keys.filter((_, i) => i !== g)
    const k = rowKey(keys)
    const e = entities.get(k) ?? { keys, rows: [], score: 0, last: '' }
    e.rows.push(r)
    if (mi >= 0) {
      const bucket = String(r.keys[g]!.id ?? '')
      // A closing balance ranks by its latest bucket; everything else by its total.
      if (measureKeys[mi] === 'balance' && isPeriodDimension(dimKeys[g] as DimensionKey)) {
        if (bucket >= e.last) { e.last = bucket; e.score = r.values[mi] ?? 0 }
      } else e.score += r.values[mi] ?? 0
    }
    entities.set(k, e)
  }
  const ranked = [...entities.values()].sort((a, b) => {
    if (mi >= 0 && a.score !== b.score) return (a.score - b.score) * dir
    return compareKeys(a.keys, b.keys) * (mi >= 0 ? 1 : dir)
  })
  const byBucket = (a: ResultRow, b: ResultRow): number => compareKeys([a.keys[g]!], [b.keys[g]!])
  const kept = model.topN ? ranked.slice(0, model.topN) : ranked
  const out = kept.flatMap((e) => [...e.rows].sort(byBucket))
  const dropped = model.topN ? ranked.slice(model.topN) : []
  if (dropped.length) {
    const perBucket = new Map<string, ResultRow[]>()
    for (const r of dropped.flatMap((e) => e.rows)) {
      const bk = rowKey([r.keys[g]!])
      perBucket.set(bk, [...(perBucket.get(bk) ?? []), r])
    }
    const varying = dimKeys.filter((_, i) => i !== g)
    const rest = [...perBucket.values()].map((rs) =>
      others(rs, (s) => s.map((k, i) => (i === g ? k : { id: null, label: i === (g === 0 ? 1 : 0) ? `All others (${dropped.length})` : '' })), varying)
    )
    out.push(...rest.sort(byBucket))
  }
  return out
}

/** Column totals. A closing balance with a date dimension totals only the last bucket (the
 *  balances at the end of the period); a voucher count only adds up across voucher-level
 *  dimensions (null otherwise — its total comes from the database); everything else sums. */
export function totalsOf(rows: ResultRow[], dimKeys: string[], measureKeys: string[], pick: (r: ResultRow) => Cell[] = (r) => r.values): Cell[] {
  const pi = dimKeys.findIndex((k) => isPeriodDimension(k as DimensionKey))
  const lastBucket = pi >= 0 ? rows.reduce<string | null>((m, r) => { const id = String(r.keys[pi]!.id); return m === null || id > m ? id : m }, null) : null
  return measureKeys.map((k, mi) => {
    if (k === 'count' && !countAdditive(dimKeys)) return null
    return rows.reduce((s, r) => {
      if (k === 'balance' && pi >= 0 && String(r.keys[pi]!.id) !== lastBucket) return s
      return s + (pick(r)[mi] ?? 0)
    }, 0)
  })
}

// ---------------------------------------------------------------- pivot

export interface PivotColumn {
  id: string
  label: string
}

export interface PivotRow {
  keys: DimValue[]
  /** cells[columnIndex][measureIndex]; null = no figure in that column. */
  cells: Cell[][]
  /** Per measure: the row total (a closing balance takes its last column; a count across a
   *  non-voucher-level pivot is null). */
  total: Cell[]
}

export interface PivotTable {
  /** Index of the pivoted dimension in the result's dims. */
  pivotIndex: number
  rowDims: ReportResult['dims']
  columns: PivotColumn[]
  measures: ResultColumnMeasure[]
  rows: PivotRow[]
  columnTotals: Cell[][]
  grandTotal: Cell[]
}

/** Spreads one dimension across columns. Columns come in the pivot dimension's own order (date
 *  buckets chronologically, others by label); rows keep the result's order. The grand total is the
 *  result's own totals when given (so it always equals the flat report's). */
export function pivotResult(result: Pick<ReportResult, 'dims' | 'measures' | 'rows'> & { totals?: Cell[] }, pivotKey: string): PivotTable {
  const pivotIndex = result.dims.findIndex((d) => d.key === pivotKey)
  if (pivotIndex < 0) throw new Error(`pivot dimension ${pivotKey} is not in the report`)
  const isDate = isPeriodDimension(pivotKey as DimensionKey)
  const rowDimKeys = result.dims.filter((_, i) => i !== pivotIndex).map((d) => d.key)
  const colMap = new Map<string, PivotColumn>()
  for (const r of result.rows) {
    const k = r.keys[pivotIndex]!
    const id = k.id === null ? `∅${k.label}` : String(k.id)
    if (!colMap.has(id)) colMap.set(id, { id, label: k.label })
  }
  const columns = [...colMap.values()].sort((a, b) =>
    isDate ? a.id.localeCompare(b.id) : (a.id.startsWith('∅') ? 1 : 0) - (b.id.startsWith('∅') ? 1 : 0) || a.label.localeCompare(b.label, undefined, { numeric: true })
  )
  const colIndex = new Map(columns.map((c, i) => [c.id, i]))
  const nm = result.measures.length
  const rowMap = new Map<string, PivotRow>()
  const order: string[] = []
  for (const r of result.rows) {
    const keys = r.keys.filter((_, i) => i !== pivotIndex)
    const rk = rowKey(keys)
    let pr = rowMap.get(rk)
    if (!pr) {
      pr = { keys, cells: columns.map(() => Array<Cell>(nm).fill(null)), total: Array<Cell>(nm).fill(0) }
      rowMap.set(rk, pr)
      order.push(rk)
    }
    const k = r.keys[pivotIndex]!
    const ci = colIndex.get(k.id === null ? `∅${k.label}` : String(k.id))!
    pr.cells[ci] = r.values.map((v, mi) => (pr!.cells[ci]![mi] === null ? v : add(pr!.cells[ci]![mi]!, v)))
  }
  const rows = order.map((k) => rowMap.get(k)!)
  for (const pr of rows) {
    pr.total = result.measures.map((m, mi) => {
      if (m.key === 'balance' && isDate) {
        for (let ci = columns.length - 1; ci >= 0; ci--) if (pr.cells[ci]![mi] !== null) return pr.cells[ci]![mi]!
        return 0
      }
      if (m.key === 'count' && !countAdditive([pivotKey])) return null
      return pr.cells.reduce<Cell>((s, c) => add(s, c[mi] ?? 0), 0)
    })
  }
  const columnTotals = columns.map((_, ci) =>
    result.measures.map((m, mi) => (m.key === 'count' && !countAdditive(rowDimKeys) ? null : rows.reduce<Cell>((s, r) => add(s, r.cells[ci]![mi] ?? 0), 0)))
  )
  const grandTotal = result.totals ?? result.measures.map((m, mi) => (m.key === 'count' ? null : rows.reduce<Cell>((s, r) => add(s, r.total[mi] ?? 0), 0)))
  return { pivotIndex, rowDims: result.dims.filter((_, i) => i !== pivotIndex), columns, measures: result.measures, rows, columnTotals, grandTotal }
}

// ---------------------------------------------------------------- flat export

export type MoneyFormat = 'display' | 'plain'

export function formatMeasure(value: Cell, m: Pick<ResultColumnMeasure, 'kind' | 'signed'>, fmt: MoneyFormat = 'display'): string {
  if (value === null) return fmt === 'plain' ? '' : '—'
  if (m.kind === 'money') {
    if (fmt === 'plain') return plainRupees(value)
    if (m.signed) return value === 0 ? '—' : `${formatPaise(Math.abs(value))} ${value > 0 ? 'Dr' : 'Cr'}`
    return formatPaise(value, { zeroDash: true })
  }
  if (m.kind === 'quantity') return fmt === 'plain' ? plainMilli(value) : formatQtyMilli(value)
  return String(value)
}

const formatPct = (pct: number | null): string => (pct === null ? '' : `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`)

function dimText(d: DimValue, key: string): string {
  if (key === 'day' && typeof d.id === 'string') return toDisplayDate(d.id)
  return d.label
}

export interface FlatTable {
  header: string[]
  /** Column alignment for the PDF template. */
  align: ('l' | 'r')[]
  rows: string[][]
  /** Index of rows that are totals (bold in a PDF). */
  totalRow: number | null
}

/** The report as header + string rows — pivoted when the model pivots, with comparative and
 *  variance columns when it compares. Feeds CSV / PDF in scheduled packs and the builder. */
export function flattenResult(result: ReportResult, pivot: string | null, fmt: MoneyFormat = 'display'): FlatTable {
  if (pivot) {
    const p = pivotResult(result, pivot)
    const header = [
      ...p.rowDims.map((d) => d.label),
      ...p.columns.flatMap((c) => p.measures.map((m) => (p.measures.length > 1 ? `${c.label} · ${m.label}` : c.label))),
      ...p.measures.map((m) => (p.measures.length > 1 ? `Total · ${m.label}` : 'Total'))
    ]
    const align: ('l' | 'r')[] = header.map((_, i) => (i < p.rowDims.length ? 'l' : 'r'))
    const rows = p.rows.map((r) => [
      ...r.keys.map((k, i) => dimText(k, p.rowDims[i]!.key)),
      ...r.cells.flatMap((c) => c.map((v, mi) => formatMeasure(v, p.measures[mi]!, fmt))),
      ...r.total.map((v, mi) => formatMeasure(v, p.measures[mi]!, fmt))
    ])
    const totals = [
      ...p.rowDims.map((_, i) => (i === 0 ? 'Total' : '')),
      ...p.columnTotals.flatMap((c) => c.map((v, mi) => formatMeasure(v, p.measures[mi]!, fmt))),
      ...p.grandTotal.map((v, mi) => formatMeasure(v, p.measures[mi]!, fmt))
    ]
    if (p.rowDims.length === 0) totals.unshift('Total')
    const withLabel = p.rowDims.length === 0
    return {
      header: withLabel ? ['', ...header] : header,
      align: withLabel ? ['l', ...align] : align,
      rows: [...rows.map((r) => (withLabel ? ['', ...r] : r)), totals],
      totalRow: rows.length
    }
  }
  const compareLabel = result.compare?.label ?? null
  const header: string[] = result.dims.map((d) => d.label)
  for (const m of result.measures) {
    header.push(m.label)
    if (compareLabel) header.push(`${m.label} · ${compareLabel}`, `${m.label} · change`, `${m.label} · change %`)
  }
  const lead = result.dims.length === 0 ? 1 : 0
  if (lead) header.unshift('')
  const align: ('l' | 'r')[] = header.map((_, i) => (i < result.dims.length + lead ? 'l' : 'r'))
  const cellsFor = (values: Cell[], compare: Cell[] | null | undefined): string[] =>
    result.measures.flatMap((m, mi) => {
      const v = values[mi] ?? null
      if (!compareLabel) return [formatMeasure(v, m, fmt)]
      const c = compare?.[mi] ?? null
      const va = variance(v, c)
      return [formatMeasure(v, m, fmt), formatMeasure(c, m, fmt), va.abs === null ? (fmt === 'plain' ? '' : '—') : formatMeasure(va.abs, { kind: m.kind, signed: false }, fmt), formatPct(va.pct)]
    })
  const rows = result.rows.map((r) => [...(lead ? [''] : []), ...r.keys.map((k, i) => dimText(k, result.dims[i]!.key)), ...cellsFor(r.values, r.compare)])
  const totals = [
    ...(lead ? ['Total'] : result.dims.map((_, i) => (i === 0 ? 'Total' : ''))),
    ...cellsFor(result.totals, result.compareTotals)
  ]
  return { header, align, rows: [...rows, totals], totalRow: rows.length }
}

/** Chart-ready series for the first measure: one point per value of the first date dimension
 *  (or of the first dimension when there is none), summed over the other dimensions. A voucher
 *  count that can't be summed over those dimensions has no chart (null). */
export function chartSeries(result: ReportResult): { categories: { key: string; label: string }[]; values: number[]; compare: (number | null)[] | null } | null {
  if (result.measures.length === 0 || result.dims.length === 0) return null
  const di = Math.max(0, result.dims.findIndex((d) => isPeriodDimension(d.key)))
  if (result.measures[0]!.key === 'count' && !countAdditive(result.dims.filter((_, i) => i !== di).map((d) => d.key))) return null
  const cats = new Map<string, { key: string; label: string; v: number; c: number | null }>()
  for (const r of result.rows) {
    const k = r.keys[di]!
    const id = k.id === null ? `∅${k.label}` : String(k.id)
    const cur = cats.get(id) ?? { key: id, label: k.label, v: 0, c: r.compare ? 0 : null }
    cur.v += r.values[0] ?? 0
    if (r.compare && cur.c !== null) cur.c += r.compare[0] ?? 0
    cats.set(id, cur)
  }
  let list = [...cats.values()]
  if (isPeriodDimension(result.dims[di]!.key)) list.sort((a, b) => a.key.localeCompare(b.key))
  if (list.length > 60) list = list.slice(0, 60)
  return { categories: list.map((c) => ({ key: c.key, label: c.label })), values: list.map((c) => c.v), compare: result.compare ? list.map((c) => c.c) : null }
}
