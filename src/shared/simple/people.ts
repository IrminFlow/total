// People (WP 9.8, plan 2026-10-13 §2 "People", §7 WP 9.8): the PURE half of the simple People
// screens — the read shapes services/simplePeople.ts returns, the list's filters and sentences,
// the words a bill's timing is said in, the reminder message (built from the WP 4.2 reminder
// letter's facts — the same overdue bills and the same gentle / firm / final step — rendered as a
// short, plain message), the WhatsApp link and the checks the person view makes before it asks
// main.
//
// No figure is computed here: what someone owes, what they paid ahead and how late each bill is
// all come from the Outstandings allocation (analysis.outstandingsWithAdvances, as on TODAY) that
// the service read; this file only sums what it is given for the "Bills to pay" header (due this
// week / this month), in integer paise.

import { z } from 'zod'
import { translator, type Language, type MessageKey, type Translate } from '../i18n'
import { formatPaise } from '../money'
import { toPlainDate } from '../dates'
import { isoDate } from '../schemas'
import { addDaysIso, daysBetweenIso } from '../receivables/interest'
import type { ReminderBucket, ReminderChannel } from '../receivables/config'
import { isPhoneNumber } from './accountKinds'

export type PersonSide = 'customer' | 'supplier'

/** The list's filters (plan §2: customers / suppliers / owes you / you owe; + late to pay). */
export const PEOPLE_FILTERS = ['all', 'customers', 'suppliers', 'owesYou', 'youOwe', 'late'] as const
export type PeopleFilter = (typeof PEOPLE_FILTERS)[number]

/** One open bill of a person, as the Outstandings allocation has it as on today. */
export interface PersonBill {
  name: string
  /** The bill's own entry (null for an opening bill). */
  voucherId: number | null
  date: string
  dueDate: string | null
  amount: number
  /** Still due (paise). */
  pending: number
  /** Days past the due date (0 = not late). */
  overdueDays: number
}

export interface PersonRow {
  ledgerId: number
  name: string
  side: PersonSide
  phone: string | null
  whatsapp: string | null
  creditDays: number | null
  onHold: boolean
  /** What is still open on their bills: a customer owes you this / you owe a supplier this. */
  open: number
  /** Money they paid ahead (customer) / you paid ahead (supplier) — the allocation's unapplied credit. */
  ahead: number
  /** The part of `open` past its due date, on how many bills, and the latest one's days. */
  late: number
  lateBills: number
  maxLateDays: number
  /** The counter's walk-in customer ("Cash sale") — listed only while it has a balance. */
  walkIn: boolean
}

export interface PeopleTotals {
  /** Every customer's open bills (= Home's "customers owe you"). */
  owesYou: number
  /** Every supplier's open bills (= Home's "you owe suppliers"). */
  youOwe: number
  customersAhead: number
  suppliersAhead: number
}

export interface PeopleList {
  today: string
  people: PersonRow[]
  totals: PeopleTotals
}

/** The reminder facts of a customer with late bills (WP 4.2's reminder candidate). */
export interface PersonReminder {
  bucket: ReminderBucket
  /** The late bills the message lists (oldest first) and their total. */
  bills: PersonBill[]
  amount: number
  /** The last reminder logged (any channel) and whether the "don't remind again within N days"
   *  setting would allow another today (the simple screen still lets you send — it says so). */
  lastSent: string | null
  allowed: boolean
  nextAllowed: string | null
}

export interface PersonView extends PersonRow {
  email: string | null
  /** Open bills, oldest first. */
  bills: PersonBill[]
  reminder: PersonReminder | null
  holdReason: string | null
  company: string
  today: string
}

export interface BillToPay extends PersonBill {
  ledgerId: number
  party: string
}

export interface BillsToPay {
  today: string
  /** Most late first, then the oldest. */
  bills: BillToPay[]
  /** Due by the end of this week (Sunday) / this month — late bills included. */
  weekEnd: string
  monthEnd: string
  dueThisWeek: number
  dueThisMonth: number
  late: number
}

// ---------------------------------------------------------------- IPC payloads

/** How a reminder left: the WhatsApp link, copied for an SMS, or just copied. */
export const REMINDER_VIA = ['whatsapp', 'sms', 'copied'] as const
export type ReminderVia = (typeof REMINDER_VIA)[number]

/** reminder_log's channel list (WP 4.2: email / pdf / print / phone / other) has no WhatsApp or
 *  SMS — they are messages to the phone, so 'phone'; a copied text is 'other'. The exact way is
 *  kept in the audit row. */
export const REMINDER_LOG_CHANNEL: Record<ReminderVia, ReminderChannel> = { whatsapp: 'phone', sms: 'phone', copied: 'other' }

const id = z.number().int().positive()

export const peopleListSchema = z.object({ today: isoDate.optional() }).strict()
export const personViewSchema = z.object({ id, today: isoDate.optional() }).strict()
export const personUpdateSchema = z
  .object({
    id,
    /** '' = none; absent = keep. */
    phone: z.string().max(40).optional(),
    whatsapp: z.string().max(40).optional(),
    /** null = none; absent = keep. */
    creditDays: z.number().int().min(0).max(365).nullable().optional()
  })
  .strict()
export type PersonUpdate = z.input<typeof personUpdateSchema>
export const personRemindedSchema = z.object({ id, via: z.enum(REMINDER_VIA), today: isoDate.optional() }).strict()

// ---------------------------------------------------------------- the list

const money = (paise: number): string => formatPaise(paise, { symbol: true })

export function matchesFilter(p: PersonRow, f: PeopleFilter): boolean {
  switch (f) {
    case 'customers':
      return p.side === 'customer'
    case 'suppliers':
      return p.side === 'supplier'
    case 'owesYou':
      return p.side === 'customer' && p.open > 0
    case 'youOwe':
      return p.side === 'supplier' && p.open > 0
    case 'late':
      return p.late > 0
    default:
      return true
  }
}

/** Where someone stands, in one short phrase ("Owes you ₹1,200.00", "Paid you ₹500.00 ahead"). */
export function balanceWords(p: Pick<PersonRow, 'side' | 'open' | 'ahead'>, t: Translate): string {
  const parts: string[] = []
  if (p.open > 0) parts.push(p.side === 'customer' ? t('simple.people.owesYou', { amount: money(p.open) }) : t('simple.people.youOwe', { amount: money(p.open) }))
  if (p.ahead > 0) parts.push(p.side === 'customer' ? t('simple.people.paidAhead', { amount: money(p.ahead) }) : t('simple.people.youPaidAhead', { amount: money(p.ahead) }))
  return parts.length ? parts.join(' · ') : t('simple.people.settled')
}

/** A bill's timing in words: "12 days overdue", "due today", "due in 3 days" ('' once paid). */
export function billTiming(b: Pick<PersonBill, 'pending' | 'dueDate' | 'overdueDays'>, today: string, t: Translate): string {
  if (b.pending <= 0) return ''
  if (b.overdueDays > 0) return t('simple.people.overdue', { days: b.overdueDays })
  if (b.dueDate && b.dueDate > today) return t('simple.people.dueIn', { days: daysBetweenIso(today, b.dueDate) })
  return t('simple.people.dueToday')
}

/** "Bills to pay": most late first, then the oldest, then by name. */
export function sortBillsToPay<T extends Pick<PersonBill, 'overdueDays' | 'date' | 'name'>>(bills: readonly T[]): T[] {
  return [...bills].sort((a, b) => b.overdueDays - a.overdueDays || a.date.localeCompare(b.date) || a.name.localeCompare(b.name))
}

/** Sunday of the week containing `date` (Monday-first weeks, as WP 4.2's promised-this-week). */
export function weekEndOf(date: string): string {
  const dow = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7
  return addDaysIso(date, 6 - dow)
}

export function monthEndOf(date: string): string {
  const [y, m] = date.split('-').map(Number) as [number, number]
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${date.slice(0, 7)}-${String(last).padStart(2, '0')}`
}

/** The header of "Bills to pay": what falls due by Sunday / by the month's end (late included). */
export function billsToPayTotals(bills: readonly Pick<PersonBill, 'pending' | 'dueDate' | 'date' | 'overdueDays'>[], today: string): Pick<BillsToPay, 'weekEnd' | 'monthEnd' | 'dueThisWeek' | 'dueThisMonth' | 'late'> {
  const weekEnd = weekEndOf(today)
  const monthEnd = monthEndOf(today)
  let dueThisWeek = 0
  let dueThisMonth = 0
  let late = 0
  for (const b of bills) {
    if (b.pending <= 0) continue
    const due = b.dueDate ?? b.date
    if (b.overdueDays > 0) late += b.pending
    if (due <= weekEnd) dueThisWeek += b.pending
    if (due <= monthEnd) dueThisMonth += b.pending
  }
  return { weekEnd, monthEnd, dueThisWeek, dueThisMonth, late }
}

// ---------------------------------------------------------------- the person view's checks

export type PersonField = 'phone' | 'whatsapp' | 'creditDays'

/** "15" → 15, "" → null, anything else (or outside 0–365) → undefined (not a number of days). */
export function parseCreditDays(text: string): number | null | undefined {
  const s = text.trim()
  if (s === '') return null
  if (!/^\d{1,3}$/.test(s)) return undefined
  const n = Number(s)
  return n <= 365 ? n : undefined
}

/** What is wrong with the typed contact details, per field (plain i18n keys). */
export function personErrors(f: { phone: string; whatsapp: string; creditDays: string }): Partial<Record<PersonField, MessageKey>> {
  const out: Partial<Record<PersonField, MessageKey>> = {}
  if (f.phone.trim() && !isPhoneNumber(f.phone)) out.phone = 'simple.people.err.phone'
  if (f.whatsapp.trim() && !isPhoneNumber(f.whatsapp)) out.whatsapp = 'simple.people.err.phone'
  if (parseCreditDays(f.creditDays) === undefined) out.creditDays = 'simple.people.err.creditDays'
  return out
}

// ---------------------------------------------------------------- the reminder message

/** How many late bills the message lists before "…and N more". */
export const REMINDER_BILL_LINES = 5

export interface ReminderMessageFacts {
  company: string
  party: string
  bucket: ReminderBucket
  /** The late bills (oldest first). */
  bills: readonly Pick<PersonBill, 'name' | 'date' | 'pending' | 'overdueDays'>[]
}

const BODY: Record<ReminderBucket, MessageKey> = {
  gentle: 'simple.people.msg.gentle',
  firm: 'simple.people.msg.firm',
  final: 'simple.people.msg.final'
}

function reminderParts(f: ReminderMessageFacts, lang: Language): { hello: string; body: string; lines: string[]; thanks: string; sign: string } {
  const t = translator(lang)
  const amount = f.bills.reduce((s, b) => s + b.pending, 0)
  const days = f.bills.reduce((m, b) => Math.max(m, b.overdueDays), 0)
  const shown = f.bills.slice(0, REMINDER_BILL_LINES)
  const lines = shown.map((b) => t('simple.people.msg.bill', { bill: b.name, date: toPlainDate(b.date), amount: money(b.pending) }))
  if (f.bills.length > shown.length) lines.push(t('simple.people.msg.more', { count: f.bills.length - shown.length }))
  return {
    hello: t('simple.people.msg.hello', { party: f.party }),
    body: t(BODY[f.bucket], { company: f.company, amount: money(amount), days }),
    lines,
    thanks: t('simple.people.msg.thanks'),
    sign: f.company
  }
}

/** The WhatsApp / copy text: hello, what is due, the late bills, thanks, the business's name. */
export function reminderMessage(f: ReminderMessageFacts, lang: Language = 'en'): string {
  const p = reminderParts(f, lang)
  return [p.hello, '', p.body, ...(p.lines.length ? ['', ...p.lines] : []), '', p.thanks, p.sign].join('\n')
}

/** The SMS text: the same message without the bill list, on as few lines as it reads well. */
export function reminderSms(f: ReminderMessageFacts, lang: Language = 'en'): string {
  const p = reminderParts(f, lang)
  return `${p.hello} ${p.body} ${p.thanks} ${p.sign}`
}

/** The number WhatsApp wants (country code, digits only). Written with `+` or `00` it is taken as
 *  international as typed (a stray trunk 0 after +91 dropped); otherwise it is an Indian number:
 *  a 10-digit number gets 91, a leading 0 is dropped, 91 + 10 digits stays. Anything else (a
 *  6-digit landline without its code, a 9-digit number…) is null — WhatsApp then asks whom to
 *  send it to rather than opening a chat with a wrong number. */
export function whatsappNumber(phone: string | null | undefined): string | null {
  if (!phone || !isPhoneNumber(phone)) return null
  const typed = phone.trim()
  let d = typed.replace(/\D/g, '')
  if (typed.startsWith('+') || d.startsWith('00')) {
    d = d.replace(/^00/, '')
    if (/^910\d{10}$/.test(d)) d = `91${d.slice(3)}`
    return d.length >= 8 && d.length <= 15 && !d.startsWith('0') ? d : null
  }
  if (/^0\d{10}$/.test(d)) d = d.slice(1)
  if (/^\d{10}$/.test(d)) return `91${d}`
  if (/^91\d{10}$/.test(d)) return d
  return null
}

/** `https://wa.me/<number>?text=…` — opened in the OS browser (the app sends nothing itself).
 *  Without a number WhatsApp asks whom to send it to. */
export function whatsappLink(phone: string | null | undefined, text: string): string {
  const n = whatsappNumber(phone)
  return `https://wa.me/${n ?? ''}?text=${encodeURIComponent(text)}`
}
