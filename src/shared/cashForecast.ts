/**
 * Cash-flow forecast engine (WP 4.4) — pure, no DB.
 *
 * Model (all paise integers):
 *   closing(p) = opening(p) + Σ inflows(p) − Σ outflows(p),   opening(1) = cash + bank today
 * where every flow is a dated, probability-weighted amount:
 *   weighted = round_half_up(amount × probability), probability in basis points (10 000 = 100 %).
 *
 * Flow sources and their default date / probability:
 * - receivables: each open bill on max(today, due date + the company's median days-late); its
 *   probability is the collection probability of its ageing bucket, learned from history
 *   (`collectionProfile`) and scaled by the scenario's collection %.
 * - payables: each open bill on max(today, due date) at 100 %.
 * - open sales / purchase orders: pending value on max(today, expected date + party credit days)
 *   at the scenario's order-conversion %.
 * - known items (rent, salaries …, the user's `forecast_items`): every occurrence of the cadence
 *   inside the horizon, 100 %; adjustments are one-off signed amounts.
 * - statutory dues (GST, TDS, TCS, PF, ESI, PT) and loan EMIs on their due dates, 100 %.
 * Anything dated before today lands in the first period (it is overdue — expected now). Flows
 * past the horizon are reported as "beyond" and left out of the periods.
 *
 * Scenarios only change three knobs (sliders in the screen's Options): collection % (applied to
 * the learned bucket probabilities, capped at 100 %), order conversion %, and extra days of
 * delay on receipts. The service hands the renderer the raw flows; the renderer recomputes the
 * forecast instantly with `buildForecast` as the sliders move.
 */
import type { BillEvent } from './outstanding'
import { mulDivRound, instalmentDate } from './loanSchedule'

// ---------- dates ----------

const DAY = 86_400_000
export function addDaysISO(date: string, delta: number): string {
  const dt = new Date(date + 'T00:00:00Z')
  dt.setUTCDate(dt.getUTCDate() + delta)
  return dt.toISOString().slice(0, 10)
}
export function daysBetweenISO(from: string, to: string): number {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY)
}
function monthEndISO(date: string): string {
  const [y, m] = date.split('-').map(Number) as [number, number]
  return `${date.slice(0, 7)}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const dayLabel = (d: string): string => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`

// ---------- periods ----------

export type ForecastUnit = 'week' | 'month'

export interface ForecastPeriod {
  key: string
  /** "Wk 1 · 7 Oct" / "Oct 2026". */
  label: string
  from: string
  to: string
}

/** `count` consecutive periods starting today: weeks of 7 days from today, or calendar months
 *  (the first one runs from today to its month end). */
export function forecastPeriods(asOn: string, unit: ForecastUnit, count: number): ForecastPeriod[] {
  const out: ForecastPeriod[] = []
  if (unit === 'week') {
    for (let i = 0; i < count; i++) {
      const from = addDaysISO(asOn, 7 * i)
      out.push({ key: `w${i + 1}`, label: `Wk ${i + 1} · ${dayLabel(from)}`, from, to: addDaysISO(from, 6) })
    }
    return out
  }
  let from = asOn
  for (let i = 0; i < count; i++) {
    const to = monthEndISO(from)
    out.push({ key: from.slice(0, 7), label: `${MONTHS[Number(from.slice(5, 7)) - 1]} ${from.slice(0, 4)}`, from, to })
    from = addDaysISO(to, 1)
  }
  return out
}

// ---------- collection history ----------

/** One historical bill: when it fell due and when (if ever) it was fully settled. */
export interface HistoryBill {
  /** Due date, or the bill date when the bill had no terms. */
  dueBasis: string
  settledOn: string | null
  amount: number
}

/**
 * Replays a party's chronological events (the same events `allocateBills` uses: positive opens a
 * bill, negative settles FIFO, named refs settle that bill) and records the date each bill was
 * fully settled. Pure; the open-bill engine (shared/outstanding.ts) stays untouched.
 */
export function billHistory(events: readonly BillEvent[], creditDays: number | null): HistoryBill[] {
  interface OpenBill { name: string; dueBasis: string; amount: number; pending: number; rec: HistoryBill }
  const open: OpenBill[] = []
  const out: HistoryBill[] = []
  let credit = 0
  const due = (date: string, explicit: string | null): string => explicit ?? (creditDays != null ? addDaysISO(date, creditDays) : date)
  const add = (name: string, date: string, amount: number, explicitDue: string | null): void => {
    const rec: HistoryBill = { dueBasis: due(date, explicitDue), settledOn: null, amount }
    out.push(rec)
    const take = Math.min(credit, amount)
    credit -= take
    const b: OpenBill = { name, dueBasis: rec.dueBasis, amount, pending: amount - take, rec }
    if (b.pending > 0) open.push(b)
    else rec.settledOn = date
  }
  const settle = (idx: number, amount: number, date: string): number => {
    const b = open[idx]!
    const take = Math.min(b.pending, amount)
    b.pending -= take
    if (b.pending === 0) {
      b.rec.settledOn = date
      open.splice(idx, 1)
    }
    return amount - take
  }
  const fifo = (amount: number, date: string): void => {
    let rest = amount
    while (rest > 0 && open.length) rest = settle(0, rest, date)
    credit += rest
  }
  for (const ev of events) {
    if (ev.refs.length > 0) {
      for (const r of ev.refs) {
        if (r.kind === 'new') add(r.name, ev.date, r.amount, r.dueDate)
        else {
          const idx = open.findIndex((b) => b.name === r.name)
          if (idx === -1) credit += r.amount
          else {
            const rest = settle(idx, r.amount, ev.date)
            if (rest > 0) fifo(rest, ev.date)
          }
        }
      }
    } else if (ev.amount > 0) add(ev.number, ev.date, ev.amount, null)
    else if (ev.amount < 0) fifo(-ev.amount, ev.date)
  }
  return out
}

export interface CollectionProfile {
  /** Bills the shares were learned from (observed for at least 90 days past due). */
  sampleSize: number
  /** Amount-weighted share (bp) of bills paid within 0 / 30 / 60 / 90 days of falling due. */
  paidWithinBp: [number, number, number, number]
  /** Probability (bp) that a bill now in ageing bucket 0–30 / 31–60 / 61–90 / 90+ days overdue
   *  is collected within the next 90 days — the share of past bills that were still unpaid at
   *  that age and were then paid within 90 more days. */
  bucketProbabilityBp: [number, number, number, number]
  /** Median days late (≥ 0) among settled bills — added to a bill's due date for its expected date. */
  medianDelayDays: number
  /** False when history was too thin (< MIN_SAMPLE bills) and DEFAULT_BUCKET_BP was used. */
  fromHistory: boolean
}

/** Fallback probabilities when the company has too little history — an explicit assumption
 *  (shown in the screen), not a statistic: 95 % / 80 % / 60 % / 30 %. */
export const DEFAULT_BUCKET_BP: [number, number, number, number] = [9500, 8000, 6000, 3000]
export const MIN_SAMPLE = 5
const BUCKET_FROM = [0, 31, 61, 91] as const
const WITHIN = [0, 30, 60, 90] as const

export function collectionProfile(history: readonly HistoryBill[], asOn: string): CollectionProfile {
  const delay = (b: HistoryBill): number | null => (b.settledOn ? Math.max(0, daysBetweenISO(b.dueBasis, b.settledOn)) : null)
  const observed = history.filter((b) => daysBetweenISO(b.dueBasis, asOn) >= 90 && b.amount > 0)
  const total = observed.reduce((s, b) => s + b.amount, 0)
  const paidWithinBp = WITHIN.map((t) => {
    if (total === 0) return 0
    const paid = observed.filter((b) => { const d = delay(b); return d != null && d <= t }).reduce((s, b) => s + b.amount, 0)
    return mulDivRound(paid, 10_000, total)
  }) as [number, number, number, number]

  const fromHistory = observed.length >= MIN_SAMPLE
  const bucketProbabilityBp = BUCKET_FROM.map((lo, i) => {
    // Bills old enough to have been lo days overdue and then watched for 90 more days.
    const pool = history.filter((b) => daysBetweenISO(b.dueBasis, asOn) >= lo + 90 && b.amount > 0)
    const reached = pool.filter((b) => { const d = delay(b); return d == null || d >= lo })
    const reachedAmt = reached.reduce((s, b) => s + b.amount, 0)
    if (!fromHistory || reached.length < MIN_SAMPLE || reachedAmt === 0) return DEFAULT_BUCKET_BP[i]!
    const paid = reached.filter((b) => { const d = delay(b); return d != null && d <= lo + 90 }).reduce((s, b) => s + b.amount, 0)
    return mulDivRound(paid, 10_000, reachedAmt)
  }) as [number, number, number, number]

  const delays = history.map(delay).filter((d): d is number => d != null).sort((a, b) => a - b)
  const medianDelayDays = delays.length === 0 ? 0 : delays[Math.floor((delays.length - 1) / 2)]!
  return { sampleSize: observed.length, paidWithinBp, bucketProbabilityBp, medianDelayDays, fromHistory }
}

/** Ageing bucket of a bill `overdueDays` past due (0 = not yet due or 0–30). */
export function bucketOf(overdueDays: number): 0 | 1 | 2 | 3 {
  return overdueDays <= 30 ? 0 : overdueDays <= 60 ? 1 : overdueDays <= 90 ? 2 : 3
}

// ---------- flows ----------

export type ForecastSource = 'receivable' | 'payable' | 'sales_order' | 'purchase_order' | 'item' | 'adjustment' | 'statutory' | 'emi'

export const SOURCE_LABELS: Record<ForecastSource, string> = {
  receivable: 'Receivables',
  payable: 'Payables',
  sales_order: 'Sales orders',
  purchase_order: 'Purchase orders',
  item: 'Known items',
  adjustment: 'Adjustments',
  statutory: 'Statutory dues',
  emi: 'Loan EMIs'
}

export interface ForecastFlow {
  source: ForecastSource
  direction: 'in' | 'out'
  /** Expected date before any scenario delay (may be before today = overdue). */
  date: string
  /** Gross paise, positive. */
  amount: number
  /** Base probability (bp) before the scenario; orders carry 10 000 (the scenario sets it). */
  probabilityBp: number
  label: string
  /** Party / ledger / document references for drill-down. */
  ledgerId?: number | null
  voucherId?: number | null
  docId?: number | null
  loanId?: number | null
  itemId?: number | null
  /** Ageing bucket for receivables (drives the probability). */
  bucket?: 0 | 1 | 2 | 3
}

export interface OpenBillInput {
  ledgerId: number
  partyName: string
  voucherId: number | null
  number: string
  date: string
  dueDate: string | null
  pending: number
  overdueDays: number
}

/** Receivable flows: expected on max(due + median delay, today); probability by bucket. */
export function receivableFlows(bills: readonly OpenBillInput[], profile: CollectionProfile): ForecastFlow[] {
  return bills.filter((b) => b.pending > 0).map((b) => {
    const bucket = bucketOf(b.overdueDays)
    return {
      source: 'receivable', direction: 'in', date: addDaysISO(b.dueDate ?? b.date, profile.medianDelayDays),
      amount: b.pending, probabilityBp: profile.bucketProbabilityBp[bucket], label: `${b.partyName} · ${b.number}`,
      ledgerId: b.ledgerId, voucherId: b.voucherId, bucket
    }
  })
}

/** Payable flows: on the due date (or bill date), certain. */
export function payableFlows(bills: readonly OpenBillInput[]): ForecastFlow[] {
  return bills.filter((b) => b.pending > 0).map((b) => ({
    source: 'payable', direction: 'out', date: b.dueDate ?? b.date, amount: b.pending, probabilityBp: 10_000,
    label: `${b.partyName} · ${b.number}`, ledgerId: b.ledgerId, voucherId: b.voucherId
  }))
}

export type ItemCadence = 'once' | 'weekly' | 'monthly' | 'quarterly' | 'yearly'
export type ItemKind = 'inflow' | 'outflow' | 'adjustment'

export interface ForecastItemLike {
  id: number
  name: string
  /** Paise: positive for inflow / outflow; signed for an adjustment (+ in, − out). */
  amount: number
  cadence: ItemCadence
  startDate: string
  endDate: string | null
  kind: ItemKind
  active: boolean
}

/** Every occurrence date of an item within [from, to]. */
export function itemOccurrences(item: Pick<ForecastItemLike, 'cadence' | 'startDate' | 'endDate'>, from: string, to: string): string[] {
  const end = item.endDate && item.endDate < to ? item.endDate : to
  if (item.cadence === 'once') return item.startDate >= from && item.startDate <= end ? [item.startDate] : []
  const out: string[] = []
  const step = item.cadence === 'weekly' ? 0 : item.cadence === 'monthly' ? 1 : item.cadence === 'quarterly' ? 3 : 12
  for (let k = 0; k < 2000; k++) {
    const d = item.cadence === 'weekly' ? addDaysISO(item.startDate, 7 * k) : instalmentDate(item.startDate, k * step)
    if (d > end) break
    if (d >= from) out.push(d)
  }
  return out
}

export function itemFlows(items: readonly ForecastItemLike[], from: string, to: string): ForecastFlow[] {
  const out: ForecastFlow[] = []
  for (const it of items) {
    if (!it.active || it.amount === 0) continue
    for (const date of itemOccurrences(it, from, to)) {
      const direction = it.kind === 'inflow' ? 'in' : it.kind === 'outflow' ? 'out' : it.amount > 0 ? 'in' : 'out'
      out.push({
        source: it.kind === 'adjustment' ? 'adjustment' : 'item', direction, date, amount: Math.abs(it.amount),
        probabilityBp: 10_000, label: it.name, itemId: it.id
      })
    }
  }
  return out
}

// ---------- scenarios ----------

export interface ForecastScenario {
  /** Scales the learned collection probabilities (100 = as learned), capped at 100 % each. */
  collectionPct: number
  /** Probability that an open order turns into cash within the horizon. */
  orderPct: number
  /** Extra days added to every receipt (receivables and sales orders). */
  delayDays: number
}

export type ScenarioName = 'best' | 'expected' | 'worst'

export const SCENARIO_PRESETS: Record<ScenarioName, ForecastScenario> = {
  best: { collectionPct: 110, orderPct: 90, delayDays: 0 },
  expected: { collectionPct: 100, orderPct: 60, delayDays: 0 },
  worst: { collectionPct: 70, orderPct: 30, delayDays: 15 }
}

/** The probability (bp) a flow carries under a scenario. */
export function scenarioProbability(f: Pick<ForecastFlow, 'source' | 'probabilityBp'>, s: ForecastScenario): number {
  if (f.source === 'receivable') return Math.min(10_000, mulDivRound(f.probabilityBp, s.collectionPct, 100))
  if (f.source === 'sales_order' || f.source === 'purchase_order') return Math.min(10_000, Math.max(0, Math.round(s.orderPct * 100)))
  return f.probabilityBp
}

// ---------- the forecast ----------

export interface PeriodTotals {
  opening: number
  inflow: number
  outflow: number
  net: number
  closing: number
  /** Weighted paise per source (inflows and outflows positive). */
  bySource: Record<ForecastSource, number>
  /** closing < the minimum balance. */
  shortfall: boolean
}

export type ForecastPeriodRow = ForecastPeriod & PeriodTotals

export interface ForecastContribution extends ForecastFlow {
  /** Date after the scenario's delay, clamped to today. */
  effectiveDate: string
  /** Probability under the scenario (bp). */
  effectiveBp: number
  weighted: number
  /** Period key, or null when past the horizon. */
  periodKey: string | null
}

export interface ForecastResult {
  periods: ForecastPeriodRow[]
  contributions: ForecastContribution[]
  totals: { inflow: number; outflow: number; closing: number }
  /** Lowest closing balance and where it falls. */
  lowest: { closing: number; periodKey: string } | null
  /** First period whose closing dips below the minimum balance. */
  firstShortfall: string | null
  beyond: { inflow: number; outflow: number }
}

export interface ForecastInput {
  asOn: string
  unit: ForecastUnit
  count: number
  openingCash: number
  flows: readonly ForecastFlow[]
  scenario: ForecastScenario
  /** Shortfall threshold (paise); default 0. */
  minBalance?: number
  /** Sources left out (screen toggles). */
  exclude?: readonly ForecastSource[]
}

const emptyBySource = (): Record<ForecastSource, number> => ({
  receivable: 0, payable: 0, sales_order: 0, purchase_order: 0, item: 0, adjustment: 0, statutory: 0, emi: 0
})

export function buildForecast(input: ForecastInput): ForecastResult {
  const periods = forecastPeriods(input.asOn, input.unit, input.count)
  const min = input.minBalance ?? 0
  const excluded = new Set(input.exclude ?? [])
  const last = periods.at(-1)?.to ?? input.asOn
  const contributions: ForecastContribution[] = []
  const perPeriod = new Map(periods.map((p) => [p.key, { inflow: 0, outflow: 0, bySource: emptyBySource() }]))
  const beyond = { inflow: 0, outflow: 0 }

  for (const f of input.flows) {
    if (excluded.has(f.source)) continue
    const delayed = f.direction === 'in' && (f.source === 'receivable' || f.source === 'sales_order') ? addDaysISO(f.date, input.scenario.delayDays) : f.date
    const effectiveDate = delayed < input.asOn ? input.asOn : delayed
    const effectiveBp = scenarioProbability(f, input.scenario)
    const weighted = mulDivRound(f.amount, effectiveBp, 10_000)
    const period = effectiveDate > last ? null : periods.find((p) => effectiveDate >= p.from && effectiveDate <= p.to) ?? null
    contributions.push({ ...f, effectiveDate, effectiveBp, weighted, periodKey: period?.key ?? null })
    if (!period) {
      if (f.direction === 'in') beyond.inflow += weighted
      else beyond.outflow += weighted
      continue
    }
    const acc = perPeriod.get(period.key)!
    if (f.direction === 'in') acc.inflow += weighted
    else acc.outflow += weighted
    acc.bySource[f.source] += weighted
  }

  let running = input.openingCash
  let lowest: ForecastResult['lowest'] = null
  let firstShortfall: string | null = null
  const rows: ForecastPeriodRow[] = periods.map((p) => {
    const acc = perPeriod.get(p.key)!
    const opening = running
    const net = acc.inflow - acc.outflow
    const closing = opening + net
    running = closing
    const shortfall = closing < min
    if (shortfall && firstShortfall == null) firstShortfall = p.key
    if (!lowest || closing < lowest.closing) lowest = { closing, periodKey: p.key }
    return { ...p, opening, inflow: acc.inflow, outflow: acc.outflow, net, closing, bySource: acc.bySource, shortfall }
  })
  contributions.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || b.weighted - a.weighted)
  return {
    periods: rows,
    contributions,
    totals: { inflow: rows.reduce((s, r) => s + r.inflow, 0), outflow: rows.reduce((s, r) => s + r.outflow, 0), closing: running },
    lowest,
    firstShortfall,
    beyond
  }
}
