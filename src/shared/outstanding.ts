/**
 * Pure bill-by-bill allocation engine, extracted from services/analysis.ts's `outstandings()` so
 * it can be unit tested without a DB. Given a party's chronological ledger events (each optionally
 * carrying explicit bill references), produces the still-open bills as of a date.
 *
 * Without refs, an event's signed net amount is inferred the same way the legacy algorithm always
 * did: positive opens a new (unnamed) bill, negative settles the oldest open bills first (FIFO),
 * any settlement beyond what's open becomes an advance credit that nets off the next new bill.
 * That refless path MUST stay byte-identical to the pre-refactor behavior — see outstanding.test.ts.
 */
import { bandLabels, bandIndex, DEFAULT_BAND_CUTS, normaliseBandCuts } from './ageing'
import { addDays, daysBetween } from './dates'
import { formatPaise } from './money'
import type { OutstandingBill } from './reports'

export interface BillRef {
  /** 'new' opens a named bill; 'against' settles one. */
  kind: 'new' | 'against'
  name: string
  /** Always positive. */
  amount: number
  dueDate: string | null
}

export interface BillEvent {
  voucherId: number | null
  date: string
  number: string
  /** Signed paise: + increases the party's outstanding balance (a bill), − reduces it (a settlement). */
  amount: number
  /** Explicit bill-by-bill references carried by this voucher, if any. */
  refs: BillRef[]
}

/**
 * A bill that closed, and how late it was.
 *
 * The open bills answer "who owes me"; these answer "how do they behave", which is the input to
 * credit scoring. A bill closed by an advance already sitting on the account counts as settled on
 * the day it was raised — the money was already in, so calling it late would be a lie.
 */
export interface SettledBillRecord {
  number: string
  date: string
  dueDate: string | null
  amount: number
  /** Date of the event that took the pending to zero. */
  settledDate: string
  /** settledDate − dueDate (or the bill date when there is no due date). Negative = paid early. */
  daysLate: number
}

export interface AllocateBillsResult {
  bills: OutstandingBill[]
  /** Bills that closed within the period, oldest settlement first. */
  settled: SettledBillRecord[]
  /** Settlement paise that outran every open bill (an advance sitting on the account). */
  unappliedCredit: number
  /** Data problems surfaced instead of silently absorbed (v0.3 #66): currently, 'against'
   *  references naming a bill that isn't open. */
  warnings: string[]
}

/**
 * FIFO-allocate a party's chronological events into open bills as of `asOn`. `creditDays` (the
 * party ledger's default credit terms) supplies a due date for bills that don't carry an explicit
 * one; null means no default (due date stays null unless a ref says otherwise).
 */
export function allocateBills(events: BillEvent[], asOn: string, creditDays: number | null): AllocateBillsResult {
  const open: OutstandingBill[] = []
  const settled: SettledBillRecord[] = []
  let credit = 0
  const warnings: string[] = []
  // The date of the event currently being applied, so a bill knows when it was closed.
  let now = asOn

  const close = (bill: OutstandingBill): void => {
    const dueBasis = bill.dueDate ?? bill.date
    settled.push({
      number: bill.number,
      date: bill.date,
      dueDate: bill.dueDate,
      amount: bill.amount,
      settledDate: now,
      daysLate: daysBetween(dueBasis, now)
    })
  }

  const dueDateFor = (date: string, ref?: BillRef): string | null => {
    if (ref?.dueDate) return ref.dueDate
    return creditDays != null ? addDays(date, creditDays) : null
  }

  const settleFifo = (amount: number): void => {
    let remaining = amount
    while (remaining > 0 && open.length) {
      const bill = open[0]!
      const take = Math.min(bill.pending, remaining)
      bill.pending -= take
      remaining -= take
      if (bill.pending === 0) {
        close(bill)
        open.shift()
      }
    }
    credit += remaining
  }

  const settleNamed = (name: string, amount: number, eventNumber: string): void => {
    const idx = open.findIndex((b) => b.number === name)
    if (idx === -1) {
      // v0.3 #66: no silent FIFO fallback — the amount sits as unapplied credit (it still nets
      // off future bills, so totals stay honest) and the broken reference is called out.
      warnings.push(`${eventNumber}: settlement references bill "${name}", which is not open — amount held as unadjusted credit`)
      credit += amount
      return
    }
    const bill = open[idx]!
    const take = Math.min(bill.pending, amount)
    bill.pending -= take
    if (bill.pending === 0) {
      close(bill)
      open.splice(idx, 1)
    }
    const remaining = amount - take
    if (remaining > 0) settleFifo(remaining)
  }

  const addBill = (bill: OutstandingBill): void => {
    // Advance credit already on the account nets off a new bill first.
    const take = Math.min(credit, bill.amount)
    credit -= take
    bill.pending = bill.amount - take
    if (bill.pending > 0) open.push(bill)
    else close(bill)
  }

  for (const ev of events) {
    now = ev.date
    if (ev.refs.length > 0) {
      for (const ref of ev.refs) {
        if (ref.kind === 'new') {
          addBill({
            voucherId: ev.voucherId,
            number: ref.name,
            date: ev.date,
            amount: ref.amount,
            pending: ref.amount,
            ageDays: 0,
            dueDate: dueDateFor(ev.date, ref),
            overdueDays: 0
          })
        } else {
          settleNamed(ref.name, ref.amount, ev.number)
        }
      }
    } else if (ev.amount > 0) {
      addBill({
        voucherId: ev.voucherId,
        number: ev.number,
        date: ev.date,
        amount: ev.amount,
        pending: ev.amount,
        ageDays: 0,
        dueDate: dueDateFor(ev.date),
        overdueDays: 0
      })
    } else if (ev.amount < 0) {
      settleFifo(-ev.amount)
    }
  }

  for (const bill of open) {
    bill.ageDays = Math.max(0, daysBetween(bill.date, asOn))
    const dueBasis = bill.dueDate ?? bill.date
    bill.overdueDays = Math.max(0, daysBetween(dueBasis, asOn))
  }

  return { bills: open, settled, unappliedCredit: credit, warnings }
}

export interface ReminderCompany {
  name: string
}

export interface ReminderParty {
  name: string
  email: string | null
  phone?: string | null
}

export interface Reminder {
  subject: string
  body: string
  mailto: string
  /** A wa.me link, when the party has a usable number. Null when it cannot be built. */
  whatsapp: string | null
}

/**
 * Turn a typed phone number into the digits wa.me wants.
 *
 * Deliberately conservative. It strips punctuation, drops a leading `+` or `00`, and adds the
 * Indian country code to a bare ten-digit mobile — the one case that is unambiguous here. Any
 * other length is returned as-is if it already looks international, and otherwise refused,
 * because sending a payment reminder to the wrong person is worse than not sending one.
 */
export function whatsappNumber(raw: string | null, defaultCountryCode = '91'): string | null {
  if (!raw) return null
  let digits = raw.replace(/[^\d+]/g, '')
  if (digits.startsWith('+')) digits = digits.slice(1)
  else if (digits.startsWith('00')) digits = digits.slice(2)
  digits = digits.replace(/\D/g, '')
  if (digits.length === 10) return `${defaultCountryCode}${digits}`
  // A leading 0 is a domestic trunk prefix, not part of the subscriber number.
  if (digits.length === 11 && digits.startsWith('0')) return `${defaultCountryCode}${digits.slice(1)}`
  if (digits.length >= 11 && digits.length <= 15) return digits
  return null
}

/**
 * How hard the letter pushes.
 *
 * The same facts read very differently depending on the sentence around them, and a business that
 * sends one tone forever gets ignored. `gentle` is the reminder you send to a good customer who
 * forgot; `final` is the one that precedes a phone call you would rather not make. Nothing here
 * threatens legal action — that is a decision for a person, not a template.
 */
export type ReminderTone = 'gentle' | 'firm' | 'final'

export const REMINDER_TONES: ReminderTone[] = ['gentle', 'firm', 'final']

const TONE_OPENING: Record<ReminderTone, string> = {
  gentle: 'A gentle reminder about the following bills, which are showing as unpaid in our books:',
  firm: 'The following bills are past their due date in our books:',
  final: 'Despite earlier reminders, the following bills remain unpaid:'
}

const TONE_CLOSING: Record<ReminderTone, string> = {
  gentle: 'If payment is already on the way, please ignore this note.',
  firm: 'Kindly arrange payment at your earliest convenience.',
  final: 'Please arrange payment immediately, or call us to discuss a date.'
}

/** Suggests the tone from the worst overdue bill, so a bulk send is not all one voice. */
export function toneFor(worstOverdueDays: number): ReminderTone {
  if (worstOverdueDays <= 0) return 'gentle'
  if (worstOverdueDays <= 30) return 'gentle'
  if (worstOverdueDays <= 60) return 'firm'
  return 'final'
}

export interface ReminderOptions {
  tone?: ReminderTone
  /** Ageing band cut points; bills are grouped under a heading per band. */
  bandCuts?: number[]
  /** Interest to state on the letter. Omitted entirely when absent — an interest line the party
   *  never agreed to is an argument, not a reminder. */
  interest?: { total: number; terms: string }
  /** Contact line under the signature, e.g. a phone number to call. */
  contact?: string | null
}

/**
 * A plain-text payment reminder for a party's open bills, grouped by ageing band.
 *
 * One body serves the email and the WhatsApp message: what the user previews is exactly what the
 * party receives, on whichever channel they pick. Bands appear only when they contain something,
 * so a party with one recent bill gets a short note rather than four empty headings.
 */
export function buildReminder(
  company: ReminderCompany,
  party: ReminderParty,
  bills: OutstandingBill[],
  opts: ReminderOptions = {}
): Reminder {
  const subject = `Payment reminder from ${company.name}`
  const total = bills.reduce((s, b) => s + b.pending, 0)
  const cuts = normaliseBandCuts(opts.bandCuts ?? DEFAULT_BAND_CUTS)
  const labels = bandLabels(cuts)
  const tone = opts.tone ?? toneFor(bills.reduce((m, b) => Math.max(m, b.overdueDays), 0))

  const grouped: OutstandingBill[][] = labels.map(() => [])
  for (const b of bills) (grouped[bandIndex(b.overdueDays, cuts)] as OutstandingBill[]).push(b)

  const billLines: string[] = []
  const multipleBands = grouped.filter((g) => g.length > 0).length > 1
  grouped.forEach((group, i) => {
    if (group.length === 0) return
    if (multipleBands) {
      const bandTotal = group.reduce((s, b) => s + b.pending, 0)
      billLines.push(`${labels[i]} — ${formatPaise(bandTotal, { symbol: true })}`)
    }
    for (const b of group) {
      billLines.push(`  ${b.number}  (${b.date})  ${formatPaise(b.pending, { symbol: true })}`)
    }
    if (multipleBands) billLines.push('')
  })
  if (billLines[billLines.length - 1] === '') billLines.pop()

  const body = [
    `Dear ${party.name},`,
    '',
    TONE_OPENING[tone],
    '',
    ...billLines,
    '',
    `Total due: ${formatPaise(total, { symbol: true })}`,
    ...(opts.interest && opts.interest.total > 0
      ? [`Interest at ${opts.interest.terms}: ${formatPaise(opts.interest.total, { symbol: true })}`]
      : []),
    '',
    TONE_CLOSING[tone],
    '',
    'Regards,',
    company.name,
    ...(opts.contact ? [opts.contact] : [])
  ].join('\n')

  const mailto = `mailto:${party.email ?? ''}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  // Same text through both channels, so what the user previews is what the party receives.
  const number = whatsappNumber(party.phone ?? null)
  const whatsapp = number ? `https://wa.me/${number}?text=${encodeURIComponent(body)}` : null
  return { subject, body, mailto, whatsapp }
}
