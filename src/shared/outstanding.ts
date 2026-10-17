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
import { formatPaise } from './money'
import type { OutstandingBill } from './reports'

export interface BillRef {
  /** 'new' opens a named bill — or, on a settling (negative) event, a named credit (an advance, a
   *  note's own bill); 'against' settles a bill — or, on a positive event, uses a named credit. */
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

export interface AllocateBillsResult {
  bills: OutstandingBill[]
  /** Settlement paise that outran every open bill (an advance sitting on the account). */
  unappliedCredit: number
  /** Data problems surfaced instead of silently absorbed (v0.3 #66): currently, 'against'
   *  references naming a bill that isn't open. */
  warnings: string[]
}

function addDays(date: string, days: number): string {
  const dt = new Date(`${date}T00:00:00Z`)
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

function daysBetween(fromDate: string, toDate: string): number {
  return Math.round((Date.parse(toDate) - Date.parse(fromDate)) / 86_400_000)
}

/**
 * FIFO-allocate a party's chronological events into open bills as of `asOn`. `creditDays` (the
 * party ledger's default credit terms) supplies a due date for bills that don't carry an explicit
 * one; null means no default (due date stays null unless a ref says otherwise).
 */
export function allocateBills(events: BillEvent[], asOn: string, creditDays: number | null): AllocateBillsResult {
  const { credits: _credits, creditNames: _names, ...result } = allocateBillsWithCredits(events, asOn, creditDays)
  return result
}

/** allocateBills plus the named credits still open (advances / notes' own bills, by name) — for
 *  callers that must not reuse a name that is still open (WP 9.1 simple intents) — and every name a
 *  named credit has had, used up or not (`creditNames`: a later bill must not reuse a settled
 *  credit's name either, or the ref that used the credit would look like it rests on that bill). */
export function allocateBillsWithCredits(events: BillEvent[], asOn: string, creditDays: number | null): AllocateBillsResult & { credits: { name: string; amount: number }[]; creditNames: string[] } {
  const open: OutstandingBill[] = []
  let credit = 0
  const warnings: string[] = []
  // WP 9.1 fix: named credits — a 'new' ref on a SETTLING (negative) event: an advance received /
  // paid, or a credit / debit note's own bill. Held by name (oldest first) until a positive
  // event's 'against' ref uses it; counted in unappliedCredit. Never netted off refless bills
  // (that path is unchanged), so the legacy inference stays byte-identical.
  const namedCredits: { name: string; amount: number }[] = []
  const creditNames = new Set<string>()

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
      if (bill.pending === 0) open.shift()
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
    if (bill.pending === 0) open.splice(idx, 1)
    const remaining = amount - take
    if (remaining > 0) settleFifo(remaining)
  }

  const addBill = (bill: OutstandingBill): void => {
    // Advance credit already on the account nets off a new bill first.
    const take = Math.min(credit, bill.amount)
    credit -= take
    bill.pending = bill.amount - take
    if (bill.pending > 0) open.push(bill)
  }

  /** A positive event drawing on a named credit (an invoice against an advance, a refund against
   *  a note): returns what the credit could not cover. */
  const useNamedCredit = (name: string, amount: number): number => {
    let remaining = amount
    for (const c of namedCredits) {
      if (remaining <= 0) break
      if (c.name !== name || c.amount <= 0) continue
      const take = Math.min(c.amount, remaining)
      c.amount -= take
      remaining -= take
    }
    for (let i = namedCredits.length - 1; i >= 0; i--) if (namedCredits[i]!.amount === 0) namedCredits.splice(i, 1)
    return remaining
  }

  for (const ev of events) {
    if (ev.refs.length > 0) {
      for (const ref of ev.refs) {
        if (ref.kind === 'new' && ev.amount < 0) {
          namedCredits.push({ name: ref.name, amount: ref.amount })
          creditNames.add(ref.name)
        } else if (ref.kind === 'against' && ev.amount > 0 && namedCredits.some((c) => c.name === ref.name)) {
          const left = useNamedCredit(ref.name, ref.amount)
          if (left > 0) {
            addBill({ voucherId: ev.voucherId, number: ev.number, date: ev.date, amount: left, pending: left, ageDays: 0, dueDate: dueDateFor(ev.date), overdueDays: 0 })
          }
        } else if (ref.kind === 'new') {
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

  return { bills: open, unappliedCredit: credit + namedCredits.reduce((t, c) => t + c.amount, 0), warnings, credits: namedCredits.map((c) => ({ ...c })), creditNames: [...creditNames] }
}

export interface ReminderCompany {
  name: string
}

export interface ReminderParty {
  name: string
  email: string | null
}

export interface Reminder {
  subject: string
  body: string
  mailto: string
}

/** A plain-text payment-reminder email for a party's open bills. */
export function buildReminder(company: ReminderCompany, party: ReminderParty, bills: OutstandingBill[]): Reminder {
  const subject = `Payment reminder from ${company.name}`
  const total = bills.reduce((s, b) => s + b.pending, 0)
  const lines = bills.map((b) => `  ${b.number}  (${b.date})  ${formatPaise(b.pending, { symbol: true })}`)
  const body = [
    `Dear ${party.name},`,
    '',
    'The following bills remain outstanding:',
    '',
    ...lines,
    '',
    `Total due: ${formatPaise(total, { symbol: true })}`,
    '',
    'Kindly arrange payment at your earliest convenience.',
    '',
    'Regards,',
    company.name
  ].join('\n')
  const mailto = `mailto:${party.email ?? ''}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  return { subject, body, mailto }
}
