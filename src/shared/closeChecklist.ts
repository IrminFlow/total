/**
 * Month-end close checklist (WP 5.5) — pure. The main process gathers the FACTS for a month from
 * the existing services (bank reconciliation, outstandings, GST exports, TDS / TCS payable,
 * negative stock, unbilled challans / GRNs, suspense, PDCs, depreciation runs, exceptions, drafts
 * — services/assistants.ts); this module turns them into checks with a status, a summary and the
 * rows behind them, each linking to the screen that fixes it. The user's "done" / "not
 * applicable" marks (assistant_marks) sit on top; nothing here is stored.
 *
 * Amounts are integer paise; the summaries format them without floats.
 */
import { depositDueDate } from './tdsInterest'
import { tcsDepositDueDate } from './tcs'
import { rupeeText } from './anomalies'
import type { AssistantSourceId } from './assistantSources'

export const CLOSE_CHECK_KEYS = [
  'bank_reconciliation',
  'unallocated',
  'overdue_bills',
  'gst_returns',
  'withholding',
  'negative_stock',
  'unbilled_goods',
  'suspense',
  'pdc_due',
  'depreciation',
  'accruals',
  'narration',
  'rounding',
  'drafts',
  'lock'
] as const
export type CloseCheckKey = (typeof CLOSE_CHECK_KEYS)[number]

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'na'
/** What the row shows once the user's mark applies. */
export type CheckEffective = CheckStatus | 'done'

export interface CheckRow {
  label: string
  detail?: string
  date?: string | null
  /** Paise. */
  amount?: number | null
  ledgerId?: number
  voucherId?: number
  itemId?: number
  draftId?: number
}

export interface CheckFix {
  screen: string
  label: string
  params?: Record<string, string | number>
}

export interface CloseMark {
  status: 'done' | 'na'
  note: string | null
  by: string | null
  at: string
  /** The check's figures when it was marked (see checkFingerprint); null = not recorded. */
  fingerprint?: string | null
}

export interface CloseCheck {
  key: CloseCheckKey
  title: string
  area: 'Banking' | 'Parties' | 'GST' | 'TDS / TCS' | 'Stock' | 'Books' | 'Assets'
  status: CheckStatus
  summary: string
  count: number
  /** Paise; null when the check has no single amount. */
  amount: number | null
  rows: CheckRow[]
  /** Rows beyond ROW_CAP (counted, not shown). */
  more: number
  dueDate: string | null
  fix: CheckFix
  help: string
  sources: AssistantSourceId[]
  mark: CloseMark | null
  effective: CheckEffective
  /** What the check found, as a fingerprint — a mark made on other figures no longer applies. */
  fingerprint: string
  /** The check was marked, but what it finds has changed since: the mark no longer counts. */
  reopened: boolean
}

export interface CloseProgress {
  total: number
  /** ok + done + not applicable. */
  cleared: number
  done: number
  na: number
  warn: number
  fail: number
  /** Whole percent cleared (integer). */
  pct: number
}

export interface CloseChecklist {
  period: string
  label: string
  from: string
  to: string
  today: string
  checks: CloseCheck[]
  progress: CloseProgress
}

export const CHECK_ROW_CAP = 100

type VRow = { voucherId: number; label: string; date: string; amount: number; ledgerId?: number; detail?: string }

/** Everything the checks are computed from — gathered by services/assistants.ts. */
export interface CloseFacts {
  bank: {
    ledgerId: number
    name: string
    /** Book entries with no bank date as on the month end. */
    unreconciled: VRow[]
    /** Imported statement lines up to the month end, neither matched nor ignored. */
    openStatementLines: { date: string; description: string; amount: number }[]
  }[]
  /** Settlements that ran past every open bill (an advance / on-account amount). */
  unallocated: { ledgerId: number; name: string; side: 'receivable' | 'payable'; amount: number }[]
  overdue: { ledgerId: number; name: string; side: 'receivable' | 'payable'; voucherId: number | null; bill: string; date: string; pending: number; overdueDays: number }[]
  /** null = not a regular GST registration (no GSTR-1 / 3B). */
  gst: { gstr1ExportedAt: string | null; gstr3bExportedAt: string | null } | null
  /** Each tagged TDS / TCS payable ledger: what was deducted per month (credits; `month` null =
   *  the opening balance) up to the month end, and what was paid out of it (debits) up to today —
   *  deposits made next month count against the month they were deducted in (oldest first). */
  withholding: { kind: 'tds' | 'tcs'; ledgerId: number; name: string; deducted: { month: string | null; amount: number }[]; paid: number }[]
  /** Vouchers where TDS looks applicable but none was deducted (the TDS workbench). */
  withholdingMissed: VRow[]
  negativeStock: { itemId: number; name: string; qtyText: string }[]
  unbilled: { stage: 'GDNI' | 'GRNI'; voucherId: number; label: string; date: string; ledgerId: number | null; party: string | null; value: number }[]
  suspense: { ledgerId: number; name: string; balance: number }[]
  pdcs: { voucherId: number; label: string; date: string; ledgerId: number | null; party: string | null; amount: number; direction: 'received' | 'issued' }[]
  depreciation: { assetsInService: number; coveredThrough: string | null } | null
  /** P&L ledgers posted in each of the previous three months but not in this one. */
  accruals: { ledgerId: number; name: string; lastMonth: string; lastAmount: number }[]
  blankNarration: VRow[]
  roundOff: VRow[]
  unbalanced: VRow[]
  drafts: { draftId: number; summary: string; date: string | null }[]
  optionalVouchers: VRow[]
  lockDate: string | null
}

// ---------------------------------------------------------------- dates

const pad = (n: number): string => String(n).padStart(2, '0')

export function monthBounds(period: string): { from: string; to: string } {
  const [y, m] = period.split('-').map(Number) as [number, number]
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { from: `${period}-01`, to: `${period}-${pad(last)}` }
}

export function addMonths(period: string, delta: number): string {
  const [y, m] = period.split('-').map(Number) as [number, number]
  const idx = y * 12 + (m - 1) + delta
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`
}

/** The return due date for a month: day `day` of the next month. */
export function nextMonthDay(period: string, day: number): string {
  return `${addMonths(period, 1)}-${pad(day)}`
}

/** GSTR-1 on the 11th (s.37(1) as extended; UNVERIFIED — see assistantSources), GSTR-3B on the
 *  20th (rule 61) of the next month — monthly filers. */
export const GSTR1_DUE_DAY = 11
export const GSTR3B_DUE_DAY = 20

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
export const periodLabel = (period: string): string => `${MONTHS[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const sum = (xs: readonly { amount?: number | null }[]): number => xs.reduce((s, x) => s + (x.amount ?? 0), 0)

// ---------------------------------------------------------------- the checks

interface Built {
  status: CheckStatus
  summary: string
  rows: CheckRow[]
  count?: number
  amount?: number | null
  dueDate?: string | null
}

interface Def {
  title: string
  area: CloseCheck['area']
  fix: CheckFix
  help: string
  sources?: AssistantSourceId[]
  build: (f: CloseFacts, c: { period: string; from: string; to: string; today: string }) => Built
}

const vrows = (list: readonly VRow[], detail?: string): CheckRow[] =>
  list.map((v) => ({ label: v.label, date: v.date, amount: v.amount, voucherId: v.voucherId, ...(v.ledgerId ? { ledgerId: v.ledgerId } : {}), ...(v.detail ?? detail ? { detail: v.detail ?? detail } : {}) }))

export const CLOSE_CHECK_DEFS: Record<CloseCheckKey, Def> = {
  bank_reconciliation: {
    title: 'Bank accounts reconciled',
    area: 'Banking',
    fix: { screen: 'banking', label: 'Open banking' },
    help: 'Every bank entry up to the month end has a bank date, and every imported statement line is matched (or ignored).',
    build: (f) => {
      const open = f.bank.flatMap((b) => b.openStatementLines.map((l) => ({ label: `${b.name}: statement line`, detail: l.description, date: l.date, amount: l.amount, ledgerId: b.ledgerId })))
      const books = f.bank.flatMap((b) => b.unreconciled.map((v) => ({ label: v.label, detail: `${b.name}: no bank date`, date: v.date, amount: v.amount, voucherId: v.voucherId, ledgerId: b.ledgerId })))
      if (!f.bank.length) return { status: 'na', summary: 'No bank ledgers.', rows: [] }
      const parts = [open.length ? `${plural(open.length, 'statement line')} not in the books` : null, books.length ? `${plural(books.length, 'book entry', 'book entries')} without a bank date` : null].filter(Boolean)
      return {
        status: open.length ? 'fail' : books.length ? 'warn' : 'ok',
        summary: parts.length ? `${parts.join('; ')}.` : `All ${plural(f.bank.length, 'bank account')} reconciled.`,
        rows: [...open, ...books],
        amount: sum(open) + sum(books)
      }
    }
  },
  unallocated: {
    title: 'Receipts and payments allocated to bills',
    area: 'Parties',
    fix: { screen: 'outstandings', label: 'Open outstandings' },
    help: 'Money received or paid that is not set off against any bill (on account / advance). Allocate it bill-wise, or confirm it is a genuine advance.',
    build: (f) => {
      const rows = f.unallocated.map((u) => ({ label: u.name, detail: u.side === 'receivable' ? 'customer: unallocated receipt / advance' : 'supplier: unallocated payment / advance', amount: u.amount, ledgerId: u.ledgerId }))
      return { status: rows.length ? 'warn' : 'ok', summary: rows.length ? `${plural(rows.length, 'party', 'parties')} with ${rupeeText(sum(rows))} not allocated to bills.` : 'Every receipt and payment is set off against bills.', rows, amount: sum(rows) }
    }
  },
  overdue_bills: {
    title: 'Overdue bills followed up',
    area: 'Parties',
    fix: { screen: 'receivables', label: 'Open receivables' },
    help: 'Bills past their due date at the month end — send reminders (receivables) or schedule payment (payables).',
    build: (f) => {
      const rows = f.overdue.map((b) => ({ label: `${b.name} — ${b.bill}`, detail: `${b.side === 'receivable' ? 'receivable' : 'payable'}, ${b.overdueDays} days overdue`, date: b.date, amount: b.pending, ledgerId: b.ledgerId, ...(b.voucherId ? { voucherId: b.voucherId } : {}) }))
      const rec = f.overdue.filter((b) => b.side === 'receivable')
      const pay = f.overdue.filter((b) => b.side === 'payable')
      return {
        status: rows.length ? 'warn' : 'ok',
        summary: rows.length ? `${plural(rec.length, 'receivable')} (${rupeeText(rec.reduce((s, b) => s + b.pending, 0))}) and ${plural(pay.length, 'payable')} (${rupeeText(pay.reduce((s, b) => s + b.pending, 0))}) overdue.` : 'No bill is overdue.',
        rows,
        amount: sum(rows)
      }
    }
  },
  gst_returns: {
    title: 'GSTR-1 and GSTR-3B prepared',
    area: 'GST',
    fix: { screen: 'gstr1', label: 'Open GST returns' },
    help: 'A return counts as prepared once its JSON is exported from the GST screens (the app does not file it). GSTR-1 is due on the 11th and GSTR-3B on the 20th of the next month (monthly filers).',
    sources: ['s37_1', 'gstr1_11th', 'rule61'],
    build: (f, c) => {
      if (!f.gst) return { status: 'na', summary: 'Not a regular GST registration — no GSTR-1 / GSTR-3B.', rows: [] }
      const d1 = nextMonthDay(c.period, GSTR1_DUE_DAY)
      const d3 = nextMonthDay(c.period, GSTR3B_DUE_DAY)
      const forms = [
        { form: 'GSTR-1', at: f.gst.gstr1ExportedAt, due: d1 },
        { form: 'GSTR-3B', at: f.gst.gstr3bExportedAt, due: d3 }
      ]
      const rows = forms.map((x) => ({ label: x.form, detail: x.at ? `prepared (JSON exported ${x.at.slice(0, 10)})` : `not prepared — due ${x.due}${c.today > x.due ? ', OVERDUE' : ''}`, date: x.due }))
      const late = forms.some((x) => !x.at && c.today > x.due)
      const missing = forms.filter((x) => !x.at)
      return {
        status: late ? 'fail' : missing.length ? 'warn' : 'ok',
        summary: missing.length ? `${missing.map((x) => x.form).join(' and ')} not prepared yet${late ? ' — past the due date' : ''}.` : 'Both returns prepared.',
        rows,
        count: missing.length,
        dueDate: missing[0]?.due ?? null
      }
    }
  },
  withholding: {
    title: 'TDS / TCS deposited',
    area: 'TDS / TCS',
    fix: { screen: 'tds', label: 'Open TDS' },
    help: 'Tax deducted or collected sits in its payable ledger until deposited: by the 7th of the next month (March: 30 April). Deposits count against the oldest deductions first, whenever they were made (up to today). Vouchers where TDS looks missed are listed too.',
    build: (f, c) => {
      // Months after this one are the next checklists' business.
      const pending = f.withholding.flatMap((w) => withholdingUnpaid(w, c.today).filter((u) => u.month === null || u.month <= c.period).map((u) => ({ ...u, w })))
      const rows: CheckRow[] = [
        ...pending.map((u) => ({
          label: u.w.name,
          detail: u.month ? `${u.w.kind.toUpperCase()} deducted in ${u.month} not deposited — due ${u.dueDate}${u.late ? ', OVERDUE' : ''}` : `${u.w.kind.toUpperCase()} opening balance not deposited`,
          amount: u.unpaid,
          ledgerId: u.w.ledgerId,
          date: u.dueDate
        })),
        ...vrows(f.withholdingMissed, 'TDS looks applicable but none was deducted')
      ]
      const late = pending.some((u) => u.late)
      if (!pending.length && !f.withholdingMissed.length) return { status: 'ok', summary: f.withholding.length ? 'Everything deducted is deposited.' : 'Nothing deducted or collected.', rows: [] }
      const total = pending.reduce((s, u) => s + u.unpaid, 0)
      const parts = [pending.length ? `${rupeeText(total)} not deposited${late ? ' (past the due date)' : ''}` : null, f.withholdingMissed.length ? `${plural(f.withholdingMissed.length, 'voucher')} where TDS looks missed` : null].filter(Boolean)
      const dues = pending.map((u) => u.dueDate).filter((d): d is string => !!d).sort()
      return { status: late ? 'fail' : 'warn', summary: `${parts.join('; ')}.`, rows, amount: total, dueDate: dues[0] ?? null }
    }
  },
  negative_stock: {
    title: 'No negative stock',
    area: 'Stock',
    fix: { screen: 'stock-summary', label: 'Open stock summary' },
    help: 'An item cannot have less than nothing: a missing purchase / GRN, or a sale entered against the wrong item.',
    build: (f) => {
      const rows = f.negativeStock.map((s) => ({ label: s.name, detail: `closing quantity ${s.qtyText}`, itemId: s.itemId }))
      return { status: rows.length ? 'fail' : 'ok', summary: rows.length ? `${plural(rows.length, 'item')} below zero at the month end.` : 'No item is below zero.', rows }
    }
  },
  unbilled_goods: {
    title: 'Challans and GRNs invoiced',
    area: 'Stock',
    fix: { screen: 'unbilled-goods', label: 'Open unbilled goods' },
    help: 'Goods delivered not yet invoiced (GDNI) and received not yet billed (GRNI) at the month end — invoice them, or accrue them.',
    build: (f) => {
      const rows = f.unbilled.map((u) => ({ label: u.label, detail: `${u.stage}${u.party ? ` — ${u.party}` : ''}`, date: u.date, amount: u.value, voucherId: u.voucherId, ...(u.ledgerId ? { ledgerId: u.ledgerId } : {}) }))
      const g = f.unbilled.filter((u) => u.stage === 'GDNI').reduce((s, u) => s + u.value, 0)
      const r = f.unbilled.filter((u) => u.stage === 'GRNI').reduce((s, u) => s + u.value, 0)
      return { status: rows.length ? 'warn' : 'ok', summary: rows.length ? `GDNI ${rupeeText(g)}, GRNI ${rupeeText(r)} pending.` : 'Every challan and GRN is invoiced.', rows, amount: g + r }
    }
  },
  suspense: {
    title: 'Suspense account cleared',
    area: 'Books',
    fix: { screen: 'trial-balance', label: 'Open trial balance' },
    help: 'Ledgers under Suspense A/c hold entries waiting for their proper account (and imported opening differences). Move them out before closing.',
    build: (f) => {
      const rows = f.suspense.map((s) => ({ label: s.name, detail: `balance ${rupeeText(Math.abs(s.balance))} ${s.balance > 0 ? 'Dr' : 'Cr'}`, amount: Math.abs(s.balance), ledgerId: s.ledgerId }))
      return { status: rows.length ? 'fail' : 'ok', summary: rows.length ? `${plural(rows.length, 'suspense ledger')} with a balance.` : 'Nothing in suspense.', rows, amount: sum(rows) }
    }
  },
  pdc_due: {
    title: 'Post-dated cheques due are cleared',
    area: 'Banking',
    fix: { screen: 'banking', label: 'Open PDC register', params: { tab: 'pdc' } },
    help: 'Post-dated cheques dated on or before the month end stay out of the books until they mature — deposit / present them, or record the bounce.',
    build: (f) => {
      const rows = f.pdcs.map((p) => ({ label: p.label, detail: `${p.direction === 'received' ? 'received from' : 'issued to'} ${p.party ?? 'party'}`, date: p.date, amount: p.amount, voucherId: p.voucherId, ...(p.ledgerId ? { ledgerId: p.ledgerId } : {}) }))
      return { status: rows.length ? 'warn' : 'ok', summary: rows.length ? `${plural(rows.length, 'cheque')} (${rupeeText(sum(rows))}) dated by the month end still post-dated.` : 'No post-dated cheque is due.', rows, amount: sum(rows) }
    }
  },
  depreciation: {
    title: 'Depreciation posted',
    area: 'Assets',
    fix: { screen: 'fixed-assets', label: 'Open fixed assets' },
    help: 'If depreciation is posted monthly, a run covering this month must exist; if it is posted yearly, only March needs it (mark the other months not applicable).',
    build: (f, c) => {
      const d = f.depreciation
      if (!d || d.assetsInService === 0) return { status: 'na', summary: 'No fixed assets in service.', rows: [] }
      if (d.coveredThrough && d.coveredThrough >= c.to) return { status: 'ok', summary: `Posted up to ${d.coveredThrough}.`, rows: [] }
      const prevEnd = monthBounds(addMonths(c.period, -1)).to
      const monthly = !!d.coveredThrough && d.coveredThrough >= prevEnd
      const yearEnd = c.period.endsWith('-03')
      const rows = [{ label: 'Book depreciation', detail: d.coveredThrough ? `last run covers up to ${d.coveredThrough}` : 'no run this financial year' }]
      if (monthly) return { status: 'fail', summary: `Posted for last month (to ${d.coveredThrough}) but not for this one.`, rows }
      if (yearEnd) return { status: 'fail', summary: `The year ends this month and depreciation is posted only up to ${d.coveredThrough ?? 'nothing yet'}.`, rows }
      return { status: 'ok', summary: d.coveredThrough ? `Posted up to ${d.coveredThrough} (not monthly).` : 'Not posted yet this year (posted yearly?).', rows }
    }
  },
  accruals: {
    title: 'Regular expenses and incomes booked',
    area: 'Books',
    fix: { screen: 'daybook', label: 'Open day book' },
    help: 'Ledgers that had entries in each of the last three months (rent, salaries, interest…) but none this month — an accrual or a bill may be missing.',
    build: (f) => {
      const rows = f.accruals.map((a) => ({ label: a.name, detail: `nothing this month; ${a.lastMonth}: ${rupeeText(a.lastAmount)}`, amount: a.lastAmount, ledgerId: a.ledgerId }))
      return { status: rows.length ? 'warn' : 'ok', summary: rows.length ? `${plural(rows.length, 'regular ledger')} with nothing this month.` : 'Every regular ledger has its entries.', rows }
    }
  },
  narration: {
    title: 'Every voucher has a narration',
    area: 'Books',
    fix: { screen: 'exceptions', label: 'Open exceptions' },
    help: 'A narration says why an entry was made — auditors ask for it.',
    build: (f) => {
      const rows = vrows(f.blankNarration, 'no narration')
      return { status: rows.length ? 'warn' : 'ok', summary: rows.length ? `${plural(rows.length, 'voucher')} without a narration.` : 'Every voucher has a narration.', rows }
    }
  },
  rounding: {
    title: 'Vouchers balance; round-off is small',
    area: 'Books',
    fix: { screen: 'exceptions', label: 'Open exceptions' },
    help: 'Every voucher must balance; a round-off line above ₹1 usually hides a wrong rate or amount.',
    build: (f) => {
      const rows = [...vrows(f.unbalanced, 'debits and credits differ'), ...vrows(f.roundOff, 'round-off above ₹1')]
      // (closing journals are excluded by the service; the month's own vouchers only)
      return {
        status: f.unbalanced.length ? 'fail' : f.roundOff.length ? 'warn' : 'ok',
        summary: rows.length ? [f.unbalanced.length ? `${plural(f.unbalanced.length, 'voucher')} not balanced` : null, f.roundOff.length ? `${plural(f.roundOff.length, 'voucher')} with round-off above ₹1` : null].filter(Boolean).join('; ') + '.' : 'Every voucher balances; round-off within ₹1.',
        rows
      }
    }
  },
  drafts: {
    title: 'No drafts or optional vouchers left',
    area: 'Books',
    fix: { screen: 'daybook', label: 'Open day book' },
    help: 'Assistant drafts are proposals waiting for review; optional (memorandum) vouchers are outside the books. Save, discard or regularise them.',
    build: (f) => {
      const rows: CheckRow[] = [
        ...f.drafts.map((d) => ({ label: `Draft #${d.draftId}`, detail: d.summary, date: d.date, draftId: d.draftId })),
        ...vrows(f.optionalVouchers, 'optional voucher (not in the books)')
      ]
      return { status: rows.length ? 'warn' : 'ok', summary: rows.length ? `${plural(f.drafts.length, 'open draft')}, ${plural(f.optionalVouchers.length, 'optional voucher')}.` : 'Nothing waiting for review.', rows }
    }
  },
  lock: {
    title: 'Books locked for the month',
    area: 'Books',
    fix: { screen: 'company-info', label: 'Set the lock date' },
    help: 'Once the month is closed, lock the books up to its last day so nothing changes underneath the returns.',
    build: (f, c) => {
      if (f.lockDate && f.lockDate >= c.to) return { status: 'ok', summary: `Locked up to ${f.lockDate}.`, rows: [] }
      return { status: 'warn', summary: f.lockDate ? `Locked only up to ${f.lockDate}; lock up to ${c.to} once the other checks are done.` : `Not locked; lock up to ${c.to} once the other checks are done.`, rows: [] }
    }
  }
}

/** Deducted amounts still unpaid, oldest first (FIFO against everything paid up to today), each
 *  with its deposit due date (TDS: rule 30(2) 1962 Rules via depositDueDate; TCS: tcsDepositDueDate). */
export function withholdingUnpaid(
  w: CloseFacts['withholding'][number],
  today: string
): { month: string | null; unpaid: number; dueDate: string | null; late: boolean }[] {
  const buckets = [...w.deducted].sort((a, b) => (a.month ?? '').localeCompare(b.month ?? ''))
  let paid = w.paid
  const out: { month: string | null; unpaid: number; dueDate: string | null; late: boolean }[] = []
  for (const b of buckets) {
    const used = Math.min(paid, b.amount)
    paid -= used
    const unpaid = b.amount - used
    if (unpaid <= 0) continue
    const dueDate = b.month ? (w.kind === 'tds' ? depositDueDate(`${b.month}-15`) : tcsDepositDueDate(`${b.month}-15`)) : null
    out.push({ month: b.month, unpaid, dueDate, late: dueDate === null || today > dueDate })
  }
  return out
}

/** What a check found, as a string a mark can be compared with. */
export const checkFingerprint = (c: Pick<CloseCheck, 'status' | 'count' | 'more' | 'amount'>): string => `${c.status}|${c.count + c.more}|${c.amount ?? ''}`

export function checkCleared(e: CheckEffective): boolean {
  return e === 'ok' || e === 'done' || e === 'na'
}

export function progressOf(checks: readonly Pick<CloseCheck, 'effective'>[]): CloseProgress {
  const total = checks.length
  const done = checks.filter((c) => c.effective === 'done').length
  const na = checks.filter((c) => c.effective === 'na').length
  const cleared = checks.filter((c) => checkCleared(c.effective)).length
  return {
    total,
    cleared,
    done,
    na,
    warn: checks.filter((c) => c.effective === 'warn').length,
    fail: checks.filter((c) => c.effective === 'fail').length,
    pct: total ? Math.floor((cleared * 100) / total) : 100
  }
}

/** The checklist for a month: every check computed from the facts, the user's marks applied. */
export function buildCloseChecklist(
  facts: CloseFacts,
  ctx: { period: string; today: string },
  marks: ReadonlyMap<string, CloseMark> = new Map()
): CloseChecklist {
  const { from, to } = monthBounds(ctx.period)
  const c = { period: ctx.period, from, to, today: ctx.today }
  const checks = CLOSE_CHECK_KEYS.map((key): CloseCheck => {
    const def = CLOSE_CHECK_DEFS[key]
    const b = def.build(facts, c)
    const mark = marks.get(key) ?? null
    const fingerprint = checkFingerprint({ status: b.status, count: b.count ?? b.rows.length, more: 0, amount: b.amount ?? null })
    // A mark counts while the check finds what it found when marked; a changed finding that
    // still needs attention re-opens it (an old mark without a fingerprint keeps counting).
    const reopened = !!mark && mark.fingerprint != null && mark.fingerprint !== fingerprint && (b.status === 'warn' || b.status === 'fail')
    const effective: CheckEffective = mark && !reopened ? (mark.status === 'na' ? 'na' : 'done') : b.status
    return {
      key,
      title: def.title,
      area: def.area,
      status: b.status,
      summary: b.summary,
      count: b.count ?? b.rows.length,
      amount: b.amount ?? null,
      rows: b.rows.slice(0, CHECK_ROW_CAP),
      more: Math.max(0, b.rows.length - CHECK_ROW_CAP),
      dueDate: b.dueDate ?? null,
      fix: def.fix,
      help: def.help,
      sources: def.sources ?? [],
      mark,
      effective,
      fingerprint,
      reopened
    }
  })
  return { period: ctx.period, label: periodLabel(ctx.period), from, to, today: ctx.today, checks, progress: progressOf(checks) }
}

/** The ledgers posted in each of the three months before `period` but not in it. `monthly` maps
 *  ledgerId → (YYYY-MM → net amount, paise; absent = no entry). */
export function missingRegulars(
  period: string,
  monthly: ReadonlyMap<number, ReadonlyMap<string, number>>,
  names: ReadonlyMap<number, string>
): CloseFacts['accruals'] {
  const prev = [addMonths(period, -1), addMonths(period, -2), addMonths(period, -3)]
  const out: CloseFacts['accruals'] = []
  for (const [ledgerId, byMonth] of monthly) {
    if (byMonth.has(period)) continue
    if (!prev.every((p) => byMonth.has(p))) continue
    out.push({ ledgerId, name: names.get(ledgerId) ?? `#${ledgerId}`, lastMonth: prev[0]!, lastAmount: Math.abs(byMonth.get(prev[0]!)!) })
  }
  return out.sort((a, b) => b.lastAmount - a.lastAmount || a.name.localeCompare(b.name))
}
