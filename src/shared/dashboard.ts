/**
 * Gateway dashboard (WP 1.10b) — response shape of `report:dashboardSeries` plus the pure
 * window/month math both sides share. No DB, no Electron. Every figure is computed in
 * src/main/services/dashboard.ts at query time from voucher_lines through the same functions the
 * matching report uses (registers, P&L, outstandings, trial balance, GSTR-3B, TDS, stock).
 */

/** One dashboard card's data, or why it could not be computed — a failing section never blanks
 *  the others (each is computed inside its own try/catch on the main side). */
export type DashSection<T> = { ok: true; data: T } | { ok: false; error: string }

export interface DashboardWindow {
  /** The working period (session from/to). */
  from: string
  to: string
  today: string
  /** Balances and month-to-date figures are as on this date: min(today, to). */
  asOn: string
  /** 'YYYY-MM' the "this month" tiles describe: today's month when today is inside the period,
   *  else the period's last month. */
  focusMonth: string
  /** Every month slot of the working period, 'YYYY-MM' (chart x-axis — future months stay empty). */
  periodMonths: string[]
  /** The six months ending at focusMonth (tile sparklines) — may reach before the period. */
  sparkMonths: string[]
}

export interface DashMonth {
  month: string
  /** The dates this month's figures cover: the calendar month clipped to the period start (first
   *  period month only) and to asOn. */
  from: string
  to: string
  /** Sales register taxable value net of credit/debit notes (tax lines excluded). */
  sales: number
  /** Purchase register taxable value net of debit/credit notes (tax lines excluded). */
  purchases: number
  /** profitAndLoss(from, to).netProfit — the P&L screen's figure for the same dates. */
  netProfit: number
}

export interface DashTrade {
  /** Months with figures (≤ asOn), ascending; spans sparkMonths ∪ period months. */
  months: DashMonth[]
  /** profitAndLoss(period from, asOn).netProfit. */
  periodNetProfit: number
  periodSales: number
  periodPurchases: number
}

export interface DashTrendPoint {
  month: string
  amount: number
}

export interface DashCashLedger {
  ledgerId: number
  name: string
  kind: 'cash' | 'bank'
  /** Dr-positive closing balance as on asOn (trial balance figure). */
  balance: number
}

export interface DashCash {
  ledgers: DashCashLedger[]
  cash: number
  bank: number
  total: number
  /** Cash + bank at each spark month's end (the last point is asOn). */
  trend: DashTrendPoint[]
}

export interface DashAgeing {
  /** Outstandings screen total (pending bills) as on asOn. */
  total: number
  /** 0–30, 31–60, 61–90, 90+ days overdue — the Outstandings screen's buckets. */
  buckets: [number, number, number, number]
  parties: number
  /** Month-end amount owed (sum of positive party balances) — trend only. */
  trend: DashTrendPoint[]
}

export interface DashParty {
  ledgerId: number
  name: string
  /** Net taxable turnover in the period (register definition, net of notes). */
  amount: number
}

export interface DashGst {
  /** 'YYYY-MM' the next GSTR-3B covers. */
  period: string
  gstr1Due: string | null
  gstr3bDue: string | null
  /** Output tax + RCM liability for the period (3.1 + 3.1(d)). */
  liability: number
  /** Net eligible ITC (4A − 4B). */
  itc: number
  /** Cash payable after set-off, including RCM (netPayable + rcmPayable). */
  payable: number
  /** WP 3.4 — GSTR-9 / ITC-04 due in the next 45 days (sourced in shared/gst/sources.ts). */
  annual?: { form: string; title: string; date: string }[]
}

export interface DashTds {
  /** e.g. 'Q3 FY2026-27'. */
  quarter: string
  /** TDS deducted in the quarter so far (TDS summary). */
  deducted: number
  /** Credit balance on the "TDS Payable …" ledgers — deducted, not yet deposited. */
  payable: number
  payableLedgers: { ledgerId: number; name: string; balance: number }[]
  nextDue: string | null
}

export interface DashStockAlert {
  stockItemId: number
  name: string
  unitSymbol: string
  decimals: number
  closingQtyMilli: number
  reorderLevelMilli: number | null
}

export interface DashStock {
  negative: DashStockAlert[]
  belowReorder: DashStockAlert[]
}

export interface DashActivity {
  /** Day Book rows (incl. optional / post-dated, excl. the bin) dated today. */
  today: number
  /** Same, Monday of this week → today. */
  week: number
  weekFrom: string
}

export interface DashStatus {
  lockDate: string | null
  /** Newest backup of any kind (epoch ms + filename tag). */
  lastBackup: { at: number; tag: string } | null
  /** Backups the user (or the scheduler / quit hook) made — not the automatic on-open snapshot. */
  userBackups: number
}

export interface DashSetup {
  companyInfoComplete: boolean
  gstRegistered: boolean
  gstinSet: boolean
  /** Ledgers the user created (seeded system ledgers excluded). */
  userLedgers: number
  bankLedgers: number
  voucherCount: number
  userBackups: number
}

/** WP 4.1 — post-dated cheques maturing within the next 7 days (and any already due). */
export interface DashPdc {
  until: string
  received: { count: number; amount: number }
  issued: { count: number; amount: number }
  /** Due but not matured (their date falls inside the locked period). */
  overdue: number
  items: { voucherId: number; number: string; date: string; direction: 'received' | 'issued'; partyName: string | null; amount: number; status: 'pending' | 'due' | 'matured' | 'bounced' }[]
}

export interface DashboardSeries {
  window: DashboardWindow
  trade: DashSection<DashTrade>
  cash: DashSection<DashCash>
  receivables: DashSection<DashAgeing>
  payables: DashSection<DashAgeing>
  topCustomers: DashSection<DashParty[]>
  topSuppliers: DashSection<DashParty[]>
  /** null data: not a regular GST registration (no GSTR-1/3B to file). */
  gst: DashSection<DashGst | null>
  /** null data: TDS feature off. */
  tds: DashSection<DashTds | null>
  /** null data: inventory feature off. */
  stock: DashSection<DashStock | null>
  activity: DashSection<DashActivity>
  status: DashSection<DashStatus>
  setup: DashSection<DashSetup>
  /** WP 4.1 — PDC reminders for the compliance card (optional: older fixtures omit it). */
  pdc?: DashSection<DashPdc>
}

// ---------- pure month math ----------

export const monthOf = (date: string): string => date.slice(0, 7)

/** 'YYYY-MM' shifted by `delta` months. */
export function addMonths(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number) as [number, number]
  const idx = y * 12 + (m - 1) + delta
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`
}

/** Inclusive list of months from `fromYm` to `toYm` (empty when from > to). */
export function monthRange(fromYm: string, toYm: string): string[] {
  const out: string[] = []
  for (let m = fromYm; m <= toYm; m = addMonths(m, 1)) out.push(m)
  return out
}

export function monthStart(ym: string): string {
  return `${ym}-01`
}

export function monthEnd(ym: string): string {
  const [y, m] = ym.split('-').map(Number) as [number, number]
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`
}

export function addDays(date: string, delta: number): string {
  const dt = new Date(date + 'T00:00:00Z')
  dt.setUTCDate(dt.getUTCDate() + delta)
  return dt.toISOString().slice(0, 10)
}

/** Monday of the week containing `date`. */
export function weekStart(date: string): string {
  const dow = new Date(date + 'T00:00:00Z').getUTCDay() // 0 = Sunday
  return addDays(date, -((dow + 6) % 7))
}

/**
 * The dashboard's window over the working period. Balances are as on min(today, to) — a past
 * period shows its closing position, the current one today's. The "this month" tiles describe
 * today's month while today is inside the period; otherwise (a past or future working period) the
 * period's last month — the most recent month that period has.
 */
export function dashboardWindow(today: string, from: string, to: string): DashboardWindow {
  const asOn = today < to ? today : to
  const focusMonth = today >= from && today <= to ? monthOf(today) : monthOf(to)
  return {
    from,
    to,
    today,
    asOn,
    focusMonth,
    periodMonths: monthRange(monthOf(from), monthOf(to)),
    sparkMonths: monthRange(addMonths(focusMonth, -5), focusMonth)
  }
}

/** The dates a month's figures cover: clipped to the period start (when the period starts
 *  inside it) and to asOn; null when the month lies wholly after asOn (nothing to show yet). */
export function monthSpan(ym: string, w: Pick<DashboardWindow, 'from' | 'asOn'>): { from: string; to: string } | null {
  const start = monthStart(ym)
  const from = monthOf(w.from) === ym && w.from > start ? w.from : start
  const end = monthEnd(ym)
  const to = end < w.asOn ? end : w.asOn
  return from <= to ? { from, to } : null
}
