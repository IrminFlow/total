/**
 * Natural-language report building (WP 5.5) — pure.
 *
 * The assistant maps a question to a REPORT REQUEST: the report builder's own vocabulary
 * (source, dimensions, measures, period, filters, sort, top-N) with filters given by NAME
 * ("Sales Accounts", "Acme Traders"), because the model knows names, not ids. `requestToModel`
 * resolves the names through a lookup the caller supplies (main: the ledgers / groups / items
 * tables) and validates the result with the WP 6.1 model schema — so a request either becomes a
 * valid ReportModel or comes back with the problems, never a half-valid model. The numbers then
 * come from the compiled report (services/reportBuilder.ts runReport), never from the model.
 *
 * `parseReportQuestion` is the deterministic mapper behind the Assistants screen's "Report from a
 * question" (it works with AI off) and the offline mock assistant: simple phrases only.
 */
import { z } from 'zod'
import {
  DIMENSION_KEYS, DIMENSIONS, MEASURE_KEYS, MEASURES, RELATIVE_PERIODS, reportModelSchema,
  type DimensionKey, type MeasureKey, type ReportModel, type ReportModelInput
} from './model'

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
const names = z.array(z.string().trim().min(1).max(120)).max(20)

/** What the model produces (tool arguments of build_report). Flat, JSON-schema friendly. */
export const reportRequestSchema = z.object({
  title: z.string().trim().min(1).max(80).describe('A short name for the report, e.g. "Sales by month"'),
  source: z.enum(['accounts', 'inventory']).describe('accounts = ledgers and vouchers (money); inventory = stock item lines (quantities, line values)'),
  dimensions: z
    .array(z.object({ key: z.enum(DIMENSION_KEYS), level: z.number().int().min(1).max(8).optional().describe('group only: depth, 1 = primary group') }))
    .max(3)
    .optional()
    .describe('Up to three things to group by (rows); omit for a single total'),
  measures: z.array(z.enum(MEASURE_KEYS)).min(1).max(8).describe('What to show per row'),
  period: z
    .object({
      kind: z.enum(['working', 'range', 'relative']),
      from: iso.optional(),
      to: iso.optional(),
      rule: z.enum(RELATIVE_PERIODS).optional()
    })
    .optional()
    .describe('working = the period the user has selected; range = from/to; relative = rule (thisMonth, lastMonth, thisQuarter, lastQuarter, fyToDate, lastFy)'),
  ledgers: names.optional().describe('Only these ledgers (exact names from list_ledgers)'),
  groups: names.optional().describe('Only ledgers under these groups (whole subtree), e.g. "Sales Accounts", "Indirect Expenses"'),
  parties: names.optional().describe('Only vouchers of these parties'),
  items: names.optional().describe('Only these stock items'),
  voucherKinds: z.array(z.string().regex(/^[a-z_]{2,40}$/)).max(20).optional().describe('e.g. sales, purchase, payment, receipt, journal, credit_note, debit_note'),
  gstRate: z.number().min(0).max(100).optional(),
  narration: z.string().trim().max(200).optional().describe('Only vouchers whose narration contains this'),
  sort: z.object({ by: z.union([z.literal('dimension'), z.enum(MEASURE_KEYS)]), dir: z.enum(['asc', 'desc']) }).optional(),
  topN: z.number().int().min(1).max(1000).optional().describe('Keep only the first N rows after sorting'),
  chart: z.enum(['none', 'bar', 'line']).optional()
})
export type ReportRequest = z.infer<typeof reportRequestSchema>

export type NameKind = 'ledger' | 'group' | 'party' | 'item'
export interface NameHit {
  id: number
  name: string
}
/** Candidates for a name: exact (case-insensitive) matches first, else partial ones. */
export type NameLookup = (kind: NameKind, name: string) => NameHit[]

export type RequestResult =
  | { ok: true; model: ReportModel; title: string; resolved: { kind: NameKind; asked: string; id: number; name: string }[] }
  | { ok: false; problems: string[] }

const KIND_WORD: Record<NameKind, string> = { ledger: 'ledger', group: 'group', party: 'party', item: 'stock item' }
const KIND_PLURAL: Record<NameKind, string> = { ledger: 'ledgers', group: 'groups', party: 'parties', item: 'stock items' }

/** Resolve a request's names and validate it as a report-builder model. */
export function requestToModel(req: ReportRequest, lookup: NameLookup): RequestResult {
  const problems: string[] = []
  const resolved: { kind: NameKind; asked: string; id: number; name: string }[] = []
  const ids = (kind: NameKind, list: readonly string[] | undefined): number[] => {
    const out: number[] = []
    for (const asked of list ?? []) {
      const hits = lookup(kind, asked)
      const exact = hits.filter((h) => h.name.toLowerCase() === asked.trim().toLowerCase())
      const pick = exact.length === 1 ? exact[0]! : hits.length === 1 ? hits[0]! : null
      if (pick) {
        out.push(pick.id)
        resolved.push({ kind, asked, id: pick.id, name: pick.name })
      } else if (!hits.length) problems.push(`No ${KIND_WORD[kind]} called “${asked}”`)
      else problems.push(`“${asked}” matches several ${KIND_PLURAL[kind]}: ${hits.slice(0, 6).map((h) => h.name).join(', ')} — use the exact name`)
    }
    return [...new Set(out)]
  }
  const filters = {
    ledgerIds: ids('ledger', req.ledgers),
    groupIds: ids('group', req.groups),
    partyIds: ids('party', req.parties),
    itemIds: ids('item', req.items),
    voucherKinds: req.voucherKinds ?? [],
    gstRate: req.gstRate ?? null,
    narration: req.narration ?? ''
  }
  let period: ReportModelInput['period'] = { kind: 'working' }
  if (req.period?.kind === 'range') {
    if (!req.period.from || !req.period.to) problems.push('A range period needs from and to')
    else period = { kind: 'range', from: req.period.from, to: req.period.to }
  } else if (req.period?.kind === 'relative') {
    if (!req.period.rule) problems.push('A relative period needs a rule')
    else period = { kind: 'relative', rule: req.period.rule }
  }
  if (problems.length) return { ok: false, problems }
  const measures = req.measures
  const sort = req.sort ?? (req.topN ? { by: measures[0]!, dir: 'desc' as const } : undefined)
  const input: ReportModelInput = {
    source: req.source,
    dimensions: req.dimensions ?? [],
    measures,
    period,
    filters,
    ...(sort ? { sort } : {}),
    topN: req.topN ?? null,
    chart: req.chart ?? 'bar'
  }
  const parsed = reportModelSchema.safeParse(input)
  if (!parsed.success) return { ok: false, problems: [...new Set(parsed.error.issues.map((i) => i.message))] }
  return { ok: true, model: parsed.data, title: req.title, resolved }
}

// ---------------------------------------------------------------- deterministic phrases

const DIM_WORDS: [RegExp, DimensionKey][] = [
  [/\b(by|per|each|every)\s+(month|months)\b|\bmonthly\b|\bmonth[- ]wise\b/, 'month'],
  [/\b(by|per|each)\s+quarter\b|\bquarterly\b|\bquarter[- ]wise\b/, 'quarter'],
  [/\b(by|per|each)\s+(financial\s+)?year\b|\byearly\b/, 'fy'],
  [/\b(by|per|each)\s+day\b|\bdaily\b|\bday[- ]wise\b/, 'day'],
  [/\b(by|per|each)\s+(party|parties|customers?|suppliers?|vendors?|debtors?|creditors?)\b|\bparty[- ]wise\b|\btop\s+\d+\s+(customers?|suppliers?|parties)\b/, 'party'],
  [/\b(by|per|each)\s+ledgers?\b|\bledger[- ]wise\b/, 'ledger'],
  [/\b(by|per|each)\s+(stock\s+)?(items?|products?)\b|\bitem[- ]wise\b|\btop\s+\d+\s+(items?|products?)\b/, 'item'],
  [/\b(by|per|each)\s+(stock\s+)?group\b/, 'group'],
  [/\b(by|per|each)\s+voucher\s+types?\b/, 'voucherType'],
  [/\b(by|per|each)\s+cost\s+cent(re|er)s?\b/, 'costCentre'],
  [/\b(by|per|each)\s+godowns?\b/, 'godown']
]

const RELATIVE: [RegExp, (typeof RELATIVE_PERIODS)[number]][] = [
  [/\blast\s+month\b|\bprevious\s+month\b/, 'lastMonth'],
  [/\bthis\s+month\b|\bcurrent\s+month\b/, 'thisMonth'],
  [/\blast\s+quarter\b|\bprevious\s+quarter\b/, 'lastQuarter'],
  [/\bthis\s+quarter\b|\bcurrent\s+quarter\b/, 'thisQuarter'],
  [/\blast\s+(financial\s+)?year\b|\bprevious\s+(financial\s+)?year\b/, 'lastFy'],
  [/\bthis\s+(financial\s+)?year\b|\byear\s+to\s+date\b|\bytd\b/, 'fyToDate']
]

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

/** A month named in the question ("in July", "for jul") → its range in the working FY. */
function namedMonth(q: string, working: { from: string } | undefined): { from: string; to: string } | null {
  if (!working) return null
  const m = MONTHS.findIndex((name) => new RegExp(`\\b(in|for|during)\\s+(${name}|${name.slice(0, 3)})\\b`).test(q))
  if (m < 0) return null
  const month = m + 1
  const [wy, wm] = working.from.split('-').map(Number) as [number, number]
  const fyStart = wm >= 4 ? wy : wy - 1
  const year = month >= 4 ? fyStart : fyStart + 1
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const mm = String(month).padStart(2, '0')
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(last).padStart(2, '0')}` }
}

/**
 * Map a plain question to a request, or null when nothing recognisable is asked. Covers: sales,
 * purchases, expenses, incomes, GST, TDS, profit, balances, quantities, voucher counts; "by
 * month / quarter / party / ledger / item / group / voucher type / day"; "top N"; relative
 * periods and "in <month>".
 */
export function parseReportQuestion(question: string, working?: { from: string; to: string }): ReportRequest | null {
  const q = question.toLowerCase()
  const dims: DimensionKey[] = []
  for (const [re, key] of DIM_WORDS) if (re.test(q) && !dims.includes(key)) dims.push(key)
  const top = /\btop\s+(\d{1,3})\b/.exec(q)
  const stock = /\b(stock|quantity|quantities|qty|units sold|items? sold|inventory)\b/.test(q)
  let source: 'accounts' | 'inventory' = stock || (dims.includes('item') && !/\b(sales|purchases?)\s+value\b/.test(q)) ? 'inventory' : 'accounts'
  if (dims.some((d) => DIMENSIONS[d].sources.length === 1 && DIMENSIONS[d].sources[0] === 'inventory')) source = 'inventory'
  const measures: MeasureKey[] = []
  const groups: string[] = []
  const kinds: string[] = []
  let title = ''
  const add = (...m: MeasureKey[]): void => {
    for (const k of m) if (!measures.includes(k) && MEASURES[k].sources.includes(source)) measures.push(k)
  }
  if (source === 'inventory') {
    if (/\bsales?|sold|outward\b/.test(q)) {
      kinds.push('sales')
      add('qtyOut', 'value')
      title = 'Quantities sold'
    } else if (/\bpurchases?|bought|inward\b/.test(q)) {
      kinds.push('purchase')
      add('qtyIn', 'value')
      title = 'Quantities bought'
    } else {
      add('qtyIn', 'qtyOut', 'qtyNet')
      title = 'Stock movement'
    }
  } else if (/\bprofit|loss\b/.test(q)) {
    add('profit')
    title = 'Profit'
  } else if (/\b(gst|tax collected|output tax|input tax|itc)\b/.test(q)) {
    add('taxable', 'cgst', 'sgst', 'igst', 'cess')
    if (/\b(purchases?|input|itc)\b/.test(q)) kinds.push('purchase')
    else if (/\bsales?|output\b/.test(q)) kinds.push('sales')
    title = 'GST'
  } else if (/\btds\b/.test(q)) {
    add('tds')
    title = 'TDS'
  } else if (/\bsales?|revenue|turnover\b/.test(q)) {
    kinds.push('sales')
    add('taxable')
    title = 'Sales'
  } else if (/\bpurchases?\b/.test(q)) {
    kinds.push('purchase')
    add('taxable')
    title = 'Purchases'
  } else if (/\bexpenses?|spend|spending|costs?\b/.test(q)) {
    groups.push('Indirect Expenses', 'Direct Expenses')
    add('net')
    if (!dims.length) dims.push('ledger')
    title = 'Expenses'
  } else if (/\bincomes?\b/.test(q)) {
    groups.push('Indirect Incomes', 'Direct Incomes')
    add('net')
    if (!dims.length) dims.push('ledger')
    title = 'Incomes'
  } else if (/\bbalances?|closing\b/.test(q)) {
    add('balance')
    if (!dims.length) dims.push('ledger')
    title = 'Closing balances'
  } else if (/\b(how many|number of|count)\b.*\bvouchers?\b|\bvouchers?\b/.test(q)) {
    add('count')
    title = 'Vouchers'
  } else if (/\b(debits?|credits?)\b/.test(q)) {
    add('debit', 'credit', 'net')
    title = 'Debits and credits'
  }
  if (!measures.length) return null
  if (/\b(how many|number of|count)\b/.test(q) && measures[0] !== 'count' && !measures.includes('balance')) add('count')
  if (top && !dims.length) dims.push(source === 'inventory' ? 'item' : 'party')
  // A closing balance takes ledger / group / date dimensions only.
  const usable = dims.filter((d) => DIMENSIONS[d].sources.includes(source) && (!measures.includes('balance') || ['ledger', 'group', 'month', 'quarter', 'fy', 'day'].includes(d)))
  const dateDims = usable.filter((d) => ['month', 'quarter', 'fy', 'day'].includes(d))
  const finalDims = usable.filter((d) => !dateDims.includes(d) || d === dateDims[0]).slice(0, 3)
  let period: ReportRequest['period']
  const month = namedMonth(q, working)
  if (month) period = { kind: 'range', ...month }
  else {
    const rel = RELATIVE.find(([re]) => re.test(q))
    if (rel) period = { kind: 'relative', rule: rel[1] }
  }
  const dimWords = finalDims.map((d) => DIMENSIONS[d].label.toLowerCase())
  return {
    title: `${top ? `Top ${top[1]} — ` : ''}${title}${dimWords.length ? ` by ${dimWords.join(' and ')}` : ''}`.slice(0, 80),
    source,
    dimensions: finalDims.map((key) => (key === 'group' ? { key, level: 1 } : { key })),
    measures,
    ...(period ? { period } : {}),
    ...(groups.length ? { groups } : {}),
    ...(kinds.length ? { voucherKinds: kinds } : {}),
    ...(top ? { topN: Number(top[1]), sort: { by: measures[0]!, dir: 'desc' as const } } : {}),
    chart: finalDims.some((d) => ['month', 'quarter', 'day', 'fy'].includes(d)) ? 'line' : 'bar'
  }
}
