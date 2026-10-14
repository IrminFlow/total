// People (WP 9.8, plan 2026-10-13 §2 "People"): the simple People screens' service. Every figure
// comes from the services the accountant screens use — nothing is stored:
//
// - peopleList: every customer and supplier (party ledgers — shared/chartOfAccounts isPartyLedger,
//   the side from the party root) with phone, credit days, credit hold and where they stand AS ON
//   TODAY: what is open on their bills, the late part and what they paid ahead — one run of
//   analysis.outstandingsWithAdvances per side (the Outstandings screen's and Home's allocation),
//   so the list, Outstandings and Home agree to the paisa (simplePeople.dbtest.ts);
// - personView: one person — the same figures, their open bills oldest first and, for a customer
//   with late bills, the WP 4.2 reminder facts (the letter's gentle / firm / final step from the
//   Settings → Receivables thresholds, the last reminder and the "don't remind within N days"
//   window);
// - billsToPay: every supplier's open bill (most late first) with what falls due this week /
//   this month — the payable side of the same allocation;
// - updatePerson: phone / WhatsApp / credit days through masters.updateLedger (audited `ledger`,
//   the same write the full app's account form makes);
// - personReminded: a reminder sent from the People screen, logged through receivables.logReminder
//   (reminder_log + its audit row) like the letter — WhatsApp / SMS as 'phone', copied as 'other'
//   (the exact way in the audit row).
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { OutstandingParty } from '@shared/reports'
import { descendantGroupIds, partyGroupIds, partyGroupRole } from '@shared/chartOfAccounts'
import { reminderBucketFor, reminderCadence } from '@shared/receivables/reminders'
import { AppError } from '@shared/errors'
import { isPhoneNumber } from '@shared/simple/accountKinds'
import {
  billsToPayTotals, REMINDER_LOG_CHANNEL, sortBillsToPay,
  type BillsToPay, type PeopleList, type PersonBill, type PersonReminder, type PersonRow, type PersonSide, type PersonUpdate, type PersonView, type ReminderVia
} from '@shared/simple/people'
import { outstandingsWithAdvances } from './analysis'
import { getLedger, listGroups, updateLedger } from './masters'
import { counterAccounts, WALK_IN_NAME } from './counter'
import { getReceivablesConfig, logReminder, reminderLog } from './receivables'

interface PartyLedgerRow {
  id: number
  name: string
  groupId: number
  phone: string | null
  whatsapp: string | null
  creditDays: number | null
  hold: number | null
  holdReason: string | null
  email: string | null
}

/** Every party ledger with its side (the root it sits under: debtors → customer). */
function partyLedgers(db: DB): (PartyLedgerRow & { side: PersonSide })[] {
  const groups = listGroups(db)
  const side = new Map<number, PersonSide>()
  for (const g of groups) {
    const role = partyGroupRole(g)
    if (role) for (const id of descendantGroupIds(groups, g.id)) side.set(id, role === 'debtor' ? 'customer' : 'supplier')
  }
  const ids = partyGroupIds(groups)
  const rows = db
    .prepare(
      `SELECT id, name, group_id AS groupId, phone, whatsapp, credit_days AS creditDays, credit_hold AS hold, credit_hold_reason AS holdReason, email
       FROM ledgers ORDER BY name COLLATE NOCASE`
    )
    .all() as PartyLedgerRow[]
  return rows.filter((l) => ids.has(l.groupId)).map((l) => ({ ...l, side: side.get(l.groupId)! }))
}

const billOf = (b: OutstandingParty['bills'][number]): PersonBill => ({
  name: b.number, voucherId: b.voucherId, date: b.date, dueDate: b.dueDate, amount: b.amount, pending: b.pending, overdueDays: b.overdueDays
})

/** The open bills (still due) of one Outstandings row, oldest first. */
const openBillsOf = (p: OutstandingParty | undefined): PersonBill[] =>
  (p?.bills ?? []).filter((b) => b.pending > 0).map(billOf).sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name))

interface Sides {
  rows: Map<number, OutstandingParty>
  ahead: Map<number, number>
}

/** One run of the Outstandings allocation for a side, as on `today`. */
function allocation(db: DB, side: PersonSide, today: string): Sides {
  const o = outstandingsWithAdvances(db, side === 'customer' ? 'receivable' : 'payable', today)
  return { rows: new Map(o.parties.map((p) => [p.ledgerId, p])), ahead: o.advanceByParty }
}

function rowOf(l: PartyLedgerRow & { side: PersonSide }, s: Sides, walkInId: number | null): PersonRow {
  const bills = openBillsOf(s.rows.get(l.id))
  const late = bills.filter((b) => b.overdueDays > 0)
  return {
    ledgerId: l.id,
    name: l.name,
    side: l.side,
    phone: l.phone,
    whatsapp: l.whatsapp,
    creditDays: l.creditDays,
    onHold: !!l.hold,
    open: s.rows.get(l.id)?.pending ?? 0,
    ahead: s.ahead.get(l.id) ?? 0,
    late: late.reduce((sum, b) => sum + b.pending, 0),
    lateBills: late.length,
    maxLateDays: late.reduce((m, b) => Math.max(m, b.overdueDays), 0),
    walkIn: l.side === 'customer' && (l.id === walkInId || l.name === WALK_IN_NAME)
  }
}

export function peopleList(db: DB, today: string): PeopleList {
  const alloc: Record<PersonSide, Sides> = { customer: allocation(db, 'customer', today), supplier: allocation(db, 'supplier', today) }
  const walkInId = counterAccounts(db).walkInLedgerId
  const people = partyLedgers(db)
    .map((l) => rowOf(l, alloc[l.side], walkInId))
    // The walk-in customer is the bills' "Cash customer" — listed only while it has a balance.
    .filter((p) => !p.walkIn || p.open !== 0 || p.ahead !== 0)
  const sum = (side: PersonSide, k: 'open' | 'ahead'): number => people.filter((p) => p.side === side).reduce((s, p) => s + p[k], 0)
  return {
    today,
    people,
    totals: { owesYou: sum('customer', 'open'), youOwe: sum('supplier', 'open'), customersAhead: sum('customer', 'ahead'), suppliersAhead: sum('supplier', 'ahead') }
  }
}

function partyOrThrow(db: DB, id: number): PartyLedgerRow & { side: PersonSide } {
  const l = partyLedgers(db).find((p) => p.id === id)
  if (!l) throw new AppError('simple_people_not_party', 'That account is not a customer or supplier')
  return l
}

/** The reminder facts of a customer with late bills — WP 4.2's candidate rule: the step by the
 *  oldest late bill's days (Settings → Receivables thresholds), the last reminder logged and the
 *  "don't remind again within N days" window. */
function reminderOf(db: DB, ledgerId: number, bills: PersonBill[], today: string): PersonReminder | null {
  const late = bills.filter((b) => b.overdueDays > 0)
  if (!late.length) return null
  const cfg = getReceivablesConfig(db)
  const maxDays = late.reduce((m, b) => Math.max(m, b.overdueDays), 0)
  const last = reminderLog(db, '0000-01-01', '9999-12-31', ledgerId)[0] ?? null
  const cadence = reminderCadence(last?.date ?? null, today, cfg.minDaysBetweenReminders)
  return {
    bucket: reminderBucketFor(maxDays, cfg)!,
    bills: late,
    amount: late.reduce((s, b) => s + b.pending, 0),
    lastSent: last?.date ?? null,
    allowed: cadence.allowed,
    nextAllowed: cadence.nextAllowed
  }
}

export function personView(db: DB, company: CompanyInfo, id: number, today: string): PersonView | null {
  const l = partyLedgers(db).find((p) => p.id === id)
  if (!l) return null
  const s = allocation(db, l.side, today)
  const row = rowOf(l, s, counterAccounts(db).walkInLedgerId)
  const bills = openBillsOf(s.rows.get(id))
  return {
    ...row,
    email: l.email,
    bills,
    reminder: l.side === 'customer' ? reminderOf(db, id, bills, today) : null,
    holdReason: l.hold ? l.holdReason : null,
    company: company.name,
    today
  }
}

export function billsToPay(db: DB, today: string): BillsToPay {
  const o = outstandingsWithAdvances(db, 'payable', today)
  const bills = sortBillsToPay(o.parties.flatMap((p) => openBillsOf(p).map((b) => ({ ...b, ledgerId: p.ledgerId, party: p.name }))))
  return { today, bills, ...billsToPayTotals(bills, today) }
}

/** Phone / WhatsApp / credit days through the full app's own account write (audited `ledger`). */
export function updatePerson(db: DB, patch: PersonUpdate): { ledgerId: number; phone: string | null; whatsapp: string | null; creditDays: number | null } {
  const l = partyOrThrow(db, patch.id)
  for (const f of ['phone', 'whatsapp'] as const) {
    const v = patch[f]?.trim()
    if (v && !isPhoneNumber(v)) throw new AppError('simple_people_bad_phone', 'Not a phone number', { field: f })
  }
  const existing = getLedger(db, l.id)!
  const next = {
    ...existing,
    ...(patch.phone !== undefined ? { phone: patch.phone.trim() } : { phone: undefined }),
    ...(patch.whatsapp !== undefined ? { whatsapp: patch.whatsapp.trim() } : { whatsapp: undefined }),
    ...(patch.creditDays !== undefined ? { creditDays: patch.creditDays } : {})
  }
  updateLedger(db, l.id, next)
  const fresh = partyOrThrow(db, l.id)
  return { ledgerId: fresh.id, phone: fresh.phone, whatsapp: fresh.whatsapp, creditDays: fresh.creditDays }
}

/** A reminder sent from the People screen — logged like the letter (no document). */
export function personReminded(db: DB, id: number, via: ReminderVia, today: string): { logId: number } {
  const l = partyOrThrow(db, id)
  if (l.side !== 'customer') throw new AppError('simple_people_nothing_late', 'Nothing is late for this person')
  const bills = openBillsOf(allocation(db, 'customer', today).rows.get(id))
  const r = reminderOf(db, id, bills, today)
  if (!r) throw new AppError('simple_people_nothing_late', 'Nothing is late for this person')
  const oldest = [...r.bills].sort((a, b) => b.overdueDays - a.overdueDays)[0]!
  const logId = logReminder(
    db,
    {
      party_ledger_id: id, bucket: r.bucket, date: today, amount_paise: r.amount, oldest_bill: oldest.name, max_overdue_days: oldest.overdueDays,
      document_path: null, channel: REMINDER_LOG_CHANNEL[via]
    },
    { via, forced: !r.allowed, from: 'simple-people' }
  )
  return { logId }
}
