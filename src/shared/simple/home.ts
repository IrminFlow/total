// Simple Home (WP 8.6, plan 2026-10-13 §2.2): the shapes `simple:home` / `simple:homeAttention`
// return, and the pure rules that pick what the "Needs attention" card shows. Every figure is
// computed by main at query time, as on TODAY, through the services the accountant screens use
// (services/simpleHome.ts):
//   money in / out today   cash + bank lines of today's in-books entries (Day Book scope)
//   customers / suppliers  analysis.outstandings — the Outstandings screen's allocation
//   cash and bank          opening + in-books movements to today (= trial balance rows)
//   profit                 reports.profitAndLoss (→ pnlLedgerAmounts), month and FY to date
//   GST                    dashboard.dashGst (the Gateway's Compliance row, regular only)
//   needs attention        the tiles' overdue bills + assistants.closeChecklist + anomalies
//   deadlines              compliance.upcomingDeadlines with complianceApplicability
// The sentences that explain them are in ./explain.ts. Nothing here is stored.

import type { DashGst, DashSetup } from '../dashboard'
import type { CloseCheck, CloseCheckKey } from '../closeChecklist'
import type { AnomalyKind, AnomalySeverity } from '../anomalies'
import type { Deadline } from '../compliance'
import type { GstFilingFrequency } from '../gst/filing'

/** One side of what is owed (customers → you, or you → suppliers), from the Outstandings
 *  allocation as on today. Paise, positive. */
export interface HomeOwed {
  /** Open bills, all parties (= the Outstandings total / the Gateway tile). */
  total: number
  /** Parties with something open. */
  parties: number
  /** The part already past its due date, and in how many bills. */
  overdue: number
  overdueBills: number
  /** The oldest open bill: whose it is and how many days old. */
  oldest: { ledgerId: number; name: string; days: number } | null
  /** The earliest due date from today on (not yet overdue). */
  nextDue: { ledgerId: number; name: string; date: string; amount: number } | null
  /** Paid ahead and not set against any bill yet (the same allocation's unapplied credit): what
   *  customers paid you in advance / what you paid suppliers in advance. */
  advances: number
  advanceParties: number
}

/** Money that came in (or went out) today through cash and bank. An entry that only moves money
 *  between cash and bank accounts is neither. Paise. */
export interface HomeMoneyDay {
  amount: number
  entries: number
  /** The part that came from (money in) or went to (money out) a loan account — borrowed or
   *  repaid money, not income or expense. */
  loans: number
}

export interface HomeCashAccount {
  ledgerId: number
  name: string
  kind: 'cash' | 'bank'
  /** Paise, debit-positive (a negative bank balance is an overdraft). */
  balance: number
}

export interface HomeCash {
  accounts: HomeCashAccount[]
  cash: number
  bank: number
  total: number
}

export interface HomeProfitPeriod {
  from: string
  to: string
  /** reports.profitAndLoss(...).netProfit — positive = profit, negative = loss. */
  netProfit: number
  openingStock: number
  closingStock: number
}

export interface HomeProfit {
  /** This month, 1st (or the FY / books start) to today. */
  month: HomeProfitPeriod & { month: string }
  /** The financial year to today. */
  year: HomeProfitPeriod
}

/** GST paid on purchases against GSTR-2B (the portal's statement of suppliers' bills, imported
 *  per month): `none` = no month of the period has a statement, so all of it is booked but not
 *  yet checked; `awaiting` = tax on purchase bills of the checked months that 2B does not list. */
export interface HomeGstCredit {
  checked: 'none' | 'some' | 'all'
  awaiting: number
}

export type HomeGst =
  | { kind: 'regular'; filing: GstFilingFrequency; row: DashGst; credit: HomeGstCredit }
  /** Composition: no GST figure — the composition return note only. */
  | { kind: 'composition' }

export type HomeAttentionSource = 'owed' | 'close' | 'anomaly' | 'stock'

export interface HomeAttentionItem {
  source: HomeAttentionSource
  /** 'receivable' / 'payable' (owed), a close-checklist key or an anomaly kind — the plain
   *  sentence is keyed by it. */
  key: CloseCheckKey | AnomalyKind | 'receivable' | 'payable' | 'low_stock'
  /** How many things (bills, entries, products …) the item is about. */
  count: number
  /** Paise, when the item has one amount. */
  amount: number | null
  level: 'high' | 'medium'
}

/** `simple:homeAttention` — the slower half of "Needs attention", fetched after Home shows. */
export interface HomeAttention {
  /** The month the close checklist was run for (YYYY-MM, the Assistants screen's default). */
  period: string
  /** Close checks + anomalies, most important first. */
  items: HomeAttentionItem[]
  /** Anomalies were not looked for: the year has more entries than ANOMALY_HOME_CAP (the
   *  Assistants screen still runs them on request). */
  anomaliesSkipped: boolean
}

/** Above this many in-books entries in the year, Home does not run the anomaly scan. */
export const ANOMALY_HOME_CAP = 10_000

export interface HomeBackup {
  /** The newest backup the user took (the automatic on-open snapshot doesn't count). */
  lastAt: number | null
  /** Whole days since then. */
  days: number | null
  /** True when that backup is older than BACKUP_NUDGE_DAYS. (No backup at all is the setup
   *  checklist's "Take a backup" step.) */
  nudge: boolean
}

export const BACKUP_NUDGE_DAYS = 7

export interface SimpleHomeData {
  /** The as-on date: the asked date, never after the server's today. */
  today: string
  fy: { from: string; to: string }
  moneyIn: HomeMoneyDay
  moneyOut: HomeMoneyDay
  receivables: HomeOwed
  payables: HomeOwed
  cash: HomeCash
  profit: HomeProfit
  /** Regular → the next GSTR-3B; composition → the composition return note; unregistered → null. */
  gst: HomeGst | null
  /** Applicable deadlines in the next 30 days other than GST (the GST tile carries those). */
  deadlines: Deadline[]
  backup: HomeBackup
  /** The onboarding facts (same as the Gateway's `setup` section). */
  setup: DashSetup
  /** The setup wizard's GST answer (meta ui.setup.gst), null for a company made another way. */
  gstAnswer: 'regular' | 'composition' | 'no' | 'not_sure' | null
}

/** Nothing recorded yet: no entries, and no balance or open bill from openings either — Home shows
 *  one "Nothing recorded yet" card instead of a row of ₹0 tiles. */
export function isEmptyHome(home: SimpleHomeData): boolean {
  return (
    home.setup.voucherCount === 0 &&
    home.cash.accounts.every((a) => a.balance === 0) &&
    home.receivables.total === 0 &&
    home.payables.total === 0 &&
    home.receivables.advances === 0 &&
    home.payables.advances === 0
  )
}

/**
 * Close-checklist rows Home lifts into "Needs attention", and from which status. Overdue bills
 * are NOT taken from the checklist (it counts both sides as on last month's end) — they come from
 * the tiles' own figures as on today (`owedAttention`), so the card never contradicts them. The
 * books' housekeeping rows (lock, narration, regular expenses) stay on the Assistants screen;
 * bank reconciliation, rounding and depreciation only when they fail.
 */
export const HOME_CHECK_LEVEL: Partial<Record<CloseCheckKey, 'warn' | 'fail'>> = {
  unallocated: 'warn',
  gst_returns: 'warn',
  withholding: 'warn',
  negative_stock: 'warn',
  unbilled_goods: 'warn',
  suspense: 'warn',
  pdc_due: 'warn',
  depreciation: 'fail',
  drafts: 'warn',
  bank_reconciliation: 'fail',
  rounding: 'fail'
}

/** Anomaly severities Home shows (low ones — weekend postings, round amounts — stay on the screen). */
const HOME_ANOMALY_SEVERITIES: ReadonlySet<AnomalySeverity> = new Set(['high', 'medium'])

/** The overdue rows, one per side, from the SAME figures as the tiles (as on today). */
export function owedAttention(receivables: HomeOwed, payables: HomeOwed): HomeAttentionItem[] {
  const out: HomeAttentionItem[] = []
  if (receivables.overdueBills > 0) out.push({ source: 'owed', key: 'receivable', count: receivables.overdueBills, amount: receivables.overdue, level: 'medium' })
  if (payables.overdueBills > 0) out.push({ source: 'owed', key: 'payable', count: payables.overdueBills, amount: payables.overdue, level: 'medium' })
  return out
}

/** The close checks that still need doing (a user's done / n/a mark counts — `effective`) and
 *  open anomalies grouped by kind; failures and high-severity findings first, then by count. */
export function attentionItems(
  checks: readonly Pick<CloseCheck, 'key' | 'effective' | 'count' | 'amount'>[],
  anomalies: readonly { kind: AnomalyKind; severity: AnomalySeverity; amount: number | null; dismissed?: unknown }[]
): HomeAttentionItem[] {
  const items: HomeAttentionItem[] = []
  for (const c of checks) {
    const from = HOME_CHECK_LEVEL[c.key]
    if (!from) continue
    if (c.effective !== 'fail' && !(from === 'warn' && c.effective === 'warn')) continue
    items.push({ source: 'close', key: c.key, count: Math.max(1, c.count), amount: c.amount, level: c.effective === 'fail' ? 'high' : 'medium' })
  }
  const byKind = new Map<AnomalyKind, HomeAttentionItem>()
  for (const a of anomalies) {
    if (a.dismissed || !HOME_ANOMALY_SEVERITIES.has(a.severity)) continue
    const level = a.severity === 'high' ? 'high' : 'medium'
    const it = byKind.get(a.kind) ?? { source: 'anomaly' as const, key: a.kind, count: 0, amount: null, level }
    it.count++
    if (level === 'high') it.level = 'high'
    byKind.set(a.kind, it)
  }
  items.push(...byKind.values())
  const rank = (i: HomeAttentionItem): number => (i.level === 'high' ? 0 : 2) + (i.source === 'close' ? 0 : 1)
  return items.sort((a, b) => rank(a) - rank(b) || b.count - a.count || String(a.key).localeCompare(String(b.key)))
}

/** The card's rows: high findings first, then the tiles' overdue bills, then the rest. */
export function homeAttentionRows(owed: HomeAttentionItem[], rest: readonly HomeAttentionItem[]): HomeAttentionItem[] {
  return [...rest.filter((i) => i.level === 'high'), ...owed, ...rest.filter((i) => i.level !== 'high')]
}

/** Whole days between an epoch-ms instant and `today` (local midnight), never negative. */
export function daysSince(at: number, today: string): number {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number]
  const then = new Date(at)
  const thenDay = Date.UTC(then.getFullYear(), then.getMonth(), then.getDate())
  return Math.max(0, Math.round((Date.UTC(y, m - 1, d) - thenDay) / 86_400_000))
}

/** A side's summary from the Outstandings allocation (analysis.outstandingsWithAdvances as on
 *  today): the same total the Outstandings screen and the Gateway tile show, plus the facts the
 *  sentence needs. Pure. */
export function owedSummary(
  parties: readonly { ledgerId: number; name: string; pending: number; bills: readonly { pending: number; ageDays: number; dueDate: string | null; overdueDays: number }[] }[],
  today: string,
  advances: { amount: number; parties: number } = { amount: 0, parties: 0 }
): HomeOwed {
  let overdue = 0
  let overdueBills = 0
  let oldest: HomeOwed['oldest'] = null
  let nextDue: HomeOwed['nextDue'] = null
  for (const p of parties) {
    for (const b of p.bills) {
      if (b.pending <= 0) continue
      if (b.overdueDays > 0) {
        overdue += b.pending
        overdueBills++
      }
      if (!oldest || b.ageDays > oldest.days) oldest = { ledgerId: p.ledgerId, name: p.name, days: b.ageDays }
      if (b.overdueDays === 0 && b.dueDate && b.dueDate >= today && (!nextDue || b.dueDate < nextDue.date)) {
        nextDue = { ledgerId: p.ledgerId, name: p.name, date: b.dueDate, amount: b.pending }
      }
    }
  }
  return {
    total: parties.reduce((s, p) => s + p.pending, 0),
    parties: parties.filter((p) => p.pending !== 0).length,
    overdue,
    overdueBills,
    oldest,
    nextDue,
    advances: advances.amount,
    advanceParties: advances.parties
  }
}
