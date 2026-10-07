/**
 * WP 4.2 — ageing buckets, reminder letters and their cadence, template merge and the
 * "email-ready" mailto: link. Pure.
 */
import { formatPaise } from '../money'
import { toDisplayDate } from '../dates'
import type { OutstandingBill } from '../reports'
import type { MergeField, ReceivablesConfig, ReminderBucket } from './config'
import { daysBetweenIso } from './interest'

/** The four ageing buckets (0–30, 31–60, 61–90, 90+ days overdue) — Outstandings, statements and
 *  the collection reports all bucket through this. */
export function ageingBucketIndex(overdueDays: number): 0 | 1 | 2 | 3 {
  return overdueDays <= 30 ? 0 : overdueDays <= 60 ? 1 : overdueDays <= 90 ? 2 : 3
}

export const AGEING_LABELS = ['0–30 days', '31–60 days', '61–90 days', 'Over 90 days'] as const

export function ageingBuckets(bills: Pick<OutstandingBill, 'pending' | 'overdueDays'>[]): [number, number, number, number] {
  const out: [number, number, number, number] = [0, 0, 0, 0]
  for (const b of bills) out[ageingBucketIndex(b.overdueDays)] += b.pending
  return out
}

/** Which letter a party gets: by its oldest overdue bill's days overdue. null = nothing overdue. */
export function reminderBucketFor(maxOverdueDays: number, cfg: Pick<ReceivablesConfig, 'firmFromDays' | 'finalFromDays'>): ReminderBucket | null {
  if (maxOverdueDays <= 0) return null
  if (maxOverdueDays >= cfg.finalFromDays) return 'final'
  if (maxOverdueDays >= cfg.firmFromDays) return 'firm'
  return 'gentle'
}

export interface CadenceCheck {
  allowed: boolean
  /** First date another reminder may go (null = any time). */
  nextAllowed: string | null
}

/** "Don't send twice within N days": `lastSent` is the latest reminder date for the party. */
export function reminderCadence(lastSent: string | null, today: string, minDays: number): CadenceCheck {
  if (!lastSent || minDays <= 0) return { allowed: true, nextAllowed: null }
  const gap = daysBetweenIso(lastSent, today)
  if (gap >= minDays) return { allowed: true, nextAllowed: null }
  const d = new Date(`${lastSent}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + minDays)
  return { allowed: false, nextAllowed: d.toISOString().slice(0, 10) }
}

/** Replace `{field}` tokens; unknown tokens are left as typed so a typo is visible, not silent. */
export function mergeTemplate(template: string, fields: Partial<Record<MergeField, string>>): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (whole, key: string) => {
    const v = (fields as Record<string, string | undefined>)[key]
    return v === undefined ? whole : v
  })
}

const rupees = (p: number): string => formatPaise(p, { symbol: true })

export interface ReminderFacts {
  company: string
  party: string
  asOn: string
  /** The party's overdue bills (overdueDays > 0). */
  overdue: OutstandingBill[]
  totalPending: number
}

export function reminderFields(f: ReminderFacts): Partial<Record<MergeField, string>> {
  const oldest = [...f.overdue].sort((a, b) => b.overdueDays - a.overdueDays)[0]
  const amount = f.overdue.reduce((s, b) => s + b.pending, 0)
  return {
    company: f.company,
    party: f.party,
    asOn: toDisplayDate(f.asOn),
    amount: rupees(amount),
    total: rupees(f.totalPending),
    oldestBill: oldest?.number ?? '',
    oldestBillDate: oldest ? toDisplayDate(oldest.date) : '',
    days: oldest ? String(oldest.overdueDays) : '0',
    bills: f.overdue
      .map((b) => `  ${b.number}  dated ${toDisplayDate(b.date)}${b.dueDate ? `, due ${toDisplayDate(b.dueDate)}` : ''}  ${rupees(b.pending)}  (${b.overdueDays} days overdue)`)
      .join('\n')
  }
}

/** A mailto: URL — the "email-ready" hand-off (the app has no SMTP; the mail client sends). */
export function mailtoLink(to: string | null, subject: string, body: string): string {
  return `mailto:${encodeURIComponent(to ?? '').replace(/%40/g, '@')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}
