/**
 * Report builder query model (WP 6.1) — pure, Zod-validated.
 *
 * A report is a SOURCE (accounts = voucher_lines + ledger openings; inventory = inventory_lines
 * that move stock), up to three DIMENSIONS to group by, one to eight MEASURES, FILTERS, a sort,
 * an optional top-N, an optional PIVOT (one of the dimensions spread as columns) and an optional
 * COMPARATIVE (previous period / previous year / a budget). The main process compiles a model to
 * one SQL statement (src/main/services/reportBuilder.ts) over the books' fact tables only, with
 * the standard filters, and computes it at query time — nothing is stored but the model itself
 * (saved_reports.model_json, migration 038).
 *
 * Money is integer paise, quantities integer thousandths, throughout.
 */
import { z } from 'zod'

// ---------------------------------------------------------------- vocabulary

export const REPORT_SOURCES = ['accounts', 'inventory'] as const
export type ReportSource = (typeof REPORT_SOURCES)[number]

export const DIMENSION_KEYS = [
  'ledger', 'group', 'party', 'item', 'itemGroup', 'godown', 'costCentre', 'voucherType', 'voucher',
  'month', 'quarter', 'fy', 'day', 'user'
] as const
export type DimensionKey = (typeof DIMENSION_KEYS)[number]

/** Dimensions that bucket dates. At most one per report. */
export const PERIOD_DIMENSIONS: readonly DimensionKey[] = ['month', 'quarter', 'fy', 'day']
export const isPeriodDimension = (k: DimensionKey): boolean => PERIOD_DIMENSIONS.includes(k)

/** What a click on a dimension cell opens (renderer drill-down). */
export type DimensionLink = 'ledger' | 'item' | 'voucher' | 'month' | null

export interface DimensionDef {
  key: DimensionKey
  label: string
  sources: readonly ReportSource[]
  link: DimensionLink
  hint: string
}

export const DIMENSIONS: Record<DimensionKey, DimensionDef> = {
  ledger: { key: 'ledger', label: 'Ledger', sources: ['accounts'], link: 'ledger', hint: 'The account each line is posted to' },
  group: { key: 'group', label: 'Group', sources: ['accounts'], link: null, hint: 'The ledger’s group at a chosen depth of the chart of accounts (level 1 = primary group)' },
  party: { key: 'party', label: 'Party', sources: ['accounts', 'inventory'], link: 'ledger', hint: 'The voucher’s party (customer / supplier)' },
  item: { key: 'item', label: 'Stock item', sources: ['inventory'], link: 'item', hint: 'The stock item on the line' },
  itemGroup: { key: 'itemGroup', label: 'Stock group', sources: ['inventory'], link: null, hint: 'The stock item’s group' },
  godown: { key: 'godown', label: 'Godown', sources: ['inventory'], link: null, hint: 'The godown the stock moved in or out of' },
  costCentre: { key: 'costCentre', label: 'Cost centre', sources: ['accounts'], link: null, hint: 'Cost-centre allocations of each line; the unallocated rest shows as “(unallocated)”' },
  voucherType: { key: 'voucherType', label: 'Voucher type', sources: ['accounts', 'inventory'], link: null, hint: 'Sales, Purchase, Payment, …' },
  voucher: { key: 'voucher', label: 'Voucher', sources: ['accounts', 'inventory'], link: 'voucher', hint: 'One row per voucher' },
  month: { key: 'month', label: 'Month', sources: ['accounts', 'inventory'], link: 'month', hint: 'Calendar month of the voucher date' },
  quarter: { key: 'quarter', label: 'Quarter', sources: ['accounts', 'inventory'], link: null, hint: 'Financial-year quarter (Q1 = Apr–Jun)' },
  fy: { key: 'fy', label: 'Financial year', sources: ['accounts', 'inventory'], link: null, hint: 'April–March financial year' },
  day: { key: 'day', label: 'Day', sources: ['accounts', 'inventory'], link: null, hint: 'Voucher date' },
  user: { key: 'user', label: 'Entered by', sources: ['accounts', 'inventory'], link: null, hint: 'Who created the voucher (from the audit trail)' }
}

export const MEASURE_KEYS = [
  'debit', 'credit', 'net', 'count', 'taxable', 'cgst', 'sgst', 'igst', 'cess', 'gst', 'tds', 'tcs', 'profit', 'balance',
  'qtyIn', 'qtyOut', 'qtyNet', 'value'
] as const
export type MeasureKey = (typeof MEASURE_KEYS)[number]

export type MeasureKind = 'money' | 'quantity' | 'number'

export interface MeasureDef {
  key: MeasureKey
  label: string
  sources: readonly ReportSource[]
  kind: MeasureKind
  /** Dr/Cr presentation (dr-positive signed money). */
  signed?: boolean
  hint: string
}

export const MEASURES: Record<MeasureKey, MeasureDef> = {
  debit: { key: 'debit', label: 'Debit', sources: ['accounts'], kind: 'money', hint: 'Debit side of the lines' },
  credit: { key: 'credit', label: 'Credit', sources: ['accounts'], kind: 'money', hint: 'Credit side of the lines' },
  net: { key: 'net', label: 'Net (Dr − Cr)', sources: ['accounts'], kind: 'money', signed: true, hint: 'Debit minus credit; a positive figure is a debit' },
  count: { key: 'count', label: 'Vouchers', sources: ['accounts', 'inventory'], kind: 'number', hint: 'Number of distinct vouchers' },
  taxable: { key: 'taxable', label: 'Taxable value', sources: ['accounts'], kind: 'money', hint: 'As the sales / purchase registers count it: sales-side lines of sales vouchers, purchase-side lines of purchase vouchers, credit / debit notes signed' },
  cgst: { key: 'cgst', label: 'CGST', sources: ['accounts'], kind: 'money', hint: 'Lines on CGST ledgers, register-signed' },
  sgst: { key: 'sgst', label: 'SGST', sources: ['accounts'], kind: 'money', hint: 'Lines on SGST ledgers, register-signed' },
  igst: { key: 'igst', label: 'IGST', sources: ['accounts'], kind: 'money', hint: 'Lines on IGST ledgers, register-signed' },
  cess: { key: 'cess', label: 'Cess', sources: ['accounts'], kind: 'money', hint: 'Lines on cess ledgers, register-signed' },
  gst: { key: 'gst', label: 'GST total', sources: ['accounts'], kind: 'money', hint: 'CGST + SGST + IGST + cess' },
  tds: { key: 'tds', label: 'TDS', sources: ['accounts'], kind: 'money', hint: 'Credits less debits on TDS-payable ledgers' },
  tcs: { key: 'tcs', label: 'TCS', sources: ['accounts'], kind: 'money', hint: 'Credits less debits on TCS-payable ledgers' },
  profit: { key: 'profit', label: 'Profit (P&L ledgers)', sources: ['accounts'], kind: 'money', hint: 'Income less expense on P&L ledgers, by the books’ single profit definition (year-end closing entries left out); before the stock adjustment' },
  balance: { key: 'balance', label: 'Closing balance', sources: ['accounts'], kind: 'money', signed: true, hint: 'Running balance at the end of the period (or of each date bucket), on the year-opening rule — income/expense ledgers restart each April' },
  qtyIn: { key: 'qtyIn', label: 'Qty in', sources: ['inventory'], kind: 'quantity', hint: 'Inward quantity (physical-count corrections excluded)' },
  qtyOut: { key: 'qtyOut', label: 'Qty out', sources: ['inventory'], kind: 'quantity', hint: 'Outward quantity (physical-count corrections excluded)' },
  qtyNet: { key: 'qtyNet', label: 'Qty net', sources: ['inventory'], kind: 'quantity', hint: 'In minus out' },
  value: { key: 'value', label: 'Line value', sources: ['inventory'], kind: 'money', hint: 'Value on the item lines as entered (sale value outward, cost inward) — not the valuation engine’s stock value' }
}

/** The GST measures, in register column order. */
export const GST_MEASURES: readonly MeasureKey[] = ['cgst', 'sgst', 'igst', 'cess']

// ---------------------------------------------------------------- schema

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
const idList = z.array(z.number().int().positive()).max(1000).default([])

export const RELATIVE_PERIODS = ['thisMonth', 'lastMonth', 'thisQuarter', 'lastQuarter', 'fyToDate', 'lastFy'] as const
export type RelativePeriod = (typeof RELATIVE_PERIODS)[number]

export const periodRuleSchema = z.discriminatedUnion('kind', [
  /** The header's working period at run time. */
  z.object({ kind: z.literal('working') }),
  z.object({ kind: z.literal('range'), from: isoDate, to: isoDate }),
  z.object({ kind: z.literal('relative'), rule: z.enum(RELATIVE_PERIODS) })
])
export type PeriodRule = z.infer<typeof periodRuleSchema>

export const reportFiltersSchema = z
  .object({
    ledgerIds: idList,
    /** Each group includes its whole subtree. */
    groupIds: idList,
    partyIds: idList,
    itemIds: idList,
    itemGroupIds: idList,
    godownIds: idList,
    costCentreIds: idList,
    voucherKinds: z.array(z.string().regex(/^[a-z_]{2,40}$/)).max(40).default([]),
    /** Line amount range, paise (inclusive). */
    amountMin: z.number().int().min(0).nullable().default(null),
    amountMax: z.number().int().min(0).nullable().default(null),
    narration: z.string().trim().max(200).default(''),
    /** GST rate (percent): accounts — the ledger's rate; inventory — the item's rate. */
    gstRate: z.number().min(0).max(100).nullable().default(null),
    /** Party state codes ('27', …). */
    stateCodes: z.array(z.string().regex(/^\d{2}$/)).max(40).default([]),
    /** Audit-trail user names (who created the voucher). */
    users: z.array(z.string().trim().min(1).max(80)).max(50).default([])
  })
  .default({})
export type ReportFilters = z.output<typeof reportFiltersSchema>

export const COMPARATIVE_KINDS = ['none', 'previousPeriod', 'previousYear', 'budget'] as const
export type ComparativeKind = (typeof COMPARATIVE_KINDS)[number]

export const dimensionSpecSchema = z.object({
  key: z.enum(DIMENSION_KEYS),
  /** Group dimension only: depth in the chart of accounts (1 = primary group). */
  level: z.number().int().min(1).max(8).optional()
})
export type DimensionSpec = z.infer<typeof dimensionSpecSchema>

/** Filters that select vouchers (not ledgers). Opening balances belong to no voucher, so they can
 *  only take part when none of these is set. */
export function voucherLevelFilters(f: ReportFilters): string[] {
  const out: string[] = []
  if (f.partyIds.length) out.push('party')
  if (f.voucherKinds.length) out.push('voucher type')
  if (f.amountMin != null || f.amountMax != null) out.push('amount range')
  if (f.narration) out.push('narration')
  if (f.costCentreIds.length) out.push('cost centre')
  if (f.stateCodes.length) out.push('state')
  if (f.users.length) out.push('entered by')
  return out
}

/** Dimensions a closing-balance report can use (balances are per ledger, per date). */
const BALANCE_DIMENSIONS: readonly DimensionKey[] = ['ledger', 'group', 'month', 'quarter', 'fy', 'day']
/** Dimensions a budget comparison can use (budget lines are per ledger / group, per month). */
export const BUDGET_DIMENSIONS: readonly DimensionKey[] = ['ledger', 'group', 'month', 'quarter', 'fy']

const reportModelBase = z.object({
  version: z.literal(1).default(1),
  source: z.enum(REPORT_SOURCES),
  dimensions: z.array(dimensionSpecSchema).max(3).default([]),
  measures: z.array(z.enum(MEASURE_KEYS)).min(1, 'Pick at least one measure').max(8),
  period: periodRuleSchema.default({ kind: 'working' }),
  filters: reportFiltersSchema,
  sort: z
    .object({ by: z.union([z.literal('dimension'), z.enum(MEASURE_KEYS)]), dir: z.enum(['asc', 'desc']) })
    .default({ by: 'dimension', dir: 'asc' }),
  topN: z.number().int().min(1).max(1000).nullable().default(null),
  pivot: z.enum(DIMENSION_KEYS).nullable().default(null),
  comparative: z
    .object({ kind: z.enum(COMPARATIVE_KINDS), budgetId: z.number().int().positive().nullable().default(null) })
    .default({ kind: 'none', budgetId: null }),
  chart: z.enum(['none', 'bar', 'line']).default('bar')
})

/** Every rule a model must satisfy; returns human-readable problems (empty = valid). */
export function modelProblems(m: z.output<typeof reportModelBase>): string[] {
  const problems: string[] = []
  const dimKeys = m.dimensions.map((d) => d.key)
  for (const d of m.dimensions) {
    if (!DIMENSIONS[d.key].sources.includes(m.source)) problems.push(`${DIMENSIONS[d.key].label} is not available for ${sourceLabel(m.source)}`)
    if (d.level !== undefined && d.key !== 'group') problems.push(`Only the group dimension has a level`)
  }
  if (new Set(dimKeys).size !== dimKeys.length) problems.push('A dimension can be used only once')
  if (dimKeys.filter(isPeriodDimension).length > 1) problems.push('Use one date dimension at a time (month, quarter, year or day)')
  if (new Set(m.measures).size !== m.measures.length) problems.push('A measure can be used only once')
  for (const k of m.measures) {
    if (!MEASURES[k].sources.includes(m.source)) problems.push(`${MEASURES[k].label} is not available for ${sourceLabel(m.source)}`)
  }
  if (m.period.kind === 'range' && m.period.from > m.period.to) problems.push('The period starts after it ends')
  if (m.filters.amountMin != null && m.filters.amountMax != null && m.filters.amountMin > m.filters.amountMax) {
    problems.push('The amount range is empty (minimum above maximum)')
  }
  if (m.sort.by !== 'dimension' && !m.measures.includes(m.sort.by)) problems.push('Sort by a measure the report shows')
  if (m.pivot !== null) {
    if (!dimKeys.includes(m.pivot)) problems.push('The pivot must be one of the report’s dimensions')
    if (m.comparative.kind !== 'none') problems.push('Turn the pivot off to compare periods or a budget')
  }
  if (m.measures.includes('balance')) {
    const bad = dimKeys.filter((k) => !BALANCE_DIMENSIONS.includes(k))
    if (bad.length) problems.push(`Closing balance works with ledger, group and date dimensions only (not ${bad.map((k) => DIMENSIONS[k].label.toLowerCase()).join(', ')})`)
    const vf = voucherLevelFilters(m.filters)
    if (vf.length) problems.push(`Closing balance can’t be combined with voucher filters (${vf.join(', ')}) — balances include opening balances, which belong to no voucher`)
  }
  if (m.comparative.kind === 'budget') {
    if (m.source !== 'accounts') problems.push('Budgets compare against accounts only')
    if (m.comparative.budgetId === null) problems.push('Choose the budget to compare against')
    if (m.measures[0] !== 'net' && m.measures[0] !== 'profit') problems.push('A budget compares against the first measure, which must be Net or Profit')
    const bad = dimKeys.filter((k) => !BUDGET_DIMENSIONS.includes(k))
    if (bad.length) problems.push(`A budget is set per ledger / group and month — it can’t be split by ${bad.map((k) => DIMENSIONS[k].label.toLowerCase()).join(', ')}`)
  }
  return problems
}

export const reportModelSchema = reportModelBase.superRefine((m, ctx) => {
  for (const message of modelProblems(m)) ctx.addIssue({ code: z.ZodIssueCode.custom, message })
})

export type ReportModel = z.output<typeof reportModelSchema>
export type ReportModelInput = z.input<typeof reportModelSchema>

export const sourceLabel = (s: ReportSource): string => (s === 'accounts' ? 'accounts' : 'stock')

/** A sensible starting model for a source (the builder's "New report"). */
export function defaultModel(source: ReportSource = 'accounts'): ReportModel {
  return reportModelSchema.parse(
    source === 'accounts'
      ? { source, dimensions: [{ key: 'group', level: 1 }], measures: ['debit', 'credit', 'net'] }
      : { source, dimensions: [{ key: 'item' }], measures: ['qtyIn', 'qtyOut', 'qtyNet'] }
  )
}

/** Parses a shared JSON model (Share → Import), returning the problems instead of throwing. */
export function parseModelJson(text: string): { ok: true; model: ReportModel; name: string | null } | { ok: false; error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: 'Not valid JSON' }
  }
  // Accept either a bare model or the shared envelope { name, model }.
  const envelope = raw && typeof raw === 'object' && 'model' in (raw as Record<string, unknown>) ? (raw as { name?: unknown; model: unknown }) : null
  const r = reportModelSchema.safeParse(envelope ? envelope.model : raw)
  if (!r.success) return { ok: false, error: r.error.issues.map((i) => i.message).join('; ') }
  const name = envelope && typeof envelope.name === 'string' ? envelope.name : null
  return { ok: true, model: r.data, name }
}

/** The shared-JSON envelope (Share as JSON). */
export function modelJsonEnvelope(name: string, model: ReportModel): string {
  return JSON.stringify({ kind: 'total-report', version: 1, name, model }, null, 2)
}

// ---------------------------------------------------------------- results

/** One dimension cell: its id (ledger id, 'YYYY-MM', …; null = none) and display label. */
export interface DimValue {
  id: number | string | null
  label: string
}

export interface ResultRow {
  keys: DimValue[]
  values: number[]
  /** Comparative figure per measure (null = not compared). Present only with a comparative. */
  compare?: (number | null)[]
}

export interface ResultColumnDim {
  key: DimensionKey
  label: string
  link: DimensionLink
}

export interface ResultColumnMeasure {
  key: MeasureKey
  label: string
  kind: MeasureKind
  signed: boolean
}

export interface ReportResult {
  from: string
  to: string
  dims: ResultColumnDim[]
  measures: ResultColumnMeasure[]
  rows: ResultRow[]
  totals: number[]
  /** What the comparative columns hold, or null. */
  compare: { kind: Exclude<ComparativeKind, 'none'>; label: string; from: string; to: string } | null
  compareTotals: (number | null)[] | null
  /** Rows dropped by the row cap (the query stopped at `rowCap`). */
  truncated: boolean
  rowCap: number
  warnings: string[]
}

export function dimColumn(spec: DimensionSpec): ResultColumnDim {
  const def = DIMENSIONS[spec.key]
  return { key: spec.key, label: spec.key === 'group' && spec.level && spec.level > 1 ? `Group (level ${spec.level})` : def.label, link: def.link }
}

export function measureColumn(key: MeasureKey): ResultColumnMeasure {
  const def = MEASURES[key]
  return { key, label: def.label, kind: def.kind, signed: !!def.signed }
}
