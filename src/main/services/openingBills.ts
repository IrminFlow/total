/**
 * WP 8.7 — opening bills (migration "opening_bills"): the ONE reader and the ONE writer.
 *
 * A party's opening balance (`ledgers.opening_balance`, the figure every report sums) may be split
 * into the bills that make it up — bill-wise master data, like Tally's bill-wise openings.
 *
 * Invariant: a party's bills always add up to its opening on its own side (debtor: dr, creditor:
 * cr) — `replaceOpeningBills` checks it after writing, and an opening changed anywhere else goes
 * through `guardOpeningChange` (masters.updateLedger — so the full-app ledger form, data / books
 * import, import undo and bulk edit all do): bills that no longer fit are CLEARED and the clearing
 * is audited (entity `opening_bills`); when one of them is in use (a receipt / payment matched to
 * it by name, or an interest charge on it) the change is REFUSED with a plain message instead. A
 * trigger (migration) refuses any other write of an opening that disagrees with its bills.
 *
 * Every bill-wise reader goes through `openingEvents` (via analysis.ts: Outstandings, statements,
 * receivables, payables, dashboard, cash forecast, AI tools …). A party without bills is exactly
 * the old single 'Opening' bill dated the FY start.
 */
import type { DB } from '../db/connection'
import type { BillEvent } from '@shared/outstanding'
import { addDaysISO, fyOf } from '@shared/dates'
import { AppError } from '@shared/errors'
import { OPENING_BALANCE_NAME } from '@shared/simple/openings'
import { writeAudit } from './audit'

export interface OpeningBillRow { name: string; date: string; dueDate: string | null; amount: number }

const hasTable = (db: DB): boolean => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'opening_bills'").get()

/** A party's opening bills by party, oldest first. Empty without the table (a migration-slice test
 *  DB) and for every party that has none. */
export function openingBillsByParty(db: DB, partyIds?: readonly number[]): Map<number, OpeningBillRow[]> {
  const out = new Map<number, OpeningBillRow[]>()
  if (!hasTable(db)) return out
  const filter = partyIds ? (partyIds.length ? `WHERE party_ledger_id IN (${partyIds.map(() => '?').join(',')})` : 'WHERE 0') : ''
  const rows = db
    .prepare(`SELECT party_ledger_id AS partyId, name, date, due_date AS dueDate, amount FROM opening_bills ${filter} ORDER BY party_ledger_id, date, id`)
    .all(...(partyIds ?? [])) as ({ partyId: number } & OpeningBillRow)[]
  for (const { partyId, ...bill } of rows) {
    const list = out.get(partyId) ?? []
    list.push(bill)
    out.set(partyId, list)
  }
  return out
}

/**
 * A party's opening as bill events, in the allocation's sign convention (`sign` +1 receivable,
 * −1 payable). No bills: the one unnamed 'Opening' bill dated the FY start of `asOn` (unchanged).
 * With bills: one named bill each on its own date, due on its due date, else bill date + the
 * party's credit days, else the bill date itself; if the opening ever differs from them (it
 * cannot through the app — see the header) the difference is an "Opening (balance)" bill or
 * settles them oldest first.
 */
export function openingEvents(asOn: string, openingBalance: number, sign: number, bills: readonly OpeningBillRow[] | undefined, creditDays: number | null = null): BillEvent[] {
  if (!bills?.length) {
    if (openingBalance === 0) return []
    // v0.3 #62: the FY start of asOn — `${asOn.year}-04-01` was wrong for Jan–Mar dates.
    return [{ voucherId: null, date: fyOf(asOn).from, number: 'Opening', amount: sign * openingBalance, refs: [] }]
  }
  const events: BillEvent[] = bills.map((b) => ({
    voucherId: null,
    date: b.date,
    number: b.name,
    amount: b.amount,
    refs: [{ kind: 'new', name: b.name, amount: b.amount, dueDate: b.dueDate ?? (creditDays != null ? addDaysISO(b.date, creditDays) : b.date) }]
  }))
  const rest = sign * openingBalance - bills.reduce((s, b) => s + b.amount, 0)
  if (rest !== 0) events.push({ voucherId: null, date: fyOf(asOn).from, number: OPENING_BALANCE_NAME, amount: rest, refs: [] })
  return events
}

/** +1 debtor, −1 creditor, null = not a party (from the ledger's group, at any depth). */
export function partySide(db: DB, groupId: number): 1 | -1 | null {
  const names = (
    db
      .prepare(
        `WITH RECURSIVE up(id, name, parent_id) AS (
           SELECT id, name, parent_id FROM groups WHERE id = ?
           UNION ALL SELECT g.id, g.name, g.parent_id FROM groups g JOIN up ON g.id = up.parent_id)
         SELECT name FROM up`
      )
      .all(groupId) as { name: string }[]
  ).map((r) => r.name)
  return names.includes('Sundry Debtors') ? 1 : names.includes('Sundry Creditors') ? -1 : null
}

/** Bills (by name) that something rests on: a receipt / payment / note in the books settling it
 *  by name, or a live interest charge on it. */
export function openingBillsInUse(db: DB, ledgerId: number, names: readonly string[]): string[] {
  if (!names.length || !hasTable(db)) return []
  const against = db.prepare(
    `SELECT 1 FROM bill_refs br JOIN vouchers v ON v.id = br.voucher_id
     WHERE br.party_ledger_id = ? AND br.kind = 'against' AND br.name = ? COLLATE NOCASE AND v.deleted_at IS NULL LIMIT 1`
  )
  const interest = db.prepare(
    `SELECT 1 FROM interest_charges ic JOIN vouchers v ON v.id = ic.debit_note_voucher_id
     WHERE ic.party_ledger_id = ? AND ic.bill_key = ? AND v.deleted_at IS NULL LIMIT 1`
  )
  return names.filter((n) => against.get(ledgerId, n) || interest.get(ledgerId, `o:${n}`))
}

const inUseMessage = (party: string, bill: string): string =>
  `Bill ${bill} of ${party} already has a payment or an interest charge against it, so it can't be removed, renumbered or changed this way. Remove that link first, or keep the bill as it is.`

function partyName(db: DB, ledgerId: number): string {
  return (db.prepare('SELECT name FROM ledgers WHERE id = ?').get(ledgerId) as { name: string } | undefined)?.name ?? `#${ledgerId}`
}

/**
 * Called before a ledger's opening or group is written anywhere (masters.updateLedger). If the
 * party has opening bills that won't fit the new opening / side, they are cleared and audited —
 * or, when one of them is in use, the change is refused.
 */
export function guardOpeningChange(db: DB, ledgerId: number, newOpening: number, newGroupId: number): void {
  const bills = openingBillsByParty(db, [ledgerId]).get(ledgerId)
  if (!bills?.length) return
  const side = partySide(db, newGroupId)
  if (side != null && side * newOpening === bills.reduce((s, b) => s + b.amount, 0)) return
  const used = openingBillsInUse(db, ledgerId, bills.map((b) => b.name))
  if (used.length) {
    throw new AppError('opening_bills_in_use', `The opening of ${partyName(db, ledgerId)} is split into bills, and ${inUseMessage(partyName(db, ledgerId), used[0]!)}`, {
      field: 'openingBalance',
      params: { name: partyName(db, ledgerId), bill: used[0]! }
    })
  }
  db.prepare('DELETE FROM opening_bills WHERE party_ledger_id = ?').run(ledgerId)
  writeAudit(db, 'opening_bills', ledgerId, 'delete', { bills }, null)
}

/**
 * The writer: replace a party's opening bills with `next` and set its opening through
 * `applyOpening` (which must leave `side × opening = Σ bills`). Bills that disappear or are
 * renumbered must not be in use. Audited (entity `opening_bills`) when anything changed.
 */
export function replaceOpeningBills(db: DB, ledgerId: number, next: readonly OpeningBillRow[], applyOpening: () => void = () => {}, field?: string): boolean {
  return db.transaction(() => replaceNow(db, ledgerId, next, applyOpening, field))()
}

function replaceNow(db: DB, ledgerId: number, next: readonly OpeningBillRow[], applyOpening: () => void, field?: string): boolean {
  const stored = openingBillsByParty(db, [ledgerId]).get(ledgerId) ?? []
  // Removed or renumbered bills (a changed amount or date keeps the bill's identity).
  const nextNames = new Set(next.map((b) => b.name.toLowerCase()))
  const used = openingBillsInUse(db, ledgerId, stored.filter((b) => !nextNames.has(b.name.toLowerCase())).map((b) => b.name))
  if (used.length) {
    throw new AppError('openings_bill_in_use', inUseMessage(partyName(db, ledgerId), used[0]!), { ...(field ? { field } : {}), params: { name: partyName(db, ledgerId), bill: used[0]! } })
  }
  const same = JSON.stringify(stored) === JSON.stringify(next.map((b) => ({ name: b.name, date: b.date, dueDate: b.dueDate, amount: b.amount })))
  if (!same && stored.length) db.prepare('DELETE FROM opening_bills WHERE party_ledger_id = ?').run(ledgerId)
  applyOpening()
  if (same) {
    assertOpeningBillsAgree(db, ledgerId)
    return false
  }
  const ins = db.prepare('INSERT INTO opening_bills (party_ledger_id, name, date, due_date, amount) VALUES (?, ?, ?, ?, ?)')
  for (const b of next) ins.run(ledgerId, b.name, b.date, b.dueDate, b.amount)
  assertOpeningBillsAgree(db, ledgerId)
  writeAudit(db, 'opening_bills', ledgerId, stored.length ? 'update' : 'create', stored.length ? { bills: stored } : null, next.length ? { bills: next } : null)
  return true
}

/** Throws unless the party's bills add up to its opening on its side (no bills always agrees). */
export function assertOpeningBillsAgree(db: DB, ledgerId: number): void {
  const bills = openingBillsByParty(db, [ledgerId]).get(ledgerId)
  if (!bills?.length) return
  const l = db.prepare('SELECT group_id, opening_balance FROM ledgers WHERE id = ?').get(ledgerId) as { group_id: number; opening_balance: number }
  const side = partySide(db, l.group_id)
  const sum = bills.reduce((s, b) => s + b.amount, 0)
  if (side == null || side * l.opening_balance !== sum) {
    throw new Error(`Opening bills of ${partyName(db, ledgerId)} (${sum}) don't add up to its opening (${l.opening_balance})`)
  }
}

/** Every party whose bills disagree with its opening (a health check; empty in a sound file). */
export function openingBillMismatches(db: DB): number[] {
  if (!hasTable(db)) return []
  const ids = (db.prepare('SELECT DISTINCT party_ledger_id AS id FROM opening_bills').all() as { id: number }[]).map((r) => r.id)
  return ids.filter((id) => {
    try {
      assertOpeningBillsAgree(db, id)
      return false
    } catch {
      return true
    }
  })
}
